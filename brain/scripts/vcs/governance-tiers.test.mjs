// governance-tiers.test.mjs — Unit tests for the doctrine-tier resolver (issue
// #358 Q5, design.md §8). Run with: npm test (node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TIERS,
  NEVER_TIERED,
  GATE_MATRIX,
  resolveTier,
  resolveGatePolicy,
  resolveGateEvidence,
  resolveReviewProtocol,
  PRODUCED_PROTOCOL,
  REVIEW_PROTOCOLS,
  tierParams,
  requiredJobs,
  printDiffBudget,
  SIZE_EXCEPTION_LABEL,
  sizeExceptionRuling
} from './governance-tiers.mjs';
import { GOVERNANCE_JOBS } from './governance-checks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

// ── TIERS / NEVER_TIERED shape ──────────────────────────────────────────────

test('TIERS is exactly the three ordinal values, lite < standard < regulated', () => {
  assert.deepEqual(TIERS, ['lite', 'standard', 'regulated']);
  assert.ok(Object.isFrozen(TIERS));
});

test('NEVER_TIERED enumerates the six REQ-TIER-2 gates', () => {
  assert.deepEqual(
    [...NEVER_TIERED].sort(),
    ['actor-check', 'brain-writes-reviewed', 'decision-gate', 'diff-size', 'issue-link', 'local-checks'].sort()
  );
});

// ── lane governance (#905, spec.md "job registration is atomic", design.md A7) ─
//
// Both gates are `required` at EVERY tier — but via position-required matrix
// rows, never by widening NEVER_TIERED (the REQ-TIER-2 doctrinal core stays
// at six; governance-tiers.test.mjs:36 above pins that enumeration and this
// slice does not touch it).

test('lane governance (#905): NEVER_TIERED stays at six entries — lane-paths/lane-scrub are NOT added to the doctrinal core', () => {
  assert.equal(NEVER_TIERED.length, 6);
  assert.ok(!NEVER_TIERED.includes('lane-paths'));
  assert.ok(!NEVER_TIERED.includes('lane-scrub'));
});

test('lane governance (#905): GATE_MATRIX rows for lane-paths/lane-scrub are required at every tier', () => {
  for (const tier of TIERS) {
    assert.equal(resolveGatePolicy('lane-paths', tier), 'required', `lane-paths must be required at "${tier}"`);
    assert.equal(resolveGatePolicy('lane-scrub', tier), 'required', `lane-scrub must be required at "${tier}"`);
  }
});

// ── REQ-TIER-1 — monotonicity ────────────────────────────────────────────────

test('REQ-TIER-1: no gate is required at a lower tier and detection at a higher one', () => {
  for (const gate of Object.keys(GATE_MATRIX)) {
    const litePolicy = resolveGatePolicy(gate, 'lite');
    const standardPolicy = resolveGatePolicy(gate, 'standard');
    const regulatedPolicy = resolveGatePolicy(gate, 'regulated');

    if (litePolicy === 'required') {
      assert.equal(standardPolicy, 'required', `${gate}: required at lite but not standard`);
    }
    if (standardPolicy === 'required') {
      assert.equal(regulatedPolicy, 'required', `${gate}: required at standard but not regulated`);
    }
  }
});

test('REQ-TIER-1: an unknown tier fails closed, never resolves to standard', () => {
  assert.throws(() => resolveTier({ governance: { tier: 'enterprise' } }), /lite, standard, regulated/);
  assert.throws(() => resolveTier({ governance: { tier: 'enterprise' } }), /governance\.tier/);
});

test('REQ-TIER-1: diffBudget is monotonically at-least-as-strict at every tier above N (lower budget = stricter)', () => {
  assert.ok(tierParams('lite').diffBudget > tierParams('standard').diffBudget);
  assert.ok(tierParams('standard').diffBudget > tierParams('regulated').diffBudget);
});

// ── REQ-TIER-2 — never-tiered core is required everywhere ──────────────────

test('REQ-TIER-2: every never-tiered gate resolves to required at every tier', () => {
  for (const gate of NEVER_TIERED) {
    for (const tier of TIERS) {
      assert.equal(
        resolveGatePolicy(gate, tier),
        'required',
        `${gate} must be required at ${tier} (REQ-TIER-2)`
      );
    }
  }
});

// ── REQ-TIER-3 — no policy outside {required, detection} ───────────────────

