import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runStage } from './codex.mjs';

function makePaths(t) {
  const root = mkdtempSync(join(tmpdir(), 'codex-backend-'));
  const candidate = join(root, 'candidate');
  const outputDir = join(root, 'host-output');
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
  mkdirSync(candidate);
  mkdirSync(outputDir);
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'auth.json'), '{"access_token":"oauth-secret"}\n', { mode: 0o600 });
  t.after(() => import('../../../__fixtures__/tmp-tree.mjs').then(({ removeTempTree }) => removeTempTree(root)));
  return {
    root, candidate, home, codexHome,
    tempPath: join(outputDir, 'last-message.md'), artifactPath: join(outputDir, 'cold-review.md'),
  };
}

function output(paths) {
  return { mode: 'final-message', tempPath: paths.tempPath, artifactPath: paths.artifactPath };
}

const BASE_ENV = {
  PATH: process.env.PATH ?? '',
  SAFE_VALUE: 'kept',
  BRAIN_REVIEWER_TOKEN: 'secret',
  GH_TOKEN: 'secret',
};

function testEnv(paths, extra = {}) {
  return { ...BASE_ENV, HOME: paths.home, ...extra };
}

test('runs exact read-only gpt-5.5 argv with scrubbed environment and isolated writable CODEX_HOME', async (t) => {
  const paths = makePaths(t);
  let seen;
  const result = await runStage({
    stage: 'cold-review',
    prompt: 'return the review artifact',
    model: 'gpt-5.5',
    cwd: paths.candidate,
    credentialEnv: ['BRAIN_REVIEWER_TOKEN'],
    forgeConfigDir: join(paths.root, 'forge-shadow'),
    output: output(paths),
    _env: testEnv(paths),
    _run: (bin, args, opts) => {
      seen = { bin, args, opts };
      assert.equal(readFileSync(join(opts.env.CODEX_HOME, 'auth.json'), 'utf8'), '{"access_token":"oauth-secret"}\n');
      assert.equal(statSync(opts.env.CODEX_HOME).mode & 0o777, 0o700);
      assert.equal(statSync(join(opts.env.CODEX_HOME, 'auth.json')).mode & 0o777, 0o600);
      writeFileSync(paths.tempPath, '```brain-findings/1\n[]\n```\n');
      return { status: 0 };
    },
  });

  assert.deepEqual(result.ok, true);
  assert.equal(seen.bin, 'codex');
  assert.deepEqual(seen.args, [
    'exec', '--model', 'gpt-5.5', '--sandbox', 'read-only', '--cd', paths.candidate,
    '--skip-git-repo-check', '--ephemeral', '--ignore-user-config',
    '--output-last-message', paths.tempPath, 'return the review artifact',
  ]);
  assert.equal(seen.opts.cwd, paths.candidate);
  assert.equal(seen.opts.env.SAFE_VALUE, 'kept');
  assert.equal(seen.opts.env.BRAIN_REVIEWER_TOKEN, undefined);
  assert.equal(seen.opts.env.GH_TOKEN, undefined);
  assert.equal(seen.opts.env.GH_CONFIG_DIR, join(paths.root, 'forge-shadow'));
  assert.equal(seen.opts.env.GLAB_CONFIG_DIR, join(paths.root, 'forge-shadow'));
  assert.notEqual(seen.opts.env.CODEX_HOME, paths.codexHome);
  assert.ok(!existsSync(seen.opts.env.CODEX_HOME), 'the per-run Codex home is removed after the result is captured');
});

test('prefers auth.json from CODEX_HOME over the HOME fallback and copies no other config', async (t) => {
  const paths = makePaths(t);
  const configuredHome = join(paths.root, 'configured-codex-home');
  mkdirSync(configuredHome);
  writeFileSync(join(configuredHome, 'auth.json'), '{"access_token":"configured-oauth"}\n', { mode: 0o644 });
  writeFileSync(join(configuredHome, 'config.toml'), 'untrusted config must not travel\n');
  let seenHome;

  const result = await runStage({
    stage: 'cold-review', prompt: 'p', model: 'gpt-5.5', cwd: paths.candidate,
    output: output(paths), _env: testEnv(paths, { CODEX_HOME: configuredHome }),
    _run: (_bin, _args, opts) => {
      seenHome = opts.env.CODEX_HOME;
      assert.equal(readFileSync(join(seenHome, 'auth.json'), 'utf8'), '{"access_token":"configured-oauth"}\n');
      assert.equal(existsSync(join(seenHome, 'config.toml')), false);
      writeFileSync(paths.tempPath, 'ok');
      return { status: 0 };
    },
  });

  assert.equal(result.ok, true);
  assert.ok(!existsSync(seenHome));
});

