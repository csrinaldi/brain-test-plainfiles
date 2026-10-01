// build-plan.test.mjs — Integration tests for buildPlan.
// Run with: npm test   (node --test, no dependencies)
//
// Uses injected readers over __fixtures__/catastro-flat/ so the test is
// deterministic and does not scan the live filesystem.
//
// Covers:
//   - Main catastro-flat integration: summary counts + per-file actions
//   - No-brain scenario: all project files, proposedAction place-under-project
//   - Project-file-not-in-manifest scenario: divergenceKind absent-upstream
//   - Envelope fields: schemaVersion, tool, generatedAt, target, manifestSource
//   - Upstream-missing: generic file with no upstream source → flag-review

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlan } from './build-plan.mjs';
import { managed, local } from '../../../core/managed-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, '__fixtures__', 'catastro-flat');

// English upstream equivalent of catastro's brain/methodology/intro.md.
// Heading count: 6 (same as the Spanish fixture) — structural mirror confirmed.
const UPSTREAM_EN = `\
# Brain Methodology — Introduction

> **Note:** This document describes the Brain methodology for knowledge management.
> Updates to Brain will replace this file with the latest upstream version.

## What is Brain Methodology?

The Brain methodology provides a structured system for managing knowledge in
software development teams. It is designed to facilitate the adoption of shared
conventions without imposing unnecessary restrictions on the team's workflow.

Each team that adopts Brain works with two distinct layers:

- **Core** (\`brain/core/\`): documents managed by Brain and updated with each
  new package version.
- **Project** (\`brain/project/\`): team-owned documents that Brain never modifies.

## How It Works

Brain uses a list of managed paths (\`managed-paths.mjs\`) to determine which
files are the package's responsibility and which belong to the team. During
\`brain:upgrade\`, only files declared as \`managed\` are updated.

### Conflict Resolution

When a managed file differs between the installed version and the latest Brain
version, the installer notifies the team without silently overwriting anything.
Update decisions remain with the team.

## Additional Conventions

Remember that every project has its unique characteristics. The conventions
described here are a shared guide, not a mandate. If any convention does not fit
your context, document it in \`brain/project/decisions/\` with your reasoning.

## References

- \`brain/core/managed-paths.mjs\`: list of managed paths
- \`brain/project/README.md\`: entry point for project documentation
- ADR-0003: architecture decision on the managed paths system
`;

const GENERATED_AT = '2026-01-01T00:00:00.000Z';
const MANIFEST = { managed, local };

// ── Main catastro-flat integration test ──────────────────────────────────────
//
// Files:
//   brain/methodology/intro.md   → generic (→ brain/core/**), translation, adopt-upstream
//   docs/onboarding/guide.md     → project (no manifest match), absent-upstream, keep-as-project
//   brain/project/custom/notes.md → project (brain/project/** in local[]), absent-upstream, keep-as-project
//
// Expected: summary.generic=1, summary.project=2, summary.translation=1

test('catastro-flat: summary.generic===1, summary.project===2, summary.translation===1', async () => {
  const files = [
    'brain/methodology/intro.md',
    'docs/onboarding/guide.md',
    'brain/project/custom/notes.md',
  ];

  const consumerContent = {
    'brain/methodology/intro.md': readFileSync(
      join(FIXTURE_ROOT, 'brain', 'methodology', 'intro.md'),
      'utf8',
    ),
    'docs/onboarding/guide.md': readFileSync(
      join(FIXTURE_ROOT, 'docs', 'onboarding', 'guide.md'),
      'utf8',
    ),
    'brain/project/custom/notes.md': readFileSync(
      join(FIXTURE_ROOT, 'brain', 'project', 'custom', 'notes.md'),
      'utf8',
    ),
  };

  const upstreamContent = {
    'brain/core/methodology/intro.md': UPSTREAM_EN,
  };

  const plan = await buildPlan({
    files,
    readConsumer: (p) => consumerContent[p],
    readUpstream: (logicalName) => upstreamContent[logicalName] ?? null,
    manifest: MANIFEST,
    generatedAt: GENERATED_AT,
    manifestSource: 'self-host',
  });

  // Envelope fields
  assert.equal(plan.schemaVersion, '1', 'schemaVersion must be "1"');
  assert.equal(plan.tool, 'brain:adopt', 'tool must be "brain:adopt"');
  assert.equal(plan.generatedAt, GENERATED_AT, 'generatedAt must equal injected value');

  // Summary counts
  assert.equal(plan.summary.generic, 1, 'summary.generic must be 1');
  assert.equal(plan.summary.project, 2, 'summary.project must be 2');
  assert.equal(plan.summary.translation, 1, 'summary.translation must be 1');
  assert.equal(plan.summary.total, 3, 'summary.total must be 3');
});

