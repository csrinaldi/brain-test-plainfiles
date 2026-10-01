// lead-time.mjs — pure lead-time selection for brain-metrics (issue #324/M9,
// design D4). Lead time is computed as the issue's LAST `approvedLabel` add
// at-or-before the merge date → the merge commit's date, and MUST be
// documented as an issue-approval proxy, not PR-review-approval time (spec
// "Merge-window aggregation" requirement). Re-approval after changes is the
// approval that actually held at merge — hence "LAST", not "first".

/**
 * Select the label-add event that determines lead time: the LAST `add` event
 * for `approvedLabel` at-or-before `mergedAtIso`.
 *
 * @param {Array<{action?: string, label?: string, at?: string}>|null} events
 *   Normalized `labelEvents()` output (or `null` on an uncomputable fetch —
 *   never a fabricated `[]`, mirroring the CONTRACT verb's own convention).
 * @param {string} approvedLabel
 * @param {string} mergedAtIso
 * @returns {{action: string, label: string, at: string}|null}
 */
export function selectApprovalEvent(events, approvedLabel, mergedAtIso) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const mergedAt = new Date(mergedAtIso).getTime();
  const adds = events
    .filter((e) => e && e.action === 'add' && e.label === approvedLabel)
    .filter((e) => new Date(e.at).getTime() <= mergedAt)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return adds.length ? adds[adds.length - 1] : null;
}

/**
 * Lead time in days: the selected approval event's timestamp → the merge
 * date. Returns `null` (rendered "N/A" by callers) when no qualifying
 * approval event exists — an issue with no `status:approved` label add is
 * NOT an error, it is simply unmeasurable lead time. Never throws.
 *
 * @param {Array|null} events
 * @param {string} approvedLabel
 * @param {string} mergedAtIso
 * @returns {number|null}
 */
export function leadTimeDays(events, approvedLabel, mergedAtIso) {
  const event = selectApprovalEvent(events, approvedLabel, mergedAtIso);
  if (!event) return null;
  const ms = new Date(mergedAtIso).getTime() - new Date(event.at).getTime();
  return ms / 86400000;
}
