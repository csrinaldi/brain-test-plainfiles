// parse-verdict.test.mjs — Unit tests for parsing a `brain-review/1` fenced
// block out of a review body (protocol §6). Used by cold-boot (rev count +
// prior verdicts), and later by the anti-loop lock and the board (H1-2/H1-5).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseVerdict } from './parse-verdict.mjs';
import { buildVerdict, renderVerdict } from '../verdict.mjs';
import { reconcileBoardLabels } from '../board.mjs';

test('parseVerdict: extracts head_sha, rev, verdict, and the passed-through author', () => {
  const body = [
    'Some prose before the block.',
    '',
    '```yaml',
    'protocol: brain-review/1',
    'verdict: REVISE',
    'head_sha: abc123',
    'rev: 1',
    'escalate: null',
    '```',
    '',
    'Prose after.',
  ].join('\n');

  const result = parseVerdict({ body, author: 'brain-reviewer' });
  assert.deepEqual(result, {
    head_sha: 'abc123',
    rev: 1,
    verdict: 'REVISE',
    author: 'brain-reviewer',
  });
});

test('parseVerdict: a body with no brain-review/1 block returns null', () => {
  assert.equal(parseVerdict({ body: 'just a regular human comment, no block here', author: 'alice' }), null);
});

test('parseVerdict: a fenced yaml block for a DIFFERENT protocol returns null', () => {
  const body = '```yaml\nprotocol: something-else/1\nhead_sha: x\nverdict: REVISE\n```';
  assert.equal(parseVerdict({ body, author: 'alice' }), null);
});

test('parseVerdict: missing body (null/undefined) returns null, never throws', () => {
  assert.equal(parseVerdict({ body: null }), null);
  assert.equal(parseVerdict({}), null);
});

test('parseVerdict: a block missing head_sha or verdict returns null (incomplete block)', () => {
  const body = '```yaml\nprotocol: brain-review/1\nrev: 0\n```';
  assert.equal(parseVerdict({ body }), null);
});

// ── sequencing (optional, H1-5c board.mjs) ──────────────────────────────────
// `sequencing:` is rendered by verdict.mjs's renderVerdict as a
// JSON-stringified value wrapped by yamlScalar's quote/escape rules
// (`sequencing: "[\"seq:merge-next\"]"`). Only present when an evaluator
// sets it — no H1 evaluator does yet, so it stays OMITTED from the parsed
// result (not merely null) whenever the block carries no `sequencing:`
// line, keeping the existing exact-key-set assertions above unaffected.

test('parseVerdict: extracts sequencing when the block carries it (JSON-array-of-labels, yamlScalar-quoted)', () => {
  const body = [
    '```yaml',
    'protocol: brain-review/1',
    'verdict: APPROVE',
    'head_sha: abc123',
    'rev: 2',
    'sequencing: "[\\"seq:merge-next\\"]"',
    '```',
  ].join('\n');

  const result = parseVerdict({ body, author: 'brain-reviewer' });
  assert.deepEqual(result.sequencing, ['seq:merge-next']);
});

test('parseVerdict: a block with no sequencing line omits the key entirely (not null)', () => {
  const body = '```yaml\nprotocol: brain-review/1\nverdict: REVISE\nhead_sha: abc123\nrev: 0\n```';
  const result = parseVerdict({ body });
  assert.equal('sequencing' in result, false);
});

test('parseVerdict: an unparseable sequencing scalar is tolerated — omitted, never throws', () => {
  const body = [
    '```yaml',
    'protocol: brain-review/1',
    'verdict: REVISE',
    'head_sha: abc123',
    'rev: 0',
    'sequencing: not-valid-json',
    '```',
  ].join('\n');
  assert.doesNotThrow(() => parseVerdict({ body }));
  const result = parseVerdict({ body });
  assert.equal('sequencing' in result, false);
});

// ── brain-review/2 support (REQ-H2-2, REQ-H2-4) ───────────────────────────

test('parseVerdict: accepts protocol: brain-review/2 alongside brain-review/1', () => {
  const body = [
    '```yaml',
    'protocol: brain-review/2',
    'verdict: REVISE',
    'head_sha: def456',
    'rev: 1',
    '```',
  ].join('\n');

  const result = parseVerdict({ body, author: 'reviewer-v2' });
  assert.deepEqual(result, {
    protocol: 'brain-review/2',
    head_sha: 'def456',
    rev: 1,
    verdict: 'REVISE',
    author: 'reviewer-v2',
  });
});

test('parseVerdict: extracts findings with evidence_class and causal_disposition from brain-review/2 block', () => {
  const body = [
    '```yaml',
    'protocol: brain-review/2',
    'verdict: REVISE',
    'head_sha: def456',
    'rev: 1',
    'findings: "[{\\"id\\":\\"R3-001\\",\\"evidence_class\\":\\"inferential\\",\\"causal_disposition\\":\\"introduced\\"}]"',
    '```',
  ].join('\n');

  const result = parseVerdict({ body, author: 'reviewer-v2' });
  assert.deepEqual(result.findings, [
    { id: 'R3-001', evidence_class: 'inferential', causal_disposition: 'introduced' },
  ]);
});

// ── #381: the REAL render -> parse round-trip ───────────────────────────────
// Every findings test above this line hand-writes its input. That is exactly
// how the defect survived: `renderVerdict` emits findings as a YAML LIST,
// `parseVerdict` only read a same-line JSON scalar, and no test ever fed one
// to the other. The tests below drive parseVerdict from ACTUAL buildVerdict +
// renderVerdict output — if the two encodings ever diverge again, these fail.

test('#381 round-trip: non-empty findings survive renderVerdict -> parseVerdict', () => {
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [
      { id: 'F-1', severity: 'blocker', evidence: 'src/a.mjs:42', cites: 'ADR-0020' },
      { id: 'F-2', severity: 'correction', evidence: 'a quoted: value, with punctuation' },
    ],
  });
  const parsed = parseVerdict({ body: renderVerdict(built), author: 'rev' });

  assert.equal(parsed.findings.length, 2, 'both findings must survive the round-trip');
  assert.deepEqual(parsed.findings[0], {
    id: 'F-1',
    severity: 'blocker',
    evidence: 'src/a.mjs:42',
    cites: 'ADR-0020',
  });
  // The second finding's evidence needed quoting on the way out; it must come
  // back un-quoted and byte-identical, not as the raw `"..."` literal.
  assert.equal(parsed.findings[1].evidence, 'a quoted: value, with punctuation');
  assert.equal(parsed.findings[1].severity, 'correction');
});

