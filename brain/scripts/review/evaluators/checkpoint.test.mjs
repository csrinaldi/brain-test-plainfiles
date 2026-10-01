// checkpoint.test.mjs — Unit tests for REQ-H1-10: the checkpoint evaluator
// (design.md §2). No test spawns a real gh/git process except the ONE
// real-git test for `defaultRunReversion`'s isolation guarantee (mirrors
// cold-boot.test.mjs's COLDBOOT-CWD test) — every other seam is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { evaluateTranche } from './tranche.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  evaluateCheckpoint,
  gatherCheckpointInputs,
  resolveChangeId,
  defaultRunReversion,
} from './checkpoint.mjs';
import { REQUIRED_JOBS, DETECTION_JOBS } from '../../vcs/governance-checks.mjs';
import { TIERS, tierParams } from '../../vcs/governance-tiers.mjs';
import { renderCheckpointClaim } from '../lib/checkpoint-block.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VACUOUS_FIXTURE = join(__dirname, '..', 'fixtures', 'vacuous.test.mjs');

function greenRollup() {
  return [
    ...REQUIRED_JOBS.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
    ...DETECTION_JOBS.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' })),
  ];
}

function greenTrancheInputs(overrides = {}) {
  return { requiredGates: greenRollup(), changedFiles: [], budget: { lines: 10, uncomputable: false, baseSha: 'BASE', headSha: 'HEAD' }, prBody: '', ...overrides };
}

/** A checkpoint report in the DECLARED form (#495) — the only shape read. */
function declared(countedLines, diffBudget) {
  return `# Checkpoint report\n\n${renderCheckpointClaim({ countedLines, diffBudget })}\n`;
}

// ── §10.1 report-vs-tree drift ──────────────────────────────────────────────
//
// THE PARSER THESE TESTS SPECIFIED IS GONE (#495). `parseBudgetClaim` scanned
// the whole report for any `N/M` whose `M` was a budget some tier declares; the
// maintainer ruled that prose is not narrowed but NOT READ, and the claim is now
// declared in a `brain-checkpoint/1` block (`review/lib/checkpoint-block.mjs`).
//
// RETIREMENT LEDGER — one line per case that went with it, so a reader can see
// which property died and which merely moved:
//
//   · "extracts NNN/400"                 → moved: checkpoint-block, the happy path
//   · "no claim present → null"          → INVERTED: null was the defect. Now
//                                          `{ok:false, absent:true}` with a reason
//   · "parses at EVERY tier"             → moved: the per-tier gather case below
//   · "wrong budget parsed and FLAGGED"  → moved: the budget case below, now a
//                                          comparison of two DECLARED numbers
//   · "selection by value, not position" ┐
//   · "several candidates, tier wins"    ├ DIED. There is nothing to select from:
//   · "prefers the tier denominator"     ┘ one block, or an error naming the count
//   · "the spaced form is a claim"       ┐
//   · "a table row is still a claim"     ├ DIED WITH THE PROSE SCAN. These were the
//   · "a denominator no tier declares"   ┘ narrowing the ruling replaced outright
//   · "omitted-budget default resolved   → DIED: there is no budget PARAMETER any
//      from tierParams" (×2)               more; the report declares its own
//
// What did NOT die is the REQ-TIER-9 literal scan, which was never about the
// parser — it is about this module, and it is kept below under its own name.

test('#495: a declared claim reaches the drift check, at EVERY tier', async () => {
  // REQ-495-6, and the successor to "parses at EVERY tier". The block's content
  // does not depend on the reader's tier — what depends on the tier is whether
  // the DECLARED budget matches the one this repo resolves, which is the next
  // case. Asserted per tier rather than at one of them, because a reader
  // calibrated to a single tier is exactly what #472 and #443 both were.
  for (const tier of TIERS) {
    const budget = tierParams(tier).diffBudget;
    const inputs = await gatherCheckpointInputs({
      changedFiles: ['openspec/changes/issue-1-x/checkpoint-report.md'],
      deps: {
        baseSha: 'BASE',
        exists: () => true,
        listDir: () => [],
        readFile: (p) => (p.endsWith('checkpoint-report.md')
          ? `# R\n\n\`\`\`brain-checkpoint/1\ncounted_lines: 213\ndiff_budget: ${budget}\n\`\`\`\n`
          : '- [x] done\n'),
        runReversion: async () => ({ uncomputable: false, command: 'cmd', vacuousTests: [] }),
        runAudit: () => '', runGovernanceStatus: () => '',
        trancheDeps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '', readIgnoreList: () => [], tier },
      },
    });
    assert.equal(inputs.reportClaims.length, 1, `${tier}: the declared block must be read`);
    assert.equal(inputs.reportClaims[0].claimed, 213, `${tier}: and read exactly`);
    assert.equal(inputs.reportClaims[0].matchesTierBudget, true,
      `${tier}: a report declaring THIS tier's budget agrees with it`);
    assert.deepEqual(inputs.uncomputable, [], `${tier}: nothing was uncomputable`);
  }
});

test('#495: a report declaring a budget this repo does not resolve is flagged, not dropped', async () => {
  // The successor to "parsed and FLAGGED, never silently dropped" (#472 option
  // 2). What changed is the epistemics, not the verdict: the 400 below is now
  // the report's OWN declared value rather than a number inferred from its prose,
  // so the finding's `evidence:` quotes something the report actually said.
  const inputs = await gatherCheckpointInputs({
    changedFiles: ['openspec/changes/issue-1-x/checkpoint-report.md'],
    deps: {
      baseSha: 'BASE',
      exists: () => true,
      listDir: () => [],
      readFile: (p) => (p.endsWith('checkpoint-report.md')
        ? '# R\n\n```brain-checkpoint/1\ncounted_lines: 213\ndiff_budget: 400\n```\n'
        : '- [x] done\n'),
      runReversion: async () => ({ uncomputable: false, command: 'cmd', vacuousTests: [] }),
      runAudit: () => '', runGovernanceStatus: () => '',
      trancheDeps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '', readIgnoreList: () => [], tier: 'lite' },
    },
  });
  assert.equal(inputs.reportClaims[0].matchesTierBudget, false);
  const result = evaluateCheckpoint(inputs);
  const finding = result.findings.find((f) => f.id === 'drift:counted-lines-budget');
  assert.ok(finding, 'a report judged under the wrong ceiling is drift in its own right');
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /400/);
  assert.match(finding.evidence, /1000/, 'and the evidence names what this repo actually resolves');
});

