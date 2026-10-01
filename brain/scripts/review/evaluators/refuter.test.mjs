// refuter.test.mjs — Unit tests for Refuter Role Evaluator (REQ-H2-1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRefuter } from './refuter.mjs';

test('evaluateRefuter: returns corroborated when claim is valid', async () => {
  const finding = {
    id: 'R3-001',
    severity: 'blocker',
    evidence_class: 'inferential',
    causal_disposition: 'introduced',
    claim: 'Uncaught promise rejection in cold-boot.mjs',
    evidence: 'git diff inspection',
    cites: 'cold-boot.mjs:42',
  };

  // Mock runner returning corroborated
  const mockRunner = async () => ({
    outcomes: [{ id: 'R3-001', outcome: 'corroborated', rationale: 'Verified missing catch handler' }],
  });

  const result = await evaluateRefuter({ findings: [finding], runner: mockRunner });
  assert.equal(result.outcomes[0].outcome, 'corroborated');
  assert.equal(result.refutedCount, 0);
});

test('evaluateRefuter: refuted outcome marks finding as refuted and non-blocking', async () => {
  const finding = {
    id: 'R3-001',
    severity: 'blocker',
    evidence_class: 'inferential',
    causal_disposition: 'introduced',
    claim: 'Alleged unhandled mutex unlock',
    evidence: 'git diff inspection',
    cites: 'cold-boot.mjs:42',
  };

  const mockRunner = async () => ({
    outcomes: [{ id: 'R3-001', outcome: 'refuted', rationale: 'defer mu.Unlock() is present at line 20' }],
  });

  const result = await evaluateRefuter({ findings: [finding], runner: mockRunner });
  assert.equal(result.outcomes[0].outcome, 'refuted');
  assert.equal(result.refutedCount, 1);
  assert.equal(result.adjustedFindings[0].refuted, true);
});

test('evaluateRefuter: inconclusive outcome forces escalate: human', async () => {
  const finding = {
    id: 'R3-001',
    severity: 'blocker',
    evidence_class: 'inferential',
    causal_disposition: 'introduced',
    claim: 'Ambiguous race condition in async queue',
    evidence: 'git diff inspection',
    cites: 'queue.mjs:10',
  };

  const mockRunner = async () => ({
    outcomes: [{ id: 'R3-001', outcome: 'inconclusive', rationale: 'Cannot determine execution ordering without trace' }],
  });

  const result = await evaluateRefuter({ findings: [finding], runner: mockRunner });
  assert.equal(result.escalate, 'human');
});

test('evaluateRefuter: skips non-inferential or non-blocker findings (lazy execution)', async () => {
  const deterministicFinding = {
    id: 'R3-001',
    severity: 'blocker',
    evidence_class: 'deterministic',
    causal_disposition: 'introduced',
    claim: 'Failing unit test',
    evidence: 'npm test output',
    cites: 'test.mjs:1',
  };

  let runnerCalled = false;
  const mockRunner = async () => {
    runnerCalled = true;
    return { outcomes: [] };
  };

  const result = await evaluateRefuter({ findings: [deterministicFinding], runner: mockRunner });
  assert.equal(runnerCalled, false);
  assert.equal(result.refutedCount, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// #552 — the fail-open the ruling turns on
//
// `cli.mjs` passes `runner: deps.refuterRunner ?? null` and `refuterRunner` is a
// test-side injection, so PRODUCTION always runs with `runner === null`. Before
// this, that state and "there was nothing to challenge" were the same return.
// ═══════════════════════════════════════════════════════════════════════════

const inferentialBlocker = (id = 'design:coupling') => ({
  id,
  severity: 'blocker',
  evidence_class: 'inferential',
  causal_disposition: 'introduced',
  evidence: 'x reaches into y',
});

test('#552: inferential blockers with NO runner are marked unchallenged and escalate — not silently passed', async () => {
  const r = await evaluateRefuter({ findings: [inferentialBlocker()], runner: null });
  assert.equal(r.unchallenged, 1);
  assert.equal(r.escalate, 'human', 'no challenge available is weaker evidence than an inconclusive challenge, which already escalates');
  assert.equal(r.adjustedFindings[0].refuter_outcome, 'unchallenged');
  assert.equal(r.adjustedFindings[0].severity, 'blocker', 'the finding still blocks — this marks the evidence, it does not soften it');
});

test('#552: "nothing to challenge" stays silent — the two states must not collapse back together', async () => {
  const deterministic = { id: 'gate:x', severity: 'blocker', evidence_class: 'deterministic', evidence: 'FAILURE' };
  const r = await evaluateRefuter({ findings: [deterministic], runner: null });
  assert.equal(r.unchallenged, 0);
  assert.equal(r.escalate, null, 'every verdict brain posts today is this state — it must not start escalating');
  assert.deepEqual(r.adjustedFindings, [deterministic]);
  assert.equal('refuter_outcome' in r.adjustedFindings[0], false);
});

test('#552: only the inferential blockers are marked — a deterministic sibling is untouched', async () => {
  const deterministic = { id: 'gate:x', severity: 'blocker', evidence_class: 'deterministic', evidence: 'FAILURE' };
  const r = await evaluateRefuter({ findings: [deterministic, inferentialBlocker()], runner: null });
  assert.equal(r.unchallenged, 1);
  assert.equal('refuter_outcome' in r.adjustedFindings[0], false, 'a mechanical finding needs no challenger');
  assert.equal(r.adjustedFindings[1].refuter_outcome, 'unchallenged');
});

test('#552: a non-blocker inferential finding is not marked — the refuter forks on BLOCKERS', async () => {
  const editorial = { id: 'style:x', severity: 'editorial', evidence_class: 'inferential', evidence: 'reads oddly' };
  const r = await evaluateRefuter({ findings: [editorial], runner: null });
  assert.equal(r.unchallenged, 0);
  assert.equal(r.escalate, null);
});

test('#552: a runner that RAN reports unchallenged: 0 — the count means "not challenged", never "not refuted"', async () => {
  const runner = async (fs) => ({ outcomes: fs.map((f) => ({ id: f.id, outcome: 'corroborated', rationale: 'holds' })) });
  const r = await evaluateRefuter({ findings: [inferentialBlocker()], runner });
  assert.equal(r.unchallenged, 0);
  assert.equal(r.adjustedFindings[0].refuter_outcome, 'corroborated');
});

test('CHAIN: an outcome applies only to a finding the challenger was HANDED', async () => {
  // `outcomeMap.get(f.id)` was applied over EVERY finding, so a runner
  // volunteering an id it was never given downgraded that finding. The producer
  // half of this hazard is closed by id namespacing; this is the challenger
  // half, and it reached anything in the list.
  const gate = {
    id: 'gate:phase-order', severity: 'blocker', evidence_class: 'deterministic',
    evidence: 'required check phase-order is FAILURE',
  };
  const reasoned = { id: 'judgment:X', severity: 'blocker', evidence_class: 'inferential', evidence: 'e' };
  const volunteer = async () => ({
    outcomes: [{ id: 'gate:phase-order', outcome: 'refuted', rationale: 'a claim about something else' }],
  });

  const out = await evaluateRefuter({ findings: [gate, reasoned], runner: volunteer });
  assert.equal(out.adjustedFindings[0].severity, 'blocker',
    'a required gate the challenger was never handed must not be downgraded by it');
  assert.equal(out.adjustedFindings[0].refuted, undefined);
  assert.equal(out.adjustedFindings[1].refuter_outcome, 'unchallenged',
    'and the finding it WAS handed, and did not answer, is unchallenged');
});
