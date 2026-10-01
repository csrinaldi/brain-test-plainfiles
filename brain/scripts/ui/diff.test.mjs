import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffSections } from './diff.mjs';

// ── Q5: section-level, `generatedAt`/`tier` excluded ────────────────────────

test('#881: an unchanged snapshot yields no changed sections — generatedAt alone differs, and it is excluded', () => {
  const a = { generatedAt: '2026-09-14T00:00:00Z', tier: 'committed', graph: { ok: true, value: 1 }, changes: { ok: true, value: [] } };
  const b = { generatedAt: '2026-09-14T00:00:05Z', tier: 'committed', graph: { ok: true, value: 1 }, changes: { ok: true, value: [] } };
  assert.deepEqual(diffSections(a, b), []);
});

test('#881: a changed section is returned in full, an unchanged sibling section is not reported', () => {
  const a = { generatedAt: 't0', tier: 'committed', graph: { ok: true, value: { nodes: [1] } }, changes: { ok: true, value: [] } };
  const b = { generatedAt: 't1', tier: 'committed', graph: { ok: true, value: { nodes: [1, 2] } }, changes: { ok: true, value: [] } };
  assert.deepEqual(diffSections(a, b), [{ name: 'graph', section: { ok: true, value: { nodes: [1, 2] } } }]);
});

test('#881: comparison is isDeepStrictEqual — a number and the same-looking string count as changed', () => {
  const a = { generatedAt: 't0', tier: 'committed', prs: { ok: true, value: 1 } };
  const b = { generatedAt: 't1', tier: 'committed', prs: { ok: true, value: '1' } };
  assert.deepEqual(diffSections(a, b), [{ name: 'prs', section: { ok: true, value: '1' } }], 'a loose (==) diff would have missed this');
});

test('#881: two sections changed in the same recompute are both reported, in top-level key order', () => {
  const a = { generatedAt: 't0', tier: 'committed', graph: { ok: true, value: 1 }, prs: { ok: true, value: 1 }, changes: { ok: true, value: [] } };
  const b = { generatedAt: 't1', tier: 'committed', graph: { ok: true, value: 2 }, prs: { ok: true, value: 2 }, changes: { ok: true, value: [] } };
  assert.deepEqual(diffSections(a, b), [
    { name: 'graph', section: { ok: true, value: 2 } },
    { name: 'prs', section: { ok: true, value: 2 } },
  ]);
});

test('#881: a section present before and absent now is reported as gone, not silently dropped (fresh review of slice 1, minor 1)', () => {
  const a = { generatedAt: 't0', tier: 'committed', graph: { ok: true, value: 1 }, prs: { ok: true, value: 1 } };
  const b = { generatedAt: 't1', tier: 'committed', graph: { ok: true, value: 1 } };
  assert.deepEqual(diffSections(a, b), [{ name: 'prs', section: null }], 'a diff that walks only the new keys would have said "nothing changed"');
});
