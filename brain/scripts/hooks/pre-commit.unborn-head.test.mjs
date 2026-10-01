// pre-commit.unborn-head.test.mjs — issue #1112, finding 4 (maintainer
// ruling, 2026-09-29): the pre-commit hook exempts a commit when the
// REPOSITORY HAS NO COMMIT AT ALL — not merely when the current HEAD is
// unborn.
//
// Root cause: `npm run brain:env:init` sets `core.hooksPath` (bootstrap.sh's
// §7, unconditionally) before the operator ever makes the adoption commit in
// the #1081 repro's ordering. Once that is set, check 1 (direct commit to
// main/master) blocks whenever the default branch is literally named
// "main"/"master", and check 2 (#788/#782 slice 2 — no commit from the MAIN
// CHECKOUT) blocks EVERY commit from the main checkout regardless of branch —
// the adoption commit can never satisfy check 2 as written.
//
// WHY THE EXEMPTION IS RIGHT (maintainer ruling, 2026-09-29, re-confirmed the
// same day with a corrected rationale — see `pre-commit`'s own comment for
// the full version): check 2 exists so parallel work cannot collide in one
// checkout. A repository with NO commit at all has no branch anyone else is
// using and no history to share, so there is no parallel work to isolate —
// the exemption applies to exactly one commit in a repository's life,
// announces itself, and closes itself. An EARLIER version of this reasoning
// claimed `git worktree add` itself "requires a commit to exist", making
// worktree isolation "structurally impossible" here — that claim was FALSE:
// `git worktree add --orphan` works against a repository with zero commits
// (git >= 2.42, verified on 2.53), so an orphan worktree could isolate this
// commit too. The exemption does not rest on that claim; it rests on there
// being no parallel work to protect against yet, plus the cost (ADR-0036) of
// making an operator move `npx brain init`/`env:init`'s already-written
// files, `.env` and git config into a separate worktree — or re-run the
// install there — on the single most fragile step, for someone brand new to
// brain.
//
// CORRECTED CONDITION (cold-review finding, same day): the first cut of this
// fix detected "HEAD is unborn" via `git rev-parse --verify -q HEAD` failing.
// That reopens #782 on demand — `git checkout --orphan x` ALSO makes HEAD
// unborn in a repository that already has real history on other refs, so the
// exemption fired repeatably for a crafted orphan-branch commit in the main
// checkout. The condition is now "the repository has no commit reachable
// from ANY ref" (`git rev-list -n 1 --all` empty) — true only before the very
// first commit anywhere in the repo, never reopenable by switching branches.
// The exemption applies while NO ref reaches any commit. It stops applying as
// soon as one does, but it is not permanent: deleting every ref (see the
// last test) brings it back, at a state with no shared history to protect.
// It does not fire on every unborn-HEAD state — see the orphan-branch test
// below, which must still be refused.
//
// Unlike pre-commit.test.mjs (mocked node/git shell scripts), THIS suite runs
// against a REAL git repository with `core.hooksPath` pointed at the real
// installed hooks — the maintainer's ruling asked for a real fixture so the
// exemption is proven against real `git rev-parse`/`git rev-list` behavior,
// not a stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, cpSync } from 'node:fs';
import { removeTempTree } from '../lib/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = join(HOOKS_DIR, '..', '..', '..');

/**
 * Copies what a real committing repo carries: `brain/scripts` + `brain/core`
 * (no tests) — checks 3/4 downstream of the unborn-HEAD gate (`staged-records-check.mjs`,
 * `check-refs.mjs`) resolve their own path via `git rev-parse --show-toplevel`,
 * so they need these to actually exist under the fixture repo, exactly as
 * `bootstrap.tier-notice.test.mjs`'s own `copyBrain` does for the same reason.
 */
function copyBrain(dest) {
  const keep = (src) => !src.endsWith('.test.mjs') && basename(src) !== '__fixtures__' && basename(src) !== 'node_modules';
  cpSync(join(SOURCE_ROOT, 'brain', 'scripts'), join(dest, 'brain', 'scripts'), { recursive: true, filter: keep });
  cpSync(join(SOURCE_ROOT, 'brain', 'core'), join(dest, 'brain', 'core'), { recursive: true, filter: keep });
}

