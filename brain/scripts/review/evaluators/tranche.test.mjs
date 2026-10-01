// tranche.test.mjs — Unit tests for REQ-H1-8: the tranche evaluator (design.md
// §2, §4). No test spawns a real gh/git process — `evaluateTranche` is pure;
// `gatherTrancheInputs` injects `fetchRollup` / `diffNumstat` / `readIgnoreList`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTranche, gatherTrancheInputs } from './tranche.mjs';
import { REQUIRED_JOBS, DETECTION_JOBS } from '../../vcs/governance-checks.mjs';
import { TIERS } from '../../vcs/governance-tiers.mjs';
import { uncomputable } from '../../vcs/lib/uncomputable-cause.mjs';

function greenRollup() {
  return [
    ...REQUIRED_JOBS.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
    ...DETECTION_JOBS.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
  ];
}

// ── evaluateTranche (pure core) ──────────────────────────────────────────────

test('evaluateTranche: all required gates green, budget within limit → APPROVE, no findings', () => {
  const result = evaluateTranche({
    requiredGates: greenRollup(),
    changedFiles: ['brain/scripts/review/evaluators/tranche.mjs'],
    budget: { lines: 120, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' },
    prBody: 'Adds the tranche evaluator.',
  });
  assert.equal(result.conclusion, 'APPROVE');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.gates.required, REQUIRED_JOBS);
});

test('evaluateTranche: a required gate is not success → blocker finding with evidence + cites', () => {
  const rollup = greenRollup().map(g => (g.name === 'memory-gate' ? { ...g, conclusion: 'FAILURE' } : g));
  const result = evaluateTranche({ requiredGates: rollup, changedFiles: [], budget: { lines: 0, uncomputable: false } });
  assert.equal(result.conclusion, 'REVISE');
  const finding = result.findings.find(f => f.id === 'gate:memory-gate');
  assert.ok(finding, 'expected a finding for the failing required gate');
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /memory-gate/);
  assert.match(finding.evidence, /FAILURE/);
  assert.ok(finding.cites, 'a blocker finding MUST carry cites (protocol §6)');
});

test('evaluateTranche: a required gate absent from the rollup entirely → blocker finding', () => {
  const rollup = greenRollup().filter(g => g.name !== 'decision-gate');
  const result = evaluateTranche({ requiredGates: rollup, changedFiles: [], budget: { lines: 0, uncomputable: false } });
  const finding = result.findings.find(f => f.id === 'gate:decision-gate');
  assert.ok(finding);
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /not present in rollup/);
});

test('evaluateTranche: null (uncomputable) rollup → REVISE, conditions include "evidence uncomputable", never APPROVE', () => {
  const result = evaluateTranche({ requiredGates: null, changedFiles: [], budget: { lines: 0, uncomputable: false } });
  assert.equal(result.conclusion, 'REVISE');
  assert.ok(result.conditions.includes('evidence uncomputable'));
  assert.deepEqual(result.findings, []);
});

// ── #606: the rollup names its cause without moving the verdict ────────────

test('evaluateTranche: a recognized-cause uncomputable rollup names the cause and quotes detail verbatim (#606)', () => {
  const rollup = uncomputable({ detail: 'gh: API rate limit exceeded (HTTP 403)' });
  const result = evaluateTranche({ requiredGates: rollup, changedFiles: [], budget: { lines: 0, uncomputable: false } });
  assert.equal(result.conclusion, 'REVISE');
  assert.equal(result.conditions.includes('evidence uncomputable'), false,
    'the bare unexplained string must no longer appear once a cause is available');
  assert.ok(
    result.conditions.some(c => c.includes('rate-limited') && c.includes('gh: API rate limit exceeded (HTTP 403)')),
    `expected a condition naming the cause and quoting the detail, got: ${JSON.stringify(result.conditions)}`,
  );
});

