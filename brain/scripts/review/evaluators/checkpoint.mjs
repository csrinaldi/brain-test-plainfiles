// checkpoint.mjs — REQ-H1-10: the checkpoint evaluator. Runs the tranche
// checks (REQ-H1-8, REUSED via evaluateTranche — gates/budget/detection are
// NEVER re-implemented here) plus five checkpoint-only checks: report-vs-tree
// drift, sdd-layout artifact completeness, prior pins applied+cited, TDD-RED
// by reversion, and audit/governance-status quoting with the decision-gate
// step-2 warn converted into a hard finding (design.md §2).
//
// §10.4's base sha (the reversion's own anchor) is an INJECTED dependency,
// `deps.baseSha`, fed by cli.mjs's one resolved baseSha (ci-context BASE_SHA →
// `prView().baseRefOid`, ADR-0022 — landed #266 H1-2C-BASE) and NEVER a
// hardcoded branch. When it is null (genuinely uncomputable), both the reversion
// AND the tranche re-derivation it feeds fold into the SAME fail-closed rule
// tranche.mjs documents (protocol §10, "never APPROVE on uncomputable
// evidence") — generalized, not reinvented.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateTranche, gatherTrancheInputs } from './tranche.mjs';
import { requiredArtifactsFor } from '../../vcs/governance-tiers.mjs';
import { changeDir, missingRequiredArtifacts } from '../../lib/sdd-layout.mjs';
import { parseCheckpointClaim } from '../lib/checkpoint-block.mjs';

