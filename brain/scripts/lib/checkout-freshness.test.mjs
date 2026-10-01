// checkout-freshness.test.mjs — issue #787.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateFreshness } from './checkout-freshness.mjs';

const SHAS = { headSha: '3c40c32', baseSha: 'e55fcf1' };

test('behind, and the verb changed: STALE', () => {
  // The measured case. 2026-08-28: `main` was at 3c40c32 while `origin/main`
  // was at e55fcf1 — two merges, one of which was #784, the commit that made
  // the worktree the default. The run created an in-place branch and said
  // "Updating main..." on the way.
  const r = evaluateFreshness({ ...SHAS, scriptsDiffer: true, headIsAncestor: true });
  assert.equal(r.stale, true);
  assert.equal(r.headSha, '3c40c32');
  assert.equal(r.baseSha, 'e55fcf1');
});

test('behind, but nothing under brain/scripts changed: FRESH', () => {
  // A docs-only gap cannot change what the verb does. Firing on it would train
  // the operator to scroll past the warning, which costs the warning.
  const r = evaluateFreshness({ ...SHAS, scriptsDiffer: false, headIsAncestor: true });
  assert.equal(r.stale, false);
});

test('the checkout is not an ancestor: FRESH, even though the code differs', () => {
  // Diverged or ahead — which is what developing the verb itself looks like.
  // "Your code differs from origin" is true there and is not a defect, so the
  // check must not nag. This is also acceptance 5: nothing here assumes the
  // checkout is on the default branch.
  const r = evaluateFreshness({ ...SHAS, scriptsDiffer: true, headIsAncestor: false });
  assert.equal(r.stale, false);
});

test('identical SHAs: FRESH, whatever the other facts say', () => {
  const r = evaluateFreshness({
    headSha: 'e55fcf1', baseSha: 'e55fcf1', scriptsDiffer: true, headIsAncestor: true,
  });
  assert.equal(r.stale, false, 'a checkout at the base cannot be behind it');
});

test('an unreadable fact is FRESH, never stale', () => {
  // FAIL-OPEN, and it is the opposite of the rest of this repo on purpose. This
  // is a warning about the operator's checkout, not a governance gate: a probe
  // that cannot reach a verdict must not block task start, and must not invent a
  // refusal for a fact it never measured.
  for (const missing of [
    { headSha: null, baseSha: 'e55fcf1', scriptsDiffer: true, headIsAncestor: true },
    { headSha: '3c40c32', baseSha: null, scriptsDiffer: true, headIsAncestor: true },
    { ...SHAS, scriptsDiffer: null, headIsAncestor: true },
    { ...SHAS, scriptsDiffer: true, headIsAncestor: null },
  ]) {
    assert.equal(evaluateFreshness(missing).stale, false, JSON.stringify(missing));
  }
});

test('it is pure — no defaults invented for absent input', () => {
  assert.equal(evaluateFreshness({}).stale, false);
  assert.equal(evaluateFreshness().stale, false);
});
