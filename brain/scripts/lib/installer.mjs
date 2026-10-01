// installer.mjs — Pure(ish) building blocks for the brain versioned installer.
//
// These functions implement the mechanics behind `brain:upgrade` and the
// `day:start` check-and-notify. They are deliberately small and side-effect
// free where possible so they can be unit-tested without a network or a real
// git remote (see installer.test.mjs).
//
// Contract (ADR-0003 / ADR-0006): the upgrade copies only the paths declared
// `managed` in brain/core/managed-paths.mjs and never touches `local` paths.
// Config migrations are additive: existing consumer values always win.

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, dirname, relative, sep } from 'node:path';
import { MANAGED_SCRIPT_KEYS } from '../../core/managed-paths.mjs';
import { readInstallProvenance } from './install-provenance.mjs';

// ── Glob matching ────────────────────────────────────────────────────────────
// Minimal glob → RegExp for the manifest syntax: `*` (no separator) and `**`
// (recursive). A trailing `/**` also matches the directory's own entries.

/**
 * Compiles a single glob pattern to a RegExp anchored at both ends.
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` → match anything (including separators). Swallow an optional
        // following slash so `a/**` matches `a/b` and `a/b/c`.
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Returns true if `relPath` (POSIX-style, repo-relative) matches any glob.
 * @param {string} relPath
 * @param {string[]} globs
 * @returns {boolean}
 */
export function matchesAny(relPath, globs) {
  return globs.some((g) => globToRegExp(g).test(relPath));
}

// ── Per-path strategy resolution (issue #397, REQ-397-5) ─────────────────────

/**
 * Resolves the ratified upgrade strategy for one path.
 *
 * An EXACT LITERAL always beats a glob that also matches. This is not a
 * stylistic preference: `brain/scripts/ci/gitlab-governance.yml` is REFUSE and
 * sits under the `brain/scripts/**` COPY glob, so letting the glob win would
 * make a signed row silently unreachable — the same "wired but never fires"
 * shape #397 exists to remove.
 *
 * Lives here rather than beside the table because resolution needs the glob
 * matcher, and `managed-paths.mjs` must not import this file (it already
 * exports MANAGED_SCRIPT_KEYS *to* it — the reverse edge would be a cycle).
 * The DATA stays in managed-paths.mjs, which is what REQ-397-5 requires.
 *
 * @param {string} relPath                  POSIX-style, repo-relative.
 * @param {Record<string, string>} strategyMap  Usually `managedStrategy`.
 * @returns {string} One of STRATEGY's values; 'copy' when nothing matches.
 */
export function strategyFor(relPath, strategyMap) {
  if (Object.hasOwn(strategyMap, relPath)) return strategyMap[relPath];
  for (const [pattern, strategy] of Object.entries(strategyMap)) {
    if (globToRegExp(pattern).test(relPath)) return strategy;
  }
  // Default COPY preserves the behaviour every path had before #397: a new
  // managed glob that nobody classified keeps working, and the drift test in
  // managed-paths.test.mjs is what makes the omission visible.
  return 'copy';
}

// ── Outgoing package snapshot (issue #397, REQ-397-1) ────────────────────────

/**
 * Reads the bytes brain shipped LAST time, before the install overwrites them.
 *
 * This is the third point that makes modification detection three-way. Until
 * step 1 of `brain:upgrade` runs, `node_modules/brain/<path>` still holds the
 * previous release's copy, so the two facts a single dest-vs-incoming diff
 * conflates — "the consumer edited it" and "brain changed it" — separate for
 * free. Same "read the outgoing package before the install" move #398 already
 * makes for its migration list.
 *
 * NEVER THROWS. It runs before the install, over a tree that may be absent,
 * partial, or from a much older brain, and its only effect is to make the
 * report better. Aborting an upgrade because this read failed would trade a
 * working upgrade for a nicer warning.
 *
 * @param {object} opts
 * @param {string} opts.pkgRoot      Installed brain package root (pre-install).
 * @param {string[]} opts.relPaths   Paths to snapshot.
 * @returns {Map<string, Buffer>}    Only paths that were readable.
 */
export function readOutgoing({ pkgRoot, relPaths }) {
  const out = new Map();
  for (const rel of relPaths) {
    try {
      out.set(rel, readFileSync(join(pkgRoot, rel)));
    } catch { /* swallow-ok: an absent or unreadable outgoing copy is "unknown", never evidence of a consumer edit; callers treat unknown as unknown */
      // Absent or unreadable. Absence is NOT evidence of a consumer edit — a
      // path brain ships for the first time has no outgoing copy either — so it
      // is simply left out of the map and callers treat "unknown" as "unknown".
    }
  }
  return out;
}

// ── File walking ─────────────────────────────────────────────────────────────

/**
 * Recursively lists files under `root`, returning POSIX-style relative paths.
 * Skips node_modules and the .git directory — neither is ever a managed path
 * and walking them would be slow and noisy.
 * @param {string} root
 * @returns {string[]}
 */
export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { /* follow-up: slice-D an unreadable directory lists as empty, so a file could be skipped from a copy without a report */
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  };
  walk(root);
  return out;
}

/**
 * Builds the restore/discard/preserve handle over a captured snapshot.
 *
 * Extracted so the journal-recovery path (`recoverFromJournal`) replays a snapshot
 * left by a run that DIED, using exactly the same restore logic a live run uses —
 * two implementations of "put the tree back" is precisely the class of bug this
 * repo batches under #315/#316/#340.
 *
 * @param {{destRoot: string, dir: string, saved: string[], created: string[], createdDirs: Set<string>}} snap
 */
function restoreHandle({ destRoot, dir, saved, created, createdDirs }) {
  return {
    dir,
    saved,
    created,
    /**
     * Returns every captured path to its pre-write state.
     *
     * Best-effort per path, deliberately: one unrecoverable entry must not strand
     * the rollback of all the others. (`rmSync(..., { force: true })` suppresses
     * ENOENT but NOT ENOTDIR, so a managed path whose parent exists as a file
     * would otherwise abort the whole restore — and its throw would replace the
     * original failure the caller is trying to report.)
     *
     * @returns {{ failed: string[] }} Paths that could not be returned to their
     *   prior state. Non-empty means the tree is still dirty and the caller must
     *   say so rather than report a clean rollback.
     */
    restore() {
      const failed = [];

      for (const rel of saved) {
        const target = join(destRoot, rel);
        try {
          // Recovery can run long after the crash, and the consumer may have deleted
          // the half-written directory in the meantime. A live rollback never needed
          // this — the write loop had just created the parent.
          mkdirSync(dirname(target), { recursive: true });
          copyFileSync(join(dir, rel), target);
        } catch { /* surfaced: the path is pushed to `failed`, which the restore result returns and the caller prints */ failed.push(rel); }
      }

      // Judged by outcome, not by whether the call threw: a path that is gone was
      // rolled back either way, and a path the write never reached was never dirty.
      // Only a path still on disk afterwards is a real failure.
      for (const rel of created) {
        const path = join(destRoot, rel);
        try { rmSync(path, { force: true }); } catch { /* surfaced: judged by outcome: pathPresent() on the next line pushes the path to `failed` when it is still on disk */ /* verified on the next line */ }
        if (pathPresent(path)) failed.push(rel);
      }

      // Deepest first, so a nested chain empties from the leaf up. A directory that
      // is no longer empty was repopulated by something outside this call — leaving
      // it in place is correct, not a failure.
      for (const d of [...createdDirs].sort((a, b) => b.length - a.length)) {
        try {
          if (pathPresent(d) && readdirSync(d).length === 0) rmSync(d, { recursive: true, force: true });
        // Reported repo-relative like every other entry: the caller prints them as
        // one list, and mixing absolute with relative paths reads as two bugs.
        } catch { /* surfaced: a directory that could not be removed is pushed to `failed` and reported by the caller */ failed.push(relative(destRoot, d)); }
      }

      return { failed };
    },
    /**
     * Drops the snapshot. Safe to call after restore().
     *
     * The JOURNAL goes first, deliberately. `rmSync` gives no ordering guarantee, so a
     * crash midway through a recursive delete could otherwise leave a journal
     * describing a snapshot that is already half-gone — and the next run would trust
     * it. Removing the journal first makes an interrupted discard fail SAFE: what
     * survives is an unreferenced directory, which the next run treats as debris.
     */
    discard() {
      try { rmSync(join(dir, JOURNAL_FILE), { force: true }); } catch { /* swallow-ok: removing the journal first is a safety ordering; the recursive removal on the next line still runs */ /* fall through */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Parses every consumer file a merge will read, BEFORE anything is snapshotted or
 * written, and reports all of them at once.
 *
 * A merge function throws on unparseable consumer JSON. #396 made that safe — the tree
 * rolls back and the error names the file — but not ESCAPABLE: one broken file blocks
 * every managed path, including the hundreds that have nothing to do with it, and it
 * fails only after the package install has already replaced `node_modules/brain`.
 *
 * Checking up front changes three things. The consumer learns about ALL the broken
 * files in one run rather than one per attempt; no snapshot is built for work that was
 * never going to happen; and the refusal can name `--skip-merge`, which is the
 * difference between a diagnosis and a lockout. That distinction is the whole reason
 * `brain/core/anti-patterns/pre-v0-8-0-upgrade-clobber-lockout.md` exists.
 *
 * @param {{destRoot: string, mergePaths: string[]}} opts
 * @returns {{ unparseable: Array<{rel: string, reason: string}> }}
 */
export function preflightMergeTargets({ destRoot, mergePaths }) {
  const unparseable = [];
  for (const rel of mergePaths) {
    const path = join(destRoot, rel);
    if (!pathPresent(path)) continue; // absent is fine — the merge writes it fresh
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      // Parseable is not the same as mergeable. `null` and arrays parse fine and then
      // blow up inside the merge on `.hooks` / `.scripts` — naming no file and offering
      // no escape, which is the pre-#399 experience surviving the fix. Two definitions
      // of "mergeable" in two places is a gap by construction; this one matches what
      // mergeClaudeSettings and mergePackageJsonScripts actually require.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        unparseable.push({ rel, reason: `expected a JSON object, got ${Array.isArray(parsed) ? 'an array' : String(parsed)}` });
      }
    } catch (err) { /* surfaced: a read or parse failure is pushed to `unparseable` with its cause and refuses the upgrade before any write */
      // "cannot be read" and "cannot be parsed" are different; say which.
      const why = err?.code && err.code !== 'ENOENT' ? `cannot be read — ${err.message}` : err?.message ?? String(err);
      unparseable.push({ rel, reason: why });
    }
  }
  return { unparseable };
}

/**
 * A version string only when it really parses as one.
 *
 * `parseSemver` yields `[0,0,0]` for anything it cannot read, which would make every
 * non-semver tag — `latest`, a branch name, a commit sha — compare as older than
 * everything and read as a downgrade. Refusing an ordinary install because its tag was
 * not numeric is worse than the bug being guarded.
 *
 * @param {string|null|undefined} v
 * @returns {string|null}
 */
export function semverOrNull(v) {
  const core = String(v ?? '').trim().replace(/^v/, '').split('-')[0];
  return /^\d+\.\d+\.\d+$/.test(core) ? core : null;
}

/**
 * The config keys a downgrade would leave stranded: those introduced by migrations
 * ABOVE the version being installed.
 *
 * `migrateConfig` only ever moves forward, so a downgrade leaves the consumer carrying
 * keys the target tag's code has never heard of, at a `schemaVersion` it never shipped.
 * Naming them is the difference between a warning and a shrug — the operator can only
 * judge the risk if they know what they are left holding.
 *
 * @param {Array<{version: string, defaults?: object}>} migrations
 * @param {string} targetVersion
 * @returns {string[]} dotted key paths, sorted
 */
export function keysAheadOfTarget(migrations, targetVersion) {
  const target = semverOrNull(targetVersion);
  if (!target) return [];
  const keys = new Set();
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
      else keys.add(path);
    }
  };
  for (const m of Array.isArray(migrations) ? migrations : []) {
    if (semverOrNull(m?.version) && compareSemver(m.version, target) > 0) walk(m.defaults, '');
  }
  return [...keys].sort();
}

