// brain-audit.test.mjs — fixture-based tests for brain-audit.mjs (REQ-S4-5, REQ-S4-6)
// Uses a temporary git repository with synthetic merge commits to test without
// touching the real repo.  Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';

const AUDIT_SCRIPT = new URL('./brain-audit.mjs', import.meta.url).pathname;

import { crossCheckExit, formatUncomputableLine, formatPrSourceSuffix } from './brain-audit.mjs';
import { readMergeParent } from './lib/merge-walk.mjs';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeRepo(dir) {
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
  return git;
}

function commit(git, dir, files, message) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(abs.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(abs, content);
  }
  git('add', '-A');
  git('commit', '-m', message);
}

/**
 * Build a plaintext record string containing a single session_summary observation.
 */
function makeSessionSummaryRecord() {
  // #1188: the audit runs the memory-gate's issue-scoped predicate, so the base
  // record is scoped to every issue number the fixtures' merges close (#1..#9, #443).
  return [1, 2, 3, 4, 5, 6, 7, 8, 9, 443].map((issue) => JSON.stringify({
    id: `rec-${issue}`,
    ts: '2026-07-12T12:00:00Z',
    actor: '@test',
    actorKind: 'human',
    type: 'session_summary',
    project: 'brain',
    issue,
    content: 'Test session summary',
  })).join('\n') + '\n';
}


// ── Tests ─────────────────────────────────────────────────────────────────────

test('brain-audit: PASS merge — emits [PASS] and exits 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-pass-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);

  // Initial commit on main
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  // Feature branch with all invariants satisfied:
  //   issueLink   → "Closes #1" in commit message
  //   diffSize    → tiny diff
  //   adrPresence → neither ADR nor HOME.md changed → pass (no ADR needed)
  //   memoryPresence → .memory/records/ contains a valid session_summary observation
  git('checkout', '-b', 'feature/good');
  commit(git, dir,
    { '.memory/records/2026-07.jsonl': makeSessionSummaryRecord() },
    'feat: good feature Closes #1 (#1)');

  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/good', '-m', 'Merge branch feature/good Closes #1');

  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD~1..HEAD'], {
    cwd: dir, encoding: 'utf8',
  });

  assert.ok(r.stdout.includes('[PASS]'), `expected [PASS] in stdout:\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr: ${r.stderr}`);
});

test('brain-audit: FAIL merge — emits [FAIL] with invariants and exits 1', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-fail-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  // Bad feature: no issue link + no memory → 2 failures
  git('checkout', '-b', 'feature/bad');
  commit(git, dir, { 'src/feature.mjs': 'export const x = 1;' }, 'feat: bad feature');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/bad', '-m', 'Merge branch feature/bad (no issue link)');

  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD~1..HEAD'], {
    cwd: dir, encoding: 'utf8',
  });

  assert.ok(r.stdout.includes('[FAIL]'), `expected [FAIL] in stdout:\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes('issueLink'), `expected "issueLink" in output:\n${r.stdout}`);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
});

// This test used to be `no merges in range — exits 0 with info message`, and its
// fixture was a range holding one ordinary commit. That is not an empty range: it
// is the #518 defect stated as an expectation. A commit was there, nothing looked
// at it, and the audit called the window clean.
//
// The property that survives is about a range with NOTHING in it, which is a real
// state (a cron run with no new commits since the cursor) and must still exit 0.
test('brain-audit: a genuinely EMPTY range exits 0 with an info message', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-empty-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD..HEAD'], { cwd: dir, encoding: 'utf8' });

  assert.equal(r.status, 0, `an empty range is clean, not uncomputable:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /No commits found/, `and says so:\n${r.stdout}`);
});

test('#518: an ordinary commit in range is AUDITED — the old "no merges" silence is gone', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-nonmerge-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  commit(git, dir, { 'x.md': 'x' }, 'docs: add x (#1)');

  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD~1..HEAD'], { cwd: dir, encoding: 'utf8' });

  // `(#1)` is a PR reference, not a closing keyword — issueLink's rule is unchanged
  // and now actually reaches this commit. Before #518 this window exited 0 having
  // read nothing.
  assert.equal(r.status, 1, `a direct commit on the audited line is governed like any other:\n${r.stdout}`);
  assert.match(r.stdout, /\[FAIL\][^\n]*issueLink/, `and by the same rule:\n${r.stdout}`);
});

// ── --first-parent regression — nested slice merges must be EXCLUDED ──────────
//
// Real-world pattern: a feature branch (e.g., feature/governance) accumulates
// several slice PRs merged into it (sub/slice1 → feature). When the feature branch
// finally merges into main the git range A..main contains both:
//   • M1  — the integration merge (feature → main)      ← SHOULD be audited
//   • M2  — the nested slice merge (sub → feature)      ← MUST be excluded
//
// Without --first-parent the engine walks second parents and finds M2.
// M2 carries "Part of #5" body (no Closes #N) → issueLink fails → false FAIL.
// With --first-parent only M1 is visited → no false failures.
test('brain-audit: --first-parent excludes nested slice merges', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-firstparent-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);

  // (A) initial commit on main
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  // (B) feature/big branch
  git('checkout', '-b', 'feature/big');

  // (C) sub/slice1 branch merged into feature/big — nested merge (no Closes #N)
  git('checkout', '-b', 'sub/slice1');
  commit(git, dir, { 'src/code.mjs': 'export const x = 1;' }, 'feat: partial work (Part of #5)');
  git('checkout', 'feature/big');
  git('merge', '--no-ff', 'sub/slice1', '-m',
    'Merge sub/slice1 into feature/big (Part of #5)');  // M2 — no Closes #N

  // (D) finalize feature: add memory record with a session_summary observation
  commit(git, dir, { '.memory/records/2026-07.jsonl': makeSessionSummaryRecord() },
    'chore: finalize (Part of #5)');

  // (E) merge feature/big into main — M1: the integration merge
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/big', '-m',
    'feat: big feature Closes #5');   // M1 — has Closes #N + .memory/ in diff

  // Range: HEAD~1..HEAD = just the top-level merge event on main.
  // With --first-parent: only M1 is audited → PASS (Closes #5, .memory/ present).
  // Without --first-parent: M2 is also visited → issueLink fails → exit 1.
  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD~1..HEAD'], {
    cwd: dir, encoding: 'utf8',
  });

  assert.equal(r.status, 0,
    `expected exit 0 (only top-level merge M1 audited), got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(r.stdout.includes('[PASS]'),
    `expected [PASS] in stdout:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('[FAIL]'),
    `unexpected [FAIL] — nested merge must not be audited:\n${r.stdout}`);

  // Confirm only ONE audit line (M1 only, not M2 too)
  const auditLines = r.stdout.split('\n').filter(l => l.startsWith('[PASS]') || l.startsWith('[FAIL]'));
  assert.equal(auditLines.length, 1,
    `expected 1 audited merge (integration merge only), got ${auditLines.length}:\n${r.stdout}`);
});

// ── baseline — pre-baseline merges are skipped, not failed ───────────────────
//
// Pattern:
//   A (initial) → MERGE_BAD (no issue link) → E (add config) → [tag v0.1.0 on E] → MERGE_GOOD (Closes #1)
//
// With auditBaseline = "v0.1.0":
//   MERGE_BAD: v0.1.0 (E) is NOT ancestor of MERGE_BAD → [SKIP] — not a failure
//   MERGE_GOOD: v0.1.0 (E) IS ancestor of MERGE_GOOD → [PASS]
//   Exit: 0  (without baseline MERGE_BAD would cause exit 1)
test('brain-audit: baseline skips pre-baseline merges (no false failure)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-baseline-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);

  // (A) initial commit on main
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  // (B) feature/bad — will be merged before the baseline tag; has no issue link
  git('checkout', '-b', 'feature/bad');
  commit(git, dir, { 'src/bad.mjs': 'export const x = 1;' }, 'feat: pre-baseline work');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/bad', '-m', 'Merge feature/bad (no issue ref)');  // MERGE_BAD
  // The branch commit itself is NOT on the first-parent line, so it stays unaudited
  // for the reason it always did — `--first-parent`, which #518 did not touch.

  // (C) commit that carries the brain.config.json with the baseline setting
  commit(git, dir, {
    'brain.config.json': JSON.stringify({
      governance: { auditBaseline: 'v0.1.0' },
    }),
  }, 'chore: add audit config Closes #9');   // #518: now audited like any other commit

  // Tag v0.1.0 on the current HEAD (commit C — after MERGE_BAD)
  git('tag', 'v0.1.0');

  // (D) feature/good — after the baseline tag; has all invariants satisfied
  git('checkout', '-b', 'feature/good');
  commit(git, dir, { '.memory/records/2026-07.jsonl': makeSessionSummaryRecord() },
    'feat: after baseline Closes #1');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/good', '-m', 'Merge feature/good Closes #1');  // MERGE_GOOD

  // Run without explicit range — defaults to HEAD (whole history)
  const r = spawnSync('node', [AUDIT_SCRIPT], {
    cwd: dir, encoding: 'utf8',
  });

  assert.equal(r.status, 0,
    `expected exit 0 (MERGE_BAD skipped by baseline), got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  // MERGE_BAD must be skipped, not failed
  assert.ok(r.stdout.includes('[SKIP]'),
    `expected [SKIP] for pre-baseline merge:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('[FAIL]'),
    `unexpected [FAIL] — pre-baseline merge must be skipped:\n${r.stdout}`);

  // MERGE_GOOD must be audited and pass
  assert.ok(r.stdout.includes('[PASS]'),
    `expected [PASS] for post-baseline merge:\n${r.stdout}`);
});

// ── baseline invalid ref — warns and audits all (no crash) ───────────────────
test('brain-audit: invalid baseline ref warns and falls back to auditing all', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-baseline-invalid-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const root = headShaOf(git);

  // Config with a baseline ref that does not exist
  commit(git, dir, {
    'brain.config.json': JSON.stringify({
      governance: { auditBaseline: 'v99.0.0-nonexistent' },
    }),
  }, 'chore: add config Closes #9');   // #518: on the audited line now

  // One good merge after the config
  git('checkout', '-b', 'feature/ok');
  commit(git, dir, { '.memory/records/2026-07.jsonl': makeSessionSummaryRecord() },
    'feat: good Closes #1');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/ok', '-m', 'Merge feature/ok Closes #1');

  // The range EXCLUDES the root commit, which is what every production caller does
  // (the cursor is seeded at `rev-list --max-parents=0`, release.yml falls back to
  // the same) — and since #518 it matters: the exemption model reads `windowFrom^1`,
  // and the root has no parent, so a window based ON the root is uncomputable. That
  // is asserted directly in the #518 block; here it would only be noise obscuring
  // what this test is about, which is the baseline fallback.
  const r = spawnSync('node', [AUDIT_SCRIPT, `${root}..HEAD`], {
    cwd: dir, encoding: 'utf8',
  });

  // Invalid baseline → falls back → audits all → [PASS] → exit 0
  assert.equal(r.status, 0,
    `expected exit 0 after invalid baseline fallback, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  // Warning must be emitted to stderr
  assert.ok(r.stderr.includes('[WARN]'),
    `expected [WARN] on stderr for invalid baseline:\n${r.stderr}`);
  // Still audits and passes the good merge
  assert.ok(r.stdout.includes('[PASS]'),
    `expected [PASS] in stdout after fallback:\n${r.stdout}`);
});

// ── real records path — session_summary causes memoryPresence to pass ─────
//
// This test is the canonical proof that the full real-records path works end-to-end:
// brain-audit reads the .memory/records/*.jsonl, parses the records,
// extracts the session_summary observation, and memoryPresence returns pass.
test('brain-audit: real records with session_summary → memoryPresence passes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-realrecords-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  git('checkout', '-b', 'feature/real-records');
  commit(git, dir,
    { '.memory/records/2026-07.jsonl': makeSessionSummaryRecord() },
    'feat: real records Closes #2');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/real-records', '-m',
    'Merge feature/real-records Closes #2');

  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD~1..HEAD'], {
    cwd: dir, encoding: 'utf8',
  });

  assert.equal(r.status, 0,
    `expected exit 0, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(r.stdout.includes('[PASS]'),
    `expected [PASS] in stdout:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('memoryPresence'),
    `memoryPresence must not appear in output when passing:\n${r.stdout}`);
});

// ── corrupt record line is skipped — no crash ─────────────────────────────────
//
// When a record file is present but has an invalid JSON line,
// brain-audit must skip it silently and NOT crash.  The merge will fail the
// memoryPresence check (no valid session_summary), but the audit process itself
// must exit cleanly (not with an unhandled exception).
test('brain-audit: corrupt record line is skipped — audit does not crash', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-corrupt-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  git('checkout', '-b', 'feature/corrupt');
  // Write a .jsonl file that is NOT valid JSON — should be caught and skipped
  commit(git, dir,
    { '.memory/records/2026-07.jsonl': 'this is not json data at all\n' },
    'feat: corrupt record Closes #3');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/corrupt', '-m',
    'Merge feature/corrupt Closes #3');

  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD~1..HEAD'], {
    cwd: dir, encoding: 'utf8',
  });

  // Corrupt chunk → skipped → allObservations=[] → memoryPresence fails → exit 1
  // But the audit process itself must NOT crash (stderr must not contain 'Error:' at top level)
  assert.equal(r.status, 1,
    `expected exit 1 (memoryPresence fail), got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(r.stdout.includes('[FAIL]'),
    `expected [FAIL] in stdout:\n${r.stdout}`);
  // No unhandled exception
  assert.ok(!r.stderr.includes('brain-audit: unexpected error'),
    `unexpected top-level error logged:\n${r.stderr}`);
});

// ── A7 — revert-of-a-revert: a re-added offender is LIVE at HEAD, must be reported ─
//
// PROPERTY (attacker's chair): a merge that fails a tree-keyed governance check
// (diffSize / adrPresence) may only be EXEMPTED if its payload is NET-ABSENT from
// the tree at HEAD.  Equivalently: an offending artifact that is LIVE on disk at
// HEAD must ALWAYS be reported, no matter how many revert / re-revert operations
// sit in the window.  Any audit that lets a live-at-HEAD ungoverned artifact
// escape reporting is WRONG.
//
// THE ATTACK (A7 — the revert-of-a-revert):
//   O   = a merge that ADDS a >400-line file → fails the diffSize tree-keyed check.
//   R   = git revert -m1 O (landed as a first-parent merge) → REMOVES O's payload.
//   R2  = git revert -m1 R (landed as a first-parent merge) → RE-ADDS O's exact
//         payload.  The >400-line file is LIVE on disk at HEAD = R2.
//
// A direction-blind reverter-skip reads R2 as "the revert's own reverter" and
// wrongly exempts it — chaining O (resolved by R) and R (resolved by R2) into a
// full all-[SKIP] / exit-0 whitewash, even though the offending file is sitting
// in the tree at HEAD.  This fixture pins the PROPERTY through the real CLI: the
// live-at-HEAD offender must be REPORTED (never on a [SKIP] line) and the audit
// must exit non-zero.  It asserts WHAT is reported / the exit code — never HOW
// net-absence is computed.
//
// Each of O / R / R2 carries a Closes #N ref and a valid session_summary record
// sits at HEAD, so diffSize is the ONLY governance axis in play: R legitimately
// removes the payload (may be [SKIP] under a correct net-parity audit), while O
// and R2 keep the >400-line file live and MUST surface as offenders.

/** HEAD sha of the fixture repo — a producer that never fabricates an empty string. */
function headShaOf(git) {
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/, `headShaOf: not a 40-hex sha: ${JSON.stringify(sha)}`);
  return sha;
}