test('REQ-TIER-3: every gate cell is exactly "required" or "detection", never off/disabled/absent', () => {
  for (const gate of Object.keys(GATE_MATRIX)) {
    for (const tier of TIERS) {
      const policy = resolveGatePolicy(gate, tier);
      assert.ok(
        policy === 'required' || policy === 'detection',
        `${gate}@${tier}: policy "${policy}" is outside {required, detection}`
      );
    }
  }
});

// ── REQ-TIER-7 — position-tiered ∩ never-tiered = ∅ ─────────────────────────

test('REQ-TIER-7: any gate whose policy varies across tiers (position-tiered) is disjoint from NEVER_TIERED', () => {
  const positionTiered = Object.keys(GATE_MATRIX).filter(gate => {
    const policies = new Set(TIERS.map(tier => resolveGatePolicy(gate, tier)));
    return policies.size > 1;
  });

  assert.ok(positionTiered.length > 0, 'expected at least one position-tiered gate (memory-gate/phase-order)');
  for (const gate of positionTiered) {
    assert.ok(
      !NEVER_TIERED.includes(gate),
      `${gate} is position-tiered but also listed in NEVER_TIERED — proportionality must never reach the core`
    );
  }
});

// ── REQ-TIER-8 — the matrix is total (drift-guard, fail-closed) ────────────

test('REQ-TIER-8: every GOVERNANCE_JOBS name has a matrix row', () => {
  for (const job of GOVERNANCE_JOBS) {
    assert.ok(GATE_MATRIX[job], `GOVERNANCE_JOBS includes "${job}" but GATE_MATRIX has no row for it`);
  }
});

test('REQ-TIER-8: every matrix row names a job GOVERNANCE_JOBS defines', () => {
  for (const gate of Object.keys(GATE_MATRIX)) {
    assert.ok(GOVERNANCE_JOBS.includes(gate), `GATE_MATRIX has a row for "${gate}" but it is not in GOVERNANCE_JOBS`);
  }
});

test('REQ-TIER-8: every matrix row resolves both a policy and an evidence form for all three tiers', () => {
  for (const gate of Object.keys(GATE_MATRIX)) {
    for (const tier of TIERS) {
      assert.ok(typeof resolveGatePolicy(gate, tier) === 'string');
      assert.ok(typeof resolveGateEvidence(gate, tier) === 'string' && resolveGateEvidence(gate, tier).length > 0);
    }
  }
});

test('REQ-TIER-8: an unmapped gate fails closed naming the gate and the tiers it must be decided for', () => {
  assert.throws(() => resolveGatePolicy('made-up-gate', 'standard'), /made-up-gate/);
  assert.throws(() => resolveGatePolicy('made-up-gate', 'standard'), /GATE_MATRIX/);
});

test('REQ-TIER-8 (regression): GOVERNANCE_JOBS and GATE_MATRIX keys are the SAME set, not just overlapping', () => {
  assert.deepEqual([...GOVERNANCE_JOBS].sort(), Object.keys(GATE_MATRIX).sort());
});

// ── REQ-TIER-9 — requiredJobs(tier), post Q5 Phase 5 promotions ─────────────
//
// Phase 5 (tasks.md) promoted actor-check, brain-writes-reviewed (all tiers)
// and phase-order (standard/regulated) out of PENDING_PROMOTION — see
// governance-tiers.mjs's STAGED ROLLOUT note. Pre-Phase-5,
// requiredJobs('standard') equalled the pre-tiering REQUIRED_JOBS literal
// exactly (REQ-TIER-10's no-op-migration guarantee); Phase 5 is a deliberate,
// ratified departure from that guarantee (design §4.1), so `standard` now
// also requires the three promoted gates.

test("REQ-TIER-9: requiredJobs('standard') includes the Q5 Phase 5 promotions (phase-order, actor-check, brain-writes-reviewed), #905's lane-paths/lane-scrub and #967's base-branch, preserving GATE_MATRIX order", () => {
  assert.deepEqual(requiredJobs('standard'), [
    'issue-link',
    'diff-size',
    'local-checks',
    'memory-gate',
    'decision-gate',
    'phase-order',
    'actor-check',
    'brain-writes-reviewed',
    'lane-paths',
    'lane-scrub',
    'base-branch',
  ]);
});

test("requiredJobs('lite') demotes memory-gate and phase-order by position (proportionality, design §2.B); promotes actor-check/brain-writes-reviewed by evidence tiering (REQ-TIER-2, Phase 5); lane-paths/lane-scrub required at every tier (#905); base-branch required at every tier, including lite (#967 ruling 1)", () => {
  assert.deepEqual(requiredJobs('lite'), [
    'issue-link',
    'diff-size',
    'local-checks',
    'decision-gate',
    'actor-check',
    'brain-writes-reviewed',
    'lane-paths',
    'lane-scrub',
    'base-branch',
  ]);
});

