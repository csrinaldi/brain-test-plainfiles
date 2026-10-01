// brain-protect-server.test.mjs — tests for the pre-receive hook installer.
//
// Verifies that:
//   (a) installPreReceiveHook copies the hook into a bare repo and makes it executable.
//   (b) A non-repository path returns { success: false } with an informative message.
//   (c) The module is side-effect-free on import (CLI guard holds).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installPreReceiveHook } from './brain-protect-server.mjs';

// Guard: skip git-dependent tests if git is not available.
const gitAvailableCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
const GIT_AVAILABLE = gitAvailableCheck.status === 0;

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// (a) Successful install into a bare repo
// ---------------------------------------------------------------------------

test('brain-protect-server: installs hook and makes it executable in a bare repo', { skip: !GIT_AVAILABLE }, (t) => {
  const root = makeTempDir('bps-install-');
  const bareDir = join(root, 'repo.git');
  t.after(() => removeTempTree(root));

  git(['init', '--bare', bareDir]);

  const result = installPreReceiveHook(bareDir);

  assert.equal(result.success, true, `install failed: ${result.message}`);

  // Hook must exist and be executable (any of owner/group/other execute bits set).
  const hookPath = join(bareDir, 'hooks', 'pre-receive');
  const st = statSync(hookPath);
  assert.ok(
    (st.mode & 0o111) !== 0,
    `hook must be executable; mode: 0${st.mode.toString(8)}`,
  );
});

// ---------------------------------------------------------------------------
// (b) Non-repository path → error result
// ---------------------------------------------------------------------------

test('brain-protect-server: returns error for a path that is not a git repository', () => {
  const nonRepoPath = join(tmpdir(), `bps-no-repo-${Date.now()}`);

  const result = installPreReceiveHook(nonRepoPath);

  assert.equal(result.success, false, 'must fail on a non-repo path');
  assert.match(
    result.message,
    /brain:protect-server/,
    'error message must identify the command',
  );
});

// ---------------------------------------------------------------------------
// (b2) Non-bare (working) repo → rejected (a pre-receive there never runs)
// ---------------------------------------------------------------------------

test('brain-protect-server: rejects a non-bare working repository', { skip: !GIT_AVAILABLE }, (t) => {
  const root = makeTempDir('bps-nonbare-');
  t.after(() => removeTempTree(root));
  git(['init', root]); // non-bare

  const result = installPreReceiveHook(root);

  assert.equal(result.success, false, 'must refuse a non-bare repo');
  assert.match(result.message, /not a bare repository/i);
});

// ---------------------------------------------------------------------------
// (b3) Existing hook is not clobbered without --force; --force overwrites
// ---------------------------------------------------------------------------

test('brain-protect-server: refuses to clobber an existing hook unless --force', { skip: !GIT_AVAILABLE }, (t) => {
  const root = makeTempDir('bps-clobber-');
  const bareDir = join(root, 'repo.git');
  t.after(() => removeTempTree(root));
  git(['init', '--bare', bareDir]);

  assert.equal(installPreReceiveHook(bareDir).success, true, 'first install succeeds');

  const second = installPreReceiveHook(bareDir);
  assert.equal(second.success, false, 'second install must refuse without --force');
  assert.match(second.message, /already exists/i);

  assert.equal(installPreReceiveHook(bareDir, { force: true }).success, true, '--force overwrites');
});

// ---------------------------------------------------------------------------
// (c) CLI guard — importing is side-effect-free
// ---------------------------------------------------------------------------

test('brain-protect-server: importing is side-effect-free (CLI guard holds)', async () => {
  // Dynamic re-import exercises the module's top-level execution path.
  // If the CLI guard were absent, the installation logic would run on import
  // (reading argv, printing, possibly exiting), which would crash this test.
  const mod = await import('./brain-protect-server.mjs');
  assert.equal(
    typeof mod.installPreReceiveHook,
    'function',
    'installPreReceiveHook must be exported',
  );
});
