// issue-link.mjs — check for a GitHub-style issue reference in a commit message or PR body.
//
// Accepts two reference patterns (case-insensitive):
//   • Closing reference:  Close(s|d)|Fix(es|ed)|Resolve(s|d) #N — all 9
//     GitHub-documented forms; used by integration PRs to the default branch.
//   • Chain reference:    Part of #N                  — used by slice PRs in a chained-PR flow
//
// Patterns are shared via issue-ref-patterns.mjs (issue #231 CP-A2a review,
// finding M1) — this file previously defined its OWN narrower 3-form closing
// pattern (closes|fixes|resolves only), which diverged from GitHub bash's and
// actor-check.mjs's broader 9-form vocabulary. Widened to match; see that
// module's header comment for the full rationale.
//
// Returns { pass: boolean, reason?: string }.

import { CLOSING_RE, CHAIN_RE } from './issue-ref-patterns.mjs';

/**
 * @param {string} body  Commit message or PR description.
 * @returns {{ pass: boolean, reason?: string }}
 */
export function issueLink(body) {
  if (typeof body === 'string' && (CLOSING_RE.test(body) || CHAIN_RE.test(body))) {
    return { pass: true };
  }
  return {
    pass: false,
    reason:
      'no issue reference found — body must contain a closing keyword ' +
      '(Close(s|d)|Fix(es|ed)|Resolve(s|d)) #N or Part of #N',
  };
}
