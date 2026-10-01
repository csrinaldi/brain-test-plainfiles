// anti-patterns-model.test.mjs — R882-4: the anti-pattern catalogue, grouped
// by scope (core before project), sorted by id within each scope. An
// unreadable entry is kept in place, sorted last within its own scope
// (rule zero, mirrors decisions-model.mjs's unreadable-ADR handling). An
// unlistable scope is its own said reason beside the other scope's real
// rows, never a silently empty section.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAntiPatternsModel } from './anti-patterns-model.mjs';
import { sourceLabel, sourceStamp } from './provenance.mjs';

const entry = (over = {}) => ({
  ok: true,
  id: 'example-anti-pattern',
  title: 'An example anti-pattern',
  scope: 'core',
  path: 'brain/core/anti-patterns/example-anti-pattern.md',
  issues: [94],
  ...over,
});

const section = (over = {}) => ({ ok: true, value: { entries: [], unlistable: [], ...over } });

test('#882 R882-4: no anti-patterns section given is a stated reason, never an empty catalogue', () => {
  const model = buildAntiPatternsModel(undefined);
  assert.equal(model.ok, false);
  assert.match(model.reason, /no anti-patterns section/);
});

test('#882 R882-4: the whole section unreadable is the model\'s own reason, unchanged', () => {
  const model = buildAntiPatternsModel({ ok: false, reason: 'brain/core/anti-patterns could not be listed: EACCES' });
  assert.deepEqual(model, { ok: false, reason: 'brain/core/anti-patterns could not be listed: EACCES' });
});

test('#882 R882-4: an entry\'s row names every issue it cites, deduplicated and sorted', () => {
  // #94 and ISSUE-94 both parse to the same number; a duplicate that
  // reaches the model (whatever its source) must still collapse to one.
  const model = buildAntiPatternsModel(section({ entries: [entry({ issues: [94, 12, 94] })] }));
  assert.equal(model.ok, true);
  assert.deepEqual(model.value.rows[0].issues, [12, 94]);
});

test('#882 R882-4: a readable entry\'s row carries its own sourceStamp, through governance-model.mjs\'s row() helper', () => {
  const e = entry();
  const model = buildAntiPatternsModel(section({ entries: [e] }));
  const row = model.value.rows[0];
  assert.equal(row.id, e.id);
  assert.equal(row.title, e.title);
  assert.equal(row.scope, e.scope);
  assert.equal(row.source, sourceLabel({ path: e.path }));
  assert.deepEqual(row.sourceStamp, sourceStamp({ path: e.path }));
});

test('#882 R882-4: an unreadable entry is kept as its own row, sorted last within its scope — no id to sort by', () => {
  const readable = entry({ id: 'aaa-first', scope: 'core' });
  const unreadable = { ok: false, path: 'brain/core/anti-patterns/broken.md', scope: 'core', reason: 'no `# Title` line' };
  const model = buildAntiPatternsModel(section({ entries: [unreadable, readable] }));
  assert.equal(model.ok, true);
  assert.deepEqual(model.value.rows.map((r) => r.id ?? null), ['aaa-first', null]);
  const badRow = model.value.rows[1];
  assert.equal(badRow.ok, false);
  assert.equal(badRow.path, unreadable.path);
  assert.equal(badRow.scope, unreadable.scope);
  assert.equal(badRow.reason, unreadable.reason);
});

test('#882 R882-4: rows group core before project (ANTI_PATTERN_DIRS\' declared order), regardless of input order', () => {
  const projectEntry = entry({ id: 'zzz-project', scope: 'project', path: 'brain/project/anti-patterns/zzz-project.md' });
  const coreEntry = entry({ id: 'aaa-core', scope: 'core', path: 'brain/core/anti-patterns/aaa-core.md' });
  const model = buildAntiPatternsModel(section({ entries: [projectEntry, coreEntry] }));
  assert.deepEqual(model.value.rows.map((r) => r.scope), ['core', 'project']);
});

test('#882 R882-4: rows sort by id within each scope', () => {
  const c1 = entry({ id: 'zzz', scope: 'core', path: 'brain/core/anti-patterns/zzz.md' });
  const c2 = entry({ id: 'aaa', scope: 'core', path: 'brain/core/anti-patterns/aaa.md' });
  const model = buildAntiPatternsModel(section({ entries: [c1, c2] }));
  assert.deepEqual(model.value.rows.map((r) => r.id), ['aaa', 'zzz']);
});

test('#882 R882-4: an unlistable scope is said beside the other scope\'s real rows, never a silently empty section', () => {
  const coreEntry = entry({ scope: 'core' });
  const unlistable = [{ scope: 'project', dir: 'brain/project/anti-patterns', reason: 'brain/project/anti-patterns could not be listed: ENOENT' }];
  const model = buildAntiPatternsModel(section({ entries: [coreEntry], unlistable }));
  assert.equal(model.ok, true);
  assert.deepEqual(model.value.unlistable, unlistable);
  assert.equal(model.value.rows.length, 1, 'the core scope\'s real row is still present, not blanked by the project scope\'s unlistable state');
});

// #882 PR 3 merge onto the tracker: `forge-url.mjs` exists now (PR 1), so a
// cited ticket becomes a real link instead of a hand-built `[forge: #N]`
// string — the same builder the roadmap rows use, never a second copy.
test('a cited ticket carries a real forge stamp when the served project is known, and today\'s bare text when it is not', () => {
  const section = { ok: true, value: { entries: [{ ok: true, scope: 'core', id: 'evidence-reader', title: 'Evidence reader empty on failure', path: 'brain/core/anti-patterns/evidence-reader.md', issues: [94, 12] }], unlistable: [] } };

  const withProject = buildAntiPatternsModel(section, { project: 'csrinaldi/brain' });
  const [row] = withProject.value.rows;
  assert.deepEqual(row.issueStamps.map((s) => s.label), ['[forge: #12]', '[forge: #94]']);
  assert.equal(row.issueStamps[0].href, 'https://github.com/csrinaldi/brain/issues/12', 'a known project makes the citation clickable');

  const without = buildAntiPatternsModel(section);
  const [bare] = without.value.rows;
  assert.deepEqual(bare.issueStamps.map((s) => s.label), ['[forge: #12]', '[forge: #94]'], 'the bare form keeps the same words');
  assert.equal(bare.issueStamps[0].href, null, 'with no project there is no link to claim');
});
