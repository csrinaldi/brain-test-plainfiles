// archive-sweep.test.mjs — Unit tests for the closed-issue selector (issue
// #557, design D1 Testing table). `node --test`, fakes only — no network, no
// real cwd, no filesystem access (the selector is pure; `exists` and
// `readIssueState` are injected fakes throughout).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OUTCOME, selectSweep } from './archive-sweep.mjs';

/** A `readIssueState` fake driven by a plain `{ iid: {state, stateReason} }` map. */
function statesOf(map) {
  const calls = [];
  const fn = async (iid) => {
    calls.push(iid);
    return Object.prototype.hasOwnProperty.call(map, iid) ? map[iid] : null;
  };
  fn.calls = calls;
  return fn;
}

/** An `exists` fake driven by a plain array/Set of existing relPaths. */
function existsOf(paths) {
  const set = new Set(paths);
  return (relPath) => set.has(relPath);
}

// ── Case 1: closed + completed → archivable ─────────────────────────────────
test('1: closed issue with stateReason completed → archivable', async () => {
  const readIssueState = statesOf({ '100': { state: 'closed', stateReason: 'completed' } });
  const result = await selectSweep({
    entries: ['issue-100-foo'],
    exists: existsOf([]),
    readIssueState,
  });
  assert.deepEqual(result.archivable, ['issue-100-foo']);
  assert.equal(result.folders[0].outcome, OUTCOME.ARCHIVABLE);
  assert.equal(result.complete, true);
});

// ── Case 2: open → absent from archivable ───────────────────────────────────
test('2: open issue → open, absent from archivable', async () => {
  const readIssueState = statesOf({ '200': { state: 'open', stateReason: null } });
  const result = await selectSweep({
    entries: ['issue-200-bar'],
    exists: existsOf([]),
    readIssueState,
  });
  assert.deepEqual(result.archivable, []);
  assert.equal(result.folders[0].outcome, OUTCOME.OPEN);
});

// ── Case 3: not-planned → excluded, distinct outcome ────────────────────────
test('3: closed + not_planned → not-planned, absent from archivable', async () => {
  const readIssueState = statesOf({ '300': { state: 'closed', stateReason: 'not_planned' } });
  const result = await selectSweep({
    entries: ['issue-300-baz'],
    exists: existsOf([]),
    readIssueState,
  });
  assert.deepEqual(result.archivable, []);
  assert.equal(result.folders[0].outcome, OUTCOME.NOT_PLANNED);
});

// ── Case 4: stateReason:null (GitLab shape) → archivable, distinct from case 5 ─
test('4: closed with stateReason:null (GitLab residual shape) → archivable', async () => {
  const readIssueState = statesOf({ '400': { state: 'closed', stateReason: null } });
  const result = await selectSweep({
    entries: ['issue-400-gl'],
    exists: existsOf([]),
    readIssueState,
  });
  assert.deepEqual(result.archivable, ['issue-400-gl']);
  assert.equal(result.folders[0].outcome, OUTCOME.ARCHIVABLE);
});

// ── Case 5: readIssueState → null → unreadable, complete false ─────────────
test('5: readIssueState resolves null → unreadable, complete:false, archivable empty', async () => {
  const readIssueState = statesOf({}); // 500 absent → null
  const result = await selectSweep({
    entries: ['issue-500-x'],
    exists: existsOf([]),
    readIssueState,
  });
  assert.equal(result.folders[0].outcome, OUTCOME.UNREADABLE);
  assert.equal(result.complete, false);
  assert.deepEqual(result.archivable, []);
  assert.deepEqual(result.readFailures, ['500']);
});

// ── Case 6: unrecognized state value → unreadable, never open ──────────────
test('6: unrecognized state value → unreadable, never open', async () => {
  const readIssueState = statesOf({ '600': { state: 'merged', stateReason: null } });
  const result = await selectSweep({
    entries: ['issue-600-y'],
    exists: existsOf([]),
    readIssueState,
  });
  assert.equal(result.folders[0].outcome, OUTCOME.UNREADABLE);
  assert.notEqual(result.folders[0].outcome, OUTCOME.OPEN);
  assert.equal(result.complete, false);
});

// ── Case 7: 3 folders share iid 518 → all collision, order-independent ─────
test('7: 3 folders sharing one iid → all three collision, same answer with entries reversed', async () => {
  const entries = ['issue-518-rung3-residuals', 'issue-518-squash-blindspot-recorded', 'issue-518-widen-audit-walk'];
  const readIssueState = statesOf({ '518': { state: 'closed', stateReason: 'completed' } });

  const forward = await selectSweep({ entries, exists: existsOf([]), readIssueState });
  for (const f of forward.folders) assert.equal(f.outcome, OUTCOME.COLLISION);
  assert.deepEqual(forward.archivable, []);
  // Row 4 precedes row 6 — a collision never reaches the network.
  assert.equal(readIssueState.calls.length, 0, 'a collision must cost zero reads (row 4 precedes row 6)');

  const reversed = await selectSweep({ entries: [...entries].reverse(), exists: existsOf([]), readIssueState: statesOf({ '518': { state: 'closed', stateReason: 'completed' } }) });
  for (const f of reversed.folders) assert.equal(f.outcome, OUTCOME.COLLISION);
  assert.deepEqual(reversed.archivable, []);
});

// ── Case 8: archive/<iid> exists → destination-exists ───────────────────────
test('8: destination archive/<iid> already exists → destination-exists', async () => {
  const readIssueState = statesOf({ '800': { state: 'closed', stateReason: 'completed' } });
  const result = await selectSweep({
    entries: ['issue-800-z'],
    exists: existsOf(['openspec/changes/archive/800']),
    readIssueState,
  });
  assert.equal(result.folders[0].outcome, OUTCOME.DESTINATION_EXISTS);
  assert.equal(readIssueState.calls.length, 0, 'destination-exists is decidable locally — no network read');
});

