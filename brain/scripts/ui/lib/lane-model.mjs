// lane-model.mjs — the graph section grouped into track lanes and the `?`
// holding lane (#998 R998-3). Pure, imported by the browser AND by
// node:test (D9): no `node:` builtin, no clock, no random.
//
// Ruling 1 (R881-6 S1) still holds here: NO NODE IS EVER FILTERED. A node
// with a declared track lands in that track's lane; a node with none —
// undeclared (`track === null`, or unreadable, which carries no track
// either) — lands in the `?` holding lane, paged rather than dropped.
//
// `layout.mjs` is a coordinate engine, and a lane is a GROUPING, not a
// second layout engine (design.md's "Component → module map"): this module
// calls `layout()` once per lane, over that lane's own subgraph, and never
// extends it. Each lane therefore owns its OWN coordinate space starting at
// (0, 0) — two lanes both place their first node at x=0, y=0 — which is why
// a cross-lane edge is never drawn as a line here: doing so would need one
// shared coordinate space across every row, which lanes deliberately do not
// have. It is reported instead, in `crossEdges`, and `app.js` says it as
// text under the lanes.
//
// Epic grouping (#1032; `node.kind`/`node.parent` have been real data since
// #967) is `epicGrouping`: nodes whose `parent` resolves to a node whose own
// `kind` is `'epic'` group under that epic's row, the same declaration an
// issue body already carries — never a second grouping vocabulary layered
// on top of `kind`/`parent`. A node whose declared parent does NOT read as
// an epic keeps the divergence the graph already said (`parent-not-epic`,
// `epic-graph.mjs`'s own D5) rather than being silently reparented; a node
// with no parent at all is untouched here — it stays in its track lane as
// every node already does, epicGrouping says nothing extra about it. Nested
// epics are REAL (#884 is both `kind:'epic'` AND a declared child of #878):
// `epics` stays FLAT, the same correction `roadmap-model.mjs`'s own cold
// review already made for the identical shape (#882 cold review of PR
// #1037, correction 2) — reused here rather than re-derived so the two
// "group by epic" views cannot drift into two different nested-epic
// answers. What this does NOT do: decide whether a node's own open PR
// targets a base other than its epic's tracker — that needs the PR list,
// which this pure module is never given (only `server.mjs`'s PR-aware
// routes receive it), so each grouped child carries a `baseCheck: {ok:
// false, reason}` slot a future model can fill rather than a claim this one
// cannot back (#1032 scope note).

import { layout } from './layout.mjs';
import { stateOf, STATES } from './state-vocab.mjs';
import { sourceStamp } from './provenance.mjs';
import { issueUrl } from './forge-url.mjs';

const PAGE_SIZE = 24;

/**
 * The exact text an author pastes into an issue body to declare a track
 * (#998 R998-3): the `brain-graph/1` fence `parseGraphBlock`
 * (`status/epic-graph.mjs`) reads. `track: A` is a worked example, not a
 * placeholder syntax — an author replaces the letter, not the shape.
 *
 * #1032 adds `kind` and `parent`. #967 made both real — a node declares
 * whether it is an epic and which epic owns it — and the lanes now group by
 * them, so a snippet that still showed only `track` told an author how to
 * leave the `?` lane while staying silent about the two declarations the
 * board is organised around.
 *
 * Every key here is one the parser actually READS. A key nobody reads would
 * be an instruction to write something with no effect, which is worse than
 * no instruction at all.
 */
const DECLARE_SNIPPET = [
  '```brain-graph/1',
  'track: A',
  'kind: epic',
  'parent: 878',
  'blocks: []',
  'needs: []',
  'files: []',
  '```',
].join('\n');

/**
 * A snippet is a worked EXAMPLE, not a form to submit whole. Pasted verbatim
 * by every undeclared issue, the two lines above would declare a repository
 * full of epics, each one the child of the same ticket. This sentence is what
 * keeps the example from reading as an instruction, and it is carried as data
 * rather than written into the page so the snippet and its caveat cannot
 * drift apart.
 */
const DECLARE_NOTE = 'keep the lines that are true: `kind: epic` only if this issue IS an epic, and `parent:` only if it is a slice of one — an issue that is neither declares just its track';

