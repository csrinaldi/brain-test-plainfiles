// inferential.test.mjs — issue #682 slice 2, REQ-682-3 and REQ-682-4.
//
// The axis these tests vary is WHAT A READER OF THE VERDICT CAN TELL: whether
// the judgment half ran, and whether the challenger could see anything that
// reader could not. Both are properties of the wire, not of the object.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateInferential, gatherInferentialInputs, shouldRun, sanitiseFinding,
  PRODUCES, CARRIED_FIELDS, ID_PREFIX, RENDERED_ALWAYS, RENDERED_AS_ANCHOR,
  findingKey,
} from './inferential.mjs';
import { PRODUCES as TRANCHE_PRODUCES } from './tranche.mjs';
import { unionControls, complementControls } from '../lib/controls.mjs';
import { evaluateRefuter } from './refuter.mjs';
import { resolveJudgment, JUDGMENT_PROTOCOL } from '../lib/resolve-challenger.mjs';
import { renderVerdict } from '../verdict.mjs';

const generated = (extra = {}) => ([{
  id: 'J1', severity: 'blocker', title: 'a reasoned claim',
  evidence: 'the parser is correct; the semantics are inverted',
  cites: 'reviewer-protocol.md §6.1', file: 'a.mjs', line: 12,
  ...extra,
}]);

// ── REQ-682-3 — the declaration follows what RAN ─────────────────────────────

test('REQ-682-3: the evaluator declares `inferential`, and that is the whole of the declaration', () => {
  assert.deepEqual(PRODUCES, ['inferential']);
});

test('REQ-682-3: when the producer runs, the union grows and #690\'s complement empties itself', () => {
  // controls.test.mjs:114 asserts this as a hypothetical — "when #682 lands, the
  // complement empties itself, no edit required". This exercises it for real,
  // without touching that test's assertion.
  const before = unionControls([TRANCHE_PRODUCES]);
  const after = unionControls([TRANCHE_PRODUCES, PRODUCES]);

  assert.deepEqual(complementControls(before), ['inferential'],
    'without the producer, the verdict must say the inferential control did NOT run');
  assert.deepEqual(complementControls(after), [],
    'with it, the complement empties by itself — derived, never hand-maintained');
});

test('REQ-682-3: an unrun producer declares NOTHING — the honest half of the same rule', () => {
  // The defect this forbids: running the evaluator, producing zero findings, and
  // declaring `inferential` anyway. That claims a control the run never applied,
  // which is exactly what controls.mjs exists to remove.
  assert.equal(shouldRun({ enabled: true, generate: null }), false,
    'enabled but with no transport must NOT run — slice 3 supplies the transport');
  assert.equal(shouldRun({ enabled: false, generate: () => [] }), false);
  assert.equal(shouldRun({ enabled: true, generate: () => [] }), true);
});

test('with no generator, gather returns null and produces nothing to declare over', async () => {
  assert.deepEqual(await gatherInferentialInputs({ deps: {} }), { generated: null, failed: false });
  assert.deepEqual(evaluateInferential({ generated: null }).findings, []);
});

test('C7: a generator that FAILED is not a generator that found nothing (#682 criterion 6)', async () => {
  // The first cut coerced with `Array.isArray(g) ? g : []`, so a transport that
  // swallowed its own error and returned undefined produced an empty list — and
  // the verdict then declared the judgment control APPLIED with nothing found.
  // "Unreachable" folded into "found nothing", in the file whose header rails
  // against exactly that.
  for (const [label, generate] of [
    ['undefined', async () => undefined],
    ['a non-array', async () => ({ error: 'unreachable' })],
    ['a throw', async () => { throw new Error('ECONNREFUSED'); }],
  ]) {
    const r = await gatherInferentialInputs({ deps: { generate } });
    assert.equal(r.failed, true, `${label} must be reported as a FAILURE`);
    assert.equal(r.generated, null, `${label} must not become an empty finding list`);
    assert.ok(r.reason, `${label} must name its cause`);
  }
});