test('evaluateTranche: an unclassified-cause uncomputable rollup still quotes the provider\'s words verbatim (#606)', () => {
  const message = 'gh: the flurb subsystem declined to enumerate the rollup (HTTP 418)';
  const rollup = uncomputable({ detail: message });
  const result = evaluateTranche({ requiredGates: rollup, changedFiles: [], budget: { lines: 0, uncomputable: false } });
  assert.equal(result.conclusion, 'REVISE');
  assert.ok(
    result.conditions.some(c => c.includes('unclassified') && c.includes(message)),
    `expected a condition naming 'unclassified' and quoting the message, got: ${JSON.stringify(result.conditions)}`,
  );
});

// M3b (design.md §3.2b, §7): the mutation that deletes ` — ${rollup.detail}`
// from tranche.mjs's condition template leaves the classifier and the
// factory perfect and STILL robs the operator of the words — the loss
// happens in THIS renderer. This is the ONLY test that catches it; a design
// tested only at the factory (uncomputable-cause.test.mjs) survives it.
test("evaluateTranche: a classifier that recognises NOTHING still leaves the operator the provider's words (#606 ruling 3, M3b)", () => {
  const ROTTABLE_CORPUS = [
    'gh: API rate limit exceeded (HTTP 403)',
    'gh pr view 1 --repo octocat/Hello-World --json statusCheckRollup failed (status 1): HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login\n',
    'gh pr view 999999999 --repo octocat/Hello-World --json statusCheckRollup failed (status 1): GraphQL: Could not resolve to a PullRequest with the number of 999999999. (repository.pullRequest)\n',
    'glab api /user failed (status null): glab: spawnSync glab ENOENT',
    'fetch failed',
    'GitLab API failed: 503 (projects/x%2Fy/merge_requests/1)',
  ];
  for (const message of ROTTABLE_CORPUS) {
    // A rotted classifier's ENTIRE blast radius is `reason: 'unclassified'`
    // (design §3.1) — constructed directly here, with real corpus messages.
    const rotted = Object.freeze({ uncomputable: true, reason: 'unclassified', detail: message });
    const result = evaluateTranche({ requiredGates: rotted, changedFiles: [], budget: { lines: 0, uncomputable: false } });
    assert.equal(result.conclusion, 'REVISE', 'a rotted classifier must not move the verdict');
    assert.ok(
      result.conditions.some(c => c.includes(message)),
      `the provider's words must reach conditions verbatim: ${message}`,
    );
  }
});

// M5a (design.md §7): the guard MUST stay `Array.isArray`, never a
// truthiness check — the #606 cause object is TRUTHY, so `!requiredGates`
// would fall through into `requiredGates.map` and throw.
test('evaluateTranche: a truthy non-array requiredGates never falls through to .map and throws (#606, M5a)', () => {
  const rollup = uncomputable({ detail: 'gh: API rate limit exceeded (HTTP 403)' });
  assert.ok(rollup, 'sanity: the uncomputable object is truthy');
  assert.doesNotThrow(() => {
    const result = evaluateTranche({ requiredGates: rollup, changedFiles: [], budget: { lines: 0, uncomputable: false } });
    assert.equal(result.conclusion, 'REVISE');
  });
});

test('evaluateTranche: budget uncomputable (no baseSha resolvable) → fail-closed REVISE, never APPROVE', () => {
  const result = evaluateTranche({ requiredGates: greenRollup(), changedFiles: [], budget: { uncomputable: true } });
  assert.equal(result.conclusion, 'REVISE');
  assert.ok(result.conditions.some(c => /evidence uncomputable/.test(c)));
});

test('evaluateTranche: budget re-derived over 400 lines → blocker finding quoting the diff command, even if a report would have claimed less', () => {
  const result = evaluateTranche({
    requiredGates: greenRollup(),
    changedFiles: [],
    budget: { lines: 610, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' },
  });
  assert.equal(result.conclusion, 'REVISE');
  const finding = result.findings.find(f => f.id === 'budget');
  assert.ok(finding);
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /git diff --numstat/);
  assert.match(finding.evidence, /610/);
});

