// markdown.test.mjs — the adapter between marked's tokenizer and the page's
// own tree (#1198). Every rule the maintainer ruled (R1 inert relative links,
// R5 html as text, R6 images as text) is applied HERE, so the DOM builder can
// stay a dumb walk over this tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownTree } from './markdown.mjs';

test('#1198 R5: an html token renders as literal text', () => {
  const { blocks } = markdownTree('<script>alert(1)</script>');
  assert.deepEqual(blocks, [{ t: 'literal', text: '<script>alert(1)</script>' }]);
});

import { safeHref } from './markdown.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const first = (md) => markdownTree(md).blocks[0];
const T = (text) => ({ t: 'text', text });

// ── block constructs: one test per mapping so deleting one fails its test ──

test('#1198 headings h1 to h4 keep their level', () => {
  const { blocks } = markdownTree('# a\n\n## b\n\n### c\n\n#### d');
  assert.deepEqual(blocks.map((b) => [b.t, b.level]), [['heading', 1], ['heading', 2], ['heading', 3], ['heading', 4]]);
  assert.deepEqual(blocks[0].children, [T('a')]);
});

test('#1198 a paragraph carries inline children', () => {
  assert.deepEqual(first('hello world'), { t: 'paragraph', children: [T('hello world')] });
});

test('#1198 lists nest: ul inside li, ol keeps its start', () => {
  const ul = first('- a\n  - b\n- c');
  assert.equal(ul.t, 'list');
  assert.equal(ul.ordered, false);
  assert.equal(ul.start, null);
  assert.equal(ul.items.length, 2);
  const nested = ul.items[0].blocks.find((b) => b.t === 'list');
  assert.equal(nested.items[0].blocks[0].children[0].text, 'b');
  const ol = first('3. x\n4. y');
  assert.deepEqual([ol.ordered, ol.start, ol.items.length], [true, 3, 2]);
  assert.equal(first('1. x').start, 1);
});

test('#1198 task items carry task and checked, with no literal [x] text', () => {
  const list = first('- [x] done\n- [ ] open\n- plain');
  assert.deepEqual(list.items.map((i) => [i.task, i.checked]), [[true, true], [true, false], [false, null]]);
  assert.ok(!JSON.stringify(list).includes('[x]'));
  assert.ok(!JSON.stringify(list).includes('[ ]'));
});

test('#1198 a GFM table keeps header, alignment and rows', () => {
  const table = first('| a | b |\n|:-|-:|\n| 1 | 2 |');
  assert.equal(table.t, 'table');
  assert.deepEqual(table.align, ['left', 'right']);
  assert.deepEqual(table.header, [[T('a')], [T('b')]]);
  assert.deepEqual(table.rows, [[[T('1')], [T('2')]]]);
});

test('#1198 fenced code stays verbatim: no markup is interpreted inside it', () => {
  const code = first('```js\n<b>x</b> **not bold**\n```');
  assert.deepEqual(code, { t: 'code', lang: 'js', text: '<b>x</b> **not bold**' });
  assert.ok(!('children' in code));
});

test('#1198 D13: a code lang is kept only when it is a plain token', () => {
  assert.equal(first('```c++\nx\n```').lang, 'c++');
  assert.equal(first('```" onclick="x\nx\n```').lang, null);
  assert.equal(first('```\nx\n```').lang, null);
});

test('#1198 blockquote and hr map to their blocks', () => {
  assert.deepEqual(first('> quoted'), { t: 'blockquote', blocks: [{ t: 'paragraph', children: [T('quoted')] }] });
  assert.deepEqual(markdownTree('a\n\n---\n\nb').blocks[1], { t: 'hr' });
});

test('#1198 an unsupported construct degrades to its literal source', () => {
  const { blocks } = markdownTree('[^1]: note');
  assert.deepEqual(blocks, [{ t: 'literal', text: '[^1]: note' }]);
});

// ── inline constructs, R6 images, html inline ────────────────────────────────

