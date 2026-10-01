// search-model.test.mjs — #1059: the finder that locates epics, trackers and
// tickets across the graph section's nodes. Fixture nodes carry the EXACT 19
// keys the running server emits (verified against `curl -s
// http://127.0.0.1:3000/api/snapshot` while this module was written) — a
// prior defect in this same area came from a test inventing its own fixture
// shape and asserting only the fields every shape happened to share.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { searchNodes, RESULT_CAP } from './search-model.mjs';

const node = (number, over = {}) => ({
  number,
  title: `ticket #${number}`,
  labels: [],
  state: 'open',
  track: null,
  kind: null,
  tracker: null,
  parent: null,
  parentSource: null,
  files: [],
  declared: false,
  sources: [],
  assignees: [],
  blockedBy: [],
  status: 'ready',
  conflictsWith: [],
  filesUnknown: false,
  ok: true,
  roadmap: { ok: true, value: { state: 'planned', evidence: { prs: [] } } },
  ...over,
});

const graph = (value) => ({
  ok: true,
  value: {
    nodes: [],
    edges: [],
    tracks: [],
    divergences: [],
    declarationDivergences: [],
    relationsUnreadable: [],
    blocksUnreadable: [],
    foreignRelations: [],
    issuesUnreadable: [],
    ...value,
  },
});

test('#1059: a missing or malformed graph section is a stated reason, never a thrown error', () => {
  assert.equal(searchNodes(undefined, 'anything').ok, false);
  assert.match(searchNodes(undefined, 'anything').reason, /no graph section/);
  assert.equal(searchNodes(null, 'anything').ok, false);
  assert.equal(searchNodes('nope', 'anything').ok, false);
});

test('#1059: a graph section that could not be computed forwards its own reason, never an empty result list', () => {
  const result = searchNodes({ ok: false, reason: 'the issue list could not be read: gh exploded' }, 'ui');
  assert.deepEqual(result, { ok: false, reason: 'the issue list could not be read: gh exploded' });
});

test('#1059: an empty or whitespace-only query is not an error — it says what to type, and matches nothing', () => {
  const g = graph({ nodes: [node(1), node(2)] });
  for (const q of ['', '   ', undefined, null]) {
    const result = searchNodes(g, q);
    assert.equal(result.ok, true, `query ${JSON.stringify(q)} must not fail`);
    assert.deepEqual(result.value.results, []);
    assert.equal(result.value.total, 0);
    assert.equal(result.value.shown, 0);
    assert.ok(typeof result.value.note === 'string' && result.value.note.length > 0, 'an empty query states what it means instead of rendering a blank area');
  }
});

test('#1059: an exact issue-number match outranks a title substring match', () => {
  const g = graph({
    nodes: [
      node(42, { title: 'fix the flaky retry loop' }),
      node(420, { title: 'a completely unrelated ticket' }),
      node(99, { title: 'this title happens to mention 42 in passing' }),
    ],
  });
  const result = searchNodes(g, '42');
  assert.equal(result.ok, true);
  const numbers = result.value.results.map((r) => r.number);
  assert.deepEqual(numbers, [42, 420, 99], 'exact(42) before prefix(420) before title-substring(99)');
  assert.deepEqual(result.value.results[0].matchedBy, ['number']);
});

test('#1059: a leading "#" is stripped so "#878" finds issue 878 by exact number', () => {
  const g = graph({ nodes: [node(878, { title: "epic(ui): Brain UI" }), node(8780, { title: 'unrelated' })] });
  const result = searchNodes(g, '#878');
  assert.deepEqual(result.value.results.map((r) => r.number), [878, 8780]);
});

test('#1059: title matching is a case-insensitive substring', () => {
  const g = graph({ nodes: [node(1, { title: 'The Lanes Group By Epic' }), node(2, { title: 'unrelated ticket' })] });
  const result = searchNodes(g, 'lanes group');
  assert.deepEqual(result.value.results.map((r) => r.number), [1]);
});

test('#1059: track matching is exact and case-insensitive, not a substring', () => {
  const g = graph({ nodes: [node(1, { track: 'UI' }), node(2, { track: 'UIX' })] });
  const result = searchNodes(g, 'ui');
  assert.deepEqual(result.value.results.map((r) => r.number), [1], 'UIX must not match a bare "ui" track query');
  assert.deepEqual(result.value.results[0].matchedBy, ['track']);
});

test('#1059: label matching covers both an exact label and a label substring, exact ranked first', () => {
  const g = graph({
    nodes: [
      node(1, { labels: ['type:feature'] }),
      node(2, { labels: ['status:type:feature-flag'] }),
    ],
  });
  const result = searchNodes(g, 'type:feature');
  assert.deepEqual(result.value.results.map((r) => r.number), [1, 2], 'exact label match outranks a label substring match');
});

