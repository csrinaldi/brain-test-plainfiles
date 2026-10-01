// resolve-challenger.test.mjs — issue #682, REQ-682-1/REQ-682-2/REQ-682-6,
// rewritten after the cold review of PR #740/#741.
//
// The axis these tests vary is WHICH STATE A READER OF THE VERDICT ENDS UP IN.
// #552's defect was two states that differed in the object and not on the wire,
// so the central cases assert on rendered bytes and the parse back.
//
// The cold review's finding about the FIRST cut of this file is worth keeping in
// front of whoever edits it: every mutation it survived varied behaviour INSIDE
// this module, and none varied whether `cli.mjs` calls it. The composition is
// covered in `cli.judgment.test.mjs`; this file covers the resolution.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveJudgment, AXES, IMPLEMENTED_AXES, JUDGMENT_PROTOCOL, DEFAULT_AXIS } from './resolve-challenger.mjs';
import { evaluateRefuter, UNCHALLENGED, ROUTED_HUMAN } from '../evaluators/refuter.mjs';
import { renderVerdict } from '../verdict.mjs';
import { parseVerdict } from './parse-verdict.mjs';
import { tierParams } from '../../vcs/governance-tiers.mjs';

const blocker = (id = 'F1') => ({
  id, severity: 'blocker', evidence_class: 'inferential',
  evidence: 'e', cites: 'reviewer-protocol.md §6.1',
});

const cfg = (inferential) => ({ reviewer: { inferential } });
const human = cfg({ enabled: true, challenger: { axis: 'human' } });

// ── ONE gate — the correction the cold review forced ─────────────────────────

test('the producer and the challenger read ONE resolution — they cannot disagree', () => {
  // The defect: the producer gated on `inferentialEnabled` and the challenger on
  // `protocol === '/2'`, and at `standard` those disagree. The producer ran, the
  // refuter was skipped entirely, and the verdict declared the judgment control
  // applied with nothing challenged — #552's ruled-against state.
  const r = resolveJudgment({ config: {}, protocol: 'brain-review/1' });
  assert.equal(r.run, false, 'a half that cannot be challenged must not be produced either');
  assert.equal(r.challenger, null);
  assert.equal(r.axis, null);
  assert.match(r.reason, /requires brain-review\/2/);
});

// The pin that stood here walked the tier table looking for a producer enabled at
// a protocol that could not challenge it. The #743 ruling removed the parameters
// that made that pair expressible, and the old body then passed VACUOUSLY — its
// `if` read `p.inferentialEnabled`, now undefined, so the assertion inside could
// never run. A green test that cannot fail is the defect this repo keeps finding.
//
// The property moved to where the data lives: `governance-tiers.test.mjs` asserts
// that no tier carries a review-system key at all. Here, the resolution itself is
// covered by the two tests below.

// ── the capability, and who answers for it ───────────────────────────────────
//
// REQ-682-2 ("the producer is OFF at `lite`") is RETIRED by the #743 ruling, and
// its two tests are gone rather than adjusted: their property was that the TIER
// decides, and the ruling says the tier does not. The addendum inverted the
// default too — absent means ON. What replaces them is the pair below: the
// default, and the one explicit value that turns it off.

test('#743: the judgment half is ON when nobody says otherwise', () => {
  const r = resolveJudgment({ config: {}, protocol: JUDGMENT_PROTOCOL });
  assert.equal(r.run, true, 'absent key means enabled — the ruling addendum, 2026-08-20');
  assert.equal(r.enabled, true);
});

test('#743: only an explicit `false` turns the judgment half off', () => {
  for (const value of [false]) {
    const r = resolveJudgment({ config: cfg({ enabled: value }), protocol: JUDGMENT_PROTOCOL });
    assert.equal(r.run, false, `enabled: ${JSON.stringify(value)} must disable the half`);
    assert.match(r.reason, /reviewer\.inferential\.enabled is false/,
      'the reason names the KEY an operator can change, never a tier');
  }
  // Anything that is not exactly `false` leaves it on — including the values a
  // sloppy config might carry. Fail-open is the ruled direction HERE, and it is
  // safe only because a half that cannot run says so in `conditions[]`.
  for (const value of [undefined, null, true]) {
    assert.equal(
      resolveJudgment({ config: cfg({ enabled: value }), protocol: JUDGMENT_PROTOCOL }).run, true,
      `enabled: ${JSON.stringify(value)} must NOT disable the half`
    );
  }
});