test('evaluateTranche: actor-check (promoted to required in issue #358 Q5 Phase 5) failing is a BLOCKER, never editorial', () => {
  const rollup = greenRollup().map(g => (g.name === 'actor-check' ? { ...g, status: 'COMPLETED', conclusion: 'FAILURE' } : g));
  const result = evaluateTranche({ requiredGates: rollup, changedFiles: [], budget: { lines: 0, uncomputable: false } });
  const finding = result.findings.find(f => f.id === 'gate:actor-check');
  assert.ok(finding, 'expected a blocker finding for the now-required actor-check gate');
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /actor-check/);
  assert.match(finding.evidence, /FAILURE/);
  assert.equal(result.conclusion, 'REVISE');
});

// NOTE (issue #358 Q5 Phase 5): DETECTION_JOBS (governance-checks.mjs, derived
// from requiredJobs('standard')) is currently EMPTY — Phase 5 promoted
// phase-order/actor-check/brain-writes-reviewed, so every GOVERNANCE_JOBS
// gate is now required at the default 'standard' tier. The editorial-finding
// branch below (`detection:${name}`) is therefore presently unreachable via
// real gate data; it stays correct dead code for the day a future gate is
// staged through PENDING_PROMOTION again (governance-tiers.mjs).
test("evaluateTranche: DETECTION_JOBS is currently empty (Q5 Phase 5 promoted every gate to required at 'standard') — no editorial findings are produced", () => {
  assert.deepEqual(DETECTION_JOBS, []);
  const result = evaluateTranche({ requiredGates: greenRollup(), changedFiles: [], budget: { lines: 0, uncomputable: false } });
  assert.deepEqual(result.gates.detection, []);
});

test('evaluateTranche: an agent-authored write to the Tier-2 frontier is flagged', () => {
  const result = evaluateTranche({
    requiredGates: greenRollup(),
    changedFiles: ['brain/core/methodology/reviewer-protocol.md', 'brain/scripts/review/evaluators/tranche.mjs'],
    budget: { lines: 10, uncomputable: false },
  });
  const finding = result.findings.find(f => f.id === 'tier2-frontier');
  assert.ok(finding);
  assert.match(finding.evidence, /brain\/core\/methodology\/reviewer-protocol\.md/);
});

test('evaluateTranche: an AI-attribution trailer in the PR body is flagged', () => {
  const result = evaluateTranche({
    requiredGates: greenRollup(),
    changedFiles: [],
    budget: { lines: 10, uncomputable: false },
    prBody: 'Fixes the bug.\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
  });
  const finding = result.findings.find(f => f.id === 'ai-attribution');
  assert.ok(finding);
  assert.equal(finding.severity, 'editorial');
});

// ── gatherTrancheInputs (DI-seam) ────────────────────────────────────────────

test('gatherTrancheInputs: wires the rollup via the injected fetchRollup seam, never touches the network', async () => {
  let called = 0;
  const inputs = await gatherTrancheInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    baseSha: 'BASE',
    changedFiles: ['a.mjs'],
    prBody: 'x',
    deps: {
      fetchRollup: async () => { called++; return greenRollup(); },
      diffNumstat: () => '10\t5\ta.mjs\n',
      readIgnoreList: () => [],
    },
  });
  assert.equal(called, 1);
  assert.equal(inputs.budget.lines, 15);
  assert.equal(inputs.budget.uncomputable, false);
});

test('gatherTrancheInputs: absent baseSha → budget is uncomputable, diffNumstat is never invoked', async () => {
  let diffCalled = false;
  const inputs = await gatherTrancheInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    baseSha: null,
    changedFiles: [],
    deps: {
      fetchRollup: async () => greenRollup(),
      diffNumstat: () => { diffCalled = true; return ''; },
    },
  });
  assert.equal(inputs.budget.uncomputable, true);
  assert.equal(diffCalled, false);
});

test('gatherTrancheInputs: fetchRollup returning null propagates as the uncomputable rollup', async () => {
  const inputs = await gatherTrancheInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    baseSha: 'BASE',
    changedFiles: [],
    deps: {
      fetchRollup: async () => null,
      diffNumstat: () => '',
      readIgnoreList: () => [],
    },
  });
  assert.equal(inputs.requiredGates, null);
});

