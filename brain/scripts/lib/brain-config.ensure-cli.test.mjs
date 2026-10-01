// brain-config.ensure-cli.test.mjs — the CLI-level pin for `brain-config.mjs ensure` (#1127).
//
// The unit test proves `ensureBrainConfig` RETURNS an error for an unparseable config; what
// bootstrap.sh reads is the PROCESS EXIT CODE. Without this, deleting the
// `process.exitCode = 1` line leaves every unit test green and env:init silently reads an
// empty config again. The module resolves its config path from its own location, so it is run
// from a COPY of the brain tree inside a temp repo — never against the real checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTmp } from './test-tmp.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('#1127 ensure (CLI): an unparseable brain.config.json exits 1, says why, and leaves the file untouched', () => {
  const root = testTmp('ensure-cli-');
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  cpSync(join(REPO, 'brain'), join(repo, 'brain'), { recursive: true, filter: (s) => !s.includes('node_modules') });
  cpSync(join(REPO, 'package.json'), join(repo, 'package.json'));
  const config = join(repo, 'brain.config.json');
  writeFileSync(config, '{ not json');

  const r = spawnSync(process.execPath, [join(repo, 'brain', 'scripts', 'lib', 'brain-config.mjs'), 'ensure'], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: root, XDG_RUNTIME_DIR: root, DBUS_SESSION_BUS_ADDRESS: '' },
  });

  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /brain\.config\.json/);
  assert.equal(readFileSync(config, 'utf8'), '{ not json', 'the file must be untouched');
});
