import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { makeSnapshotFixture as makeFixture } from '../__fixtures__/snapshot-tree.mjs';
import {
  buildSnapshot, roadmapState, aggregateActors, projectRecord, readChanges, readRecordRows, reviewRows,
  issueOfBranch, renderSnapshotText, PLANNED, IN_FLIGHT, DONE, UNREADABLE,
} from './snapshot.mjs';

const NOW = '2026-09-13T00:00:00Z';

const VERDICT = (sha, rev, verdict) => `Round ${rev}\n\n\`\`\`yaml\nprotocol: brain-review/2\nhead_sha: ${sha}\nrev: ${rev}\nverdict: ${verdict}\nfindings: []\n\`\`\`\n`;

/** A verdict whose `findings:` block carries the given entries, in the ONE list encoding `renderVerdict` emits (#998 R998-5). `file`/`line` are real emitted fields (verdict.mjs's `hasUsableAnchor`, REQ-405-2, measured on PR #1006's posted verdict) — included here only when the fixture asks for them. */
const VERDICT_WITH_FINDINGS = (sha, rev, verdict, findings) => {
  const lines = ['protocol: brain-review/2', `head_sha: ${sha}`, `rev: ${rev}`, `verdict: ${verdict}`, 'findings:'];
  for (const f of findings) {
    lines.push(`  - id: ${f.id}`);
    lines.push(`    severity: ${f.severity}`);
    if (f.evidence !== undefined) lines.push(`    evidence: "${f.evidence}"`);
    if (f.cites !== undefined) lines.push(`    cites: ${f.cites}`);
    if (f.file !== undefined) lines.push(`    file: ${f.file}`);
    if (f.line !== undefined) lines.push(`    line: ${f.line}`);
  }
  return `Round ${rev}\n\n\`\`\`yaml\n${lines.join('\n')}\n\`\`\`\n`;
};

/** A findings block in the FOREIGN 0-indent encoding (#452/#478): unreadable at any entry count, never a truncated prefix. */
const VERDICT_MALFORMED_FINDINGS = (sha, rev, verdict) =>
  `Round ${rev}\n\n\`\`\`yaml\nprotocol: brain-review/2\nhead_sha: ${sha}\nrev: ${rev}\nverdict: ${verdict}\nfindings:\n- id: F-1\n  severity: blocker\n\`\`\`\n`;

/** A port whose every write verb throws — "read-only" proved, not promised. */
function readOnlyPort(reads) {
  const port = {};
  for (const w of ['mrCreate', 'mrAutoMerge', 'issueCreate', 'issueUpdate', 'prReviewComment', 'issueComment', 'labelAdd', 'labelRemove', 'branchProtect']) {
    port[w] = async () => { throw new Error(`write verb ${w} called by a read model`); };
  }
  return Object.assign(port, reads);
}

function snapshotTree(root) {
  const out = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); const s = statSync(p); out.push(`${p}:${s.isDirectory() ? 'd' : s.size}:${s.mtimeMs}`); if (s.isDirectory()) walk(p); } };
  walk(root);
  return out.sort();
}

// ── R879-2: fresh clone, no forge ───────────────────────────────────────────

test('#879: with no port the forge sections say why, the tree sections are computed, nothing is written', async () => {
  const root = makeFixture();
  const before = snapshotTree(root);
  const s = await buildSnapshot({ root, now: NOW });
  assert.equal(s.generatedAt, '2026-09-13T00:00:00.000Z');
  assert.equal(s.tier, 'committed');
  assert.deepEqual(s.governanceTier, { ok: true, value: 'lite' });
  for (const k of ['graph', 'prs', 'reviews']) {
    assert.equal(s[k].ok, false, k);
    assert.match(s[k].reason, /no VCS port/);
  }
  assert.equal(s.changes.ok, true);
  assert.equal(s.records.ok, true);
  assert.equal(s.adrs.ok, true);
  assert.equal(s.antiPatterns.ok, true);
  assert.equal(s.actors.ok, true);
  assert.equal(s.releaseDebt.ok, true);
  assert.equal(s.drift.ok, true);
  assert.equal(s.history.ok, false, 'no real git repo backs this tmpdir fixture');
  assert.match(s.history.reason, /git (log|tag)/);
  assert.deepEqual(snapshotTree(root), before, 'the snapshot wrote nothing');
});

