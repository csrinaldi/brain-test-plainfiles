// ruling.test.mjs — Unit tests for REQ-H1-11: the ruling evaluator, Option
// (B) (owner ruling, issue #266 comment 5009584044). The reviewer NEVER
// auto-rules: a structurally valid `## FORK` ALWAYS escalates to a human
// (`STOP` + `escalate: 'human'`); it never emits APPROVE or a ruled
// conclusion. Pure `evaluateRuling` core + `gatherRulingInputs` gather, D1
// DI-seam style, mirrors tranche.test.mjs / checkpoint.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRuling, gatherRulingInputs, parseFork } from './ruling.mjs';

function validForkBody({ recCount = 1 } = {}) {
  const recLine = recCount === 0 ? '' : Array(recCount).fill('Recommendation: go with Option A').join('\n');
  return [
    '## FORK',
    '',
    '### Option A',
    'cost: 2 days of rework',
    'consequence: widens the port surface',
    '',
    '### Option B',
    'cost: a new mini-port',
    'consequence: calcifies into a parallel seam',
    '',
    recLine,
  ].join('\n');
}

// ── parseFork — the minimal ## FORK contract ────────────────────────────────

test('parseFork: no "## FORK" heading → invalid', () => {
  const result = parseFork('Just a regular PR body with no fork section.');
  assert.equal(result.valid, false);
  assert.match(result.reason, /FORK/);
});

test('parseFork: a single option → invalid (needs >=2)', () => {
  const body = [
    '## FORK',
    '### Option A',
    'cost: x',
    'consequence: y',
    'Recommendation: Option A',
  ].join('\n');
  const result = parseFork(body);
  assert.equal(result.valid, false);
  assert.match(result.reason, /1/);
});

test('parseFork: an option missing cost/consequence → invalid', () => {
  const body = [
    '## FORK',
    '### Option A',
    'cost: x',
    // missing consequence
    '### Option B',
    'cost: y',
    'consequence: z',
    'Recommendation: Option A',
  ].join('\n');
  const result = parseFork(body);
  assert.equal(result.valid, false);
  assert.match(result.reason, /\bA\b/);
});

test('parseFork: no Recommendation line → invalid', () => {
  const body = [
    '## FORK',
    '### Option A',
    'cost: x',
    'consequence: y',
    '### Option B',
    'cost: a',
    'consequence: b',
  ].join('\n');
  const result = parseFork(body);
  assert.equal(result.valid, false);
  assert.match(result.reason, /Recommendation/);
});

test('parseFork: two Recommendation lines → invalid (exactly one required)', () => {
  const result = parseFork(validForkBody({ recCount: 2 }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /Recommendation/);
});

test('parseFork: a well-formed fork with >=2 options + recommendation → valid, options carry id/cost/consequence', () => {
  const result = parseFork(validForkBody());
  assert.equal(result.valid, true);
  assert.equal(result.options.length, 2);
  assert.deepEqual(result.options.map(o => o.id), ['A', 'B']);
  assert.equal(result.options[0].cost, '2 days of rework');
  assert.equal(result.options[0].consequence, 'widens the port surface');
  assert.match(result.recommendation, /Option A/);
});

test('parseFork: accepts a list-equivalent option format (bullet, not heading)', () => {
  const body = [
    '## FORK',
    '- Option A',
    'cost: x',
    'consequence: y',
    '- Option B',
    'cost: a',
    'consequence: b',
    'Recommendation: Option A',
  ].join('\n');
  const result = parseFork(body);
  assert.equal(result.valid, true);
  assert.deepEqual(result.options.map(o => o.id), ['A', 'B']);
});

// ── evaluateRuling — REVISE on malformed, STOP+escalate on valid ───────────

test('evaluateRuling: a fork without options → REVISE, "a fork without options is a request to design"', () => {
  const result = evaluateRuling({ prBody: 'no fork section here' });
  assert.equal(result.conclusion, 'REVISE');
  assert.equal(result.escalate, null);
  assert.equal(result.pin, undefined);
  const finding = result.findings.find(f => f.id === 'fork-malformed');
  assert.ok(finding, 'expected a fork-malformed finding');
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /request to design/);
  assert.ok(finding.cites, 'a blocker finding must carry cites to survive verdict.mjs\'s downgrade gate');
});

test('evaluateRuling: a structurally valid fork (>=2 options, cost+consequence, one recommendation) → STOP + escalate:human, never a ruled conclusion', () => {
  const result = evaluateRuling({ prBody: validForkBody() });
  assert.equal(result.conclusion, 'STOP');
  assert.equal(result.escalate, 'human');
  const finding = result.findings.find(f => f.id === 'fork-escalate');
  assert.ok(finding, 'expected a fork-escalate finding');
  assert.match(finding.evidence, /new decision, not a ruling/);
});

test('evaluateRuling: NEVER emits APPROVE or any conclusion other than REVISE/STOP — no auto-rule path exists', () => {
  const malformed = evaluateRuling({ prBody: '' });
  const valid = evaluateRuling({ prBody: validForkBody() });
  assert.ok(['REVISE', 'STOP'].includes(malformed.conclusion));
  assert.ok(['REVISE', 'STOP'].includes(valid.conclusion));
});

// ── #750: conclusionCauses — shape assertions only ──────────────────────────
//
// Neither ruling return path is reachable by buildVerdict's softening (STOP
// never softens, and a malformed REVISE has no candidate for the
// pre-existing/base-only routing this evaluator never touches) — these pins
// are weaker than tranche's/checkpoint's, and are labelled as such.

test('evaluateRuling: malformed fork → conclusionCauses is [\'blocker\'] (shape only, unreachable by the softening) (#750)', () => {
  const result = evaluateRuling({ prBody: 'no fork section here' });
  assert.deepEqual(result.conclusionCauses, ['blocker']);
});

test('evaluateRuling: valid fork (STOP) → conclusionCauses is [] (shape only, unreachable by the softening) (#750)', () => {
  const result = evaluateRuling({ prBody: validForkBody() });
  assert.deepEqual(result.conclusionCauses, []);
});

// ── the pin: payload — the durable-record seed (protocol §8) ───────────────

test('evaluateRuling: a valid fork emits a pin: payload with fork/options/recommendation', () => {
  const result = evaluateRuling({ prBody: validForkBody() });
  assert.ok(result.pin, 'expected a pin payload');
  assert.deepEqual(result.pin.options.map(o => o.id), ['A', 'B']);
  assert.match(result.pin.recommendation, /Option A/);
});

// ── gatherRulingInputs — DI-seam gather, mirrors gatherTrancheInputs shape ──

test('gatherRulingInputs: passes prBody straight through to evaluateRuling shape', async () => {
  const body = validForkBody();
  const inputs = await gatherRulingInputs({ project: 'csrinaldi/brain', number: 42, prBody: body, deps: {} });
  assert.equal(inputs.prBody, body);
  const result = evaluateRuling(inputs);
  assert.equal(result.conclusion, 'STOP');
});