/**
 * An offender MERGE that adds `files` and lands as a first-parent merge on main
 * (the `--first-parent --merges` shape brain-audit tracks).  `mergeMsg` carries
 * the Closes #N ref that issueLink reads.  Returns the merge sha.
 */
function mergeAddingPayload(git, dir, files, label, mergeMsg) {
  git('checkout', '-b', `feat-${label}`, 'main');
  commit(git, dir, files, `${label}: add payload`);
  git('checkout', 'main');
  const m = git('merge', '--no-ff', `feat-${label}`, '-m', mergeMsg);
  assert.equal(m.status, 0, `merge ${label} failed: ${m.stderr}`);
  return headShaOf(git);
}

/**
 * `git revert -m 1 --no-edit <offender>` on a fresh branch off main, merged back
 * with --no-ff — a GENUINE revert that lands as a first-parent merge (the real
 * auto-revert PR flow).  `mergeMsg` carries the revert PR's own Closes #N ref.
 * Returns the merge sha.
 */
function genuineRevertMerge(git, dir, offenderSha, branchName, mergeMsg) {
  git('checkout', '-b', branchName, 'main');
  const rv = git('revert', '-m', '1', '--no-edit', offenderSha);
  assert.equal(rv.status, 0, `revert of ${offenderSha} failed: ${rv.stderr}`);
  git('checkout', 'main');
  const m = git('merge', '--no-ff', branchName, '-m', mergeMsg);
  assert.equal(m.status, 0, `merge ${branchName} failed: ${m.stderr}`);
  return headShaOf(git);
}

test('brain-audit: A7 revert-of-a-revert — a re-added >400-line offender LIVE at HEAD is reported, never all-[SKIP]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a7-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);

  // Base on main: README + a valid session_summary record so memoryPresence
  // passes repo-wide (it is read once at HEAD). This isolates diffSize as the
  // only governance axis, so O/R2's offender status is purely the LIVE big file.
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);

  // A >400-line file → fails the diffSize tree-keyed check (budget 400).
  const bigFile = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

  // O — offender merge: adds the >400-line file. diffSize FAIL.
  const oSha = mergeAddingPayload(git, dir, { 'src/big.mjs': bigFile }, 'O',
    'O: add oversized payload Closes #1');

  // R — genuine revert of O (as a merge): REMOVES the payload. May legitimately
  // be [SKIP] under a correct net-parity audit; not asserted either way.
  genuineRevertMerge(git, dir, oSha, 'revert-O', 'R: revert O Closes #2');

  // R2 — revert of R (as a merge): RE-ADDS O's exact payload. The >400-line file
  // is LIVE on disk at HEAD = R2. MUST be reported as an offender.
  const r2Sha = genuineRevertMerge(git, dir, headShaOf(git), 'revert-R',
    'R2: revert R Closes #3');

  // Sanity: the offending file really is live in the working tree at HEAD.
  assert.ok(existsSync(join(dir, 'src/big.mjs')),
    'fixture invariant: the >400-line offender must be live on disk at HEAD=R2');

  // Audit the whole window base..HEAD (covers O, R, R2 on the first-parent chain).
  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], {
    cwd: dir, encoding: 'utf8',
  });

  // ── PROPERTY assertions — WHAT is reported / exit code, never the mechanism ──

  // 1. The live-at-HEAD offender must fail the audit. A direction-blind
  //    reverter-skip emits all-[SKIP] / exit 0 here — that is the WRONG answer.
  assert.notEqual(r.status, 0,
    `a live-at-HEAD >400-line ungoverned artifact must fail the audit (exit non-zero); got exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  // 2. R2 — the re-add that puts the offender back on disk at HEAD — must be
  //    REPORTED, and must NOT be exempted on a [SKIP] line. Format-agnostic:
  //    matches [FAIL] <sha7> and [FAIL-SHA] <full-sha> alike, reddens on [SKIP].
  const lines = r.stdout.split('\n').filter(Boolean);
  const r2Line = lines.find(l => l.includes(r2Sha) || l.includes(r2Sha.slice(0, 7)));
  assert.ok(r2Line,
    `R2 (the live re-add at HEAD) must appear in the audit output:\n${r.stdout}`);
  assert.ok(!r2Line.startsWith('[SKIP]'),
    `R2 re-adds a live >400-line offender at HEAD — it must NOT be [SKIP]-exempted:\n${r2Line}`);

  // 3. O — the original offender whose payload is live again at HEAD — must
  //    likewise be reported, never [SKIP]-exempted as "resolved by revert".
  const oLine = lines.find(l => l.includes(oSha) || l.includes(oSha.slice(0, 7)));
  assert.ok(oLine,
    `O (the original >400-line offender, live again at HEAD) must appear in the audit output:\n${r.stdout}`);
  assert.ok(!oLine.startsWith('[SKIP]'),
    `O's payload is live at HEAD via R2 — it must NOT be [SKIP]-exempted:\n${oLine}`);

  // 4. The window must NOT collapse into an all-[SKIP] whitewash: at least one
  //    merge is reported as an offender (the anti-whitewash property).
  const skipCount = lines.filter(l => l.startsWith('[SKIP]')).length;
  const auditedCount = lines.filter(l => /^\[(PASS|FAIL|FAIL-SHA|SKIP)\]/.test(l)).length;
  assert.ok(skipCount < auditedCount,
    `all-[SKIP] whitewash — every audited merge was exempted despite a live offender at HEAD:\n${r.stdout}`);
});

// ── prView fix-at-source disposition ──────────────────────────────────────────
//
// prView() now returns `labels: null, body: null` on a genuinely uncomputable
// fetch (REQ-CIC-2) — distinct from `[]`/`''` (genuinely empty). The audit
// consumer must NOT collapse that `null` back into a fabricated `[]`/`''`
// default (`pr.labels ?? []`) — that re-introduces the exact fail-open the
// seam was built to remove, just on a parallel path. `shouldSkipSize(null)`
// and `selectIssueLinkBody(null, commitBody)` (audit-helpers.test.mjs) already
// prove the downstream pure functions handle `null` safely; this proves the
// null actually reaches them, unmangled.
// GUARD RE-POINT (issue #324 Phase 2): `fetchPrMeta` — the prView() fetch this
// guard fences — moved to lib/merge-walk.mjs (EVIDENCE layer) during the
// brain-metrics extraction. Re-pointing at the literal path where the guarded
// code NOW lives is not optional: leaving this guard aimed at brain-audit.mjs
// after the code moved out would make it pass vacuously forever (the pattern
// it forbids can never appear in a file that no longer contains the logic),
// silently deleting the safety net (design "Safety note (blocking for apply)").
test('brain-audit (merge-walk): prView() null labels/body are NOT coerced to []/\'\' before reaching the pure helpers (fix dies at source)', () => {
  const src = readFileSync(fileURLToPath(new URL('./lib/merge-walk.mjs', import.meta.url)), 'utf8');
  assert.equal(src.includes('pr.labels ?? []'), false,
    'must not fabricate an empty labels default over a possibly-null pr.labels — let null reach shouldSkipSize()');
  assert.equal(src.includes('pr.body ?? \'\''), false,
    'must not fabricate an empty body default over a possibly-null pr.body — let null reach selectIssueLinkBody()');
});

// ═══════════════════════════════════════════════════════════════════════════
// D2 PR3 — net-parity resolved-skip + reverter-skip, class-filtered [FAIL-SHA],
// newest-carrier dedup, fail-closed exit contract (design §15, REQ-D2-3/-6/-10/
// -10a/-16). These fixtures drive the REAL CLI end-to-end; the frozen A7 finder
// fixture above pins the same net-parity property from the attacker's chair.
// ═══════════════════════════════════════════════════════════════════════════

const ADR_FILE = 'brain/project/decisions/adr-901-example.md';

/** A merge whose diff ADDS an ADR without brain/HOME.md → fails adrPresence. */
function mergeAddingAdr(git, dir, label, mergeMsg) {
  return mergeAddingPayload(git, dir, { [ADR_FILE]: `# ADR 901 ${label}\n\nBody.\n` }, label, mergeMsg);
}

// ── Emission — an un-exempted tree-keyed offender emits [FAIL] + [FAIL-SHA] ──
test('D2 emission — a diffSize offender carries an additive [FAIL-SHA] <full-sha> line', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-emit-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  const bigFile = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const o = mergeAddingPayload(git, dir, { 'src/big.mjs': bigFile }, 'O', 'O: oversized Closes #1');

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes(`[FAIL] ${o.slice(0, 7)}`), `expected [FAIL] sha7:\n${r.stdout}`);
  assert.ok(r.stdout.includes(`[FAIL-SHA] ${o}`), `expected [FAIL-SHA] full-sha:\n${r.stdout}`);
});

// ── Resolved-skip liveness (A2) — a genuine revert resolves the offender ─────
test('D2 A2 — a genuine revert resolves the offender: O [SKIP] resolved by revert, exit 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a2-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  const bigFile = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const o = mergeAddingPayload(git, dir, { 'src/big.mjs': bigFile }, 'O', 'O: oversized Closes #1');
  genuineRevertMerge(git, dir, o, 'revert-O', 'R: revert O Closes #2');

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0 (payload net-absent)\n${r.stdout}\n${r.stderr}`);
  const oLine = r.stdout.split('\n').find(l => l.includes(o.slice(0, 7)));
  assert.ok(oLine && oLine.startsWith('[SKIP]') && oLine.includes('resolved by revert'),
    `O must be [SKIP] resolved by revert:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('[FAIL-SHA]'), `no [FAIL-SHA] when fully resolved:\n${r.stdout}`);
});

