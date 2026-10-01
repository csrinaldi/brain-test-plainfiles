// sdd-layout.test.mjs — rehearsal-tests + drift-guard for sdd-layout.mjs (issue #250, B0;
// A3 landed in B1, issue #253).
// Owner ruling #587, item 2: each helper's test is written AS THE MEASURED SITE
// WILL CALL IT — citing the site by file:line — so the API is validated by
// rehearsal, not speculation. Run with: npm test (node --test, no dependencies).
//
// Phase 2 (A1 + A2 + A3) is the drift-guard: a TEST, not a lint rule (design §3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Task 1.1 (RED): fails with "module not found" until sdd-layout.mjs exists.
import {
  REQUIRED_ARTIFACTS,
  OPERATIONAL_ARTIFACTS,
  CHANGES_ROOT,
  LEGACY_GRANDFATHERED,
  LIFECYCLE_STAGES,
  changeDir,
  artifactPaths,
  archivePath,
  parseChangeId,
  isGrandfathered,
  hasSpec,
  missingRequiredArtifacts,
  resolveStageSet,
} from './sdd-layout.mjs';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── Task 1.2: the four frozen constants ──────────────────────────────────────

test('1.2: OPERATIONAL_ARTIFACTS / CHANGES_ROOT / LEGACY_GRANDFATHERED are frozen', () => {
  assert.ok(Object.isFrozen(OPERATIONAL_ARTIFACTS));
  assert.ok(Object.isFrozen(CHANGES_ROOT));
  assert.ok(Object.isFrozen(LEGACY_GRANDFATHERED));
  assert.equal(LEGACY_GRANDFATHERED.length, 12);
  // #555: `REQUIRED_ARTIFACTS` stays, as the SCAFFOLD set (REQ-L4-2′ — "the tier
  // scopes what the gate demands, never what the scaffold produces"). What is
  // tier-resolved is what the GATES require, which is `requiredArtifactsFor`.
  // Both are asserted, because the whole defect was treating them as one thing.
  assert.deepEqual(REQUIRED_ARTIFACTS, ['proposal.md', 'spec.md', 'design.md', 'tasks.md']);
  assert.deepEqual(requiredArtifactsFor('standard'), ['proposal.md', 'spec.md', 'design.md', 'tasks.md']);
  assert.deepEqual(requiredArtifactsFor('lite'), ['spec.md']);
});

// ── Task 1.3: changeDir — rehearses new-change.mjs:48-110, engram.mjs:804-805 &
// 925-926, feature-resolution.mjs:37-45, phase-order-check.mjs's CHANGE_DIR_PREFIX ──

test('1.3: changeDir rehearses join(repoRoot,"openspec","changes",changeId) (new-change.mjs:48-49)', () => {
  assert.equal(changeDir('issue-250-b0'), 'openspec/changes/issue-250-b0');
});

test('1.3: changeDir rehearses join(root,"openspec","changes",resolvedFeature) (engram.mjs:804-805 & 925-926)', () => {
  assert.equal(changeDir('issue-250-b0'), `${CHANGES_ROOT}/issue-250-b0`);
});

test('1.3: changeDir documents the shared change-dir literal ("openspec/changes/") that phase-order-check.mjs\'s private CHANGE_DIR_PREFIX also hardcodes today — CHANGE_DIR_PREFIX is unexported, so this test cannot rehearse it directly; B1\'s consolidation is what makes phase-order-check.mjs import CHANGES_ROOT instead of re-declaring the literal', () => {
  assert.equal(`${changeDir('issue-250-b0')}/`, `${CHANGES_ROOT}/issue-250-b0/`);
});

// ── Task 1.4: artifactPaths — rehearses new-change.mjs:48-110's four scaffolded targets ──

test('1.4: artifactPaths rehearses new-change.mjs writeFileSync targets (proposal/spec/design/tasks)', () => {
  const paths = artifactPaths('issue-250-b0');
  assert.deepEqual(paths, {
    proposal: 'openspec/changes/issue-250-b0/proposal.md',
    spec: 'openspec/changes/issue-250-b0/spec.md',
    design: 'openspec/changes/issue-250-b0/design.md',
    tasks: 'openspec/changes/issue-250-b0/tasks.md',
  });
  // Note: #251 (fix/issue-249-spec-scaffold) already landed on main — today's
  // new-change.mjs writes all four files, spec.md included. B1 wires the
  // scaffold onto artifactPaths(); this rehearsal only proves the shape matches.
});

// ── Task 1.5: archivePath — direct unit test (no rehearsal site; E1 unbuilt) ──

test('1.5: archivePath matches the measured value from design §5 (PLAN-adapters-v3.md §E1 line 361)', () => {
  assert.equal(archivePath('250'), 'openspec/changes/archive/250');
});

// ── Task 1.6: parseChangeId — rehearses session-start.mjs:38-69's deriveChangeFromBranch
// delimiter-anchored match + new-change.mjs:48's changeId construction shape ──

test('1.6: parseChangeId("issue-250-b0") rehearses new-change.mjs:48 changeId construction', () => {
  assert.deepEqual(parseChangeId('issue-250-b0'), { iid: '250', slug: 'b0' });
});

test('1.6: parseChangeId("issue-250") — a valid parse, slug:null is a violation for NEW dirs', () => {
  assert.deepEqual(parseChangeId('issue-250'), { iid: '250', slug: null });
});

test('1.6: parseChangeId("not-a-change-dir") → null', () => {
  assert.equal(parseChangeId('not-a-change-dir'), null);
});

test('1.6: rehearses session-start.mjs:70-77 delimiter-anchored match — "issue-138-session-start" must NOT match token "issue-13"', () => {
  // deriveChangeFromBranch matches `name === token || name.startsWith(`${token}-`)`.
  // parseChangeId proves the underlying dir-name shape session-start.mjs relies on:
  // 'issue-138-session-start' parses to iid '138', NOT a substring '13'.
  assert.deepEqual(parseChangeId('issue-138-session-start'), { iid: '138', slug: 'session-start' });
  assert.notEqual(parseChangeId('issue-138-session-start').iid, '13');
});

// ── Task 1.7: isGrandfathered — rehearses phase-order-check.mjs's BASELINE_EXEMPT_DIRS
// (subset proof) + check-refs.mjs:96-112's S-1 per-dir loop ──

test('1.7: isGrandfathered — the historical BASELINE_EXEMPT_DIRS (deleted in B1, REQ-B1-3) is a strict subset of LEGACY_GRANDFATHERED (proves B1\'s swap was behavior-preserving)', () => {
  // phase-order-check.mjs's own BASELINE_EXEMPT_DIRS export was removed in B1
  // (issue #253) once its default arg was swapped to LEGACY_GRANDFATHERED —
  // the 3 historical names are hardcoded here (documentation-only) since
  // there is no longer a live export to import for the subset proof.
  const HISTORICAL_BASELINE_EXEMPT_DIRS = ['installer-versionado', 'vcs-adapter', 'cli-i18n'];
  assert.equal(HISTORICAL_BASELINE_EXEMPT_DIRS.length, 3);
  for (const dir of HISTORICAL_BASELINE_EXEMPT_DIRS) {
    assert.ok(isGrandfathered(dir), `expected ${dir} to be grandfathered`);
  }
});