test('#381 round-trip: an empty findings array still round-trips (the case that always worked)', () => {
  const built = buildVerdict({ headSha: 'abc123', conclusion: 'APPROVE', findings: [] });
  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.deepEqual(parsed.findings, [], 'findings: [] must parse to an empty array, not null');
});

test('#381 round-trip: follow_ups survive too — they were rendered but never parsed', () => {
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    protocol: 'brain-review/2',
    findings: [
      { id: 'K-1', severity: 'blocker', evidence: 'live.mjs:7', causal_disposition: 'introduced' },
      { id: 'K-2', severity: 'blocker', evidence: 'old.mjs:9', causal_disposition: 'pre-existing' },
    ],
  });
  const parsed = parseVerdict({ body: renderVerdict(built) });

  assert.deepEqual(parsed.findings.map(f => f.id), ['K-1'], 'introduced findings stay in findings');
  assert.deepEqual(parsed.follow_ups.map(f => f.id), ['K-2'], 'pre-existing findings move to follow_ups');
  assert.equal(parsed.follow_ups[0].causal_disposition, 'pre-existing');
});

test('#381 round-trip: the list parser stops at the next top-level key', () => {
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [{ id: 'F-1', severity: 'blocker', evidence: 'x.mjs:1' }],
    conditions: ['some-condition'],
  });
  const rendered = renderVerdict(built);
  const parsed = parseVerdict({ body: rendered });

  assert.equal(parsed.findings.length, 1, 'exactly one finding — conditions must not be absorbed');
  assert.equal('conditions' in parsed.findings[0], false, 'the next key must not leak into the entry');
});

// ── issue #452: three states, three answers ─────────────────────────────────
//
// `null` is the sentinel for "the key is absent". `parseEntryList`'s last line
// made it ALSO the sentinel for "the key is present and its list is empty", so
// `parseVerdict`'s `if (x !== null)` guard dropped the field in both cases and
// a consumer could not tell them apart. That is `evidence-reader-empty-on-failure`
// in the parser — and the THIRD appearance of the #381 class in this same pair
// of functions, the second in `follow_ups`.
//
// `parseEntryList` is not exported, so these go through `parseVerdict`: the
// distinction only matters if it survives to a consumer, and the consumers
// (cold-boot.mjs:123, board.mjs:104) read exactly this shape.

/** A minimal valid /2 block with `extra` spliced in before the fence closes. */
function blockWith(extra) {
  return ['```yaml',
    'protocol: brain-review/2',
    'head_sha: abc123',
    'verdict: APPROVE',
    ...extra,
    '```'].join('\n');
}

test('#452: a key that is ABSENT leaves the property off the result', () => {
  const parsed = parseVerdict({ body: blockWith([]) });
  assert.equal('follow_ups' in parsed, false);
  assert.equal('findings' in parsed, false);
});

test('#452: a key that is PRESENT with an empty list yields [] — not the same answer as absent', () => {
  // Red before the fix: `parseEntryList` returned null here, so the property was
  // dropped and this state was indistinguishable from the one above.
  const parsed = parseVerdict({ body: blockWith(['follow_ups:']) });
  assert.equal('follow_ups' in parsed, true,
    'the key WAS in the block — a reader that reports it absent is answering a different question than the one asked');
  assert.deepEqual(parsed.follow_ups, []);
});

test('#452: a key that is PRESENT with entries yields the entries (unchanged)', () => {
  const parsed = parseVerdict({ body: blockWith(['follow_ups:', '  - id: "K-1"']) });
  assert.deepEqual(parsed.follow_ups, [{ id: 'K-1' }]);
});

test('#452: the same three states hold for findings, on the block encoding', () => {
  assert.equal('findings' in parseVerdict({ body: blockWith([]) }), false);
  assert.deepEqual(parseVerdict({ body: blockWith(['findings:']) }).findings, []);
  assert.deepEqual(parseVerdict({ body: blockWith(['findings:', '  - id: "F-1"']) }).findings, [{ id: 'F-1' }]);
});

test('#452: the INLINE empty encoding is untouched — `findings: []` still round-trips (REQ-452-3)', () => {
  // This path is caught by `scalar()` before the block branch ever runs, and it
  // is the one that ALREADY worked. #381's post-mortem records that this is
  // precisely why that defect stayed hidden — the empty case round-tripped. The
  // repair to the broken encoding must not move the working one.
  const parsed = parseVerdict({ body: blockWith(['findings: []']) });
  assert.equal('findings' in parsed, true);
  assert.deepEqual(parsed.findings, []);
});

test('#452: renderVerdict → parseVerdict closes the round trip for an empty findings list (REQ-452-4)', () => {
  const built = buildVerdict({ headSha: 'abc123', conclusion: 'APPROVE', findings: [] });
  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.deepEqual(parsed.findings, [],
    'an empty findings list must survive the trip — the field is now pinnable at the PARSER level, ' +
    'which is what PR #444 could not do (its REQ-409-6 had to assert at the wire level instead)');
});

test('#452: the renderer is UNCHANGED — follow_ups stays absent from what brain emits (REQ-452-6)', () => {
  // The in-scope check. The renderer half (should renderVerdict emit `follow_ups: []`
  // the way it emits `findings: []`?) is a PROTOCOL choice and belongs to #408, which
  // is also what makes follow_ups reachable at all. If this goes red, this change
  // touched something it was not supposed to.
  const built = buildVerdict({ headSha: 'abc123', conclusion: 'APPROVE', findings: [] });
  const rendered = renderVerdict(built);
  assert.doesNotMatch(rendered, /^follow_ups:/m);
  assert.equal('follow_ups' in parseVerdict({ body: rendered }), false);
});

