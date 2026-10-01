// marked-usage-guard.test.mjs — the vendored tokenizer is reachable through
// ONE door: `lib/markdown.mjs` importing exactly `{ Lexer }` and calling only
// `Lexer.lex(` (#1198, R1198-11, R1198-17). marked's own renderer and
// `marked.parse` emit HTML strings; the page never assigns markup, so the
// only safe use is the tokenizer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const UI_DIR = dirname(fileURLToPath(import.meta.url));
const DOOR = 'lib/markdown.mjs';

function sourcesUnder(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== 'vendor' && ent.name !== 'node_modules') sourcesUnder(full, out);
    } else if (/\.(mjs|js)$/.test(ent.name) && !ent.name.endsWith('.test.mjs')) {
      out.push(full);
    }
  }
  return out;
}

/** Blank comments and string bodies so prose never reads as code. */
function codeOnly(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1 '))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Returns the list of violations for one file's text. Exported shape: a
 *  function, so the self-tests can feed it injected sources. */
export function markedViolations(rel, text) {
  const bad = [];
  const code = codeOnly(text);
  const isDoor = rel === DOOR;
  // An IMPORT of the vendored file: `from '…marked.esm.js'` or `import('…marked.esm.js')`.
  // A path string elsewhere (server.mjs's allow-list entry) is not an import.
  const importsVendor = /\bfrom\s*['"][^'"]*marked\.esm\.js['"]|\bimport\s*\(?\s*['"][^'"]*marked\.esm\.js['"]/.test(code);

  if (importsVendor && !isDoor) bad.push(`${rel}: imports the vendored marked file, only ${DOOR} may`);
  if (isDoor) {
    for (const m of code.matchAll(/\bimport\s+([^;]*?)\bfrom\s*['"]([^'"]*marked[^'"]*)['"]/g)) {
      if (m[1].replace(/\s+/g, '') !== '{Lexer}') bad.push(`${rel}: imports "${m[1].trim()}" from marked, exactly { Lexer } is allowed`);
    }
    if (/\bimport\s*\(/.test(code)) bad.push(`${rel}: dynamic import`);
  }
  if (/\bmarked\s*\(/.test(code) || /\bmarked\./.test(code.replace(/marked\.esm\.js/g, ''))) bad.push(`${rel}: uses marked(...) or marked.*`);
  if (/\bparseInline\b/.test(code)) bad.push(`${rel}: parseInline`);
  for (const m of code.matchAll(/\bimport\s+[^;]*?\bfrom\s*['"]([^'"]+)['"]/g)) {
    if (/\bParser\b/.test(m[0])) bad.push(`${rel}: Parser in an import`);
    if (/^marked(\/|$)/.test(m[1])) bad.push(`${rel}: bare specifier "${m[1]}"`);
  }
  for (const m of code.matchAll(/\bLexer\.(\w*)/g)) {
    if (m[1] !== 'lex') bad.push(`${rel}: Lexer.${m[1]} — only Lexer.lex( is allowed`);
  }
  for (const m of code.matchAll(/([\w$.]*)\.parse\s*\(/g)) {
    if (m[1] !== 'JSON' && m[1] !== 'Date') bad.push(`${rel}: ${m[1] || '(no receiver)'}.parse( — only JSON.parse and Date.parse`);
  }
  return bad;
}

test('#1198: no ui source (outside vendor/ and tests) misuses the vendored tokenizer', () => {
  const files = sourcesUnder(UI_DIR);
  assert.ok(files.length > 10, 'the scan must actually see the ui sources');
  const bad = files.flatMap((f) => markedViolations(relative(UI_DIR, f), readFileSync(f, 'utf8')));
  assert.deepEqual(bad, []);
});

test('#1198 self-test: marked.parse(text) and a bare marked import are violations', () => {
  assert.notDeepEqual(markedViolations('lib/x.mjs', 'const h = marked.parse(text);'), []);
  assert.notDeepEqual(markedViolations('lib/x.mjs', "import { marked } from 'marked';"), []);
  assert.notDeepEqual(markedViolations('lib/x.mjs', "import { Lexer } from '../vendor/marked.esm.js';"), [], 'a non-door file');
});

test('#1198 self-test: the door itself is held to { Lexer } and Lexer.lex(', () => {
  const ok = "import { Lexer } from '../vendor/marked.esm.js';\nconst t = Lexer.lex(s, {});";
  assert.deepEqual(markedViolations(DOOR, ok), []);
  assert.notDeepEqual(markedViolations(DOOR, "import { Lexer, Parser } from '../vendor/marked.esm.js';"), []);
  assert.notDeepEqual(markedViolations(DOOR, "import * as m from '../vendor/marked.esm.js';"), []);
  assert.notDeepEqual(markedViolations(DOOR, ok + '\nLexer.lexInline(s);'), []);
  assert.notDeepEqual(markedViolations(DOOR, ok + "\nawait import('../vendor/marked.esm.js');"), []);
  assert.notDeepEqual(markedViolations(DOOR, ok + '\nthing.parse(x);'), []);
  assert.deepEqual(markedViolations(DOOR, ok + '\nJSON.parse(x); Date.parse(y);'), []);
});

test('#1198 R1198-11/17: the real door imports the vendored file by a path that resolves to ui/vendor/marked.esm.js, and app.js imports nothing named marked', () => {
  const door = readFileSync(join(UI_DIR, DOOR), 'utf8');
  const spec = /from\s*['"]([^'"]*marked[^'"]*)['"]/.exec(door)?.[1];
  assert.equal(spec, '../vendor/marked.esm.js');
  // Resolved the way the browser does it: /lib/markdown.mjs + ../vendor/... = /vendor/marked.esm.js,
  // which server.mjs serves from ui/vendor/.
  assert.equal(new URL(spec, 'http://x/lib/markdown.mjs').pathname, '/vendor/marked.esm.js');
  assert.ok(existsSync(join(UI_DIR, 'lib', spec)), 'and node resolves it to a real file');
  const app = readFileSync(join(UI_DIR, 'static', 'app.js'), 'utf8');
  assert.doesNotMatch(app, /from\s*['"][^'"]*marked[^'"]*['"]/, 'app.js reaches the tokenizer only through lib/markdown.mjs');
  assert.match(app, /from '\.\/lib\/markdown\.mjs'/);
});
