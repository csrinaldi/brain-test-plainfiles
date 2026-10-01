// epic-map.test.mjs — issue #459.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGraphBlock, buildGraph, filesOverlap, declaredParent, READY, BLOCKED, AWAITING_HUMAN, UNCLASSIFIED } from './epic-graph.mjs';
import { renderMermaid, renderSummary, replaceMapRegion, outsideRegion, BEGIN, END } from './epic-render.mjs';
import { parseArgs, composeMap, main } from './epic-map.mjs';

// #709: the declaration is the fence TAG, not an interior `protocol:` scalar — so
// the fixture no longer writes one. Every existing test below reuses this builder
// and therefore exercises the new shape without being individually rewritten.
const block = ({ track = 'A', needs = [], blocks = [], files = [] } = {}) =>
  ['```brain-graph/1', `track: ${track}`,
    `needs: ${JSON.stringify(needs)}`, `blocks: ${JSON.stringify(blocks)}`,
    `files: ${JSON.stringify(files)}`, '```'].join('\n');

/** The pre-#709 shape: ```yaml + `protocol: brain-graph/1` inside. Used only by
 * the tests below that specifically pin its refusal (D7) — it must not become the
 * default fixture, or the suite would stop exercising the tag-based selector. */
const legacyBlock = ({ track = 'A', needs = [], blocks = [], files = [] } = {}) =>
  ['```yaml', 'protocol: brain-graph/1', `track: ${track}`,
    `needs: ${JSON.stringify(needs)}`, `blocks: ${JSON.stringify(blocks)}`,
    `files: ${JSON.stringify(files)}`, '```'].join('\n');

/**
 * The FULL shape `parseGraphBlock` returns, with #967's keys at their defaults.
 *
 * Every site below keeps `assert.deepEqual` against this, so the assertion stays a
 * full-shape comparison and a STRAY KEY STILL FAILS (design D11). Rewriting any of
 * them to `partialDeepStrictEqual` or to per-key `assert.equal` would be the
 * weakening this helper exists to avoid: both stop noticing an extra key, which is
 * precisely what these assertions have been catching since #459.
 */
const graphShape = (o = {}) => ({
  track: null, kind: null, tracker: null, parent: null, parentSource: null,
  blocks: [], needs: [], files: [], declarationDivergences: [], ...o,
});

/** A `brain-graph/1` block carrying exactly the lines a case needs. The matrix
 * below declares keys the fixed-shape `block()` builder knows nothing about, and
 * malformed values it would never produce. */
const rawBlock = (...lines) => ['```brain-graph/1', ...lines, '```'].join('\n');

const issue = (number, o = {}) => ({
  number, title: o.title ?? `t${number}`, labels: o.labels ?? ['status:approved'],
  state: o.state ?? 'open', body: o.body ?? block(o),
  ...(o.assignees !== undefined ? { assignees: o.assignees } : {}),
  ...(o.relations !== undefined ? { relations: o.relations } : {}),
});

/** A successful native read that found nothing — distinct from `null`. */
const noRelations = { blocks: [], needs: [], foreign: 0 };

// ── the declared block ──────────────────────────────────────────────────────

test('#459: the block is read from the body as DATA', () => {
  const g = parseGraphBlock(block({ track: 'B', needs: [1], blocks: [2, 3], files: ['a/**'] }));
  assert.deepEqual(g, graphShape({ track: 'B', needs: [1], blocks: [2, 3], files: ['a/**'] }));
});

test('#967 R967-1 S2: a block declaring none of the three keys parses EXACTLY as it did before this change', () => {
  // The regression pin for the whole slice. The four new fields are `null` and
  // `declarationDivergences` is empty, and — the half a `graphShape()` comparison
  // cannot prove on its own — every pre-existing field still holds the byte-identical
  // value it held before #967, compared against the literal copied out of the
  // pre-change assertion rather than against a freshly derived one.
  const g = parseGraphBlock(block({ track: 'B', needs: [1], blocks: [2, 3], files: ['a/**'] }));
  const beforeThisChange = { track: 'B', needs: [1], blocks: [2, 3], files: ['a/**'] };
  const { kind, tracker, parent, parentSource, declarationDivergences, ...preExisting } = g;
  assert.deepEqual(preExisting, beforeThisChange, 'not one pre-existing field moved');
  assert.equal(kind, null);
  assert.equal(tracker, null);
  assert.equal(parent, null);
  assert.equal(parentSource, null);
  assert.deepEqual(declarationDivergences, [], 'declaring nothing is not a divergence');
});

test('#459: a body with no block yields null — absent is not empty', () => {
  assert.equal(parseGraphBlock('just prose'), null);
  assert.equal(parseGraphBlock(''), null);
  assert.equal(parseGraphBlock(undefined), null);
});

test('#459: a fenced block of a DIFFERENT protocol is not read as a graph block', () => {
  const other = '```yaml\nprotocol: brain-review/1\nverdict: APPROVE\nhead_sha: abc\n```';
  assert.equal(parseGraphBlock(other), null, 'three protocols share the fence primitives; only one owns this shape');
});

test('#612: track: (whitespace-only) reads as null, not the empty string', () => {
  const g = parseGraphBlock(['```brain-graph/1', 'track: ', 'needs: []', 'blocks: []', 'files: []', '```'].join('\n'));
  assert.equal(g.track, null);
});

test('#612: blocks: (whitespace-only) reads as [] — same as an empty declared list', () => {
  const g = parseGraphBlock(['```brain-graph/1', 'track: A', 'needs: []', 'blocks: ', 'files: []', '```'].join('\n'));
  assert.deepEqual(g.blocks, []);
});

test('#612: a node with track: (whitespace-only) groups under the SAME tracks-map key ("?") as an undeclared node, not its own "" group', () => {
  const withBlankTrack = issue(1, { body: ['```brain-graph/1', 'track: ', 'needs: []', 'blocks: []', 'files: []', '```'].join('\n') });
  const undeclared = issue(2, { body: 'just prose, no block at all' });
  const { tracks, nodes } = buildGraph([withBlankTrack, undeclared]);
  assert.equal(nodes[0].track, null);
  assert.equal(nodes[1].track, null);
  assert.ok(tracks.has('?'));
  assert.equal(tracks.get('?').length, 2, 'both nodes land in the SAME fallback group');
  assert.equal(tracks.has(''), false, 'the pre-repair "" group no longer exists');
});

// ── #967 D2: a malformed declaration is SAID, never dropped and never guessed ──
//
// The channel is NEW (`declarationDivergences`), not the graph's existing
// `divergences`: that array carries `{from, to, only}` edge entries, its formatter
// reads those three fields, and it is gated on a native relations read that the
// snapshot path never performs. A declaration divergence routed through it would
// print `#undefined→#undefined` in the one surface that needs it, and be `[]` in
// the other.
//
// `reason` is a STABLE TOKEN, not a sentence: the gate in this change's third slice
// has to branch on "the tracker is malformed", and a reader that string-matches
// prose to decide is a reader one wording change away from silence.

test('#967 R967-1 S6: a tracker outside the feature/ grammar is refused and said, never repaired', () => {
  const g = parseGraphBlock(rawBlock('kind: epic', 'tracker: main'));
  assert.equal(g.tracker, null, 'never silently rewritten to feature/main');
  assert.deepEqual(g.declarationDivergences, [{ key: 'tracker', value: 'main', reason: 'tracker-grammar' }]);
});

test('#967 R967-1 S6: a tracker with a .. segment is refused — the character class alone would admit it', () => {
  // `..` is spelled entirely out of `[A-Za-z0-9._-]`, so the grammar matches it and
  // the explicit refusal is what stops a traversal-shaped branch name being read as
  // a tracker. Dropping that clause turns exactly this case green again.
  const g = parseGraphBlock(rawBlock('kind: epic', 'tracker: feature/../x'));
  assert.equal(g.tracker, null);
  assert.deepEqual(g.declarationDivergences, [{ key: 'tracker', value: 'feature/../x', reason: 'tracker-grammar' }]);
});

test('#967: a nested feature/ path IS the grammar — the refusal above is about .., not about depth', () => {
  const g = parseGraphBlock(rawBlock('kind: epic', 'tracker: feature/brain-ui/wave-b'));
  assert.equal(g.tracker, 'feature/brain-ui/wave-b');
  assert.deepEqual(g.declarationDivergences, []);
});

test('#967 R967-1 S5: a tracker on a node that is not an epic is CARRIED and said, not dropped', () => {
  const g = parseGraphBlock(rawBlock('track: UI', 'tracker: feature/brain-ui'));
  assert.equal(g.tracker, 'feature/brain-ui', 'carried — the divergence is what keeps it from being honoured');
  assert.equal(g.kind, null);
  assert.deepEqual(g.declarationDivergences,
    [{ key: 'tracker', value: 'feature/brain-ui', reason: 'tracker-without-kind-epic' }]);
});

