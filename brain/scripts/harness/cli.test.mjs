// scripts/harness/cli.test.mjs — unit tests for the SDD harness dispatcher.
//
// Acceptance criteria:
//   (a) resolveHarness: env var (SDD_HARNESS) wins over .env file value.
//   (b) resolveHarness: .env value used when env var absent.
//   (c) resolveHarness: defaults to 'gentle-ai' when both absent.
//   (d) dispatch: calls 'init' on the resolved backend (injectable fake).
//   (e) dispatch: unknown harness → throws a clear error.
//   (f) dispatch: unknown op → throws a clear error.
//   (g) dispatch: backend missing 'init' export → throws a clear error.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveHarness, resolvePlatform, resolveEngine, dispatch, VALID_OPS } from './cli.mjs';
import { SDD_ENGINES, DEFAULT_PLATFORM, AGENT_PLATFORMS } from './platform.mjs';

// ── 3-axis resolution tests (issue #305) ───────────────────────────────────

test('resolvePlatform: env AGENT_PLATFORM wins over envVars and config', () => {
  const result = resolvePlatform({
    env: { AGENT_PLATFORM: 'claude' },
    envVars: { AGENT_PLATFORM: 'antigravity' },
  });
  assert.equal(result, 'claude');
});

// The legacy value is `antigravity`, NOT `claude` (#1125): with `claude` the
// default, a legacy `SDD_HARNESS=claude` resolves to `claude` whether or not the
// fallback is read at all — the test would pass against a resolver that dropped
// SDD_HARNESS. The value under test must differ from the default to detect it.
test('resolvePlatform: falls back to legacy SDD_HARNESS when platform absent', () => {
  const result = resolvePlatform({
    env: {},
    envVars: { SDD_HARNESS: 'antigravity' },
  });
  assert.equal(result, 'antigravity');
});

// #1125 — the default is `claude` (ADR-0024 Amendment 2). Until #1125 this test
// pinned `antigravity`, ADR-0024's "deliberate default"; the maintainer's ruling
// of 2026-09-24 moved it. Updated, not deleted: the default is still pinned, it is
// just a different value.
test('resolvePlatform: defaults to claude when nothing is stated (#1125)', () => {
  assert.equal(resolvePlatform({ env: {}, envVars: {} }), 'claude');
  assert.equal(resolvePlatform({ env: {}, envVars: {}, config: {} }), 'claude');
  assert.equal(resolvePlatform({ env: {} }), 'claude');
});

test('resolvePlatform: DEFAULT_PLATFORM is the one declaration of the default, and it is claude (#1125)', () => {
  assert.equal(DEFAULT_PLATFORM, 'claude');
  assert.equal(resolvePlatform({ env: {}, envVars: {} }), DEFAULT_PLATFORM);
});

test('resolvePlatform: a legacy SDD_HARNESS outside the platform set falls to the claude default, not to itself (#1125)', () => {
  // `gentle-ai` is an ENGINE (ADR-0024); as a legacy SDD_HARNESS it must not
  // leak into the platform axis.
  assert.equal(resolvePlatform({ env: {}, envVars: { SDD_HARNESS: 'gentle-ai' } }), 'claude');
});

test('resolvePlatform: a stated antigravity still resolves to antigravity on EVERY path (#1125)', () => {
  const paths = {
    'process env AGENT_PLATFORM': { env: { AGENT_PLATFORM: 'antigravity' }, envVars: {}, config: {} },
    '.env AGENT_PLATFORM': { env: {}, envVars: { AGENT_PLATFORM: 'antigravity' }, config: {} },
    'config platform': { env: {}, envVars: {}, config: { platform: 'antigravity' } },
    'process env SDD_HARNESS (legacy)': { env: { SDD_HARNESS: 'antigravity' }, envVars: {}, config: {} },
    '.env SDD_HARNESS (legacy)': { env: {}, envVars: { SDD_HARNESS: 'antigravity' }, config: {} },
    'config harness (legacy)': { env: {}, envVars: {}, config: { harness: 'antigravity' } },
  };
  for (const [label, opts] of Object.entries(paths)) {
    assert.equal(resolvePlatform(opts), 'antigravity', `stated via ${label}`);
  }
});

