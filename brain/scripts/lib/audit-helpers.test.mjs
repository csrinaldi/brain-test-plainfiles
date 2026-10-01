// audit-helpers.test.mjs — Unit tests for brain-audit pure helpers.
// Run with: npm test  (node --test, no git or VCS required)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parsePrNumber, shouldSkipSize, isAfterBaseline, selectIssueLinkBody, chunkObservations, auditedTip } from './audit-helpers.mjs';
import { issueLink } from '../governance/checks/issue-link.mjs';

// ── parsePrNumber ─────────────────────────────────────────────────────────────

test('parsePrNumber: GitHub auto-merge subject extracts number', () => {
  assert.equal(parsePrNumber('Merge pull request #42 from user/branch'), 42);
});

test('parsePrNumber: GitHub auto-merge subject case-insensitive', () => {
  assert.equal(parsePrNumber('merge pull request #7 from other/branch'), 7);
});

test('parsePrNumber: trailing "(#N)" notation extracts number', () => {
  assert.equal(parsePrNumber('feat: add something (#7)'), 7);
});

test('parsePrNumber: trailing "(#N)" with trailing whitespace', () => {
  assert.equal(parsePrNumber('chore: bump version (#123)  '), 123);
});

test('parsePrNumber: no PR number returns null', () => {
  assert.equal(parsePrNumber('chore: no pr reference here'), null);
});

test('parsePrNumber: non-string null returns null', () => {
  assert.equal(parsePrNumber(null), null);
});

test('parsePrNumber: non-string undefined returns null', () => {
  assert.equal(parsePrNumber(undefined), null);
});

// ── shouldSkipSize ────────────────────────────────────────────────────────────

test('shouldSkipSize: size:exception present → true', () => {
  assert.equal(shouldSkipSize(['size:exception', 'kind:feature']), true);
});

test('shouldSkipSize: size:exception is the only label → true', () => {
  assert.equal(shouldSkipSize(['size:exception']), true);
});

test('shouldSkipSize: labels without size:exception → false', () => {
  assert.equal(shouldSkipSize(['kind:feature', 'status:approved']), false);
});

test('shouldSkipSize: empty labels array → false', () => {
  assert.equal(shouldSkipSize([]), false);
});

test('shouldSkipSize: null input → false (graceful)', () => {
  assert.equal(shouldSkipSize(null), false);
});

test('shouldSkipSize: undefined input → false (graceful)', () => {
  assert.equal(shouldSkipSize(undefined), false);
});

// ── isAfterBaseline ───────────────────────────────────────────────────────────

test('isAfterBaseline: returns true when isAncestorFn returns true', () => {
  assert.equal(isAfterBaseline('v1.0.0', 'abc123', () => true), true);
});

test('isAfterBaseline: returns false when isAncestorFn returns false', () => {
  assert.equal(isAfterBaseline('v1.0.0', 'abc123', () => false), false);
});

test('isAfterBaseline: forwards baseline and sha to isAncestorFn', () => {
  let called = null;
  isAfterBaseline('v2.0.0', 'deadbeef', (b, s) => { called = { b, s }; return true; });
  assert.deepEqual(called, { b: 'v2.0.0', s: 'deadbeef' });
});

// ── selectIssueLinkBody ───────────────────────────────────────────────────────

test('selectIssueLinkBody: non-empty prBody → uses prBody', () => {
  const result = selectIssueLinkBody('Closes #5', 'Merge pull request #42 from feat/something');
  assert.equal(result, 'Closes #5');
});

test('selectIssueLinkBody: empty string prBody → falls back to commitBody', () => {
  const result = selectIssueLinkBody('', 'feat: something Closes #3');
  assert.equal(result, 'feat: something Closes #3');
});

test('selectIssueLinkBody: whitespace-only prBody → falls back to commitBody', () => {
  const result = selectIssueLinkBody('   ', 'feat: something Closes #3');
  assert.equal(result, 'feat: something Closes #3');
});

test('selectIssueLinkBody: non-string prBody → falls back to commitBody', () => {
  const result = selectIssueLinkBody(null, 'feat: fallback Closes #1');
  assert.equal(result, 'feat: fallback Closes #1');
});

