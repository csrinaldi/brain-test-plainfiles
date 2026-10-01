// spec-cards.test.mjs — R881-8 Spec tab, D11. `spec.md`'s
// `### R<issue>-<n>: <title>` / `#### Scenario: <name>` /
// `- **WHEN** … **THEN** …` grammar, parsed deterministically into
// requirement/scenario cards, each carrying `{path, line}`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSpecCards } from './spec-cards.mjs';

const PATH = 'openspec/changes/issue-881-ui-server-canvas/spec.md';

test('#881: a fixture spec.md parses into requirement cards with their scenarios and line numbers', () => {
  const text = [
    '### R881-6: every open issue is a node, coloured by its computed state',
    '',
    '#### Scenario: no node is filtered away',
    '- **WHEN** the graph has 90 open issues, some undeclared, some unreadable',
    '- **THEN** the canvas renders 90 nodes, one per issue, none omitted',
    '',
    '#### Scenario: blocked overrides state colour',
    '- **WHEN** a node has an open blockedBy',
    '- **THEN** the node renders with the blocked mark',
  ].join('\n');
  const { ok, value: cards } = parseSpecCards({ text, path: PATH });
  assert.equal(ok, true);
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.equal(card.id, 'R881-6');
  assert.equal(card.title, 'every open issue is a node, coloured by its computed state');
  assert.equal(card.line, 1);
  assert.deepEqual(card.source, { path: PATH, line: 1 });
  assert.equal(card.scenarios.length, 2);
  assert.equal(card.scenarios[0].name, 'no node is filtered away');
  assert.equal(card.scenarios[0].when, 'the graph has 90 open issues, some undeclared, some unreadable');
  assert.equal(card.scenarios[0].then, 'the canvas renders 90 nodes, one per issue, none omitted');
  assert.equal(card.scenarios[0].complete, true);
  assert.deepEqual(card.scenarios[0].source, { path: PATH, line: 3 });
});

test('#881: an empty spec.md parses to zero cards — a fact, not a failure', () => {
  const { ok, value: cards } = parseSpecCards({ text: '', path: PATH });
  assert.equal(ok, true);
  assert.deepEqual(cards, []);
});

test('#881: a heading with no scenarios yet still yields a card, with an empty scenarios array', () => {
  const text = '### R881-9: degradation is stated, never silent';
  const { ok, value: cards } = parseSpecCards({ text, path: PATH });
  assert.equal(ok, true);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].scenarios, []);
});

test('#881: a scenario with WHEN but no THEN is kept, marked incomplete, never dropped or thrown', () => {
  const text = [
    '### R881-1: something',
    '#### Scenario: half-written',
    '- **WHEN** a thing happens',
  ].join('\n');
  assert.doesNotThrow(() => parseSpecCards({ text, path: PATH }));
  const { value: cards } = parseSpecCards({ text, path: PATH });
  assert.equal(cards[0].scenarios.length, 1);
  assert.equal(cards[0].scenarios[0].when, 'a thing happens');
  assert.equal(cards[0].scenarios[0].then, null);
  assert.equal(cards[0].scenarios[0].complete, false);
});

test('#881: CRLF line endings parse the same as LF', () => {
  const lf = ['### R1-1: a', '#### Scenario: s', '- **WHEN** w', '- **THEN** t'].join('\n');
  const crlf = lf.replaceAll('\n', '\r\n');
  const { value: fromLf } = parseSpecCards({ text: lf, path: PATH });
  const { value: fromCrlf } = parseSpecCards({ text: crlf, path: PATH });
  assert.deepEqual(fromLf, fromCrlf);
});

test('#881: no text given is a said failure, never an empty array read as "no requirements"', () => {
  const result = parseSpecCards({ text: null, path: PATH });
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
});

// ── #1059: a spec it cannot parse is not a spec with nothing in it ─────────
// Found by the maintainer: "cuando hago click en SDD u otro menú en el lateral
// no veo la info relacionada". The Spec tab of #1059 said "this tab's source
// was read and has nothing in it" while the SDD tab said spec.md was present.
// Both were reading the same 5,731-byte file. The file used `##` for its
// requirement headings and the grammar declares `###`, so the parser found no
// cards and returned an EMPTY LIST — `evidence-reader-empty-on-failure` in its
// purest form, and the one anti-pattern this page exists to refuse.
test('#1059: text with no requirement heading is a stated failure, never an empty card list', () => {
  const text = [
    '# Spec — issue-1059-design-structure',
    '',
    '## R1059-1: the status bar is the design\'s region 01',
    '',
    'The bar MUST carry the branch served and the node counts.',
    '',
    '- **WHEN** the graph holds four nodes',
    '- **THEN** the bar says so.',
  ].join('\n');

  const parsed = parseSpecCards({ text, path: 'openspec/changes/issue-1059/spec.md' });

  assert.equal(parsed.ok, false, 'a file with 8 lines of content has something in it — saying otherwise is a lie the reader acts on');
  assert.match(parsed.reason, /### R/, 'the reason names the heading the grammar wants, so the author can fix it without reading the parser');
  assert.match(parsed.reason, /openspec\/changes\/issue-1059\/spec\.md/, 'and names the file it read');
});

test('#1059: a spec.md that really is empty still reads as empty, not as a failure', () => {
  for (const text of ['', '   \n\n  \t\n']) {
    const parsed = parseSpecCards({ text, path: 'x/spec.md' });
    assert.equal(parsed.ok, true, 'nothing in the file IS nothing to say — this is the one case where an empty list is the truth');
    assert.deepEqual(parsed.value, []);
  }
});

test('#1059: a WHEN or THEN that belongs to no scenario is carried as a stated divergence, never dropped', () => {
  const text = [
    '### R1-1: a requirement whose author forgot the scenario heading',
    '',
    '- **WHEN** something happens',
    '- **THEN** something follows.',
  ].join('\n');

  const parsed = parseSpecCards({ text, path: 'y/spec.md' });
  assert.equal(parsed.ok, true, 'the requirement itself parsed, so the file is readable');
  assert.equal(parsed.value.length, 1);
  assert.equal(parsed.value[0].scenarios.length, 0);
  assert.ok(Array.isArray(parsed.orphans), 'the lines that attached to nothing are carried');
  assert.equal(parsed.orphans.length, 2, 'both of them — a dropped WHEN is a requirement the page silently stops testing');
  assert.deepEqual(parsed.orphans.map((o) => o.line), [3, 4]);
  assert.match(parsed.orphans[0].reason, /Scenario/, 'and each says what heading it was missing');
});