// ── #882 R882-5: history, additive beside the nine existing sections ────────

test('#882 R882-5: history is wired from gatherHistoryFacts through buildSnapshot\'s own injected _run, additive beside every other section', async () => {
  const root = makeFixture();
  const calls = [];
  const s = await buildSnapshot({
    root, now: NOW,
    _run: (file, args) => {
      calls.push(args);
      if (args[0] === 'log') return 'aaa1111|2026-09-10 10:00:00 +0000|feat(ui): the History view (#123)\n';
      if (args[0] === 'tag') return 'v1.4.0|2026-09-01T00:00:00+00:00\n';
      throw new Error(`unexpected git ${args[0]}`);
    },
  });
  assert.equal(s.history.ok, true);
  assert.deepEqual(s.history.value.commits, [
    { sha: 'aaa1111', date: '2026-09-10T10:00:00+00:00', subject: 'feat(ui): the History view (#123)', citedRef: 123, malformed: null },
  ]);
  assert.deepEqual(s.history.value.tags, [{ name: 'v1.4.0', date: '2026-09-01T00:00:00+00:00', malformed: null }]);
  assert.ok(calls.some((a) => a[0] === 'log'), 'buildSnapshot\'s own _run reaches gatherHistoryFacts, not a second git seam');
  // Every other section computed from THIS same _run-injected buildSnapshot call still
  // stands exactly as the no-history baseline test above — additive, never displaced.
  assert.equal(s.changes.ok, true);
  assert.equal(s.records.ok, true);
  assert.equal(s.adrs.ok, true);
  assert.equal(s.antiPatterns.ok, true);
  assert.equal(s.actors.ok, true);
  assert.equal(s.releaseDebt.ok, true);
  assert.equal(s.drift.ok, true);
});

test('#879: a missing records dir is a reason on records AND actors, never []', async () => {
  const s = await buildSnapshot({ root: makeFixture({ records: false }), now: NOW });
  assert.equal(s.records.ok, false);
  assert.match(s.records.reason, /\.memory\/records is absent/);
  assert.equal(s.actors.ok, false);
  assert.equal(readRecordRows({ root: '/nowhere' }).ok, false);
});

test('#879: drift names the ADR HOME.md lists that has no readable file, by path', async () => {
  const s = await buildSnapshot({ root: makeFixture(), now: NOW });
  assert.deepEqual(s.drift.value, {
    homeOnly: [{ number: 2, path: 'brain/project/decisions/adr-0002-b.md' }],
    filesOnly: [],
    unreadable: [],
  });
  assert.match(renderSnapshotText(s), /⚠ adr drift.*\n.*ADR-0002 brain\/project\/decisions\/adr-0002-b\.md/);
});

// ── R879-8: changes through the accessor ────────────────────────────────────

test('#879: changes read tasks, slice scopes and missing artefacts; an absent tasks.md is a reason', () => {
  const root = makeFixture();
  const c = readChanges({ root, tier: 'lite' });
  assert.equal(c.ok, true);
  const active = c.value.filter((x) => !x.archived);
  assert.deepEqual(active.map((x) => x.id), ['issue-1-a', 'issue-2-no-tasks'], 'archive/ is not a change dir of its own');
  const [a, b] = active;
  assert.deepEqual(a.tasks, { checked: { ok: true, value: 1 }, open: { ok: true, value: 1 }, next: { ok: true, value: 'next one' } });
  assert.deepEqual(a.sliceScopes, { ok: true, value: [{ slice: 1, claims: ['R1-1'], terminal_pr: 'this PR -> main' }] });
  assert.deepEqual(a.missing, { ok: true, value: [] });
  assert.equal(b.tasks.checked.ok, false);
  assert.match(b.tasks.checked.reason, /issue-2-no-tasks\/tasks\.md could not be read/);
  assert.deepEqual(b.missing.value, [], 'at lite only spec.md is required, and it is there');
  assert.deepEqual(readChanges({ root, tier: 'standard' }).value.filter((x) => !x.archived)[1].missing.value, ['proposal.md', 'design.md', 'tasks.md'], 'the tier decides the required set');
  assert.equal(readChanges({ root: '/nowhere', tier: 'lite' }).ok, false);
  const unresolved = readChanges({ root, tier: null });
  assert.equal(unresolved.value.filter((x) => !x.archived)[0].missing.ok, false, 'no tier → the required set cannot be resolved, and that is said');
});

