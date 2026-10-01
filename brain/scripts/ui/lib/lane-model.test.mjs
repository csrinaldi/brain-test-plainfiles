// lane-model.test.mjs — #998 R998-3: track lanes and the `?` holding lane.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLaneModel, nodeSummaryFor, childrenOf } from './lane-model.mjs';
import { parseGraphBlock } from '../../status/epic-graph.mjs';

const node = (number, over = {}) => ({
  number,
  title: `issue ${number}`,
  status: 'ready',
  track: 'A',
  blockedBy: [],
  ok: true,
  roadmap: { ok: true, value: { state: 'planned' } },
  ...over,
});

const graph = (value) => ({ ok: true, value: { nodes: [], edges: [], issuesUnreadable: [], ...value } });

test('#998 R998-3: a graph that could not be computed is a stated reason, never an empty lane row', () => {
  const model = buildLaneModel({ ok: false, reason: 'the issue list could not be read: gh exploded' });
  assert.deepEqual(model, { ok: false, reason: 'the issue list could not be read: gh exploded' });
  assert.equal(buildLaneModel(undefined).ok, false);
  assert.match(buildLaneModel(undefined).reason, /no graph section/);
});

test('#998 R998-3: the undeclared majority lands in the `?` holding lane, collapsed by default, with a visible total', () => {
  const nodes = [];
  for (let i = 1; i <= 67; i++) nodes.push(node(i, { track: null }));
  for (let i = 68; i <= 91; i++) nodes.push(node(i, { track: i % 2 === 0 ? 'A' : 'B' }));
  const model = buildLaneModel(graph({ nodes }));
  assert.equal(model.ok, true);
  assert.equal(model.value.holding.count, 67);
  assert.equal(model.value.holding.collapsed, true, 'the `?` lane is collapsed by default');
  const totalInLanes = model.value.lanes.reduce((sum, l) => sum + l.count, 0);
  assert.equal(totalInLanes + model.value.holding.count, 91, 'every node lands in exactly one lane or the holding lane');
  const s = model.value.edgeSummary;
  assert.equal(s.laneInternal + s.holdingInternal + s.crossLane + s.unknownNode, 0, 'no edges in this fixture, so every count and the sum is zero');
  assert.equal(s.total, 0, "the 91-node fixture's edgeSummary sums to its edge count (0)");
});

test('#998 R998-3: an edge between two undeclared nodes belongs to the holding lane — it is classified, not swallowed', () => {
  const model = buildLaneModel(graph({
    nodes: [node(1, { track: null }), node(2, { track: null })],
    edges: [{ from: 1, to: 2 }],
  }));
  assert.equal(model.value.holding.edges.length, 1, 'the holding-holding edge lands in holding.edges');
  assert.equal(model.value.holding.edges[0].from, 1);
  assert.equal(model.value.holding.edges[0].to, 2);
  assert.equal(model.value.holding.edgeCount, 1, 'counted for the collapsed header');
  assert.deepEqual(model.value.edgeSummary, { laneInternal: 0, holdingInternal: 1, crossLane: 0, unknownNode: 0, total: 1 });
});

test('#998 R998-3: an edge from the holding lane to a declared track crosses lanes, named `?`', () => {
  const model = buildLaneModel(graph({
    nodes: [node(1, { track: null }), node(2, { track: 'A' })],
    edges: [{ from: 1, to: 2 }],
  }));
  assert.deepEqual(model.value.crossEdges, [{ from: 1, to: 2, fromTrack: '?', toTrack: 'A' }]);
  assert.equal(model.value.holding.edges.length, 0, 'a cross-lane edge belongs to neither the holding board nor a lane board');
  assert.equal(model.value.edgeSummary.crossLane, 1);
  assert.equal(model.value.edgeSummary.total, 1);
});

test('#998 R998-3: the holding lane pages at 24 per page', () => {
  const nodes = Array.from({ length: 50 }, (_, i) => node(i + 1, { track: null }));
  const model = buildLaneModel(graph({ nodes }), { holdingPage: 1 });
  assert.equal(model.value.holding.nodes.length, 24);
  assert.deepEqual(model.value.holding.nodes.map((n) => n.number), Array.from({ length: 24 }, (_, i) => 25 + i));
  assert.equal(model.value.holding.totalPages, 3);
});

