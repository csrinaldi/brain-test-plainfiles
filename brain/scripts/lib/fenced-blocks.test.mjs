// fenced-blocks.test.mjs — issue #495 task 1.
//
// The three cases below moved VERBATIM out of `amendment-draft.test.mjs` when
// `fencedBlocks` was extracted (design D2). Their bodies are byte-identical to
// the ones that lived there; that identity IS the purity proof for the move, and
// it is checkable rather than asserted — `git log -p` shows a delete and an
// insert of the same text.
//
// They stayed with the function rather than being re-exported from
// `amendment-draft.mjs`, because a re-export would leave two import paths for one
// symbol and the next reader could not tell which is canonical.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fencedBlocks } from './fenced-blocks.mjs';

test('fencedBlocks: reads the info string and the verbatim content of each block', () => {
  const { blocks } = fencedBlocks('text\n```one\na\nb\n```\nmore\n```two\nc\n```\n');
  assert.deepEqual(
    blocks.map((b) => [b.tag, b.content]),
    [
      ['one', 'a\nb'],
      ['two', 'c'],
    ],
  );
});

test('fencedBlocks: a shorter fence inside a longer one is CONTENT, not a block', () => {
  const { blocks } = fencedBlocks('````outer\n```inner\nx\n```\n````\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].tag, 'outer');
  assert.equal(blocks[0].content, '```inner\nx\n```');
});

test('fencedBlocks: an unterminated fence yields no block, and REPORTS the line it opened on', () => {
  const { blocks, unterminated } = fencedBlocks('x\n```one\na\n');
  assert.deepEqual(blocks, []);
  assert.deepEqual(unterminated, { tag: 'one', line: 2 });
});

// ─────────────────────────────────────────────────────────────────────────────
// #709 — the 14-axis matrix (design D2–D5, D8, D14).
//
// Appended BELOW the three cases above, which stay VERBATIM: they are the purity
// proof of #495's extraction, and rewriting them would delete the evidence rather
// than the defect.
//
// That rule already earned its keep during this change. A first pass added `lang` to
// `unterminated` for symmetry with `blocks[]`, which forced an edit to the third case
// — `deepEqual` asserts the WHOLE object, so one extra field is a breaking change
// wearing an additive costume, and D14's safety argument for the two sibling consumers
// rests on the contract being genuinely additive. The field was removed, not the
// assertion. Callers derive the first word themselves; `epic-graph.mjs` already does.
//
// Why a matrix and not a handful of cases: three predecessors (#639→#702,
// #703→#710) each shipped a green suite that was green because no test VARIED the
// axis the next reviewer broke. An axis is listed here even where today's answer is
// "unchanged", because the point is that the answer is now PINNED.
// ─────────────────────────────────────────────────────────────────────────────

const L = (...lines) => lines.join('\n');
const F = '```';

// ── Axis 1 — the info string's first word is `lang`; `tag` keeps the whole string ──

test('#709 axis 1: lang is the first word of the info string, and tag is still the whole trimmed string', () => {
  const { blocks } = fencedBlocks(L(
    F, 'untagged', F,
    F + 'yaml', 'a', F,
    F + 'brain-graph/1', 'b', F,
    F + 'console', 'c', F,
  ));
  assert.deepEqual(blocks.map((b) => [b.tag, b.lang]), [
    ['', ''],
    ['yaml', 'yaml'],
    ['brain-graph/1', 'brain-graph/1'],
    ['console', 'console'],
  ]);
});

test('#709 axis 1: yml and YAML are their own langs — no aliasing, no case folding', () => {
  const { blocks } = fencedBlocks(L(F + 'yml', 'a', F, F + 'YAML', 'b', F));
  assert.deepEqual(blocks.map((b) => b.lang), ['yml', 'YAML']);
});

// ── Axis 2 — backtick and tilde are peers, and never close each other ──

test('#709 axis 2: a tilde fence opens and closes exactly like a backtick fence', () => {
  const { blocks } = fencedBlocks(L('~~~yaml', 'a', '~~~'));
  assert.deepEqual(blocks.map((b) => [b.tag, b.content]), [['yaml', 'a']]);
});

test('#709 axis 2: a tilde run does NOT close a backtick fence, and the reverse', () => {
  const byTilde = fencedBlocks(L(F + 'one', 'a', '~~~', 'b'));
  assert.deepEqual(byTilde.blocks, [], 'the tilde run is content; the backtick fence never closed');
  assert.equal(byTilde.unterminated.tag, 'one');

  const byBacktick = fencedBlocks(L('~~~one', 'a', F, 'b'));
  assert.deepEqual(byBacktick.blocks, []);
  assert.equal(byBacktick.unterminated.tag, 'one');
});

// ── Axis 3 — nesting, in BOTH directions ──

test('#709 axis 3: a tilde fence inside a backtick fence is content, not a boundary', () => {
  const { blocks } = fencedBlocks(L(F + 'outer', '~~~inner', 'x', '~~~', F));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, L('~~~inner', 'x', '~~~'));
});