// ── selectIssueLinkBody + issueLink integration (no git or VCS) ──────────────
//
// These tests prove the full decision path: PR body has the reference but the
// merge commit body does not (the real-world GitHub case where merge commit
// bodies are "Merge pull request #N from branch").

test('issueLink passes when PR body has "Closes #5", merge commit body has none', () => {
  const body = selectIssueLinkBody('This PR Closes #5', 'Merge pull request #42 from feat/something');
  assert.deepEqual(issueLink(body), { pass: true });
});

test('issueLink passes when PR body has "Part of #5", merge commit body has none', () => {
  const body = selectIssueLinkBody('Part of #5', 'Merge pull request #42 from feat/something');
  assert.deepEqual(issueLink(body), { pass: true });
});

test('issueLink falls back to commit body when PR body is empty and commit body has reference', () => {
  const body = selectIssueLinkBody('', 'chore: finalize Closes #3');
  assert.deepEqual(issueLink(body), { pass: true });
});

test('issueLink fails when both PR body and commit body have no reference', () => {
  const body = selectIssueLinkBody('', 'Merge pull request #42 from feat/something');
  assert.equal(issueLink(body).pass, false);
});

// ── chunkObservations ─────────────────────────────────────────────────────────

test('chunkObservations: valid chunk with observations array → returns array', () => {
  const obs = [{ id: 1, type: 'session_summary' }, { id: 2, type: 'decision' }];
  assert.deepEqual(chunkObservations({ sessions: [], observations: obs }), obs);
});

test('chunkObservations: missing observations key → returns []', () => {
  assert.deepEqual(chunkObservations({ sessions: [] }), []);
});

test('chunkObservations: observations is not an array → returns []', () => {
  assert.deepEqual(chunkObservations({ observations: 'not-an-array' }), []);
});

test('chunkObservations: null input → returns []', () => {
  assert.deepEqual(chunkObservations(null), []);
});

test('chunkObservations: undefined input → returns []', () => {
  assert.deepEqual(chunkObservations(undefined), []);
});

test('chunkObservations: empty object → returns []', () => {
  assert.deepEqual(chunkObservations({}), []);
});

// ── auditedTip (MINOR 1, ruling rev 3 on #297) ────────────────────────────────
// The net-parity skips anchor liveness at a TIP. Hardcoding `'HEAD'` while
// `resolveRange` accepts an arbitrary range makes "resolved at HEAD" decide an
// audit of a NON-HEAD tip — an offender already reverted somewhere past the
// audited tip would be exempted out of a window that never contained the revert.
// `auditedTip` turns design §2.2's unenforced "the window ends at the tip"
// precondition into code.

test('auditedTip: a two-dot range anchors at its right-hand side', () => {
  assert.equal(auditedTip('origin/main..HEAD'), 'HEAD');
  assert.equal(auditedTip('v1.0.0..release-2'), 'release-2');
});

test('auditedTip: a bare revision IS the tip (the `HEAD` / single-ref form)', () => {
  assert.equal(auditedTip('HEAD'), 'HEAD');
  assert.equal(auditedTip('feature/v2.0.0'), 'feature/v2.0.0');
});

test('auditedTip: an omitted right-hand side means HEAD, exactly as git reads `A..`', () => {
  assert.equal(auditedTip('origin/main..'), 'HEAD');
});

test('auditedTip: an omitted left-hand side still anchors at the right-hand side', () => {
  assert.equal(auditedTip('..release-2'), 'release-2');
});

test('auditedTip: a three-dot range anchors at its right-hand side, never on the dots', () => {
  // `A...B` is git's symmetric difference; the audited tip is still B. The
  // two-dot split MUST NOT run first and yield a stray leading '.' from 'A...B'.
  assert.equal(auditedTip('origin/main...HEAD'), 'HEAD');
  assert.equal(auditedTip('main...release-2'), 'release-2');
});

test('auditedTip: surrounding whitespace never becomes part of the ref', () => {
  assert.equal(auditedTip('  origin/main..HEAD  '), 'HEAD');
});