test('#998 R998-3: a reversed edge inside a lane is kept, marked, and never treated as leaving the lane', () => {
  const model = buildLaneModel(graph({
    nodes: [node(1), node(2)],
    edges: [{ from: 1, to: 2 }, { from: 2, to: 1 }],
  }));
  const laneA = model.value.lanes.find((l) => l.track === 'A');
  assert.equal(laneA.edges.length, 2);
  assert.equal(laneA.edges.filter((e) => e.reversed).length, 1);
  assert.equal(model.value.crossEdges.length, 0);
});

test('#998 R998-3: a cross-lane edge is never dropped — it is reported with both lanes named', () => {
  const model = buildLaneModel(graph({
    nodes: [node(1, { track: 'A' }), node(2, { track: 'B' })],
    edges: [{ from: 1, to: 2 }],
  }));
  assert.deepEqual(model.value.crossEdges, [{ from: 1, to: 2, fromTrack: 'A', toTrack: 'B' }]);
  for (const lane of model.value.lanes) assert.equal(lane.edges.length, 0, "the cross edge belongs to neither lane's own board");
});

test('#998 R998-3: an edge to an unknown node is reported, not swallowed', () => {
  const model = buildLaneModel(graph({ nodes: [node(1)], edges: [{ from: 1, to: 99 }] }));
  assert.deepEqual(model.value.droppedEdges, [{ from: 1, to: 99, reason: 'unknown node' }]);
});

test('#998 R998-3: every node carries a state word and mark for the label, alongside its existing marks', () => {
  const model = buildLaneModel(graph({ nodes: [node(1, { blockedBy: [2] })] }));
  const drawn = model.value.lanes[0].nodes[0];
  assert.deepEqual(drawn.state, { code: 'blocked', label: 'Blocked', mark: '⊘' });
  assert.ok(Array.isArray(drawn.marks) && drawn.marks.some((m) => m.includes('blocked by')));
});

test('#1032: a node with no declared parent is untouched by epicGrouping — it stays in its track lane as today', () => {
  const model = buildLaneModel(graph({ nodes: [node(1)] }));
  assert.equal(model.value.epicGrouping.ok, true);
  // "Untouched" is not "absent": the node is UNCLAIMED, which is what tells
  // the board to keep drawing it in its track lane. Leaving it out of every
  // set would read as a node this grouping had never seen.
  assert.deepEqual(model.value.epicGrouping.value, { epics: [], divergentChildren: [], unclaimed: [1] });
});

test('#998 R998-3: the declare snippet parses as a real brain-graph/1 declaration', () => {
  const model = buildLaneModel(graph({ nodes: [] }));
  const parsed = parseGraphBlock(model.value.holding.declareSnippet);
  assert.ok(parsed && parsed.ok !== false, `the snippet must parse: ${JSON.stringify(parsed)}`);
  assert.equal(typeof parsed.track, 'string');
  assert.ok(parsed.track.length > 0, 'the snippet declares a track, the whole point of pasting it');
});

test('#998 R998-3: a lane with zero nodes does not exist', () => {
  const model = buildLaneModel(graph({ nodes: [node(1, { track: 'A' })] }));
  assert.deepEqual(model.value.lanes.map((l) => l.track), ['A']);
  assert.ok(model.value.lanes.every((l) => l.count > 0));
});

test('#998 R998-3: the `?` lane with zero nodes says every open issue declares a track', () => {
  const model = buildLaneModel(graph({ nodes: [node(1, { track: 'A' })] }));
  assert.equal(model.value.holding.count, 0);
  assert.equal(model.value.holding.note, 'every open issue declares a track');
});

test('#998 R998-3: the same graph, nodes and edges shuffled, gives a byte-identical model', () => {
  const nodes = [node(3, { track: 'B' }), node(1, { track: 'A' }), node(5, { track: null }), node(2, { track: 'A' }), node(4, { track: 'B' })];
  const edges = [{ from: 1, to: 2 }, { from: 3, to: 4 }];
  const a = buildLaneModel(graph({ nodes, edges }));
  const b = buildLaneModel(graph({ nodes: [...nodes].reverse(), edges: [...edges].reverse() }));
  assert.deepEqual(a, b);
});