test("requiredJobs('regulated') is a superset of requiredJobs('standard') (memory-gate, phase-order, actor-check, brain-writes-reviewed all stay required)", () => {
  const standard = requiredJobs('standard');
  const regulated = requiredJobs('regulated');
  for (const gate of standard) {
    assert.ok(regulated.includes(gate), `regulated must still require "${gate}"`);
  }
});

test('Q5 Phase 5: PENDING_PROMOTION is empty — requiredJobs() no longer filters actor-check/brain-writes-reviewed/phase-order out of the matrix-declared policy', () => {
  for (const tier of TIERS) {
    const required = requiredJobs(tier);
    for (const gate of ['actor-check', 'brain-writes-reviewed']) {
      assert.ok(
        required.includes(gate),
        `${gate} must be required at ${tier} post-Phase-5 (matrix declares it required at every tier)`
      );
    }
  }
  assert.ok(!requiredJobs('lite').includes('phase-order'), 'phase-order stays detection at lite by design (proportionality), not PENDING_PROMOTION');
  assert.ok(requiredJobs('standard').includes('phase-order'), 'phase-order is required at standard post-Phase-5');
  assert.ok(requiredJobs('regulated').includes('phase-order'), 'phase-order is required at regulated post-Phase-5');
});

// ── REQ-TIER-10 — governance.tier defaults to standard ──────────────────────

test('REQ-TIER-10: resolveTier defaults to "standard" when governance.tier is absent', () => {
  assert.equal(resolveTier({}), 'standard');
  assert.equal(resolveTier(undefined), 'standard');
  assert.equal(resolveTier({ governance: {} }), 'standard');
});

test('REQ-TIER-10: a default of "lite" is forbidden — absence never resolves to lite', () => {
  assert.notEqual(resolveTier({}), 'lite');
});

// ── tierParams — §2.C doctrine parameters ───────────────────────────────────

test('tierParams: diffBudget matches design §2.C (1000/400/200)', () => {
  assert.equal(tierParams('lite').diffBudget, 1000);
  assert.equal(tierParams('standard').diffBudget, 400);
  assert.equal(tierParams('regulated').diffBudget, 200);
});

test('tierParams: size:exception honored at lite/standard, refused at regulated (REQ-TIER-6)', () => {
  assert.equal(tierParams('lite').honorSizeException, true);
  assert.equal(tierParams('standard').honorSizeException, true);
  assert.equal(tierParams('regulated').honorSizeException, false);
});

test('tierParams: override:* honored at lite/standard, refused at regulated (REQ-TIER-6)', () => {
  assert.equal(tierParams('lite').honorOverride, true);
  assert.equal(tierParams('standard').honorOverride, true);
  assert.equal(tierParams('regulated').honorOverride, false);
});

test('tierParams: standard keeps all four artefacts; regulated adds a recorded verification artefact (design §3 ratified)', () => {
  assert.deepEqual(tierParams('standard').artefacts, ['proposal', 'spec', 'design', 'tasks']);
  assert.deepEqual(tierParams('regulated').artefacts, ['proposal', 'spec', 'design', 'tasks', 'verification']);
  assert.deepEqual(tierParams('lite').artefacts, ['spec']);
});

test('tierParams: unknown tier throws', () => {
  assert.throws(() => tierParams('enterprise'), /unknown tier/);
});

// ── the tier answers the approval question, and nothing else (#743) ─────────
//
// The pin that stood here asserted the tiered `/1` → `/2` default. The
// 2026-08-20 ruling on #743 retired it by name, so it is gone rather than
// adjusted: its property was that the TIER decides the protocol.
//
// What replaces it is the guard #743 asks for as acceptance criterion 5, and it
// is the more useful of the two — it fails when the drift RETURNS, which is the
// failure mode this ticket exists for. The previous instance was added by an
// agent extending the very ADR that forbids it, and no test noticed.

test('#743: tierParams carries no parameter of the review system', () => {
  const FORBIDDEN = ['reviewProtocol', 'inferentialEnabled', 'challengerAxis'];
  for (const tier of TIERS) {
    for (const k of FORBIDDEN) {
      assert.ok(!(k in tierParams(tier)),
        `tier "${tier}" carries "${k}". The tiers answer ONE question — can this team ` +
        'satisfy an approval requirement (#329) — and ADR-0026 invariant 7 forbids ' +
        'position tiering from reaching correctness. The review system is configured ' +
        'by reviewer.* in brain.config.json, never here.');
    }
  }
});