test('#709 axis 3: a backtick fence inside a tilde fence is content, not a boundary', () => {
  const { blocks } = fencedBlocks(L('~~~outer', F + 'inner', 'x', F, '~~~'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, L(F + 'inner', 'x', F));
});

// ── Axis 4 — closer run length ──

test('#709 axis 4: a closer run SHORTER than the opener is content, not a close', () => {
  const { blocks, unterminated } = fencedBlocks(L('````outer', 'a', F, 'b'));
  assert.deepEqual(blocks, []);
  assert.equal(unterminated.tag, 'outer');
});

test('#709 axis 4: a closer run LONGER than the opener closes — the loose direction, decided (D2)', () => {
  const { blocks } = fencedBlocks(L(F + 'one', 'a', '`````'));
  assert.deepEqual(blocks.map((b) => [b.tag, b.content]), [['one', 'a']]);
});

test('#709 axis 4: a run of the right length but carrying trailing text does not close', () => {
  const { blocks, unterminated } = fencedBlocks(L(F + 'one', 'a', F + ' trailing'));
  assert.deepEqual(blocks, []);
  assert.equal(unterminated.tag, 'one');
});

// ── Axis 5 — indentation ──

test('#709 axis 5: a 1–3 space opener declares, and its content is de-indented by the opener indent', () => {
  const { blocks } = fencedBlocks(L('   ' + F + 'yaml', '   track: A', '   ' + F));
  assert.deepEqual(blocks.map((b) => [b.tag, b.content]), [['yaml', 'track: A']]);
});

test('#709 axis 5: a 4+ space opener is an indented CODE BLOCK — it declares nothing', () => {
  const { blocks, skipped } = fencedBlocks(L('    ' + F + 'brain-graph/1', '    track: A', '    ' + F));
  assert.deepEqual(blocks, [], 'the renderer shows this as content, and so does the reader');
  assert.equal(skipped.length, 2, 'both 4-space fence-shaped lines are recorded');
  assert.equal(skipped[0].reason, 'indented-code');
  assert.equal(skipped[0].lang, 'brain-graph/1');
});

// ── Axis 6 — blockquote ──

test('#709 axis 6: a blockquoted fence does not declare, and is RECORDED as skipped', () => {
  const { blocks, skipped } = fencedBlocks(L('> ' + F + 'brain-graph/1', '> track: A', '> ' + F));
  assert.deepEqual(blocks, []);
  assert.equal(skipped.length, 2);
  assert.equal(skipped[0].reason, 'blockquote');
  assert.equal(skipped[0].lang, 'brain-graph/1');
  assert.equal(skipped[0].line, 1);
});

test('#709 axis 6: a blockquote does not swallow a real declaration that follows it', () => {
  const { blocks } = fencedBlocks(L('> ' + F + 'quoted', '> x', '> ' + F, '', F + 'brain-graph/1', 'track: A', F));
  assert.deepEqual(blocks.map((b) => [b.lang, b.content]), [['brain-graph/1', 'track: A']]);
});

// ── Axis 7 — list-item nesting ──

test('#709 axis 7: a fence indented under a list bullet declares, with content de-indented', () => {
  const { blocks } = fencedBlocks(L('- a bullet:', '', '  ' + F + 'brain-graph/1', '  track: A', '  ' + F));
  assert.deepEqual(blocks.map((b) => [b.lang, b.content]), [['brain-graph/1', 'track: A']]);
});

// ── Axis 8 — HTML comment ──

test('#709 axis 8: a fence inside an HTML comment does not declare, and is RECORDED', () => {
  const { blocks, skipped, unterminatedComment } = fencedBlocks(
    L('<!--', F + 'brain-graph/1', 'track: A', F, '-->'),
  );
  assert.deepEqual(blocks, []);
  assert.equal(unterminatedComment, null);
  assert.equal(skipped.length, 2);
  assert.equal(skipped[0].reason, 'html-comment');
  assert.equal(skipped[0].lang, 'brain-graph/1');
});

test('#709 axis 8: a one-line comment does not open COMMENT state, so the fence after it declares', () => {
  const { blocks } = fencedBlocks(L('<!-- a note -->', F + 'brain-graph/1', 'track: A', F));
  assert.deepEqual(blocks.map((b) => b.lang), ['brain-graph/1']);
});

test('#709 axis 8 / D4: a comment opener INSIDE a fence is content — FENCE state is entered first', () => {
  const { blocks } = fencedBlocks(L(F + 'one', '<!--', 'x', '-->', F));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].content, L('<!--', 'x', '-->'));
});

