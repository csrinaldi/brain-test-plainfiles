// base-branch.test.mjs — Unit tests for the base-branch pure predicate (issue #967 PR C).
// Run with: npm test
//
// Scope: the PURE PREDICATE ALONE — `baseBranchRule({issueBody, epicBody,
// targetBranch, defaultBranch, headBranch})`. No fetch, no parseGraphBlock IO —
// the predicate reuses parseGraphBlock's grammar (#340: never a second
// implementation of "parent"/"tracker"), fed pre-read body strings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { baseBranchRule } from './base-branch.mjs';

const EPIC_TRACKED = [
  '```brain-graph/1',
  'kind: epic',
  'tracker: feature/brain-ui',
  '```',
].join('\n');

const EPIC_NO_TRACKER = ['```brain-graph/1', 'kind: epic', '```'].join('\n');

const EPIC_MALFORMED_TRACKER = [
  '```brain-graph/1',
  'kind: epic',
  'tracker: not-a-tracker',
  '```',
].join('\n');

const EPIC_NOT_DECLARED = ['```brain-graph/1', 'track: A', '```'].join('\n');

const SLICE_WITH_PARENT = (n) => ['```brain-graph/1', `parent: ${n}`, '```'].join('\n');
const SLICE_NO_PARENT = ['```brain-graph/1', 'track: A', '```'].join('\n');

// ── R967-7 S1: a declared tracker with base `main` fails, naming tracker + epic ──

