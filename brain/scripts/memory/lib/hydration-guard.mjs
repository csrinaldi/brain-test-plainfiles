// hydration-guard.mjs — a machine-scoped, NON-BLOCKING guard around the engram
// adapter's import window (#820; memory 2.0 task 0.1, Wave 0).
//
// `importMemory` computes its delta from a snapshot of the backend and writes it
// later; `engram import` INSERTS. Two importers through one snapshot double the
// batch, permanently — it fired three times on 2026-09-01, on a path that runs
// at every session start and every `post-merge`, with sixty worktrees sharing
// ONE store. That is why the lock lives in `os.tmpdir()` and not under
// `.memory/`: a per-worktree lock would guard nothing. It is not under the
// backend's own directory either — that layout is the adapter's private
// business (#863's no-artifact rule cuts both ways).
//
// Contention is a SKIP, never a wait. A second importer that finds the guard
// held returns `{held:false, owner}`; the caller says so on stderr and lets the
// next run retry. `post-merge` is `|| true` on purpose, and #795 is what a
// memory path that gets in the way turns into. A stale guard — dead pid, or
// older than `staleMs` — is reclaimed, so a crashed importer cannot wedge
// hydration forever.
//
// This is MITIGATION. The fix is #863's backend contract: hydration from
// records is idempotent by record id, and a backend that satisfies it needs no
// guard at all. Under `MEMORY_BACKEND=plainfiles` `import` is `rebuildIndex`,
// idempotent by construction, and this module is never wired in.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const DEFAULT_LOCK_PATH = join(tmpdir(), 'brain-memory-hydration.lock');
export const DEFAULT_STALE_MS = 10 * 60 * 1000;
const OWNER_FILE = 'owner.json';

function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) { /* swallow-ok: kill(pid, 0) throws by design to say "not alive"; EPERM (alive, not ours) maps to true */
    // EPERM is an ALIVE pid this user may not signal; only ESRCH means dead.
    return err?.code === 'EPERM';
  }
}

function readOwner(lockPath) {
  try {
    const o = JSON.parse(readFileSync(join(lockPath, OWNER_FILE), 'utf8'));
    if (typeof o?.pid === 'number' && typeof o?.startedAt === 'number') return o;
  } catch { /* swallow-ok: an absent or unreadable owner file falls to the directory-age rule the caller applies */
    /* absent or unreadable → the caller decides by the directory's age */
  }
  return null;
}

function sameOwner(a, b) {
  return Boolean(a && b) && a.pid === b.pid && a.startedAt === b.startedAt;
}

const NO_OWNER = Object.freeze({ pid: -1, startedAt: 0, ageMs: 0 });
const PRIVATE_TAGS = ['staging', 'stale', 'released'];

/**
 * Every two-step sequence here (mkdir+rename, rename+rm) can be killed between
 * its steps — SIGKILL, OOM — and leave a private sibling directory beside the
 * lock forever (rev-2 cold review of PR #872, cold-1). Nothing else would ever
 * list them. So a CONTENDED acquire sweeps siblings older than `staleMs` (the
 * uncontended fast path pays no readdir); a live sequence completes in
 * microseconds, so age alone is the safe criterion. Best effort, never throws.
 */
function sweepOrphans(lockPath, staleMs, now) {
  const dir = dirname(lockPath);
  const prefix = `${basename(lockPath)}.`;
  let names;
  try { names = readdirSync(dir); } catch { /* swallow-ok: reclaiming orphans is opportunistic; the lock take itself still runs and reports contention */ return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const tag = name.slice(prefix.length).split('-')[0];
    if (!PRIVATE_TAGS.includes(tag)) continue;
    const full = join(dir, name);
    try {
      if (now - statSync(full).mtimeMs > staleMs) rmSync(full, { recursive: true, force: true });
    } catch { /* swallow-ok: gone already or unreadable — not ours to insist on */
      /* gone already, or unreadable — not ours to insist on */
    }
  }
}

/**
 * Try to take the guard.
 *
 * ACQUISITION IS ONE ATOMIC STEP (rev-1 cold review of PR #872, cold-1). The
 * first version did `mkdirSync(lock)` and then wrote `owner.json` as a second
 * syscall; a process hitting EEXIST in between saw a lock with no owner,
 * called it stale, reclaimed it, and BOTH ended up holding. Now the owner
 * record is written into a private staging directory first and the staging
 * directory is `rename`d onto the lock path: the lock either exists with its
 * owner inside, or does not exist. A rename onto an existing NON-EMPTY
 * directory fails (ENOTEMPTY/EEXIST), which is the contended signal.
 *
 * RECLAIM IS VERIFIED. A stale lock (dead pid, or older than `staleMs`) is
 * renamed away to a private tombstone — atomic — and its owner re-read there.
 * Only if it is still the owner the stale decision was made about is it
 * removed; if another process installed a fresh lock in between, the
 * tombstone is renamed back and this call reports contended. What remains
 * unguarded is the rename-back itself losing a three-way race in the same
 * microseconds; the consequence is the pre-#820 behaviour, never worse, and
 * the fix for that class is #863's idempotent hydration, not a better lock.
 *
 * @returns {{held: true, release: () => void} | {held: false, owner: {pid:number, startedAt:number, ageMs:number}}}
 */