// ── Restore point (rollback) ──────────────────────────────────────────────────

/**
 * Directory the pre-write snapshot is staged in, relative to the consumer root.
 * Kept inside the repo so the snapshot lands on the same filesystem as the files
 * it protects. It matches no `managed` glob, so an upgrade never copies over its
 * own restore point (pinned by test — REQ-S6-6).
 */
export const RESTORE_POINT_DIR = '.brain-upgrade-backup';

/**
 * The journal, written INSIDE the snapshot directory.
 *
 * Its presence is the whole signal, and the moment it is written is what makes that
 * signal trustworthy: it lands AFTER the snapshot is complete and BEFORE the first
 * write. So on a later run, a leftover snapshot directory means one of exactly two
 * things, and they are told apart by this file alone:
 *
 *   no journal  → the previous run died while snapshotting. Nothing was written, so
 *                 the leftover protects nothing and is safe to clear.
 *   journal     → the previous run died between its first and last write. Those bytes
 *                 are the only surviving record of the pre-upgrade tree.
 *
 * Without that distinction, replaying a leftover snapshot could restore bytes over a
 * tree the previous run never touched.
 */
export const JOURNAL_FILE = 'journal.json';

/** Bumped when the journal's shape changes; an unrecognised version is ignored, never guessed at. */
export const JOURNAL_VERSION = 1;

/** Lock path, deliberately a SIBLING of the snapshot dir so clearing that dir never releases it. */
export const LOCK_PATH_SUFFIX = '.lock';

/**
 * Forces a path's bytes (or a directory's entries) to stable storage.
 *
 * Recovery code cannot rely on the page cache. On a power cut, ext4's default
 * ordering commits metadata without guaranteeing data, and gives NO ordering at all
 * between two independent files — so a journal could land while the snapshot bytes
 * it describes did not. Recovery would then restore a zero-length file over the
 * consumer's real content AND report success, which is the worst outcome this code
 * can produce. Best-effort: a filesystem that refuses fsync is not a reason to abort
 * an upgrade, but it IS a reason not to have claimed durability without trying.
 */
function fsyncPath(p) {
  let fd;
  try {
    fd = openSync(p, 'r');
    fsyncSync(fd);
  } catch { /* swallow-ok: fsync is a durability hint; a failure leaves the write valid, only less durable across power loss */ /* best effort */ } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* swallow-ok: closing the probe descriptor cannot change the outcome; the fsync attempt above already ran */ /* ignore */ } }
  }
}

/**
 * Is `pid` a process that currently exists?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. ESRCH means gone; EPERM means it exists and belongs to someone else —
 * which is still ALIVE, and reading it as dead is how a mutex gets broken.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { /* swallow-ok: kill(pid, 0) throws by design to say "not alive"; EPERM (alive, not ours) maps to true */ return err?.code === 'EPERM'; }
}

/**
 * @returns {{path: string, present: boolean, pid: number|null, readable: boolean,
 *            alive: boolean, mine: boolean}}
 *   `readable` false means something occupies the path but names no usable owner — an
 *   empty or garbage file, a directory, a dangling link. That is UNOWNED, not held:
 *   a zero-length file is the canonical post-power-cut residue, and power loss is this
 *   feature's whole threat model, so treating it as a live owner would strand the repo
 *   on exactly the event it exists to survive.
 *   `mine` exists because a process must never refuse its own lock.
 */
function readLock(destRoot) {
  const path = join(destRoot, RESTORE_POINT_DIR + LOCK_PATH_SUFFIX);
  // Presence is decided by `lstat`, NOT by whether the content could be read. A
  // directory or a dangling link at this path makes readFileSync throw, and reporting
  // that as "nothing here" left the reclaim branches unreachable — the path stayed
  // occupied and every run refused forever.
  if (!pathPresent(path)) return { path, present: false, pid: null, readable: false, unknown: false, alive: false, mine: false };

  // "Could not read it" and "it names no owner" are DIFFERENT, and conflating them
  // inverted this feature's safety property: a live owner's lock that merely could not
  // be read (EACCES from a lock written under another uid, EIO from the failing disk
  // this exists for, EMFILE under CI fd pressure, ESTALE on NFS) was classified as
  // unowned and RECLAIMED out from under it.
  //
  // Only errnos that prove the path CANNOT name an owner mean unowned. Anything else is
  // unknown, and unknown fails closed — refusing costs a re-run, permitting costs the
  // consumer's work.
  const STRUCTURALLY_UNOWNED = new Set(['EISDIR', 'ELOOP', 'ENXIO', 'ENOENT']);
  let raw = '';
  let unknown = false;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) { /* surfaced: a code outside STRUCTURALLY_UNOWNED marks the lock `unknown`, which fails closed and refuses */
    if (!STRUCTURALLY_UNOWNED.has(err?.code)) unknown = true;
  }
  const pid = Number.parseInt(String(raw).trim(), 10);
  const readable = Number.isInteger(pid) && pid > 0;
  if (unknown) return { path, present: true, pid: null, readable: false, unknown: true, alive: true, mine: false };
  return {
    path,
    present: true,
    pid: readable ? pid : null,
    readable,
    alive: readable && pidAlive(pid),
    mine: readable && pid === process.pid,
  };
}

/**
 * The ONE question every transition must ask before touching anything:
 * what is here, who owns it, and are they still alive?
 *
 * This exists because the alternative was tried and failed four times. The
 * snapshot, the journal and the lock are a single lifecycle, and while each
 * cleanup site judged locally whether what it saw was garbage, every round of
 * fixes produced a new site that deleted something another site owned — the
 * rollback's own snapshot, then the preserved copy, then the evidence a refusal
 * pointed at, then a live run's mutex. Local judgement is the defect. One reader,
 * one verdict, every caller obeys it.
 *
 * @param {string} destRoot
 * @returns {{state: 'clean'|'live-run'|'interrupted'|'corrupt'|'debris',
 *            lock: {path: string, present: boolean, pid: number|null, alive: boolean},
 *            journal: object|null, snapshotPresent: boolean, reason: string}}
 */
export function inspectRestorePoint(destRoot) {
  const dir = join(destRoot, RESTORE_POINT_DIR);
  const lock = readLock(destRoot);
  const snapshotPresent = pathPresent(dir);
  const journalPath = join(dir, JOURNAL_FILE);
  const journalOnDisk = pathPresent(journalPath);
  const journal = readJournal(destRoot);

  // A live owner outranks everything: whatever else is on disk belongs to a run
  // that is still using it.
  // `!lock.mine` is load-bearing, not defensive. The CLI takes the lock and THEN calls
  // copyManaged, so without this the run reads its own live lock as a competitor and
  // refuses itself — which shipped, bricked every upgrade, and passed 2294 tests
  // because not one of them asserted that a plain upgrade succeeds.
  if (lock.present && lock.alive && !lock.mine) {
    return { state: 'live-run', lock, journal, snapshotPresent,
      reason: lock.unknown
        ? `a lock is present at ${lock.path} but cannot be read, so whether an upgrade is running here is unknown — refusing rather than guessing. Fix its permissions or delete it if you are certain none is`
        : `another brain:upgrade is running in this repo (pid ${lock.pid}, lock at ${lock.path})` };
  }

  // A journal we cannot read is NOT the same as no journal. Absent means nothing was
  // written; unreadable means something was, and we no longer know what. Deleting on
  // that evidence is how a torn journal turns into lost bytes.
  if (journalOnDisk && !journal) {
    return { state: 'corrupt', lock, journal: null, snapshotPresent,
      reason: `the restore point at ${dir} carries a journal this version cannot read, so what a previous run wrote is unknown` };
  }

  if (journal) {
    const n = journal.saved.length + journal.created.length;
    return { state: 'interrupted', lock, journal, snapshotPresent,
      reason: `a previous brain:upgrade was interrupted after it began writing (restore point at ${dir}, covering ${n} managed path(s))` };
  }

  if (snapshotPresent) {
    return { state: 'debris', lock, journal: null, snapshotPresent,
      reason: 'a previous run died before its first write; what it left protects nothing' };
  }

  return { state: 'clean', lock, journal: null, snapshotPresent: false, reason: '' };
}

/**
 * Takes the lock for a real upgrade, refusing when anything on disk says no.
 *
 * `wx` makes the create atomic. A lock whose owner is GONE — or that names no owner at
 * all — is reclaimed here rather than left to strand the repo forever, but never on a
 * bare "the file exists": liveness is checked against the recorded pid first.
 */