test('catastro-flat: intro.md is adopt-upstream translation with languageFlag:true', async () => {
  const files = [
    'brain/methodology/intro.md',
    'docs/onboarding/guide.md',
    'brain/project/custom/notes.md',
  ];

  const readConsumer = (p) =>
    p === 'brain/methodology/intro.md'
      ? readFileSync(join(FIXTURE_ROOT, 'brain', 'methodology', 'intro.md'), 'utf8')
      : 'project-owned content';

  const readUpstream = (logicalName) =>
    logicalName === 'brain/core/methodology/intro.md' ? UPSTREAM_EN : null;

  const plan = await buildPlan({
    files,
    readConsumer,
    readUpstream,
    manifest: MANIFEST,
    generatedAt: GENERATED_AT,
    manifestSource: 'self-host',
  });

  const intro = plan.files.find(f => f.sourcePath === 'brain/methodology/intro.md');
  assert.ok(intro, 'intro.md must be in plan.files');
  assert.equal(intro.proposedAction, 'adopt-upstream', 'intro.md proposedAction must be adopt-upstream');
  assert.equal(intro.divergenceKind, 'translation', 'intro.md divergenceKind must be translation');
  assert.equal(intro.languageFlag, true, 'intro.md languageFlag must be true');
  assert.equal(intro.classification, 'generic', 'intro.md classification must be generic');
  assert.ok(intro.languageSignal !== null, 'intro.md languageSignal must not be null');
  assert.equal(intro.languageSignal.verdict, 'es', 'intro.md languageSignal.verdict must be es');
});

test('catastro-flat: guide.md is project keep-as-project (flat-brain)', async () => {
  const files = [
    'brain/methodology/intro.md',
    'docs/onboarding/guide.md',
    'brain/project/custom/notes.md',
  ];

  const readConsumer = (p) =>
    p === 'brain/methodology/intro.md'
      ? readFileSync(join(FIXTURE_ROOT, 'brain', 'methodology', 'intro.md'), 'utf8')
      : readFileSync(join(FIXTURE_ROOT, 'docs', 'onboarding', 'guide.md'), 'utf8');

  const readUpstream = (logicalName) =>
    logicalName === 'brain/core/methodology/intro.md' ? UPSTREAM_EN : null;

  const plan = await buildPlan({
    files,
    readConsumer,
    readUpstream,
    manifest: MANIFEST,
    generatedAt: GENERATED_AT,
    manifestSource: 'self-host',
  });

  const guide = plan.files.find(f => f.sourcePath === 'docs/onboarding/guide.md');
  assert.ok(guide, 'guide.md must be in plan.files');
  assert.equal(guide.proposedAction, 'keep-as-project', 'guide.md proposedAction must be keep-as-project (flat-brain)');
  assert.equal(guide.classification, 'project', 'guide.md classification must be project');
  assert.equal(guide.divergenceKind, 'absent-upstream', 'guide.md divergenceKind must be absent-upstream');
  assert.equal(guide.matchedGlob, null, 'guide.md matchedGlob must be null');
});

// ── No-brain scenario ────────────────────────────────────────────────────────
//
// All files are project (no generic match) → target.shape: 'no-brain',
// all project files get proposedAction: 'place-under-project'.

test('no-brain scenario: target.shape no-brain, all project, proposedAction place-under-project', async () => {
  const files = ['docs/README.md', 'docs/onboarding/guide.md'];

  const plan = await buildPlan({
    files,
    readConsumer: () => 'consumer content',
    readUpstream: () => null,
    manifest: MANIFEST,
    generatedAt: GENERATED_AT,
    manifestSource: 'node_modules/brain',
  });

  assert.equal(plan.target.shape, 'no-brain', 'target.shape must be no-brain when no generic files');
  assert.ok(
    plan.files.every(f => f.proposedAction !== 'adopt-upstream'),
    'no file must have proposedAction adopt-upstream in no-brain repo',
  );
  assert.ok(
    plan.files.every(f => f.classification === 'project'),
    'all files must be classified project',
  );
  assert.ok(
    plan.files.every(f => f.proposedAction === 'place-under-project'),
    'all project files in no-brain repo must get place-under-project',
  );
});

