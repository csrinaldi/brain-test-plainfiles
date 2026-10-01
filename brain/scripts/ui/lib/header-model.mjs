// header-model.mjs — the status bar's own read model (#1059 phase 1, region 01
// of the maintainer's design). Pure, imported by the browser AND by node:test
// (D9), like every other model in this directory.
//
// The design's header carries six facts side by side: the branch served, the
// stream's state, when the forge was last polled, the epic this checkout is
// working on, how many nodes the graph holds and how many of them declared
// nothing. Five of those already existed somewhere on the page; the counts and
// the epic did not, and the counts were the reason this module exists — the
// status bar re-renders on a five-second clock, and recomputing the whole lane
// model to count two numbers would pay for the lanes twice a minute.
//
// The epic is the one fact the data cannot yet answer: an epic declares its
// `tracker` branch (#967 shipped that), so the branch being served COULD name
// its epic, but nothing joins the two. Rather than draw the design's
// `issue-878 (epic)` from a guess, the model says the join does not exist and
// names the ticket that owns it — the same "state the absence" rule every
// other section here follows.

import { row } from './governance-model.mjs';

/** The ticket that will make `epic` answerable; until it lands the header says so. */
export const EPIC_JOIN_PENDING = 'the epic this branch serves is not resolved yet — an epic declares its tracker branch, and no reader joins the served branch to it';

/**
 * buildHeaderModel(graphSection, meta) -> {ok:true, value:{servedBranch, counts, epic}}
 * | {ok:false, reason}
 *
 * `counts` is `{ok:true, nodes, tracked, undeclared}` or its own `{ok:false,
 * reason}` — an unreadable graph costs the header its counts and nothing else,
 * the same per-field degradation `actors-model.mjs` and `sdd-model.mjs` use.
 * A node counts as tracked when it declares a track; "undeclared" is the
 * complement, which is exactly what the `?` holding lane collects.
 */
export function buildHeaderModel(graphSection, meta = {}) {
  const servedBranch = meta?.servedBranch ?? null;

  let counts;
  if (!graphSection || typeof graphSection !== 'object') {
    counts = { ok: false, reason: 'no graph section was given to the header' };
  } else if (graphSection.ok !== true) {
    counts = { ok: false, reason: graphSection.reason };
  } else {
    const nodes = graphSection.value?.nodes ?? [];
    const tracked = nodes.filter((n) => typeof n.track === 'string' && n.track !== '').length;
    counts = { ok: true, nodes: nodes.length, tracked, undeclared: nodes.length - tracked };
  }

  return {
    ok: true,
    value: {
      servedBranch: row({ source: servedBranch?.source ?? null, branch: servedBranch?.ok === true ? servedBranch.branch : null, reason: servedBranch?.ok === false ? servedBranch.reason : null }),
      counts,
      epic: { ok: false, reason: EPIC_JOIN_PENDING },
    },
  };
}