test('#967: a MALFORMED tracker on a non-epic says the grammar once, not twice', () => {
  // The grammar runs first and leaves `tracker: null`. There is no carried value left
  // to not-honour, so the second rule has nothing to say about it — one declaration,
  // one entry.
  const g = parseGraphBlock(rawBlock('track: UI', 'tracker: brain-ui'));
  assert.equal(g.tracker, null);
  assert.deepEqual(g.declarationDivergences, [{ key: 'tracker', value: 'brain-ui', reason: 'tracker-grammar' }]);
});

test('#967 R967-1 S7: a non-numeric parent is refused, never coerced to 0, NaN or a string', () => {
  // `007` and `0007` join the list: `Number()` normalised them to 7, and 7 is not the
  // byte the body wrote. "A bare positive integer" is the grammar, and a repair is
  // exactly what R967-1 forbids for the other two keys — the parser does not get to
  // decide the author meant a different issue than the one they typed.
  for (const bad of ['abc', 'main', '#878', '0', '-3', '87.5', '878x', '007', '0007']) {
    const g = parseGraphBlock(rawBlock('track: A', `parent: ${bad}`));
    assert.equal(g.parent, null, `parent: ${bad} must not become a number`);
    assert.equal(g.parentSource, null);
    assert.deepEqual(g.declarationDivergences, [{ key: 'parent', value: bad, reason: 'parent-grammar' }],
      `parent: ${bad} must be said, not dropped`);
  }
});

test('#967 R967-2 S5: two line-initial Parent: lines with different numbers is ambiguity, never a first match', () => {
  const body = ['Parent: #878 (Brain UI) — slice 3, Wave B.', '', 'and later, wrongly:', '',
    'Parent: #879 (something else).', '', block({ track: 'A' })].join('\n');
  const g = parseGraphBlock(body);
  assert.equal(g.parent, null, 'neither wins — two values for one key is ambiguity');
  assert.equal(g.parentSource, null);
  assert.deepEqual(g.declarationDivergences, [{ key: 'parent', value: '878, 879', reason: 'parent-ambiguous' }]);
});

test('#967: an issue number is bare positive digits in PROSE too — one grammar, not two', () => {
  // Measured: the prose path carried no positivity check at all, so `Parent: #0`
  // yielded `parent: 0` — a value the block path names in its own refused list. The
  // two paths read the same fact out of the same body and must not disagree about
  // what an issue number is.
  //
  // The block path SAYS `parent-grammar` because a `parent:` key is a declaration that
  // failed; a prose line that does not match the pattern is not a declaration at all
  // and says nothing (R967-2), which is the same rule that already governs `#878x`.
  for (const line of ['Parent: #0', 'Parent: #00', 'Parent: #007', 'Parent: #0007']) {
    const g = parseGraphBlock([line, '', rawBlock('track: A')].join('\n'));
    assert.equal(g.parent, null, `${line} must not become a number`);
    assert.equal(g.parentSource, null);
    assert.deepEqual(g.declarationDivergences, []);
  }
});

test('#967 R967-2 S5: TWO numbers on ONE Parent: line is the same ambiguity as two lines', () => {
  // The two-line rule refused to pick; the one-line shape slipped past it, because the
  // pattern stopped reading at the first number and the rest of the line was never
  // looked at. "Two values for one key" is the fact being refused, and it does not
  // become one value by being written with a comma.
  const body = ['Parent: #878, #879', '', rawBlock('track: A')].join('\n');
  const g = parseGraphBlock(body);
  assert.equal(g.parent, null, 'neither wins — and 878 must not win by writing order');
  assert.equal(g.parentSource, null);
  assert.deepEqual(g.declarationDivergences, [{ key: 'parent', value: '878, 879', reason: 'parent-ambiguous' }]);
});

test('#967: #881’s real line survives the one-line ambiguity rule — it carries no second #N', () => {
  // The guard is a SECOND ISSUE NUMBER, not trailing prose. The one real body this
  // reader exists for has parentheses, an em dash, a slice and a wave after the
  // number, and must still read.
  const g = parseGraphBlock(['Parent: #878 (Brain UI) — slice 3, Wave B.', '', rawBlock('track: A')].join('\n'));
  assert.equal(g.parent, 878);
  assert.equal(g.parentSource, 'prose');
  assert.deepEqual(g.declarationDivergences, []);
});

test('#967: the SAME number twice on one line is a restatement, exactly as it is across two lines', () => {
  // The rule is stated over the SET of numbers, so the one-line and two-line shapes
  // cannot disagree with each other about what counts as a restatement.
  const g = parseGraphBlock(['Parent: #878 — see #878 for the epic body.', '', rawBlock('track: A')].join('\n'));
  assert.equal(g.parent, 878, 'one answer, said twice on one line');
  assert.equal(g.parentSource, 'prose');
  assert.deepEqual(g.declarationDivergences, []);
});

// ── #967 D3: the parent — block key, else the prose line, else null. One hop. ──
//
// The two bodies below are VERBATIM from the forge, not sketched: #881's line is
// the one real declaration this reader exists to admit, and #337's is the one real
// line it must refuse. A `$`-anchored pattern (the shape the proposal carried)
// matches neither correctly — it misses #881 entirely.

test('#967 R967-2 S1: a block parent: wins and the prose line is never read — no disagreement to report', () => {
  const body = ['Parent: #879 (the prose line)', '', rawBlock('track: A', 'parent: 878')].join('\n');
  const g = parseGraphBlock(body);
  assert.equal(g.parent, 878);
  assert.equal(g.parentSource, 'block', 'the node says where its answer came from');
  assert.deepEqual(g.declarationDivergences, [],
    'the block key is the declaration; the prose line is not a second one to disagree with');
});

test('#967 R967-2 S1: a block parent: beside TWO differing prose lines is still not ambiguity', () => {
  const body = ['Parent: #879', '', 'Parent: #880', '', rawBlock('track: A', 'parent: 878')].join('\n');
  const g = parseGraphBlock(body);
  assert.equal(g.parent, 878);
  assert.equal(g.parentSource, 'block');
  assert.deepEqual(g.declarationDivergences, [], 'unread lines cannot disagree with each other');
});

test('#967 R967-2 S2: #881’s real line is read, trailing prose and all', () => {
  const body = ['# Issue #881 [OPEN] feat(ui): slice 3 — local server and the DAG canvas', '',
    'Parent: #878 (Brain UI) — slice 3, Wave B.', '',
    'No HTTP server exists in brain yet.', '', rawBlock('track: UI', 'needs: [879]')].join('\n');
  const g = parseGraphBlock(body);
  assert.equal(g.parent, 878, 'the one real body this reader exists for');
  assert.equal(g.parentSource, 'prose');
  assert.deepEqual(g.declarationDivergences, []);
});

test('#967 R967-2 S4: #337’s real mid-line Parent: declares nothing, and says nothing either', () => {
  // There the parent is #335 and the epic is #313 — one line, two different issues.
  // A relaxed `/Parent:/` would mint an edge to #335 that nobody declared. And a
  // line the pattern does not match is not a MALFORMED declaration, it is not a
  // declaration: there is nothing to say about it.
  const body = ['Issue: #337 — M10 Phase 3. Parent: #335. Epic: #313.', '', rawBlock('track: A')].join('\n');
  const g = parseGraphBlock(body);
  assert.equal(g.parent, null);
  assert.equal(g.parentSource, null);
  assert.deepEqual(g.declarationDivergences, []);
});

test('#967: an indented or quoted Parent: line declares nothing — column zero, like the fence tag', () => {
  for (const line of ['> Parent: #999', '  Parent: #999', '- Parent: #999']) {
    const g = parseGraphBlock([line, '', rawBlock('track: A')].join('\n'));
    assert.equal(g.parent, null, `${line} must not declare`);
    assert.deepEqual(g.declarationDivergences, []);
  }
});

test('#967 R967-2: a column-zero Parent: inside a FENCE is an illustration, never a declaration', () => {
  // The same rule the fence selector itself settled in #709: a body that ILLUSTRATES
  // the protocol and a body that DECLARES it must not be byte-identical to the reader.
  // `> Parent: #999` and `  Parent: #999` were already refused by column zero; a
  // fenced example is at column zero and was read — and the third case below is the
  // damaging one, where the illustration does not merely add a parent, it DELETES a
  // real declaration by manufacturing an ambiguity with it.
  const inPlainFence = ['```', 'Parent: #999', '```', '', rawBlock('track: A')].join('\n');
  const a = parseGraphBlock(inPlainFence);
  assert.equal(a.parent, null, 'a fenced example declares nothing');
  assert.equal(a.parentSource, null);
  assert.deepEqual(a.declarationDivergences, [], 'and it is not a malformed declaration either');

  // The graph fence is a fence like any other: `Parent:` is not its `parent:` key
  // (`scalar` is exact-case, anchored `^parent:`), so it is not read there either.
  const inGraphFence = parseGraphBlock(rawBlock('track: A', 'Parent: #999'));
  assert.equal(inGraphFence.parent, null, 'the block declares with `parent:`, not with prose inside itself');
  assert.equal(inGraphFence.parentSource, null);
  assert.deepEqual(inGraphFence.declarationDivergences, []);

  // An unterminated foreign fence runs to the end of the document, so everything
  // below it is content on the author's screen too.
  const swallowed = [rawBlock('track: A'), '', '```console', 'Parent: #999'].join('\n');
  const s = parseGraphBlock(swallowed);
  assert.equal(s.parent, null);
  assert.deepEqual(s.declarationDivergences, []);

  // THE MEASURED DAMAGE: an example above a REAL declaration used to make the two
  // disagree, and the refusal fell on the real one.
  const exampleThenReal = ['Here is how a slice declares its epic:', '',
    '```', 'Parent: #999', '```', '', 'Parent: #878 (Brain UI) — slice 3, Wave B.', '',
    rawBlock('track: UI')].join('\n');
  const r = parseGraphBlock(exampleThenReal);
  assert.equal(r.parent, 878, 'the one declaration outside the fence is the only one there is');
  assert.equal(r.parentSource, 'prose');
  assert.deepEqual(r.declarationDivergences, [], 'an illustration cannot disagree with a declaration');
});

