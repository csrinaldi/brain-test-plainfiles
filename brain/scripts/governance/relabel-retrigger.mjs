// relabel-retrigger.mjs — governance-relabel workflow entrypoint (issue #328).
//
// The bug: governance.yml runs on `pull_request` events only. Two of its
// gates depend on human approval that can arrive AFTER a PR opens — the
// status:approved label applied to the issue the PR references (issue #124):
//   - issue-link (bash, REQUIRED): fails if the issue isn't yet approved when
//     the job runs → stale RED.
//   - actor-check (vcs/actor-check.mjs's evaluateActor, DETECTION): returns
//     { level: 'warn' } (green) when zero `labeled` events exist yet — by
//     design, "never fail on missing evidence" (REQ-L5-2). Once approval
//     lands this should re-evaluate to fail (self-approval) or pass, but
//     nothing ever re-runs the job → stale GREEN, the worse failure (a PR
//     merged on a verdict computed before the fact it depends on existed).
//
// Both evaluators already read CURRENT state every time they run — they are
// not themselves buggy. The only missing piece is a TRIGGER: this script,
// invoked by .github/workflows/governance-relabel.yml on `issues: labeled`,
// finds every OPEN PR whose body references the just-approved issue and
// forces a FULL rerun of governance.yml for each (via the GitHub-only
// `rerunWorkflowRun` verb, axes/vcs/adapters/github.mjs) — never `gh run rerun
// --failed`, which only reruns already-failed jobs and would leave the
// stale-green actor-check untouched, the literal bug being fixed here.
//
// Note (#329, tracked separately, out of scope here): once this fix lands,
// actor-check (a DETECTION_JOBS, non-blocking gate) will start correctly
// detecting self-approval on this repo's own PRs — expected and safe, since
// it never blocks merge.

import { fileURLToPath } from 'node:url';

import { getVcs } from '../vcs/cli.mjs';
import { CLOSING_RE, CHAIN_RE } from './checks/issue-ref-patterns.mjs';

/**
 * Pure filter: given a list of candidate PRs (each `{ number, headRefName,
 * body }`) and an issue number, returns the subset whose body references
 * that EXACT issue number via a closing keyword ("Closes #328", all 9
 * GitHub-documented forms) or a chain reference ("Part of #328") — reusing
 * the shared CLOSING_RE/CHAIN_RE constants (issue-ref-patterns.mjs) so this
 * never reinvents the vocabulary those regexes already encode.
 *
 * Near-miss numbers (e.g. "#3288", "#32" when the target is 328) do NOT
 * match: CLOSING_RE/CHAIN_RE's own `\d+` capture takes the full contiguous
 * digit run ("3288", "32" respectively, never truncated to "328"), and this
 * function compares that captured number verbatim against `issueNumber`.
 *
 * Scans EVERY closing/chain reference in the body, not just the first —
 * `CLOSING_RE`/`CHAIN_RE` are matched with a per-call global flag (`matchAll`)
 * so a body like "Closes #10\n\nAlso closes #328 as a followup" still matches
 * issue 328 even though it isn't the first reference (a real PR shape; the
 * first-match-only version of this function missed it — see #328 review).
 *
 * @param {Array<{ number: number, headRefName?: string, body?: string|null }>} candidatePrs
 * @param {number} issueNumber
 * @returns {Array<{ number: number, headRefName?: string, body?: string|null }>}
 */
function referencesIssue(body, issueNumber, re, group) {
  const global = new RegExp(re.source, `${re.flags.includes('g') ? re.flags : `${re.flags}g`}`);
  for (const match of body.matchAll(global)) {
    if (Number(match[group]) === issueNumber) return true;
  }
  return false;
}

export function selectReferencingPrs(candidatePrs, issueNumber) {
  return (candidatePrs ?? []).filter(pr => {
    const body = pr.body ?? '';
    return referencesIssue(body, issueNumber, CLOSING_RE, 2) || referencesIssue(body, issueNumber, CHAIN_RE, 1);
  });
}

/**
 * Discovers open PRs and fetches each one's body via `prView` — `mrList`
 * alone does not carry body text (design judgment, issue #328: extending
 * mrList's normalized shape is riskier than a second call through an
 * already-existing contract verb here). Returns the raw candidate list,
 * unfiltered — `selectReferencingPrs` applies the issue-number filter
 * afterward.
 *
 * @param {object} vcs  A resolved `getVcs()` provider module.
 * @param {string} project
 * @returns {Promise<Array<{ number: number, headRefName: string, body: string|null }>>}
 */
async function discoverCandidatePrs(vcs, project) {
  const openPrs = await vcs.mrList({ project, state: 'open' });
  const candidates = [];
  for (const pr of openPrs) {
    const detail = await vcs.prView({ project, number: pr.number });
    candidates.push({ number: pr.number, headRefName: pr.headBranch, body: detail?.body ?? null });
  }
  return candidates;
}