test('#495: a report with NO declared block is UNCOMPUTABLE and says so — never silent, never a fabricated claim', async () => {
  // The ruling's point 2, at the layer that matters. The report below contains
  // the sentence verbatim from this repo's own governance-tiers.test.mjs — the
  // shape a report DISCUSSING the tier table writes, and the one that used to
  // produce a `drift:counted-lines-budget` blocker quoting a claim nobody made.
  const inputs = await gatherCheckpointInputs({
    changedFiles: ['openspec/changes/issue-1-x/checkpoint-report.md'],
    deps: {
      baseSha: 'BASE',
      exists: () => true,
      listDir: () => [],
      readFile: (p) => (p.endsWith('checkpoint-report.md')
        ? '# R\n\ndiffBudget matches design §2.C (1000/400/200).\n'
        : '- [x] done\n'),
      runReversion: async () => ({ uncomputable: false, command: 'cmd', vacuousTests: [] }),
      runAudit: () => '', runGovernanceStatus: () => '',
      trancheDeps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '', readIgnoreList: () => [], tier: 'lite' },
    },
  });
  assert.deepEqual(inputs.reportClaims, [], 'prose produces no claim at all');
  assert.equal(inputs.uncomputable.length, 1);

  const result = evaluateCheckpoint(inputs);
  assert.equal(result.conclusion, 'REVISE', 'never APPROVE on uncomputable evidence (protocol §10)');
  assert.ok(
    result.conditions.some((c) => /evidence uncomputable: report budget claim/.test(c)),
    'and the reason is STATED — an unreadable report must not look like a report with nothing to say',
  );
  assert.ok(
    !result.findings.some((f) => f.id.startsWith('drift:')),
    'and no drift finding is invented from a sentence the report never meant as a claim',
  );
});

test('#495: BOTH uncomputable reasons reach conditions together — the list is a list', () => {
  // A list with one member proves nothing about a list. The reversion was the
  // only uncomputable thing before #495 and its handling was written in place;
  // this pins that generalising it did not turn two reasons into one sentence.
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    uncomputable: ['report budget claim — no block'],
    reversion: { uncomputable: true, command: null },
  });
  assert.equal(result.conclusion, 'REVISE');
  const stated = result.conditions.filter((c) => c.startsWith('evidence uncomputable:'));
  assert.equal(stated.length, 2, `both reasons must be stated, got: ${JSON.stringify(stated)}`);
  assert.ok(stated.some((c) => /report budget claim/.test(c)));
  assert.ok(stated.some((c) => /TDD-RED reversion/.test(c)));
});

test('evaluateCheckpoint: a claim carrying no matchesTierBudget produces NO budget finding — the check is strictly === false', () => {
  // `reportClaims` is a published contract ("more parsers can be added without
  // changing the contract"), and any future producer omits this field. Relaxed
  // to `!== true`, every such claim emits a bogus blocker reading "this repo
  // resolves undefined". The strictness is deliberate; nothing else proves it.
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    reportClaims: [{ key: 'counted-lines', claimed: 10, recomputed: 10 }],
  });
  assert.equal(
    result.findings.filter((f) => f.id.endsWith('-budget')).length, 0,
    'a claim from a producer that does not classify the denominator must not be accused of quoting the wrong one',
  );
});

test('#443/#472: no budget literal survives anywhere in checkpoint.mjs, not only in a parameter default', () => {
  // Widened from a single-string source scan: the literal can come back at the
  // CALL SITE (`trancheInputs.diffBudget ?? 400`) or inside the function body,
  // and a scan for one exact spelling sees neither. Comments are stripped first
  // — they cite the tier table on purpose, and citing a number is not declaring
  // one. REQ-TIER-9: resolve, never re-declare.
  const src = readFileSync(fileURLToPath(new URL('./checkpoint.mjs', import.meta.url)), 'utf8');
  const code = src
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // Numeric literals are normalised through Number(), so decimal, exponent
  // (`4e2`), hex/octal/binary (`0x190`) and separator (`1_000`) spellings are
  // all caught. The claim stops there, deliberately: a COMPUTED value
  // (`4 * 100`) is unreachable by any lexical scan, and asserting otherwise
  // would be the completeness this guard cannot have. What it buys is that
  // every spelling someone would plausibly TYPE is covered; what it does not
  // buy is proof that no budget can be reconstructed arithmetically.
  const budgets = new Set(TIERS.map((t) => tierParams(t).diffBudget));
  const literals = [...code.matchAll(/(?<![\w.$])(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)(?![\w.])/g)]
    .map((m) => Number(m[0].replace(/_/g, '')));
  const offenders = literals.filter((n) => budgets.has(n));
  assert.deepEqual(
    offenders, [],
    `a tier budget is written as a numeric literal in executable code (${offenders.join(', ')}) — resolve it through tierParams instead (REQ-TIER-9)`,
  );
});

test('evaluateCheckpoint: report claims fewer lines than the cold recomputation → blocker citing the recomputed value', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    reportClaims: [{ key: 'counted-lines', claimed: 300, recomputed: 372 }],
  });
  assert.equal(result.conclusion, 'REVISE');
  const finding = result.findings.find(f => f.id === 'drift:counted-lines');
  assert.ok(finding, 'expected a drift finding');
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /300/);
  assert.match(finding.evidence, /372/);
});

test('evaluateCheckpoint: report claim matches the recomputation → no drift finding', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    reportClaims: [{ key: 'counted-lines', claimed: 372, recomputed: 372 }],
  });
  assert.ok(!result.findings.some(f => f.id === 'drift:counted-lines'));
});

// ── §10.2 artifact completeness ─────────────────────────────────────────────

test('evaluateCheckpoint: a missing tier-required artefact → blocker citing governance-tiers', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    artifacts: { missing: ['design.md'], hasCheckedTask: true },
  });
  assert.equal(result.conclusion, 'REVISE');
  const finding = result.findings.find(f => f.id === 'artifacts-missing');
  assert.ok(finding);
  assert.match(finding.evidence, /design\.md/);
});

test('evaluateCheckpoint: tasks.md has zero "- [x]" entries → blocker', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    artifacts: { missing: [], hasCheckedTask: false },
  });
  const finding = result.findings.find(f => f.id === 'tasks-no-progress');
  assert.ok(finding);
  assert.equal(finding.severity, 'blocker');
});

