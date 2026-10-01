// causal-admission.mjs — issue #394 (M3), completing #284: bridges the three
// deterministic evaluators (tranche.mjs, checkpoint.mjs, ruling.mjs) into the
// brain-review/2 causal-admission pipeline (verdict.mjs, schema-v2.mjs) at
// cli.mjs's single buildVerdict convergence point — the same seam issue-391's
// T2.3 design.md §3 (Q3.1) identifies as "the single place any mode's
// evalResult ... converges before a verdict is constructed."
//
// WHY annotate here, not inside tranche/checkpoint/ruling: those three stay
// pure, tier-unaware evaluators (design.md §5 style) — they answer "what is
// wrong with this candidate", never "which protocol is this repo on". Every
// finding they produce comes from a mechanical check (a fetched gate-status
// rollup, `git diff --numstat`, a regex over the PR body, `existsSync`, a
// base-sha reversion + `node --test`) — never an LLM inference — so
// `evidence_class: 'deterministic'` is always correct for them. And because
// each check is RE-DERIVED fresh against THIS candidate's own state (the
// rollup fetched for THIS head_sha, the budget diffed for THIS base...head,
// the reversion's OWN base-sha checkout), a finding one of them emits
// describes something true of / introduced by the candidate under review —
// never a defect merely inherited unchanged from base — so the safe default
// causal_disposition is 'introduced', never 'unknown' (T2.3 design.md §7,
// §9: defaulting to `unknown` here would force every real finding to
// `escalate: human`, the "escalation storm" issue #394 explicitly guards
// against) and never 'pre-existing'/'base-only' (none of these checks
// compare against base closely enough to honestly claim that — inventing
// the claim would be worse than omitting it).
//
// The refuter (evaluators/refuter.mjs, issue #284, REQ-H2-1) runs AFTER
// annotation, lazily (design.md FORK 1: only when >=1 blocker carries
// `evidence_class: 'inferential'`) — a no-op today, since no evaluator yet
// produces an inferential finding, but genuinely WIRED into the execution
// path (not dead code) so a future inferential finding-producer needs no
// second integration point.
//
// ISSUE #408 amends the sentence above about `pre-existing`. It stays true of
// tranche/checkpoint/ruling themselves — none of them compares against base —
// and it is no longer true of this pipeline, because a step that DOES compare
// now runs between the annotation and the refuter: `base-comparison.mjs`
// re-derives `local-checks` in a worktree at base and re-classifies a gate
// finding that fails there too. The default stays `introduced`; the override
// only ever fires on an observation, never on an absence.
//
// ORDER IS LOAD-BEARING: annotate → classify against base → refute. The
// refuter forks on BLOCKERS, and a finding reclassified to `pre-existing` is
// on its way out of the blocking set (`verdict.mjs`), so refuting it would be
// challenging a finding that no longer blocks anything.

import { evaluateRefuter } from '../evaluators/refuter.mjs';
import { classifyAgainstBase } from './base-comparison.mjs';

const DEFAULT_EVIDENCE_CLASS = 'deterministic';
const DEFAULT_CAUSAL_DISPOSITION = 'introduced';

/**
 * Fills `evidence_class`/`causal_disposition` on findings that don't already
 * carry them (a future finding-producer's own classification always wins).
 * Pure — never mutates its input.
 *
 * @param {Array<object>} findings
 * @returns {Array<object>}
 */
export function annotateDeterministicFindings(findings = []) {
  return findings.map((f) => ({
    evidence_class: DEFAULT_EVIDENCE_CLASS,
    causal_disposition: DEFAULT_CAUSAL_DISPOSITION,
    ...f,
  }));
}

/**
 * REQ-H2-1: annotates, then runs the refuter over the result — lazily
 * (FORK 1), a no-op unless >=1 blocker carries `evidence_class:
 * 'inferential'`. Merges the refuter's forced `escalate: 'human'` (an
 * `inconclusive` outcome, REQ-H2-1 Scenario 1.4) with whatever `escalate`
 * the calling evaluator (e.g. ruling.mjs) already set — the refuter's
 * escalation always wins when it fires, since it is strictly MORE
 * conservative than "no escalation yet decided".
 *
 * `baseProbe`/`probeAttempted` (issue #408) carry the base re-run's result to the
 * classifier. `null` + `probeAttempted: false` is the common case — no
 * base-comparable blocker existed, so nothing was run and nothing is reported.
 * `null` + `probeAttempted: true` is a probe that FAILED, which surfaces as a
 * condition and leaves every finding blocking.
 *
 * `conditions` is returned, not merged: the caller owns the evaluator's own
 * condition list and this function has no business rewriting it.
 *
 * @param {{ findings?: Array<object>, escalate?: string|null, runner?: Function|null,
 *   baseProbe?: object|null, probeAttempted?: boolean }} args
 * @returns {Promise<{ findings: Array<object>, escalate: string|null, conditions: string[] }>}
 */
export async function applyCausalAdmission({
  findings = [], escalate = null, runner = null,
  baseProbe = null, probeAttempted = false,
} = {}) {
  const annotated = annotateDeterministicFindings(findings);
  const classified = classifyAgainstBase({ findings: annotated, baseProbe, probeAttempted });
  const refuterResult = await evaluateRefuter({ findings: classified.findings, runner });
  // #552: a reasoned blocker nobody challenged is stated on the verdict, not
  // only annotated on the finding. `conditions` is the field protocol §10 already
  // uses for "the evidence behind this verdict is weaker than it looks", and this
  // is that exactly — the finding-level `refuter_outcome` says WHICH one, the
  // condition says the run as a whole had no challenger available.
  const conditions = [...classified.conditions];
  if (refuterResult.unchallenged > 0) {
    conditions.push(
      `${refuterResult.unchallenged} inferential blocker(s) were NOT challenged — no refuter runner is configured`,
    );
  }
  return {
    findings: refuterResult.adjustedFindings,
    escalate: refuterResult.escalate ?? escalate,
    conditions,
  };
}