test('gatherTrancheInputs: ignoreList from readIgnoreList excludes matched paths from the budget count', async () => {
  const inputs = await gatherTrancheInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    baseSha: 'BASE',
    changedFiles: [],
    deps: {
      fetchRollup: async () => greenRollup(),
      diffNumstat: () => '100\t0\tfoo.test.mjs\n5\t0\tbar.mjs\n',
      readIgnoreList: () => ['**/*.test.mjs'],
    },
  });
  assert.equal(inputs.budget.lines, 5);
});

// ── gatherTrancheInputs: tier-scoped job sets (issue #358 Q5 Phase 5 review finding 2) ──
//
// REQUIRED_JOBS/DETECTION_JOBS (governance-checks.mjs) are a 'standard'-tier
// snapshot — stale for any repo declaring a different tier. gatherTrancheInputs
// must resolve requiredJobs/detectionJobs from the repo's OWN declared tier,
// never fall back to the stale snapshot silently.

test('gatherTrancheInputs: deps.tier="lite" resolves requiredJobs/detectionJobs from the tier matrix — actor-check/brain-writes-reviewed stay required, memory-gate/phase-order demote to detection', async () => {
  const inputs = await gatherTrancheInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    baseSha: 'BASE',
    changedFiles: [],
    deps: {
      fetchRollup: async () => greenRollup(),
      diffNumstat: () => '',
      readIgnoreList: () => [],
      tier: 'lite',
    },
  });
  assert.equal(inputs.tier, 'lite');
  assert.deepEqual(inputs.detectionJobs, ['memory-gate', 'phase-order']);
  assert.ok(inputs.requiredJobs.includes('actor-check'));
  assert.ok(inputs.requiredJobs.includes('brain-writes-reviewed'));
  assert.ok(!inputs.requiredJobs.includes('phase-order'));
});

test('gatherTrancheInputs: deps.readConfig overrides the tier source (no deps.tier) — resolves through resolveTier', async () => {
  const inputs = await gatherTrancheInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    baseSha: 'BASE',
    changedFiles: [],
    deps: {
      fetchRollup: async () => greenRollup(),
      diffNumstat: () => '',
      readIgnoreList: () => [],
      readConfig: () => ({ governance: { tier: 'regulated' } }),
    },
  });
  assert.equal(inputs.tier, 'regulated');
  assert.deepEqual(inputs.detectionJobs, []);
});

test('evaluateTranche: fed lite-tier job sets, a red memory-gate is editorial (detection), never a blocker', () => {
  const rollup = greenRollup().map(g => (g.name === 'memory-gate' ? { ...g, conclusion: 'FAILURE' } : g));
  const result = evaluateTranche({
    requiredGates: rollup,
    changedFiles: [],
    budget: { lines: 0, uncomputable: false },
    requiredJobs: ['issue-link', 'diff-size', 'local-checks', 'decision-gate', 'actor-check', 'brain-writes-reviewed'],
    detectionJobs: ['memory-gate', 'phase-order'],
  });
  const finding = result.findings.find(f => f.id === 'detection:memory-gate');
  assert.ok(finding, 'expected an editorial finding for memory-gate at the lite-tier detection policy');
  assert.equal(finding.severity, 'editorial');
  assert.equal(result.findings.some(f => f.id === 'gate:memory-gate'), false, 'memory-gate must not ALSO be counted as a blocker');
});

// ── issue #443: the diff budget is the TIER's budget ─────────────────────────
//
// ADR-0026 tiered the budget (lite 1000 · standard 400 · regulated 200) and every
// other consumer reads it through governance-tiers.mjs. This evaluator carried its
// own `const LINE_BUDGET = 400` — correct at `standard` BY COINCIDENCE, which is
// exactly why 2470 tests never saw it: every tranche fixture above (and in
// cli.test.mjs) sits at the one tier where the hardcode is right.
//
// These cases go through `gatherTrancheInputs`, not straight into the pure core,
// because the defect IS the gather: it resolves the tier for the job sets and then
// drops it before the budget. Injecting `diffBudget` by hand into `evaluateTranche`
// would test a wiring that production never performs.

