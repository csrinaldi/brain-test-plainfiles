// issue-link.test.mjs — Unit tests for issueLink check (REQ-S4-1)
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { issueLink } from './issue-link.mjs';

test('issueLink: body with "Closes #42" → pass', () => {
  assert.deepEqual(issueLink('feat: something\n\nCloses #42'), { pass: true });
});

test('issueLink: body with no issue reference → fail with reason', () => {
  const r = issueLink('Some PR description without any link');
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
});

test('issueLink: case-insensitive "FIXES #7" → pass', () => {
  assert.deepEqual(issueLink('FIXES #7'), { pass: true });
});

// ── Part of #N — chained-PR slice references ──────────────────────────────────

test('issueLink: "Part of #5" in subject → pass', () => {
  assert.deepEqual(issueLink('Part of #5'), { pass: true });
});

test('issueLink: "Part of #5" in multi-line body → pass', () => {
  assert.deepEqual(issueLink('feat: add slice\n\nPart of #5'), { pass: true });
});

test('issueLink: "part of #5" lowercase → pass (case-insensitive)', () => {
  assert.deepEqual(issueLink('part of #5'), { pass: true });
});

test('issueLink: body with no issue reference → fail, reason mentions Part of #N', () => {
  const r = issueLink('Some PR description without any link');
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('Part of'), `reason must mention "Part of", got: ${r.reason}`);
});

// ── 9-form closing-keyword vocabulary (issue #231 CP-A2a review, finding M1)
// — issueLink() was NARROW (closes|fixes|resolves only, 3 of 9 GitHub-
// documented forms); widened to match GitHub bash + actor-check.mjs's
// existing BROAD vocabulary: close, closes, closed, fix, fixes, fixed,
// resolve, resolves, resolved.

test('issueLink: "Fixed #42" (past-tense form) → pass (M1 widen)', () => {
  assert.deepEqual(issueLink('Fixed #42'), { pass: true });
});

test('issueLink: "Close #10" (bare present-tense form) → pass (M1 widen)', () => {
  assert.deepEqual(issueLink('Close #10'), { pass: true });
});

test('issueLink: "Closed #3" (past-tense form) → pass (M1 widen)', () => {
  assert.deepEqual(issueLink('Closed #3'), { pass: true });
});

test('issueLink: "Resolved #5" (past-tense form) → pass (M1 widen)', () => {
  assert.deepEqual(issueLink('Resolved #5'), { pass: true });
});

test('issueLink: "resolve #8" (bare present-tense form) → pass (M1 widen)', () => {
  assert.deepEqual(issueLink('resolve #8'), { pass: true });
});