// ── Axis 9 — line endings ──

test('#709 axis 9: CRLF and LF produce identical openers, closers and content', () => {
  const lf = fencedBlocks(L(F + 'yaml', 'track: A', F));
  const crlf = fencedBlocks([F + 'yaml', 'track: A', F].join('\r\n'));
  assert.deepEqual(crlf, lf);
});

// ── Axis 10 — the unterminated fence, reported UNCONDITIONALLY (D5) ──

test('#709 axis 10: blocks closed ABOVE an unterminated opener stand, and nothing below is a block', () => {
  const { blocks, unterminated } = fencedBlocks(
    L(F + 'first', 'a', F, F + 'runaway', 'b', F + 'never-a-block', 'c'),
  );
  assert.deepEqual(blocks.map((b) => [b.tag, b.content]), [['first', 'a']]);
  assert.deepEqual(unterminated, { tag: 'runaway', line: 4 });
});

test('#709 axis 10 / D5: the unterminated fence is reported whatever its tag — no attribution branch', () => {
  // #710 finding 4: this axis was unpinned at 139 pass / 0 fail. A reader that filtered
  // this report by tag would answer `null` for two of the three bodies below.
  for (const tag of ['brain-graph/1', 'console', '']) {
    const { unterminated } = fencedBlocks(L('prose', F + tag, 'a'));
    assert.deepEqual(
      unterminated,
      { tag, line: 2 },
      `an unterminated ${tag || '(untagged)'} fence must be reported like any other`,
    );
  }
});

// ── Axis 11 — trailing attributes in the info string ──

test('#709 axis 11: trailing attributes leave tag whole and lang the first word', () => {
  const { blocks } = fencedBlocks(L(F + 'brain-graph/1 title="x"', 'track: A', F));
  assert.equal(blocks[0].tag, 'brain-graph/1 title="x"');
  assert.equal(blocks[0].lang, 'brain-graph/1');
});

// ── Axis 12 — case ──

