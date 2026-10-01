// installed-version.test.mjs — `readInstalledVersion` across the rename (#627).
//
// This was a bare `pkg.name === 'brain'`, and the scope broke it in BOTH
// directions at once. Measured on `main` @ `982f544` before the fix: null for a
// consumer with `@logikas/brain` installed, and null for brain's own repo.
//
// `day:start` step 4 reads this FIRST, so the whole version check was already
// inert — and inert in the way that reads as fine, since the message it printed
// was "could not determine installed brain version — skipping check". A check
// that skips itself looks the same as a check that passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readInstalledVersion, PACKAGE_NAME, LEGACY_PACKAGE_DIR } from './installer.mjs';

/** A consumer tree with `name` installed at `version`. */
function consumerWith(name, version) {
  const root = mkdtempSync(join(tmpdir(), 'brain-627-'));
  const pkgDir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
  // The consumer's own manifest is a different package — the second candidate
  // must not match it, or every consumer would report their OWN version as
  // brain's.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-consumer', version: '9.9.9' }));
  return root;
}

test('#627: the scoped install is read', () => {
  const root = consumerWith(PACKAGE_NAME, '1.1.0');
  try {
    assert.equal(readInstalledVersion(root), '1.1.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#627: a PRE-RENAME install is still read — telling them is the whole point', () => {
  // The population that most needs to hear "a new version exists" is precisely
  // the one that has not crossed the rename yet. Dropping the legacy name would
  // silence the check for exactly them.
  const root = consumerWith(LEGACY_PACKAGE_DIR, '1.0.0');
  try {
    assert.equal(readInstalledVersion(root), '1.0.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#627: a consumer\'s OWN version is never mistaken for brain\'s', () => {
  // The fallback candidate is the repo's own package.json, for the self-host
  // case. It must match on NAME, not on position.
  const root = mkdtempSync(join(tmpdir(), 'brain-627-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-consumer', version: '9.9.9' }));
    assert.equal(readInstalledVersion(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#627: self-host — brain\'s own repo reports its own version', () => {
  const root = process.cwd();
  const v = readInstalledVersion(root);
  assert.ok(v, 'brain\'s own repo must resolve a version; null here is the defect this closes');
  assert.match(v, /^\d+\.\d+\.\d+/);
});
