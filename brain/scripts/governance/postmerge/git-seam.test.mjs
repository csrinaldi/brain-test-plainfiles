// git-seam.test.mjs — the ONE git primitive the platform-neutral core is
// built on MUST return status, never throw on a non-zero exit (design §4).
// A throw-only boolean seam cannot distinguish e.g. `ls-remote --exit-code`
// status 2 ("no matching ref — proved absent") from status 128
// ("unreachable remote") — that collapse is what produced the F2 bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { gitTry, gitOrThrow } from './git-seam.mjs';

function makeRepo(dir) {
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
  return git;
}

test('gitTry: status 0 on a successful command, stdout captured', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-seam-ok-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  git('commit', '--allow-empty', '-m', 'init');

  const r = gitTry(['rev-parse', 'HEAD'], { cwd: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^[0-9a-f]{40}$/);
  assert.equal(r.stderr, '');
});

test('gitTry: never throws on a documented non-zero exit (ls-remote --exit-code, no matching ref → 2)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-seam-absent-'));
  t.after(() => removeTempTree(dir));
  makeRepo(dir);

  assert.doesNotThrow(() => {
    const r = gitTry(['ls-remote', '--exit-code', dir, 'refs/does-not-exist'], { cwd: dir });
    assert.equal(r.status, 2);
  });
});

test('gitTry: never throws on an unrelated failure (unreachable remote → non-zero, non-2)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-seam-unreachable-'));
  t.after(() => removeTempTree(dir));
  makeRepo(dir);

  const bogus = join(dir, 'does', 'not', 'exist', 'at', 'all');
  const r = gitTry(['ls-remote', '--exit-code', bogus, 'refs/heads/main'], { cwd: dir });
  assert.notEqual(r.status, 0);
  assert.notEqual(r.status, 2);
});

// A `git diff --binary` over a memory-sync merge routinely exceeds Node's 1 MiB
// execFileSync default. Without an explicit maxBuffer the spawn dies with
// ENOBUFS, err.status is undefined, and gitTry collapses it to -1 — which
// brain-audit reports as `governance:audit-uncomputable`, reddening the release
// gate for an infra limit rather than a governance violation (issue #332).
test('gitTry: captures git output larger than the 1 MiB execFileSync default', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-seam-bigdiff-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  git('commit', '--allow-empty', '-m', 'init');

  // ~2 MiB of incompressible-enough text: the diff carries the literal content,
  // so the captured payload is comfortably over the default ceiling.
  const line = 'the quick brown fox jumps over the lazy dog 0123456789\n';
  writeFileSync(join(dir, 'big.txt'), line.repeat(40000));
  git('add', 'big.txt');
  git('commit', '-m', 'add big file');

  const r = gitTry(['diff', '--binary', '-U3', 'HEAD^1', 'HEAD'], { cwd: dir });

  assert.equal(r.status, 0, `expected status 0, got ${r.status} (stderr: ${r.stderr})`);
  assert.ok(
    r.stdout.length > 1024 * 1024,
    `expected the full diff to be captured, got ${r.stdout.length} bytes`,
  );
});

// The -1 collapse is deliberate (an unmapped status is uncomputable, never a
// verdict) but it must not erase WHY. A self-inflicted buffer limit has to read
// as a buffer limit, not as an unmappable git tri-state.
test('gitTry: an exceeded output buffer reports a legible reason, not an empty stderr', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-seam-enobufs-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  git('commit', '--allow-empty', '-m', 'init');

  const r = gitTry(['log', '--format=%H'], { cwd: dir, maxBuffer: 8 });

  assert.equal(r.status, -1);
  assert.match(r.stderr, /exceeded the .* output buffer/i);
});

test('gitOrThrow: returns stdout on status 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-seam-orthrow-ok-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  git('commit', '--allow-empty', '-m', 'init');

  const out = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir });
  assert.match(out.trim(), /^[0-9a-f]{40}$/);
});

test('gitOrThrow: throws an Error carrying .status on a non-zero exit', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-seam-orthrow-fail-'));
  t.after(() => removeTempTree(dir));
  makeRepo(dir);

  assert.throws(
    () => gitOrThrow(['ls-remote', '--exit-code', dir, 'refs/does-not-exist'], { cwd: dir }),
    (err) => {
      assert.equal(err.status, 2);
      return true;
    },
  );
});