// ── A6 (HONEST title, task 3.0.2) — a single O+R reverter pair: the genuine
// revert is tree-keyed-exempted, the offender resolves, exit 0. (Does NOT claim
// to close the revert-of-revert loop — that is the frozen A7 fixture's job.) ──
test('D2 A6 — a genuine O(adrPresence)+R reverter pair: R is tree-keyed exempted, O resolved, exit 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a6-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  const o = mergeAddingAdr(git, dir, 'O', 'O: add ungoverned ADR Closes #1');
  const rSha = genuineRevertMerge(git, dir, o, 'revert-O', 'R: revert O Closes #2');

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0\n${r.stdout}\n${r.stderr}`);
  const lines = r.stdout.split('\n').filter(Boolean);
  const rLine = lines.find(l => l.includes(rSha.slice(0, 7)));
  // The PROPERTY: R, whose whole contribution is undoing O, is not itself reported.
  //
  // It used to be `[SKIP]` specifically, and #510 changed WHY rather than WHAT. R
  // deletes the ADR path, and the pre-#510 adrPresence — deciding on `git diff
  // --name-only`, which lists deletions alongside additions — scored that as "an ADR
  // without a HOME.md entry" and failed R. The exemption then had to rescue it, so
  // `[SKIP]` was the observable outcome. With the added-only list R has no failure to
  // rescue and comes out `[PASS]`.
  //
  // Asserting `[SKIP]` here would be asserting that the spurious failure still exists.
  assert.ok(rLine && !rLine.startsWith('[FAIL'),
    `R (genuine revert of an adrPresence offender) must not itself be flagged:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('[FAIL-SHA]'), `no [FAIL-SHA] on a settled O+R pair:\n${r.stdout}`);
});

// ── claim-only merge is NOT skipped (spec REQ-D2-10a reverter-skip scenario) ──
test('D2 — a merge that merely CLAIMS a revert but has no tree inverse is NOT skipped', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-claim-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  const bigFile = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const o = mergeAddingPayload(git, dir, { 'src/big.mjs': bigFile }, 'O', 'O: oversized Closes #1');
  // C: adds a DIFFERENT >400-line file; message falsely claims to revert O.
  const other = Array.from({ length: 500 }, (_, i) => `other ${i + 1}`).join('\n') + '\n';
  const c = mergeAddingPayload(git, dir, { 'src/other.mjs': other }, 'C',
    `C: This reverts commit ${o}. Closes #2`);

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1\n${r.stdout}\n${r.stderr}`);
  const cLine = r.stdout.split('\n').find(l => l.includes(c.slice(0, 7)) || l.includes(c));
  assert.ok(cLine && !cLine.startsWith('[SKIP]'),
    `a claim-only merge with no tree inverse must NOT be [SKIP]-exempted:\n${r.stdout}`);
  assert.ok(r.stdout.includes(`[FAIL-SHA] ${c}`), `C must emit [FAIL-SHA]:\n${r.stdout}`);
});

// ── A9(a) — class-filtered emission: memoryPresence-only / issueLink-only
// merges drive exit 1 but emit ZERO [FAIL-SHA] (non-tree-keyed → human gate) ──
test('D2 A9(a) — a memoryPresence-only failure drives exit 1 but emits ZERO [FAIL-SHA]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a9mem-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  // History exists (a record for ANOTHER issue) but none is scoped to #1 → the
  // gate's predicate fails it (#1188: a repo with NO history at all abstains instead).
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': JSON.stringify({ id: 'other', type: 'session_summary', issue: 99 }) + '\n',
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  mergeAddingPayload(git, dir, { 'src/small.mjs': 'export const x = 1;\n' }, 'N',
    'N: small clean Closes #1');

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1 (memoryPresence gap)\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes('memoryPresence'), `expected memoryPresence in output:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('[FAIL-SHA]'),
    `memoryPresence is repo-global — MUST NOT emit [FAIL-SHA]:\n${r.stdout}`);
});

test('D2 A9(a) — an issueLink-only failure drives exit 1 but emits ZERO [FAIL-SHA]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a9issue-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  // small diff, memory present, no ADR, but merge message carries NO issue ref.
  mergeAddingPayload(git, dir, { 'src/small.mjs': 'export const x = 1;\n' }, 'N',
    'N: small clean merge with no issue reference');

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1 (issueLink gap)\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes('issueLink'), `expected issueLink in output:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('[FAIL-SHA]'),
    `issueLink is body-keyed — MUST NOT emit [FAIL-SHA]:\n${r.stdout}`);
});

// ── Newest-carrier dedup (REQ-D2-3) — O and R2 share a payload signature;
// only the newest net-present carrier (R2) emits [FAIL-SHA]; O emits none. ────
test('D2 dedup — O and R2 share a payload; only the newest carrier R2 emits [FAIL-SHA]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-dedup-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  const bigFile = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const o = mergeAddingPayload(git, dir, { 'src/big.mjs': bigFile }, 'O', 'O: oversized Closes #1');
  genuineRevertMerge(git, dir, o, 'revert-O', 'R: revert O Closes #2');
  const r2 = genuineRevertMerge(git, dir, headShaOf(git), 'revert-R', 'R2: revert R Closes #3');

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1\n${r.stdout}\n${r.stderr}`);
  const failShaLines = r.stdout.split('\n').filter(l => l.startsWith('[FAIL-SHA]'));
  assert.equal(failShaLines.length, 1, `exactly one [FAIL-SHA] (newest carrier):\n${r.stdout}`);
  assert.equal(failShaLines[0], `[FAIL-SHA] ${r2}`, `the newest carrier R2 must be the one emitted:\n${r.stdout}`);
  assert.ok(!r.stdout.includes(`[FAIL-SHA] ${o}`), `O (older carrier) must NOT emit [FAIL-SHA]:\n${r.stdout}`);
});

// ── adrPresence [FAIL] line carries the human-gate remediation (§15.6a) ──────
test('D2 — an adrPresence [FAIL] line appends the human-gate remediation (accept --reason)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-adrrem-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  mergeAddingAdr(git, dir, 'O', 'O: add ungoverned ADR Closes #1');

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, `expected exit 1\n${r.stdout}\n${r.stderr}`);
  const failLine = r.stdout.split('\n').find(l => l.startsWith('[FAIL]') && l.includes('adrPresence'));
  assert.ok(failLine && failLine.includes('accept'),
    `adrPresence [FAIL] must append the accept --reason human-gate remediation:\n${r.stdout}`);
});

// ── no-import drift-guard (PR2b §2b.3.4) — the direction-blind pairwise
// isReverterOf must never be re-imported into the merge walk ────────────────
//
// GUARD RE-POINT (issue #324 Phase 2): the reverter-exemption composition this
// guard fences (`netAddFull`/`addedPathsAbsentAt`/`revertResurrectsAt`) moved
// to lib/merge-walk.mjs (VERDICT layer) during the brain-metrics extraction —
// brain-audit.mjs no longer imports resolution.mjs directly at all. Re-pointed
// at the literal path where the resolution.mjs import now lives so this guard
// stays a REAL assertion (it would otherwise fail outright — `importMatch`
// would be null — rather than passing vacuously, but either way the old
// target no longer tests what it claims to).
test('D2 drift-guard — lib/merge-walk.mjs does NOT import the retired pairwise isReverterOf', () => {
  const src = readFileSync(fileURLToPath(new URL('./lib/merge-walk.mjs', import.meta.url)), 'utf8');
  // The true no-import guard (PR2b §2b.3.4): assert no resolution.mjs import
  // binding pulls in isReverterOf. Checks the actual import specifier — the only
  // place the retired export could enter — so rationale comments may still name
  // it. isReverterOf is exported ONLY by resolution.mjs, so this is exhaustive.
  const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*resolution\.mjs['"]/);
  assert.ok(importMatch, 'expected a resolution.mjs import in lib/merge-walk.mjs');
  assert.equal(/\bisReverterOf\b/.test(importMatch[1]), false,
    'lib/merge-walk.mjs must compose netAddFull (net-parity), never import the retired direction-blind isReverterOf');
});

// ── crossCheckExit — the fail-closed exit contract (REQ-D2-6b, §15.5) ────────
test('D2 crossCheckExit — decoupled failCount / tree-keyed⟺[FAIL-SHA] coherence', () => {
  // Clean run.
  assert.equal(crossCheckExit(0, 0, 0), 0);
  // Legit exit 1 with ZERO [FAIL-SHA]: all violations non-tree-keyed.
  assert.equal(crossCheckExit(2, 0, 0), 1);
  // A7-shaped: tree-keyed failures present, at least one [FAIL-SHA] emitted.
  assert.equal(crossCheckExit(2, 2, 1), 1);
  // Un-exempted tree-keyed failure recorded but ZERO [FAIL-SHA] → crash mid-emission → exit 2.
  assert.equal(crossCheckExit(1, 1, 0), 2);
  // A [FAIL-SHA] with no backing tree-keyed failure → incoherent → exit 2.
  assert.equal(crossCheckExit(1, 0, 1), 2);
});

// ── Fail-closed top-level catch — an uncomputable range exits 2 on stdout ────
test('D2 fail-closed — an uncomputable git range exits 2 with the message on stdout', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-uncomputable-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  // A range referencing a nonexistent ref → git log throws → fail-closed exit 2.
  const r = spawnSync('node', [AUDIT_SCRIPT, 'no-such-ref-xyz..HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 2, `expected exit 2 (uncomputable), got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes('uncomputable'),
    `the uncomputable message must be on stdout (captured), not stderr:\n${r.stdout}\n${r.stderr}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// #474 (REQ-TS-1/-2) — THE c724942 SCENARIO, end-to-end through the real CLI.
//
// This is the run that was observed live on 2026-08-06 (run 31094912872):
// `brain-audit` over a window containing a merge whose PR body carries the
// closing keyword, evaluated with an unauthenticated `gh`. Before this change
// it reported `[FAIL] … issueLink: no issue reference found` — a confident
// GOVERNANCE VERDICT rendered from the auto-generated merge commit body,
// because the evaluator could not read the PR it was judging. Exit 1 with zero
// [FAIL-SHA] — which is #466's unhandled deadlock.
//
// The fixture drives the SHIPPED CLI with a `gh` stub that fails exactly the
// way an unauthenticated one does (non-zero exit), so `prView` returns its
// REQ-CIC-2 null/null sentinel through the real provider.
// ═══════════════════════════════════════════════════════════════════════════

/** Put a `gh` on PATH that fails like an unauthenticated one. */
function writeFailingGhStub(binDir) {
  mkdirSync(binDir, { recursive: true });
  const gh = join(binDir, 'gh');
  writeFileSync(gh, '#!/usr/bin/env bash\necho "gh: not authenticated" >&2\nexit 1\n');
  chmodSync(gh, 0o755);
}

/**
 * Put a `gh` on PATH that answers `pr view` and `pr review` for ONE pull request.
 *
 * A10's reinforcement (#511 ruling, option 3). Its original fixture has no PR at all, so
 * under the human-gate check it would ABSTAIN — and A10 would keep passing purely on
 * adrPresence's imprecision, which is what #510 removes. Giving it a resolvable PR is what
 * makes the fixture pin the invariant that now does the work, rather than a leftover.
 *
 * `pr.body` overrides the default `Closes #<number>` PR description — used to plant
 * evidence (e.g. the `Memory lane:` marker) that must be read from `prBody`, never
 * fabricated by the stub matching the commit body by coincidence.
 *
 * @param {string} binDir
 * @param {{ number: number, author: string, reviews: Array<{state: string, login: string}>, body?: string }} pr
 */
function writeReviewedGhStub(binDir, pr) {
  mkdirSync(binDir, { recursive: true });
  const gh = join(binDir, 'gh');
  const view = JSON.stringify({
    number: pr.number, labels: [], body: pr.body ?? `Closes #${pr.number}`,
    author: { login: pr.author }, headRefOid: 'deadbeef',
  });
  const reviews = JSON.stringify(pr.reviews.map(r => ({ state: r.state, user: { login: r.login }, body: '' })));
  writeFileSync(gh, [
    '#!/usr/bin/env bash',
    'case "$*" in',
    `  *"pr view"*)   printf '%s' ${JSON.stringify(view)} ;;`,
    `  *"/reviews"*|*"pr review"*) printf '%s' ${JSON.stringify(reviews)} ;;`,
    "  *) echo '{}' ;;",
    'esac',
    'exit 0',
  ].join('\n') + '\n');
  chmodSync(gh, 0o755);
}

/** Build the c724942 shape: a PR-shaped merge whose commit body has no closing keyword. */
function c724942Fixture(dir) {
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
    'brain.config.json': JSON.stringify({
      vcs: { provider: 'github' },
      project: { slug: 'csrinaldi/brain' },
    }),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);

  git('checkout', '-b', 'feature/x');
  commit(git, dir, { 'src/x.mjs': 'export const x = 1;\n' }, 'fix: a change');
  git('checkout', 'main');
  // The auto-generated merge subject/body GitHub produces. `Closes #443` lives
  // in the PR description — which is exactly what an unauthenticated run cannot read.
  git('merge', '--no-ff', 'feature/x', '-m', 'Merge pull request #471 from csrinaldi/fix/issue-443');
  return { git, base };
}

function runAuditUnauthenticated(dir, range) {
  const binDir = join(dir, '.stubbin');
  writeFailingGhStub(binDir);
  return spawnSync('node', [AUDIT_SCRIPT, range], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      GH_CONFIG_DIR: join(dir, 'nonexistent-gh-config'),
    },
  });
}

test('REQ-TS-2 (#474/c724942): an unreadable PR is UNCOMPUTABLE (exit 2), never an issueLink verdict', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-uncomputable-pr-'));
  t.after(() => removeTempTree(dir));
  const { base } = c724942Fixture(dir);

  const r = runAuditUnauthenticated(dir, `${base}..HEAD`);

  // The whole point: no governance verdict is rendered from evidence that could
  // not be read. This assertion is what fails on the pre-fix code (it reported
  // `[FAIL] … issueLink: no issue reference found` and exit 1).
  assert.ok(!/\[FAIL\].*issueLink/.test(r.stdout),
    `an unreadable PR must NEVER produce an issueLink verdict:\n${r.stdout}`);
  assert.ok(r.stdout.includes('[UNCOMPUTABLE]'),
    `expected an [UNCOMPUTABLE] line naming the merge:\n${r.stdout}`);
  assert.equal(r.status, 2,
    `uncomputable DOMINATES — expected exit 2, got ${r.status}\n${r.stdout}\n${r.stderr}`);
});

test('REQ-TS-2 (#474): ONE unreadable PR poisons a window whose other merges PASS', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-uncomputable-mixed-'));
  t.after(() => removeTempTree(dir));
  const { git, base } = c724942Fixture(dir);

  // A second merge that carries its issue link in the COMMIT body and references
  // no PR — it is fully evaluable even unauthenticated, and it passes.
  git('checkout', '-b', 'feature/y');
  commit(git, dir, { 'src/y.mjs': 'export const y = 1;\n' }, 'fix: y Closes #2');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/y', '-m', 'Merge branch feature/y Closes #2');

  const r = runAuditUnauthenticated(dir, `${base}..HEAD`);

  assert.ok(r.stdout.includes('[PASS]'),
    `the evaluable merge must still be evaluated and pass:\n${r.stdout}`);
  assert.ok(r.stdout.includes('[UNCOMPUTABLE]'), `expected the uncomputable line:\n${r.stdout}`);
  // exit-codes.mjs: "an uncomputable check must never read as clean or as a mere
  // violation". A window that advanced the cursor here would move the
  // never-evaluated merge permanently behind it (ADR-0015 rung 3).
  assert.equal(r.status, 2,
    `one uncomputable merge must dominate a window of passes, got ${r.status}\n${r.stdout}`);
});

