// ship.test.mjs — unit tests for shipLane() (#888, ADR-0034 L1/L2/L5).
// Every injected fn (`collect`, `git`, `vcs`) is a fake — no filesystem, no
// subprocess, no network. See openspec/changes/issue-888-lane-ship/{spec,
// design}.md for the requirements and architecture decisions (A1-A7) this
// file proves.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shipLane } from './ship.mjs';

const REF = 'refs/heads/memory/test-host-2026-09-09';
const BRANCH = 'memory/test-host-2026-09-09';

/** A collect fake returning a fixed shape, override any field. */
function fakeCollect(overrides = {}) {
  return () => ({
    ref: REF,
    commit: 'c0mm1t',
    collected: 1,
    skipped: [],
    duplicates: { ids: 0, divergent: 0 },
    baseFetched: true,
    skippedWorktrees: [],
    ...overrides,
  });
}

/**
 * A router-based fake `git`. `rules` is an array of `{ match(argv) => bool,
 * result }`; the first matching rule wins. Every call is recorded in `calls`.
 */
function fakeGit(rules) {
  const calls = [];
  const git = (argv, opts) => {
    calls.push(argv);
    for (const rule of rules) {
      if (rule.match(argv)) return typeof rule.result === 'function' ? rule.result(argv, opts) : rule.result;
    }
    throw new Error(`fakeGit: no rule matched argv ${JSON.stringify(argv)}`);
  };
  return { git, calls };
}

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = (stderr, status = 1) => ({ status, stdout: '', stderr });

/** The standard "ahead of origin by one, no divergence" survey + diff rules,
 * shared by every test that reaches the push step.
 *
 * `diffPaths` answers `surveyDelivery`'s first call (three-dot, `origin/main
 * ...<ref>` — byte-identical to `buildTitleAndBody`'s own diff, R4's
 * deliberate collision) and `undeliveredPaths` answers its second (`--`
 * pathspec). The `--` rule is checked FIRST (first-match-wins, R4's ordered
 * pair) so the two argvs are never confused. `undeliveredPaths` defaults to
 * `diffPaths` (undelivered) so every pre-#920 test keeps its behavior and
 * assertions verbatim. */
function surveyOkRules({
  behind = '0', ahead = '1',
  diffPaths = ['.memory/records/2026-09-rec-1.jsonl'],
  undeliveredPaths = diffPaths,
} = {}) {
  return [
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${REF}..refs/remotes/origin/${BRANCH}`, result: ok(behind) },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${BRANCH}..${REF}`, result: ok(ahead) },
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: ok(undeliveredPaths.join('\n')) },
    { match: (a) => a[0] === 'diff' && a[2] === `origin/main...${REF}`, result: ok(diffPaths.join('\n')) },
  ];
}

function fakeVcs(overrides = {}) {
  const calls = { mrList: 0, mrCreate: 0, mrAutoMerge: 0 };
  const base = {
    mrList: async () => { calls.mrList++; return []; },
    mrCreate: async () => { calls.mrCreate++; return { url: 'https://example.invalid/pull/42' }; },
    mrAutoMerge: async () => { calls.mrAutoMerge++; return { enabled: true, url: null }; },
  };
  const vcs = { ...base, ...overrides };
  return { vcs, calls };
}

// ── Requirement: the ship sequence and outcome shape ────────────────────────

test('a full run produces the outcome shape, pushed:true, pr.number set', async () => {
  const { git } = fakeGit([
    ...surveyOkRules(),
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  const { vcs } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  assert.equal(result.pushed, true);
  assert.equal(result.ref, REF);
  assert.equal(result.branch, BRANCH);
  assert.ok(result.pr && result.pr.number === 42);
  assert.equal(result.autoMerge.enabled, true);
  assert.equal(result.identityBound, false);
  assert.equal(result.dryRun, false);
  assert.equal(result.closedUnmerged, false, 'closedUnmerged defaults to false on the ordinary success path');
});

// ── #921 — shipLane() must forward collectLane()'s skippedWorktrees, never drop it ──

test('#921 — a full run forwards collect()\'s skippedWorktrees verbatim into the outcome shape', async () => {
  const { git } = fakeGit([
    ...surveyOkRules(),
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  const { vcs } = fakeVcs();
  const skippedWorktrees = [{ path: '/repo/wt-b', reason: 'fatal: could not read worktree' }];

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect({ skippedWorktrees }), git, vcs,
  });

  assert.deepEqual(result.skippedWorktrees, skippedWorktrees, 'a worktree collect() could not inspect must survive into shipLane\'s own outcome shape, not be dropped in translation');
});

test('#921 — a --dry-run run also forwards skippedWorktrees (collect() already ran before the dry-run short-circuit)', async () => {
  const dryRunGit = (argv) => {
    if (argv[0] === 'diff') return ok('.memory/records/2026-09-rec-1.jsonl');
    throw new Error(`unexpected argv under --dry-run: ${JSON.stringify(argv)}`);
  };
  const skippedWorktrees = [{ path: '/repo/wt-b', reason: 'fatal: could not read worktree' }];

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    dryRun: true, collect: fakeCollect({ skippedWorktrees }), git: dryRunGit, vcs: null,
  });

  assert.deepEqual(result.skippedWorktrees, skippedWorktrees);
});

