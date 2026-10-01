// chunk-boundary.test.mjs — the chunk read-back becomes an ENFORCED boundary
// (#247, epic #864 task 2.3; spec.md D4 guards 1-4; design.md A1-A5, testing
// strategy rows 1-4). Per #863 D3 (ratified 2026-09-08): this is the
// READ-BACK boundary only — `share` still calls `engram sync --export`
// (`engram.mjs:1108` `save()` is `unsupportedOp`, so the export is engram's
// only producer path into `records/` until task 3.2, #874). Nothing that
// runs is changed by this file; it only asserts what already imports what.
//
// RED-first (design A4, the one real trap): `lane-scrub.test.mjs:88-94`'s
// `source.split('\n')` + `/^\s*import\b/` idiom cannot see `cli.mjs:620-622`,
// a 3-line `const { … } = await import(\n  "./lib/migrate-v1.mjs"\n);`. This
// guard matches over the WHOLE source with one regex covering both the
// static and the dynamic spelling, so it sees the edge the line-filtered
// idiom misses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTmp } from '../lib/test-tmp.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// The roots this guard walks — design A2: tests are INCLUDED, one flat
// allowlist, not a production-only sample. Excluding `**/*.test.mjs` would
// make `migrate-v1.test.mjs:13` (a real importer) invisible. Widened to
// `brain/**` (not `brain/scripts/**`): three tracked production modules live
// outside `brain/scripts/**` (`brain/core/config-migrations.mjs`,
// `brain/core/managed-paths.mjs`, `brain/project/check-refs-rules.mjs`) and a
// planted importer there previously passed unseen — measured live, none of
// the three imports a chunk symbol today, so the found set is unchanged.
const WALK_GLOBS = ['brain/**/*.mjs', 'test/**/*.mjs'];

