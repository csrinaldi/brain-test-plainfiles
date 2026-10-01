// cli.test.mjs — issue #823: the thin I/O half, against real files and a real
// child process. The planner's rules are covered next door; these tests own
// exit codes, the atomic write, and what the operator is TOLD.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { removeTempTree } from '../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

function world(t, config = { docs: { language: 'en' }, schemaVersion: '0.2.0' }) {
  const root = mkdtempSync(join(tmpdir(), 'brain-823-'));
  t.after(() => removeTempTree(root));
  writeFileSync(join(root, 'brain.config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
  return root;
}

const run = (root, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });

test('#823 cli: get prints the resolved value and exits 0', (t) => {
  const r = run(world(t), 'get', 'docs.language');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '"en"');
});

test('#823 cli: get on a missing path says undefined and exits 1 — absence is a reportable answer, not a crash', (t) => {
  const r = run(world(t), 'get', 'docs.nothing');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\.nothing/);
});

test('#823 cli: set writes the value AND the pending migrations, atomically, and says which', (t) => {
  const root = world(t, { docs: { language: 'en' }, schemaVersion: '0.2.0' });
  const r = run(root, 'set', 'docs.language', 'es');
  assert.equal(r.status, 0, r.stderr);
  const next = JSON.parse(readFileSync(join(root, 'brain.config.json'), 'utf8'));
  assert.equal(next.docs.language, 'es');
  assert.ok(next.schemaVersion !== '0.2.0', 'pending migrations ran in the verb — the file says so');
  assert.match(r.stdout, /migration/i, 'the operator is told migrations were applied');
});

test('#823 cli: an unknown path refuses, writes NOTHING, exits 1', (t) => {
  const root = world(t);
  const before = readFileSync(join(root, 'brain.config.json'), 'utf8');
  const r = run(root, 'set', 'docs.lang', 'es');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\.lang/);
  assert.equal(readFileSync(join(root, 'brain.config.json'), 'utf8'), before, 'byte-identical — a refusal writes nothing');
});

test('#823 cli: no brain.config.json is a named refusal, not a stack trace', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-823-empty-'));
  t.after(() => removeTempTree(root));
  const r = run(root, 'get', 'docs.language');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /brain\.config\.json/);
  assert.ok(!/at .*\(/.test(r.stderr), 'no stack trace — this is an operator message');
});

test('#823 cli: usage on a missing op or path', (t) => {
  const r = run(world(t), 'set');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage/);
});

// #906 A6 (measured): the 1.6.0 migration entry is DORMANT until package.json
// is cut to >=1.6.0 — but `deriveKnownPaths` (config-verb.mjs) walks every
// migration's `defaults` with no version filter, so the leaf is settable
// TODAY, version-independent of the installed package.json.
test('#906 A6: memory.lane.enabled is a known settable leaf today, get/set round-trips', (t) => {
  const root = world(t, { docs: { language: 'en' }, schemaVersion: '0.2.0' });
  const setResult = run(root, 'set', 'memory.lane.enabled', 'true');
  assert.equal(setResult.status, 0, setResult.stderr);

  const getResult = run(root, 'get', 'memory.lane.enabled');
  assert.equal(getResult.status, 0, getResult.stderr);
  assert.equal(getResult.stdout.trim(), 'true');
});