/**
 * Gathers + evaluates at a tier with a synthetic numstat of `lines` changed
 * lines.
 *
 * `labels: []` is deliberate and load-bearing (#1072): these tests are about
 * the TIER's contribution to the evidence text, so the PR they describe is one
 * that WAS read and carries no exception. Leaving it out would make them
 * describe a PR whose labels could not be read, which is a different fact and
 * carries a different sentence — and would quietly turn every tier assertion
 * into an assertion about the unread case instead.
 */
async function trancheAtTier(tier, lines) {
  const inputs = await gatherTrancheInputs({
    project: 'owner/repo',
    number: 1,
    headSha: 'HEAD',
    baseSha: 'BASE',
    labels: [],
    deps: {
      tier,
      fetchRollup: async () => greenRollup(),
      diffNumstat: () => `${lines}\t0\tbig.txt\n`,
      readIgnoreList: () => [],
    },
  });
  return { inputs, result: evaluateTranche(inputs), budgetFinding: evaluateTranche(inputs).findings.find(f => f.id === 'budget') };
}

test('gatherTrancheInputs→evaluateTranche: at regulated (budget 200) a 250-line diff is a BLOCKER — the reviewer must not approve what doctrine forbids (#443)', async () => {
  const { result, budgetFinding } = await trancheAtTier('regulated', 250);
  assert.ok(budgetFinding, 'no budget finding at regulated/250 — this is the #443 false negative, on the one tier that pays for /2');
  assert.equal(budgetFinding.severity, 'blocker');
  assert.equal(result.conclusion, 'REVISE');
});

test('gatherTrancheInputs→evaluateTranche: at regulated, 199 lines stays silent — the threshold is real, not a constant that happens to sit below every input (#443)', async () => {
  const { result, budgetFinding } = await trancheAtTier('regulated', 199);
  assert.equal(budgetFinding, undefined);
  assert.equal(result.conclusion, 'APPROVE');
});

test('gatherTrancheInputs→evaluateTranche: at lite (budget 1000) a 500-line diff is NOT flagged — flagging what governance allows erodes the verdict (#443)', async () => {
  const { result, budgetFinding } = await trancheAtTier('lite', 500);
  assert.equal(budgetFinding, undefined, 'a budget finding at lite/500 is the #443 false positive: governance allows 1000 here');
  assert.equal(result.conclusion, 'APPROVE');
});

test('gatherTrancheInputs→evaluateTranche: at lite, 1001 lines IS flagged — proven from both sides (#443)', async () => {
  const { budgetFinding } = await trancheAtTier('lite', 1001);
  assert.ok(budgetFinding, 'lite has a budget too — 1000, not infinity');
  assert.equal(budgetFinding.severity, 'blocker');
});

test('gatherTrancheInputs: standard keeps the pre-#443 DECISION — the no-op guarantee (REQ-443-2, REQ-TIER-10)', async () => {
  // `standard` is where the hardcode was CORRECT, so "the suite still passes at
  // standard" carries no information about this change. Pin the value and the
  // boundary explicitly instead.
  const { inputs } = await trancheAtTier('standard', 401);
  assert.equal(inputs.diffBudget, 400, 'standard must still resolve to 400 — this change is a no-op at the default tier');
  const over = await trancheAtTier('standard', 401);
  assert.ok(over.budgetFinding, '401 > 400 still flags');
  assert.equal(over.budgetFinding.severity, 'blocker');
  assert.equal(over.result.conclusion, 'REVISE');
  assert.equal((await trancheAtTier('standard', 400)).budgetFinding, undefined, '400 is within budget, as before');
});