const CHECKPOINT_REPORT_RE = /(?:^|\/)openspec\/changes\/([^/]+)\/checkpoint-report\.md$/;
// Mirrors workflow-governance.md Invariant 4 step 2's scanned surfaces.
const ARCHITECTURAL_SURFACE_RE = [/providers\//, /^brain\/core\//, /config-migrations\.mjs$/, /^package\.json$/];

/** Finds the change id from a `checkpoint-report.md` path in `changedFiles`. */
export function resolveChangeId(changedFiles = []) {
  for (const f of changedFiles) {
    const m = CHECKPOINT_REPORT_RE.exec(f);
    if (m) return m[1];
  }
  return null;
}

function matchesArchitecturalSurface(file) {
  return ARCHITECTURAL_SURFACE_RE.some((re) => re.test(file));
}

// ── §10.1 report-vs-tree drift ──────────────────────────────────────────────
function checkReportDrift(claims = []) {
  const findings = [];
  for (const claim of claims) {
    if (typeof claim.claimed === 'number' && typeof claim.recomputed === 'number' && claim.claimed < claim.recomputed) {
      findings.push({
        id: `drift:${claim.key}`,
        severity: 'blocker',
        evidence: `checkpoint-report.md claims ${claim.key}=${claim.claimed}; cold recomputation = ${claim.recomputed}`,
        cites: 'reviewer-protocol.md §10 report-vs-tree drift',
      });
    }
    // A report quoting a budget the repo does not operate under is itself
    // report drift: it asserts compliance against doctrine that does not apply
    // here, and the numerator it states was judged under the wrong ceiling
    // (issue #472). Dropping the claim instead would restore the silence this
    // check exists to remove — the parse failure would be indistinguishable
    // from a report that matched.
    if (claim.matchesTierBudget === false) {
      findings.push({
        id: `drift:${claim.key}-budget`,
        severity: 'blocker',
        evidence: `checkpoint-report.md states the ${claim.key} budget as ${claim.declaredBudget}; this repo resolves ${claim.tierBudget}${claim.tier ? ` (tier: ${claim.tier})` : ''}`,
        cites: 'ADR-0026 tierParams(tier).diffBudget; reviewer-protocol.md §10 report-vs-tree drift',
      });
    }
  }
  return findings;
}

// ── §10.2 artifact completeness ─────────────────────────────────────────────
function checkArtifactCompleteness({ missing = [], hasCheckedTask, tasksAbsent = false, tier = 'standard' } = {}) {
  const findings = [];
  if (missing.length > 0) {
    findings.push({
      // #555: the set is tier-resolved, so the evidence names the tier it was
      // measured against. Citing a fixed constant made a blocker unfalsifiable —
      // a reader could not tell whether the finding held at THIS repo's tier.
      id: 'artifacts-missing',
      severity: 'blocker',
      evidence: `governance-tiers requiredArtifactsFor("${tier}") missing: ${missing.join(', ')}`,
      cites: `governance-tiers.mjs requiredArtifactsFor (tier "${tier}", ADR-0026)`,
    });
  }
  // #555 round 3, on the maintainer's ruling: the SDD must be EXECUTED at every
  // tier, `lite` included. That is Rule C's question, not Rule A's, so it does not
  // ride on the tier's artefact set — an absent tasks.md blocks here even where the
  // tier does not list it among the required artefacts. Reported as its own finding
  // rather than folded into `tasks-no-progress`, because "you never wrote one" and
  // "you wrote one and completed nothing" are different things to tell an author.
  if (tasksAbsent) {
    findings.push({
      id: 'tasks-absent',
      severity: 'blocker',
      evidence: 'no tasks.md in the change dir — the SDD leaves no record of having been executed',
      cites: 'phase-order-check.mjs evaluateRuleC (code without completed phases; not tier-scoped)',
    });
  }
  if (hasCheckedTask === false) {
    findings.push({
      id: 'tasks-no-progress',
      severity: 'blocker',
      evidence: 'tasks.md has zero "- [x]" entries',
      cites: 'sdd-layout.mjs REQUIRED_ARTIFACTS (tasks.md)',
    });
  }
  return findings;
}

// ── §10.3 prior pins applied, each cited file:line ──────────────────────────
// NOTE: the `pin` field's exact shape is provisional — the ruling evaluator
// that WRITES it (H1-4) has not shipped yet. This reads whatever a prior
// verdict's `.memory/records/` entry carries under `pin.citation`; tighten
// once H1-4 lands its writer.
function checkPriorPins(pins = [], exists) {
  const findings = [];
  for (const pin of pins) {
    // A truthy non-string citation would throw on `.split(':')` — treat it as a missing/invalid citation, not a crash.
    if (!pin.citation || typeof pin.citation !== 'string') {
      findings.push({
        id: `pin:${pin.id}`,
        severity: 'blocker',
        evidence: `pin "${pin.id}" carries no file:line citation`,
        cites: 'reviewer-protocol.md §8 pin: payload',
      });
      continue;
    }
    const file = pin.citation.split(':')[0];
    if (!exists(file)) {
      findings.push({
        id: `pin:${pin.id}`,
        severity: 'blocker',
        evidence: `pin "${pin.id}" cites ${pin.citation} — file not found in the reviewed tree`,
        cites: 'reviewer-protocol.md §8 pin: payload',
      });
    }
  }
  return findings;
}

// ── §10.4 TDD-RED by reversion ──────────────────────────────────────────────
function checkReversion(reversion) {
  if (!reversion || reversion.uncomputable) return { findings: [], uncomputable: true, command: reversion?.command ?? null };
  const findings = (reversion.vacuousTests ?? []).map((testFile) => ({
    id: `reversion:${testFile}`,
    severity: 'blocker',
    evidence: `${reversion.command} — "${testFile}" PASSED after reverting the implementation to base (vacuous test)`,
    cites: 'reviewer-protocol.md §10 TDD-RED by reversion',
  }));
  return { findings, uncomputable: false };
}

// ── §10.5 audit/governance-status quoted + decision-gate step-2 → ruling ────
function checkAuditGovernance({ auditOutput, governanceStatusOutput } = {}) {
  const findings = [];
  if (auditOutput) findings.push({ id: 'audit-output', severity: 'editorial', evidence: `brain:audit — ${auditOutput}` });
  if (governanceStatusOutput) {
    findings.push({ id: 'governance-status-output', severity: 'editorial', evidence: `brain:governance-status — ${governanceStatusOutput}` });
  }
  return findings;
}

function checkDecisionSurface({ changedFiles = [], hasDecisionLabel } = {}) {
  const touched = changedFiles.filter(matchesArchitecturalSurface);
  if (touched.length === 0 || hasDecisionLabel) return [];
  // A checkpoint is a cold, deliberate audit — the CI step-2 heuristic only
  // WARNS (workflow-governance.md Invariant 4); here it becomes a real
  // finding that forces the human question "is this a decision?" rather than
  // a silently-ignorable ::warning::.
  return [{
    id: 'decision-surface',
    severity: 'blocker',
    evidence: `touches an architectural surface without the "decision" label: ${touched.join(', ')}`,
    cites: 'workflow-governance.md Invariant 4 step 2 (decision-gate)',
  }];
}

/**
 * The control classes this evaluator is capable of producing (#683).
 *
 * Every check it runs is mechanical — a fetched gate-status rollup, a
 * `git diff --numstat`, a regex over a body, an `existsSync`, a base-sha
 * reversion — so `deterministic` is the whole of it, for the reason
 * `lib/causal-admission.mjs` already states about the same three evaluators.
 *
 * Declared HERE rather than inferred at the call site: this is the file that
 * would change if the answer ever changed, and a declaration that lives next to
 * the code it describes is the one that gets updated with it.
 */
export const PRODUCES = Object.freeze(['deterministic']);

/**
 * Pure core (design.md §5 style). Reuses `evaluateTranche`'s findings/gates
 * verbatim and layers the five checkpoint-only checks on top.
 * @returns {{ conclusion: 'APPROVE'|'REVISE', gates: object, findings: object[], conditions: string[] }}
 */
export function evaluateCheckpoint({
  trancheInputs = {},
  reportClaims = [],
  artifacts = {},
  pins = [],
  reversion = null,
  uncomputable = [],
  auditOutput = '',
  governanceStatusOutput = '',
  changedFiles = [],
  hasDecisionLabel = false,
  exists = () => true,
} = {}) {
  const tranche = evaluateTranche(trancheInputs);
  const findings = [...tranche.findings];
  const conditions = [...tranche.conditions];

  findings.push(...checkReportDrift(reportClaims));
  findings.push(...checkArtifactCompleteness(artifacts));
  findings.push(...checkPriorPins(pins, exists));

  // #495 D4: "could not be computed" is a LIST of reasons, not a property of the
  // reversion. The reversion was the first thing that could be uncomputable and
  // its handling was written in place; the declared budget claim is the second,
  // and a second `if` here would be two implementations of §10's one rule
  // ("never APPROVE on uncomputable evidence"). One list, one sentence, one
  // effect on the conclusion.
  const uncomputableReasons = [...uncomputable];
  const rev = checkReversion(reversion);
  if (rev.uncomputable) {
    uncomputableReasons.push(`TDD-RED reversion (${rev.command ?? 'base sha unresolvable'})`);
  } else {
    findings.push(...rev.findings);
  }
  for (const reason of uncomputableReasons) conditions.push(`evidence uncomputable: ${reason}`);

  findings.push(...checkAuditGovernance({ auditOutput, governanceStatusOutput }));
  findings.push(...checkDecisionSurface({ changedFiles, hasDecisionLabel }));

  const anyBlocker = findings.some((f) => f.severity === 'blocker');
  const anyUncomputable = uncomputableReasons.length > 0;
  const conclusion =
    tranche.conclusion === 'REVISE' || anyBlocker || anyUncomputable ? 'REVISE' : 'APPROVE';

  // #750: UNION, not overwrite. Tranche's uncomputable causes are not
  // findings and are invisible to `anyBlocker` above — a checkpoint whose own
  // checks are all clean but whose inherited tranche result was uncomputable
  // must still declare 'uncomputable'. Deduped (blocker genuinely can arrive
  // from both tranche and checkpoint's own checks) and deliberately NOT
  // sorted — the only consumer is `length > 0 && every(=== 'blocker')`.
  const conclusionCauses = [...new Set([
    ...tranche.conclusionCauses,
    ...(anyBlocker ? ['blocker'] : []),
    ...(anyUncomputable ? ['uncomputable'] : []),
  ])];

  return { conclusion, gates: tranche.gates, findings, conditions, conclusionCauses };
}

function childTestEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// True iff `path` exists at `ref` (non-throwing): `git cat-file -e <ref>:<path>`
// exits 0 when the blob exists — tells an impl file the PR MODIFIED (exists at
// base) apart from one it ADDS (absent at base).
function existsAtRef({ cwd, ref, path }) {
  try { execFileSync('git', ['cat-file', '-e', `${ref}:${path}`], { cwd, encoding: 'utf8' }); return true; } catch { return false; }
}

// COLDBOOT-CWD-style isolation (protocol §8): NEVER `git checkout` in the
// operator's cwd. The revert + the PR's new tests run in a SEPARATE detached
// worktree, torn down after. Mirrors cold-boot.mjs's defaultCloneDetached.
export function defaultRunReversion({ cwd = process.cwd(), tmp = tmpdir() } = {}) {
  return ({ baseSha, headSha, implFiles = [], testFiles = [] }) => {
    if (!baseSha || !headSha) return { uncomputable: true, command: null };
    const worktreePath = join(tmp, `brain-review-reversion-${headSha}`);
    // Wrap the WHOLE body: an unexpected git/fs failure must NOT escape and
    // crash brain:review — it degrades to fail-closed (uncomputable → REVISE).
    try {
      try { execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd, encoding: 'utf8' }); } catch { /* no prior worktree */ }
      execFileSync('git', ['worktree', 'add', '--detach', worktreePath, headSha], { cwd, encoding: 'utf8' });

      // Bring each impl file to its BASE state: files that EXIST at base are
      // reverted; files ABSENT at base (the PR ADDS them) have no base content,
      // so REMOVE them. Passing an added path to `git checkout <base>` exits 1
      // (pathspec did not match) and aborts the ENTIRE batch — so partition.
      const toRevert = [];
      const toRemove = [];
      for (const path of implFiles) {
        if (existsAtRef({ cwd: worktreePath, ref: baseSha, path })) toRevert.push(path);
        else toRemove.push(path);
      }
      if (toRevert.length > 0) execFileSync('git', ['checkout', baseSha, '--', ...toRevert], { cwd: worktreePath, encoding: 'utf8' });
      for (const path of toRemove) rmSync(join(worktreePath, path), { force: true });

      const revertCmd = toRevert.length > 0 ? `git checkout ${baseSha} -- ${toRevert.join(' ')}` : '';
      const rmCmd = toRemove.length > 0 ? `rm ${toRemove.join(' ')}` : '';
      const command = [revertCmd, rmCmd, `node --test ${testFiles.join(' ')}`].filter(Boolean).join(' && ');
      const vacuousTests = [];
      for (const testFile of testFiles) {
        try {
          // NODE_TEST_CONTEXT must NOT leak into this child (gotcha: when this
          // evaluator itself runs under `node --test`, the inherited env var
          // trips node's recursive-test guard and the child silently SKIPS
          // running the file, exiting 0 — a false "vacuous" negative).
          execFileSync('node', ['--test', testFile], { cwd: worktreePath, encoding: 'utf8', env: childTestEnv() });
          vacuousTests.push(testFile); // passed against base — vacuous, never tested the change
        } catch { /* failed against base — real RED, exactly what TDD requires */ }
      }
      return { uncomputable: false, command, vacuousTests };
    } catch {
      // Fail-closed: an unexpected failure is uncomputable evidence, never a crash.
      return { uncomputable: true, command: null };
    } finally {
      try { execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd, encoding: 'utf8' }); } catch { /* best effort */ }
    }
  };
}