test('(a) ref exists, remote matches, lane delivered ⇒ no-op: zero push/list/create/arm calls', async () => {
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${REF}..refs/remotes/origin/${BRANCH}`, result: ok('0') },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${BRANCH}..${REF}`, result: ok('0') },
    { match: (a) => a[0] === 'diff', result: ok('') },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect({ commit: null }), git, vcs,
  });

  assert.equal(result.pushed, false);
  assert.equal(result.pr, null);
  assert.equal(result.autoMerge, null);
  // C3 (cold review): unconditional title/body in the outcome shape, null
  // rather than absent — see the "cold-1" test below for the full rationale.
  assert.equal(result.title, null);
  assert.equal(result.body, null);
  assert.ok(!calls.some((a) => a[0] === 'push'), 'must never push when nothing to ship');
  assert.deepEqual(vcsCalls, { mrList: 0, mrCreate: 0, mrAutoMerge: 0 });
  // R6/R13: delivered content-containment makes this a true no-op.
  assert.equal(result.delivered, true);
  assert.equal(result.deliveredReason, null);
  assert.equal(result.reconciled, false);
  assert.equal(result.closedUnmerged, false, 'a delivered no-op never reaches the D4 lookup, so this stays the default');
});

test('(b) M1 regression pin: ref exists, ahead:0, records absent from origin/main ⇒ no push, but find/create + arm run', async () => {
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${REF}..refs/remotes/origin/${BRANCH}`, result: ok('0') },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${BRANCH}..${REF}`, result: ok('0') },
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: ok('.memory/records/2026-09-rec-1.jsonl') },
    { match: (a) => a[0] === 'diff', result: ok('.memory/records/2026-09-rec-1.jsonl') },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect({ commit: null }), git, vcs,
  });

  assert.equal(result.pushed, false, 'nothing new is queued, so no push happens');
  assert.equal(result.reconciled, true, 'the reconcile tail must still run for an undelivered lane');
  assert.ok(result.pr && result.pr.number === 42);
  assert.deepEqual(vcsCalls, { mrList: 1, mrCreate: 1, mrAutoMerge: 1 });
  assert.ok(!calls.some((a) => a[0] === 'push'), 'the M1 retry must never push when nothing is queued');
});

test('row 7: PR merged, remote branch auto-deleted (remoteRefPresent:false, ahead:3), delivered ⇒ zero push/list/create/arm', async () => {
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: fail(`fatal: couldn't find remote ref refs/heads/${BRANCH}`) },
    { match: (a) => a[0] === 'rev-list' && a[1] === '--count' && a[2] === REF, result: ok('3') },
    { match: (a) => a[0] === 'diff', result: ok('') },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect({ commit: null }), git, vcs,
  });

  assert.equal(result.remoteRefPresent, false);
  assert.equal(result.ahead, 3);
  assert.equal(result.delivered, true);
  assert.equal(result.pushed, false);
  assert.ok(!calls.some((a) => a[0] === 'push'), 'a delivered lane must never re-push a merged, deleted branch');
  assert.deepEqual(vcsCalls, { mrList: 0, mrCreate: 0, mrAutoMerge: 0 });
});

test('reconcile-only path (M1 shape): mrList throwing is still fatal prLookupFailed, mrCreate never called', async () => {
  const { git } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${REF}..refs/remotes/origin/${BRANCH}`, result: ok('0') },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${BRANCH}..${REF}`, result: ok('0') },
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: ok('.memory/records/2026-09-rec-1.jsonl') },
    { match: (a) => a[0] === 'diff', result: ok('.memory/records/2026-09-rec-1.jsonl') },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs({
    mrList: async () => { throw new Error('gh api pulls failed: rate limited'); },
  });

  await assert.rejects(
    () => shipLane({
      root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
      collect: fakeCollect({ commit: null }), git, vcs,
    }),
    (err) => { assert.equal(err.prLookupFailed, true); assert.equal(err.pushed, false, '#1119: decidePr\'s own lookup always runs before the push'); return true; },
  );
  assert.equal(vcsCalls.mrCreate, 0);
});