// ── #1059 phase 3: the design draws a lane as a grid of cards ─────────────
// A card names the issue, its title on its own line, its state, and what it
// waits on. `label` glued the number and the title into one string for an SVG
// text node; a card needs them apart, and the edges it used to draw as lines
// become the words "blocked by #N" on the card that is blocked.
test('#1059 region 03: a lane node carries its title and what blocks it, apart from its label', () => {
  const model = buildLaneModel({ ok: true, value: {
    nodes: [
      { number: 881, title: 'ui server, SVG canvas, SSE live stream', track: 'UI', status: 'ready', blockedBy: [], roadmap: { ok: true, value: { state: 'in-flight' } } },
      { number: 882, title: 'management views', track: 'UI', status: 'blocked', blockedBy: [881], roadmap: { ok: true, value: { state: 'planned' } } },
    ],
    edges: [{ from: 881, to: 882 }],
    tracks: new Map([['UI', [881, 882]]]),
  } });

  assert.equal(model.ok, true);
  const [lane] = model.value.lanes;
  const [first, second] = lane.nodes;
  assert.equal(first.title, 'ui server, SVG canvas, SSE live stream', 'the title stands on its own, not glued into the label');
  assert.deepEqual(second.blockedBy, [881], 'what a node waits on is a fact of the card, not only a drawn line');
  assert.deepEqual(first.blockedBy, []);
});

// #1059 phase 5: the design states the batch as a proportion — "67 of 91 open
// issues declared no block" — so the holding lane carries the total it is a
// part of, rather than the page computing it from two places.
test('#1059 region 04: the holding lane knows the whole it is a part of', () => {
  const model = buildLaneModel({ ok: true, value: {
    nodes: [
      { number: 1, title: 'a', track: 'UI', status: 'ready', blockedBy: [] },
      { number: 2, title: 'b', track: null, status: 'unclassified', blockedBy: [] },
      { number: 3, title: 'c', track: null, status: 'unclassified', blockedBy: [] },
    ],
    edges: [],
    tracks: new Map([['UI', [1]]]),
  } });

  assert.equal(model.value.holding.count, 2);
  assert.equal(model.value.holding.total, 3, 'the batch says "2 of 3", and both numbers come from one place');
});

// ── #1059 region 08: the drawer's own header names the node ───────────────
// The design's panel opens with the issue's number, its state, its track and a
// link to the forge. That is the same shape a card carries, so it comes from
// the same place rather than being derived a second time in the page.
test('#1059 region 08: nodeSummaryFor gives the drawer the node a card would show', () => {
  const graph = { ok: true, value: {
    nodes: [{ number: 881, title: 'ui server', track: 'UI', status: 'ready', blockedBy: [879], roadmap: { ok: true, value: { state: 'in-flight' } } }],
    edges: [], tracks: new Map([['UI', [881]]]),
  } };

  const found = nodeSummaryFor(graph, 881);
  assert.equal(found.ok, true);
  assert.equal(found.value.number, 881);
  assert.equal(found.value.title, 'ui server');
  assert.equal(found.value.track, 'UI');
  assert.deepEqual(found.value.blockedBy, [879]);
  assert.equal(typeof found.value.state.label, 'string');
  assert.equal(typeof found.value.state.mark, 'string');

  const missing = nodeSummaryFor(graph, 4242);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /#4242/, 'an issue the graph does not hold says which one');

  const unreadable = nodeSummaryFor({ ok: false, reason: 'the forge would not answer' }, 881);
  assert.equal(unreadable.reason, 'the forge would not answer', 'the section\'s own reason passes through');
});

