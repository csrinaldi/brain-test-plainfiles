// memory-gate.parity.test.mjs — issue #1188: the post-merge audit and the PR-time
// memory-gate evaluate ONE predicate. The audit used to call `memoryPresence`
// (repo-wide, tier-blind) while the gate ran issue-scoped retrieval with
// lite-as-detection; the same merge got two verdicts, and the disagreement
// surfaced as `governance:audit-unrevertible` on a fresh consumer's first merge.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main as gateMain } from '../run-check.mjs';
import { evaluateMerge } from '../../lib/merge-walk.mjs';
import { evaluateMemoryGate } from './memory-gate.mjs';

const summary = (issue, id = `r-${issue}`) => ({ id, type: 'session_summary', issue });
const note = (issue, id = `n-${issue}`) => ({ id, type: 'decision', issue });

const CASES = [
  { name: 'scoped session_summary in the tree', tree: [summary(7)], main: [] },
  { name: 'scoped session_summary on main via the lane', tree: [], main: [summary(7)], history: true },
  { name: 'records exist but none scoped to the issue', tree: [summary(3)], main: [] },
  { name: 'scoped non-summary record (partial coverage)', tree: [note(7)], main: [] },
];
const TIERS = ['lite', 'standard', 'regulated'];
const BODY = 'Closes #7';

async function gateVerdict(tier, tree, main) {
  const realLog = console.log;
  console.log = () => {};
  try {
    const code = await gateMain('memory-gate', {
      ctx: { prNumber: 5, body: BODY, targetBranch: 'main', defaultBranch: 'main', labels: [] },
      cwd: '/nonexistent',
      readRecords: () => tree,
      readConfig: () => ({ governance: { tier } }),
      readDefaultBranchRecords: () => ({ records: main, error: null, fetched: false }),
    });
    return code === 0;
  } finally {
    console.log = realLog;
  }
}

function auditVerdict(tier, tree, main) {
  const union = [...tree, ...main];
  const rec = evaluateMerge('deadbeef', {
    numstat: '', changedFiles: [], addedFiles: [], issueLinkBody: BODY, prLabels: [],
    ignoreList: [], allObservations: union, resolutionGit: null, windowFrom: 'a', windowTo: 'b',
    tier, prNum: 5,
  });
  return rec.results.memoryPresence.pass;
}

for (const tier of TIERS) {
  for (const c of CASES) {
    test(`parity @${tier}: ${c.name} — audit verdict equals the memory-gate exit`, async () => {
      assert.equal(auditVerdict(tier, c.tree, c.main), await gateVerdict(tier, c.tree, c.main));
    });
  }
}

test('parity: lite is detection-only — a scoped miss is a pass with a ::warning:: in BOTH', async () => {
  assert.equal(auditVerdict('lite', [summary(3)], []), true);
  assert.equal(await gateVerdict('lite', [summary(3)], []), true);
  const r = evaluateMemoryGate(
    { prNumber: 5, body: BODY, targetBranch: 'main', defaultBranch: 'main' },
    [summary(3)],
    { readDefaultBranchRecords: () => ({ records: [], error: null, fetched: false }) },
    'lite',
  );
  assert.equal(r.pass, false, 'the raw predicate still reports the miss; the tier softens it');
});

test('audit early merge: zero memory history is an abstention, never a failure, at any tier', () => {
  for (const tier of TIERS) {
    const rec = evaluateMerge('deadbeef', {
      numstat: '', changedFiles: [], addedFiles: [], issueLinkBody: BODY, prLabels: [],
      ignoreList: [], allObservations: [], resolutionGit: null, windowFrom: 'a', windowTo: 'b', tier,
    });
    assert.equal(rec.results.memoryPresence.pass, true, tier);
    assert.match(rec.results.memoryPresence.note, /no memory history/, tier);
  }
});

test('audit: once any record exists the predicate applies in full (a scoped miss at standard still fails)', () => {
  assert.equal(auditVerdict('standard', [summary(3)], []), false);
});
