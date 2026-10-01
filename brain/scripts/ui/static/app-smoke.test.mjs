// app-smoke.test.mjs — the page is RUN, not scanned (#1059).
//
// `app-source-guard.test.mjs` asserts what the page's source may contain. This
// file asserts that the page WORKS: it boots the real `static/app.js` against
// a real snapshot, renders every mode, and activates the controls a reader
// activates. Three defects shipped in #1059 that no scan could have seen, and
// every one of them is a one-line failure here.
//
// THE FIXTURE IS NOT INVENTED. The data comes out of `status/snapshot.mjs` —
// the same builder `server.mjs` serves — fed by issue BODIES, which is the
// text a maintainer actually writes. Nothing in this file describes the shape
// of a node or a change; the production readers decide that. The defect this
// harness exists to catch was caused by a test that invented a shape and then
// asserted only the fields every shape happened to share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSnapshot } from '../../status/snapshot.mjs';
import { buildChangeView } from '../change-route.mjs';
import { testTmp } from '../../lib/test-tmp.mjs';
import { MODES } from '../lib/view-model.mjs';
import { GOVERNANCE_VIEWS } from '../lib/governance-model.mjs';
import { installDom, fire, find, findAll, byClass } from '../test-support/dom.mjs';
import { loadApp, settle } from '../test-support/load-app.mjs';
import { fakeGit } from '../test-support/fake-git.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
// The ids `index.html` carries. A mount the page reads and this list omits
// comes back null and the page throws, which is the correct failure: the two
// files are one contract.
const MOUNT_IDS = ['status', 'modes', 'search', 'banners', 'governance-nav', 'canvas', 'drawer'];

/** The declaration block exactly as it is written in an issue body. */
function fence(lines) {
  return ['## What it is', '', 'Prose the parser must step over.', '', '```brain-graph/1', ...lines, '```', ''].join('\n');
}

const ISSUES = [
  {
    number: 878, title: 'epic(ui): Brain UI — the project\'s state', labels: ['type:feature', 'status:approved'],
    body: fence(['kind:     epic', 'track:    UI', 'tracker:  feature/brain-ui', 'blocks:   []', 'needs:    []']),
  },
  {
    number: 1059, title: 'feat(ui): the page is built from the design', labels: ['status:approved'],
    body: fence(['track:    UI', 'parent:   878', 'blocks:   []', 'needs:    []']),
  },
  {
    number: 1032, title: 'feat(ui): the lanes group by epic', labels: [],
    body: fence(['track:    UI', 'parent:   878', 'blocks:   []', 'needs:    [1059]']),
  },
  {
    number: 907, title: 'fix(governance): a check with no declared track', labels: [],
    body: 'This issue declares nothing at all, which is the `?` holding lane.\n',
  },
  // A DIFFERENT track that needs a UI ticket. The page never draws a line
  // across lanes (R998-3: they share no coordinate space), it SAYS the edge —
  // and saying it is what calls `saidList`, the helper that was missing.
  {
    number: 1024, title: 'fix(governance): the memory gate reads the PR context', labels: [],
    body: fence(['track:    GOVERNANCE', 'blocks:   []', 'needs:    [1059]']),
  },
  // Declares a PARENT but no track: the `?` batch holds it in track mode, and
  // its epic claims it in epic mode. It must never be on screen twice (#1079).
  {
    number: 921, title: 'feat(ui): a slice that declared no track', labels: [],
    body: fence(['parent:   878', 'blocks:   []', 'needs:    []']),
  },
  // A body the forge will not hand over. The node still enters the graph with
  // what the LIST said, and the page must say the body is unknown rather than
  // draw it as an issue that declared nothing.
  { number: 953, title: 'feat(vcs): a body this harness refuses to serve', labels: [], body: null },
];

const VCS = {
  async issueList() { return ISSUES.map(({ number, title, labels }) => ({ number, title, labels, assignees: [] })); },
  async issueView({ number }) {
    const issue = ISSUES.find((i) => i.number === number);
    if (!issue) throw new Error(`no such issue #${number}`);
    if (issue.body === null) throw new Error('the forge refused this body');
    return { body: issue.body, assignees: [] };
  },
};

