// render-report.test.mjs — Unit tests for renderReport.
// Run with: npm test   (node --test, no dependencies)
//
// Covers:
//   - All four required sections present (Summary, Replacements, Flagged, Project Files)
//   - Generic Files section present
//   - Translation file (intro.md) appears in Replacements section
//   - Flagged-for-review section is non-empty when drift/ambiguous files are present
//   - Project section contains guide.md path
//   - Empty-plan edge cases (sections render without crashing)
//   - no-brain plan: generic files section says "no-brain repo"

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderReport } from './render-report.mjs';

// ── Test plan — represents a catastro-flat-style repo with:
//   • intro.md        : generic, translation → languageFlag:true, adopt-upstream
//   • setup.sh        : generic, drift+flag-for-review → proposedAction:flag-review
//   • conventions.md  : generic, drift → proposedAction:adopt-upstream (auto-overwrite callout)
//   • guide.md        : project, absent-upstream → keep-as-project (flat-brain shape)

const TRANSLATION_PATH = 'brain/methodology/intro.md';
const FLAGGED_PATH = 'scripts/setup.sh';
const DRIFT_ADOPT_PATH = 'brain/core/conventions.md';
const PROJECT_PATH = 'docs/onboarding/guide.md';

const TEST_PLAN = {
  schemaVersion: '1',
  tool: 'brain:adopt',
  generatedAt: '2026-01-01T00:00:00.000Z',
  target: { shape: 'flat-brain', root: '.' },
  manifestSource: 'self-host',
  summary: {
    total: 4,
    generic: 3,
    project: 1,
    identical: 0,
    translation: 1,
    drift: 1,
    flagForReview: 1,
    upstreamMissing: 0,
  },
  files: [
    {
      sourcePath: TRANSLATION_PATH,
      logicalName: 'brain/core/methodology/intro.md',
      classification: 'generic',
      matchedGlob: 'brain/core/**',
      divergenceKind: 'translation',
      languageSignal: { es: 39, en: 0, verdict: 'es' },
      languageFlag: true,
      proposedAction: 'adopt-upstream',
      reason: 'consumer text is ES-dominant; upstream is EN by policy (ADR-0009); heading structure mirrors upstream',
    },
    {
      sourcePath: FLAGGED_PATH,
      logicalName: 'brain/scripts/setup.sh',
      classification: 'generic',
      matchedGlob: 'brain/scripts/**',
      divergenceKind: 'drift',
      languageSignal: { es: 0, en: 0, verdict: 'mixed' },
      languageFlag: false,
      proposedAction: 'flag-review',
      reason: 'ambiguous language signal (es=0, en=0); flagged for human review',
    },
    {
      sourcePath: DRIFT_ADOPT_PATH,
      logicalName: 'brain/core/conventions.md',
      classification: 'generic',
      matchedGlob: 'brain/core/**',
      divergenceKind: 'drift',
      languageSignal: { es: 0, en: 5, verdict: 'en' },
      languageFlag: false,
      proposedAction: 'adopt-upstream',
      reason: 'consumer text is EN with differing bytes (en=5, es=0); classified as drift',
    },
    {
      sourcePath: PROJECT_PATH,
      logicalName: 'docs/onboarding/guide.md',
      classification: 'project',
      matchedGlob: null,
      divergenceKind: 'absent-upstream',
      languageSignal: null,
      languageFlag: false,
      proposedAction: 'keep-as-project',
      reason: 'no manifest match; consumer-owned file',
    },
  ],
};

// ── Section presence ─────────────────────────────────────────────────────────

test('renderReport includes a Summary section', () => {
  const md = renderReport(TEST_PLAN);
  assert.ok(md.includes('## Summary'), 'must contain "## Summary" section');
});

test('renderReport includes a Generic Files section', () => {
  const md = renderReport(TEST_PLAN);
  assert.ok(md.includes('## Generic Files'), 'must contain "## Generic Files" section');
});

test('renderReport includes a Replacements section', () => {
  const md = renderReport(TEST_PLAN);
  assert.ok(
    md.includes('## Replacements (translations to be adopted from upstream)'),
    'must contain Replacements section header',
  );
});

test('renderReport includes a Flagged for Review section', () => {
  const md = renderReport(TEST_PLAN);
  assert.ok(md.includes('## Flagged for Review'), 'must contain "## Flagged for Review" section');
});

test('renderReport includes a Project Files section', () => {
  const md = renderReport(TEST_PLAN);
  assert.ok(md.includes('## Project Files'), 'must contain "## Project Files" section');
});

// ── Translations in Replacements (ADR-0009: never silent) ────────────────────

