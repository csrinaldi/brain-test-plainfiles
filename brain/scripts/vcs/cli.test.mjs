// cli.test.mjs — Unit tests for the VCS adapter foundation (PR1).
// Run with: npm test  (node --test, no dependencies)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProviderName, getVcs, VERBS } from './cli.mjs';
import {
  normalizeCommitStatus,
  providerState,
  assigneeParams,
} from './lib/normalize.mjs';
import { migrateConfig } from '../lib/installer.mjs';
import { migrations } from '../../core/config-migrations.mjs';

// ── Dispatcher: provider resolution ─────────────────────────────────────────────
test('resolveProviderName reads vcs.provider from config', () => {
  assert.equal(resolveProviderName({ config: { vcs: { provider: 'github' } }, env: {} }), 'github');
});

test('resolveProviderName: VCS_PROVIDER env overrides config', () => {
  assert.equal(
    resolveProviderName({ config: { vcs: { provider: 'gitlab' } }, env: { VCS_PROVIDER: 'github' } }),
    'github',
  );
});

test('resolveProviderName: an explicit provider arg wins over VCS_PROVIDER env AND config (runtime provider — finding #14)', () => {
  assert.equal(
    resolveProviderName({
      provider: 'gitlab',
      env: { VCS_PROVIDER: 'github' },
      config: { vcs: { provider: 'github' } },
    }),
    'gitlab',
  );
  // A null/absent override falls through to the existing env>config precedence.
  assert.equal(
    resolveProviderName({ provider: null, env: {}, config: { vcs: { provider: 'github' } } }),
    'github',
  );
});

test('resolveProviderName throws a helpful error when unset', () => {
  assert.throws(
    () => resolveProviderName({ config: {}, env: {} }),
    /no provider configured.*brain\.config\.json/s,
  );
});

test('resolveProviderName treats the post-migration empty provider as unset', () => {
  // After the v0.2.0 migration and before the user fills it in, vcs.provider is ''.
  assert.throws(
    () => resolveProviderName({ config: { vcs: { provider: '' } }, env: {} }),
    /no provider configured/,
  );
});

test('getVcs rejects an invalid provider name (path-traversal guard)', async () => {
  await assert.rejects(
    getVcs({ config: { vcs: { provider: '../lib/normalize' } }, env: {} }),
    /invalid provider name/,
  );
});

test('getVcs loads the matching provider module', async () => {
  const gh = await getVcs({ config: { vcs: { provider: 'github' } }, env: {} });
  assert.equal(gh.PROVIDER, 'github');
  const gl = await getVcs({ config: { vcs: { provider: 'gitlab' } }, env: {} });
  assert.equal(gl.PROVIDER, 'gitlab');
});

test('getVcs throws for an unknown provider', async () => {
  await assert.rejects(
    getVcs({ config: { vcs: { provider: 'nope' } }, env: {} }),
    /provider 'nope' not found/,
  );
});

test('both providers expose every contract verb', async () => {
  for (const name of ['github', 'gitlab']) {
    const mod = await getVcs({ config: { vcs: { provider: name } }, env: {} });
    for (const verb of VERBS) {
      assert.equal(typeof mod[verb], 'function', `${name}.${verb} must be a function`);
    }
  }
});

// ── Normalization ───────────────────────────────────────────────────────────────
test('normalizeCommitStatus maps GitHub enum to canonical', () => {
  assert.equal(normalizeCommitStatus('github', 'failure'), 'failed');
  assert.equal(normalizeCommitStatus('github', 'cancelled'), 'canceled');
  assert.equal(normalizeCommitStatus('github', 'in_progress'), 'running');
  assert.equal(normalizeCommitStatus('github', 'success'), 'success');
  assert.equal(normalizeCommitStatus('github', 'skipped'), null);
  assert.equal(normalizeCommitStatus('github', null), null);
});

test('normalizeCommitStatus passes GitLab values through, guards unknowns', () => {
  assert.equal(normalizeCommitStatus('gitlab', 'failed'), 'failed');
  assert.equal(normalizeCommitStatus('gitlab', 'canceled'), 'canceled');
  assert.equal(normalizeCommitStatus('gitlab', 'weird'), null);
});

test('providerState maps open → opened only for gitlab', () => {
  assert.equal(providerState('gitlab', 'open'), 'opened');
  assert.equal(providerState('github', 'open'), 'open');
});

test('assigneeParams produces provider-specific query params', () => {
  assert.deepEqual(assigneeParams('gitlab', 'none'), { assignee_id: 'None' });
  assert.deepEqual(assigneeParams('gitlab', 'me', 'crinaldi'), { assignee_username: 'crinaldi' });
  assert.deepEqual(assigneeParams('github', 'me', 'crinaldi'), { assignee: 'crinaldi' });
  assert.deepEqual(assigneeParams('github', 'none'), { assignee: 'none' });
  assert.deepEqual(assigneeParams('github', undefined), {});
});

// ── Migrations (real registry, additive) ────────────────────────────────────────
// docs.language is v0.2.0 (ADR-0009); vcs.provider is v0.3.0 (rebased after the
// language policy landed on main).
test('migrating to v0.3.0 adds docs.language and vcs.provider without clobbering', () => {
  const config = {
    schemaVersion: '0.1.0',
    project: { name: 'mine', slug: 'org/repo', gitHost: 'github.com' },
  };
  const { config: migrated, applied } = migrateConfig(config, migrations, '0.3.0');

  assert.ok(applied.includes('0.2.0'));             // docs.language
  assert.ok(applied.includes('0.3.0'));             // vcs.provider
  assert.equal(migrated.docs.language, 'en');       // v0.2.0 default
  assert.equal(migrated.vcs.provider, '');          // v0.3.0 default
  assert.equal(migrated.project.name, 'mine');      // existing values intact
  assert.equal(migrated.project.gitHost, 'github.com');
  assert.equal(migrated.schemaVersion, '0.3.0');
});

test('vcs.provider migration never overwrites a provider the user already set', () => {
  const config = { schemaVersion: '0.2.0', vcs: { provider: 'gitlab' } };
  const { config: migrated } = migrateConfig(config, migrations, '0.3.0');
  assert.equal(migrated.vcs.provider, 'gitlab');    // user value wins
});
