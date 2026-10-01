// scripts/axes/sdd-engine/adapters/gentle-ai.test.mjs — unit tests for the gentle-ai harness backend.
//
// Acceptance criteria:
//   Ecosystem step (init):
//     (a) gentle-ai absent → warn, return early, no crash.
//     (b) gentle-ai present + doctor healthy → logs ok, does NOT call install.
//     (c) gentle-ai present + doctor unhealthy + TTY → calls install.
//     (d) gentle-ai present + doctor unhealthy + no TTY → warns no-TTY, no install.
//     (e) registry refresh always attempted when gentle-ai present.
//   SDD context step (init):
//     (f) context found in engram → no "not found" notice.
//     (g) context missing in engram → prints notice mentioning sdd-init or Init Guard.
//     (h) project unresolvable → skips context check, no crash.
//   Safety:
//     (i) never throws when gentle-ai absent + doctor throws.
//     (j) never throws when engram search throws.
//     (k) never throws when registry refresh throws.
//
// All tests use injectable seams — no real subprocess or engram call is made.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED: import fails until gentle-ai.mjs exports init.
import { init } from './gentle-ai.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a set of injectable deps where all tools are present and healthy,
 * project is resolvable, context is found, no TTY, and decisions dir is populated.
 * Individual overrides let tests probe one behaviour at a time.
 */
function makeDeps(overrides = {}) {
  return {
    _checkGentleAi:  () => true,
    _runDoctor:      () => true,          // healthy
    _runInstall:     () => true,          // success
    _refreshRegistry: () => true,         // success
    _checkTty:       () => false,         // no TTY by default
    _resolveProject: () => 'my-project',
    _checkEngram:    () => true,
    _runEngramSearch: (_project) => true, // context found
    _resolveDecisionsDir: () => '/fake/decisions',
    _checkDecisionsDir: () => true,       // populated → no ADR notice by default
    ...overrides,
  };
}

/** Capture console.warn lines while calling fn(). */
async function captureWarn(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try { await fn(); } finally { console.warn = orig; }
  return warnings;
}

/** Capture console.log lines while calling fn(). */
async function captureLog(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try { await fn(); } finally { console.log = orig; }
  return logs;
}

// ── (a) gentle-ai absent → warn, return early ────────────────────────────────

test('init: gentle-ai absent → warns with mention of gentle-ai, does not crash', async () => {
  const warnings = await captureWarn(() =>
    init(makeDeps({ _checkGentleAi: () => false }))
  );
  assert.ok(
    warnings.some((w) => w.includes('gentle-ai')),
    `expected warning mentioning gentle-ai; got: ${JSON.stringify(warnings)}`,
  );
});

test('init: gentle-ai absent → does NOT call doctor', async () => {
  let doctorCalled = false;
  await init(makeDeps({
    _checkGentleAi: () => false,
    _runDoctor: () => { doctorCalled = true; return true; },
  }));
  assert.ok(!doctorCalled, 'doctor should not be called when gentle-ai is absent');
});

// ── (b) doctor healthy → no install ──────────────────────────────────────────

test('init: doctor healthy → does NOT call install', async () => {
  let installCalled = false;
  await init(makeDeps({
    _runDoctor: () => true,
    _runInstall: () => { installCalled = true; return true; },
  }));
  assert.ok(!installCalled, 'install should not be called when doctor is healthy');
});

test('init: doctor healthy → logs a message mentioning "already" or "initialized"', async () => {
  const logs = await captureLog(() => init(makeDeps({ _runDoctor: () => true })));
  assert.ok(
    logs.some((l) => /already|initialized|ok/i.test(l)),
    `expected an "already initialized" log line; got: ${JSON.stringify(logs)}`,
  );
});

// ── (c) doctor unhealthy + TTY → runs install ────────────────────────────────

test('init: doctor unhealthy + TTY → calls install', async () => {
  let installCalled = false;
  await init(makeDeps({
    _runDoctor: () => false,
    _checkTty: () => true,
    _runInstall: () => { installCalled = true; return true; },
  }));
  assert.ok(installCalled, 'install should be called when doctor is unhealthy and TTY is available');
});