test('argv collision (Risk 4): on a pushing, undelivered run both the three-dot and the -- pathspec diff argvs appear, distinct', async () => {
  const { git, calls } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs } = fakeVcs();

  await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  const diffCalls = calls.filter((a) => a[0] === 'diff');
  const threeDot = diffCalls.filter((a) => a[2] === `origin/main...${REF}` && !a.includes('--'));
  const pathspec = diffCalls.filter((a) => a.includes('--'));
  assert.ok(threeDot.length >= 1, 'the three-dot diff argv must appear');
  assert.ok(pathspec.length >= 1, 'the -- pathspec diff argv must appear');
  for (const argv of pathspec) assert.notDeepEqual(argv, threeDot[0], 'the two diff argvs must never be confused');
});

test('surveyDelivery: baseFetched:false short-circuits with zero delivery-diff calls, the run still acts, delivered:null/baseStale', async () => {
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${REF}..refs/remotes/origin/${BRANCH}`, result: ok('0') },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${BRANCH}..${REF}`, result: ok('1') },
    { match: (a) => a[0] === 'diff', result: ok('.memory/records/2026-09-rec-1.jsonl') }, // only buildTitleAndBody may reach this
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  const { vcs } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect({ baseFetched: false }), git, vcs,
  });

  assert.equal(result.pushed, true, 'an unreadable delivery state must never block a pending push');
  assert.equal(result.delivered, null);
  assert.equal(result.deliveredReason, 'baseStale');
  assert.equal(result.reconciled, true);
  const diffCalls = calls.filter((a) => a[0] === 'diff');
  assert.equal(diffCalls.length, 1, 'surveyDelivery must make zero diff calls when baseFetched is false — only buildTitleAndBody\'s own call may run');
});

test('surveyDelivery: the delivery diff exits non-zero ⇒ the run still acts, delivered:null/diffFailed', async () => {
  const { git } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${REF}..refs/remotes/origin/${BRANCH}`, result: ok('0') },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${BRANCH}..${REF}`, result: ok('1') },
    { match: (a) => a[0] === 'diff', result: fail("fatal: ambiguous argument 'origin/main...refs/heads/memory/test-host-2026-09-09': unknown revision or path not in the working tree.") },
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  assert.equal(result.pushed, true);
  assert.equal(result.delivered, null);
  assert.equal(result.deliveredReason, 'diffFailed');
  assert.equal(result.reconciled, true);
  assert.equal(vcsCalls.mrCreate, 1);
});

test('surveyDelivery: the SECOND (-- pathspec) delivery diff exits non-zero while the first succeeds ⇒ delivered:null/diffFailed, the run still reconciles', async () => {
  // Adversarial-review regression pin: mutating ship.mjs's undeliveredDiff
  // failure branch to `delivered: true` must fail THIS test — a false
  // "delivered" on an unreadable second diff would strand the lane's
  // records on origin forever (R5).
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: fail("fatal: ambiguous argument 'refs/heads/memory/test-host-2026-09-09': unknown revision or path not in the working tree.") },
    ...surveyOkRules(),
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  assert.equal(result.pushed, true);
  assert.equal(result.delivered, null);
  assert.equal(result.deliveredReason, 'diffFailed');
  assert.equal(result.reconciled, true, 'a failed second diff must still attempt reconciliation, never skip it');
  assert.equal(vcsCalls.mrCreate, 1);
  const diffCalls = calls.filter((a) => a[0] === 'diff');
  assert.ok(
    diffCalls.some((a) => a[2] === `origin/main...${REF}` && !a.includes('--')),
    'the first (three-dot) diff must have succeeded before the second one failed',
  );
});

test('surveyDelivery: non-empty lanePaths but the -- pathspec diff reports zero undelivered paths ⇒ genuine content containment, delivered:true, zero push/list/create/arm', async () => {
  const { git, calls } = fakeGit([
    ...surveyOkRules({ ahead: '0', undeliveredPaths: [] }),
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect({ commit: null }), git, vcs,
  });

  assert.equal(result.delivered, true);
  assert.equal(result.deliveredReason, null);
  assert.equal(result.pushed, false);
  assert.equal(result.pr, null);
  assert.ok(!calls.some((a) => a[0] === 'push'));
  assert.deepEqual(vcsCalls, { mrList: 0, mrCreate: 0, mrAutoMerge: 0 });
});

test('cold-1 (PR #902 review): a ref that never existed locally is nothing-to-ship with NO diff call and no misleading reason', async () => {
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: fail("fatal: ambiguous argument 'refs/heads/memory/test-host-2026-09-09': unknown revision or path not in the working tree.") },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect({ commit: null }), git, vcs,
  });

  assert.equal(result.pushed, false);
  assert.equal(result.pr, null);
  assert.ok(
    !calls.some((a) => a[0] === 'diff'),
    'a ref that was never created must never be diffed against origin/main — there is nothing to derive a title from',
  );
  // C3 (cold review): design.md's module map declares `title`/`body`
  // unconditional in the outcome shape — `null` here, not an absent key, is
  // how "nothing to derive a title from" is signaled, never a fabricated
  // title/body and never a misleading "could not be fetched" reason for a
  // ref that simply never existed.
  assert.equal(result.title, null, 'nothing-to-ship must carry title:null, not a fabricated title');
  assert.equal(result.body, null, 'nothing-to-ship must carry body:null, not a fabricated body');
  // R2: tip === null is the structural no-op — never surveyed for delivery.
  assert.equal(result.delivered, null);
  assert.equal(result.deliveredReason, 'noRef');
  assert.equal(result.reconciled, false);
  assert.equal(result.closedUnmerged, false, 'a ref that never existed never reaches the D4 lookup either');
});