test('gatherTrancheInputs: standard\'s evidence TEXT does change, and that is REQ-443-4 applying at every tier (REQ-443-2)', async () => {
  // The cold review of PR #471 found REQ-443-2's first draft claiming the evidence
  // string was unchanged at standard — contradicting REQ-443-4 in the same document
  // and false against the code. `standard` is the tier every consumer who never
  // declared `governance.tier` inherits, so the text they see on a posted verdict is
  // a real (intended) change and belongs under assertion, not under a claim.
  // On main this read: `… = 401` with cites `governance.yml diff-size gate (400-line budget)`.
  const { budgetFinding } = await trancheAtTier('standard', 401);
  assert.equal(budgetFinding.evidence,
    'git diff --numstat BASE...HEAD | diff-size-count.mjs = 401 > 400 (tier: standard)');
  assert.equal(budgetFinding.cites, 'governance-tiers.mjs tierParams(tier).diffBudget');
});

test('evaluateTranche: the budget finding cites the tiered resolver and shows the comparison — never a hardcoded "(400-line budget)" it did not apply (REQ-443-4)', async () => {
  const { budgetFinding } = await trancheAtTier('regulated', 250);
  assert.match(budgetFinding.cites, /governance-tiers\.mjs tierParams\(tier\)\.diffBudget/,
    'cites must name the resolver, mirroring the gate finding\'s `governance-tiers.mjs requiredJobs(tier)`');
  assert.doesNotMatch(budgetFinding.cites, /400/,
    'a citation naming 400 while the evaluator applied 200 is a review defect in its own right');
  assert.match(budgetFinding.evidence, /git diff --numstat/, 'the command stays quoted (protocol §10)');
  assert.match(budgetFinding.evidence, /250 > 200/, 'the reader must be able to check the arithmetic without knowing the tier table');
  assert.match(budgetFinding.evidence, /regulated/, 'and must be able to see WHICH tier produced that budget');
});

test('gatherTrancheInputs: diffBudget rides the SAME tier resolution as the job sets — one config read, one tier, no drift (#443)', async () => {
  const inputs = await gatherTrancheInputs({
    project: 'owner/repo', number: 1, headSha: 'HEAD', baseSha: 'BASE',
    deps: {
      fetchRollup: async () => greenRollup(),
      diffNumstat: () => '',
      readIgnoreList: () => [],
      readConfig: () => ({ governance: { tier: 'regulated' } }),
    },
  });
  assert.equal(inputs.tier, 'regulated');
  assert.equal(inputs.diffBudget, 200, 'resolved from readConfig, exactly like requiredJobs/detectionJobs above it');
});