// ── Project-file-not-in-manifest scenario ────────────────────────────────────
//
// A consumer file with no match in managed[]: divergenceKind 'absent-upstream'.
// In a flat-brain repo (has a generic file), project files get 'keep-as-project'.

test('project-file-not-in-manifest: divergenceKind absent-upstream, keep-as-project (flat-brain)', async () => {
  // brain/core/intro.md is in managed[], so it's generic → flat-brain shape.
  // custom/team-notes.md has no manifest match → project.
  const identicalContent = 'identical upstream content';
  const files = ['brain/core/intro.md', 'custom/team-notes.md'];

  const plan = await buildPlan({
    files,
    readConsumer: () => identicalContent,
    readUpstream: (logicalName) =>
      logicalName === 'brain/core/intro.md' ? identicalContent : null,
    manifest: MANIFEST,
    generatedAt: GENERATED_AT,
    manifestSource: 'self-host',
  });

  const teamNotes = plan.files.find(f => f.sourcePath === 'custom/team-notes.md');
  assert.ok(teamNotes, 'custom/team-notes.md must be in plan.files');
  assert.equal(teamNotes.classification, 'project', 'classification must be project');
  assert.equal(teamNotes.divergenceKind, 'absent-upstream', 'divergenceKind must be absent-upstream');
  assert.equal(teamNotes.proposedAction, 'keep-as-project', 'keep-as-project in flat-brain repo');
  assert.equal(teamNotes.matchedGlob, null, 'matchedGlob must be null for project files');
  assert.equal(teamNotes.languageFlag, false, 'languageFlag must be false for project files');
  assert.equal(teamNotes.languageSignal, null, 'languageSignal must be null for project files');
});

// ── Upstream-missing scenario ─────────────────────────────────────────────────
//
// A generic file whose upstream source is absent → divergenceKind: 'upstream-missing',
// proposedAction: 'flag-review'.

test('upstream-missing: generic file with no upstream source → flag-review', async () => {
  const files = ['brain/methodology/intro.md'];

  const plan = await buildPlan({
    files,
    readConsumer: () => 'some content',
    readUpstream: () => null, // no upstream
    manifest: MANIFEST,
    generatedAt: GENERATED_AT,
    manifestSource: 'node_modules/brain',
  });

  const intro = plan.files[0];
  assert.equal(intro.classification, 'generic');
  assert.equal(intro.divergenceKind, 'upstream-missing');
  assert.equal(intro.proposedAction, 'flag-review');
  assert.equal(intro.languageFlag, false);
  assert.equal(intro.languageSignal, null);
  assert.equal(plan.summary.upstreamMissing, 1, 'summary.upstreamMissing must be 1');
});

// ── Envelope contract ─────────────────────────────────────────────────────────

test('plan envelope has all required fields per spec JSON Plan Schema', async () => {
  const plan = await buildPlan({
    files: ['docs/README.md'],
    readConsumer: () => 'content',
    readUpstream: () => null,
    manifest: MANIFEST,
    generatedAt: GENERATED_AT,
    manifestSource: 'node_modules/brain',
  });

  assert.equal(typeof plan.schemaVersion, 'string', 'schemaVersion must be string');
  assert.equal(plan.schemaVersion, '1');
  assert.equal(plan.tool, 'brain:adopt');
  assert.equal(plan.generatedAt, GENERATED_AT);
  assert.ok(plan.target && typeof plan.target.shape === 'string', 'target.shape must exist');
  assert.ok(typeof plan.target.root === 'string', 'target.root must exist');
  assert.ok(typeof plan.manifestSource === 'string', 'manifestSource must exist');
  assert.ok(plan.summary && typeof plan.summary.total === 'number', 'summary.total must exist');
  assert.ok(Array.isArray(plan.files), 'files must be an array');
});