// ── (d) doctor unhealthy + no TTY → warns no-TTY, no install ────────────────

test('init: doctor unhealthy + no TTY → warns about TTY, does NOT call install', async () => {
  let installCalled = false;
  const warnings = await captureWarn(() =>
    init(makeDeps({
      _runDoctor: () => false,
      _checkTty: () => false,
      _runInstall: () => { installCalled = true; return true; },
    }))
  );
  assert.ok(!installCalled, 'install must not be called without a TTY');
  assert.ok(
    warnings.some((w) => /tty|terminal/i.test(w)),
    `expected a no-TTY warning; got: ${JSON.stringify(warnings)}`,
  );
});

// ── (e) registry refresh always attempted ────────────────────────────────────

test('init: registry refresh is called when gentle-ai is present', async () => {
  let refreshCalled = false;
  await init(makeDeps({ _refreshRegistry: () => { refreshCalled = true; return true; } }));
  assert.ok(refreshCalled, 'registry refresh should be called when gentle-ai is present');
});

test('init: registry refresh NOT called when gentle-ai is absent', async () => {
  let refreshCalled = false;
  await init(makeDeps({
    _checkGentleAi: () => false,
    _refreshRegistry: () => { refreshCalled = true; return true; },
  }));
  assert.ok(!refreshCalled, 'registry refresh must not be called when gentle-ai is absent');
});

// ── (f) context found → no "not found" notice ────────────────────────────────

test('init: context found in engram → no "not found" notice', async () => {
  const logs = await captureLog(() =>
    init(makeDeps({ _runEngramSearch: () => true }))
  );
  assert.ok(
    !logs.some((l) => /not found|missing/i.test(l)),
    `should not emit a "not found" notice when context is present; got: ${JSON.stringify(logs)}`,
  );
});

// ── (g) context missing → notice mentions sdd-init or Init Guard ─────────────

test('init: context missing → notice mentions sdd-init or Init Guard', async () => {
  const logs = await captureLog(() =>
    init(makeDeps({ _runEngramSearch: () => false }))
  );
  assert.ok(
    logs.some((l) => /sdd.?init|init.?guard|\/sdd-init/i.test(l)),
    `expected a notice about sdd-init or Init Guard; got: ${JSON.stringify(logs)}`,
  );
});

// ── (h) project unresolvable → skip context check ────────────────────────────

test('init: project unresolvable → skips context check, no crash', async () => {
  let searchCalled = false;
  await init(makeDeps({
    _resolveProject: () => null,
    _runEngramSearch: () => { searchCalled = true; return false; },
  }));
  assert.ok(!searchCalled, 'engram search must not be called when project is unresolvable');
});

// ── (i) never throws when gentle-ai absent + doctor throws ───────────────────

test('init: never throws when gentle-ai absent', async () => {
  await assert.doesNotReject(() =>
    init(makeDeps({ _checkGentleAi: () => false }))
  );
});

// ── (j) never throws when engram search throws ───────────────────────────────

test('init: never throws when engram search throws', async () => {
  await assert.doesNotReject(() =>
    init(makeDeps({
      _runEngramSearch: () => { throw new Error('engram unavailable'); },
    }))
  );
});

// ── (k) never throws when registry refresh throws ────────────────────────────

test('init: never throws when registry refresh throws', async () => {
  await assert.doesNotReject(() =>
    init(makeDeps({
      _refreshRegistry: () => { throw new Error('refresh failed'); },
    }))
  );
});

// ── _toEngramProject — last path segment extraction ───────────────────────────
//
// RED: these fail until _toEngramProject is exported from gentle-ai.mjs.

import { _toEngramProject } from './gentle-ai.mjs';

test('_toEngramProject: "owner/repo" resolves to bare name "repo"', () => {
  assert.equal(_toEngramProject('owner/repo'), 'repo');
});

test('_toEngramProject: nested "group/sub/repo" resolves to "repo"', () => {
  assert.equal(_toEngramProject('group/sub/repo'), 'repo');
});

