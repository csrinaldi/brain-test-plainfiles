// lane.test.mjs — pure unit suite for classifyLane, the lane predicate (#905,
// spec.md "the lane predicate is narrow and structural", design.md A1-A3).
//
// RED until brain/scripts/governance/checks/lane.mjs exists (task A1). Every
// case here is taken from spec.md's Slice A test map.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LANE_BRANCH_RE, LANE_PATH_RE, classifyLane } from './lane.mjs';
import { planLaneCommit } from '../../memory/lane/plan.mjs';

// ── the clean lane vs a foreign path (spec Scenario 1) ──────────────────────

test('branch matches AND all changed paths under .memory/records/ are added-only ⇒ lane:true', () => {
  const result = classifyLane({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: ['.memory/records/a.jsonl', '.memory/records/b.jsonl'],
    addedFiles: ['.memory/records/a.jsonl', '.memory/records/b.jsonl'],
  });
  assert.equal(result.lane, true);
  assert.equal(result.laneBranch, true);
  assert.equal(result.lanePaths, true);
  assert.deepEqual(result.offending, []);
});

test('branch matches, a changed path under the prefix is modified (changed ⊄ added) ⇒ not-a-lane, offending lists it', () => {
  const result = classifyLane({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: ['.memory/records/a.jsonl', '.memory/records/b.jsonl'],
    addedFiles: ['.memory/records/a.jsonl'], // b.jsonl was modified, not added
  });
  assert.equal(result.lane, false);
  assert.equal(result.laneBranch, true);
  assert.equal(result.lanePaths, false);
  assert.deepEqual(result.offending, ['.memory/records/b.jsonl']);
});

test('branch matches, paths otherwise satisfy the predicate but include .memory/index.jsonl ⇒ not-a-lane (prefix fails, no special case)', () => {
  const result = classifyLane({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: ['.memory/records/a.jsonl', '.memory/index.jsonl'],
    addedFiles: ['.memory/records/a.jsonl', '.memory/index.jsonl'],
  });
  assert.equal(result.lane, false);
  assert.equal(result.lanePaths, false);
  assert.ok(result.offending.includes('.memory/index.jsonl'));
});

test('branch matches, one path is nested (.memory/records/sub/x.jsonl) ⇒ not-a-lane ([^/]+ fails)', () => {
  const result = classifyLane({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: ['.memory/records/sub/x.jsonl'],
    addedFiles: ['.memory/records/sub/x.jsonl'],
  });
  assert.equal(result.lane, false);
  assert.equal(result.lanePaths, false);
  assert.deepEqual(result.offending, ['.memory/records/sub/x.jsonl']);
});

test('paths satisfy the predicate but the branch does not match (e.g. feat/x) ⇒ lane:false, laneBranch:false, lanePaths:true', () => {
  const result = classifyLane({
    sourceBranch: 'feat/x',
    changedFiles: ['.memory/records/a.jsonl'],
    addedFiles: ['.memory/records/a.jsonl'],
  });
  assert.equal(result.lane, false);
  assert.equal(result.laneBranch, false);
  assert.equal(result.lanePaths, true);
});

test('sourceBranch: null ⇒ lane:false, reason names an absent branch', () => {
  const result = classifyLane({
    sourceBranch: null,
    changedFiles: ['.memory/records/a.jsonl'],
    addedFiles: ['.memory/records/a.jsonl'],
  });
  assert.equal(result.lane, false);
  assert.equal(result.laneBranch, false);
  assert.match(result.reason, /branch/i);
  assert.match(result.reason, /absent/i);
});

test('changedFiles/addedFiles empty ⇒ lane:false, reason: empty diff', () => {
  const result = classifyLane({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: [],
    addedFiles: [],
  });
  assert.equal(result.lane, false);
  assert.equal(result.lanePaths, false);
  assert.match(result.reason, /empty diff/);
});

test('changedFiles/addedFiles null (uncomputable) ⇒ lane:false, NEVER uncomputable:true', () => {
  const result = classifyLane({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: null,
    addedFiles: null,
  });
  assert.equal(result.lane, false);
  assert.equal(result.lanePaths, false);
  assert.equal(result.uncomputable, undefined);
});

// ── date-suffix grammar (design A3) — LANE_BRANCH_RE has NO (-\d+)? group ───

test('LANE_BRANCH_RE: a literal memory/host-2026-09-10-2 is asserted NOT a lane branch', () => {
  assert.equal(LANE_BRANCH_RE.test('memory/host-2026-09-10-2'), false);
});

test('the producer oracle: every plan.mjs ref over a host/date matrix satisfies LANE_BRANCH_RE after refs/heads/ is stripped', () => {
  const hosts = ['My-Host', 'a', 'ZZZ 123!!', 'host_with_underscore', '  spaced  ', 'UPPER-CASE-HOST'];
  const dates = ['2026-01-01', '2026-09-10', '2026-12-31'];
  for (const host of hosts) {
    for (const date of dates) {
      const plan = planLaneCommit({
        candidates: [],
        mainPaths: [],
        host,
        date,
        parent: { ref: 'origin/main', tip: null },
      });
      const branch = plan.ref.replace(/^refs\/heads\//, '');
      assert.ok(
        LANE_BRANCH_RE.test(branch),
        `plan.mjs ref "${plan.ref}" (branch "${branch}") for host=${JSON.stringify(host)} date=${date} must satisfy LANE_BRANCH_RE`
      );
    }
  }
});

// ── invariant across every case table row ───────────────────────────────────

test('invariant: lane === laneBranch && lanePaths (clean lane row)', () => {
  const result = classifyLane({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: ['.memory/records/a.jsonl'],
    addedFiles: ['.memory/records/a.jsonl'],
  });
  assert.equal(result.lane, result.laneBranch && result.lanePaths);
});

test('invariant: lane === laneBranch && lanePaths (branch-only row)', () => {
  const result = classifyLane({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: ['.memory/index.jsonl'],
    addedFiles: ['.memory/index.jsonl'],
  });
  assert.equal(result.lane, result.laneBranch && result.lanePaths);
});

test('invariant: lane === laneBranch && lanePaths (paths-only row)', () => {
  const result = classifyLane({
    sourceBranch: 'feat/x',
    changedFiles: ['.memory/records/a.jsonl'],
    addedFiles: ['.memory/records/a.jsonl'],
  });
  assert.equal(result.lane, result.laneBranch && result.lanePaths);
});

test('invariant: lane === laneBranch && lanePaths (uncomputable diff row)', () => {
  const result = classifyLane({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: null,
    addedFiles: null,
  });
  assert.equal(result.lane, result.laneBranch && result.lanePaths);
});

// ── LANE_PATH_RE, exported for lane-paths/lane-scrub reuse (design A5) ──────

test('LANE_PATH_RE matches a flat records path and refuses a nested one', () => {
  assert.equal(LANE_PATH_RE.test('.memory/records/x.jsonl'), true);
  assert.equal(LANE_PATH_RE.test('.memory/records/sub/x.jsonl'), false);
  assert.equal(LANE_PATH_RE.test('.memory/index.jsonl'), false);
});
