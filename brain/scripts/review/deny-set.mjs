// deny-set.mjs — REQ-H1-14: the hardcoded label deny-set (protocol §9,
// design.md §7). A fail-closed ALLOW-LIST every `labelAdd`/`labelRemove`
// MUST pass through, hardcoded in the caller, not left to the model to
// remember.
//
// ADD allow-list (tightening, protocol §9): `decision`, `seq:*`,
// `reviewed:*`, `needs-ruling`, `needs-decision`. Everything else is
// DENIED — including the named loosen/unlock labels (`status:approved`,
// `size:exception`, `skip:*`, `override:*`) AND any unknown label not on
// the allow-list. The allow-list IS the fence; the named examples are
// illustrations of what it catches, not an exhaustive blacklist.
//
// `needs-decision` (H1-5b, the escalation inbox, candidate 4993202904,
// decided IN by plan 5011584432): applied when a verdict carries
// `escalate: 'human'` — pure tightening, same rationale as `needs-ruling`.
//
// REMOVE allow-list is NARROWER than ADD (H1-5c, board.mjs): only `seq:*`
// and `reviewed:*` — the reviewer's OWN derived index (protocol §9,
// "verdicts are truth, labels are the derived index" — a label desync in
// THOSE two namespaces is a rebuildable no-op). `decision`/`needs-ruling`/
// `needs-decision` carry human/circuit intent — ADDING them is tightening,
// REMOVING them is LOOSENING, so they are refused on the remove path even
// though they are allowed on the add path. `status:approved` is human-only
// and never touched by the reviewer on either path.
//
// `guardedLabelAdd`/`guardedLabelRemove` are the single chokepoints every
// reviewer write-path SHOULD share: `poster.mjs`'s anti-stale
// `reviewed:stale` label add is folded under `guardedLabelAdd` (standing
// condition 1, issue #266 comment 5004345710: "the constant is the seed,
// not the fence") and `board.mjs` (H1-5c) passes both its adds and removes
// through the same two gates. The refusal happens BEFORE the provider is
// ever reached — `assertAllowed`/`assertAllowedRemove` throw synchronously,
// so `vcs.labelAdd`/`vcs.labelRemove` are never invoked for a denied label.

const ALLOWED_EXACT = new Set(['decision', 'needs-ruling', 'needs-decision']);
const ALLOWED_PREFIXES = ['seq:', 'reviewed:'];
const ALLOWED_REMOVE_PREFIXES = ['seq:', 'reviewed:'];

/**
 * Pure predicate — no seams. `true` iff `label` is on the tightening
 * allow-list (§9). Fail-closed: anything not explicitly matched is denied.
 * @param {string} label
 * @returns {boolean}
 */
export function isAllowedLabel(label) {
  if (typeof label !== 'string' || label.length === 0) return false;
  if (ALLOWED_EXACT.has(label)) return true;
  return ALLOWED_PREFIXES.some(prefix => label.startsWith(prefix));
}

/**
 * Throws on the FIRST denied label in `labels`. Checking every label in the
 * batch means one denied label refuses the whole call — no partial apply.
 * @param {string[]} labels
 * @throws {Error} naming the refused label and the reason (protocol §9,
 *   REQ-H1-14)
 */
export function assertAllowed(labels) {
  for (const label of labels ?? []) {
    if (!isAllowedLabel(label)) {
      throw new Error(
        `deny-set: refused label "${label}" — the reviewer may only apply tightening labels ` +
          '(decision, seq:*, reviewed:*, needs-ruling, needs-decision); loosen/unlock labels ' +
          '(status:approved, size:exception, skip:*, override:*) and any label outside the ' +
          'allow-list are refused before labelAdd is invoked (protocol §9, REQ-H1-14).',
      );
    }
  }
}

/**
 * The single chokepoint every reviewer `labelAdd` call MUST pass through
 * (design.md §7). Checks `assertAllowed` BEFORE calling `vcs.labelAdd` — the
 * provider is never reached for a denied label.
 * @param {{ labelAdd: Function }} vcs
 * @param {{ project: string, number: number, labels: string[] }} args
 * @returns {Promise<object>} whatever `vcs.labelAdd` resolves to
 */
export async function guardedLabelAdd(vcs, { project, number, labels }) {
  assertAllowed(labels);
  return vcs.labelAdd({ project, number, labels });
}

/**
 * Pure predicate — no seams. `true` iff `label` may be REMOVED by the
 * reviewer: strictly `seq:*` / `reviewed:*` (its own derived index, §9).
 * NARROWER than `isAllowedLabel` — `decision`/`needs-ruling`/
 * `needs-decision` are addable but never removable (removing them is
 * loosening, not tightening); `status:approved` is human-only either way.
 * @param {string} label
 * @returns {boolean}
 */
export function isAllowedRemoveLabel(label) {
  if (typeof label !== 'string' || label.length === 0) return false;
  return ALLOWED_REMOVE_PREFIXES.some(prefix => label.startsWith(prefix));
}

/**
 * Throws on the FIRST label in `labels` that may not be REMOVED. Checking
 * every label in the batch means one denied removal refuses the whole call
 * — no partial apply.
 * @param {string[]} labels
 * @throws {Error} naming the refused label and the reason (protocol §9)
 */
export function assertAllowedRemove(labels) {
  for (const label of labels ?? []) {
    if (!isAllowedRemoveLabel(label)) {
      throw new Error(
        `deny-set: refused label removal "${label}" — the reviewer may only REMOVE its own ` +
          'derived index (seq:*, reviewed:*); decision/needs-ruling/needs-decision (human/circuit ' +
          'intent — removing them loosens, not tightens) and status:approved (human-only) may never ' +
          'be removed by the reviewer (protocol §9).',
      );
    }
  }
}

/**
 * The single chokepoint every reviewer `labelRemove` call MUST pass
 * through (design.md §7, board.mjs H1-5c). Checks `assertAllowedRemove`
 * BEFORE calling `vcs.labelRemove` — the provider is never reached for a
 * denied removal.
 * @param {{ labelRemove: Function }} vcs
 * @param {{ project: string, number: number, labels: string[] }} args
 * @returns {Promise<object>} whatever `vcs.labelRemove` resolves to
 */
export async function guardedLabelRemove(vcs, { project, number, labels }) {
  assertAllowedRemove(labels);
  return vcs.labelRemove({ project, number, labels });
}
