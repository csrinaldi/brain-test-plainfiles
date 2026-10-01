// scripts/lib/pm.test.mjs — Unit tests for the pm detection module.
// Run with: npm test  (node --test, no external dependencies)
//
// Covers all spec scenarios:
//   - detectPM: lockfile detection for all 4 PMs
//   - detectPM: packageManager field takes priority over lockfile
//   - detectPM: yarn Berry PnP rejection
//   - detectPM: yarn Berry without PnP passes
//   - detectPM: npm fallback when no signals present
//   - getPMConfig: returns correct shape for each PM

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectPM, getPMConfig } from './pm.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a temp dir, optionally writes files, runs fn(dir), then cleans up.
 * @param {Record<string, string>} files  filename → content  (relative to tmpdir)
 * @param {(dir: string) => void} fn
 */
function withTmpDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pm-test-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
      writeFileSync(abs, content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── getPMConfig — pure, no FS ─────────────────────────────────────────────────

test('getPMConfig: npm returns correct shape', () => {
  const cfg = getPMConfig('npm');
  assert.equal(cfg.name, 'npm');
  assert.deepEqual(cfg.installArgs, ['npm', 'install', '-D']);
  assert.deepEqual(cfg.runArgs('repo:check', true), ['npm', 'run', '--silent', 'repo:check']);
  assert.deepEqual(cfg.runArgs('repo:check', false), ['npm', 'run', 'repo:check']);
  assert.deepEqual(cfg.runArgs('repo:check'), ['npm', 'run', 'repo:check']);
});

test('getPMConfig: pnpm returns correct shape', () => {
  const cfg = getPMConfig('pnpm');
  assert.equal(cfg.name, 'pnpm');
  assert.deepEqual(cfg.installArgs, ['pnpm', 'add', '-D']);
  assert.deepEqual(cfg.runArgs('repo:check', true), ['pnpm', 'run', '--silent', 'repo:check']);
  assert.deepEqual(cfg.runArgs('repo:check', false), ['pnpm', 'run', 'repo:check']);
});

test('getPMConfig: yarn returns correct shape', () => {
  const cfg = getPMConfig('yarn');
  assert.equal(cfg.name, 'yarn');
  assert.deepEqual(cfg.installArgs, ['yarn', 'add']);
  // yarn classic: no --silent flag
  assert.deepEqual(cfg.runArgs('repo:check', true), ['yarn', 'repo:check']);
  assert.deepEqual(cfg.runArgs('repo:check', false), ['yarn', 'repo:check']);
});

test('getPMConfig: bun returns correct shape', () => {
  const cfg = getPMConfig('bun');
  assert.equal(cfg.name, 'bun');
  assert.deepEqual(cfg.installArgs, ['bun', 'add', '-d']);
  // bun: no --silent flag (quiet by default)
  assert.deepEqual(cfg.runArgs('repo:check', true), ['bun', 'run', 'repo:check']);
  assert.deepEqual(cfg.runArgs('repo:check', false), ['bun', 'run', 'repo:check']);
});

test('getPMConfig: unknown name throws', () => {
  assert.throws(() => getPMConfig('pip'), /unsupported|unknown/i);
});

// ── detectPM: lockfile detection ──────────────────────────────────────────────

test('detectPM: package-lock.json → npm', () => {
  withTmpDir({ 'package-lock.json': '{}' }, (dir) => {
    const pm = detectPM(dir);
    assert.equal(pm.name, 'npm');
    assert.deepEqual(pm.installArgs, ['npm', 'install', '-D']);
  });
});

test('detectPM: pnpm-lock.yaml → pnpm', () => {
  withTmpDir({ 'pnpm-lock.yaml': 'lockfileVersion: 6' }, (dir) => {
    const pm = detectPM(dir);
    assert.equal(pm.name, 'pnpm');
    assert.deepEqual(pm.installArgs, ['pnpm', 'add', '-D']);
  });
});

test('detectPM: yarn.lock (no .yarnrc.yml) → yarn classic', () => {
  withTmpDir({ 'yarn.lock': '# yarn lockfile v1' }, (dir) => {
    const pm = detectPM(dir);
    assert.equal(pm.name, 'yarn');
    assert.deepEqual(pm.installArgs, ['yarn', 'add']);
  });
});

test('detectPM: bun.lockb → bun', () => {
  withTmpDir({ 'bun.lockb': '' }, (dir) => {
    const pm = detectPM(dir);
    assert.equal(pm.name, 'bun');
    assert.deepEqual(pm.installArgs, ['bun', 'add', '-d']);
  });
});

// ── detectPM: packageManager field priority ───────────────────────────────────

test('detectPM: packageManager field beats lockfile (pnpm@8 + package-lock.json → pnpm)', () => {
  withTmpDir(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@8.0.0' }),
      'package-lock.json': '{}',
    },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'pnpm');
    },
  );
});

test('detectPM: packageManager field "npm@10.0.0" → npm', () => {
  withTmpDir(
    { 'package.json': JSON.stringify({ packageManager: 'npm@10.0.0' }) },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'npm');
    },
  );
});

test('detectPM: packageManager field "yarn@1.22.0" → yarn', () => {
  withTmpDir(
    { 'package.json': JSON.stringify({ packageManager: 'yarn@1.22.0' }) },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'yarn');
    },
  );
});