test("A1 recovery case: commit:null but ahead:1 (a prior push failed) still pushes and opens/arms", async () => {
  const { git, calls } = fakeGit([
    ...surveyOkRules({ ahead: '1' }),
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect({ commit: null }), git, vcs,
  });

  assert.equal(result.pushed, true);
  assert.ok(calls.some((a) => a[0] === 'push'), 'the recovery case must still push');
  assert.equal(vcsCalls.mrCreate, 1);
  assert.equal(vcsCalls.mrAutoMerge, 1);
});

// ── Requirement: the push is a fast-forward, never forced ───────────────────

test('push argv contains --no-verify and never --force or a leading +, on any argv and in no source line', async () => {
  const { git, calls } = fakeGit([
    ...surveyOkRules(),
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  const { vcs } = fakeVcs();

  await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  const pushCall = calls.find((a) => a[0] === 'push');
  assert.ok(pushCall.includes('--no-verify'));
  for (const argv of calls) {
    assert.ok(!argv.includes('--force'), `--force must never appear in any argv: ${JSON.stringify(argv)}`);
    assert.ok(!argv.some((a) => typeof a === 'string' && a.startsWith('+') && a !== '+refs/heads/' + BRANCH + ':refs/remotes/origin/' + BRANCH), `a bare leading + push refspec must never appear: ${JSON.stringify(argv)}`);
  }
  const source = await (await import('node:fs/promises')).readFile(new URL('./ship.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(['"])--force\1/, 'no --force literal may exist in the source at all');
});

test('behind > 0 (diverged) refuses before push: diverged, exit non-zero, zero port calls', async () => {
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${REF}..refs/remotes/origin/${BRANCH}`, result: ok('2') },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${BRANCH}..${REF}`, result: ok('1') },
    // Non-empty: an undelivered lane (delivered:false/null), never true — a
    // delivered lane would short-circuit as a no-op before this divergence
    // check is ever reached (see the decision table's `behind>0` row).
    { match: (a) => a[0] === 'diff', result: ok('.memory/records/2026-09-rec-1.jsonl') },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  await assert.rejects(
    () => shipLane({
      root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
      collect: fakeCollect(), git, vcs,
    }),
    (err) => { assert.equal(err.diverged, true); return true; },
  );

  assert.ok(!calls.some((a) => a[0] === 'push'), 'a pre-detected divergence must never attempt the push');
  assert.deepEqual(vcsCalls, { mrList: 0, mrCreate: 0, mrAutoMerge: 0 });
});

test('a non-fast-forward push refusal (undetected by the pre-check) is classified diverged from stderr', async () => {
  const { git } = fakeGit([
    ...surveyOkRules({ behind: '0' }),
    { match: (a) => a[0] === 'push', result: fail('! [rejected] memory/test-host-2026-09-09 -> memory/test-host-2026-09-09 (non-fast-forward)') },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  await assert.rejects(
    () => shipLane({
      root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
      collect: fakeCollect(), git, vcs,
    }),
    (err) => { assert.equal(err.diverged, true); return true; },
  );
  // D4 (#936): the PR lookup now runs BEFORE the push (it must, to decide
  // whether a push is even allowed), so mrList is 1 here — only mrCreate and
  // mrAutoMerge, which come strictly after a successful push, stay at 0.
  assert.deepEqual(vcsCalls, { mrList: 1, mrCreate: 0, mrAutoMerge: 0 });
});

test('a genuine push failure (not a divergence shape) is classified pushFailed', async () => {
  const { git } = fakeGit([
    ...surveyOkRules(),
    { match: (a) => a[0] === 'push', result: fail('fatal: unable to access origin: Could not resolve host') },
  ]);
  const { vcs } = fakeVcs();

  await assert.rejects(
    () => shipLane({
      root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
      collect: fakeCollect(), git, vcs,
    }),
    (err) => { assert.equal(err.pushFailed, true); assert.notEqual(err.diverged, true); return true; },
  );
});

// ── Requirement: PR lookup and creation are idempotent ───────────────────────

test('PR already open by headBranch wins over a newer closed PR: mrCreate never called, mrAutoMerge still called', async () => {
  const { git } = fakeGit([
    ...surveyOkRules(),
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  let mrListArgs;
  const { vcs, calls: vcsCalls } = fakeVcs({
    mrList: async (args) => {
      vcsCalls.mrList++;
      mrListArgs = args;
      // D4: an open item must win even though a higher-numbered closed item
      // for the same branch also exists — "open wins" is checked BEFORE
      // "highest-numbered decides".
      return [
        { number: 7, title: 't', headBranch: BRANCH, state: 'open', merged: false },
        { number: 9, title: 't', headBranch: BRANCH, state: 'closed', merged: false },
      ];
    },
  });

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  assert.equal(vcsCalls.mrCreate, 0);
  assert.equal(vcsCalls.mrAutoMerge, 1);
  assert.equal(result.pr.number, 7);
  assert.equal(result.closedUnmerged, false);
  // D4 (#936): the lookup now queries ALL states (open wins, else the
  // highest-numbered item decides) and is bound to this exact branch via the
  // D2 `headBranch` filter — never a repo-wide `state: 'open'` list, which
  // could never see a closed-unmerged PR to begin with.
  assert.deepEqual(mrListArgs, { project: 'x/y', state: 'all', headBranch: BRANCH });
});

// ── Requirement: #920's R8 is reversed (D4) — closed-unmerged is reported, never reopened ──

test('D4: a foreign branch\'s PR is filtered out before "newest" is picked, so an unrelated closed-unmerged PR never blocks a fresh create', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs, calls: vcsCalls } = fakeVcs({
    mrList: async () => [{ number: 99, title: 't', headBranch: 'memory/some-other-host-2026-09-08', state: 'closed', merged: false }],
  });

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  assert.equal(vcsCalls.mrCreate, 1, 'an unrelated branch\'s closed-unmerged PR must never suppress this branch\'s own create');
  assert.equal(result.closedUnmerged, false);
  assert.equal(result.pr.number, 42);
});

test('D4: no open PR, highest-numbered match is closed-unmerged ⇒ closedUnmerged:true, zero push/create/arm calls, PR reported', async () => {
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${REF}..refs/remotes/origin/${BRANCH}`, result: ok('0') },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${BRANCH}..${REF}`, result: ok('1') },
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: ok('.memory/records/2026-09-rec-1.jsonl') },
    { match: (a) => a[0] === 'diff', result: ok('.memory/records/2026-09-rec-1.jsonl') },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs({
    // Lower-numbered closed+merged, higher-numbered closed-unmerged — the
    // HIGHEST number must decide, per D4's "newest wins" rule, and it is
    // closed-unmerged here.
    mrList: async () => {
      vcsCalls.mrList++;
      return [
        { number: 3, title: 't', headBranch: BRANCH, state: 'closed', merged: true },
        { number: 11, title: 't', headBranch: BRANCH, state: 'closed', merged: false },
      ];
    },
  });

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  assert.equal(result.closedUnmerged, true);
  assert.equal(result.pr.number, 11);
  assert.equal(result.pushed, false, 'a branch whose only current PR is closed-unmerged must never be re-shipped (a push here would be indistinguishable from re-opening it)');
  assert.equal(result.reconciled, false);
  assert.equal(result.autoMerge, null);
  assert.deepEqual(vcsCalls, { mrList: 1, mrCreate: 0, mrAutoMerge: 0 });
  assert.ok(!calls.some((a) => a[0] === 'push'), 'D4 forbids the push entirely once the newest PR is closed-unmerged, regardless of pending content');
});

test('D4: no open PR, highest-numbered match is closed+merged ⇒ creates a fresh PR (pre-#936 [closed, merged] histories heal)', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs, calls: vcsCalls } = fakeVcs({
    mrList: async () => [{ number: 5, title: 't', headBranch: BRANCH, state: 'closed', merged: true }],
  });

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  assert.equal(result.closedUnmerged, false);
  assert.equal(vcsCalls.mrCreate, 1);
  assert.equal(result.pr.number, 42);
});

test('D4: the highest-numbered match\'s state/merged is null (uncomputable) ⇒ prLookupFailed, zero push/create calls', async () => {
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${REF}..refs/remotes/origin/${BRANCH}`, result: ok('0') },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${BRANCH}..${REF}`, result: ok('1') },
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: ok('.memory/records/2026-09-rec-1.jsonl') },
    { match: (a) => a[0] === 'diff', result: ok('.memory/records/2026-09-rec-1.jsonl') },
  ]);
  const { vcs, calls: vcsCalls } = fakeVcs({
    mrList: async () => [{ number: 4, title: 't', headBranch: BRANCH, state: null, merged: null }],
  });

  await assert.rejects(
    () => shipLane({
      root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
      collect: fakeCollect(), git, vcs,
    }),
    (err) => { assert.equal(err.prLookupFailed, true); assert.equal(err.pushed, false, '#1119: decidePr\'s own lookup always runs before the push'); return true; },
  );
  assert.equal(vcsCalls.mrCreate, 0);
  assert.ok(!calls.some((a) => a[0] === 'push'), 'an uncomputable PR state must fail closed before any push');
});