test('C7: a generator that legitimately found nothing is NOT a failure', async () => {
  const r = await gatherInferentialInputs({ deps: { generate: async () => [] } });
  assert.equal(r.failed, false);
  assert.deepEqual(r.generated, []);
});

// ── the class is forced, never trusted ───────────────────────────────────────

test('every emitted finding is forced to `evidence_class: inferential`', () => {
  const r = evaluateInferential({ generated: generated({ evidence_class: 'deterministic' }) });
  assert.equal(r.findings[0].evidence_class, 'inferential',
    'a judgment evaluator claiming `deterministic` would put a reasoned claim on the ' +
    'deterministic side of #575 Ruling 3 and skip the refuter entirely');
});

test('B4: produced ids are namespaced, so a producer cannot address a deterministic finding', async () => {
  // `evaluateRefuter` keys outcomes by id ALONE and applies them to EVERY
  // finding carrying it. Before namespacing, a producer emitting
  // `gate:phase-order` — which an LLM asked to review a PR reaches for
  // unprompted — meant that refuting the REASONED claim flipped the genuinely
  // failing required gate to `correction`. Fail-open, on a real gate.
  const deterministic = {
    id: 'gate:phase-order', severity: 'blocker', evidence_class: 'deterministic',
    evidence: 'required check phase-order is FAILURE',
  };
  const reasoned = evaluateInferential({
    generated: [{ id: 'gate:phase-order', severity: 'blocker', evidence: 'a reasoned claim' }],
  }).findings;

  assert.equal(reasoned[0].id, `${ID_PREFIX}gate:phase-order`);

  const refuteAll = async (blockers) => ({
    outcomes: blockers.map(f => ({ id: f.id, outcome: 'refuted', rationale: 'not real' })),
  });
  const out = await evaluateRefuter({ findings: [deterministic, ...reasoned], runner: refuteAll });

  assert.equal(out.adjustedFindings[0].severity, 'blocker',
    'the deterministic gate finding must still block — nothing challenged IT');
  assert.equal(out.adjustedFindings[1].severity, 'correction');
});

test('the producer never escalates on its own', () => {
  // Escalation for a reasoned finding is the CHALLENGER's decision. A producer
  // that escalated its own claims would be judging them — the self-attestation
  // ADR-0031 refuses.
  assert.equal(evaluateInferential({ generated: generated() }).escalate, null);
});

// ── REQ-682-4 — the challenger sees no more than the reader does ─────────────

test('REQ-682-4: reasoning fields are DROPPED before a finding leaves the producer', () => {
  const leaky = generated({
    reasoning: 'first I considered X, then rejected it because…',
    chain_of_thought: 'step 1…',
    _prompt: 'you are a reviewer…',
    model_scratchpad: 'hmm',
  })[0];

  const clean = sanitiseFinding(leaky);
  for (const k of ['reasoning', 'chain_of_thought', '_prompt', 'model_scratchpad']) {
    assert.equal(k in clean, false, `${k} must not survive — it is the producer's reasoning`);
  }
  assert.equal(clean.evidence, leaky.evidence, 'the claim\'s support survives; the thinking does not');
});

test('REQ-682-4: the carried set is enumerated, so a new generator field cannot widen the boundary', () => {
  const clean = sanitiseFinding(generated({ brand_new_field: 'anything' })[0]);
  for (const k of Object.keys(clean)) {
    assert.ok(CARRIED_FIELDS.includes(k), `${k} is not in CARRIED_FIELDS`);
  }
  assert.equal('brand_new_field' in clean, false,
    'a generator that grows a field does not get to widen the boundary by existing');
});

