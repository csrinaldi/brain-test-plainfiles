// source-guard.test.mjs — the D9 boundary, enforced by a scan, not a promise
// (#881 PR 3). `ui/lib/**` is imported by the browser AND by `node:test`
// (D9); one `node:fs` import there breaks the page silently in a way no
// node test would catch, so the rule is asserted here instead of trusted.
//
// Scoped test-only, no production change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));

function libModules() {
  return readdirSync(LIB_DIR)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .sort();
}

function importSpecifiers(text) {
  const specs = [];
  for (const line of text.split('\n')) {
    if (!/^\s*import\b/.test(line) && !/\bimport\(/.test(line)) continue;
    const m = /from\s+['"]([^'"]+)['"]/.exec(line) ?? /import\(\s*['"]([^'"]+)['"]/.exec(line);
    if (m) specs.push(m[1]);
  }
  return specs;
}

test('#881: ui/lib/ exists and ships at least one pure module', () => {
  const modules = libModules();
  assert.ok(modules.length > 0, 'brain/scripts/ui/lib/ must contain at least one .mjs module');
});

// The ONE exemption to the `./`-only rule: the markdown adapter's door to the
// vendored tokenizer (#1198, R1198-11). It is an exact (file, specifier) pair,
// never a pattern, so no other lib module can reach outside ui/lib/**.
const IMPORT_EXEMPTIONS = [['markdown.mjs', '../vendor/marked.esm.js']];

/** The specifiers of `name` that break the `./`-only rule, exemptions applied. */
function outsideImports(name, specs, exemptions = IMPORT_EXEMPTIONS) {
  return specs.filter((spec) => !spec.startsWith('./') && !exemptions.some(([f, s]) => f === name && s === spec));
}

test('#881: no file under ui/lib/** imports anything outside ui/lib/** (D9)', () => {
  const modules = libModules();
  assert.ok(modules.length > 0, 'no modules to scan — see the previous test');
  for (const name of modules) {
    const text = readFileSync(join(LIB_DIR, name), 'utf8');
    const bad = outsideImports(name, importSpecifiers(text));
    assert.deepEqual(
      bad,
      [],
      `${name}: imports ${JSON.stringify(bad)} — only sibling ./*.mjs imports are allowed under ui/lib/** ` +
        '(no node: builtin, no ../status/*, no npm package)',
    );
  }
});

test('#1198: the ./-only rule has exactly one exemption, scoped to (markdown.mjs, ../vendor/marked.esm.js)', () => {
  assert.deepEqual(IMPORT_EXEMPTIONS, [['markdown.mjs', '../vendor/marked.esm.js']]);
  assert.deepEqual(outsideImports('markdown.mjs', ['../vendor/marked.esm.js']), []);
  assert.deepEqual(outsideImports('other.mjs', ['../vendor/marked.esm.js']), ['../vendor/marked.esm.js']);
  assert.deepEqual(outsideImports('markdown.mjs', ['../vendor/other.js']), ['../vendor/other.js']);
  assert.deepEqual(outsideImports('markdown.mjs', ['node:fs']), ['node:fs']);
});

test('#1198: the exemption is used — markdown.mjs really imports the vendored file', () => {
  const text = readFileSync(join(LIB_DIR, 'markdown.mjs'), 'utf8');
  assert.ok(importSpecifiers(text).includes('../vendor/marked.esm.js'), 'an unused exemption must be deleted');
});

test('#881: no ui/lib/** module reaches for wall-clock time, randomness, process, or the network', () => {
  const modules = libModules();
  assert.ok(modules.length > 0, 'no modules to scan — see the first test');
  const forbidden = [
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bMath\.random\s*\(/, 'Math.random()'],
    [/\bprocess\./, 'process.*'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/\bimport\.meta\b/, 'import.meta'], // environment-dependent: the browser and node disagree on it
  ];
  for (const name of modules) {
    const text = readFileSync(join(LIB_DIR, name), 'utf8');
    for (const [re, label] of forbidden) {
      assert.ok(!re.test(text), `${name}: matched forbidden pattern ${label} — ui/lib/** must stay pure`);
    }
  }
});
