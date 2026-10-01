// ticket-base.test.mjs — issue #967. The base a slice starts from is a
// DECISION, and this is where it is decided: from the epic's declaration, with
// the reason always stated, and without a repository, a network or a forge.
//
// The verb it serves (`ticket-start.mjs`) reads `process.argv` at module scope
// and calls `process.exit` on eight paths, so it has no test file and this
// change deliberately did not create one (design Q2). Everything the verb
// decides is decided here instead; what is left there is a print and an exit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveBase } from './ticket-base.mjs';
import { OFF_TRACKER_FLAG } from './ticket-args.mjs';

// ── Fixtures: bodies, not forges ──────────────────────────────────────────

const graph = (lines) => ['```brain-graph/1', ...lines, '```'].join('\n');

/** An epic as `parseGraphBlock` reads one: `kind: epic` is what makes it an
 *  epic — never its title (R967-9). */
const epicBody = ({ tracker = null, kind = 'epic', parent = null } = {}) => graph([
  ...(kind ? [`kind: ${kind}`] : []),
  ...(tracker ? [`tracker: ${tracker}`] : []),
  ...(parent ? [`parent: ${parent}`] : []),
  'track: UI', 'blocks: []', 'needs: []', 'files: []',
]);

const sliceBody = (parent) => graph([
  ...(parent ? [`parent: ${parent}`] : []),
  'track: UI', 'blocks: []', 'needs: []', 'files: []',
]);

const TRACKER = 'feature/brain-ui';
const EPIC = 878;
const GRANDPARENT = 900;

/** The injected port: a recording one-argument closure, the shape
 *  `runIssueLinkCheck` already uses. No provider, no project, no stub. */
const reader = (bodies) => {
  const calls = [];
  const fetchIssue = async (number) => {
    calls.push(number);
    const body = bodies[number];
    if (body instanceof Error) throw body;
    return body === undefined ? null : { number, body };
  };
  return { fetchIssue, calls };
};

const args = (over = {}) => ({
  baseBranch: 'main', baseExplicit: false, offTracker: false, ...over,
});

const slice = (parent = EPIC) => ({ number: 881, body: sliceBody(parent) });

// ── Row 1: the tracker is used, and the epic that declared it is named ────

test('an epic that declares a tracker gives the base, and the message names both', async () => {
  // R967-5 S1. The whole point of the change: a slice of an epic in flight does
  // not start from `main`, and nobody had to remember `--base`.
  const { fetchIssue, calls } = reader({ [EPIC]: epicBody({ tracker: TRACKER }) });

  const r = await resolveBase({ issue: slice(), args: args(), fetchIssue });

  assert.equal(r.ok, true);
  assert.equal(r.base, TRACKER);
  assert.equal(r.say.key, 'ticket.base.fromEpic');
  assert.equal(r.say.params.tracker, TRACKER);
  assert.equal(r.say.params.epic, EPIC, 'a base taken from someone else\'s declaration names who declared it');
  assert.equal(r.say.params.source, 'block');
  assert.deepEqual(calls, [EPIC]);
});

test('a parent declared in prose is honoured, and the message says it was prose', async () => {
  // `parseGraphBlock` reports WHERE the parent came from; the operator sees it,
  // because `Parent: #878` in prose is a weaker declaration than the block key
  // and a surprising base should be traceable to the line that caused it.
  const { fetchIssue } = reader({ [EPIC]: epicBody({ tracker: TRACKER }) });
  const issue = { number: 881, body: `Parent: #${EPIC}\n\n${sliceBody(null)}` };

  const r = await resolveBase({ issue, args: args(), fetchIssue });

  assert.equal(r.base, TRACKER);
  assert.equal(r.say.params.source, 'prose');
});

test('a parent declared in prose with NO block at all is still honoured (#967 PR D, review round 2)', async () => {
  // Blocker 2 (cold review of the tracker PR, 2026-09-17): `parseGraphBlock`
  // returned `null` before the prose scan ever ran when the body carried no
  // `brain-graph/1` fence at all — invisible to `parentOf`, and so to this
  // resolver. `declaredParent` is the shared fix; this pins it through the leaf.
  const { fetchIssue } = reader({ [EPIC]: epicBody({ tracker: TRACKER }) });
  const issue = { number: 881, body: `Parent: #${EPIC} (Brain UI) — slice 3, Wave B.` };

  const r = await resolveBase({ issue, args: args(), fetchIssue });

  assert.equal(r.base, TRACKER);
  assert.equal(r.say.params.source, 'prose');
});

// ── Row 2: `main`, and never silently ────────────────────────────────────

