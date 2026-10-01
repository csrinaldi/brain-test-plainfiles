// app-source-guard.test.mjs — the D9 boundary applied to the file the
// BROWSER loads (#881 PR 4 / B2, tasks T2a). `ui/lib/**` already has its own
// guard (`lib/source-guard.test.mjs`); this one covers `static/app.js` and
// `static/index.html`, which no `node:test` can execute — there is no DOM
// runner in this repo (design D9), so the rules that would otherwise break
// the page silently are asserted by a scan instead of trusted.
//
// The rules, all from the maintainer's 2026-09-14 ruling (no dependency, no
// CDN, no vendored library, no build step) and R881-10:
//
//   1. `app.js` imports ONLY `./lib/*.mjs` — the same pure modules node tests
//      import. No `node:` builtin (the browser has none), no URL import, no
//      bare package specifier (there is no bundler to resolve one).
//   2. `index.html` loads no external resource and carries no inline handler.
//   3. `app.js` talks to `/api/*` and nothing else — no third-party endpoint,
//      no `file://`, no worktree path.
//   4. No `eval` / `new Function` anywhere in the page.
//
// Test-only; the production files it scans are T1b/T2b/T3b's work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const STATIC_DIR = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(STATIC_DIR, '..', 'lib');
const APP_JS = join(STATIC_DIR, 'app.js');
const INDEX_HTML = join(STATIC_DIR, 'index.html');

function read(path) {
  assert.ok(existsSync(path), `${path} must exist — the page is a real file, not a promise`);
  return readFileSync(path, 'utf8');
}

/**
 * Every import specifier in the file, collected over the WHOLE text: a
 * line-based scan reads `import {\n  debounce,\n} from 'lodash-es';` as four
 * lines none of which carries both an `import` and a `from`, so the bare
 * package it pulls into the browser passes the guard unseen. The three forms
 * an ES module has: `… from '<spec>'`, a bare `import '<spec>'` for side
 * effects, and a dynamic `import('<spec>')`.
 */