// ── #1059 phase 10: a node's own children ─────────────────────────────────
// Selecting an epic should show the tickets that belong to it. `parent` is a
// node field since #967, so the relation is already data — it just had no
// reader. The relation is DECLARED by the child, so the parent's list is
// whoever points at it, never a list the parent itself carries.
test('#1059: childrenOf lists the issues that declare this one as their parent', () => {
  const graph = { ok: true, value: {
    nodes: [
      { number: 878, title: 'the epic', track: 'UI', status: 'ready', blockedBy: [], parent: null },
      { number: 1059, title: 'the design', track: 'UI', status: 'ready', blockedBy: [], parent: 878 },
      { number: 1032, title: 'epic lanes', track: 'UI', status: 'ready', blockedBy: [], parent: 878 },
      { number: 1026, title: 'a memory fix', track: 'MEMORY', status: 'ready', blockedBy: [], parent: null },
    ],
    edges: [], tracks: new Map(),
  } };

  const children = childrenOf(graph, 878);
  assert.equal(children.ok, true);
  assert.deepEqual(children.value.map((c) => c.number), [1032, 1059], 'ascending, so the list does not depend on the forge\'s order');
  assert.equal(children.value[0].title, 'epic lanes');
  assert.equal(typeof children.value[0].state.mark, 'string', 'a child is shown with the same state vocabulary a card uses');

  assert.deepEqual(childrenOf(graph, 1026).value, [], 'a node nobody declares as parent has no children — that is a fact, not a failure');
  assert.equal(childrenOf({ ok: false, reason: 'the forge would not answer' }, 878).reason, 'the forge would not answer');
});

// ── #1032: epicGrouping becomes real — kind and parent are data since #967 ─
// `kind`/`parent` are declarations the issue body already carries (D9's own
// pure-module rule holds here too): an epic is a node like any other, never
// a second grouping vocabulary. Fixtures below use the exact key list and
// the exact live values captured from `/api/snapshot` for issue #1032
// (#878/#884/#1071/#1056/#1035 etc — verified against the running server on
// main, 2026-09-19): #878 is the top-level epic (`tracker: null`, `parent:
// null`), #884 is BOTH an epic and a declared child of #878
// (`parentSource: 'prose'`), and #1071's parent came from the `block` — the
// two `parentSource` values the real data actually carries.

const epicGraph = (nodes, over = {}) => graph({ nodes, declarationDivergences: [], ...over });

test('#1032: a node whose parent resolves to a real epic groups under that epic, the epic\'s own row leading its slice', () => {
  const epic = node(878, { title: 'the tracker epic', kind: 'epic', parent: null, parentSource: null, tracker: null });
  const child = node(1071, { title: 'a slice of #878', kind: null, parent: 878, parentSource: 'block' });
  const model = buildLaneModel(epicGraph([epic, child]));
  assert.equal(model.value.epicGrouping.ok, true);
  const { epics, divergentChildren } = model.value.epicGrouping.value;
  assert.equal(epics.length, 1);
  assert.equal(epics[0].number, 878);
  assert.equal(epics[0].title, 'the tracker epic');
  assert.deepEqual(epics[0].children.map((c) => c.number), [1071]);
  assert.equal(epics[0].children[0].parentSource, 'block', 'block vs prose provenance survives to the reader (house rule 5)');
  assert.deepEqual(divergentChildren, [], 'the one declared child is grouped, not divergent');
});

test('#1032: children nest under their epic in ascending order regardless of input order (determinism)', () => {
  const epic = node(878, { kind: 'epic', parent: null, tracker: null });
  const c1 = node(1071, { parent: 878, parentSource: 'block' });
  const c2 = node(880, { parent: 878, parentSource: 'prose' });
  const c3 = node(1035, { parent: 878, parentSource: 'prose' });
  const forward = buildLaneModel(epicGraph([epic, c1, c2, c3]));
  const shuffled = buildLaneModel(epicGraph([c3, epic, c1, c2]));
  assert.deepEqual(forward.value.epicGrouping, shuffled.value.epicGrouping);
  assert.deepEqual(forward.value.epicGrouping.value.epics[0].children.map((c) => c.number), [880, 1035, 1071]);
});

