// installed-package-root.resolve.test.mjs — new code must find an OLD install
// (issue #625).
//
// THE BREAK THIS DOES NOT FIX, stated first so the scope is not mistaken. A
// consumer on the git-tag install has `node_modules/brain`. The release that
// carries the scoped name kills their `brain:upgrade` mid-run: their vendored
// OLD code resolves `node_modules/brain`, `installSpec` installs from the git
// URL, npm reads the NEW package.json and lands the tree in
// `node_modules/@scope/brain`, and the old code then finds nothing. That code
// is already in their tree; nothing written here reaches it.
//
// WHAT IS FIXABLE is the mirror: NEW code finding an OLD install. After any
// recovery a tree can hold `node_modules/brain` while the running code expects
// the scoped path, and today that reads as "not installed".
//
// WHY IT IS TESTED WITH AN INJECTED NAME. It was written BEFORE the rename,
// when `PACKAGE_NAME` was `brain` and the fallback was inert — shipping a safety
// net untested until the day it matters is how one is discovered to be missing
// while being used. The rename has since landed (#655), so the two `#655` tests
// below assert the same behaviour with the REAL constants; the injected ones
// stay, because they are what will keep this honest at the next rename.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  resolveInstalledPackageRoot,
  describeInstalledPackageSearch,
  installedPackageSearchPaths,
  PACKAGE_NAME,
  LEGACY_PACKAGE_DIR,
} from './installer.mjs';

const SCOPED = '@logikas/brain';
const ROOT = '/consumer';
const scopedPath = join(ROOT, 'node_modules', '@logikas', 'brain');
const legacyPath = join(ROOT, 'node_modules', 'brain');

/** A fake fs: only the listed paths exist. */
const only = (...present) => (p) => present.includes(p);

test('#625: a scoped install is found where it is', () => {
  assert.equal(
    resolveInstalledPackageRoot({ repoRoot: ROOT, packageName: SCOPED, exists: only(scopedPath) }),
    scopedPath,
  );
});

test('#625: a LEGACY install is found when the scoped path is absent', () => {
  assert.equal(
    resolveInstalledPackageRoot({ repoRoot: ROOT, packageName: SCOPED, exists: only(legacyPath) }),
    legacyPath,
  );
});

test('#625: the scoped path wins when BOTH exist — the legacy one is a fallback, not a preference', () => {
  assert.equal(
    resolveInstalledPackageRoot({ repoRoot: ROOT, packageName: SCOPED, exists: only(scopedPath, legacyPath) }),
    scopedPath,
  );
});

test('#625: with neither present it returns the CANONICAL path, so an error names what to create', () => {
  assert.equal(
    resolveInstalledPackageRoot({ repoRoot: ROOT, packageName: SCOPED, exists: only() }),
    scopedPath,
  );
});

test('#625: trailing segments are appended to whichever root won', () => {
  const rest = ['brain', 'core', 'managed-paths.mjs'];
  assert.equal(
    resolveInstalledPackageRoot({ repoRoot: ROOT, packageName: SCOPED, rest, exists: only(legacyPath) }),
    join(legacyPath, ...rest),
  );
  assert.equal(
    resolveInstalledPackageRoot({ repoRoot: ROOT, packageName: SCOPED, rest, exists: only(scopedPath) }),
    join(scopedPath, ...rest),
  );
});

test('#655: the rename happened, so the fallback is live rather than inert', () => {
  // This replaces #625's pre-rename pin. That test asserted the two coincided and
  // said it "should be revisited with the rename" — this is that revision, and it
  // asserts the opposite, with no injected name: the real constants.
  assert.notEqual(PACKAGE_NAME, LEGACY_PACKAGE_DIR,
    'PACKAGE_NAME is unscoped again — the rename was reverted, and everything below is inert');
  assert.equal(
    resolveInstalledPackageRoot({ repoRoot: ROOT, packageName: PACKAGE_NAME, exists: only(legacyPath) }),
    legacyPath,
    'a consumer who still has the pre-rename install reads as NOT INSTALLED — the #625 fallback is not working',
  );
});