test('REQ-TS-3 (#474): a merge with NO PR reference stays evaluable unauthenticated', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-nopr-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
    'brain.config.json': JSON.stringify({
      vcs: { provider: 'github' }, project: { slug: 'csrinaldi/brain' },
    }),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  git('checkout', '-b', 'feature/z');
  commit(git, dir, { 'src/z.mjs': 'export const z = 1;\n' }, 'fix: z Closes #7');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/z', '-m', 'Merge branch feature/z Closes #7');

  const r = runAuditUnauthenticated(dir, `${base}..HEAD`);

  // There is no PR to fetch, so there is no missing evidence — the commit body
  // IS the evidence. Turning this into a halt would break every squash/direct merge.
  assert.ok(!r.stdout.includes('[UNCOMPUTABLE]'),
    `a merge referencing no PR must not be uncomputable:\n${r.stdout}`);
  assert.equal(r.status, 0, `expected a clean exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// ── A8 — payload PREDATING the audit window base: a delete + a live re-add ────
//
// PROPERTY (same frozen property as A7, attacker's chair): a merge that fails a
// tree-keyed governance check (adrPresence / diffSize) may be EXEMPTED from that
// failure ONLY IF its payload is NET-ABSENT from the tree at HEAD. An offending
// artifact LIVE on disk at HEAD must ALWAYS be reported, no matter what
// revert / re-revert operations sit in the window.
//
// THE ATTACK (A8 — the distinguishing twist from A7): the offending payload's
// ORIGINAL introduction sits BEHIND the audit window base — it is already present
// before the range starts. Only a DELETE and a RE-ADD sit inside the audited
// window:
//   base = a commit that ALREADY contains an ungoverned ADR (no HOME.md entry →
//          fails adrPresence). The audit range STARTS at this commit, so the
//          original add is OUTSIDE the window.
//   R    = a merge that DELETES the ADR (inside the window).
//   O    = a merge that RE-ADDS the exact ADR (inside the window) — the ungoverned
//          artifact is LIVE on disk at HEAD = O.
//
// A window-scoped net check that only sees `R` (delete) then `O` (re-add) can
// wrongly conclude the payload is "already present at the window base, no net
// addition here" and EXEMPT O — collapsing the window into all-[SKIP] / exit 0
// even though the ungoverned ADR is sitting in the tree at HEAD. This fixture
// pins the PROPERTY through the real CLI: the live-at-HEAD offender must be
// REPORTED (never on a [SKIP] line) and the audit must exit non-zero. It asserts
// WHAT is reported / the exit code — never HOW net-absence is computed.
//
// Each of R / O carries a Closes #N ref and a valid session_summary record sits
// at HEAD, so adrPresence is the only governance axis in play on the live re-add:
// R legitimately removes the payload, while O keeps the ungoverned ADR live and
// MUST surface as an offender.

/**
 * A merge that DELETES `path` and lands as a first-parent merge on main. Mirrors
 * the `mergeAddingPayload` shape (branch off main, commit, --no-ff merge back).
 * `mergeMsg` carries the Closes #N ref. Returns the merge sha.
 */
function mergeDeletingPath(git, dir, path, label, mergeMsg) {
  git('checkout', '-b', `del-${label}`, 'main');
  const rm = git('rm', path);
  assert.equal(rm.status, 0, `git rm ${path} failed: ${rm.stderr}`);
  git('commit', '-m', `${label}: delete payload`);
  git('checkout', 'main');
  const m = git('merge', '--no-ff', `del-${label}`, '-m', mergeMsg);
  assert.equal(m.status, 0, `merge ${label} failed: ${m.stderr}`);
  return headShaOf(git);
}

test('brain-audit: A8 payload predating the window base — a delete + a live re-add of an ungoverned ADR at HEAD is reported, never all-[SKIP]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a8-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);

  // The exact ungoverned ADR payload. Its ORIGINAL introduction lands in the
  // base commit BELOW — behind the audit window — so the range never sees the
  // original add. R (delete) and O (re-add) are the only in-window carriers.
  const A8_ADR = '# ADR 901 payload\n\nBody predating the audit window.\n';

  // Base on main: README + a valid session_summary record (memoryPresence passes
  // repo-wide, read once at HEAD) + the ungoverned ADR ALREADY present. The audit
  // range starts HERE, so the original add of the ADR is OUTSIDE the window.
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
    [ADR_FILE]: A8_ADR,
  }, 'chore: initial with pre-existing ADR (#0)');
  const base = headShaOf(git);

  // R — genuine cleanup merge that DELETES the ADR (inside the window). Removes
  // the payload; may legitimately be [SKIP]/[PASS] — not asserted either way.
  mergeDeletingPath(git, dir, ADR_FILE, 'R', 'R: delete ungoverned ADR Closes #2');

  // O — merge that RE-ADDS the EXACT ADR (inside the window) with no HOME.md
  // entry → fails adrPresence. The ungoverned ADR is LIVE on disk at HEAD = O.
  const oSha = mergeAddingPayload(git, dir, { [ADR_FILE]: A8_ADR }, 'O',
    'O: re-add ungoverned ADR Closes #3');

  // Sanity: the offending ADR really is live in the working tree at HEAD=O.
  assert.ok(existsSync(join(dir, ADR_FILE)),
    'fixture invariant: the ungoverned ADR must be live on disk at HEAD=O');

  // Audit the whole window base..HEAD (covers R, O on the first-parent chain).
  // The original add sits AT base, so it is excluded from the range.
  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], {
    cwd: dir, encoding: 'utf8',
  });

  // ── PROPERTY assertions — WHAT is reported / exit code, never the mechanism ──

  // 1. The live-at-HEAD ungoverned ADR must fail the audit. A window-scoped net
  //    check that misses the original add (behind base) emits all-[SKIP] / exit 0
  //    here — that is the WRONG answer.
  assert.notEqual(r.status, 0,
    `a live-at-HEAD ungoverned ADR must fail the audit (exit non-zero); got exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const lines = r.stdout.split('\n').filter(Boolean);

  // 2. O — the re-add that puts the ungoverned ADR back on disk at HEAD — must be
  //    REPORTED, and must NOT be exempted on a [SKIP] line. Format-agnostic:
  //    matches [FAIL] <sha7> and [FAIL-SHA] <full-sha> alike, reddens on [SKIP].
  const oLine = lines.find(l => l.includes(oSha) || l.includes(oSha.slice(0, 7)));
  assert.ok(oLine,
    `O (the live re-add at HEAD) must appear in the audit output:\n${r.stdout}`);
  assert.ok(!oLine.startsWith('[SKIP]'),
    `O re-adds a live ungoverned ADR at HEAD — it must NOT be [SKIP]-exempted:\n${oLine}`);

  // 3. The offender must actually be reported as a failure (never a whitewash):
  //    at least one [FAIL] / [FAIL-SHA] line is emitted for the live-at-HEAD ADR.
  const anyFail = lines.some(l => /^\[(FAIL|FAIL-SHA)\]/.test(l));
  assert.ok(anyFail,
    `a live-at-HEAD ungoverned ADR must be reported as an offender ([FAIL]/[FAIL-SHA]); all-[SKIP] whitewash:\n${r.stdout}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// HELD ITEMS from the external ruling rev 3 on #297 — MINOR 1 (anchor liveness
// at the AUDITED TIP, not literal 'HEAD'), MINOR 2 (the per-merge reads route
// through the THROWING git path), and the SIG-mirror drift-guard.
// ═══════════════════════════════════════════════════════════════════════════

// GUARD RE-POINT (issue #324 Phase 2): `resolvedSkipLine` moved to
// lib/merge-walk.mjs (VERDICT layer) during the brain-metrics extraction.
// Imported directly from its new home rather than via a brain-audit.mjs
// re-export, so this stays a straight-line import a future reader can follow.
import { resolvedSkipLine } from './lib/merge-walk.mjs';

const AUDIT_SRC = readFileSync(fileURLToPath(new URL('./brain-audit.mjs', import.meta.url)), 'utf8');
// GUARD RE-POINT (issue #324 Phase 2): the per-merge evidence reads (numstat,
// changed files, commit body, parent) MINOR 2 fences moved to
// lib/merge-walk.mjs's `readMergeDiff`/`readMergeParent` — re-pointed below so
// the guards keep reading the file that actually contains the git calls.
// `AUDIT_SRC` above stays targeted at brain-audit.mjs: the SIG drift-guard's
// `payloadSignature`/`SIG_CONFIG`/`SIG_ARGS` DID NOT move (design's Emission
// layer stays local), so that guard's target is unchanged.
const MERGE_WALK_SRC = readFileSync(
  fileURLToPath(new URL('./lib/merge-walk.mjs', import.meta.url)), 'utf8');
const RESOLUTION_SRC = readFileSync(
  fileURLToPath(new URL('./governance/postmerge/resolution.mjs', import.meta.url)), 'utf8');

// ── MINOR 1 — the tip is a PARAMETER, and it is required on the export ───────
// DOCTRINE (owner, engram #964): an exported guard whose soundness depends on
// the caller is unsound by design. A defaulted `tip = 'HEAD'` would let a
// future caller auditing a non-HEAD tip silently get HEAD's answer — the exact
// unenforced §2.2 precondition MINOR 1 exists to convert into code. So the
// contract is a THROW, not a default.
test('MINOR 1 — resolvedSkipLine refuses to run without an explicit audited tip (never defaults to HEAD)', () => {
  const git = { orThrow: () => { throw new Error('the predicate must never be reached'); } };
  assert.throws(
    () => resolvedSkipLine('deadbee', 'M: subject', { git }),
    /audited tip/i,
    'a missing tip must throw fail-closed, never silently anchor at HEAD',
  );
});

test('MINOR 1 — resolvedSkipLine threads the caller-supplied tip into the predicate verbatim', () => {
  const seen = [];
  // Stub the seam at the argv level: record every rev the predicate asks about.
  const git = {
    orThrow: (argv) => { seen.push(argv.join(' ')); return 'PATCH\n'; },
  };
  resolvedSkipLine('deadbee', 'M: subject', { git, tip: 'release-2' });
  assert.ok(seen.some((cmd) => cmd.includes('release-2')),
    `the audited tip must reach git, not 'HEAD':\n${seen.join('\n')}`);
  assert.ok(!seen.some((cmd) => /\bHEAD\b/.test(cmd)),
    `'HEAD' must never appear when auditing a non-HEAD tip:\n${seen.join('\n')}`);
});

// ── MINOR 2 — no error-swallowing git reads survive on the per-merge path ────
// The defect was `numstat`/`changedFiles`/`body` routing through a helper that
// returned '' on ANY git failure: a transient failure produced an EMPTY diff, so
// diffSize and adrPresence PASSED — a silent fail-open inside the very slice
// whose thesis is "never a silent PASS" (already enforced for range-load and
// missing-parent → exit 2). Guarded by source scan rather than behaviorally, and
// deliberately so: every hermetic way to break `git diff` in a fixture (a bogus
// `diff.algorithm`, a deleted blob) ALSO breaks the range-load or the
// resolved-skip, both of which already exit 2 — so a "behavioral" test would
// pass against the unfixed code and prove nothing. The honest guard is
// structural: the swallowing helper does not exist to be called.
test('MINOR 2 — lib/merge-walk.mjs defines no error-swallowing git helper (the silent fail-open cannot return)', () => {
  assert.equal(/catch\s*\{\s*return\s*'';?\s*\}/.test(MERGE_WALK_SRC), false,
    'a git helper that swallows failure into an empty string re-opens the diffSize/adrPresence fail-open');
});

test('MINOR 2 — the per-merge reads route through the throwing seam', () => {
  for (const read of ['--numstat', '--name-only', '--format=%B', '--format=%P']) {
    const re = new RegExp(`gitOrThrow\\(\\[[^\\]]*'${read.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
    assert.ok(re.test(MERGE_WALK_SRC),
      `the ${read} read must go through gitOrThrow so a transient failure is exit 2, not a silent PASS`);
  }
});

// ── SIG drift-guard (ruling rev 3, the R3 source-scan precedent) ─────────────
// `payloadSignature` is a LOCAL mirror of resolution.mjs's module-private
// `normDiff` pins, accepted for PR3 only because reopening the PR2b-frozen
// export surface is the owner's keystroke. The fence is this test. The risk
// direction is the CORRECTED one: a COARSER local signature collides two
// distinct payloads onto one dedup key and SUPPRESSES a needed [FAIL-SHA] — a
// MISSED emission, fail-open for PR4's consumer. (The original claim that
// coarsening yields an EXTRA [FAIL-SHA] was inverted; see
// openspec/changes/issue-259-d2/brain-drafts/local-mirror-of-a-frozen-pin.md.) crossCheckExit
// compares booleans (>0), so it can never detect a partial suppression.
test('SIG drift-guard — the local payload-signature pins stay byte-aligned with resolution.mjs normDiff', () => {
  // Compare the VALUES, not the formatting: extract the quoted entries in
  // order. A guard that reddens on a line break is a guard nobody keeps.
  const pins = (src, name) => {
    const m = src.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`));
    assert.ok(m, `${name} not found — the drift-guard cannot verify what it cannot read`);
    return (m[1].match(/'[^']*'/g) || []).map((s) => s.slice(1, -1));
  };
  assert.deepEqual(pins(AUDIT_SRC, 'SIG_CONFIG'), pins(RESOLUTION_SRC, 'HARDENED_CONFIG'),
    'SIG_CONFIG drifted from resolution.mjs HARDENED_CONFIG — a coarser signature SUPPRESSES [FAIL-SHA]');
  assert.deepEqual(pins(AUDIT_SRC, 'SIG_ARGS'), pins(RESOLUTION_SRC, 'DIFF_ARGS'),
    'SIG_ARGS drifted from resolution.mjs DIFF_ARGS — a coarser signature SUPPRESSES [FAIL-SHA]');
});

// The mirror must also strip the SAME position-only lines normDiff strips
// (`@@ ...` hunk headers and `index ...` blob ids). Aligning the pins but not
// the normalization would still let two distinct payloads collapse.
test('SIG drift-guard — the local signature strips the same position-only lines as normDiff', () => {
  const filters = (src) => (src.match(/!\/\^(@@ |index )\/\.test\(line\)/g) || []).sort();
  assert.deepEqual(filters(AUDIT_SRC), filters(RESOLUTION_SRC),
    'the local mirror normalizes differently from normDiff — distinct payloads can collapse to one dedup key');
});

// ═══════════════════════════════════════════════════════════════════════════
// A10 — FROZEN FINDER FIXTURE (governance #297, finder≠patcher split).
//
// Labelled A10, not A9: the D2 emission series already owns "D2 A9(a)", and a
// shared label would make `--test-name-pattern="A9"` select three unrelated
// tests — which is precisely the selector this workflow pastes output from.
//
// The candidate attack the rev-4 ruling ROUTED here, stated mechanism-blind as
// the reviewer stated it: "the offending content arrives by EDITING AN EXISTING
// FILE." Nothing below inspects how net-absence, exemption, or liveness is
// computed — it builds a commit chain and reads the audit's own output.
//
// Attacker's chair: the ungoverned ADR text is introduced BEHIND the audit
// window (in the base commit), then removed and restored INSIDE the window by
// MODIFYING the file rather than adding it. The file's path is never `A` in any
// audited merge, so any exemption reasoning scoped to a candidate's ADDED paths
// has nothing to look at, while the ungoverned text sits LIVE at HEAD.
//
// This is A8's shape with one variable changed — modify instead of delete+add —
// which is exactly why it is worth freezing separately: A8 pins the ADD channel,
// A10 pins the MODIFY channel of the same property.
//
// The property, unchanged across both: A LIVE-AT-HEAD UNGOVERNED ARTIFACT MUST
// ALWAYS BE REPORTED. Each of R / O carries a Closes #N ref and a valid
// session_summary sits at HEAD, so the governance axis under test is the only
// one in play — the audit has exactly one honest thing to say about O.
//
// ── #510 REINFORCEMENT (maintainer's ruling on this ticket, option 3) ───────
//
// The PROPERTY above is frozen and untouched. What changed is which invariant
// carries it, and the fixture had to move with it or become an ornament.
//
// Until #510, the thing that reported O was `adrPresence` — a name-only check
// that could not tell an added path from a modified one, and therefore fired on
// O's MODIFY. That was never the rule `adrPresence` states ("a NEW ADR must be
// indexed in brain/HOME.md"); it was imprecision doing useful work by accident,
// documented only in another module's docstring. #510 makes the check precise,
// and the accident goes with it.
//
// The invariant that now owns the MODIFY channel is `writesGoverned` (#511) —
// "an ADR change on merged history carries a human gate". It keys on PR review
// evidence, so the fixture needs a RESOLVABLE PR: with none, the check abstains
// (it cannot determine governance, and #474/#511 settled that absence of
// evidence is not a verdict), and O would come out `[PASS]` — the fixture green
// for the reason the ruling explicitly rejected, its comment describing a
// mechanism that no longer runs.
//
// So R and O become PR-shaped merges and a PATH-stubbed `gh` serves one PR whose
// only review is a COMMENT — a real, resolvable, NON-approving review. That is
// the honest shape of the attack under the new design: the merge was seen and
// nobody gated it.
//
// Two things worth naming rather than discovering:
//   · What this fixture does NOT prove, stated because the first draft of this
//     comment claimed it did: it does not prove that `writesGoverned` survives
//     the net-parity exemption. Adding `writesGoverned` to TREE_KEYED_CHECKS
//     leaves A10 green — O's payload is LIVE at the tip, so the exemption never
//     applies to O whatever the membership. That property is real and load-
//     bearing, and it is pinned where it can actually fail, in
//     merge-walk.test.mjs, not asserted by proximity here.
//   · A merge with NO resolvable PR is no longer reported at all. The audit's
//     guarantee is now conditional on being able to read review evidence, and
//     that narrowing is recorded in ADR-0029 rather than left to be found here.

// A10b/A10c — the REINFORCEMENT (#511 ruling, option 3).
//
// A10 above proves the property through adrPresence, which #510 must make precise. These
// two prove the SAME property through the invariant that owns it, so the fixture keeps
// meaning what its comment says once the proxy is gone. They also pin the distinction the
// whole #511 investigation turned on: at PR time absent review evidence means "not yet";
// on merged history it means "never".
//
// Tier note: the fixture repo declares no governance.tier, and resolveTier defaults to
// `standard`, where the evidence IS an approving human review. At `lite` the ratified
// doctrine (ADR-0026) holds the maintainer's own authorship to be the gate — which is why
// A10's property is a standard/regulated property, and why A10 predating the tiering work
// (#297, before #358 Q5) is not a contradiction.

function a10Repo(dir) {
  const git = makeRepo(dir);
  const OFFENDING = '# ADR 902 example\n\nBody.\n\nUngoverned decision text.\n';
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
    'brain.config.json': JSON.stringify({
      vcs: { provider: 'github' }, project: { slug: 'acme/x' },
    }),
    [ADR_FILE]: OFFENDING,
  }, 'chore: initial with pre-existing ungoverned ADR (#0)');
  const base = headShaOf(git);
  commit(git, dir, { [ADR_FILE]: '# ADR 902 example\n\nBody.\n' }, 'R: clean Closes #2');
  return { git, base, OFFENDING };
}

function runAuditWithReviews(dir, range, reviews) {
  const binDir = join(dir, '.stubbin');
  writeReviewedGhStub(binDir, { number: 3, author: 'a-human', reviews });
  return spawnSync('node', [AUDIT_SCRIPT, range], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, GH_TOKEN: 'x' },
  });
}

test('A10b: the MODIFY channel with NO approving review is reported — post-merge, "not yet" is "never" (#511)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a10b-'));
  t.after(() => removeTempTree(dir));
  const { git, base, OFFENDING } = a10Repo(dir);
  const oSha = mergeAddingPayload(git, dir, { [ADR_FILE]: OFFENDING }, 'O',
    'Merge pull request #3 from acme/restore');

  const oStatus = git('diff', '--name-status', `${oSha}^1`, oSha).stdout;
  assert.match(oStatus, /^M\s/m, 'fixture invariant: O must MODIFY the ADR (never add it)');
  assert.doesNotMatch(oStatus, /^A\s/m, 'fixture invariant: O must add NO path — that is the attack');

  const r = runAuditWithReviews(dir, `${base}..HEAD`, [{ state: 'COMMENTED', login: 'a-human' }]);
  assert.notEqual(r.status, 0,
    `an ungoverned ADR edit, merged, must be reported\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /writesGoverned/,
    'and it must be the human-gate invariant saying so, not adrPresence standing in for it');
});

test('A10c: the same edit WITH an approving human review is not reported (#511)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a10c-'));
  t.after(() => removeTempTree(dir));
  const { git, base, OFFENDING } = a10Repo(dir);
  mergeAddingPayload(git, dir, { [ADR_FILE]: OFFENDING }, 'O',
    'Merge pull request #3 from acme/restore');

  const r = runAuditWithReviews(dir, `${base}..HEAD`, [{ state: 'APPROVED', login: 'a-reviewer' }]);
  assert.doesNotMatch(r.stdout, /writesGoverned/,
    'a reviewed ADR change is governed — the check must not fire, or it is not reading reviews at all');
});

