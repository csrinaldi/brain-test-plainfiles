// pre-push integration tests for the issue #890 feature-PR memory retirement.
// The hook keeps checkpointing and repository checks, but no longer transports
// durable records or inspects dirty .memory/ state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK_PATH = new URL('./pre-push', import.meta.url).pathname;
const SAFE_SYSTEM_PATH = '/bin';

function temp(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

function createMockBin({ callLog, fakeRepoRoot, checkpointCode = 0, includeNode = true, rootFailure = false, branch = 'feat/issue-42-demo' }) {
  const bin = temp('pp-bin-');
  if (includeNode) {
    writeFileSync(join(bin, 'node'), [
      '#!/usr/bin/env sh',
      `printf '%s\\n' "$*" >> "${callLog}"`,
      `if [ "$2" = "feature-checkpoint" ]; then exit ${checkpointCode}; fi`,
      'exit 0',
    ].join('\n'));
    chmodSync(join(bin, 'node'), 0o755);
  }
  writeFileSync(join(bin, 'git'), [
    '#!/usr/bin/env sh',
    'if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then',
    rootFailure ? '  exit 1' : `  printf '%s\\n' "${fakeRepoRoot}"`,
    'elif [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then',
    `  printf '%s\\n' "${branch}"`,
    'elif [ "$1" = "merge-base" ]; then',
    '  exit 1',
    'elif [ "$1" = "-C" ]; then',
    '  printf ""',
    'fi',
    'exit 0',
  ].join('\n'));
  chmodSync(join(bin, 'git'), 0o755);
  return bin;
}

function runHook(bin, args = ['refs/heads/main', 'refs/heads/feature'], input = '') {
  return spawnSync('sh', [HOOK_PATH, ...args], {
    input,
    env: { PATH: `${bin}:${SAFE_SYSTEM_PATH}`, HOME: process.env.HOME ?? '/tmp' },
    encoding: 'utf8',
    timeout: 5000,
  });
}

function calls(path) {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function fixture(t, { feature = true, ...opts } = {}) {
  const root = temp('pp-root-');
  const log = join(root, 'calls.log');
  if (feature) mkdirSync(join(root, 'openspec', 'changes', 'issue-42-demo'), { recursive: true });
  const bin = createMockBin({ callLog: log, fakeRepoRoot: root, ...opts });
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); });
  return { root, log, bin };
}

test('pre-push: checkpoint runs for an active feature without share, ship, or brain:save', (t) => {
  const { log, bin } = fixture(t);
  const result = runHook(bin);
  const lines = calls(log);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lines.filter(line => line.includes('feature-checkpoint')).length, 1);
  assert.equal(lines.some(line => /(^| )share( |$)|brain-save|(^| )ship( |$)/.test(line)), false,
    `retired transport must not run: ${JSON.stringify(lines)}`);
});

test('pre-push: no feature directory means no checkpoint and no memory dependency', (t) => {
  const { log, bin } = fixture(t, { feature: false });
  const result = runHook(bin);
  const lines = calls(log);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lines.some(line => line.includes('feature-checkpoint')), false);
  assert.equal(lines.some(line => line.includes('share') || line.includes('brain-save')), false);
});

test('pre-push: checkpoint failure remains isolated from push result', (t) => {
  const { log, bin } = fixture(t, { checkpointCode: 1 });
  const result = runHook(bin);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls(log).some(line => line.includes('feature-checkpoint')), true);
});

test('pre-push: root resolution failure stops before node work', (t) => {
  const { log, bin } = fixture(t, { rootFailure: true });
  const result = runHook(bin);
  assert.notEqual(result.status, 0);
  assert.equal(calls(log).length, 0, 'node must not run without a canonical root');
  assert.match(result.stderr, /repo root|root/i);
});

test('pre-push: node absence remains a non-blocking no-op', (t) => {
  const { log, bin } = fixture(t, { includeNode: false });
  const result = runHook(bin);
  assert.equal(result.status, 0);
  assert.equal(calls(log).length, 0);
});

test('pre-push: tracking, first-push, and explicit-refspec forms share one checkpoint-only path', (t) => {
  for (const args of [[], ['-u', 'origin', 'feat/issue-42-demo'], ['origin', 'HEAD:refs/heads/review']]) {
    const { log, bin, root } = fixture(t);
    const result = runHook(bin, args, `${root} refs/heads/main\n`);
    const lines = calls(log);
    assert.equal(result.status, 0, `args ${args.join(' ')}: ${result.stderr}`);
    assert.equal(lines.filter(line => line.includes('feature-checkpoint')).length, 1);
    assert.equal(lines.some(line => line.includes('share') || line.includes('brain-save') || line.includes('ship')), false);
  }
});

test('#1165 pre-push: a checkpoint skipped because the backend is undeclared SAYS so, and still never blocks the push', (t) => {
  const { bin } = fixture(t, { checkpointCode: 3 });
  const result = runHook(bin);
  assert.equal(result.status, 0, 'non-blocking by design');
  assert.match(result.stderr, /feature checkpoint skipped — memory backend not declared/);
  assert.match(result.stderr, /brain:config -- set memory\.backend/);
});

test('#1165 pre-push: a checkpoint that fails for any OTHER reason stays as quiet as before', (t) => {
  const { bin } = fixture(t, { checkpointCode: 1 });
  const result = runHook(bin);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /not declared/);
});
