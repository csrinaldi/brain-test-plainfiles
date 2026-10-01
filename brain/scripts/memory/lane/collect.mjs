// collect.mjs — the IO shell for the lane collector (#887 Slice B, ADR-0034 L4/C2).
//
// collectLane() is the only place this slice touches the machine: it
// enumerates worktrees, reads bytes, scans them for secrets, writes blobs,
// builds a tree in a TEMPORARY index, mints a commit, and moves ONE local
// ref with a compare-and-swap. Every decision about WHICH bytes survive is
// delegated to `lane/plan.mjs`'s planLaneCommit() (A1) — this module never
// decides who wins a group, it only executes the plan.
//
// See openspec/changes/issue-887-lane-collector/design.md, decisions A1-A9,
// and its "Data flow" section for the exact command sequence this mirrors.

import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { planLaneCommit } from './plan.mjs';
import { contentDelivery } from './delivery.mjs';
import { scanTextForSecrets, resolveSecretConfig, compilePatterns } from '../lib/secret-scrub.mjs';
import { loadBrainConfigOrThrow } from '../../lib/brain-config.mjs';
// removeTempTree, not a bare rmSync: this module spawns git AND recursively
// removes a directory (the temp index's mkdtemp dir) — issue #800/#802's
// adoption rule for exactly that combination. Imported from `lib/`, not
// `__fixtures__/` (issue #887 correction C2): this is a production module,
// and `lib/tmp-tree.mjs` is now the production home for the helper —
// `__fixtures__/tmp-tree.mjs` re-exports it for every existing test import.
import { removeTempTree } from '../../lib/tmp-tree.mjs';