// ── #452 review round: `[]` must mean EMPTY, never UNREADABLE ───────────────
//
// Cold review of PR #478, finding 1 (blocker). The first version of this change
// returned `entries` unconditionally, which made `[]` the answer for BOTH "the
// key's list is empty" and "the key had a body this parser could not read".
// Reproduced: a foreign verdict carrying REAL findings in 0-indent YAML block
// sequence — the shape `yaml.dump` emits by default — parsed as `findings: []`,
// i.e. a positive, trusted assertion that the reviewer found nothing. On main it
// was `undefined` (unknown). That inverts the failure direction on exactly the
// population this fix exists for (cold-boot/board read FOREIGN verdicts), and it
// is the anti-pattern's own rule read backwards:
//
//   brain/core/anti-patterns/evidence-reader-empty-on-failure.md —
//   "null = uncomputable (the fetch failed), [] / '' = genuinely empty."
//
// So: `[]` only when the body under the key is genuinely absent; `null` when
// there was content there and this parser could not read it.

test('#452/#478-F1: a foreign 0-indent YAML list with REAL entries is UNREADABLE (null), never an empty finding list', () => {
  const parsed = parseVerdict({ body: blockWith(['findings:', '- id: F-1', '  severity: blocker']) });
  assert.equal('findings' in parsed, false,
    'this block CARRIES two findings this parser cannot read — reporting findings: [] would tell the ' +
    'consumer the reviewer found nothing, which is the inversion protocol §10 forbids');
});

test('#452/#478-F1: other unreadable indentations are also null, not empty', () => {
  for (const shape of [
    ['findings:', '    - id: F-1'],          // 4-space sequence
    ['findings:', '\t- id: F-1'],            // tab-indented
    ['findings:', '  - "id": F-1'],          // quoted key — ENTRY_OPEN_RE rejects it
    ['findings:', '', '- id: F-1'],          // blank line then foreign content
  ]) {
    const parsed = parseVerdict({ body: blockWith(shape) });
    assert.equal('findings' in parsed, false, `unreadable body reported as empty: ${JSON.stringify(shape)}`);
  }
});

test('#452/#478-F1: a genuinely empty list is still [] — the fix must not swallow the case it exists for', () => {
  // Both ways a list can legitimately be empty: followed by the next top-level
  // key, and sitting at the end of the block. If either of these returned null
  // the blocker fix would have undone #452 itself.
  assert.deepEqual(parseVerdict({ body: blockWith(['findings:', 'conditions: []']) }).findings, [],
    'key followed by the next top-level key — genuinely empty');
  assert.deepEqual(parseVerdict({ body: blockWith(['findings:']) }).findings, [],
    'key at the end of the block — genuinely empty');
});

test('#452/#478-F2: a trailing space on the key line no longer routes to the INLINE branch (#612)', () => {
  // WAS a pinned defect: `scalar()`'s `^key:[ \t]*(.+)$` backtracked so `(.+)`
  // captured the trailing space, `inline` became '' (non-null), the block branch
  // never ran, and `findings: ` with real entries came back as malformed — two
  // readable findings read as none. #477 deferred the repair on scope; #612
  // landed it as `(\S.*)`, so the whitespace-only key line is now the ABSENT
  // state and the block branch runs.
  // This assertion is INVERTED from its original form on purpose. The direction of the
  // change is the record; do not delete the id.
  const withSpace = parseVerdict({ body: blockWith(['findings: ', '  - id: "F-1"']) });
  assert.deepEqual(withSpace.findings, [{ id: 'F-1' }], 'the trailing space is now insignificant');
  assert.equal('malformed' in withSpace, false, 'and it is not reported unreadable either');
  const clean = parseVerdict({ body: blockWith(['findings:', '  - id: "F-1"']) });
  assert.deepEqual(clean.findings, [{ id: 'F-1' }], 'the control: the two forms now agree byte for byte');
});

test('#612: a whitespace-only `rev:` is ABSENT (null), never revision zero', () => {
  // Found by the verify pass, not by the design: `rev`'s ternary is
  // `revRaw !== null ? Number(revRaw) : null`, so under the old regex a
  // whitespace-only `rev: ` produced `Number('') === 0` — a revision number
  // fabricated out of an empty string. The repair makes it `null`, which is
  // what the field's own JSDoc has always declared (`rev: number|null`).
  //
  // The repair is right and the old behaviour was wrong, but it was a SILENT
  // divergence with no test on either side of it, which is how it nearly
  // shipped unrecorded. `rev` is only re-rendered today (`verdict.mjs`) and
  // never used arithmetically, so the blast radius was low — low is not a
  // reason to leave a behaviour change unpinned.
  const withSpace = parseVerdict({ body: blockWith(['rev: ']) });
  assert.equal(withSpace.rev, null, 'a whitespace-only rev is absent, not 0');
  assert.equal(parseVerdict({ body: blockWith(['rev:']) }).rev, null,
    'the control: the clean form already answered absent, and the two now agree');
  assert.equal(parseVerdict({ body: blockWith(['rev: 3']) }).rev, 3,
    'the negative control — a real revision still parses, so this is not a blanket null');
});

test('#612: findings with a trailing space and NOTHING under it is [], the same as the byte-equivalent clean form', () => {
  // The nothing-follows half of axis 6 (design.md §D-F): a fix that only
  // repairs the block-scan branch's entry-reading, without repairing
  // `scalar` itself, would pass the F2 pin above (entries present) but
  // fail this one (no entries) — trailing whitespace is not significant
  // in YAML, and the clean and trailing-space forms of an empty list must
  // now agree.
  const withSpace = parseVerdict({ body: blockWith(['findings: ']) });
  assert.deepEqual(withSpace.findings, [], 'trailing space, no entries — genuinely empty, not unreadable');
  assert.equal('malformed' in withSpace, false);
});

test('#612: sequencing/controls/controls_not_applied stay malformed on a whitespace-only value, unchanged by the repair', () => {
  // Axis 11 (design.md §D-F), the negative/invariant axis: these three
  // fields are read through `readControlList`/the inline `sequencing`
  // reader, not through `readList`'s block-scan fallback. Their `KEY_RE`
  // probe fires on the bare `key:` prefix regardless of what follows, and
  // `raw !== null ? parseJsonScalar(raw) : null` already treated `''` and
  // `null` identically (neither parses to a valid array) before this
  // repair touched `scalar`. Pinned so a future "simplification" that
  // drops that probe, or that special-cases whitespace-only differently,
  // is caught here rather than silently reaching a gate.
  const parsed = parseVerdict({
    body: blockWith(['sequencing: ', 'controls: ', 'controls_not_applied: ']),
  });
  assert.deepEqual(
    parsed.malformed?.slice().sort(),
    ['controls', 'controls_not_applied', 'sequencing'],
    'all three stay malformed, exactly as before the repair',
  );
  assert.equal('sequencing' in parsed && Array.isArray(parsed.sequencing), false);
  assert.equal('controls' in parsed && Array.isArray(parsed.controls), false);
  assert.equal('controls_not_applied' in parsed && Array.isArray(parsed.controls_not_applied), false);
});

