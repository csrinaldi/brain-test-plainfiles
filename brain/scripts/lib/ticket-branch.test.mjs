// ticket-branch.test.mjs — issue #785. The assertion that matters is not the
// upstream value; it is WHAT GIT SUGGESTS when the push fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { removeTempTree } from '../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { worktreeAddArgs, inPlaceCheckoutArgs } from './ticket-branch.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** A real repo with a real `origin`, both local. No network. */
function makeRepoWithOrigin(t, defaultBranch = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'brain-ticket-'));
  t.after(() => removeTempTree(dir));

  const bare = join(dir, 'origin.git');
  const work = join(dir, 'work');
  mkdirSync(work);
  git(dir, 'init', '--bare', '-b', defaultBranch, bare);
  git(work, 'init', '-b', defaultBranch);
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'user.name', 'Test');
  writeFileSync(join(work, 'README.md'), '# fixture\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'init');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '-u', 'origin', defaultBranch);
  git(work, 'fetch', 'origin');
  return { dir, work, bare };
}

// ── The arg builders, pure ────────────────────────────────────────────────

test('worktreeAddArgs: a NEW branch is created --no-track', () => {
  const args = worktreeAddArgs({
    worktreePath: '/tmp/wt', branchName: 'fix/issue-785', startPoint: 'origin/main',
    branchExists: false,
  });
  assert.ok(args.includes('--no-track'), 'without it the branch is born tracking origin/<base>');
  assert.ok(args.includes('-b'));
});

test('worktreeAddArgs: an EXISTING branch is attached, not created', () => {
  // Nothing is created, so nothing acquires an upstream — `--no-track` would be
  // meaningless here and git rejects it alongside a bare branch name.
  const args = worktreeAddArgs({
    worktreePath: '/tmp/wt', branchName: 'fix/issue-785', startPoint: 'origin/main',
    branchExists: true,
  });
  assert.equal(args.includes('-b'), false);
  assert.equal(args.includes('--no-track'), false);
});

test('inPlaceCheckoutArgs: the in-place path is --no-track too', () => {
  // BOTH paths were affected. `ticket-start.mjs:189` is the in-place one and it
  // had the same defect as `:160` — a fix that covered only the worktree would
  // leave the mode the doctrine allows for solo work as the broken one.
  const args = inPlaceCheckoutArgs({ branchName: 'fix/issue-785', startPoint: 'origin/main' });
  assert.ok(args.includes('--no-track'));
});

// ── The behaviour, on a real repo with a real origin ──────────────────────

test('a branch built with these args has NO upstream', (t) => {
  const { work } = makeRepoWithOrigin(t);
  const r = git(work, ...inPlaceCheckoutArgs({ branchName: 'fix/issue-785', startPoint: 'origin/main' }));
  assert.equal(r.ok, true, r.err);
  assert.equal(git(work, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').ok, false,
    'a task branch must not point at the branch it will open a pull request against');
});

test('a bare `git push` names --set-upstream, and NEVER the default branch', (t) => {
  // ACCEPTANCE 2 OF #785, and the assertion the upstream value only proxies.
  // What made this a bug rather than an ergonomics complaint is the TEXT git
  // prints: with an upstream of `origin/main` its first remedy is
  // `git push origin HEAD:main`, which lands a task branch on the default
  // branch past every required check.
  const { work } = makeRepoWithOrigin(t);
  git(work, ...inPlaceCheckoutArgs({ branchName: 'fix/issue-785', startPoint: 'origin/main' }));

  const push = git(work, 'push');
  assert.equal(push.ok, false, 'a branch with no upstream cannot push, and that is correct');
  const message = `${push.err}\n${push.out}`;
  assert.match(message, /--set-upstream/, 'git must suggest the command that is actually right');
  assert.doesNotMatch(message, /HEAD:main/, 'git must not offer to push a task branch onto the default branch');
});

test('--base <tracker>: the defect and the fix are the same, only the target moves', (t) => {
  const { work } = makeRepoWithOrigin(t);
  git(work, 'checkout', '-b', 'feature/v2.0.0');
  git(work, 'push', '-u', 'origin', 'feature/v2.0.0');
  git(work, 'checkout', 'main');
  git(work, 'fetch', 'origin');

  const r = git(work, ...inPlaceCheckoutArgs({
    branchName: 'fix/issue-785', startPoint: 'origin/feature/v2.0.0',
  }));
  assert.equal(r.ok, true, r.err);
  assert.equal(git(work, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').ok, false);
});

// ── The defect itself, pinned ─────────────────────────────────────────────

test('WITHOUT --no-track the branch tracks origin/main and git offers HEAD:main', (t) => {
  // The red half, kept as a test rather than as a paragraph. If a future change
  // drops `--no-track`, the tests above go red and this one stays green —
  // together they say which direction the drift went.
  const { work } = makeRepoWithOrigin(t);
  const r = git(work, 'checkout', '-b', 'fix/issue-785', 'origin/main');
  assert.equal(r.ok, true, r.err);

  const upstream = git(work, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  assert.equal(upstream.ok, true);
  assert.equal(upstream.out, 'origin/main', 'this is what brain:ticket:start produced before #785');

  const push = git(work, 'push');
  assert.equal(push.ok, false);
  assert.match(
    `${push.err}\n${push.out}`,
    /HEAD:main/,
    'and this is the suggestion that made it a bug: git offers to push the task branch onto main',
  );
});