/** A real git repo with core.hooksPath pointed at the REAL installed hooks. */
function makeRepo({ defaultBranch = 'main' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-1112-unbornhead-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', defaultBranch);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  // core.hooksPath is an ABSOLUTE path here (test-only convenience); bootstrap.sh
  // itself writes a repo-relative one (`brain/scripts/hooks`) — irrelevant to
  // what THIS hook does once invoked, which is the only thing under test.
  git('config', 'core.hooksPath', HOOKS_DIR);
  copyBrain(dir);
  return { dir, git };
}

/** Stages one new file and attempts a real commit — may fail; caller asserts. */
function attemptCommit(dir, filename, msg) {
  writeFileSync(join(dir, filename), `${filename}\n`);
  execFileSync('git', ['-C', dir, 'add', filename], { encoding: 'utf8' });
  return spawnSync('git', ['-C', dir, 'commit', '-m', msg], { cwd: dir, encoding: 'utf8' });
}

test('#1112 unborn HEAD: the FIRST commit from the main checkout is accepted, even on "main"', () => {
  const { dir } = makeRepo({ defaultBranch: 'main' });
  try {
    const result = attemptCommit(dir, 'README.md', 'chore: adopt brain (#1112)');
    assert.equal(result.status, 0, `first commit must succeed; stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  } finally {
    removeTempTree(dir);
  }
});

test('#1112 unborn HEAD: detection is not by branch name — a non-main default branch is accepted too', () => {
  const { dir } = makeRepo({ defaultBranch: 'trunk' });
  try {
    const result = attemptCommit(dir, 'README.md', 'chore: adopt brain (#1112)');
    assert.equal(result.status, 0, `first commit on a non-main default branch must succeed; stderr:\n${result.stderr}`);
  } finally {
    removeTempTree(dir);
  }
});

test('#1112 unborn HEAD: the exemption is reported, not silent', () => {
  const { dir } = makeRepo({ defaultBranch: 'main' });
  try {
    const result = attemptCommit(dir, 'README.md', 'chore: adopt brain (#1112)');
    assert.equal(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /no commit yet/i,
      `the allowed-because-no-commit-at-all reason must be visible to the operator; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  } finally {
    removeTempTree(dir);
  }
});

test('#1112 a SECOND commit from the main checkout (HEAD no longer unborn) is still refused by check 2', () => {
  const { dir, git } = makeRepo({ defaultBranch: 'main' });
  try {
    const first = attemptCommit(dir, 'README.md', 'chore: adopt brain (#1112)');
    assert.equal(first.status, 0, 'setup: the first commit must succeed');

    // Move OFF main so check 1 does not also fire — isolates check 2.
    git('checkout', '-q', '-b', 'feature/x');

    const second = attemptCommit(dir, 'second.md', 'feat(x): second change (#1112)');
    assert.equal(second.status, 1, 'a second commit from the main checkout must still be refused');
    assert.match(
      `${second.stdout}${second.stderr}`,
      /MAIN CHECKOUT/,
      `check 2's own refusal must still fire once HEAD is no longer unborn; got:\n${second.stdout}${second.stderr}`,
    );
  } finally {
    removeTempTree(dir);
  }
});

test('#1112 orphan branch in a repo WITH history is judged by checks 1/2, never exempted (cold-review finding: git checkout --orphan reopens #782 on demand)', () => {
  const { dir, git } = makeRepo({ defaultBranch: 'main' });
  try {
    const first = attemptCommit(dir, 'README.md', 'chore: adopt brain (#1112)');
    assert.equal(first.status, 0, 'setup: the first commit must succeed');

    // `git checkout --orphan` makes the CURRENT HEAD unborn again — a
    // symbolic ref to a branch with no commit of its own — even though the
    // repository as a whole still has real history on `main`. A detector
    // keyed on "HEAD is unborn" cannot tell this apart from a genuinely
    // empty repository; a detector keyed on "the repo has no commit
    // anywhere" can, because `main`'s commit is still reachable via `--all`.
    git('checkout', '-q', '--orphan', 'orphan-branch');

    const second = attemptCommit(dir, 'sneaky.md', 'chore: sneaky orphan commit (#1112)');
    assert.equal(
      second.status,
      1,
      `an orphan-branch commit in a repo with history must be refused by check 2, never exempted; stdout:\n${second.stdout}\nstderr:\n${second.stderr}`,
    );
    assert.match(
      `${second.stdout}${second.stderr}`,
      /MAIN CHECKOUT/,
      `check 2 must fire — the repository already has a commit (on main), so this is not the exempted first-ever commit; got:\n${second.stdout}${second.stderr}`,
    );
    assert.doesNotMatch(
      `${second.stdout}${second.stderr}`,
      /no commit yet/i,
      'the no-commit-at-all exemption message must never appear for an orphan branch in a repo with history',
    );
  } finally {
    removeTempTree(dir);
  }
});

test('#1112 the exemption applies again once EVERY ref is deleted (documented behaviour: no ref reaches any commit)', () => {
  const { dir, git } = makeRepo({ defaultBranch: 'main' });
  try {
    const first = attemptCommit(dir, 'README.md', 'chore: adopt brain (#1112)');
    assert.equal(first.status, 0, 'setup: the first commit must succeed');

    // Deliberately delete every ref: `git rev-list -n 1 --all` is empty again.
    git('checkout', '-q', '--orphan', 'x');
    git('branch', '-q', '-D', 'main');
    assert.equal(git('rev-list', '-n', '1', '--all').trim(), '', 'setup: no ref may reach a commit');

    const again = attemptCommit(dir, 'again.md', 'chore: adopt brain again (#1112)');
    assert.equal(
      again.status,
      0,
      `with no ref reaching any commit the exemption applies; stdout:\n${again.stdout}\nstderr:\n${again.stderr}`,
    );
    assert.match(`${again.stdout}${again.stderr}`, /no commit yet/i);
  } finally {
    removeTempTree(dir);
  }
});

test('#1112 check 1 (direct commit to main) is unchanged for a NON-unborn repo', () => {
  const { dir, git } = makeRepo({ defaultBranch: 'main' });
  try {
    const first = attemptCommit(dir, 'README.md', 'chore: adopt brain (#1112)');
    assert.equal(first.status, 0, 'setup: the first commit must succeed');

    // HEAD is now born; branch is still "main" — the ORIGINAL check 1 case.
    const second = attemptCommit(dir, 'second.md', 'feat(x): second change (#1112)');
    assert.equal(second.status, 1, 'a direct commit to main must still be refused once HEAD is born');
    assert.match(
      `${second.stdout}${second.stderr}`,
      /direct commits to 'main'/,
      `check 1's own message must still fire unchanged; got:\n${second.stdout}${second.stderr}`,
    );
  } finally {
    removeTempTree(dir);
  }
});
