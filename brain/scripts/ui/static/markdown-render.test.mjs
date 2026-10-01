// markdown-render.test.mjs — an SDD stage row expands into its document, drawn
// by the REAL app.js on the fake DOM (#1198). The hostile fixture is the
// proposal, so every assertion about elements, attributes and links is made
// on what the page actually built, not on the tree that fed it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSnapshot } from '../../status/snapshot.mjs';
import { buildChangeView } from '../change-route.mjs';
import { testTmp } from '../../lib/test-tmp.mjs';
import { installDom, fire, find, findAll, byClass } from '../test-support/dom.mjs';
import { loadApp, settle } from '../test-support/load-app.mjs';
import { fakeGit } from '../test-support/fake-git.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const XSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'test-support', 'fixtures', 'markdown-xss.txt'), 'utf8');
const MOUNT_IDS = ['status', 'modes', 'search', 'banners', 'governance-nav', 'canvas', 'drawer'];
const ISSUE = 1198;
const DIR = 'openspec/changes/issue-1198-sdd-artifact-reader';
const HEAD = 'abc1234'.padEnd(40, '0');
const TIP = 'def5678'.padEnd(40, '0');
const BRANCH = 'feat/issue-1198-reader';
const ISSUES = [{ number: ISSUE, title: 'feat(ui): every SDD artifact is readable', labels: ['status:approved'], body: ['## What it is', '', '```brain-graph/1', 'track:    UI', 'blocks:   []', 'needs:    []', '```', ''].join('\n') }];

const RICH = [
  '# Title', '', 'para with `code` and **bold** and [rel](./design.md)', '',
  '- [x] done', '- [ ] open', '', '3. three', '4. four', '',
  '| a | b |', '|:-|-:|', '| 1 | 2 |', '', '> quote', '', '---', '', '```js', '<b>raw</b>', '```', '',
  'struck ~~gone~~ then a hard break  ', 'next line', '',
].join('\n');

async function boot({ proposal = XSS, resume = '---\nnext_action: go\n---\n\nresume **body**\n', design } = {}) {
  const root = testTmp('md-render-');
  writeFileSync(join(root, 'brain.config.json'), readFileSync(join(REPO, 'brain.config.json'), 'utf8'));
  mkdirSync(join(root, DIR), { recursive: true });
  const files = { [`${DIR}/proposal.md`]: proposal, [`${DIR}/spec.md`]: '# Spec\n', [`${DIR}/tasks.md`]: '- [x] a\n' };
  if (design !== undefined) files[`${DIR}/design.md`] = design;
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  const vcs = {
    async issueList() { return ISSUES.map(({ number, title, labels }) => ({ number, title, labels, assignees: [] })); },
    async issueView() { return { body: ISSUES[0].body, assignees: [] }; },
  };
  const snapshot = await buildSnapshot({ root, project: 'csrinaldi/brain', vcs, now: '2026-09-19T12:00:00.000Z', _run: () => { throw new Error('no git'); } });
  const run = fakeGit({ files, head: HEAD, branches: { [BRANCH]: { commit: TIP, files: resume === null ? {} : { 'resume.md': resume } } } });
  snapshot.prs = { ok: true, value: [{ number: 5, title: 'x', headBranch: BRANCH, issue: ISSUE }] };
  const changes = { [ISSUE]: buildChangeView({ root, issue: ISSUE, snapshot, _run: run }) };
  const dom = installDom({ mountIds: MOUNT_IDS, snapshot, changes });
  await loadApp();
  await settle();
  return dom;
}

async function openSdd(dom) {
  const card = findAll(dom.mounts.canvas, byClass('node-card')).find((c) => c.getAttribute('data-issue') === String(ISSUE));
  fire(card, 'click');
  await settle();
  const tabs = find(dom.mounts.drawer, byClass('tabs'));
  fire(tabs.childNodes.find((b) => b.textContent.includes('SDD')), 'click');
  await settle();
}

const rows = (dom) => findAll(dom.mounts.drawer, byClass('card'));
const toggleOf = (dom, name) => {
  const row = rows(dom).find((r) => find(r, byClass('stage-name'))?.textContent === name);
  return { row, button: row && find(row, byClass('doc-toggle')) };
};
const all = (root) => findAll(root, () => true);

