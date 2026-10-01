// branch-type.test.mjs — unit tests for deriveBranchType (#101).
//
// Regression guard: the repo uses `type:*` labels, so the derivation must strip
// the `type:` prefix. Before the fix, every ticket fell back to `feat/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveBranchType, findTypeLabel } from './branch-type.mjs';

// ── The bug this fixes: namespaced type: labels must map ─────────────────────
const NAMESPACED = [
  ['type:bug', 'fix'],
  ['type:feature', 'feat'],
  ['type:chore', 'chore'],
  ['type:docs', 'docs'],
  ['type:refactor', 'refactor'],
];

for (const [label, expected] of NAMESPACED) {
  test(`deriveBranchType: ${label} → ${expected}`, () => {
    assert.equal(deriveBranchType([label]), expected);
  });
}

// ── Bare labels still work (backward compatible) ─────────────────────────────
test('deriveBranchType: bare bug → fix', () => {
  assert.equal(deriveBranchType(['bug']), 'fix');
});

test('deriveBranchType: bare feature → feat', () => {
  assert.equal(deriveBranchType(['feature']), 'feat');
});

// ── Non-type labels are ignored; first mapping label wins ────────────────────
test('deriveBranchType: ignores non-type labels and picks the type label', () => {
  assert.equal(deriveBranchType(['status:approved', 'good first issue', 'type:bug']), 'fix');
});

test('deriveBranchType: first mapping label wins', () => {
  assert.equal(deriveBranchType(['type:docs', 'type:bug']), 'docs');
});

// ── Fallbacks ────────────────────────────────────────────────────────────────
test('deriveBranchType: no mapping label → feat', () => {
  assert.equal(deriveBranchType(['status:approved', 'good first issue']), 'feat');
});

test('deriveBranchType: empty / missing labels → feat', () => {
  assert.equal(deriveBranchType([]), 'feat');
  assert.equal(deriveBranchType(undefined), 'feat');
});

test('deriveBranchType: case-insensitive', () => {
  assert.equal(deriveBranchType(['TYPE:BUG']), 'fix');
});

// ── GitLab's `::` scoped-label form (issue #334 A3) ──────────────────────────
// Regression guard: `deriveBranchType` used to strip only `/^type:/`, so
// GitLab's `type::bug` yielded `:bug` (leading colon retained) — no LABEL_TYPE
// entry matches a leading colon, so every GitLab-sourced type label silently
// fell back to `feat`. Widened to `/^type::?/`.
test('deriveBranchType: GitLab scoped type::bug → fix (was silently feat before the #334 fix)', () => {
  assert.equal(deriveBranchType(['type::bug']), 'fix');
});

test('deriveBranchType: GitLab scoped type::feature → feat', () => {
  assert.equal(deriveBranchType(['type::feature']), 'feat');
});

// ── findTypeLabel (issue #334, ship-pr-label-resolution) ─────────────────────
test('findTypeLabel: returns the first type:* label verbatim, unmodified', () => {
  assert.equal(findTypeLabel(['status:approved', 'type:bug']), 'type:bug');
});

test('findTypeLabel: matches GitLab\'s scoped type:: form verbatim', () => {
  assert.equal(findTypeLabel(['status::approved', 'type::bug']), 'type::bug');
});

test('findTypeLabel: preserves original case — no case-folding (label travels verbatim to the write)', () => {
  assert.equal(findTypeLabel(['TYPE:BUG']), 'TYPE:BUG');
});

test('findTypeLabel: no type:* label present → undefined', () => {
  assert.equal(findTypeLabel(['status:approved', 'good first issue']), undefined);
});

test('findTypeLabel: empty / missing labels → undefined', () => {
  assert.equal(findTypeLabel([]), undefined);
  assert.equal(findTypeLabel(undefined), undefined);
});

test('findTypeLabel: first mapping label wins when multiple type:* labels are present', () => {
  assert.equal(findTypeLabel(['type:docs', 'type:bug']), 'type:docs');
});
