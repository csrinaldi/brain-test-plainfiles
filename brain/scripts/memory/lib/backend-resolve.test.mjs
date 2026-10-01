// backend-resolve.test.mjs — the ONE memory-backend resolver (issue #1165).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveMemoryBackend, MEMORY_BACKENDS } from './backend-resolve.mjs';
import { resolveAxisSelector } from '../../lib/axis-selector.mjs';
import { testTmp } from '../../lib/test-tmp.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'backend-resolve.mjs');

function root({ env, config } = {}) {
  const dir = testTmp('backend-resolve-');
  if (env !== undefined) writeFileSync(join(dir, '.env'), env);
  if (config !== undefined) writeFileSync(join(dir, 'brain.config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  return dir;
}

test('the closed set is exactly the two adapters', () => {
  assert.deepEqual([...MEMORY_BACKENDS], ['engram', 'plainfiles']);
});

test('precedence: shell > .env > config > none, each with its source', () => {
  const dir = root({ env: 'MEMORY_BACKEND=engram\n', config: { memory: { backend: 'plainfiles' } } });
  assert.deepEqual(
    [resolveMemoryBackend({ root: dir, env: { MEMORY_BACKEND: 'plainfiles' } }).source,
     resolveMemoryBackend({ root: dir, env: { MEMORY_BACKEND: 'plainfiles' } }).backend],
    ['shell', 'plainfiles']);
  const f = resolveMemoryBackend({ root: dir, env: {} });
  assert.deepEqual([f.backend, f.source], ['engram', 'file']);
  assert.deepEqual(f.shadowed, [{ source: 'config', value: 'plainfiles' }], 'the losing team value is reported');
  const c = resolveMemoryBackend({ root: root({ config: { memory: { backend: 'plainfiles' } } }), env: {} });
  assert.deepEqual([c.backend, c.source], ['plainfiles', 'config']);
  const n = resolveMemoryBackend({ root: root({}), env: {} });
  assert.deepEqual([n.backend, n.source, n.status], [null, 'none', 'undeclared']);
});

test('an empty value is undeclared at every level, and does not hide a lower one', () => {
  const dir = root({ env: 'MEMORY_BACKEND=\n', config: { memory: { backend: 'plainfiles' } } });
  assert.equal(resolveMemoryBackend({ root: dir, env: { MEMORY_BACKEND: '' } }).backend, 'plainfiles');
  const dir2 = root({ env: 'MEMORY_BACKEND=engram\n' });
  assert.equal(resolveMemoryBackend({ root: dir2, env: { MEMORY_BACKEND: '' } }).backend, 'engram', 'empty shell falls through to .env');
});

test('an unknown value is invalid, never coerced', () => {
  const r = resolveMemoryBackend({ root: root({ config: { memory: { backend: 'plainfile' } } }), env: {} });
  assert.deepEqual([r.status, r.backend, r.invalidValue, r.source], ['invalid', null, 'plainfile', 'config']);
});

test('an unreadable config is reported, and .env still resolves', () => {
  const dir = root({ env: 'MEMORY_BACKEND=plainfiles\n', config: '{ not json' });
  const r = resolveMemoryBackend({ root: dir, env: {} });
  assert.equal(r.backend, 'plainfiles');
  assert.match(r.configError, /brain\.config\.json/);
  const none = resolveMemoryBackend({ root: root({ config: '{ not json' }), env: {} });
  assert.equal(none.status, 'undeclared');
  assert.match(none.configError, /brain\.config\.json/, '"could not look" is not silently "declared nothing"');
});

test('axis-selector is generic: another axis resolves through the same precedence', () => {
  const r = resolveAxisSelector({ key: 'SDD_ENGINE', configPath: 'sdd.engine', allowed: ['gentle-ai', 'openspec'],
    config: { sdd: { engine: 'openspec' } }, env: {}, root: root({}) });
  assert.deepEqual([r.value, r.source, r.valid], ['openspec', 'config', true]);
});

test('CLI (the bash reader): declared -> "<backend> <source>" exit 0; undeclared -> exit 3; invalid -> exit 4', () => {
  const run = (dir, env = {}) => spawnSync(process.execPath, [CLI, '--root', dir], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const ok = run(root({ config: { memory: { backend: 'plainfiles' } } }));
  assert.deepEqual([ok.status, ok.stdout], [0, 'plainfiles config\n']);
  const none = run(root({}));
  assert.deepEqual([none.status, none.stdout], [3, '']);
  const bad = run(root({ config: { memory: { backend: 'zzz' } } }));
  assert.deepEqual([bad.status, bad.stdout], [4, '! zzz config\n']);
  const viaEnv = run(root({ config: { memory: { backend: 'plainfiles' } } }), { MEMORY_BACKEND: 'engram' });
  assert.equal(viaEnv.stdout, 'engram shell\n');
});

test('#1165 S1 self-hosting: THIS repository declares its own backend in tracked config (per-issue worktrees have no .env)', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const r = resolveMemoryBackend({ root: repo, env: {}, envFile: join(root({}), 'no-such-env') });
  assert.deepEqual([r.status, r.backend, r.source], ['declared', 'engram', 'config']);
});

// ── S4: brain:upgrade names the fix when the migration leaves the backend undeclared ──
import { undeclaredUpgradeNotice } from './backend-resolve.mjs';

test('#1165 S4 undeclaredUpgradeNotice: undeclared after migration -> one line naming the fix; declared anywhere -> null', () => {
  const none = undeclaredUpgradeNotice({ root: root({ config: { memory: { backend: '' } } }), env: {} });
  assert.match(none, /memory\.backend/);
  assert.match(none, /brain:config -- set memory\.backend/);
  assert.equal(undeclaredUpgradeNotice({ root: root({ config: { memory: { backend: 'plainfiles' } } }), env: {} }), null);
  assert.equal(undeclaredUpgradeNotice({ root: root({ config: { memory: { backend: '' } }, env: 'MEMORY_BACKEND=engram\n' }), env: {} }), null, '.env declares one: nothing to say');
  assert.equal(undeclaredUpgradeNotice({ root: root({ config: { memory: { backend: '' } } }), env: { MEMORY_BACKEND: 'engram' } }), null);
});

// ── cold-5: "could not look" must not read as "declared nothing" ────────────────────
test('#1165 cold-5 the resolver CLI: an unreadable config with nothing else declared exits 5 and says why on stderr, not 3', () => {
  const r = spawnSync(process.execPath, [CLI, '--root', root({ config: '{ not json' })], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 5);
  assert.match(r.stderr, /brain\.config\.json/);
});
