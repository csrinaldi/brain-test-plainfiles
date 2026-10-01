// cli.reindex-duplicates.test.mjs — issue #574, the REPORTING half, end to end.
//
// The rule is only worth having if a human hears it, and the ticket's complaint
// was precisely that nobody printed anything. So this drives the real CLI in a
// child process against a fixture store (via BRAIN_MEMORY_TEST_ROOT, the same
// test-only seam save/search use) and asserts on what it EMITS — not on a
// return value some caller might again forget to read.
//
// On STDERR specifically: `brain/scripts/hooks/post-merge` runs the CLI with
// `>/dev/null`, deliberately preserving stderr, and post-merge is the moment a
// union merge mints a duplicate. A report on stdout would be discarded on every
// pull — the same outage in a different pipe — so the sink is asserted, not
// just the text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRecord, serializeRecord } from './lib/format.mjs';
import { removeTempTree } from '../lib/tmp-tree.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

const base = {
  ts: '2026-07-04T12:00:00Z',
  actor: '@crinaldi',
  actorKind: 'human',
  type: 'decision',
  project: 'brain',
};

// #738 (design A6, #897 precedent): `brain:memory:save` now reads `brain.actor`
// from the real `git config --get` (cwd = root). Isolated from ambient
// global/system config so this suite's verdict does not depend on the
// machine it runs on.
const ISOLATED_GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function fixtureRoot(t, lines) {
  const root = mkdtempSync(join(tmpdir(), 'brain-cli-dup-'));
  // #802: this fixture now `git init`s root (#738's isolation fixture) — a
  // bare recursive rmSync here would trip the drift guard; removeTempTree instead.
  t.after(() => removeTempTree(root));
  spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...ISOLATED_GIT_ENV } });
  spawnSync('git', ['config', '--local', 'brain.actor', '@test'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...ISOLATED_GIT_ENV } });
  const recordsDir = join(root, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(recordsDir, '2026-07.jsonl'), lines.map((l) => l + '\n').join(''), 'utf8');
  return root;
}

function runCli(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_MEMORY_TEST_ROOT: root, MEMORY_BACKEND: 'plainfiles', ...ISOLATED_GIT_ENV },
  });
}

test('brain:memory:reindex REPORTS the duplicate accounting — the silence #574 opened on', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const b = buildRecord({ ...base, content: 'B' });
  const root = fixtureRoot(t, [serializeRecord(a), serializeRecord(b), serializeRecord(a)]);

  const run = runCli(root, 'reindex');

  assert.equal(run.status, 0, `reindex must still succeed on a duplicated store:\n${run.stderr}`);
  assert.match(run.stdout, /2 record\(s\) indexed/, 'the index count is the unique-id count');
  assert.match(run.stderr, /1 duplicate record id\(s\)/);
  assert.match(run.stderr, /1 excess physical line\(s\)/);
  assert.match(run.stderr, /3 physical line\(s\) → 2 indexed/, 'the store/index gap is stated, not left to arithmetic');
  assert.ok(run.stderr.includes(a.id), 'the duplicated id is named');
  assert.match(run.stderr, /2026-07\.jsonl:1, 2026-07\.jsonl:3/, 'both physical lines are located');
  assert.equal(/duplicate record id/.test(run.stdout), false, 'on stderr, which the hooks preserve — never stdout');
});

test('brain:memory:reindex on a clean store reports NOTHING at all', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const root = fixtureRoot(t, [serializeRecord(a)]);

  const run = runCli(root, 'reindex');

  assert.equal(run.status, 0);
  assert.match(run.stdout, /1 record\(s\) indexed/);
  assert.equal(
    /duplicate/i.test(run.stdout + run.stderr), false,
    'a clean store stays quiet — the report is a signal, not a banner',
  );
});

test('brain:memory:reindex REPORTS a divergent duplicate as divergent, exits 0, and still writes the index', (t) => {
  // Not a refusal: `source` is hash-excluded, and brain's own round-trip
  // widens it, so this pair is a record brain itself writes.
  const a = buildRecord({ ...base, content: 'A', source: 'issue #574' });
  const b = { ...a, source: 'issue #999' };
  const root = fixtureRoot(t, [serializeRecord(a), serializeRecord(b)]);

  const run = runCli(root, 'reindex');

  assert.equal(run.status, 0, `a disagreeing pair must not brick the store:\n${run.stderr}`);
  assert.match(run.stderr, /1 of them DISAGREE outside the hashed fields/);
  assert.match(run.stderr, /\[divergent\]/, 'and the group is marked, not buried in a total');
  assert.match(run.stderr, /first-wins/i, 'the resolution is stated, not left implicit');
  assert.equal(readFileSync(join(root, '.memory', 'index.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
});

// ── the verbs the ticket actually names ──────────────────────────────────────

test('brain:memory:share REPORTS it too — the verb #574 measured as printing nothing', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const root = fixtureRoot(t, [serializeRecord(a), serializeRecord(a)]);

  const run = runCli(root, 'share');

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /1 duplicate record id\(s\)/);
  assert.match(run.stderr, /1 excess physical line\(s\)/);
});

test('brain:memory:save REPORTS it, with the store/index gap — the first verb run after a pull', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const root = fixtureRoot(t, [serializeRecord(a), serializeRecord(a)]);

  const run = runCli(root, 'save', 'A title', 'Some content.', '--type', 'discovery');

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /✓ saved rec-/);
  assert.match(run.stderr, /1 duplicate record id\(s\)/);
  assert.match(run.stderr, /physical line\(s\) → \d+ indexed/, 'indexCount travels with save, not only with reindex');
});

test('memory:search REPORTS it without claiming it touched the index', (t) => {
  const a = buildRecord({ ...base, content: 'A findable decision' });
  const root = fixtureRoot(t, [serializeRecord(a), serializeRecord(a)]);

  const run = runCli(root, 'search', 'findable');

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1 matching record\(s\)/, 'the duplicate is collapsed out of the hit count');
  assert.match(run.stderr, /collapsed into the records read/, 'search never reindexes and does not say it did');
});

test('memory:search on a query that matches NOTHING still says the store repeats, but briefly', (t) => {
  // The accounting is store-wide, so "collapsed into the result set" would have
  // named a collapse that did not happen in this result set — and a question
  // that matched nothing should not be answered with a dozen lines of store
  // history. Counts yes, per-id evidence no.
  const a = buildRecord({ ...base, content: 'A findable decision' });
  const root = fixtureRoot(t, [serializeRecord(a), serializeRecord(a)]);

  const run = runCli(root, 'search', 'zzznomatchzzz');

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no matching records found/);
  assert.match(run.stderr, /1 duplicate record id\(s\)/, 'still reported — brief is not silent');
  assert.match(run.stderr, /memory:reindex.*locations/, 'and it points at the verb that lists them');
  assert.equal(/2026-07\.jsonl:1/.test(run.stderr), false, 'no per-id evidence on a query verb');
});
