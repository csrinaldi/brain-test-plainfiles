// sdd-view.test.mjs — the SDD view's rendering, asserted by text scan
// (#998, review of PR 4): this repo has no DOM test harness (design D9), so
// the rules that would otherwise break the page silently are pinned against
// `app.js`'s own source text, the same precedent `app-source-guard.test.mjs`
// and `loadChange`'s token-guard test already use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const STATIC_DIR = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(STATIC_DIR, 'app.js');

function read(path) {
  return readFileSync(path, 'utf8');
}

/** The named function's whole body, `function <name>(` to its closing `\n}\n` at column 0. */
function functionBody(text, signaturePrefix) {
  const start = text.indexOf(signaturePrefix);
  assert.ok(start >= 0, `${signaturePrefix} must exist in app.js`);
  const end = text.indexOf('\n}\n', start);
  assert.ok(end > start, `${signaturePrefix} must close with a top-level "}"`);
  return text.slice(start, end + 3);
}

// ── review of PR 4, fix 1: skipped archive dirs are said in band ───────────

// #1059 phase 10 moved this view from a stage matrix to the project's slice
// plan. The fact survived the move: it reads the same section, so it still
// says what that section skipped — the assertion follows the new field name.
test('#998 fix1 (as moved by #1059): renderSdd says the archive dirs it skipped, by name', () => {
  const body = functionBody(read(APP_JS), 'function renderSdd(');
  assert.match(body, /archiveSkipped\.count/, 'the band is gated on the count, not always shown');
  assert.match(body, /archiveSkipped\.names/, 'the names are rendered, not just the count');
});

// ── review of PR 4, fix 2: every path in the SDD row renders through sourceStamp ──

test('#998 fix2: renderSddRow stamps every path it renders — the row header, each stage cell, the tasks line, and each slice line', () => {
  const body = functionBody(read(APP_JS), 'function renderSddRow(');
  assert.match(body, /sourceStamp\(\{\s*path:\s*change\.dir\s*\}\)/, 'the row header already stamps change.dir');
  assert.match(body, /sourceStamp\(stage\.source\)/, 'each stage cell stamps its own source');
  assert.match(body, /sourceStamp\(t\.source\)/, 'the tasks line stamps its own source');
  assert.match(body, /sourceStamp\(s\.source\)/, 'each slice line stamps its own source');
});

// ── review of PR 4, fix 3: "PR state is not read" is rendered as data ──────

test('#998 fix3: renderSdd/renderSddRow render the model\'s sliceNote — the sentence is not a page literal', () => {
  const text = read(APP_JS);
  const sddBody = functionBody(text, 'function renderSdd(');
  const rowBody = functionBody(text, 'function renderSddRow(');
  assert.doesNotMatch(rowBody, /PR state is not read/, 'the sentence must not be hard-coded on the page');
  assert.match(sddBody + rowBody, /sliceNote/, "the model's sliceNote is threaded through instead");
});

// ── cold review of #1008/PR6: a null "next" renders no "— next:" fragment ──

test('#998 cold-1008: the tasks line omits the "next" fragment when t.next is falsy — sdd-model.mjs\'s own job is normalising the "—" sentinel to null, this only pins the row already guards on it', () => {
  const rowBody = functionBody(read(APP_JS), 'function renderSddRow(');
  assert.match(rowBody, /\$\{t\.next \? `[^`]*next:[^`]*`\s*:\s*''\}/, 'the tasks line must guard the "— next: …" fragment on t.next being truthy');
});