test('1.7: isGrandfathered — rehearses check-refs.mjs:96-112 S-1 per-dir loop, true for all 12 sealed names', () => {
  for (const dir of LEGACY_GRANDFATHERED) {
    assert.ok(isGrandfathered(dir), `expected ${dir} to be grandfathered`);
  }
});

test('1.7: isGrandfathered — false for an arbitrary new issue-<N>-<slug>', () => {
  assert.equal(isGrandfathered('issue-999-not-real'), false);
});

// ── Task 1.8: hasSpec — rehearses check-refs.mjs:96-112 extended to the flat-OR-nested
// tolerance pin (D1/Pin 1). Injectable {exists, listDir} — no real fs in this test ──

function fakeFs(entries) {
  // entries: relPath -> true (file/dir exists) | string[] (dir listing)
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(entries, p),
    listDir: (p) => {
      const v = entries[p];
      if (!Array.isArray(v)) throw new Error(`not a dir: ${p}`);
      return v;
    },
  };
}

test('1.8: hasSpec — true for a flat spec.md (canonical, rehearses check-refs.mjs S-1)', () => {
  const fs = fakeFs({ 'openspec/changes/issue-1-x/spec.md': true });
  assert.equal(hasSpec('issue-1-x', fs), true);
});

test('1.8: hasSpec — true for nested specs/<capability>/spec.md, no flat file (legacy governance/auto-adrs shape)', () => {
  const fs = fakeFs({
    'openspec/changes/governance/specs': ['workflow-governance'],
    'openspec/changes/governance/specs/workflow-governance/spec.md': true,
  });
  assert.equal(hasSpec('governance', fs), true);
});

test('1.8: hasSpec — false when neither flat nor nested spec exists', () => {
  const fs = fakeFs({});
  assert.equal(hasSpec('issue-1-x', fs), false);
});

// ── Task 1.9: missingRequiredArtifacts — rehearses check-refs.mjs:96-112 end-to-end ──

test('1.9: missingRequiredArtifacts — a NEW dir missing spec.md and design.md returns exactly those two', () => {
  const fs = fakeFs({
    'openspec/changes/issue-999-x/proposal.md': true,
    'openspec/changes/issue-999-x/tasks.md': true,
  });
  assert.deepEqual(missingRequiredArtifacts('issue-999-x', { artefacts: STANDARD, ...fs }), ['spec.md', 'design.md']);
});

test('1.9: missingRequiredArtifacts — a grandfathered dir missing everything short-circuits to [] ("the past is recorded, not edited")', () => {
  const fs = fakeFs({});
  assert.deepEqual(missingRequiredArtifacts('vcs-adapter', { artefacts: STANDARD, ...fs }), []);
});

test('1.9: missingRequiredArtifacts — spec slot delegates to hasSpec (nested spec counts as present)', () => {
  const fs = fakeFs({
    'openspec/changes/issue-999-x/proposal.md': true,
    'openspec/changes/issue-999-x/design.md': true,
    'openspec/changes/issue-999-x/tasks.md': true,
    'openspec/changes/issue-999-x/specs': ['cap'],
    'openspec/changes/issue-999-x/specs/cap/spec.md': true,
  });
  assert.deepEqual(missingRequiredArtifacts('issue-999-x', { artefacts: STANDARD, ...fs }), []);
});

// ── Task 1.10: OPERATIONAL_ARTIFACTS — rehearses feature-resolution.mjs:79-84
// (existsSync(join(changesDir, candidate, 'resume.md'))) + engram.mjs:805/926 ──

test('1.10: OPERATIONAL_ARTIFACTS includes resume.md, and no tier ever requires it', () => {
  assert.ok(OPERATIONAL_ARTIFACTS.includes('resume.md'));
  // Widened by #555: driven over EVERY tier, not one constant. `resume.md` is
  // machine-written and discardable, so a tier that required it would be a gate
  // on a file the tooling rewrites.
  for (const tier of ALL_TIERS) {
    assert.equal(requiredArtifactsFor(tier).includes('resume.md'), false, tier);
  }
});

test('1.10: resume.md is never consulted by missingRequiredArtifacts (feature-resolution.mjs:79-84 shape)', () => {
  const fs = fakeFs({
    'openspec/changes/issue-999-x/proposal.md': true,
    'openspec/changes/issue-999-x/spec.md': true,
    'openspec/changes/issue-999-x/design.md': true,
    'openspec/changes/issue-999-x/tasks.md': true,
    // resume.md deliberately absent — must not affect the result.
  });
  assert.deepEqual(missingRequiredArtifacts('issue-999-x', { artefacts: STANDARD, ...fs }), []);
});

// Task 1.11 (stop-condition, owner ruling #587 item 2): every helper above
// expressed its cited site's call shape without needing to reshape the site
// itself. STOP-CONDITION DID NOT FIRE — no B0 finding to report.

// ── #456 slice A — the stage set becomes DATA (design §2 D1/D2/D3/D5/D5a) ──
//
// `LIFECYCLE_STAGES` is THE ONE declaration (§1's measurement: the set was
// declared THREE times — here as bare names, in stage-engine.mjs, in
// phase-order-check.mjs — and the drift guard was blind to two of them
// because it only matched `.md`-suffixed names). `resolveStageSet` is PURE:
// config is RECEIVED, never read, because this module's own header promises
// "no side effects at import" and #555's first cut broke exactly that promise
// once already (design D1's "hard constraint discovered").
//
// `sdd.stages` is an OBJECT keyed by stage name (design D3, symmetric with
// `sdd.map`), not an array of bare strings — the spec's scenario prose uses
// array notation as shorthand for "the declared set of names in this order";
// the object form is what config actually carries (migration default is
// `{ sdd: { stages: {} } }`, not `[]`).

test('#456 1.1: resolveStageSet(undefined) resolves to the canonical four, in order, mapped to their default files', () => {
  const result = resolveStageSet(undefined);
  assert.deepEqual(result.stages, ['proposal', 'spec', 'design', 'tasks']);
  assert.deepEqual(result.files, {
    proposal: 'proposal.md', spec: 'spec.md', design: 'design.md', tasks: 'tasks.md',
  });
});

test('#456 1.1: resolveStageSet({}) — no sdd key at all — resolves identically to resolveStageSet(undefined) (zero-config identity)', () => {
  assert.deepEqual(resolveStageSet({}), resolveStageSet(undefined));
});

