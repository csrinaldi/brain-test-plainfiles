// retired-artifacts.static.test.mjs — static guards for artifact-retirement
// (epic #864 task 2.4, issue #955). Each subtest proves a retired artifact
// left no trace in PRODUCTION source, by literal string absence — never by
// asserting the deleted function/file is merely unused (design.md's mutation
// matrix: these are the SOLE killer for driver/lib-module re-additions).
//
// S1-S3 are Slice A (#958). B1-B4 land in Slice B (#955) — see design.md's
// File Changes tables and Testing Strategy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN_ROOT = join(REPO_ROOT, 'brain', 'scripts');

const EXCLUDE_TEST_FILE = /\.test\.mjs$/;
const EXCLUDE_FIXTURES_DIR = /^__fixtures__$/;

/**
 * Walks `brain/scripts/**` (hooks included), skipping `*.test.mjs` files and
 * `__fixtures__/` directories, and returns [{file, matches}] for every file
 * that contains a literal `manifest.json` or `engram-manifest` string.
 *
 * @returns {{ hits: {file: string, term: string}[], scanned: number }}
 */
function scanForRetiredArtifactStrings() {
  const hits = [];
  let scanned = 0;
  const TERMS = ['manifest.json', 'engram-manifest'];

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (EXCLUDE_FIXTURES_DIR.test(e.name)) continue;
        walk(join(dir, e.name));
        continue;
      }
      if (EXCLUDE_TEST_FILE.test(e.name)) continue;
      const p = join(dir, e.name);
      if (statSync(p).size > 2 * 1024 * 1024) continue;
      scanned++;
      const rel = relative(REPO_ROOT, p);
      let content;
      try {
        content = readFileSync(p, 'utf8');
      } catch {
        continue; // unreadable (e.g. binary/symlink target gone) — not this guard's job
      }
      for (const term of TERMS) {
        if (content.includes(term)) hits.push({ file: rel, term });
      }
    }
  };
  walk(SCAN_ROOT);
  return { hits, scanned };
}

const { hits, scanned } = scanForRetiredArtifactStrings();

test('S1: the scan read a real tree (a vacuous pass is a failure) — more than 100 production files scanned, including engram.mjs', () => {
  assert.ok(scanned > 100, `only ${scanned} file(s) scanned under brain/scripts/ — the walker, not the tree, is what to look at`);
  const engramMjsPath = join(SCAN_ROOT, 'axes', 'memory', 'adapters', 'engram.mjs');
  assert.doesNotThrow(() => statSync(engramMjsPath), 'engram.mjs must exist and be reachable by the walk');
});

test('S1: no production file under brain/scripts/** references manifest.json or engram-manifest (#955 R6/R7)', () => {
  assert.deepEqual(
    hits, [],
    'these production files still name a retired artifact:\n' +
      hits.map((h) => `  ${h.file} — "${h.term}"`).join('\n'),
  );
});

test('S2: .gitattributes no longer names the engram-manifest merge driver', () => {
  const content = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8');
  assert.doesNotMatch(content, /engram-manifest/, '.gitattributes must not reference the retired driver');
});

test('S3: .gitignore has the exact line `.memory/manifest.json`', () => {
  const content = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
  const lines = content.split('\n').map((l) => l.trim());
  assert.ok(
    lines.includes('.memory/manifest.json'),
    '.gitignore must contain the exact line ".memory/manifest.json" (R6)',
  );
});

// ─────────────────────────────────────────────────────────────────────────
// B1-B4 — Slice B (#955). These check DEFINITIONS and IMPORTS only, never
// prose — several files legitimately keep a prose mention of a retired
// identifier as historical precedent (design.md: store.mjs, plainfiles.mjs,
// staged-records-check.mjs, i18n comments, cli.mjs comments). A "definition"
// is a `function <name>(` declaration (any export/async combination) or a
// `const <name> =` assignment. An "import" is either a static named import
// or a dynamic `const { <name> } = await import(...)` destructure — the
// exact shape `cli.mjs:618` used for `rollbackMigration` before B3.3.
const BRAIN_ROOT = join(REPO_ROOT, 'brain');
const EXCLUDE_MJS_ONLY = /\.mjs$/;

/**
 * Walks `brain/**` (any depth, `.mjs` files only), skipping `*.test.mjs`
 * files and `__fixtures__/` directories, and returns every file that
 * defines or imports any of `names`.
 *
 * @param {string[]} names
 * @returns {{ file: string, name: string, kind: 'definition' | 'import' }[]}
 */
function scanForRetiredDefinitions(names) {
  const hits = [];

  const defPatterns = names.map((name) => ({
    name,
    re: new RegExp(`(^|[^\\w$])(export\\s+)?(default\\s+)?(async\\s+)?function\\s+${name}\\s*\\(`),
  }));
  const constDefPatterns = names.map((name) => ({
    name,
    re: new RegExp(`(^|[^\\w$])(export\\s+)?const\\s+${name}\\s*=`),
  }));
  const staticImportPatterns = names.map((name) => ({
    name,
    re: new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`),
  }));
  const dynamicImportPatterns = names.map((name) => ({
    name,
    re: new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*(await\\s+)?import\\s*\\(`),
  }));

  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (EXCLUDE_FIXTURES_DIR.test(e.name)) continue;
        walk(join(dir, e.name));
        continue;
      }
      if (!EXCLUDE_MJS_ONLY.test(e.name)) continue;
      if (EXCLUDE_TEST_FILE.test(e.name)) continue;
      const p = join(dir, e.name);
      let content;
      try {
        content = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const rel = relative(REPO_ROOT, p);
      for (const { name, re } of [...defPatterns, ...constDefPatterns]) {
        if (re.test(content)) hits.push({ file: rel, name, kind: 'definition' });
      }
      for (const { name, re } of [...staticImportPatterns, ...dynamicImportPatterns]) {
        if (re.test(content)) hits.push({ file: rel, name, kind: 'import' });
      }
    }
  };
  walk(BRAIN_ROOT);
  return hits;
}

function assertNoDefinitionOrImport(name, ruling) {
  const hits = scanForRetiredDefinitions([name]).filter((h) => h.name === name);
  assert.deepEqual(
    hits, [],
    `${name} still has a definition or import (${ruling}):\n` +
      hits.map((h) => `  ${h.file} — ${h.kind}`).join('\n'),
  );
}

test('B1: dualWriteRecords has no definition or import in brain/** (#955 R5)', () => {
  assertNoDefinitionOrImport('dualWriteRecords', 'R5');
});

test('B2: rollbackMigration has no definition or import in brain/** (#955 R2)', () => {
  assertNoDefinitionOrImport('rollbackMigration', 'R2');
});

test('B3: scrubChunkFile has no definition or import in brain/** (#955 R4)', () => {
  assertNoDefinitionOrImport('scrubChunkFile', 'R4');
});

test('B4: secret-scrub.mjs does not import node:zlib (#955 R4 — gunzip stayed only for scrubChunkFile)', () => {
  const content = readFileSync(join(BRAIN_ROOT, 'scripts', 'memory', 'lib', 'secret-scrub.mjs'), 'utf8');
  assert.doesNotMatch(content, /from\s+["']node:zlib["']/, 'secret-scrub.mjs must not import node:zlib once scrubChunkFile is gone');
});
