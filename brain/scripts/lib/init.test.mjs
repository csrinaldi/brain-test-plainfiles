// init.test.mjs — `npx brain init` (issue #400). Pure/dispatch layer only; the
// spawned path is proven by test/fresh-install across all four package managers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../cli-entry.mjs', import.meta.url));

import {
  BOOTSTRAP_SCRIPT_KEY,
  BOOTSTRAP_SCRIPT_VALUE,
  evaluateInitPreconditions,
  helpText,
  resolveInstalledTag,
  writeBootstrapAlias,
} from './init.mjs';
import { main, runInit } from '../cli-entry.mjs';

// ── resolveInstalledTag (REQ-400-4) ─────────────────────────────────────────

test('resolveInstalledTag: reads the INSTALLED package version and v-prefixes it', () => {
  const tag = resolveInstalledTag({
    root: '/repo',
    exists: () => true,
    readFile: () => JSON.stringify({ name: 'brain', version: '1.2.3' }),
  });
  assert.equal(tag, 'v1.2.3');
});

test('resolveInstalledTag: absent node_modules/brain → null (caller refuses, never guesses)', () => {
  assert.equal(resolveInstalledTag({ root: '/repo', exists: () => false }), null);
});

test('resolveInstalledTag: unparseable or version-less package.json → null', () => {
  assert.equal(resolveInstalledTag({ root: '/r', exists: () => true, readFile: () => 'not json' }), null);
  assert.equal(resolveInstalledTag({ root: '/r', exists: () => true, readFile: () => '{"name":"brain"}' }), null);
});

// ── evaluateInitPreconditions (REQ-400-5) ───────────────────────────────────

test('evaluateInitPreconditions: a consumer repo with a package.json proceeds', () => {
  assert.deepEqual(evaluateInitPreconditions({ hasPackageJson: true, isBrainSource: false }), { ok: true });
});

test('evaluateInitPreconditions: no package.json → refuse, naming the remedy', () => {
  const r = evaluateInitPreconditions({ hasPackageJson: false, isBrainSource: false });
  assert.equal(r.ok, false);
  assert.match(r.remedy, /npm init/);
});