test('#456 1.1: resolveStageSet({ sdd: { stages: {} } }) — the 0.11.0 migration default — also resolves to the canonical four', () => {
  // This is the shape the migration ships on every existing consumer's config
  // (design D4): `{}` because writing the four into JSON would be a FOURTH
  // declaration of the set, in a file the drift guard cannot scan.
  assert.deepEqual(resolveStageSet({ sdd: { stages: {} } }).stages, ['proposal', 'spec', 'design', 'tasks']);
});

test('#456 1.1: REQUIRED_ARTIFACTS stays byte-identical after the LIFECYCLE_STAGES re-derivation', () => {
  assert.deepEqual(REQUIRED_ARTIFACTS, ['proposal.md', 'spec.md', 'design.md', 'tasks.md']);
  assert.deepEqual(REQUIRED_ARTIFACTS, artefactFiles(LIFECYCLE_STAGES));
});

test('#456: LIFECYCLE_STAGES is frozen and is the four in canonical order', () => {
  assert.ok(Object.isFrozen(LIFECYCLE_STAGES));
  assert.deepEqual(LIFECYCLE_STAGES, ['proposal', 'spec', 'design', 'tasks']);
});

test('#456 1.3: resolveStageSet refuses a declared set omitting one lifecycle stage, naming it', () => {
  assert.throws(
    () => resolveStageSet({ sdd: { stages: { proposal: {}, design: {}, tasks: {} } } }),
    /sdd.stages omits lifecycle stage\(s\) "spec"/,
    'the message must name the missing stage so a consumer can fix it without reading source',
  );
});

test('#456 1.3: resolveStageSet refuses a declared set omitting TWO lifecycle stages, naming both', () => {
  assert.throws(
    () => resolveStageSet({ sdd: { stages: { proposal: {}, tasks: {} } } }),
    /"spec".*"design"|"design".*"spec"/,
  );
});

test('#456 1.3: resolveStageSet refuses an empty sdd.stages set... no — an EXPLICIT empty set is zero-config (task 1.1), so omission only fires when at least one name is declared but not all four', () => {
  // Design D1/§the migration default: `{}` (no keys at all) is the absence of
  // a declaration, not a declaration of zero stages — it MUST resolve to the
  // default four (asserted above), never refuse. The spec's "empty array"
  // scenario describes a DIFFERENT shape (an array literal `[]`) that this
  // object-keyed config cannot express — see the note at the top of this
  // section on notation.
  assert.deepEqual(resolveStageSet({ sdd: { stages: {} } }).stages, ['proposal', 'spec', 'design', 'tasks']);
});

test('#456 1.3: resolveStageSet refuses the four declared out of relative order (D5a — REFUSED, not normalised)', () => {
  assert.throws(
    () => resolveStageSet({ sdd: { stages: { tasks: {}, design: {}, spec: {}, proposal: {} } } }),
    /out of relative order/,
  );
});

test('#456 1.3: resolveStageSet REFUSAL message states the expected canonical order (D5a — "the fix is readable from the error")', () => {
  assert.throws(
    () => resolveStageSet({ sdd: { stages: { tasks: {}, design: {}, spec: {}, proposal: {} } } }),
    /proposal, spec, design, tasks/,
  );
});

test('#456 1.3: a custom stage interleaved BETWEEN the four in canonical relative order is legal (design D5a: "interleaving stays legal")', () => {
  const result = resolveStageSet({
    sdd: {
      stages: {
        proposal: {}, 'threat-model': { artefact: 'threat-model.md' }, spec: {}, design: {}, tasks: {},
      },
    },
  });
  assert.deepEqual(result.stages, ['proposal', 'threat-model', 'spec', 'design', 'tasks']);
});

test('#456 1.3: resolveStageSet refuses a declared artefact colliding with an existing lifecycle file (impersonation, D5)', () => {
  assert.throws(
    () => resolveStageSet({
      sdd: {
        stages: {
          proposal: {}, spec: {}, design: {}, tasks: {},
          'threat-model': { artefact: 'spec.md' },
        },
      },
    }),
    /collides with an existing lifecycle file/,
  );
});

// The BOUNDARY of the collision check, pinned because it is the half a later
// edit removes. The refusal skips the entry that already owns the file
// (`lifecycleName !== name` in the finder): a stage restating its own canonical
// artefact is a redundancy, not an impersonation. Drop that comparison and this
// test goes red — without it, `spec: { artefact: 'spec.md' }` would be refused
// for colliding with itself, and the error would name the same stage twice.
test('#456 1.3b: a stage declaring its OWN canonical file is not a collision — the refusal skips the owner', () => {
  const result = resolveStageSet({
    sdd: {
      stages: {
        proposal: {}, spec: { artefact: 'spec.md' }, design: {}, tasks: {},
      },
    },
  });

  assert.deepEqual(result.stages, ['proposal', 'spec', 'design', 'tasks']);
  assert.equal(result.files.spec, 'spec.md');
});

test('#456 1.5: the four plus an explicit custom stage (`threat-model`) resolves to five, files merged', () => {
  const result = resolveStageSet({
    sdd: {
      stages: {
        proposal: {}, spec: {}, design: {}, tasks: {}, 'threat-model': { artefact: 'threat-model.md' },
      },
    },
  });
  assert.deepEqual(result.stages, ['proposal', 'spec', 'design', 'tasks', 'threat-model']);
  assert.deepEqual(result.files, {
    proposal: 'proposal.md', spec: 'spec.md', design: 'design.md', tasks: 'tasks.md',
    'threat-model': 'threat-model.md',
  });
});

test('#456: a custom stage declared WITHOUT an artefact file is refused, naming the stage (D3 — the refusal stays intact; which map is consulted changed, not whether one is)', () => {
  assert.throws(
    () => resolveStageSet({ sdd: { stages: { proposal: {}, spec: {}, design: {}, tasks: {}, 'threat-model': {} } } }),
    /unknown artefact name "threat-model"/,
  );
});

test('#456: artefactFiles(names) on the DEFAULT map still throws for an unmapped name — the default fileMap param does not weaken the existing refusal (D3)', () => {
  assert.throws(() => artefactFiles(['threat-model']), /unknown artefact name/i);
});

// ── Phase 2: the drift-guard — a TEST, not a lint rule (design §3) ──────────

// A1 — single source (blocking, B0). Scan brain/scripts/**/*.mjs (excluding
// sdd-layout.mjs and *.test.mjs) for a rival array literal that stands in as
// a second REQUIRED_ARTIFACTS-shaped definition. Precision-tuned (task 2.2 /
// CP concern): an array literal counts as a rival only when it co-occurs AT
// LEAST 3 of the 4 canonical filenames — this is what excludes check-refs.mjs's
// pre-existing, narrower `['proposal.md', 'tasks.md']` S-1 loop (a real,
// already-known 2-of-4 partial array — B1 worklist item 1 migrates it; it is
// NOT a new rival full-set definition and must not false-positive the guard).
const ARTIFACT_NAMES = ['proposal.md', 'spec.md', 'design.md', 'tasks.md'];
const BRACKET_RE = /\[[^\]]*\]/gs;