// A10d — the exemption must not swallow the invariant that now carries A10.
//
// #511 made `writesGoverned` deliberately absent from TREE_KEYED_CHECKS and wrote why
// at the declaration; nothing tested it. #510 is what makes it load-bearing: while
// `adrPresence` still reported the MODIFY channel, an exemption swallowing the human
// gate left a tree-keyed failure behind anyway. With the proxy gone, `writesGoverned`
// is the only thing between an ungoverned brain/ write and a silent [SKIP].
//
// This exists because a mutation found the gap: adding 'writesGoverned' to
// TREE_KEYED_CHECKS left the entire suite green, A10 included. A10 cannot see it —
// its offender's payload is LIVE at the tip, so the net-parity exemption never applies
// to it whatever the membership says.
//
// Which merge CAN see it took a second wrong turn to find. Not the offender O: a merge
// whose contribution is net-absent at the tip is dropped by the PRE-EVALUATION resolved
// -skip (`resolvedSkipLine`, design §3.5/REQ-D2-10), which runs before any check and so
// before `writesGoverned` exists to have an opinion. The merge the exemption is actually
// FOR is the cleanup reverter R — `netAddFull`'s full-window range exists precisely so a
// tip-most R, with nothing after it to cancel it, still earns its exemption (§15.3's
// range-asymmetry note). R is a brain/ write like any other, and if `writesGoverned`
// were tree-keyed the exemption would take it with the rest.
//
// So the property here is about R, and it is the one A11 already frames from the other
// side: the good citizen MAY be reported, and must never be auto-reverted.
test('A10d: the cleanup reverter is a brain/ write too — its missing human gate survives the reverter-skip and is never nominated (#510/#511)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a10d-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
    'brain.config.json': JSON.stringify({
      vcs: { provider: 'github' }, project: { slug: 'acme/x' },
    }),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);

  const oSha = mergeAddingAdr(git, dir, 'O', 'Merge pull request #3 from acme/add-adr');
  // R — a genuine revert, tip-most. Its whole contribution is removal, so it is
  // exemption-ELIGIBLE: without the membership rule the exemption would clear it.
  const rSha = genuineRevertMerge(git, dir, oSha, 'revert-O', 'Merge pull request #2 from acme/revert');

  const r = runAuditWithReviews(dir, `${base}..HEAD`, [{ state: 'COMMENTED', login: 'a-human' }]);

  const rLine = r.stdout.split('\n').filter(Boolean)
    .find(l => l.includes(rSha) || l.includes(rSha.slice(0, 7)));
  assert.ok(rLine, `R must appear in the audit output:\n${r.stdout}`);

  // THE PROPERTY: R edited brain/project/** with no approving review. That is not a
  // statement about the tree, so the tree-parity exemption must not clear it.
  assert.ok(!rLine.startsWith('[SKIP]'),
    `R's brain/ write was never gated — the net-parity exemption must not clear a non-tree-keyed failure:\n${r.stdout}`);
  assert.match(rLine, /writesGoverned/,
    `and writesGoverned must be what survives — that is the membership decision under test:\n${r.stdout}`);
  // A11's property, restated for this class: the remedy for "nobody reviewed this" is
  // a human reviewing it, never a machine undoing it — and undoing R would resurrect
  // the very payload R removed.
  assert.ok(!r.stdout.split('\n').filter(l => l.startsWith('[FAIL-SHA]'))
    .some(l => l.includes(rSha) || l.includes(rSha.slice(0, 7))),
  `a review-evidence failure must never emit [FAIL-SHA]:\n${r.stdout}`);
});