test('#1198 inline constructs: codespan, strong, em, del, br', () => {
  const kids = first('`c` **s** *e* ~~d~~ x  \ny').children;
  assert.deepEqual(kids.filter((k) => k.t !== 'text').map((k) => k.t), ['codespan', 'strong', 'em', 'del', 'br']);
  assert.deepEqual(kids.find((k) => k.t === 'codespan'), { t: 'codespan', text: 'c' });
  assert.deepEqual(kids.find((k) => k.t === 'strong').children, [T('s')]);
});

test('#1198 R1198-6: strikethrough maps to its own del element', () => {
  const kids = first('a ~~gone~~ b').children;
  assert.deepEqual(kids.find((k) => k.t === 'del').children, [T('gone')]);
});

test('#1198 R1198-6: a hard line break maps to its own br element', () => {
  assert.equal(first('line one  \nline two').children.filter((k) => k.t === 'br').length, 1);
});

test('#1198 R6: an image is its alt text and never carries the URL', () => {
  const tree = markdownTree('![architecture diagram](https://a.example/x.png) and ![](u)');
  assert.deepEqual(tree.blocks[0].children.filter((k) => k.t === 'text').map((k) => k.text), ['[image: architecture diagram]', ' and ', '[image: ]']);
  assert.ok(!JSON.stringify(tree).includes('a.example'));
  assert.ok(!JSON.stringify(tree).includes('"u"'));
});

test('#1198 R5: inline html tags are literal text and a comment stays visible', () => {
  const text = first('see <b>bold</b> now').children.map((k) => k.text).join('');
  assert.equal(text, 'see <b>bold</b> now');
  const note = markdownTree('<!-- note to self -->');
  assert.deepEqual(note.blocks, [{ t: 'literal', text: '<!-- note to self -->' }]);
});

// ── safeHref (R7/R8) ─────────────────────────────────────────────────────────

test('#1198 safeHref: http and https are the only live schemes', () => {
  assert.deepEqual(safeHref('https://a.example'), { ok: true, href: 'https://a.example/' });
  assert.deepEqual(safeHref('http://a.example/x?y=1'), { ok: true, href: 'http://a.example/x?y=1' });
});

test('#1198 safeHref: relative, anchor and refused schemes are classified, never live', () => {
  for (const rel of ['./design.md', 'x/y.md', '../other/spec.md', '//evil.example/']) {
    assert.deepEqual(safeHref(rel), { ok: false, reason: 'relative' }, rel);
  }
  assert.deepEqual(safeHref('#top'), { ok: false, reason: 'anchor' });
  for (const u of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'ftp://a.example/', 'file:///etc/passwd', 'mailto:a@b.c']) {
    assert.deepEqual(safeHref(u), { ok: false, reason: 'scheme' }, u);
  }
});

test('#1198 safeHref: obfuscated script schemes are never ok', () => {
  for (const u of [' javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'jav&#x61;script:alert(1)', '&#106;avascript:alert(1)', 'java%73cript:alert(1)', 'java\0script:alert(1)', '‮javascript:alert(1)', 'java\nscript:x']) {
    assert.equal(safeHref(u).ok, false, JSON.stringify(u));
  }
});

test('#1198 safeHref: credentials, empty hosts and non-strings are malformed', () => {
  assert.deepEqual(safeHref('https://github.com@evil.example'), { ok: false, reason: 'malformed' });
  assert.deepEqual(safeHref('https:///'), { ok: false, reason: 'malformed' });
  for (const v of [undefined, null, 42, {}]) assert.deepEqual(safeHref(v), { ok: false, reason: 'malformed' });
});

function links(md) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (n.t === 'link' || n.t === 'inert') out.push(n);
    for (const v of Object.values(n)) walk(v);
  };
  walk(markdownTree(md).blocks);
  return out;
}

test('#1198 R1: relative and anchor links are inert and show their path as text', () => {
  const [rel, anchor] = links('[spec](./spec.md) [top](#top)');
  assert.deepEqual(rel, { t: 'inert', target: './spec.md', children: [T('spec')] });
  assert.deepEqual(anchor, { t: 'inert', target: '#top', children: [T('top')] });
});