test('detectPM: packageManager field "bun@1.0.0" → bun', () => {
  withTmpDir(
    { 'package.json': JSON.stringify({ packageManager: 'bun@1.0.0' }) },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'bun');
    },
  );
});

// ── detectPM: yarn Berry PnP guard ────────────────────────────────────────────

test('detectPM: yarn.lock + .yarnrc.yml with nodeLinker:pnp → throws', () => {
  withTmpDir(
    {
      'yarn.lock': '# yarn lockfile v1',
      '.yarnrc.yml': 'nodeLinker: pnp\n',
    },
    (dir) => {
      assert.throws(() => detectPM(dir), (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          /berry|pnp|plug.?n.?play/i.test(err.message),
          `message "${err.message}" must name Berry PnP`,
        );
        assert.ok(
          /workaround|node.?modules|unsupported/i.test(err.message),
          `message "${err.message}" must provide guidance`,
        );
        return true;
      });
    },
  );
});

test('detectPM: yarn.lock + .yarnrc.yml with nodeLinker:node-modules → yarn (no throw)', () => {
  withTmpDir(
    {
      'yarn.lock': '# yarn lockfile v1',
      '.yarnrc.yml': 'nodeLinker: node-modules\n',
    },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'yarn');
    },
  );
});

test('detectPM: yarn.lock + .yarnrc.yml without nodeLinker → yarn (no throw)', () => {
  withTmpDir(
    {
      'yarn.lock': '# yarn lockfile v1',
      '.yarnrc.yml': 'enableTelemetry: false\n',
    },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'yarn');
    },
  );
});

// ── detectPM: fallback to npm ─────────────────────────────────────────────────

test('detectPM: no signals → fallback to npm', () => {
  withTmpDir({}, (dir) => {
    const pm = detectPM(dir);
    assert.equal(pm.name, 'npm');
  });
});

test('detectPM: package.json without packageManager field → lockfile/fallback path', () => {
  withTmpDir(
    { 'package.json': JSON.stringify({ name: 'my-app', version: '1.0.0' }) },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'npm'); // no lockfile → fallback
    },
  );
});

// ── detectPM: lockfile priority order ────────────────────────────────────────
// pnpm-lock.yaml beats yarn.lock and package-lock.json.

test('detectPM: pnpm-lock.yaml wins over package-lock.json when both present', () => {
  withTmpDir(
    {
      'pnpm-lock.yaml': 'lockfileVersion: 6',
      'package-lock.json': '{}',
    },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'pnpm');
    },
  );
});

test('detectPM: yarn.lock wins over package-lock.json when both present', () => {
  withTmpDir(
    {
      'yarn.lock': '# yarn lockfile v1',
      'package-lock.json': '{}',
    },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'yarn');
    },
  );
});

test('detectPM: bun.lockb wins over package-lock.json when both present', () => {
  withTmpDir(
    {
      'bun.lockb': '',
      'package-lock.json': '{}',
    },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'bun');
    },
  );
});

// ── detectPM: pnpm workspace root (issue #176 bug 2) ──────────────────────────
// `pnpm add` on a workspace root aborts with ERR_PNPM_ADDING_TO_ROOT unless
// `-w`/`--workspace-root` is passed. Only append `-w` when pnpm-workspace.yaml
// exists at root — never for non-workspace pnpm (where -w itself would error)
// and never for npm/yarn/bun.

test('detectPM: pnpm-lock.yaml + pnpm-workspace.yaml → installArgs includes -w', () => {
  withTmpDir(
    {
      'pnpm-lock.yaml': 'lockfileVersion: 6',
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'pnpm');
      assert.deepEqual(pm.installArgs, ['pnpm', 'add', '-D', '-w']);
    },
  );
});

test('detectPM: pnpm-lock.yaml without pnpm-workspace.yaml → installArgs does NOT include -w', () => {
  withTmpDir(
    { 'pnpm-lock.yaml': 'lockfileVersion: 6' },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'pnpm');
      assert.deepEqual(pm.installArgs, ['pnpm', 'add', '-D']);
    },
  );
});

test('detectPM: packageManager "pnpm@9" + pnpm-workspace.yaml → installArgs includes -w (issue #176)', () => {
  withTmpDir(
    {
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0' }),
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'pnpm');
      assert.deepEqual(pm.installArgs, ['pnpm', 'add', '-D', '-w']);
    },
  );
});

test('detectPM: non-pnpm PM + a stray pnpm-workspace.yaml → -w never leaks (issue #176)', () => {
  withTmpDir(
    {
      'package.json': JSON.stringify({ packageManager: 'npm@10.0.0' }),
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    },
    (dir) => {
      const pm = detectPM(dir);
      assert.equal(pm.name, 'npm');
      assert.deepEqual(pm.installArgs, ['npm', 'install', '-D']);
    },
  );
});

// ── detectPM: runArgs shape ────────────────────────────────────────────────────

test('detectPM returns runArgs function that builds correct argv', () => {
  withTmpDir({ 'pnpm-lock.yaml': '' }, (dir) => {
    const pm = detectPM(dir);
    assert.deepEqual(pm.runArgs('memory:pull', true), ['pnpm', 'run', '--silent', 'memory:pull']);
    assert.deepEqual(pm.runArgs('memory:index'), ['pnpm', 'run', 'memory:index']);
  });
});