test('evaluateInitPreconditions: brain\'s own repo → refuse even with a package.json', () => {
  // The marker wins: init here would rewrite brain's own scripts.
  const r = evaluateInitPreconditions({ hasPackageJson: true, isBrainSource: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /brain-source/);
});

// ── writeBootstrapAlias (REQ-400-2, REQ-400-3) ──────────────────────────────

test('writeBootstrapAlias: adds the bootstrap alias to a consumer without one', () => {
  let written = null;
  const r = writeBootstrapAlias({
    pkgPath: '/repo/package.json',
    readFile: () => JSON.stringify({ name: 'consumer', scripts: { test: 'vitest' } }, null, 2) + '\n',
    writeFile: (_p, content) => { written = content; },
  });
  assert.equal(r.written, true);
  assert.equal(r.alreadyPresent, false);
  const parsed = JSON.parse(written);
  assert.equal(parsed.scripts[BOOTSTRAP_SCRIPT_KEY], BOOTSTRAP_SCRIPT_VALUE);
  assert.equal(parsed.scripts.test, 'vitest', 'consumer scripts must survive');
  assert.equal(parsed.name, 'consumer', 'top-level consumer fields must survive');
});

test('writeBootstrapAlias: a consumer\'s OWN brain:upgrade is never overwritten (REQ-400-3)', () => {
  let written = null;
  const consumer = JSON.stringify({
    scripts: { [BOOTSTRAP_SCRIPT_KEY]: 'my-own-upgrade-wrapper' },
  }, null, 2) + '\n';
  const r = writeBootstrapAlias({
    pkgPath: '/repo/package.json',
    readFile: () => consumer,
    writeFile: (_p, c) => { written = c; },
  });
  assert.equal(r.alreadyPresent, true);
  assert.equal(r.written, false, 'identical bytes → no write at all');
  assert.equal(written, null);
});

test('writeBootstrapAlias: second run is a no-op — idempotent (REQ-400-2)', () => {
  let current = JSON.stringify({ scripts: {} }, null, 2) + '\n';
  const run = () => writeBootstrapAlias({
    pkgPath: '/p',
    readFile: () => current,
    writeFile: (_p, c) => { current = c; },
  });
  assert.equal(run().written, true);
  assert.equal(run().written, false, 're-running init must not churn the file');
});

// ── helpText (REQ-400-7) ────────────────────────────────────────────────────

test('helpText: lists init, the bootstrap alias, and the AGENT_PLATFORM escape hatch', () => {
  const h = helpText();
  assert.match(h, /npx brain init/);
  assert.match(h, new RegExp(BOOTSTRAP_SCRIPT_KEY));
  assert.match(h, /brain:day:start/, 'the merged verb surface must be discoverable');
  assert.match(h, /AGENT_PLATFORM/);
  assert.match(h, /brain:env:init/, 'the interactive next step must be named');
});

// A consumer repo: everything exists EXCEPT brain's own `.brain-source` marker.
// `exists: () => true` would make the marker present too and refuse before the
// spawn — which silently turned an exit-code assertion into a refusal assertion.
const consumerExists = (p) => !p.endsWith('.brain-source');
const consumerPkg = () => JSON.stringify({ name: 'consumer', scripts: {} }, null, 2) + '\n';

// ── dispatch + exit codes (REQ-400-1, REQ-400-7, REQ-400-8) ─────────────────

test('main: no subcommand and --help both print help and exit 0', () => {
  for (const argv of [[], ['--help'], ['-h'], ['help']]) {
    const lines = [];
    assert.equal(main(argv, { log: (s) => lines.push(s) }), 0);
    assert.match(lines.join('\n'), /Usage:/);
  }
});

test('main: an unknown command exits non-zero and shows the verb list', () => {
  const errors = [];
  assert.equal(main(['bogus'], { log: () => {}, error: (s) => errors.push(s) }), 1);
  assert.match(errors.join('\n'), /unknown command "bogus"/);
});

test('runInit: refuses without a package.json — no spawn, no write', () => {
  let spawned = false;
  const code = runInit({
    root: '/empty',
    exists: () => false,
    spawn: () => { spawned = true; return { status: 0 }; },
    log: () => {}, error: () => {},
  });
  assert.equal(code, 1);
  assert.equal(spawned, false, 'refusing must not reach the upgrade');
});

test('runInit: refuses when the installed version is unreadable — never guesses a tag (REQ-400-4)', () => {
  let spawned = false;
  const errors = [];
  const code = runInit({
    root: '/repo',
    // package.json exists; node_modules/brain/package.json does not.
    exists: (p) => p.endsWith('package.json') && !p.includes('node_modules'),
    spawn: () => { spawned = true; return { status: 0 }; },
    log: () => {}, error: (s) => errors.push(s),
  });
  assert.equal(code, 1);
  assert.equal(spawned, false);
  assert.match(errors.join('\n'), /did not pin/, 'the refusal must say why guessing is worse');
});

test('runInit: an explicit tag argument overrides the installed version', () => {
  let spawnArgs = null;
  const code = runInit({
    root: '/repo',
    argTag: 'v9.9.9',
    exists: consumerExists,
    readFile: consumerPkg,
    writeFile: () => {},
    spawn: (_bin, args) => { spawnArgs = args; return { status: 0 }; },
    log: () => {}, error: () => {},
  });
  assert.equal(code, 0);
  assert.ok(spawnArgs.includes('v9.9.9'));
});

test('runInit: a failed upgrade propagates its exit code — never reports success (REQ-400-8)', () => {
  const code = runInit({
    root: '/repo',
    argTag: 'v1.0.0',
    exists: consumerExists,
    readFile: consumerPkg,
    writeFile: () => {},
    spawn: () => ({ status: 3 }),
    log: () => {}, error: () => {},
  });
  assert.equal(code, 3, 'a scripted adoption must not read a failed install as success');
});

test('runInit: a killed upgrade (status null) still exits non-zero', () => {
  const code = runInit({
    root: '/repo', argTag: 'v1.0.0', exists: consumerExists, readFile: consumerPkg, writeFile: () => {},
    spawn: () => ({ status: null }), log: () => {}, error: () => {},
  });
  assert.equal(code, 1);
});

test('runInit: on success it reports brain:env:init but never runs it (REQ-400-6)', () => {
  const lines = [];
  let spawnCount = 0;
  const code = runInit({
    root: '/repo', argTag: 'v1.0.0', exists: consumerExists, readFile: consumerPkg, writeFile: () => {},
    spawn: () => { spawnCount++; return { status: 0 }; },
    log: (s) => lines.push(s), error: () => {},
  });
  assert.equal(code, 0);
  assert.equal(spawnCount, 1, 'exactly one spawn — the upgrade; the interactive step is only reported');
  assert.match(lines.join('\n'), /brain:env:init/);
});

// ── The spawned entry path (REQ-400-1) ──────────────────────────────────────
//
// Every test above imports `main` directly, so NONE of them can see whether the
// file actually runs when executed. It did not: the entry guard compared
// `import.meta.url` against an UNRESOLVED `process.argv[1]`, and a package manager
// installs a `bin` as a symlink — so the command exited 0 printing nothing, in the
// only way it is ever invoked in production. Caught by installing brain into a
// scratch consumer repo, not by the suite. These two cases close that gap cheaply;
// test/fresh-install still proves the four-package-manager story.

test('cli-entry: executing the file runs main and prints help (not a silent exit 0)', () => {
  const r = spawnSync(process.execPath, [ENTRY, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/, 'a silent exit 0 means the entry guard never fired');
});

test('cli-entry: executing it through a SYMLINK still runs main (the bin install shape)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-bin-'));
  const link = join(dir, 'brain');
  try {
    symlinkSync(ENTRY, link);
    const r = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/, 'argv[1] is the LINK; the guard must resolve it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
