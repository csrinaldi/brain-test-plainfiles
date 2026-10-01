// phase-order-check.test.mjs — Unit tests for evaluatePhaseOrder (REQ-L4-1..4, design §2)
// and the PR4b git I/O wrapper + CLI (REQ-L4-1, REQ-L4-5, REQ-NEUTRALITY-1/2).
// Run with: npm test  (node --test, no dependencies)
//
// Wrapper tests use plain-data fakes injected via `deps` — no test spawns a real
// git process or touches the real cwd (CI-fragility discipline, same as
// run-check.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evaluatePhaseOrder, runPhaseOrderCheck, resolveWalkSet, gatherPhaseOrderInputs, main } from './phase-order-check.mjs';
import { LEGACY_GRANDFATHERED } from '../lib/sdd-layout.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Builds a changeDirs entry with sane "everything complete, nothing changed" defaults. */
function makeDir(overrides = {}) {
  return {
    name: 'issue-999-foo',
    hasProposal: true,
    hasSpec: true,
    hasDesign: true,
    hasTasks: true,
    checkedTasks: 1,
    statusBefore: 'tasked',
    statusAfter: 'tasked',
    ...overrides,
  };
}

// ── Rule C — code-without-completed-phases (the enforcing core) ───────────────

test('Rule C: impl non-empty and exactly one touched dir with checkedTasks === 0 → fail', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ checkedTasks: 0 })],
  });
  assert.equal(result.level, 'fail');
  const ruleCFinding = result.findings.find(f => f.rule === 'C');
  assert.ok(ruleCFinding, 'expected a Rule C finding');
  assert.equal(ruleCFinding.level, 'fail');
  assert.match(ruleCFinding.message, /tasks\.md has no checked item/);
});

test('Rule C: impl non-empty but no touched dir (unattributable) → warn, never fail', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs'],
    changeDirs: [],
  });
  assert.equal(result.level, 'warn');
  assert.equal(result.findings.some(f => f.level === 'fail'), false);
  const ruleCFinding = result.findings.find(f => f.rule === 'C');
  assert.ok(ruleCFinding, 'expected a Rule C finding');
  assert.equal(ruleCFinding.level, 'warn');
});

test('Rule C: impl non-empty and touched dir has >= 1 checked task → no violation', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ checkedTasks: 3 })],
  });
  assert.equal(result.level, 'pass');
  assert.deepEqual(result.findings, []);
});

test('Rule C: multi-dir — impl + two touched dirs, one checkedTasks===0 and one checkedTasks>=1 → fail attributed to the 0-checked dir', () => {
  // Regression: a bystander second change-dir edit (e.g. an unrelated checkbox
  // bump or shared doc touch in a second openspec/changes/** dir) must NOT
  // disable the enforcing core for the dir with the real violation.
  const result = evaluatePhaseOrder({
    changedFiles: [
      'brain/scripts/vcs/foo.mjs',
      'openspec/changes/issue-999-foo/tasks.md',
      'openspec/changes/issue-888-bar/tasks.md',
    ],
    changeDirs: [
      makeDir({ name: 'issue-999-foo', checkedTasks: 0 }),
      makeDir({ name: 'issue-888-bar', checkedTasks: 5 }),
    ],
  });
  assert.equal(result.level, 'fail');
  const ruleCFindings = result.findings.filter(f => f.rule === 'C');
  assert.equal(ruleCFindings.length, 1);
  assert.equal(ruleCFindings[0].change, 'issue-999-foo');
  assert.match(ruleCFindings[0].message, /tasks\.md has no checked item/);
});

test('Rule C: multi-dir — impl + two touched dirs, BOTH checkedTasks===0 → fail with one finding per dir', () => {
  const result = evaluatePhaseOrder({
    changedFiles: [
      'brain/scripts/vcs/foo.mjs',
      'openspec/changes/issue-999-foo/tasks.md',
      'openspec/changes/issue-888-bar/tasks.md',
    ],
    changeDirs: [
      makeDir({ name: 'issue-999-foo', checkedTasks: 0 }),
      makeDir({ name: 'issue-888-bar', checkedTasks: 0 }),
    ],
  });
  assert.equal(result.level, 'fail');
  const ruleCFindings = result.findings.filter(f => f.rule === 'C');
  assert.equal(ruleCFindings.length, 2);
  assert.ok(ruleCFindings.some(f => f.change === 'issue-999-foo'));
  assert.ok(ruleCFindings.some(f => f.change === 'issue-888-bar'));
});

test('Rule C: multi-dir — impl + two touched dirs, both checkedTasks>=1 → no Rule C violation', () => {
  const result = evaluatePhaseOrder({
    changedFiles: [
      'brain/scripts/vcs/foo.mjs',
      'openspec/changes/issue-999-foo/tasks.md',
      'openspec/changes/issue-888-bar/tasks.md',
    ],
    changeDirs: [
      makeDir({ name: 'issue-999-foo', checkedTasks: 1 }),
      makeDir({ name: 'issue-888-bar', checkedTasks: 5 }),
    ],
  });
  assert.equal(result.findings.filter(f => f.rule === 'C').length, 0);
});

