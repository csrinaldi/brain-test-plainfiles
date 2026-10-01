// governance-checks.mjs — Single source of truth for governance check contexts (S3).
//
// GOVERNANCE_JOBS is the tier-independent full job set that must stay in sync with
// the job name: fields in .github/workflows/governance.yml — every job runs and
// reports at every tier (REQ-TIER-3); only its EXIT POLICY and branch-protection
// membership vary by tier. A drift-guard unit test parses the YAML and asserts the
// set matches — fail-closed.
//
// Two-tier registry (governance v3, design §7), now DERIVED from the tier matrix
// (issue #358 Q5, REQ-TIER-9) instead of two hand-maintained literals:
// `requiredJobs(tier)` (governance-tiers.mjs) replaces the old REQUIRED_JOBS
// constant, and `checkContexts(tier)` derives branch-protection's required-context
// list from the SAME resolution — neither surface may carry an independent copy of
// the matrix (REQ-TIER-9).
//
// REQUIRED_JOBS/DETECTION_JOBS stay exported as backward-compatible aliases, a
// SNAPSHOT of requiredJobs('standard')/its complement taken at import time —
// see each constant's own STALE CONTRACT WARNING below. Phase 5 (issue #358 Q5)
// emptied PENDING_PROMOTION, so `requiredJobs('standard')` grew from 5 jobs to
// all 8 and DETECTION_JOBS collapsed to `[]`: these constants no longer
// reproduce "today's shipped split" for every tier — they are a 'standard'-only
// snapshot. New code should call requiredJobs(tier)/resolveJobSets(tier)/
// checkContexts(tier) directly (tier-scoped); migrating the remaining
// literal-array importers (review/evaluators/tranche.mjs, lib/metrics-aggregate.mjs)
// to the tier-aware call is tracked per-caller below.
//
// When adding a job: add a GATE_MATRIX row (governance-tiers.mjs) AND add the job to
// governance.yml in the same commit, or the drift-guard test turns red.

import { requiredJobs } from './governance-tiers.mjs';

/**
 * The full set of job names governance.yml must define — tier-independent
 * (REQ-TIER-3: every job runs at every tier; only its exit policy varies). The
 * drift-guard test asserts the YAML job name: fields equal this set, in this
 * exact order (REQUIRED-today jobs first, then DETECTION-today jobs — mirrors
 * governance.yml's job ordering).
 *
 * @type {string[]}
 */
export const GOVERNANCE_JOBS = [
  'issue-link',
  'diff-size',
  'local-checks',
  'memory-gate',
  'decision-gate',
  'phase-order',
  'actor-check',
  'brain-writes-reviewed',
  // #905 (ADR-0034 L1/C1) — APPENDED AT THE END: governance-checks.test.mjs's
  // order-guard asserts governance.yml's job order equals this array exactly.
  'lane-paths',
  'lane-scrub',
  'base-branch',
];

/**
 * Deprecated backward-compatible alias — a SNAPSHOT of `requiredJobs('standard')`
 * (governance-tiers.mjs) taken at import time, for importers that have not yet
 * migrated to tier-aware resolution.
 *
 * STALE CONTRACT WARNING (issue #358 Q5 Phase 5 review finding): this constant
 * used to "reproduce exactly what REQUIRED_JOBS was before tiering landed"
 * (REQ-TIER-10's no-op-migration guarantee) — that was true for Phases 1-4
 * ONLY, while `phase-order`/`actor-check`/`brain-writes-reviewed` sat on
 * `PENDING_PROMOTION` (governance-tiers.mjs). Phase 5 emptied
 * `PENDING_PROMOTION`: `requiredJobs('standard')` GREW from 5 jobs to all 8
 * (design.md §4.1, a ratified departure from REQ-TIER-10). This constant
 * still equals `requiredJobs('standard')` — it is simply no longer a no-op
 * with pre-tiering history. It is ALSO tier-blind: a repo declaring `lite` or
 * `regulated` gets the WRONG split from this constant (e.g. `lite`'s
 * `phase-order` is `detection`, not `required` — this constant reports it as
 * required anyway, because it was captured at `'standard'`).
 *
 * Prefer `requiredJobs(tier)` (or `resolveJobSets(tier)` below) in new code —
 * anything that needs to be correct for a repo's OWN declared tier (e.g.
 * brain's own `lite`) must not read this constant.
 *
 * @type {string[]}
 */