test('#1032: a node whose declared parent is not an epic keeps the said divergence the graph already reports, never silently reparented', () => {
  const notEpic = node(1, { title: 'not an epic', kind: null, parent: null });
  const child = node(2, { parent: 1, parentSource: 'prose' });
  // The reason is deliberately NOT the local fallback ('parent-not-epic') a
  // resolved-non-epic-parent would realistically carry — a fixture that used
  // the fallback value could pass even if the graph's own entry were never
  // read at all (a hole a mutation-testing pass caught: killing the
  // `reportedReasonFor` lookup left this test green). A distinguishing value
  // proves the graph's OWN reason is what is carried through, not a locally
  // re-derived default that happens to coincide with it.
  const divergences = [{ number: 2, key: 'parent', value: 1, reason: 'parent-ambiguous' }];
  const model = buildLaneModel(epicGraph([notEpic, child], { declarationDivergences: divergences }));
  const { epics, divergentChildren } = model.value.epicGrouping.value;
  assert.equal(epics.length, 0, 'the non-epic parent never becomes a fake epic row');
  assert.equal(divergentChildren.length, 1);
  assert.equal(divergentChildren[0].number, 2);
  assert.equal(divergentChildren[0].parent, 1);
  assert.equal(divergentChildren[0].parentSource, 'prose');
  assert.equal(divergentChildren[0].reason, 'parent-ambiguous', 'the graph\'s own reason is carried through, never re-derived');
});

test('#1032: a node with no declared parent never appears in epics.children nor divergentChildren — it stays in its track lane as today', () => {
  const epic = node(878, { kind: 'epic', parent: null, tracker: null });
  const orphan = node(50, { parent: null });
  const model = buildLaneModel(epicGraph([epic, orphan]));
  const { epics, divergentChildren } = model.value.epicGrouping.value;
  assert.deepEqual(epics[0].children, []);
  assert.deepEqual(divergentChildren, []);
});

test('#1032: an epic is a node like any other — its OWN declared parent absent from the graph states the same honest fact a plain node would', () => {
  const epic = node(884, { kind: 'epic', parent: 9999, parentSource: 'prose', tracker: null });
  const model = buildLaneModel(epicGraph([epic]));
  const row = model.value.epicGrouping.value.epics[0];
  assert.deepEqual(row.parentDivergence, { parent: 9999, parentSource: 'prose', reason: 'parent-not-in-graph' });
});

test('#1032: a parent number absent from the graph entirely states its own honest fact rather than borrowing a reason the graph never reported', () => {
  const child = node(2, { parent: 9999, parentSource: 'prose' });
  const model = buildLaneModel(epicGraph([child]));
  const { divergentChildren } = model.value.epicGrouping.value;
  assert.equal(divergentChildren.length, 1);
  assert.equal(divergentChildren[0].reason, 'parent-not-in-graph');
  assert.equal(divergentChildren[0].parent, 9999);
});

test('#1032: nested epics are real (#884 IS one) — epics stay FLAT, the dropped parent-epic relation is said on the child epic\'s own row, never silently absorbed', () => {
  const grandparent = node(878, { title: 'the tracker epic', kind: 'epic', parent: null, tracker: null });
  const nested = node(884, { title: 'nested epic', kind: 'epic', parent: 878, parentSource: 'prose', tracker: null });
  const model = buildLaneModel(epicGraph([grandparent, nested]));
  const { epics } = model.value.epicGrouping.value;
  assert.equal(epics.length, 2, 'both epics get their own top-level row — epics are never nested under each other');
  const child = epics.find((e) => e.number === 884);
  const parent = epics.find((e) => e.number === 878);
  assert.deepEqual(child.parentDivergence, { parent: 878, parentSource: 'prose', reason: 'nested-epic-not-supported' });
  assert.equal(parent.parentDivergence, null, 'the parent epic itself carries no divergence of its own');
  assert.deepEqual(child.children, [], 'a nested epic leads no slice of its own in this flat model — it is not a non-epic node');
});

test('#1032: an epic that declares no tracker says so explicitly — the live data\'s own reality today for every epic', () => {
  const epic = node(878, { kind: 'epic', parent: null, tracker: null });
  const model = buildLaneModel(epicGraph([epic]));
  assert.deepEqual(model.value.epicGrouping.value.epics[0].tracker, { branch: null, stamp: null, reason: 'epic-declares-no-tracker' });
});

