// provenance.test.mjs — A3, a PROPERTY test, not a screenshot (D11): for a
// fixture change, every object `spec-cards.mjs`, `tasks-list.mjs`,
// `resume-view.mjs` and — since PR 3's follow-up run — `change-route.mjs`'s
// composed view emit carries a non-empty `source.path` or `source.url`. No
// DOM, no browser. `blame.mjs` itself emits raw per-line attribution, not a
// drawer-visible object; its data is consumed BY `tasks-list.mjs` (directly)
// and BY `change-route.mjs`'s per-row `attribution` leaf (below), so it
// needs no separate provenance assertion of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecCards } from './spec-cards.mjs';
import { parseTasksList } from './tasks-list.mjs';
import { parseBlame } from './blame.mjs';
import { shapeResumeView } from './resume-view.mjs';
import { buildChangeView } from '../change-route.mjs';
import { fakeGit } from '../test-support/fake-git.mjs';

const SPEC_PATH = 'openspec/changes/issue-881-ui-server-canvas/spec.md';
const TASKS_PATH = 'openspec/changes/issue-881-ui-server-canvas/tasks.md';
const BRANCH = 'feat/issue-881-slice-3-lib';

function hasSource(obj) {
  const src = obj.source;
  if (!src || typeof src !== 'object') return false;
  return (typeof src.path === 'string' && src.path.length > 0) || (typeof src.url === 'string' && src.url.length > 0);
}

function walkAndCheck(obj, assertPath) {
  assert.ok(hasSource(obj), `${assertPath}: no non-empty source.path or source.url — ${JSON.stringify(obj)}`);
}

test('#881: every spec-cards.mjs card and scenario carries a non-empty source', () => {
  const specText = [
    '### R881-6: every open issue is a node, coloured by its computed state',
    '#### Scenario: no node is filtered away',
    '- **WHEN** the graph has 90 open issues',
    '- **THEN** the canvas renders 90 nodes',
    '### R881-7: the layout is deterministic and cycle-tolerant',
    '#### Scenario: a cycle does not crash or hide nodes',
    '- **WHEN** the edge set contains a cycle',
    '- **THEN** the layout returns a coordinate for every node',
  ].join('\n');
  const { ok, value: cards } = parseSpecCards({ text: specText, path: SPEC_PATH });
  assert.equal(ok, true);
  assert.ok(cards.length > 0);
  for (const card of cards) {
    walkAndCheck(card, `card ${card.id}`);
    for (const scenario of card.scenarios) walkAndCheck(scenario, `card ${card.id} scenario "${scenario.name}"`);
  }
});

test('#881: every tasks-list.mjs item carries a non-empty source, with or without blame attribution', () => {
  const tasksText = ['## Phase 1', '- [x] ship layout.mjs', '- [ ] ship change-route.mjs'].join('\n');
  const blame = parseBlame({
    text: [
      'abc1234abc1234abc1234abc1234abc1234abc1 1 2 1',
      'author csrinaldi',
      'author-mail <c@example.com>',
      'author-time 1694700000',
      'author-tz +0000',
      'committer csrinaldi',
      'committer-mail <c@example.com>',
      'committer-time 1694700000',
      'committer-tz +0000',
      'summary ship layout.mjs',
      'filename tasks.md',
      '\t- [x] ship layout.mjs',
    ].join('\n'),
  });
  assert.equal(blame.ok, true);
  const attribution = Object.entries(blame.value).map(([line, a]) => ({ line: Number(line), actor: a.author, ts: a.authorTime }));
  const { ok, value: items } = parseTasksList({ text: tasksText, path: TASKS_PATH, attribution });
  assert.equal(ok, true);
  assert.ok(items.length > 0);
  for (const item of items) walkAndCheck(item, `task item "${item.text}"`);
});

test('#881: every resume-view.mjs field carries a non-empty source, including a field that failed to shape', () => {
  const result = shapeResumeView({ frontmatter: { current_slice: 3, blockers: [] }, branch: BRANCH }); // next_action deliberately missing
  for (const [key, field] of Object.entries(result)) walkAndCheck(field, `resume field "${key}"`);
});