export const REQUIRED_JOBS = requiredJobs('standard');

/**
 * Deprecated backward-compatible alias — the GOVERNANCE_JOBS not in
 * REQUIRED_JOBS at the default 'standard' tier. Same STALE CONTRACT WARNING as
 * REQUIRED_JOBS above applies: this is now `[]` (every gate promoted to
 * `required` at `standard` in Phase 5) and is tier-blind (wrong at `lite`,
 * where `phase-order` is genuinely `detection`). Prefer resolving policy via
 * `resolveGatePolicy(gate, tier)` or `resolveJobSets(tier)` in new code.
 *
 * @type {string[]}
 */
export const DETECTION_JOBS = GOVERNANCE_JOBS.filter(job => !REQUIRED_JOBS.includes(job));

/**
 * Resolves BOTH job sets for a tier in one call (issue #358 Q5 Phase 5 review
 * finding) — the tier-aware replacement for reading REQUIRED_JOBS/
 * DETECTION_JOBS directly. `required` is `requiredJobs(tier)` (already
 * PENDING_PROMOTION-filtered); `detection` is simply GOVERNANCE_JOBS minus
 * that set, computed fresh per call (never a stale snapshot).
 *
 * @param {'lite'|'standard'|'regulated'} [tier='standard']
 * @returns {{ required: string[], detection: string[] }}
 */
export function resolveJobSets(tier = 'standard') {
  const required = requiredJobs(tier);
  const detection = GOVERNANCE_JOBS.filter(job => !required.includes(job));
  return { required, detection };
}

/**
 * Returns the required GitHub check-run names for branch protection at a tier
 * (REQ-TIER-9 — the SAME resolution `run-check.mjs`'s exit-policy mapping
 * uses, via `governance-tiers.mjs#requiredJobs`).
 *
 * GitHub Actions names a check-run after the job's OWN `name:` field ONLY — the
 * workflow name is a UI grouping label shown next to the check, never part of the
 * check-run's identity that branch protection matches against. A "{workflow.name} /
 * {job.name}" prefix here would produce a required context that no check-run can
 * ever satisfy, silently hard-blocking every PR (issue #203; caught on PR #202
 * despite all REQUIRED_JOBS reporting green). This function derives contexts from
 * requiredJobs(tier) only — the rest of GOVERNANCE_JOBS run and report but never
 * block merge at this tier.
 *
 * @param {'lite'|'standard'|'regulated'} [tier='standard']
 * @returns {string[]}  e.g. ['issue-link', 'diff-size', 'local-checks']
 */
export function checkContexts(tier = 'standard') {
  return [...requiredJobs(tier)];
}

/**
 * Classifies a branch's actual check-run names against the required contexts for
 * the `brain:protect` arm-and-verify step (issue #203, deliverable 3). Warns,
 * never fails: a freshly protected branch legitimately has zero check-runs before
 * its first PR runs, so zero runs collapses to a single "unverifiable" result
 * rather than one warning per required context (which would be noise, not signal).
 *
 * @param {string[]} requiredContexts   e.g. checkContexts()
 * @param {string[]} existingCheckRunNames  check-run names found on the branch's latest commit
 * @returns {{ unverifiable: boolean, missing: string[] }}
 */
export function diffArmedChecks(requiredContexts, existingCheckRunNames) {
  if (existingCheckRunNames.length === 0) {
    return { unverifiable: true, missing: [] };
  }
  return {
    unverifiable: false,
    missing: requiredContexts.filter(context => !existingCheckRunNames.includes(context)),
  };
}
