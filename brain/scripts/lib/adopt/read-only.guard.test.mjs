// read-only.guard.test.mjs — Structural guard for brain/scripts/lib/adopt/*.mjs.
// Run with: npm test   (node --test, no dependencies beyond node:fs)
//
// Asserts that every non-test .mjs file in this directory imports neither
// node:fs nor node:child_process. The read-only contract (design.md § "Read-only
// enforced structurally") requires lib modules to be pure: I/O lives only at the
// CLI edge (adopt.mjs). This guard fails automatically when a new lib file is
// added that violates the contract, so the rule is enforced continuously.
//
// Exclusions:
//   - *.test.mjs files (test harness legitimately uses node:fs for fixture reads)
//   - directories (e.g., __fixtures__/)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FS_IMPORT_RE    = /import[^'"]*['"](?:node:)?fs(?:\/[^'"]+)?['"]/;
const CHILD_IMPORT_RE = /import[^'"]*['"](?:node:)?child_process['"]/;

test('adopt lib modules import no node:fs or node:child_process', () => {
  const entries = readdirSync(__dirname).filter((name) => {
    // Only plain .mjs files — skip test files and non-files (directories).
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) return false;
    const abs = join(__dirname, name);
    return statSync(abs).isFile();
  });

  assert.ok(entries.length > 0, 'guard must find at least one lib .mjs file to check');

  for (const file of entries) {
    const src = readFileSync(join(__dirname, file), 'utf8');

    assert.doesNotMatch(
      src,
      FS_IMPORT_RE,
      `${file} must NOT import node:fs — I/O belongs at the CLI edge only`,
    );

    assert.doesNotMatch(
      src,
      CHILD_IMPORT_RE,
      `${file} must NOT import node:child_process — adopt is read-only`,
    );
  }
});