export function acquireLock(destRoot) {
  const path = join(destRoot, RESTORE_POINT_DIR + LOCK_PATH_SUFFIX);

  // `wx` FIRST. The previous form read, then deleted, then created — three syscalls
  // with no atomicity, so two processes that both saw the same dead owner could both
  // delete and both create. Measured: 7 of 40 concurrent processes held it at once.
  // Here the atomic create is the only way in, and reclaiming a dead owner's lock is
  // the exceptional branch rather than the path everyone takes.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: 'wx' });
      // Read back: if someone reclaimed and recreated between our create and now, the
      // lock is theirs, not ours, and silently proceeding would be the same violation.
      const mine = readLock(destRoot);
      if (mine.pid !== process.pid) {
        throw new Error(`another brain:upgrade took the lock at ${path} at the same moment.`);
      }
      break;
    } catch (err) { /* swallow-ok: ONLY EEXIST continues (a live owner refuses, a dead one is reclaimed, a contended retry throws); every other error is re-thrown */
      if (err?.code !== 'EEXIST') throw err;
      const cur = readLock(destRoot);
      if (cur.alive) {
        throw new Error(`another brain:upgrade is running in this repo (pid ${cur.pid}, lock at ${path}).`);
      }
      if (attempt === 1) {
        throw new Error(`could not take the lock at ${path} — it is being contended. Re-run.`);
      }
      // Compare-and-delete: remove ONLY the exact dead lock just inspected, never
      // whatever happens to be at the path by the time we get here.
      //
      // An UNREADABLE lock is reclaimed outright. It names no owner, so there is no
      // identity to compare — and comparing anyway strands the repo forever, because
      // the previous form compared two NaNs and `NaN === NaN` is false. A zero-length
      // lock is what a power cut leaves (create and write are not atomic together and
      // the lock is not fsynced), so this manufactured its own permanent lockout on
      // precisely the failure this feature exists to survive.
      const stillSame = readLock(destRoot);
      if (stillSame.present && !stillSame.readable) {
        rmSync(path, { recursive: true, force: true });
      } else if (stillSame.present && stillSame.pid === cur.pid && !stillSame.alive) {
        rmSync(path, { force: true });
      }
    }
  }
  return {
    path,
    /** Releases ONLY a lock this process still owns — never one someone else took. */
    release() {
      try {
        const cur = readLock(destRoot);
        if (cur.present && cur.pid === process.pid) rmSync(path, { force: true });
      } catch { /* swallow-ok: releasing our own lock is cosmetic; a stale lock is caught by the pid-liveness check on the next run */ /* cosmetic */ }
    },
  };
}

function writeJournal({ dir, saved, created, createdDirs, destRoot }) {
  const journal = {
    version: JOURNAL_VERSION,
    saved,
    created,
    createdDirs: [...createdDirs].map((d) => relative(destRoot, d)),
  };
  mkdirSync(dir, { recursive: true });
  const path = join(dir, JOURNAL_FILE);

  // Written to a temp file and RENAMED into place. A plain write leaves a window in
  // which the journal is truncated, and the most likely moment for a power cut to hit
  // it is the one instant when nothing has been written yet — producing a `corrupt`
  // verdict whose message ("something WAS written and we no longer know what") would
  // be the exact opposite of the truth, and a permanent refusal with no way out.
  // rename(2) is atomic for one path, which is precisely the case here.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(journal, null, 2) + '\n');
  fsyncPath(tmp);
  renameSync(tmp, path);
  // The journal is the last thing written before the first managed write, so this is
  // the barrier that makes "journal present" mean "the snapshot below it is durable".
  fsyncPath(path);
  fsyncPath(dir);
  // …and destRoot, which holds the snapshot directory's own entry. Without it a power
  // cut can lose the whole restore point while its contents were durable, and the next
  // run reads `clean` and proceeds with nothing to undo.
  fsyncPath(destRoot);
}

/**
 * Reads a journal left by an interrupted run, or null when there is none to trust.
 *
 * Fails closed on anything malformed: a journal that cannot be parsed, carries an
 * unknown version, or lacks its path arrays is treated as ABSENT rather than
 * guessed at — replaying a half-understood journal is worse than not replaying.
 *
 * @param {string} destRoot
 * @returns {{version: number, saved: string[], created: string[], createdDirs: string[]}|null}
 */
export function readJournal(destRoot) {
  try {
    const j = JSON.parse(readFileSync(join(destRoot, RESTORE_POINT_DIR, JOURNAL_FILE), 'utf8'));
    if (j?.version !== JOURNAL_VERSION) return null;
    if (!Array.isArray(j.saved) || !Array.isArray(j.created) || !Array.isArray(j.createdDirs)) return null;
    return j;
  } catch { /* surfaced: any read, parse or version failure returns null; inspectRestorePoint then reports state `corrupt` and refuses whenever a journal file is on disk */
    return null;
  }
}

/**
 * Replays a journal left by a run that DIED — the SIGKILL / power-loss path slice 1
 * could not cover, because no in-process handler runs for those.
 *
 * Deliberately NOT automatic. Between the crash and this call the consumer may have
 * repaired things by hand, and replaying stale snapshot bytes over that repair would
 * destroy work while reporting success. The caller reaches this only on an explicit
 * request; `createRestorePoint` refuses until it happens.
 *
 * @param {{destRoot: string}} opts
 * @returns {{recovered: string[], failed: string[], snapshotDir: string|null}|null}
 *   null when there is nothing to recover.
 */
export function recoverFromJournal({ destRoot }) {
  // Recovery replays a DEAD run's snapshot. If the owner is alive, this would revert
  // a tree mid-write while that run reports success — the exact disaster this issue
  // exists to prevent, reachable through its own remedy. Refuse.
  const state = inspectRestorePoint(destRoot);
  if (state.state === 'live-run') throw Object.assign(new Error(state.reason), { liveRun: true });
  if (state.state === 'corrupt') throw Object.assign(new Error(state.reason), { corruptJournal: true });

  const journal = state.journal;
  if (!journal) return null;

  const dir = join(destRoot, RESTORE_POINT_DIR);
  const handle = restoreHandle({
    destRoot,
    dir,
    saved: journal.saved,
    created: journal.created,
    createdDirs: new Set(journal.createdDirs.map((d) => join(destRoot, d))),
  });

  const { failed } = handle.restore();
  // Kept SEPARATE, because they are opposite actions on the operator's disk. A path in
  // `saved` is rewritten with earlier bytes; a path in `created` is DELETED, since it did
  // not exist before the interrupted run. Reporting them as one "restored" count told an
  // operator their files had been put back while most of them had just been removed — and
  // anything they hand-wrote at one of those paths after the crash went with it, silently.
  const restored = journal.saved.filter((p) => !failed.includes(p));
  const removed = journal.created.filter((p) => !failed.includes(p));
  const recovered = [...restored, ...removed];
  // Barrier before the evidence is dropped: otherwise a power cut just after
  // "Recovered." can commit the journal's removal while the restored bytes are lost.
  for (const rel of recovered) fsyncPath(join(destRoot, rel));

  if (failed.length === 0) {
    safeDiscard(handle);
    return { recovered, restored, removed, failed, snapshotDir: null };
  }
  // Same rule as a live rollback: what could not be put back keeps its evidence AND
  // keeps the gate armed, so the next run still refuses over the still-dirty tree.
  return { recovered, restored, removed, failed, snapshotDir: dir };
}


/**
 * `lstat` without throwing — returns null when the path is absent.
 *
 * Deliberately NOT `existsSync`, which follows symlinks and therefore reports a
 * DANGLING link as absent. That misclassification is load-bearing here: a path
 * wrongly judged absent is recorded as "created by this run" and is DELETED on
 * rollback, destroying an entry that existed before the call.
 *
 * @param {string} p
 * @returns {import('node:fs').Stats|null}
 */
function lstatOrNull(p) {
  try { return lstatSync(p); } catch { /* swallow-ok: absent-or-unreadable is the null callers branch on: "nothing there" */ return null; }
}

/** True when something occupies `p` — including a symlink with no target. */
function pathPresent(p) {
  return lstatOrNull(p) !== null;
}

/**
 * True when `p`, after every symlink ON ITS WHOLE PATH is resolved, lands outside
 * `destRoot`.
 *
 * This is the real, measured boundary — not "is it a symlink". A symlink pointing
 * INSIDE the repo round-trips perfectly: `copyFileSync` follows it when the
 * snapshot is taken, follows it again on the write, and follows it a third time on
 * restore, so the target ends at its original bytes and the link itself is never
 * touched. Refusing those would soft-lock a consumer for no gain — and
 * `AGENTS.md -> CLAUDE.md`, a managed path, is the canonical agent-interop symlink.
 *
 * What genuinely cannot be covered is a write that lands outside `destRoot`, since
 * the snapshot lives inside it. Resolving the whole path (not just the leaf) is
 * what catches a symlinked ANCESTOR directory, which a leaf-only check misses.
 *
 * @param {string} destRoot
 * @param {string} p
 * @returns {boolean}
 */
