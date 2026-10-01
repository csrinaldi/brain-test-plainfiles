// brain/scripts/day-start.test.mjs — a source guard for day-start.mjs's
// step-5 lane-sweep wiring (#906 cold review C5).
//
// day-start.mjs is a top-level script (side-effecting at import time: VCS
// auth, git fetch, engram calls) — it cannot be `import`ed in a unit test
// the way a module of pure exports can, and test/bootstrap-smoke/smoke.mjs
// already proves the real end-to-end flag-off path reaches 6/6 against a
// fresh consumer fixture (outside npm test's own glob). What had ZERO
// coverage before this file: the step-5 lane-sweep block's WIRING itself —
// a mutant turning `warn(...)` into a fatal exit was invisible, because
// nothing asserted the block's own shape. This is that assertion, mirroring
// the source-guard pattern already used in this repo (e.g.
// memory/cli.ship.test.mjs's `getVcs()`-count pin).
//
// The actual DECISION logic (four branches: skip / ok-shipped / ok-nothing /
// warn) is extracted into the pure `laneSweepLine()` and unit-tested
// directly in day-start-sweep.test.mjs — this file only pins that
// day-start.mjs's block RENDERS that decision and never reimplements or
// escalates it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('./day-start.mjs', import.meta.url), 'utf8');

function laneSweepBlock() {
  const start = SOURCE.indexOf('// 5a. Lane sweep');
  const end = SOURCE.indexOf('// ── 6. Ticket board');
  assert.ok(start !== -1, 'the lane-sweep block start marker must be present in day-start.mjs');
  assert.ok(end !== -1 && end > start, 'the lane-sweep block end marker must be present in day-start.mjs');
  return SOURCE.slice(start, end);
}

test('day-start.mjs step-5 lane-sweep block never calls die(), process.exit, or throw — it can only warn or ok, never fail day:start', () => {
  const block = laneSweepBlock();
  assert.ok(!/\bdie\(/.test(block), 'the lane-sweep block must never call die()');
  assert.ok(!/process\.exit/.test(block), 'the lane-sweep block must never call process.exit');
  assert.ok(!/\bthrow\b/.test(block), 'the lane-sweep block must never throw');
});

test('day-start.mjs step-5 lane-sweep block routes through the pure laneSweepLine() decision, not an ad hoc re-derivation', () => {
  const block = laneSweepBlock();
  assert.match(block, /laneSweepLine\(/, 'the block must call laneSweepLine() to decide what to render');
  assert.ok(
    !/sweep\.unparsed/.test(block) && !/sweep\.status/.test(block) && !/sweep\.outcome/.test(block),
    'day-start.mjs must not branch on sweep.unparsed/.status/.outcome directly once laneSweepLine() exists — that decision belongs to the pure function, tested once, in day-start-sweep.test.mjs',
  );
});

test('day-start.mjs step-5 lane-sweep block prints a progress line before the (up to 60s) sweep runs, like the 4a/4b/4c sub-steps above it', () => {
  const block = laneSweepBlock();
  assert.match(
    block,
    /laneSweepEnabled\(config\)[\s\S]*console\.log[\s\S]*runLaneSweep\(/,
    'a progress line must print (when armed) before runLaneSweep() is invoked, not only after it returns',
  );
});

// #936 (D-sweep step 5.7): the cross-day sweep's own per-branch lines are
// rendered the same way as the single-line summary above — through the
// pure laneSweepBranchLines() decision, never a literal "sweep.outcome"
// re-derivation (the same discipline the test above pins for laneSweepLine).
test('day-start.mjs step-5 lane-sweep block also renders laneSweepBranchLines(), routed the same pure way', () => {
  const block = laneSweepBlock();
  assert.match(block, /laneSweepBranchLines\(/, 'the block must call laneSweepBranchLines() to render the per-branch sweep rows');
  assert.ok(
    !/sweep\.outcome/.test(block),
    'day-start.mjs must not re-derive sweep.outcome directly — laneSweepBranchLines() owns that read',
  );
});
