// new-change.test.mjs — SDD scaffold must produce all four required artifacts (issue #249).
//
// new-change.mjs derives repoRoot from its own script location
// (dirname(__dirname)/../..), so we copy the script into an isolated tmp dir that
// mirrors the real brain/scripts/ layout before spawning it. This keeps writes
// confined to the tmp dir and never touches the real openspec/changes/.
//
// harness-contract.md and docs/workflow-guide.md both list proposal.md, spec.md,
// design.md, tasks.md as the four required SDD artifacts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, existsSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { artifactPaths } from './lib/sdd-layout.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_SRC = join(__dirname, 'new-change.mjs');
const LIB_SRC = join(__dirname, 'lib', 'sdd-layout.mjs');

function makeIsolatedScript() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'brain-new-change-'));
  const scriptsDir = join(tmpRoot, 'brain', 'scripts');
  const libDir = join(scriptsDir, 'lib');
  mkdirSync(libDir, { recursive: true });
  const scriptDest = join(scriptsDir, 'new-change.mjs');
  cpSync(SCRIPT_SRC, scriptDest);
  cpSync(LIB_SRC, join(libDir, 'sdd-layout.mjs'));
  return { tmpRoot, scriptDest };
}

test('new-change: scaffolds all four SDD artifacts (proposal, spec, design, tasks)', () => {
  const { tmpRoot, scriptDest } = makeIsolatedScript();
  try {
    const result = spawnSync(
      'node',
      [scriptDest, '--issue', '999999', '--title', 'scaffold check'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);

    const changeDir = join(tmpRoot, 'openspec', 'changes', 'issue-999999-scaffold-check');
    const files = readdirSync(changeDir).sort();
    assert.deepEqual(
      files,
      ['design.md', 'proposal.md', 'spec.md', 'tasks.md'],
      'scaffold must write exactly the four required SDD artifacts',
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── REQ-B1-1 (task 2.4): the four write targets equal
// join(repoRoot, artifactPaths(id).*) exactly — the accessor, not a
// re-derived literal, owns the scaffold paths. ──────────────────────────────

test('new-change: the four write targets are exactly join(repoRoot, artifactPaths(changeId).*)', () => {
  const { tmpRoot, scriptDest } = makeIsolatedScript();
  try {
    const result = spawnSync(
      'node',
      [scriptDest, '--issue', '888888', '--title', 'path wiring check'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);

    const changeId = 'issue-888888-path-wiring-check';
    const paths = artifactPaths(changeId);
    for (const key of ['proposal', 'spec', 'design', 'tasks']) {
      const abs = join(tmpRoot, paths[key]);
      assert.ok(existsSync(abs), `expected ${paths[key]} to exist at ${abs}`);
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── REQ-B1-5 (task 5.2/5.3): slug mandate — ERROR when absent, never a
// derived placeholder (#595 pin 2). ──────────────────────────────────────────

test('new-change: rejects (no dir created) when --title/slug is omitted', () => {
  const { tmpRoot, scriptDest } = makeIsolatedScript();
  try {
    const result = spawnSync('node', [scriptDest, '--issue', '777777'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, 'expected a non-zero exit when --title is omitted');
    assert.ok(
      !existsSync(join(tmpRoot, 'openspec', 'changes', 'issue-777777')),
      'must NOT create a bare issue-<N> placeholder dir',
    );
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('new-change: with --title produces issue-<N>-<slug> exactly as before (unchanged path)', () => {
  const { tmpRoot, scriptDest } = makeIsolatedScript();
  try {
    const result = spawnSync(
      'node',
      [scriptDest, '--issue', '666666', '--title', 'unchanged path'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
    assert.ok(existsSync(join(tmpRoot, 'openspec', 'changes', 'issue-666666-unchanged-path')));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── #810 (#456 slice B): the scaffold produces the DECLARED set ─────────────

test('#810: a declared custom stage is scaffolded from its resolved artefact file', () => {
  const { tmpRoot, scriptDest } = makeIsolatedScript();
  try {
    writeFileSync(join(tmpRoot, 'brain.config.json'), JSON.stringify({
      sdd: { stages: { proposal: {}, research: { artefact: 'research.md' }, spec: {}, design: {}, tasks: {} } },
    }));
    const result = spawnSync('node', [scriptDest, '--issue', '999998', '--title', 'custom stage check'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const dir = join(tmpRoot, 'openspec', 'changes', 'issue-999998-custom-stage-check');
    assert.deepEqual(readdirSync(dir).sort(), ['design.md', 'proposal.md', 'research.md', 'spec.md', 'tasks.md'],
      'the scaffold writes the FULL declared set — never tier-scoped (REQ-L4-2 prime)');
    const stub = readFileSync(join(dir, 'research.md'), 'utf8');
    assert.match(stub, /stage: research/, 'the stub names its stage in front matter');
    assert.match(result.stdout, /research\.md/, 'the summary reports the custom artefact');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('#810: a malformed declaration refuses with the resolver\'s own message and writes NOTHING', () => {
  const { tmpRoot, scriptDest } = makeIsolatedScript();
  try {
    writeFileSync(join(tmpRoot, 'brain.config.json'), JSON.stringify({
      sdd: { stages: { spec: {}, design: {}, tasks: {} } },
    }));
    const result = spawnSync('node', [scriptDest, '--issue', '999997', '--title', 'refused check'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /omits lifecycle stage/, 'resolveStageSet\'s refusal reaches the operator verbatim');
    assert.ok(!existsSync(join(tmpRoot, 'openspec', 'changes', 'issue-999997-refused-check')), 'nothing was written');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('#810: an unreadable config degrades to zero-config — the four, exactly', () => {
  const { tmpRoot, scriptDest } = makeIsolatedScript();
  try {
    writeFileSync(join(tmpRoot, 'brain.config.json'), '{not json');
    const result = spawnSync('node', [scriptDest, '--issue', '999996', '--title', 'degrade check'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const dir = join(tmpRoot, 'openspec', 'changes', 'issue-999996-degrade-check');
    assert.deepEqual(readdirSync(dir).sort(), ['design.md', 'proposal.md', 'spec.md', 'tasks.md']);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('#810 r7: a traversal artefact never reaches the filesystem — refused before any write', () => {
  const { tmpRoot, scriptDest } = makeIsolatedScript();
  try {
    writeFileSync(join(tmpRoot, 'brain.config.json'), JSON.stringify({
      sdd: { stages: { proposal: {}, spec: {}, design: {}, tasks: {}, evil: { artefact: '../../../escaped-810.md' } } },
    }));
    const result = spawnSync('node', [scriptDest, '--issue', '999995', '--title', 'traversal check'], { encoding: 'utf8' });
    assert.equal(result.status, 1, 'the scaffold refuses');
    assert.ok(!existsSync(join(tmpRoot, 'escaped-810.md')), 'NOTHING lands outside the change dir');
    assert.ok(!existsSync(join(tmpRoot, 'openspec', 'changes', 'issue-999995-traversal-check')), 'nothing lands inside either');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