function importSpecifiers(text) {
  const specs = [];
  // Anchored to one statement: the clause body may span lines but never a
  // `;` or a quote, so a bare import cannot chain to a later `from` elsewhere.
  for (const m of text.matchAll(/\bimport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  return [...new Set(specs)];
}

test('#881 T2a: app.js exists and imports only ./lib/*.mjs — never a node: builtin, a URL, or a bare package', () => {
  const text = read(APP_JS);
  const specs = importSpecifiers(text);
  assert.ok(specs.length > 0, 'app.js must consume the pure lib modules, not re-implement them in the browser file');
  for (const spec of specs) {
    assert.match(spec, /^\.\/lib\/[a-z][a-z0-9-]*\.mjs$/, `app.js imports "${spec}" — only ./lib/<module>.mjs is allowed (D9)`);
    assert.ok(!spec.endsWith('.test.mjs'), `app.js imports "${spec}" — a test file is not part of the page`);
  }
});

test('#881 T2a: every module app.js imports really exists under ui/lib/ — a typo would 404 in the browser and pass every node test', () => {
  const available = new Set(readdirSync(LIB_DIR).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs')));
  for (const spec of importSpecifiers(read(APP_JS))) {
    const name = spec.replace('./lib/', '');
    assert.ok(available.has(name), `app.js imports ./lib/${name}, which does not exist (have: ${[...available].sort().join(', ')})`);
  }
});

test('#881 T2a: app.js fetches /api/* and nothing else, and never evaluates a string', () => {
  const text = read(APP_JS);
  for (const m of text.matchAll(/fetch\(\s*([`'"])([^`'"]*)\1/g)) {
    assert.match(m[2], /^\/api\//, `app.js fetches "${m[2]}" — the page reads this server's own API only`);
  }
  for (const m of text.matchAll(/new EventSource\(\s*([`'"])([^`'"]*)\1/g)) {
    assert.match(m[2], /^\/api\//, `app.js streams from "${m[2]}" — the page reads this server's own API only`);
  }
  assert.ok(/fetch\(/.test(text), 'app.js must actually read the API — a page that fetches nothing cannot be the SPA');
  for (const [re, label] of [[/\beval\s*\(/, 'eval()'], [/new\s+Function\s*\(/, 'new Function()']]) {
    assert.ok(!re.test(text), `app.js matched ${label} — forbidden in the page (no remote code, no third-party endpoint)`);
  }
  // The page used to carry ONE absolute URL — the SVG namespace constant that
  // `createElementNS` requires literally. #1059 region 03 replaced the lane
  // boards with the design's card grid, so nothing in the page draws SVG any
  // more and the allowance is gone with it: the list is now empty, which is
  // the strictest this assertion has ever been.
  const absolute = [...text.matchAll(/https?:\/\/\S*/g)].map((m) => m[0].replace(/['";,)]+$/, ''));
  assert.deepEqual([...new Set(absolute)], [], 'the page must reach no host but this server');
});

test('#881 T2a: index.html loads no external resource, no inline handler, and no build artefact', () => {
  const html = read(INDEX_HTML);
  assert.ok(!/<script[^>]+src="https?:/.test(html), 'index.html must not load a script from the network (no CDN — maintainer ruling)');
  assert.ok(!/<link[^>]+href="https?:/.test(html), 'index.html must not load a stylesheet or font from the network');
  assert.ok(!/\son[a-z]+=/i.test(html), 'index.html must not carry an inline event handler — app.js wires every listener');
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/, 'the page loads app.js directly as an ES module: no bundler, no build step');
});

// ── cold review of #982, correction 2: loadChange drops a stale answer ──

test('#881: loadChange guards its answer with a request token from lib/frames.mjs — a burst of refs frames cannot render an older answer over a newer one', () => {
  const text = readFileSync(APP_JS, 'utf8');
  assert.match(text, /import \{[^}]*\brequestSequence\b[^}]*\} from '\.\/lib\/frames\.mjs'/);
  const body = text.slice(text.indexOf('async function loadChange('));
  const fn = body.slice(0, body.indexOf('\n}\n') + 3);
  assert.match(fn, /const token = \w+\.next\(\)/, 'a token is taken before the fetch');
  assert.match(fn, /isCurrent\(token\)/, 'and checked after the answer, before rendering');
});

// ── cold review of #982, correction 1: the scanner must not span statements ──

test('#881: importSpecifiers never chains a bare import to a later "from" in a comment, and still catches a multi-line bare package import', () => {
  const phantom = 'import "./lib/setup.mjs";\n\n// naming convention borrowed from "lodash-es" for readability\nimport { buildX } from "./lib/x.mjs";\n';
  assert.deepEqual(importSpecifiers(phantom).sort(), ['./lib/setup.mjs', './lib/x.mjs'], 'a word in a comment is not a specifier');
  const multi = 'import {\n  a,\n  b,\n}\nfrom \'lodash-es\';\nimport { c } from "./lib/c.mjs";\n';
  assert.deepEqual(importSpecifiers(multi).sort(), ['./lib/c.mjs', 'lodash-es']);
});

test('#998: the page never assigns markup — no innerHTML, outerHTML, insertAdjacentHTML or document.write in app.js', () => {
  const text = readFileSync(APP_JS, 'utf8');
  assert.doesNotMatch(text, /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/, 'text from the forge and from files is rendered as text, never as markup');
});

// ── #1198: rendered markdown must never become markup, in lib/ either ────────
// `codeOnly` is defined below (function declarations hoist), and is what keeps
// the comment in lib/memory-model.mjs that names `innerHTML` from matching.
const MARKUP_SINK = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/;

function libMarkupSinks(sources) {
  return Object.entries(sources)
    .filter(([, text]) => MARKUP_SINK.test(codeOnly(text)))
    .map(([name]) => name);
}

test('#1198: no ui/lib/*.mjs assigns markup (innerHTML family), and the real app.js still passes', () => {
  const sources = {};
  for (const name of readdirSync(LIB_DIR).filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))) {
    sources[`lib/${name}`] = readFileSync(join(LIB_DIR, name), 'utf8');
  }
  assert.ok(Object.keys(sources).length > 10, 'the scan must actually see the lib modules');
  assert.deepEqual(libMarkupSinks(sources), []);
  assert.ok(!MARKUP_SINK.test(codeOnly(readFileSync(APP_JS, 'utf8'))), 'app.js stays markup-free');
});

test('#1198: an injected lib/markdown.mjs that assigns innerHTML is caught and named', () => {
  const evil = { 'lib/markdown.mjs': 'export const f = (el, s) => { el.innerHTML = s; };', 'lib/ok.mjs': '// innerHTML is banned\nexport const x = 1;' };
  assert.deepEqual(libMarkupSinks(evil), ['lib/markdown.mjs']);
});

// ── #1059: a call to a function that does not exist ────────────────────────
// `saidList` was called in seven places and defined in none. It had been
// deleted as collateral when phase 5 removed the SVG helpers it happened to
// sit above, and NOTHING caught it: app.js has no DOM runner (D9), so a
// ReferenceError is not a failing test, it is a blank page in the browser —
// `renderLanes` threw before `renderDrawer` ran, so no ticket panel could
// ever open. The maintainer found it by clicking.
//
// This scan is the cheapest guard that would have caught it: every identifier
// in call position must be declared in the file, imported, a parameter, or a
// known platform global. It is deliberately conservative — a name it cannot
// account for is a failure, so the fix is to declare the function or add the
// global here, never to loosen the rule.
const PLATFORM_GLOBALS = new Set([
  'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
  'EventSource', 'Error', 'Object', 'Array', 'Number', 'String', 'Boolean',
  'Math', 'JSON', 'Date', 'Map', 'Set', 'Promise', 'RegExp', 'Symbol',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'structuredClone',
]);
const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'new', 'of', 'in', 'await', 'else', 'do', 'try', 'throw', 'case', 'delete',
  'void', 'instanceof', 'yield', 'super', 'this', 'constructor', 'get', 'set',
]);

/** The source with comments and string/template bodies blanked, so a name
 *  that only appears in prose or in a quoted string is never read as code.
 *
 *  THE ORDER IS LOAD-BEARING, and getting it wrong is how this scan first
 *  lied to me. Stripping block comments first lets a `/*` that occurs inside
 *  a LINE comment — app.js's own header says "a pure `lib/<star>.mjs` module"
 *  — open a comment that runs to the next real closer and swallows the
 *  imports below it, which then read as undefined. Line comments go first for
 *  that reason; strings go last, because comment prose is full of
 *  apostrophes that would otherwise open a string that never closes. */
function codeOnly(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1 '))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

test('#1059: every function app.js calls is really defined — a ReferenceError is a blank page, not a failing test', () => {
  const code = codeOnly(read(APP_JS));

  const declared = new Set();
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  // Destructured bindings and every parameter list: `({a, b})`, `(x, y) =>`,
  // `function f(a, b)`. Collected loosely on purpose — a name bound anywhere
  // is not the defect this looks for.
  for (const m of code.matchAll(/[({,[]\s*([A-Za-z_$][\w$]*)\s*(?=[,)}\]=:])/g)) declared.add(m[1]);
  for (const m of code.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) declared.add(name);
    }
  }

  const unknown = new Set();
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (JS_KEYWORDS.has(name) || PLATFORM_GLOBALS.has(name) || declared.has(name)) continue;
    unknown.add(name);
  }

  assert.deepEqual([...unknown].sort(), [],
    'these names are called in app.js but never defined, imported or bound — each one throws a ReferenceError the moment its branch runs');
});