// Known heuristic limit (documented, not chased — mirrors how C3 documented its
// indirect-binding residual rather than closing it): splitting the 4 canonical
// filenames across TWO separate `[...]` array literals stays under the 3-of-4
// threshold in each bracket and evades this scan. Not hardened, because a
// genuine accidental second REQUIRED_ARTIFACTS definition is naturally written
// as ONE literal — chasing the split-literal case risks new false positives
// (the guard's actual death mode) for a threat model that isn't realistic.
function countArtifactTokens(bracketText) {
  return ARTIFACT_NAMES.filter((name) =>
    bracketText.includes(`'${name}'`) || bracketText.includes(`"${name}"`) || bracketText.includes(`\`${name}\``),
  ).length;
}

function scanForRivalArtifactArray(root, { readdir = readdirSync, readFile = readFileSync } = {}) {
  const offenders = [];
  const entries = readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    if (entry.name.endsWith('.test.mjs') || entry.name === 'sdd-layout.mjs') continue;
    const relDir = entry.parentPath ?? entry.path;
    const full = join(relDir, entry.name);
    const content = readFile(full, 'utf8');
    const brackets = content.match(BRACKET_RE) ?? [];
    if (brackets.some((b) => countArtifactTokens(b) >= 3)) offenders.push(full);
  }
  return offenders;
}