test('brain-audit: A10 modification-shaped payload — an ungoverned ADR edited back in and LIVE at HEAD is reported, never all-[SKIP]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a10-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);

  // The ADR exists BEFORE the audit window in its OFFENDING state. Both later
  // merges only ever EDIT this file — its path is never added by either of them.
  const A10_OFFENDING = '# ADR 902 example\n\nBody.\n\nUngoverned decision text.\n';
  const A10_CLEANED = '# ADR 902 example\n\nBody.\n';

  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
    // #510 reinforcement: the audit must be ABLE to ask "was this reviewed?".
    // Without a VCS adapter it cannot, `writesGoverned` abstains, and the fixture
    // would go green on an unanswered question.
    'brain.config.json': JSON.stringify({
      vcs: { provider: 'github' }, project: { slug: 'acme/x' },
    }),
    [ADR_FILE]: A10_OFFENDING,
  }, 'chore: initial with pre-existing ungoverned ADR (#0)');
  const base = headShaOf(git);

  // R — cleanup merge that EDITS the offending text out (inside the window).
  // May legitimately be [SKIP]/[PASS]/[FAIL]; not asserted either way.
  mergeAddingPayload(git, dir, { [ADR_FILE]: A10_CLEANED }, 'R',
    'Merge pull request #2 from acme/clean');

  // O — merge that EDITS the offending text back in (inside the window). No
  // brain/HOME.md entry accompanies it, and the text is LIVE on disk at HEAD.
  const oSha = mergeAddingPayload(git, dir, { [ADR_FILE]: A10_OFFENDING }, 'O',
    'Merge pull request #3 from acme/restore');

  // Fixture invariants — if these break, the fixture is not testing the attack.
  assert.ok(existsSync(join(dir, ADR_FILE)),
    'fixture invariant: the ADR must be live on disk at HEAD=O');
  assert.ok(readFileSync(join(dir, ADR_FILE), 'utf8').includes('Ungoverned decision text'),
    'fixture invariant: the OFFENDING text must be live in the tree at HEAD=O');
  const oStatus = git('diff', '--name-status', `${oSha}^1`, oSha).stdout;
  assert.match(oStatus, /^M\s/m,
    `fixture invariant: O must MODIFY the ADR (never add it) — got:\n${oStatus}`);
  assert.doesNotMatch(oStatus, /^A\s/m,
    `fixture invariant: O must add NO path — that is the attack — got:\n${oStatus}`);

  // A resolvable PR whose only review is a COMMENT: seen, and not gated.
  const r = runAuditWithReviews(dir, `${base}..HEAD`, [{ state: 'COMMENTED', login: 'a-human' }]);

  // ── PROPERTY assertions — WHAT is reported / exit code, never the mechanism ──

  assert.notEqual(r.status, 0,
    `a live-at-HEAD ungoverned ADR must fail the audit (exit non-zero); got exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  const lines = r.stdout.split('\n').filter(Boolean);
  const oLine = lines.find(l => l.includes(oSha) || l.includes(oSha.slice(0, 7)));
  assert.ok(oLine, `O must appear in the audit output:\n${r.stdout}`);
  assert.ok(!oLine.startsWith('[SKIP]'),
    `O restored the ungoverned ADR and it is LIVE at HEAD — it must never be exempted on a [SKIP] line:\n${r.stdout}`);

  // #510: and it is the invariant that OWNS the MODIFY channel saying so. Without
  // this, the fixture would be satisfied again by any future check whose imprecision
  // happens to fire here — which is the state #510 found it in.
  assert.match(r.stdout, /writesGoverned/,
    `the report must come from the human-gate invariant, not from a proxy standing in for it:\n${r.stdout}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// A11 — FROZEN FINDER FIXTURE (governance #297, finder≠patcher split).
//
// Stage two of the rev-11 STAGED C ruling. Stage one (PR3c) widened the
// reverter-exemption liveness guard to MODIFIED paths, closing A10. That fix
// has a KNOWN, MEASURED cost, recorded at the time rather than discovered
// later: a LEGITIMATE modify-shaped cleanup reverter — a merge whose entire
// contribution is REMOVING offending content from a pre-existing file — now
// loses its exemption. Losing the exemption is acceptable; it yields an extra
// [FAIL], and an extra [FAIL] is the closed direction.
//
// What is NOT acceptable is the second half: that merge also emits
// [FAIL-SHA], the AUTO-REVERT signal. PR4 consumes [FAIL-SHA] to revert. So
// the signal points PR4 at the good citizen, and reverting a cleanup
// RESURRECTS the payload it removed — the precise harm design §15.5 names when
// it requires "never revert the intermediate legit reverter".
//
// THE PROPERTY, stated mechanism-blind and from the attacker's chair even
// though the "attacker" here is our own emitter: A MERGE WHOSE WHOLE
// CONTRIBUTION IS REMOVAL MUST NEVER CARRY [FAIL-SHA]. It may be reported —
// never a silent PASS — but it must not be nominated for automatic reversion.
//
// Nothing below inspects HOW exemption, denial or emission are computed. It
// builds a commit chain and reads the audit's own output lines.
//
// This fixture BLOCKS NOTHING TODAY (rev 11): it gates the pre-PR4 suppression
// work, and PR4 is bound by rec-779629c7… not to consume [FAIL-SHA] until this
// fixture and that suppression have landed.

test('brain-audit: A11 good-citizen emission — a modify-shaped cleanup reverter is reported but NEVER carries [FAIL-SHA]', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a11-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);

  const A11_CLEAN = '# ADR 904 example\n\nBody.\n';
  const A11_DIRTY = '# ADR 904 example\n\nBody.\n\nUngoverned decision text.\n';

  // Base: the ADR exists and is CLEAN. Inside the window, O dirties it and R
  // cleans it back — both by EDITING, never by adding or deleting the path.
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
    [ADR_FILE]: A11_CLEAN,
  }, 'chore: initial with a clean ADR (#0)');
  const base = headShaOf(git);

  // O — edits the offending text IN. The genuine offender.
  const oSha = mergeAddingPayload(git, dir, { [ADR_FILE]: A11_DIRTY }, 'O',
    'O: add ungoverned decision text Closes #1');

  // R — edits the offending text back OUT, tip-most. THE GOOD CITIZEN: its
  // entire contribution is removal.
  const rSha = mergeAddingPayload(git, dir, { [ADR_FILE]: A11_CLEAN }, 'R',
    'R: remove ungoverned decision text Closes #2');

  // ── Fixture invariants — if these break, this is not testing the property ──
  assert.ok(existsSync(join(dir, ADR_FILE)),
    'fixture invariant: the ADR itself must survive at HEAD (R edits, never deletes)');
  assert.equal(readFileSync(join(dir, ADR_FILE), 'utf8').includes('Ungoverned decision text'), false,
    'fixture invariant: R must have REMOVED the offending text — the tree at HEAD is clean');
  const rStatus = git('diff', '--name-status', `${rSha}^1`, rSha).stdout;
  assert.match(rStatus, /^M\s/m,
    `fixture invariant: R must MODIFY the ADR — got:\n${rStatus}`);
  assert.doesNotMatch(rStatus, /^[AD]\s/m,
    `fixture invariant: R must neither add nor delete a path — that is what makes it the good citizen — got:\n${rStatus}`);

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], {
    cwd: dir, encoding: 'utf8',
  });

  // ── PROPERTY assertions — WHAT is emitted, never HOW it is decided ────────

  // 1. THE PROPERTY. R contributed only removal, so it must never be nominated
  //    for automatic reversion. Format-agnostic: any [FAIL-SHA] carrying R's
  //    sha — abbreviated or full — violates it.
  const failShaLines = r.stdout.split('\n').filter(l => l.startsWith('[FAIL-SHA]'));
  const rNominated = failShaLines.some(l => l.includes(rSha) || l.includes(rSha.slice(0, 7)));
  assert.equal(rNominated, false,
    `R's whole contribution is REMOVAL — nominating it for auto-revert would resurrect the payload (§15.5).\n`
    + `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  // 2. The other half of the property, so a fix cannot satisfy (1) by going
  //    silent: R may be reported. What it must not be is invisible.
  const rLine = r.stdout.split('\n').filter(Boolean).find(l => l.includes(rSha.slice(0, 7)));
  assert.ok(rLine, `R must still appear in the audit output — never a silent PASS:\n${r.stdout}`);

  // 3. The offender itself stays accounted for: O introduced the text, and the
  //    audit must not lose track of it while getting R right.
  const oLine = r.stdout.split('\n').filter(Boolean).find(l => l.includes(oSha.slice(0, 7)));
  assert.ok(oLine, `O must appear in the audit output:\n${r.stdout}`);
});


// ═══════════════════════════════════════════════════════════════════════════
// A12 — FROZEN FINDER FIXTURE (governance #302, finder≠patcher split).
//
// The shape that candidate 1 (measured green on the whole frozen set, #302)
// gets WRONG: a REPLACE-shaped cleanup. A11 only exercised PURE-removal
// cleanups (zero `+` lines), so any "does the merge add live content" primitive
// passes A11 while resurrecting payloads on a replace.
//
// The chair, mechanism-blind: the ungoverned offending text is introduced
// BEHIND the audit window (base commit). Inside the window a single tip-most
// merge R REPLACES it — removes the offending text AND writes different,
// unrelated text in its place. R's net effect on the offending payload is
// REMOVAL, so reverting R would re-add the offending text (and delete the
// replacement) — the §15.5 resurrection. But R also ADDS a line ("replacement
// text") that is LIVE at the tip, so any primitive keyed on "did R add live
// content" wrongly keeps R's auto-revert signal.
//
// THE PROPERTY: a merge whose NET EFFECT removes the offending payload must
// never carry [FAIL-SHA], EVEN WHEN it also adds unrelated content live at the
// tip. R may be reported ([FAIL], human gate) — it may not be nominated for
// automatic reversion.
//
// RED against the shipped state (no suppression exists): R touches a live ADR
// path, fails adrPresence, is denied the exemption, and carries [FAIL-SHA].
// It stays RED under candidate 1 (`addsLiveContentAt` line-membership), because
// R's replacement line is live at the tip — that is the whole demonstration.
// GREEN only under a payload-anchored primitive that asks whether the OFFENDING
// content (not just any added line) is live at the tip.

test('brain-audit: A12 replace-shaped cleanup — a merge whose net effect removes the offending payload is never nominated for auto-revert, even while adding live text', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-a12-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);

  const OFFENDING = 'Ungoverned decision text.';
  const REPLACEMENT = 'Governed summary placeholder line.';
  const A12_DIRTY = `# ADR 905 example\n\nBody.\n\n${OFFENDING}\n`;
  const A12_REPLACED = `# ADR 905 example\n\nBody.\n\n${REPLACEMENT}\n`;

  // Base (outside the window): the ADR already holds the OFFENDING text.
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
    [ADR_FILE]: A12_DIRTY,
  }, 'chore: initial with pre-existing offending ADR (#0)');
  const base = headShaOf(git);

  // R (tip-most, in-window): REPLACES the offending text with different text.
  // Removes the payload AND adds a live replacement line. Modifies the ADR
  // without brain/HOME.md → fails adrPresence.
  const rSha = mergeAddingPayload(git, dir, { [ADR_FILE]: A12_REPLACED }, 'R',
    'R: replace ungoverned text with a governed placeholder Closes #2');

  // ── Fixture invariants — assert the attack shape BEFORE the property ───────
  const liveBlob = readFileSync(join(dir, ADR_FILE), 'utf8');
  assert.ok(existsSync(join(dir, ADR_FILE)),
    'fixture invariant: the ADR survives at HEAD (R modifies, never deletes)');
  assert.equal(liveBlob.includes(OFFENDING), false,
    'fixture invariant: the OFFENDING text must be GONE from the tree at HEAD (R removed it)');
  assert.ok(liveBlob.includes(REPLACEMENT),
    'fixture invariant: R\'s REPLACEMENT line must be LIVE at HEAD — this is what breaks a content-liveness primitive');
  const rStatus = git('diff', '--name-status', `${rSha}^1`, rSha).stdout;
  assert.match(rStatus, /^M\s/m,
    `fixture invariant: R must MODIFY the ADR — got:\n${rStatus}`);
  assert.doesNotMatch(rStatus, /^[AD]\s/m,
    `fixture invariant: R must neither add nor delete a path — got:\n${rStatus}`);
  // R's own diff genuinely ADDS the replacement line (a `+` line) — so any
  // "did the merge add live content" test sees it and wrongly nominates R.
  const rDiff = git('diff', '-U0', `${rSha}^1`, rSha).stdout;
  assert.ok(rDiff.split('\n').some(l => l.startsWith('+') && l.includes(REPLACEMENT)),
    `fixture invariant: R must ADD the replacement line in its own diff — got:\n${rDiff}`);

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], {
    cwd: dir, encoding: 'utf8',
  });

  // ── PROPERTY assertions — WHAT is emitted, never HOW it is decided ─────────

  // 1. THE PROPERTY. R's net effect removed the offending payload, so it must
  //    never be nominated for automatic reversion. Format-agnostic.
  const failShaLines = r.stdout.split('\n').filter(l => l.startsWith('[FAIL-SHA]'));
  const rNominated = failShaLines.some(l => l.includes(rSha) || l.includes(rSha.slice(0, 7)));
  assert.equal(rNominated, false,
    `R replaced the offending payload with unrelated text — reverting it resurrects the payload (§15.5). `
    + `It must never carry [FAIL-SHA].\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  // 2. R must still be REPORTED — a fix may not satisfy the property by going
  //    silent (that trades an auto-revert hazard for a silent PASS).
  const rLine = r.stdout.split('\n').filter(Boolean).find(l => l.includes(rSha.slice(0, 7)));
  assert.ok(rLine, `R must still appear in the audit output — never a silent PASS:\n${r.stdout}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// #518 — THE WALK IS THE WHOLE FIRST-PARENT LINE.
//
// It used to select `--first-parent --merges`, i.e. commits with more than one
// parent. A squash lands as a single-parent commit and was therefore never in the
// audited set — not evaluated and passed, NEVER LOOKED AT — and on a clean window
// the cursor advanced past it, permanently, because the cursor only moves forward.
// Measured on origin/main over 60 days: 101 first-parent commits, 70 enumerated,
// 31 never audited.
//
// The old shape of the silence: a window whose only content was a squash printed
// `[INFO] No merge commits found` and exited 0. Not "checked and clean" — never
// read, reported as nothing to read.
//
// THE ACCEPTANCE IS PARITY, and the ticket says so explicitly: a squash-shaped
// offender must receive the same verdict a merge-shaped one carrying the identical
// payload receives. Two separate assertions would let the two shapes drift into two
// policies; one comparison cannot.

function squashCommit(git, dir, files, message) {
  commit(git, dir, files, message);
  return headShaOf(git);
}

/** The audit's verdict lines, with shas stripped so two shapes compare equal. */
function verdictShape(stdout) {
  return stdout
    .split('\n')
    .filter(l => /^\[(PASS|FAIL|SKIP|WARN)/.test(l))
    .map(l => l.replace(/\b[0-9a-f]{7,40}\b/g, '<sha>'))
    .sort();
}

test('#518 PARITY: a squash-shaped offender gets the SAME verdict as a merge-shaped one', (t) => {
  // The two repos differ in ONE thing: how the identical payload landed. Anything
  // else in the fixture is held byte-identical, because a parity assertion over two
  // fixtures that differ in two ways proves nothing about either.
  const payload = { 'src/feature.mjs': 'export const x = 1;\n' };
  const subject = 'feat: the same payload (#77)';

  const run = (how) => {
    const dir = mkdtempSync(join(tmpdir(), `audit-518par-${how}-`));
    t.after(() => removeTempTree(dir));
    const git = makeRepo(dir);
    commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
    const base = headShaOf(git);
    if (how === 'squash') squashCommit(git, dir, payload, subject);
    else mergeAddingPayload(git, dir, payload, 'F', subject);
    return spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  };

  const squashed = run('squash');
  const merged = run('merge');

  assert.deepEqual(verdictShape(squashed.stdout), verdictShape(merged.stdout),
    `the same payload must earn the same verdict whatever its shape:\nsquash:\n${squashed.stdout}\nmerge:\n${merged.stdout}`);
  assert.equal(squashed.status, merged.status,
    `and the same exit code — squash=${squashed.status} merge=${merged.status}`);
  // And it must be a REAL verdict, not two matching silences. Without this the
  // assertion above is satisfied by the defect: both windows reporting nothing.
  assert.ok(verdictShape(squashed.stdout).length > 0,
    `both shapes must actually be audited, not both ignored:\n${squashed.stdout}`);
});

test('#518: a window whose only content is a squash is AUDITED, not reported empty', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-518sq-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  const sq = squashCommit(git, dir, { 'src/feature.mjs': 'export const x = 1;\n' }, 'feat: squash-shaped (#77)');

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });

  assert.ok(!/No merge commits found|No commits found/.test(r.stdout),
    `the exact old silence — a squash-only window reported as nothing to read:\n${r.stdout}`);
  assert.ok(r.stdout.includes(sq.slice(0, 7)),
    `the squash must appear by sha in the verdict lines:\n${r.stdout}`);
});