/**
 * Runs the full relabel-retrigger flow: resolve the vcs provider, discover
 * open PRs, filter to those referencing `issueNumber`, and force a FULL
 * governance.yml rerun for each match's head ref. Logs what it did.
 *
 * Never throws — this is a best-effort re-trigger, not a REQUIRED gate: a
 * failure here just means a stale-GREEN PR waits for its next natural
 * `pull_request` trigger instead of crashing the `issues: labeled` workflow.
 * Every I/O step (resolving vcs, discovering PRs, each individual rerun) is
 * wrapped so one PR's failure never aborts the others.
 *
 * @param {{ project: string, issueNumber: number, getVcs?: Function, provider?: string, workflow?: string }} deps
 * @returns {Promise<{ triggered: number[], failed: Array<{ number: number, reason: string }> }>}
 */
export async function run(deps = {}) {
  const { project, issueNumber, getVcs: getVcsFn = getVcs, provider, workflow = 'governance.yml' } = deps;

  if (!project || !issueNumber) {
    console.log(`relabel-retrigger: missing project/issueNumber — nothing to do (project=${project}, issueNumber=${issueNumber}).`);
    return { triggered: [], failed: [] };
  }

  let vcs;
  try {
    vcs = await getVcsFn({ provider });
  } catch (err) {
    console.log(`::warning::relabel-retrigger: could not resolve vcs provider — ${err.message}. Issue #${issueNumber}'s approval-dependent gates will NOT be re-triggered; this is a silent-staleness risk, not just a no-op.`);
    return { triggered: [], failed: [{ number: null, reason: `vcs resolution failed: ${err.message}` }] };
  }

  let candidates;
  try {
    candidates = await discoverCandidatePrs(vcs, project);
  } catch (err) {
    console.log(`::warning::relabel-retrigger: could not discover open PRs — ${err.message}. Issue #${issueNumber}'s approval-dependent gates will NOT be re-triggered; this is a silent-staleness risk, not just a no-op.`);
    return { triggered: [], failed: [{ number: null, reason: `PR discovery failed: ${err.message}` }] };
  }

  const matches = selectReferencingPrs(candidates, issueNumber);
  console.log(`relabel-retrigger: issue #${issueNumber} approved — ${matches.length} open PR(s) reference it.`);

  const triggered = [];
  const failed = [];
  for (const pr of matches) {
    if (!pr.headRefName) {
      console.log(`relabel-retrigger: PR #${pr.number} — no headRefName available, skipping.`);
      failed.push({ number: pr.number, reason: 'no headRefName available' });
      continue;
    }
    try {
      const result = await vcs.rerunWorkflowRun({ project, ref: pr.headRefName, workflow });
      if (result?.ok) {
        console.log(`relabel-retrigger: PR #${pr.number} (${pr.headRefName}) — forced a full rerun of ${workflow} (run ${result.runId}).`);
        triggered.push(pr.number);
      } else {
        console.log(`relabel-retrigger: PR #${pr.number} (${pr.headRefName}) — rerun failed: ${result?.reason ?? 'unknown'}.`);
        failed.push({ number: pr.number, reason: result?.reason ?? 'unknown' });
      }
    } catch (err) {
      console.log(`relabel-retrigger: PR #${pr.number} (${pr.headRefName}) — unexpected error: ${err.message}.`);
      failed.push({ number: pr.number, reason: err.message });
    }
  }

  if (failed.length > 0) {
    console.log(`::warning::relabel-retrigger: ${failed.length} PR(s) failed to retrigger for issue #${issueNumber}: ${failed.map(f => `#${f.number ?? '?'} (${f.reason})`).join('; ')}. These PRs keep their stale verdict until their next natural pull_request trigger — this run should not be treated as green if it reports failures.`);
  }

  return { triggered, failed };
}

/**
 * CLI entrypoint wiring: reads the labeled issue number + repo slug from the
 * GitHub Actions environment (see governance-relabel.yml), runs the flow,
 * and reports a process exit code. Kept separate from `process.exit()`
 * itself so it stays testable (mirrors actor-check.mjs / run-check.mjs's
 * `main()`). Always resolves 0 unless a genuinely unexpected error escapes
 * `run()` (which itself never throws) — this is a best-effort re-trigger,
 * not a gate that should fail the workflow.
 *
 * @param {object} [deps]
 * @returns {Promise<0|1>}
 */
export async function main(deps = {}) {
  const project = deps.project ?? process.env.GITHUB_REPOSITORY;
  const issueNumber = deps.issueNumber ?? Number(process.env.ISSUE_NUMBER);
  const provider = deps.provider ?? 'github';

  try {
    await run({ project, issueNumber, provider, ...deps });
    return 0;
  } catch (err) {
    console.error(`relabel-retrigger: unexpected error — ${err.message}`);
    return 1;
  }
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
