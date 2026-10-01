// roadmap-model.test.mjs — R882-2: the epic graph grouped for real. No
// timeline is computed (no start/due date exists anywhere in the data) —
// this is per-epic STATUS grouping only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRoadmapModel } from './roadmap-model.mjs';
import { issueUrl } from './forge-url.mjs';

const node = (number, over = {}) => ({
  number,
  title: `issue ${number}`,
  kind: null,
  parent: null,
  status: 'ready',
  blockedBy: [],
  roadmap: { ok: true, value: { state: 'planned' } },
  ...over,
});

const graph = (over = {}) => ({ ok: true, value: { nodes: [], declarationDivergences: [], ...over } });

test('#882 R882-2: a graph section that could not be computed is a stated reason, never an empty roadmap', () => {
  assert.deepEqual(buildRoadmapModel({ ok: false, reason: 'the issue list could not be read: gh exploded' }), {
    ok: false,
    reason: 'the issue list could not be read: gh exploded',
  });
  assert.equal(buildRoadmapModel(undefined).ok, false);
  assert.match(buildRoadmapModel(undefined).reason, /no graph section/);
});

test('#882 R882-2: an epic\'s declared children nest under it, each carrying its own roadmap state', () => {
  const epic = node(1, { kind: 'epic', title: 'the epic' });
  const c1 = node(2, { parent: 1, roadmap: { ok: true, value: { state: 'in-flight' } } });
  const c2 = node(3, { parent: 1, roadmap: { ok: true, value: { state: 'done' } } });
  const c3 = node(4, { parent: 1 });
  const model = buildRoadmapModel(graph({ nodes: [epic, c1, c2, c3] }));
  assert.equal(model.ok, true);
  assert.equal(model.value.epics.length, 1);
  const row = model.value.epics[0];
  assert.equal(row.number, 1);
  assert.deepEqual(row.children.map((c) => c.number), [2, 3, 4]);
  assert.equal(row.children[0].state.code, 'in-flight');
  assert.equal(row.children[1].state.code, 'done');
});

test('#882 R882-2: a node with no declared parent is never dropped — it lands in the unlinked bucket', () => {
  const model = buildRoadmapModel(graph({ nodes: [node(5)] }));
  assert.equal(model.ok, true);
  assert.equal(model.value.epics.length, 0);
  assert.deepEqual(model.value.unlinked.map((n) => n.number), [5]);
});

test('#882 R882-2: a parent that is not itself an epic is said, never silently trusted as a real epic', () => {
  const notEpic = node(1, { title: 'not an epic' });
  const child = node(2, { parent: 1 });
  const divergences = [{ number: 2, key: 'parent', value: 1, reason: 'parent-not-epic' }];
  const model = buildRoadmapModel(graph({ nodes: [notEpic, child], declarationDivergences: divergences }));
  assert.equal(model.ok, true);
  assert.equal(model.value.epics.length, 0, 'the non-epic parent gets no epic row');
  assert.deepEqual(model.value.unlinked.map((n) => n.number), [1, 2], 'neither node is dropped — the would-be parent is itself a plain unlinked node');
  const childRow = model.value.unlinked.find((n) => n.number === 2);
  assert.deepEqual(childRow.divergences, [{ key: 'parent', value: 1, reason: 'parent-not-epic' }], 'the child carries its own parent-not-epic divergence, never silently nested under #1');
});

test('#882 R882-2: determinism under shuffled input — the same graph, nodes in any order, is a byte-identical model', () => {
  const epic = node(10, { kind: 'epic' });
  const c1 = node(11, { parent: 10 });
  const c2 = node(12, { parent: 10 });
  const unlinked1 = node(13);
  const unlinked2 = node(14);
  const forward = buildRoadmapModel(graph({ nodes: [epic, c1, c2, unlinked1, unlinked2] }));
  const shuffled = buildRoadmapModel(graph({ nodes: [unlinked2, c2, epic, unlinked1, c1] }));
  assert.deepEqual(forward, shuffled);
});

// ── #882 cold review of PR 1 (blocker): every row goes through
// governance-model.mjs's row() and carries a real source when a project is
// known ───────────────────────────────────────────────────────────────────