test('no parent, a parent that is not an epic, and an epic with no tracker each state their own reason', async () => {
  // R967-5 S3. Three different facts that happen to share an outcome. A single
  // "base: main" would make them indistinguishable to the operator who has to
  // decide whether that is correct — which is the silence this change removes.
  const cases = [
    ['no-parent', { issue: slice(null), bodies: {} }],
    ['parent-not-epic', { issue: slice(), bodies: { [EPIC]: epicBody({ kind: null, tracker: null }) } }],
    ['epic-declares-no-tracker', { issue: slice(), bodies: { [EPIC]: epicBody({ tracker: null }) } }],
  ];

  for (const [reason, { issue, bodies }] of cases) {
    const { fetchIssue } = reader(bodies);
    const r = await resolveBase({ issue, args: args(), fetchIssue });

    assert.equal(r.ok, true, reason);
    assert.equal(r.base, 'main', reason);
    assert.equal(r.say.key, 'ticket.base.noEpic', reason);
    assert.equal(r.say.params.reason, reason, 'the reason is the stated fact, not a shrug');
  }
});

test('a parent-grammar or parent-ambiguous divergence states its own reason, not "no-parent" (#967 PR E, tracker PR #1004 round 3)', async () => {
  // `parentOf` used to collapse a divergent parent's `number` to `null`, the
  // SAME value a body that never declares one produces — this leaf silently
  // resolved both to `reason: 'no-parent'`, the exact defect base-branch.mjs's
  // gate had at the other caller `declaredParent` serves. R967-5's fail-open
  // philosophy still holds here (no refusal, base: main, never chases the
  // forge for a number it does not have) — only the STATED reason changes.
  const grammar = { number: 881, body: ['```brain-graph/1', 'parent: abc', '```'].join('\n') };
  const ambiguous = { number: 881, body: ['Parent: #878', 'Parent: #879'].join('\n') };

  for (const [reason, issue] of [['parent-grammar', grammar], ['parent-ambiguous', ambiguous]]) {
    const { fetchIssue, calls } = reader({});
    const r = await resolveBase({ issue, args: args(), fetchIssue });

    assert.equal(r.ok, true, reason);
    assert.equal(r.base, 'main', reason);
    assert.equal(r.say.key, 'ticket.base.noEpic', reason);
    assert.equal(r.say.params.reason, reason, 'the reason must name the divergence, not "no-parent"');
    assert.deepEqual(calls, [], 'a parent that could not be read is not a parent to fetch');
  }
});

test('a tracker declared without `kind: epic` is not honoured, and the reason is stated', async () => {
  // Q7 / R967-9: `kind` is the declaration. A `tracker:` on a node that never
  // said it was an epic is carried by the parser as a divergence and honoured
  // by nobody — including here.
  const { fetchIssue } = reader({ [EPIC]: epicBody({ kind: null, tracker: TRACKER }) });

  const r = await resolveBase({ issue: slice(), args: args(), fetchIssue });

  assert.equal(r.base, 'main');
  assert.equal(r.say.params.reason, 'parent-not-epic');
});

// ── R967-5 S2: one hop. The grandparent does not exist, as far as this goes ──

test('only the immediate parent is consulted — a grandparent epic is never fetched', async () => {
  // The parent declares a parent of its own that IS an epic with a tracker.
  // Walking it would make the base depend on how deep a chain someone happened
  // to write, and would turn one read into an unbounded walk over the forge.
  const { fetchIssue, calls } = reader({
    [EPIC]: epicBody({ tracker: null, parent: GRANDPARENT }),
    [GRANDPARENT]: epicBody({ tracker: 'feature/never-read' }),
  });

  const r = await resolveBase({ issue: slice(), args: args(), fetchIssue });

  assert.equal(r.base, 'main');
  assert.equal(r.say.params.reason, 'epic-declares-no-tracker');
  assert.ok(calls.length <= 1, `one hop is at most one read, got ${calls.length}`);
  assert.ok(!calls.includes(GRANDPARENT), 'the grandparent is not read, not even to ignore it');
});

// ── Row 3: an unreadable epic FAILS OPEN ─────────────────────────────────

test('an epic that throws on read resolves to main with the reason quoted, and never refuses', async () => {
  // R967-5 S4, and the house rule one screen away in `ticket-start.mjs:151-154`:
  // "a wrong warning is noise; a wrong refusal is a stopped session". A forge
  // outage must not be able to stop every session that starts a slice.
  const { fetchIssue } = reader({ [EPIC]: new Error('HTTP 502 from the forge') });

  const r = await resolveBase({ issue: slice(), args: args(), fetchIssue });

  assert.equal(r.ok, true, 'fail OPEN — an unreachable epic is not a refusal');
  assert.equal(r.base, 'main');
  assert.equal(r.say.key, 'ticket.base.epicUnreadable');
  assert.equal(r.say.params.epic, EPIC);
  assert.match(r.say.params.message, /502/, 'the reason is quoted, not summarised away');
  assert.equal(r.refusal, undefined);
});

test('an epic whose body cannot be parsed fails open the same way', async () => {
  // Two `brain-graph/1` blocks: the parser refuses to pick one, and that refusal
  // is a body that cannot be read — the second half of R967-5 S4.
  const twoBlocks = `${epicBody({ tracker: TRACKER })}\n\n${epicBody({ tracker: 'feature/other' })}`;
  const { fetchIssue } = reader({ [EPIC]: twoBlocks });

  const r = await resolveBase({ issue: slice(), args: args(), fetchIssue });

  assert.equal(r.ok, true);
  assert.equal(r.base, 'main');
  assert.equal(r.say.key, 'ticket.base.epicUnreadable');
});