export function acquireHydrationGuard({
  lockPath = DEFAULT_LOCK_PATH,
  staleMs = DEFAULT_STALE_MS,
  _pidAlive = defaultPidAlive,
  _now = Date.now,
  _pid = process.pid,
} = {}) {
  const privateDir = (tag) => `${lockPath}.${tag}-${_pid}-${process.hrtime.bigint().toString(36)}`;
  let mine = null; // the owner record this call installed, for the release check

  // RELEASE IS ATOMIC TOO, and verified. `rmSync(lockPath, {recursive})` in place
  // unlinks owner.json and THEN rmdir's — and between the two the lock path is an
  // empty directory, which a POSIX rename from another process's staging dir
  // silently replaces. The multi-process test caught it: the releaser's rmdir
  // then fails ENOTEMPTY on the newcomer's lock. So: rename the lock aside
  // (atomic — the path is never empty-but-present), confirm it is still ours,
  // and remove the tombstone. If it is not ours (we were reclaimed as stale),
  // put it back. Never throws: a release failure must not mask the import.
  const release = () => {
    const tomb = privateDir('released');
    try {
      renameSync(lockPath, tomb);
    } catch { /* swallow-ok: ENOENT means reclaimed by someone else; any other rename error leaves the lock in place, which the stale-lock rule frees — release must never mask the import */
      return; // already gone — reclaimed by someone else; nothing of ours to remove
    }
    const moved = readOwner(tomb);
    if (sameOwner(moved, mine)) {
      rmSync(tomb, { recursive: true, force: true });
      return;
    }
    try { renameSync(tomb, lockPath); } catch { /* swallow-ok: putting the lock back lost a race; removing the tombstone is the safe end, the lock was not ours */ rmSync(tomb, { recursive: true, force: true }); }
  };

  const take = () => {
    const staging = privateDir('staging');
    mkdirSync(staging);
    const owner = { pid: _pid, startedAt: _now() };
    writeFileSync(join(staging, OWNER_FILE), JSON.stringify(owner), 'utf8');
    try {
      renameSync(staging, lockPath);
      mine = owner;
      return { held: true, release };
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      if (err?.code === 'ENOTEMPTY' || err?.code === 'EEXIST' || err?.code === 'EPERM') return null;
      throw err;
    }
  };

  const describe = (owner) => (owner ? { pid: owner.pid, startedAt: owner.startedAt, ageMs: _now() - owner.startedAt } : NO_OWNER);

  for (let attempt = 0; attempt < 2; attempt++) {
    const got = take();
    if (got) return got;

    // Contended path only (rev-3 cold review of PR #872): a readdir of tmpdir on
    // every uncontended acquire would tax every session start for a leak that
    // can only exist once something has gone wrong here.
    if (attempt === 0) sweepOrphans(lockPath, staleMs, _now());

    const owner = readOwner(lockPath);
    let stale;
    if (owner) {
      stale = !_pidAlive(owner.pid) || _now() - owner.startedAt > staleMs;
    } else {
      // Not a lock this module ever creates (ours always carry their owner).
      // Unknown is not stale: reclaim only once the directory itself is old.
      let ageMs = 0;
      try { ageMs = _now() - statSync(lockPath).mtimeMs; } catch { /* surfaced: an unreadable lock path returns `held: false`, which the caller reports as contention */ return { held: false, owner: NO_OWNER }; }
      stale = ageMs > staleMs;
    }
    if (!stale) return { held: false, owner: describe(owner) };

    // Verified reclaim: move the stale lock aside atomically, confirm it is
    // still the one judged stale, and only then discard it.
    const tomb = privateDir('stale');
    try {
      renameSync(lockPath, tomb);
    } catch { /* swallow-ok: someone else moved the stale lock first; the loop retries the take */
      continue; // someone else moved it first — retry the take
    }
    const moved = readOwner(tomb);
    if (owner ? sameOwner(moved, owner) : moved === null) {
      rmSync(tomb, { recursive: true, force: true });
      continue;
    }
    // A fresh lock was installed between the decision and the reclaim: put it back.
    try { renameSync(tomb, lockPath); } catch { /* swallow-ok: putting the lock back lost a race; removing the tombstone is the safe end, the lock was not ours */ rmSync(tomb, { recursive: true, force: true }); }
    return { held: false, owner: describe(moved) };
  }
  return { held: false, owner: describe(readOwner(lockPath)) };
}

/**
 * Run `fn` under the guard. `{held:true, result}` or `{held:false, owner}`; a
 * throw inside `fn` releases the guard and propagates.
 */
export function withHydrationGuard(fn, opts = {}) {
  const g = acquireHydrationGuard(opts);
  if (!g.held) return g;
  try {
    return { held: true, result: fn() };
  } finally {
    g.release();
  }
}
