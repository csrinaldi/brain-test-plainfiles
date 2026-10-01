// ticket-type.mjs — `brain:ticket:start` refuses an issue with no type:* label (#1206).
//
// `brain:ship` refuses the same issue at the LAST step (`brain-ship.mjs`), after the
// work is done. The refusal belongs at the first step, before a branch or worktree
// exists. It asks `findTypeLabel` — the one module that knows the `type:` vocabulary
// (branch-type.mjs) — so the two verbs can never disagree about what "has a type" means.
//
// PURE, and the result carries a message KEY, never a message (same shape as
// ticket-base.mjs): the caller awaits `t(key, params)`.

import { findTypeLabel } from './branch-type.mjs';

/**
 * @param {{issue: {number?: number, labels?: string[]}}} input
 * @returns {{ok: true, label: string} | {ok: false, refusal: {key: string, params: object}}}
 */
export function requireTypeLabel({ issue }) {
  const labels = issue?.labels ?? [];
  const label = findTypeLabel(labels);
  if (label) return { ok: true, label };
  return {
    ok: false,
    refusal: {
      key: 'ticket.error.noTypeLabel',
      params: { id: issue?.number, labels: labels.join(', ') },
    },
  };
}
