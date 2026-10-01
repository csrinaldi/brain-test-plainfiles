// governance-model.test.mjs — R882-1: the governance sub-nav table and the
// shared row helper every one of this ticket's view builders reuses.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GOVERNANCE_VIEWS, GOVERNANCE_VIEW_IDS, GOVERNANCE_PLACEHOLDERS, row } from './governance-model.mjs';
import { sourceLabel, sourceStamp } from './provenance.mjs';

test('#882 R882-1: GOVERNANCE_VIEWS is the five sub-view ids, in the issue body\'s order', () => {
  assert.deepEqual(GOVERNANCE_VIEW_IDS, ['roadmap', 'decisions', 'anti-patterns', 'history', 'actors', 'queue', 'slices']);
  for (const view of GOVERNANCE_VIEWS) {
    assert.equal(typeof view.id, 'string');
    assert.equal(typeof view.label, 'string');
    assert.ok(view.label.length > 0, `view "${view.id}" has no label`);
  }
});

test('#882 R882-1/PR 5: every sub-view id draws real content — GOVERNANCE_PLACEHOLDERS has nothing left unbuilt as of #882\'s last slice (By actor)', () => {
  for (const id of GOVERNANCE_VIEW_IDS) assert.equal(GOVERNANCE_PLACEHOLDERS[id], null, `sub-view "${id}" still names a placeholder`);
});

test('#882 R882-1: row() derives both source and sourceStamp from one source input, through provenance.mjs\'s own shapers — never a second provenance shaper', () => {
  const source = { path: 'brain/HOME.md', line: 12 };
  const entry = row({ title: 'a row', detail: 'some detail', source, extra: 'kept' });
  assert.equal(entry.title, 'a row');
  assert.equal(entry.detail, 'some detail');
  assert.equal(entry.source, sourceLabel(source));
  assert.deepEqual(entry.sourceStamp, sourceStamp(source));
  assert.equal(entry.extra, 'kept', 'extra fields ride through unchanged');
});

test('#882 R882-1: row() with a forge source stamps the forge form, matching provenance.mjs exactly', () => {
  const source = { url: 'https://github.com/o/r/issues/123' };
  const entry = row({ title: 'a row', detail: null, source });
  assert.equal(entry.source, source.url);
  assert.deepEqual(entry.sourceStamp, { label: '[forge: #123]', href: source.url, kind: 'forge' });
});