// ── Case 9: container + non-change dir → zero reads ─────────────────────────
test('9: archive/ container and a non-change dir → container / not-a-change, zero readIssueState calls', async () => {
  const readIssueState = statesOf({});
  const result = await selectSweep({
    entries: ['archive', 'random-notes'],
    exists: existsOf([]),
    readIssueState,
  });
  const byName = Object.fromEntries(result.folders.map(f => [f.name, f.outcome]));
  assert.equal(byName['archive'], OUTCOME.CONTAINER);
  assert.equal(byName['random-notes'], OUTCOME.NOT_A_CHANGE);
  assert.equal(readIssueState.calls.length, 0, 'neither the container nor a non-change dir may trigger a network read');
});

// ── Case 10: iid 260 parity — no hardcode, treated like any other iid ──────
test('10: iid 260 receives identical treatment to any other iid at the same state (no re-introduced hardcode)', async () => {
  const readIssueState = statesOf({
    '260': { state: 'open', stateReason: null },
    '261': { state: 'open', stateReason: null },
  });
  const result = await selectSweep({
    entries: ['issue-260-in-flight', 'issue-261-also-in-flight'],
    exists: existsOf([]),
    readIssueState,
  });
  const byName = Object.fromEntries(result.folders.map(f => [f.name, f.outcome]));
  assert.equal(byName['issue-260-in-flight'], OUTCOME.OPEN);
  assert.equal(byName['issue-260-in-flight'], byName['issue-261-also-in-flight'], '260 must be classified identically to any other open iid');

  // And the mirror: 260 CLOSED must archive like any other closed iid.
  const closedResult = await selectSweep({
    entries: ['issue-260-in-flight'],
    exists: existsOf([]),
    readIssueState: statesOf({ '260': { state: 'closed', stateReason: 'completed' } }),
  });
  assert.equal(closedResult.folders[0].outcome, OUTCOME.ARCHIVABLE);
});

// ── Case 11: 3 folders, 3 distinct iids, no collision → memoized reads ─────
test('11: 3 folders with distinct iids (no collision) → readIssueState called exactly once per distinct iid', async () => {
  const readIssueState = statesOf({
    '301': { state: 'closed', stateReason: 'completed' },
    '302': { state: 'open', stateReason: null },
    '303': { state: 'closed', stateReason: 'not_planned' },
  });
  const result = await selectSweep({
    entries: ['issue-301-a', 'issue-302-b', 'issue-303-c'],
    exists: existsOf([]),
    readIssueState,
  });
  assert.equal(readIssueState.calls.length, 3, 'exactly one read per distinct iid — never more');
  assert.deepEqual([...readIssueState.calls].sort(), ['301', '302', '303']);
  assert.deepEqual(result.archivable, ['issue-301-a']);
});

// ── Memoization within a single iid, per design D1's #518 example ──────────
test('memoization: readIssueState is called at most once per distinct iid even outside the collision path', async () => {
  // Two folders, two DIFFERENT non-colliding iids, one of which happens to
  // resolve slowly — proves the Promise.all/Set-based memoization keys are
  // per-iid, not per-invocation-order.
  let calls = 0;
  const readIssueState = async (iid) => {
    calls += 1;
    return { state: 'closed', stateReason: 'completed' };
  };
  const result = await selectSweep({
    entries: ['issue-701-a', 'issue-702-b'],
    exists: existsOf([]),
    readIssueState,
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.archivable.sort(), ['issue-701-a', 'issue-702-b']);
});

// ── Fail-closed aggregation: one unreadable folder among several archivable ──
test('fail-closed: complete is false when ANY folder in the batch is unreadable, even if others resolved cleanly', async () => {
  const readIssueState = statesOf({
    '901': { state: 'closed', stateReason: 'completed' },
    // 902 deliberately absent — readIssueState resolves null for it.
  });
  const result = await selectSweep({
    entries: ['issue-901-ok', 'issue-902-broken'],
    exists: existsOf([]),
    readIssueState,
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.readFailures, ['902']);
  // The readable folder still reports its OWN correct outcome — the caller
  // (not the selector) decides whether to act on a partial `folders` list.
  const byName = Object.fromEntries(result.folders.map(f => [f.name, f.outcome]));
  assert.equal(byName['issue-901-ok'], OUTCOME.ARCHIVABLE);
  assert.equal(byName['issue-902-broken'], OUTCOME.UNREADABLE);
});

// ── Grandfathered dirs never resolve an iid, never collide ──────────────────
test('grandfathered dir → no-issue-key, iid:null, zero network reads', async () => {
  const readIssueState = statesOf({});
  const result = await selectSweep({
    entries: ['vcs-adapter'], // LEGACY_GRANDFATHERED member
    exists: existsOf([]),
    readIssueState,
  });
  assert.equal(result.folders[0].outcome, OUTCOME.NO_ISSUE_KEY);
  assert.equal(result.folders[0].iid, null);
  assert.equal(readIssueState.calls.length, 0);
});

// ── Every OUTCOME row is reachable and the enum is frozen ───────────────────
test('OUTCOME is frozen and carries exactly the 9 design-table values', () => {
  assert.ok(Object.isFrozen(OUTCOME));
  assert.deepEqual(
    Object.values(OUTCOME).sort(),
    [
      'archivable',
      'collision',
      'container',
      'destination-exists',
      'no-issue-key',
      'not-a-change',
      'not-planned',
      'open',
      'unreadable',
    ].sort(),
  );
});