test('evaluateCheckpoint: artifacts complete, tasks.md has progress → no artifact findings', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    artifacts: { missing: [], hasCheckedTask: true },
  });
  assert.ok(!result.findings.some(f => f.id === 'artifacts-missing' || f.id === 'tasks-no-progress'));
});

// ── §10.3 prior pins applied, cited file:line ───────────────────────────────

test('evaluateCheckpoint: a pin with no citation → blocker', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    pins: [{ id: 'CP-1', citation: null }],
  });
  const finding = result.findings.find(f => f.id === 'pin:CP-1');
  assert.ok(finding);
  assert.match(finding.evidence, /no file:line citation/);
});

test('evaluateCheckpoint: a pin cited to a file absent from the tree → blocker (not applied)', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    pins: [{ id: 'CP-2', citation: 'brain/core/methodology/reviewer-protocol.md:42' }],
    exists: () => false,
  });
  const finding = result.findings.find(f => f.id === 'pin:CP-2');
  assert.ok(finding);
  assert.match(finding.evidence, /not found in the reviewed tree/);
});

test('evaluateCheckpoint: a pin cited to a file present in the tree → no finding', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    pins: [{ id: 'CP-3', citation: 'brain/core/methodology/reviewer-protocol.md:42' }],
    exists: () => true,
  });
  assert.ok(!result.findings.some(f => f.id === 'pin:CP-3'));
});

test('evaluateCheckpoint: a pin with a truthy non-string (numeric) citation → blocker, does not throw (MINOR 4)', () => {
  let result;
  assert.doesNotThrow(() => {
    result = evaluateCheckpoint({
      trancheInputs: greenTrancheInputs(),
      pins: [{ id: 'CP-4', citation: 42 }],
    });
  }, 'a non-string citation is a missing/invalid citation, not a crash');
  const finding = result.findings.find(f => f.id === 'pin:CP-4');
  assert.ok(finding, 'a numeric citation must produce a missing-citation finding');
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /no file:line citation/);
});

// ── §10.4 TDD-RED by reversion ──────────────────────────────────────────────

test('evaluateCheckpoint: reversion uncomputable (no base sha) → REVISE, conditions include "evidence uncomputable", never APPROVE', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    reversion: { uncomputable: true, command: null },
  });
  assert.equal(result.conclusion, 'REVISE');
  assert.ok(result.conditions.some(c => /evidence uncomputable/.test(c)));
});

test('evaluateCheckpoint: a new test that PASSED against the reverted base → blocker quoting the revert+test command', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    reversion: { uncomputable: false, command: 'git checkout BASE -- impl.mjs && node --test vacuous.test.mjs', vacuousTests: ['vacuous.test.mjs'] },
  });
  assert.equal(result.conclusion, 'REVISE');
  const finding = result.findings.find(f => f.id === 'reversion:vacuous.test.mjs');
  assert.ok(finding, 'a vacuous test must be caught by reversion');
  assert.equal(finding.severity, 'blocker');
  assert.match(finding.evidence, /git checkout BASE/);
});

test('evaluateCheckpoint: every new test FAILED against base (real RED) → no reversion finding', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    reversion: { uncomputable: false, command: 'git checkout BASE -- impl.mjs && node --test real.test.mjs', vacuousTests: [] },
  });
  assert.ok(!result.findings.some(f => f.id?.startsWith('reversion:')));
});

// ── #750: conclusionCauses unions tranche's causes with checkpoint's own ───
//
// REQ-750-1. Checkpoint's own uncomputableReasons are NOT findings — they are
// invisible to a `findings.some(blocker)`-style check, so the union is
// load-bearing, not decorative. No pin below asserts raw insertion order
// (design decision 2) — every assertion compares `[...new Set(c)].sort()`.

test('evaluateCheckpoint: inherited-only — tranche\'s conclusionCauses propagate untouched when checkpoint adds nothing of its own (#750)', () => {
  // A rollup-uncomputable tranche pushes ZERO findings (tranche.mjs:154-166's
  // early return) — its 'uncomputable' cause is invisible to checkpoint's own
  // `anyBlocker`/`anyUncomputable` checks (neither a finding nor one of
  // checkpoint's own uncomputableReasons), so only the union spread of
  // `tranche.conclusionCauses` can carry it through. This is the pin that
  // catches "drop the checkpoint union" — the other two tests below both use
  // 'blocker', which checkpoint's own findings-derived `anyBlocker` would
  // still see even with the union deleted.
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs({ requiredGates: null }),
    reversion: { uncomputable: false, command: 'cmd', vacuousTests: [] },
  });
  assert.deepEqual([...result.conclusionCauses].sort(), ['uncomputable']);
});

test('evaluateCheckpoint: observed-only — checkpoint\'s own anyBlocker adds a cause tranche never had (#750)', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    reversion: { uncomputable: false, command: 'cmd', vacuousTests: [] },
    pins: [{ id: 'CP-1', citation: null }],
  });
  assert.deepEqual([...result.conclusionCauses].sort(), ['blocker'],
    'a green tranche declares no cause of its own — this "blocker" is entirely checkpoint\'s (a missing pin citation)');
});

test('evaluateCheckpoint: union case — tranche\'s blocker and checkpoint\'s own uncomputable reversion both fire, deduped (#750)', () => {
  const rollup = greenRollup().map(g => (g.name === 'memory-gate' ? { ...g, conclusion: 'FAILURE' } : g));
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs({ requiredGates: rollup }),
    reversion: { uncomputable: true, command: null },
  });
  assert.deepEqual([...new Set(result.conclusionCauses)].sort(), ['blocker', 'uncomputable']);
});

// ── §10.5 audit/governance-status quoted + decision-gate step-2 → ruling ────

test('evaluateCheckpoint: brain:audit and brain:governance-status output are quoted verbatim as editorial findings', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    auditOutput: 'audit: 3 records, 0 orphaned',
    governanceStatusOutput: 'governance status — owner/repo (github)',
  });
  const audit = result.findings.find(f => f.id === 'audit-output');
  const gov = result.findings.find(f => f.id === 'governance-status-output');
  assert.ok(audit && gov);
  assert.equal(audit.severity, 'editorial');
  assert.match(audit.evidence, /3 records/);
  assert.equal(gov.severity, 'editorial');
  assert.match(gov.evidence, /owner\/repo/);
});