// Node's execFileSync defaults to a 1 MiB output buffer — the same ceiling
// governance/postmerge/git-seam.mjs raises for the same reason (#332): a
// large `ls-tree`/`status` over a long-lived worktree tree must not collapse
// to an unmapped -1 status just because our own limit, not git's, was hit.
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * defaultGit() — A3: shaped like governance/postmerge/git-seam.mjs#gitTry,
 * widened by `input` (A2's exact-bytes hash) and `env` (A9's GIT_INDEX_FILE).
 * NEVER throws — a genuine spawn failure collapses to status -1, still
 * distinguishable from every real git exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, input?: string, env?: Record<string,string> }} [opts]
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function defaultGit(argv, { cwd = process.cwd(), input, env } = {}) {
  try {
    const stdout = execFileSync('git', argv, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: DEFAULT_MAX_BUFFER,
      input,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) { /* surfaced: ENOBUFS is returned as status -1, an uncomputable git result the callers never read as a pass */
    if (err.code === 'ENOBUFS') {
      return {
        status: -1,
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: `git output exceeded the ${DEFAULT_MAX_BUFFER}-byte output buffer (ENOBUFS)`,
      };
    }
    return {
      status: typeof err.status === 'number' ? err.status : -1,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : String(err.message ?? ''),
    };
  }
}

/** Run `git(argv, opts)`; return stdout on status 0, throw (`.status` attached) otherwise. */
function gitOrThrow(git, argv, opts = {}) {
  const result = git(argv, opts);
  if (result.status !== 0) {
    const err = new Error(`git ${argv.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
    err.status = result.status;
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }
  return result.stdout;
}

/**
 * _defaultLoadConfig() — reads `brain.config.json` for the
 * `governance.memorySecret*` keys, via `loadBrainConfigOrThrow` (#942).
 *
 * DIRECTION RULE (#712, R1): `memorySecretPatterns` is DENY-direction and
 * `memorySecretAllowPatterns` is ALLOW-direction, but ONE read carries both
 * — a read cannot be half-propagated, so the deny-direction key decides for
 * the whole read. ENOENT still returns `{}` (absence stays green, R12/
 * REQ-SCAN-3); every OTHER read/parse failure PROPAGATES (REQ-SCAN-1) —
 * this reader no longer swallows it. The call site (`cli.mjs`'s `collect`
 * catch arm) decides the refusal; this function only reads.
 *
 * @param {string} root
 * @returns {object}
 */
function _defaultLoadConfig(root) {
  return loadBrainConfigOrThrow(root);
}

/**
 * Parse `git worktree list --porcelain` into `{path, bare, prunable}` stanzas.
 *
 * E3: a `locked` stanza is deliberately NOT tracked here. Per design.md's
 * scope table (:234), a locked worktree is INCLUDED in the scan by design —
 * `git worktree lock` only guards against accidental `worktree remove`/
 * `prune`, it has no bearing on whether this collector should read the
 * worktree's `.memory/records/` candidates, and an unreadable path already
 * degrades to a per-candidate `unreadable` skip regardless of lock state.
 * Carrying a field nothing ever reads would be dead state, not a real gate.
 */
export function parseWorktrees(stdout) {
  const stanzas = [];
  let current = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), bare: false, prunable: false };
      stanzas.push(current);
    } else if (current && line === 'bare') {
      current.bare = true;
    } else if (current && line.startsWith('prunable')) {
      current.prunable = true;
    }
  }
  return stanzas;
}

/**
 * Parse `git status --porcelain -z -uall -- .memory/records` output.
 * NUL-delimited, two-char status code + space + repo-relative path. A
 * rename/copy record (`status[0]` is `R` or `C`) carries a SECOND
 * NUL-terminated part immediately after: the pre-image (old) path, with no
 * status-code prefix of its own — `R  new\0old\0`. That second part is
 * consumed here as the old path, never parsed as a separate `{status, path}`
 * entry (cold review #897, C1-adjacent): slicing two arbitrary characters
 * off a bare path as if they were a status code would otherwise manufacture
 * a bogus second candidate that was never a real status line. The surviving
 * (new-path) entry itself is still routed to `unexpected-status` by the
 * planner — a renamed path is unreachable for this pathspec under normal use
 * (records are appended, not renamed), and `unexpected-status` is the closed
 * reason set's correct bucket for it.
 */
function parseStatusZ(stdout) {
  const parts = stdout.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length < 4) continue;
    const status = part.slice(0, 2);
    const path = part.slice(3);
    entries.push({ status, path });
    if ((status[0] === 'R' || status[0] === 'C') && i + 1 < parts.length) {
      i += 1; // consume the old-path NUL part; it is not its own entry.
    }
  }
  return entries;
}

/**
 * buildCandidate() — A1/A2: read the file's bytes ONCE and scan that exact
 * string. Every status entry is read, regardless of what it will turn out to
 * be routed as — the planner (not this function) decides what is
 * collectable, so duplicating its filename/status grammar here would be a
 * second place for the rule to drift (A7's own rationale, restated).
 */
function buildCandidate(worktreePath, entry, patterns, allowPatterns) {
  const file = basename(entry.path);
  const absPath = join(worktreePath, entry.path);
  let content = null;
  let readError;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch (err) { /* surfaced: recorded as `readError` on the candidate and routed to skipped with its reason */
    readError = err.message;
  }
  let secret;
  if (content !== null) {
    const hit = scanTextForSecrets(content, patterns, allowPatterns);
    if (hit) secret = { pattern: hit.pattern, lineNumber: hit.lineNumber };
  }
  return { worktree: worktreePath, file, path: entry.path, status: entry.status, content, readError, secret };
}

/**
 * collectLane() — B2: the IO shell. See design.md's "Data flow" for the
 * exact command sequence.
 *
 * @param {{
 *   root: string,
 *   date?: string,
 *   host?: string,
 *   git?: typeof defaultGit,
 *   loadConfig?: (root: string) => object,
 * }} opts
 * @returns {{ref: string, commit: string|null, collected: number, skipped: object[],
 *   duplicates: object, baseFetched: boolean, skippedWorktrees: Array<{path: string, reason: string}>,
 *   reparented: boolean}}
 */
export function collectLane({
  root,
  date = new Date().toISOString().slice(0, 10),
  host = hostname(),
  git = defaultGit,
  loadConfig = _defaultLoadConfig,
}) {
  // A4: date is read once by the caller's default above, not re-read below —
  // a run that crosses midnight must not mint two refs.

  // 1. fetch origin main — best-effort. A failed fetch degrades to the local
  //    origin/main ref, never aborts the run (A9's "offline" branch).
  const fetchResult = git(['fetch', 'origin', 'main'], { cwd: root });
  const baseFetched = fetchResult.status === 0;

  // 2. the base tree/commit this run measures candidates against.
  const originMainTip = gitOrThrow(git, ['rev-parse', 'origin/main'], { cwd: root }).trim();

  // 3. one `worktree list --porcelain` call (D6 cost control).
  const worktreeListOut = gitOrThrow(git, ['worktree', 'list', '--porcelain'], { cwd: root });
  const stanzas = parseWorktrees(worktreeListOut);

  // 4. one `ls-tree` for the whole run (D6 cost control) — mainPaths.
  const lsTreeOut = gitOrThrow(git, ['ls-tree', '-r', '--name-only', 'origin/main'], { cwd: root });
  const mainPaths = lsTreeOut.split('\n').filter(Boolean);

  // 5. secret config, resolved once per run.
  const { patternSources, allowPatternSources } = resolveSecretConfig(loadConfig(root));
  const patterns = compilePatterns(patternSources);
  const allowPatterns = compilePatterns(allowPatternSources);

  // 6. one `status -z -uall` per worktree (A8), `-C <wt>` in argv — the ONLY
  //    `-C` call in this module (the seam guard, design's 3b, asserts this).
  //    `prunable`/`bare` stanzas are skipped without ever calling `status`
  //    on them, and `git worktree prune` is never invoked anywhere here.
  //
  // #921: a `status` invocation that exits non-zero is NOT the same fact as
  // "this worktree has nothing pending" — the former means part of the scan
  // universe could not be inspected at all, and collapsing it into silence
  // makes `collected: 0` ambiguous between "confirmed nothing" and
  // "incomplete inspection". Every such worktree is now recorded, by path
  // and reason, in `skippedWorktrees` — a SEPARATE list from `skipped`
  // (plan.mjs's per-candidate skip list): this is a worktree-level failure,
  // never a candidate the planner ever saw.
  const candidates = [];
  const skippedWorktrees = [];
  for (const stanza of stanzas) {
    if (stanza.bare || stanza.prunable) continue;
    const statusResult = git(
      ['-C', stanza.path, 'status', '--porcelain', '-z', '-uall', '--', '.memory/records'],
      { cwd: root },
    );
    if (statusResult.status !== 0) {
      const reason = statusResult.stderr.trim() || `git status exited ${statusResult.status}`;
      skippedWorktrees.push({ path: stanza.path, reason });
      continue;
    }
    for (const entry of parseStatusZ(statusResult.stdout)) {
      candidates.push(buildCandidate(stanza.path, entry, patterns, allowPatterns));
    }
  }

  // 7. the plan. `parent` is a placeholder here: ref/files/skipped/duplicates/
  //    message never depend on it, only the RETURNED `parent` field does — so
  //    it is safe to correct that one field below once the ref's real tip (if
  //    any) is known, without re-invoking the planner (badHost would already
  //    have thrown by now if the host were invalid).
  let plan;
  try {
    plan = planLaneCommit({ candidates, mainPaths, host, date, parent: { ref: originMainTip, tip: null } });
  } catch (err) {
    if (typeof err.message === 'string' && err.message.startsWith('memory.collect.badHost')) err.badHost = true;
    throw err;
  }

  // 8. A9: observe the ref's current tip AT PLAN TIME — this is the `<old>`
  //     value the CAS below is compared against. If it moved between here and
  //     the `update-ref` call, the CAS fails and the run reports `raced`.
  //
  //  #936 (D3, the #1050 fix): a same-day append used to ALWAYS parent on
  //  the existing tip, even when that tip's own content had already reached
  //  `origin/main` (e.g. a same-day squash-merge) — the three-dot diff
  //  against `origin/main` then re-derived every one of the tip's own paths
  //  as "added by this lane" forever, since a squash-merged lane shares no
  //  commit ancestry with `main` (`surveyDelivery`'s own doc comment). The
  //  shared `contentDelivery()` helper answers the same question this
  //  module's own step-9 delivery survey (`ship.mjs`'s `surveyDelivery`)
  //  asks: when the existing tip is fully `delivered`, this run reparents
  //  onto `origin/main`'s own tip instead — `pending`/`unknown` keep
  //  appending on the existing tip exactly as before this change, since a
  //  partial or unreadable delivery state must never reparent.
  const refCheck = git(['rev-parse', '--verify', '--quiet', plan.ref], { cwd: root });
  const existingTip = refCheck.status === 0 ? refCheck.stdout.trim() : null;
  const oldTipArg = existingTip ?? '';
  let reparented = false;
  if (existingTip) {
    const delivery = contentDelivery({ git, root, rev: existingTip, baseFetched });
    if (delivery.status === 'delivered') {
      plan.parent = originMainTip;
      reparented = true;
    } else {
      plan.parent = existingTip; // D2: same-day append parents off the ref's tip, not origin/main
    }
  }

  // 9. blobs for the winners ONLY (A1: a marked candidate never reaches
  //    `plan.files`, so `hash-object -w` is structurally unreachable for it).
  const blobs = plan.files.map((f) => ({
    path: f.path,
    sha: gitOrThrow(git, ['hash-object', '-w', '--stdin', '--path', f.path], { cwd: root, input: f.content }).trim(),
  }));

  // 10. build the tree in a TEMPORARY index (D6: no working tree, no repo
  //     index, is ever touched — `read-tree`/`update-index --cacheinfo`/
  //     `write-tree` with no `-u`/`-m` flag never checks anything out).
  const tmpDir = mkdtempSync(join(tmpdir(), 'brain-lane-index-'));
  const tmpIndex = join(tmpDir, 'index');
  try {
    const env = { GIT_INDEX_FILE: tmpIndex };
    gitOrThrow(git, ['read-tree', plan.parent], { cwd: root, env });
    for (const b of blobs) {
      gitOrThrow(git, ['update-index', '--add', '--cacheinfo', '100644', b.sha, b.path], { cwd: root, env });
    }
    const newTreeSha = gitOrThrow(git, ['write-tree'], { cwd: root, env }).trim();
    const parentTreeSha = gitOrThrow(git, ['rev-parse', `${plan.parent}^{tree}`], { cwd: root }).trim();

    if (newTreeSha === parentTreeSha) {
      // Nothing new: the ref is left exactly as it was, `update-ref` is never
      // called — the "nothing new is a no-op" scenario, verbatim. `reparented`
      // is `false` here even when the delivery read above decided to reparent
      // (`plan.parent = originMainTip`): no commit was minted and the ref's
      // own tip never moved, so nothing was actually reparented. A fully
      // delivered tip stranded this way is harmless (D5) — the next run with
      // genuinely new content reparents it, or the cross-day sweep deletes it.
      return {
        ref: plan.ref, commit: null, collected: 0, skipped: plan.skipped,
        duplicates: plan.duplicates, baseFetched, skippedWorktrees, reparented: false,
      };
    }

    // C1: `plan.files.length` counts GROUP WINNERS, not new blobs. On a
    // same-day re-run, a file already baked into the ref's prior tip
    // re-enters `plan.files` unchanged — it is still an untracked candidate
    // on disk, and `mainPaths` is filtered against origin/main, never the
    // lane ref the parent is actually built from. The tree diff between the
    // parent this commit is built on and the tree just written is the only
    // reliable measure of what is genuinely NEW; `collected` and the commit
    // message are both derived from THAT, not from the planner's per-run
    // winner count. Kept as a tree-diff read rather than teaching the
    // planner about the ref's tip, so `plan.mjs` stays pure and untouched.
    const addedPaths = gitOrThrow(
      git,
      ['diff-tree', '-r', '--name-only', '--no-commit-id', parentTreeSha, newTreeSha],
      { cwd: root },
    ).split('\n').filter(Boolean);
    const message = plan.message.replace(/\(\d+ records\)$/, `(${addedPaths.length} records)`);

    const newCommitSha = gitOrThrow(
      git,
      ['commit-tree', newTreeSha, '-p', plan.parent, '-m', message],
      { cwd: root },
    ).trim();

    // 11. the CAS. A lost race is NOT retried — the loser's plan is stale,
    //     its blobs are harmless loose objects, and a re-run collects them.
    const updateRefResult = git(['update-ref', plan.ref, newCommitSha, oldTipArg], { cwd: root });
    if (updateRefResult.status !== 0) {
      // E2: `update-ref` can fail for reasons that are NOT a lost race (a
      // malformed ref, a permissions error, disk pressure...). Only tag
      // `raced` when git's own stderr names exactly the CAS-lock shapes it
      // actually produces on a lost compare-and-swap — "cannot lock ref"
      // (covers both the old-value-mismatch and the must-not-exist
      // collision) and, defensively, the two more specific phrasings the
      // review flagged. Anything else is a genuine failure and must say so.
      if (/cannot lock ref|reference already exists|is at .* but expected/.test(updateRefResult.stderr)) {
        const err = new Error(`memory.collect.raced: ${plan.ref} moved during this run — ${updateRefResult.stderr.trim()}`);
        err.raced = true;
        throw err;
      }
      const err = new Error(`git update-ref ${plan.ref} exited ${updateRefResult.status}: ${updateRefResult.stderr.trim()}`);
      err.status = updateRefResult.status;
      throw err;
    }

    return {
      ref: plan.ref,
      commit: newCommitSha,
      collected: addedPaths.length,
      skipped: plan.skipped,
      duplicates: plan.duplicates,
      baseFetched,
      skippedWorktrees,
      reparented,
    };
  } finally {
    removeTempTree(tmpDir);
  }
}