test('refuses before spawning with a clear OAuth diagnostic when no auth.json is available', async (t) => {
  const paths = makePaths(t);
  let spawned = false;
  let madeHome = false;
  const result = await runStage({
    stage: 'cold-review', prompt: 'p', model: 'gpt-5.5', cwd: paths.candidate,
    output: output(paths), _env: { ...BASE_ENV, HOME: join(paths.root, 'empty-home') },
    _makeCodexHome: () => { madeHome = true; return join(paths.root, 'should-not-exist'); },
    _run: () => { spawned = true; return { status: 0 }; },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /OAuth authentication is unavailable/i);
  assert.match(result.reason, /auth\.json.*\$CODEX_HOME.*\$HOME\/\.codex/i);
  assert.match(result.reason, /codex login/i);
  assert.equal(madeHome, false);
  assert.equal(spawned, false);
});

test('refuses unsafe output paths inside the candidate before spawning', async (t) => {
  const paths = makePaths(t);
  let spawned = false;
  const result = await runStage({
    stage: 'cold-review', prompt: 'p', model: 'gpt-5.5', cwd: paths.candidate,
    output: { mode: 'final-message', tempPath: join(paths.candidate, 'result.md'), artifactPath: paths.artifactPath },
    _env: testEnv(paths),
    _run: () => { spawned = true; return { status: 0 }; },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /outside the candidate/i);
  assert.equal(spawned, false);
});

test('fails closed for timeout, non-zero exit, and missing final-message output', async (t) => {
  const paths = makePaths(t);
  const cases = [
    { name: 'timeout', run: () => ({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }), expected: /did not finish/i },
    { name: 'non-zero', run: () => ({ status: 2, stderr: 'authentication unavailable' }), expected: /exited with status 2/i },
    { name: 'missing output', run: () => ({ status: 0 }), expected: /wrote no final message/i },
  ];

  for (const entry of cases) {
    const result = await runStage({
      stage: 'cold-review', prompt: 'p', model: 'gpt-5.5', cwd: paths.candidate,
      output: output(paths), _env: testEnv(paths), _run: entry.run,
    });
    assert.equal(result.ok, false, entry.name);
    assert.match(result.reason, entry.expected, entry.name);
  }
});

test('fails closed when isolated-home cleanup cannot be proved', async (t) => {
  const paths = makePaths(t);
  const result = await runStage({
    stage: 'cold-review', prompt: 'p', model: 'gpt-5.5', cwd: paths.candidate,
    output: output(paths), _env: testEnv(paths),
    _makeCodexHome: () => { const home = join(paths.root, 'isolated-home'); mkdirSync(home); return home; },
    _removeCodexHome: () => { throw new Error('cleanup denied'); },
    _run: () => { writeFileSync(paths.tempPath, 'ok'); return { status: 0 }; },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /cleanup/i);
  assert.match(result.reason, /cleanup denied/i);
});

test('cleans the isolated home when copying OAuth authentication fails', async (t) => {
  const paths = makePaths(t);
  const isolatedHome = join(paths.root, 'isolated-home');
  let spawned = false;
  const result = await runStage({
    stage: 'cold-review', prompt: 'p', model: 'gpt-5.5', cwd: paths.candidate,
    output: output(paths), _env: testEnv(paths),
    _makeCodexHome: () => { mkdirSync(isolatedHome); return isolatedHome; },
    _copyAuth: () => { throw new Error('copy denied'); },
    _run: () => { spawned = true; return { status: 0 }; },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /OAuth authentication could not be prepared/i);
  assert.match(result.reason, /copy denied/i);
  assert.equal(spawned, false);
  assert.equal(existsSync(isolatedHome), false);
});