test('evaluateCheckpoint: an architectural surface touched without the "decision" label → blocker (converts the decision-gate step-2 warn into a ruling)', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs({ changedFiles: ['brain/core/methodology/reviewer-protocol.md'] }),
    changedFiles: ['brain/core/methodology/reviewer-protocol.md'],
    hasDecisionLabel: false,
  });
  assert.equal(result.conclusion, 'REVISE');
  const finding = result.findings.find(f => f.id === 'decision-surface');
  assert.ok(finding, 'expected the step-2 heuristic to be converted into a hard finding');
  assert.match(finding.evidence, /reviewer-protocol\.md/);
  assert.match(finding.cites, /decision-gate/);
});

test('evaluateCheckpoint: an architectural surface touched WITH the "decision" label → no decision-surface finding', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs({ changedFiles: ['brain/core/methodology/reviewer-protocol.md'] }),
    changedFiles: ['brain/core/methodology/reviewer-protocol.md'],
    hasDecisionLabel: true,
  });
  assert.ok(!result.findings.some(f => f.id === 'decision-surface'));
});

// ── reuse of evaluateTranche (no re-implementation of gates/budget/detection) ─

test('evaluateCheckpoint: a failing required gate (tranche-level) still surfaces through the checkpoint verdict', () => {
  const rollup = greenRollup().map(g => (g.name === 'memory-gate' ? { ...g, conclusion: 'FAILURE' } : g));
  const result = evaluateCheckpoint({ trancheInputs: greenTrancheInputs({ requiredGates: rollup }) });
  assert.equal(result.conclusion, 'REVISE');
  assert.ok(result.findings.find(f => f.id === 'gate:memory-gate'));
});

test('evaluateCheckpoint: everything green → APPROVE, gates carried through from evaluateTranche', () => {
  const result = evaluateCheckpoint({
    trancheInputs: greenTrancheInputs(),
    reversion: { uncomputable: false, command: 'cmd', vacuousTests: [] },
  });
  assert.equal(result.conclusion, 'APPROVE');
  assert.deepEqual(result.gates.required, REQUIRED_JOBS);
});

test('evaluateCheckpoint: the tiered diff budget reaches the checkpoint verdict through the shared gather (#443, REQ-443-5)', async () => {
  // #443 fixed `gatherTrancheInputs`, and checkpoint gathers through it — so this
  // evaluator is fixed "for free". "For free" is a CLAIM: an unexercised protection
  // carries no information, and the whole reason #443 existed is that the one tier
  // under test was the one where the bug was invisible. Gather for real (not
  // hand-wired trancheInputs) at regulated, where 250 lines is over the 200 budget
  // and was silently APPROVED before the fix.
  const inputs = await gatherCheckpointInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    changedFiles: ['a.mjs'],
    deps: {
      baseSha: 'BASE',
      trancheDeps: {
        tier: 'regulated',
        fetchRollup: async () => greenRollup(),
        diffNumstat: () => '250\t0\tbig.txt\n',
        readIgnoreList: () => [],
      },
      runReversion: async () => ({ uncomputable: false, command: 'cmd', vacuousTests: [] }),
      runAudit: () => '',
      runGovernanceStatus: () => '',
      exists: () => true,
      listDir: () => [],
      readFile: () => '',
    },
  });
  assert.equal(inputs.trancheInputs.diffBudget, 200, 'the gather must carry regulated\'s budget, not the pre-#443 constant');
  const result = evaluateCheckpoint(inputs);
  const finding = result.findings.find(f => f.id === 'budget');
  assert.ok(finding, 'the checkpoint verdict must carry the budget blocker — a 250-line diff at regulated is over doctrine');
  assert.equal(result.conclusion, 'REVISE');
});

// ── resolveChangeId ──────────────────────────────────────────────────────────

test('resolveChangeId: extracts the change id from a checkpoint-report.md path', () => {
  assert.equal(resolveChangeId(['openspec/changes/issue-266-h1-brain-review/checkpoint-report.md', 'a.mjs']), 'issue-266-h1-brain-review');
});

test('resolveChangeId: no checkpoint-report.md present → null', () => {
  assert.equal(resolveChangeId(['a.mjs']), null);
});

// ── gatherCheckpointInputs (DI-seam) ─────────────────────────────────────────

test('gatherCheckpointInputs: deps.baseSha absent → reversion is uncomputable, runReversion never invoked, never reads ci-context', async () => {
  let called = false;
  const inputs = await gatherCheckpointInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    changedFiles: ['a.mjs'],
    deps: {
      runReversion: async () => { called = true; return { uncomputable: false, command: '', vacuousTests: [] }; },
      trancheDeps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '', readIgnoreList: () => [] },
      runAudit: () => '', runGovernanceStatus: () => '',
    },
  });
  assert.equal(called, false);
  assert.equal(inputs.reversion.uncomputable, true);
});

test('gatherCheckpointInputs: deps.baseSha injected → wires runReversion with base+head+impl/test files derived from changedFiles', async () => {
  let seen = null;
  const inputs = await gatherCheckpointInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    changedFiles: ['review/evaluators/checkpoint.mjs', 'review/evaluators/checkpoint.test.mjs'],
    deps: {
      baseSha: 'BASE',
      runReversion: async (args) => { seen = args; return { uncomputable: false, command: 'cmd', vacuousTests: [] }; },
      trancheDeps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '', readIgnoreList: () => [] },
      runAudit: () => '', runGovernanceStatus: () => '',
    },
  });
  assert.equal(seen.baseSha, 'BASE');
  assert.equal(seen.headSha, 'HEAD');
  assert.deepEqual(seen.implFiles, ['review/evaluators/checkpoint.mjs']);
  assert.deepEqual(seen.testFiles, ['review/evaluators/checkpoint.test.mjs']);
  assert.equal(inputs.reversion.uncomputable, false);
});