test('mrCreate returning {url:null, error} is fatal: prCreateFailed, mrAutoMerge never called', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs, calls: vcsCalls } = fakeVcs({
    mrCreate: async () => { vcsCalls.mrCreate++; return { url: null, error: 'gh: already exists' }; },
  });

  await assert.rejects(
    () => shipLane({
      root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
      collect: fakeCollect(), git, vcs,
    }),
    (err) => { assert.equal(err.prCreateFailed, true); return true; },
  );
  assert.equal(vcsCalls.mrAutoMerge, 0);
});

// ── Requirement: PR grammar and target ───────────────────────────────────────

test("title/body match the ticket's grammar byte for byte, Records: n from the three-dot diff, base main, labels []", async () => {
  const { git } = fakeGit([
    ...surveyOkRules({ diffPaths: ['.memory/records/2026-09-rec-2222222222222222.jsonl', '.memory/records/2026-09-rec-1111111111111111.jsonl'] }),
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  let createArgs;
  const { vcs } = fakeVcs({
    mrCreate: async (args) => { createArgs = args; return { url: 'https://example.invalid/pull/42' }; },
  });

  await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  assert.equal(createArgs.title, 'memory: test-host 2026-09-09 (2 records)');
  const bodyLines = createArgs.body.split('\n');
  assert.equal(bodyLines[0], 'Memory lane: test-host 2026-09-09');
  assert.equal(bodyLines[1], 'Records: 2');
  assert.deepEqual(bodyLines.slice(2).filter(Boolean).sort(), [
    '- .memory/records/2026-09-rec-1111111111111111.jsonl',
    '- .memory/records/2026-09-rec-2222222222222222.jsonl',
  ]);
  assert.doesNotMatch(createArgs.body, /Closes #|closes #/i, 'no closing keyword may appear');
  assert.equal(createArgs.base, 'main');
  assert.deepEqual(createArgs.labels, []);
});

test('C: a non-zero diff exit (origin/main unfetchable) reports the count as unknown, never 0', async () => {
  const { git } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${REF}..refs/remotes/origin/${BRANCH}`, result: ok('0') },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${BRANCH}..${REF}`, result: ok('1') },
    { match: (a) => a[0] === 'diff', result: fail("fatal: ambiguous argument 'origin/main...refs/heads/memory/test-host-2026-09-09': unknown revision or path not in the working tree.") },
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  let createArgs;
  const { vcs } = fakeVcs({ mrCreate: async (args) => { createArgs = args; return { url: 'https://example.invalid/pull/42' }; } });

  await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect({ baseFetched: false }), git, vcs,
  });

  assert.equal(createArgs.title, 'memory: test-host 2026-09-09 (records: unknown)');
  assert.doesNotMatch(createArgs.title, /\(0 records\)/, 'a missing base must never be reported as zero records');
  const bodyLines = createArgs.body.split('\n');
  assert.equal(bodyLines[0], 'Memory lane: test-host 2026-09-09');
  assert.match(bodyLines[1], /could not be fetched/i, 'the body must say the base could not be fetched, not claim zero records');
});