test('base-branch: a slice PR against main whose epic declares a tracker fails, naming both', () => {
  const r = baseBranchRule({
    issueBody: SLICE_WITH_PARENT(878),
    epicBody: EPIC_TRACKED,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('feature/brain-ui'), `reason must name the tracker, got: ${r.reason}`);
  assert.ok(r.reason.includes('878'), `reason must name the epic, got: ${r.reason}`);
});

// ── R967-7 S2: base equal to the tracker passes, no warning ──────────────────────

test('base-branch: a slice PR based on the declared tracker passes with no warning', () => {
  const r = baseBranchRule({
    issueBody: SLICE_WITH_PARENT(878),
    epicBody: EPIC_TRACKED,
    targetBranch: 'feature/brain-ui',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.deepEqual(r, { pass: true });
});

// ── R967-7 S3: a tracker's own PR must target the default branch ────────────────
//
// PR D (cold review round 2, 2026-09-17): a head is "a tracker's own PR" ONLY
// when `headBranch` equals the LINKED ISSUE'S OWN declared tracker (`kind: epic`
// + `tracker:`) — never by `feature/` prefix alone. The two tests below replace
// the old prefix-only pair, which asserted the exact bug this fix closes: they
// never passed `issueBody`, so a bare `feature/…` name was trusted with no
// declaration behind it at all.

test('base-branch: the REAL tracker head (== the linked epic\'s own declared tracker) targeting the default branch passes', () => {
  const r = baseBranchRule({
    issueBody: EPIC_TRACKED, // the epic's OWN issue: kind: epic, tracker: feature/brain-ui
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'feature/brain-ui',
  });
  assert.deepEqual(r, { pass: true });
});

test('base-branch: the REAL tracker head targeting another feature/... branch fails, naming the default branch', () => {
  const r = baseBranchRule({
    issueBody: EPIC_TRACKED,
    targetBranch: 'feature/other-epic',
    defaultBranch: 'main',
    headBranch: 'feature/brain-ui',
  });
  assert.equal(r.pass, false);
  assert.ok(/default branch/.test(r.reason), `reason must state a tracker PR targets the default branch, got: ${r.reason}`);
});

// ── measured bug: a slice head that merely STARTS WITH feature/ is not the tracker ──

test('base-branch (measured): a slice head naming an unrelated feature/... branch, correctly based on the real tracker, passes', () => {
  // The reviewed bug: `headBranch: 'feature/issue-42-my-feature'` used to trip the
  // blind `startsWith('feature/')` short-circuit before the epic/parent chain was
  // ever read, rejecting a slice that was already based on its epic's tracker.
  const r = baseBranchRule({
    issueBody: SLICE_WITH_PARENT(878),
    epicBody: EPIC_TRACKED,
    targetBranch: 'feature/brain-ui',
    defaultBranch: 'main',
    headBranch: 'feature/issue-42-my-feature',
  });
  assert.deepEqual(r, { pass: true });
});

// ── R967-7 S4: the standing case — pass untouched ────────────────────────────────

test('base-branch: no linked issue body at all passes untouched', () => {
  const r = baseBranchRule({
    issueBody: undefined,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.deepEqual(r, { pass: true });
});

test('base-branch: the linked issue declares no parent — passes untouched', () => {
  const r = baseBranchRule({
    issueBody: SLICE_NO_PARENT,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.deepEqual(r, { pass: true });
});

test('base-branch: a parent that is not kind: epic passes untouched (R967-9 — never inferred)', () => {
  const r = baseBranchRule({
    issueBody: SLICE_WITH_PARENT(878),
    epicBody: EPIC_NOT_DECLARED,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.deepEqual(r, { pass: true });
});

test('base-branch: an epic with no tracker passes untouched', () => {
  const r = baseBranchRule({
    issueBody: SLICE_WITH_PARENT(878),
    epicBody: EPIC_NO_TRACKER,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.deepEqual(r, { pass: true });
});

test('base-branch: the linked issue is itself kind: epic — its own work obeys no parent tracker', () => {
  const r = baseBranchRule({
    issueBody: EPIC_TRACKED,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.deepEqual(r, { pass: true });
});

// ── malformed tracker fails, naming the epic and the bad value ──────────────────

test('base-branch: a malformed declared tracker fails, naming the epic and the bad value', () => {
  const r = baseBranchRule({
    issueBody: SLICE_WITH_PARENT(878),
    epicBody: EPIC_MALFORMED_TRACKER,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.equal(r.pass, false);
  assert.ok(r.reason.includes('878'), `reason must name the epic, got: ${r.reason}`);
  assert.ok(r.reason.includes('not-a-tracker'), `reason must name the bad value, got: ${r.reason}`);
});

// ── unreadable declarations are uncomputable, never a silent pass ───────────────

test('base-branch: the linked issue\'s own graph block is unreadable (two blocks) — uncomputable', () => {
  const twoBlocks = ['```brain-graph/1', 'track: A', '```', '```brain-graph/1', 'track: B', '```'].join('\n');
  const r = baseBranchRule({
    issueBody: twoBlocks,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.equal(r.pass, false);
  assert.equal(r.uncomputable, true);
});

test('base-branch: the parent issue body could not be read — uncomputable, never a silent pass', () => {
  const r = baseBranchRule({
    issueBody: SLICE_WITH_PARENT(878),
    epicBody: undefined,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.equal(r.pass, false);
  assert.equal(r.uncomputable, true);
});

// ── a parent divergence is uncomputable, never a silent pass (PR E, round-3 ──
// cold-review finding, tracker PR #1004): `declaredParent(issueBody).parent`
// collapses a `parent-grammar` (malformed block key) and a `parent-ambiguous`
// (two disagreeing prose `Parent:` lines) divergence into the SAME `null` a
// body that never mentions a parent at all produces — line 84's old
// `if (parent === null) return { pass: true }` could not tell them apart, so
// an unreadable parent declaration passed untouched instead of failing closed.

const SLICE_PARENT_GRAMMAR = ['```brain-graph/1', 'parent: abc', '```'].join('\n');
const SLICE_PARENT_AMBIGUOUS = ['Parent: #878', 'Parent: #879'].join('\n');

test('base-branch: a parent-grammar divergence (parent: abc) is uncomputable, never a silent pass', () => {
  const r = baseBranchRule({
    issueBody: SLICE_PARENT_GRAMMAR,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.equal(r.pass, false);
  assert.equal(r.uncomputable, true);
  assert.ok(r.reason.includes('parent-grammar'), `reason must name the divergence reason, got: ${r.reason}`);
  assert.ok(r.reason.includes('abc'), `reason must name the offending value, got: ${r.reason}`);
});

test('base-branch: a parent-ambiguous divergence (two disagreeing Parent: lines) is uncomputable, never a silent pass', () => {
  const r = baseBranchRule({
    issueBody: SLICE_PARENT_AMBIGUOUS,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.equal(r.pass, false);
  assert.equal(r.uncomputable, true);
  assert.ok(r.reason.includes('parent-ambiguous'), `reason must name the divergence reason, got: ${r.reason}`);
  assert.ok(r.reason.includes('878, 879'), `reason must name the offending value, got: ${r.reason}`);
});

test('base-branch: a clean body with no parent mentioned at all still passes untouched (the standing case)', () => {
  const r = baseBranchRule({
    issueBody: SLICE_NO_PARENT,
    targetBranch: 'main',
    defaultBranch: 'main',
    headBranch: 'slice/whatever',
  });
  assert.deepEqual(r, { pass: true });
});

// ── mutation (R967-7 S9, the revert-proof): reverting this file alone turns ─────
// exactly this file red. Proven by a static-import scan: no module other than
// run-check.mjs (the one sanctioned wrapper, #340's rule against a second
// implementation) may import base-branch.mjs.

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('base-branch mutation (revert-proof): only run-check.mjs imports checks/base-branch.mjs', () => {
  const scriptsDir = fileURLToPath(new URL('../../', import.meta.url)); // brain/scripts
  const self = fileURLToPath(new URL('./base-branch.mjs', import.meta.url));
  const thisTest = fileURLToPath(new URL('./base-branch.test.mjs', import.meta.url));

  // An ACTUAL import statement, not a comment mentioning the filename
  // (run-check.test.mjs's own doc comment names it in prose without
  // importing it — that must not count as an importer).
  const IMPORT_RE = /from\s+['"][^'"]*base-branch\.mjs['"]/;
  const importers = walk(scriptsDir)
    .filter((f) => f !== self && f !== thisTest)
    .filter((f) => IMPORT_RE.test(readFileSync(f, 'utf8')))
    .map((f) => f.replace(scriptsDir, ''));

  assert.deepEqual(
    importers,
    importers.filter((f) => f === 'governance/run-check.mjs'),
    `base-branch.mjs must be imported by run-check.mjs alone (never a second implementation of ` +
      `the same rule, #340) — found: ${JSON.stringify(importers)}`,
  );
});