test('gatherCheckpointInputs: resolves artifacts + report claim from an injected fs seam (exists/listDir/readFile), never touches the real fs', async () => {
  const changeId = 'issue-999-fixture';
  const files = {
    [`openspec/changes/${changeId}/proposal.md`]: 'x',
    [`openspec/changes/${changeId}/spec.md`]: 'x',
    [`openspec/changes/${changeId}/design.md`]: 'x',
    [`openspec/changes/${changeId}/tasks.md`]: '- [x] done\n- [ ] pending\n',
    [`openspec/changes/${changeId}/checkpoint-report.md`]: declared(372, 400),
  };
  const inputs = await gatherCheckpointInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    changedFiles: [`openspec/changes/${changeId}/checkpoint-report.md`],
    deps: {
      baseSha: 'BASE',
      exists: (p) => p in files,
      listDir: () => [],
      readFile: (p) => files[p],
      runReversion: async () => ({ uncomputable: false, command: 'cmd', vacuousTests: [] }),
      trancheDeps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '10\t5\ta.mjs\n', readIgnoreList: () => [] },
      runAudit: () => '', runGovernanceStatus: () => '',
    },
  });
  assert.deepEqual(inputs.artifacts.missing, []);
  assert.equal(inputs.artifacts.hasCheckedTask, true);
  assert.equal(inputs.reportClaims[0].claimed, 372);
  assert.equal(inputs.reportClaims[0].recomputed, 15);
});

// Issue #472 — the integration cases, kept through #495 with their reports
// rewritten into the declared form. What they pin is unchanged and is not a
// property of the parser: that the TIER reaches the resolution, and that an
// understated report blocks at every tier rather than only at the one the
// fixtures happen to sit on. The unit cases above are blind along the PATH axis
// on their own; these drive the gather seam, which is the only place the binding
// is observable. (brain/core/anti-patterns/red-proof-blind-along-an-unvaried-axis.md)

/** Builds the injected fs + tranche seams for a checkpoint gather at a given tier. */
function gatherAtTier({ tier, reportText, numstat = '10\t5\ta.mjs\n' }) {
  const changeId = 'issue-999-fixture';
  const files = {
    [`openspec/changes/${changeId}/proposal.md`]: 'x',
    [`openspec/changes/${changeId}/spec.md`]: 'x',
    [`openspec/changes/${changeId}/design.md`]: 'x',
    [`openspec/changes/${changeId}/tasks.md`]: '- [x] done\n',
    [`openspec/changes/${changeId}/checkpoint-report.md`]: reportText,
  };
  return gatherCheckpointInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    changedFiles: [`openspec/changes/${changeId}/checkpoint-report.md`],
    // #555 round 2: the TOP-LEVEL tier, which drives requiredArtifactsFor. It was
    // passed only into trancheDeps, so every checkpoint test ran the artefact
    // resolution at the 'standard' default — the consumer was blind along the very
    // axis #555 introduced, and a cold review measured that neither of the PR's own
    // mutations moved a single checkpoint test.
    tier,
    deps: {
      baseSha: 'BASE',
      exists: (p) => p in files,
      listDir: () => [],
      readFile: (p) => files[p],
      runReversion: async () => ({ uncomputable: false, command: 'cmd', vacuousTests: [] }),
      trancheDeps: { tier, fetchRollup: async () => greenRollup(), diffNumstat: () => numstat, readIgnoreList: () => [] },
      runAudit: () => '', runGovernanceStatus: () => '',
    },
  });
}

test('gatherCheckpointInputs → evaluateCheckpoint: at LITE, an understated report still produces the drift blocker', async () => {
  // 372 claimed against a tree holding 400 counted lines. Before #472 the lite
  // report `**372/1000**` parsed to null, `reportClaims` stayed [], and §10.1
  // returned no finding — silence indistinguishable from a matching report.
  const inputs = await gatherAtTier({
    tier: 'lite',
    reportText: declared(372, 1000),
    numstat: '300\t100\ta.mjs\n',
  });

  assert.equal(inputs.reportClaims.length, 1, 'a lite report must yield a checkable claim');
  assert.equal(inputs.reportClaims[0].claimed, 372);
  assert.equal(inputs.reportClaims[0].tierBudget, 1000, 'the budget must ride the SAME tier resolution as the job sets');
  assert.equal(
    inputs.reportClaims[0].matchesTierBudget, true,
    'the tier must reach the PARSER, not merely the claim object — this is the only value that changes if the call site drops its diffBudget argument, and the canonical fallback would otherwise mask that regression',
  );

  const result = evaluateCheckpoint({ ...inputs, trancheInputs: inputs.trancheInputs });
  const drift = result.findings.find((f) => f.id === 'drift:counted-lines');
  assert.ok(drift, 'a report claiming fewer lines than the tree holds must block at lite, exactly as at standard');
  assert.match(drift.evidence, /claims counted-lines=372; cold recomputation = 400/);
});

test('gatherCheckpointInputs → evaluateCheckpoint: at REGULATED, an understated report produces the drift blocker', async () => {
  const inputs = await gatherAtTier({
    tier: 'regulated',
    reportText: declared(150, 200),
    numstat: '200\t100\ta.mjs\n',
  });

  assert.equal(inputs.reportClaims[0].tierBudget, 200);
  assert.equal(inputs.reportClaims[0].matchesTierBudget, true, 'the tier reached the parser (see the lite case)');
  const result = evaluateCheckpoint({ ...inputs, trancheInputs: inputs.trancheInputs });
  assert.ok(result.findings.some((f) => f.id === 'drift:counted-lines'), 'regulated must block too');
});

test('gatherCheckpointInputs: at STANDARD the behaviour is unchanged — the no-op migration guarantee (REQ-TIER-10)', async () => {
  // Asserted explicitly rather than inferred from "standard still passes":
  // every fixture in this suite sat at standard before #472, which is exactly
  // why the defect survived. "Standard is green" is not evidence about a change
  // that only ever misbehaved at the other two tiers.
  const inputs = await gatherAtTier({
    tier: 'standard',
    reportText: declared(372, 400),
    numstat: '10\t5\ta.mjs\n',
  });

  assert.deepEqual(
    { claimed: inputs.reportClaims[0].claimed, recomputed: inputs.reportClaims[0].recomputed, tierBudget: inputs.reportClaims[0].tierBudget },
    { claimed: 372, recomputed: 15, tierBudget: 400 },
  );
  const result = evaluateCheckpoint({ ...inputs, trancheInputs: inputs.trancheInputs });
  assert.equal(result.findings.filter((f) => f.id.startsWith('drift:')).length, 0, 'an honest standard report drifts on nothing');
});