// The refusal that used to live here — "enabled, but the tier supplies no axis"
// — is GONE, and deliberately not replaced. It could only fire when a tier
// enabled the half without naming an axis; no tier names either any more, so the
// branch became unreachable and was deleted with it. Keeping a test for a
// condition nothing can produce is how a suite starts lying about its coverage.

test('an explicit axis is honoured, and turning the half on needs no other key', () => {
  const r = resolveJudgment({ config: human, protocol: JUDGMENT_PROTOCOL });
  assert.equal(r.run, true);
  assert.equal(r.axis, 'human');
});

// ── REQ-682-1 — resolution order and the refusal ─────────────────────────────

test('REQ-682-1: absent config resolves the axis to the default, and the default is implemented', () => {
  const r = resolveJudgment({ config: {}, protocol: JUDGMENT_PROTOCOL });
  assert.equal(r.axis, DEFAULT_AXIS);
  // The two halves of why `human` is the default, and the second is the one that
  // keeps it honest: a default naming an axis this build cannot run would promise
  // a strength of evidence nobody can deliver.
  assert.equal(DEFAULT_AXIS, 'human');
  assert.ok(IMPLEMENTED_AXES.includes(DEFAULT_AXIS),
    'the default axis must be one this build implements — otherwise every repo ' +
    'that declares nothing gets an unbuilt challenger');
});

test('REQ-682-1: explicit config beats the tier default', () => {
  assert.equal(resolveJudgment({ config: human, protocol: JUDGMENT_PROTOCOL }).axis, 'human');
});

test('REQ-682-1: an unrecognised axis REFUSES, naming what it would have accepted', () => {
  assert.throws(
    () => resolveJudgment({
      config: cfg({ enabled: true, challenger: { axis: 'same-modle' } }),
      protocol: JUDGMENT_PROTOCOL,
    }),
    (err) => {
      assert.match(err.message, /unrecognised challenger axis "same-modle"/);
      for (const a of AXES) assert.ok(err.message.includes(a), `must name ${a}`);
      return true;
    },
  );
});

// ── an unbuilt axis fails CLOSED on the wire, not in a stack trace ────────────

test('an unbuilt axis reports UNCHALLENGED and escalates — it does not throw', async () => {
  // The first cut threw at call time, and nothing catches it: it surfaced as an
  // unhandled rejection with NO verdict posted, replacing #552's honest
  // `unchallenged` + escalate + posted REVISE. Trading a posted fail-closed
  // verdict for a crash leaves the operator with less, not more.
  // The axis is DECLARED now rather than inherited from `regulated`: the tier no
  // longer supplies one, so an unbuilt axis is only ever an operator's explicit
  // request — which is exactly the case that must refuse instead of degrading.
  const r = resolveJudgment({
    config: cfg({ enabled: true, challenger: { axis: 'cross-family' } }),
    protocol: JUDGMENT_PROTOCOL,
  });
  assert.equal(r.axis, 'cross-family');
  assert.ok(!IMPLEMENTED_AXES.includes(r.axis));

  const out = await evaluateRefuter({ findings: [blocker()], runner: r.challenger });
  assert.equal(out.adjustedFindings[0].refuter_outcome, UNCHALLENGED);
  assert.equal(out.escalate, 'human');
  assert.match(out.adjustedFindings[0].refuter_rationale, /axis "cross-family" is not implemented/);
  assert.match(out.adjustedFindings[0].refuter_rationale, /Refusing to substitute a weaker axis/);
});

// ── the implemented set is ONE declaration, pinned by a literal ──────────────

test('every axis behaves the way IMPLEMENTED_AXES claims, and the claim is pinned', async () => {
  // The cold review of the terminal PR mutated `IMPLEMENTED_AXES` to claim
  // `same-model` was implemented while `same-model` still routed to
  // `unbuiltRunner` — telling an operator that the strongest axis they asked
  // for exists — and the FULL suite stayed green. The only test that touched
  // the constant read the same constant it was meant to pin, so it moved with
  // the mutation.
  //
  // So: a LITERAL, and then every axis checked against what the literal says.
  // The literal moves only when a runner is added to `RUNNERS` (slice 3 adds
  // `same-model`), and the loop below moves with it — which is the point.
  assert.deepEqual([...IMPLEMENTED_AXES], ['human']);

  for (const axis of AXES) {
    const r = resolveJudgment({
      config: cfg({ enabled: true, challenger: { axis } }),
      protocol: JUDGMENT_PROTOCOL,
    });
    const [outcome] = (await r.challenger([blocker()])).outcomes;

    if (IMPLEMENTED_AXES.includes(axis)) {
      assert.notEqual(
        outcome.outcome, UNCHALLENGED,
        `"${axis}" is declared implemented — it must produce a challenge, not report unchallenged`
      );
    } else {
      assert.equal(
        outcome.outcome, UNCHALLENGED,
        `"${axis}" is unbuilt — it must report unchallenged, never another axis's answer`
      );
      assert.match(
        outcome.rationale, new RegExp(`axis "${axis}" is not implemented`),
        `"${axis}" must name ITSELF as the axis that did not run`
      );
    }
  }
});