test('resolvePlatform: AGENT_PLATFORMS names the supported platforms, claude first (#1125)', () => {
  assert.deepEqual([...AGENT_PLATFORMS], ['claude', 'antigravity', 'plain']);
  for (const p of AGENT_PLATFORMS) {
    assert.equal(resolvePlatform({ env: {}, envVars: { SDD_HARNESS: p } }), p, `legacy SDD_HARNESS=${p}`);
  }
});

test('resolveEngine: env SDD_ENGINE wins over envVars', () => {
  const result = resolveEngine({
    env: { SDD_ENGINE: 'plain' },
    envVars: { SDD_ENGINE: 'gentle-ai' },
  });
  assert.equal(result, 'plain');
});

test('resolveEngine: falls back to legacy SDD_HARNESS when engine absent', () => {
  const result = resolveEngine({
    env: {},
    envVars: { SDD_HARNESS: 'plain' },
  });
  assert.equal(result, 'plain');
});

test('resolveEngine: defaults to gentle-ai when absent', () => {
  const result = resolveEngine({ env: {}, envVars: {} });
  assert.equal(result, 'gentle-ai');
});

// ── #312 D2 supporting change: SDD_ENGINES is ONE declaration, cli.mjs is a reader ──
//
// `resolveEngine` used to hold the engine-axis membership as an inline
// literal `['gentle-ai', 'plain']`. Extracted to `harness/platform.mjs` as
// `SDD_ENGINES` so `axes/sdd-engine/role-port.mjs`'s registry assertion (and any future
// second reader) shares the same one declaration — `CLI_OPS`-from-`OPS`
// (`:136-145` above) and `IMPLEMENTED_AXES`-from-`RUNNERS`
// (`resolve-challenger.mjs:64-74`) are the house pattern this mirrors.
// `resolveEngine`'s OWN behavior must not move a single inch: this is a
// refactor of WHERE the membership is declared, never of WHAT it resolves to.

test('#312 D2: SDD_ENGINES is exported from platform.mjs and holds exactly the two known engines', () => {
  assert.deepEqual([...SDD_ENGINES].sort(), ['gentle-ai', 'plain']);
});

test('#312 D2: resolveEngine via SDD_HARNESS is unchanged — every SDD_ENGINES member still resolves, in that role, and nothing outside it does', () => {
  for (const engine of SDD_ENGINES) {
    const result = resolveEngine({ env: {}, envVars: { SDD_HARNESS: engine } });
    assert.equal(result, engine, `${engine} must still resolve via the legacy SDD_HARNESS fallback`);
  }
  const result = resolveEngine({ env: {}, envVars: { SDD_HARNESS: 'not-a-real-engine' } });
  assert.equal(result, 'gentle-ai', 'an SDD_HARNESS value outside SDD_ENGINES must still fall through to the default, unchanged');
});