// ── R998-4: the archive reader ──────────────────────────────────────────────

test('#998 R998-4: readChanges also lists openspec/changes/archive/<issue> rows, archived: true, same shape', () => {
  const root = makeFixture();
  const c = readChanges({ root, tier: 'lite' });
  assert.equal(c.ok, true);
  const archived = c.value.filter((x) => x.archived);
  assert.deepEqual(archived.map((x) => x.id), ['9']);
  const [nine] = archived;
  assert.equal(nine.dir, 'openspec/changes/archive/9');
  assert.equal(nine.issue, 9);
  assert.equal(nine.slug, null);
  assert.equal(nine.grandfathered, false);
  assert.deepEqual(nine.artefacts, { proposal: true, spec: true, design: true, tasks: true, apply: false, verify: false, archive: true });
  assert.deepEqual(nine.tasks, { checked: { ok: true, value: 2 }, open: { ok: true, value: 0 }, next: { ok: true, value: '—' } });
  assert.deepEqual(nine.missing.value, [], 'at lite only spec.md is required, and it is there too');
});

// ── cold review of #1008/PR6: hasSpec's nested-specs/ tolerance through the archive path ──

test('#998 cold-1008: an archived row with the nested specs/*/spec.md convention still resolves spec:true', () => {
  const files = {
    'openspec/changes': [],
    'openspec/changes/archive': ['12'],
    'openspec/changes/archive/12': ['tasks.md', 'specs'],
    'openspec/changes/archive/12/specs': ['a'],
  };
  const c = readChanges({
    root: '/fake',
    tier: 'lite',
    _list: (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]; },
    _exists: (p) => p === 'openspec/changes/archive'
      || p === 'openspec/changes/archive/12/tasks.md'
      || p === 'openspec/changes/archive/12/specs'
      || p === 'openspec/changes/archive/12/specs/a/spec.md',
    _read: (p) => { if (p === 'openspec/changes/archive/12/tasks.md') return '- [ ] x'; throw new Error('missing'); },
  });
  assert.equal(c.ok, true);
  const [twelve] = c.value.filter((x) => x.archived);
  assert.equal(twelve.artefacts.spec, true, 'the nested specs/*/spec.md convention must resolve through the archive path too, the same as an active change dir');
});

test('#998 R998-4: a missing archive dir is "no archived changes", never an error', () => {
  const files = { 'openspec/changes': ['issue-1-a'], 'openspec/changes/issue-1-a': ['tasks.md'] };
  const c = readChanges({
    root: '/fake',
    tier: 'lite',
    _list: (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]; },
    _exists: (p) => p === 'openspec/changes/issue-1-a/tasks.md',
    _read: (p) => { if (p === 'openspec/changes/issue-1-a/tasks.md') return '- [ ] x'; throw new Error('missing'); },
  });
  assert.equal(c.ok, true);
  assert.deepEqual(c.value.filter((x) => x.archived), []);
});

test('#998 R998-4: an archive dir that exists but cannot be listed is a reason on the whole section', () => {
  const c = readChanges({
    root: '/fake',
    tier: 'lite',
    _list: (p) => { if (p === 'openspec/changes') return []; throw new Error('permission denied'); },
    _exists: () => true,
    _read: () => { throw new Error('n/a'); },
  });
  assert.equal(c.ok, false);
  assert.match(c.reason, /permission denied/);
});