test('#1198 R1198-1/2: a readable document gets a native toggle; missing and unreadable say so and get no button', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());
  await openSdd(dom);

  const proposal = toggleOf(dom, 'proposal');
  assert.equal(proposal.button.tagName, 'BUTTON');
  assert.equal(proposal.button.getAttribute('aria-expanded'), 'false');
  assert.equal(proposal.button.getAttribute('aria-controls'), `doc-${ISSUE}-proposal`);

  const design = toggleOf(dom, 'design');
  assert.equal(design.button, null);
  assert.match(design.row.textContent, /design\.md is not committed at HEAD/);
  const archive = toggleOf(dom, 'archive');
  assert.equal(archive.button, null, 'archive is a stage, not a document');
  assert.doesNotMatch(archive.row.textContent, /not committed|could not be read/);
  assert.equal(findAll(dom.mounts.drawer, byClass('tabs'))[0].childNodes.length, 6, 'no tab was added');
});

test('#1198 R1198-1/5/16: expanding appends a labelled region with stamp, path and commit; collapsing removes it; the drawer is not re-rendered', async (t) => {
  const dom = await boot({ proposal: RICH });
  t.after(() => dom.restore());
  await openSdd(dom);

  const { row, button } = toggleOf(dom, 'proposal');
  assert.equal(find(row, (n) => n.tagName === 'SECTION'), null, 'lazy: nothing rendered before the first expansion');
  const drawerBefore = dom.mounts.drawer.childNodes.length;
  fire(button, 'click');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  const region = find(row, (n) => n.tagName === 'SECTION');
  assert.equal(region.getAttribute('role'), 'region');
  assert.equal(region.getAttribute('id'), `doc-${ISSUE}-proposal`);
  const stamp = `${DIR}/proposal.md @ ${HEAD.slice(0, 12)}`;
  assert.equal(region.getAttribute('aria-label'), stamp);
  assert.match(region.textContent, new RegExp(`${DIR}/proposal\\.md`));
  assert.match(region.textContent, new RegExp(HEAD.slice(0, 12)));
  assert.equal(dom.mounts.drawer.childNodes.length, drawerBefore, 'the click toggled in place and did not rebuild the drawer');
  assert.ok(row.parentNode, 'the row node itself survived, so focus survives');

  fire(button, 'click');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(find(row, (n) => n.tagName === 'SECTION'), null);
});

test('#1198 R1198-16: the expanded state survives a drawer re-render (a tab switch and back)', async (t) => {
  const dom = await boot({ proposal: RICH });
  t.after(() => dom.restore());
  await openSdd(dom);
  fire(toggleOf(dom, 'proposal').button, 'click');
  const tabs = find(dom.mounts.drawer, byClass('tabs')).childNodes;
  fire(tabs.find((b) => b.textContent.includes('Tasks')), 'click');
  fire(find(dom.mounts.drawer, byClass('tabs')).childNodes.find((b) => b.textContent.includes('SDD')), 'click');
  const again = toggleOf(dom, 'proposal');
  assert.equal(again.button.getAttribute('aria-expanded'), 'true');
  assert.ok(find(again.row, (n) => n.tagName === 'SECTION'));
});

test('#1198 R1198-6: the page maps blocks to elements — headings, lists, task marks, tables, code, quote, hr, del, br, inert links', async (t) => {
  const dom = await boot({ proposal: RICH });
  t.after(() => dom.restore());
  await openSdd(dom);
  const { row, button } = toggleOf(dom, 'proposal');
  fire(button, 'click');
  const tags = (tag) => findAll(row, (n) => n.tagName === tag);
  assert.equal(tags('H3').length, 1, 'a level-1 heading is h3, under the drawer title');
  assert.equal(tags('OL')[0].getAttribute('start'), '3');
  assert.equal(tags('UL').length, 1);
  assert.deepEqual(findAll(row, byClass('md-task')).map((n) => n.textContent.trim()), ['☑', '☐']);
  assert.ok(find(row, (n) => n.tagName === 'THEAD'));
  assert.ok(find(row, (n) => n.tagName === 'TBODY'));
  assert.ok(find(row, byClass('md-align-left')) && find(row, byClass('md-align-right')));
  assert.equal(tags('BLOCKQUOTE').length, 1);
  assert.equal(tags('HR').length, 1);
  assert.equal(tags('PRE')[0].textContent, '<b>raw</b>');
  assert.equal(tags('B').length, 0, 'fenced code interprets nothing');
  assert.equal(tags('DEL').length, 1, 'strikethrough is part of the R1198-6 subset');
  assert.equal(tags('DEL')[0].textContent, 'gone');
  assert.equal(tags('BR').length, 1, 'a hard line break is part of the R1198-6 subset');
  const inert = find(row, byClass('md-inert'));
  assert.match(inert.textContent, /rel/);
  assert.equal(find(inert, (n) => n.tagName === 'CODE').textContent, './design.md');
  assert.equal(findAll(row, (n) => n.tagName === 'A').length, 0, 'a relative link is not a link');
  for (const n of all(row)) assert.equal(n.getAttribute?.('title') ?? null, null);
});

