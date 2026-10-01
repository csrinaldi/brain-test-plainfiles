// writes-governed.mjs — the human-gate invariant, read on MERGED HISTORY (issue #511).
//
// Same question L6 asks at PR time, same evaluator, same per-tier evidence from
// ADR-0026's GATE_MATRIX. What differs is the only thing that CAN differ: what an
// ABSENCE of review evidence means at the moment it is read.
//
//   PR time        absent reviews = "not reviewed YET"   → warn. Correct: failing
//                  here would block every freshly-opened PR before anyone could
//                  look at it. That is REQ-L6-1's "never failing on missing
//                  evidence", and it is deliberate.
//   merged history absent reviews = "never reviewed"      → FAIL. There is no
//                  later. The merge already happened.
//
// This is why L6 could not simply be reused as-is on the audit (the conclusion the
// #511 investigation reached the long way): the evaluator was always right, the
// READING of its `warn` was not.
//
// NOT re-implemented here. `evaluateBrainWritesReviewed` is called directly, so the
// tier matrix, the agent-authorship exclusion and the approver-set logic have exactly
// one definition. Two implementations of one rule is the class this repo batches under
// #315/#316/#340 — and #340 is that exact defect for `issue-link`, still open.
//
// NOT tree-keyed. It keys on PR metadata, like `issueLink`, not on the commit's tree,
// so it is deliberately absent from TREE_KEYED_CHECKS: it never emits [FAIL-SHA] and
// never auto-reverts. The remedy for "nobody reviewed this" is a human reviewing it,
// not a machine undoing it.

import { evaluateBrainWritesReviewed } from '../../vcs/brain-writes-reviewed.mjs';

/**
 * @param {object} input
 * @param {string[]} input.changedFiles
 * @param {Array} input.reviews  From `prReviews`. A failed call never reaches here —
 *   fetchPrMeta turns it into prMetaError, the channel the audit already understands.
 * @param {string|null} input.author  PR author login.
 * @param {boolean} input.prResolved  Whether a PR was resolved for this merge at all.
 * @param {string[]} [input.botAllowlist]  `governance.reviewActors`.
 * @param {'lite'|'standard'|'regulated'} [input.tier]
 * @returns {{ pass?: boolean, abstain?: boolean, reason?: string }}
 */
export function writesGoverned({
  changedFiles = [],
  reviews = null,
  author = null,
  prResolved = false,
  botAllowlist = [],
  tier = 'standard',
} = {}) {
  // ABSTENTION, not a verdict and not "uncomputable". #474 established that a merge
  // with no PR reference stays EVALUABLE — its lack of a PR is a fact about the merge,
  // not a failure to read one. A check that cannot speak about such a merge must say
  // nothing at all: failing it re-poisons the windows #474 cleared, and passing it is a
  // silent fail-open.
  //
  // Abstention is expressed as ABSENCE from the result set (see evaluateMerge), so the
  // walk learns no fourth state. A read FAILURE is a different animal and does not
  // arrive here: fetchPrMeta routes it through the established prMetaError channel,
  // which the audit already handles before this check ever runs.
  if (!prResolved || reviews === null || reviews === undefined) {
    return {
      abstain: true,
      reason: prResolved
        ? 'this adapter does not implement prReviews — the human-gate invariant cannot be '
          + 'answered here at all. A capability gap, not a failed read.'
        : 'no pull request for this merge — the human-gate invariant has no evidence to '
          + 'read here, and absence of a PR is a fact about the merge, not a failed read (#474).',
    };
  }

  const l6 = evaluateBrainWritesReviewed({ changedFiles, reviews, author, botAllowlist, tier });

  if (l6.level === 'pass') return { pass: true, reason: l6.reason };
  if (l6.level === 'fail') return { pass: false, reason: l6.reason };

  // `warn` — L6's "no evidence YET". Read on merged history, there is no yet.
  return {
    pass: false,
    reason: `${l6.reason} Read on merged history, where "not yet" is "never": the merge has `
      + 'already happened, so this is a failure rather than a warning (#511).',
  };
}