// ── Rule A — artifact completeness, gated on Rule C seeing impl ────────────────

test('Rule A: touched change missing hasDesign → fail "implementation without spec.md/design.md"', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ checkedTasks: 1, hasDesign: false })],
  });
  assert.equal(result.level, 'fail');
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.ok(ruleAFinding, 'expected a Rule A finding');
  assert.equal(ruleAFinding.level, 'fail');
  assert.match(ruleAFinding.message, /implementation without spec\.md\/design\.md/);
});

test('Rule A: touched change lacking a spec artifact (either convention, via hasSpec) → fail', () => {
  // hasSpec is expected to already fold in BOTH spec.md and specs/*/spec.md
  // detection (Gap G1) — this pure function only consumes the resulting boolean.
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ checkedTasks: 1, hasSpec: false })],
  });
  assert.equal(result.level, 'fail');
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.ok(ruleAFinding, 'expected a Rule A finding');
  assert.equal(ruleAFinding.level, 'fail');
  assert.match(ruleAFinding.message, /implementation without spec\.md\/design\.md/);
});

// ── Rule A — tier-scoped artefact set (issue #358 Q5, REQ-L4-2′) ──────────────

test('Rule A (REQ-L4-2′): lite tier lands implementation with spec.md only — proposal/design/tasks missing still passes', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ checkedTasks: 1, hasProposal: false, hasDesign: false, hasTasks: false })],
    artefacts: ['spec'],
  });
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.equal(ruleAFinding, undefined, 'lite tier must not fail Rule A when only spec.md is required');
});

test('Rule A (REQ-L4-2′): lite tier still fails when spec.md itself is missing', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ checkedTasks: 1, hasSpec: false })],
    artefacts: ['spec'],
  });
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.ok(ruleAFinding, 'lite tier must still fail Rule A when spec.md is missing');
  assert.match(ruleAFinding.message, /spec\.md/);
});

test('Rule A (REQ-L4-2′): standard tier (default artefacts) still demands design.md — same PR without design.md fails, naming it', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ checkedTasks: 1, hasDesign: false })],
    // artefacts omitted — defaults to the standard-tier four, exactly as
    // every pre-tiering call site already exercises.
  });
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.ok(ruleAFinding, 'standard tier must fail Rule A when design.md is missing');
  assert.match(ruleAFinding.message, /design\.md/);
});

test('Rule A (REQ-L4-2′): regulated artefact set additionally requires a recorded verification artefact', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ checkedTasks: 1, hasVerification: false })],
    artefacts: ['proposal', 'spec', 'design', 'tasks', 'verification'],
  });
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.ok(ruleAFinding, 'regulated tier must fail Rule A when the verification artefact is missing');
  // #555: `verify-report.md`, not `verification.md`. This assertion pinned the
  // message's INVENTED name — the gate has always probed `verify-report.md`
  // (`buildChangeDir`), so the finding named a file the operator could create and
  // still fail. The message now reads from the one name→file map.
  assert.match(ruleAFinding.message, /verify-report\.md/);
});

test('Rule A (REQ-L4-2′): regulated artefact set passes when all five artefacts (incl. verification) are present', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ checkedTasks: 1, hasVerification: true })],
    artefacts: ['proposal', 'spec', 'design', 'tasks', 'verification'],
  });
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.equal(ruleAFinding, undefined);
});

test('Rule A: planning-only PR (impl empty) is never subjected to Rule A, even with incomplete artifacts', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [
      makeDir({
        checkedTasks: 0,
        hasSpec: false,
        hasDesign: false,
        statusBefore: 'draft',
        statusAfter: 'draft',
      }),
    ],
  });
  assert.equal(result.level, 'pass');
  assert.equal(result.findings.filter(f => f.rule === 'A').length, 0);
});

// ── Rule B — monotonic status ───────────────────────────────────────────────

test('Rule B: statusAfter earlier than statusBefore on the ladder → fail (backward phase jump)', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['openspec/changes/issue-999-foo/design.md'],
    changeDirs: [makeDir({ statusBefore: 'designed', statusAfter: 'proposed' })],
  });
  assert.equal(result.level, 'fail');
  const ruleBFinding = result.findings.find(f => f.rule === 'B');
  assert.ok(ruleBFinding, 'expected a Rule B finding');
  assert.equal(ruleBFinding.level, 'fail');
  assert.match(ruleBFinding.message, /designed.*proposed/s);
});