// ── #478 second cold review, F1: a PARTIAL read is uncomputable too ─────────
//
// The first correction applied the unreadable check only in the
// `entries.length === 0` branch. If even ONE entry parsed before the scan hit
// content it could not read, the function returned the truncated prefix as a
// confident, positive list — the same inversion one branch further up, and the
// shipped state table asserted the opposite.
//
// This state is reachable from brain's OWN renderer: `yamlScalar` quotes but
// does not escape newlines (verdict.mjs), and checkpoint.mjs interpolates the
// full multi-line stdout of brain-governance-status into `evidence:`. Measured
// before the fix: a two-finding verdict rendered and re-parsed yielded ONE
// finding, silently dropping a blocker, with `'findings' in parsed === true`.
//
// (The renderer's newline handling is the root cause and is its own ticket —
// no parser can read that block correctly. What this parser CAN do is refuse to
// present a partial read as a complete one.)

test('#478-2/F1: a partially-readable list is uncomputable (null) — never a confident truncated prefix', () => {
  const parsed = parseVerdict({
    body: blockWith(['findings:', '  - id: "F-1"', '    severity: "blocker"', 'line two of a multi-line scalar']),
  });
  assert.equal('findings' in parsed, false,
    'one entry parsed and then the scan hit unreadable content — reporting [F-1] would hide whatever ' +
    'followed it behind a positive, complete-looking list');
});

test('#478-2/F1 → #481: through the REAL renderer, multi-line evidence ROUND-TRIPS — no finding may vanish silently', () => {
  // MOVED, not deleted. This case first asserted `'findings' in parsed === false`
  // — the honest "uncomputable" answer for a block the parser could not fully
  // read — because `yamlScalar` quoted but did not ESCAPE newlines, so brain's
  // own renderer emitted a list that terminated at the first continuation line.
  //
  // The maintainer ruled #481 in scope for this change, so the emitter is fixed
  // and that premise is gone: this renderer can no longer produce that block. The
  // assertion moves to the stronger property it was standing in for — every
  // finding survives — instead of being deleted along with the defect.
  //
  // The parser-side guarantee it used to carry is NOT lost: the hand-built case
  // above still pins "partial read → null" for input this renderer cannot emit
  // but a foreign, older, or hand-authored source can.
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [
      { id: 'multi', severity: 'blocker', evidence: 'line one\nline two', cites: 'x.md' },
      { id: 'tier2-touch', severity: 'blocker', evidence: 'brain/core/x.md', cites: 'y.md' },
    ],
  });
  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.deepEqual((parsed.findings ?? []).map(f => f.id), ['multi', 'tier2-touch'],
    'a 2-finding verdict must re-parse to 2 findings — before #481 this dropped the second, a BLOCKER');
  assert.equal(parsed.findings[0].evidence, 'line one\nline two',
    'and the multi-line evidence must decode back to its exact characters');
});

test('#478-2/F1: a FULLY readable multi-entry list is unaffected — the control', () => {
  const parsed = parseVerdict({
    body: blockWith(['findings:', '  - id: "F-1"', '  - id: "F-2"', 'conditions: []']),
  });
  assert.deepEqual(parsed.findings, [{ id: 'F-1' }, { id: 'F-2' }]);
});

// ── #478 THIRD cold review, blocker 1: which lines may END a list ───────────
//
// The round-2 correction established "unreadable → null at ANY entry count" as a
// normative requirement in three places — and never interrogated the predicate
// that decides "unreadable". `TOP_LEVEL_KEY_RE` accepted ANY `word:` at column 0
// as the next top-level key, so unreadable content whose first line happens to
// look like one was read as a CLEAN END and the truncated prefix came back as a
// confident, complete list.
//
// The falsifying shape is the likeliest one in production, not a corner case:
// `brain-governance-status`'s stdout — what checkpoint.mjs interpolates into
// `evidence:` — contains lines like `Tier: 2`.
//
// The list can only be ended by a key this protocol actually emits.

test('#478-3/B1: content that merely LOOKS like a key does not end the list — the prefix must not be returned as complete', () => {
  const parsed = parseVerdict({
    body: blockWith([
      'findings:',
      '  - id: "F-1"',
      '    evidence: "line one',
      'Tier: 2',                       // <- from real governance-status stdout
      '  - id: "F-2-BLOCKER"',
      'conditions: []',
    ]),
  });
  assert.equal('findings' in parsed, false,
    'the scan broke on unreadable content; "Tier:" is not a verdict key, so this block is uncomputable — ' +
    'returning [F-1] would drop F-2-BLOCKER AND assert the remainder is the whole set');
});

test('#478-3/B1: a REAL next key still ends the list cleanly — the control', () => {
  const parsed = parseVerdict({ body: blockWith(['findings:', '  - id: "F-1"', 'conditions: []']) });
  assert.deepEqual(parsed.findings, [{ id: 'F-1' }]);
  assert.deepEqual(parseVerdict({ body: blockWith(['findings:', 'conditions: []']) }).findings, []);
});