test('#312 D2: cli.mjs holds no inline engine-membership literal of its own — SDD_ENGINES is the one declaration', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(
    src, /\[\s*['"]gentle-ai['"]\s*,\s*['"]plain['"]\s*\]/,
    'cli.mjs must read SDD_ENGINES from platform.mjs, not hold its own copy of the engine-axis membership',
  );
});

// ── (b) resolveHarness: .env value used when env var absent ──────────────────

test('resolveHarness: envVars used when env var absent', () => {
  const result = resolveHarness({ env: {}, envVars: { SDD_HARNESS: 'from-file' } });
  assert.equal(result, 'from-file');
});

// ── (c) resolveHarness: defaults to gentle-ai ────────────────────────────────

test('resolveHarness: defaults to gentle-ai when both absent', () => {
  const result = resolveHarness({ env: {}, envVars: {} });
  assert.equal(result, 'gentle-ai');
});

test('resolveHarness: defaults to gentle-ai when env is empty object and no envVars', () => {
  const result = resolveHarness({ env: {} });
  assert.equal(result, 'gentle-ai');
});

// ── (d) dispatch: calls init on the resolved backend ─────────────────────────

test('dispatch: calls init on the resolved backend', async () => {
  const calls = [];
  const fakeBackendLoader = async () => ({
    init: async () => { calls.push('init'); },
  });
  await dispatch('gentle-ai', 'init', [], { backendLoader: fakeBackendLoader });
  assert.deepEqual(calls, ['init']);
});

test('dispatch: forwards extra args to the backend function', async () => {
  const received = [];
  const fakeBackendLoader = async () => ({
    init: async (...args) => { received.push(...args); },
  });
  await dispatch('gentle-ai', 'init', ['extra-arg'], { backendLoader: fakeBackendLoader });
  assert.deepEqual(received, ['extra-arg']);
});

// ── (e) dispatch: unknown harness → error ────────────────────────────────────

test('dispatch: unknown harness (backend not found) → rejects with clear message', async () => {
  const failLoader = async (harness) => {
    throw new Error(`Cannot find module ./backends/${harness}.mjs`);
  };
  await assert.rejects(
    dispatch('nonexistent', 'init', [], { backendLoader: failLoader }),
    /nonexistent/,
  );
});

// ── (f) dispatch: unknown op → error ─────────────────────────────────────────

test('dispatch: unknown op → rejects with clear message', async () => {
  await assert.rejects(
    dispatch('gentle-ai', 'foo', [], { backendLoader: async () => ({}) }),
    /unknown op 'foo'/,
  );
});

// ── (g) dispatch: backend missing the op → error ─────────────────────────────

test('dispatch: backend missing init export → rejects with clear message', async () => {
  const emptyBackend = async () => ({});   // no 'init' exported
  await assert.rejects(
    dispatch('gentle-ai', 'init', [], { backendLoader: emptyBackend }),
    /does not implement op 'init'/,
  );
});

// ── VALID_OPS export ──────────────────────────────────────────────────────────

test('VALID_OPS includes init', () => {
  assert.ok(Array.isArray(VALID_OPS));
  assert.ok(VALID_OPS.includes('init'));
});

// ── #682 C.5 round 2, judgment:cold-1 — the module GRAPH, not the dispatch ────
//
// A backend importing this dispatcher closes a cycle through its own top-level
// await, and the graph never settles: `AGENT_PLATFORM=claude node cli.mjs init`
// exited 13 with `Detected unsettled top-level await` and wrote nothing, on the
// path `bootstrap.sh` runs.
//
// NO TEST IN THIS FILE COULD HAVE SEEN IT, and the reason is structural rather
// than an oversight: every `dispatch` test above injects `backendLoader`, so the
// REAL dynamic import never happens, and the cycle only exists in the real one.
// Faking the loader is right for testing dispatch — it just means dispatch tests
// say nothing about the module graph, which is a second property needing a
// second oracle.
//
// This one reads the graph directly, which is cheap, deterministic, and needs no
// child process: no module a backend can reach may import the dispatcher. That
// is the invariant; the deadlock was one instance of breaking it.

test('#682 cold-1: no backend reaches the dispatcher — the cycle that deadlocked bootstrap', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const { HARNESS_ADAPTER_AXES, harnessAdapterDir } = await import('../axes/lib/harness-adapter-url.mjs');

  const here = dirname(fileURLToPath(import.meta.url));
  // The old `backends/` directory, split by axis in #1141.
  const backendsDirs = HARNESS_ADAPTER_AXES.map((axis) => fileURLToPath(harnessAdapterDir(axis)));

  // Walk the STATIC import graph of every backend, following relative edges.
  const seen = new Set();
  const offenders = [];

  const visit = (file, chain) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { return; }
    for (const m of src.matchAll(/^\s*import\s[^'"]*from\s+['"](\.[^'"]+)['"]/gm)) {
      const target = join(dirname(file), m[1]);
      if (/harness[/\\]cli\.mjs$/.test(target)) {
        offenders.push(`${[...chain, file, target].map((f) => f.replace(here, '')).join(' → ')}`);
        continue;
      }
      visit(target, [...chain, file]);
    }
  };

  const backends = backendsDirs.flatMap((dir) => readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.includes('.test.'))
    .map((f) => join(dir, f)));
  assert.ok(backends.length >= 3, 'the backends directory must still hold backends — otherwise this test is vacuous');

  for (const b of backends) visit(b, []);

  assert.deepEqual(
    offenders, [],
    'a backend reaches harness/cli.mjs through its static imports. cli.mjs dispatches to backends from ' +
    'inside a top-level await, so that edge is a cycle re-entered through a suspended module and the ' +
    'graph never settles — `node cli.mjs init` exits 13 and writes nothing. Anything a backend needs ' +
    'from the dispatcher is not dispatch logic: put it in a leaf, like platform.mjs.'
  );
});