test('#1198 R7: an allowed link is live with the normalised href, a refused scheme is inert', () => {
  const [live, dead] = links('[a](https://a.example/p) [b](javascript:alert(1))');
  assert.deepEqual(live, { t: 'link', href: 'https://a.example/p', children: [T('a')] });
  assert.equal(dead.t, 'inert');
  assert.equal(dead.target, 'javascript:alert(1)');
});

test('#1198 R7: a javascript autolink and a javascript reference definition stay inert', () => {
  assert.ok(links('<javascript:alert(1)>').every((l) => l.t === 'inert'));
  assert.ok(links('[r]: javascript:alert(1)\n\n[click][r]').every((l) => l.t === 'inert'));
});

// ── frontmatter, depth, termination, determinism ────────────────────────────

test('#1198 D11: leading frontmatter is its own block and the rest is lexed', () => {
  const { blocks } = markdownTree('---\nstatus: draft\nissue: 1\n---\n\n# Title');
  assert.deepEqual(blocks[0], { t: 'frontmatter', text: 'status: draft\nissue: 1' });
  assert.equal(blocks[1].t, 'heading');
  assert.notEqual(markdownTree('---\nno close here').blocks[0].t, 'frontmatter');
});

function maxDepth(blocks) {
  let deepest = 0;
  const walk = (bs, d) => {
    for (const b of bs) {
      deepest = Math.max(deepest, d);
      if (b.t === 'blockquote') walk(b.blocks, d + 1);
      if (b.t === 'list') b.items.forEach((i) => walk(i.blocks, d + 1));
    }
  };
  walk(blocks, 1);
  return deepest;
}

test('#1198 D4: nesting is capped at 32, deeper content becomes literal', () => {
  const quotes = markdownTree('>'.repeat(40) + ' deep');
  assert.ok(maxDepth(quotes.blocks) <= 33);
  assert.ok(JSON.stringify(quotes).includes('"literal"'));
  const lists = markdownTree(Array.from({ length: 40 }, (_, i) => `${' '.repeat(i * 2)}- x`).join('\n'));
  assert.ok(maxDepth(lists.blocks) <= 33);
  assert.ok(JSON.stringify(lists).includes('"literal"'));
});

test('#1198 D4: an oversized document is shown as text with a notice, never handed to the tokenizer', () => {
  const out = markdownTree('x'.repeat(600000));
  assert.equal(out.blocks[0].t, 'code');
  assert.equal(out.notices.length, 1);
});

test('#1198 D4: 2000 levels of nesting terminate, either capped or degraded to text with a notice', () => {
  for (const input of ['>'.repeat(2000) + ' deep', Array.from({ length: 2000 }, (_, i) => `${' '.repeat(i * 2)}- x`).join('\n')]) {
    const out = markdownTree(input);
    assert.ok(out.blocks.length > 0);
    assert.ok(maxDepth(out.blocks) <= 33);
    assert.ok(JSON.stringify(out).includes('"literal"') || out.notices.length === 1);
  }
});

test('#1198 termination: pathological input returns quickly, never throws, never empty', () => {
  const inputs = ['['.repeat(50000), '*'.repeat(50000), '>'.repeat(10000), '```\nunclosed', '<!-- unclosed', `|${' a |'.repeat(1000)}\n|${'---|'.repeat(1000)}\n|${' b |'.repeat(1000)}`, '\0\0\0', '[a](', '[x](<', '| a | b |\n|---|', '\n', '   '];
  for (const input of inputs) {
    const t0 = performance.now();
    const out = markdownTree(input);
    assert.ok(performance.now() - t0 < 2000, `slow on ${JSON.stringify(input.slice(0, 20))}`);
    assert.ok(input.length === 0 || out.blocks.length > 0, `empty for ${JSON.stringify(input.slice(0, 20))}`);
  }
  assert.deepEqual(markdownTree('').blocks, []);
});