test('#478-3/B1: the terminator set does not drift from what renderVerdict emits', () => {
  // The list-ending predicate names the protocol's own keys. If renderVerdict
  // gains a top-level key and this set is not updated, a verdict carrying that
  // key would parse as "unreadable" — failing safe, but wrongly. This test is
  // the drift guard the loose regex made impossible.
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [{ id: 'F-1', severity: 'blocker', evidence: 'x', cites: 'y', evidence_class: 'inferential' }],
    conditions: ['c'],
    sequencing: ['seq:x'],
    pin: { a: 1 },
    // #682 — the fixture must be FULLY populated or the guard is blind to the
    // key it was written to catch. `challenger_axis` rendered for weeks while
    // this test passed, because `judgmentAxis` was never set here and
    // `renderVerdict` emits the line only when a reasoned finding exists.
    protocol: 'brain-review/2',
    judgmentAxis: 'same-model',
  });
  const block = renderVerdict(built).split('```')[1];
  const emitted = block.split('\n')
    .map(l => l.match(/^([A-Za-z_][A-Za-z0-9_]*):/))
    .filter(Boolean).map(m => m[1]);
  assert.ok(emitted.length >= 6, `expected several top-level keys, got ${JSON.stringify(emitted)}`);
  // `findings` is excluded as its own terminator: a second `findings:` line in the
  // same block is matched by `scalar()`'s inline branch before the list branch
  // ever runs, so the probe would measure that instead. A key cannot end its own
  // list, and no renderer emits one twice.
  for (const key of emitted.filter(k => k !== 'findings')) {
    const probe = parseVerdict({ body: blockWith(['findings:', `${key}: whatever`]) });
    assert.deepEqual(probe.findings, [],
      `renderVerdict emits top-level "${key}" but the parser does not accept it as a list terminator — ` +
      'a verdict carrying it after a list would parse as unreadable');
  }
});

// ── #478 round 4: ONE encoder must not have TWO decoders ────────────────────
//
// Found by the fourth cold review, which was tracing this to board.mjs's label
// writes when it died mid-run; reproduced and confirmed from its probe.
//
// `yamlScalar` is the single emitter. Two functions decode it:
//   unyamlScalar   — used for findings/follow_ups ENTRY fields
//   parseJsonScalar — used for `pin`, `sequencing`, and the INLINE list form
//
// When #481 taught the encoder to escape line terminators, only `unyamlScalar`
// learned to decode them. `parseJsonScalar` kept a generic `\X -> X` strip,
// which turns the new `\u2028` escape into the literal text `u2028`:
//
//   in : seq:blocked-on<U+2028>411
//   out: seq:blocked-onu2028411
//
// That is not cosmetic. `sequencing` is the ONE member of this family with a
// destructive live consumer: board.mjs's reconcileBoardLabels compares the
// parsed list against the PR's current labels, so a corrupted name puts the
// REAL label in toRemove and a fabricated one in toAdd.

test('#478-4: `sequencing` round-trips through the REAL encoder when a value carries a line separator', () => {
  const built = buildVerdict({ headSha: 'abc123', conclusion: 'APPROVE', findings: [] });
  built.sequencing = ['seq:after-411', 'seq:blocked-on\u2028411'];
  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.deepEqual(parsed.sequencing, built.sequencing,
    'a decoder that does not mirror the encoder corrupts the label NAME — and board.mjs deletes labels by name');
});

test('#478-4: the same holds for every ESCAPED value, on BOTH decoders', () => {
  // The entry path and the JSON path must agree, because one emitter feeds both.
  //
  // SCOPE, corrected by round 5/B2: this is NOT "any value the encoder can
  // produce" — the earlier wording claimed a total property and was false. A
  // value containing a markdown code fence escapes nothing (`yamlScalar` covers
  // `\` `"` `\n` `\r` `\u2028` `\u2029`) and `FENCE_RE` is non-greedy, so the
  // first fence inside any value ENDS the block: the findings list comes back
  // truncated, `sequencing` disappears, and board.mjs puts every real `seq:*`
  // label into `toRemove`. Measured, and pre-existing on the merge-base — the
  // defect is the fence, not these escapes. See the round-5 review record.
  //
  // What this case pins is the escape set, exhaustively. It must not be read as
  // a guarantee about every possible value.
  const nasty = ['a\nb', 'a\rb', 'a\u2028b', 'a\u2029b', 'a"b', 'a\\b', 'a\\nb'];
  for (const v of nasty) {
    const built = buildVerdict({
      headSha: 'abc123',
      conclusion: 'REVISE',
      findings: [{ id: 'f', severity: 'blocker', evidence: v, cites: 'c' }],
    });
    built.sequencing = [v];
    const parsed = parseVerdict({ body: renderVerdict(built) });
    assert.equal(parsed.findings[0].evidence, v, `entry path corrupted ${JSON.stringify(v)}`);
    assert.deepEqual(parsed.sequencing, [v], `JSON path corrupted ${JSON.stringify(v)}`);
  }
});

// ── #487 — a code fence in any verdict value truncated the block ─────────────
//
// `FENCE_RE` had no anchor on its terminator, so the first ``` appearing ANYWHERE —
// including in the middle of an `evidence:` value — ended the block. Not a corner case:
// `reviewer-protocol.md:187` defines evidence as a command the reviewer actually ran
// cold, and command output is normally fenced; `checkpoint.mjs` interpolates raw
// `brain:audit` stdout straight into `evidence:`.
//
// Measured on `main` @ c9d2b36 before the fix, through the REAL chain:
//
//   findings 2 -> 1  |  evidence intacta: false  |  sequencing: undefined
//   toRemove: ["seq:after-411","seq:blocked-on-412"]
//
// The case below is the one #478 round 5 predicted in the comment above, promoted from
// a note into a guard.

const FENCED_EVIDENCE = 'repro:\n```bash\nnpm test -- --grep x\n```\nexit 1';

test('#487: a fenced value does not truncate the block — every finding survives and `sequencing` is intact', () => {
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [
      { id: 'f1', severity: 'blocker', evidence: FENCED_EVIDENCE, cites: 'reviewer-protocol.md' },
      { id: 'f2', severity: 'major', evidence: 'the second finding must survive', cites: 'x.md' },
    ],
  });
  built.sequencing = ['seq:after-411', 'seq:blocked-on-412'];

  const parsed = parseVerdict({ body: renderVerdict(built) });

  assert.equal(parsed.findings.length, 2, 'the findings list truncated at the fence');
  assert.equal(parsed.findings[0].evidence, FENCED_EVIDENCE, 'the fenced evidence came back mangled');
  assert.equal(parsed.findings[1].id, 'f2', 'a blocker after the fenced finding was silently dropped');
  assert.deepEqual(parsed.sequencing, built.sequencing, '`sequencing` disappeared — indistinguishable from "no sequencing"');
});