test('#743: every tier still answers the approval question it exists for', () => {
  // The complement, and the reason the guard above is not just "keep the table
  // small": what SURVIVED the narrowing has to still be there. A guard that only
  // forbids would pass on an empty table.
  for (const tier of TIERS) {
    const p = tierParams(tier);
    for (const k of ['requiredReviews', 'memoryAssertion', 'diffBudget', 'artefacts']) {
      assert.ok(k in p, `tier "${tier}" lost "${k}" — that one answers the approval question`);
    }
  }
});

// ── resolveGatePolicy / resolveGateEvidence — unknown tier fails closed ─────

test('resolveGatePolicy/resolveGateEvidence throw on an unknown tier for a known gate', () => {
  assert.throws(() => resolveGatePolicy('issue-link', 'enterprise'), /issue-link/);
  assert.throws(() => resolveGateEvidence('issue-link', 'enterprise'), /issue-link/);
});

// ── CLI printer — REQ-TIER-9 (no second budget literal) ─────────────────────

test('printDiffBudget prints the tier-resolved budget as a string', () => {
  assert.equal(printDiffBudget(() => ({ governance: { tier: 'lite' } })), '1000');
  assert.equal(printDiffBudget(() => ({ governance: { tier: 'regulated' } })), '200');
  assert.equal(printDiffBudget(() => ({})), '400');
});

test('printDiffBudget propagates the fail-closed throw on an unknown tier', () => {
  assert.throws(() => printDiffBudget(() => ({ governance: { tier: 'enterprise' } })), /governance\.tier/);
});

// ── Drift-guard against the real governance.yml (mirrors governance-checks.test.mjs) ──

test('drift-guard: GATE_MATRIX keys match governance.yml job names exactly', () => {
  const yamlPath = resolve(REPO_ROOT, '.github/workflows/governance.yml');
  const yamlText = readFileSync(yamlPath, 'utf8');
  const matches = [...yamlText.matchAll(/^    name: (\S+)\s*$/mg)];
  const yamlJobNames = matches.map(m => m[1]);

  assert.deepEqual(
    [...new Set(yamlJobNames)].sort(),
    [...new Set(Object.keys(GATE_MATRIX))].sort(),
    `Drift detected: GATE_MATRIX keys=${JSON.stringify(Object.keys(GATE_MATRIX))} ` +
    `but governance.yml job names=${JSON.stringify(yamlJobNames)}`
  );
});

// ── #442: the reviewer protocol is separable from the tier ───────────────────
//
// `/2` is `regulated`'s default and brain cannot declare `regulated` — at that tier
// `actor-check` wants an approver distinct from the author who authored no commit on
// the branch, unsatisfiable at n=1 (#329, the contradiction ADR-0026 resolves). The
// override is what lets `/2` be DOGFOODED without moving a single gate.

test('#743: with nothing declared, every repo gets /2 — one produced protocol', () => {
  // This test used to assert the opposite: that each tier returned ITS OWN
  // default, byte-identical to pre-#442. The ruling made the tier stop having
  // one. The absent/null shapes still matter — they are the ones a real
  // brain.config.json produces — so they are kept and pointed at the new answer.
  for (const shape of [{}, undefined, { reviewer: {} }, { reviewer: { protocol: null } }]) {
    assert.equal(resolveReviewProtocol(shape), PRODUCED_PROTOCOL,
      `${JSON.stringify(shape)} must resolve to the one produced protocol`);
  }
  assert.equal(PRODUCED_PROTOCOL, 'brain-review/2', 'and that protocol is /2 (#743 ruling)');

  // `/1` stays READABLE — the parsers must keep reading a history of /1 blocks,
  // which is what makes `rev` and the anti-loop lock work on older PRs. Retired
  // as an output, never as an input.
  assert.ok(REVIEW_PROTOCOLS.includes('brain-review/1'),
    'brain-review/1 must remain parseable — every verdict already posted is one');
});