// Matches BOTH `import { x, y } from '...'` / `export { x, y } from '...'`
// and the dynamic `const { x, y } = await import('...')` (which may span
// multiple lines) — one regex, over the whole source, not `split('\n')` + a
// leading-`import` filter (design A4). `export { x } from '...'` is a
// re-export edge with the same import-graph meaning as `import { x } from`.
const CHUNK_IMPORT_RE =
  /(?:(?:import|export)\s*\{([^}]*)\}\s*from\s*|(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\s*\(\s*)['"]([^'"]+)['"]/g;

// A binding CHUNK_IMPORT_RE cannot parse: a namespace import (`import * as
// <name> from` a migrate-v1.mjs specifier) or a non-destructured dynamic
// import (`const <name> = await import(...)` from the same specifier),
// followed elsewhere by a `<name>.collectChunkObservations` member access.
// Syntax-anchored on purpose (binding name + member access), not a
// free-text substring scan — a bare "does the file contain both strings"
// scan would self-match this guard's own fixture-building source below.
// NOT covered: a computed member access (square-bracket form) or a
// specifier built from a runtime expression.
const NAMESPACE_BINDING_RE =
  /(?:import\s*\*\s*as\s+(\w+)\s*from\s*|(?:const|let|var)\s+(\w+)\s*=\s*await\s+import\s*\(\s*)['"]([^'"]*migrate-v1\.mjs)['"]/g;

/**
 * Walks `roots` (globs, relative to `cwd`) and extracts every import edge
 * matching CHUNK_IMPORT_RE. Returns the scanned file list (for the "did the
 * scan actually read anything" self-check) plus every edge found.
 */
function scanImportEdges(cwd, globs) {
  const files = globSync(globs, { cwd }).map((f) => f.split(sep).join('/'));
  const edges = [];
  for (const relFile of files) {
    const src = readFileSync(join(cwd, relFile), 'utf8');
    const re = new RegExp(CHUNK_IMPORT_RE.source, CHUNK_IMPORT_RE.flags);
    let m;
    while ((m = re.exec(src))) {
      const names = (m[1] ?? m[2] ?? '')
        .split(',')
        // `{ x as y }` counts as importing `x` — the alias is a local
        // rename, not a different symbol; keep the pre-`as` name only.
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      const specifier = m[3];
      const line = src.slice(0, m.index).split('\n').length;
      edges.push({ file: relFile, line, names, specifier });
    }
  }
  return { files, edges };
}

/** Namespace/member-access importers NAMESPACE_BINDING_RE's binding half
 * finds: a namespace import or a non-destructured dynamic import bound to a
 * migrate-v1.mjs specifier, paired with a `<name>.collectChunkObservations`
 * member access elsewhere in the same file. Both halves must be present. */
function namespaceImporters(cwd, globs) {
  const files = globSync(globs, { cwd }).map((f) => f.split(sep).join('/'));
  const found = [];
  for (const relFile of files) {
    const src = readFileSync(join(cwd, relFile), 'utf8');
    const re = new RegExp(NAMESPACE_BINDING_RE.source, NAMESPACE_BINDING_RE.flags);
    let m;
    while ((m = re.exec(src))) {
      const name = m[1] ?? m[2];
      const memberRe = new RegExp(`\\b${name}\\.collectChunkObservations\\b`);
      if (memberRe.test(src)) {
        const line = src.slice(0, m.index).split('\n').length;
        found.push({ file: relFile, line });
      }
    }
  }
  return found;
}

/** Every import edge whose specifier resolves to `migrate-v1.mjs` and whose
 * named imports include `collectChunkObservations` — the surface D4 guard 2
 * constrains to an annotated allowlist. Two detection layers, merged by
 * file (name-based edge wins the reported line when both fire): (a)
 * CHUNK_IMPORT_RE's named-import/re-export edges (aliases stripped); (b)
 * namespaceImporters' binding + member-access scan for the forms (a) cannot
 * parse. Covered: named import, re-export, aliased import, destructured
 * dynamic import, namespace import + member access, non-destructured
 * dynamic import + member access. NOT covered: computed member access or a
 * specifier assembled from a runtime expression. */
function chunkImporters(cwd) {
  const { files, edges } = scanImportEdges(cwd, WALK_GLOBS);
  const named = edges
    .filter((e) => e.specifier.endsWith('migrate-v1.mjs') && e.names.includes('collectChunkObservations'))
    .map((e) => ({ file: e.file, line: e.line }));
  const namespaced = namespaceImporters(cwd, WALK_GLOBS);
  const byFile = new Map();
  for (const entry of [...named, ...namespaced]) {
    if (!byFile.has(entry.file)) byFile.set(entry.file, entry);
  }
  const found = [...byFile.values()].sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  return { files, found };
}

/** `readChunkObservations` must have zero importers AND no definition
 * anywhere (D4 guard 1, A5). Three definition shapes, because a redefinition
 * can dodge a single pattern: `export (async )?function|const|let|var
 * readChunkObservations`; a bare (non-exported) `function
 * readChunkObservations`; or a plain `function readChunkObservations` paired
 * with a separate `export { readChunkObservations }` list. Comments are
 * deliberately NOT scanned (A5) — see the D4 guard 1 test below. */
function definesReadChunkObservations(cwd, globs) {
  const files = globSync(globs, { cwd }).map((f) => f.split(sep).join('/'));
  const EXPORTED_DEFINITION_RE = /^\s*export\s+(?:async\s+)?(?:function|const|let|var)\s+readChunkObservations\b/m;
  const BARE_FUNCTION_RE = /^\s*(?:async\s+)?function\s+readChunkObservations\b/m;
  // Anchored to line start, like the two patterns above — an unanchored
  // scan would also match prose that merely quotes the phrase (this very
  // function's own doc comment describes the shape it detects).
  const BARE_EXPORT_LIST_RE = /^\s*export\s*\{[^}]*\breadChunkObservations\b/m;
  return files.filter((relFile) => {
    const src = readFileSync(join(cwd, relFile), 'utf8');
    return EXPORTED_DEFINITION_RE.test(src) || BARE_FUNCTION_RE.test(src) || BARE_EXPORT_LIST_RE.test(src);
  });
}

const sortAllowlist = (rows) =>
  [...rows].map(({ file, line }) => ({ file, line })).sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

// Broken up so the raw source text of THIS file never contains the
// contiguous substring `import {`/`export {`/`await import(` outside a
// regex literal — the fixture tests below plant these forms in isolated
// `testTmp` roots, never the real repo, and must not register as a SECOND
// real importer when the guards above scan this file's own tree.
const IMPORT_KW = 'im' + 'port';
const EXPORT_KW = 'ex' + 'port';

// ── D4 guard 2 — `collectChunkObservations`'s importers are an annotated
// allowlist (spec.md, design A2-A4) ─────────────────────────────────────────

// The annotated allowlist itself (design A4's literal) — each row names the
// ticket that retires it. #874 split B, task B2 retires row 2:
// `engram.mjs`'s import of `collectChunkObservations` (and its
// `_defaultReadObservations` caller) is gone — `share()` has no observation
// reader left at all. Only the two rows below remain.
//
// R3 (#955, epic task 2.4) corrects the #874 ledger row 7 note this
// allowlist used to carry: `collectChunkObservations` is KEPT, not
// retired — it reads a consumer's own `chunks/`, not `legacy/`, and forward
// `migrate-v1` still calls it. `retiredBy` below names that ruling, not a
// pending deletion.
const ALLOWLIST = [
  { file: 'brain/scripts/memory/cli.mjs', line: 777, retiredBy: 'kept — R3 (#955)' }, // #1165 moved it to 777 (the resolver block replaced the env read above); #1119 shifted this line again by adding a comment above the ship op's prLookupFailed/prLookupFailedAfterPush key-selection ternary, earlier in the same block
  { file: 'brain/scripts/memory/lib/migrate-v1.test.mjs', line: 13, retiredBy: 'kept — R3 (#955)' },
];

test('collectChunkObservations: the real importer set equals the annotated allowlist, both directions (D4 guard 2, A3)', () => {
  const { found } = chunkImporters(repoRoot);
  assert.deepEqual(sortAllowlist(found), sortAllowlist(ALLOWLIST));
});

test('collectChunkObservations: a stale allowlist row (code stopped importing) fails the check — the reverse direction (A3)', () => {
  // Real `found` set against an allowlist that ADDS a row nothing in the
  // tree imports (an already-retired file) — the reverse of "a new importer
  // appears": an allowlisted entry surviving a retirement must fail, not
  // pass silently. `check-refs.mjs`'s exemptions (`:57-58`, `:80`) are
  // one-directional and cannot catch this; this guard is stricter.
  const { found } = chunkImporters(repoRoot);
  const staleAllowlist = [
    ...ALLOWLIST,
    { file: 'brain/scripts/memory/backends/already-retired.mjs', line: 1, retiredBy: 'never landed' },
  ];
  assert.notDeepEqual(sortAllowlist(found), sortAllowlist(staleAllowlist), 'a stale allowlist row must break equality');
});

test('collectChunkObservations: a fixture importer with no allowlist row fails the check — the forward direction (A3)', () => {
  // An isolated fixture tree (testTmp — #842 hygiene), never the real repo:
  // plant a `.mjs` file importing `collectChunkObservations` from a path
  // ending in `migrate-v1.mjs`, scan ONLY that fixture root, and assert the
  // walker finds it while an empty allowlist does not name it — the "a new
  // importer with no allowlist row fails" direction, proven without ever
  // mutating a tracked file.
  const fixtureRoot = testTmp('chunk-boundary-fixture-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  // Built via concatenation, not a literal `import {...} from '...'`
  // string: this file is itself under `brain/scripts/**`, so a literal
  // match here would register as a SECOND real importer when this guard
  // scans its own tree, corrupting the allowlist equality test above.
  const plantedSource = ['im' + 'port', "{ collectChunkObservations }", 'from', "'./lib/migrate-v1.mjs';\n"].join(' ');
  writeFileSync(join(fixtureDir, 'planted-importer.mjs'), plantedSource, 'utf8');
  const { found } = chunkImporters(fixtureRoot);
  assert.equal(found.length, 1, 'the walker must see the planted fixture importer');
  assert.equal(found[0].file, 'brain/scripts/planted-importer.mjs');
  assert.notDeepEqual(sortAllowlist(found), sortAllowlist([]), 'an unlisted importer must not equal an empty allowlist');
});

test('collectChunkObservations: a re-export (`export { x } from ...`) counts as an importer', () => {
  // Mutant C: a re-export of the symbol has the same import-graph meaning
  // as a plain named import, but the original CHUNK_IMPORT_RE only matched
  // the `import` keyword's clause, not `export`'s.
  const fixtureRoot = testTmp('chunk-boundary-fixture-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource = `${EXPORT_KW} { collectChunkObservations } from './lib/migrate-v1.mjs';\n`;
  writeFileSync(join(fixtureDir, 'planted-reexport.mjs'), plantedSource, 'utf8');
  const { found } = chunkImporters(fixtureRoot);
  assert.equal(found.length, 1, 'a re-export edge must be found');
  assert.equal(found[0].file, 'brain/scripts/planted-reexport.mjs');
});

test('collectChunkObservations: an aliased import (`{ x as y }`) still counts as importing `x`', () => {
  // Mutant E: `import { collectChunkObservations as grabChunks }` — the
  // original names-split kept the whole "collectChunkObservations as
  // grabChunks" string, which never equals the bare symbol name.
  const fixtureRoot = testTmp('chunk-boundary-fixture-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource =
    `${IMPORT_KW} { collectChunkObservations as grabChunks } from './lib/migrate-v1.mjs';\n` + 'grabChunks();\n';
  writeFileSync(join(fixtureDir, 'planted-aliased.mjs'), plantedSource, 'utf8');
  const { found } = chunkImporters(fixtureRoot);
  assert.equal(found.length, 1, 'an aliased import edge must be found');
  assert.equal(found[0].file, 'brain/scripts/planted-aliased.mjs');
});

test('collectChunkObservations: a namespace import + member access is found (`import * as mig` then `mig.collectChunkObservations`)', () => {
  // Mutant F: CHUNK_IMPORT_RE cannot parse `import * as mig from '...'` at
  // all — no `{ }` destructuring, so no edge, no names, nothing to check.
  const fixtureRoot = testTmp('chunk-boundary-fixture-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource = `${IMPORT_KW} * as mig from './lib/migrate-v1.mjs';\n` + 'mig.collectChunkObservations();\n';
  writeFileSync(join(fixtureDir, 'planted-namespace.mjs'), plantedSource, 'utf8');
  const { found } = chunkImporters(fixtureRoot);
  assert.equal(found.length, 1, 'a namespace import + member access must be found');
  assert.equal(found[0].file, 'brain/scripts/planted-namespace.mjs');
});

test('collectChunkObservations: a non-destructured dynamic import + member access is found (`const mod = await import(...)` then `mod.collectChunkObservations`)', () => {
  // Mutant G: same gap as F, via the dynamic-import spelling instead of the
  // static namespace spelling.
  const fixtureRoot = testTmp('chunk-boundary-fixture-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource =
    `const mod = await ${IMPORT_KW}('./lib/migrate-v1.mjs');\n` + 'mod.collectChunkObservations();\n';
  writeFileSync(join(fixtureDir, 'planted-dynamic-namespace.mjs'), plantedSource, 'utf8');
  const { found } = chunkImporters(fixtureRoot);
  assert.equal(found.length, 1, 'a non-destructured dynamic import + member access must be found');
  assert.equal(found[0].file, 'brain/scripts/planted-dynamic-namespace.mjs');
});

test('collectChunkObservations: the scan actually read something — evidence floor (A3, settings-hooks.test.mjs pattern)', () => {
  // A scan that reads nothing proves nothing (axes/platform/lib/settings-hooks.test.mjs:145-150's rule).
  const { files } = chunkImporters(repoRoot);
  assert.ok(files.length > 100, `the scan read ${files.length} files — it is not looking where it thinks`);
  for (const known of [
    'brain/scripts/axes/memory/adapters/engram.mjs',
    'brain/scripts/memory/cli.mjs',
    'brain/scripts/memory/lib/migrate-v1.mjs',
  ]) {
    assert.ok(files.includes(known), `the scan never read ${known}; a scan that reads nothing proves nothing`);
  }
});

test('collectChunkObservations: migrate-v1.mjs still exports the symbol the allowlist is annotated against (A3)', () => {
  const src = readFileSync(join(repoRoot, 'brain/scripts/memory/lib/migrate-v1.mjs'), 'utf8');
  assert.match(
    src,
    /^export function collectChunkObservations\b/m,
    'a deleted migrate-v1.mjs would leave the allowlist check vacuously green',
  );
});

// ── D4 guard 1 — `readChunkObservations` has zero importers (spec.md, design A5) ──

test('readChunkObservations: zero importers across brain/** and test/** (D4 guard 1)', () => {
  const { edges } = scanImportEdges(repoRoot, WALK_GLOBS);
  const importers = edges.filter((e) => e.names.includes('readChunkObservations'));
  assert.deepEqual(importers, [], 'readChunkObservations must have zero importers');
});

test('readChunkObservations: no definition anywhere in brain/** or test/** (D4 guard 1, A5)', () => {
  // Two assertions, deliberately: zero importers alone would pass over a
  // resurrected module nobody imports YET. Comments are NOT scanned —
  // `store.mjs:281`, `store.test.mjs:266,269`, `run-check.test.mjs:32`
  // mention the name as history, and definesReadChunkObservations only
  // matches a real definition (export function/const/let/var, a bare
  // function declaration, or a bare `export { readChunkObservations }`).
  const defined = definesReadChunkObservations(repoRoot, WALK_GLOBS);
  assert.deepEqual(defined, [], 'readChunkObservations must not be redefined anywhere');
});

test('readChunkObservations: `export async function` redefinition is caught', () => {
  // Mutant H1: the original pattern was pinned to `export function`
  // (no `async`), so `export async function readChunkObservations` passed.
  const fixtureRoot = testTmp('chunk-boundary-fixture-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource = `${EXPORT_KW} async function readChunkObservations() { return []; }\n`;
  writeFileSync(join(fixtureDir, 'planted-async-def.mjs'), plantedSource, 'utf8');
  const defined = definesReadChunkObservations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(defined, ['brain/scripts/planted-async-def.mjs']);
});

test('readChunkObservations: `export const` redefinition is caught', () => {
  // Mutant H2: the original pattern only matched `export function`, not an
  // arrow-function assigned to `export const readChunkObservations`.
  const fixtureRoot = testTmp('chunk-boundary-fixture-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource = `${EXPORT_KW} const readChunkObservations = () => [];\n`;
  writeFileSync(join(fixtureDir, 'planted-const-def.mjs'), plantedSource, 'utf8');
  const defined = definesReadChunkObservations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(defined, ['brain/scripts/planted-const-def.mjs']);
});

test('readChunkObservations: a bare function + a separate `export { readChunkObservations }` list is caught', () => {
  // Mutant H3: a non-exported `function readChunkObservations` declaration
  // paired with a later bare `export { readChunkObservations };` re-export
  // list — neither half alone looks like `export function`.
  const fixtureRoot = testTmp('chunk-boundary-fixture-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource =
    'function readChunkObservations() { return []; }\n' + `${EXPORT_KW} { readChunkObservations };\n`;
  writeFileSync(join(fixtureDir, 'planted-bare-def.mjs'), plantedSource, 'utf8');
  const defined = definesReadChunkObservations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(defined, ['brain/scripts/planted-bare-def.mjs']);
});

// ── D4 guard 4 — PR #258's readers stay records-only (spec.md, pin) ────────

test('brain-audit.mjs and brain-check.mjs import readRecordObservations, never a chunk reader (D4 guard 4)', () => {
  // Green on arrival, not red-first — PR #258 already migrated both readers.
  // Stated as a regression pin, not a red-first, per spec.md's scenario.
  for (const relFile of ['brain/scripts/brain-audit.mjs', 'brain/scripts/brain-check.mjs']) {
    const src = readFileSync(join(repoRoot, relFile), 'utf8');
    assert.match(
      src,
      /import\s*\{[^}]*\breadRecordObservations\b[^}]*\}\s*from\s*['"][^'"]*store\.mjs['"]/,
      `${relFile} must import readRecordObservations`,
    );
    assert.doesNotMatch(src, /\breadChunkObservations\b/, `${relFile} must never reference readChunkObservations`);
    assert.doesNotMatch(
      src,
      /\bcollectChunkObservations\b/,
      `${relFile} must never reference collectChunkObservations`,
    );
  }
});
