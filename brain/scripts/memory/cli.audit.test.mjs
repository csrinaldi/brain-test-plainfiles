// cli.audit.test.mjs — `brain:memory:audit` through the real CLI (#870), against a
// fixture store under BRAIN_MEMORY_TEST_ROOT with its own git history, so the
// argument handling, the text/JSON rendering and the exit codes are exercised
// end to end. Added after the rev-1 cold review of PR #871.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { testTmp } from '../lib/test-tmp.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function fixtureRepo({ withRecords = true } = {}) {
  const root = testTmp('cli-audit-');
  git(root, 'init', '-q');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'root');
  if (withRecords) {
    const dir = join(root, '.memory', 'records');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-09-rec-aaaa.jsonl'), '{"id":"rec-aaaa","ts":"2026-09-01T00:00:00Z","actor":"@me","issue":7}\n', 'utf8');
    writeFileSync(join(root, '.memory', 'index.jsonl'), '{"id":"rec-aaaa"}\n', 'utf8');
    git(root, 'add', '.memory');
    git(root, 'commit', '-q', '-m', 'chore(memory): one record');
  }
  return root;
}

function runCli(root, ...args) {
  return spawnSync(process.execPath, [CLI, 'audit', ...args], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_MEMORY_TEST_ROOT: root, MEMORY_BACKEND: 'plainfiles' },
  });
}

test('brain:memory:audit prints every row from a fixture store with git history', () => {
  const run = runCli(fixtureRepo(), '--since', '2026-08-01');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /learn→main\s+n 1 ·/);
  assert.match(run.stdout, /records\s+lines 1 · distinct 1 · excess 0/);
  assert.match(run.stdout, /handle 1/);
  assert.match(run.stdout, /issue 1\/1/);
  assert.match(run.stdout, /backend\s+plainfiles index \(vacuity row\) · rows 1 · distinct 1/);
});

test('brain:memory:audit --json is the same report as one object', () => {
  const run = runCli(fixtureRepo(), '--json', '--since', '2026-08-01');
  assert.equal(run.status, 0, run.stderr);
  const o = JSON.parse(run.stdout);
  assert.equal(o.latency.n, 1);
  assert.equal(o.backend.measured, true);
  assert.equal(o.window.sinceIso, '2026-08-01T00:00:00Z');
});

test('brain:memory:audit --since with a non-date exits 1 and says so', () => {
  const run = runCli(fixtureRepo(), '--since', 'nope');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--since is not a date — nope/);
});

test('brain:memory:audit with a trailing --since (no value) exits 1 — it does not fall back to the default window', () => {
  const run = runCli(fixtureRepo(), '--since');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--since/);
});

test('brain:memory:audit with --since swallowed by the next flag exits 1', () => {
  const run = runCli(fixtureRepo(), '--since', '--json');
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--since/);
});

test('brain:memory:audit with no records dir exits 1 naming the path — no zeros', () => {
  const run = runCli(fixtureRepo({ withRecords: false }));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /records dir not found/);
  assert.doesNotMatch(run.stdout, /lines 0/);
});
