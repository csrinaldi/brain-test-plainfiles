// causal-admission.test.mjs — Unit tests for the #394/#284 causal-admission
// bridge (annotateDeterministicFindings, applyCausalAdmission).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { annotateDeterministicFindings, applyCausalAdmission } from './causal-admission.mjs';

// ── annotateDeterministicFindings ───────────────────────────────────────────

test('annotateDeterministicFindings: fills evidence_class:deterministic and causal_disposition:introduced on a bare finding', () => {
  const [f] = annotateDeterministicFindings([{ id: 'gate:memory-gate', severity: 'blocker', evidence: 'FAILURE', cites: 'x' }]);
  assert.equal(f.evidence_class, 'deterministic');
  assert.equal(f.causal_disposition, 'introduced');
  assert.equal(f.id, 'gate:memory-gate');
});

test('annotateDeterministicFindings: never overwrites a finding that already carries its own classification', () => {
  const [f] = annotateDeterministicFindings([
    { id: 'r1', severity: 'blocker', evidence_class: 'inferential', causal_disposition: 'unknown' },
  ]);
  assert.equal(f.evidence_class, 'inferential');
  assert.equal(f.causal_disposition, 'unknown');
});

test('annotateDeterministicFindings: pure — does not mutate the input array/objects', () => {
  const input = [{ id: 'a' }];
  const out = annotateDeterministicFindings(input);
  assert.equal(input[0].evidence_class, undefined);
  assert.notEqual(out, input);
});

test('annotateDeterministicFindings: empty input → empty output', () => {
  assert.deepEqual(annotateDeterministicFindings([]), []);
  assert.deepEqual(annotateDeterministicFindings(), []);
});

// ── applyCausalAdmission ─────────────────────────────────────────────────────

test('applyCausalAdmission: no runner injected → annotates but never calls the refuter (no inferential blockers, no-op today)', async () => {
  const findings = [{ id: 'gate:x', severity: 'blocker', evidence: 'e', cites: 'c' }];
  const result = await applyCausalAdmission({ findings });
  assert.equal(result.findings[0].causal_disposition, 'introduced');
  assert.equal(result.findings[0].evidence_class, 'deterministic');
  assert.equal(result.escalate, null);
});

test('applyCausalAdmission: preserves a pre-set escalate when the refuter never fires', async () => {
  const findings = [{ id: 'fork-escalate', severity: 'editorial', evidence: 'e' }];
  const result = await applyCausalAdmission({ findings, escalate: 'human' });
  assert.equal(result.escalate, 'human');
});

test('applyCausalAdmission: an inferential blocker finding triggers the refuter; a "refuted" outcome demotes severity', async () => {
  const findings = [
    { id: 'r1', severity: 'blocker', evidence_class: 'inferential', causal_disposition: 'introduced', evidence: 'e', cites: 'c' },
  ];
  const runner = async (batch) => ({
    outcomes: batch.map((f) => ({ id: f.id, outcome: 'refuted', rationale: 'false positive' })),
  });
  const result = await applyCausalAdmission({ findings, runner });
  assert.equal(result.findings[0].severity, 'correction');
  assert.equal(result.findings[0].refuted, true);
});

test('applyCausalAdmission: an "inconclusive" refuter outcome forces escalate:human, overriding a null pre-set escalate', async () => {
  const findings = [
    { id: 'r1', severity: 'blocker', evidence_class: 'inferential', causal_disposition: 'introduced', evidence: 'e', cites: 'c' },
  ];
  const runner = async (batch) => ({
    outcomes: batch.map((f) => ({ id: f.id, outcome: 'inconclusive', rationale: 'cannot determine' })),
  });
  const result = await applyCausalAdmission({ findings, runner, escalate: null });
  assert.equal(result.escalate, 'human');
});

// ═══════════════════════════════════════════════════════════════════════════
// #552 — an unchallenged reasoned blocker is visible ON THE WIRE
//
// The property, stated as the thing that was false: a reader of a posted verdict
// must be able to tell a judgment finding that was CHALLENGED from one that was
// never challenged at all. Before this, they rendered byte-identically.
// ═══════════════════════════════════════════════════════════════════════════

const INFERENTIAL = Object.freeze({
  id: 'design:coupling',
  severity: 'blocker',
  evidence: 'x reaches into y',
  cites: 'judgment',
  evidence_class: 'inferential',
  causal_disposition: 'introduced',
});

const CORROBORATING = async (fs) => ({
  outcomes: fs.map((f) => ({ id: f.id, outcome: 'corroborated', rationale: 're-derived it independently' })),
});

test('#552: with no runner, the verdict carries a condition and escalates to a human', async () => {
  const r = await applyCausalAdmission({ findings: [{ ...INFERENTIAL }], escalate: null, runner: null });
  assert.equal(r.escalate, 'human');
  assert.equal(r.conditions.length, 1);
  assert.match(r.conditions[0], /1 inferential blocker\(s\) were NOT challenged/);
  assert.match(r.conditions[0], /no refuter runner is configured/);
});

test('#552: with a runner that corroborated, there is no such condition — the condition means "not asked", not "asked and answered"', async () => {
  const r = await applyCausalAdmission({ findings: [{ ...INFERENTIAL }], escalate: null, runner: CORROBORATING });
  assert.deepEqual(r.conditions, []);
  assert.equal(r.escalate, null);
});

test('#552: the two states render DIFFERENTLY — they used to be byte-identical', async () => {
  const { buildVerdict, renderVerdict } = await import('../verdict.mjs');
  const render = async (runner) => {
    const r = await applyCausalAdmission({ findings: [{ ...INFERENTIAL }], escalate: null, runner });
    return renderVerdict(buildVerdict({
      headSha: 'abc123', gates: { required: [], detection: [] }, protocol: 'brain-review/2',
      findings: r.findings, escalate: r.escalate, conditions: r.conditions,
    }));
  };
  const never = await render(null);
  const checked = await render(CORROBORATING);

  assert.notEqual(never, checked, 'a reasoned blocker nobody challenged must not read like one that was');
  assert.match(never, /refuter_outcome: unchallenged/);
  assert.match(never, /escalate: human/);
  assert.match(checked, /refuter_outcome: corroborated/);
  assert.match(checked, /refuter_rationale: "re-derived it independently"/,
    'the REASON for the outcome is rendered too — a marker whose justification only the code can see is the same defect one field over');
});

test('#552: a deterministic-only verdict is UNCHANGED — every verdict brain posts today takes this path', async () => {
  const before = await applyCausalAdmission({
    findings: [{ id: 'gate:x', severity: 'blocker', evidence: 'FAILURE', cites: 'y' }],
    escalate: null, runner: null,
  });
  assert.deepEqual(before.conditions, []);
  assert.equal(before.escalate, null);
  assert.equal('refuter_outcome' in before.findings[0], false);
});

// ── #750 cold review C2: REQ-750-1's negative half — this bridge never declares conclusionCauses ──

test('#750 REQ-750-1: applyCausalAdmission never declares conclusionCauses — it never touches conclusion', async () => {
  const findings = [{ id: 'gate:x', severity: 'blocker', evidence: 'e', cites: 'c' }];
  const result = await applyCausalAdmission({ findings, conclusion: 'REVISE' });
  assert.ok(!('conclusionCauses' in result),
    'applyCausalAdmission has no conclusion parameter and no conclusionCauses field to declare');
  assert.ok(!('conclusion' in result),
    'a conclusion passed in is not a parameter this function reads — it must not leak into the result untouched or otherwise');
});