test('#1032: an epic that declares a tracker names it with a stamp — a forge label without a project, a real issue link with one', () => {
  const epic = node(878, { kind: 'epic', parent: null, tracker: 'feature/epic-878' });
  const noProject = buildLaneModel(epicGraph([epic]));
  assert.deepEqual(noProject.value.epicGrouping.value.epics[0].tracker, {
    branch: 'feature/epic-878',
    stamp: { label: '[forge: #878]', href: null, kind: 'forge' },
    reason: null,
  });
  const withProject = buildLaneModel(epicGraph([epic]), { project: 'o/r' });
  assert.deepEqual(withProject.value.epicGrouping.value.epics[0].tracker, {
    branch: 'feature/epic-878',
    stamp: { label: '[forge: #878]', href: 'https://github.com/o/r/issues/878', kind: 'forge' },
    reason: null,
  });
});

test('#1032: every grouped child carries an explicit, never-computed baseCheck — the "open PR targets a wrong base" marking needs the PR list this model does not receive', () => {
  const epic = node(878, { kind: 'epic', parent: null, tracker: 'feature/epic-878' });
  const child = node(1071, { parent: 878, parentSource: 'block' });
  const model = buildLaneModel(epicGraph([epic, child]));
  const row = model.value.epicGrouping.value.epics[0].children[0];
  assert.equal(row.baseCheck.ok, false, 'never a silent empty area (evidence-reader-empty-on-failure) — the gap is stated, not omitted');
  assert.match(row.baseCheck.reason, /PR list/);
});

test('#1032: the same graph, epics and children shuffled, gives a byte-identical epicGrouping', () => {
  const epic = node(878, { kind: 'epic', parent: null, tracker: null });
  const nested = node(884, { kind: 'epic', parent: 878, parentSource: 'prose', tracker: null });
  const c1 = node(1071, { parent: 878, parentSource: 'block' });
  const c2 = node(880, { parent: 878, parentSource: 'prose' });
  const notEpic = node(1, { kind: null, parent: null });
  const bad = node(2, { parent: 1, parentSource: 'prose' });
  const divergences = [{ number: 2, key: 'parent', value: 1, reason: 'parent-not-epic' }];
  const forward = buildLaneModel(epicGraph([epic, nested, c1, c2, notEpic, bad], { declarationDivergences: divergences }));
  const shuffled = buildLaneModel(epicGraph([bad, c2, nested, notEpic, c1, epic], { declarationDivergences: [...divergences] }));
  assert.deepEqual(forward.value.epicGrouping, shuffled.value.epicGrouping);
});

test('#1032: real-shaped data — #878/#884/#1071, the exact fields and values captured from the running server (kind, parent, parentSource, tracker) — never crashes, groups correctly', () => {
  // The full node key list this graph section carries per #1032's task brief:
  // number, title, labels, state, track, kind, tracker, parent, parentSource,
  // files, declared, sources, assignees, blockedBy, status, conflictsWith,
  // filesUnknown, ok, roadmap.
  const realNode = (over) => ({
    number: over.number, title: over.title, labels: [], state: 'open', track: 'A',
    kind: over.kind ?? null, tracker: over.tracker ?? null, parent: over.parent ?? null,
    parentSource: over.parentSource ?? null, files: [], declared: true, sources: ['declared'],
    assignees: null, blockedBy: [], status: 'ready', conflictsWith: [], filesUnknown: false,
    ok: true, roadmap: { ok: true, value: { state: 'planned' } },
  });
  const n878 = realNode({ number: 878, title: 'epic tracker', kind: 'epic', parent: null, parentSource: null, tracker: null });
  const n884 = realNode({ number: 884, title: 'nested epic', kind: 'epic', parent: 878, parentSource: 'prose', tracker: null });
  const n1071 = realNode({ number: 1071, title: 'slice', kind: null, parent: 878, parentSource: 'block' });
  const model = buildLaneModel(epicGraph([n878, n884, n1071]));
  assert.equal(model.ok, true);
  const { epics, divergentChildren } = model.value.epicGrouping.value;
  assert.deepEqual(epics.map((e) => e.number), [878, 884]);
  assert.deepEqual(epics.find((e) => e.number === 878).children.map((c) => c.number), [1071]);
  assert.deepEqual(epics.find((e) => e.number === 884).parentDivergence, { parent: 878, parentSource: 'prose', reason: 'nested-epic-not-supported' });
  assert.deepEqual(divergentChildren, []);
});