/** A repository with just enough on disk for the readers to have something true to say. */
function fixtureRepo() {
  const root = testTmp('ui-smoke-repo-');
  writeFileSync(join(root, 'brain.config.json'), readFileSync(join(REPO, 'brain.config.json'), 'utf8'));
  const change = join(root, 'openspec', 'changes', 'issue-1059-design-structure');
  mkdirSync(change, { recursive: true });
  writeFileSync(join(change, 'proposal.md'), '# Proposal\n');
  // A requirement the grammar reads, and beneath it a WHEN/THEN pair whose
  // author forgot the scenario heading. The page must show the orphan rather
  // than drop it (#1067 cold review, finding cold-1).
  writeFileSync(join(change, 'spec.md'), [
    '# Spec',
    '',
    '### R1059-1: a requirement the grammar reads',
    '#### Scenario: it is attached',
    '- **WHEN** a scenario heading is present',
    '- **THEN** the pair attaches to it.',
    '',
    '### R1059-2: a requirement whose author forgot the heading',
    '',
    '- **WHEN** nobody wrote a scenario heading',
    '- **THEN** the line belongs to no scenario.',
    '',
  ].join('\n'));
  writeFileSync(join(change, 'design.md'), '# Design\n');
  writeFileSync(join(change, 'tasks.md'), '# Tasks\n\n- [x] one\n- [ ] two\n');

  // The memory ledger, in the shape `.memory/records` really holds: one JSON
  // object per line. `snapshot.mjs`'s own reader turns these into the records
  // section, so nothing here describes what a record looks like to the page.
  const records = join(root, '.memory', 'records');
  mkdirSync(records, { recursive: true });
  writeFileSync(join(records, '2026-09-rec-aaaa.jsonl'),
    `${JSON.stringify({ id: 'rec-aaaa', ts: '2026-09-18T22:10:52Z', actor: 'feat/issue-1059-design', actorKind: 'agent', type: 'architecture', project: 'brain', content: 'a decision' })}\n`);
  writeFileSync(join(records, '2026-09-rec-bbbb.jsonl'),
    `${JSON.stringify({ id: 'rec-bbbb', ts: '2026-09-17T09:00:00Z', actor: '@legacy', actorKind: 'human', type: 'bugfix', project: 'brain', content: 'a fix' })}\n`);
  return root;
}

async function boot({ issues = ISSUES } = {}) {
  const root = fixtureRepo();
  const vcs = {
    async issueList() { return issues.map(({ number, title, labels }) => ({ number, title, labels, assignees: [] })); },
    async issueView({ number }) {
      const issue = issues.find((i) => i.number === number);
      if (!issue) throw new Error(`no such issue #${number}`);
      if (issue.body === null) throw new Error('the forge refused this body');
      return { body: issue.body, assignees: [] };
    },
  };
  const snapshot = await buildSnapshot({
    root,
    project: 'csrinaldi/brain',
    vcs,
    now: '2026-09-19T12:00:00.000Z',
    // No git in a temp directory, and a harness must not depend on one.
    _run: () => { throw new Error('git is not available in this harness'); },
  });
  // The panel's body comes from `GET /api/change/<n>`, which the server
  // answers with `buildChangeView`. The harness answers it with the SAME
  // builder over the same fixture repo, so the panel's tabs are the shapes
  // the production reader really emits — not a hand-written stand-in.
  //
  // Artifacts are read from the object store (#1198), so the harness commits
  // the fixture's files into an in-memory git rather than leaving them for a
  // working-tree read the route no longer makes.
  const changeDir = 'openspec/changes/issue-1059-design-structure';
  const committed = {};
  for (const name of ['proposal.md', 'spec.md', 'design.md', 'tasks.md']) {
    committed[`${changeDir}/${name}`] = readFileSync(join(root, changeDir, name), 'utf8');
  }
  const changes = {};
  for (const issue of [1059]) {
    changes[issue] = buildChangeView({
      root,
      issue,
      snapshot,
      _run: fakeGit({ files: committed, head: 'abc1234'.padEnd(40, '0') }),
    });
  }

  const dom = installDom({ mountIds: MOUNT_IDS, snapshot, changes });
  await loadApp();
  await settle();
  return dom;
}

