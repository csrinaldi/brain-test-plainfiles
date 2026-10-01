// home-index-nav-integrity.test.mjs — Fixture test proving a HOME.md patched
// by insertAdrLink keeps brain:nav clean end to end (install-home-scaffold,
// REQ-6 of the home-index spec).
//
// Model: home-scaffold-nav-integrity.test.mjs's spawn pattern. ROOT inside
// check-brain-nav.mjs is derived from the script's own file location (not
// cwd), so this test copies the real script plus a real brain/core/ copy
// into a temp fixture root that mirrors a fresh consumer, scaffolds
// brain/HOME.md via ensureHome(), adds a real ADR fixture file under
// brain/project/decisions/, patches HOME.md via insertAdrLink(), then spawns
// the real check-brain-nav.mjs and asserts exit 0.
//
// If this fails after a correct implementation, either the template or
// insertAdrLink's insertion point is wrong — fix the implementation, not
// this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { ensureHome } from './home-scaffold.mjs';
import { insertAdrLink } from './home-index.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(LIB_DIR, '..', '..', '..');
const REAL_CHECK_SCRIPT = join(REPO_ROOT, 'brain', 'scripts', 'check-brain-nav.mjs');
const REAL_CORE_DIR = join(REPO_ROOT, 'brain', 'core');
const REAL_SCRIPTS_DIR = join(REPO_ROOT, 'brain', 'scripts');

const ADR_CONTENT = [
  '# ADR-0099 — Example: Decision title',
  '',
  '## Decision',
  '',
  'Use the pure home-index helper to keep HOME.md navigable.',
  '',
].join('\n');

function makeFreshConsumerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'home-index-nav-'));
  const scriptsDir = join(dir, 'brain', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  // brain/scripts/** is MANAGED (managed-paths.mjs): a real consumer gets all of
  // it, and brain/core/** docs cite into it. One script modelled an environment
  // no consumer is ever in — invisible to a link-only check, visible to this one.
  cpSync(REAL_SCRIPTS_DIR, scriptsDir, { recursive: true });
  cpSync(REAL_CORE_DIR, join(dir, 'brain', 'core'), { recursive: true });
  return dir;
}

test('nav-integrity: HOME.md patched via insertAdrLink with a real ADR passes check-brain-nav (exit 0)', (t) => {
  const dir = makeFreshConsumerFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const scaffoldResult = ensureHome(dir);
  assert.deepEqual(scaffoldResult, { created: true }, 'ensureHome must create brain/HOME.md on a fresh consumer');

  const decisionsDir = join(dir, 'brain', 'project', 'decisions');
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(join(decisionsDir, 'adr-0099-example.md'), ADR_CONTENT, 'utf8');

  const homePath = join(dir, 'brain', 'HOME.md');
  const before = readFileSync(homePath, 'utf8');
  const patch = insertAdrLink(before, {
    number: 99,
    slug: 'adr-0099-example',
    description: 'Example: Decision title',
  });
  assert.equal(patch.inserted, true, 'insertAdrLink must insert into a freshly scaffolded HOME.md');
  writeFileSync(homePath, patch.text, 'utf8');

  const r = spawnSync('node', [join(dir, 'brain/scripts/check-brain-nav.mjs')], { encoding: 'utf8' });

  assert.equal(r.status, 0,
    `expected exit 0 (nav-clean after ADR indexing), got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(!/huérfano/.test(r.stderr), `expected zero orphans, got:\n${r.stderr}`);
  assert.ok(!/roto/.test(r.stderr), `expected zero dead links, got:\n${r.stderr}`);
});