test('#882 cold review of PR 1 (blocker): a row sources to its issue URL through forge-url.mjs when a project is known', () => {
  const model = buildRoadmapModel(graph({ nodes: [node(7)] }), { project: 'o/r' });
  const row = model.value.unlinked[0];
  assert.equal(row.source, issueUrl('o/r', 7));
  assert.deepEqual(row.sourceStamp, { label: '[forge: #7]', href: issueUrl('o/r', 7), kind: 'forge' });
});

test('#882 cold review of PR 1 (blocker): without a known project, a row carries sourceStamp\'s own "no source was recorded" stamp — never a crash, never a guessed link', () => {
  const model = buildRoadmapModel(graph({ nodes: [node(8)] }));
  const row = model.value.unlinked[0];
  assert.equal(row.source, 'no source was recorded for this value');
  assert.deepEqual(row.sourceStamp, { label: '[no source was recorded for this value]', href: null, kind: 'none' });
});

test('#882 cold review of PR 1 (blocker): the epic row itself is sourced too, not only its children', () => {
  const model = buildRoadmapModel(graph({ nodes: [node(20, { kind: 'epic' })] }), { project: 'o/r' });
  assert.equal(model.value.epics[0].source, issueUrl('o/r', 20));
});

// ── #882 cold review of PR #1037 (correction 1): stateOf's own throw on an
// unknown node.status or an unmapped roadmap state must never blank the
// whole canvas — one bad node says its own reason, the rest still draw ──

test('#882 cold review of PR #1037 (correction 1): an unknown node status never throws the whole model — that row says the reason, every other row still draws', () => {
  const bad = node(30, { status: 'a-status-this-table-does-not-know' });
  const good = node(31);
  const model = buildRoadmapModel(graph({ nodes: [bad, good] }));
  assert.equal(model.ok, true, 'one bad node must not fail the whole model');
  const badRow = model.value.unlinked.find((n) => n.number === 30);
  const goodRow = model.value.unlinked.find((n) => n.number === 31);
  assert.equal(badRow.state.code, 'unknown', 'the unknown vocabulary entry exists for exactly this case');
  assert.match(badRow.stateReason, /unknown node status "a-status-this-table-does-not-know"/, 'the row says WHY, not just that it is unknown');
  assert.equal(goodRow.state.code, 'planned', 'the other row is unaffected — one bad node does not cost the operator the rest');
  assert.equal(goodRow.stateReason, null, 'a readable row carries no state reason');
});

test('#882 cold review of PR #1037 (correction 1): an unmapped roadmap state (not just an unknown status) is the same "said, never thrown" case', () => {
  const bad = node(32, { roadmap: { ok: true, value: { state: 'a-roadmap-state-this-table-does-not-know' } } });
  const model = buildRoadmapModel(graph({ nodes: [bad] }));
  assert.equal(model.ok, true);
  const badRow = model.value.unlinked[0];
  assert.equal(badRow.state.code, 'unknown');
  assert.match(badRow.stateReason, /no state for roadmap "a-roadmap-state-this-table-does-not-know"/);
});

// ── #882 cold review of PR #1037 (correction 2): an epic whose declared
// parent is itself an epic is never silently flattened without saying so ──

test('#882 cold review of PR #1037 (correction 2): an epic declaring another epic as its parent is said, not silently dropped — epics stay flat, the relation does not', () => {
  const grandparent = node(40, { kind: 'epic', title: 'grandparent epic' });
  const child = node(41, { kind: 'epic', parent: 40, title: 'child epic' });
  const model = buildRoadmapModel(graph({ nodes: [grandparent, child] }));
  assert.equal(model.ok, true);
  assert.equal(model.value.epics.length, 2, 'both epics still get their own top-level row — epics are not nested');
  const childRow = model.value.epics.find((e) => e.number === 41);
  assert.deepEqual(
    childRow.divergences,
    [{ key: 'parent', value: 40, reason: 'nested-epic-not-supported' }],
    'the dropped parent-epic relation is said on the child epic\'s own row, never silently absorbed',
  );
  const grandparentRow = model.value.epics.find((e) => e.number === 40);
  assert.deepEqual(grandparentRow.divergences, [], 'the parent epic itself carries no divergence of its own');
});