test('#967 R967-2 S3: Epic: #N is NOT a synonym for Parent: #N', () => {
  const body = ['Epic: #313', '', rawBlock('track: A')].join('\n');
  const g = parseGraphBlock(body);
  assert.equal(g.parent, null, '#337 is the counterexample: parent #335, epic #313, one line');
  assert.equal(g.parentSource, null);
  assert.deepEqual(g.declarationDivergences, []);
});

// ── #967 PR D (cold review round 2, 2026-09-17): `declaredParent` — the prose ──
// fallback runs whether or not a `brain-graph/1` block exists at all.
//
// `parseGraphBlock` returns `null` BEFORE the prose scan whenever the body
// carries no graph-tagged fence (`!body.includes(GRAPH_PROTOCOL)`), so
// `Parent: #878` in a body that never declared a block was invisible to
// `buildGraph`, to `lib/ticket-base.mjs`'s `parentOf`, and to the gate —
// R967-2's own rule says the fallback applies "block or no block". This
// export is the one entry both `buildGraph` and `parentOf` now share.

test('#967 R967-2 (PR D): a body with Parent: #878 and NO block at all — parseGraphBlock alone still says null', () => {
  const body = 'Parent: #878 (Brain UI) — slice 3, Wave B.';
  assert.equal(parseGraphBlock(body), null, 'measured: no graph-tagged fence, so parseGraphBlock never runs its scan');
});

test('#967 R967-2 (PR D): declaredParent resolves the same body\'s prose parent with no block owed', () => {
  const body = 'Parent: #878 (Brain UI) — slice 3, Wave B.';
  assert.deepEqual(declaredParent(body), { parent: 878, parentSource: 'prose', ambiguousValue: null, divergence: null });
});

test('#967 R967-2 (PR D): the same Parent: line INSIDE a fence, no block — declaredParent says null too', () => {
  const body = ['```', 'Parent: #878', '```'].join('\n');
  assert.deepEqual(declaredParent(body), { parent: null, parentSource: null, ambiguousValue: null, divergence: null });
});

test('#967 R967-2 (PR D): a block declaring parent: wins over declaredParent too', () => {
  const body = rawBlock('track: A', 'parent: 878');
  assert.deepEqual(declaredParent(body), { parent: 878, parentSource: 'block', ambiguousValue: null, divergence: null });
});

test('#967 R967-2 (PR D): a body with neither a block nor a Parent: line — byte-identical either reader', () => {
  const body = 'just prose, no declaration of any kind.';
  assert.deepEqual(declaredParent(body), { parent: null, parentSource: null, ambiguousValue: null, divergence: null });
  assert.equal(parseGraphBlock(body), null);
});

test('#967 R967-2 (PR D): a MALFORMED block never falls back to prose — malformed is not absent', () => {
  const dupes = [rawBlock('track: A'), '', rawBlock('track: Z')].join('\n');
  assert.deepEqual(declaredParent(dupes), { parent: null, parentSource: null, ambiguousValue: null, divergence: null });
});

test('#967-2 (PR #1006 review round 1, finding 2): declaredParent surfaces an ambiguous prose parent, no block owed', () => {
  const body = 'Parent: #878, #879';
  assert.deepEqual(declaredParent(body), {
    parent: null, parentSource: null, ambiguousValue: '878, 879',
    divergence: { key: 'parent', value: '878, 879', reason: 'parent-ambiguous' },
  });
});

// ── PR E (tracker PR #1004, round-3 cold review): declaredParent names WHY ──
// the parent is null, so a caller (base-branch.mjs) can fail closed on a
// divergence instead of reading it the same as "no parent mentioned".

test('#967 PR E: declaredParent surfaces a parent-grammar divergence from the block key', () => {
  const body = rawBlock('track: A', 'parent: abc');
  assert.deepEqual(declaredParent(body), {
    parent: null, parentSource: null, ambiguousValue: null,
    divergence: { key: 'parent', value: 'abc', reason: 'parent-grammar' },
  });
});

test('#967 R967-10 S2: a needs: edge is never read as a parent', () => {
  // Measured, not assumed: #881 declares `needs: [879]`, a SIBLING, and #878 — the
  // real parent — declares `needs: []`. The fallback would resolve to the wrong node.
  const g = parseGraphBlock(rawBlock('track: UI', 'needs: [879]'));
  assert.deepEqual(g.needs, [879]);
  assert.equal(g.parent, null);
  assert.equal(g.parentSource, null);
  assert.deepEqual(g.declarationDivergences, []);
});

test('#967: two Parent: lines naming the SAME issue is a restatement, not ambiguity', () => {
  const body = ['Parent: #878 (Brain UI) — slice 3, Wave B.', '', 'Restated: ', '',
    'Parent: #878 again, for the reader who skipped the header.', '', rawBlock('track: A')].join('\n');
  const g = parseGraphBlock(body);
  assert.equal(g.parent, 878, 'one answer, said twice');
  assert.equal(g.parentSource, 'prose');
  assert.deepEqual(g.declarationDivergences, []);
});

test('#967: a MALFORMED block parent: does not fall through to the prose line', () => {
  // Malformed is not absent. Salvaging the prose here would make a refused
  // declaration quietly succeed by another door, and the divergence would name a
  // value the node did not end up carrying.
  const body = ['Parent: #879', '', rawBlock('track: A', 'parent: abc')].join('\n');
  const g = parseGraphBlock(body);
  assert.equal(g.parent, null);
  assert.equal(g.parentSource, null);
  assert.deepEqual(g.declarationDivergences, [{ key: 'parent', value: 'abc', reason: 'parent-grammar' }]);
});

test('#967 D3 / risk R3: a body whose BLOCK is unreadable salvages no prose parent', () => {
  // "An unreadable block asserts NOTHING — it is not half a declaration to be
  // salvaged" is this module's own rule, and reading a parent out of one would make
  // `declared: false` a lie about the same body.
  const dupes = ['Parent: #878 (Brain UI)', '', block({ track: 'A' }), '', block({ track: 'Z' })].join('\n');
  const r = parseGraphBlock(dupes);
  assert.equal(r.ok, false);
  assert.equal(r.parent, undefined, 'a refusal carries no fields to read');

  const hiddenBlock = ['Parent: #878 (Brain UI)', '', '```brain-graph/1', 'track: A'].join('\n');
  const h = parseGraphBlock(hiddenBlock);
  assert.equal(h.ok, false);
  assert.equal(h.parent, undefined);

  const noBlockAtAll = 'Parent: #878 (Brain UI) — and not one brain-graph fence in sight.';
  assert.equal(parseGraphBlock(noBlockAtAll), null, 'absent is still absent — and still not half a declaration');
});

// ── the locator: the `protocol:` scalar, not the position (#639) ────────────
//
// WHAT WAS MEASURED, because the ticket's stated repro is not the defect. Its
// headline fixture — a ```js snippet above the block — was ALREADY GREEN, and by
// accident rather than by design: `FENCE_RE` only opens on ``` or ```yaml, so it
// skips the tagged foreign OPENER, latches onto that block's CLOSING fence, and
// swallows through to the graph block, where `scalar`'s `^protocol:` anchor still
// finds the key. It is pinned below so that accident cannot silently become a
// regression, and it is labelled as what it is.
//
// The shapes that were RED are the ones the locator cannot skip: an UNTAGGED
// fence (a log excerpt — the most ordinary thing an issue body opens with) and a
// ```yaml fence carrying another protocol.

test('#639: an UNTAGGED fence above the block does not hide it — the locator reads the protocol, not the position', () => {
  const body = ['```', 'some log excerpt', '```', '', block({ track: 'C' })].join('\n');
  assert.deepEqual(parseGraphBlock(body), graphShape({ track: 'C', needs: [], blocks: [], files: [] }));
});

