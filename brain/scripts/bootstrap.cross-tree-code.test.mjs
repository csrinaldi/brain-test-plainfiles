// bootstrap.cross-tree-code.test.mjs — bootstrap.sh runs the INVOKING tree's
// own code, not the MAIN worktree's stale copy (issue #1093).
//
// ── The bug, precisely ──────────────────────────────────────────────────────
//
// #657 made bootstrap.sh `cd` into the MAIN worktree — correctly, because
// `.env` is gitignored and lives only there. But it then ran EVERYTHING from
// that directory, including `node brain/scripts/**` and `$PM run brain:*`,
// which resolve relative to cwd. When the calling worktree holds a newer
// brain than the main checkout (every adoption or upgrade-on-a-branch), the
// bootstrap silently executes the OLD code against the OLD tree — a real
// reproduction in `csrinaldi/synergy` printed two `Cannot find module` errors
// and re-registered a merge driver 1.6.0 had already retired (#958), then
// still printed `== Environment ready ==`.
//
// ── Why this lifts snippets instead of asserting on the file's text ────────
//
// Same reasoning as `bootstrap.worktree.test.mjs` (#657): a test that greps
// bootstrap.sh for the absence of a bare `node brain/scripts/...` call would
// pass against any replacement, correct or not, and would go green on a
// helper that no longer runs at all. Every expression under test here is
// LIFTED OUT OF THE FILE and executed — there is no second copy to drift
// from the first (#340).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');
const SOURCE = readFileSync(BOOTSTRAP, 'utf8');
const LINES = SOURCE.split('\n');

/**
 * The verbatim single line beginning with `prefix` (ignoring leading
 * indentation), as bootstrap.sh writes it today.
 */
function line(prefix) {
  const l = LINES.find((s) => s.trimStart().startsWith(prefix));
  assert.ok(l, `bootstrap.sh must have a line starting with "${prefix}"`);
  return l.trim();
}

/** The verbatim memory-step helper functions (#1127). */
function helpers() {
  const start = LINES.findIndex((s) => s.includes('BEGIN memory-step-helpers'));
  const end = LINES.findIndex((s, i) => i > start && s.includes('END memory-step-helpers'));
  assert.ok(start >= 0 && end > start, 'bootstrap.sh must carry the memory-step-helpers block');
  return LINES.slice(start, end).join('\n');
}

/** The verbatim `if [ ! -d "$BRAIN_SCRIPTS" ]; then ... fi` guard, whole. */
function brainScriptsGuard() {
  const start = LINES.findIndex((s) => s.startsWith('if [ ! -d "$BRAIN_SCRIPTS" ]'));
  assert.ok(start !== -1, 'bootstrap.sh must guard on BRAIN_SCRIPTS existing');
  const end = LINES.findIndex((s, i) => i > start && s === 'fi');
  assert.ok(end !== -1, 'the BRAIN_SCRIPTS guard must close with fi');
  return LINES.slice(start, end + 1).join('\n');
}

const CLEAN_ENV = { ...process.env };
delete CLEAN_ENV.VCS_TOKEN;

// stdout AND stderr merged: the warn/error output this suite checks for is
// written to fd2 (`printf ... >&2`), and `execFileSync` otherwise only
// captures fd1.
const sh = (script, cwd) =>
  execFileSync('bash', ['-c', `{\n${script}\n} 2>&1`], { cwd, encoding: 'utf8', env: CLEAN_ENV });

/**
 * A real repo with a real linked worktree, each carrying its OWN
 * `brain/scripts/**` — exactly the shape a version-mismatched adoption or
 * upgrade-on-a-branch produces. `.env` is written ONLY to the main tree
 * (#657's invariant, unchanged by this fix).
 */
function withRepoAndWorktree(fn) {
  const base = mkdtempSync(join(tmpdir(), 'brain-1093-bootstrap-'));
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
    writeFileSync(join(main, '.env'), 'VCS_TOKEN=tok\n');
    return fn({ main, wt });
  } finally {
    removeTempTree(base);
  }
}

