// vendor.test.mjs — the vendored markdown tokenizer is pinned, offline and
// declared nowhere in package.json (#1198, R1198-11, R1198-17).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const VENDOR_DIR = dirname(fileURLToPath(import.meta.url));
const PKG = join(VENDOR_DIR, '..', '..', '..', '..', 'package.json');
const FILE = 'marked.esm.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The drift check, as a function so a mutated copy can be fed to it. */
function driftFailure(name, bytes, versionsText) {
  const m = new RegExp(`^marked (\\S+) sha256:([0-9a-f]{64}) ${name.replace('.', '\\.')}$`, 'm').exec(versionsText);
  if (!m) return `${name}: no pinned line in VERSIONS`;
  return sha256(bytes) === m[2] ? null : `${name}: sha256 differs from the pin in VERSIONS`;
}

test('#1198: marked.esm.js matches the sha256 pinned in VERSIONS', () => {
  const versions = readFileSync(join(VENDOR_DIR, 'VERSIONS'), 'utf8');
  assert.match(versions, /^marked 18\.0\.14 sha256:[0-9a-f]{64} marked\.esm\.js$/m);
  assert.equal(driftFailure(FILE, readFileSync(join(VENDOR_DIR, FILE)), versions), null);
});

test('#1198: a one-byte change is a drift failure that names the file', () => {
  const versions = readFileSync(join(VENDOR_DIR, 'VERSIONS'), 'utf8');
  const bytes = Buffer.from(readFileSync(join(VENDOR_DIR, FILE)));
  bytes[10] ^= 1;
  assert.match(driftFailure(FILE, bytes, versions), /marked\.esm\.js/);
});

test('#1198: the MIT licence ships beside the vendored file', () => {
  assert.ok(existsSync(join(VENDOR_DIR, 'LICENSE.marked')));
  assert.match(readFileSync(join(VENDOR_DIR, 'LICENSE.marked'), 'utf8'), /MIT license/i);
});

test('#1198 AC6: package.json declares marked in no dependency section', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.ok(!('marked' in (pkg[section] ?? {})), `${section} must not name marked`);
  }
});

test('#1198: the vendored file reaches no network, no global and no DOM', () => {
  const text = readFileSync(join(VENDOR_DIR, FILE), 'utf8');
  for (const needle of ['fetch(', 'XMLHttpRequest', 'import(', 'globalThis', 'window.', 'document.']) {
    assert.ok(!text.includes(needle), `marked.esm.js contains ${needle}`);
  }
});