test('#518: a squash carrying a governance violation FAILS, where it used to pass unseen', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-518bad-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const base = headShaOf(git);
  // No issue reference anywhere — the violation issueLink exists to catch.
  squashCommit(git, dir, { 'src/sneaky.mjs': 'export const x = 1;\n' }, 'feat: no issue reference at all');

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, `a squash-shaped violation must fail the window:\n${r.stdout}`);
  assert.match(r.stdout, /\[FAIL\]/, `and be reported:\n${r.stdout}`);
});

test('#518: a squash-shaped offender can be NOMINATED for auto-revert', (t) => {
  // `[FAIL-SHA]` can only nominate a commit the audit enumerated, so before this
  // there was no remediation path for a squash at all. The workflow's revert step
  // already branches on parent count (`-m 1` only when nparents >= 2), so a linear
  // nomination is executable — that branch existed before anything could reach it.
  const dir = mkdtempSync(join(tmpdir(), 'audit-518nom-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init', 'brain/HOME.md': '# home\n' }, 'chore: initial (#0)');
  const base = headShaOf(git);
  // An ADR added with no HOME.md update — adrPresence is TREE-KEYED, so it is the
  // class that earns a [FAIL-SHA] nomination.
  squashCommit(git, dir,
    { 'brain/project/decisions/adr-0099-x.md': '# adr\n' }, 'feat: adr without index (#88)');

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.match(r.stdout, /\[FAIL-SHA\]/,
    `a tree-keyed failure on a squash must be nominatable, or it has no remediation path:\n${r.stdout}`);
});

test('#518: a range reaching the ROOT commit is uncomputable, never silently narrowed', (t) => {
  // The widened walk rests on `sha^1` resolving, which is true of every commit
  // EXCEPT the root. `readMergeParent` used to justify itself with "a
  // --merges-qualified commit always has >=2 parents"; that premise is gone, and the
  // replacement guarantee (`%P` is empty only at the root) has to be asserted rather
  // than assumed — fail-closed, never a skip.
  const dir = mkdtempSync(join(tmpdir(), 'audit-518root-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, `a window containing the root must not pass silently:\n${r.stdout}`);
  assert.match(`${r.stdout}${r.stderr}`, /uncomputable|no resolvable parent/,
    `and must say it could not compute, not that it found nothing:\n${r.stdout}\n${r.stderr}`);
});

test('#518: readMergeParent REFUSES the root commit — driven as a unit, not through the CLI', (t) => {
  // The CLI-level root test above goes red for a DIFFERENT reason: the exemption
  // model reads `windowFrom^1` and git rejects it before this guard is consulted.
  // So the guard itself had no coverage, and a mutation returning the sha instead
  // of throwing stayed green through the whole suite.
  //
  // That is the `||`-in-an-assertion lesson in another shape: an outcome satisfied
  // by a second path proves nothing about the first. This drives the function.
  const dir = mkdtempSync(join(tmpdir(), 'audit-518parent-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const root = headShaOf(git);

  assert.throws(() => readMergeParent(root, 'chore: initial (#0)', dir),
    /no resolvable parent/,
    'the root has no parent and the diff-against-parent model cannot answer — fail closed, never a skip');

  // And the ordinary case still resolves, or the guard would be trivially satisfied
  // by refusing everything.
  commit(git, dir, { 'x.md': 'x' }, 'docs: x Closes #1');
  const child = headShaOf(git);
  assert.equal(readMergeParent(child, 'docs: x Closes #1', dir), root,
    'a single-parent commit resolves its one parent — that is what makes the wider walk possible');
});

test('#518 DRIFT GUARD: no enumerator on the audited path may filter to merges again', () => {
  // The completeness is a property of the git command, so it is pinned on the
  // SOURCE. A runtime re-count would issue the same query and agree with itself —
  // the shape of self-confirming evidence this repo keeps removing.
  //
  // All three move together or the two sides disagree about what a window contains:
  // the offender walk, and the revert side's two.
  for (const rel of ['lib/merge-walk.mjs', 'governance/postmerge/resolution.mjs']) {
    const src = readFileSync(fileURLToPath(new URL(`./${rel}`, import.meta.url)), 'utf8');
    const offenders = src.split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /'--first-parent'/.test(l) && /'--merges'/.test(l));
    assert.deepEqual(offenders, [],
      `${rel}: an enumerator filtering to --merges skips every squash (#518)`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// #518 — the remediation line the audit prints must be a command that RUNS.
//
// It used to be `cursor.mjs accept <sha> --reason "…"`, and the reason a unit test
// on the emitter's text would not have caught it is the whole point: the string
// LOOKS right. The CLI takes `<from> <to> --reason`, and the missing `<to>` does not
// even trip the arity guard — `--reason` binds to `to`, all three bindings are
// truthy, `usage()` never fires, and `acceptManually` prints `accept: <reason>` to
// stdout BEFORE `advanceCursor` rejects the non-hex target. A success-shaped line
// followed by a failure.
//
// So this test EXTRACTS the printed command and EXECUTES it, which is the only shape
// that can tell "the text changed" from "the instruction works".

function extractAcceptCommand(stdout) {
  const line = stdout.split('\n').find(l => l.includes('cursor.mjs accept'));
  if (!line) return null;
  const m = line.match(/node (brain\/scripts\/governance\/postmerge\/cursor\.mjs accept [^"]*"[^"]*")/);
  return m ? m[1] : null;
}

test('#518: the printed accept command PARSES — it reaches the CAS, not the usage error', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-518-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  mergeAddingAdr(git, dir, 'O', 'O: add ungoverned ADR Closes #1');

  const audit = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.equal(audit.status, 1, `expected a surviving adrPresence failure:\n${audit.stdout}\n${audit.stderr}`);

  const cmd = extractAcceptCommand(audit.stdout);
  assert.ok(cmd, `the remediation line must carry an accept command:\n${audit.stdout}`);

  // Run it. There is no remote here, so the CAS push cannot succeed — that is fine
  // and is not what is under test. What IS under test: the command must get PAST
  // argument parsing and PAST both 40-hex validations, i.e. it must fail (if at all)
  // at the push, never at `usage` and never at "to must be a 40-hex sha".
  const parts = cmd.split(' ');
  const reasonIdx = parts.indexOf('--reason');
  const argv = [...parts.slice(1, reasonIdx + 1), parts.slice(reasonIdx + 1).join(' ').replace(/^"|"$/g, '')];
  const run = spawnSync('node', argv, { cwd: dir, encoding: 'utf8' });
  const out = `${run.stdout}\n${run.stderr}`;

  assert.ok(!/Usage: cursor\.mjs/.test(out),
    `the printed command must not hit the usage error — it is what the audit tells a human to run:\n${out}`);
  assert.ok(!/to must be a 40-hex sha/.test(out),
    `the printed command must supply a real <to> — this is the exact defect #518 records:\n${out}`);
});

test('#518: the accept command names the WINDOW, never the offending merge as <from>', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-518b-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  const oSha = mergeAddingAdr(git, dir, 'O', 'O: add ungoverned ADR Closes #1');

  const audit = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  const cmd = extractAcceptCommand(audit.stdout);

  // `from` is the human's assertion of the CURSOR value they reviewed — that is what
  // gives the CAS its function. `accept` advances a WINDOW; there is no per-merge
  // accept, and a fix that only appended a `<to>` would have kept this half wrong.
  assert.match(cmd, new RegExp(`accept ${base} `), `<from> must be the window base:\n${cmd}`);
  assert.ok(!cmd.includes(`accept ${oSha}`), `the offending merge must not sit in the <from> slot:\n${cmd}`);
  assert.match(audit.stdout, /ACCEPT THE WHOLE AUDITED WINDOW/,
    'the line must say what accepting does — the old wording read as a per-merge accept');
});

test('#518: with no window base, the command is VISIBLY a placeholder rather than a plausible guess', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-518c-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  mergeAddingAdr(git, dir, 'O', 'O: add ungoverned ADR Closes #1');

  // A bare revision names no base — a local `brain:audit` with no origin/main.
  const audit = spawnSync('node', [AUDIT_SCRIPT, 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.match(audit.stdout, /accept <cursor-sha> <target-sha>/,
    'a fabricated sha in a force-with-lease is worse than an obvious blank');
  assert.match(audit.stdout, /cursor\.mjs window/,
    'and it must say where to get the real values');
});

// ═══════════════════════════════════════════════════════════════════════════
// B1 (#889, design A8, spec "brain:audit reports [LANE] on both signals") —
// a merge/squash classified as a lane by BOTH signals (records-only additions
// AND the `/^Memory lane: /m` body marker) is reported `[LANE]` and never
// reaches `evaluateMerge` — no governance verdict is rendered for a shipped
// memory lane. Paths alone or the marker alone must NOT classify as a lane.
// ═══════════════════════════════════════════════════════════════════════════

test('B1 (fallback path, no resolvable PR): a records-only squash carrying the lane marker in the COMMIT BODY prints [LANE], never a verdict', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-lane-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const base = headShaOf(git);

  const sq = squashCommit(
    git, dir,
    { '.memory/records/2026-07.jsonl': makeSessionSummaryRecord() },
    'feat: ship a session record\n\nMemory lane: host1-2026-09-10\n',
  );

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });

  assert.ok(r.stdout.includes(`[LANE] ${sq.slice(0, 7)}`),
    `expected a [LANE] line naming the squash:\n${r.stdout}\n${r.stderr}`);
  assert.ok(!/\[(PASS|FAIL|SKIP)\]/.test(r.stdout),
    `a lane merge must never reach evaluateMerge — no verdict line expected:\n${r.stdout}`);
  assert.equal(r.status, 0, `a lane merge is clean, not a failure:\n${r.stdout}\n${r.stderr}`);
});

// This is the SHAPE PR 2 actually ships: a squash subject carrying `(#N)` (so
// `parsePrNumber` resolves a PR), `gh pr view` answering with the `Memory lane:`
// marker in the PR BODY (the body `ship.mjs` writes — design A8), and NO marker in
// the raw commit body at all. The fallback test above cannot exercise `issueLinkBody`
// taking its PR-body branch — its subject has no `(#N)`, so `prNum` is null,
// `fetchPrMeta` never calls `gh`, and `selectIssueLinkBody` falls back to the commit
// body by construction. That gap is exactly what let `issueLinkBody` → `body`
// (`brain-audit.mjs:341`) survive: with the marker present in BOTH bodies in the
// fallback fixture, the fallback test cannot tell which one the code actually read.
test('B1 (production shape): the marker lives in the PR body via `gh pr view`; the commit body carries none', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-lane-prbody-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    'brain.config.json': JSON.stringify({
      vcs: { provider: 'github' },
      project: { slug: 'acme/x' },
    }),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);

  // Squash subject only — NO body, so the raw commit body is empty and carries no marker.
  const sq = squashCommit(
    git, dir,
    { '.memory/records/2026-09-10.jsonl': makeSessionSummaryRecord() },
    'memory: host1 2026-09-10 (1 records) (#912)',
  );

  const binDir = join(dir, '.stubbin');
  writeReviewedGhStub(binDir, {
    number: 912, author: 'brain-bot', reviews: [],
    body: 'Memory lane: host1 2026-09-10\nRecords: 1\n',
  });

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, GH_TOKEN: 'x' },
  });

  assert.ok(r.stdout.includes(`[LANE] ${sq.slice(0, 7)}`),
    `the marker fetched from the PR body (gh pr view), not the marker-free commit body, must classify this as a lane:\n${r.stdout}\n${r.stderr}`);
  assert.ok(!/\[(PASS|FAIL|SKIP)\]/.test(r.stdout),
    `a lane merge must never reach evaluateMerge — no verdict line expected:\n${r.stdout}`);
  assert.equal(r.status, 0, `a lane merge is clean, not a failure:\n${r.stdout}\n${r.stderr}`);
});