// ── WORKTREE_ROOT / BRAIN_SCRIPTS resolve to the INVOKING tree ─────────────

test('#1093 bootstrap.sh WORKTREE_ROOT/BRAIN_SCRIPTS: resolve to the invoking tree, not the main tree', () => {
  withRepoAndWorktree(({ main, wt }) => {
    const script = [
      line('WORKTREE_ROOT='),
      line('BRAIN_SCRIPTS='),
      'printf \'%s\\n%s\' "$WORKTREE_ROOT" "$BRAIN_SCRIPTS"',
    ].join('\n');

    const [rootMain, scriptsMain] = sh(script, main).split('\n');
    assert.equal(rootMain, main, 'from the main tree, WORKTREE_ROOT is the main tree');
    assert.equal(scriptsMain, join(main, 'brain', 'scripts'));

    const [rootWt, scriptsWt] = sh(script, wt).split('\n');
    assert.equal(rootWt, wt, 'from a worktree, WORKTREE_ROOT is the WORKTREE — never the main tree');
    assert.equal(scriptsWt, join(wt, 'brain', 'scripts'));
  });
});

// ── Direct `node brain/scripts/**` calls run the WORKTREE's own copy ───────

test("#1093 bootstrap.sh home-scaffold call: runs the WORKTREE's module, not a missing main-tree one", () => {
  withRepoAndWorktree(({ main, wt }) => {
    // worktree: a working stub that writes a marker.
    mkdirSync(join(wt, 'brain', 'scripts', 'lib'), { recursive: true });
    writeFileSync(
      join(wt, 'brain', 'scripts', 'lib', 'home-scaffold.mjs'),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync('HOME_SCAFFOLD_MARKER', 'worktree-ran\\n');\n",
    );
    // main tree deliberately has NO brain/scripts/lib/home-scaffold.mjs at
    // all — the exact synergy shape: an old checkout that predates the file.

    const script = [
      line('WORKTREE_ROOT='),
      line('BRAIN_SCRIPTS='),
      'MISSING_OPTIONAL=()',
      `REPO_ROOT=${JSON.stringify(main)}`,
      'cd "$REPO_ROOT"',
      line('node "$BRAIN_SCRIPTS/lib/home-scaffold.mjs" ensure'),
    ].join('\n');

    sh(script, wt);
    assert.ok(
      existsSync(join(main, 'HOME_SCAFFOLD_MARKER')),
      "the WORKTREE's home-scaffold.mjs must have run (writing the marker into cwd=REPO_ROOT) — " +
      'main tree has no such module at all, so the OLD (relative-path) invocation would MODULE_NOT_FOUND instead',
    );
  });
});

// ── The two silent `|| true` swallows become visible + tracked ─────────────

