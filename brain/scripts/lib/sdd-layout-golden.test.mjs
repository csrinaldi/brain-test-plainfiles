// sdd-layout-golden.test.mjs — F1: the frozen-corpus behavior-preservation proof
// (issue #253, slice B1, REQ-B1-2). Test-scoped, budget-free (design §2.2 / §7
// open item 3): this file is BOTH the capture routine (run once, pre-wiring, to
// generate the committed fixture) AND the regression test that re-runs forever
// after.
//
// The iteration mechanism (the pin's core, design §2.2): every test below
// iterates `Object.keys(fixture.changes)` — the FROZEN keys recorded in the
// committed fixture — and rebuilds an injected fake-fs EXCLUSIVELY from each
// key's recorded `facts`. NEVER a live `readdir(openspec/changes)`. A new dir
// created after capture (including issue-253-b1 itself) has no fixture entry
// and is therefore out of scope by construction — see the guard test below.
//
// RED→GREEN sequence (design §2.2):
//   1. Pre-wiring: `node brain/scripts/lib/sdd-layout-golden.test.mjs` (CLI
//      entry, guarded below) walks the REAL openspec/changes/* tree and writes
//      sdd-layout.golden.json. Committed BEFORE any site is touched.
//   2. Each site is wired (Phase 2, RED→GREEN per site).
//   3. This file's `test()` blocks recompute every gate's verdict from the
//      fixture's frozen facts via the (now-wired) library functions and assert
//      `deepEqual` against the committed BEFORE value. Zero diff → GREEN.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANGES_ROOT, changeDir, missingRequiredArtifacts, OPERATIONAL_ARTIFACTS } from './sdd-layout.mjs';
import { requiredArtifactsFor } from '../vcs/governance-tiers.mjs';

// #555: the golden corpus was frozen when the required set was a fixed four. It is
// now tier-resolved, and these fixtures pin the `standard` set deliberately — the
// question they answer is "did the B1 wiring change any verdict", which must stay
// measured against the SAME set it was frozen with. A tier-varying golden would be
// answering a different question with the same name.
const GOLDEN_ARTEFACTS = requiredArtifactsFor('standard');
import { evaluatePhaseOrder, applyBaselineExemption } from '../vcs/phase-order-check.mjs';
import { deriveChangeFromBranch } from '../session-start.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
// Suffix `.golden.json` (not `.fixture.json`) is deliberate: it matches the
// `**/*.golden.json` governance.ignoreList glob (brain.config.json) — a
// machine-generated snapshot whose generator (this file) is reviewed counts
// as test data, not review surface, for the diff-size budget gate.
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'sdd-layout.golden.json');
const SELF_CHANGE_ID = 'issue-253-b1';

// ── Facts extraction (capture-time only — reads the REAL tree) ──────────────

function readRealFacts(name) {
  const dir = join(REPO_ROOT, CHANGES_ROOT, name);
  const proposal = existsSync(join(dir, 'proposal.md'));
  const specFlat = existsSync(join(dir, 'spec.md'));
  const specsDirPath = join(dir, 'specs');
  const specsDirExists = existsSync(specsDirPath);
  let specsEntries = [];
  if (specsDirExists) {
    try {
      specsEntries = readdirSync(specsDirPath);
    } catch {
      specsEntries = [];
    }
  }
  const specsWithSpecMd = specsEntries.filter((e) => existsSync(join(specsDirPath, e, 'spec.md')));
  const design = existsSync(join(dir, 'design.md'));
  const tasks = existsSync(join(dir, 'tasks.md'));
  const resume = existsSync(join(dir, 'resume.md'));
  return {
    proposal,
    specFlat,
    specsDirExists,
    specsEntries: [...specsEntries].sort(),
    specsWithSpecMd: [...specsWithSpecMd].sort(),
    design,
    tasks,
    resume,
  };
}

// ── Fake-fs builder — the injected seam every recomputation below uses ──────
// Built EXCLUSIVELY from a key's recorded `facts` (design §2.2's core pin) —
// never a live fs call.