test('gatherCheckpointInputs → evaluateCheckpoint: a report quoting the WRONG tier budget blocks on the denominator (issue #472 option 2)', async () => {
  // The report is numerically honest (150 ≤ the tree) but cites `standard`'s
  // ceiling in a `regulated` repo — it asserts compliance against doctrine that
  // does not apply here. Silence would be the pre-#472 behaviour by another route.
  const inputs = await gatherAtTier({
    tier: 'regulated',
    reportText: declared(150, 400),
    numstat: '10\t5\ta.mjs\n',
  });

  const result = evaluateCheckpoint({ ...inputs, trancheInputs: inputs.trancheInputs });
  const finding = result.findings.find((f) => f.id === 'drift:counted-lines-budget');
  assert.ok(finding, 'a report citing a budget the repo does not operate under is report drift in its own right');
  assert.match(finding.evidence, /states the counted-lines budget as 400; this repo resolves 200 \(tier: regulated\)/);
  assert.equal(finding.severity, 'blocker');
});

test('gatherCheckpointInputs: doctrineRecords with a `pin` field are surfaced as pins with their citation', async () => {
  const inputs = await gatherCheckpointInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    changedFiles: [],
    doctrineRecords: [
      { id: 'r1', type: 'decision', pin: { citation: 'brain/HOME.md:1' } },
      { id: 'r2', type: 'decision' }, // no pin — not a prior ruling pin
    ],
    deps: {
      trancheDeps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '', readIgnoreList: () => [] },
      runAudit: () => '', runGovernanceStatus: () => '',
    },
  });
  assert.deepEqual(inputs.pins, [{ id: 'r1', citation: 'brain/HOME.md:1' }]);
});

test('gatherCheckpointInputs: default audit + governance-status runners spawn against the cold worktreePath, not the operator cwd (MINOR 3)', async () => {
  const seen = [];
  const worktreePath = '/tmp/cold-worktree-minor3';
  await gatherCheckpointInputs({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    headSha: 'HEAD',
    changedFiles: [],
    worktreePath,
    deps: {
      // Capture what the DEFAULT audit/gov runners spawn (runAudit /
      // runGovernanceStatus are deliberately NOT injected → the real wiring
      // path is exercised, so this asserts they run against the cold worktree).
      exec: (file, args, opts) => { seen.push({ script: args[0], cwd: opts.cwd }); return `${args[0]} ran`; },
      trancheDeps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '', readIgnoreList: () => [] },
    },
  });
  const auditCall = seen.find(c => c.script.includes('brain-audit'));
  const govCall = seen.find(c => c.script.includes('brain-governance-status'));
  assert.ok(auditCall, 'brain:audit must be spawned via the injected exec seam');
  assert.ok(govCall, 'brain:governance-status must be spawned via the injected exec seam');
  assert.equal(auditCall.cwd, worktreePath);
  assert.equal(govCall.cwd, worktreePath);
});

// ── REVERSION-CWD (real default, issue #266 H1-3): isolated worktree, never
// moves the operator's HEAD — mirrors cold-boot.test.mjs's COLDBOOT-CWD test.

test('REVERSION-CWD (real default): defaultRunReversion reverts impl to base in an ISOLATED worktree, catches the vacuous fixture, and never moves the operator HEAD', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'brain-review-rev-op-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'brain-review-rev-wt-'));
  t.after(() => {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: repo }); } catch { /* best effort */ }
    removeTempTree(repo);
    removeTempTree(wtParent);
  });

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');

  // base: a "buggy" impl, no tests yet.
  writeFileSync(join(repo, 'impl.mjs'), 'export function add(a, b) { return a - b; }\n');
  git('add', 'impl.mjs');
  git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  const branch = git('symbolic-ref', '--short', 'HEAD');

  // head: impl fixed + a real test (fails against base) + the vacuous fixture (passes against base).
  writeFileSync(join(repo, 'impl.mjs'), 'export function add(a, b) { return a + b; }\n');
  writeFileSync(join(repo, 'real.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './impl.mjs';",
    "test('add works', () => { assert.equal(add(2, 3), 5); });",
  ].join('\n') + '\n');
  copyFileSync(VACUOUS_FIXTURE, join(repo, 'vacuous.test.mjs'));
  git('add', 'impl.mjs', 'real.test.mjs', 'vacuous.test.mjs');
  git('commit', '-q', '-m', 'head');
  const headSha = git('rev-parse', 'HEAD');

  const runReversion = defaultRunReversion({ cwd: repo, tmp: wtParent });
  const result = runReversion({ baseSha, headSha, implFiles: ['impl.mjs'], testFiles: ['real.test.mjs', 'vacuous.test.mjs'] });

  assert.equal(result.uncomputable, false);
  assert.deepEqual(result.vacuousTests, ['vacuous.test.mjs'], 'the real test failed against base (good); the vacuous fixture passed against base (caught)');
  assert.match(result.command, /git checkout/);

  // operator HEAD never moved.
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), branch);
  assert.equal(git('rev-parse', 'HEAD'), headSha);
});

// ── REVERSION reversion-semantics (issue #266 H1-3 BLOCKER 1): a checkpoint's
// dominant case is a PR that ADDS impl+test files. `git checkout <base> -- <p>`
// exits 1 for any path absent at base — the added file's base state is
// "absent", so it must be REMOVED, not checked out. Mixed add+modify must not
// abort the whole checkout, and any unexpected git failure must fail closed.

test('REVERSION-ADD (real default): a PR that ADDS impl+test — reversion removes the added impl (base=absent), the new test FAILS against base (not vacuous), never crashes, operator HEAD unmoved', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'brain-review-rev-add-op-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'brain-review-rev-add-wt-'));
  t.after(() => {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: repo }); } catch { /* best effort */ }
    removeTempTree(repo);
    removeTempTree(wtParent);
  });

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');

  // base: only an unrelated file. newimpl.mjs does NOT exist at base.
  writeFileSync(join(repo, 'README.md'), '# base\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  const branch = git('symbolic-ref', '--short', 'HEAD');

  // head: the PR ADDS newimpl.mjs + newimpl.test.mjs (the test imports newimpl).
  writeFileSync(join(repo, 'newimpl.mjs'), 'export function feature() { return 42; }\n');
  writeFileSync(join(repo, 'newimpl.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { feature } from './newimpl.mjs';",
    "test('feature works', () => { assert.equal(feature(), 42); });",
  ].join('\n') + '\n');
  git('add', 'newimpl.mjs', 'newimpl.test.mjs');
  git('commit', '-q', '-m', 'head adds impl+test');
  const headSha = git('rev-parse', 'HEAD');

  const runReversion = defaultRunReversion({ cwd: repo, tmp: wtParent });
  let result;
  assert.doesNotThrow(() => {
    result = runReversion({ baseSha, headSha, implFiles: ['newimpl.mjs'], testFiles: ['newimpl.test.mjs'] });
  }, 'reversion must not crash on a file the PR ADDS');

  assert.equal(result.uncomputable, false);
  // The added impl was removed → base state = absent → the new test cannot
  // import it → real RED, correctly NOT flagged vacuous.
  assert.deepEqual(result.vacuousTests, []);

  // operator HEAD never moved.
  assert.equal(git('symbolic-ref', '--short', 'HEAD'), branch);
  assert.equal(git('rev-parse', 'HEAD'), headSha);
});