test('#639: a ```yaml fence of ANOTHER protocol above the block does not hide it', () => {
  const other = '```yaml\nprotocol: brain-review/2\nverdict: APPROVE\n```';
  const body = [other, '', block({ track: 'D', needs: [7] })].join('\n');
  assert.deepEqual(parseGraphBlock(body), graphShape({ track: 'D', needs: [7], blocks: [], files: [] }));
});

test('#639: a ```js snippet above the block still parses — pinned, and it was already green', () => {
  const body = ['Here is the failing call:', '', '```js', "requiredArtifactsFor('lite')", '```', '',
    block({ track: 'A', blocks: [435, 94] })].join('\n');
  assert.deepEqual(parseGraphBlock(body), graphShape({ track: 'A', needs: [], blocks: [435, 94], files: [] }));
});

test('#639: TWO graph blocks is an error naming the count, never a silent pick of one', () => {
  // The rule `parseAmendmentDraft` and `parseCheckpointClaim` already hold. The old
  // locator answered with the FIRST one and said nothing — two values for one key is
  // ambiguity, and the reader must stop picking.
  const r = parseGraphBlock([block({ track: 'A' }), '', 'and again', '', block({ track: 'Z' })].join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.error, /2 `brain-graph\/1` blocks found/);
  assert.match(r.error, /exactly once/);
});

test('#639: an unreadable block is carried out and named — it is not an issue that declared nothing', () => {
  const dupes = [block({ track: 'A', needs: [1] }), '', block({ track: 'Z' })].join('\n');
  const g = buildGraph([issue(1), { number: 9, title: 'dos bloques', labels: ['status:approved'], state: 'open', body: dupes }]);
  const n9 = g.nodes.find(n => n.number === 9);

  assert.deepEqual(g.blocksUnreadable.map(b => b.number), [9]);
  assert.match(g.blocksUnreadable[0].error, /2 `brain-graph\/1` blocks found/);
  assert.equal(n9.status, UNCLASSIFIED, 'no source placed it — that part is honest');
  assert.equal(n9.declared, false);
  assert.equal(g.edges.length, 0, 'an unreadable block asserts nothing; it is not half a declaration to salvage');
});

