// approval-deny.mjs — the write-side refusal that keeps `status:approved` human
// (issue #528; #124 and reviewer-protocol §9).
//
// WHY THIS EXISTS AT THE PORT AND NOT AT THE CALLER. `issueCreate` is the first
// verb brain has ever had that can attach labels to a NEW issue, and the approval
// label is the one signature the doctrine reserves for a human: `actor-check`
// refuses it from a review identity, and #124 states it outright. A verb that could
// pass it would hand an agent the authorisation it is supposed to be asking for —
// the agent would open its own ticket, approve it, and satisfy `issue-link` on a PR
// nobody ruled on.
//
// Guarding at the caller would leave every other caller unguarded, and a comment
// saying "do not pass this label" is not a guard at all. So the refusal sits on the
// verb, in both providers, and `issue-create-deny.test.mjs` pins that both call it.
//
// IT RESOLVES THE LABEL, IT DOES NOT HARDCODE IT. `governance.approvedLabel` is a
// consumer-owned config key and GitLab maps it to a scoped form (`status::approved`).
// A literal `'status:approved'` here would be defeated two ways without anyone
// noticing: a consumer who renames the label, and every GitLab consumer, for whom
// the scoped form would simply not match. This is the same platform-agnosticism rule
// #454 settled for `agentActors` — the product must not hardcode what the consumer
// declares.
//
// Case-insensitive: provider label matching is, and refusing on case alone — or
// worse, PASSING on case alone — would make the guard a spelling test.

import { resolveApprovedLabel } from '../../governance/approved-label.mjs';

/**
 * Throws when `labels` carries the approval label for this provider.
 *
 * Fail-closed on an unreadable config: `resolveApprovedLabel` falls back to the
 * documented default rather than returning nothing, so a missing config narrows
 * what is refused but never disables the refusal.
 *
 * @param {string[]} labels
 * @param {{ config?: object, provider?: string }} [ctx]
 * @throws {Error} when the approval label is present
 */
export function assertNoApprovalLabel(labels, { config, provider } = {}) {
  if (!Array.isArray(labels) || labels.length === 0) return;
  const approved = resolveApprovedLabel(config, provider);
  const hit = labels.find(l => typeof l === 'string' && l.toLowerCase() === String(approved).toLowerCase());
  if (hit) {
    throw new Error(
      `vcs: refusing to create an issue carrying "${hit}" — the approval label is a HUMAN signature `
      + '(#124, reviewer-protocol §9) and no verb may apply it. Create the issue without it and let a '
      + 'human approve.',
    );
  }
}
