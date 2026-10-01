// tokens.test.mjs — R998-1: the token block. Every state has a fg/bg token
// pair on bare `:root` (the light palette, the base); the dark palette lives
// under `prefers-color-scheme: dark` and redefines only tokens the base
// already defines; the font stacks are system stacks; no external resource.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { STATE_CODES } from '../lib/state-vocab.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, 'app.css'), 'utf8');
const html = readFileSync(join(HERE, 'index.html'), 'utf8');

function block(text, opener) {
  const i = text.indexOf(opener);
  assert.ok(i >= 0, `${opener} not found`);
  const open = text.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '{') depth++;
    if (text[j] === '}' && --depth === 0) return text.slice(open + 1, j);
  }
  assert.fail(`${opener} never closes`);
}
const tokensIn = (body) => [...body.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]);

test('#998: every state has a --state-<code>-fg and -bg token on bare :root', () => {
  const root = block(css, ':root');
  const names = new Set(tokensIn(root));
  for (const code of STATE_CODES) {
    assert.ok(names.has(`state-${code}-fg`), `--state-${code}-fg missing on :root`);
    assert.ok(names.has(`state-${code}-bg`), `--state-${code}-bg missing on :root`);
  }
});

test('#998: the dark palette redefines only tokens the light base already defines — light is the base', () => {
  const light = new Set(tokensIn(block(css, ':root')));
  const dark = tokensIn(block(css, '@media (prefers-color-scheme: dark)'));
  assert.ok(dark.length >= STATE_CODES.length * 2, 'the dark block redefines the state tokens');
  for (const name of dark) assert.ok(light.has(name), `--${name} is defined only in the dark block`);
  assert.ok(!/prefers-color-scheme:\s*light/.test(css), 'no light-only block: light is the default');
});

test('#998: system font stacks, no downloadable face, no external resource in the stylesheet or the shell', () => {
  assert.match(css, /--font-sans:\s*ui-sans-serif/);
  assert.match(css, /--font-mono:\s*ui-monospace/);
  assert.ok(!/@font-face|@import|url\(/.test(css), 'no font file, no import, no url()');
  assert.ok(!/https?:\/\//.test(css), 'no external resource in app.css');
  const external = [...html.matchAll(/https?:\/\/[^"'\s>]+/g)].map((m) => m[0]);
  assert.deepEqual(external, [], 'no external resource in index.html');
});

test('#998: no surface is hard-coded white outside the token block — the drawer follows the dark palette too (cold review of PR 1, correction)', () => {
  // Comments are not colours (an issue reference like #998 is not a hex), and the token blocks are where literals belong.
  // `white` as a COLOUR is forbidden; `white-space` is a property name and was
  // a false positive the moment a rule outside the token block needed it
  // (#1059 region 04, the batch's tiles), so the match stops at a hyphen.
  // The token blocks are where literals belong, and since #1059 there are
  // three of them: the bare `:root` light base, the guarded media query, and
  // the explicit `[data-theme]` stamp. All three are stripped before the scan.
  const withoutTokens = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?\n\}/g, '')
    .replace(/:root(?:\[[^\]]*\])?\s*\{[^}]*\}/g, '');
  const literals = [...withoutTokens.matchAll(/#[0-9a-fA-F]{3,8}\b|\bwhite\b(?!-)/g)].map((m) => m[0]);
  assert.deepEqual(literals, [], 'a colour outside the token block must read a token, never a literal (cold review of PR 2: a hard-coded light hex on the active mode button was illegible in dark)');
});

// ── #1059 phase 8: three theme states, one set of names ───────────────────
// A token defined in only one block is the classic unreadable-page bug: the
// viewer gets one theme's text on the other theme's ground. The light block on
// bare `:root` is the base and must define every name the others redefine.
test('#1059: every token the dark blocks redefine is defined on bare :root first', () => {
  const names = (block) => [...block.matchAll(/--[a-z0-9-]+(?=\s*:)/g)].map((m) => m[0]).sort();

  const light = names((css.match(/^:root \{([\s\S]*?)\n\}/m) ?? [, ''])[1]);
  const media = names((css.match(/:root:not\(\[data-theme='light'\]\) \{([\s\S]*?)\n  \}/) ?? [, ''])[1]);
  const stamped = names((css.match(/:root\[data-theme='dark'\] \{([\s\S]*?)\n\}/) ?? [, ''])[1]);

  assert.ok(light.length > 0, 'the bare :root block must carry the light palette');
  assert.ok(media.length > 0, 'the media query must redefine the dark palette');
  assert.deepEqual(media, stamped, 'the stamped dark theme and the system dark theme must define the SAME names, or the toggle changes a different set of colours than the OS does');
  for (const name of media) {
    assert.ok(light.includes(name), `${name} is redefined for dark but never defined on bare :root — a viewer on light would inherit nothing`);
  }
});