// THE acceptance test, and the reason this ticket is data-loss rather than parsing.
// A parser-only guard would let the same end state return through a third door: what
// must never happen is a REAL `seq:*` label landing in `toRemove` because a verdict was
// unreadable. board.mjs reconciles by NAME and the write is destructive.
test('#487: a real `seq:*` label is never scheduled for deletion because a verdict carried a fence', () => {
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [{ id: 'f1', severity: 'blocker', evidence: FENCED_EVIDENCE, cites: 'x.md' }],
  });
  built.sequencing = ['seq:after-411', 'seq:blocked-on-412'];

  const parsed = parseVerdict({ body: renderVerdict(built) });
  const { toAdd, toRemove } = reconcileBoardLabels({
    latestVerdict: parsed,
    currentLabels: ['seq:after-411', 'seq:blocked-on-412', 'reviewed:revised'],
  });

  assert.deepEqual(toRemove, [], `a live label was scheduled for deletion: ${JSON.stringify(toRemove)}`);
  assert.deepEqual(toAdd, [], 'nothing should be added — the PR already carries exactly what the verdict wants');
});

// ── Adversarial fence shapes ────────────────────────────────────────────────
//
// The anchor is what makes these decidable, so each one pins a DIFFERENT reason the
// old regex was wrong. They are not variations on the case above.

test('#487: an UNTERMINATED fence reads as null, never as a confident prefix (#452 guarantee)', () => {
  const body = '```yaml\nprotocol: brain-review/1\nverdict: APPROVE\nhead_sha: abc123\n';
  assert.equal(parseVerdict({ body }), null,
    'a partially-read block must answer null — a truncated prefix reported as complete is the #452 defect');
});

test('#487: a fence in prose before the block no longer costs the verdict, when it carries a language tag', () => {
  const built = buildVerdict({ headSha: 'abc123', conclusion: 'APPROVE', findings: [] });
  const body = 'Contexto previo:\n\n```bash\nnpm test\n```\n\n' + renderVerdict(built);

  // Measured on `main` @ c9d2b36 this returned NULL, and board.mjs then silently
  // reconciles from an OLDER verdict — the third adversarial shape #487 listed. The
  // anchored opener only accepts ``` or ```yaml, so a tagged prose fence is skipped
  // rather than mistaken for the block. Not the goal of the fix; a consequence of it,
  // pinned so it cannot regress unnoticed.
  const parsed = parseVerdict({ body });
  assert.equal(parsed?.head_sha, 'abc123', 'the verdict block must be found past a tagged prose fence');
  assert.equal(parsed?.verdict, 'APPROVE');
});

// KNOWN LIMITATION, pinned rather than fixed — see the PR for why it is not this
// ticket's call. An UNTAGGED ``` fence in prose above the verdict IS a valid opener, so
// it becomes "the first fence" and the verdict is never located. Behaviour is identical
// before and after #487; closing it means letting the reader scan past a fence that does
// not parse, which contradicts design.md §E2 rule 17 ("only the first fence is ever
// read") — a documented rule with a stated reason, not an oversight to patch in passing.
//
// This assertion exists so the day someone changes rule 17, this file objects.
test('#487: an UNTAGGED prose fence still shadows the verdict block — documented, not fixed here', () => {
  const built = buildVerdict({ headSha: 'abc123', conclusion: 'APPROVE', findings: [] });
  const body = 'Contexto:\n\n```\nnpm test\n```\n\n' + renderVerdict(built);
  assert.equal(parseVerdict({ body }), null,
    'if this now parses, rule 17 changed — update the doctrine and this comment together');
});

test('#487: an indented ``` inside a value is not a terminator', () => {
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [{ id: 'f1', severity: 'blocker', evidence: 'salida:\n    ```\n    x\n    ```', cites: 'x.md' }],
  });
  built.sequencing = ['seq:after-411'];
  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.equal(parsed.findings.length, 1);
  assert.deepEqual(parsed.sequencing, ['seq:after-411']);
});

test('#487: with TWO fenced blocks in one body, the first is still the one read', () => {
  const first = buildVerdict({ headSha: 'aaa111', conclusion: 'APPROVE', findings: [] });
  const second = buildVerdict({ headSha: 'bbb222', conclusion: 'STOP', findings: [] });
  const parsed = parseVerdict({ body: `${renderVerdict(first)}\n\nquoted below:\n\n${renderVerdict(second)}` });
  assert.equal(parsed.head_sha, 'aaa111',
    'the single-fence read is the documented rule — a stale block quoted above a fresh one is not addressed here');
});

// ── #477: a CORRUPT list is not an ABSENT list ──────────────────────────────
//
// #452 taught the BLOCK encoding to separate "genuinely empty" from the other
// two states. It left `null` carrying BOTH remaining meanings — "the key is not
// here" and "the key is here and I could not read it" — and `parseVerdict`'s
// `if (x !== null)` guard erases the difference by dropping the field either
// way. The INLINE encoding never separated anything: `parseJsonScalar` answers
// `null` for every value it cannot read.
//
// Measured on `main` @ 51bbcaa, the state this ticket exists to end:
//
//   findings INLINE []           | 'findings' in result: true  | value: []
//   findings INLINE unparseable  | 'findings' in result: false | value: undefined
//   findings key OMITTED         | 'findings' in result: false | value: undefined
//
// Rows 2 and 3 are the same answer, and the direction they agree on is the
// reassuring one: a truncated or hand-mangled verdict reads as a reviewer who
// found nothing. That is `evidence-reader-empty-on-failure` sitting in the
// reader that feeds §10's evaluators, and it is the inversion §6.1 already
// forbids one layer up — "'no findings' and 'findings discarded' must never
// look identical to the reader" (#483).
//
// Maintainer ruling on this ticket (2026-08-12): option 3 — `null` stays, the
// unreadable field is recorded on the result as `malformed: [...]`, and
// `parseJsonScalar`'s never-throws guarantee is preserved. The ruling's second
// half — board.mjs and cold-boot.mjs treating an unreadable verdict as NOT
// clean — is NOT delivered here; it is outside this change's file claim
// (`brain/scripts/review/lib/**`). The two tests at the end of this block pin
// exactly what that leaves standing, so the gap is asserted rather than implied.

