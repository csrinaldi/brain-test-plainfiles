// verify-change.test.mjs — S1 independence test for the repo-scope MATRIX row.
//
// verify-change.mjs executes git at module load, so a standard import() would
// require a real git repo context.  Instead we inspect the source text to assert
// the S1 invariant: the repo-scope `commands` must use a direct `node` invocation
// and must NOT reference any npm/pm verb by name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, 'verify-change.mjs'), 'utf8');

// ── S1 independence invariant ─────────────────────────────────────────────────

test('verify-change: repo-scope row does NOT invoke pm.runArgs("repo:check")', () => {
  // The old verb-dependent call must be gone.
  assert.ok(
    !SRC.includes("pm.runArgs('repo:check'"),
    'Expected pm.runArgs(\'repo:check\') to be absent — S1 should have removed it',
  );
});

test('verify-change: repo-scope row uses direct node invocation of check-refs.mjs', () => {
  // The new direct call must be present.
  assert.ok(
    SRC.includes("'node', 'brain/scripts/check-refs.mjs'"),
    "Expected [\'node\', \'brain/scripts/check-refs.mjs\'] to be present in source",
  );
});