test('2.1: A1 false-positive fixture — a rival array literal co-occurring 3+ of the 4 canonical names IS caught, naming the file', () => {
  const files = {
    'fixture/rival.mjs': `export const REQUIRED = ['proposal.md', 'design.md', 'tasks.md'];`,
  };
  const offenders = scanForRivalArtifactArray('fixture', {
    readdir: () => [{ isFile: () => true, name: 'rival.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
  });
  assert.deepEqual(offenders, ['fixture/rival.mjs']);
});

test('2.1b (MINOR 2, fresh-review hardening): A1 catches a BACKTICK-quoted rival array literal (evasion: backticks instead of \'/" quotes)', () => {
  const files = {
    'fixture/rival-backtick.mjs': 'export const REQUIRED = [`proposal.md`, `spec.md`, `design.md`, `tasks.md`];',
  };
  const offenders = scanForRivalArtifactArray('fixture', {
    readdir: () => [{ isFile: () => true, name: 'rival-backtick.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
  });
  assert.deepEqual(offenders, ['fixture/rival-backtick.mjs']);
});

test('2.2: A1 precision guard — a BASELINE_EXEMPT_DIRS-shaped 3-element array does NOT trip the scan', () => {
  const content = `export const BASELINE_EXEMPT_DIRS = ['installer-versionado', 'vcs-adapter', 'cli-i18n'];`;
  const brackets = content.match(BRACKET_RE) ?? [];
  assert.ok(brackets.every((b) => countArtifactTokens(b) < 3));
});

test('2.2: A1 precision guard — a 2-element subset mentioning only proposal.md (check-refs.mjs\'s own pre-existing S-1 shape) does NOT trip the scan', () => {
  const content = `for (const required of ['proposal.md', 'tasks.md']) {`;
  const brackets = content.match(BRACKET_RE) ?? [];
  assert.ok(brackets.every((b) => countArtifactTokens(b) < 3));
});

test('2.2: A1 precision guard — the same 4 strings scattered across separate const declarations (no shared array literal) does NOT trip the scan', () => {
  const content = `const a = 'proposal.md';\nconst b = 'spec.md';\nconst c = 'design.md';\nconst d = 'tasks.md';`;
  const brackets = content.match(BRACKET_RE) ?? [];
  assert.equal(brackets.length, 0);
});

test('2.3: A1 real-repo-tree pass — brain/scripts/** has no rival REQUIRED_ARTIFACTS-shaped array today', () => {
  const offenders = scanForRivalArtifactArray(SCRIPTS_DIR);
  assert.deepEqual(offenders, []);
});

// A2 — sealed set (blocking, B0).
const THE_12_HARDCODED = [
  'installer-versionado', 'vcs-adapter', 'cli-i18n',
  'feature-working-memory', 'auto-adrs', 'governance',
  'managed-paths-namespace', 'issue-138-session-start',
  'issue-144-governance-v3', 'install-home-scaffold',
  'issue-193-ci-context-design', 'issue-196-ci-context-impl',
];

test('2.4: A2 sealed-12 lock — the comparison mechanism itself distinguishes 12 from a hypothetical 13th entry', () => {
  const thirteen = [...LEGACY_GRANDFATHERED, 'issue-999-not-real'];
  assert.notDeepEqual([...thirteen].sort(), [...THE_12_HARDCODED].sort());
});

test('2.5: A2 sealed-12 lock — the real export equals EXACTLY the 12 hardcoded names (a 13th entry, removal, or typo fails here)', () => {
  assert.deepEqual([...LEGACY_GRANDFATHERED].sort(), [...THE_12_HARDCODED].sort());
});

// A3 — consumers reference the module via their real ESM import shape (B1,
// issue #253, design §4, REQ-B1-4). Precision over coverage — the A1 lesson
// carried forward: never a loose substring, never a single shared depth
// literal (a shared '../lib/' would false-negative 5 of 6 sites).

const LAYOUT_ABS = fileURLToPath(new URL('./sdd-layout.mjs', import.meta.url));

// The six sites (REQ-B1-1), relative to SCRIPTS_DIR — five physical files
// (engram's two call sites share one import).
const CONSUMING_SITE_RELPATHS = [
  'check-refs.mjs',
  'session-start.mjs',
  'new-change.mjs',
  'vcs/phase-order-check.mjs',
  'axes/memory/adapters/engram.mjs',
  'memory/lib/feature-resolution.mjs',
];

/** Never hand-typed — self-corrects if a file moves (design §4). */
function computeExpectedSpecifier(siteAbsPath) {
  const rel = relative(dirname(siteAbsPath), LAYOUT_ABS).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

const CONSUMING_SITES = CONSUMING_SITE_RELPATHS.map((rel) => {
  const abs = join(SCRIPTS_DIR, rel);
  return { rel, abs, specifier: computeExpectedSpecifier(abs) };
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The real A3 assertion (task 4.3): a genuine `import { ... } from '<specifier>'`. */
function siteImportsLayoutViaRealShape(content, specifier) {
  const re = new RegExp(`import\\s*\\{[^}]*\\}\\s*from\\s*['"]${escapeRegExp(specifier)}['"]`);
  return re.test(content);
}

/** The REJECTED naive approach — a loose substring match (design §4's death mode). */
function naiveLooseSubstringMatch(content) {
  return content.includes('sdd-layout');
}

// ── Task 4.2 — false-positive/false-negative traps, written FIRST, proven
// against the NAIVE matcher before the real assertion is trusted ───────────

test('A3 trap (a): a doc-comment mention of sdd-layout fools the naive substring matcher (false positive) but NOT the real import-shape assertion', () => {
  const content = '// see sdd-layout.mjs for the contract this file should eventually consume\nexport const x = 1;\n';
  assert.equal(naiveLooseSubstringMatch(content), true, 'naive matcher is expected to be fooled here');
  assert.equal(siteImportsLayoutViaRealShape(content, './lib/sdd-layout.mjs'), false);
});

test('A3 trap (b): the .test.mjs filename itself satisfies the naive substring matcher (false positive) but NOT the real assertion', () => {
  const content = "// companion of sdd-layout.test.mjs\nexport const x = 1;\n";
  assert.equal(naiveLooseSubstringMatch(content), true, 'naive matcher is expected to be fooled here');
  assert.equal(siteImportsLayoutViaRealShape(content, './lib/sdd-layout.mjs'), false);
});

test('A3 trap (c): a shared "../lib/" literal false-NEGATIVES a real "./lib/" site — depth precision matters (design §4\'s core concern)', () => {
  // check-refs.mjs's REAL, correct import (depth './lib/') — but tested
  // against the WRONG shared specifier a naive single-depth guard would use.
  const content = "import { CHANGES_ROOT, missingRequiredArtifacts, isGrandfathered } from './lib/sdd-layout.mjs';\n";
  assert.equal(
    siteImportsLayoutViaRealShape(content, '../lib/sdd-layout.mjs'),
    false,
    'a shared "../lib/" literal must false-negative this real "./lib/" import',
  );
  assert.equal(
    siteImportsLayoutViaRealShape(content, './lib/sdd-layout.mjs'),
    true,
    'the correctly computed per-site specifier must match',
  );
});

test('A3 trap (d): a bare side-effect import (no braces) satisfies the naive matcher (false positive) but NOT the real assertion (requires a named { } consumption)', () => {
  const content = "import '../lib/sdd-layout.mjs';\n";
  assert.equal(naiveLooseSubstringMatch(content), true, 'naive matcher is expected to be fooled here');
  assert.equal(siteImportsLayoutViaRealShape(content, '../lib/sdd-layout.mjs'), false);
});

// ── Task 4.3 — the real assertion, run against all six wired sites ─────────

test('A3: all six wired sites reference sdd-layout.mjs via their real, per-site-depth import shape', () => {
  for (const site of CONSUMING_SITES) {
    const content = readFileSync(site.abs, 'utf8');
    assert.ok(
      siteImportsLayoutViaRealShape(content, site.specifier),
      `${site.rel}: expected a real "import { ... } from '${site.specifier}'" statement`,
    );
  }
});

test('A3: the per-site specifiers are NOT a single shared literal (proves depth precision is exercised, not vacuously)', () => {
  const specifiers = new Set(CONSUMING_SITES.map((s) => s.specifier));
  assert.ok(specifiers.size >= 3, `expected at least 3 distinct depths (./, ../, ../../), got: ${[...specifiers]}`);
});

// ── Task 4.4 — negative case: a site re-declaring a rival literal fails A3,
// naming the offending file ─────────────────────────────────────────────────

function scanSitesForA3(sites) {
  const offenders = [];
  for (const site of sites) {
    if (!siteImportsLayoutViaRealShape(site.content, site.specifier)) offenders.push(site.rel);
  }
  return offenders;
}

test('A3 negative case: a hypothetical site re-declaring its own artifact-name array / openspec-changes literal / grandfather list, without importing the accessor, fails A3 and is named', () => {
  const rivalSite = {
    rel: 'fixture/rival-site.mjs',
    specifier: './lib/sdd-layout.mjs',
    content: [
      "const REQUIRED_ARTIFACTS = ['proposal.md', 'spec.md', 'design.md', 'tasks.md'];",
      "const CHANGES_DIR = 'openspec/changes';",
      "const GRANDFATHERED = ['installer-versionado', 'vcs-adapter', 'cli-i18n'];",
    ].join('\n'),
  };
  const legitSite = {
    rel: 'fixture/legit-site.mjs',
    specifier: './lib/sdd-layout.mjs',
    content: "import { CHANGES_ROOT } from './lib/sdd-layout.mjs';",
  };
  const offenders = scanSitesForA3([legitSite, rivalSite]);
  assert.deepEqual(offenders, ['fixture/rival-site.mjs']);
});

// ── Task 4.5 — A3 against all six sites as wired in Phases 2–3 ─────────────

test('A3 (task 4.5): scanning the six real wired sites reports zero offenders', () => {
  const sites = CONSUMING_SITES.map((s) => ({ ...s, content: readFileSync(s.abs, 'utf8') }));
  assert.deepEqual(scanSitesForA3(sites), []);
});

// ── #555: ONE artifact set, resolved by tier ────────────────────────────────
//
// Two sets coexisted and disagreed in three ways at once — contents (1 vs 4 vs 5),
// extension (`spec` vs `spec.md`), and one being fixed while the other tiered:
//
//   REQUIRED_ARTIFACTS (fixed)      ["proposal.md","spec.md","design.md","tasks.md"]
//   tierParams('lite').artefacts    ["spec"]
//
// `phase-order` was tiered by #358 Q5. `missingRequiredArtifacts` and its two
// consumers were not, so at the tier brain declares for ITSELF, doctrine said
// `spec` suffices while `local-checks` and the reviewer's checkpoint demanded all
// four. The same change passed one gate and blocked on another — this repository's
// own configuration, not a laboratory case.
//
// #312 is why it stopped being decoration: the artifact set became the primary key
// of the executor contract, and a contract keyed on an ambiguous set inherits the
// ambiguity.

import { requiredArtifactsFor } from '../vcs/governance-tiers.mjs';
import { tierParams as tierParamsFor, TIERS as ALL_TIERS } from '../vcs/governance-tiers.mjs';
import { assertRoutableStage } from './stage-engine.mjs';

/** #555: these tests measured against the fixed four; they now name the set explicitly. */
const STANDARD = requiredArtifactsFor('standard');

test('#555: requiredArtifactsFor resolves from the tier table, with the extension normalised in ONE place', () => {
  assert.deepEqual(requiredArtifactsFor('lite'), ['spec.md']);
  assert.deepEqual(requiredArtifactsFor('standard'), ['proposal.md', 'spec.md', 'design.md', 'tasks.md']);
  assert.deepEqual(requiredArtifactsFor('regulated'),
    ['proposal.md', 'spec.md', 'design.md', 'tasks.md', 'verify-report.md']);
});

// #555 round 2 — a guard was REMOVED here, twice over, and the reason is worth
// more than the guard was.
//
// v1 asserted `requiredArtifactsFor(tier)` equalled `artefacts.map(n => n + '.md')`
// — character-for-character the function's body. It agreed with the
// `verification.md` bug instead of catching it.
//
// v2 replaced it with cardinality + membership against ARTEFACT_FILE. Also a
// theorem of the implementation: `.map()` preserves length, and every value it can
// return is by construction a value of the map. Proven inert by a cold review —
// with `spec` remapped to `design.md`, a filename WAS invented and the guard whose
// failure message read "a filename was invented" passed.
//
// Both were written FROM the implementation, which is the one place a guard cannot
// see a mistake. What actually catches an invented filename is the literal
// expectation in the test above, because those literals are an independent
// declaration of the answer. Two tautologies are not worth a third attempt.

test('#555: at `lite` a change carrying only spec.md is COMPLETE — the tier brain declares for itself', () => {
  // Before the fix this returned ["proposal.md","design.md","tasks.md"] and the
  // reviewer emitted an `artifacts-missing` BLOCKER over a change doctrine calls
  // finished.
  const seam = {
    exists: (p) => p.endsWith('/spec.md'),
    listDir: () => ['spec.md'],
  };
  assert.deepEqual(missingRequiredArtifacts('issue-999-only-spec', { artefacts: requiredArtifactsFor('lite'), ...seam }), []);
});

test('#555: and at `standard` the same change is still incomplete — the fix is not a blanket loosening', () => {
  const seam = {
    exists: (p) => p.endsWith('/spec.md'),
    listDir: () => ['spec.md'],
  };
  assert.deepEqual(
    missingRequiredArtifacts('issue-999-only-spec', { artefacts: requiredArtifactsFor('standard'), ...seam }),
    ['proposal.md', 'design.md', 'tasks.md']);
});

test('#555: omitting the set THROWS — a consumer cannot silently fall back to its own list', () => {
  // The guard the ticket asks for, and it is structural rather than textual: there
  // is no default to drift because there is no default at all. A consumer that
  // "goes back to reading its own list" has to pass it explicitly, which is visible
  // in the diff instead of hiding in a parameter default.
  assert.throws(
    () => missingRequiredArtifacts('issue-999-x', { exists: () => false, listDir: () => [] }),
    /artefacts` is required/,
    'an absent set must refuse, not quietly assume the four');
});

// ── #555 round 2: the name→file map, found by a cold review ─────────────────
//
// The first cut derived filenames by appending `.md` to the tier table's bare
// names. That is not the convention: `verification` is `verify-report.md`
// (phase-order-check.mjs's `buildChangeDir`). So `regulated` demanded a file that
// exists nowhere, and a change carrying all five REAL artefacts passed
// `phase-order` and failed `check-refs` — #555's own complaint, relocated from
// `lite` to `regulated`.
//
// The root cause was that the mapping existed TWICE and disagreed. It is one map
// now, and `phase-order`'s message reads from it too — that message had the same
// defect already, naming `verification.md` for a probe of `verify-report.md`.

import { ARTEFACT_FILE, artefactFiles } from './sdd-layout.mjs';

test('#555: the artefact name→file map is NOT a suffix rule — verification is verify-report.md', () => {
  assert.equal(ARTEFACT_FILE.verification, 'verify-report.md',
    'the one name that breaks the `.md` rule is the whole reason this map exists');
  assert.deepEqual(artefactFiles(['proposal', 'spec', 'design', 'tasks']),
    ['proposal.md', 'spec.md', 'design.md', 'tasks.md']);
  assert.deepEqual(artefactFiles(['verification']), ['verify-report.md']);
});

test('#555: an unmapped artefact name REFUSES — it is never guessed at with .md', () => {
  // Guessing is what produced the blocker. A name the map does not know is a
  // config error, and inventing a filename for it hides that error until a
  // consumer at that tier cannot satisfy a gate.
  assert.throws(() => artefactFiles(['whatever']), /unknown artefact name/i);
});

test('#555: every tier the table declares resolves to files the repo actually writes', () => {
  // Driven over EVERY tier rather than the three spelled out, so a tier added
  // later cannot introduce a name with no file behind it.
  for (const tier of ALL_TIERS) {
    for (const name of tierParamsFor(tier).artefacts) {
      assert.ok(ARTEFACT_FILE[name], `${tier} declares "${name}" and the map has no file for it`);
    }
  }
});

test('#555: at `regulated`, a change carrying the five REAL artefacts is complete', () => {
  // The blocker, driven end to end. Before the fix this returned
  // ['verification.md'] over a dir that had everything the repo's own convention
  // writes.
  const present = new Set(['proposal.md', 'spec.md', 'design.md', 'tasks.md', 'verify-report.md']);
  const seam = {
    exists: (p) => present.has(p.split('/').pop()),
    listDir: () => [...present],
  };
  assert.deepEqual(
    missingRequiredArtifacts('issue-999-reg', { artefacts: requiredArtifactsFor('regulated'), ...seam }),
    []);
});

test('#555: REQUIRED_ARTIFACTS is restored as the SCAFFOLD set — four, at every tier', () => {
  // REQ-L4-2′: "REQUIRED_ARTIFACTS in sdd-layout.mjs stays the canonical scaffold
  // set at every tier — the tier scopes what the GATE demands, never what the
  // SCAFFOLD produces." The first cut deleted it to fix the gate question, which
  // collapsed two things the spec deliberately separates.
  assert.deepEqual(REQUIRED_ARTIFACTS, ['proposal.md', 'spec.md', 'design.md', 'tasks.md']);
  assert.ok(Object.isFrozen(REQUIRED_ARTIFACTS));
});

// ── Phase 5 (#456 slice A, design D6) — the drift guard's SECOND scan ───────
//
// A1 above matches `.md`-suffixed names only. §1's measurement found the set
// declared a THIRD time, in BARE names (`stage-engine.mjs`'s
// `SDD_LIFECYCLE_STAGES`, `phase-order-check.mjs`'s `STANDARD_ARTEFACTS`) —
// invisible to A1's `ARTIFACT_NAMES` scan. This is a SECOND scan beside A1,
// not a widened A1 (D6): same BRACKET_RE array-literal window, same 3-of-4
// quoted-token threshold, following `__fixtures__/tmp-tree-adoption.test.mjs`
// (#802)'s precedent of writing the false-positive/false-negative traps
// FIRST, before the real scan is trusted.
//
// LANDS LAST in the task order (Phase 5, after Phases 2-3 removed the two
// bare-name literals it exists to prove are gone) — running it earlier would
// fail on this repo's OWN pre-migration tree.

const LIFECYCLE_NAMES = ['proposal', 'spec', 'design', 'tasks'];

/** Same quoted-token requirement as A1's countArtifactTokens, over bare names
 *  instead of `.md`-suffixed ones — a comment inside a bracket carries no
 *  quotes; a real rival array literal always does. */
function countBareStageTokens(bracketText) {
  return LIFECYCLE_NAMES.filter((name) =>
    bracketText.includes(`'${name}'`) || bracketText.includes(`"${name}"`) || bracketText.includes(`\`${name}\``),
  ).length;
}

/**
 * The allowlist for `scanForRivalStageArray`. `governance-tiers.mjs`'s
 * `TIER_PARAMS` is the ONE entry, and it is a legitimate 4-of-4 hit — REQ-L4-2′:
 * "the tier scopes what the GATE demands, never what the SCAFFOLD produces."
 * That table declares the GATE set per tier (`standard`'s `artefacts` is the
 * bare four; `regulated`'s is the four plus `verification`), which #555's
 * first cut collapsed onto the SCAFFOLD set exactly once already. This entry
 * is the executable statement of that separation, not a workaround for it —
 * pinned here so the next author who wants to "clean up the duplicate" reads
 * the reason before doing so.
 *
 * Neither `stage-engine.mjs` nor `phase-order-check.mjs` is allowlisted —
 * both must stop declaring their own literal (Phases 2-3), which is what
 * task 5.3's real-tree scan proves.
 */
const STAGE_DRIFT_ALLOWLIST = [
  {
    path: 'brain/scripts/vcs/governance-tiers.mjs',
    reason: 'REQ-L4-2′: the tier scopes what the GATE demands, never what the SCAFFOLD produces — ' +
      'TIER_PARAMS.artefacts is the tier-scoped GATE set, a DIFFERENT set from LIFECYCLE_STAGES on purpose.',
  },
  {
    path: 'brain/scripts/ui/lib/sdd-model.mjs',
    reason: 'D9: this module is loaded directly by the browser (app.js -> ./lib/sdd-model.mjs), and ' +
      'sdd-layout.mjs is not browser-safe (node:fs at module scope for its own exists()/listDir() ' +
      'defaults) — importing it would break the page\'s whole module graph, not just the SDD tab\'s. ' +
      'LIFECYCLE_ORDER is a genuine restatement of LIFECYCLE_STAGES, pinned equal to it by ' +
      'sdd-model.test.mjs (a node:test file, never served to the browser).',
  },
];

function scanForRivalStageArray(root, { readdir = readdirSync, readFile = readFileSync, allowlist = STAGE_DRIFT_ALLOWLIST } = {}) {
  const repoRoot = join(SCRIPTS_DIR, '..', '..');
  const allowSet = new Set(allowlist.map((e) => join(repoRoot, e.path)));
  const offenders = [];
  const entries = readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    if (entry.name.endsWith('.test.mjs') || entry.name === 'sdd-layout.mjs') continue;
    const relDir = entry.parentPath ?? entry.path;
    const full = join(relDir, entry.name);
    if (allowSet.has(full)) continue;
    const content = readFile(full, 'utf8');
    const brackets = content.match(BRACKET_RE) ?? [];
    if (brackets.some((b) => countBareStageTokens(b) >= 3)) offenders.push(full);
  }
  return offenders;
}

test('5.1: scanForRivalStageArray catches a bare-name rival array literal co-occurring 3+ of the 4 lifecycle names, naming the file', () => {
  const files = {
    'fixture/rival.mjs': `export const RIVAL = ['proposal', 'design', 'tasks'];`,
  };
  const offenders = scanForRivalStageArray('fixture', {
    readdir: () => [{ isFile: () => true, name: 'rival.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
    allowlist: [],
  });
  assert.deepEqual(offenders, ['fixture/rival.mjs']);
});

test('5.1: scanForRivalStageArray does NOT trip on a 2-of-4 partial bare-name array (below the 3-of-4 threshold)', () => {
  const files = {
    'fixture/partial.mjs': `export const SOME = ['proposal', 'tasks'];`,
  };
  const offenders = scanForRivalStageArray('fixture', {
    readdir: () => [{ isFile: () => true, name: 'partial.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
    allowlist: [],
  });
  assert.deepEqual(offenders, []);
});

test('5.1: scanForRivalStageArray ignores an UNQUOTED mention inside brackets — a comment or prose token carries no quotes, a real rival literal always does', () => {
  const files = {
    'fixture/prose.mjs': `// [proposal, spec, design, tasks] — the four stages, mentioned in prose\nexport const x = 1;`,
  };
  const offenders = scanForRivalStageArray('fixture', {
    readdir: () => [{ isFile: () => true, name: 'prose.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
    allowlist: [],
  });
  assert.deepEqual(offenders, []);
});

test('5.1: the allowlisted governance-tiers.mjs-shaped path does NOT trip, while a non-allowlisted twin at a different path DOES', () => {
  const repoRoot = join(SCRIPTS_DIR, '..', '..');
  const dir = join(repoRoot, 'brain', 'scripts', 'vcs');
  const content = `export const TIER_PARAMS = { standard: { artefacts: ['proposal', 'spec', 'design', 'tasks'] } };`;
  const files = {
    [join(dir, 'governance-tiers.mjs')]: content,
    [join(dir, 'not-allowlisted-twin.mjs')]: content,
  };
  const offenders = scanForRivalStageArray(dir, {
    readdir: () => [
      { isFile: () => true, name: 'governance-tiers.mjs', parentPath: dir },
      { isFile: () => true, name: 'not-allowlisted-twin.mjs', parentPath: dir },
    ],
    readFile: (p) => files[p],
  });
  assert.deepEqual(offenders, [join(dir, 'not-allowlisted-twin.mjs')]);
});

test('5.2: scanForRivalStageArray real-tree scan of brain/scripts/** returns ZERO offenders (proves Phases 2-3 landed — no bare-name rival remains)', () => {
  const offenders = scanForRivalStageArray(SCRIPTS_DIR);
  const message = offenders.length === 0
    ? undefined
    : `Found ${offenders.length} bare-name rival stage-set array(s): ${offenders.join(', ')}. ` +
      'Import LIFECYCLE_STAGES from sdd-layout.mjs instead of declaring a private literal (issue #456), ' +
      'or add a REVIEWED allowlist entry with a one-line reason stating REQ-L4-2′ if the array is ' +
      'genuinely a tier-scoped GATE set, not a rival SCAFFOLD declaration.';
  assert.deepEqual(offenders, [], message);
});

// ── Phase 6 (#456 slice A) — separation + untouched-surface proof ──────────

test('6.1: REQ-L4-2′ both directions at `lite` — SCAFFOLD (REQUIRED_ARTIFACTS) is the four at every tier; GATE (requiredArtifactsFor) is tier-scoped and DIFFERENT at `lite`', () => {
  // #555's collapse, re-armed: the fix this slice ships must not quietly
  // re-merge the two sets it took a bug report to separate the first time.
  assert.deepEqual(REQUIRED_ARTIFACTS, ['proposal.md', 'spec.md', 'design.md', 'tasks.md'],
    'SCAFFOLD: brain:project:feature always writes all four, unaffected by tier');
  assert.deepEqual(requiredArtifactsFor('lite'), ['spec.md'],
    'GATE: at `lite` the tier demands only spec.md — a DIFFERENT, SMALLER set than SCAFFOLD');
  assert.notDeepEqual(REQUIRED_ARTIFACTS, requiredArtifactsFor('lite'),
    'the two sets must disagree at `lite` — proving they are separate, not the same list read twice');
});

test('6.2: declaring the four in sdd.stages does NOT hand out routed evidence — declaration and the conditions check are different doors (#323 S2)', () => {
  // resolveStageSet's resolved (config-dependent) set is NEVER what
  // assertRoutableStage refuses against — it refuses against
  // stage-engine.mjs's SDD_LIFECYCLE_STAGES, a re-export of the same
  // LIFECYCLE_STAGES constant this resolves from, which additive-only
  // guarantees is always a subset of any resolved set.
  const resolved = resolveStageSet({
    sdd: { stages: { proposal: {}, spec: {}, design: {}, tasks: {}, 'threat-model': { artefact: 'threat-model.md' } } },
  });
  assert.deepEqual(resolved.stages, ['proposal', 'spec', 'design', 'tasks', 'threat-model']);
  for (const stage of LIFECYCLE_STAGES) {
    assert.throws(() => assertRoutableStage(stage), /without routed evidence/,
      `${stage} still refuses without assertRoutedStage's result — an sdd.stages declaration is not evidence the conditions hold`);
  }
  // The custom stage IS routable — that is the point of declaring it (cold-review precedent).
  assert.doesNotThrow(() => assertRoutableStage('threat-model'));
});

// ── issue #323 S5 — the brain-slice-scope/1 contract ────────────────────────

test('#323 S5: two well-formed scope blocks parse, in order', async () => {
  const { parseSliceScopes } = await import('./sdd-layout.mjs');
  const text = [
    '# Tasks', '',
    '```brain-slice-scope/1', '{"slice": 1, "claims": ["REQ-1"], "terminal_pr": "feature/x -> main"}', '```', '',
    'plan prose the reviewer never needs', '',
    '```brain-slice-scope/1', '{"slice": 2, "claims": ["REQ-2", "REQ-3"], "terminal_pr": "feature/x -> main"}', '```',
  ].join('\n');
  const { scopes, refusal } = parseSliceScopes(text);
  assert.equal(refusal, null);
  assert.deepEqual(scopes.map((s) => s.slice), [1, 2]);
  assert.deepEqual(scopes[1].claims, ['REQ-2', 'REQ-3']);
});

test('#323 S5: absence is LEGAL — legacy is grandfathered by absence, not by list', async () => {
  const { parseSliceScopes } = await import('./sdd-layout.mjs');
  const { scopes, refusal } = parseSliceScopes('# Tasks\n- [ ] 1.1 things\n');
  assert.equal(refusal, null);
  assert.deepEqual(scopes, []);
});

test('#323 S5: malformed blocks refuse with the rule named — JS, bad claims, missing terminal', async () => {
  const { parseSliceScopes } = await import('./sdd-layout.mjs');
  const wrap = (body) => '```brain-slice-scope/1\n' + body + '\n```\n';
  assert.match(parseSliceScopes(wrap("{ slice: 1 }")).refusal, /JSON/);
  assert.match(parseSliceScopes(wrap('{"slice": 1, "claims": "REQ-1", "terminal_pr": "x"}')).refusal, /claims/);
  assert.match(parseSliceScopes(wrap('{"slice": 1, "claims": ["REQ-1"]}')).refusal, /terminal_pr/);
});

test('#810 r2: a declared stage may not take a RESERVED vocabulary name — "verification" refused', () => {
  assert.throws(
    () => resolveStageSet({ sdd: { stages: {
      proposal: {}, spec: {}, design: {}, tasks: {}, verification: { artefact: 'other.md' },
    } } }),
    /reserved/,
    'tier vocabulary outside the declarable four must be refused, not silently forked between flag and message',
  );
});

test('#810 r3: a LIFECYCLE stage may not rename its own artefact — the four\'s files are canon', () => {
  assert.throws(
    () => resolveStageSet({ sdd: { stages: {
      proposal: { artefact: 'kickoff.md' }, spec: {}, design: {}, tasks: {},
    } } }),
    /canon|not declarable/,
    'gate and scaffold read the four through fixed vocabulary; honoring a rename would fork what the gates demand',
  );
  const ok = resolveStageSet({ sdd: { stages: {
    proposal: {}, spec: {}, design: {}, tasks: {}, research: { artefact: 'research.md' },
  } } });
  assert.equal(ok.files.proposal, 'proposal.md', 'a bare lifecycle entry keeps its canonical file');
});

test('#810 r4: two declared stages may not share one artefact file — one file, one demand', () => {
  assert.throws(
    () => resolveStageSet({ sdd: { stages: {
      proposal: {}, spec: {}, design: {}, tasks: {},
      research: { artefact: 'shared.md' }, notes: { artefact: 'shared.md' },
    } } }),
    /shared|duplicate|already declared/i,
    'a shared file lets one write satisfy two separately-declared demands — the gate walk collapses',
  );
});

test('#810 r7: a declared artefact is a BARE .md filename — traversal and separators refused', () => {
  const four = { proposal: {}, spec: {}, design: {}, tasks: {} };
  for (const evil of ['../../../escaped.md', 'a/b.md', '/abs.md', 'a\\b.md', '.hidden.md', 'x.txt', '']) {
    assert.throws(
      () => resolveStageSet({ sdd: { stages: { ...four, evil: { artefact: evil } } } }),
      /bare .*\.md|not a bare/i,
      `"${evil}" must be refused — a config string reaching the filesystem unvalidated is the S5 shell-injection class`,
    );
  }
  const ok = resolveStageSet({ sdd: { stages: { ...four, research: { artefact: 'research-notes.v2.md' } } } });
  assert.equal(ok.files.research, 'research-notes.v2.md', 'a bare dotted-kebab .md name stays legal');
});

test('#810 r7: a declared stage NAME is a plain kebab identifier — hostile keys refused', () => {
  const four = { proposal: {}, spec: {}, design: {}, tasks: {} };
  for (const evil of ['__proto__', 'constructor', 'A Stage', 'stage/x']) {
    assert.throws(
      () => resolveStageSet({ sdd: { stages: { ...four, [evil]: { artefact: 'x.md' } } } }),
      /identifier|name/i,
      `"${evil}" must be refused — #823's hostile-segment discipline applies to stage keys too`,
    );
  }
});

test('#810 r8: a declared artefact may not take an OPERATIONAL name — resume.md refused', () => {
  assert.throws(
    () => resolveStageSet({ sdd: { stages: {
      proposal: {}, spec: {}, design: {}, tasks: {}, notes: { artefact: 'resume.md' },
    } } }),
    /operational|machine-written/i,
    'resume.md is a machine-written convention: feature-resolution reads its EXISTENCE and engram merges it against a schema a scaffolded stub cannot satisfy',
  );
});