test('#709 axis 12: lang is exact-case — BRAIN-GRAPH/1 is a different lang, not a near-miss to forgive', () => {
  const { blocks } = fencedBlocks(L(F + 'BRAIN-GRAPH/1', 'a', F, F + 'Brain-Graph/1', 'b', F));
  assert.deepEqual(blocks.map((b) => b.lang), ['BRAIN-GRAPH/1', 'Brain-Graph/1']);
});

// ── Axis 13 — multiplicity ──

test('#709 axis 13: every fence is returned, in document order — the splitter selects nothing', () => {
  const { blocks } = fencedBlocks(L(
    F + 'yaml', 'protocol: brain-graph/1', F,
    F + 'brain-graph/1', 'track: A', F,
    F + 'brain-graph/1', 'track: B', F,
  ));
  assert.deepEqual(blocks.map((b) => b.lang), ['yaml', 'brain-graph/1', 'brain-graph/1']);
});

// ── Axis 14 — position ──

test('#709 axis 14: position selects nothing — first, last and only read the same', () => {
  const only = fencedBlocks(L(F + 'brain-graph/1', 'track: A', F));
  const last = fencedBlocks(L(F + 'log', 'noise', F, F + 'brain-graph/1', 'track: A', F));
  const first = fencedBlocks(L(F + 'brain-graph/1', 'track: A', F, F + 'log', 'noise', F));
  const graph = (r) => r.blocks.filter((b) => b.lang === 'brain-graph/1');
  assert.deepEqual(graph(only), graph(last).map((b) => ({ ...b, line: 1 })));
  assert.equal(graph(first).length, 1);
  assert.equal(graph(last).length, 1);
});

// ── Scenarios the axes do not name on their own ──

test('#709 scenario: the tilde-nesting attack yields no backtick block at all', () => {
  const { blocks } = fencedBlocks(L(
    '~~~console',
    F + 'yaml',
    'protocol: brain-graph/1',
    F,
    '~~~',
  ));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lang, 'console', 'the inner backtick fence is CONTENT of the tilde block');
  assert.equal(blocks.filter((b) => b.lang === 'yaml').length, 0);
});

test('#709 scenario: a legally indented closer closes a column-0 opener, and swallows nothing after', () => {
  const { blocks } = fencedBlocks(L(F + 'one', 'a', '  ' + F, 'after', F + 'two', 'b', F));
  assert.deepEqual(blocks.map((b) => [b.tag, b.content]), [['one', 'a'], ['two', 'b']]);
});

// ── Non-axis obligations ──

test('#709 D14: an indent-0 opener extracts content BYTE-for-byte — de-indentation is a no-op', () => {
  // Load-bearing: `amend-find` content is an EXACT anchor for in-place edits to signed
  // doctrine files, so a one-space shift would silently re-target a destructive edit.
  const content = L('  two leading spaces', '\tone tab', '', 'trailing   ');
  const { blocks } = fencedBlocks(L(F + 'amend-find', content, F));
  assert.equal(blocks[0].content, content);
});

test('#709: skipped carries the right reason for each of its three values, asserted individually', () => {
  const { skipped } = fencedBlocks(L(
    '> ' + F + 'quoted',
    '    ' + F + 'indented',
    '<!--',
    F + 'commented',
    '-->',
  ));
  assert.deepEqual(
    skipped.map((s) => [s.reason, s.lang]),
    [['blockquote', 'quoted'], ['indented-code', 'indented'], ['html-comment', 'commented']],
  );
});

test('#709 D5: unterminatedComment never populates unterminated, and the reverse', () => {
  const comment = fencedBlocks(L('<!--', 'a note that never closes'));
  assert.equal(comment.unterminated, null, 'a comment must not be reported as a fenced block');
  assert.deepEqual(comment.unterminatedComment, { line: 1 });

  const fence = fencedBlocks(L(F + 'one', 'a'));
  assert.equal(fence.unterminatedComment, null);
  assert.deepEqual(fence.unterminated, { tag: 'one', line: 1 });
});
