// home-scaffold-nav-integrity.test.mjs — Fixture test proving the scaffolded
// HOME.md reaches every brain/core/**/*.md a fresh consumer ships with, with
// zero dead links (install-home-scaffold, REQ-3/REQ-6).
//
// Model: check-brain-nav.test.mjs's spawn pattern. ROOT inside
// check-brain-nav.mjs is derived from the script's own file location (not
// cwd), so this test copies the real script plus a real brain/core/ copy into
// a temp fixture root that mirrors a fresh consumer (no brain/project/**,
// no docs/), scaffolds brain/HOME.md via ensureHome(), then spawns the real
// check-brain-nav.mjs and asserts exit 0.
//
// If this fails after a correct implementation, the TEMPLATE is missing a
// link to a reachable brain/core/**/*.md file — fix the template, not this
// test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { ensureHome } from './home-scaffold.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(LIB_DIR, '..', '..', '..');
const REAL_CHECK_SCRIPT = join(REPO_ROOT, 'brain', 'scripts', 'check-brain-nav.mjs');
const REAL_CORE_DIR = join(REPO_ROOT, 'brain', 'core');
const REAL_SCRIPTS_DIR = join(REPO_ROOT, 'brain', 'scripts');

function makeFreshConsumerFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'home-scaffold-nav-'));
  // brain/scripts/** is a MANAGED path (managed-paths.mjs) — a real consumer
  // receives all of it on brain:upgrade, and brain/core/** docs cite into it
  // (reviewer-protocol.md → vcs/cli.mjs, sdd-layout.md → lib/sdd-layout.mjs).
  // Copying one script modelled an environment no consumer is ever in, which
  // the link-only check could not see and the citation check can.
  cpSync(REAL_SCRIPTS_DIR, join(dir, 'brain', 'scripts'), { recursive: true });
  cpSync(REAL_CORE_DIR, join(dir, 'brain', 'core'), { recursive: true });
  return dir;
}

test('nav-integrity: scaffolded HOME.md + real brain/core/** passes check-brain-nav (exit 0)', (t) => {
  const dir = makeFreshConsumerFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const scaffoldResult = ensureHome(dir);
  assert.deepEqual(scaffoldResult, { created: true }, 'ensureHome must create brain/HOME.md on a fresh consumer');

  const r = spawnSync('node', [join(dir, 'brain/scripts/check-brain-nav.mjs')], { encoding: 'utf8' });

  assert.equal(r.status, 0,
    `expected exit 0 (nav-clean fresh consumer), got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(!/huérfano/.test(r.stderr), `expected zero orphans, got:\n${r.stderr}`);
  assert.ok(!/roto/.test(r.stderr), `expected zero dead links, got:\n${r.stderr}`);
});
