// ticket-type.test.mjs — issue #1206. `brain:ticket:start` refuses an issue with no
// type:* label BEFORE any branch or worktree exists, using the SAME `findTypeLabel`
// `brain:ship` uses. One rule, one implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { requireTypeLabel } from './ticket-type.mjs';
import { findTypeLabel } from './branch-type.mjs';

test('#1206 an issue with no type label is refused, naming the issue', () => {
  const r = requireTypeLabel({ issue: { number: 7, labels: ['status:approved'] } });
  assert.equal(r.ok, false);
  assert.equal(r.refusal.key, 'ticket.error.noTypeLabel');
  assert.equal(r.refusal.params.id, 7);
  assert.equal(r.refusal.params.labels, 'status:approved');
});

test('#1206 an issue with no labels at all is refused', () => {
  assert.equal(requireTypeLabel({ issue: { number: 7 } }).ok, false);
  assert.equal(requireTypeLabel({ issue: { number: 7, labels: [] } }).ok, false);
});

test('#1206 GitHub type:bug and GitLab scoped type::bug both pass, label verbatim', () => {
  for (const l of ['type:bug', 'type::bug']) {
    const r = requireTypeLabel({ issue: { number: 1, labels: ['status:approved', l] } });
    assert.deepEqual(r, { ok: true, label: l });
  }
});

test('#1206 the verdict is findTypeLabel\'s — no second implementation', () => {
  const src = readFileSync(fileURLToPath(new URL('./ticket-type.mjs', import.meta.url)), 'utf8');
  assert.match(src, /findTypeLabel/);
  assert.ok(!/TYPE_PREFIX|\/\^type/.test(src), 'the type: vocabulary lives only in branch-type.mjs');
  const labels = ['x', 'type:docs'];
  assert.equal(requireTypeLabel({ issue: { number: 1, labels } }).label, findTypeLabel(labels));
});

test('#1206 ticket-start.mjs runs the check before resolveBase and any git work', () => {
  const src = readFileSync(fileURLToPath(new URL('../ticket-start.mjs', import.meta.url)), 'utf8');
  const at = src.indexOf('requireTypeLabel(');
  assert.ok(at > 0, 'ticket-start must call requireTypeLabel');
  assert.ok(at < src.indexOf('await resolveBase('), 'refuse before reading the epic');
  assert.ok(at < src.indexOf("'worktree', 'add'") || at < src.indexOf('worktreeAddArgs({'), 'refuse before any worktree');
  assert.ok(at < src.indexOf('inPlaceCheckoutArgs({'), 'refuse before any checkout');
});
