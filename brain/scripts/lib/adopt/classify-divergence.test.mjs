// classify-divergence.test.mjs — Unit + tuning tests for classifyDivergence.
// Run with: npm test   (node --test, no dependencies)
//
// Covers:
//   - identical bytes → 'identical'
//   - catastro fixture Spanish translation → 'translation' (tuning validation)
//   - English-modified text → 'drift'
//   - ambiguous / short text → 'flag-for-review'
//   - languageSignal shape assertions
//   - MIN_HITS constant is pinned and exported

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyDivergence, MIN_HITS } from './classify-divergence.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, '__fixtures__', 'catastro-flat');

// English upstream equivalent of catastro's brain/methodology/intro.md.
// Used alongside the Spanish fixture to validate the translation classifier.
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

// ── Identical bytes ──────────────────────────────────────────────────────────

test('identical consumer and upstream text → divergenceKind: identical', () => {
  const { divergenceKind, languageSignal } = classifyDivergence('same content', 'same content');
  assert.equal(divergenceKind, 'identical');
  assert.equal(languageSignal, null);
});

test('identical empty strings → divergenceKind: identical', () => {
  const { divergenceKind, languageSignal } = classifyDivergence('', '');
  assert.equal(divergenceKind, 'identical');
  assert.equal(languageSignal, null);
});

// ── Translation (catastro fixture — tuning validation) ───────────────────────

test('catastro fixture intro.md (Spanish translation) → divergenceKind: translation', () => {
  const esText = readFileSync(
    join(FIXTURE_ROOT, 'brain', 'methodology', 'intro.md'),
    'utf8',
  );

  const { divergenceKind, languageSignal, reason } = classifyDivergence(esText, UPSTREAM_EN);

  assert.equal(divergenceKind, 'translation',
    `expected translation but got ${divergenceKind}; reason: ${reason}`);
  assert.ok(languageSignal !== null, 'languageSignal must not be null for translation');
  assert.equal(languageSignal.verdict, 'es');
  assert.ok(languageSignal.es >= MIN_HITS,
    `ES score (${languageSignal.es}) must be >= MIN_HITS (${MIN_HITS})`);
  assert.ok(languageSignal.es > languageSignal.en,
    `ES score (${languageSignal.es}) must exceed EN score (${languageSignal.en})`);
});

test('inline Spanish text with ≥MIN_HITS markers → divergenceKind: translation', () => {
  // Minimal inline Spanish text with enough ES markers to exceed MIN_HITS.
  const esText = '¿Cómo están los equipos? Para cada proyecto, la gestión del conocimiento es fundamental.';
  const { divergenceKind, languageSignal } = classifyDivergence(esText, 'different upstream text');
  assert.equal(divergenceKind, 'translation');
  assert.equal(languageSignal.verdict, 'es');
  assert.ok(languageSignal.es >= MIN_HITS);
});

test('ES-dominant consumer with more headings than upstream → divergenceKind: flag-for-review', () => {
  // Spec condition 4: ES-dominant text that has consumer-ADDED sections (more headings
  // than upstream) must NOT be classified as 'translation' — doing so would allow
  // adopt-upstream to silently overwrite custom content.
  const esConsumerWithExtraSections = `\
# Metodología Brain — Introducción

## ¿Qué es la Metodología Brain?

La metodología Brain proporciona una organización estructurada para la gestión del
conocimiento en equipos de desarrollo. Está diseñada para facilitar la adopción
de convenciones compartidas sin imponer restricciones innecesarias.

## ¿Cómo Funciona?

Brain utiliza una lista de rutas gestionadas para determinar qué archivos son
responsabilidad del paquete. Durante la actualización, solo se actualizan los
archivos declarados como gestionados.

## Sección del Equipo Catastro

Este contenido fue agregado por el equipo de Catastro y no existe en el upstream.
Documentación específica del proyecto municipal.

## Otra Sección Personalizada

Contenido adicional propietario del equipo, también ausente en el upstream original.
`;
  const upstreamEN = `\
# Brain Methodology — Introduction

## What is Brain Methodology?

Brain provides a structured system for managing knowledge.

## How It Works

Brain uses a list to determine which files are managed.
`;
  // consumer: 5 headings, upstream: 3 headings → structural divergence → flag-for-review.
  const { divergenceKind, languageSignal, reason } = classifyDivergence(esConsumerWithExtraSections, upstreamEN);
  assert.strictEqual(divergenceKind, 'flag-for-review',
    `expected flag-for-review (structural divergence), got ${divergenceKind}; reason: ${reason}`);
  assert.ok(languageSignal !== null);
  assert.strictEqual(languageSignal.verdict, 'es', 'language signal must still be ES-dominant');
  assert.ok(reason.includes('structure diverges'),
    `reason should mention structural divergence, got: ${reason}`);
});

// ── Drift (English-modified text) ───────────────────────────────────────────

test('English text differing from upstream → divergenceKind: drift', () => {
  const consumerEN = `\
The brain methodology provides a structured approach for managing knowledge.
This system is designed for developers who want to establish shared conventions.
Teams that adopt this framework can rely on consistent documentation practices.
Note: this version has been modified by the Catastro team with additional sections.
`;
  const upstreamEN = `\
The brain methodology provides a structured approach for managing knowledge.
This system is designed for developers who want to establish shared conventions.
`;

  const { divergenceKind, languageSignal } = classifyDivergence(consumerEN, upstreamEN);
  assert.equal(divergenceKind, 'drift');
  assert.ok(languageSignal !== null);
  assert.equal(languageSignal.verdict, 'en');
  assert.ok(languageSignal.en > 0, 'EN score must be positive for EN text');
  assert.ok(languageSignal.es < MIN_HITS, 'ES score must be below MIN_HITS for EN text');
});

