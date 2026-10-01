// bootstrap.env-gitignore.test.mjs — issue #1112, finding 1.
//
// Neither `npx brain init` nor `env:init` ever created or amended a
// `.gitignore` in the consumer, so a fresh repo's `.env` — the file
// `env:init` writes the operator's PAT into (bootstrap.sh §3) — was
// untracked but NOT ignored. The very next `git add -A` committed the
// token.
//
// Same idiom as the other bootstrap.*.test.mjs files: the function is
// LIFTED OUT OF bootstrap.sh between sentinel comments and executed against
// a real temp git repo, so there is no second copy of the logic to drift
// from the real one (#340). `git check-ignore` is used (not a plain grep)
// because it honors every applicable `.gitignore`, not just a literal line
// in the repo-root file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');
const SOURCE = readFileSync(BOOTSTRAP, 'utf8');
const LINES = SOURCE.split('\n');

function ensureEnvGitignoredFragment() {
  const start = LINES.findIndex((l) => l.includes('BEGIN ensure-env-gitignored'));
  assert.ok(start >= 0, 'bootstrap.sh must have a BEGIN ensure-env-gitignored marker');
  const end = LINES.findIndex((l, i) => i > start && l.includes('END ensure-env-gitignored'));
  assert.ok(end > start, 'bootstrap.sh must have a matching END ensure-env-gitignored marker');
  return LINES.slice(start + 1, end).join('\n');
}

const FRAGMENT = ensureEnvGitignoredFragment();

/** A real git repo in a temp dir — `git check-ignore` needs a real .git. */
function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-1112-envgitignore-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    return fn(dir);
  } finally {
    removeTempTree(dir);
  }
}

function runFragment(dir) {
  const script = [
    'set -euo pipefail',
    `cd "${dir}"`,
    'ok() { :; }',
    'warn() { :; }',
    'I18N_BOOTSTRAP_GITIGNORE_OK=ok',
    'I18N_BOOTSTRAP_GITIGNORE_FAILED=failed',
    FRAGMENT,
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

test('#1112 a fresh repo with no .gitignore: one is created, .env ends up ignored', () => {
  withRepo((dir) => {
    const result = runFragment(dir);
    assert.equal(result.status, 0, `fragment must succeed; stderr:\n${result.stderr}`);
    const check = spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: dir });
    assert.equal(check.status, 0, '.env must be git-ignored after the fragment runs');
  });
});

test('#1112 an existing .gitignore missing a trailing newline is appended to correctly, not corrupted', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, '.gitignore'), 'node_modules/'); // no trailing \n, on purpose
    const result = runFragment(dir);
    assert.equal(result.status, 0, `fragment must succeed; stderr:\n${result.stderr}`);
    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.match(content, /^node_modules\/\s*$/m, 'the pre-existing line must survive intact, not get glued to the new one');
    assert.match(content, /^\.env\s*$/m, '.env must be its own line');
    const check = spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: dir });
    assert.equal(check.status, 0);
  });
});

test('#1112 idempotent: running twice does not duplicate the .env line', () => {
  withRepo((dir) => {
    runFragment(dir);
    runFragment(dir);
    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    const envLines = content.split('\n').filter((l) => l.trim() === '.env');
    assert.equal(envLines.length, 1, `expected exactly one ".env" line, got:\n${content}`);
  });
});

test('#1112 a broader existing pattern (.env*) already covers it: no redundant literal line is added', () => {
  withRepo((dir) => {
    writeFileSync(join(dir, '.gitignore'), '.env*\n');
    const result = runFragment(dir);
    assert.equal(result.status, 0);
    const content = readFileSync(join(dir, '.gitignore'), 'utf8');
    assert.ok(!content.includes('\n.env\n') && !content.startsWith('.env\n'), `must not add a redundant ".env" line when already covered:\n${content}`);
    const check = spawnSync('git', ['check-ignore', '-q', '.env'], { cwd: dir });
    assert.equal(check.status, 0);
  });
});

test('#1112 structural guard: the gitignore-ensure step runs BEFORE the PAT is ever written to .env', () => {
  const beginIdx = LINES.findIndex((l) => l.includes('BEGIN ensure-env-gitignored'));
  const patWriteIdx = LINES.findIndex((l) => l.includes('env_set "$VCS_TOKEN_VAR"'));
  assert.ok(beginIdx >= 0 && patWriteIdx >= 0);
  assert.ok(beginIdx < patWriteIdx, 'ensure_env_gitignored must run before the PAT is written to .env');
});
