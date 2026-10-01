// commit-msg.first-commit.test.mjs — issue #1161.
//
// Root cause: `commit-msg` demanded a ticket reference (#N) on EVERY commit
// that is not machine-generated, including the adoption commit of a brand-new
// repository — which has no issues yet. `pre-commit` already exempts that same
// commit while no ref reaches any commit (#1112), so the two hooks disagreed
// and the operator could only proceed by skipping the hooks or by opening an issue.
//
// Contract: while NO ref reaches any commit, `commit-msg` accepts a
// Conventional Commit without #N and says why. The condition is shared with
// `pre-commit` through `no-commit-yet.sh` (one predicate, not two copies).
// Conventional-Commit validation still applies; only the ticket is exempt.
//
// Real git fixtures: a fresh `git init` under the OS temp dir with
// `core.hooksPath` pointed at a directory holding only commit-msg + its helper,
// so pre-commit's own checks do not mask what commit-msg does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTempTree } from '../lib/tmp-tree.mjs';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

/** A real repo whose hooksPath holds ONLY commit-msg and its sourced helper(s). */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'brain-1161-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  const hooks = join(dir, '.hooks-under-test');
  mkdirSync(hooks, { recursive: true });
  cpSync(join(HOOKS_DIR, 'commit-msg'), join(hooks, 'commit-msg'), { recursive: true });
  for (const f of readdirSync(HOOKS_DIR)) {
    if (f.endsWith('.sh')) cpSync(join(HOOKS_DIR, f), join(hooks, f));
  }
  git('config', 'core.hooksPath', hooks);
  return { dir, git };
}

function commit(dir, file, msg) {
  writeFileSync(join(dir, file), `${file}\n`);
  execFileSync('git', ['-C', dir, 'add', file]);
  return spawnSync('git', ['-C', dir, 'commit', '-m', msg], { cwd: dir, encoding: 'utf8' });
}

/** Setup commit with hooks disabled through config, not a per-commit flag. */
function seed(dir, file, msg) {
  writeFileSync(join(dir, file), `${file}\n`);
  execFileSync('git', ['-C', dir, 'add', file]);
  execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', msg]);
}

test('#1161 (a) the first commit of a new repo, "chore: adopt brain", is accepted and says why', () => {
  const { dir } = makeRepo();
  try {
    const r = commit(dir, 'README.md', 'chore: adopt brain');
    assert.equal(r.status, 0, `stderr:\n${r.stderr}\nstdout:\n${r.stdout}`);
    assert.match(`${r.stdout}${r.stderr}`, /commit-msg: .*no commit yet.*ticket/i);
  } finally {
    removeTempTree(dir);
  }
});

test('#1161 (b) a second commit without #N is refused', () => {
  const { dir } = makeRepo();
  try {
    assert.equal(commit(dir, 'a.md', 'chore: adopt brain').status, 0, 'setup');
    const r = commit(dir, 'b.md', 'chore: second commit');
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /must reference a ticket/);
  } finally {
    removeTempTree(dir);
  }
});

test('#1161 (c) a non-Conventional first message is still refused', () => {
  const { dir } = makeRepo();
  try {
    const r = commit(dir, 'a.md', 'adopt brain');
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /Conventional Commits/);
  } finally {
    removeTempTree(dir);
  }
});

test('#1161 (d) orphan branch in a repo WITH history: a commit without #N is refused', () => {
  const { dir, git } = makeRepo();
  try {
    seed(dir, 'a.md', 'chore: history (#1)');
    git('checkout', '-q', '--orphan', 'x');
    const r = commit(dir, 'b.md', 'chore: sneaky orphan');
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /must reference a ticket/);
  } finally {
    removeTempTree(dir);
  }
});

// ── REQ-4: the exemption fails CLOSED (cold-review findings 1 and 2) ─────────

/** Runs commit-msg directly (not through git) so a broken repo cannot mask the hook. */
function runHook(hooksDir, cwd, msg, env = {}) {
  const msgFile = join(mkdtempSync(join(tmpdir(), 'brain-1161-msg-')), 'MSG');
  writeFileSync(msgFile, msg);
  return spawnSync('sh', [join(hooksDir, 'commit-msg'), msgFile], {
    cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', ...env },
  });
}

test('#1161 REQ-4 outside a git repository the exemption does not apply', () => {
  const outside = mkdtempSync(join(tmpdir(), 'brain-1161-norepo-'));
  try {
    const r = runHook(HOOKS_DIR, outside, 'chore: adopt brain', { GIT_CEILING_DIRECTORIES: dirname(outside) });
    assert.notEqual(r.status, 0, `stdout:\n${r.stdout}`);
    assert.match(`${r.stdout}${r.stderr}`, /must reference a ticket/);
  } finally {
    removeTempTree(outside);
  }
});

test('#1161 REQ-4 a git error while listing commits does not grant the exemption', () => {
  const { dir } = makeRepo();
  try {
    seed(dir, 'a.md', 'chore: history (#1)');
    // Corrupt the ref: rev-parse --git-dir still succeeds, rev-list --all errors with empty stdout.
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'main'), 'not-a-sha\n');
    const probe = spawnSync('git', ['-C', dir, 'rev-list', '-n', '1', '--all'], { encoding: 'utf8' });
    assert.notEqual(probe.status, 0, 'fixture precondition: rev-list must error');
    assert.equal(probe.stdout.trim(), '', 'fixture precondition: rev-list prints nothing');
    const r = runHook(join(dir, '.hooks-under-test'), dir, 'chore: no ticket here');
    assert.notEqual(r.status, 0, `exemption granted on a git error; stdout:\n${r.stdout}`);
    assert.match(`${r.stdout}${r.stderr}`, /must reference a ticket/);
  } finally {
    removeTempTree(dir);
  }
});

test('#1161 REQ-4 a missing helper means no exemption, even in a repo with no commit', () => {
  const { dir } = makeRepo();
  try {
    const lone = join(dir, '.lone-hook');
    cpSync(join(HOOKS_DIR, 'commit-msg'), join(lone, 'commit-msg'));
    const r = runHook(lone, dir, 'chore: adopt brain');
    assert.notEqual(r.status, 0, `stdout:\n${r.stdout}`);
    assert.match(`${r.stdout}${r.stderr}`, /must reference a ticket/);
  } finally {
    removeTempTree(dir);
  }
});