test('A4: title/body are parsed from the branch, not the raw host param — a host needing slugification', async () => {
  const slugRef = 'refs/heads/memory/my-host-lab-2026-09-09';
  const slugBranch = 'memory/my-host-lab-2026-09-09';
  const { git } = fakeGit([
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
    { match: (a) => a[0] === 'fetch', result: ok() },
    { match: (a) => a[0] === 'rev-list' && a[2] === `${slugRef}..refs/remotes/origin/${slugBranch}`, result: ok('0') },
    { match: (a) => a[0] === 'rev-list' && a[2] === `refs/remotes/origin/${slugBranch}..${slugRef}`, result: ok('1') },
    { match: (a) => a[0] === 'diff', result: ok('.memory/records/2026-09-rec-1.jsonl') },
    { match: (a) => a[0] === 'push', result: ok() },
  ]);
  let createArgs;
  const { vcs } = fakeVcs({ mrCreate: async (args) => { createArgs = args; return { url: 'https://example.invalid/pull/1' }; } });

  await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'My.Host.Lab', date: '2026-09-09',
    collect: fakeCollect({ ref: slugRef }), git, vcs,
  });

  assert.equal(createArgs.title, 'memory: my-host-lab 2026-09-09 (1 records)');
  assert.match(createArgs.body, /^Memory lane: my-host-lab 2026-09-09\n/);
});

// ── Requirement: the PR number is derived, never guessed ────────────────────

test('the number parses from a github-shaped URL', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  let armArgs;
  const { vcs } = fakeVcs({
    mrCreate: async () => ({ url: 'https://github.invalid/x/y/pull/123' }),
    mrAutoMerge: async (args) => { armArgs = args; return { enabled: true, url: null }; },
  });

  await shipLane({ root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs });
  assert.equal(armArgs.number, 123);
});

