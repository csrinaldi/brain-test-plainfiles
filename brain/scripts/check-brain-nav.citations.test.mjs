// check-brain-nav.citations.test.mjs — the cited-path check is real (issue #499).
//
// This file exists because the red-proof found the guard UNPINNED: removing the
// cited-path count from the exit condition left `npm test` entirely green while
// the script still printed all 22 findings. A gate that reports and does not fail
// is `evidence-reader-empty-on-failure` wearing a checkmark — and it would have
// been indistinguishable, in CI, from a gate that found nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-brain-nav.mjs');

// Every assertion goes through a SPAWN. The extractor is inline in the script on
// purpose — it is copied standalone into fixtures and into the adoption
// scaffolding, and a relative import breaks it outside its own tree (measured:
// moving it to lib/ turned 5 existing tests red with ERR_MODULE_NOT_FOUND). So the
// unit-level assertions are expressed as gate behaviour over fixture content,
// which is also the form that cannot pass against a gate that reports and does not
// fail — the hole the red-proof found in the first version of this guard.

// The script derives ROOT from its OWN location, not from cwd — so the fixture
// gets its own copy of the script and its lib at the same relative positions.
// Found by measurement: passing `cwd` alone ran the gate against the real repo.
function runNavIn(root) {
  const dest = join(root, 'brain', 'scripts');
  mkdirSync(dest, { recursive: true });
  cpSync(SCRIPT, join(dest, 'check-brain-nav.mjs'));
  return spawnSync('node', [join(dest, 'check-brain-nav.mjs')], { encoding: 'utf8' });
}

function scaffold(fn) {
  const root = mkdtempSync(join(tmpdir(), 'brain-499-'));
  try {
    mkdirSync(join(root, 'brain', 'core', 'methodology'), { recursive: true });
    // A minimal navigable brain/: HOME links the one doc, so orphan and link
    // checks pass and the cited-path check is the only variable.
    writeFileSync(join(root, 'brain', 'HOME.md'), '# HOME\n\n- [m](core/methodology/m.md)\n');
    return fn(root, join(root, 'brain', 'core', 'methodology', 'm.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('#499 the gate EXITS NONZERO on a cited path that does not exist (REQ-499-1)', () => {
  scaffold((root, doc) => {
    writeFileSync(doc, '# m\n\nNever commit to `brain/decisions/`.\n');
    const r = runNavIn(root);
    assert.equal(r.status, 1, `a dead citation must FAIL the gate, not just print. stdout: ${r.stdout}`);
    assert.match(r.stderr, /ruta\(s\) CITADA/, 'and must say so');
    assert.match(r.stderr, /brain\/decisions\//, 'naming the citation');
  });
});

test('#499 the gate stays GREEN when every cited path resolves (REQ-499-1)', () => {
  scaffold((root, doc) => {
    // Cites a path that exists in this fixture — the same shape, resolving.
    writeFileSync(doc, '# m\n\nSee `brain/core/methodology/m.md` and `brain/HOME.md`.\n');
    const r = runNavIn(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  });
});

test('#499 a GLOB is not a citation — `brain/**` must not be demanded to exist', () => {
  // Measured, after a first version asserted the wrong thing: the regex needs a
  // closing backtick and `*` is outside its character class, so `brain/**` never
  // completes a match at all — it does not degrade to `brain/`. The extractor's
  // `.filter(p => !p.includes('*'))` is therefore dead code today, kept as
  // belt-and-braces. Pinned so a future widening of the class cannot silently
  // start failing the gate on every zone-map row.
  scaffold((root, doc) => {
    writeFileSync(doc, '# m\n\nZones: `brain/**` and `brain/core/**` are human-only.\n');
    assert.equal(runNavIn(root).status, 0, 'a glob must not be treated as a destination');
  });
});

test('#499 a cited DIRECTORY counts — the four dead ones were all directories', () => {
  // The tier lists name folders, not files. A check that only resolved `.md`
  // citations would have reported 4 of the 22 and called the gate done, which is
  // what the M4 mutation measured.
  scaffold((root, doc) => {
    writeFileSync(doc, '# m\n\nZones: `brain/project/architecture/`.\n');
    assert.equal(runNavIn(root).status, 1, 'a dead directory citation must fail the gate');
    mkdirSync(join(root, 'brain', 'project', 'architecture'), { recursive: true });
    assert.equal(runNavIn(root).status, 0, 'and pass once it exists');
  });
});
