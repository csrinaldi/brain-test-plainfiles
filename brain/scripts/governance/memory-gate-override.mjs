// memory-gate-override.mjs — decides whether `skip:memory-gate` is honored
// (issue #1024, REQ-L3-5, design.md D7). Pure module, shared by
// `run-check.mjs` (the gate itself) and `brain-metrics.mjs` (honored-count
// reporting) — the rule has ONE implementation.
//
// D7 option C (chosen over "anyone who can label" and a new config key): the
// applier must differ from the PR author, and must not be in
// `governance.reviewActors`/`governance.agentActors` — the same deny set
// `actor-check.mjs`'s approved-label evidence already refuses (issue #375).
// `denyingList` is imported from there rather than re-deriving the
// agent-vs-review distinction a second time.
//
// Whether the tier HONORS the label at all is `tierParams(tier)
// .honorSkipMemoryGate` — `false`/`true`/`false` at `lite`/`standard`/
// `regulated` (governance-tiers.mjs). `regulated` REFUSES the label with a
// reason naming the tier, in the style of the diff-size REQ-TIER-6 refusal
// (`run-check.mjs`'s `runDiffSizeCheck`) — it does not silently ignore it.
// `lite` NOTES the label in the output and does not consult it, because the
// gate is detection-only there (nothing to skip).
//
// Degradation (never a silent skip):
//   - `labels === null` (uncomputable, distinct from `[]`) is NEVER read as
//     the label being applied or as "no label" — the caller falls through
//     to REQ-L3-4's scoped evaluation.
//   - `labelEvents === null`, or no `add` event found for the label, means
//     the applier is unknown — never honored, the reason says so.
//   - The LATEST `add` event wins (handles re-labeling: remove → re-add).

import { denyingList } from '../vcs/actor-check.mjs';
import { tierParams } from '../vcs/governance-tiers.mjs';

export const SKIP_MEMORY_GATE_LABEL = 'skip:memory-gate';

function isInList(actor, list) {
  return Array.isArray(list) && list.some((a) => a && String(a).toLowerCase() === String(actor).toLowerCase());
}

/**
 * Coerces a `governance.reviewActors`/`governance.agentActors`-shaped config
 * value to a list: an array passes through, a non-empty string becomes a
 * one-element list (a typo's obvious meaning, same discipline actor-check.mjs
 * applies to `denyActors`), anything else degrades to `[]`. Shared by
 * `run-check.mjs` and `brain-metrics.mjs` — both resolve the same config
 * shape into the `reviewActors`/`agentActors` this module consumes.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function toActorList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value) return [value];
  return [];
}

/**
 * @param {object} input
 * @param {string[]|null} input.labels  Fresh PR/MR labels (`ctx.labels`).
 *   `null` means uncomputable (the fetch failed) — distinct from `[]`.
 * @param {Array<{actor?: {login?: string}, action?: string, label?: string, at?: string}>|null} input.labelEvents
 *   The `labelEvents` CONTRACT verb's result for this PR/MR number, or `null`
 *   when uncomputable.
 * @param {string|null|undefined} input.prAuthor
 * @param {'lite'|'standard'|'regulated'} input.tier
 * @param {string[]} [input.reviewActors]  `governance.reviewActors`.
 * @param {string[]} [input.agentActors]  `governance.agentActors`.
 * @returns {{honored: boolean, present: boolean, applier?: string, refused?: boolean, reason: string|null}}
 *   `present` is whether the label is (or was) applied at all — `false` when
 *   uncomputable or genuinely absent. `reason` is `null` only when the label
 *   is genuinely absent (nothing to note); every other case carries a reason
 *   the caller may surface (unconditionally on a skip, or only when the
 *   fallback evaluation subsequently fails, per design.md's Degradation
 *   table — that choice belongs to the caller, not this pure function).
 */
export function decideMemoryGateOverride({
  labels,
  labelEvents,
  prAuthor,
  tier,
  reviewActors = [],
  agentActors = [],
} = {}) {
  if (labels === null || labels === undefined) {
    return {
      honored: false,
      present: false,
      reason: 'labels uncomputable — a skip:memory-gate override could not be checked',
    };
  }

  const labelPresent = Array.isArray(labels) && labels.includes(SKIP_MEMORY_GATE_LABEL);
  if (!labelPresent) {
    return { honored: false, present: false, reason: null };
  }

  if (tier === 'lite') {
    return {
      honored: false,
      present: true,
      reason: 'skip:memory-gate noted, not consulted at the "lite" tier (detection-only — nothing to skip)',
    };
  }

  const honorsAtTier = tierParams(tier).honorSkipMemoryGate;
  if (!honorsAtTier) {
    return {
      honored: false,
      present: true,
      refused: true,
      reason:
        `skip:memory-gate is not honored at the "${tier}" tier — the override is refused, ` +
        'consistent with this tier refusing size:exception; evaluation continues.',
    };
  }

  if (!Array.isArray(labelEvents)) {
    return {
      honored: false,
      present: true,
      reason: 'skip:memory-gate present but its applier could not be read — not honored',
    };
  }

  const addEvents = labelEvents.filter(
    (e) => e?.label === SKIP_MEMORY_GATE_LABEL && e?.action === 'add',
  );
  const lastAdd = addEvents[addEvents.length - 1];
  const applier = lastAdd?.actor?.login;

  if (!applier) {
    return {
      honored: false,
      present: true,
      reason: 'skip:memory-gate present but its applier could not be read — not honored',
    };
  }

  if (prAuthor && applier.toLowerCase() === String(prAuthor).toLowerCase()) {
    return {
      honored: false,
      present: true,
      applier,
      reason: `skip:memory-gate applied by the PR author (@${applier}) is refused — the author cannot waive their own PR`,
    };
  }

  if (isInList(applier, agentActors) || isInList(applier, reviewActors)) {
    const { clause } = denyingList(applier, agentActors);
    return {
      honored: false,
      present: true,
      applier,
      reason: `skip:memory-gate applied by @${applier} (${clause}) is refused — not honored`,
    };
  }

  return {
    honored: true,
    present: true,
    applier,
    reason: `skip:memory-gate applied by @${applier}, not the PR author, honored at the "${tier}" tier`,
  };
}