test('the number parses from a gitlab-shaped URL', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  let armArgs;
  const { vcs } = fakeVcs({
    mrCreate: async () => ({ url: 'https://gitlab.invalid/x/y/-/merge_requests/12' }),
    mrAutoMerge: async (args) => { armArgs = args; return { enabled: true, url: null }; },
  });

  await shipLane({ root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs });
  assert.equal(armArgs.number, 12);
});

test('an unparseable URL triggers exactly one mrList re-scan and recovers the number', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  let mrListCalls = 0;
  let armArgs;
  const { vcs } = fakeVcs({
    mrList: async () => {
      mrListCalls++;
      return mrListCalls === 1 ? [] : [{ number: 9, title: 't', headBranch: BRANCH, state: 'open', merged: false }];
    },
    mrCreate: async () => ({ url: 'https://example.invalid/unparseable' }),
    mrAutoMerge: async (args) => { armArgs = args; return { enabled: true, url: null }; },
  });

  await shipLane({ root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs });
  assert.equal(mrListCalls, 2, 'exactly one re-scan beyond the original find-or-create lookup');
  assert.equal(armArgs.number, 9);
});

test('E2: a non-PR URL whose last path segment merely ends in a digit is never mistaken for a PR number', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  let mrListCalls = 0;
  const { vcs } = fakeVcs({
    mrList: async () => { mrListCalls++; return []; },
    mrCreate: async () => ({ url: 'https://host/g/p2' }),
  });

  const result = await shipLane({ root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs });
  assert.equal(mrListCalls, 2, 'a non-PR-shaped URL must trigger the one-shot re-scan, not a false parse');
  assert.equal(result.pr.number, null);
  assert.equal(result.autoMerge, null);
});

test('E2: a pull URL with a query string or fragment still parses to the PR number', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  let armArgs;
  const { vcs } = fakeVcs({
    mrCreate: async () => ({ url: 'https://github.invalid/x/y/pull/123?tab=files#issuecomment-1' }),
    mrAutoMerge: async (args) => { armArgs = args; return { enabled: true, url: null }; },
  });

  await shipLane({ root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs });
  assert.equal(armArgs.number, 123);
});

test('both derivations failing: pr.number is null, mrAutoMerge never called, run still exits 0 (non-fatal, self-heals)', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs, calls: vcsCalls } = fakeVcs({
    mrCreate: async () => { vcsCalls.mrCreate++; return { url: 'https://example.invalid/unparseable' }; },
  });

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs,
  });

  assert.equal(result.pr.number, null);
  assert.equal(result.autoMerge, null);
  assert.equal(vcsCalls.mrAutoMerge, 0);
});

// ── Requirement: tier-gated arm, refusals are never fatal ───────────────────

test('requiredReviews:0 (lite) arms auto-merge', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  let armArgs;
  const { vcs } = fakeVcs({ mrAutoMerge: async (args) => { armArgs = args; return { enabled: true, url: null }; } });

  const result = await shipLane({ root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs });
  assert.equal(armArgs.requiredReviews, 0);
  assert.equal(result.autoMerge.enabled, true);
});

test('requiredReviews:1 (standard): refusal is reported in autoMerge.reason, run still exits 0, PR stays open', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs } = fakeVcs({ mrAutoMerge: async () => ({ enabled: false, reason: 'requires-human-approval' }) });

  const result = await shipLane({ root: '/repo', project: 'x/y', tier: 'standard', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs });
  assert.equal(result.autoMerge.enabled, false);
  assert.equal(result.autoMerge.reason, 'requires-human-approval');
  assert.equal(result.pr.number, 42);
});

for (const reason of ['requires-human-approval', 'unsupported', 'transport']) {
  test(`every mrAutoMerge refusal reason ("${reason}") is non-fatal`, async () => {
    const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
    const { vcs } = fakeVcs({ mrAutoMerge: async () => ({ enabled: false, reason }) });

    const result = await shipLane({ root: '/repo', project: 'x/y', tier: 'standard', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs });
    assert.equal(result.autoMerge.reason, reason);
  });
}

test('E2 (cold review): a throwing mrAutoMerge is mapped to a non-fatal refusal, never propagates — the push and PR already landed', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs } = fakeVcs({
    mrAutoMerge: async () => { throw new Error('gh api pulls/42/merge failed: 503 Service Unavailable'); },
  });

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });

  assert.equal(result.pushed, true);
  assert.equal(result.pr.number, 42);
  assert.equal(result.autoMerge.enabled, false);
  assert.match(result.autoMerge.reason, /503 Service Unavailable/);
});

// ── Requirement: mrList throwing is the one fatal port failure ──────────────