test('#1093 bootstrap.sh home-scaffold failure: is WARNED about and tracked in MISSING_OPTIONAL, not silently swallowed', () => {
  withRepoAndWorktree(({ main, wt }) => {
    mkdirSync(join(wt, 'brain', 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(wt, 'brain', 'scripts', 'lib', 'home-scaffold.mjs'), 'process.exit(1);\n');

    const script = [
      line('WORKTREE_ROOT='),
      line('BRAIN_SCRIPTS='),
      'MISSING_OPTIONAL=()',
      `REPO_ROOT=${JSON.stringify(main)}`,
      'cd "$REPO_ROOT"',
      line('node "$BRAIN_SCRIPTS/lib/home-scaffold.mjs" ensure'),
      'printf \'COUNT=%s\\n\' "${#MISSING_OPTIONAL[@]}"',
    ].join('\n');

    const out = sh(script, wt);
    assert.match(out, /⚠/, 'a failed home-scaffold step must print a visible warning, not vanish behind `|| true`');
    assert.match(out, /COUNT=1/, 'a failed home-scaffold step must be tracked in MISSING_OPTIONAL');
  });
});

// ── Hard guard: an incomplete checkout (no brain/scripts/) refuses to run ──

test('#1093 bootstrap.sh: exits non-zero immediately when the invoking tree has no brain/scripts/ at all', () => {
  withRepoAndWorktree(({ wt }) => {
    // wt has no brain/ directory whatsoever — an incomplete/corrupted checkout.
    const script = [
      line('WORKTREE_ROOT='),
      line('BRAIN_SCRIPTS='),
      brainScriptsGuard(),
      'echo SHOULD_NOT_REACH_HERE',
    ].join('\n');

    assert.throws(
      () => execFileSync('bash', ['-c', script], { cwd: wt, encoding: 'utf8', stdio: 'pipe', env: CLEAN_ENV }),
      (err) => {
        assert.notEqual(err.status, 0, 'a missing brain/scripts/ must exit non-zero');
        assert.doesNotMatch(String(err.stdout), /SHOULD_NOT_REACH_HERE/, 'must stop before continuing past the guard');
        return true;
      },
    );
  });
});

test('#1093 bootstrap.sh: the brain/scripts/ guard does NOT fire when the invoking tree is complete', () => {
  withRepoAndWorktree(({ wt }) => {
    mkdirSync(join(wt, 'brain', 'scripts'), { recursive: true });
    const script = [
      line('WORKTREE_ROOT='),
      line('BRAIN_SCRIPTS='),
      brainScriptsGuard(),
      'echo REACHED',
    ].join('\n');

    assert.equal(sh(script, wt).trim(), 'REACHED');
  });
});

// ── `$PM run brain:memory:*` runs the WORKTREE's package.json, not main's ──

test("#1093 bootstrap.sh memory pull: runs against the WORKTREE's package.json, not the main tree's", () => {
  withRepoAndWorktree(({ main, wt }) => {
    const pkg = (marker) => JSON.stringify({
      name: 'fixture',
      scripts: { 'brain:memory:pull': `node -e "require('fs').writeFileSync('${marker}', 'ran')"` },
    }, null, 2);
    writeFileSync(join(main, 'package.json'), pkg('MAIN_PULL_MARKER'));
    writeFileSync(join(wt, 'package.json'), pkg('WT_PULL_MARKER'));

    const script = [
      line('WORKTREE_ROOT='),
      line('BRAIN_SCRIPTS='),
      `REPO_ROOT=${JSON.stringify(main)}`,
      'cd "$REPO_ROOT"',
      'PM=npm',
      'ok() { :; }; warn() { :; }', // stubs — bootstrap.sh defines these earlier; irrelevant here
      // Slice A (#1127): the pull runs through run_memory_pull. The preflight is stubbed so the
      // question under test stays WHICH package.json ran, in WHICH directory.
      'MISSING_OPTIONAL=(); REQUIRED_FAILURES=()',
      helpers(),
      'memory_pull_unavailable() { return 1; }',
      'run_memory_pull',
    ].join('\n');

    sh(script, wt);
    // The `(cd "$WORKTREE_ROOT" && ...)` subshell runs `npm run` WITH cwd set
    // to the worktree, so the marker lands there — proving both halves at
    // once: which package.json's script body ran, AND that it ran with the
    // worktree (not REPO_ROOT/main) as its own cwd.
    assert.ok(existsSync(join(wt, 'WT_PULL_MARKER')), "the WORKTREE's brain:memory:pull script must have run, in the worktree");
    assert.ok(!existsSync(join(main, 'MAIN_PULL_MARKER')), "the MAIN tree's (stale) brain:memory:pull script must NOT have run");
    assert.ok(!existsSync(join(wt, 'MAIN_PULL_MARKER')), "the MAIN tree's script body must not run anywhere");
  });
});
