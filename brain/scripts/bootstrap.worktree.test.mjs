// bootstrap.worktree.test.mjs — the root bootstrap.sh resolves, measured from a
// real git worktree (issue #657).
//
// ── Why this executes the file instead of asserting on its text ─────────────
//
// A test that greps bootstrap.sh for the absence of `--show-toplevel` would pass
// against any replacement string, correct or not, and would go green on a helper
// that no longer runs at all. So both expressions are LIFTED OUT OF THE FILE and
// executed: whatever bootstrap.sh actually says is what gets measured. There is no
// second copy of either expression here to drift from the first — the #340 defect
// this repo already names.
//
// The scenario is the one that broke: `.env` is gitignored, so it exists in the
// MAIN checkout alone, while `git config --local` — and therefore the single
// credential-helper string — is shared by every worktree. A push from a worktree
// ran the helper against a `.env` that was not there, read an empty token, and
// failed with no useful signal. AGENTS.md:212 makes worktrees mandatory for
// parallel work, so this is the ordinary path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');
const SOURCE = readFileSync(BOOTSTRAP, 'utf8');

/** The verbatim `REPO_ROOT=...` assignment as bootstrap.sh writes it. */
function repoRootAssignment() {
  const line = SOURCE.split('\n').find((l) => l.startsWith('REPO_ROOT='));
  assert.ok(line, 'bootstrap.sh must assign REPO_ROOT');
  return line;
}

/** The verbatim `HELPER=...` assignment as bootstrap.sh writes it. */
function helperAssignment() {
  const line = SOURCE.split('\n').find((l) => l.startsWith('HELPER='));
  assert.ok(line, 'bootstrap.sh must assign HELPER');
  return line;
}

/**
 * The child environment is EXPLICIT, with the token variable stripped.
 *
 * The helper reads `${VCS_TOKEN_VAR:-}` AFTER sourcing `.env`, so an exported
 * `$VCS_TOKEN` in the calling shell satisfies it even when `.env` was never read.
 * Anyone who has run `env:init` in their shell has one — so inheriting the
 * environment made the missing-token case unreachable on a real machine while it
 * passed on a clean one, which is the only reason this suite went green here and
 * red on the maintainer's box.
 *
 * Stripping it also makes the happy path prove more than it did: with no ambient
 * token to fall back on, a token in the output can only have come from the `.env`
 * these tests write into the main worktree.
 */
const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.VCS_TOKEN;

const sh = (script, cwd) =>
  execFileSync('bash', ['-c', script], { cwd, encoding: 'utf8', env: CLEAN_ENV }).trim();

/**
 * A real repo with a real linked worktree. `.env` is written ONLY to the main
 * tree, exactly as gitignoring it guarantees in practice.
 */
function withRepoAndWorktree(fn) {
  const base = mkdtempSync(join(tmpdir(), 'brain-657-bootstrap-'));
  const main = join(base, 'repo');
  const wt = join(base, 'wt');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', main]);
    const git = (...args) => execFileSync('git', ['-C', main, ...args], { stdio: 'ignore' });
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(join(main, 'seed.txt'), 'seed\n');
    git('add', 'seed.txt');
    git('commit', '-qm', 'seed');
    git('worktree', 'add', '-q', wt, '-b', 'feature/x');
    writeFileSync(join(main, '.env'), 'VCS_TOKEN=tok-from-main-tree\n');
    return fn({ main, wt });
  } finally {
    removeTempTree(base);
  }
}

test('#657 bootstrap.sh REPO_ROOT: resolves to the MAIN worktree from inside a linked worktree', () => {
  withRepoAndWorktree(({ main, wt }) => {
    const script = `${repoRootAssignment()}\nprintf '%s' "$REPO_ROOT"`;

    // Sanity: the main tree was never broken, and must stay that way.
    assert.equal(sh(script, main), main, 'the main tree must keep resolving to itself');

    // The regression: this returned the worktree path before the fix.
    assert.equal(
      sh(script, wt),
      main,
      'a worktree must resolve REPO_ROOT to the main tree — .env lives there and nowhere else',
    );
  });
});

test('#657 bootstrap.sh credential helper: emits the token from a worktree, not an empty password', () => {
  withRepoAndWorktree(({ main, wt }) => {
    // Resolve the helper the way bootstrap.sh does (the two vars it interpolates),
    // then strip git's leading `!` so the shell can run the function directly.
    const resolve = [
      'VCS_TOKEN_VAR=VCS_TOKEN',
      'VCS_CRED_USER=oauth2',
      helperAssignment(),
      `printf '%s' "\${HELPER#!}"`,
    ].join('\n');
    const helper = sh(resolve, main);

    assert.ok(helper.includes('git rev-parse'), 'the helper must resolve .env dynamically');

    for (const [label, cwd] of [['main tree', main], ['worktree', wt]]) {
      const out = sh(helper, cwd);
      assert.match(
        out,
        /^username=oauth2\npassword=tok-from-main-tree$/,
        `the helper must emit the token from the ${label}; got: ${JSON.stringify(out)}`,
      );
    }
  });
});

test('#657 bootstrap.sh: the helper FAILS LOUDLY when the token really is absent (the fix must not mask a missing .env)', () => {
  withRepoAndWorktree(({ main, wt }) => {
    rmSync(join(main, '.env'));
    const resolve = [
      'VCS_TOKEN_VAR=VCS_TOKEN',
      'VCS_CRED_USER=oauth2',
      helperAssignment(),
      `printf '%s' "\${HELPER#!}"`,
    ].join('\n');
    const helper = sh(resolve, main);

    // Non-zero + a message, from the worktree too — not a silent empty password,
    // which is what the caller could not distinguish before.
    assert.throws(
      () => execFileSync('bash', ['-c', helper], { cwd: wt, encoding: 'utf8', stdio: 'pipe', env: CLEAN_ENV }),
      (err) => {
        assert.equal(err.status, 1, 'a missing token must exit non-zero');
        assert.match(String(err.stderr), /VCS_TOKEN/);
        return true;
      },
    );
  });
});
