// brain/scripts/memory/day-start-sweep.test.mjs — unit tests for the
// synchronous day:start lane sweep (#906, design.md A7).
//
// The launcher (session-end-ship.mjs) detaches; this is its sibling — a
// SYNCHRONOUS sub-step inside day:start's own "Team memory" step, with its
// OWN timeout (day-start.mjs's run() passes none). It never throws: a
// non-zero ship exit or an unparseable --json line is reported, never
// fatal — the caller decides whether to warn.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { laneSweepEnabled, runLaneSweep, laneSweepLine, laneSweepBranchLines } from './day-start-sweep.mjs';
import en from '../i18n/en.mjs';
import es from '../i18n/es.mjs';

// ── laneSweepEnabled — pure ─────────────────────────────────────────────────

test('laneSweepEnabled: true only when memory.lane.enabled === true', () => {
  assert.equal(laneSweepEnabled({ memory: { lane: { enabled: true } } }), true);
  assert.equal(laneSweepEnabled({ memory: { lane: { enabled: false } } }), false);
  assert.equal(laneSweepEnabled({}), false);
  assert.equal(laneSweepEnabled({ memory: {} }), false);
  assert.equal(laneSweepEnabled(undefined), false);
});

// ── runLaneSweep — flag off ──────────────────────────────────────────────────