function escapesRoot(destRoot, p) {
  let rootReal;
  try { rootReal = realpathSync(destRoot); } catch { /* follow-up: slice-D an unresolvable destination root reads as "does not escape", which fails open in a safety check */ return false; }

  // Resolve the deepest ancestor that exists, then re-attach the tail that does
  // not — so a path scheduled to be CREATED under a symlinked parent is judged on
  // where it would actually land.
  const tail = [];
  for (let cur = p; ;) {
    try {
      const base = realpathSync(cur);
      const resolved = tail.length ? join(base, ...tail) : base;
      return resolved !== rootReal && !resolved.startsWith(rootReal + sep);
    } catch { /* swallow-ok: an unresolvable segment moves the probe to its parent; that walk is how a path still to be created is judged */
      const parent = dirname(cur);
      if (parent === cur) return false; // nothing on the path resolves at all
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Drops a restore point without ever letting cleanup failure masquerade as the
 * action failing.
 *
 * `rmSync(..., { force: true })` suppresses ENOENT but NOT EACCES/EPERM/EBUSY, so
 * an unguarded discard can turn a fully-applied upgrade into a reported failure —
 * and inside a `catch`, its throw would replace the very error being reported. A
 * leftover snapshot directory is cosmetic; a false failure report is not.
 */
function safeDiscard(restorePoint) {
  try { restorePoint.discard(); } catch { /* swallow-ok: cosmetic — a leftover snapshot directory is harmless, a false failure after a fully applied upgrade is not */ /* cosmetic — never surface as failure */ }
}

/**
 * Attaches rollback state to a failure without ever losing the original.
 *
 * A bare `err.rollbackIncomplete = …` is not safe: modules are strict mode, so
 * assigning to a string, a frozen Error or null throws a TypeError that REPLACES
 * the failure being reported and drops the dirty-tree signal with it — leaving
 * the caller to print a clean-rollback message over a dirty tree. `specialMerge`
 * is caller-supplied on an exported API, so a non-Error throw is reachable
 * without touching this file.
 *
 * @param {unknown} err     Whatever the write loop threw.
 * @param {string[]} failed Paths `restore()` could not put back.
 * @param {string} snapshotDir Where the surviving snapshot was left.
 * @returns {unknown} `err` itself when it can carry the annotation, else a
 *   wrapper carrying `err` as `cause`.
 */
function annotateRollback(err, failed, snapshotDir) {
  if (failed.length === 0) return err;
  if (err !== null && typeof err === 'object') {
    try {
      err.rollbackIncomplete = failed;
      err.rollbackSnapshotDir = snapshotDir;
      return err;
    } catch { /* swallow-ok: a frozen error cannot be annotated; the next lines wrap it in a new Error that carries it as cause */ /* frozen or sealed — fall through to the wrapper */ }
  }
  const wrapped = new Error(
    `upgrade failed and the rollback was incomplete — ${failed.length} path(s) still modified`,
    { cause: err },
  );
  wrapped.rollbackIncomplete = failed;
  wrapped.rollbackSnapshotDir = snapshotDir;
  return wrapped;
}

/**
 * Captures the current on-disk state of `relPaths` so a failed write can be undone.
 *
 * Why this exists (#396): `copyManaged` writes the managed payload with a
 * sequential loop of copy/merge calls. A throw partway through — ENOSPC, EACCES,
 * an unreadable source file, a merge function rejecting malformed consumer JSON —
 * used to leave the consumer tree half old and half new, recoverable only through
 * the consumer's own git hygiene.
 *
 * The snapshot is taken BEFORE the first write, so restoring every captured path
 * returns the tree to its pre-write bytes no matter where in the loop the failure
 * landed. Paths that did not exist beforehand are recorded under `created` and are
 * DELETED on restore rather than restored — a fresh install rolls back to absent,
 * not to empty. Directories the write would have had to create are pruned too, so
 * a rollback leaves no empty scaffolding behind.
 *
 * Taking the snapshot can itself fail — it writes to the same disk that is about
 * to be written. That is the safe ordering, not a gap: it throws before any
 * managed path has been touched, so the caller observes zero writes.
 *
 * NOT covered here: SIGKILL and power loss, which run no in-process handler at
 * all. Surviving those needs an on-disk journal replayed by the NEXT invocation;
 * this snapshot directory is the substrate that work builds on. Tracked as the
 * second half of #396.
 *
 * @param {object} opts
 * @param {string} opts.destRoot  Consumer repo root.
 * @param {string[]} opts.relPaths  Every dest-relative path the caller may write.
 * @returns {{ dir: string, saved: string[], created: string[], restore: () => void, discard: () => void }}
 */
export function createRestorePoint({ destRoot, relPaths }) {
  const dir = join(destRoot, RESTORE_POINT_DIR);
  const saved = [];
  const created = [];
  const createdDirs = new Set();
  const escaping = [];
  const dangling = [];

  // INVERTED from slice 1, as that slice's own comment said it must be. A leftover
  // snapshot is no longer debris to clear — with a recovery path in place it may be
  // the only surviving record of a tree a killed run left half-applied, and clearing
  // it here would destroy exactly what recovery replays.
  //
  // The journal is what tells the two cases apart (see JOURNAL_FILE): written after
  // the snapshot and before the first write, so its ABSENCE proves the previous run
  // never wrote anything.
  // ONE reader, ONE verdict. Every transition obeys it — see inspectRestorePoint for
  // why local per-site judgement was abandoned.
  const state = inspectRestorePoint(destRoot);
  if (state.state !== 'clean' && state.state !== 'debris') {
    const covered = state.journal ? state.journal.saved.length + state.journal.created.length : null;
    throw Object.assign(
      new Error(
        `${state.reason}. Nothing will be written until it is dealt with` +
        (state.state === 'interrupted'
          ? ': re-run with --recover to put those paths back, or delete that directory to discard the record and lose the ability to undo that run.'
          : state.state === 'corrupt'
            ? '. This is deliberately NOT auto-cleared: an unreadable journal means something WAS written and we no longer know what, so deleting it would destroy the only copy of the previous state. Inspect it by hand.'
            : '.'),
      ),
      { interruptedRun: state.state !== 'live-run', restorePointState: state.state, snapshotDir: dir, coveredPaths: covered },
    );
  }
  // 'debris' only: a run that died BEFORE its first write. What it left protects nothing.
  if (state.snapshotPresent) rmSync(dir, { recursive: true, force: true });

  for (const rel of relPaths) {
    const dest = join(destRoot, rel);

    // Refused case 1: the write would land outside the repository, so no snapshot
    // inside it can cover the change. Catches a symlinked path AND a symlinked
    // ancestor directory — a leaf-only test misses the latter entirely.
    if (escapesRoot(destRoot, dest)) {
      escaping.push(rel);
      continue;
    }

    const st = lstatOrNull(dest);

    // Refused case 2: a DANGLING symlink. There is nothing to copy, so no snapshot
    // of it can be taken — and this is the exact shape that used to be misread as
    // "absent, created by this run" and DELETED on rollback.
    if (st?.isSymbolicLink() && !existsSync(dest)) {
      dangling.push(rel);
      continue;
    }

    if (st) {
      // Includes a VALID symlink resolving inside the repo. copyFileSync follows it
      // in every direction, so backup -> write -> restore returns the target to its
      // original bytes with the link intact. Measured, not assumed.
      const backup = join(dir, rel);
      mkdirSync(dirname(backup), { recursive: true });
      copyFileSync(dest, backup);
      fsyncPath(backup);
      // …and every directory link on the way to it. Syncing only the snapshot root
      // persists the entries directly in it; almost every managed path is nested, so
      // without this the journal can be durable while the file it names is not.
      for (let d = dirname(backup); d.startsWith(dir); d = dirname(d)) fsyncPath(d);
      saved.push(rel);
      continue;
    }

    created.push(rel);
    // Record the ancestor directories the write loop would have to create, so a
    // rollback can prune them back out instead of leaving empty dirs behind.
    for (let d = dirname(dest); d.startsWith(destRoot) && d !== destRoot && !pathPresent(d); d = dirname(d)) {
      createdDirs.add(d);
    }
  }

  // Fail closed, before a single byte is written, and ONLY for what genuinely
  // cannot be rolled back. The message names the paths and the remedy, so this is
  // an actionable refusal rather than the silent-lockout class recorded in
  // brain/core/anti-patterns/.
  if (escaping.length > 0 || dangling.length > 0) {
    rmSync(dir, { recursive: true, force: true });
    const reasons = [];
    if (escaping.length > 0) {
      reasons.push(
        `${escaping.length} path(s) resolve outside the repository, so a write there could not ` +
        `be rolled back — ${escaping.join(', ')}`,
      );
    }
    if (dangling.length > 0) {
      reasons.push(
        `${dangling.length} path(s) are symlinks with no target, so no snapshot of them can be ` +
        `taken — ${dangling.join(', ')}`,
      );
    }
    throw new Error(
      `cannot protect this upgrade: ${reasons.join('; ')}. Point them inside the repository, ` +
      'replace them with real files, or remove them, then re-run. ' +
      'A symlink resolving INSIDE the repository is fine and needs no change.',
    );
  }

  writeJournal({ dir, saved, created, createdDirs, destRoot });

  return restoreHandle({ destRoot, dir, saved, created, createdDirs });
}

// ── Copy managed paths ─────────────────────────────────────────────────────────

/**
 * Copies every file under `srcRoot` whose relative path matches a `managed`
 * glob into `destRoot`, overwriting. A path that also matches a `local` glob is
 * skipped (local always wins) and reported under `skipped`.
 *
 * Before any write begins, a read-only pre-flight pass inspects every managed
 * path that is NOT in `specialMerge`: if the destination exists and its bytes
 * differ from the source, the relative path is pushed to `collisions[]`. This
 * pre-flight always completes before the write loop starts, so a caller with
 * `abortOnCollision: true` is guaranteed to observe zero writes.
 *
 * When `abortOnCollision` is true and `collisions` is non-empty, the function
 * returns immediately — before the write loop — with empty `copied` and `merged`
 * arrays. When false (the default), all files are written and `collisions` is
 * surfaced as a warning list for the caller.
 *
 * When `specialMerge` is provided, any managed path whose relative form is a
 * key in that map is routed through the corresponding merge function instead of
 * `copyFileSync`. Those paths are excluded from the collision guard (they merge,
 * never collide). The merge function receives `(destPath, srcPath)` and is
 * responsible for writing the merged result to disk. Those paths are reported
 * under `merged` (not `copied`). Under `--dry-run` the merge function is NOT
 * called but the path still appears in `merged` so callers can plan output.
 *
 * The write loop is guarded by a restore point (#396): if any write throws, every
 * path the loop could have touched is returned to its pre-call bytes and the
 * original error is re-thrown. A caller that catches therefore sees an unchanged
 * tree, not a half-applied one. See `createRestorePoint` for what this does and
 * does not survive.
 *
 * @param {object}  opts
 * @param {string}  opts.srcRoot          Installed brain package root.
 * @param {string}  opts.destRoot         Consumer repo root.
 * @param {string[]} opts.managed
 * @param {string[]} opts.local
 * @param {boolean} [opts.dryRun]         When true, computes the plan without writing.
 * @param {boolean} [opts.abortOnCollision] When true and collisions exist, returns
 *   before the write loop with empty copied/merged arrays.
 * @param {Record<string, (destPath: string, srcPath: string) => void>} [opts.specialMerge]
 *   Map of relative path → merge function. Paths in this map bypass the collision
 *   guard and copyFileSync.
 * @param {Map<string, Buffer>|null} [opts.outgoing]  What brain shipped LAST time,
 *   from `readOutgoing` before the install (#397). Null means the outgoing tree
 *   was unavailable (e.g. `--no-install`) and detection degrades to two-way.
 * @param {string[]} [opts.refusePaths]   REFUSE-classified paths (#397). One that
 *   the consumer also modified aborts the run before any write.
 * @param {string[]} [opts.forceManaged]  Paths the operator named explicitly to
 *   overwrite anyway. Per path, never a wildcard (signed decision 3).
 * @param {string[]} [opts.retired]  Exact paths the INCOMING package declares it
 *   no longer ships (`lib/retired-paths.mjs`, #1141). Each one present in the
 *   consumer's tree is removed, unless it is `local`, outside `managed`, or the
 *   incoming package ships it again. Removed under the same restore point as the
 *   writes, so a failed run puts them back.
 * @returns {{ copied: string[], skipped: string[], merged: string[], collisions: string[],
 *   consumerModified: string[], brainChanged: string[],
 *   modificationDetection: 'three-way'|'degraded',
 *   refused: string[], forced: string[], removed: string[] }}
 */
export function copyManaged(opts) {
  // ── The `beforeAnyWrite` invariant, owned in ONE place (#447) ───────────────
  //
  // `brain-upgrade.mjs` branches on this flag, and the branch it guards is not a
  // wording preference — it is a statement of fact about the consumer's tree:
  //
  //     "Every managed path was rolled back to the bytes it had before the copy."
  //
  // That sentence must never print for a failure that happened before a restore
  // point existed, because nothing was rolled back and an operator who reads it
  // will not go look at their tree.
  //
  // The flag used to be set at exactly one site — the catch around
  // `createRestorePoint` — while the ENTIRE read-only pre-flight pass, the REFUSE
  // gate and the abort gate sit above it. Every throw from there fell through to
  // the catch-all and printed the false claim. The `restorePointState` re-throw
  // inside that same catch did too.
  //
  // So the invariant is inverted and hoisted: everything is "before any write"
  // UNLESS the run is known to have reached the restore point. A new throw site
  // added above the write loop is then covered by construction, which is the
  // property the one-site version did not have.
  const phase = { restorePointReached: false };
  try {
    return copyManagedImpl(opts, phase);
  } catch (err) {
    if (!phase.restorePointReached && err !== null && typeof err === 'object') {
      try { err.beforeAnyWrite = true; } catch { /* swallow-ok: annotating a frozen error only changes wording; the original error is re-thrown unchanged */ /* frozen — wording stays generic */ }
    }
    throw err;
  }
}

function copyManagedImpl({ srcRoot, destRoot, managed, local, dryRun = false, specialMerge = {}, abortOnCollision = false, outgoing = null, refusePaths = [], forceManaged = [], retired = [] }, phase) {
  const skipped = [];
  const collisions = [];
  const toCopy = [];  // rel paths for plain copyFileSync
  const toMerge = []; // rel paths for specialMerge
  // #397: the two facts the single dest-vs-incoming diff used to conflate.
  const consumerModified = [];
  // REFUSE-classified paths brain is shipping for the FIRST time that already
  // exist in the consumer's tree (#601). Kept separate from consumerModified:
  // the evidence is different (no prior ship, so the bytes are wholly theirs)
  // and a caller reporting "you modified this" about a file brain never shipped
  // would be stating something it cannot know.
  const firstShipOwned = [];
  const brainChanged = [];
  // With no outgoing package there is only one tree, so consumer modification
  // cannot be ESTABLISHED. Reported explicitly because an empty
  // `consumerModified` under a degraded check reads exactly like a confident
  // "nothing was modified" — REQ-397-1 Scenario 3 exists to stop that.
  const modificationDetection = outgoing ? 'three-way' : 'degraded';

  // ── Pre-flight pass (read-only) ─────────────────────────────────────────────
  // Categorise every source file into skipped, toMerge, or toCopy.
  // For toCopy candidates, detect collisions: dest exists AND bytes differ.
  for (const rel of listFiles(srcRoot)) {
    if (!matchesAny(rel, managed)) continue;
    if (matchesAny(rel, local)) {
      // Overlap: local ownership wins. Never clobber the consumer.
      skipped.push(rel);
      continue;
    }

    // Three-way classification (#397, REQ-397-1). Runs for every managed
    // candidate, merged or copied, because it answers a question about the
    // CONSUMER's tree that is independent of what we then do with the path.
    // A path absent from `outgoing` is unknown, not unmodified: brain may be
    // shipping it for the first time, in which case there was nothing to edit.
    if (outgoing?.has(rel)) {
      const outBytes = outgoing.get(rel);
      const destFile = join(destRoot, rel);
      if (existsSync(destFile)) {
        let destBytes = null;
        try { destBytes = readFileSync(destFile); } catch { /* swallow-ok: any read error on an existing destination file (EACCES, EISDIR; ENOENT is excluded by existsSync) means "cannot claim it was edited"; the copy that follows reports a real write failure */ /* unreadable — cannot claim it was edited */ }
        if (destBytes && !destBytes.equals(outBytes)) consumerModified.push(rel);
      }
      try {
        if (!readFileSync(join(srcRoot, rel)).equals(outBytes)) brainChanged.push(rel);
      } catch { /* swallow-ok: unreadable incoming file: the copy below reports the real failure */ /* unreadable incoming — the copy below will report the real failure */ }
    } else if (outgoing !== null && matchesAny(rel, refusePaths) && existsSync(join(destRoot, rel))) {
      // FIRST SHIP OF A REFUSE PATH (#601). brain never shipped this path, and a
      // file is sitting at it in the consumer's tree. Those bytes cannot be
      // brain's — nothing of brain's was ever there — so they are the
      // consumer's, entirely. That is a STRONGER claim than "modified", and it
      // used to produce a weaker outcome: absent from `outgoing`, the path was
      // never consumerModified, so the REFUSE gate never saw it; it was reported
      // as a collision, and `--abort-on-collision` is opt-in, so the default run
      // printed "Proceeding" and overwrote them.
      //
      // The classification exists to prevent exactly this, and it was inert on
      // the one release where the risk is highest: the release that introduces
      // the path. Measured in #596 against a GitLab consumer's own
      // `.gitlab/merge_request_templates/Default.md` — the single most likely
      // file for them to own, since it is the one GitLab auto-applies.
      //
      // Guarded on `outgoing !== null`: under `--no-install` there IS no
      // outgoing tree, and treating that as "brain never shipped this" would
      // refuse every REFUSE path on every degraded run. Unknown-because-degraded
      // and unknown-because-new are different facts, and only the second one is
      // evidence about the consumer's file.
      firstShipOwned.push(rel);
    }

    if (Object.prototype.hasOwnProperty.call(specialMerge, rel)) {
      // Special merge path: excluded from the collision guard.
      toMerge.push(rel);
    } else {
      // Plain copy candidate: check for a collision before the write loop.
      const destFile = join(destRoot, rel);
      if (existsSync(destFile)) {
        const srcBytes = readFileSync(join(srcRoot, rel));
        const destBytes = readFileSync(destFile);
        if (!srcBytes.equals(destBytes)) {
          collisions.push(rel);
        }
      }
      toCopy.push(rel);
    }
  }

  // ── REFUSE gate (#397, REQ-397-2) ───────────────────────────────────────────
  // Only a path that is BOTH consumer-modified AND REFUSE-classified reaches
  // here. A REFUSE classification is not "always ask": untouched, these paths
  // copy like anything else. Asking on every release is how a real warning
  // becomes the thing everyone clicks through.
  //
  // Forcing is per path (signed decision 3). A single flag that forced
  // everything pending would recreate the clobber this issue is about, one
  // keystroke away — so a force names exactly one path and covers exactly it.
  const refused = [];
  const forced = [];
  for (const rel of consumerModified) {
    if (!matchesAny(rel, refusePaths)) continue;
    (forceManaged.includes(rel) ? forced : refused).push(rel);
  }
  // First-ship REFUSE paths take the same gate: named, and overridable by the
  // same per-path `--force-managed`. They are already REFUSE-classified by
  // construction, so no second membership test is needed.
  for (const rel of firstShipOwned) {
    (forceManaged.includes(rel) ? forced : refused).push(rel);
  }

  // Write in a stable order rather than in whatever order the filesystem handed
  // back. Two reasons: an upgrade that fails partway does so at a reproducible
  // point (so a bug report is reproducible), and it matches the sorted arrays
  // this function already returns. The journal half of #396 needs a defined
  // replay order too.
  toMerge.sort();
  toCopy.sort();

  // ── Retired paths (#1141) ───────────────────────────────────────────────────
  // The pre-flight above walks the INCOMING package, so it can never see a file
  // the package stopped shipping. The package names those itself; only the ones
  // still in the consumer's tree, still brain's to manage, and not shipped again
  // are removed. A consumer file beside them is not on the list and is untouched.
  // A REFUSE or MERGE path is never removed: those strategies exist because the
  // consumer's bytes there matter, and deleting them is the clobber REFUSE refuses.
  const toRemove = [...new Set(retired)]
    .filter((rel) => matchesAny(rel, managed) && !matchesAny(rel, local))
    .filter((rel) => !matchesAny(rel, refusePaths) && !Object.hasOwn(specialMerge, rel))
    .filter((rel) => !existsSync(join(srcRoot, rel)))
    .filter((rel) => { try { return lstatSync(join(destRoot, rel)).isFile(); } catch { /* swallow-ok: a retired path that cannot be stat'd is neither removed nor claimed removed; it is left out of the removal list */ return false; } })
    .sort();

  // ── Abort gate ──────────────────────────────────────────────────────────────
  // When the caller requests abort-on-collision and collisions were found, return
  // before the write loop so the caller observes zero writes. Skipped under
  // dryRun: a dry run never writes anyway, so we fall through and return the full
  // plan (toCopy/toMerge) — the caller can report it AND the collisions.
  // A refusal aborts the WHOLE run, not just the refused paths (REQ-397-2).
  // Partially applying would leave the tree in a state no release ever shipped,
  // and the operator has to make one decision per named path anyway. Like the
  // collision gate, it returns BEFORE createRestorePoint (design §6): nothing is
  // written, so there is nothing to roll back.
  //
  // Note the ordering against a FORCED path — forcing does not write here
  // either. If any sibling still refuses, the forced path stays untouched too,
  // because the run as a whole did not happen.
  if ((refused.length > 0 || (abortOnCollision && collisions.length > 0)) && !dryRun) {
    return {
      copied: [],
      skipped: skipped.sort(),
      merged: [],
      collisions: collisions.sort(),
      consumerModified: consumerModified.sort(),
      brainChanged: brainChanged.sort(),
      modificationDetection,
      refused: refused.sort(),
      forced: forced.sort(),
      removed: [],
    };
  }

  // ── Write loop ──────────────────────────────────────────────────────────────
  // Guarded by a restore point (#396): the loop is not atomic — it is a sequence
  // of independent writes — so a throw anywhere inside it would otherwise leave
  // the tree half old and half new. The snapshot is taken before the first write
  // and covers every path either loop can touch, so the rollback is complete
  // regardless of where the failure lands.
  if (!dryRun) {
    let restorePoint;
    try {
      restorePoint = createRestorePoint({ destRoot, relPaths: [...toMerge, ...toCopy, ...toRemove] });
    } catch (err) {
      // An interrupted-run refusal is NOT a failed snapshot. It fires because a
      // journal is already on disk, and that journal plus its snapshot are the only
      // record of a tree some killed run left half-applied. Clearing here would
      // destroy the evidence in the very act of telling the operator to recover from
      // it — the same "destroy what we promised to protect" shape as the `finally`
      // discard and the retry-clears-the-preserved-snapshot bug before it.
      // ALLOW-LIST, not a deny-list. Only a snapshot CONSTRUCTION failure — one that
      // built partial debris of its own — may clear anything here. Every refusal that
      // came from the verdict carries `restorePointState`, and none of them owns what
      // is on disk: `interrupted` and `corrupt` describe a dead run's only evidence,
      // and `live-run` describes a running one's working state.
      //
      // The previous form asked "is this NOT interruptedRun?" and therefore cleared on
      // `live-run` — deleting a live run's snapshot AND journal. That is the same shape
      // this file has now produced five times: a cleanup deciding locally that what it
      // sees is its own debris.
      if (err?.restorePointState) throw err;

      // A genuinely failed snapshot: nothing was written, but it may have built part
      // of a backup first. Clear it — a refusal must not leave debris behind.
      rmSync(join(destRoot, RESTORE_POINT_DIR), { recursive: true, force: true });
      // No `beforeAnyWrite` tag here any more: `phase.restorePointReached` is still
      // false, so copyManaged's wrapper tags BOTH this throw and the
      // `restorePointState` re-throw above it — which the one-site version missed.
      throw err;
    }
    // From here on a restore point exists, so "everything was rolled back" is a
    // claim the caller may legitimately make. Everything above this line is not.
    phase.restorePointReached = true;

    try {
      for (const rel of toMerge) {
        const dest = join(destRoot, rel);
        mkdirSync(dirname(dest), { recursive: true });
        specialMerge[rel](dest, join(srcRoot, rel));
      }
      for (const rel of toCopy) {
        const dest = join(destRoot, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(join(srcRoot, rel), dest);
      }
      for (const rel of toRemove) {
        rmSync(join(destRoot, rel));
        pruneEmptyParents(destRoot, rel);
      }
    } catch (err) {
      const { failed } = restorePoint.restore();
      if (failed.length === 0) {
        // Everything went back. The snapshot has served its purpose.
        safeDiscard(restorePoint);
        throw err;
      }
      // The rollback could NOT put everything back, so the snapshot is now the only
      // surviving copy of those bytes. Move it somewhere no later run auto-clears —
      // only a COMPLETE rollback earns the cleanup, which is why this is not a
      // `finally` — and tell the caller where it went.
      // Left at the DEFAULT path on purpose. Slice 1 renamed it here, because back
      // then a retry cleared that path — but slice 2's journal makes a retry REFUSE
      // instead, and renaming would move the journal out of readJournal's sight and
      // silently disarm the gate over a tree that is still dirty.
      throw annotateRollback(err, failed, restorePoint.dir);
    }

    safeDiscard(restorePoint);
  }

  return {
    copied: toCopy.sort(),
    skipped: skipped.sort(),
    merged: toMerge.sort(),
    collisions: collisions.sort(),
    consumerModified: consumerModified.sort(),
    brainChanged: brainChanged.sort(),
    modificationDetection,
    refused: refused.sort(),
    forced: forced.sort(),
    removed: toRemove,
  };
}

/**
 * Removes the directories a retired path leaves empty, from its parent upward,
 * stopping at the first one that still holds anything and never reaching
 * `destRoot` itself. A consumer file in the same directory keeps it alive.
 */
function pruneEmptyParents(destRoot, rel) {
  let dir = dirname(rel);
  while (dir && dir !== '.' && dir !== '/') {
    const abs = join(destRoot, dir);
    try {
      if (readdirSync(abs).length > 0) return;
      rmdirSync(abs);
    } catch { /* swallow-ok: pruning empty parents is tidying after a removal that already succeeded */ return; }
    dir = dirname(dir);
  }
}

// ── Claude settings merge ─────────────────────────────────────────────────────

/**
 * Merges brain's settings object into an existing consumer settings object
 * without overwriting consumer-owned content. Pure, fs-free — the shared core
 * behind `mergeClaudeSettings` below AND `claude.mjs`/`antigravity.mjs`'s
 * `init()`, which compile brain's content in memory and have no brain-side
 * file to point a path-shaped API at (issue #1139).
 *
 * Behaviour:
 * - `existingSettings` is `null`/`undefined` (no existing file) → brain's
 *   object, as-is (shallow copy).
 * - Otherwise → spread the existing object (all its top-level keys
 *   preserved), then for EVERY hook event brain defines (PreToolUse,
 *   PostToolUse, …), additively append brain's entries that are not already
 *   present. `permissions.allow` and every other existing key are left
 *   untouched.
 *
 * Entry dedup is by `JSON.stringify`, so it is sensitive to key ordering: a
 * brain hook entry a consumer hand-added with a different key order would not
 * dedup and could duplicate. In practice brain owns these entries and writes
 * them with a stable key order, so this is a non-issue.
 *
 * @param {object|null} existingSettings  Parsed existing settings, or `null` if none.
 * @param {object} brainSettings          Parsed brain settings object.
 * @returns {object} The merged settings object.
 */
export function mergeSettings(existingSettings, brainSettings) {
  if (existingSettings == null) {
    return { ...brainSettings };
  }

  // Shallow-spread preserves all top-level existing keys (permissions.allow, etc.).
  const merged = { ...existingSettings };

  // Merge every hook event brain defines: keep existing entries first, then
  // append any brain entries not already present (compared by serialised value).
  // Existing-only hook events are preserved untouched by the spread above.
  const brainHooks = brainSettings.hooks ?? {};
  if (Object.keys(brainHooks).length > 0) {
    const mergedHooks = { ...existingSettings.hooks };
    for (const [event, brainEntries] of Object.entries(brainHooks)) {
      const existingEntries = mergedHooks[event] ?? [];
      const seen = new Set(existingEntries.map((e) => JSON.stringify(e)));
      const additions = brainEntries.filter((e) => !seen.has(JSON.stringify(e)));
      mergedHooks[event] = [...existingEntries, ...additions];
    }
    merged.hooks = mergedHooks;
  }

  return merged;
}

/**
 * Merges brain's `.claude/settings.json` into the consumer's copy without
 * overwriting consumer-owned content. Thin file-IO wrapper around
 * `mergeSettings` above — reads both files, delegates the merge, writes the
 * result.
 *
 * @param {string} existingPath       Absolute path to consumer's settings.json (may not exist).
 * @param {string} brainSettingsPath  Absolute path to brain's settings.json.
 */
export function mergeClaudeSettings(existingPath, brainSettingsPath) {
  const brainSettings = JSON.parse(readFileSync(brainSettingsPath, 'utf8'));

  if (!existsSync(existingPath)) {
    mkdirSync(dirname(existingPath), { recursive: true });
    writeFileSync(existingPath, JSON.stringify(mergeSettings(null, brainSettings), null, 2) + '\n');
    return;
  }

  // The consumer's file is not under brain's control — a corrupt or partial
  // settings.json must fail with a file-identifying message, not an opaque
  // SyntaxError that aborts brain:upgrade with no clue which file is at fault.
  let consumerSettings;
  try {
    consumerSettings = JSON.parse(readFileSync(existingPath, 'utf8'));
  } catch (e) {
    throw new Error(
      `mergeClaudeSettings: could not parse consumer settings at ${existingPath}: ${e.message}`,
    );
  }

  const merged = mergeSettings(consumerSettings, brainSettings);
  writeFileSync(existingPath, JSON.stringify(merged, null, 2) + '\n');
}

// ── Package.json scripts merge ─────────────────────────────────────────────────

/**
 * Merges managed brain:* script entries into a consumer's package.json without
 * overwriting consumer-owned values.
 *
 * Rules:
 * - `out = { ...consumer }` — all top-level consumer fields preserved.
 * - `out.scripts = { ...consumer.scripts }` — created empty if absent.
 * - For each [k, v] in managedScripts: add ONLY if k is NOT already in out.scripts.
 *   Consumer value wins unconditionally — never deleted, never reordered.
 * - Additions are appended in managedScripts iteration order (MANAGED_SCRIPT_KEYS
 *   order when the caller is mergePackageJson).
 * - Serialized as `JSON.stringify(out, null, 2) + '\n'` — matches every other
 *   JSON writer in the repo (mergeClaudeSettings, migrateConfig).
 *
 * @param {string|object} consumerPkgRaw  Consumer's package.json — text or parsed object.
 * @param {Record<string, string>} managedScripts  Brain-managed key→target map.
 * @param {string} [label]  Optional file path for error messages (mirrors mergeClaudeSettings).
 * @returns {string} Serialized package.json (2-space indent + trailing newline).
 */
export function mergePackageJsonScripts(consumerPkgRaw, managedScripts, label) {
  let consumer;
  if (typeof consumerPkgRaw === 'string') {
    try {
      consumer = JSON.parse(consumerPkgRaw);
    } catch (e) {
      const at = label ? ` at ${label}` : '';
      throw new Error(
        `mergePackageJsonScripts: could not parse consumer package.json${at}: ${e.message}`,
      );
    }
  } else {
    consumer = consumerPkgRaw;
  }

  const out = { ...consumer };
  out.scripts = { ...(consumer.scripts ?? {}) };

  for (const [k, v] of Object.entries(managedScripts)) {
    if (!(k in out.scripts)) {
      out.scripts[k] = v;
    }
  }

  return JSON.stringify(out, null, 2) + '\n';
}

/**
 * IO wrapper for mergePackageJsonScripts — implements the specialMerge signature.
 *
 * Reads brain's package.json at `srcPath`, filters its `scripts` to
 * `MANAGED_SCRIPT_KEYS` → managedScripts. Reads the consumer's package.json at
 * `destPath` (may be absent — treated as an empty `{}` so all managed scripts are
 * written). Calls the pure fn and writes the result ONLY if it differs from the
 * current file bytes (idempotent no-op write — no needless mtime churn on re-upgrade).
 *
 * @param {string} destPath  Absolute path to consumer's package.json (may not exist).
 * @param {string} srcPath   Absolute path to brain's package.json.
 */
export function mergePackageJson(destPath, srcPath) {
  const brainPkg = JSON.parse(readFileSync(srcPath, 'utf8'));

  // Filter brain's scripts to only the managed brain:* keys.
  const managedScripts = {};
  for (const key of MANAGED_SCRIPT_KEYS) {
    if (brainPkg.scripts?.[key] !== undefined) {
      managedScripts[key] = brainPkg.scripts[key];
    }
  }

  // Absent consumer → start from an empty object (managed scripts become the only content).
  const consumerRaw = existsSync(destPath)
    ? readFileSync(destPath, 'utf8')
    : '{}';

  const result = mergePackageJsonScripts(consumerRaw, managedScripts, destPath);

  // Write only if content changed — avoid mtime churn on idempotent re-upgrade.
  if (existsSync(destPath) && readFileSync(destPath, 'utf8') === result) return;

  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, result);
}

// ── Config migration ─────────────────────────────────────────────────────────

/**
 * Deep-merges `defaults` into `existing`, preserving every value already
 * present in `existing`. Only missing keys are filled. Arrays and non-plain
 * values are treated as leaves (existing wins). Returns a new object.
 * @param {object} existing
 * @param {object} defaults
 * @returns {object}
 */
export function mergeDefaults(existing, defaults) {
  const isPlainObject = (v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  const out = { ...existing };
  for (const [key, defVal] of Object.entries(defaults)) {
    if (!(key in out)) {
      out[key] = defVal;
    } else if (isPlainObject(out[key]) && isPlainObject(defVal)) {
      out[key] = mergeDefaults(out[key], defVal);
    }
    // else: key exists with a leaf/array value — keep the consumer's value.
  }
  return out;
}

// ── Semver ───────────────────────────────────────────────────────────────────

/**
 * Parses a version string ("v0.1.0", "1.2.3") into [major, minor, patch].
 * Non-numeric or missing parts become 0. Pre-release suffixes are ignored.
 * @param {string} v
 * @returns {[number, number, number]}
 */
export function parseSemver(v) {
  const core = String(v ?? '').trim().replace(/^v/, '').split('-')[0];
  const [maj, min, pat] = core.split('.');
  return [Number(maj) || 0, Number(min) || 0, Number(pat) || 0];
}

/**
 * Compares two versions. Returns -1 if a < b, 0 if equal, 1 if a > b.
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Applies every pending migration to a config object.
 *
 * "Pending" = migration.version > config.schemaVersion AND <= targetVersion.
 * Additive migrations (those with `defaults`) merge defaults without
 * overwriting existing values. Migrations with a `migrate` fn run it with the
 * { mergeDefaults } helper. The returned config carries the new schemaVersion.
 *
 * @param {object} config        The consumer's current brain.config.json.
 * @param {Array}  migrations    Ordered migration descriptors.
 * @param {string} targetVersion The brain version being installed.
 * @returns {{ config: object, applied: string[] }}
 */
export function migrateConfig(config, migrations, targetVersion) {
  const from = config.schemaVersion ?? '0.0.0';
  let result = { ...config };
  const applied = [];
  const ordered = [...migrations].sort((a, b) => compareSemver(a.version, b.version));
  for (const m of ordered) {
    const isAfterCurrent = compareSemver(m.version, from) > 0;
    const isWithinTarget = compareSemver(m.version, targetVersion) <= 0;
    if (!isAfterCurrent || !isWithinTarget) continue;
    if (typeof m.migrate === 'function') {
      result = m.migrate(result, { mergeDefaults });
    } else if (m.defaults) {
      result = mergeDefaults(result, m.defaults);
    }
    applied.push(m.version);
  }
  result.schemaVersion = compareSemver(targetVersion, result.schemaVersion ?? '0.0.0') > 0
    ? targetVersion
    : (result.schemaVersion ?? targetVersion);
  return { config: result, applied };
}

// ── Install URL resolution ─────────────────────────────────────────────────────

/**
 * Canonical HTTPS install URL for the brain package.
 * Used as a fallback when the installed package.json has no repository.url or
 * when that URL cannot be parsed.
 */
export const BRAIN_REPO_HTTPS = 'git+https://github.com/csrinaldi/brain.git';

/**
 * The published package name — the directory npm installs brain into.
 *
 * ONE source, on purpose (issue #623). Measured before extracting it: this path
 * was resolved by literal in nine executable places across six modules, so a
 * scoped rename (`@scope/brain`, ADR-0030) had nine independent chances to miss
 * one. A missed one does not fail at rename time; it fails on the release that
 * first needs that path, inside `brain:upgrade` — the verb a consumer runs to
 * recover. That is #601's shape.
 *
 * `installed-package-root.test.mjs` fails if a second literal reappears
 * anywhere under `brain/scripts/**`, so the rename is now one constant.
 */
export const PACKAGE_NAME = '@logikas/brain';

/**
 * Where releases BEFORE the scoped rename installed. Kept as its own constant
 * rather than a literal inside the resolver, so the day `PACKAGE_NAME` becomes
 * `@scope/brain` this still names the directory a consumer's older tree holds.
 */
export const LEGACY_PACKAGE_DIR = 'brain';

/**
 * Where an installed brain lives inside a consumer repo.
 *
 * Handles a scoped name without the caller knowing: npm splits `@scope/name`
 * into two directory segments, so this must never be a single `join` argument.
 *
 * @param {string} repoRoot  the consumer repo root
 * @param {...string} rest   further segments inside the package
 * @returns {string}
 */
export function installedPackageRoot(repoRoot, ...rest) {
  return resolveInstalledPackageRoot({ repoRoot, rest });
}

/**
 * Resolves where brain ACTUALLY is, preferring the canonical path and falling
 * back to a pre-rename install (issue #625).
 *
 * WHAT THIS DOES NOT FIX, so the scope is not mistaken: a consumer running
 * their OLD vendored `brain-upgrade.mjs` when the scoped release lands still
 * dies. That code resolves `node_modules/brain`, `installSpec` installs from the
 * git URL, npm reads the new package.json and lands the tree under the scope,
 * and the old code finds nothing. It is already in their tree; nothing here
 * reaches it. The rename therefore belongs with the publish, where a consumer
 * changes their install line anyway.
 *
 * What this DOES fix is the mirror case — new code, old install — which is real
 * after any recovery and previously read as "not installed".
 *
 * With neither present it returns the CANONICAL path, so an error names the
 * location a reader should create rather than the one that happens to be older.
 *
 * @param {object}   o
 * @param {string}   o.repoRoot
 * @param {string[]} [o.rest]         segments inside the package
 * @param {string}   [o.packageName]  injectable so the scoped behaviour is testable before the rename
 * @param {string}   [o.legacyDir]
 * @param {(p:string)=>boolean} [o.exists]
 * @returns {string}
 */
export function resolveInstalledPackageRoot({
  repoRoot,
  rest = [],
  packageName = PACKAGE_NAME,
  legacyDir = LEGACY_PACKAGE_DIR,
  exists = existsSync,
} = {}) {
  const canonical = join(repoRoot, 'node_modules', ...packageName.split('/'));
  // Before the rename the two coincide; no probing, no behaviour change.
  if (canonical === join(repoRoot, 'node_modules', legacyDir)) return join(canonical, ...rest);
  if (exists(canonical)) return join(canonical, ...rest);
  const legacy = join(repoRoot, 'node_modules', legacyDir);
  if (exists(legacy)) return join(legacy, ...rest);
  return join(canonical, ...rest);
}

/**
 * Every place `resolveInstalledPackageRoot` probes, in the order it probes them,
 * as repo-relative POSIX paths for humans to read.
 *
 * Deliberately built from the SAME two constants the resolver uses, so a message
 * can never name a path the code did not search. Before the rename the two
 * coincide and this returns one entry — a message that invents a second location
 * sends the reader to look twice at one directory.
 *
 * @param {object} [o]
 * @param {string} [o.packageName]
 * @param {string} [o.legacyDir]
 * @returns {string[]}
 */
export function installedPackageSearchPaths({
  packageName = PACKAGE_NAME,
  legacyDir = LEGACY_PACKAGE_DIR,
} = {}) {
  const canonical = ['node_modules', ...packageName.split('/')].join('/');
  const legacy = ['node_modules', legacyDir].join('/');
  return canonical === legacy ? [canonical] : [canonical, legacy];
}

/**
 * The searched locations rendered for an error message.
 *
 * `brain:upgrade` is the verb a consumer runs to RECOVER, so the text it dies
 * with is the last thing they get before they are on their own. Naming one path
 * while having searched two is worse than not falling back at all: it sends them
 * to inspect a directory the code never looked at (issue #625).
 *
 * @param {object}   [o]
 * @param {string[]} [o.rest]  segments inside the package, e.g. `['package.json']`
 * @param {string}   [o.packageName]
 * @param {string}   [o.legacyDir]
 * @returns {string}
 */
export function describeInstalledPackageSearch({ rest = [], ...o } = {}) {
  const tail = rest.length ? `/${rest.join('/')}` : '';
  const [canonical, legacy] = installedPackageSearchPaths(o).map((p) => `${p}${tail}`);
  return legacy ? `${canonical} (nor the pre-rename ${legacy})` : canonical;
}

/**
 * Normalizes any git repository URL to an npm-installable `git+https://` form.
 *
 * Accepted input forms and their canonical output:
 *   git+https://host/owner/repo.git  → as-is
 *   https://host/owner/repo.git      → prefix `git+`
 *   git+ssh://git@host/owner/repo.git → convert host and path to git+https
 *   git@host:owner/repo.git          → SCP form → convert to git+https
 *   github:owner/repo                → expand to git+https://github.com/…
 *
 * Null / empty input returns BRAIN_REPO_HTTPS (safe fallback).
 *
 * @param {string|null|undefined} url
 * @returns {string}
 */
export function resolveInstallUrl(url) {
  if (!url || typeof url !== 'string' || !url.trim()) return BRAIN_REPO_HTTPS;

  const u = url.trim();

  // Already the correct form.
  if (u.startsWith('git+https://')) {
    return u.endsWith('.git') ? u : `${u}.git`;
  }

  // Plain https — just prefix git+.
  if (u.startsWith('https://')) {
    return 'git+' + (u.endsWith('.git') ? u : `${u}.git`);
  }

  // github: shorthand — npm resolves this to SSH, which is the problem we're fixing.
  const githubShorthand = u.match(/^github:([^#]+)/);
  if (githubShorthand) {
    const path = githubShorthand[1].replace(/\.git$/, '');
    return `git+https://github.com/${path}.git`;
  }

  // git+ssh://git@host/owner/repo.git
  const gitSsh = u.match(/^git\+ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (gitSsh) {
    return `git+https://${gitSsh[1]}/${gitSsh[2]}.git`;
  }

  // git@host:owner/repo.git  (SCP shorthand)
  const scp = u.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (scp) {
    return `git+https://${scp[1]}/${scp[2]}.git`;
  }

  // Unknown form — ensure at least the git+ prefix.
  return u.startsWith('git+') ? u : `git+${u}`;
}

/**
 * Returns the full npm install specifier for brain at the given tag.
 *
 * Reads `repository.url` from the installed brain's `package.json` at
 * `<root>/node_modules/brain/package.json`, normalizes it with
 * `resolveInstallUrl`, and appends `#<tag>`.
 *
 * Falls back to `BRAIN_REPO_HTTPS#<tag>` when the file is absent,
 * unparseable, or the `repository.url` field is missing.
 *
 * The result is ALWAYS in the form `git+https://…#<tag>` — never SSH or
 * `github:` shorthand — so HTTPS-only consumers (CI, containers without
 * SSH keys) can install the private repo without extra setup.
 *
 * @param {string} root Consumer repo root (e.g. `process.cwd()`).
 * @param {string} tag  Git tag to install (e.g. `"v0.4.0"`).
 * @returns {string}
 */
export function installSpec(root, tag) {
  const detail = installSpecDetail(root, tag);
  if (detail.spec === null) throw new Error(`install spec unresolved — ${detail.why}`);
  return detail.spec;
}

/**
 * `installSpec` with the reasoning attached (issue #644).
 *
 * Reads `name` and `repository.url` from the installed manifest and hands both
 * to `resolveInstallSpec`. Prefer this over `installSpec` at any call site that
 * can print: `source` tells a fallback from a manifest-derived answer, and `why`
 * is already written for a human.
 *
 * An absent or unparseable manifest is not swallowed into a bare string here —
 * it reaches the caller as `source: 'fallback'` with a reason. "The manifest
 * said this" and "I guessed" must not look identical.
 *
 * @param {string} root Consumer repo root.
 * @param {string} tag  Git tag or version.
 * @returns {{kind:'registry'|'git'|'unresolved', spec:string|null, source:'manifest'|'fallback', why:string}}
 */
export function installSpecDetail(root, tag, { readProvenance } = {}) {
  const pkgPath = installedPackageRoot(root, 'package.json');
  let name;
  let repoUrl;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (typeof pkg?.name === 'string') name = pkg.name;
    const declared = pkg?.repository?.url ?? (typeof pkg?.repository === 'string' ? pkg.repository : undefined);
    if (typeof declared === 'string') repoUrl = declared;
  } catch { /* surfaced: reported as `source: 'fallback'`, never silently */
    // Absent or unparseable — reported as `source: 'fallback'`, never silently.
  }
  // Injectable so the resolution can be exercised without a real `node_modules`
  // on disk. The search paths come from HERE, so the provenance read and the
  // package the upgrade will actually use can never describe different targets.
  const read = readProvenance
    ?? ((repoRoot) => readInstallProvenance({
      repoRoot,
      searchPaths: installedPackageSearchPaths(),
      // The name to look up is the one this code ships as, not the one the
      // installed tree happens to carry: with `node_modules` deleted there IS
      // no installed tree, and that is exactly the case the declared-dependency
      // read exists to answer.
      packageName: PACKAGE_NAME,
    }));
  let provenance = 'unknown';
  let provenanceWhy = null;
  try {
    const p = read(root);
    provenance = p?.source ?? 'unknown';
    provenanceWhy = p?.why ?? null;
    // With `node_modules` deleted there is no installed manifest to declare a
    // repository, and the canonical constant would send a mirror/air-gap
    // consumer to a host they cannot reach — the one population the git route
    // exists for. The DECLARED dependency spec carries their URL, so it stands
    // in. Only for `git`: a `file:` tarball path is not a repository, and only
    // the base — the ref is replaced by the tag being installed.
    if (!repoUrl && provenance === 'git' && typeof p?.resolved === 'string') {
      const base = p.resolved.split('#')[0].trim();
      if (base) repoUrl = base;
    }
  } catch { /* swallow-ok: a provenance read must never be what stops an upgrade; `unknown` keeps the prior behaviour and the git fallback */
    // A provenance read must never be what stops an upgrade: `unknown` keeps the
    // pre-existing behaviour and the git fallback stays attached.
  }
  const detail = resolveInstallSpec({ name, version: tag, repoUrl, provenance });
  return { ...detail, provenance, provenanceWhy };
}

/**
 * The bare semver inside a git tag or a registry version — `v1.2.0` and `1.2.0`
 * name the same release, and only one of the two forms exists on a registry.
 *
 * THE BOUNDARY IS DECIDED ONCE, HERE (issue #644). Stripping the `v` at each
 * call site is how `@scope/name@v1.2.0` gets built: a spec npm resolves to
 * nothing, reported as "not found" rather than as "wrong shape".
 *
 * Returns null rather than guessing. `latest`, `main` and `''` are not versions,
 * and a caller that receives null can say so; a caller handed `'latest'` as if
 * it were a version installs something nobody pinned.
 *
 * @param {unknown} tagOrVersion
 * @returns {string|null}
 */
export function specVersion(tagOrVersion) {
  if (typeof tagOrVersion !== 'string') return null;
  const m = tagOrVersion.trim().match(/^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  return m ? m[1] : null;
}

/** A scoped npm name — `@scope/name`. The scope is what makes it a registry install. */
const SCOPED_NAME_RE = /^@[^/]+\/.+/;

/**
 * Resolves how brain should be installed, from what the installed manifest says
 * about itself (issue #644, ADR-0030 Decision 3).
 *
 * TWO SHAPES, NOT ONE TRANSLATED INTO THE OTHER:
 *
 * - a **scoped** name → a registry spec, `@scope/name@1.2.0`, with the `v`
 *   stripped because a published version has none;
 * - anything else → the git URL form, `git+https://…#v1.2.0`, with the ref kept
 *   **verbatim** because a git ref is a NAME and not a number — `#1.2.0` is a
 *   different ref, and usually a missing one.
 *
 * The git form is not a leftover. ADR-0030 Amendment 1 (#629) records it as a
 * supported fallback for anyone who can reach a git host but not the registry,
 * measured equivalent: it honours `files` and lands at the same install path.
 *
 * `source` distinguishes a manifest-derived spec from the constant fallback, so
 * a caller can SAY which it used. A fallback that looks identical to a real
 * answer is the #601 shape.
 *
 * PROVENANCE OUTRANKS THE NAME (ADR-0030 Amendment 1's invariant). The scoped
 * name says what the package IS; it does not say where THIS consumer got it.
 * A consumer who installed from a git URL — the documented path for anyone who
 * cannot reach the registry — carries the same scoped name on disk, so deciding
 * by name alone sent them to the registry on every upgrade and made the git
 * fallback unreachable for anything but a first install. `provenance: 'git'`
 * therefore keeps the git form even for a scoped name.
 *
 * `provenance` is optional and `'unknown'` is a first-class answer: the reader
 * is npm-only (`lib/install-provenance.mjs`), and pnpm/yarn/bun consumers are
 * supported. With no provenance the pre-existing behaviour stands unchanged —
 * and `fallbackSpec` carries the git form so a wrong guess is recoverable
 * rather than terminal.
 *
 * @param {object} o
 * @param {string} [o.name]     the installed package's `name`
 * @param {string} [o.version]  a tag or a version
 * @param {string} [o.repoUrl]  the installed package's `repository.url`
 * @param {'registry'|'git'|'file'|'unknown'} [o.provenance]  where this consumer installed FROM
 * @returns {{kind:'registry'|'git'|'unresolved', spec:string|null, source:'manifest'|'fallback', why:string, fallbackSpec:string|null}}
 */
export function resolveInstallSpec({ name, version, repoUrl, provenance } = {}) {
  const gitSpec = () => `${resolveInstallUrl(repoUrl)}#${version}`;
  const scoped = typeof name === 'string' && SCOPED_NAME_RE.test(name);

  // Measured provenance wins. `file:` resolves to git too: a local tarball or a
  // linked checkout is not a registry, and the git URL is the reachable form.
  if (scoped && (provenance === 'git' || provenance === 'file')) {
    return {
      kind: 'git',
      spec: gitSpec(),
      source: repoUrl ? 'manifest' : 'fallback',
      why: `${name} is scoped, but this consumer installed from ${provenance} — upgrading by the same route.`,
      fallbackSpec: null,
    };
  }

  if (scoped) {
    const v = specVersion(version);
    if (!v) {
      return {
        kind: 'unresolved',
        spec: null,
        source: 'manifest',
        why: `"${version}" is not a version, and ${name} installs by version — pass a semver, not a ref.`,
        fallbackSpec: null,
      };
    }
    // The git form rides along as a recovery route. It is what makes a wrong
    // guess survivable on the paths provenance cannot be read from.
    return {
      kind: 'registry',
      spec: `${name}@${v}`,
      source: 'manifest',
      why: provenance === 'registry'
        ? `${name} was installed from the registry; upgrading by version.`
        : `${name} is scoped and this consumer's install source could not be read; installing by version.`,
      fallbackSpec: gitSpec(),
    };
  }
  const source = repoUrl ? 'manifest' : 'fallback';
  return {
    kind: 'git',
    spec: gitSpec(),
    source,
    why: source === 'manifest'
      ? 'the installed name is unscoped; installing from the git URL it declares.'
      : `the installed manifest declared no repository URL; falling back to ${BRAIN_REPO_HTTPS}.`,
    // Already the git form — there is no second route to fall back TO.
    fallbackSpec: null,
  };
}

/**
 * The highest RELEASE in a registry version list.
 *
 * Prereleases are excluded deliberately, and this is a re-derivation rather than
 * a port (ADR-0030's *"never translate … without re-deriving it"*). Two reasons,
 * both measured:
 *
 * 1. `compareSemver` reads only major.minor.patch, so `1.0.0-rc.1` and `1.0.0`
 *    compare EQUAL. A plain `.sort(compareSemver).at(-1)` therefore returns
 *    whichever the registry listed last — an answer that depends on input order.
 * 2. This feeds check-and-notify, which must never tell an operator to install
 *    an rc.
 *
 * Null means "no published release", not "could not read" — the caller still
 * holds the list and can tell them apart. That distinction is doctrine as of
 * ADR-0030 Amendment 1 (#629).
 *
 * @param {string[]|null|undefined} versions
 * @returns {string|null}
 */
export function highestVersion(versions) {
  if (!Array.isArray(versions)) return null;
  const releases = versions
    .map((v) => specVersion(v))
    .filter((v) => v !== null && !/[-+]/.test(v));
  if (releases.length === 0) return null;
  return releases.sort(compareSemver).at(-1);
}

// ── Update check (for day:start) ───────────────────────────────────────────────

/**
 * Parses `git ls-remote --tags` output into the highest semver tag found.
 * Ignores peeled tag refs (`^{}`) and non-semver tags.
 * @param {string} lsRemoteStdout
 * @returns {string|null} The highest tag (e.g. "v1.2.0"), or null if none.
 */
export function highestTag(lsRemoteStdout) {
  const tags = [];
  for (const line of String(lsRemoteStdout).split('\n')) {
    const m = line.match(/refs\/tags\/(\S+)/);
    if (!m) continue;
    const tag = m[1];
    if (tag.endsWith('^{}')) continue;
    if (!/^v?\d+\.\d+\.\d+/.test(tag)) continue;
    tags.push(tag);
  }
  if (tags.length === 0) return null;
  return tags.sort(compareSemver).at(-1);
}

/**
 * Reads the installed brain version. In a consumer, that is the `version` of
 * the installed package's manifest; in the brain repo itself (self-host), the
 * repo's own `package.json`. Returns null if neither is found.
 *
 * The name is matched against `PACKAGE_NAME` **and** the pre-rename `brain`
 * (issue #627). It was a bare `=== 'brain'` literal, which the scope broke in
 * both directions at once — measured on `main` @ `982f544`: null for a consumer
 * with `@logikas/brain` installed, and null for brain's own repo. `day:start`
 * step 4 reads this first, so the whole version check was already inert,
 * reporting "could not determine installed version" rather than failing.
 *
 * The legacy name stays deliberately: a consumer who has not upgraded across
 * the rename still carries `"name": "brain"` on disk, and telling THEM a new
 * version exists is the entire point of the check.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function readInstalledVersion(repoRoot) {
  const names = new Set([PACKAGE_NAME, LEGACY_PACKAGE_DIR]);
  const candidates = [
    installedPackageRoot(repoRoot, 'package.json'),
    join(repoRoot, 'package.json'),
  ];
  for (const path of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      if (names.has(pkg.name) && pkg.version) return pkg.version;
    } catch { /* swallow-ok: tries the next candidate path; falling off the end returns null, the "version unknown" answer */
      // try next candidate
    }
  }
  return null;
}