test('translation file (intro.md) appears in Replacements section', () => {
  const md = renderReport(TEST_PLAN);
  const replacementsStart = md.indexOf('## Replacements');
  const nextSection = md.indexOf('## Flagged for Review');
  assert.ok(replacementsStart !== -1, 'Replacements section must be present');
  assert.ok(nextSection > replacementsStart, 'Flagged section must come after Replacements');
  const replacementsBlock = md.slice(replacementsStart, nextSection);
  assert.ok(
    replacementsBlock.includes(TRANSLATION_PATH),
    `Replacements block must contain '${TRANSLATION_PATH}'`,
  );
});

test('Replacements section lists language signal for translation', () => {
  const md = renderReport(TEST_PLAN);
  const replacementsStart = md.indexOf('## Replacements');
  const flaggedStart = md.indexOf('## Flagged for Review');
  const block = md.slice(replacementsStart, flaggedStart);
  // language signal: es=39, en=0, verdict=es
  assert.ok(block.includes('es=39'), 'Replacements must show ES score');
});

// ── Flagged section non-empty when flag-review files present ─────────────────

test('Flagged for Review section is non-empty when drift/ambiguous files are present', () => {
  const md = renderReport(TEST_PLAN);
  const flaggedStart = md.indexOf('## Flagged for Review');
  const projectStart = md.indexOf('## Project Files');
  assert.ok(flaggedStart !== -1);
  assert.ok(projectStart > flaggedStart);
  const flaggedBlock = md.slice(flaggedStart, projectStart);
  assert.ok(
    flaggedBlock.includes(FLAGGED_PATH),
    `Flagged block must contain '${FLAGGED_PATH}'`,
  );
  // Must NOT say "No files flagged"
  assert.ok(
    !flaggedBlock.includes('No files flagged for review'),
    'Flagged section must not say "none" when files are present',
  );
});

// ── Project section contains guide.md path ───────────────────────────────────

test('Project Files section contains guide.md path', () => {
  const md = renderReport(TEST_PLAN);
  const projectStart = md.indexOf('## Project Files');
  assert.ok(projectStart !== -1, 'Project Files section must be present');
  const projectBlock = md.slice(projectStart);
  assert.ok(
    projectBlock.includes(PROJECT_PATH),
    `Project Files section must contain '${PROJECT_PATH}'`,
  );
});

test('Project Files section shows keep-as-project action for flat-brain', () => {
  const md = renderReport(TEST_PLAN);
  const projectStart = md.indexOf('## Project Files');
  const projectBlock = md.slice(projectStart);
  assert.ok(projectBlock.includes('keep-as-project'), 'flat-brain project action must be keep-as-project');
});

// ── Summary table counts ─────────────────────────────────────────────────────

test('Summary section contains correct total count', () => {
  const md = renderReport(TEST_PLAN);
  const summaryStart = md.indexOf('## Summary');
  const genericStart = md.indexOf('## Generic Files');
  const summaryBlock = md.slice(summaryStart, genericStart);
  assert.ok(summaryBlock.includes('| Total files | 4 |'), 'Summary must show Total files: 4');
  assert.ok(summaryBlock.includes('| Translations | 1 |'), 'Summary must show Translations: 1');
});

// ── No-brain plan (all project, no generic) ──────────────────────────────────

const NO_BRAIN_PLAN = {
  schemaVersion: '1',
  tool: 'brain:adopt',
  generatedAt: '2026-01-01T00:00:00.000Z',
  target: { shape: 'no-brain', root: '.' },
  manifestSource: 'node_modules/brain',
  summary: {
    total: 2,
    generic: 0,
    project: 2,
    identical: 0,
    translation: 0,
    drift: 0,
    flagForReview: 0,
    upstreamMissing: 0,
  },
  files: [
    {
      sourcePath: 'docs/README.md',
      logicalName: 'docs/README.md',
      classification: 'project',
      matchedGlob: null,
      divergenceKind: 'absent-upstream',
      languageSignal: null,
      languageFlag: false,
      proposedAction: 'place-under-project',
      reason: 'no manifest match; consumer-owned file',
    },
    {
      sourcePath: 'docs/guide.md',
      logicalName: 'docs/guide.md',
      classification: 'project',
      matchedGlob: null,
      divergenceKind: 'absent-upstream',
      languageSignal: null,
      languageFlag: false,
      proposedAction: 'place-under-project',
      reason: 'no manifest match; consumer-owned file',
    },
  ],
};

test('no-brain plan: Generic Files section says "no-brain repo"', () => {
  const md = renderReport(NO_BRAIN_PLAN);
  assert.ok(md.includes('no-brain repo'), 'must mention "no-brain repo" in Generic Files section');
});

