// git-config.test.mjs — unit tests for gitConfigGet() (#738, design A1).
//
// The ONE spawn that reads git config: `git config --get <key>` with `cwd`,
// letting git's own precedence (system → global → local, last wins) resolve
// the value. NEVER throws — missing key, non-zero exit, and a spawn throw
// all normalize to `null`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gitConfigGet } from './git-config.mjs';

test('gitConfigGet: key set → value, trimmed', () => {
  const _spawn = () => ({ status: 0, stdout: '@csrinaldi\n' });
  assert.equal(gitConfigGet('brain.actor', '/repo', { _spawn }), '@csrinaldi');
});

test('gitConfigGet: missing key (non-zero exit) → null', () => {
  const _spawn = () => ({ status: 1, stdout: '' });
  assert.equal(gitConfigGet('brain.actor', '/repo', { _spawn }), null);
});

test('gitConfigGet: spawn throws (git absent / non-git dir) → null, never a rethrow', () => {
  const _spawn = () => { throw new Error('spawn git ENOENT'); };
  assert.doesNotThrow(() => gitConfigGet('brain.actor', '/repo', { _spawn }));
  assert.equal(gitConfigGet('brain.actor', '/repo', { _spawn }), null);
});

test('gitConfigGet: uses spawn with `git config --get <key>`, cwd, encoding:utf8', () => {
  let captured = null;
  const _spawn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { status: 0, stdout: 'value\n' };
  };
  gitConfigGet('brain.agentEnv', '/repo', { _spawn });
  assert.equal(captured.cmd, 'git');
  assert.deepEqual(captured.args, ['config', '--get', 'brain.agentEnv']);
  assert.equal(captured.opts.cwd, '/repo');
  assert.equal(captured.opts.encoding, 'utf8');
});

test('gitConfigGet: empty stdout on status 0 → null', () => {
  const _spawn = () => ({ status: 0, stdout: '' });
  assert.equal(gitConfigGet('brain.actor', '/repo', { _spawn }), null);
});