test('mrList throwing is fatal: exit non-zero, mrCreate never called, and — D4 — the lookup now runs before push, so push never happens either', async () => {
  const { git, calls } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs, calls: vcsCalls } = fakeVcs({
    mrList: async () => { throw new Error('gh api pulls failed: rate limited'); },
  });

  await assert.rejects(
    () => shipLane({ root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs }),
    (err) => { assert.equal(err.prLookupFailed, true); assert.equal(err.pushed, false, '#1119: decidePr\'s own lookup always runs before the push'); return true; },
  );
  assert.equal(vcsCalls.mrCreate, 0);
  assert.ok(!calls.some((a) => a[0] === 'push'), 'D4 moves the PR lookup before the push — a lookup failure must never let a push through first');
});

test('#1119: unlike decidePr\'s own lookup, createPr\'s one-shot re-scan only ever runs AFTER the push — a failure there is tagged pushed:true', async () => {
  const { git, calls } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  let mrListCalls = 0;
  const { vcs, calls: vcsCalls } = fakeVcs({
    mrList: async () => {
      mrListCalls++;
      // Call 1 is decidePr()'s own lookup (state:'all', pre-push) — an empty
      // list picks action:'create', which reaches the push step and then
      // createPr(). Call 2 is createPr()'s one-shot re-scan (state:'open',
      // triggered below by an unparseable mrCreate URL) — THIS is the one
      // that fails, strictly after the push above already ran.
      if (mrListCalls === 1) return [];
      throw new Error('gh api pulls failed: rate limited');
    },
    mrCreate: async () => { vcsCalls.mrCreate++; return { url: 'https://example.invalid/unparseable' }; },
  });

  await assert.rejects(
    () => shipLane({ root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', collect: fakeCollect(), git, vcs }),
    (err) => {
      assert.equal(err.prLookupFailed, true);
      assert.equal(err.pushed, true, '#1119: the push rule above already ran by the time createPr\'s re-scan is reached');
      return true;
    },
  );
  assert.equal(mrListCalls, 2, 'the failure must be the re-scan (call 2), not the initial decidePr lookup (call 1)');
  assert.equal(vcsCalls.mrCreate, 1, 'mrCreate must have run before the re-scan — proving the push already happened too');
  assert.ok(calls.some((a) => a[0] === 'push'), 'the push must have actually run before this failure, unlike the decidePr case above');
});

// ── Requirement: credential threading ────────────────────────────────────────

test('token present: every vcs.* call runs bound (the injected vcs spy is used for every call)', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs, calls: vcsCalls } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    identityBound: true, collect: fakeCollect(), git, vcs,
  });

  assert.equal(result.identityBound, true);
  assert.equal(vcsCalls.mrList, 1);
  assert.equal(vcsCalls.mrCreate, 1);
  assert.equal(vcsCalls.mrAutoMerge, 1);
});

test('token absent: identityBound is false, no ambient-credential assertion at this layer', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs } = fakeVcs();

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    collect: fakeCollect(), git, vcs,
  });
  assert.equal(result.identityBound, false);
});

// ── Requirement: --dry-run performs collect's plan only ─────────────────────

test('--dry-run: vcs is null and a git fake that throws on push/fetch still lets the run complete, pushed:false, pr:null', async () => {
  const throwingGit = (argv) => {
    if (argv[0] === 'push' || argv[0] === 'fetch') throw new Error(`must not call ${argv[0]} under --dry-run`);
    if (argv[0] === 'diff') return ok('.memory/records/2026-09-rec-1.jsonl');
    throw new Error(`unexpected argv under --dry-run: ${JSON.stringify(argv)}`);
  };

  const result = await shipLane({
    root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
    dryRun: true, collect: fakeCollect(), git: throwingGit, vcs: null,
  });

  assert.equal(result.pushed, false);
  assert.equal(result.pr, null);
  assert.equal(result.dryRun, true);
  assert.equal(result.autoMerge, null);
  // R12: shape uniformity only — dry-run never surveys delivery.
  assert.equal(result.delivered, null);
  assert.equal(result.deliveredReason, 'dryRun');
  assert.equal(result.reconciled, false);
  assert.equal(result.closedUnmerged, false, '--dry-run never reaches the D4 lookup (vcs:null)');
});

// ── Requirement: no credential value ever appears in the returned shape ─────

test('the result object, JSON-stringified, contains no value of BRAIN_MEMORY_TOKEN under either credential path', async () => {
  const { git } = fakeGit([...surveyOkRules(), { match: (a) => a[0] === 'push', result: ok() }]);
  const { vcs } = fakeVcs();

  for (const identityBound of [true, false]) {
    const result = await shipLane({
      root: '/repo', project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09',
      identityBound, collect: fakeCollect(), git, vcs,
    });
    const dump = JSON.stringify(result);
    assert.doesNotMatch(dump, /BRAIN_MEMORY_TOKEN|sekrit-token-value/, 'no credential value may ever appear in the returned shape');
    assert.equal(typeof result.identityBound, 'boolean');
  }
});