test('#477: the three INLINE states of `findings` are three distinct answers', () => {
  const empty = parseVerdict({ body: blockWith(['findings: []']) });
  assert.deepEqual(empty.findings, [], 'present and empty → []');
  assert.equal('malformed' in empty, false, 'a readable block carries no malformed key');

  // A truncated JSON scalar — the shape a clipped comment body or a bad hand-edit
  // produces. `scalar()` reads the line, `parseJsonScalar` cannot read the value.
  const corrupt = parseVerdict({ body: blockWith(['findings: [{"id": "F-1"']) });
  assert.equal('findings' in corrupt, false,
    'an unreadable list must never be presented as a list — the field stays off the result');
  assert.deepEqual(corrupt.malformed, ['findings'],
    'and the reader must SAY it could not read it: this is the whole difference from the row below');

  const absent = parseVerdict({ body: blockWith([]) });
  assert.equal('findings' in absent, false, 'absent → the field is off the result');
  assert.equal('malformed' in absent, false,
    'nothing was unreadable — a block that never mentioned findings must not be reported as corrupt');
});

test('#477: the BLOCK encoding separates absent from unreadable too — #452 stopped one state short', () => {
  // #452 fixed `[]` vs the rest. Both survivors still answered `null`, so the
  // 0-indent foreign list below — a real shape, what `yaml.dump` emits — was
  // indistinguishable from a block that never carried findings at all.
  const unreadable = parseVerdict({ body: blockWith(['findings:', '- id: F-1', '  severity: blocker']) });
  assert.equal('findings' in unreadable, false, '#452\'s guarantee is unchanged: never [] here');
  assert.deepEqual(unreadable.malformed, ['findings'],
    'this block CARRIES two findings this parser cannot read — it must not read as a block that carried none');

  assert.equal('malformed' in parseVerdict({ body: blockWith(['findings:']) }), false,
    'the genuinely-empty case is not corrupt');
  assert.equal('malformed' in parseVerdict({ body: blockWith(['findings:', '  - id: "F-1"']) }), false,
    'the readable case is not corrupt');
});

test('#477: an inline value that is not a LIST is unreadable — a list field has no scalar reading', () => {
  // `findings: 3` parses as JSON and is not a findings list. Before this change
  // it was assigned verbatim, so `result.findings` could be a number that every
  // consumer treats as an array.
  for (const raw of ['3', '"a string"', '{"id": "F-1"}', 'null']) {
    const parsed = parseVerdict({ body: blockWith([`findings: ${raw}`]) });
    assert.equal('findings' in parsed, false, `findings: ${raw} must not land on the result`);
    assert.deepEqual(parsed.malformed, ['findings'], `findings: ${raw} must be reported unreadable`);
  }
});

test('#477: `follow_ups` and `sequencing` are covered by the same rule — all three are named', () => {
  const parsed = parseVerdict({
    body: blockWith(['sequencing: not-valid-json', 'findings: [{"id"', 'follow_ups: [{"id"']),
  });
  assert.deepEqual(parsed.malformed, ['sequencing', 'findings', 'follow_ups'],
    'every unreadable field is named, in the order parseVerdict reads them');
  assert.equal('sequencing' in parsed, false);
  assert.equal('findings' in parsed, false);
  assert.equal('follow_ups' in parsed, false);
});

test('#477: a verdict from the REAL renderer never reports itself corrupt', () => {
  // The false-positive guard. If `malformed` fired on brain's own output, every
  // consumer that adopts it would stop trusting it inside a week.
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [{ id: 'F-1', severity: 'blocker', evidence: 'line one\nline two', cites: 'ADR-0020' }],
    conditions: ['c'],
  });
  built.sequencing = ['seq:after-411'];
  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.equal('malformed' in parsed, false, `renderVerdict output reported corrupt: ${JSON.stringify(parsed.malformed)}`);
  assert.equal(parsed.findings.length, 1);
  assert.deepEqual(parsed.sequencing, ['seq:after-411']);

  const emptyish = parseVerdict({ body: renderVerdict(buildVerdict({ headSha: 'abc123', conclusion: 'APPROVE', findings: [] })) });
  assert.equal('malformed' in emptyish, false, 'an APPROVE with no findings is clean, not corrupt');
});

test('#477: the never-throws guarantee is preserved — no input makes parseVerdict raise', () => {
  for (const shape of ['findings: [{"id"', 'sequencing: {', 'findings:', 'findings: ', 'follow_ups: ]']) {
    assert.doesNotThrow(() => parseVerdict({ body: blockWith([shape]) }), `threw on ${JSON.stringify(shape)}`);
  }
});

// ── #477, consumer level ────────────────────────────────────────────────────
//
// The ruling: "the consumers that count findings must treat an unreadable field
// as NOT clean… a flag nobody reads is the downside the ticket itself names."
// The predicate below is what a counting consumer has to use; the two live
// consumers adopting it is the ruling's second half and is outside this file
// claim. What this change owes, and what these two tests measure, is that the
// predicate is now DERIVABLE — on `main` it was not, because nothing on the
// result distinguished the two verdicts.

/** What "clean" has to mean once a verdict can be unreadable. */
const countsAsClean = v => (v.findings ?? []).length === 0 && (v.malformed ?? []).length === 0;

test('#477 consumer-level: a corrupt findings list no longer counts as a clean verdict', () => {
  const clean = parseVerdict({ body: blockWith(['findings: []']) });
  const corrupt = parseVerdict({ body: blockWith(['findings: [{"id": "F-1"']) });

  // Measured on `main` @ 51bbcaa: the corrupt verdict and a verdict that never
  // mentioned findings serialised to the SAME object, byte for byte —
  //   {"head_sha":"abc123","rev":null,"verdict":"APPROVE","author":null,"protocol":"brain-review/2"}
  // — so a consumer counting findings read the corrupt one as zero.
  assert.equal(countsAsClean(clean), true, 'an APPROVE with an empty findings list is genuinely clean');
  assert.equal(countsAsClean(corrupt), false,
    'a verdict whose findings list could not be read is not a verdict that found nothing — ' +
    'protocol §10 forbids exactly this direction of failure');
});

