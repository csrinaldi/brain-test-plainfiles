// roadmap-model.mjs — the epic graph grouped by epic, for real (#882
// R882-2). Pure, imported by the browser and by node:test (D9): no
// `node:` builtin, no clock, no random, no fetch.
//
// Rule zero (the same "never filter a node away" discipline
// lane-model.mjs's `?` holding lane already holds for undeclared tracks):
// a node with no epic parent — no declared parent, or a declared parent
// that does not itself declare `kind: epic` — lands in the `unlinked`
// bucket, never dropped and never nested under a node that is not really
// an epic. No timeline is computed here (no start/due date exists
// anywhere in the data): this is per-epic STATUS grouping only.

import { stateOf, STATES } from './state-vocab.mjs';
import { row } from './governance-model.mjs';
import { issueUrl } from './forge-url.mjs';

const byNumber = (a, b) => a.number - b.number;

/**
 * `stateOf` throws by design on a `node.status` or a roadmap state this
 * table does not know (state-vocab.mjs's own deliberate refusal to guess).
 * A per-node throw reaching `buildRoadmapModel` un-caught would blank the
 * WHOLE canvas over one bad node — the empty-on-failure anti-pattern in its
 * worst form. Caught here instead (the same guard `lane-model.mjs`'s own
 * `stateAndMarks` already holds for exactly this throw): the row falls back
 * to the `unknown` vocabulary entry and SAYS why, so the other ninety rows
 * still draw (#882 cold review of PR #1037, correction 1).
 */
function safeStateOf(node) {
  try {
    return { state: stateOf(node), reason: null };
  } catch (err) {
    return { state: STATES.unknown, reason: err?.message ?? String(err) };
  }
}

/**
 * One roadmap row, through `governance-model.mjs`'s own `row()` (#882 cold
 * review of PR 1, blocker): the node's own roadmap state (state-vocab.mjs's
 * own priority table, read through `safeStateOf` so one unreadable state
 * never throws — correction 1 above), its open blockers, and the
 * `parent`-keyed divergences graph.mjs (or this module — correction 2
 * below) already found for it. `source` is the node's own issue URL when a
 * `project` is known (`forge-url.mjs`'s `issueUrl`, the SAME builder
 * `change-route.mjs`'s PR-url shaper now delegates to) — `null`,
 * `sourceStamp`'s own honest "no source was recorded" stamp, when it is
 * not.
 */
function roadmapRow(node, divergences, project) {
  const { state, reason } = safeStateOf(node);
  return row({
    title: node.title,
    detail: null,
    source: project ? { url: issueUrl(project, node.number) } : null,
    number: node.number,
    state,
    stateReason: reason,
    blockedBy: node.blockedBy ?? [],
    divergences,
  });
}

/**
 * buildRoadmapModel(graphSection, {project}) -> {ok:true,
 * value:{epics, unlinked}} | {ok:false, reason}.
 *
 * `epics` is one row per `kind === 'epic'` node, its declared children
 * nested under it (every node whose `parent` resolves to that epic's
 * number). `unlinked` is every other node: no declared parent, or a
 * declared parent that does not resolve to an epic — carrying the
 * `parent`-keyed `declarationDivergences` entry as its own warning rather
 * than absorbing it silently.
 *
 * Epics themselves stay FLAT (#882 cold review of PR #1037, correction 2):
 * `epics` is not a tree. An epic whose own declared `parent` resolves to
 * ANOTHER epic still gets its own top-level row — it is not nested under
 * that epic — because `childrenByEpic` only ever collects non-epic nodes,
 * and a real nested-epic tree (arbitrary depth, cycles to guard against) is
 * a bigger structural change than this ticket's "per-epic status grouping,
 * no timeline" scope. The dropped relation is never silently absorbed
 * either way, though: it is said on the child epic's own row as a
 * `nested-epic-not-supported` divergence, the same shape and the same
 * `roadmap-divergence` rendering `parent-not-epic` already uses.
 *
 * `project` (#882 cold review of PR 1, blocker) is `server.mjs`'s
 * `buildMeta()` project string, the same one `change-route.mjs` already
 * threads through to source a PR link — optional and defaulting to `null`,
 * which degrades every row's `source` to `sourceStamp`'s own honest "no
 * source was recorded" stamp rather than a guessed or missing link.
 *
 * Determinism: the same graph, with `nodes` in any order, produces a
 * byte-identical model — every grouping sorts by issue number before it
 * builds a row.
 *
 * @param {{ok:boolean, value?:{nodes:Array, declarationDivergences?:Array}, reason?:string}} graphSection
 * @param {{project?: string|null}} [options]
 */
export function buildRoadmapModel(graphSection, { project = null } = {}) {
  if (!graphSection || typeof graphSection !== 'object') return { ok: false, reason: 'no graph section was given to the roadmap' };
  if (graphSection.ok !== true) return { ok: false, reason: graphSection.reason };

  const { nodes = [], declarationDivergences = [] } = graphSection.value ?? {};

  const divergencesByNode = new Map();
  for (const d of declarationDivergences) {
    if (d.key !== 'parent') continue;
    const list = divergencesByNode.get(d.number) ?? [];
    list.push({ key: d.key, value: d.value, reason: d.reason });
    divergencesByNode.set(d.number, list);
  }
  const divergencesFor = (number) => divergencesByNode.get(number) ?? [];

  const sorted = [...nodes].sort(byNumber);
  const byNode = new Map(sorted.map((n) => [n.number, n]));

  const childrenByEpic = new Map();
  for (const n of sorted) if (n.kind === 'epic') childrenByEpic.set(n.number, []);

  const unlinked = [];
  for (const n of sorted) {
    if (n.kind === 'epic') continue;
    const parentNode = n.parent === null || n.parent === undefined ? null : byNode.get(n.parent);
    if (parentNode && parentNode.kind === 'epic') {
      childrenByEpic.get(parentNode.number).push(roadmapRow(n, divergencesFor(n.number), project));
    } else {
      unlinked.push(roadmapRow(n, divergencesFor(n.number), project));
    }
  }

  // An epic declaring another epic as its own `parent` (correction 2 above):
  // said on the CHILD epic's own row, never silently dropped — `epics`
  // itself stays flat, but the relation `childrenByEpic` cannot carry (it
  // only ever collects non-epic nodes) does not vanish.
  const epicParentDivergence = (n) => {
    const parentNode = n.parent === null || n.parent === undefined ? null : byNode.get(n.parent);
    return parentNode && parentNode.kind === 'epic'
      ? [{ key: 'parent', value: n.parent, reason: 'nested-epic-not-supported' }]
      : [];
  };

  const epics = sorted
    .filter((n) => n.kind === 'epic')
    .map((n) => ({
      ...roadmapRow(n, [...divergencesFor(n.number), ...epicParentDivergence(n)], project),
      children: childrenByEpic.get(n.number),
    }));

  return { ok: true, value: { epics, unlinked } };
}