// ── review of PR 4, fix 1: a not-issue-numbered archive dir is said, not dropped ────

test('#998 fix1: an archive dir that is not a bare issue number is skipped from rows but named in archiveSkipped, never silently dropped', () => {
  const files = {
    'openspec/changes': [],
    'openspec/changes/archive': ['5', '2026-07-26-issue-334-brain-ship-labels', 'governance'],
    'openspec/changes/archive/5': ['spec.md'],
  };
  const c = readChanges({
    root: '/fake',
    tier: 'lite',
    _list: (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]; },
    _exists: (p) => p === 'openspec/changes/archive' || p === 'openspec/changes/archive/5/spec.md',
    _read: () => { throw new Error('n/a'); },
  });
  assert.equal(c.ok, true);
  assert.deepEqual(c.value.filter((x) => x.archived).map((x) => x.id), ['5'], 'only the issue-numbered dir becomes a row');
  assert.deepEqual(c.archiveSkipped, [
    { name: '2026-07-26-issue-334-brain-ship-labels', reason: 'not an issue-numbered archive dir' },
    { name: 'governance', reason: 'not an issue-numbered archive dir' },
  ]);
});

test('#998 fix1: the fixture archive/ carries only its own .gitkeep as a non-issue-numbered entry — named, not dropped', () => {
  const c = readChanges({ root: makeFixture(), tier: 'lite' });
  assert.equal(c.ok, true);
  assert.deepEqual(c.archiveSkipped, [{ name: '.gitkeep', reason: 'not an issue-numbered archive dir' }]);
});

// ── R879-5: roadmap ─────────────────────────────────────────────────────────

test('#879: roadmap is done / in-flight / planned, and uncomputable when the PR list was not read', () => {
  const prs = { ok: true, value: [{ number: 10, headBranch: 'feat/issue-5-x' }, { number: 11, headBranch: 'main' }] };
  const reviews = { ok: true, value: [{ pr: 10, ok: true, latest: { pr: 10, rev: 2, verdict: 'APPROVE' } }] };
  assert.deepEqual(roadmapState({ number: 5, state: 'closed' }, prs, reviews).value.state, DONE);
  const inFlight = roadmapState({ number: 5, state: 'open' }, prs, reviews);
  assert.equal(inFlight.value.state, IN_FLIGHT);
  assert.deepEqual(inFlight.value.evidence, { prs: [10], verdict: { pr: 10, rev: 2, verdict: 'APPROVE' } });
  assert.equal(roadmapState({ number: 6, state: 'open' }, prs, reviews).value.state, PLANNED);
  const unread = roadmapState({ number: 6, state: 'open' }, { ok: false, reason: 'offline' }, reviews);
  assert.equal(unread.ok, false);
  assert.match(unread.reason, /offline.*planned/);
  assert.equal(roadmapState({ number: 6, state: 'closed' }, { ok: false, reason: 'offline' }, reviews).value.state, DONE, 'closed needs no PR');
  assert.equal(issueOfBranch('fix/issue-42'), 42);
  assert.equal(issueOfBranch('issue-42'), null, 'the grammar needs a type');
});

// ── R879-6: actors ──────────────────────────────────────────────────────────

test('#879: actors is one aggregation over records, sorted, humans and agents in one shape', () => {
  const rows = aggregateActors([
    { actor: '@b', actorKind: 'agent', type: 'decision', ts: '2026-07-01T00:00:00Z' },
    { actor: '@a', actorKind: 'human', type: 'decision', ts: '2026-06-01T00:00:00Z' },
    { actor: '@a', actorKind: 'human', type: 'bugfix', ts: '2026-08-01T00:00:00Z' },
  ]);
  assert.deepEqual(rows, [
    { actor: '@a', actorKind: 'human', records: 2, byType: { bugfix: 1, decision: 1 }, first: '2026-06-01T00:00:00Z', last: '2026-08-01T00:00:00Z' },
    { actor: '@b', actorKind: 'agent', records: 1, byType: { decision: 1 }, first: '2026-07-01T00:00:00Z', last: '2026-07-01T00:00:00Z' },
  ]);
});