test('#639: the summary prints the unreadable blocks, distinct from the ones that never declared', () => {
  const dupes = [block({ track: 'A' }), '', block({ track: 'Z' })].join('\n');
  const g = buildGraph([
    { number: 9, title: 'dos bloques', labels: [], state: 'open', body: dupes },
    { number: 8, title: 'sin bloque', labels: [], state: 'open', body: 'prosa' },
  ]);
  const out = renderSummary(g);

  const ilegibles = out.match(/^.*ilegibles.*$/m)[0];
  // Both nodes are UNCLASSIFIED, and that is right — no source placed either. What
  // the map must not do is let "could not read what it declared" and "declared
  // nothing" read as the same fact, so only #9 appears on this line.
  assert.ok(ilegibles.includes('#9'));
  assert.ok(!ilegibles.includes('#8'));
  assert.match(out.match(/^.*Sin ubicar.*$/m)[0], /#8/);
});

// ── the selector is the fence TAG, not an interior scalar (#709, ADR-0032) ──

test('#709 REQ-639-1 scenario 1: untagged, foreign- and yaml-tagged fences are skipped — none carries the graph tag', () => {
  const body = ['```', 'log excerpt', '```', '', '```yaml', 'some: config', '```', '',
    '```console', 'x', '```', '', '```js', 'y', '```'].join('\n');
  assert.equal(parseGraphBlock(body), null, 'no fence tag equals brain-graph/1, so nothing is selected');
});

test('#709 D1: the legacy ```yaml + protocol: scalar shape no longer selects the block', () => {
  assert.equal(parseGraphBlock(legacyBlock({ track: 'Z' })).ok, false,
    'refused out loud (D7) below — but definitely not the parsed graph');
});

test('#709 D7: the legacy shape is refused OUT LOUD, naming the retag — never silently read as absent', () => {
  const r = parseGraphBlock(legacyBlock({ track: 'A' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /retag/, 'the reader must be told what to do, not just that reading failed');
  assert.match(r.error, /brain-graph\/1/);
});

test('#709 D1/axis 12: BRAIN-GRAPH/1 and Brain-Graph/1 (wrong case) do not declare — exact case only', () => {
  const upper = '```BRAIN-GRAPH/1\ntrack: A\nneeds: []\nblocks: []\nfiles: []\n```';
  const mixed = '```Brain-Graph/1\ntrack: A\nneeds: []\nblocks: []\nfiles: []\n```';
  assert.equal(parseGraphBlock(upper), null, 'no whitelist of near-misses to forgive (D1)');
  assert.equal(parseGraphBlock(mixed), null);
});

test('#709 D1/axis 11: trailing attributes after the tag still declare — only the first word is compared', () => {
  const withAttrs = '```brain-graph/1 title="x"\ntrack: A\nneeds: []\nblocks: []\nfiles: []\n```';
  assert.deepEqual(parseGraphBlock(withAttrs), graphShape({ track: 'A', needs: [], blocks: [], files: [] }));
});

test('#709 D1/axis 13: one declared block plus a yaml-tagged illustration of the same protocol is NOT ambiguity', () => {
  const illustration = '```yaml\nprotocol: brain-graph/1\ntrack: ignored-because-not-declared\n```';
  const body = [illustration, '', block({ track: 'A', blocks: [5] })].join('\n');
  assert.deepEqual(parseGraphBlock(body), graphShape({ track: 'A', needs: [], blocks: [5], files: [] }),
    'the illustration is not a declaration, so the tagged block reads alone');
});

test('#709 D6: an unterminated brain-graph/1-tagged fence hides the declaration and is reported, never read as absent', () => {
  const body = 'prose above\n```brain-graph/1\ntrack: A\n';
  const r = parseGraphBlock(body);
  assert.equal(r.ok, false);
  assert.match(r.error, /never closed/);
});

// ── #967 D4/D5: the node carries the four fields; the graph lifts what was said ──

test('#967 R967-1 S1: the four fields land on the node literal beside track', () => {
  const g = buildGraph([issue(1, { body: rawBlock('track: UI', 'kind: epic', 'tracker: feature/brain-ui', 'parent: 851') })]);
  const n = g.nodes[0];
  assert.equal(n.track, 'UI');
  assert.equal(n.kind, 'epic');
  assert.equal(n.tracker, 'feature/brain-ui');
  assert.equal(n.parent, 851);
  assert.equal(n.parentSource, 'block');
  assert.deepEqual(g.declarationDivergences, [], 'a parent outside the set is not a divergence');
});

test('#967 R967-1 S3: track and tracker are read from their OWN keys and cannot collide', () => {
  const g = buildGraph([issue(1, { body: rawBlock('track: UI', 'kind: epic', 'tracker: feature/brain-ui') })]);
  const n = g.nodes[0];
  assert.equal(n.track, 'UI', '`scalar` is anchored `^track:`, which never matches a `tracker:` line');
  assert.equal(n.tracker, 'feature/brain-ui');
});

test('#967 R967-1 S4: an unknown key is still ignored, and ignoring it is not a divergence', () => {
  const g = buildGraph([issue(1, { body: rawBlock('track: A', 'colour: red') })]);
  const n = g.nodes[0];
  assert.equal(n.track, 'A');
  assert.equal(n.declared, true);
  assert.deepEqual(g.declarationDivergences, [],
    'no key-schema validation is introduced anywhere — forward compatibility is free without it');
});

test('#967 R967-9 S1: an epic(...) TITLE with no kind: key is not an epic', () => {
  const g = buildGraph([issue(878, { title: 'epic(ui): Brain UI — the whole thing', body: rawBlock('track: UI') })]);
  assert.equal(g.nodes[0].kind, null, 'the title prefix stays decorative; nothing is inferred from it');
  assert.equal(g.nodes[0].tracker, null);
});

test('#967: what each body said is lifted to the graph, stamped with the issue number', () => {
  const g = buildGraph([
    issue(1, { body: rawBlock('track: A', 'tracker: main') }),
    issue(2, { body: rawBlock('track: B', 'parent: abc') }),
  ]);
  assert.deepEqual(g.declarationDivergences, [
    { number: 1, key: 'tracker', value: 'main', reason: 'tracker-grammar' },
    { number: 2, key: 'parent', value: 'abc', reason: 'parent-grammar' },
  ]);
});

test('#967 R967-4 S1: a parent IN the set that declares no kind: epic is one said entry, not an inference', () => {
  const g = buildGraph([
    issue(881, { body: rawBlock('track: UI', 'parent: 878') }),
    issue(878, { body: rawBlock('track: UI', 'tracker: feature/brain-ui') }),
  ]);
  const n878 = g.nodes.find((n) => n.number === 878);
  const n881 = g.nodes.find((n) => n.number === 881);

  assert.deepEqual(g.declarationDivergences, [
    // #878 says its own half: it declared a tracker without declaring `kind: epic`.
    { number: 878, key: 'tracker', value: 'feature/brain-ui', reason: 'tracker-without-kind-epic' },
    // and the cross-node half, which only the builder can see — both nodes named.
    { number: 881, key: 'parent', value: 878, reason: 'parent-not-epic' },
  ]);
  assert.equal(n878.kind, null, 'never inferred to be an epic because someone pointed at it');
  assert.deepEqual(g.edges, [], 'a parent is not an edge — it draws nothing');
  assert.equal(n881.status, READY, 'and it changes no status');
  assert.equal(n878.status, READY);
});

test('#967: a parent IN the set that DOES declare kind: epic says nothing', () => {
  const g = buildGraph([
    issue(881, { body: rawBlock('track: UI', 'parent: 878') }),
    issue(878, { body: rawBlock('track: UI', 'kind: epic', 'tracker: feature/brain-ui') }),
  ]);
  assert.deepEqual(g.declarationDivergences, []);
  assert.equal(g.nodes.find((n) => n.number === 878).tracker, 'feature/brain-ui');
});

test('#967 R967-4 S2: a parent ABSENT from the set says nothing — "not in this list" is not "not an epic"', () => {
  // It may be closed, or in another repository. Reporting either as a divergence
  // would manufacture one out of the shape of the query, the same distinction
  // `buildGraph` already makes for a native read it could not perform.
  const g = buildGraph([issue(881, { body: rawBlock('track: UI', 'parent: 9999') })]);
  assert.equal(g.nodes[0].parent, 9999, 'the declaration is kept');
  assert.deepEqual(g.declarationDivergences, []);
});

test('#967 R967-2 (PR D): buildGraph resolves a prose parent for a node with NO graph block at all', () => {
  const g = buildGraph([
    issue(878, { body: rawBlock('track: UI', 'kind: epic', 'tracker: feature/brain-ui') }),
    { number: 881, title: 'no block, prose parent', labels: ['status:approved'], state: 'open',
      body: 'Parent: #878 (Brain UI) — slice 3, Wave B.' },
  ]);
  const n881 = g.nodes.find((n) => n.number === 881);
  assert.equal(n881.parent, 878, 'the prose parent resolves even with no brain-graph/1 block at all');
  assert.equal(n881.parentSource, 'prose');
  assert.equal(n881.declared, false, 'a prose-only parent is a relation, not a graph declaration');
});

test('#967-2 (PR #1006 review round 1, finding 2): buildGraph says an ambiguous prose parent, no block at all', () => {
  // `declaredParent` dropped `parentFromProse(...).ambiguousValue`, and the divergence
  // lift in `buildGraph` iterates `g?.declarationDivergences` — `g` is `null` for a
  // body with no block, so the ambiguity was silently lost instead of being SAID,
  // unlike the block-bearing path (`parseGraphBlock` ~line 502-504) which already
  // reports it.
  const g = buildGraph([{ number: 881, title: 'no block, ambiguous prose parent', labels: ['status:approved'],
    state: 'open', body: 'Parent: #878, #879' }]);
  const n881 = g.nodes.find((n) => n.number === 881);
  assert.equal(n881.parent, null, 'an ambiguous prose parent resolves to no parent, same as a block would refuse it');
  assert.deepEqual(g.declarationDivergences,
    [{ number: 881, key: 'parent', value: '878, 879', reason: 'parent-ambiguous' }]);
});

test('#967: an unreadable block contributes no divergence and carries none of the four fields', () => {
  const dupes = [block({ track: 'A' }), '', block({ track: 'Z' })].join('\n');
  const g = buildGraph([{ number: 9, title: 'dos bloques', labels: [], state: 'open', body: dupes }]);
  const n9 = g.nodes[0];
  assert.equal(n9.kind, null);
  assert.equal(n9.tracker, null);
  assert.equal(n9.parent, null);
  assert.equal(n9.parentSource, null);
  assert.deepEqual(g.declarationDivergences, [],
    'an unreadable block asserts nothing — including nothing to diverge about');
  assert.deepEqual(g.blocksUnreadable.map((b) => b.number), [9], 'it is still carried out as unreadable');
});

// ── the classification ──────────────────────────────────────────────────────

test('#459: an undeclared issue is UNCLASSIFIED, never dropped and never a free leaf', () => {
  // A node that disappears for want of metadata is the same class as a commit the
  // audit never enumerates (#518): the map would report a graph it had not read.
  const g = buildGraph([issue(1), { number: 9, title: 'sin bloque', labels: [], state: 'open', body: 'prosa' }]);
  const n9 = g.nodes.find(n => n.number === 9);
  assert.equal(n9.status, UNCLASSIFIED);
  assert.equal(g.nodes.length, 2, 'it is in the graph, counted, and visible');
});

test('#459: an OPEN prerequisite blocks; a CLOSED one does not', () => {
  const g = buildGraph([
    issue(1, { state: 'closed' }),
    issue(2, { state: 'open' }),
    issue(3, { needs: [1, 2] }),
  ]);
  const n3 = g.nodes.find(n => n.number === 3);
  assert.equal(n3.status, BLOCKED);
  assert.deepEqual(n3.blockedBy, [2], 'finished work does not block — only the open prerequisite does');
});

test('#459: `A needs B` and `B blocks A` are ONE edge, declared from either end', () => {
  const fromNeeds = buildGraph([issue(1), issue(2, { needs: [1] })]);
  const fromBlocks = buildGraph([issue(1, { blocks: [2] }), issue(2)]);
  const edge = [{ from: 1, to: 2, sources: ['declared'] }];
  assert.deepEqual(fromNeeds.edges, edge);
  assert.deepEqual(fromBlocks.edges, edge);

  // And declaring BOTH ends does not double it.
  const both = buildGraph([issue(1, { blocks: [2] }), issue(2, { needs: [1] })]);
  assert.deepEqual(both.edges, edge);
});

test('#459: an unapproved issue waits on a HUMAN, not on code', () => {
  const g = buildGraph([issue(1, { labels: ['type:bug'] })]);
  assert.equal(g.nodes[0].status, AWAITING_HUMAN);
});

test('#459: approved, unblocked and declared is READY', () => {
  assert.equal(buildGraph([issue(1)]).nodes[0].status, READY);
});

// ── parallelisability is COMPUTED ───────────────────────────────────────────

test('#459: overlap is decided from `files`, not from a declared boolean', () => {
  const g = buildGraph([
    issue(1, { files: ['brain/scripts/vcs/**'] }),
    issue(2, { files: ['brain/scripts/vcs/cli.mjs'] }),
    issue(3, { files: ['docs/x.md'] }),
  ]);
  const n = (x) => g.nodes.find(v => v.number === x);
  assert.deepEqual(n(1).conflictsWith, [2], 'a prefix claim covers the file under it');
  assert.deepEqual(n(3).conflictsWith, [], 'disjoint claims parallelise');
});

test('#459: an UNDECIDABLE glob reads as overlapping — conservative in the safe direction', () => {
  // Answering "no overlap" for something it cannot parse would license two agents
  // onto one file. Refusing to decide must cost a lost parallelisation, never a
  // collision.
  assert.equal(filesOverlap(['a/*/c.mjs'], ['totally/unrelated']), true);
  assert.equal(filesOverlap(['a/**'], ['b/**']), false, 'and what it CAN decide, it decides');
});

// ── rendering ───────────────────────────────────────────────────────────────

test('#459: mermaid output is deterministic — two runs are byte-identical', () => {
  const issues = [issue(3, { needs: [1] }), issue(1, { blocks: [3] }), issue(2)];
  const a = renderMermaid(buildGraph(issues));
  const b = renderMermaid(buildGraph([...issues].reverse()));
  assert.equal(a, b, 'input order must not change the output, or the write is not idempotent');
});

test('#459: a title carrying mermaid syntax cannot break the block', () => {
  const out = renderMermaid(buildGraph([issue(1, { title: 'fix: a["b"] | c {d}' })]));
  const node = out.split('\n').find(l => l.includes('N1['));
  // The property, not the golden string: every character that ENDS a mermaid label
  // must be gone from the label's interior, or the node syntax terminates early and
  // the rest of the diagram is read as garbage.
  const inner = node.slice(node.indexOf('["') + 2, node.lastIndexOf('"]'));
  for (const c of '"<>[]{}()|') {
    assert.ok(!inner.includes(c), `the label must not carry ${c} — it breaks the node syntax`);
  }
  // …and the sanitiser must not leave the gaps it opened: replacing each stripped
  // character with a space is only half the job.
  assert.equal(node, '  N1["#1 fix: a b c d"]');
});

test('#459: an edge to an out-of-scope issue is DRAWN, not dropped', () => {
  // Dropping it would make the map claim there is no dependency — a stronger and
  // falser statement than "there is one, and it is not in this set".
  const out = renderMermaid(buildGraph([issue(1, { blocks: [999] })]));
  assert.match(out, /N999\["#999 \(fuera del alcance\)"\]/);
  assert.match(out, /N1 --> N999/);
});

test('#459: the summary reports the unplaced COUNT rather than hiding them', () => {
  const s = renderSummary(buildGraph([
    issue(1), { number: 8, title: 'x', labels: [], state: 'open', body: '' },
  ]));
  assert.match(s, /\*\*Sin ubicar\*\* \(1\)/);
  assert.match(s, /#8/);
  // The count is the point: an undeclared issue must not be quietly absorbed into
  // "Listos ahora", which would make the map overstate what is startable.
  assert.ok(!/Listos ahora:\*\* [^\n]*#8/.test(s));
});

// ── #967: the summary says the declaration divergences ─────────────────────

test('#967: the summary prints one line per declaration divergence, naming the issue, the key and the reason', () => {
  const g = buildGraph([
    issue(1, { body: rawBlock('track: A', 'tracker: main') }),
    issue(881, { body: rawBlock('track: UI', 'parent: 878') }),
    issue(878, { body: rawBlock('track: UI', 'tracker: feature/brain-ui') }),
  ]);
  const line = renderSummary(g).match(/^.*Declaraciones.*$/m)[0];
  assert.match(line, /\(3\)/, 'the count, so nothing is quietly absorbed');
  assert.match(line, /#1[^·]*tracker[^·]*main[^·]*tracker-grammar/);
  assert.match(line, /#878[^·]*tracker[^·]*feature\/brain-ui[^·]*tracker-without-kind-epic/);
  assert.match(line, /#881[^·]*parent[^·]*878[^·]*parent-not-epic/);
});

test('#967: with nothing to say the summary is BYTE-IDENTICAL, and a caller that never heard of the field still renders', () => {
  // The proof that no current caller changed. The parameter is optional and
  // defaults to `[]`: removing that default turns this red, because the second
  // call passes an object without the key — exactly the shape every caller had
  // before this change.
  const g = buildGraph([issue(1), issue(2, { body: 'prosa' })]);
  const { declarationDivergences, ...asItWasBefore } = g;
  assert.deepEqual(declarationDivergences, []);
  assert.equal(renderSummary(g), renderSummary(asItWasBefore));
  assert.ok(!renderSummary(g).includes('Declaraciones'), 'an empty array prints no line at all');
});

// ── the body write ──────────────────────────────────────────────────────────

test('#459: everything outside the markers is byte-identical afterwards', () => {
  const body = `# Épico\n\nprosa importante\n\n${BEGIN}\nviejo\n${END}\n\nmás prosa al final\n`;
  const out = replaceMapRegion(body, 'nuevo');
  assert.match(out, /nuevo/);
  assert.ok(!out.includes('viejo'));
  assert.ok(out.startsWith('# Épico\n\nprosa importante\n\n'));
  assert.ok(out.endsWith('\n\nmás prosa al final\n'));
});

test('#459: a first run on an untouched epic APPENDS, it does not rewrite', () => {
  const out = replaceMapRegion('# Épico\n\nsolo prosa', 'X');
  assert.ok(out.startsWith('# Épico\n\nsolo prosa'));
  assert.match(out, new RegExp(`${BEGIN}\\nX\\n${END}`));
});

test('#459: writing twice with unchanged input is byte-idempotent', () => {
  const once = replaceMapRegion('prosa', 'X');
  assert.equal(replaceMapRegion(once, 'X'), once);
});

test('#459: a malformed marker region (END before BEGIN) appends rather than corrupting', () => {
  const body = `${END}\ntexto\n${BEGIN}`;
  const out = replaceMapRegion(body, 'X');
  assert.ok(out.includes('texto'), 'nothing is destroyed when the markers make no sense');
});

// ── the CLI ─────────────────────────────────────────────────────────────────

test('#459: parseArgs requires an issue number', () => {
  assert.deepEqual(parseArgs(['313']), { ok: true, number: 313, dryRun: false, relations: true });
  assert.deepEqual(parseArgs(['313', '--dry-run']), { ok: true, number: 313, dryRun: true, relations: true });
  assert.equal(parseArgs([]).ok, false);
  assert.match(parseArgs(['--bogus']).error, /unknown argument/);
});

test('#533: native relations are read BY DEFAULT — the flag turns them OFF, never on', () => {
  // A second source that ships behind an opt-in flag is a source nobody turns on:
  // green in test, inert in production (#335). The flag exists for the cost, not
  // for the feature.
  assert.equal(parseArgs(['313']).relations, true);
  assert.equal(parseArgs(['313', '--no-relations']).relations, false);
});

test('#459: a failed issue list REFUSES rather than drawing a graph with holes', async () => {
  const lines = [];
  const code = await main(['313'], {
    say: (s) => lines.push(String(s)),
    config: {}, origin: { project: 'a/b' },
    vcs: { issueList: async () => { throw new Error('HTTP 500'); } },
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /could not read the issue list/);
});

test('#459: with no body-write verb on the port, it prints the region instead of pretending', async () => {
  const lines = [];
  const code = await main(['313'], {
    say: (s) => lines.push(String(s)),
    config: {}, origin: { project: 'a/b' },
    vcs: {
      issueList: async () => [{ number: 1, title: 't', labels: ['status:approved'] }],
      issueView: async () => ({ body: block({}) }),
    },
  });
  assert.equal(code, 0);
  const out = lines.join('\n');
  assert.match(out, /no issue-body write verb/);
  assert.match(out, /```mermaid/);
});

// ── slice 2: two sources, one graph (#533, ADR-0029 Decision 2) ─────────────

test('#533: an edge only the NATIVE side knows is in the graph', () => {
  // "A repo that never declares a block should still get a graph" — the ticket's
  // own words, and the reason the two sources are not exclusive.
  const g = buildGraph([
    { number: 1, title: 'sin bloque', labels: ['status:approved'], state: 'open', body: 'prosa',
      relations: { blocks: [2], needs: [], foreign: 0 } },
    issue(2, { relations: noRelations }),
  ]);
  assert.deepEqual(g.edges, [{ from: 1, to: 2, sources: ['native'] }]);
  const n1 = g.nodes.find(n => n.number === 1);
  assert.notEqual(n1.status, UNCLASSIFIED, 'a native relation PLACES the node — it is not "sin ubicar"');
  assert.deepEqual(n1.sources, ['native']);
  assert.equal(g.nodes.find(n => n.number === 2).status, BLOCKED);
});

test('#533: when both sources declare the SAME edge it is one edge, and no disagreement', () => {
  const g = buildGraph([
    issue(1, { blocks: [2], relations: { blocks: [2], needs: [], foreign: 0 } }),
    issue(2, { relations: noRelations }),
  ]);
  assert.deepEqual(g.edges, [{ from: 1, to: 2, sources: ['declared', 'native'] }]);
  assert.deepEqual(g.divergences, [], 'agreement is not a divergence');
});

test('#533: the UNION is taken and the disagreement is REPORTED — neither source overrides', () => {
  // Precedence is a way of DISCARDING an assertion. An edge either source knows
  // about is a real constraint; dropping it makes the map say "there is no
  // dependency", the stronger and falser statement. The report is what keeps the
  // union honest — a relation someone clicked by accident shows up in a list a
  // human can act on, where a silently overridden one never would.
  const g = buildGraph([
    issue(1, { blocks: [2], relations: noRelations }),            // declared only
    issue(2, { relations: { blocks: [3], needs: [], foreign: 0 } }), // native only
    issue(3, { relations: noRelations }),
  ]);
  assert.deepEqual(g.edges.map(e => [e.from, e.to, e.sources.join('+')]).sort(),
    [[1, 2, 'declared'], [2, 3, 'native']]);
  assert.deepEqual(g.divergences, [
    { from: 1, to: 2, only: 'declared' },
    { from: 2, to: 3, only: 'native' },
  ]);

  const s = renderSummary(g);
  assert.match(s, /Las dos fuentes no coinciden/);
  assert.match(s, /#1→#2 \(sólo declarado\)/);
  assert.match(s, /#2→#3 \(sólo nativo\)/);
});

test('#533: an UNREADABLE native side is not "no relations", and manufactures no divergence', () => {
  // Reporting "the declared edge is missing from native" when native could not be
  // read charges an outage to the data — the same substitution of absence for
  // emptiness the assignees half of this ticket exists to stop.
  const g = buildGraph([
    issue(1, { blocks: [2], relations: null }),
    issue(2, { relations: null }),
  ]);
  assert.deepEqual(g.relationsUnreadable, [1, 2]);
  assert.deepEqual(g.divergences, [], 'a fetch failure is not a disagreement');
  assert.deepEqual(g.edges, [{ from: 1, to: 2, sources: ['declared'] }], 'and the declared edge survives');
  assert.match(renderSummary(g), /Relaciones nativas ilegibles.*#1 #2/s);
});

test('#533: not ASKING for relations is not the same as asking and failing', () => {
  // `--no-relations` (undefined) must leave slice 1's output untouched: no
  // divergence list, no "ilegibles" line, nothing claiming a source was consulted.
  const g = buildGraph([issue(1, { blocks: [2] }), issue(2)]);
  assert.deepEqual(g.divergences, []);
  assert.deepEqual(g.relationsUnreadable, []);
  const s = renderSummary(g);
  assert.ok(!/Las dos fuentes/.test(s));
  assert.ok(!/ilegibles/.test(s));
});

test('#533: cross-repo relations are counted through to the summary, never silently dropped', () => {
  const g = buildGraph([issue(1, { relations: { blocks: [], needs: [], foreign: 2 } })]);
  assert.equal(g.foreignRelations, 2);
  assert.match(renderSummary(g), /Relaciones cross-repo omitidas:\*\* 2/);
});

test('#533: a node no source places is still UNCLASSIFIED — a successful empty read places nothing', () => {
  const g = buildGraph([
    { number: 9, title: 'x', labels: ['status:approved'], state: 'open', body: 'prosa', relations: noRelations },
  ]);
  assert.equal(g.nodes[0].status, UNCLASSIFIED, 'reading "no relations" is not the same as being placed by one');
});

// ── slice 2: the executor (#533, ADR-0029 Decision 1) ───────────────────────

test('#533: the map shows WHO — and keeps "nobody" and "cannot see" apart', () => {
  const g = buildGraph([
    issue(1, { assignees: ['alice'] }),
    issue(2, { assignees: [] }),
    issue(3, { assignees: null }),
  ]);
  const m = renderMermaid(g);
  assert.match(m, /N1\["#1 t1 · alice"\]/);
  assert.match(m, /N2\["#2 t2 · sin asignar"\]/, 'read, and nobody is on it');
  assert.match(m, /N3\["#3 t3"\]/, 'brain cannot see — it says NOTHING rather than "sin asignar"');

  const s = renderSummary(g);
  assert.match(s, /#1 → alice/);
  assert.match(s, /#2 \(sin asignar\)/);
  assert.match(s, /#3 \(\?\)/);
});

test('#533: buildGraph does not erase `null` assignees into an empty list', () => {
  // `?? []` here would silently undo the whole reason the port was widened.
  const g = buildGraph([issue(1, { assignees: null }), issue(2, { assignees: [] })]);
  assert.equal(g.nodes.find(n => n.number === 1).assignees, null);
  assert.deepEqual(g.nodes.find(n => n.number === 2).assignees, []);
});

test('#533: an assignee name carrying mermaid syntax cannot break the block', () => {
  const node = renderMermaid(buildGraph([issue(1, { assignees: ['a["b"]|c'] })]))
    .split('\n').find(l => l.includes('N1['));
  const inner = node.slice(node.indexOf('["') + 2, node.lastIndexOf('"]'));
  for (const c of '"<>[]{}()|') {
    assert.ok(!inner.includes(c), `the label must not carry ${c} — names are user text too`);
  }
});

test('#533: a READY node with no `files` is reported unverifiable, not silently parallelisable', () => {
  // An empty `conflictsWith` reads as "proven parallelisable". It proved nothing —
  // and native-only nodes carry no `files` at all, so this became routine.
  const g = buildGraph([issue(1, { files: [] }), issue(2, { files: ['a/**'] })]);
  assert.equal(g.nodes.find(n => n.number === 1).filesUnknown, true);
  assert.equal(g.nodes.find(n => n.number === 2).filesUnknown, false);
  assert.match(renderSummary(g), /Paralelización no verificable[^\n]*#1/);
});

// ── slice 2: the body write (#533, ADR-0029 Decision 3) ─────────────────────

test('#533: outsideRegion is blind to the region and exact everywhere else', () => {
  const body = `# Épico\n\nprosa\n\n${BEGIN}\nviejo\n${END}\n\nfinal\n`;
  assert.equal(outsideRegion(replaceMapRegion(body, 'nuevo')), outsideRegion(body),
    'a regeneration changes nothing outside the markers');
  assert.equal(outsideRegion(replaceMapRegion('# Épico\n\nsolo prosa', 'X')), outsideRegion('# Épico\n\nsolo prosa'),
    'and a FIRST run, which appends, is still contained');
  assert.notEqual(outsideRegion(body), outsideRegion(body.replace('prosa', 'prosa.')),
    'one character of surrounding prose is enough to differ — this is not a fuzzy check');
});

test('#533: the map REFUSES to write when the prose outside the markers would change', async () => {
  // A stray BEGIN with no END is the real shape of this: appending a full region
  // leaves the stray marker as the FIRST one, so the next run would swallow the
  // prose between it and the real END. Refuse instead of writing the trap.
  const lines = [];
  let wrote = false;
  const code = await main(['313'], {
    say: (s) => lines.push(String(s)),
    config: {}, origin: { project: 'a/b' },
    vcs: {
      issueList: async () => [{ number: 1, title: 't', labels: ['status:approved'], assignees: [] }],
      issueView: async ({ number }) => (number === 313
        ? { body: `# Épico\n\nprosa\n${BEGIN}\ntexto huérfano` }
        : { body: block({}) }),
      issueRelations: async () => noRelations,
      issueUpdate: async () => { wrote = true; return { ok: true, url: null }; },
    },
  });
  assert.equal(code, 1);
  assert.equal(wrote, false, 'nothing may be written when containment cannot be proven');
  assert.match(lines.join('\n'), /refusing to write/);
});

test('#533: the map WRITES through issueUpdate, with the body it composed', async () => {
  let seen = null;
  const lines = [];
  const code = await main(['313'], {
    say: (s) => lines.push(String(s)),
    config: {}, origin: { project: 'a/b' },
    vcs: {
      issueList: async () => [{ number: 1, title: 't', labels: ['status:approved'], assignees: ['alice'] }],
      issueView: async ({ number }) => (number === 313 ? { body: '# Épico\n\nprosa' } : { body: block({}) }),
      issueRelations: async () => noRelations,
      issueUpdate: async (args) => { seen = args; return { ok: true, url: 'u' }; },
    },
  });
  assert.equal(code, 0);
  assert.equal(seen.number, 313);
  assert.match(seen.body, /```mermaid/);
  assert.match(seen.body, /N1\["#1 t · alice"\]/, 'the executor read from issueList reaches the written body');
  assert.ok(seen.body.startsWith('# Épico\n\nprosa'), 'the prose is intact');
  assert.match(lines.join('\n'), /map regenerated/);
});

test('#533: a refused write is reported as a failure, not as a regenerated map', async () => {
  const lines = [];
  const code = await main(['313'], {
    say: (s) => lines.push(String(s)),
    config: {}, origin: { project: 'a/b' },
    vcs: {
      issueList: async () => [{ number: 1, title: 't', labels: ['status:approved'] }],
      issueView: async () => ({ body: block({}) }),
      issueRelations: async () => noRelations,
      issueUpdate: async () => ({ ok: false, error: 'HTTP 403' }),
    },
  });
  assert.equal(code, 1);
  const out = lines.join('\n');
  assert.match(out, /could not write #313: HTTP 403/);
  assert.ok(!/map regenerated/.test(out), 'a failed write must never print success');
});

test('#533: --no-relations does not call issueRelations at all', async () => {
  let called = 0;
  await main(['313', '--no-relations', '--dry-run'], {
    say: () => {},
    config: {}, origin: { project: 'a/b' },
    vcs: {
      issueList: async () => [{ number: 1, title: 't', labels: [] }],
      issueView: async () => ({ body: block({}) }),
      issueRelations: async () => { called += 1; return noRelations; },
    },
  });
  assert.equal(called, 0);
});

test('#533: a provider WITHOUT issueRelations degrades to the declared block alone', async () => {
  // A third provider that has not implemented the verb must still get slice 1's
  // map, and must not be reported as "unreadable" — it was never asked.
  const lines = [];
  const code = await main(['313', '--dry-run'], {
    say: (s) => lines.push(String(s)),
    config: {}, origin: { project: 'a/b' },
    vcs: {
      issueList: async () => [{ number: 1, title: 't', labels: ['status:approved'] }],
      issueView: async () => ({ body: block({}) }),
    },
  });
  assert.equal(code, 0);
  assert.ok(!/ilegibles/.test(lines.join('\n')));
});

test('#533: the body written is EXACTLY composeMap over the same graph — one composer, not two', () => {
  // `composeMap` is exported so a test can assert the CLI writes the same text a
  // reader can reproduce. Two spellings of one rule is the #340 defect, and here it
  // would mean the region a human reviews is not the region the verb writes.
  const issues = [
    { number: 1, title: 't', labels: ['status:approved'], state: 'open', body: block({}), assignees: ['alice'], relations: noRelations },
  ];
  const region = composeMap(buildGraph(issues));
  const body = replaceMapRegion('# Épico\n\nprosa', region);
  assert.ok(body.includes(`${BEGIN}\n${region}\n${END}`));
  assert.equal(outsideRegion(body), outsideRegion('# Épico\n\nprosa'));
});

test('#533: when NEITHER source carries assignees the map stays silent — it does not invent "sin asignar"', async () => {
  // The CLI-level twin of the port rule. A `?? []` here would undo the whole point
  // one layer above where the port defends it, and the map — the artefact a human
  // actually reads — would say "nobody is on this" about issues it never saw.
  const lines = [];
  await main(['313', '--dry-run'], {
    say: (s) => lines.push(String(s)),
    config: {}, origin: { project: 'a/b' },
    vcs: {
      issueList: async () => [{ number: 1, title: 't', labels: ['status:approved'] }],
      issueView: async () => ({ body: block({}) }),
    },
  });
  const out = lines.join('\n');
  assert.match(out, /N1\["#1 t"\]/);
  assert.ok(!/sin asignar/.test(out), 'absent must not be rendered as empty');
  assert.match(out, /#1 \(\?\)/, 'and the summary says it cannot see, rather than saying nobody');
});

test('#533: an EMPTY list from issueList is an answer — it does not fall through to issueView', async () => {
  // `||` instead of `??` here would treat "read, and nobody is assigned" as a
  // miss and quietly prefer a second, staler source.
  const lines = [];
  await main(['313', '--dry-run'], {
    say: (s) => lines.push(String(s)),
    config: {}, origin: { project: 'a/b' },
    vcs: {
      issueList: async () => [{ number: 1, title: 't', labels: ['status:approved'], assignees: [] }],
      issueView: async () => ({ body: block({}), assignees: ['fantasma'] }),
    },
  });
  const out = lines.join('\n');
  assert.match(out, /N1\["#1 t · sin asignar"\]/);
  assert.ok(!/fantasma/.test(out));
});

test('#533: issueView is the fallback when the LIST endpoint cannot carry assignees', async () => {
  const lines = [];
  await main(['313', '--dry-run'], {
    say: (s) => lines.push(String(s)),
    config: {}, origin: { project: 'a/b' },
    vcs: {
      issueList: async () => [{ number: 1, title: 't', labels: ['status:approved'] }],
      issueView: async () => ({ body: block({}), assignees: ['alice'] }),
    },
  });
  assert.match(lines.join('\n'), /N1\["#1 t · alice"\]/);
});

// ── #723 / #710: D6 row 4 — a HIDDEN declaration is refused, never reported absent ──
//
// `epic-graph.mjs` never destructured `skipped`, so the half of D6 that depends on
// it was never wired. Four shapes that HIDE a complete, well-formed declaration
// answered `null` — the value REQ-639-4 defines as "nobody declared one".
//
// This is the exact conflation #709 shipped to end, surviving inside #709's own
// delivery. Task 2.2 asked for it, but PR #720 (selector) landed BEFORE PR #722
// created `skipped` — D0 sequenced them that way on purpose — and when the field
// arrived nothing came back to wire it. The box was already checked, against the
// half that was buildable at the time.
//
// The suite was green throughout, and said nothing: no test varied this axis.

const hidden = (...lines) => lines.join('\n');
const G = '```brain-graph/1';

test('#723: a BLOCKQUOTED graph fence is refused by reason, not reported absent', () => {
  const r = parseGraphBlock(hidden('> ' + G, '> track: A', '> ```'));
  assert.equal(r?.ok, false, 'answered absent (null) about a body that declares a graph');
  assert.match(r.error, /blockquote/, 'the refusal does not name the reason');
  assert.match(r.error, /line 1\b/, 'the refusal does not name the line');
});

test('#723: an INDENTED-CODE graph fence is refused by reason, not reported absent', () => {
  const r = parseGraphBlock(hidden('    ' + G, '    track: A', '    ```'));
  assert.equal(r?.ok, false);
  assert.match(r.error, /indented/);
  assert.match(r.error, /line 1\b/);
});

test('#723: an HTML-COMMENTED graph fence is refused by reason, not reported absent', () => {
  const r = parseGraphBlock(hidden('<!--', G, 'track: A', '```', '-->'));
  assert.equal(r?.ok, false);
  assert.match(r.error, /comment/);
  assert.match(r.error, /line 2\b/, 'the refusal names the fence line, not the comment opener');
});

test('#710 finding 1 / #723: an unterminated FOREIGN fence that swallows a declaration is refused, not reported absent', () => {
  // The pre-existing branch only fired when the UNTERMINATED fence was itself
  // graph-tagged. A runaway ```console consumes the declaration below it, so the
  // graph fence never becomes a block and the unterminated tag is `console`.
  const r = parseGraphBlock(hidden('```console', '$ gh pr checks', '', G, 'track: A', 'blocks: [7]', '```'));
  assert.equal(r?.ok, false, 'a runaway foreign fence still hides the declaration silently');
  assert.match(r.error, /line 1\b/, 'the refusal does not name the fence that swallowed it');
  assert.match(r.error, /swallow|never closed/i);
});

test('#710 finding 1 / #723: a runaway fence that is NEVER closed hides it too — the other shape', () => {
  // Measured: when nothing closes the foreign fence, `unterminated` is set and
  // `blocks` is EMPTY, so the block-content scan cannot see it. Two shapes, two
  // detections; one of them alone leaves the other silent.
  const r = parseGraphBlock(hidden('```console', '$ gh pr checks', '', G, 'track: A'));
  assert.equal(r?.ok, false);
  assert.match(r.error, /never closed/i);
  assert.match(r.error, /line 1\b/);
});

test('#710 finding 1 / #723: a ~~~ runaway hides it as well — delimiters are peers', () => {
  const r = parseGraphBlock(hidden('~~~console', '$ x', '', G, 'track: A'));
  assert.equal(r?.ok, false);
  assert.match(r.error, /never closed/i);
});

test('#723: a body that merely MENTIONS the protocol in prose is still absent, not a refusal', () => {
  // The boundary. Widening row 4 into "any body containing the string" would
  // turn every issue that discusses the protocol into an unreadable block —
  // trading a silent omission for a fabricated defect, which is the trade
  // ADR-0032 exists to refuse.
  assert.equal(parseGraphBlock('we should adopt brain-graph/1 in the epic bodies'), null);
});

test('#723: an unterminated foreign fence with the protocol only ABOVE it stays absent', () => {
  // The mention is not inside the swallowed region, so nothing is hidden. The
  // refusal must key on position, not on the string appearing anywhere.
  assert.equal(parseGraphBlock(hidden('brain-graph/1 is the tag', '```console', '$ runaway')), null);
});

test('#723: a well-formed declaration is untouched by any of this', () => {
  assert.deepEqual(parseGraphBlock(block({ track: 'B', blocks: [2] })),
    graphShape({ track: 'B', blocks: [2], needs: [], files: [] }));
});

// ── #1029: the key's VALUE ends where the prose begins ─────────────────────
// Measured on issue #998's own body, which refused the Brain UI tracker PR
// (#1028): naming the parent and then saying anything else about the work on
// the same line was read as five competing declarations.
test('#1029: a Parent: line that also mentions other issues in prose declares ONE parent, not an ambiguity', () => {
  const body = [
    'Parent: #878 (Brain UI) — the surface, after slice 3. Slice 3 (#881, merged as #970) proved the data path. PR 7 is #882 content; PR 8 lands after #967.',
    '', rawBlock('track: A'),
  ].join('\n');
  const g = parseGraphBlock(body);
  assert.equal(g.parent, 878, 'the value is the reference the key names; the rest of the line is prose');
  assert.deepEqual(g.declarationDivergences, []);
});

test('#1029: two references joined only by whitespace are still two values for one key', () => {
  const g = parseGraphBlock(['Parent: #878 #879', '', rawBlock('track: A')].join('\n'));
  assert.equal(g.parent, null);
  assert.deepEqual(g.declarationDivergences, [{ key: 'parent', value: '878, 879', reason: 'parent-ambiguous' }]);
});

// #1030 cold review, correction: the value region's separator hops must not
// backtrack quadratically. Measured on the first draft: a `Parent:` line with
// a long run of spaces before a non-reference took 2.4s at 65k spaces and
// 14.5s at 160k, against 0ms for the end-of-line pattern it replaced.
test('#1029: a long run of spaces after the parent reference is scanned linearly, not quadratically', () => {
  const body = ['Parent: #878' + ' '.repeat(120_000) + 'x', '', rawBlock('track: A')].join('\n');
  const started = process.hrtime.bigint();
  const g = parseGraphBlock(body);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(g.parent, 878, 'the value is still the reference the key names');
  assert.ok(elapsedMs < 1000, `the value region must not backtrack over the run (took ${Math.round(elapsedMs)}ms)`);
});

// #1030 cold review, editorial: a comma followed by "and" is how an English
// list joins its last item; it was reading as one value plus prose.
test('#1029: a list joined by ", and" is still two values for one key', () => {
  const g = parseGraphBlock(['Parent: #878, and #879', '', rawBlock('track: A')].join('\n'));
  assert.equal(g.parent, null);
  assert.deepEqual(g.declarationDivergences, [{ key: 'parent', value: '878, 879', reason: 'parent-ambiguous' }]);
});