test('#1198 R1198-7 to 10/12: the hostile fixture builds no active element, no handler, no style, and only https links', async (t) => {
  const dom = await boot({ proposal: XSS });
  t.after(() => dom.restore());
  await openSdd(dom);
  const { row, button } = toggleOf(dom, 'proposal');
  fire(button, 'click');

  const nodes = all(row);
  for (const n of nodes) {
    assert.ok(!['SCRIPT', 'IMG', 'IFRAME', 'STYLE', 'OBJECT', 'EMBED', 'INPUT'].includes(n.tagName), `${n.tagName} must never be built`);
    for (const name of Object.keys(n.attributes ?? {})) {
      assert.ok(!/^on/i.test(name), `attribute ${name}`);
      assert.notEqual(name, 'style');
    }
  }
  const anchors = nodes.filter((n) => n.tagName === 'A');
  assert.ok(anchors.length >= 2, 'the fixture has live links');
  for (const a of anchors) {
    assert.match(a.getAttribute('href'), /^https?:\/\//);
    assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(a.getAttribute('target'), '_blank');
    assert.equal(a.getAttribute('referrerpolicy'), 'no-referrer');
  }
  const text = row.textContent;
  assert.ok(text.includes("<script>alert('raw-script')</script>"), 'the script text is visible, as text');
  assert.ok(text.includes('<img src=x onerror=alert(1)>'));
  assert.ok(text.includes('javascript:alert(1)'), 'a refused link shows its target as text');
  assert.ok(text.includes('[image: img]'));
  assert.ok(!anchors.some((a) => /javascript|evil\.example/.test(a.getAttribute('href'))));
});

test('#1198 R1198-14: two renders of the same input build the same structure', async (t) => {
  const shape = (n) => ({ tag: n.tagName, cls: n.className, text: n.childNodes.length === 0 ? n.textContent : undefined, attrs: n.attributes && { ...n.attributes }, kids: n.childNodes.map(shape) });
  const a = await boot({ proposal: RICH });
  await openSdd(a);
  fire(toggleOf(a, 'proposal').button, 'click');
  const first = shape(find(toggleOf(a, 'proposal').row, (n) => n.tagName === 'SECTION'));
  a.restore();
  const b = await boot({ proposal: RICH });
  t.after(() => b.restore());
  await openSdd(b);
  fire(toggleOf(b, 'proposal').button, 'click');
  assert.deepEqual(shape(find(toggleOf(b, 'proposal').row, (n) => n.tagName === 'SECTION')), first);
});

test('#1198 R1198-3: a truncated document shows the note beside its text', async (t) => {
  const dom = await boot({ design: `# Big\n${'x'.repeat(300000)}\n` });
  t.after(() => dom.restore());
  await openSdd(dom);
  const { row, button } = toggleOf(dom, 'design');
  fire(button, 'click');
  assert.match(find(row, (n) => n.tagName === 'SECTION').textContent, /truncated at 262144 bytes/);
});

test('#1198 D10: resume.md is reachable from the SDD tab as an unnumbered row and renders its body as markdown', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());
  await openSdd(dom);
  const row = rows(dom).find((r) => /working memory/.test(r.textContent));
  assert.ok(row, 'the resume row exists');
  assert.equal(find(row, byClass('stage-number')), null, 'unnumbered');
  fire(find(row, byClass('doc-toggle')), 'click');
  const region = find(row, (n) => n.tagName === 'SECTION');
  assert.match(region.textContent, /next_action: go/, 'the frontmatter is shown');
  assert.ok(find(region, (n) => n.tagName === 'STRONG'), 'the body is markdown');
  assert.match(region.getAttribute('aria-label'), new RegExp(`resume\\.md @ ${TIP.slice(0, 12)}`));
});

test('#1198 R1198-2: a branch with no resume.md says it is not committed, with no toggle', async (t) => {
  const dom = await boot({ resume: null });
  t.after(() => dom.restore());
  await openSdd(dom);
  const row = rows(dom).find((r) => /working memory/.test(r.textContent));
  assert.match(row.textContent, new RegExp(`resume\\.md is not committed at ${BRANCH}`));
  assert.equal(find(row, byClass('doc-toggle')), null);
});