test('#477 consumer-level: an unreadable sequencing never deletes a real `seq:*` label', () => {
  // This test was first written as a PINNED DEFECT: board.mjs read
  // `latestVerdict.sequencing ?? []`, so an unreadable value produced an empty
  // desired set and this asserted `toRemove == ['seq:after-411']` — a real label
  // scheduled for deletion off evidence nobody could read — with a note saying
  // the fix lived in board.mjs, outside that change's file claim.
  //
  // The claim was extended and the fix landed, so the test went red exactly as
  // designed and is now the assertion it was standing in for. Kept here, at the
  // parser's own test file, because the parser is what must keep FEEDING the
  // consumer the flag: if `malformed` ever stops being reported, this fails here
  // as well as in board.test.mjs.
  const parsed = parseVerdict({ body: blockWith(['sequencing: not-valid-json']) });
  assert.deepEqual(parsed.malformed, ['sequencing'], 'the parser reports what it could not read');

  // `reviewed:approved` matches this block's APPROVE verdict, so any movement
  // below would be damage the unreadable `sequencing` caused.
  const { toAdd, toRemove, unreadable } = reconcileBoardLabels({
    latestVerdict: parsed,
    currentLabels: ['seq:after-411', 'reviewed:approved'],
  });
  assert.deepEqual(toRemove, [], 'MEASURED before the consumer fix: ["seq:after-411"]');
  assert.deepEqual(toAdd, []);
  assert.deepEqual(unreadable, ['sequencing'], 'and the board reports the namespace as uncomputable');

  const nonArray = parseVerdict({ body: blockWith(['sequencing: 3']) });
  assert.doesNotThrow(
    () => reconcileBoardLabels({ latestVerdict: nonArray, currentLabels: ['seq:after-411'] }),
    'a non-array sequencing used to reach `for…of 3` in board.mjs and take down the entire board run');
});

// ── #477 review round: `sequencing` is NOT findings-shaped ──────────────────
//
// Regression introduced by the first cut of this change and caught by review.
// `sequencing` was routed through `parseEntryList` for the malformed reporting,
// but that function is the inverse of ONE emitter — the findings/follow_ups
// entry list — and `sequencing` is a FLAT LIST OF LABEL STRINGS.
//
// So `sequencing:` followed by a 2-space block sequence (what `yaml.dump`
// emits, and the natural hand-edited form) matched ENTRY_OPEN_RE:
//
//   sequencing:
//     - seq:after-411        →  [{ seq: 'after-411' }]     NOT flagged malformed
//
// Measured: those objects reached `guardedLabelAdd`, which threw
// `refused label "[object Object]"` out of runBoard's per-PR loop and left
// every REMAINING open PR unreconciled — the exact "takes down the whole board
// run" failure this change's own comment claims to retire, reintroduced through
// a different door. On `origin/main` the same block produced no `sequencing`
// key at all: a safe no-op. This was a regression, not a pre-existing defect.

test('#477/review: a block-sequence `sequencing` is UNREADABLE — never entry-parsed into objects', () => {
  const parsed = parseVerdict({
    body: blockWith(['sequencing:', '  - seq:after-411', '  - seq:blocked-on-412']),
  });
  assert.equal('sequencing' in parsed, false,
    'the findings-shaped entry regexes must not be applied to a flat label list');
  assert.deepEqual(parsed.malformed, ['sequencing'],
    'this block CARRIES sequencing this parser cannot read — it must say so, not invent entries');
});

test('#477/review: an inline `sequencing` whose members are not strings is UNREADABLE', () => {
  // The same end state through the inline door: labels are compared and deleted
  // BY NAME, so a non-string member is not a label under any reading.
  for (const raw of ['[{"seq":"a"}]', '[1,2]', '[null]', '"seq:a"', '{}']) {
    const parsed = parseVerdict({ body: blockWith([`sequencing: ${raw}`]) });
    assert.equal('sequencing' in parsed, false, `sequencing: ${raw} must not land on the result`);
    assert.deepEqual(parsed.malformed, ['sequencing'], `sequencing: ${raw} must be reported unreadable`);
  }
});

test('#477/review: the READABLE inline forms still work — the control', () => {
  assert.deepEqual(parseVerdict({ body: blockWith(['sequencing: "[\\"seq:merge-next\\"]"']) }).sequencing,
    ['seq:merge-next'], 'the form renderVerdict actually emits');
  assert.deepEqual(parseVerdict({ body: blockWith(['sequencing: []']) }).sequencing, [],
    'a genuinely empty sequencing is empty, not unreadable');
  assert.equal('malformed' in parseVerdict({ body: blockWith(['sequencing: []']) }), false);
});

test('#682 REQ-682-3: `challenger_axis` round-trips, and does not terminate the findings list', () => {
  // It RENDERED and did not parse back — returned absent, and not even reported
  // in `malformed`, so the one field distinguishing a same-model-challenged
  // verdict from a cross-family-challenged one was write-only. Missing from
  // TOP_LEVEL_KEYS it also terminated nothing, so a block placing it after a
  // findings list lost the WHOLE LIST.
  //
  // The drift guard above pins the terminator set; this pins the READER, because
  // a key that terminates correctly and is never assigned is half a fix that
  // reads as a whole one.
  for (const axis of ['same-model', 'cross-family', 'human', 'mechanical']) {
    const body = renderVerdict({
      protocol: 'brain-review/2', verdict: 'REVISE', head_sha: 'a'.repeat(40), rev: 1,
      gates: { required: ['issue-link'], detection: [] },
      controls: ['inferential'], judgmentAxis: axis,
      findings: [{ id: 'J1', severity: 'blocker', evidence_class: 'inferential', evidence: 'e', cites: 'c' }],
      follow_ups: [], conditions: [], escalate: null,
    });
    assert.equal(parseVerdict({ body }).challenger_axis, axis,
      `${axis} must survive the round trip — this field's neighbours shipped an asymmetry once (#381)`);
  }

  const withAxisAfterFindings = [
    '```yaml', 'protocol: brain-review/2', 'verdict: REVISE',
    `head_sha: ${'a'.repeat(40)}`, 'rev: 1', 'gates:', '  required: []', '  detection: []',
    'findings:', '  - id: "F-1"', 'challenger_axis: human', 'escalate: null', '```',
  ].join('\n');
  const parsed = parseVerdict({ body: withAxisAfterFindings });
  assert.deepEqual(parsed.findings, [{ id: 'F-1' }], 'the axis must TERMINATE the list, not swallow it');
  assert.equal(parsed.challenger_axis, 'human');
});