test('flag off: _spawnSync is never called, returns skipped:true', () => {
  let called = false;
  const result = runLaneSweep({
    config: { memory: { lane: { enabled: false } } },
    _spawnSync: () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(result.skipped, true);
});

// ── runLaneSweep — flag on ───────────────────────────────────────────────────

test('flag on: one _spawnSync call with --json and a timeout', () => {
  const calls = [];
  runLaneSweep({
    config: { memory: { lane: { enabled: true } } },
    _spawnSync: (...args) => {
      calls.push(args);
      return { status: 0, stdout: '{"pushed":false,"collected":0}\n', stderr: '' };
    },
  });
  assert.equal(calls.length, 1, 'exactly one spawnSync call');
  const [cmd, argv, opts] = calls[0];
  assert.equal(cmd, process.execPath);
  assert.ok(argv.some((a) => a.endsWith('cli.mjs')));
  // #1012: the sweep caller declares itself — argv.slice(1) drops only the
  // resolved cli.mjs path, so the exact remaining shape is pinned.
  assert.deepEqual(argv.slice(1), ['ship', '--json', '--invoker', 'sweep']);
  assert.equal(typeof opts.timeout, 'number');
  assert.ok(opts.timeout > 0);
  assert.equal('env' in opts, false, 'no env key — the child inherits the parent env by default');
});

test('flag on, exit 0, one JSON line: parsed into outcome, skipped:false', () => {
  const result = runLaneSweep({
    config: { memory: { lane: { enabled: true } } },
    _spawnSync: () => ({
      status: 0,
      stdout: '{"pushed":true,"pr":{"number":42},"autoMerge":{"enabled":true},"collected":3,"ref":"refs/heads/memory/x-2026-09-10"}\n',
      stderr: '',
    }),
  });
  assert.equal(result.skipped, false);
  assert.equal(result.status, 0);
  assert.equal(result.unparsed, false);
  assert.deepEqual(result.outcome, {
    pushed: true,
    pr: { number: 42 },
    autoMerge: { enabled: true },
    collected: 3,
    ref: 'refs/heads/memory/x-2026-09-10',
  });
});

test('non-zero child exit: reported in the outcome, never thrown', () => {
  assert.doesNotThrow(() => {
    const result = runLaneSweep({
      config: { memory: { lane: { enabled: true } } },
      _spawnSync: () => ({ status: 1, stdout: '', stderr: 'memory/cli: ship failed\n' }),
    });
    assert.equal(result.skipped, false);
    assert.equal(result.status, 1);
    assert.equal(result.outcome, null);
    assert.equal(result.unparsed, false);
  });
});

test('unparseable stdout: unparsed:true, still non-fatal', () => {
  assert.doesNotThrow(() => {
    const result = runLaneSweep({
      config: { memory: { lane: { enabled: true } } },
      _spawnSync: () => ({ status: 0, stdout: 'not json at all', stderr: '' }),
    });
    assert.equal(result.skipped, false);
    assert.equal(result.unparsed, true);
    assert.equal(result.outcome, null);
  });
});

test('spawnSync itself failing to start (ENOENT-shaped result): never throws, reports status null', () => {
  assert.doesNotThrow(() => {
    const result = runLaneSweep({
      config: { memory: { lane: { enabled: true } } },
      _spawnSync: () => ({ status: null, error: new Error('ENOENT'), stdout: '', stderr: '' }),
    });
    assert.equal(result.skipped, false);
    assert.equal(result.status, null);
    assert.equal(result.outcome, null);
  });
});

// ── laneSweepLine — pure, four branches (#906 cold review C5) ───────────────
//
// day-start.mjs's step-5 wiring had ZERO behavioural coverage before this: a
// mutant turning a `warn(...)` into something fatal was invisible. Extracting
// the RENDER DECISION into this pure function (never calls t(), never touches
// I/O, never throws) makes that decision independently testable, and pins
// that day-start.mjs's own wiring only ever has `warn`/`ok`/nothing to choose
// from — never a path to a fatal exit.

test('laneSweepLine: flag off (skipped) → level "skip", nothing to render', () => {
  const line = laneSweepLine({ skipped: true, status: null, outcome: null, unparsed: false });
  assert.equal(line.level, 'skip');
  assert.equal(line.key, null);
});

test('laneSweepLine: exit 0, pushed → level "ok", the shipped key with ref/number params', () => {
  const line = laneSweepLine({
    skipped: false,
    status: 0,
    unparsed: false,
    outcome: { pushed: true, pr: { number: 42 }, ref: 'refs/heads/memory/x-2026-09-10' },
  });
  assert.equal(line.level, 'ok');
  assert.equal(line.key, 'day.memory.laneSweep.shipped');
  assert.deepEqual(line.params, { ref: 'refs/heads/memory/x-2026-09-10', number: 42 });
});

// R11 (#920): a reconciliation-without-a-push (find/create + arm ran, with
// zero new commits) must render as work, never as "nothing" — a false
// negative about memory delivery.

test('laneSweepLine: reconciled without a push → level "ok", the reconciled key with ref/number params', () => {
  const line = laneSweepLine({
    skipped: false,
    status: 0,
    unparsed: false,
    outcome: { pushed: false, reconciled: true, pr: { number: 42 }, ref: 'refs/heads/memory/x-2026-09-10' },
  });
  assert.equal(line.level, 'ok');
  assert.equal(line.key, 'day.memory.laneSweep.reconciled');
  assert.deepEqual(line.params, { ref: 'refs/heads/memory/x-2026-09-10', number: 42 });
});

test('laneSweepLine: pushed:true still wins over reconciled:true (pushed is checked first)', () => {
  const line = laneSweepLine({
    skipped: false,
    status: 0,
    unparsed: false,
    outcome: { pushed: true, reconciled: true, pr: { number: 7 }, ref: 'refs/heads/memory/x-2026-09-10' },
  });
  assert.equal(line.level, 'ok');
  assert.equal(line.key, 'day.memory.laneSweep.shipped');
});

test('laneSweepLine: pushed:false and reconciled:false still falls through to "nothing"', () => {
  const line = laneSweepLine({
    skipped: false,
    status: 0,
    unparsed: false,
    outcome: { pushed: false, reconciled: false, collected: 0 },
  });
  assert.equal(line.level, 'ok');
  assert.equal(line.key, 'day.memory.laneSweep.nothing');
  assert.deepEqual(line.params, {});
});

test('laneSweepLine: exit 0, nothing pushed → level "ok", the nothing key, no params', () => {
  const line = laneSweepLine({
    skipped: false,
    status: 0,
    unparsed: false,
    outcome: { pushed: false, collected: 0 },
  });
  assert.equal(line.level, 'ok');
  assert.equal(line.key, 'day.memory.laneSweep.nothing');
  assert.deepEqual(line.params, {});
});

// F2 (cold review, #921/#923): before this fix, `laneSweepLine()` read only
// `pushed`/`reconciled` off the parsed outcome and fell through to
// `.nothing` whenever neither was true — even when `ship --json`'s own
// outcome carried a non-empty `skippedWorktrees` (#921). That is exactly the
// indistinguishability the ticket named, on the one surface (`day:start`)
// that discards the ship child's stderr entirely (see runLaneSweep() above:
// it never reads `result.stderr`).

test('laneSweepLine: nothing pending, and nothing skipped → still the plain "nothing" line (regression guard)', () => {
  const line = laneSweepLine({
    skipped: false,
    status: 0,
    unparsed: false,
    outcome: { pushed: false, collected: 0, skippedWorktrees: [] },
  });
  assert.equal(line.level, 'ok');
  assert.equal(line.key, 'day.memory.laneSweep.nothing');
  assert.deepEqual(line.params, {});
});

test('laneSweepLine: nothing pending, but a worktree was skipped → level "ok", the worktreeSkipped key, count+paths (never the plain "nothing" line)', () => {
  const line = laneSweepLine({
    skipped: false,
    status: 0,
    unparsed: false,
    outcome: {
      pushed: false, collected: 0,
      skippedWorktrees: [{ path: '/repo/wt-b', reason: 'fatal: not a git repository' }],
    },
  });
  assert.equal(line.level, 'ok');
  assert.equal(line.key, 'day.memory.laneSweep.worktreeSkipped');
  assert.deepEqual(line.params, { count: 1, paths: '/repo/wt-b (fatal: not a git repository)' });
});

test('laneSweepLine: pushed:true with a skipped worktree still renders "shipped" (documented scope boundary — the skip is still visible via --json and the SessionEnd log, not duplicated here)', () => {
  const line = laneSweepLine({
    skipped: false,
    status: 0,
    unparsed: false,
    outcome: {
      pushed: true, pr: { number: 42 }, ref: 'refs/heads/memory/x-2026-09-10',
      skippedWorktrees: [{ path: '/repo/wt-b', reason: 'fatal: not a git repository' }],
    },
  });
  assert.equal(line.level, 'ok');
  assert.equal(line.key, 'day.memory.laneSweep.shipped');
});

test('laneSweepLine: non-zero exit (ship failure) → level "warn", never "die" — an i18n detail KEY, not a literal string', () => {
  const line = laneSweepLine({ skipped: false, status: 1, unparsed: false, outcome: null });
  assert.equal(line.level, 'warn');
  assert.equal(line.key, 'day.memory.laneSweep.warn');
  assert.equal(line.params.detailKey, 'day.memory.laneSweep.detailExitCode');
  assert.deepEqual(line.params.detailParams, { status: 1 });
});

test('laneSweepLine: unparseable stdout → level "warn", the unparsed detail key', () => {
  const line = laneSweepLine({ skipped: false, status: 0, unparsed: true, outcome: null });
  assert.equal(line.level, 'warn');
  assert.equal(line.key, 'day.memory.laneSweep.warn');
  assert.equal(line.params.detailKey, 'day.memory.laneSweep.detailUnparsed');
  assert.deepEqual(line.params.detailParams, {});
});

test('laneSweepLine: null status (spawnSync itself failed to start) reads as a warn with "unknown" in the exit-code detail params, not a crash', () => {
  const line = laneSweepLine({ skipped: false, status: null, unparsed: false, outcome: null });
  assert.equal(line.level, 'warn');
  assert.equal(line.params.detailKey, 'day.memory.laneSweep.detailExitCode');
  assert.equal(line.params.detailParams.status, 'unknown');
});

test('laneSweepLine never returns a level outside {skip, ok, warn} — the only vocabulary day-start.mjs is allowed to render', () => {
  const cases = [
    { skipped: true, status: null, outcome: null, unparsed: false },
    { skipped: false, status: 0, outcome: { pushed: true, pr: {}, ref: 'x' }, unparsed: false },
    { skipped: false, status: 0, outcome: { pushed: false }, unparsed: false },
    { skipped: false, status: 1, outcome: null, unparsed: false },
    { skipped: false, status: 0, outcome: null, unparsed: true },
  ];
  for (const c of cases) {
    assert.ok(['skip', 'ok', 'warn'].includes(laneSweepLine(c).level));
  }
});

// ── laneSweepBranchLines — pure, one line per sweep-table row (#936) ────────

test('laneSweepBranchLines: null sweep (--dry-run, or no sweep ran) yields zero lines, never a crash', () => {
  assert.deepEqual(laneSweepBranchLines(null), []);
  assert.deepEqual(laneSweepBranchLines(undefined), []);
  assert.deepEqual(laneSweepBranchLines({ remoteListed: true, branches: undefined }), []);
});

test('laneSweepBranchLines: empty branches yields zero lines', () => {
  assert.deepEqual(laneSweepBranchLines({ remoteListed: true, branches: [] }), []);
});

const BRANCH_ACTIONS = ['deleted', 'shipped', 'reconciled', 'closedUnmerged', 'unknown', 'diverged', 'failed', 'remoteOnly'];
const WARN_ACTIONS = new Set(['closedUnmerged', 'unknown', 'diverged', 'failed', 'remoteOnly']);

for (const action of BRANCH_ACTIONS) {
  test(`laneSweepBranchLines: action "${action}" renders day.memory.laneSweep.branch.${action}, level ${WARN_ACTIONS.has(action) ? 'warn' : 'ok'}`, () => {
    const row = { branch: 'memory/test-host-2026-09-01', date: '2026-09-01', where: 'local', action, delivered: null, pr: { number: 7, url: null }, reason: action === 'failed' ? 'boom' : null };
    const [line] = laneSweepBranchLines({ remoteListed: true, branches: [row] });
    assert.equal(line.key, `day.memory.laneSweep.branch.${action}`);
    assert.equal(line.level, WARN_ACTIONS.has(action) ? 'warn' : 'ok');
    assert.equal(line.params.branch, row.branch);
    assert.equal(line.params.date, row.date);
    assert.equal(line.params.number, 7);
    // Both catalogs must carry this key — a missing key would otherwise
    // silently render as the literal key string to the operator.
    assert.equal(typeof en[line.key], 'string', `en.mjs must carry ${line.key}`);
    assert.equal(typeof es[line.key], 'string', `es.mjs must carry ${line.key}`);
    assert.equal(typeof en[`memory.ship.sweep.${action}`], 'string', `en.mjs must carry memory.ship.sweep.${action}`);
    assert.equal(typeof es[`memory.ship.sweep.${action}`], 'string', `es.mjs must carry memory.ship.sweep.${action}`);
  });
}

test('laneSweepBranchLines: a row with no PR (pr:null) reports number:null, never throws', () => {
  const [line] = laneSweepBranchLines({ remoteListed: true, branches: [{ branch: 'memory/test-host-2026-09-01', date: '2026-09-01', action: 'deleted', delivered: true, pr: null, reason: null }] });
  assert.equal(line.params.number, null);
});

// #936 remediation (cold review WARNING): `sweepLanes()` can now fail closed
// as a whole (cli.mjs isolates a throw from its pre-loop code into
// `{ failed: true, reason }`) — `laneSweepBranchLines()` must render that as
// ONE line, not silently fall through to the empty-array branch (`branches`
// is absent on this shape, which is exactly what the pre-existing "null/
// shapeless sweep" test above already covers for the OTHER reason: no sweep
// ran at all. This is a THIRD, distinct shape: a sweep that ran and failed).
test('laneSweepBranchLines: a whole-sweep failure ({failed:true, reason}) renders exactly one warn line naming the reason', () => {
  const lines = laneSweepBranchLines({ failed: true, reason: 'boom: BRAIN_MEMORY_SWEEP_FORCE_THROW=1' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'warn');
  assert.equal(lines[0].key, 'day.memory.laneSweep.sweepFailed');
  assert.equal(lines[0].params.reason, 'boom: BRAIN_MEMORY_SWEEP_FORCE_THROW=1');
  assert.equal(typeof en[lines[0].key], 'string', `en.mjs must carry ${lines[0].key}`);
  assert.equal(typeof es[lines[0].key], 'string', `es.mjs must carry ${lines[0].key}`);
});

test('laneSweepBranchLines: multiple rows produce one line each, in order', () => {
  const branches = [
    { branch: 'memory/test-host-2026-09-01', date: '2026-09-01', action: 'deleted', delivered: true, pr: null, reason: null },
    { branch: 'memory/test-host-2026-09-02', date: '2026-09-02', action: 'unknown', delivered: null, pr: null, reason: 'baseStale' },
  ];
  const lines = laneSweepBranchLines({ remoteListed: true, branches });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].key, 'day.memory.laneSweep.branch.deleted');
  assert.equal(lines[1].key, 'day.memory.laneSweep.branch.unknown');
});