// ── #1032 part 3: the declare snippet learns the keys that now exist ────────
// The `?` lane's snippet is what an author pastes to LEAVE it. `kind`,
// `parent` and `tracker` became data in #967, and the snippet never learned
// them — so the page told an author how to declare a track and stayed silent
// about the two declarations the lanes now group by.
test('#1032: the declare snippet carries the keys #967 made real, with a note saying which are for whom', () => {
  const model = buildLaneModel({ ok: true, value: { nodes: [{ number: 1, title: 't', track: null, state: 'open', ok: true }], edges: [], tracks: {} } });
  const { declareSnippet, declareNote } = model.value.holding;

  assert.match(declareSnippet, /^```brain-graph\/1$/m, 'the fence the parser reads, not prose about it');
  assert.match(declareSnippet, /^track: /m, 'the key that leaves the `?` lane');
  assert.match(declareSnippet, /^parent: /m, 'and the one that puts a slice under its epic');
  assert.match(declareSnippet, /^kind: /m, 'and the one that makes a node an epic at all');

  // A snippet is a worked example, not a form to submit whole: telling every
  // undeclared issue to paste `kind: epic` would declare a repository full of
  // epics. The note is what keeps the example from reading as an instruction.
  assert.equal(typeof declareNote, 'string');
  assert.match(declareNote, /epic/i, 'the note says `kind` is for an epic');
  assert.match(declareNote, /parent/i, 'and that `parent` is for a slice of one');

  // Every key in the snippet is one the parser actually reads. A key nobody
  // reads would be an instruction to write something with no effect.
  const keys = declareSnippet.split('\n').filter((l) => /^[a-z]+:/.test(l)).map((l) => l.split(':')[0]);
  assert.deepEqual([...keys].sort(), ['blocks', 'files', 'kind', 'needs', 'parent', 'track']);
});

// ── #1032: the model says who it did NOT claim ─────────────────────────────
// The page must be able to draw epic clusters without drawing a claimed node
// twice, and it may not work that out for itself: deciding which nodes an
// epic owns is this model's job, and a renderer re-deriving it is a second
// answer that can disagree with the first.
test('#1032: epicGrouping names the nodes no epic claims, so the page never draws one twice', () => {
  const nodes = [
    { number: 100, title: 'the epic', track: 'UI', kind: 'epic', parent: null, state: 'open', ok: true },
    { number: 101, title: 'its slice', track: 'UI', kind: null, parent: 100, parentSource: 'block', state: 'open', ok: true },
    { number: 102, title: 'no parent', track: 'UI', kind: null, parent: null, state: 'open', ok: true },
    { number: 103, title: 'parent is not an epic', track: 'GOVERNANCE', kind: null, parent: 102, parentSource: 'block', state: 'open', ok: true },
  ];
  const model = buildLaneModel({ ok: true, value: { nodes, edges: [], tracks: {} } });
  const grouping = model.value.epicGrouping;
  assert.equal(grouping.ok, true);

  assert.ok(Array.isArray(grouping.value.unclaimed), 'the model states who it did not claim');
  // #100 leads its own cluster and #101 sits under it, so neither is
  // unclaimed. #102 declared no parent and #103's parent is not an epic —
  // both are still on the board, in their track lanes, exactly as before.
  assert.deepEqual([...grouping.value.unclaimed].sort((a, b) => a - b), [102, 103]);

  // Every node is accounted for exactly once: claimed by an epic, leading a
  // cluster, or unclaimed. A node in neither set would vanish from a board
  // that trusted this answer.
  const claimed = grouping.value.epics.flatMap((e) => [e.number, ...e.children.map((c) => c.number)]);
  const seen = [...claimed, ...grouping.value.unclaimed].sort((a, b) => a - b);
  assert.deepEqual(seen, [100, 101, 102, 103], 'the three sets partition the graph — no node counted twice, none dropped');
});

// ── #1032: a grouped row IS a card, not a near-card ─────────────────────────
// `app.js` draws an epic's slices with `renderNodeCard`, the same function the
// track lanes use. A row missing a field that renderer reads produces a card
// with `class="node-card undefined"` and throws on `blockedBy.length` — the
// exact shape-mismatch that shipped this morning in `sddForIssue` and took a
// whole board down with it. The two shapes are pinned against each other here
// rather than trusted to stay aligned by reading.
test('#1032: an epic-grouped row carries every field a lane card carries, so one renderer draws both', () => {
  const nodes = [
    { number: 200, title: 'the epic', track: 'UI', kind: 'epic', parent: null, state: 'open', ok: true },
    { number: 201, title: 'its slice', track: 'UI', kind: null, parent: 200, parentSource: 'block', blockedBy: [999], state: 'open', ok: true },
  ];
  const model = buildLaneModel({ ok: true, value: { nodes, edges: [], tracks: {} } });

  const laneCard = model.value.lanes.flatMap((l) => l.nodes).find((n) => n.number === 201);
  const grouped = model.value.epicGrouping.value.epics[0].children.find((c) => c.number === 201);
  const epicRow = model.value.epicGrouping.value.epics[0];
  assert.ok(laneCard && grouped, 'the same node appears in both places');

  // Everything the card renderer reads. A field here that a lane card has and
  // a grouped row lacks is a card that draws wrong or throws.
  for (const field of ['number', 'title', 'className', 'marks', 'state', 'track']) {
    assert.deepEqual(grouped[field], laneCard[field], `a grouped row must carry \`${field}\` exactly as its lane card does`);
    assert.deepEqual(epicRow[field], model.value.lanes.flatMap((l) => l.nodes).find((n) => n.number === 200)[field],
      `and so must the epic's own row: the page draws it as a heading rather than a card, but it reads the same \`state\` and \`marks\` to do it, and a row that carried different words there would contradict the same node's card one mode away`);
  }
  assert.deepEqual(grouped.blockedBy, [999], 'what a slice waits on is a fact of its card, wherever the card is drawn');
  assert.deepEqual(epicRow.blockedBy, []);

  // The coordinates are NOT carried: a cluster is a grid, not a board, and a
  // grouped row that pretended to have a position would be inviting a second
  // layout engine into a module that deliberately has none.
  assert.equal(grouped.x, undefined, 'a cluster lays out as a grid; coordinates belong to a lane board');
});