test('B1: the SAME records-only payload WITHOUT the marker is evaluated normally', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-lane-nomarker-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const base = headShaOf(git);

  squashCommit(
    git, dir,
    { '.memory/records/2026-07.jsonl': makeSessionSummaryRecord() },
    'feat: ship a session record (no lane marker)',
  );

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });

  assert.ok(!r.stdout.includes('[LANE]'),
    `paths alone must not classify as a lane — the marker is required too:\n${r.stdout}`);
  assert.ok(/\[(PASS|FAIL)\]/.test(r.stdout),
    `without the marker, evaluateMerge must still run and produce a verdict:\n${r.stdout}`);
});

test('B1: a code path alongside records, WITH the marker, is evaluated normally (lanePaths false)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-lane-mixed-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const base = headShaOf(git);

  squashCommit(
    git, dir,
    {
      '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
      'src/feature.mjs': 'export const x = 1;\n',
    },
    'feat: ship a record alongside code\n\nMemory lane: host1-2026-09-10\n',
  );

  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });

  assert.ok(!r.stdout.includes('[LANE]'),
    `the marker alone must not classify as a lane — a non-record path must fail lanePaths:\n${r.stdout}`);
  assert.ok(/\[(PASS|FAIL)\]/.test(r.stdout),
    `a mixed payload must still be evaluated by evaluateMerge:\n${r.stdout}`);
});

test('B1: the [UNCOMPUTABLE] guard short-circuits BEFORE lane classification', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-lane-uncomputable-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    'brain.config.json': JSON.stringify({
      vcs: { provider: 'github' },
      project: { slug: 'csrinaldi/brain' },
    }),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);

  git('checkout', '-b', 'memory/host1-2026-09-10');
  commit(git, dir, { '.memory/records/2026-07.jsonl': makeSessionSummaryRecord() }, 'feat: lane ship');
  git('checkout', 'main');
  // The lane marker lives in the PR description, which an unauthenticated
  // fetch cannot read — never fall back to the raw merge commit body to
  // manufacture a [LANE] verdict the evidence does not support.
  git('merge', '--no-ff', 'memory/host1-2026-09-10', '-m', 'Merge pull request #472 from csrinaldi/memory/host1-2026-09-10');

  const r = runAuditUnauthenticated(dir, `${base}..HEAD`);

  assert.ok(!r.stdout.includes('[LANE]'),
    `a merge whose PR metadata failed must never be classified as a lane on a fallback body:\n${r.stdout}`);
  assert.ok(r.stdout.includes('[UNCOMPUTABLE]'), `expected [UNCOMPUTABLE]:\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.status, 2, `uncomputable dominates:\n${r.stdout}\n${r.stderr}`);
});

// ── Config-read failure — DENY-direction fail-closed (issue #962) ───────────
//
// `governance.reviewActors` (`:354`) is the DENY/exclusion list `loadConfig`
// feeds to `evaluateMerge`'s `botAllowlist` — it decides which reviewers are
// EXCLUDED from the human-approver count. Before this fix `loadConfig` caught
// ANY read/parse failure and returned `{}` ("never throws"), so an unparseable
// brain.config.json silently excluded nobody — the PERMISSIVE answer in a DENY
// direction (`evidence-reader-empty-on-failure.md`, "Direction decides whether
// empty is safe", issue #942). `brain-audit.mjs` IS the release gate
// (`.github/workflows/release.yml` tags only after it exits 0), so that silent
// `{}` let a release through on a policy the audit never actually read.
//
// A source-level fixture test (a temp repo, never the real clone), per the
// acceptance criteria. `loadConfig` now runs `loadBrainConfigOrThrow` and does
// NOT catch, so the throw propagates to the top-level `.catch` (REQ-D2-12)
// BEFORE any merge is evaluated — no sibling reader (ignoreList, tier,
// baseline, the VCS adapter, reviewActors itself) ever runs on this path, so
// reverting ONLY this reader (restoring `catch { return {}; }`) is what turns
// this test red; nothing else on the path can fail it.
test('#962: unparseable brain.config.json fails the release gate closed, naming the config (never a silent {})', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-config-unparseable-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  commit(git, dir, { 'brain.config.json': '{oops' }, 'chore: corrupt config');

  // A genuinely EMPTY range (`HEAD..HEAD`, same shape as the "genuinely EMPTY
  // range" test above): with the fix, `loadConfig` throws unconditionally
  // BEFORE `listAuditedCommits` ever runs, so zero commits in range still
  // fails closed. This also means no commit's issueLink/memoryPresence/etc
  // content can flip this assertion — the walk never starts.
  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD..HEAD'], { cwd: dir, encoding: 'utf8' });

  assert.notEqual(r.status, 0,
    `an unparseable brain.config.json must not read as a clean release gate:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /brain\.config\.json/,
    `the failure must name the config as the cause:\n${r.stdout}`);
  assert.match(r.stdout, /could not be parsed/,
    `the failure must name WHY (loadBrainConfigOrThrow's message), not a generic error:\n${r.stdout}`);
});

// ── Config-shape failure — the #942 class through a shape gap (issue #975) ──
//
// `loadBrainConfigOrThrow` used to return whatever `JSON.parse` produced,
// with no check that it was a plain object. `loadConfig(cwd)` (`:181`) feeds
// that value straight to `governance.reviewActors` (`:370`) via optional
// chaining, so `null`, `[]`, or `42` degraded exactly like `{}` — nobody
// excluded, the PERMISSIVE answer in a DENY direction. A source-level
// fixture test (a temp repo, never the real clone), same shape as the #962
// test above: a genuinely-empty range means `loadConfig`'s throw is the ONLY
// thing that can flip this assertion.
test('#975: a non-object brain.config.json ([]) fails the release gate closed, naming the type found', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-config-shape-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  commit(git, dir, { 'brain.config.json': '[]' }, 'chore: non-object config');

  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD..HEAD'], { cwd: dir, encoding: 'utf8' });

  assert.notEqual(r.status, 0,
    `a non-object brain.config.json must not read as a clean release gate:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /brain\.config\.json/,
    `the failure must name the config as the cause:\n${r.stdout}`);
  assert.match(r.stdout, /must contain a JSON object/,
    `the failure must name WHY (loadBrainConfigOrThrow's shape-check message):\n${r.stdout}`);
  assert.match(r.stdout, /got array/,
    `the failure must name the JSON type found:\n${r.stdout}`);
});

test('#962: no brain.config.json at all — behaviour unchanged (ENOENT still resolves to {}, R11)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-config-absent-'));
  t.after(() => removeTempTree(dir));

  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  // No merges at all in range — the genuinely-empty-range path, scoped here to
  // an explicitly ABSENT config so an ENOENT must not turn it into a failure.
  const r = spawnSync('node', [AUDIT_SCRIPT, 'HEAD..HEAD'], { cwd: dir, encoding: 'utf8' });

  assert.equal(r.status, 0,
    `an absent brain.config.json must audit exactly as before (R11):\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /No commits found/);
});

// ═══════════════════════════════════════════════════════════════════════════
// Issue #1086 (D6) — emission suffixes. Pure unit tests on the exported
// formatters: no entrypoint spawn, no real `.git`, no fixture repo at all —
// exactly the "pure emission path" the design's Testing Strategy calls for.
// ═══════════════════════════════════════════════════════════════════════════

test('#1086: the legacy [UNCOMPUTABLE] line stays byte-identical (prView read could not be completed)', () => {
  const line = formatUncomputableLine('deadbeefcafe', 'Merge pull request #471 from x/y', {
    prNum: 471,
    prMetaError: 'PR metadata unreadable (prView returned the REQ-CIC-2 uncomputable sentinel for #471) '
      + '— the API call failed; the evaluator has no evidence, not empty evidence',
  });

  assert.equal(
    line,
    '[UNCOMPUTABLE] deadbee Merge pull request #471 from x/y — PR #471 metadata unreachable: '
      + 'PR metadata unreadable (prView returned the REQ-CIC-2 uncomputable sentinel for #471) '
      + '— the API call failed; the evaluator has no evidence, not empty evidence',
    'this is the exact pre-#1086 wording — a consumer parsing this line must see no change',
  );
});

test('#1086: an ambiguous [UNCOMPUTABLE] line (two containing PRs) names its own cause, distinct from the legacy line', () => {
  const legacy = formatUncomputableLine('cafebabe0001', 'feat: x (#5)', {
    prNum: 5,
    prMetaError: 'PR metadata unreadable (prView returned the REQ-CIC-2 uncomputable sentinel for #5) '
      + '— the API call failed; the evaluator has no evidence, not empty evidence',
  });
  const ambiguous = formatUncomputableLine('cafebabe0002', 'feat: y (#6)', {
    prNum: null,
    prMetaError: "subject's #6 is not a pull request; 2 pull requests contain the merge commit (10, 20) "
      + 'and none can be chosen — the evaluator has no evidence, not empty evidence',
  });

  assert.notEqual(legacy, ambiguous);
  assert.match(legacy, /PR #5 metadata unreachable/);
  assert.match(ambiguous, /10, 20/);
  assert.doesNotMatch(ambiguous, /metadata unreachable/,
    'the ambiguous cause must never be phrased as the legacy "read could not be completed" cause');
});

test('#1086: the commit-sha-resolved suffix renders on [PASS]/[FAIL]', () => {
  const suffix = formatPrSourceSuffix({ subjectRef: 978, prNum: 991, prSource: 'commit-sha', prMetaError: null });
  assert.equal(suffix, ' [pr #991 by commit-sha; (#978) is not a pull request]');
});

test('#1086: the no-containing-PR suffix renders when the commit body was audited', () => {
  const suffix = formatPrSourceSuffix({ subjectRef: 978, prNum: null, prSource: null, prMetaError: null });
  assert.equal(suffix, ' [(#978) is not a pull request; no pull request contains this merge — commit body audited]');
});

test('#1086: no suffix for an ordinary subject-resolved merge (unchanged today)', () => {
  assert.equal(formatPrSourceSuffix({ subjectRef: 471, prNum: 471, prSource: 'subject', prMetaError: null }), '');
});

test('#1086: no suffix when the subject references no PR at all (unchanged today)', () => {
  assert.equal(formatPrSourceSuffix({ subjectRef: null, prNum: null, prSource: null, prMetaError: null }), '');
});

// ── #1188 — the demo replay: a fresh consumer's first real merge ──────────────
//
// The 1.10.0 exit demonstration (#1185) ran adoption, then the lane-enable PR.
// The PR-time memory-gate passed it; the post-merge audit failed it as
// `memoryPresence`, filed `governance:audit-unrevertible`, and pinned the cursor.
// These fixtures replay that history in a real git repo and run the real audit.

function adoptedConsumer(dir, tier) {
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'consumer',
    'brain.config.json': JSON.stringify({ governance: { tier }, vcs: { provider: 'github' } }),
  }, 'chore: adopt brain (#1)');
  return git;
}

function laneEnableMerge(git, dir) {
  git('checkout', '-b', 'chore/enable-memory-lane');
  commit(git, dir, { 'brain.config.json': JSON.stringify({ memory: { lane: { enabled: true } } }) },
    'chore(memory): enable the memory lane (#3)');
  git('checkout', 'main');
  git('merge', '--no-ff', 'chore/enable-memory-lane', '-m', 'chore(memory): enable the memory lane (#3)\n\nCloses #2');
}

test('brain-audit #1188: lite consumer, lane-enable merge with no records — no unrevertible failure (demo replay)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-1188-lite-'));
  t.after(() => removeTempTree(dir));
  const git = adoptedConsumer(dir, 'lite');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  laneEnableMerge(git, dir);
  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.ok(!/memoryPresence/.test(r.stdout), `memoryPresence must not fail:\n${r.stdout}`);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
});

test('brain-audit #1188: standard consumer with NO memory history — early merge abstains, never fails', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-1188-early-'));
  t.after(() => removeTempTree(dir));
  const git = adoptedConsumer(dir, 'standard');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  laneEnableMerge(git, dir);
  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.ok(!/memoryPresence/.test(r.stdout), `memoryPresence must not fail:\n${r.stdout}`);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
});

test('brain-audit #1188: standard consumer WITH history — a merge with no scoped record still fails (the predicate applies in full)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-1188-history-'));
  t.after(() => removeTempTree(dir));
  const git = adoptedConsumer(dir, 'standard');
  commit(git, dir, {
    '.memory/records/2026-09-x.jsonl': JSON.stringify({ id: 'other', type: 'session_summary', issue: 99, content: 'x' }) + '\n',
  }, 'chore(memory): a record for another issue (#5)');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  laneEnableMerge(git, dir);
  const r = spawnSync('node', [AUDIT_SCRIPT, `${base}..HEAD`], { cwd: dir, encoding: 'utf8' });
  assert.match(r.stdout, /memoryPresence/);
  assert.equal(r.status, 1);
});