const cards = (dom) => findAll(dom.mounts.canvas, byClass('node-card'));
const cardFor = (dom, issue) => cards(dom).find((c) => c.getAttribute('data-issue') === String(issue));

/**
 * The mode control, found by the LABEL the table declares — `view-model.mjs`
 * is the single source of those words, and a `data-mode` attribute invented
 * here would be a second one that the page does not have to keep true.
 */
function modeButton(dom, id) {
  const label = MODES.find((m) => m.id === id)?.label;
  assert.ok(label, `${id} is a real mode`);
  const button = find(dom.mounts.modes, (n) => n.tagName === 'BUTTON' && n.textContent.includes(label));
  assert.ok(button, `the ${id} mode has a control reading "${label}"`);
  return button;
}

test('#1059 smoke: the page boots against a real snapshot and draws the board', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  assert.ok(dom.mounts.status.childNodes.length > 0, 'the status bar drew');
  assert.ok(dom.mounts.modes.childNodes.length > 0, 'the mode bar drew');
  // Three issues declare a track and become cards; the fourth declares
  // nothing and belongs to the `?` holding lane, which the design draws as a
  // batch of tiles rather than as cards (#1059 phase 5).
  assert.equal(cards(dom).length, 4, `every issue that declared a track became a card, drawn: ${cards(dom).length}`);
  const count = find(dom.mounts.canvas, byClass('batch-count'));
  assert.ok(count, 'the holding lane states its own proportion');
  assert.match(count.textContent, /3 of 7 open issues/, 'and the proportion is of the whole graph, not of the lane');

  // It opens collapsed, so the tiles are behind the toggle — which makes this
  // the cheapest place to prove the toggle is wired at all.
  assert.equal(findAll(dom.mounts.canvas, byClass('batch-tile')).length, 0, 'collapsed, so no tiles yet');
  fire(find(dom.mounts.canvas, byClass('lane-toggle')), 'click');
  const batch = findAll(dom.mounts.canvas, byClass('batch-tile'));
  assert.equal(batch.length, 3, 'expanded, the issues with no declared track are tiles — never silently missing');
  assert.match(batch.map((t) => t.textContent).join(' '), /#907/);

  // `saidList` was called in seven places and defined in none, and nothing
  // caught it because no fixture ever reached one of those branches. These
  // two are the cheapest of the seven to provoke, and they run on every boot.
  const board = dom.mounts.canvas.textContent;
  assert.match(board, /edge\(s\) cross lanes/, 'a cross-lane edge is said, because it is never drawn');
  assert.match(board, /#1059 → #1024 crosses lanes UI → GOVERNANCE/, 'and it names both ends and both lanes — the edge points from the blocker to the blocked');
  assert.match(board, /issue body\(ies\) could not be read/, 'a body the forge refused is stated, never rendered as "declared nothing"');
  assert.match(board, /#953/);

  // The exact defect that shipped: `sddForIssue` returned the raw snapshot
  // entry, `renderNodeSdd` read a `stages` it does not carry, and the throw
  // took `renderLanes` down with it — a blank board, not a failing test.
  const card = cardFor(dom, 1059);
  assert.ok(card, 'the issue that owns a change directory is on the board');
  assert.match(card.textContent, /tasks 1\/2/, 'its strip counts the change directory\'s ticked tasks');
});

test('#1059 smoke: clicking a ticket opens its panel, from every mode', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  assert.equal(dom.mounts.drawer.hidden, true, 'nothing is selected yet, so no panel');

  fire(cardFor(dom, 878), 'click');
  await settle();
  assert.equal(dom.mounts.drawer.hidden, false, 'the panel opened');
  assert.match(dom.mounts.drawer.textContent, /#878/, 'and it is about the ticket that was clicked');

  // The epic's children are declared BY THE CHILDREN, so the panel's list is
  // whoever points at it (#1059 phase 10).
  assert.match(dom.mounts.drawer.textContent, /#1059/, 'the panel lists the tickets that declare this one as their parent');
  assert.match(dom.mounts.drawer.textContent, /#1032/);

  // The defect the maintainer hit: a mode is about the PROJECT, a panel is
  // about a TICKET, so switching mode may not shut the panel.
  for (const mode of ['governance', 'memory', 'map']) {
    fire(modeButton(dom, mode), 'click');
    await settle();
    assert.equal(dom.mounts.drawer.hidden, false, `the panel survives the ${mode} mode — closing it is the reader's own control`);
  }
});

test('#1059 smoke: every mode renders without throwing, and the theme control takes', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  for (const mode of ['governance', 'memory', 'map']) {
    fire(modeButton(dom, mode), 'click');
    await settle();
    assert.ok(dom.mounts.canvas.childNodes.length > 0, `the ${mode} mode drew something — an empty area is the one thing this page never shows`);
  }

  const select = find(dom.mounts.status, (n) => n.tagName === 'SELECT');
  assert.ok(select, 'the theme control is in the status bar');
  select.value = 'dark';
  fire(select, 'change');
  assert.equal(dom.documentElement.getAttribute('data-theme'), 'dark', 'an explicit choice stamps the document');
  assert.equal(dom.storage.get('brain:ui:theme'), 'dark', 'and it is remembered for the next visit');
});

test('#1059 smoke: the finder finds a ticket by number and by title, and opens it', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  const input = find(dom.mounts.search, (n) => n.tagName === 'INPUT');
  assert.ok(input, 'the finder has a field');

  const hits = () => findAll(dom.mounts.search, byClass('search-hit'));
  assert.equal(hits().length, 0, 'nothing is asked yet, so nothing is listed');
  assert.match(dom.mounts.search.textContent, /type an issue number/, 'and the page says what to type instead of showing a blank area');

  // By number.
  input.value = '1059';
  fire(input, 'input');
  assert.equal(hits().length, 1, 'an exact issue number is one hit');
  assert.match(hits()[0].textContent, /#1059/);

  // By a word in the title, across issues.
  input.value = 'lanes';
  fire(input, 'input');
  assert.ok(hits().length >= 1, 'a word from a title finds it');
  assert.match(hits().map((h) => h.textContent).join(' '), /#1032/);

  // The unreadable node is findable, and says why it is unreadable rather
  // than being dropped from the list.
  input.value = '953';
  fire(input, 'input');
  assert.equal(hits().length, 1);
  assert.match(hits()[0].textContent, /could not be read/, 'an issue whose body the forge refused is still findable, with its reason');

  // A query that matches nothing says so.
  input.value = 'zzzzz-nothing-matches-this';
  fire(input, 'input');
  assert.equal(hits().length, 0);
  assert.match(dom.mounts.search.textContent, /no epic, tracker, or ticket matches/);

  // Clicking a hit opens that ticket's panel — the same panel a card opens.
  input.value = '878';
  fire(input, 'input');
  fire(hits()[0], 'click');
  await settle();
  assert.equal(dom.mounts.drawer.hidden, false, 'the finder opens the panel');
  assert.match(dom.mounts.drawer.textContent, /#878/);
});

test('#1059 smoke: the finder survives a re-render, and says epics are not data yet', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  const input = find(dom.mounts.search, (n) => n.tagName === 'INPUT');
  input.value = '10';
  fire(input, 'input');
  const before = findAll(dom.mounts.search, byClass('search-hit')).length;
  assert.ok(before > 0, 'a number prefix matches');

  // THE TRAP THIS GUARDS. The status bar re-renders on a five-second clock
  // and `render()` runs on every stream frame. If the finder were rebuilt by
  // either, the caret and the half-typed query would vanish under the
  // reader's hands. The input must be the SAME element afterwards.
  fire(modeButton(dom, 'governance'), 'click');
  await settle();
  const after = find(dom.mounts.search, (n) => n.tagName === 'INPUT');
  assert.equal(after, input, 'the field is the same element across a full render — never rebuilt');
  assert.equal(after.value, '10', 'so the query survives');

  // The maintainer's ask, literally: find the epic. #878 declares
  // `kind: epic` and a tracker branch in its body, so the result must say
  // both — from the declaration, never guessed from the word in the title.
  input.value = '878';
  fire(input, 'input');
  const epic = findAll(dom.mounts.search, byClass('search-hit'))[0];
  assert.ok(epic, 'the epic is findable by its number');
  assert.match(epic.textContent, /epic/, 'and the row says it is an epic');
  assert.match(epic.textContent, /tracker feature\/brain-ui/, 'and names the branch the epic declared');

  // A ticket that declares neither is not decorated as one.
  input.value = '1032';
  fire(input, 'input');
  const ticket = findAll(dom.mounts.search, byClass('search-hit'))[0];
  assert.ok(!/tracker /.test(ticket.textContent), 'a ticket claims no tracker it never declared');
});

test('#1059 smoke: asked for an epic in a graph that declares none, the finder says why — and stays quiet otherwise', async (t) => {
  // The live snapshot is exactly this graph: 95 nodes, `kind` and `tracker`
  // null on every one of them, because no issue body has declared either yet.
  const undeclared = ISSUES.map((i) => (i.body === null ? i : { ...i, body: i.body.replace(/^kind:.*\n/m, '').replace(/^tracker:.*\n/m, '') }));
  const dom = await boot({ issues: undeclared });
  t.after(() => dom.restore());

  const input = find(dom.mounts.search, (n) => n.tagName === 'INPUT');

  input.value = 'epic';
  fire(input, 'input');
  const asked = dom.mounts.search.textContent;
  assert.match(asked, /no issue body has declared one yet/, 'asked for an epic, the page states the absence instead of answering an empty list');
  assert.match(asked, /#1032 is the ticket/, 'and names the ticket that makes kind, parent and tracker real data');

  // A sentence about `kind` under every search for a title is noise, and
  // noise is how a real statement stops being read.
  input.value = 'memory';
  fire(input, 'input');
  assert.ok(!/no issue body has declared one yet/.test(dom.mounts.search.textContent),
    'a query that never mentioned epics or trackers gets no lecture about them');
});

test('#1059: every governance sub-view draws, including the two that came down from the top level', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  fire(modeButton(dom, 'governance'), 'click');
  await settle();

  const buttons = findAll(dom.mounts['governance-nav'], (n) => n.tagName === 'BUTTON');
  assert.equal(buttons.length, GOVERNANCE_VIEWS.length, 'the sub-nav IS the table, never a second copy of it');

  for (const sub of GOVERNANCE_VIEWS) {
    const button = buttons.find((b) => b.textContent.includes(sub.label));
    assert.ok(button, `the ${sub.id} sub-view has a control reading "${sub.label}"`);
    fire(button, 'click');
    await settle();
    assert.ok(dom.mounts.canvas.childNodes.length > 0,
      `the ${sub.id} sub-view drew something — an empty pane is the one thing this page never shows`);
  }
});

test('#1059: the Memory mode leads with the ledger summary and lists the records', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  fire(modeButton(dom, 'memory'), 'click');
  await settle();

  const drawn = dom.mounts.canvas.textContent;
  assert.match(drawn, /2 memory record\(s\)/, 'the count leads, before any row');
  assert.match(drawn, /\.memory\/records\//, 'and names where they live');

  // The summary is over every record, not over the capped list beneath it.
  assert.match(drawn, /architecture/);
  assert.match(drawn, /bugfix/);
  assert.match(drawn, /agent/);
  assert.match(drawn, /human/);

  // An actor here is a BRANCH, not a person, and the page must not dress it
  // up as one.
  assert.match(drawn, /feat\/issue-1059-design/);

  const rows = findAll(dom.mounts.canvas, (n) => n.tagName === 'TR');
  assert.equal(rows.length, 3, 'a header row and one row per record');
  const first = rows[1].textContent;
  assert.match(first, /rec-aaaa/, 'most recent first');
});

test('#1059: the panel\'s SDD tab names the file of every stage, present or missing', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  fire(cardFor(dom, 1059), 'click');
  await settle();

  const tabs = find(dom.mounts.drawer, byClass('tabs'));
  assert.ok(tabs, 'the panel has its tab bar');
  const sddTab = tabs.childNodes.find((b) => b.textContent.includes('SDD'));
  assert.ok(sddTab, 'and an SDD tab');
  fire(sddTab, 'click');
  await settle();

  // The maintainer's report: "SDD no está listando los files cuando click en
  // un ticket". Every stage is a file, and the tab named none of them.
  const files = findAll(dom.mounts.drawer, byClass('stage-file')).map((n) => n.textContent);
  assert.deepEqual(files, [
    'proposal.md', 'spec.md', 'design.md', 'tasks.md',
    'apply-progress.md', 'verify-report.md', 'archive-report.md',
  ], 'all seven, in lifecycle order — a missing stage names the file it would be written to');

  // And each row's provenance points at ITS file, not at the one directory
  // all seven used to share.
  const drawn = dom.mounts.drawer.textContent;
  assert.match(drawn, /openspec\/changes\/issue-1059-design-structure\/proposal\.md/);
  assert.match(drawn, /openspec\/changes\/issue-1059-design-structure\/design\.md/);
});

test('#1067: a WHEN with no scenario heading is DRAWN in the panel, not merely collected', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  fire(cardFor(dom, 1059), 'click');
  await settle();

  const drawn = dom.mounts.drawer.textContent;
  assert.match(drawn, /R1059-1/, 'the requirements the grammar read are there');
  assert.match(drawn, /2 line\(s\) the grammar could not attach/, 'and the two it could not are counted');
  assert.match(drawn, /nobody wrote a scenario heading/, 'the orphan line is shown AS WRITTEN — the reviewer\'s point was that collecting it is not showing it');
  assert.match(drawn, /belongs to no scenario/, 'with what it was missing');
});

test('#1032: epic clustering groups the slices under their epic, and draws no node twice', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  const button = (label) => find(dom.mounts.canvas, (n) => n.tagName === 'BUTTON' && n.textContent.includes(label));
  const issuesDrawn = () => findAll(dom.mounts.canvas, byClass('node-card')).map((c) => c.getAttribute('data-issue'));

  assert.equal(findAll(dom.mounts.canvas, byClass('epic-cluster')).length, 0, 'the board opens on track swimlanes');
  const epicButton = button('epic clusters');
  assert.ok(epicButton, 'the design draws both clustering choices');
  assert.ok(!epicButton.disabled, 'and the second one works now that kind and parent are data (#1032)');

  fire(epicButton, 'click');
  await settle();

  const clusters = findAll(dom.mounts.canvas, byClass('epic-cluster'));
  assert.equal(clusters.length, 1, 'one cluster, for the one issue declaring kind: epic');
  const cluster = clusters[0].textContent;
  assert.match(cluster, /#878/, 'led by the epic itself');
  assert.match(cluster, /#1059/, 'with the slices that named it as their parent');
  assert.match(cluster, /#1032/);

  // This fixture's epic DOES declare a tracker, so the branch is named.
  assert.match(cluster, /feature\/brain-ui/, 'the tracker branch the epic declared is on screen');

  // THE RULE THIS MODE LIVES OR DIES BY. A slice is on screen once: under its
  // epic, not also down in its track lane. The page filters by the model's own
  // `unclaimed` set rather than deciding again from kind and parent.
  const drawn = issuesDrawn();
  assert.equal(new Set(drawn).size, drawn.length, `a node was drawn twice: ${drawn.join(', ')}`);
  assert.ok(drawn.includes('1059'), 'the slice is drawn, under its epic');

  // And nothing vanished: the issue with no parent is still on the board.
  assert.ok(drawn.includes('1024'), 'a node no epic claimed keeps its place in its own track lane');

  // Back, and the board is what it was.
  fire(button('track swimlanes'), 'click');
  await settle();
  assert.equal(findAll(dom.mounts.canvas, byClass('epic-cluster')).length, 0);
});

test('#1032: an epic that declares no tracker says so where the branch would be', async (t) => {
  // True of every epic in this repository today, so it is the case a reader
  // actually meets. `ticket-base.mjs` calls this state
  // `epic-declares-no-tracker`, and a blank line there would read as "this
  // epic has a tracker and we did not show it".
  const noTracker = ISSUES.map((i) => (i.body === null ? i : { ...i, body: i.body.replace(/^tracker:.*\n/m, '') }));
  const dom = await boot({ issues: noTracker });
  t.after(() => dom.restore());

  fire(find(dom.mounts.canvas, (n) => n.tagName === 'BUTTON' && n.textContent.includes('epic clusters')), 'click');
  await settle();

  const cluster = find(dom.mounts.canvas, byClass('epic-cluster'));
  assert.ok(cluster, 'the epic still leads a cluster — a missing tracker is not a missing epic');
  assert.match(cluster.textContent, /epic-declares-no-tracker|declares no tracker/,
    'the absence is named, in the words the resolver itself uses');
  assert.ok(!/feature\/brain-ui/.test(cluster.textContent), 'and no branch is claimed that was never declared');
});

test('#1079: the declare snippet\'s caveat is ON SCREEN, not only in the model', async (t) => {
  // The snippet gained `kind: epic` and `parent: 878`. The note saying both
  // lines are conditional was carried by the model and drawn nowhere, so the
  // page showed a block that, pasted as printed, declares a repository full
  // of epics parented to one ticket. This is the same class as the spec
  // orphans earlier in this change: collected is not shown.
  const dom = await boot();
  t.after(() => dom.restore());

  fire(find(dom.mounts.canvas, byClass('lane-toggle')), 'click');
  await settle();

  const batch = find(dom.mounts.canvas, byClass('batch')).textContent;
  assert.match(batch, /kind: epic/, 'the snippet offers the key');
  assert.match(batch, /parent: 878/);
  assert.match(batch, /only if this issue IS an epic/, 'and the page says when to keep it');
  assert.match(batch, /only if it is a slice of one/);
});

test('#1079: a node with no track that an epic claims is drawn once, and the batch says so', async (t) => {
  const dom = await boot();
  t.after(() => dom.restore());

  const button = (label) => find(dom.mounts.canvas, (n) => n.tagName === 'BUTTON' && n.textContent.includes(label));
  fire(button('epic clusters'), 'click');
  await settle();
  fire(find(dom.mounts.canvas, byClass('lane-toggle')), 'click');
  await settle();

  const drawn = [
    ...findAll(dom.mounts.canvas, byClass('node-card')).map((c) => c.getAttribute('data-issue')),
    ...findAll(dom.mounts.canvas, byClass('batch-tile')).map((t2) => t2.textContent.replace(/[^0-9]/g, '')),
  ];
  const twice = drawn.filter((n, i) => drawn.indexOf(n) !== i);
  assert.deepEqual(twice, [], `drawn twice: ${twice.join(', ')} — the batch must not repeat what a cluster already shows`);
  assert.ok(drawn.includes('921'), 'and it IS on screen, under the epic that claimed it');

  // Not hidden, shown elsewhere. A batch that silently shrank would read as
  // the graph changing when only the view did.
  assert.match(find(dom.mounts.canvas, byClass('batch')).textContent, /1 more shown under their epic/);
});