// ── REQ-682-6 — routed:human is a state of its own ───────────────────────────

test('REQ-682-6: the human axis marks `routed:human`, keeps the blocker, escalates', async () => {
  const r = resolveJudgment({ config: human, protocol: JUDGMENT_PROTOCOL });
  const out = await evaluateRefuter({ findings: [blocker()], runner: r.challenger });
  assert.equal(out.adjustedFindings[0].refuter_outcome, ROUTED_HUMAN);
  assert.equal(out.adjustedFindings[0].severity, 'blocker');
  assert.equal(out.escalate, 'human');
  assert.equal(out.unchallenged, 0);
});

test('REQ-682-6: the human axis does NOT fall through to `corroborated`', async () => {
  const r = resolveJudgment({ config: human, protocol: JUDGMENT_PROTOCOL });
  const out = await evaluateRefuter({ findings: [blocker()], runner: r.challenger });
  assert.notEqual(out.adjustedFindings[0].refuter_outcome, 'corroborated');
});

test('REQ-682-6: `routed:human` and `unchallenged` differ ON THE WIRE and both round-trip', async () => {
  const render = async (runner) => {
    const out = await evaluateRefuter({ findings: [blocker()], runner });
    return renderVerdict({
      protocol: 'brain-review/2', verdict: 'REVISE', head_sha: 'a'.repeat(40), rev: 1,
      gates: { required: ['issue-link'], detection: [] },
      findings: out.adjustedFindings, follow_ups: [], conditions: [], escalate: out.escalate,
    });
  };
  const routed = await render(resolveJudgment({ config: human, protocol: JUDGMENT_PROTOCOL }).challenger);
  const absent = await render(null);

  assert.notEqual(routed, absent);
  assert.match(routed, /refuter_outcome: routed:human/);
  assert.match(absent, /refuter_outcome: unchallenged/);
  assert.equal(parseVerdict({ body: routed }).findings[0].refuter_outcome, ROUTED_HUMAN);
  assert.equal(parseVerdict({ body: absent }).findings[0].refuter_outcome, UNCHALLENGED);
});

// ── the partial-runner backstop ──────────────────────────────────────────────

test('a runner that answers for SOME blockers leaves none unmarked and none uncounted', async () => {
  // Every test in the first cut used exactly one blocker, so multiplicity was
  // never varied — and a model handed 5 blockers returning 4 outcomes is the
  // most likely failure mode of the transport slice 3 introduces.
  const partial = async (blockers) => ({
    outcomes: blockers.slice(0, 1).map(f => ({ id: f.id, outcome: 'corroborated', rationale: 'r' })),
  });
  const out = await evaluateRefuter({ findings: [blocker('A'), blocker('B'), blocker('C')], runner: partial });

  assert.equal(out.unchallenged, 2, 'the two unanswered blockers must be COUNTED');
  assert.equal(out.escalate, 'human');
  assert.equal(out.adjustedFindings[1].refuter_outcome, UNCHALLENGED);
  assert.equal(out.adjustedFindings[2].refuter_outcome, UNCHALLENGED);
  assert.equal(out.adjustedFindings[0].refuter_outcome, 'corroborated');
});

test('the backstop does not touch findings the refuter was never asked about', async () => {
  const deterministic = { id: 'gate:x', severity: 'blocker', evidence_class: 'deterministic', evidence: 'e' };
  const out = await evaluateRefuter({
    findings: [deterministic, blocker('A')],
    runner: async () => ({ outcomes: [] }),
  });
  assert.equal('refuter_outcome' in out.adjustedFindings[0], false,
    'a deterministic finding is not an unanswered reasoned one');
  assert.equal(out.adjustedFindings[1].refuter_outcome, UNCHALLENGED);
  assert.equal(out.unchallenged, 1);
});