const defaultExec = (file, args, opts) => execFileSync(file, args, opts);

function defaultRunAudit({ cwd = process.cwd(), exec = defaultExec } = {}) {
  return () => {
    try { return exec('node', ['brain/scripts/brain-audit.mjs'], { cwd, encoding: 'utf8' }).trim(); } catch (err) { return String(err.stdout ?? err.message ?? '').trim(); }
  };
}

function defaultRunGovernanceStatus({ cwd = process.cwd(), exec = defaultExec } = {}) {
  return () => {
    try { return exec('node', ['brain/scripts/brain-governance-status.mjs'], { cwd, encoding: 'utf8' }).trim(); } catch (err) { return String(err.stdout ?? err.message ?? '').trim(); }
  };
}

/**
 * Gathers `evaluateCheckpoint`'s inputs. Mirrors `gatherTrancheInputs` — the
 * tranche portion is delegated wholesale (no re-implementation). Every
 * additional seam (`exists`/`listDir`/`readFile`/`runReversion`/`runAudit`/
 * `runGovernanceStatus`) is injectable; production defaults resolve against
 * `worktreePath` (cold-boot's isolated detached checkout) or `process.cwd()`.
 *
 * @param {{ project, number, provider, headSha, changedFiles, prBody, labels,
 *   worktreePath, doctrineRecords, deps }} args
 */