// ── The failure has to be legible ───────────────────────────────────────────
//
// A resolver that searches two places and an error that names one is worse than
// no fallback at all: the reader is sent to inspect a path the code never looked
// at. `brain:upgrade` is the verb a consumer runs to RECOVER, so its death
// message is the last thing they get before they are on their own.

test('#625: the searched-paths list is exactly what the resolver probes, in the same order', () => {
  assert.deepEqual(
    installedPackageSearchPaths({ packageName: SCOPED }),
    ['node_modules/@logikas/brain', 'node_modules/brain'],
  );
});

test('#625: a failure message names BOTH places that were searched', () => {
  const text = describeInstalledPackageSearch({ packageName: SCOPED });
  assert.match(text, /node_modules\/@logikas\/brain/,
    'the canonical path is missing — the reader cannot tell where the code expected to find brain');
  assert.match(text, /node_modules\/brain/,
    'the pre-rename path is missing — the fallback searched it and the message hides that it did');
});

test('#655: with the real constants the message names BOTH paths', () => {
  // The pre-rename version of this asserted exactly one path. Both directions
  // were guarded then and both are guarded now: naming one place when two were
  // searched sends the reader to the wrong directory, and naming two when one was
  // searched sends them to look twice at the same one.
  assert.deepEqual(installedPackageSearchPaths(), [`node_modules/${PACKAGE_NAME}`, 'node_modules/brain']);
  const text = describeInstalledPackageSearch();
  assert.match(text, new RegExp(`node_modules/${PACKAGE_NAME.replace('/', '\\/')}`));
  assert.match(text, /pre-rename node_modules\/brain/);
});

test('#625: trailing segments appear on every named path, not just the first', () => {
  const text = describeInstalledPackageSearch({ packageName: SCOPED, rest: ['package.json'] });
  assert.match(text, /node_modules\/@logikas\/brain\/package\.json/);
  assert.match(text, /node_modules\/brain\/package\.json/);
});

/**
 * Executable lines of a file — comments stripped, so prose ABOUT the legacy path
 * (of which both entry points carry several, deliberately) is not read as code
 * resolving it.
 *
 * Throws rather than returning `''`: an unreadable file must not pass as a file
 * with no offending lines.
 */
function executableLines(relPath) {
  const full = fileURLToPath(new URL(`../${relPath}`, import.meta.url));
  const lines = readFileSync(full, 'utf8').split('\n');
  const kept = lines.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  if (kept.length === 0) throw new Error(`${relPath}: every line read as a comment — the stripper is broken, not the file`);
  return kept;
}

test('#625: the entry points do not hardcode the path they claim to have searched', () => {
  // The two sites that die when brain is not installed. Their text used to be a
  // literal, which after the rename would name a path the code never searched —
  // the worst kind of error message, because it is confidently wrong.
  const SITES = ['brain-upgrade.mjs', 'cli-entry.mjs'];
  const offenders = [];
  for (const site of SITES) {
    const hits = executableLines(site)
      .map((l, i) => ({ line: i + 1, text: l }))
      .filter((e) => /node_modules\/brain/.test(e.text));
    for (const h of hits) offenders.push(`  ${site}: ${h.text.trim()}`);
  }
  assert.deepEqual(
    offenders, [],
    'these spell the installed root into executable text instead of deriving it from PACKAGE_NAME:\n'
      + offenders.join('\n')
      + '\n\n  Use describeInstalledPackageSearch() from lib/installer.mjs.'
      + '\n\n  lib/init.mjs is not scanned, and that is deliberate: its BOOTSTRAP_SCRIPT_VALUE is now'
      + '\n  derived (#628, delivered in #655), but LEGACY_BOOTSTRAP_VALUES still holds the pre-rename'
      + '\n  literal ON PURPOSE — it is how a stale alias in a consumer\'s package.json is recognised'
      + '\n  and migrated. A guard there would delete the migration.',
  );
});