test('upstream text used as consumer (EN only, differs) → divergenceKind: drift', () => {
  const { divergenceKind, languageSignal } = classifyDivergence(UPSTREAM_EN, UPSTREAM_EN + '\nextra line');
  assert.equal(divergenceKind, 'drift');
  assert.equal(languageSignal.verdict, 'en');
});

// ── EN structural guard (condition 4 mirrored for EN path) ──────────────────

test('EN-dominant file with more headings than upstream → divergenceKind: flag-for-review', () => {
  // Spec condition 4 applies to both languages: an EN generic file with consumer-added
  // sections (more headings than upstream) must not be silently scheduled for adopt-upstream.
  const enConsumerWithExtraSections = `\
# Brain Methodology — Introduction

## What is Brain Methodology?

The Brain methodology provides structured knowledge management.

## How It Works

Brain uses managed paths to decide which files it owns.

## Catastro-Specific Conventions

This section was added by the Catastro team and does not exist in upstream.
All local overrides for our municipality deployment are documented here.

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
  // consumer: 4 headings, upstream: 3 headings → structural divergence → flag-for-review
  const { divergenceKind, languageSignal, reason } = classifyDivergence(enConsumerWithExtraSections, enUpstream);
  assert.strictEqual(divergenceKind, 'flag-for-review',
    `expected flag-for-review (EN structural guard), got ${divergenceKind}; reason: ${reason}`);
  assert.ok(languageSignal !== null);
  assert.strictEqual(languageSignal.verdict, 'en', 'language signal must still be EN-dominant');
  assert.ok(reason.includes('consumer-added headings'),
    `reason should mention consumer-added headings, got: ${reason}`);
});

test('EN-dominant file with same/fewer headings but differing bytes → divergenceKind: drift', () => {
  // When the EN consumer has NOT added headings (≤ upstream count), it is plain drift —
  // the structural guard does not fire and adopt-upstream is safe.
  const enConsumerDrift = `\
# Brain Methodology — Introduction

## What is Brain Methodology?

The Brain methodology provides structured knowledge management, modified by consumer.

## How It Works

Brain uses managed paths to decide which files it owns.
`;
  const enUpstream = `\
# Brain Methodology — Introduction

## What is Brain Methodology?

The Brain methodology provides structured knowledge management.

## How It Works

Brain uses managed paths to decide which files it owns.
`;
  // consumer: 3 headings, upstream: 3 headings → no structural divergence → drift
  const { divergenceKind, languageSignal } = classifyDivergence(enConsumerDrift, enUpstream);
  assert.strictEqual(divergenceKind, 'drift',
    `expected drift (same heading count, bytes differ), got ${divergenceKind}`);
  assert.ok(languageSignal !== null);
  assert.strictEqual(languageSignal.verdict, 'en');
});

// ── Flag-for-review (ambiguous / short / no markers) ────────────────────────

test('short text with no language markers → divergenceKind: flag-for-review', () => {
  const { divergenceKind, languageSignal } = classifyDivergence('foo bar', 'baz qux');
  assert.equal(divergenceKind, 'flag-for-review');
  assert.ok(languageSignal !== null);
});

test('code-only text (no ES or EN stopwords) → divergenceKind: flag-for-review', () => {
  const codeText = 'export const x = { a: 1, b: 2 };\nexport default x;';
  const { divergenceKind } = classifyDivergence(codeText, '// different');
  assert.equal(divergenceKind, 'flag-for-review');
});

test('mixed-language text (balanced ES/EN, es < MIN_HITS) → drift', () => {
  // A text with just 1 ES marker (below MIN_HITS) and some EN markers.
  // é in café → es=1 < MIN_HITS=3; EN stopwords (the, will, there, and, have) → en=5.
  // es < MIN_HITS + en > 0 → verdict 'en' → divergenceKind: 'drift'. Outcome is deterministic.
  const mixedText = 'The café is open. We will meet there and have coffee.';
  const { divergenceKind, languageSignal } = classifyDivergence(mixedText, 'different');
  assert.strictEqual(divergenceKind, 'drift');
  assert.ok(languageSignal !== null);
  assert.ok(languageSignal.es < MIN_HITS, `ES (${languageSignal.es}) must be < MIN_HITS (${MIN_HITS})`);
});

// ── languageSignal shape ─────────────────────────────────────────────────────

test('languageSignal has required shape { es, en, verdict } for non-identical', () => {
  const { languageSignal } = classifyDivergence('the fox and the hound', 'different');
  assert.ok(languageSignal !== null);
  assert.ok(typeof languageSignal.es === 'number');
  assert.ok(typeof languageSignal.en === 'number');
  assert.ok(['es', 'en', 'mixed'].includes(languageSignal.verdict),
    `verdict must be 'es'|'en'|'mixed', got ${languageSignal.verdict}`);
});

test('reason field is a non-empty string', () => {
  const { reason } = classifyDivergence('hello world', 'different');
  assert.ok(typeof reason === 'string' && reason.length > 0);
});

// ── Edge cases ──────────────────────────────────────────────────────────────

test('empty consumer vs non-empty upstream → divergenceKind: flag-for-review', () => {
  // Empty content yields no language markers (es=0, en=0) → mixed verdict → flag-for-review.
  // Conservative: an empty consumer file against a non-empty upstream is always flagged.
  const { divergenceKind } = classifyDivergence('', 'non-empty upstream');
  assert.strictEqual(divergenceKind, 'flag-for-review');
});

// ── MIN_HITS is exported and equals the tuned constant ───────────────────────

test('MIN_HITS export equals tuned value 3', () => {
  assert.equal(MIN_HITS, 3,
    'MIN_HITS must equal 3 — the value tuned against catastro-flat/brain/methodology/intro.md');
});