test('#1059: a node with ok:false is still findable by number, and its unreadable state is visible, not dropped', () => {
  const g = graph({
    nodes: [node(500, { ok: false, reason: "issue #500's body could not be read: rate limited", title: null, labels: null })],
  });
  const result = searchNodes(g, '500');
  assert.equal(result.value.results.length, 1);
  const r = result.value.results[0];
  assert.equal(r.number, 500);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "issue #500's body could not be read: rate limited");
});

test('#1059: an unreadable node with no recorded reason still says something, never silently drops the fact', () => {
  const g = graph({ nodes: [node(7, { ok: false, reason: undefined })] });
  const result = searchNodes(g, '7');
  assert.equal(result.value.results[0].ok, false);
  assert.match(result.value.results[0].reason, /#7/);
});

test('#1059: results are capped, and both the shown count and the true total are said', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => node(i + 1, { title: `matching ticket ${i + 1}` }));
  const g = graph({ nodes });
  const result = searchNodes(g, 'matching');
  assert.equal(result.value.total, 30);
  assert.equal(result.value.shown, RESULT_CAP);
  assert.equal(result.value.results.length, RESULT_CAP);
});

test('#1059: options.limit overrides the default cap', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => node(i + 1, { title: `matching ticket ${i + 1}` }));
  const g = graph({ nodes });
  const result = searchNodes(g, 'matching', { limit: 3 });
  assert.equal(result.value.shown, 3);
  assert.equal(result.value.total, 10);
  assert.equal(result.value.cap, 3);
});

test('#1059: a query matching nothing says so by name, never an empty area with no explanation', () => {
  const g = graph({ nodes: [node(1, { title: 'alpha' })] });
  const result = searchNodes(g, 'zzz-nothing-matches');
  assert.equal(result.value.total, 0);
  assert.match(result.value.note, /zzz-nothing-matches/);
});

test('#1059: equal-rank results tie-break by ascending issue number for determinism', () => {
  const g = graph({ nodes: [node(30, { title: 'zeta' }), node(10, { title: 'zeta' }), node(20, { title: 'zeta' })] });
  const result = searchNodes(g, 'zeta');
  assert.deepEqual(result.value.results.map((r) => r.number), [10, 20, 30]);
});

test('#1059: kind and tracker are null on every node today, so the epic/tracker facet says why instead of pretending', () => {
  const g = graph({ nodes: [node(1, { kind: null, tracker: null }), node(2, { kind: null, tracker: null })] });
  const result = searchNodes(g, 'anything');
  assert.equal(result.value.epicTrackerFacet.ok, false);
  assert.match(result.value.epicTrackerFacet.reason, /#1032/);
});

test('#1059: once a node DOES carry a kind, the epic/tracker facet reports it instead of forever saying "no data"', () => {
  const g = graph({
    nodes: [
      node(1, { kind: 'epic', title: 'epic ticket' }),
      node(2, { kind: null, tracker: 'tracker-a' }),
      node(3, { kind: null, tracker: null }),
    ],
  });
  const result = searchNodes(g, 'anything');
  assert.equal(result.value.epicTrackerFacet.ok, true);
  assert.deepEqual(result.value.epicTrackerFacet.value.epics, [1]);
  assert.deepEqual(result.value.epicTrackerFacet.value.trackers, [2]);
});

test('#1059: a node matching by several dimensions reports every dimension it matched by', () => {
  const g = graph({ nodes: [node(9, { title: 'the number 9 appears here too', track: null, labels: [] })] });
  const result = searchNodes(g, '9');
  assert.deepEqual(result.value.results[0].matchedBy, ['number', 'title']);
});

// The name is the guard. A raw graph node's `state` is the forge's own word
// ("open"), while every node `lane-model.mjs` builds carries a `{code, mark,
// label}` object under that same name. Carrying the string through as `state`
// would invite `row.state.code`, which throws at render — the exact class of
// defect that shipped three times in #1059.
test('#1059: a result carries the forge word as forgeState, never as a `state` that reads like the vocabulary object', () => {
  const node = { number: 1, title: 'a ticket', labels: [], track: 'UI', kind: null, tracker: null, parent: null, state: 'open', ok: true };
  const found = searchNodes({ ok: true, value: { nodes: [node] } }, '1');

  assert.equal(found.value.results[0].forgeState, 'open', 'the forge word travels under its own name');
  assert.ok(!('state' in found.value.results[0]),
    'and nothing on a result row is called `state`, so no renderer can reach for `.code` on a string');
});