// Every string the tree would show: text-bearing fields, walked recursively.
function visibleText(node) {
  if (Array.isArray(node)) return node.map(visibleText).join(' ');
  if (node && typeof node === 'object') {
    return Object.entries(node).map(([k, v]) => (k === 't' || k === 'lang' ? '' : visibleText(v))).join(' ');
  }
  return typeof node === 'string' ? node : '';
}

test('#1198 R1198-13: malformed constructs degrade to text, the input\'s non-markup characters survive', () => {
  const cases = [
    ['```js\nunclosed', ['unclosed']],
    ['**unclosed', ['unclosed']],
    ['[a](', ['a']],
    ['| a | b |\n|---|', ['a', 'b']],
    ['[x](<', ['x']],
  ];
  for (const [input, words] of cases) {
    const shown = visibleText(markdownTree(input).blocks);
    for (const w of words) assert.ok(shown.includes(w), `${JSON.stringify(w)} lost for ${JSON.stringify(input)}; tree shows ${JSON.stringify(shown)}`);
  }
});

test('#1198 D4: a tokenizer that throws degrades to one code block plus a notice', () => {
  const out = markdownTree('# hello', () => { throw new RangeError('boom'); });
  assert.deepEqual(out.blocks, [{ t: 'code', lang: null, text: '# hello' }]);
  assert.equal(out.notices.length, 1);
});

test('#1198 R3 corollary: a 262144-byte table document still returns elements', () => {
  const row = '| a | b |\n';
  const md = '| h | i |\n|---|---|\n' + row.repeat(Math.floor(262144 / row.length));
  assert.equal(markdownTree(md).blocks[0].t, 'table');
});

function realArtifacts() {
  const root = join(HERE, '..', '..', '..', '..', 'openspec', 'changes');
  if (!existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root)) {
    if (dir === 'archive') continue;
    for (const f of ['proposal.md', 'spec.md', 'design.md', 'tasks.md']) {
      const p = join(root, dir, f);
      if (existsSync(p)) out.push(readFileSync(p, 'utf8'));
    }
  }
  return out;
}

test('#1198 determinism: the same text gives a deep-equal tree, across calls and a fresh import', async () => {
  const fresh = await import(`./markdown.mjs?fresh=${Date.now()}`);
  const docs = realArtifacts();
  assert.ok(docs.length > 0, 'the repo carries at least this change’s own artifacts');
  for (const text of docs) {
    const a = markdownTree(text);
    assert.deepEqual(markdownTree(text), a);
    assert.deepEqual(fresh.markdownTree(text), a);
  }
});

test('#1198 determinism: the adapter source reads no clock, randomness or environment', () => {
  const src = readFileSync(join(HERE, 'markdown.mjs'), 'utf8');
  for (const needle of ['Date', 'Math.random', 'performance.now', 'process.env']) {
    assert.ok(!src.includes(needle), `markdown.mjs mentions ${needle}`);
  }
});

// ── the hostile fixture, asserted on the tree (R7 to R10) ───────────────────

test('#1198 XSS fixture: no node carries an href but an http(s) one, and the script text survives as text', () => {
  const fixture = readFileSync(join(HERE, '..', 'test-support', 'fixtures', 'markdown-xss.txt'), 'utf8');
  const tree = markdownTree(fixture);
  const hrefs = [];
  const texts = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if ('href' in n) hrefs.push(n.href);
    if (typeof n.text === 'string') texts.push(n.text);
    for (const v of Object.values(n)) walk(v);
  };
  walk(tree.blocks);
  assert.ok(hrefs.length >= 2, 'the fixture really contains live links');
  for (const h of hrefs) assert.match(h, /^https?:\/\//);
  const all = texts.join('\n');
  assert.ok(all.includes('<script>alert(\'raw-script\')</script>'));
  assert.ok(all.includes('<img src=x onerror=alert(1)>'));
  assert.ok(all.includes('<!-- <script>alert(\'commented\')</script> -->'));
  assert.ok(all.includes('<style>'));
  assert.ok(!JSON.stringify(tree).includes('"t":"image"'));
  assert.ok(!hrefs.some((h) => /evil\.example/.test(h)), 'credentials and protocol-relative links are never live');
});