// ── #1079 cold review, finding cold-1 ──────────────────────────────────────
// A node can declare NO TRACK and still declare a parent. In epic clustering
// the epic claims it, and the `?` holding lane held it too — so expanding the
// batch drew the same node a second time. The lanes were filtered by
// `unclaimed`; the holding lane was appended whole.
//
// The arithmetic lives here, not in the page: the batch states a count, a
// total and a page span, and a renderer dropping rows from a page it did not
// compute would make all three lie.
test('#1079: in epic clustering the `?` batch excludes what an epic already claimed, and says how many', () => {
  const nodes = [
    { number: 1, title: 'epic', track: 'UI', kind: 'epic', parent: null, state: 'open', ok: true },
    { number: 2, title: 'claimed, no track', track: null, kind: null, parent: 1, parentSource: 'block', state: 'open', ok: true },
    { number: 3, title: 'undeclared, no parent', track: null, kind: null, parent: null, state: 'open', ok: true },
  ];
  const section = { ok: true, value: { nodes, edges: [], tracks: {} } };

  // Track swimlanes: the batch is what it always was. Declaring a parent does
  // not declare a track, and this lane is about the track.
  const byTrack = buildLaneModel(section, { collapsedTracks: new Set() });
  assert.deepEqual(byTrack.value.holding.nodes.map((n) => n.number), [2, 3]);
  assert.equal(byTrack.value.holding.count, 2);
  assert.equal(byTrack.value.holding.claimedElsewhere, 0, 'nothing is shown elsewhere in this mode');

  // Epic clusters: #2 is on screen under its epic, so the batch must not show
  // it again — and must not pretend it was never undeclared either.
  const byEpic = buildLaneModel(section, { collapsedTracks: new Set(), clustering: 'epic' });
  assert.deepEqual(byEpic.value.holding.nodes.map((n) => n.number), [3], 'only what no epic claimed');
  assert.equal(byEpic.value.holding.count, 1, 'and the count is of what this batch actually shows');
  assert.equal(byEpic.value.holding.claimedElsewhere, 1,
    'the one it is not showing is stated — a batch that silently shrank would misreport how much of the graph declared no track');
  assert.equal(byEpic.value.holding.total, 3, 'the proportion is still of every open issue');
});