test('evaluateTranche: a caller that skips the gather seam gets the standard-tier budget — the same tier its job-set defaults use (REQ-443-3)', () => {
  const result = evaluateTranche({
    requiredGates: greenRollup(),
    changedFiles: [],
    budget: { lines: 401, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' },
  });
  assert.ok(result.findings.find(f => f.id === 'budget'),
    'the default must stay standard/400 — a standard job set judged against a lite budget would be an incoherent doctrine');
});

// ── #750: every return path declares conclusionCauses ──────────────────────
//
// REQ-750-1. `buildVerdict`'s softening cannot read WHY an evaluator said
// REVISE unless the evaluator says so on every exit — these three pins cover
// tranche.mjs's three return statements (:154-166, :192-202, :249-251).

test('evaluateTranche: rollup not an array → conclusionCauses is [\'uncomputable\'] (#750)', () => {
  const result = evaluateTranche({ requiredGates: null, changedFiles: [], budget: { lines: 0, uncomputable: false } });
  assert.deepEqual(result.conclusionCauses, ['uncomputable']);
});

test('evaluateTranche: budget uncomputable with no blocker finding already pushed → conclusionCauses is [\'uncomputable\'] only (#750)', () => {
  const result = evaluateTranche({ requiredGates: greenRollup(), changedFiles: [], budget: { uncomputable: true } });
  assert.deepEqual(result.conclusionCauses, ['uncomputable'],
    'every required gate is green, so no blocker finding exists yet when the budget check returns early');
});

test('evaluateTranche: budget uncomputable WITH a blocker finding already pushed → conclusionCauses contains BOTH (#750)', () => {
  const rollup = greenRollup().filter(g => g.name !== 'decision-gate');
  const result = evaluateTranche({ requiredGates: rollup, changedFiles: [], budget: { uncomputable: true } });
  assert.deepEqual([...result.conclusionCauses].sort(), ['blocker', 'uncomputable'],
    'the missing required gate pushed a blocker BEFORE the budget check runs — both causes contributed');
});

test('evaluateTranche: normal exit with a blocker finding → conclusionCauses is [\'blocker\'] (#750)', () => {
  const rollup = greenRollup().map(g => (g.name === 'memory-gate' ? { ...g, conclusion: 'FAILURE' } : g));
  const result = evaluateTranche({ requiredGates: rollup, changedFiles: [], budget: { lines: 0, uncomputable: false } });
  assert.deepEqual(result.conclusionCauses, ['blocker']);
});

test('evaluateTranche: normal exit with no blocker finding → conclusionCauses is [] (#750)', () => {
  const result = evaluateTranche({
    requiredGates: greenRollup(),
    changedFiles: [],
    budget: { lines: 120, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' },
  });
  assert.deepEqual(result.conclusionCauses, []);
});

// ── #1072: the reviewer honors size:exception exactly as the gate does ──────
// Measured on PR #1067: `diff-size` passed at 13:0x and the cold reviewer
// emitted `budget / blocker` on the same 3,101 lines eight seconds later. The
// gate read the label; this evaluator read `tierParams(tier).diffBudget` and
// never read the label at all — one field of the tier's frozen params, with
// its sibling `honorSizeException` ignored. The maintainer's ruling: honor it
// as the gate does.

test('#1072: over budget with size:exception at a tier that honors it → no blocker, and the waiver is SAID', () => {
  const result = evaluateTranche({
    requiredGates: greenRollup(),
    changedFiles: ['brain/scripts/ui/static/app.js'],
    budget: { lines: 3101, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' },
    diffBudget: 1000,
    tier: 'lite',
    labels: ['size:exception', 'type:feature'],
  });

  assert.ok(!result.findings.some((f) => f.id === 'budget' && f.severity === 'blocker'),
    'the gate waived this exact number; the reviewer may not block on it');

  // Waiving is not forgetting. The repository refuses an empty area where a
  // fact belongs, and 3,101 lines waived is a fact.
  const waived = result.findings.find((f) => f.id === 'budget');
  assert.ok(waived, 'the budget is still reported');
  assert.equal(waived.severity, 'editorial', 'stated, not blocking');
  assert.match(waived.evidence, /3101 > 1000/, 'with the number it waived');
  assert.match(waived.evidence, /size:exception/, 'and the label that waived it');
  assert.match(waived.evidence, /lite/, 'and the tier that honored it');
});

test('#1072: over budget with size:exception at a tier that REFUSES it → still a blocker, and it says the tier refused', () => {
  const result = evaluateTranche({
    requiredGates: greenRollup(),
    changedFiles: [],
    budget: { lines: 300, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' },
    diffBudget: 200,
    tier: 'regulated',
    labels: ['size:exception'],
  });

  const finding = result.findings.find((f) => f.id === 'budget');
  assert.ok(finding);
  assert.equal(finding.severity, 'blocker');
  // REQ-TIER-6, the same sentence `run-check.mjs` produces: the label WAS
  // present and the tier is what refused it. Silence here would read as "no
  // exception was asked for", which is a different fact.
  assert.match(finding.evidence, /not honored at the "regulated" tier/);
  assert.ok(finding.cites, 'a blocker finding MUST carry cites (protocol §6)');
});

test('#1072: over budget with no label is the blocker it always was', () => {
  const result = evaluateTranche({
    requiredGates: greenRollup(),
    changedFiles: [],
    budget: { lines: 1500, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' },
    diffBudget: 1000,
    tier: 'lite',
    labels: ['type:feature'],
  });

  const finding = result.findings.find((f) => f.id === 'budget');
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /1500 > 1000/);
  assert.ok(!/size:exception/.test(finding.evidence), 'no waiver was asked for, so none is mentioned');
});

test('#1072: labels the reviewer could not read never waive the budget', () => {
  // Granting an exception because a fetch failed is the one direction this
  // must never fail. `gatherTrancheInputs` hands `null` when prView throws.
  for (const labels of [null, undefined, 'size:exception']) {
    const result = evaluateTranche({
      requiredGates: greenRollup(),
      changedFiles: [],
      budget: { lines: 3101, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' },
      diffBudget: 1000,
      tier: 'lite',
      labels,
    });
    const finding = result.findings.find((f) => f.id === 'budget');
    assert.equal(finding.severity, 'blocker',
      `an unreadable label set is not a waiver (${JSON.stringify(labels)})`);
  }
});

test('#1072: labels are an INPUT — the gather never reaches the forge for them', async () => {
  // A fallback fetch was tried here and reverted. It made every existing test
  // that did not pass labels call out to a forge: green on a machine with an
  // authenticated `gh`, red in CI where the call threw and changed a budget
  // finding's evidence string. A unit suite whose result depends on the
  // network is not a unit suite, so the seam is gone and this pins it.
  const forge = () => { throw new Error('the gather must not reach the forge'); };

  const given = await gatherTrancheInputs({
    project: 'o/r', number: 1067, headSha: 'H', baseSha: 'B',
    labels: ['size:exception'],
    deps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '1\t0\tf.mjs\n', readIgnoreList: () => [], readConfig: () => ({}), tier: 'lite', getVcs: forge, prView: forge },
  });
  assert.deepEqual(given.labels, ['size:exception']);

  // None supplied is "not read", which waives nothing — never a lookup.
  const none = await gatherTrancheInputs({
    project: 'o/r', number: 1067, headSha: 'H', baseSha: 'B',
    deps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '1\t0\tf.mjs\n', readIgnoreList: () => [], readConfig: () => ({}), tier: 'lite', getVcs: forge, prView: forge },
  });
  assert.equal(none.labels, null, 'not read, and not an empty list that would claim the PR carries no exception');
});

test('#1073: a budget blocker says whether the labels were UNREAD or genuinely absent', () => {
  const base = {
    requiredGates: greenRollup(),
    changedFiles: [],
    budget: { lines: 1500, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' },
    diffBudget: 1000,
    tier: 'lite',
  };

  // Not read: the forge refused, so nobody knows whether an exception exists.
  const unread = evaluateTranche({ ...base, labels: null }).findings.find((f) => f.id === 'budget');
  assert.equal(unread.severity, 'blocker');
  assert.match(unread.evidence, /labels could not be read/,
    'a block on an unread label set must not be presented as a block on an absent exception');

  // Read, and empty: a real answer. Saying "could not be read" here would be
  // the opposite lie.
  const absent = evaluateTranche({ ...base, labels: [] }).findings.find((f) => f.id === 'budget');
  assert.equal(absent.severity, 'blocker');
  assert.ok(!/could not be read/.test(absent.evidence),
    'the labels WERE read and carry no exception — that is a fact, not a gap');
});

test('#1073 rev 5: the tier a budget sentence names is the tier the ruling was made against', () => {
  // Gemini's finding cold-2. The refused-waiver sentence interpolated a bare
  // `tier` while the ruling and the waived sentence resolved the default, so
  // the two could name different tiers. It is not reachable while
  // `DEFAULT_TIER` honors the waiver — which is exactly why it is pinned
  // structurally rather than guarded: this asserts the OUTCOME for every tier,
  // and the code now resolves once so there is no second spelling to drift.
  for (const tier of [...TIERS, null, undefined]) {
    for (const labels of [[], ['size:exception'], null]) {
      const finding = evaluateTranche({
        requiredGates: greenRollup(),
        changedFiles: [],
        budget: { lines: 5000, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' },
        diffBudget: 1000,
        tier,
        labels,
      }).findings.find((f) => f.id === 'budget');

      assert.ok(finding, `a 5000-line diff is over every tier's budget (${tier})`);
      assert.ok(!/"(null|undefined)"/.test(finding.evidence),
        `the evidence named an unresolved tier: ${finding.evidence}`);
    }
  }
});