test('no-brain plan: Replacements section says "No translated files detected"', () => {
  const md = renderReport(NO_BRAIN_PLAN);
  assert.ok(md.includes('No translated files detected'));
});

test('no-brain plan: Project Files shows place-under-project action', () => {
  const md = renderReport(NO_BRAIN_PLAN);
  const projectStart = md.indexOf('## Project Files');
  const projectBlock = md.slice(projectStart);
  assert.ok(projectBlock.includes('place-under-project'));
});

// ── Auto-adopted from upstream callout ───────────────────────────────────────
//
// drift files with proposedAction:'adopt-upstream' must appear in the
// "Auto-adopted from upstream" callout section so humans cannot miss that
// their local copy will be overwritten.

test('drift+adopt-upstream file appears in "Auto-adopted from upstream" section', () => {
  const md = renderReport(TEST_PLAN);
  assert.ok(
    md.includes('## Auto-adopted from upstream (local copy will be overwritten)'),
    'must contain the auto-adopted callout section header',
  );
  // The drift+adopt-upstream file must appear under the callout section,
  // not only in the generic table.
  const calloutStart = md.indexOf('## Auto-adopted from upstream');
  const replacementsStart = md.indexOf('## Replacements');
  assert.ok(calloutStart !== -1, 'callout section must be present');
  assert.ok(replacementsStart > calloutStart, 'Replacements section must come after callout');
  const calloutBlock = md.slice(calloutStart, replacementsStart);
  assert.ok(
    calloutBlock.includes(DRIFT_ADOPT_PATH),
    `callout block must contain '${DRIFT_ADOPT_PATH}'`,
  );
});

test('translation file does NOT appear in auto-adopted callout (listed in Replacements)', () => {
  const md = renderReport(TEST_PLAN);
  const calloutStart = md.indexOf('## Auto-adopted from upstream');
  const replacementsStart = md.indexOf('## Replacements');
  const calloutBlock = md.slice(calloutStart, replacementsStart);
  assert.ok(
    !calloutBlock.includes(TRANSLATION_PATH),
    `translation file '${TRANSLATION_PATH}' must NOT appear in the auto-adopted callout (it belongs in Replacements)`,
  );
});

test('flag-review file does NOT appear in auto-adopted callout', () => {
  const md = renderReport(TEST_PLAN);
  const calloutStart = md.indexOf('## Auto-adopted from upstream');
  const replacementsStart = md.indexOf('## Replacements');
  const calloutBlock = md.slice(calloutStart, replacementsStart);
  assert.ok(
    !calloutBlock.includes(FLAGGED_PATH),
    `flag-review file '${FLAGGED_PATH}' must NOT appear in auto-adopted callout`,
  );
});

test('plan with no drift+adopt-upstream files shows empty callout message', () => {
  const noDriftPlan = {
    ...NO_BRAIN_PLAN,
    files: [
      {
        sourcePath: 'docs/README.md',
        logicalName: 'docs/README.md',
        classification: 'project',
        matchedGlob: null,
        divergenceKind: 'absent-upstream',
        languageSignal: null,
        languageFlag: false,
        proposedAction: 'place-under-project',
        reason: 'no manifest match; consumer-owned file',
      },
    ],
  };
  const md = renderReport(noDriftPlan);
  const calloutStart = md.indexOf('## Auto-adopted from upstream');
  assert.ok(calloutStart !== -1, 'callout section must always be present');
  const replacementsStart = md.indexOf('## Replacements');
  const calloutBlock = md.slice(calloutStart, replacementsStart);
  assert.ok(
    calloutBlock.includes('No drift files scheduled'),
    'empty callout must show placeholder message',
  );
});

// ── Empty-files plan (edge case: no files at all) ────────────────────────────

test('empty plan renders without crashing and contains all section headers', () => {
  const emptyPlan = {
    schemaVersion: '1',
    tool: 'brain:adopt',
    generatedAt: '2026-01-01T00:00:00.000Z',
    target: { shape: 'no-brain', root: '.' },
    manifestSource: 'node_modules/brain',
    summary: { total: 0, generic: 0, project: 0, identical: 0, translation: 0, drift: 0, flagForReview: 0, upstreamMissing: 0 },
    files: [],
  };
  const md = renderReport(emptyPlan);
  assert.ok(typeof md === 'string' && md.length > 0);
  assert.ok(md.includes('## Summary'));
  assert.ok(md.includes('## Generic Files'));
  assert.ok(md.includes('## Auto-adopted from upstream'));
  assert.ok(md.includes('## Replacements'));
  assert.ok(md.includes('## Flagged for Review'));
  assert.ok(md.includes('## Project Files'));
});
