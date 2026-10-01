// engines-cli.test.mjs — issue #824: the I/O half against a real child
// process and the REAL in-repo frameworks (plain, gentle-ai — both are
// repo-local data since #814, so this runs on any machine).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { removeTempTree } from '../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'engines-cli.mjs');

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'brain-824-'));
  t.after(() => removeTempTree(root));
  // A custom stage rides along (the #456 shape), so the survey has one answer
  // gentle-ai's recording never saw — the `derived` visibility case is real.
  writeFileSync(join(root, 'brain.config.json'), JSON.stringify({
    schemaVersion: '0.10.0',
    sdd: { stages: { proposal: {}, spec: {}, design: {}, tasks: {}, 'cold-review': { artefact: 'cold-review.md' } } },
  }, null, 2) + '\n', 'utf8');
  return root;
}

const run = (root, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' });

test('#824 cli: the survey reports BOTH frameworks, per stage, and exits 0', (t) => {
  const r = run(world(t));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /plain/);
  assert.match(r.stdout, /gentle-ai/);
  assert.match(r.stdout, /proposal/, 'stages come from the resolved set');
  assert.match(r.stdout, /human/, "plain's agent is visible");
  assert.match(r.stdout, /derived/i, "gentle-ai's unseen-stage answer states its provenance state or the report is a laundering surface");
});

test('#824 cli: --record WRITES — sdd.engines is declared since migration 1.4.0, and the sequencing gate stood down the day it landed', (t) => {
  // This test's previous body pinned the fails-closed state ("while sdd.engines
  // is undeclared") — that WHILE ended when the 1.4.0 promotion merged (#830),
  // exactly as the sequencing consequence predicted. The planner-level
  // fails-closed rule stays pinned in engines-report.test.mjs against a
  // synthetic list WITHOUT the key; here, against the real shipped list, the
  // record path is now the product.
  const root = world(t);
  const r = run(root, '--record');
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(readFileSync(join(root, 'brain.config.json'), 'utf8'));
  // schemaVersion lands at the PACKAGE version, not the migration tail:
  // migrateConfig applies entries up to the installed version, so an entry
  // activates when the package reaches it. That is why this reads the real
  // package.json instead of naming a version: the literal here was '1.1.0'
  // and the 1.4.0 release cut (#848) expired it the moment it shipped. The
  // RELATIONSHIP is the invariant; the number is today's value of it.
  const packageVersion = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ).version;
  assert.equal(cfg.schemaVersion, packageVersion, 'migrated up to the installed package version');
  for (const engine of ['plain', 'gentle-ai']) {
    assert.ok(cfg.sdd.engines[engine], `${engine} recorded`);
    assert.ok(Array.isArray(cfg.sdd.engines[engine].stages) && cfg.sdd.engines[engine].stages.length > 0);
    assert.ok(cfg.sdd.engines[engine].recordedAt, 'the recording is dated');
  }
});

test('#824 cli: no brain.config.json is a named refusal, not a stack trace', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-824-empty-'));
  t.after(() => removeTempTree(root));
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /brain\.config\.json/);
});

// ── round 1 of the cold review — two verified findings ──────────────────────

test('#824 (review r1): a DISABLED stage is visibly disabled — the survey must not launder state either', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-824-disabled-'));
  t.after(() => removeTempTree(root));
  writeFileSync(join(root, 'brain.config.json'), JSON.stringify({
    schemaVersion: '0.10.0',
    sdd: { configs: { tasks: { enabled: false } } },
  }, null, 2) + '\n', 'utf8');
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tasks.*DISABLED/s, 'the state the port computed must reach the operator');
  assert.match(r.stdout, /sdd\.configs/, 'and the reason travels with it');
});

test('#824 (review r1): a recorded entry that no longer matches the survey prints DRIFT — the promise tasks.md made', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-824-drift-'));
  t.after(() => removeTempTree(root));
  writeFileSync(join(root, 'brain.config.json'), JSON.stringify({
    schemaVersion: '0.10.0',
    sdd: { engines: { plain: { recordedAt: '2026-08-01T00:00:00Z', stages: ['proposal', 'spec', 'design', 'tasks', 'retired-stage'] } } },
  }, null, 2) + '\n', 'utf8');
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /drift/i);
  assert.match(r.stdout, /retired-stage/, 'the drifted member is named, not just counted');
});

test('#824 (review r1): a recorded entry that MATCHES prints no drift — silence about agreement, words about change', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-824-nodrift-'));
  t.after(() => removeTempTree(root));
  writeFileSync(join(root, 'brain.config.json'), JSON.stringify({
    schemaVersion: '0.10.0',
    sdd: { engines: { plain: { recordedAt: '2026-08-01T00:00:00Z', stages: ['proposal', 'spec', 'design', 'tasks'] } } },
  }, null, 2) + '\n', 'utf8');
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /drift/i);
});