test('a parent that cannot be found fails open, and is not read as "no epic"', async () => {
  const { fetchIssue } = reader({});

  const r = await resolveBase({ issue: slice(), args: args(), fetchIssue });

  assert.equal(r.ok, true);
  assert.equal(r.base, 'main');
  assert.equal(r.say.key, 'ticket.base.epicUnreadable');
});

// ── Row 4: an explicit `main` against a declared tracker is REFUSED ───────

test('--base main against a declared tracker refuses, naming the tracker and the way out', async () => {
  // R967-6 S2. The only refusal this leaf emits, and it exists because the
  // silent alternative — honouring `main` — is how a slice ends up merged into
  // the default branch while its epic is still in flight.
  const { fetchIssue } = reader({ [EPIC]: epicBody({ tracker: TRACKER }) });

  const r = await resolveBase({
    issue: slice(), args: args({ baseExplicit: true }), fetchIssue,
  });

  assert.equal(r.ok, false);
  assert.equal(r.refusal.key, 'ticket.error.baseIsTracked');
  assert.equal(r.refusal.params.tracker, TRACKER);
  assert.equal(r.refusal.params.epic, EPIC);
  assert.equal(r.refusal.params.flag, OFF_TRACKER_FLAG, 'a refusal that names no way out is a wall');
  assert.equal(r.base, undefined, 'a refusal carries no base — the caller must not be able to proceed');
});

// ── Row 5: the override is honoured, and said ────────────────────────────

test(`${OFF_TRACKER_FLAG} is honoured and names the tracker it went off`, async () => {
  // R967-6 S3. The opt-out is a decision an operator states out loud, in the
  // shape `--in-place` already established for this verb.
  const { fetchIssue } = reader({ [EPIC]: epicBody({ tracker: TRACKER }) });

  const r = await resolveBase({
    issue: slice(), args: args({ baseExplicit: true, offTracker: true }), fetchIssue,
  });

  assert.equal(r.ok, true);
  assert.equal(r.base, 'main');
  assert.equal(r.say.key, 'ticket.base.offTracker');
  assert.equal(r.say.params.tracker, TRACKER);
});

test(`${OFF_TRACKER_FLAG} with nothing to override is harmless`, async () => {
  // R967-6 S5. A flag that throws when it has no work to do is a flag nobody
  // can safely put in a script.
  const { fetchIssue } = reader({});

  const r = await resolveBase({
    issue: slice(null), args: args({ offTracker: true }), fetchIssue,
  });

  assert.equal(r.ok, true);
  assert.equal(r.base, 'main');
  assert.equal(r.say.key, 'ticket.base.noEpic');
  assert.equal(r.say.params.reason, 'no-parent');
});

// ── Row 6: another explicit base is today's behaviour, byte for byte ──────

test('--base feature/other is returned untouched, and the forge is never called', async () => {
  // R967-6 S4. An operator who names a base has answered the question this leaf
  // exists to answer; reading the epic anyway would spend a network round trip
  // to produce a message nobody asked for and a chance to fail.
  const { fetchIssue, calls } = reader({ [EPIC]: epicBody({ tracker: TRACKER }) });

  const r = await resolveBase({
    issue: slice(), args: args({ baseBranch: 'feature/other', baseExplicit: true }), fetchIssue,
  });

  assert.equal(r.ok, true);
  assert.equal(r.base, 'feature/other');
  assert.equal(r.say, null, 'no message: this path is unchanged from before the change');
  assert.deepEqual(calls, [], 'not one call — an explicit base is not a question');
});

// ── The leaf never returns a MESSAGE, and never reads a TITLE ─────────────

test('every outcome carries a key and params, never a rendered sentence', async () => {
  // D7. `t()` is async and locale-bound; a resolver that rendered its own
  // messages would be untestable without i18n and would put operator strings
  // outside the catalogs, where the en/es parity test cannot see them.
  const { fetchIssue } = reader({ [EPIC]: epicBody({ tracker: TRACKER }) });

  const resolved = await resolveBase({ issue: slice(), args: args(), fetchIssue });
  const refused = await resolveBase({
    issue: slice(), args: args({ baseExplicit: true }), fetchIssue,
  });

  for (const m of [resolved.say, refused.refusal]) {
    assert.match(m.key, /^ticket\./);
    assert.equal(typeof m.params, 'object');
  }
});

test('nothing in this leaf matches an issue title (R967-9)', async () => {
  // The `epic(...)` title prefix is decoration. A resolver that read it would
  // hand an editorial choice about a title the power to redirect a branch.
  const src = readFileSync(fileURLToPath(new URL('./ticket-base.mjs', import.meta.url)), 'utf8');

  assert.doesNotMatch(src, /\.title/, 'the leaf must never read an issue title');
  assert.doesNotMatch(src, /epic\(/, 'no `epic(` prefix matching anywhere');
});