test('Rule B: unknown/custom status, unchanged status, absent frontmatter, forward-only → pass (no-op)', () => {
  const unchanged = evaluatePhaseOrder({
    changedFiles: ['openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ statusBefore: 'tasked', statusAfter: 'tasked' })],
  });
  assert.equal(unchanged.level, 'pass');
  assert.equal(unchanged.findings.filter(f => f.rule === 'B').length, 0);

  const forwardOnly = evaluatePhaseOrder({
    changedFiles: ['openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ statusBefore: 'spec', statusAfter: 'designed' })],
  });
  assert.equal(forwardOnly.level, 'pass');
  assert.equal(forwardOnly.findings.filter(f => f.rule === 'B').length, 0);

  const unknownStatus = evaluatePhaseOrder({
    changedFiles: ['openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ statusBefore: 'custom-legacy', statusAfter: 'draft' })],
  });
  assert.equal(unknownStatus.level, 'pass');
  assert.equal(unknownStatus.findings.filter(f => f.rule === 'B').length, 0);

  const absentFrontmatter = evaluatePhaseOrder({
    changedFiles: ['openspec/changes/issue-999-foo/tasks.md'],
    changeDirs: [makeDir({ statusBefore: undefined, statusAfter: undefined })],
  });
  assert.equal(absentFrontmatter.level, 'pass');
  assert.equal(absentFrontmatter.findings.filter(f => f.rule === 'B').length, 0);
});

// ── Archive-location exclusion (#264) ───────────────────────────────────────
//
// E1 introduced the accessor-owned archive container `openspec/changes/archive/<iid>/`
// (sdd-layout.mjs archivePath()). A PR that touches it must NOT be evaluated as if
// `archive` were itself an in-flight change dir — it is a container, not a change.

test('#264: a PR touching the archive container plus its own complete change dir produces zero Rule A/C findings for the archive entry', () => {
  // Mirrors PR #261's real shape: impl code + the archiving change's own
  // (complete) change dir + the actual archived-into-container files. Before
  // the fix, `archive` was itself evaluated as a touched change dir and (being
  // incomplete/unattributed) failed Rule A and Rule C.
  const result = evaluatePhaseOrder({
    changedFiles: [
      'brain/scripts/lib/sdd-layout.mjs',
      'openspec/changes/issue-999-foo/tasks.md',
      'openspec/changes/archive/999/proposal.md',
      'openspec/changes/archive/999/tasks.md',
    ],
    changeDirs: [
      makeDir({ name: 'issue-999-foo' }), // complete, checkedTasks: 1 — the real change
      // Mirrors what the git-I/O wrapper's buildChangeDir('archive', ...) would
      // produce today: the archive/ container root carries none of the four
      // artifacts and no checked tasks — it is not a change dir at all.
      {
        name: 'archive',
        hasProposal: false,
        hasSpec: false,
        hasDesign: false,
        hasTasks: false,
        checkedTasks: 0,
        statusBefore: undefined,
        statusAfter: undefined,
      },
    ],
  });
  assert.equal(result.findings.filter(f => f.change === 'archive').length, 0, 'expected no finding attributed to the archive container');
  assert.equal(result.findings.filter(f => f.rule === 'A').length, 0, 'expected no Rule A finding');
  assert.equal(result.findings.filter(f => f.rule === 'C').length, 0, 'expected no Rule C finding');
  assert.equal(result.level, 'pass');
});

test('#264 regression: a real in-flight change with impl code but no spec.md/design.md still triggers Rule A/C', () => {
  const result = evaluatePhaseOrder({
    changedFiles: [
      'brain/scripts/lib/sdd-layout.mjs',
      'openspec/changes/issue-999-x/tasks.md',
    ],
    changeDirs: [
      makeDir({
        name: 'issue-999-x',
        hasSpec: false,
        hasDesign: false,
        checkedTasks: 0,
      }),
    ],
  });
  assert.equal(result.level, 'fail');
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.ok(ruleAFinding, 'expected a Rule A finding for the real in-flight change');
  assert.equal(ruleAFinding.change, 'issue-999-x');
  const ruleCFinding = result.findings.find(f => f.rule === 'C');
  assert.ok(ruleCFinding, 'expected a Rule C finding for the real in-flight change');
  assert.equal(ruleCFinding.change, 'issue-999-x');
});

test('#264: ARCHIVE_DIR_NAME is derived from sdd-layout.archivePath(), no hardcoded literal string', () => {
  const srcPath = fileURLToPath(new URL('./phase-order-check.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.match(src, /archivePath\(/, 'expected ARCHIVE_DIR_NAME to be derived via the archivePath() accessor');
  const derivationLine = src.split('\n').find(l => l.includes('ARCHIVE_DIR_NAME ='));
  assert.ok(derivationLine, 'expected an ARCHIVE_DIR_NAME assignment line');
  assert.doesNotMatch(
    derivationLine,
    /['"]archive['"]/,
    "ARCHIVE_DIR_NAME's own assignment line must not hardcode the literal string 'archive'"
  );
});

// ── issue #557 D7-a: openspec/specs/** is allowlisted, not implementation ──

test('#557 D7-a: an archive-PR diff shape (deleted changes/<name>/*, added changes/archive/<iid>/*, modified openspec/specs/<cap>/spec.md) evaluates pass', () => {
  const result = evaluatePhaseOrder({
    changedFiles: [
      // Deleted from the swept folder.
      'openspec/changes/issue-999-foo/proposal.md',
      'openspec/changes/issue-999-foo/design.md',
      'openspec/changes/issue-999-foo/tasks.md',
      'openspec/changes/issue-999-foo/spec.md',
      // Added under the archive container.
      'openspec/changes/archive/999/proposal.md',
      'openspec/changes/archive/999/design.md',
      'openspec/changes/archive/999/tasks.md',
      'openspec/changes/archive/999/spec.md',
      // The consolidated durable spec — the file this fix allowlists.
      'openspec/specs/some-capability/spec.md',
    ],
    changeDirs: [
      // What the git-I/O wrapper's buildChangeDir would produce for the swept
      // folder at HEAD: every artifact gone, zero checked tasks — because the
      // folder no longer exists post-move, not because phases were skipped.
      {
        name: 'issue-999-foo',
        hasProposal: false,
        hasSpec: false,
        hasDesign: false,
        hasTasks: false,
        checkedTasks: 0,
        statusBefore: 'tasked',
        statusAfter: undefined,
      },
      // The archive container itself — already excluded from touchedDirs by
      // ARCHIVE_DIR_NAME (issue #264), asserted here as a belt-and-braces
      // sanity check that this fix does not depend on that exclusion.
      {
        name: 'archive',
        hasProposal: false,
        hasSpec: false,
        hasDesign: false,
        hasTasks: false,
        checkedTasks: 0,
        statusBefore: undefined,
        statusAfter: undefined,
      },
    ],
  });

  assert.equal(result.level, 'pass', `expected pass, got ${result.level}: ${JSON.stringify(result.findings)}`);
  assert.equal(result.findings.length, 0, 'openspec/specs/** must not be counted as implementation code — Rule A/C must not fire');
});

test('#557 D7-a teeth: the SAME diff shape with the consolidated spec under a path NOT covered by the openspec/specs/ allowlist restores Rule A/C failures', () => {
  // Identical shape to the passing test above, except the durable-spec file
  // lives one path segment off (openspec/other-specs/... instead of
  // openspec/specs/...) — proving the passing test's result is attributable
  // to the openspec/specs/ prefix rule specifically, not to some unrelated
  // reason the diff might otherwise pass (e.g. an empty impl set by
  // accident). If the openspec/specs/ allowlist entry ever regresses (typo,
  // narrowed prefix, deleted rule), THIS shape is what the real diff would
  // degrade to, and it must fail.
  const result = evaluatePhaseOrder({
    changedFiles: [
      'openspec/changes/issue-999-foo/proposal.md',
      'openspec/changes/issue-999-foo/design.md',
      'openspec/changes/issue-999-foo/tasks.md',
      'openspec/changes/issue-999-foo/spec.md',
      'openspec/changes/archive/999/proposal.md',
      'openspec/changes/archive/999/design.md',
      'openspec/changes/archive/999/tasks.md',
      'openspec/changes/archive/999/spec.md',
      'openspec/other-specs/some-capability/spec.md', // NOT under openspec/specs/
    ],
    changeDirs: [
      {
        name: 'issue-999-foo',
        hasProposal: false,
        hasSpec: false,
        hasDesign: false,
        hasTasks: false,
        checkedTasks: 0,
        statusBefore: 'tasked',
        statusAfter: undefined,
      },
    ],
  });

  assert.equal(result.level, 'fail');
  assert.ok(result.findings.some(f => f.rule === 'C' && f.change === 'issue-999-foo'), 'expected Rule C to fire once the durable-spec path escapes the allowlist');
  assert.ok(result.findings.some(f => f.rule === 'A' && f.change === 'issue-999-foo'), 'expected Rule A to fire once the durable-spec path escapes the allowlist');
});

// ── Aggregation — level + findings across rules (REQ-L4-1) ────────────────────

test('aggregation: level is pass and findings is empty when no rule reports a violation', () => {
  const result = evaluatePhaseOrder({ changedFiles: [], changeDirs: [] });
  assert.equal(result.level, 'pass');
  assert.deepEqual(result.findings, []);
});

test('aggregation: level is fail when multiple rules report violations across different dirs; findings collects all of them', () => {
  const result = evaluatePhaseOrder({
    changedFiles: [
      'brain/scripts/vcs/foo.mjs',
      'openspec/changes/issue-999-foo/tasks.md',
      'openspec/changes/issue-888-bar/design.md',
    ],
    changeDirs: [
      // Rule A fail: touched, impl present, missing design.
      makeDir({ name: 'issue-999-foo', checkedTasks: 1, hasDesign: false }),
      // Rule B fail: touched (via design.md), status regressed.
      makeDir({
        name: 'issue-888-bar',
        checkedTasks: 1,
        statusBefore: 'designed',
        statusAfter: 'proposed',
      }),
    ],
  });
  assert.equal(result.level, 'fail');
  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.some(f => f.rule === 'A' && f.change === 'issue-999-foo'));
  assert.ok(result.findings.some(f => f.rule === 'B' && f.change === 'issue-888-bar'));
});

test('aggregation: level is warn (not fail) when only warn-level findings are present', () => {
  const result = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/vcs/foo.mjs'],
    changeDirs: [],
  });
  assert.equal(result.level, 'warn');
  assert.equal(result.findings.every(f => f.level !== 'fail'), true);
});

// ── PR4b — git I/O wrapper + CLI (REQ-L4-1) ─────────────────────────────────────

/**
 * Builds injectable `deps` for gatherPhaseOrderInputs/runPhaseOrderCheck/main
 * from plain in-memory maps — no real git process, no real filesystem.
 *
 * `filesAfter`/`filesBefore` are flat maps of relative-path → file content
 * (working tree / BASE ref, respectively). A "directory" is any prefix shared
 * by at least one key, so `exists()`/`listDir()` behave like a real fs without
 * needing explicit directory entries.
 */
function makeFakeDeps({ baseSha = 'BASE', headSha = 'HEAD', changedFiles = [], filesAfter = {}, filesBefore = {} }) {
  const exists = relPath => {
    if (Object.prototype.hasOwnProperty.call(filesAfter, relPath)) return true;
    const prefix = `${relPath}/`;
    return Object.keys(filesAfter).some(k => k.startsWith(prefix));
  };
  const listDir = relPath => {
    const prefix = `${relPath}/`;
    const names = new Set();
    for (const key of Object.keys(filesAfter)) {
      if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
    }
    return [...names];
  };
  return {
    baseSha,
    headSha,
    diffNameOnly: () => changedFiles,
    exists,
    listDir,
    readFile: relPath => filesAfter[relPath] ?? null,
    showAtRef: (_ref, relPath) => filesBefore[relPath] ?? null,
  };
}

/** Runs `fn` with console.log captured; returns the logged lines. */
function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = msg => lines.push(msg);
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

const COMPLETE_DIR_FILES = {
  'openspec/changes/issue-999-foo/proposal.md': '',
  'openspec/changes/issue-999-foo/design.md': '',
  'openspec/changes/issue-999-foo/spec.md': '',
  'openspec/changes/issue-999-foo/tasks.md': '---\nstatus: tasked\n---\n- [x] done\n',
};

test('wrapper: happy path — complete artifacts + a checked task → main exits 0, pass verdict', () => {
  const deps = makeFakeDeps({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    filesAfter: COMPLETE_DIR_FILES,
    filesBefore: { 'openspec/changes/issue-999-foo/tasks.md': '---\nstatus: tasked\n---\n- [ ] pending\n' },
  });

  let exitCode;
  const lines = captureLogs(() => {
    exitCode = main(deps);
  });

  assert.equal(exitCode, 0);
  assert.equal(lines[0], 'phase-order-check: pass');
});

test('wrapper: fail path — impl change + zero checked tasks → main exits 1, expected verdict format', () => {
  const deps = makeFakeDeps({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    filesAfter: {
      ...COMPLETE_DIR_FILES,
      'openspec/changes/issue-999-foo/tasks.md': '---\nstatus: tasked\n---\n- [ ] not done\n',
    },
  });

  let exitCode;
  const lines = captureLogs(() => {
    exitCode = main(deps);
  });

  assert.equal(exitCode, 1);
  assert.equal(lines[0], 'phase-order-check: fail');
  assert.ok(
    lines.some(l => l.includes('Rule C') && l.includes('tasks.md has no checked item')),
    `expected a Rule C line, got: ${JSON.stringify(lines)}`
  );
});

// ── wrapper — uncomputable diff is tier-scoped (issue #358 Q5 finding A, REQ-TIER-3) ──
//
// `phase-order`'s policy is `required` at standard/regulated and `detection`
// at `lite` (governance-tiers.mjs GATE_MATRIX). REQ-TIER-3 requires every
// `detection`-policy job to still run and still exit 0 with a `::warning::`
// naming the tier — never a hard block at a tier this gate does not block at.

test('wrapper: standard tier — missing BASE_SHA/HEAD_SHA fails closed (issue #358 Q5 Phase 5, ADR-0015 precondition), never throws', () => {
  const deps = makeFakeDeps({ changedFiles: [] });
  const result = runPhaseOrderCheck({ ...deps, tier: 'standard', baseSha: undefined, headSha: undefined });
  assert.equal(result.level, 'fail');
  assert.match(result.findings[0].message, /diff uncomputable \(cannot verify artefact presence\)/);
});

test('wrapper: regulated tier — missing BASE_SHA/HEAD_SHA fails closed', () => {
  const deps = makeFakeDeps({ changedFiles: [] });
  const result = runPhaseOrderCheck({ ...deps, tier: 'regulated', baseSha: undefined, headSha: undefined });
  assert.equal(result.level, 'fail');
  assert.match(result.findings[0].message, /diff uncomputable \(cannot verify artefact presence\)/);
});

test('wrapper: lite tier — missing BASE_SHA/HEAD_SHA degrades to a tier-named warning, exit 0 (REQ-TIER-3, issue #358 Q5 finding A)', () => {
  const deps = makeFakeDeps({ changedFiles: [] });
  const result = runPhaseOrderCheck({ ...deps, tier: 'lite', baseSha: undefined, headSha: undefined });
  assert.equal(result.level, 'warn');
  assert.match(result.findings[0].message, /^::warning::phase-order:/);
  assert.match(result.findings[0].message, /\(tier: lite\)/);
  assert.match(result.findings[0].message, /diff uncomputable \(cannot verify artefact presence\)/);

  const lines = [];
  const orig = console.log;
  console.log = msg => lines.push(msg);
  let exitCode;
  try {
    exitCode = main({ ...deps, tier: 'lite', baseSha: undefined, headSha: undefined });
  } finally {
    console.log = orig;
  }
  assert.equal(exitCode, 0, 'a detection-policy gate must exit 0, never block');
});

test('wrapper: standard tier — a failing/throwing git command (uncomputable diff) fails closed, never degrades to warn', () => {
  const deps = makeFakeDeps({ baseSha: 'BASE', headSha: 'HEAD', changedFiles: [] });
  const throwingDeps = {
    ...deps,
    tier: 'standard',
    diffNameOnly: () => {
      throw new Error('git: fatal: bad revision');
    },
  };
  const result = runPhaseOrderCheck(throwingDeps);
  assert.equal(result.level, 'fail');
  assert.match(result.findings[0].message, /diff uncomputable \(cannot verify artefact presence\)/);
  assert.match(result.findings[0].message, /bad revision/);
});

test('wrapper: regulated tier — a failing/throwing git command (uncomputable diff) fails closed', () => {
  const deps = makeFakeDeps({ baseSha: 'BASE', headSha: 'HEAD', changedFiles: [] });
  const throwingDeps = {
    ...deps,
    tier: 'regulated',
    diffNameOnly: () => {
      throw new Error('git: fatal: bad revision');
    },
  };
  const result = runPhaseOrderCheck(throwingDeps);
  assert.equal(result.level, 'fail');
  assert.match(result.findings[0].message, /diff uncomputable \(cannot verify artefact presence\)/);
  assert.match(result.findings[0].message, /bad revision/);
});

test('wrapper: lite tier — a failing/throwing git command (uncomputable diff) degrades to a tier-named warning, exit 0', () => {
  const deps = makeFakeDeps({ baseSha: 'BASE', headSha: 'HEAD', changedFiles: [] });
  const throwingDeps = {
    ...deps,
    tier: 'lite',
    diffNameOnly: () => {
      throw new Error('git: fatal: bad revision');
    },
  };
  const result = runPhaseOrderCheck(throwingDeps);
  assert.equal(result.level, 'warn');
  assert.match(result.findings[0].message, /^::warning::phase-order:/);
  assert.match(result.findings[0].message, /\(tier: lite\)/);
  assert.match(result.findings[0].message, /diff uncomputable \(cannot verify artefact presence\)/);
  assert.match(result.findings[0].message, /bad revision/);
});

// ── wrapper — tier-scoped artefact set (issue #358 Q5, REQ-L4-2′) ────────────

test('wrapper: deps.tier="lite" passes Rule A with spec.md only, even though proposal/design/tasks are missing', () => {
  const deps = makeFakeDeps({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    filesAfter: {
      'openspec/changes/issue-999-foo/spec.md': '',
      'openspec/changes/issue-999-foo/tasks.md': '---\nstatus: tasked\n---\n- [x] done\n',
    },
  });

  const result = runPhaseOrderCheck({ ...deps, tier: 'lite' });
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.equal(ruleAFinding, undefined, 'lite tier must not fail Rule A on the reduced artefact set');
});

test('wrapper: deps.tier="standard" (or omitted) still fails Rule A without design.md', () => {
  const deps = makeFakeDeps({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    filesAfter: {
      'openspec/changes/issue-999-foo/proposal.md': '',
      'openspec/changes/issue-999-foo/spec.md': '',
      'openspec/changes/issue-999-foo/tasks.md': '---\nstatus: tasked\n---\n- [x] done\n',
    },
  });

  const result = runPhaseOrderCheck({ ...deps, tier: 'standard' });
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.ok(ruleAFinding, 'standard tier must still require design.md');
});

test('wrapper: hasVerification is gathered from verify-report.md presence (regulated artefact set)', () => {
  const deps = makeFakeDeps({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    filesAfter: {
      ...COMPLETE_DIR_FILES,
      'openspec/changes/issue-999-foo/verify-report.md': '',
    },
  });

  const result = runPhaseOrderCheck({ ...deps, tier: 'regulated' });
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.equal(ruleAFinding, undefined, 'regulated tier must pass Rule A when verify-report.md is present');
});

test('wrapper: regulated artefact set fails Rule A naming the missing verification artefact when verify-report.md is absent', () => {
  const deps = makeFakeDeps({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    filesAfter: COMPLETE_DIR_FILES, // no verify-report.md
  });

  const result = runPhaseOrderCheck({ ...deps, tier: 'regulated' });
  const ruleAFinding = result.findings.find(f => f.rule === 'A');
  assert.ok(ruleAFinding, 'regulated tier must fail Rule A when verify-report.md is absent');
  assert.match(ruleAFinding.message, /verify-report\.md/);
});

test('neutrality (REQ-NEUTRALITY-1): identical verdict with vs. without SKILL.md/.claude/** files present', () => {
  const shared = {
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    filesAfter: COMPLETE_DIR_FILES,
    filesBefore: { 'openspec/changes/issue-999-foo/tasks.md': '---\nstatus: tasked\n---\n- [x] already\n' },
  };
  const without = runPhaseOrderCheck(makeFakeDeps(shared));
  const withHarness = runPhaseOrderCheck(
    makeFakeDeps({
      ...shared,
      changedFiles: [...shared.changedFiles, 'SKILL.md', '.claude/settings.json'],
      filesAfter: {
        ...shared.filesAfter,
        'SKILL.md': '# a harness skill file',
        '.claude/settings.json': '{}',
      },
    })
  );
  assert.deepEqual(without, withHarness);
});

// ── ci-context seam wiring (ADR-0016) — reads ctx.baseSha/headSha ────────────

test('ci-context seam: deps.ctx.baseSha/headSha are used when deps.baseSha/headSha are absent', () => {
  const deps = makeFakeDeps({ changedFiles: [] });
  delete deps.baseSha;
  delete deps.headSha;
  const result = runPhaseOrderCheck({ ...deps, ctx: { baseSha: 'BASE', headSha: 'HEAD' } });
  // makeFakeDeps' diffNameOnly ignores its args and returns `changedFiles` — a
  // pass/warn/fail verdict (not the "BASE_SHA/HEAD_SHA not set" degrade) proves
  // gatherPhaseOrderInputs was actually invoked with ctx-derived shas.
  assert.notEqual(result.findings[0]?.message, 'BASE_SHA/HEAD_SHA not set — cannot compute diff; skipping phase-order check.');
});

test('ci-context seam: missing both deps.baseSha/headSha AND ctx → fails closed at standard (never reads process.env directly, never silently degrades)', () => {
  const deps = makeFakeDeps({ changedFiles: [] });
  delete deps.baseSha;
  delete deps.headSha;
  const result = runPhaseOrderCheck({ ...deps, tier: 'standard', ctx: { baseSha: null, headSha: null } });
  assert.equal(result.level, 'fail');
});

test('neutrality source-scan (REQ-NEUTRALITY-2): phase-order-check.mjs source contains no .claude or SKILL.md literal', () => {
  const srcPath = fileURLToPath(new URL('./phase-order-check.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.equal(src.includes('.claude'), false, 'source must not reference .claude');
  assert.equal(src.includes('SKILL.md'), false, 'source must not reference SKILL.md');
});

test('Gap G1: change dir with specs/foo/spec.md (nested convention) is detected as hasSpec=true — no false Rule A fail', () => {
  const deps = makeFakeDeps({
    changedFiles: ['brain/scripts/vcs/foo.mjs', 'openspec/changes/issue-999-foo/tasks.md'],
    filesAfter: {
      'openspec/changes/issue-999-foo/proposal.md': '',
      'openspec/changes/issue-999-foo/design.md': '',
      'openspec/changes/issue-999-foo/specs/governance/spec.md': '',
      'openspec/changes/issue-999-foo/tasks.md': '- [x] done\n',
    },
  });
  const result = runPhaseOrderCheck(deps);
  assert.equal(
    result.findings.filter(f => f.rule === 'A').length,
    0,
    `expected no Rule A finding, got: ${JSON.stringify(result.findings)}`
  );
});

test('baseline (REQ-L4-5): pre-v3 legacy dir with no spec artifact → exempt, not fail, in detection mode', () => {
  // The original 3-dir BASELINE_EXEMPT_DIRS literal (deleted in B1, REQ-B1-3)
  // — a strict subset of LEGACY_GRANDFATHERED — is exercised directly here so
  // this test keeps proving the "no spec artifact at all" exemption case,
  // independent of the other 9 sealed dirs which all carry a nested spec.
  const HISTORICAL_BASELINE_EXEMPT_DIRS = ['installer-versionado', 'vcs-adapter', 'cli-i18n'];
  for (const legacyDir of HISTORICAL_BASELINE_EXEMPT_DIRS) {
    assert.ok(LEGACY_GRANDFATHERED.includes(legacyDir), `expected ${legacyDir} in LEGACY_GRANDFATHERED`);
    const deps = makeFakeDeps({
      changedFiles: ['brain/scripts/vcs/foo.mjs', `openspec/changes/${legacyDir}/tasks.md`],
      filesAfter: {
        [`openspec/changes/${legacyDir}/proposal.md`]: '',
        [`openspec/changes/${legacyDir}/design.md`]: '',
        // no spec.md, no specs/*/spec.md — models the real pre-v3 dirs.
        [`openspec/changes/${legacyDir}/tasks.md`]: '- [x] done\n',
      },
    });
    const result = runPhaseOrderCheck(deps);
    assert.equal(result.level, 'pass', `${legacyDir}: expected pass (exempt), got ${result.level}`);
    const finding = result.findings.find(f => f.change === legacyDir);
    assert.ok(finding, `${legacyDir}: expected an exempted finding`);
    assert.equal(finding.level, 'exempt');
    assert.match(finding.message, /baseline exemption/);
  }
});

// ── #810 (#456 slice B): the walk set — tier scopes the four, declaration ────
// demands the rest, interleaving preserved.

test('#810: zero-config walk sets are byte-identical to the tier tables — all three tiers', () => {
  const std = resolveWalkSet({ config: {}, tier: 'standard' });
  assert.deepEqual(std.artefacts, ['proposal', 'spec', 'design', 'tasks']);
  assert.deepEqual(resolveWalkSet({ config: {}, tier: 'lite' }).artefacts, ['spec']);
  assert.deepEqual(resolveWalkSet({ config: {}, tier: 'regulated' }).artefacts,
    ['proposal', 'spec', 'design', 'tasks', 'verification'],
    'verification keeps its regulated demand — it is tier vocabulary, never a declared stage');
});

test('#810: a declared custom stage joins the walk IN ITS DECLARED POSITION, at every tier', () => {
  const config = { sdd: { stages: {
    proposal: {}, research: { artefact: 'research.md' }, spec: {}, design: {}, tasks: {},
  } } };
  assert.deepEqual(resolveWalkSet({ config, tier: 'standard' }).artefacts,
    ['proposal', 'research', 'spec', 'design', 'tasks'], 'interleaved, not appended');
  assert.deepEqual(resolveWalkSet({ config, tier: 'lite' }).artefacts,
    ['research', 'spec'],
    'the tier scopes the FOUR; declaring a custom stage IS the demand (REQ-L4-2 prime)');
  const reg = resolveWalkSet({ config, tier: 'regulated' });
  assert.deepEqual(reg.artefacts, ['proposal', 'research', 'spec', 'design', 'tasks', 'verification']);
  assert.equal(reg.fileMap.research, 'research.md', 'the resolved file rides with the set');
  assert.equal(reg.fileMap.verification, 'verify-report.md', 'the fixed map still answers for tier vocabulary');
});

test('#810: Rule A demands the custom artefact via the generic presence probe and NAMES its file', () => {
  const config = { sdd: { stages: {
    proposal: {}, research: { artefact: 'research.md' }, spec: {}, design: {}, tasks: {},
  } } };
  const { artefacts, fileMap } = resolveWalkSet({ config, tier: 'standard' });
  const r = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/x.mjs', 'openspec/changes/issue-9-z/proposal.md'],
    changeDirs: [{
      name: 'issue-9-z', hasProposal: true, hasSpec: true, hasDesign: true, hasTasks: true,
      present: { research: false }, checkedTasks: 1, statusBefore: null, statusAfter: null,
    }],
    artefacts, fileMap,
  });
  assert.equal(r.level, 'fail');
  assert.match(r.findings[0].message, /research\.md/, 'the message names the ACTUAL missing file, never the legacy literal');
  assert.ok(!r.findings[0].message.includes('spec.md/design.md'), 'the standard-four sentinel must not fire for a custom set');
});

test('#810: with the custom artefact present the walk passes — presence is read from the probe', () => {
  const config = { sdd: { stages: {
    proposal: {}, research: { artefact: 'research.md' }, spec: {}, design: {}, tasks: {},
  } } };
  const { artefacts, fileMap } = resolveWalkSet({ config, tier: 'standard' });
  const r = evaluatePhaseOrder({
    changedFiles: ['brain/scripts/x.mjs', 'openspec/changes/issue-9-z/proposal.md'],
    changeDirs: [{
      name: 'issue-9-z', hasProposal: true, hasSpec: true, hasDesign: true, hasTasks: true,
      present: { research: true }, checkedTasks: 1, statusBefore: null, statusAfter: null,
    }],
    artefacts, fileMap,
  });
  assert.equal(r.level, 'pass');
});

test('#810: a malformed sdd.stages declaration is an UNCOMPUTABLE verdict, never a crash', () => {
  const r = runPhaseOrderCheck({
    baseSha: 'b', headSha: 'h', tier: 'standard',
    readConfig: () => ({ sdd: { stages: { spec: {}, design: {}, tasks: {} } } }),
  });
  assert.equal(r.level, 'fail', 'standard tier fails closed on an uncomputable input');
  assert.match(r.findings[0].message, /omits lifecycle stage/, "the resolver's own refusal reaches the operator");
});

test('#810: buildChangeDir probes a custom artefact through the resolved file map', () => {
  const inputs = gatherPhaseOrderInputs({
    baseSha: 'b', headSha: 'h',
    deps: {
      diffNameOnly: () => ['openspec/changes/issue-9-z/research.md', 'brain/scripts/x.mjs'],
      exists: (p) => p === 'openspec/changes/issue-9-z/research.md' || p === 'openspec/changes/issue-9-z/proposal.md',
      listDir: () => [],
      readFile: () => null,
      showAtRef: () => null,
    },
    fileMap: { research: 'research.md' },
    customNames: ['research'],
  });
  assert.equal(inputs.changeDirs.length, 1);
  assert.deepEqual(inputs.changeDirs[0].present, { research: true }, 'the generic probe reads the RESOLVED file name');
});

test('#810 r2: a declaration naming reserved vocabulary is an uncomputable verdict at the gate', () => {
  const r = runPhaseOrderCheck({
    baseSha: 'b', headSha: 'h', tier: 'regulated',
    readConfig: () => ({ sdd: { stages: {
      proposal: {}, spec: {}, design: {}, tasks: {}, verification: { artefact: 'other.md' },
    } } }),
  });
  assert.equal(r.level, 'fail');
  assert.match(r.findings[0].message, /reserved/, "the resolver's refusal reaches the operator — never a flag/message fork");
});
