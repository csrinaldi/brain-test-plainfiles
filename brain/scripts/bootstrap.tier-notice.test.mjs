// bootstrap.tier-notice.test.mjs — env:init states the governance tier
// (issue #1124).
//
// In #1081 env:init wrote `standard` for a new one-person repository and never
// said so; that repository's lane PR could not have merged. The ruling: a NEW
// consumer gets `lite`, an EXISTING one keeps its tier, and env:init says which,
// why, and how to change it.
//
// Same idiom as bootstrap.worktree.test.mjs / bootstrap.cross-tree-code.test.mjs:
// the line under test is LIFTED OUT OF bootstrap.sh and executed, never
// re-typed, so there is no second copy to drift from the first (#340). The
// consumer tree gets a real copy of brain/scripts + brain/core, because
// `brain-config.mjs` resolves the config it writes relative to ITS OWN module
// path — a symlink would resolve to this checkout and write here instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = join(HERE, '..', '..');
const LINES = readFileSync(join(HERE, 'bootstrap.sh'), 'utf8').split('\n');

function line(prefix) {
  const l = LINES.find((s) => s.trimStart().startsWith(prefix));
  assert.ok(l, `bootstrap.sh must have a line starting with "${prefix}"`);
  return l.trim();
}

/** The whole `ensure` statement: its line plus the `|| { … }` failure classification that follows (#1127). */
function ensureStatement() {
  const start = LINES.findIndex((s) => s.startsWith('node "$BRAIN_SCRIPTS/lib/brain-config.mjs" ensure'));
  assert.ok(start >= 0, 'bootstrap.sh must run brain-config.mjs ensure');
  const end = LINES.findIndex((s, i) => i > start && s === '}');
  return LINES.slice(start, end + 1).join('\n');
}

/** Copies what a consumer carries after `brain init`: brain/scripts + brain/core, no tests. */
function copyBrain(dest) {
  const keep = (src) => !src.endsWith('.test.mjs') && basename(src) !== '__fixtures__' && basename(src) !== 'node_modules';
  cpSync(join(SOURCE_ROOT, 'brain', 'scripts'), join(dest, 'brain', 'scripts'), { recursive: true, filter: keep });
  cpSync(join(SOURCE_ROOT, 'brain', 'core'), join(dest, 'brain', 'core'), { recursive: true, filter: keep });
}

function withConsumer(fn) {
  const base = mkdtempSync(join(tmpdir(), 'brain-1124-tier-'));
  const repo = join(base, 'repo');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git']);
    copyBrain(repo);
    return fn(repo);
  } finally {
    removeTempTree(base);
  }
}

/** Runs bootstrap.sh's own ensure line from the consumer root, stdout+stderr merged. */
function runEnsure(repo) {
  const script = [
    'MISSING_OPTIONAL=()',
    `BRAIN_SCRIPTS=${JSON.stringify(join(repo, 'brain', 'scripts'))}`,
    'REQUIRED_FAILURES=()',
    ensureStatement(),
  ].join('\n');
  return execFileSync('bash', ['-c', `{\n${script}\n} 2>&1`], { cwd: repo, encoding: 'utf8' });
}

test('#1124 env:init on a NEW consumer: writes governance.tier lite and says so, why, and how to change it', () => {
  withConsumer((repo) => {
    const out = runEnsure(repo);
    const cfg = JSON.parse(readFileSync(join(repo, 'brain.config.json'), 'utf8'));
    assert.equal(cfg.governance.tier, 'lite', 'a config env:init creates declares lite');
    assert.match(out, /governance tier: lite/, `the tier line must appear in env:init's output:\n${out}`);
    assert.match(out, /one maintainer/i);
    assert.match(out, /standard/);
    assert.match(out, /regulated/);
    assert.match(out, /brain:config -- set governance\.tier/);
  });
});

test('#1124 env:init on an EXISTING standard consumer: states standard, and leaves the file byte-identical', () => {
  withConsumer((repo) => {
    const before = JSON.stringify({
      project: { name: 'w', slug: 'acme/widget', gitHost: 'github.com', gitProjectId: '', owner: '' },
      vcs: { provider: 'github' },
      governance: { tier: 'standard' },
      schemaVersion: '1.6.0',
    }, null, 2) + '\n';
    writeFileSync(join(repo, 'brain.config.json'), before);
    const out = runEnsure(repo);
    assert.equal(readFileSync(join(repo, 'brain.config.json'), 'utf8'), before, 'an existing config is not rewritten');
    assert.match(out, /governance tier: standard/, `the declared tier must be stated:\n${out}`);
    assert.match(out, /unchanged/i);
    assert.doesNotMatch(out, /governance tier: lite/);
  });
});