test('_toEngramProject: single-segment "brain" resolves to itself', () => {
  assert.equal(_toEngramProject('brain'), 'brain');
});

test('_toEngramProject: null returns null (graceful — no origin case)', () => {
  assert.equal(_toEngramProject(null), null);
});

test('_toEngramProject: empty string returns null (graceful — empty origin)', () => {
  assert.equal(_toEngramProject(''), null);
});

// ── init Step 3: _runEngramSearch invoked with value from _resolveProject ─────

test('init: _runEngramSearch is called with the project name returned by _resolveProject', async () => {
  let capturedProject = null;
  await init(makeDeps({
    _resolveProject: () => 'brain',
    _runEngramSearch: (p) => { capturedProject = p; return true; },
  }));
  assert.equal(capturedProject, 'brain',
    'init must pass the _resolveProject return value directly to _runEngramSearch');
});

test('init: context found (bare project name) → no "not found" notice printed', async () => {
  const logs = await captureLog(() =>
    init(makeDeps({
      _resolveProject: () => 'brain',
      _runEngramSearch: () => true,
    }))
  );
  assert.ok(
    !logs.some((l) => /not found/i.test(l)),
    `no "not found" notice should be printed when context exists; got: ${JSON.stringify(logs)}`,
  );
});

// ── Step 4: _checkDecisionsDir seam (tasks 1.1 – 1.5) ───────────────────────

// (1.1) absent decisions dir → gap notice
test('init: absent decisions dir → gap notice logged', async () => {
  const logs = await captureLog(() =>
    init(makeDeps({ _checkDecisionsDir: () => false }))
  );
  assert.ok(
    logs.some((l) => /No project ADRs/i.test(l)),
    `expected gap notice for absent dir; got: ${JSON.stringify(logs)}`,
  );
});

// (1.2) present dir with no .md files → gap notice (same seam shape, different semantic)
test('init: empty decisions dir (no .md files) → gap notice logged', async () => {
  const logs = await captureLog(() =>
    init(makeDeps({ _checkDecisionsDir: () => false }))
  );
  assert.ok(
    logs.some((l) => /No project ADRs/i.test(l)),
    `expected gap notice for empty (no .md) dir; got: ${JSON.stringify(logs)}`,
  );
});

// (1.3) populated dir → silent
test('init: populated decisions dir (≥1 .md) → no gap notice', async () => {
  const logs = await captureLog(() =>
    init(makeDeps({ _checkDecisionsDir: () => true }))
  );
  assert.ok(
    !logs.some((l) => /No project ADRs/i.test(l)),
    `should not log gap notice when decisions dir is populated; got: ${JSON.stringify(logs)}`,
  );
});

// (1.4) Step 4 runs even when _resolveProject returns null
// (the early return inside checkSddContext must NOT skip Step 4)
test('init: Step 4 runs even when _resolveProject returns null (engram early-return does not skip Step 4)', async () => {
  const logs = await captureLog(() =>
    init(makeDeps({
      _resolveProject: () => null,
      _checkDecisionsDir: () => false,
    }))
  );
  assert.ok(
    logs.some((l) => /No project ADRs/i.test(l)),
    `expected gap notice even when project is unresolvable; got: ${JSON.stringify(logs)}`,
  );
});

// (1.5) regression: engram-context notice (Step 3) still fires after checkSddContext() refactor
test('init: engram context notice (checkSddContext) still fires after refactor', async () => {
  const logs = await captureLog(() =>
    init(makeDeps({ _runEngramSearch: () => false }))
  );
  assert.ok(
    logs.some((l) => /sdd.?init|init.?guard|\/sdd-init/i.test(l)),
    `expected SDD context notice to still fire after checkSddContext() refactor; got: ${JSON.stringify(logs)}`,
  );
});

test('gentle-ai declares the runtime seam explicitly (issue #123)', async () => {
  const { AGENT_RUNTIME } = await import('./gentle-ai.mjs');
  // Must EXIST, so "nobody added the export" is not indistinguishable from
  // "this backend deliberately declares nothing" — the whole point of the seam.
  assert.equal(AGENT_RUNTIME, null);
});