test('REVERSION-MIXED (real default): one ADDED impl + one MODIFIED impl — both reach base state (added removed, modified reverted), no whole-checkout abort, no crash', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'brain-review-rev-mix-op-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'brain-review-rev-mix-wt-'));
  t.after(() => {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: repo }); } catch { /* best effort */ }
    removeTempTree(repo);
    removeTempTree(wtParent);
  });

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');

  // base: modfile exists (V='base'); addfile does NOT exist.
  writeFileSync(join(repo, 'modfile.mjs'), "export const V = 'base';\n");
  git('add', 'modfile.mjs');
  git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD');
  const branch = git('symbolic-ref', '--short', 'HEAD');

  // head: modfile modified (V='head'), addfile added, + a test per file pinning
  // it to its HEAD state (so both FAIL once brought to base → both real RED).
  writeFileSync(join(repo, 'modfile.mjs'), "export const V = 'head';\n");
  writeFileSync(join(repo, 'addfile.mjs'), 'export const N = 1;\n');
  writeFileSync(join(repo, 'mod.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { V } from './modfile.mjs';",
    "test('mod at head', () => { assert.equal(V, 'head'); });",
  ].join('\n') + '\n');
  writeFileSync(join(repo, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { N } from './addfile.mjs';",
    "test('add exists', () => { assert.equal(N, 1); });",
  ].join('\n') + '\n');
  git('add', 'modfile.mjs', 'addfile.mjs', 'mod.test.mjs', 'add.test.mjs');
  git('commit', '-q', '-m', 'head');
  const headSha = git('rev-parse', 'HEAD');

  const runReversion = defaultRunReversion({ cwd: repo, tmp: wtParent });
  let result;
  assert.doesNotThrow(() => {
    result = runReversion({ baseSha, headSha, implFiles: ['modfile.mjs', 'addfile.mjs'], testFiles: ['mod.test.mjs', 'add.test.mjs'] });
  }, 'the added file must not abort the whole checkout of the modified file');

  assert.equal(result.uncomputable, false);
  // modfile reverted to V='base' → mod.test (expects 'head') FAILS; addfile
  // removed → add.test import FAILS. Both real RED → neither is vacuous. If the
  // added path had aborted the checkout, modfile would stay 'head' and mod.test
  // would PASS → surface as vacuous. Empty vacuousTests proves BOTH reverted.
  assert.deepEqual(result.vacuousTests, []);

  assert.equal(git('symbolic-ref', '--short', 'HEAD'), branch);
  assert.equal(git('rev-parse', 'HEAD'), headSha);
});

test('REVERSION-CRASHSAFE (real default): an unexpected git failure (bogus head sha) folds to uncomputable/fail-closed, never throws', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'brain-review-rev-crash-op-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'brain-review-rev-crash-wt-'));
  t.after(() => {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: repo }); } catch { /* best effort */ }
    removeTempTree(repo);
    removeTempTree(wtParent);
  });

  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@t.t');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# base\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'base');

  const runReversion = defaultRunReversion({ cwd: repo, tmp: wtParent });
  let result;
  // headSha does not exist → `git worktree add` fails unexpectedly. This must
  // NOT escape and crash brain:review — the headline defense degrades safely.
  assert.doesNotThrow(() => {
    result = runReversion({ baseSha: 'HEAD', headSha: '0000000000000000000000000000000000000000', implFiles: ['x.mjs'], testFiles: ['x.test.mjs'] });
  }, 'an unexpected git failure must not escape the reversion runner');
  assert.equal(result.uncomputable, true);
  assert.equal(result.command, null);
});

// ── #555 round 2: the checkpoint consumer MOVES with the tier ────────────────

/** Like gatherAtTier, but the caller chooses which artefact files exist. */
function gatherWithArtefacts({ tier, present }) {
  const changeId = 'issue-999-artefacts';
  const files = Object.fromEntries(
    present.map(f => [`openspec/changes/${changeId}/${f}`, f === 'tasks.md' ? '- [x] done\n' : 'x']));
  files[`openspec/changes/${changeId}/checkpoint-report.md`] = 'Counted diff re-derived cold = **10/1000**.';
  return gatherCheckpointInputs({
    project: 'csrinaldi/brain', number: 42, provider: 'github', headSha: 'HEAD',
    changedFiles: [`openspec/changes/${changeId}/checkpoint-report.md`],
    tier,
    deps: {
      baseSha: 'BASE',
      exists: (p) => p in files,
      listDir: () => [],
      readFile: (p) => files[p] ?? '',
      runReversion: async () => ({ uncomputable: false, command: 'cmd', vacuousTests: [] }),
      trancheDeps: { tier, fetchRollup: async () => greenRollup(), diffNumstat: () => '1\t0\ta.mjs\n', readIgnoreList: () => [] },
      runAudit: () => '', runGovernanceStatus: () => '',
    },
  });
}

test('#555: at LITE the artefact SET is spec.md alone — but the SDD must still be executed', async () => {
  // REWRITTEN in round 3. The first version asserted only `artifacts.missing` and
  // never called `evaluateCheckpoint`, so it could not see that the blocker had
  // been RENAMED rather than removed: with tasks.md out of the tier's set, an
  // absent tasks.md read as "present with zero checked" and `tasks-no-progress`
  // fired in `artifacts-missing`'s place. A test that measures the thing you
  // changed instead of the outcome that matters cannot see that.
  const inputs = await gatherWithArtefacts({ tier: 'lite', present: ['spec.md'] });
  assert.deepEqual(inputs.artifacts.missing, [],
    'lite requires spec.md alone for Rule A (ADR-0026)');

  const blockers = evaluateCheckpoint(inputs).findings.filter(f => f.severity === 'blocker').map(f => f.id);
  assert.deepEqual(blockers, ['tasks-absent'],
    'and exactly ONE blocker — the SDD-execution one (maintainer ruling 2026-08-13: "por más que ' +
    'sea lite, el SDD debe ser ejecutado"), never a no-progress finding over a file that is not there');
});

