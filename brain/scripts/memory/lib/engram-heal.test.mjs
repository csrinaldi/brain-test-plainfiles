// engram-heal.test.mjs — the pure planning half of the engram duplicate heal
// (#1061, #864 task 1.2a). No filesystem, no engram dependency, no child
// processes — mirrors engram-export.mjs/engram-import.mjs's own contract.
//
// The three measured pairs (proposal.md:9-13) are the fixture: one import ran
// twice before the #820 guard, leaving three `rec-` keys with two live rows
// each, content/title/type identical, lower id always the keeper.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planDuplicateHeal, parseEngramVersion, isTestedVersion } from './engram-heal.mjs';

function obs({ id, topic_key, content = 'c', title = 't', type = 'decision', deleted_at }) {
  const o = { id, topic_key, content, title, type };
  if (deleted_at !== undefined) o.deleted_at = deleted_at;
  return o;
}

// ── planDuplicateHeal: grouping and keeper selection ────────────────────────

test('planDuplicateHeal: two live rows, one key — lower id wins regardless of export order', () => {
  const parsed = {
    observations: [
      obs({ id: 3092, topic_key: 'rec-35e09fc539447742' }),
      obs({ id: 3089, topic_key: 'rec-35e09fc539447742' }),
    ],
  };
  const plan = planDuplicateHeal(parsed);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.groups, [{ key: 'rec-35e09fc539447742', keep: 3089, delete: [3092] }]);
});

test('planDuplicateHeal: non-rec- keys are never reported as duplicates', () => {
  const parsed = {
    observations: [
      obs({ id: 1, topic_key: 'skill-registry' }),
      obs({ id: 2, topic_key: 'skill-registry' }),
    ],
  };
  const plan = planDuplicateHeal(parsed);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.groups, []);
});

test('planDuplicateHeal: a soft-deleted row (deleted_at set) is never a duplicate candidate', () => {
  const parsed = {
    observations: [
      obs({ id: 3089, topic_key: 'rec-35e09fc539447742' }),
      obs({ id: 3092, topic_key: 'rec-35e09fc539447742', deleted_at: '2026-09-19 00:00:00' }),
    ],
  };
  const plan = planDuplicateHeal(parsed);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.groups, [], 'only one LIVE row remains for the key — not a duplicate');
  assert.equal(plan.rows, 1);
});

test('planDuplicateHeal: observations: null gives zero groups, zero rows — the legitimately empty store', () => {
  const plan = planDuplicateHeal({ observations: null });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.groups, []);
  assert.equal(plan.rows, 0);
  assert.equal(plan.distinct, 0);
});

test('planDuplicateHeal: the three measured pairs (proposal.md) plan deletes [3092,3093,3094]', () => {
  const parsed = {
    observations: [
      obs({ id: 3089, topic_key: 'rec-35e09fc539447742', content: 'a', title: 'A', type: 'decision' }),
      obs({ id: 3092, topic_key: 'rec-35e09fc539447742', content: 'a', title: 'A', type: 'decision' }),
      obs({ id: 3090, topic_key: 'rec-4d99842973ef6c5b', content: 'b', title: 'B', type: 'decision' }),
      obs({ id: 3093, topic_key: 'rec-4d99842973ef6c5b', content: 'b', title: 'B', type: 'decision' }),
      obs({ id: 3091, topic_key: 'rec-d2ded214bc5d66c1', content: 'c', title: 'C', type: 'decision' }),
      obs({ id: 3094, topic_key: 'rec-d2ded214bc5d66c1', content: 'c', title: 'C', type: 'decision' }),
    ],
  };
  const plan = planDuplicateHeal(parsed);
  assert.equal(plan.ok, true);
  const deletes = plan.groups.flatMap((g) => g.delete).sort((a, b) => a - b);
  assert.deepEqual(deletes, [3092, 3093, 3094]);
  assert.equal(plan.rows, 6);
  assert.equal(plan.distinct, 3);
});

// ── planDuplicateHeal: refusals ──────────────────────────────────────────────

test('planDuplicateHeal: a content difference refuses divergent, naming the key and the field', () => {
  const parsed = {
    observations: [
      obs({ id: 1, topic_key: 'rec-abc', content: 'one' }),
      obs({ id: 2, topic_key: 'rec-abc', content: 'two' }),
    ],
  };
  const plan = planDuplicateHeal(parsed);
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal, 'divergent');
  assert.equal(plan.key, 'rec-abc');
  assert.deepEqual(plan.fields, ['content']);
});

test('planDuplicateHeal: a title difference refuses divergent, naming the field', () => {
  const parsed = {
    observations: [
      obs({ id: 1, topic_key: 'rec-abc', title: 'one' }),
      obs({ id: 2, topic_key: 'rec-abc', title: 'two' }),
    ],
  };
  const plan = planDuplicateHeal(parsed);
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal, 'divergent');
  assert.deepEqual(plan.fields, ['title']);
});

test('planDuplicateHeal: a type difference refuses divergent, naming the field', () => {
  const parsed = {
    observations: [
      obs({ id: 1, topic_key: 'rec-abc', type: 'decision' }),
      obs({ id: 2, topic_key: 'rec-abc', type: 'discovery' }),
    ],
  };
  const plan = planDuplicateHeal(parsed);
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal, 'divergent');
  assert.deepEqual(plan.fields, ['type']);
});

test('planDuplicateHeal: 3+ live rows sharing one key refuse tooMany, naming the key and the count', () => {
  const parsed = {
    observations: [
      obs({ id: 1, topic_key: 'rec-abc' }),
      obs({ id: 2, topic_key: 'rec-abc' }),
      obs({ id: 3, topic_key: 'rec-abc' }),
    ],
  };
  const plan = planDuplicateHeal(parsed);
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal, 'tooMany');
  assert.equal(plan.key, 'rec-abc');
  assert.equal(plan.count, 3);
});

test('planDuplicateHeal: a missing id refuses shape', () => {
  const parsed = { observations: [{ topic_key: 'rec-abc', content: 'c', title: 't', type: 'decision' }] };
  const plan = planDuplicateHeal(parsed);
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal, 'shape');
  assert.equal(plan.key, 'rec-abc');
});

test('planDuplicateHeal: a missing content/title/type refuses shape', () => {
  const parsed = { observations: [{ id: 1, topic_key: 'rec-abc', title: 't', type: 'decision' }] };
  const plan = planDuplicateHeal(parsed);
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal, 'shape');
});

test('planDuplicateHeal: observations neither array nor null refuses shape before classifying anything', () => {
  const plan = planDuplicateHeal({ observations: 'not an array' });
  assert.equal(plan.ok, false);
  assert.equal(plan.refusal, 'shape');
});

// ── parseEngramVersion / isTestedVersion ────────────────────────────────────

test('parseEngramVersion: reads the first x.y.z on stdout', () => {
  assert.deepEqual(parseEngramVersion('engram 1.20.0\n'), { major: 1, minor: 20, patch: 0 });
});

test('parseEngramVersion: unparseable output is null, never a guess', () => {
  assert.equal(parseEngramVersion('garbage, no version here'), null);
  assert.equal(parseEngramVersion(''), null);
  assert.equal(parseEngramVersion(undefined), null);
});

test('isTestedVersion: 1.20.0 is in range, 2.0.0 is not', () => {
  assert.equal(isTestedVersion(parseEngramVersion('engram 1.20.0')), true);
  assert.equal(isTestedVersion(parseEngramVersion('engram 2.0.0')), false);
  assert.equal(isTestedVersion(null), false);
});
