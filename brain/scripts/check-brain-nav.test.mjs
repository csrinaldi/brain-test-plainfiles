// check-brain-nav.test.mjs — Unit tests for the missing brain/HOME.md guard.
//
// Issue #176 bug 3: a missing brain/HOME.md made check-brain-nav.mjs crash
// with a raw ENOENT stack trace instead of a clear, actionable error
// (found live: synergy has no brain/HOME.md from an incomplete adoption).
//
// ROOT inside check-brain-nav.mjs is derived from the script's own file
// location (not cwd), so this test copies the real script into a temp
// fixture root that mirrors brain/scripts/ and lacks brain/HOME.md, then
// spawns it and asserts a clean, actionable failure — no raw ENOENT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REAL_SCRIPT = new URL('./check-brain-nav.mjs', import.meta.url).pathname;

function makeFixtureRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'brain-nav-'));
  const scriptsDir = join(dir, 'brain/scripts');
  mkdirSync(scriptsDir, { recursive: true });
  cpSync(REAL_SCRIPT, join(scriptsDir, 'check-brain-nav.mjs'));
  return dir;
}

function runCheckBrainNav(dir) {
  return spawnSync('node', [join(dir, 'brain/scripts/check-brain-nav.mjs')], {
    encoding: 'utf8',
  });
}

test('check-brain-nav: missing brain/HOME.md → clean actionable error, no raw ENOENT', (t) => {
  const dir = makeFixtureRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // brain/ exists (via brain/scripts/) but has no HOME.md — incomplete adoption.
  const r = runCheckBrainNav(dir);

  assert.notEqual(r.status, 0,
    `expected non-zero exit, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(!/ENOENT/.test(r.stderr),
    `expected no raw ENOENT stack trace in stderr:\n${r.stderr}`);
  assert.ok(/HOME\.md/.test(r.stderr),
    `expected an actionable message naming HOME.md in stderr:\n${r.stderr}`);
});

test('check-brain-nav: happy path (HOME.md present, no orphans/dead links) still exits 0', (t) => {
  const dir = makeFixtureRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'brain/HOME.md'), '# HOME\n');

  const r = runCheckBrainNav(dir);

  assert.equal(r.status, 0,
    `expected exit 0 (clean nav), got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
});

// install-home-scaffold Slice 1, Phase 1: templates are scaffolding sources, not
// navigable docs. brain/core/templates/HOME.template.md ships as part of
// brain/core/** and, if walked like any other .md, would (a) be reported as an
// orphan (HOME.md must not link its own template) and (b) have its links
// (core/methodology/...) resolve relative to brain/core/templates/ and dead-link.
// Both trigger merely from the file existing — so /templates/ must be excluded
// from the walk, mirroring the existing /__fixtures__/ skip.
test('check-brain-nav: a .md file under /templates/ is excluded (no orphan, no dead link)', (t) => {
  const dir = makeFixtureRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'brain/HOME.md'), '# HOME\n');

  // A template file that, if scanned, would dead-link (target does not exist
  // relative to brain/core/templates/) and would itself be an orphan (nothing
  // links to it, by design — HOME.md must not reference its own template).
  mkdirSync(join(dir, 'brain/core/templates'), { recursive: true });
  writeFileSync(
    join(dir, 'brain/core/templates/HOME.template.md'),
    '# Template\n\n[dead](core/methodology/does-not-exist.md)\n',
  );

  const r = runCheckBrainNav(dir);

  assert.equal(r.status, 0,
    `expected exit 0 (template excluded from nav walk), got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
});

// install-home-scaffold Slice 1 review fix: the /templates/ exclusion must be
// anchored to brain/core/templates/ (the shipped scaffold source), NOT a loose
// substring on "/templates/". check-brain-nav is a governance gate; a consumer
// dir like brain/project/templates/ must NOT silently lose nav coverage, or the
// gate would hide real orphans and dead links inside it.
test('check-brain-nav: a .md under a NON-core templates/ dir is still scanned (orphan/dead-link caught)', (t) => {
  const dir = makeFixtureRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'brain/HOME.md'), '# HOME\n');

  // A consumer doc under a project-level templates/ dir: both an orphan (nothing
  // links to it) and dead-linked. Only brain/core/templates/ is scaffolding to
  // exclude — every other "templates" path is real content the gate must cover.
  mkdirSync(join(dir, 'brain/project/templates'), { recursive: true });
  writeFileSync(
    join(dir, 'brain/project/templates/consumer-doc.md'),
    '# Consumer doc\n\n[broken](./nope.md)\n',
  );

  const r = runCheckBrainNav(dir);

  assert.notEqual(r.status, 0,
    `expected non-zero exit (a non-core templates/ file must be scanned), got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
});