test('#555: at LITE, spec.md + a tasks.md with one checked item passes clean', async () => {
  const inputs = await gatherWithArtefacts({ tier: 'lite', present: ['spec.md', 'tasks.md'] });
  const blockers = evaluateCheckpoint(inputs).findings.filter(f => f.severity === 'blocker').map(f => f.id);
  assert.deepEqual(blockers, [],
    'the shape REQ-L4-2′s own lite scenario describes must not block');
});

test('#555: a tasks.md with NO checked item is a different finding from an absent one', async () => {
  // "You never wrote one" and "you wrote one and completed nothing" are different
  // things to tell an author, and collapsing them is what produced round 3's blocker.
  const inputs = await gatherWithArtefacts({ tier: 'lite', present: ['spec.md', 'tasks-empty.md'] });
  const ids = evaluateCheckpoint(inputs).findings.filter(f => f.severity === 'blocker').map(f => f.id);
  assert.ok(ids.includes('tasks-absent'), `absent tasks.md must say so: ${JSON.stringify(ids)}`);
  assert.ok(!ids.includes('tasks-no-progress'), 'and must not claim zero progress on a file it never read');
});

test('#555: at REGULATED the same change is missing four, named by their REAL filenames', async () => {
  const inputs = await gatherWithArtefacts({ tier: 'regulated', present: ['spec.md'] });
  assert.deepEqual(inputs.artifacts.missing,
    ['proposal.md', 'design.md', 'tasks.md', 'verify-report.md'],
    'and the verification artefact is verify-report.md, never the invented verification.md');
});

test('#555: at REGULATED, verify-report.md present completes the set', async () => {
  const inputs = await gatherWithArtefacts({
    tier: 'regulated',
    present: ['proposal.md', 'spec.md', 'design.md', 'tasks.md', 'verify-report.md'],
  });
  assert.deepEqual(inputs.artifacts.missing, [],
    'a regulated change carrying the five REAL artefacts is complete — the blocker B1 fixed');
});

// ── #1073 cold review rev 3 ────────────────────────────────────────────────
// `review/cli.mjs` hands this evaluator `boot.prView.labels ?? null`, so an
// unread label set arrives as `null` — and `labels = []` is a default, which
// only applies to `undefined`. `labels.includes('decision')` then throws, and
// a checkpoint review CRASHES on a refused forge read instead of failing
// closed and saying the labels could not be read. Measured by the reviewer as
// a TypeError at checkpoint.mjs:468.
test('#1073: an unread label set fails closed, it does not crash the checkpoint review', async () => {
  const base = {
    changedFiles: ['openspec/changes/issue-1-x/checkpoint-report.md'],
    deps: {
      baseSha: 'BASE',
      exists: () => true,
      listDir: () => [],
      readFile: () => '- [x] done\n',
      runReversion: async () => ({ uncomputable: false, command: 'cmd', vacuousTests: [] }),
      runAudit: () => '', runGovernanceStatus: () => '',
      trancheDeps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '', readIgnoreList: () => [], tier: 'lite' },
    },
  };

  const unread = await gatherCheckpointInputs({ ...base, labels: null });
  assert.equal(unread.hasDecisionLabel, false,
    'nobody read the labels, so nobody can claim a decision label is there — false, never a throw');
  assert.equal(unread.labels ?? null, null, 'and the unread set travels on as unread');

  // Read, and carrying the label: the ordinary case must be untouched.
  const withLabel = await gatherCheckpointInputs({ ...base, labels: ['decision'] });
  assert.equal(withLabel.hasDecisionLabel, true);

  // Read, and not carrying it: a fact, distinct from the unread case above.
  const without = await gatherCheckpointInputs({ ...base, labels: [] });
  assert.equal(without.hasDecisionLabel, false);
});

// #1073 rev 4: R1072-5 says a `labels = []` default does not satisfy the
// unread case — and this evaluator still carried one, then FORWARDED that
// manufactured `[]` into the tranche gather. So a caller that omitted labels
// produced a budget finding claiming the PR was read and carries no
// exception. Hardening the consumers was not enough while the default was
// still minting the false claim.
test('#1073: omitting the labels yields "not read", never an empty set that claims the PR carries no exception', async () => {
  const base = {
    // Both SHAs, or the tranche gather reports the budget uncomputable and
    // there is no finding to inspect.
    headSha: 'HEAD',
    changedFiles: ['openspec/changes/issue-1-x/checkpoint-report.md'],
    deps: {
      baseSha: 'BASE',
      exists: () => true,
      listDir: () => [],
      readFile: () => '- [x] done\n',
      runReversion: async () => ({ uncomputable: false, command: 'cmd', vacuousTests: [] }),
      runAudit: () => '', runGovernanceStatus: () => '',
      trancheDeps: { fetchRollup: async () => greenRollup(), diffNumstat: () => '1500\t0\tbig.txt\n', readIgnoreList: () => [], tier: 'lite' },
    },
  };

  const omitted = await gatherCheckpointInputs(base);
  assert.equal(omitted.labels, null, 'omitted is UNREAD, and the default must not invent a read');
  assert.equal(omitted.trancheInputs.labels, null, 'and the unread set is what gets forwarded, not a manufactured []');
  assert.equal(omitted.hasDecisionLabel, false, 'and still fails closed');

  // The budget lives on the tranche inputs this evaluator gathers, which is
  // exactly the value the forwarded labels travel on.
  const budget = evaluateTranche(omitted.trancheInputs).findings.find((f) => f.id === 'budget');
  assert.match(budget.evidence, /labels could not be read/,
    'the over-budget block must say the labels were never read, not present it as a PR with no exception');

  // Read, and empty: the opposite fact, and it must not borrow that sentence.
  const read = await gatherCheckpointInputs({ ...base, labels: [] });
  assert.deepEqual(read.labels, []);
  assert.deepEqual(read.trancheInputs.labels, []);
  const readBudget = evaluateTranche(read.trancheInputs).findings.find((f) => f.id === 'budget');
  assert.ok(!/could not be read/.test(readBudget.evidence));
});