test('#881: change-route.mjs\'s composed view — every Spec/Tasks/Working-memory/Reviews leaf carries a non-empty source', () => {
  const changeDir = 'openspec/changes/issue-881-ui-server-canvas';
  const snapshot = {
    changes: { ok: true, value: [{ id: 'issue-881-ui-server-canvas', issue: 881, slug: 'ui-server-canvas', dir: changeDir }] },
    prs: { ok: true, value: [{ number: 957, title: 'x', headBranch: BRANCH, issue: 881 }] },
    reviews: {
      ok: true,
      value: [{
        pr: 957,
        ok: true,
        verdicts: [{ pr: 957, head_sha: 'aaa1111', rev: 1, verdict: 'approve', author: 'reviewer-a', findings: 0, malformed: [] }],
        latest: null,
      }],
    },
  };
  const run = fakeGit({
    files: {
      [`${changeDir}/spec.md`]: [
        '### R881-8: the inspector drawer, four tabs, every value sourced',
        '#### Scenario: full drawer for a change with a spec and tasks',
        "- **WHEN** a node's issue has a change dir",
        '- **THEN** the Spec tab shows its cards',
      ].join('\n'),
      [`${changeDir}/tasks.md`]: '- [x] ship it\n',
    },
    branches: { [BRANCH]: { commit: 'f'.repeat(40), files: { 'resume.md': '---\nnext_action: ship it\ncurrent_slice: 3\nblockers:\n---\n' } } },
    blame: [
      'abc1234abc1234abc1234abc1234abc1234abc1 1 1 1',
      'author csrinaldi',
      'author-mail <c@example.com>',
      'author-time 1694700000',
      'author-tz +0000',
      'committer csrinaldi',
      'committer-mail <c@example.com>',
      'committer-time 1694700000',
      'committer-tz +0000',
      'summary ship it',
      'filename tasks.md',
      '\t- [x] ship it',
    ].join('\n'),
  });

  const result = buildChangeView({ issue: 881, snapshot, project: 'o/r', _run: run });
  assert.equal(result.ok, true);
  assert.equal(result.value.spec.ok, true);
  assert.equal(result.value.tasks.ok, true);
  assert.equal(result.value.workingMemory.ok, true);
  assert.equal(result.value.reviews.ok, true);

  for (const card of result.value.spec.value) {
    walkAndCheck(card, `change-route spec card ${card.id}`);
    for (const scenario of card.scenarios) walkAndCheck(scenario, `change-route spec card ${card.id} scenario "${scenario.name}"`);
  }
  for (const item of result.value.tasks.value) walkAndCheck(item, `change-route task item "${item.text}"`);
  for (const [key, field] of Object.entries(result.value.workingMemory.value)) walkAndCheck(field, `change-route working-memory field "${key}"`);
  for (const round of result.value.reviews.value) walkAndCheck(round, `change-route review round rev=${round.rev}`);
  for (const u of result.value.reviews.unreadable ?? []) walkAndCheck(u, `change-route unreadable review thread pr=${u.pr}`);
});

test('#881: change-route.mjs\'s "no change dir" leaves still carry a non-empty source, naming the expected glob', () => {
  const snapshot = {
    changes: { ok: true, value: [] },
    prs: { ok: true, value: [] },
    reviews: { ok: true, value: [] },
  };
  const result = buildChangeView({ root: '/does-not-matter', issue: 881, snapshot, _run: () => '' });
  assert.equal(result.ok, true);
  walkAndCheck(result.value.spec, 'change-route spec (no change dir)');
  walkAndCheck(result.value.tasks, 'change-route tasks (no change dir)');
});

// ── #998 R998-1: sourceLabel moved here, and the design's stamp forms ────────

import { sourceLabel, sourceStamp } from './provenance.mjs';

test('#998: sourceLabel keeps the plain forms the current page shows', () => {
  assert.equal(sourceLabel({ path: 'a/b.md', line: 42 }), 'a/b.md:42');
  assert.equal(sourceLabel({ path: 'a/b.md' }), 'a/b.md');
  assert.equal(sourceLabel({ url: 'https://github.com/o/r/pull/971' }), 'https://github.com/o/r/pull/971');
  assert.equal(sourceLabel({}), 'no source was recorded for this value');
});

test('#998: sourceStamp renders the design\'s stamps — [repo: path:line], [forge: #n] with the URL kept, [git: sha7] — and never an empty label', () => {
  assert.deepEqual(sourceStamp({ path: 'a/b.md', line: 42 }), { label: '[repo: a/b.md:42]', href: null, kind: 'repo' });
  assert.deepEqual(sourceStamp({ path: 'a/b.md' }), { label: '[repo: a/b.md]', href: null, kind: 'repo' });
  assert.deepEqual(sourceStamp({ url: 'https://github.com/o/r/issues/881' }), { label: '[forge: #881]', href: 'https://github.com/o/r/issues/881', kind: 'forge' });
  assert.deepEqual(sourceStamp({ url: 'https://github.com/o/r/pull/971#issuecomment-5' }), { label: '[forge: #971]', href: 'https://github.com/o/r/pull/971#issuecomment-5', kind: 'forge' });
  assert.deepEqual(sourceStamp({ url: 'https://example.com/x' }), { label: '[link: https://example.com/x]', href: 'https://example.com/x', kind: 'link' }, 'a URL that is not a forge issue or PR is still shown, as a link');
  assert.deepEqual(sourceStamp({ sha: '4f9a2e1c9d' }), { label: '[git: 4f9a2e1]', href: null, kind: 'git' });
  assert.deepEqual(sourceStamp({}), { label: '[no source was recorded for this value]', href: null, kind: 'none' });
  assert.deepEqual(sourceStamp({ url: 'javascript:alert(1)' }).href, null, 'only https forge links become hrefs');
});