test('per-file record has all required spec fields', async () => {
  const plan = await buildPlan({
    files: ['brain/methodology/intro.md'],
    readConsumer: () => readFileSync(join(FIXTURE_ROOT, 'brain', 'methodology', 'intro.md'), 'utf8'),
    readUpstream: () => UPSTREAM_EN,
    manifest: MANIFEST,
    generatedAt: GENERATED_AT,
    manifestSource: 'self-host',
  });

  const record = plan.files[0];
  // All spec-required per-file fields must be present.
  assert.ok('sourcePath' in record, 'sourcePath required');
  assert.ok('logicalName' in record, 'logicalName required');
  assert.ok('classification' in record, 'classification required');
  assert.ok('matchedGlob' in record, 'matchedGlob required');
  assert.ok('divergenceKind' in record, 'divergenceKind required');
  assert.ok('languageSignal' in record, 'languageSignal required');
  assert.ok('languageFlag' in record, 'languageFlag required');
  assert.ok('proposedAction' in record, 'proposedAction required');
  assert.ok('reason' in record, 'reason required');
  // Types
  assert.equal(typeof record.sourcePath, 'string');
  assert.equal(typeof record.logicalName, 'string');
  assert.ok(['generic', 'project'].includes(record.classification), 'classification must be generic|project');
  assert.equal(typeof record.languageFlag, 'boolean', 'languageFlag must be boolean');
  assert.equal(typeof record.reason, 'string', 'reason must be string');
});

// ── EN-drift structural guard integration ─────────────────────────────────────
//
// A generic EN file where the consumer added sections (more headings than upstream)
// must NOT be scheduled for adopt-upstream. The classifier returns 'flag-for-review',
// which build-plan maps to divergenceKind:'drift' + proposedAction:'flag-review'.
// The consumer's content is therefore NOT overwritten (no adopt-upstream in the plan).

test('EN generic file with consumer-added sections → proposedAction:flag-review, NOT adopt-upstream', async () => {
  const enConsumerWithExtraSections = `\
# Brain Methodology — Introduction

## What is Brain Methodology?

The Brain methodology provides structured knowledge management.

## How It Works

Brain uses managed paths to decide which files it owns.

## Catastro-Specific Conventions

This section was added by the Catastro team. Upstream does not have this.

## Additional Team Notes

More consumer-added content absent from the upstream brain package.
`;
  const enUpstream = `\
# Brain Methodology — Introduction

## What is Brain Methodology?

The Brain methodology provides structured knowledge management.

## How It Works

Brain uses managed paths to decide which files it owns.
`;

  const plan = await buildPlan({
    files: ['brain/methodology/intro.md'],
    readConsumer: () => enConsumerWithExtraSections,
    readUpstream: () => enUpstream,
    manifest: MANIFEST,
    generatedAt: GENERATED_AT,
    manifestSource: 'self-host',
  });

  const record = plan.files[0];
  assert.equal(record.classification, 'generic', 'must be classified generic');
  // classifier 'flag-for-review' maps to plan divergenceKind:'drift' + proposedAction:'flag-review'
  assert.equal(record.divergenceKind, 'drift',
    `plan divergenceKind must be 'drift' (internal flag-for-review maps here), got ${record.divergenceKind}`);
  assert.equal(record.proposedAction, 'flag-review',
    `proposedAction must be 'flag-review', NOT 'adopt-upstream'; consumer content must not be overwritten`);
  assert.equal(record.languageFlag, false, 'languageFlag must be false (not a translation)');
  // Guard: consumer content is NOT scheduled for overwrite
  assert.notEqual(record.proposedAction, 'adopt-upstream',
    'adopt-upstream must NOT appear — consumer-added sections would be silently overwritten');
});

// ── generatedAt is injected (purity check) ───────────────────────────────────

test('generatedAt in plan matches injected value exactly (Date not called internally)', async () => {
  const FIXED_TIME = '2025-06-15T12:34:56.789Z';
  const plan = await buildPlan({
    files: ['docs/README.md'],
    readConsumer: () => 'content',
    readUpstream: () => null,
    manifest: MANIFEST,
    generatedAt: FIXED_TIME,
    manifestSource: 'node_modules/brain',
  });
  assert.equal(plan.generatedAt, FIXED_TIME, 'generatedAt must equal the injected timestamp');
});