test('REQ-682-4: the rendered sets are the oracle, and CARRIED_FIELDS cannot outgrow them', async () => {
  // `RENDERED_ALWAYS` and `RENDERED_AS_ANCHOR` were declared as the oracle for
  // this requirement and NOTHING read them — two exports, zero consumers. So
  // the mutation the file above names as the defect it fixed still passed:
  // adding `deliberation_notes` to `CARRIED_FIELDS` left the full suite green
  // while the boundary widened. The test below is a real improvement over the
  // self-comparison it replaced, but its oracle is the keys ITS OWN fixture
  // emits — it iterates one hand-written finding, so a carried field no fixture
  // names is never reached by any assertion.
  //
  // Two assertions close it from both sides, and neither needs a fixture to
  // know a field's name.

  // 1. Nothing crosses the boundary that the renderer does not emit. Adding a
  //    field to CARRIED_FIELDS alone fails HERE, whatever any fixture carries.
  const declaredRendered = [...RENDERED_ALWAYS, ...RENDERED_AS_ANCHOR];
  for (const k of CARRIED_FIELDS) {
    assert.ok(
      declaredRendered.includes(k),
      `${k} is carried to the challenger but no rendered set claims it — add it to the ` +
      'renderer and to RENDERED_ALWAYS/RENDERED_AS_ANCHOR, or drop it from CARRIED_FIELDS'
    );
  }

  // 2. And the rendered sets are not fiction either: every member must appear
  //    in a verdict built from a finding that carries them all. Without this,
  //    assertion 1 could be satisfied by declaring a field rendered that the
  //    renderer never emits — the same lie, one list over.
  const carrier = evaluateInferential({
    generated: [{
      id: 'J9', severity: 'blocker', evidence: 'a claim with every carried field present',
      cites: 'reviewer-protocol.md §6.1', file: 'a.mjs', line: 12,
    }],
  }).findings;

  const carrierBody = renderVerdict({
    protocol: 'brain-review/2', verdict: 'REVISE', head_sha: 'c'.repeat(40), rev: 1,
    gates: { required: ['issue-link'], detection: [] },
    controls: ['deterministic', 'inferential'],
    findings: carrier, follow_ups: [], conditions: [], escalate: null,
  });

  for (const k of declaredRendered) {
    assert.match(
      carrierBody, new RegExp(`^\\s*(?:-\\s+)?${k}:`, 'm'),
      `${k} is declared rendered and renderVerdict emits no line for it`
    );
  }
});

test('REQ-682-4: what the challenger receives is a SUBSET of what the verdict RENDERS', async () => {
  // THE CENTRAL CASE, rewritten. The first cut asserted `CARRIED_FIELDS
  // .includes(k)` — comparing the list to itself, which cannot fail for any
  // member however un-rendered. That is exactly how `title` survived in the
  // list while `renderVerdict` emitted it nowhere: three fields crossed the
  // boundary invisibly and the test said the property held.
  //
  // The oracle is now the RENDERER. A field reaches the challenger only if a
  // reader of the posted verdict can see it.
  const emitted = evaluateInferential({
    generated: [{
      id: 'J1', severity: 'blocker', evidence: 'the semantics are inverted',
      cites: 'reviewer-protocol.md §6.1', file: 'a.mjs', line: 12,
      title: 'A TITLE A READER NEVER SEES',
      reasoning: "the producer's private chain",
    }],
  }).findings;

  let seenByChallenger = null;
  const spy = async (blockers) => {
    seenByChallenger = blockers;
    return { outcomes: blockers.map(f => ({ id: f.id, outcome: 'corroborated', rationale: 'r' })) };
  };
  const out = await evaluateRefuter({ findings: emitted, runner: spy });

  const body = renderVerdict({
    protocol: 'brain-review/2', verdict: 'REVISE', head_sha: 'a'.repeat(40), rev: 1,
    gates: { required: ['issue-link'], detection: [] },
    controls: ['deterministic', 'inferential'], judgmentAxis: 'human',
    findings: out.adjustedFindings, follow_ups: [], conditions: [], escalate: out.escalate,
  });

  assert.ok(seenByChallenger, 'the runner must have been called');
  const REFUTER_FIELDS = ['refuter_outcome', 'refuter_rationale', 'causal_disposition'];
  for (const f of seenByChallenger) {
    for (const [k, v] of Object.entries(f)) {
      if (REFUTER_FIELDS.includes(k)) continue;
      assert.match(body, new RegExp(`\\b${k}:`),
        `the challenger saw "${k}" and the rendered verdict never emits it — the boundary leaked`);
      assert.ok(body.includes(String(v)),
        `the challenger saw ${k}=${JSON.stringify(v)} and that VALUE is not on the wire`);
    }
  }
  assert.equal('title' in seenByChallenger[0], false,
    'title is the free-text field an LLM fills with its own framing — the reasoning channel');
});

