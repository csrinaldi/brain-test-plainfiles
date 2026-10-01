// header-model.test.mjs — the status bar's read model (#1059 phase 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildHeaderModel, EPIC_JOIN_PENDING } from './header-model.mjs';

const graph = (nodes) => ({ ok: true, value: { nodes } });
const node = (over = {}) => ({ number: 1, title: 't', track: 'UI', ...over });

test('#1059 region 01: the counts split the graph into tracked and undeclared, and they sum to the node count', () => {
  const model = buildHeaderModel(graph([
    node({ number: 1, track: 'UI' }),
    node({ number: 2, track: 'GOVERNANCE' }),
    node({ number: 3, track: null }),
    node({ number: 4, track: '' }),
  ]), {});

  assert.equal(model.ok, true);
  assert.deepEqual(model.value.counts, { ok: true, nodes: 4, tracked: 2, undeclared: 2 });
  assert.equal(model.value.counts.tracked + model.value.counts.undeclared, model.value.counts.nodes,
    'every node is on exactly one side of the split — the design shows both numbers beside the total');
});

test('#1059 region 01: an unreadable graph costs the header its counts and nothing else', () => {
  const model = buildHeaderModel({ ok: false, reason: 'the forge would not answer' }, { servedBranch: { ok: true, branch: 'main', source: { path: 'HEAD' } } });

  assert.equal(model.ok, true, 'the header still draws — a section that could not be read is not the whole bar');
  assert.equal(model.value.counts.ok, false);
  assert.equal(model.value.counts.reason, 'the forge would not answer');
  assert.equal(model.value.servedBranch.branch, 'main', 'the branch is still named');
});

test('#1059 region 01: the served branch carries its own source, and its refusal when it has one', () => {
  const named = buildHeaderModel(graph([]), { servedBranch: { ok: true, branch: 'feature/x', source: { path: 'HEAD' } } });
  assert.equal(named.value.servedBranch.branch, 'feature/x');
  assert.deepEqual(named.value.servedBranch.sourceStamp, { label: '[repo: HEAD]', href: null, kind: 'repo' });

  const detached = buildHeaderModel(graph([]), { servedBranch: { ok: false, reason: 'HEAD is detached' } });
  assert.equal(detached.value.servedBranch.branch, null);
  assert.equal(detached.value.servedBranch.reason, 'HEAD is detached');
});

test('#1059 region 01: the epic this branch serves is stated as unresolved, never guessed from the branch name', () => {
  const model = buildHeaderModel(graph([node({ track: 'UI' })]), { servedBranch: { ok: true, branch: 'feature/issue-1059-design-structure', source: { path: 'HEAD' } } });

  assert.equal(model.value.epic.ok, false, 'an epic is declared, not parsed out of a branch name');
  assert.equal(model.value.epic.reason, EPIC_JOIN_PENDING);
  assert.ok(/tracker/.test(model.value.epic.reason), 'the reason names what the join would read');
});

test('#1059 region 01: no meta at all still draws a header', () => {
  const model = buildHeaderModel(graph([node({})]));
  assert.equal(model.ok, true);
  assert.equal(model.value.servedBranch.branch, null);
  assert.equal(model.value.counts.nodes, 1);
});