test('#879: a record is projected to its index metadata plus the file that holds it', () => {
  const r = projectRecord({ id: 'rec-0000000000000001', ts: '2026-06-01T00:00:00Z', actor: '@a', actorKind: 'human', type: 'decision', project: 'x', issue: 1, content: 'long' });
  assert.deepEqual(r, { id: 'rec-0000000000000001', ts: '2026-06-01T00:00:00Z', actor: '@a', actorKind: 'human', type: 'decision', issue: 1, file: '.memory/records/2026-06-rec-0000000000000001.jsonl' });
  assert.equal(projectRecord({ id: 'bad' }).file, null, 'an unnameable record is kept, with no pointer');
});

// ── R879-2 / D4: the forge, per section and per item ────────────────────────

test('#879: with a port the graph carries roadmap per node, and one unreadable thread does not take the others', async () => {
  const issues = [
    { number: 5, title: 'five', labels: ['status:approved'], assignees: [] },
    { number: 6, title: 'six', labels: [], assignees: null },
  ];
  const port = readOnlyPort({
    issueList: async () => issues,
    issueView: async ({ number }) => ({ body: number === 5 ? '```brain-graph/1\ntrack: UI\nblocks: []\nneeds: []\nfiles: []\n```' : '', assignees: null }),
    mrList: async () => [{ number: 10, title: 'pr', headBranch: 'feat/issue-5-x' }, { number: 11, title: 'pr', headBranch: 'feat/issue-6-y' }],
    prReviews: async ({ number }) => {
      if (number === 11) throw new Error('thread 11 timed out');
      return [{ state: 'COMMENTED', author: 'bot', body: VERDICT('abc', 1, 'REVISE') }, { state: 'COMMENTED', author: 'bot', body: VERDICT('def', 2, 'APPROVE') }];
    },
  });
  const s = await buildSnapshot({ root: makeFixture(), now: NOW, vcs: port, project: 'o/r' });
  assert.equal(s.graph.ok, true);
  // #6 answered with an EMPTY body. That is a real reply from the forge, so #6
  // is an issue that declared nothing: readable, `unclassified`, in the `?`
  // track. The forge NOT answering is the next test, and the two must never
  // look alike (cold review of #953, rev 1).
  assert.deepEqual(s.graph.value.issuesUnreadable, []);
  assert.equal(s.graph.value.nodes.find((n) => n.number === 6).ok, true);
  assert.deepEqual(s.graph.value.tracks, { '?': [6], UI: [5] }, 'tracks is a plain object, JSON-safe');
  const n5 = s.graph.value.nodes.find((n) => n.number === 5);
  assert.deepEqual(n5.roadmap.value, { state: IN_FLIGHT, evidence: { prs: [10], verdict: { pr: 10, rev: 2, verdict: 'APPROVE' } } });
  assert.deepEqual(s.prs.value[0], { number: 10, title: 'pr', headBranch: 'feat/issue-5-x', issue: 5 });
  assert.equal(s.reviews.ok, true);
  const [t10, t11] = s.reviews.value;
  assert.equal(t10.verdicts.length, 2, 'every posted round, oldest first');
  assert.equal(t10.verdicts[0].verdict, 'REVISE');
  assert.equal(t10.latest.verdict, 'APPROVE');
  assert.deepEqual(t11, { pr: 11, ok: false, reason: 'thread 11 timed out' });
  // JSON-safe end to end: a Map or an undefined would not survive this.
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('#967 R967-3 S1/S2: the declared kind, tracker, parent and parentSource reach the snapshot, JSON-safe', async () => {
  // A NEW case rather than an edit of the one above: changing #6's body in place
  // would move that test's `tracks` deep-equal, an unrelated pin.
  const issues = [
    { number: 5, title: 'epic(ui): Brain UI', labels: ['status:approved'], assignees: [] },
    { number: 6, title: 'six', labels: [], assignees: null },
  ];
  const epic = '```brain-graph/1\nkind: epic\ntrack: UI\ntracker: feature/brain-ui\nblocks: []\nneeds: []\nfiles: []\n```';
  const slice = ['Parent: #5 (Brain UI) — slice 3, Wave B.', '',
    '```brain-graph/1', 'track: UI', 'blocks: []', 'needs: []', 'files: []', '```'].join('\n');
  const port = readOnlyPort({
    issueList: async () => issues,
    issueView: async ({ number }) => ({ body: number === 5 ? epic : slice, assignees: null }),
    mrList: async () => [],
    prReviews: async () => [],
  });
  const s = await buildSnapshot({ root: makeFixture(), now: NOW, vcs: port, project: 'o/r' });
  const n5 = s.graph.value.nodes.find((n) => n.number === 5);
  const n6 = s.graph.value.nodes.find((n) => n.number === 6);

  assert.equal(n5.kind, 'epic');
  assert.equal(n5.tracker, 'feature/brain-ui');
  assert.equal(n5.parent, null);
  assert.equal(n5.parentSource, null);
  assert.equal(n6.kind, null, 'nothing is inferred from the epic(...) title on #5 either');
  assert.equal(n6.tracker, null);
  assert.equal(n6.parent, 5, 'read from the line-initial prose declaration');
  assert.equal(n6.parentSource, 'prose', 'and the node says where it came from');
  assert.deepEqual(s.graph.value.declarationDivergences, [], 'a clean pair says nothing');
  // JSON-safe end to end, the four new fields included: a Map or an undefined among
  // them would not survive this, and the verb's `--json` prints exactly this shape.
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('#967 R967-2 (PR D, review round 2): a slice body with Parent: prose and NO graph block at all still resolves its parent in the snapshot', async () => {
  // A NEW case rather than an edit of the S1/S2 fixture above — #6 there already
  // carries a `brain-graph/1` block (with no `parent:` key), so it exercises the
  // block-exists prose fallback, not the no-block-at-all one this fix closes.
  const issues = [
    { number: 5, title: 'epic(ui): Brain UI', labels: ['status:approved'], assignees: [] },
    { number: 7, title: 'seven', labels: [], assignees: null },
  ];
  const epic = '```brain-graph/1\nkind: epic\ntrack: UI\ntracker: feature/brain-ui\nblocks: []\nneeds: []\nfiles: []\n```';
  const noBlockSlice = 'Parent: #5 (Brain UI) — slice 4, Wave B.';
  const port = readOnlyPort({
    issueList: async () => issues,
    issueView: async ({ number }) => ({ body: number === 5 ? epic : noBlockSlice, assignees: null }),
    mrList: async () => [],
    prReviews: async () => [],
  });
  const s = await buildSnapshot({ root: makeFixture(), now: NOW, vcs: port, project: 'o/r' });
  const n7 = s.graph.value.nodes.find((n) => n.number === 7);

  assert.equal(n7.parent, 5, 'the prose parent resolves even with no brain-graph/1 block at all');
  assert.equal(n7.parentSource, 'prose');
  assert.equal(n7.declared, false, 'a prose-only parent is a relation, not a graph declaration');
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
});

test('#879: one issue body that cannot be read is a node that says so — never an issue that declared nothing', async () => {
  const issues = [
    { number: 5, title: 'five', labels: ['status:approved'], assignees: [] },
    { number: 6, title: 'six', labels: [], assignees: null },
  ];
  const body5 = '```brain-graph/1\ntrack: UI\nblocks: []\nneeds: [6]\nfiles: []\n```';
  const port = (view6) => readOnlyPort({
    issueList: async () => issues,
    issueView: async ({ number }) => {
      if (number === 6) return view6();
      return { body: body5, assignees: null };
    },
    // Siblings neutralized: `prs` and `reviews` are read in sequence after the
    // graph and this test is about the issue reader alone. Empty lists keep
    // both sections `ok` while contributing no roadmap PR and no verdict, so a
    // change in THOSE readers cannot turn this test red, and a red here means
    // the issue reader. The fixture tree plays the same role for the local
    // readers (changes, records, ADRs): present so `buildSnapshot` reaches the
    // graph, asserted nowhere below.
    mrList: async () => [],
    prReviews: async () => [],
  });
  const root = makeFixture();
  const failed = await buildSnapshot({ root, now: NOW, vcs: port(() => { throw new Error('issue 6 timed out'); }), project: 'o/r' });
  const undeclared = await buildSnapshot({ root, now: NOW, vcs: port(() => ({ body: '', assignees: null })), project: 'o/r' });

  const n6 = failed.graph.value.nodes.find((n) => n.number === 6);
  assert.equal(n6.ok, false);
  assert.match(n6.reason, /issue 6 timed out/);
  assert.equal(n6.status, UNREADABLE, 'not "unclassified" — nobody knows whether it declared a block');
  assert.equal(n6.declared, null);
  // #967 R967-3 S3: an unreadable node carries none of the four declared fields —
  // never a tracker or a parent it did not declare.
  //
  // PINNED, AND IT WAS ALREADY GREEN, labelled as what it is. `readForge` substitutes
  // `body: ''` for a body it could not read, so the parse is `null` and all four
  // arrive `null` before the reset ever runs. The reset names them anyway, for the
  // same reason it already names `track`, `files` and `sources` — all three equally
  // free today: it is the written guarantee, so that a later change to that
  // substitution cannot silently turn a free property into a leaked declaration.
  // No mutation of the reset alone can turn this assertion red, and saying so here
  // is cheaper than a reviewer rediscovering it.
  assert.equal(n6.kind, null);
  assert.equal(n6.tracker, null);
  assert.equal(n6.parent, null);
  assert.equal(n6.parentSource, null);
  assert.deepEqual(failed.graph.value.issuesUnreadable, [{ number: 6, reason: 'issue 6 timed out' }]);
  assert.equal(n6.roadmap.value.state, PLANNED, 'state and PRs came from the list, so the roadmap is still a fact');
  // What the LIST said still counts: #5 declared it needs #6, and #6 is open.
  assert.deepEqual(failed.graph.value.nodes.find((n) => n.number === 5).blockedBy, [6]);
  assert.deepEqual(failed.graph.value.tracks, { UI: [5] }, 'an unknown track is not the "?" track');
  assert.match(renderSnapshotText(failed), /1 issue body\(ies\) unreadable/);

  // The measurement the review made, inverted: the two cases must NOT be byte-identical.
  const u6 = undeclared.graph.value.nodes.find((n) => n.number === 6);
  assert.equal(u6.ok, true);
  assert.equal(u6.status, 'unclassified');
  assert.deepEqual(undeclared.graph.value.issuesUnreadable, []);
  assert.deepEqual(undeclared.graph.value.tracks, { '?': [6], UI: [5] });
  assert.notDeepEqual(n6, u6);
});

test('#879: an issue list that fails takes only the graph; a PR list that fails takes prs and reviews', async () => {
  const port = readOnlyPort({
    issueList: async () => { throw new Error('rate limited'); },
    mrList: async () => { throw new Error('offline'); },
  });
  const s = await buildSnapshot({ root: makeFixture(), now: NOW, vcs: port, project: 'o/r' });
  assert.match(s.graph.reason, /rate limited/);
  assert.match(s.prs.reason, /offline/);
  assert.match(s.reviews.reason, /offline/);
});

test('#879: reviewRows keeps verdicts oldest first and marks a review with no block as no verdict', () => {
  const r = reviewRows(3, [{ body: 'just a comment', author: 'h' }, { body: VERDICT('a', 1, 'REVISE'), author: 'bot' }]);
  assert.equal(r.verdicts.length, 1);
  assert.equal(r.latest.rev, 1);
  assert.equal(reviewRows(4, []).latest, null);
});

test('#1009 cold review round 2: reviewRows keeps a STOP verdict verbatim, same as REVISE/APPROVE — parseVerdict does not filter the word against the enum', () => {
  const r = reviewRows(12, [{ body: VERDICT('stopsha0', 3, 'STOP'), author: 'bot' }]);
  assert.equal(r.verdicts[0].verdict, 'STOP');
  assert.equal(r.latest.verdict, 'STOP');
});

// ── #998 R998-5: findings per verdict — the array, not the count ───────────

test('#998 R998-5: reviewRows carries a verdict\'s findings as the shaped array, plus findingCount — the excerpt truncated to 240 chars', () => {
  const longEvidence = 'e'.repeat(300);
  const body = VERDICT_WITH_FINDINGS('abc', 1, 'REVISE', [
    { id: 'F-1', severity: 'blocker', evidence: longEvidence, cites: 'ADR-1' },
    { id: 'F-2', severity: 'correction', evidence: 'short' },
  ]);
  const r = reviewRows(5, [{ body, author: 'bot' }]);
  assert.equal(r.verdicts[0].findingCount, 2);
  assert.deepEqual(r.verdicts[0].findings, [
    { id: 'F-1', severity: 'blocker', cites: 'ADR-1', file: null, line: null, evidenceExcerpt: longEvidence.slice(0, 240) },
    { id: 'F-2', severity: 'correction', cites: null, file: null, line: null, evidenceExcerpt: 'short' },
  ]);
  assert.equal(r.verdicts[0].findings[0].evidenceExcerpt.length, 240);
});

test('#998 R998-5: a finding carrying file/line (the real emitted anchor, verdict.mjs\'s hasUsableAnchor / REQ-405-2, measured on PR #1006) survives with both present; one without has both null', () => {
  const body = VERDICT_WITH_FINDINGS('abc', 1, 'REVISE', [
    { id: 'F-1', severity: 'blocker', evidence: 'e', cites: 'ADR-1', file: 'brain/scripts/governance/run-check.mjs', line: 556 },
    { id: 'F-2', severity: 'correction', evidence: 'e' },
  ]);
  const r = reviewRows(8, [{ body, author: 'bot' }]);
  assert.equal(r.verdicts[0].findings[0].file, 'brain/scripts/governance/run-check.mjs');
  assert.equal(r.verdicts[0].findings[0].line, 556);
  assert.equal(r.verdicts[0].findings[1].file, null);
  assert.equal(r.verdicts[0].findings[1].line, null);
});

test("#1009 cold review finding 3: a finding's line of 0 parses to null — hasUsableAnchor (verdict.mjs) never emits line 0, and provenance.mjs's falsy check would silently drop it", () => {
  const body = VERDICT_WITH_FINDINGS('abc', 1, 'REVISE', [
    { id: 'F-1', severity: 'blocker', evidence: 'e', file: 'brain/scripts/governance/run-check.mjs', line: 0 },
  ]);
  const r = reviewRows(11, [{ body, author: 'bot' }]);
  assert.equal(r.verdicts[0].findings[0].line, null, 'line 0 is not a usable anchor — parseFindingLine must reject it, same as non-numeric input');
});

test('#998 R998-5: a malformed findings block keeps findings: [] with the reason said in malformed, not silently "no findings"', () => {
  const body = VERDICT_MALFORMED_FINDINGS('def', 2, 'REVISE');
  const r = reviewRows(6, [{ body, author: 'bot' }]);
  assert.deepEqual(r.verdicts[0].findings, []);
  assert.deepEqual(r.verdicts[0].malformed, ['findings']);
  assert.equal(r.verdicts[0].findingCount, null, 'uncomputable, distinct from a verdict that declared zero findings');
});

test('#998 R998-5: a verdict that declares findings: [] (genuinely empty) has findingCount 0, not null', () => {
  const r = reviewRows(7, [{ body: VERDICT('ghi', 1, 'APPROVE'), author: 'bot' }]);
  assert.deepEqual(r.verdicts[0].findings, []);
  assert.equal(r.verdicts[0].findingCount, 0);
});