test('REQ-682-4: there is no side channel — the runner receives findings and nothing else', async () => {
  const emitted = evaluateInferential({ generated: generated() }).findings;
  let argCount = null;
  const spy = async (...args) => {
    argCount = args.length;
    return { outcomes: [] };
  };
  await evaluateRefuter({ findings: emitted, runner: spy });
  assert.equal(argCount, 1,
    'a second argument would be a channel from producer to challenger that the verdict never shows');
});

// ── the two halves compose ───────────────────────────────────────────────────

test('a reasoned finding with the human axis is routed, not corroborated', async () => {
  const emitted = evaluateInferential({ generated: generated() }).findings;
  const { challenger: runner } = resolveJudgment({
    config: { reviewer: { inferential: { enabled: true, challenger: { axis: 'human' } } } },
    tier: 'standard', protocol: JUDGMENT_PROTOCOL,
  });
  const r = await evaluateRefuter({ findings: emitted, runner });
  assert.equal(r.adjustedFindings[0].refuter_outcome, 'routed:human');
  assert.equal(r.escalate, 'human');
});

// ── #750 cold review C2: REQ-750-1's negative half — this producer never sets `conclusion` ──

test('#750 REQ-750-1: evaluateInferential never sets conclusion or declares conclusionCauses — there is nothing for it to declare', () => {
  const result = evaluateInferential({ generated: generated() });
  assert.equal(result.conclusion, null,
    'this producer touches only findings/conditions/escalate — it must never raise a conclusion');
  assert.ok(!('conclusionCauses' in result),
    'a producer that never sets conclusion must never declare conclusionCauses — there is nothing for it to declare');
});

// ── #682 C.5's verdict, judgment:cold-2 ──────────────────────────────────────
//
// The round loop deduplicated by `f?.id`, so two DISTINCT findings sharing an
// id collapsed to one — inside a single round, on the default bound, with the
// loop not even involved. A blocker left the verdict in silence.
//
// Measured on both sides before the fix: base `71a7abd` returned 2, head
// returned 1. Fail-OPEN, over a producer whose ids are a model's choice.

test('#682 cold-2: two DISTINCT findings under one id both survive a single round', async () => {
  const two = [
    { id: 'J1', severity: 'blocker', evidence: 'first claim', cites: 'REQ-A' },
    { id: 'J1', severity: 'blocker', evidence: 'second claim', cites: 'REQ-B' },
  ];
  const r = await gatherInferentialInputs({ deps: { generate: async () => two.map(o => ({ ...o })) } });

  assert.equal(r.failed, false);
  assert.deepEqual(
    r.generated.map(f => f.evidence), ['first claim', 'second claim'],
    'a blocker was dropped for sharing a label with another — the producer chooses these ids, ' +
    'and two claims are not one claim because a model reused a name'
  );
});

test('#682 cold-2: and the second one reaches the verdict, disambiguated', async () => {
  // The gather-level assertion above is necessary and not sufficient: the
  // user-visible property is that BOTH findings are rendered, under distinct
  // ids. `uniqueId` exists for exactly this and was unreachable, because the
  // finding was dropped before `evaluateInferential` ever saw it.
  const r = await gatherInferentialInputs({
    deps: {
      generate: async () => ([
        { id: 'J1', severity: 'blocker', evidence: 'first claim', cites: 'REQ-A' },
        { id: 'J1', severity: 'blocker', evidence: 'second claim', cites: 'REQ-B' },
      ]),
    },
  });

  const ids = evaluateInferential({ generated: r.generated }).findings.map(f => f.id);
  assert.deepEqual(
    ids, [`${ID_PREFIX}J1`, `${ID_PREFIX}J1#2`],
    'the second finding must render under its own id — refuting one must not silently answer the other'
  );
});

