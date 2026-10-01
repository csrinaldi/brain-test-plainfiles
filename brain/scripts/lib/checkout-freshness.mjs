// checkout-freshness.mjs — is the checkout the verb is RUNNING FROM behind the
// base it just fetched? (issue #787)
//
// THE DEFECT THIS CLOSES. `ticket-start.mjs:131` prints `Updating main...` and
// then fetches into `refs/remotes/origin/<base>` — the remote-tracking ref the
// new branch needs as its start point. Nothing else moves: not the local
// branch, not `ROOT`'s working tree, and not the copy of the verb Node already
// loaded.
//
//   The START POINT is refreshed. The VERB is not.
//
// Measured 2026-08-28, right after #783 and #784 merged: `main` at `3c40c32`,
// `origin/main` at `e55fcf1`. The run printed `Updating main...` and created an
// IN-PLACE branch — #784 had made the isolated worktree the default hours
// earlier, and the code that executed predated it. One run mixed old behaviour
// with new content and reported success.
//
// ── WHY THIS WARNS AND DOES NOT REFUSE ──────────────────────────────────────
//
// Every other guard in this area fails closed. This one does not, for a reason
// that changed on the day it was written: **slice 2 of #782 now catches the
// consequence.** A stale run's worst outcome is an in-place branch in the main
// checkout, and `hooks/pre-commit` refuses a commit there. The damage is caught
// downstream by something that cannot be forgotten, so the cost of refusing here
// — blocking an operator who is deliberately on an older base — buys little.
//
// A warning also has an honest failure mode and a refusal does not: a warning
// that is wrong is noise, a refusal that is wrong is a stopped session.
//
// ── WHAT "STALE" MEANS, AND WHAT IT DELIBERATELY DOES NOT ───────────────────
//
// Two facts, both required:
//
//   1. `brain/scripts/**` differs between HEAD and the freshly fetched base.
//      That is the code about to run. A documentation-only gap cannot change
//      what the verb does, and firing on it would train the operator to scroll
//      past the warning — which costs the warning.
//   2. HEAD is an ANCESTOR of the base. Diverged or ahead is what developing the
//      verb itself looks like: the code differs, truthfully, and it is not a
//      defect. This is also why nothing here assumes the checkout is on the
//      default branch (#787 acceptance 5).
//
// FAIL-OPEN ON AN UNREADABLE FACT. A probe that reached no verdict must not
// manufacture one — the inverse of `producer-forge-reach.mjs`, and deliberately
// so: that module guards an isolation property, this one guards an operator's
// convenience. Blocking task start on a git call that did not answer would be a
// refusal about a fact nobody measured.

/**
 * evaluateFreshness() — PURE. Facts in, verdict out.
 *
 * @param {{headSha?: string|null, baseSha?: string|null,
 *          scriptsDiffer?: boolean|null, headIsAncestor?: boolean|null}} [facts]
 * @returns {{stale: boolean, headSha: string|null, baseSha: string|null}}
 */
export function evaluateFreshness({
  headSha = null,
  baseSha = null,
  scriptsDiffer = null,
  headIsAncestor = null,
} = {}) {
  const report = { stale: false, headSha: headSha ?? null, baseSha: baseSha ?? null };

  // Any fact missing → fresh. See the header: no verdict is manufactured from a
  // probe that did not answer.
  if (typeof headSha !== 'string' || typeof baseSha !== 'string') return report;
  if (typeof scriptsDiffer !== 'boolean' || typeof headIsAncestor !== 'boolean') return report;

  // A checkout AT the base cannot be behind it, whatever the other facts claim.
  if (headSha === baseSha) return report;

  return { ...report, stale: scriptsDiffer && headIsAncestor };
}
