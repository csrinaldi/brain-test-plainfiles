// capability-report.mjs — what a platform will and will not enforce, PROBED (#348).
//
// THE RULING THIS IMPLEMENTS. #348 asked whether to call GitLab's approval-rules
// API (Premium) or ratify the gap. Ratified — implementing it would trade a
// PROVIDER asymmetry for a PLAN asymmetry, harder to explain and impossible to
// honour for Free users. But ratifying silently is worse: `branchProtect`
// returned `{ enforced: true }` over a `requiredReviews` it never applied.
//
// WHY THERE IS NO PRICING TABLE HERE. The account types make these two axes
// independent, and not in the direction a reader expects:
//
//   GitHub Free, private   no protected branch   no approval count   rung 2
//   GitLab Free            protected branch      no approval count   rung 1
//
// GitLab Free is STRONGER than GitHub Free-private for brain. A hardcoded plan
// table would have to track two vendors' pricing to say that, and would be
// wrong on a schedule nobody here controls. So every answer comes from the
// platform's own response — the same rule the rest of this tree converged on:
// when a tool already knows, ask it.
//
// Pure: responses in, capability out. The spawning stays in the adapters.

/** The vocabulary both axes speak. */
export const CAPABILITY_STATES = Object.freeze(['available', 'unavailable', 'unknown']);

/**
 * Pure: classify one probe response into a capability answer.
 *
 * `unknown` is a first-class answer, not a fallback dressed as one — the same
 * discipline `uncomputable` carries in the gates. A probe we could not read is
 * not a probe that said no, and reporting it as `unavailable` would send an
 * operator to fix a plan when the real problem was a network or a token.
 *
 * @param {{ ok: boolean, stderr?: string }} response
 * @param {{ notFoundIsAvailable?: boolean, remedies: Array<{ match: RegExp, remedy: string }> }} rules
 * @returns {{ state: 'available'|'unavailable'|'unknown', remedy?: string, detail?: string }}
 */
export function classifyProbe(response, { notFoundIsAvailable = false, remedies = [] } = {}) {
  if (response?.ok) return { state: 'available' };
  const stderr = String(response?.stderr ?? '');

  // A 404 means the FEATURE answered and had nothing configured yet — the API
  // is reachable, which is what "available" claims. Opt-in per axis, because it
  // is true of branch protection and NOT of an endpoint a plan withholds.
  if (notFoundIsAvailable && /(^|\D)404(\D|$)/.test(stderr)) return { state: 'available' };

  for (const { match, remedy } of remedies) {
    if (match.test(stderr)) return { state: 'unavailable', remedy };
  }
  return { state: 'unknown', detail: stderr.trim() || 'unexpected error from the provider CLI' };
}

/**
 * Pure: what `branchProtect` did NOT do, phrased for its return value (#348).
 *
 * Returns null when there is nothing to report — at `lite`, `requiredReviews`
 * is 0, and announcing an unapplied count nobody asked for is noise. Noise is
 * how a real signal stops being read.
 *
 * @param {{ requiredReviews?: number, approvalCount: 'available'|'unavailable'|'unknown', remedy?: string }} input
 * @returns {string|null}
 */
export function unappliedNote({ requiredReviews = 0, approvalCount, remedy } = {}) {
  if (!requiredReviews || requiredReviews <= 0) return null;
  if (approvalCount === 'available') return null;
  const tail = remedy ? ` — ${remedy}` : '';
  return approvalCount === 'unknown'
    ? `the branch is protected, but whether a ${requiredReviews}-approval rule could be applied is UNKNOWN${tail}`
    : `the branch is protected, but the ${requiredReviews}-approval requirement was NOT applied${tail}`;
}