test('#682 cold-2: a round that repeats ITSELF still converges — the dedup keeps its job', async () => {
  // THE PROPERTY THE FIX MUST NOT COST, and it had no oracle before this. A
  // dedup removed entirely would satisfy both tests above and break this one:
  // round 2 would re-add round 1's findings and the loop would never stop
  // early. Same content, emitted twice, must be one finding and must end the
  // loop — while the bound stays available for a producer that keeps finding
  // new things.
  const rounds = [];
  const r = await gatherInferentialInputs({
    maxRounds: 5,
    deps: {
      generate: async ({ round }) => {
        rounds.push(round);
        // Same finding every round, with its keys written in a DIFFERENT ORDER
        // the second time: a content key that is not order-normalised would see
        // two findings here and never converge.
        return round === 1
          ? [{ id: 'J1', severity: 'blocker', evidence: 'the same claim' }]
          : [{ evidence: 'the same claim', severity: 'blocker', id: 'J1' }];
      },
    },
  });

  assert.equal(r.generated.length, 1, 'a repeated finding is one finding, whatever order its keys arrive in');
  assert.deepEqual(rounds, [1, 2], 'the loop must stop on the first round that produces nothing new, not run the bound out');
  assert.equal(r.rounds, 2);
});

// ── An uncomputable key is ABSENT, not shared (#682, the cold read's tail) ────
//
// `findingKey` returned `String(f)` on an unserialisable value, and a comment
// called that "the conservative direction". MEASURED before the fix: two
// DIFFERENT circular findings both keyed to "[object Object]", so the second
// read as a duplicate and was dropped — two blockers in, one out, with
// `failed: false` and no condition, count or log line to say so.
//
// D.3's `judgment:cold-2` returning one layer down inside its own fix: that one
// dropped a finding because a producer reused an id, this one because a producer
// emitted a value JSON cannot describe. Same deletion, same silence.

function circular(id, evidence) {
  const f = { id, severity: 'blocker', evidence_class: 'inferential', evidence, cites: 'REQ-1' };
  f.self = f;
  return f;
}

test('#682: findingKey reports NO KEY rather than a shared placeholder', () => {
  const a = circular('A', 'first');
  const b = circular('B', 'a different claim entirely');

  assert.equal(findingKey(a), null, 'an uncomputable key must be absent, not a string that collides');
  assert.equal(findingKey(b), null);

  // And it stays TOTAL — the whole reason it exists. A throw here would make
  // deduplication the thing that fails the review.
  for (const weird of [undefined, () => {}, Symbol('x'), { n: 1n }, [circular('C', 'c')]]) {
    assert.doesNotThrow(() => findingKey(weird), `findingKey threw on ${String(weird)}`);
  }
});

test('#682: a finding with no computable key is FRESH, never deduplicated away', async () => {
  const result = await gatherInferentialInputs({
    deps: { generate: async () => [circular('A', 'first'), circular('B', 'a different claim entirely')] },
  });

  assert.equal(result.failed, false);
  assert.equal(
    result.generated.length, 2,
    'a second unkeyable blocker was dropped — silently, which is why this needs an oracle rather than a comment'
  );
  // Bare ids: `uniqueId`'s `judgment:` prefix is applied downstream by
  // `evaluateInferential`, not here. Asserted as measured rather than as assumed.
  assert.deepEqual(result.generated.map((f) => f.id), ['A', 'B']);
});

test('#682: keyable findings still deduplicate — the fix must not disable convergence', () => {
  // The other direction, and the one that would rot unnoticed: making every
  // finding "fresh" would satisfy the test above and destroy the round loop.
  const one = { id: 'A', severity: 'blocker', evidence: 'same' };
  const same = { severity: 'blocker', evidence: 'same', id: 'A' };  // key order differs

  assert.notEqual(findingKey(one), null);
  assert.equal(
    findingKey(one), findingKey(same),
    'key ordering must still normalise — {a,b} and {b,a} are one finding'
  );
  assert.notEqual(findingKey(one), findingKey({ id: 'A', severity: 'blocker', evidence: 'different' }));
});