/** The marks a node carries, plus its state-vocab word — the label's whole content. (The rule was `canvas-model.mjs`'s; that module had no importer left and was removed in #1032.) */
function stateAndMarks(node) {
  const marks = [];
  if (node.status === 'unreadable') marks.push('unreadable');
  else if (node.track == null) marks.push('? track');
  if (node.roadmap && node.roadmap.ok === false) marks.push('not computed');
  if (Array.isArray(node.blockedBy) && node.blockedBy.length > 0) {
    marks.push(`blocked by ${node.blockedBy.map((n) => `#${n}`).join(', ')}`);
  }
  let state;
  try {
    state = stateOf(node);
  } catch (err) {
    // One unknown state cannot blank a lane: mark that node, keep every
    // other one drawing. An unreadable row is a row with a reason on it,
    // never a reason to stop drawing the rest.
    state = STATES.unknown;
    marks.push(`unknown state: ${err?.message ?? err}`);
  }
  return { marks, state };
}

/**
 * nodeSummaryFor(graphSection, issue) -> {ok:true, value:{number, title, track,
 * state, marks, blockedBy}} | {ok:false, reason}
 *
 * The one node the drawer's own header names (#1059 region 08). It is the same
 * shape a lane card shows, built by the same `stateAndMarks` — a header that
 * derived the state a second way could disagree with the card the reader just
 * clicked, which is the kind of quiet contradiction this page exists to avoid.
 */
export function nodeSummaryFor(graphSection, issue) {
  if (!graphSection || typeof graphSection !== 'object') return { ok: false, reason: 'no graph section was given' };
  if (graphSection.ok !== true) return { ok: false, reason: graphSection.reason };
  const node = (graphSection.value?.nodes ?? []).find((n) => n.number === issue);
  if (!node) return { ok: false, reason: `the graph holds no issue #${issue}` };
  const { marks, state } = stateAndMarks(node);
  return {
    ok: true,
    value: {
      number: node.number,
      title: node.title ?? '',
      track: node.track ?? null,
      state: { code: state.code, label: state.label, mark: state.mark },
      marks,
      blockedBy: [...(node.blockedBy ?? [])].sort((a, b) => a - b),
    },
  };
}

/**
 * childrenOf(graphSection, issue) -> {ok:true, value:[{number, title, state,
 * track}]} | {ok:false, reason}
 *
 * The tickets that belong to this one (#1059 phase 10). The relation is
 * DECLARED BY THE CHILD — `parent` is a node field since #967 — so a parent's
 * list is whoever points at it, never a list the parent carries about itself.
 * That asymmetry is why nobody had read it yet, and why a node nobody declares
 * has an empty list rather than a missing one: "no ticket names this as its
 * parent" is a fact, not a failure.
 */
export function childrenOf(graphSection, issue) {
  if (!graphSection || typeof graphSection !== 'object') return { ok: false, reason: 'no graph section was given' };
  if (graphSection.ok !== true) return { ok: false, reason: graphSection.reason };
  const value = (graphSection.value?.nodes ?? [])
    .filter((n) => n.parent === issue)
    .sort((a, b) => a.number - b.number)
    .map((node) => {
      const { state } = stateAndMarks(node);
      return {
        number: node.number,
        title: node.title ?? '',
        track: node.track ?? null,
        state: { code: state.code, label: state.label, mark: state.mark },
      };
    });
  return { ok: true, value };
}

/** A drawable node — the shape the retired `canvas-model.mjs` established, plus the state word/mark (#998 R998-3) — for one lane's own board. */
function drawnNode(node, box) {
  const { marks, state } = stateAndMarks(node);
  return {
    number: node.number,
    label: `#${node.number} ${node.title ?? ''}`.trim(),
    // #1059 region 03: the design draws a card, not a labelled rectangle, so
    // the title stands on its own line and what a node waits on is a fact of
    // the card rather than only a line between two boxes.
    title: node.title ?? '',
    blockedBy: [...(node.blockedBy ?? [])].sort((a, b) => a - b),
    className: state.className,
    marks,
    track: node.track ?? null,
    state: { code: state.code, label: state.label, mark: state.mark },
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
  };
}

/** A holding-lane row: the same facts, no board coordinates — the `?` lane is a paged list, never a drawing (undeclared nodes carry no track to lay a board out against). */
function holdingRow(node) {
  const { marks, state } = stateAndMarks(node);
  return {
    number: node.number,
    label: `#${node.number} ${node.title ?? ''}`.trim(),
    title: node.title ?? '',
    blockedBy: [...(node.blockedBy ?? [])].sort((a, b) => a - b),
    marks,
    state: { code: state.code, label: state.label, mark: state.mark },
  };
}

const byNumber = (a, b) => a.number - b.number;
const byFromTo = (a, b) => a.from - b.from || a.to - b.to;

/** The shared fields every `epicGrouping` row carries — the same words
 * `stateAndMarks` already derives for a track-lane card, so a node grouped
 * by epic cannot read differently from the same node's own card just
 * because it now has a second grouped location (#1032). */
function groupedRow(node) {
  const { marks, state } = stateAndMarks(node);
  // EVERY field `drawnNode` gives a lane card, minus the coordinates. The
  // page draws a cluster's slices with the SAME `renderNodeCard` the lanes
  // use, so a row missing one of these produces a card with an `undefined`
  // class and throws reading `blockedBy.length` — the shape mismatch that
  // shipped in `sddForIssue` and took the whole board down (#1059).
  //
  // The coordinates are deliberately absent: a cluster is a grid, and a row
  // carrying an `x` would be inviting a second layout engine into a module
  // that has exactly one.
  return {
    number: node.number,
    title: node.title ?? '',
    track: node.track ?? null,
    blockedBy: [...(node.blockedBy ?? [])].sort((a, b) => a - b),
    className: state.className,
    state: { code: state.code, label: state.label, mark: state.mark },
    marks,
  };
}

/**
 * A node grouped under its epic. `parentSource` — 'block' or 'prose' —
 * survives to the reader unchanged (house rule: the distinction between a
 * declared block and a prose "Parent:" line must not be lost in the
 * grouping). `baseCheck` is a reserved, honestly-failed slot: this pure
 * module never receives the PR list, so it cannot say whether the node's
 * own open PR targets a base other than its epic's tracker — that gap is
 * SAID, never a silently empty field (rule 4, evidence-reader-empty-on-
 * failure).
 */
function epicChildRow(node) {
  return {
    ...groupedRow(node),
    parentSource: node.parentSource ?? null,
    baseCheck: {
      ok: false,
      reason: 'the PR list is not available to lane-model.mjs (#1032 scope) — computing whether this node\'s open PR targets a base other than its epic\'s tracker needs a model that receives PRs',
    },
  };
}

/** A node whose declared parent did not resolve to a real epic — carried
 * with the graph's own reason, never re-derived (D5, `epic-graph.mjs`). */
function divergentChildRow(node, reason) {
  return {
    ...groupedRow(node),
    parent: node.parent,
    parentSource: node.parentSource ?? null,
    reason,
  };
}

/**
 * The epic's own tracker, named with a stamp (#1032). `branch` is
 * `node.tracker` verbatim; when it is falsy the epic SAYS why
 * (`epic-declares-no-tracker`, `ticket-base.mjs`'s own token — #967's data
 * shows every epic in the live graph is in exactly this state today) rather
 * than rendering an empty tracker as if none had been asked for. When a
 * tracker IS declared, its stamp names the epic issue that declared it —
 * a real forge link when `project` is known, the same bracket-only forge
 * label `anti-patterns-model.mjs` already falls back to when it is not.
 */
function trackerInfo(epicNode, project) {
  if (!epicNode.tracker) return { branch: null, stamp: null, reason: 'epic-declares-no-tracker' };
  return {
    branch: epicNode.tracker,
    stamp: project
      ? sourceStamp({ url: issueUrl(project, epicNode.number) })
      : { label: `[forge: #${epicNode.number}]`, href: null, kind: 'forge' },
    reason: null,
  };
}

/**
 * buildEpicGrouping(nodes, declarationDivergences, project) -> {ok:true,
 * value:{epics, divergentChildren}} (#1032).
 *
 * `epics` is one row per `kind === 'epic'` node — FLAT, never nested under
 * each other even when one epic declares another as its own `parent`
 * (#884-shaped data is real): that dropped relation is said on the child
 * epic's own `parentDivergence` as `nested-epic-not-supported`, the exact
 * shape and reason `roadmap-model.mjs` already established for the
 * identical decision (#882 cold review of PR #1037, correction 2) — reused
 * rather than re-derived so the two "group by epic" views cannot disagree.
 *
 * `divergentChildren` is every non-epic node whose `parent` is declared but
 * does not resolve to a real epic: when the parent number resolves to a
 * real, non-epic node, the reason is the graph's own `declarationDivergences`
 * entry (`parent-not-epic`, D5 in `epic-graph.mjs`) carried through
 * unchanged; when the parent number is simply absent from this graph
 * (closed issue, another repository — `epic-graph.mjs`'s own comment: "not
 * in this list is not 'not an epic'"), the graph reports no divergence for
 * it, so this model states its own honest, locally-observed fact instead of
 * borrowing a reason nobody upstream reported: `parent-not-in-graph`.
 *
 * A node with NO declared parent appears in neither bucket — it stays in
 * its track lane exactly as before #1032, which is the "must not become a
 * second grouping vocabulary" rule read literally: nothing is said about a
 * node that itself said nothing.
 *
 * Determinism: `epics` and every `children` array sort by issue number
 * before returning, independent of input order.
 */
function buildEpicGrouping(nodes, declarationDivergences, project) {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const divergences = Array.isArray(declarationDivergences) ? declarationDivergences : [];
  const byNode = new Map(nodeList.map((n) => [n.number, n]));
  const reportedReasonFor = (number) => {
    const d = divergences.find((x) => x.number === number && x.key === 'parent');
    return d ? d.reason : null;
  };
  // A parent declaration resolved against the graph: null (no parent
  // declared), the resolved node (parent found), or undefined (a parent
  // number this graph holds no node for — an outage-shaped absence, never
  // read as "not an epic").
  const resolveParent = (n) => (n.parent == null ? null : byNode.get(n.parent));
  const parentReason = (n, parentNode) => (parentNode ? (reportedReasonFor(n.number) ?? 'parent-not-epic') : 'parent-not-in-graph');

  const epicNodes = nodeList.filter((n) => n.kind === 'epic').sort(byNumber);
  const childrenByEpic = new Map(epicNodes.map((e) => [e.number, []]));
  const divergentChildren = [];

  for (const n of [...nodeList].sort(byNumber)) {
    if (n.kind === 'epic') continue; // epics get their own flat top-level row below, never nested as a slice
    if (n.parent == null) continue; // #1032: no declaration to group by — stays in its track lane, untouched here
    const parentNode = resolveParent(n);
    if (parentNode && parentNode.kind === 'epic') {
      childrenByEpic.get(parentNode.number).push(epicChildRow(n));
      continue;
    }
    divergentChildren.push(divergentChildRow(n, parentReason(n, parentNode)));
  }

  const epics = epicNodes.map((e) => {
    // `e.parent == null` alone decides "nothing declared" — `resolveParent`
    // deliberately returns `undefined` (not `null`) for a declared parent
    // this graph holds no node for, and collapsing that into the same
    // "no divergence" branch would silently swallow the exact
    // `parent-not-in-graph` fact rule 4 requires this model to say.
    const parentNode = resolveParent(e);
    const parentDivergence = e.parent == null ? null : {
      parent: e.parent,
      parentSource: e.parentSource ?? null,
      reason: parentNode && parentNode.kind === 'epic' ? 'nested-epic-not-supported' : parentReason(e, parentNode),
    };
    return {
      ...groupedRow(e),
      tracker: trackerInfo(e, project),
      parentDivergence,
      children: childrenByEpic.get(e.number),
    };
  });

  // WHO THIS GROUPING DID NOT CLAIM (#1032). The page draws epic clusters
  // beside the track lanes, and a node an epic already claimed must not be
  // drawn a second time down in its lane. Deciding who is claimed is THIS
  // module's job: a renderer that worked it out from `parent` and `kind`
  // would be a second answer to a question already answered here, and the two
  // can disagree.
  //
  // The three sets partition the graph: a node leads a cluster, sits under
  // one, or is unclaimed. A `divergentChildren` row is UNCLAIMED — its
  // declaration did not resolve to an epic, so nothing claimed it, and it
  // stays on the board in its own track lane with its reason beside it.
  const claimed = new Set(epics.flatMap((e) => [e.number, ...e.children.map((c) => c.number)]));
  const unclaimed = nodeList.map((n) => n.number).filter((number) => !claimed.has(number)).sort((a, b) => a - b);

  return { ok: true, value: { epics, divergentChildren, unclaimed } };
}

/**
 * buildLaneModel(graphSection, {collapsedTracks, holdingPage, project}) ->
 * {ok:true, value:{lanes, crossEdges, holding, droppedEdges,
 * issuesUnreadable, epicGrouping}} | {ok:false, reason}
 *
 * Determinism: the same graph, with `nodes`/`edges` in any order, produces a
 * byte-identical model — every grouping sorts before it lays out or pages.
 *
 * @param {{ok:boolean, value?:{nodes:Array, edges:Array, issuesUnreadable?:Array, declarationDivergences?:Array}, reason?:string}} graphSection
 * @param {{collapsedTracks?: Set<string>, holdingPage?: number, project?: string|null}} [options] `collapsedTracks` holds the track ids currently collapsed — the `?` lane starts in it, so it is collapsed by default without `app.js` deciding that on its own. `project` (optional, defaulting to `null` the way `roadmap-model.mjs`'s own `buildRoadmapModel` already does) sources the epic tracker's stamp to a real forge link when known.
 */
export function buildLaneModel(graphSection, { collapsedTracks = new Set(['?']), holdingPage = 0, project = null, clustering = 'track' } = {}) {
  if (!graphSection || typeof graphSection !== 'object') return { ok: false, reason: 'no graph section was given to the lanes' };
  if (graphSection.ok !== true) return { ok: false, reason: graphSection.reason };

  const { nodes = [], edges = [], issuesUnreadable = [], declarationDivergences = [] } = graphSection.value ?? {};

  const trackOf = new Map(nodes.map((n) => [n.number, n.track ?? null]));
  const byTrack = new Map();
  const holdingNodes = [];
  for (const node of [...nodes].sort(byNumber)) {
    if (node.track == null) { holdingNodes.push(node); continue; }
    if (!byTrack.has(node.track)) byTrack.set(node.track, []);
    byTrack.get(node.track).push(node);
  }

  // Edges are classified ONCE, over the whole graph, before any lane's own
  // layout() runs — a lane that only ever saw its own node subset would
  // read the other endpoint of a cross-lane edge as an unknown node
  // (layout.mjs's own "unknown node" reason), which is a different fact
  // from "this edge leaves the lane". Every valid edge lands in exactly one
  // of three buckets below.
  const droppedEdges = [];
  const crossEdges = [];
  const perLaneEdges = new Map();
  const holdingEdges = [];
  for (const e of edges) {
    if (!trackOf.has(e.from) || !trackOf.has(e.to)) {
      droppedEdges.push({ from: e.from, to: e.to, reason: 'unknown node' });
      continue;
    }
    const fromTrack = trackOf.get(e.from);
    const toTrack = trackOf.get(e.to);
    if (fromTrack === toTrack) {
      // Both undeclared: internal to the HOLDING lane, not a track lane —
      // the `?` lane is still a lane for edge classification (R998-3's
      // cold review), so this edge is kept and counted, never silently
      // continued past.
      if (fromTrack == null) { holdingEdges.push({ from: e.from, to: e.to }); continue; }
      if (!perLaneEdges.has(fromTrack)) perLaneEdges.set(fromTrack, []);
      perLaneEdges.get(fromTrack).push({ from: e.from, to: e.to });
      continue;
    }
    crossEdges.push({ from: e.from, to: e.to, fromTrack: fromTrack ?? '?', toTrack: toTrack ?? '?' });
  }
  crossEdges.sort(byFromTo);
  droppedEdges.sort(byFromTo);
  holdingEdges.sort(byFromTo);

  const trackNames = [...byTrack.keys()].sort((a, b) => a.localeCompare(b));
  const lanes = trackNames.map((track) => {
    const laneNodes = byTrack.get(track);
    const laneEdges = (perLaneEdges.get(track) ?? []).slice().sort(byFromTo);
    const placed = layout({ nodes: laneNodes, edges: laneEdges });
    const drawn = laneNodes.map((node) => drawnNode(node, placed.nodes[node.number]));
    return {
      track,
      label: `Track ${track}`,
      count: drawn.length,
      collapsed: collapsedTracks.has(track),
      nodes: drawn,
      edges: placed.edges,
      width: placed.width,
      height: placed.height,
    };
  });

  // The grouping is built BEFORE the batch, because the batch has to know
  // what it already claimed (#1079 cold review, finding cold-1). A node can
  // declare no track and still declare a parent: in epic clustering the epic
  // shows it, and the `?` batch showing it again drew the same node twice.
  //
  // The arithmetic stays here rather than in the page. This batch states a
  // count, a total and a page span, and a renderer dropping rows from a page
  // it did not compute would make all three lie.
  const epicGrouping = buildEpicGrouping(nodes, declarationDivergences, project);
  const shownElsewhere = clustering === 'epic' && epicGrouping.ok
    ? new Set(nodes.map((n) => n.number).filter((number) => !epicGrouping.value.unclaimed.includes(number)))
    : new Set();

  const holdingAll = [...holdingNodes].sort(byNumber);
  const holdingSorted = holdingAll.filter((n) => !shownElsewhere.has(n.number));
  // NOT hidden — shown somewhere else. The two are different facts, and a
  // batch that silently shrank would misreport how much of the graph declared
  // no track at all.
  const claimedElsewhere = holdingAll.length - holdingSorted.length;
  const holdingTotal = holdingSorted.length;
  const totalPages = Math.max(1, Math.ceil(holdingTotal / PAGE_SIZE));
  const page = Math.min(Math.max(0, holdingPage), totalPages - 1);
  const pageNodesRaw = holdingSorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const pageNodes = pageNodesRaw.map(holdingRow);

  // holding.edges is a BOARD, laid out the same way a lane's own edges are
  // (one layout() call, over that page's own subgraph) — it is never the
  // full cross-page edge set, because only the current page's nodes have
  // coordinates to draw a line between. holding.edgeCount, by contrast, is
  // every holding-holding edge across every page, so the collapsed header
  // can say the true total without expanding first.
  const pageNumbers = new Set(pageNodesRaw.map((n) => n.number));
  const pageHoldingEdges = holdingEdges.filter((e) => pageNumbers.has(e.from) && pageNumbers.has(e.to));
  const placedHolding = layout({ nodes: pageNodesRaw, edges: pageHoldingEdges });
  const boardNodes = pageNodesRaw.map((node) => drawnNode(node, placedHolding.nodes[node.number]));

  const holding = {
    track: '?',
    count: holdingTotal,
    // #1059 region 04: the design states the batch as a proportion of the
    // whole graph ("67 of 91"), so the whole travels with the part rather
    // than the page adding two numbers from two places.
    total: nodes.length,
    collapsed: collapsedTracks.has('?'),
    page,
    totalPages,
    nodes: pageNodes,
    boardNodes,
    edges: placedHolding.edges,
    edgeCount: holdingEdges.length,
    width: placedHolding.width,
    height: placedHolding.height,
    claimedElsewhere,
    declareSnippet: DECLARE_SNIPPET,
    declareNote: DECLARE_NOTE,
    // Never empty-on-failure: a page with nothing currently visible and a
    // track with nothing left to declare are different facts.
    note: holdingTotal === 0 ? 'every open issue declares a track' : null,
  };

  // Every valid edge lands in EXACTLY one of these four counts — the
  // classification invariant a cold review (#998 R998-3) found broken for
  // same-track null/null edges, which used to vanish uncounted.
  const laneInternal = lanes.reduce((sum, l) => sum + l.edges.length, 0);
  const edgeSummary = {
    laneInternal,
    holdingInternal: holdingEdges.length,
    crossLane: crossEdges.length,
    unknownNode: droppedEdges.length,
    total: laneInternal + holdingEdges.length + crossEdges.length + droppedEdges.length,
  };

  return {
    ok: true,
    value: {
      lanes,
      crossEdges,
      holding,
      droppedEdges,
      issuesUnreadable,
      edgeSummary,
      epicGrouping,
    },
  };
}