export async function gatherCheckpointInputs({
  project,
  number,
  provider,
  headSha,
  changedFiles = [],
  prBody = '',
  // #1073 rev 4: `null`, NOT `[]`. A default of `[]` MINTS a claim — "the PR
  // was read and carries no exception" — for a caller that simply did not
  // pass any, and this evaluator forwards that value into the tranche gather,
  // where it decides whether a budget block says the labels were unread.
  // Hardening the consumers was not enough while the default was still
  // manufacturing the false reading upstream of them (R1072-5).
  labels = null,
  worktreePath,
  doctrineRecords = [],
  tier = 'standard',
  deps = {},
} = {}) {
  const baseSha = deps.baseSha ?? null; // fed by cli.mjs (ci-context → prView.baseRefOid, ADR-0022); tests inject directly

  const trancheInputs = await gatherTrancheInputs({
    // #1072: this evaluator already takes the PR's labels for
    // `hasDecisionLabel`; the budget needs the same set, and reading them here
    // rather than fetching keeps one reading of the PR per run.
    project, number, provider, headSha, baseSha, changedFiles, prBody, labels, deps: deps.trancheDeps ?? {},
  });

  const root = worktreePath ?? process.cwd();
  const exists = deps.exists ?? ((p) => existsSync(join(root, p)));
  const listDir = deps.listDir ?? ((p) => readdirSync(join(root, p)));
  const readFile = deps.readFile ?? ((p) => readFileSync(join(root, p), 'utf8'));

  const changeId = deps.changeId ?? resolveChangeId(changedFiles);
  let artifacts = { missing: [], hasCheckedTask: null, tasksAbsent: false, tier };
  let reportClaims = [];
  // Evidence this run could not compute, each entry a REASON rather than a flag
  // (#495 design D4). `evaluateCheckpoint` turns them into `conditions:` and
  // REVISE, under §10's general rule "never APPROVE on uncomputable evidence".
  const uncomputable = [];
  if (changeId) {
    const missing = missingRequiredArtifacts(changeId, { artefacts: requiredArtifactsFor(tier), exists, listDir });
    // #555 round 3: guarded on the file EXISTING, not on the artefact set.
    //
    // `!missing.includes('tasks.md')` was a proxy for "tasks.md is there", and it
    // held only while every tier required it. At `lite` the set is ['spec'], so
    // tasks.md is never in `missing`, the read always ran, and an ABSENT file read
    // as "present with zero checked items" — the `artifacts-missing` blocker was
    // renamed to `tasks-no-progress`, not removed. A cold review caught it; the
    // test written for that case asserted only `artifacts.missing` and never called
    // `evaluateCheckpoint`, so it could not see the blocker its own title denied.
    //
    // The two questions are separate and the repo already separates them:
    // Rule A asks WHICH ARTEFACTS a tier requires (tiered); Rule C asks whether the
    // SDD was EXECUTED — code without completed phases — and is not tiered. The
    // maintainer ruled 2026-08-13 that the second holds at `lite` too: "por más que
    // sea lite, el SDD debe ser ejecutado."
    //
    // So: absent → `null`, uncomputable, reported as its own finding. Present with
    // no `- [x]` → `false`, the real no-progress blocker. Never conflated.
    const tasksPath = `${changeDir(changeId)}/tasks.md`;
    let hasCheckedTask = null;
    let tasksAbsent = false;
    if (exists(tasksPath)) {
      try { hasCheckedTask = /^- \[x\]/im.test(readFile(tasksPath)); } catch { hasCheckedTask = false; }
    } else {
      tasksAbsent = true;
    }
    artifacts = { missing, hasCheckedTask, tasksAbsent, tier };

    // #495: the claim is DECLARED, and read from the declared block alone. The
    // guard this replaced was `!missing.includes('checkpoint-report.md')` —
    // always true, since no tier lists the report among its artefacts — wrapped
    // in a bare `catch` that made an unreadable report indistinguishable from a
    // report with nothing to say. Both silences are gone: every path below ends
    // in either a claim or a STATED reason.
    let reportText = null;
    const reportPath = `${changeDir(changeId)}/checkpoint-report.md`;
    if (exists(reportPath)) {
      try { reportText = readFile(reportPath); } catch { reportText = null; }
    }
    const claim = parseCheckpointClaim(reportText);
    if (claim.ok) {
      reportClaims = [{
        key: 'counted-lines',
        claimed: claim.countedLines,
        recomputed: trancheInputs.budget?.lines ?? null,
        // The report DECLARES the budget it judged itself against; this repo
        // resolves its own through the one tier→number path `gatherTrancheInputs`
        // owns (#472/#443). A disagreement is report drift in its own right, and
        // it is now a comparison of two declared values rather than an inference.
        declaredBudget: claim.diffBudget,
        matchesTierBudget: claim.diffBudget === (trancheInputs.diffBudget ?? null),
        tierBudget: trancheInputs.diffBudget ?? null,
        tier: trancheInputs.tier ?? null,
      }];
    } else {
      // Ruling point 2: unparseable must SAY SO. `null` here would be
      // indistinguishable from "the report made no claim", which is this
      // ticket's own defect reproduced inside its fix.
      uncomputable.push(`report budget claim — ${claim.error}`);
    }
  }

  const pins = (doctrineRecords ?? [])
    .filter((r) => r?.pin)
    .map((r) => ({ id: r.id ?? r.source ?? 'unknown', citation: r.pin?.citation ?? null }));

  const testFiles = deps.testFiles ?? changedFiles.filter((f) => f.endsWith('.test.mjs'));
  const implFiles = deps.implFiles ?? changedFiles.filter((f) => /\.mjs$/.test(f) && !f.endsWith('.test.mjs'));

  const runReversion = deps.runReversion ?? defaultRunReversion(deps);
  const reversion = baseSha ? await runReversion({ baseSha, headSha, implFiles, testFiles }) : { uncomputable: true, command: null };

  // §10.5 evidence is gathered against the COLD head (`root` = the isolated
  // worktree, per cold-boot.mjs's invariant), NOT the operator's live tree.
  const runAudit = deps.runAudit ?? defaultRunAudit({ cwd: root, exec: deps.exec });
  const runGovernanceStatus = deps.runGovernanceStatus ?? defaultRunGovernanceStatus({ cwd: root, exec: deps.exec });

  return {
    trancheInputs,
    reportClaims,
    artifacts,
    pins,
    reversion,
    uncomputable,
    auditOutput: runAudit(),
    governanceStatusOutput: runGovernanceStatus(),
    changedFiles,
    // #1073: `labels = []` is a DEFAULT, and a default only applies to
    // `undefined`. `review/cli.mjs` hands this evaluator
    // `boot.prView.labels ?? null`, so a refused forge read arrives as `null`
    // and `null.includes` threw — a checkpoint review crashing on a failure it
    // was supposed to survive. Nobody read the labels, so nobody can claim a
    // decision label is there: false, which is also the closed direction.
    hasDecisionLabel: Array.isArray(labels) && labels.includes('decision'),
    labels,
    exists,
  };
}
