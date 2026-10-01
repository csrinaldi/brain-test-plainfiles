// installed-package-root.test.mjs — one source for where an installed brain
// lives inside a consumer (issue #623).
//
// WHY. Renaming the package to a scope moves the install root from
// `node_modules/brain` to `node_modules/@scope/brain`. Measured on `main` @
// `d0c576f`, that path was resolved by LITERAL in nine executable places across
// six production modules. Nine independent chances to miss one — and a missed
// one does not fail at rename time. It fails on the release that first needs
// that path, in `brain:upgrade`, which is the verb a consumer runs to recover.
// That is #601's shape.
//
// So the rename is not a name field. This guard is what makes it one.
//
// MIRRORS `sdd-layout.test.mjs`'s A1 guard deliberately, rather than inventing a
// second shape for the same job (#340): scan `brain/scripts/**/*.mjs`, exclude
// the owning module and `*.test.mjs`, and name the offending files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The module allowed to spell the path out. Everything else imports from it. */
const OWNER = 'installer.mjs';

/**
 * A literal that resolves the installed-package root by hand. Matches the
 * `join(x, 'node_modules', 'brain')` shape in any quoting, which is how all
 * nine original sites were written.
 */
const RIVAL_RE = /['"`]node_modules['"`]\s*,\s*['"`]brain['"`]/g;

/**
 * Files that spell it out. Throws rather than returning `[]` on an unreadable
 * tree: "nothing found" and "nothing scanned" must not share a verdict.
 *
 * @returns {{offenders: {file:string, count:number}[], scanned:number}}
 */
function scanForRivalLiterals() {
  const offenders = [];
  let scanned = 0;
  const entries = readdirSync(SCRIPTS_ROOT, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    if (entry.name.endsWith('.test.mjs') || entry.name === OWNER) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    scanned++;
    const hits = (readFileSync(full, 'utf8').match(RIVAL_RE) ?? []).length;
    if (hits > 0) offenders.push({ file: full.slice(SCRIPTS_ROOT.length + 1), count: hits });
  }
  if (scanned === 0) throw new Error(`scanned no .mjs files under ${SCRIPTS_ROOT} — the walker is broken, not the tree`);
  return { offenders, scanned };
}

const { offenders, scanned } = scanForRivalLiterals();

test('installed-package-root: the scan actually read brain/scripts (a vacuous pass is a failure)', () => {
  assert.ok(scanned > 50, `only ${scanned} .mjs files scanned — the walker, not the tree, is what to look at`);
});

test('installed-package-root: only installer.mjs spells out node_modules/brain (#623)', () => {
  assert.deepEqual(
    offenders, [],
    'these resolve the installed-package root by literal, so a scoped rename must find every one of them:\n'
      + offenders.map((o) => `  ${o.file}  ×${o.count}`).join('\n')
      + `\n\n  Import the single source from lib/${OWNER} instead.`,
  );
});
