import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runStage, deduplicateFindingsBlocks, canonicalPath, isWithin, hasAgyAuth, GEMINI_MODEL } from './gemini.mjs';

function makePaths(t) {
  const root = mkdtempSync(join(tmpdir(), 'gemini-backend-'));
  const candidate = join(root, 'candidate');
  const outputDir = join(root, 'host-output');
  mkdirSync(candidate);
  mkdirSync(outputDir);
  t.after(() => import('../../../__fixtures__/tmp-tree.mjs').then(({ removeTempTree }) => removeTempTree(root)));
  return {
    root,
    candidate,
    tempPath: join(outputDir, 'last-message.md'),
    artifactPath: join(outputDir, 'cold-review.md'),
  };
}

function output(paths) {
  return { mode: 'final-message', tempPath: paths.tempPath, artifactPath: paths.artifactPath };
}

const FAKE_KEY = ['gemini', 'fixture', 'value'].join('-');
const BASE_ENV = {
  PATH: process.env.PATH ?? '',
  SAFE_VALUE: 'kept',
  BRAIN_REVIEWER_TOKEN: 'secret',
  GH_TOKEN: 'secret',
  GEMINI_API_KEY: FAKE_KEY,
};

test('runs exact agy argv for Google AI Pro subscription with scrubbed environment', async (t) => {
  const paths = makePaths(t);
  let seen;
  const result = await runStage({
    stage: 'cold-review',
    prompt: 'return the review artifact',
    model: 'gemini-3.1-pro-high',
    cwd: paths.candidate,
    credentialEnv: ['BRAIN_REVIEWER_TOKEN'],
    forgeConfigDir: join(paths.root, 'forge-shadow'),
    output: output(paths),
    _env: { ...BASE_ENV },
    _commandExists: (bin) => bin === 'agy',
    _hasAgyAuth: () => true,
    _run: (bin, args, opts) => {
      seen = { bin, args, opts };
      return { status: 0, stdout: '```brain-findings/1\n[]\n```\n' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(seen.bin, 'agy');
  assert.deepEqual(seen.args, [
    '-p', 'return the review artifact',
    '--model', 'gemini-3.1-pro-high',
    '--sandbox',
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
  ]);
  assert.equal(seen.opts.cwd, paths.candidate);
  assert.equal(seen.opts.env.SAFE_VALUE, 'kept');
  assert.equal(seen.opts.env.GEMINI_API_KEY, undefined);
  assert.equal(seen.opts.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(seen.opts.env.BRAIN_REVIEWER_TOKEN, undefined);
  assert.equal(seen.opts.env.GH_TOKEN, undefined);
  assert.equal(seen.opts.env.GH_CONFIG_DIR, join(paths.root, 'forge-shadow'));
  assert.equal(seen.opts.env.GLAB_CONFIG_DIR, join(paths.root, 'forge-shadow'));
  assert.equal(readFileSync(paths.tempPath, 'utf8'), '```brain-findings/1\n[]\n```');
});

test('runs exact gemini argv with scrubbed environment and final-message output', async (t) => {
  const paths = makePaths(t);
  let seen;
  const result = await runStage({
    stage: 'cold-review',
    prompt: 'return the review artifact',
    model: 'gemini-2.5-pro',
    cwd: paths.candidate,
    credentialEnv: ['BRAIN_REVIEWER_TOKEN'],
    forgeConfigDir: join(paths.root, 'forge-shadow'),
    output: output(paths),
    _env: { ...BASE_ENV },
    _commandExists: (bin) => bin === 'gemini',
    _run: (bin, args, opts) => {
      seen = { bin, args, opts };
      writeFileSync(paths.tempPath, '```brain-findings/1\n[]\n```\n');
      return { status: 0 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(seen.bin, 'gemini');
  assert.deepEqual(seen.args, [
    '-p', 'return the review artifact',
    '-m', 'gemini-2.5-pro',
    '--approval-mode', 'plan',
  ]);
  assert.equal(seen.opts.cwd, paths.candidate);
  assert.equal(seen.opts.env.SAFE_VALUE, 'kept');
  assert.equal(seen.opts.env.GEMINI_API_KEY, FAKE_KEY);
  assert.equal(seen.opts.env.BRAIN_REVIEWER_TOKEN, undefined);
  assert.equal(seen.opts.env.GH_TOKEN, undefined);
  assert.equal(seen.opts.env.GH_CONFIG_DIR, join(paths.root, 'forge-shadow'));
  assert.equal(seen.opts.env.GLAB_CONFIG_DIR, join(paths.root, 'forge-shadow'));
});

test('refuses before spawning when neither agy nor GEMINI_API_KEY/GOOGLE_APPLICATION_CREDENTIALS is set', async (t) => {
  const paths = makePaths(t);
  let spawned = false;
  const envWithoutKey = { ...BASE_ENV };
  delete envWithoutKey.GEMINI_API_KEY;

  const result = await runStage({
    stage: 'cold-review',
    prompt: 'p',
    model: 'gemini-2.5-pro',
    cwd: paths.candidate,
    output: output(paths),
    _env: envWithoutKey,
    _commandExists: (bin) => bin === 'gemini',
    _run: () => { spawned = true; return { status: 0 }; },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Gemini authentication is unavailable/i);
  assert.match(result.reason, /neither agy.*nor GEMINI_API_KEY/i);
  assert.equal(spawned, false);
});

test('refuses before spawning when gemini CLI binary does not exist even if key is present', async (t) => {
  const paths = makePaths(t);
  let spawned = false;
  const result = await runStage({
    stage: 'cold-review',
    prompt: 'p',
    model: 'gemini-2.5-pro',
    cwd: paths.candidate,
    output: output(paths),
    _env: { ...BASE_ENV },
    _commandExists: () => false,
    _run: () => { spawned = true; return { status: 0 }; },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Gemini authentication is unavailable/i);
  assert.equal(spawned, false);
});

test('refuses unsafe output paths inside the candidate before spawning', async (t) => {
  const paths = makePaths(t);
  let spawned = false;
  const result = await runStage({
    stage: 'cold-review',
    prompt: 'p',
    model: 'gemini-2.5-pro',
    cwd: paths.candidate,
    output: { mode: 'final-message', tempPath: join(paths.candidate, 'result.md'), artifactPath: paths.artifactPath },
    _env: { ...BASE_ENV },
    _commandExists: (bin) => bin === 'gemini',
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
    { name: 'non-zero', run: () => ({ status: 2, stderr: 'API quota exceeded' }), expected: /exited with status 2/i },
    { name: 'missing output', run: () => ({ status: 0 }), expected: /wrote no final message/i },
  ];

  for (const entry of cases) {
    const result = await runStage({
      stage: 'cold-review',
      prompt: 'p',
      model: 'gemini-2.5-pro',
      cwd: paths.candidate,
      output: output(paths),
      _env: { ...BASE_ENV },
      _commandExists: (bin) => bin === 'gemini',
      _run: entry.run,
    });
    assert.equal(result.ok, false, entry.name);
    assert.match(result.reason, entry.expected, entry.name);
  }
});

test('deduplicateFindingsBlocks collapses identical fenced blocks to one', () => {
  const block = '```brain-findings/1\n[{"id":"cold-1","severity":"blocker"}]\n```';
  const duplicated = `${block}\n\n${block}`;
  const deduplicated = deduplicateFindingsBlocks(duplicated);
  assert.equal(deduplicated, block);

  // Different blocks are preserved as-is so findings-artifact fails closed
  const diffBlock = '```brain-findings/1\n[{"id":"cold-2","severity":"blocker"}]\n```';
  const mixed = `${block}\n\n${diffBlock}`;
  assert.equal(deduplicateFindingsBlocks(mixed), mixed);
});

test('redacts GEMINI_API_KEY from stderr in error tail', async (t) => {
  const paths = makePaths(t);
  const sensitiveValue = 'mock-key-value-12345';
  const result = await runStage({
    stage: 'cold-review',
    prompt: 'p',
    model: 'gemini-2.5-pro',
    cwd: paths.candidate,
    output: output(paths),
    _env: { ...BASE_ENV, GEMINI_API_KEY: sensitiveValue },
    _commandExists: (bin) => bin === 'gemini',
    _run: () => ({ status: 1, stderr: `Error connecting with key ${sensitiveValue}` }),
  });

  assert.equal(result.ok, false);
  assert.ok(!result.reason.includes(sensitiveValue), 'sensitive value must not be present in reason');
  assert.ok(result.reason.includes('[redacted]'), 'sensitive value must be replaced with [redacted]');
});

test('runStage deduplicates identical findings in stdout when writing tempPath', async (t) => {
  const paths = makePaths(t);
  const block = '```brain-findings/1\n[{"id":"cold-1","severity":"blocker"}]\n```';
  const duplicated = `${block}\n\n${block}`;

  const result = await runStage({
    stage: 'cold-review',
    prompt: 'p',
    model: 'gemini-3.1-pro-high',
    cwd: paths.candidate,
    output: output(paths),
    _env: { ...BASE_ENV },
    _commandExists: (bin) => bin === 'agy',
    _hasAgyAuth: () => true,
    _run: () => ({ status: 0, stdout: duplicated }),
  });

  assert.equal(result.ok, true);
  const written = readFileSync(paths.tempPath, 'utf8');
  assert.equal(written, block);
});

test('hasAgyAuth: returns true when cli dir and indicator file exists', () => {
  const existsMap = new Set([
    '/fake/home/.gemini/antigravity-cli',
    '/fake/home/.gemini/antigravity-cli/settings.json',
  ]);
  assert.equal(hasAgyAuth({ HOME: '/fake/home' }, (p) => existsMap.has(p)), true);
});

test('hasAgyAuth: returns false when indicator file is missing or dir does not exist', () => {
  assert.equal(hasAgyAuth({ HOME: '/fake/home' }, (p) => p === '/fake/home/.gemini/antigravity-cli'), false);
  assert.equal(hasAgyAuth({ HOME: '/fake/home' }, () => false), false);
});

test('canonicalPath: correctly preserves first letter when resolving non-existent path directly under root', () => {
  const resolved = canonicalPath('/nonexistent_test_dir_123');
  assert.equal(resolved, '/nonexistent_test_dir_123');
});

test('isWithin: correctly identifies paths inside parent even when filename starts with double dot', () => {
  assert.equal(isWithin('/candidate', '/candidate/..hacker.tmp'), true);
  assert.equal(isWithin('/candidate', '/candidate/subdir/..file'), true);
  assert.equal(isWithin('/candidate', '/candidate'), true);
  assert.equal(isWithin('/candidate', '/outside/file'), false);
  assert.equal(isWithin('/candidate', '/candidate/../outside'), false);
});