function fakeFsFromFacts(name, facts) {
  const dir = `${CHANGES_ROOT}/${name}`;
  const nestedSpecRe = new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/specs/([^/]+)/spec\\.md$`);
  const exists = (p) => {
    if (p === `${dir}/proposal.md`) return facts.proposal;
    if (p === `${dir}/spec.md`) return facts.specFlat;
    if (p === `${dir}/design.md`) return facts.design;
    if (p === `${dir}/tasks.md`) return facts.tasks;
    if (p === `${dir}/resume.md`) return facts.resume;
    if (p === `${dir}/specs`) return facts.specsDirExists;
    const m = p.match(nestedSpecRe);
    if (m) return facts.specsWithSpecMd.includes(m[1]);
    return false;
  };
  const listDir = (p) => {
    if (p === `${dir}/specs`) return facts.specsEntries;
    throw new Error(`fakeFsFromFacts: not a dir: ${p}`);
  };
  return { exists, listDir };
}

// ── check-refs verdict — OLD (2-of-4, no grandfather awareness) vs NEW
// (missingRequiredArtifacts, 4-of-4, grandfather-short-circuited) ───────────

/** Mirrors check-refs.mjs's CURRENT (pre-B1) S-1 loop: ['proposal.md','tasks.md'], no grandfather check. */
function oldCheckRefsMissing(facts) {
  const missing = [];
  if (!facts.proposal) missing.push('proposal.md');
  if (!facts.tasks) missing.push('tasks.md');
  return missing;
}

/** The site's NEW (B1-wired) verdict, recomputed from the frozen facts. */
function newCheckRefsMissing(name, facts) {
  return missingRequiredArtifacts(name, { artefacts: GOLDEN_ARTEFACTS, ...fakeFsFromFacts(name, facts) });
}

// ── phase-order-check verdict — a synthetic single-dir-touched scenario ────
// (this dir alone changed, plus one impl file, checkedTasks=1 to keep Rule C
// silent) so Rule A/the exempt-list swap is exercised deterministically. This
// SAME function is used at capture time (pre-wiring, current
// BASELINE_EXEMPT_DIRS default) and at test time (post-wiring,
// LEGACY_GRANDFATHERED default) — only the imported default changes between
// runs, not this code (design §2.1/§3 proof made mechanical).

function computePhaseOrderVerdict(name, facts) {
  const hasSpec = facts.specFlat || facts.specsWithSpecMd.length > 0;
  const dirEntry = {
    name,
    hasProposal: facts.proposal,
    hasSpec,
    hasDesign: facts.design,
    hasTasks: facts.tasks,
    checkedTasks: 1,
    statusBefore: undefined,
    statusAfter: undefined,
  };
  const changedFiles = [`${CHANGES_ROOT}/${name}/tasks.md`, 'brain/scripts/_synthetic-impl.mjs'];
  const evaluation = evaluatePhaseOrder({ changedFiles, changeDirs: [dirEntry] });
  return applyBaselineExemption(evaluation);
}

// ── session-start verdict — deriveChangeFromBranch fed the frozen key set ──

function fakeReaddirOverFrozenKeys(names) {
  return () => names.map((name) => ({ name, isDirectory: () => true }));
}

// ── Capture (pre-wiring, run once via CLI entry) ────────────────────────────

function captureFrozenCorpus() {
  const names = readdirSync(join(REPO_ROOT, CHANGES_ROOT), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'archive' && e.name !== SELF_CHANGE_ID)
    .map((e) => e.name)
    .sort();

  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

  const changes = {};
  for (const name of names) {
    const facts = readRealFacts(name);
    changes[name] = {
      facts,
      checkRefs: { missing: oldCheckRefsMissing(facts) },
      phaseOrder: computePhaseOrderVerdict(name, facts),
      featureResolution: { hasResume: facts.resume },
    };
  }

  const tokens = [...new Set(
    names
      .map((name) => name.match(/^issue-(\d+)(?:-|$)/))
      .filter(Boolean)
      .map((m) => `issue-${m[1]}`),
  )].sort();

  const sessionStart = {};
  for (const token of tokens) {
    sessionStart[token] = {
      token,
      matches: deriveChangeFromBranch(token, CHANGES_ROOT, { _readdir: fakeReaddirOverFrozenKeys(names) }).matches,
    };
  }

  return {
    _header: `point-in-time migration proof over the frozen ${names.length}; new dirs out of scope by design`,
    _capturedAtBase: headSha,
    _frozenCount: names.length,
    changes,
    sessionStart,
  };
}

// ── CLI entry — regenerate the fixture (pre-wiring use only, explicit opt-in
// ONLY) ──────────────────────────────────────────────────────────────────────
//
// Guarded by BOTH the direct-invocation check AND an explicit env var. The
// argv[1] check alone is NOT sufficient here: `node --test <this file>` runs
// each matched test file in its own child process where argv[1] equals the
// test file's own path (Node's default per-file process isolation) — without
// the env-var gate, EVERY `npm test` run would silently re-capture from the
// LIVE tree and overwrite the committed frozen fixture, exactly the
// self-referential re-derivation REQ-B1-2's third scenario forbids ("never
// regenerated from the post-wiring code"). Regeneration requires a human to
// deliberately run:
//   SDD_LAYOUT_GOLDEN_CAPTURE=1 node brain/scripts/lib/sdd-layout-golden.test.mjs

if (process.argv[1] === fileURLToPath(import.meta.url) && process.env.SDD_LAYOUT_GOLDEN_CAPTURE === '1') {
  const fixture = captureFrozenCorpus();
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`captured ${fixture._frozenCount} frozen keys -> ${FIXTURE_PATH}`);
}

// ── The regression test — reads the COMMITTED fixture, never regenerates it ─

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

test('F1 golden: fixture header states the point-in-time-over-the-frozen-N substance (REQ-B1-2)', () => {
  assert.match(fixture._header, /point-in-time migration proof over the frozen \d+/);
  assert.match(fixture._header, /new dirs out of scope by design/);
  assert.equal(fixture._frozenCount, Object.keys(fixture.changes).length);
});

test('F1 golden: adding issue-253-b1 to the live corpus does not enter the frozen fixture (REQ-B1-2 scenario)', () => {
  assert.ok(
    !(SELF_CHANGE_ID in fixture.changes),
    'issue-253-b1 did not exist at capture time and must stay out of the frozen set by design',
  );
});

for (const name of Object.keys(fixture.changes).sort()) {
  const entry = fixture.changes[name];

  test(`F1 golden [${name}]: check-refs verdict is deepEqual pre/post-wiring (missingRequiredArtifacts)`, () => {
    assert.deepEqual(newCheckRefsMissing(name, entry.facts), entry.checkRefs.missing);
  });

  test(`F1 golden [${name}]: phase-order-check verdict is deepEqual pre/post-wiring (evaluatePhaseOrder + applyBaselineExemption)`, () => {
    assert.deepEqual(computePhaseOrderVerdict(name, entry.facts), entry.phaseOrder);
  });

  test(`F1 golden [${name}]: feature-resolution hasResume signal is deepEqual pre/post-wiring (changeDir + OPERATIONAL_ARTIFACTS[0])`, () => {
    const fs = fakeFsFromFacts(name, entry.facts);
    const hasResume = fs.exists(`${changeDir(name)}/${OPERATIONAL_ARTIFACTS[0]}`);
    assert.deepEqual(hasResume, entry.featureResolution.hasResume);
  });
}

for (const token of Object.keys(fixture.sessionStart).sort()) {
  test(`F1 golden [sessionStart ${token}]: deriveChangeFromBranch matches are deepEqual pre/post-wiring`, () => {
    const names = Object.keys(fixture.changes);
    const result = deriveChangeFromBranch(token, CHANGES_ROOT, { _readdir: fakeReaddirOverFrozenKeys(names) });
    assert.deepEqual(result.matches, fixture.sessionStart[token].matches);
  });
}
