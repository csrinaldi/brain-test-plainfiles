// local-gate-context.test.mjs — what `brain:check` / `brain:ship` need to know about the
// repo BEFORE a pull request exists, resolved the way the rest of the product resolves it
// (#1186, #1187). Every test is red against the pre-fix `brain-check.mjs`, which never set
// `repo` and read the default branch from a ref a fresh consumer does not have.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testTmp } from './test-tmp.mjs';
import { gitTry } from '../governance/postmerge/git-seam.mjs';
import {
  resolveProjectSlug,
  resolveDefaultBranch,
  npmTestApplicability,
} from './local-gate-context.mjs';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
}

/** A repo whose `origin` is a local bare repo and whose `origin/HEAD` was NEVER set — exactly a fresh `git remote add` + push. */
function consumerWithUnsetOriginHead(defaultBranch) {
  const root = testTmp('local-gate-ctx-');
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  assert.equal(git(root, 'init', '-q', '--bare', '-b', defaultBranch, origin).status, 0);
  git(repo, 'init', '-q', '-b', defaultBranch);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'seed');
  git(repo, 'remote', 'add', 'origin', origin);
  assert.equal(git(repo, 'push', '-q', '-u', 'origin', defaultBranch).status, 0);
  return { root, repo, origin };
}

// ── (a) the project slug ───────────────────────────────────────────────────────────

test('#1186 (a): the slug is brain.config.json project.slug — the field every other verb reads', () => {
  const slug = resolveProjectSlug({ config: { project: { slug: 'acme/widgets' } }, identity: () => ({ project: 'other/thing' }) });
  assert.equal(slug, 'acme/widgets');
});

test('#1186 (a): with no configured slug it falls back to the origin remote, as ensureProjectIdentity does', () => {
  const slug = resolveProjectSlug({ config: {}, identity: () => ({ host: 'github.com', project: 'acme/widgets' }) });
  assert.equal(slug, 'acme/widgets');
});

test('#1186 (a): neither source → null, never the string "undefined"', () => {
  assert.equal(resolveProjectSlug({ config: {}, identity: () => ({ host: null, project: null }) }), null);
});

// ── (b) the default branch, with no `git remote set-head` ──────────────────────────

test('#1186 (b): default branch resolves from the remote when origin/HEAD is unset, and does not mutate the repo', () => {
  const { repo } = consumerWithUnsetOriginHead('trunk');
  assert.notEqual(git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').status, 0,
    'precondition: origin/HEAD is unset, which is what made the local checks UNVERIFIED');
  assert.equal(resolveDefaultBranch({ cwd: repo, env: {} }), 'trunk');
  assert.notEqual(git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').status, 0,
    'the resolver reads; it never runs set-head on the operator\'s behalf');
});

test('#1186 (b): DEFAULT_BRANCH, the variable CI reads, wins over git', () => {
  const { repo } = consumerWithUnsetOriginHead('trunk');
  assert.equal(resolveDefaultBranch({ cwd: repo, env: { DEFAULT_BRANCH: 'release' } }), 'release');
});

test('#1186 (b): a recorded origin/HEAD is used without asking the network', () => {
  const { repo } = consumerWithUnsetOriginHead('main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  const asked = [];
  const spy = { try: (argv) => { asked.push(argv[0]); return gitTry(argv, { cwd: repo }); } };
  assert.equal(resolveDefaultBranch({ cwd: repo, env: {}, git: spy }), 'main');
  assert.ok(!asked.includes('ls-remote'), `ls-remote must stay the fallback, saw: ${asked.join(',')}`);
});

test('#1186 (b): an unreachable remote is null (UNVERIFIED), never a guessed "main"', () => {
  const root = testTmp('local-gate-ctx-offline-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', join(root, 'does-not-exist.git'));
  assert.equal(resolveDefaultBranch({ cwd: repo, env: {} }), null);
});

// ── (c) npm test is "not applicable", not a failure ────────────────────────────────

function pkg(dir, scripts, { source = false } = {}) {
  const d = testTmp('local-gate-ctx-pkg-');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', scripts }));
  if (source) writeFileSync(join(d, '.brain-source'), '');
  return d;
}

test('#1187 (c): no `test` script → not applicable, and the reason is stated', () => {
  const r = npmTestApplicability({ cwd: pkg('a', { start: 'x' }, { source: true }) });
  assert.equal(r.applicable, false);
  assert.match(r.reason, /no "test" script/);
});

test('#1187 (c): a consumer is not applicable even WITH the `npm init` placeholder script — CI runs npm test only in the brain source repo', () => {
  const r = npmTestApplicability({ cwd: pkg('b', { test: 'echo "Error: no test specified" && exit 1' }) });
  assert.equal(r.applicable, false);
  assert.match(r.reason, /brain source/);
});

test('#1187 (c): the brain source repo with a test script is applicable — the same condition as the governance.yml step', () => {
  assert.deepEqual(npmTestApplicability({ cwd: pkg('c', { test: 'node --test' }, { source: true }) }), { applicable: true });
});

test('#1187 (c): no package.json at all → not applicable', () => {
  const r = npmTestApplicability({ cwd: testTmp('local-gate-ctx-empty-') });
  assert.equal(r.applicable, false);
});