test('#442: an explicit protocol wins at EVERY tier — the tier sets a default, not a ceiling', () => {
  // T2.3 design §3.4, quoted in this module's own TIER_PARAMS docstring.
  for (const tier of TIERS) {
    assert.equal(resolveReviewProtocol({ reviewer: { protocol: 'brain-review/2' } }), 'brain-review/2');
    assert.equal(resolveReviewProtocol({ reviewer: { protocol: 'brain-review/1' } }), 'brain-review/1');
  }
  assert.equal(resolveReviewProtocol({ reviewer: { protocol: 'brain-review/1' } }), 'brain-review/1',
    'downward too — a ceiling in either direction would be a rule this doctrine does not have');
});

test('#442: an unknown protocol THROWS — it never falls back to the tier default', () => {
  // Falling back would hand the operator a /1 verdict while they believed they had
  // /2, silently dropping causal admission. Same fail-closed shape as resolveTier.
  assert.throws(() => resolveReviewProtocol({ reviewer: { protocol: 'brain-review/3' } }), /unknown reviewer\.protocol/);
  assert.throws(() => resolveReviewProtocol({ reviewer: { protocol: '' } }), /unknown reviewer\.protocol/);
  assert.throws(() => resolveReviewProtocol({ reviewer: { protocol: 'brain-review/2 ' } }), /unknown reviewer\.protocol/,
    'a trailing space is a typo, not a dialect');
});

test('brain\'s OWN config resolves to /2 — and no longer needs to ask', () => {
  // #442 made this line an OVERRIDE: `lite` defaulted to /1 and brain.config.json
  // asked for /2 so brain could dogfood it. After #743 the same result arrives
  // with nobody asking, so what this guards has changed and the assertion says so
  // rather than quietly meaning something else.
  const config = JSON.parse(readFileSync(resolve(REPO_ROOT, 'brain.config.json'), 'utf8'));
  assert.equal(resolveTier(config), 'lite', 'brain stays at lite — the tier moves no gate here');
  assert.equal(resolveReviewProtocol(config), 'brain-review/2');

  // And the point #442 actually defended, which outlives it: removing the line
  // from brain.config.json must not change what brain produces. It cannot now —
  // there is nothing left to fall back TO.
  const withoutTheLine = { ...config, reviewer: { ...config.reviewer, protocol: undefined } };
  assert.equal(resolveReviewProtocol(withoutTheLine), 'brain-review/2',
    'dropping reviewer.protocol must leave brain producing /2, not fall back to /1');
});

// ── #1072: ONE ruling on size:exception, read by both authorities ──────────
// Measured on PR #1067: the `diff-size` CI gate passed (the label is present
// and `lite` carries `honorSizeException: true`) while the cold reviewer
// emitted a `blocker` on the same number eight seconds later, because
// `evaluators/tranche.mjs` read `tierParams(tier).diffBudget` and never read
// the label at all. A budget decision readable two ways from two files is not
// a policy, it is a contradiction. This function is the one reading.
test('#1072: the label is honored where the tier honors it, refused where it does not, and absent is absent', () => {
  assert.equal(SIZE_EXCEPTION_LABEL, 'size:exception', 'one spelling, imported — never retyped at a call site');

  const honored = sizeExceptionRuling({ labels: ['size:exception', 'type:feature'], tier: 'lite' });
  assert.deepEqual(honored, { present: true, honored: true, refusedByTier: false });

  // REQ-TIER-6: a tier that refuses the waiver must SAY the label was present
  // and refused, never behave as though nobody asked.
  const refused = sizeExceptionRuling({ labels: ['size:exception'], tier: 'regulated' });
  assert.deepEqual(refused, { present: true, honored: false, refusedByTier: true });

  const absent = sizeExceptionRuling({ labels: ['type:feature'], tier: 'lite' });
  assert.deepEqual(absent, { present: false, honored: false, refusedByTier: false });
});

test('#1072: no labels at all is the same as no exception, and never throws', () => {
  for (const labels of [undefined, null, [], 'not-an-array', {}]) {
    const ruling = sizeExceptionRuling({ labels, tier: 'lite' });
    assert.deepEqual(ruling, { present: false, honored: false, refusedByTier: false },
      `a label set the reviewer could not read is not a waiver (${JSON.stringify(labels)})`);
  }
});

test('#1072: every tier answers, and the answer agrees with its own honorSizeException flag', () => {
  for (const tier of TIERS) {
    const ruling = sizeExceptionRuling({ labels: ['size:exception'], tier });
    assert.equal(ruling.honored, tierParams(tier).honorSizeException === true,
      `the ruling for "${tier}" must be the tier's own flag, not a second opinion about it`);
    assert.equal(ruling.present, true);
    assert.equal(ruling.refusedByTier, !ruling.honored);
  }
});
