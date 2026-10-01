// checkpoint-block.test.mjs — issue #495, the `brain-checkpoint/1` contract.
//
// The reader this exercises replaced a scanner that read the WHOLE report for
// any `N/M` whose `M` was a budget some tier declares. That filter rejected the
// shapes brain's reports actually contain (test counts, slice counts, versions)
// and could not reject a sentence mentioning another tier's budget — four of
// which are pinned below, from the ticket.
//
// Refusals are asserted on the REASON and on `absent`, never only on
// `ok === false`: a parser that rejects everything satisfies a boolean and
// nothing else (the discipline `amendment-draft.test.mjs` states in its header,
// and this reader is modelled on that one).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHECKPOINT_TAG, renderCheckpointClaim, parseCheckpointClaim } from './checkpoint-block.mjs';

/** A report with `body` before the declared block and `tail` after it. */
function report({ body = '# Checkpoint\n\nProse.\n', claim = 'counted_lines: 213\ndiff_budget: 400', tail = '\nMore prose.\n' } = {}) {
  return `${body}\n\`\`\`${CHECKPOINT_TAG}\n${claim}\n\`\`\`\n${tail}`;
}

// ── the happy path, and the round trip ──────────────────────────────────────

test('#495: a well-formed declared block is read', () => {
  assert.deepEqual(parseCheckpointClaim(report()), { ok: true, countedLines: 213, diffBudget: 400 });
});

test('#495: render and parse are inverses — emitter and reader in ONE module', () => {
  // The `decision-block.mjs` precedent, chosen deliberately over the
  // verdict.mjs/parse-verdict.mjs split that has already cost two drift bugs
  // (#381, #452): one module cannot be edited half-way, two files can.
  const rendered = renderCheckpointClaim({ countedLines: 372, diffBudget: 1000 });
  assert.deepEqual(parseCheckpointClaim(`# R\n\n${rendered}\n`), { ok: true, countedLines: 372, diffBudget: 1000 });
});

test('#495: zero is a claim, not an absence', () => {
  // A change that is entirely openspec/** counts 0 lines. `if (claimed)` on a
  // falsy-but-real number is how this class of parser usually loses a claim.
  assert.deepEqual(
    parseCheckpointClaim(report({ claim: 'counted_lines: 0\ndiff_budget: 1000' })),
    { ok: true, countedLines: 0, diffBudget: 1000 },
  );
});

// ── ABSENT is its own answer, never `null` ──────────────────────────────────

test('#495: no declared block → absent, with a reason — never null', () => {
  // The ruling's point 2. `null` is indistinguishable from "made no claim",
  // which reproduces this ticket's own defect one level up, inside its fix.
  const r = parseCheckpointClaim('# Checkpoint\n\nNo block here.\n');
  assert.equal(r.ok, false);
  assert.equal(r.absent, true);
  assert.match(r.error, /brain-checkpoint\/1/);
  assert.notEqual(r, null);
});

test('#495: the four sentences from the ticket each yield NO claim', () => {
  const sentences = [
    ['prior-round count', 'Reviewed 3/200 findings from the prior round.'],
    // The important one: VERBATIM from this repo's own governance-tiers.test.mjs,
    // and the shape a report discussing the tier table would write.
    ['the tier table itself', 'diffBudget matches design §2.C (1000/400/200).'],
    ['a past-tense budget', 'The old tranche budget was 372/400 before ADR-0026.'],
    ['a coverage ratio', 'Coverage improved from 180/400 statements to full.'],
  ];
  for (const [label, sentence] of sentences) {
    const r = parseCheckpointClaim(`# Checkpoint\n\n${sentence}\n`);
    assert.equal(r.ok, false, `${label}: prose must never produce a claim`);
    assert.equal(r.absent, true, `${label}: and it must read as ABSENT, not as malformed`);
  }
});

test('#495: prose is not read even when it sits beside a real declared block', () => {
  // Not "narrowed" — NOT READ. The prose here states a different number against
  // a different budget; the answer must come from the block alone.
  const r = parseCheckpointClaim(report({
    body: '# Checkpoint\n\nThe old tranche budget was 372/400 before ADR-0026.\n',
    claim: 'counted_lines: 213\ndiff_budget: 1000',
  }));
  assert.deepEqual(r, { ok: true, countedLines: 213, diffBudget: 1000 });
});

// ── MALFORMED is not ABSENT ─────────────────────────────────────────────────

test('#495: a non-integer value is malformed, not absent', () => {
  const r = parseCheckpointClaim(report({ claim: 'counted_lines: abc\ndiff_budget: 400' }));
  assert.equal(r.ok, false);
  assert.equal(r.absent, undefined, '"you wrote one and it is wrong" is not "you wrote none"');
  assert.match(r.error, /counted_lines/);
});

test('#612: counted_lines: (whitespace-only, no value) reads as the MISSING-key error, not "got \'\'"', () => {
  // Before #612, `scalar` captured the trailing space, so this fell through
  // to the "must be a non-negative integer, got ''" branch below — a claim
  // that read as malformed-but-present. `scalar` now answers `null` for a
  // whitespace-only key line, so this is the ABSENT branch: same error text
  // a truly missing `counted_lines:` line would produce.
  const r = parseCheckpointClaim(report({ claim: 'counted_lines: \ndiff_budget: 400' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /missing the required `counted_lines:` key/);
});

test('#495: a missing key is malformed, not absent', () => {
  const r = parseCheckpointClaim(report({ claim: 'counted_lines: 213' }));
  assert.equal(r.ok, false);
  assert.equal(r.absent, undefined);
  assert.match(r.error, /diff_budget/);
});

test('#495: a misspelled key is caught by the required-key check', () => {
  // `counted-lines` (hyphen) is the typo this contract is most likely to attract,
  // since the finding id it feeds is `drift:counted-lines`.
  const r = parseCheckpointClaim(report({ claim: 'counted-lines: 213\ndiff_budget: 400' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /counted_lines/);
});

test('#495: a negative count is malformed — a diff cannot have negative counted lines', () => {
  const r = parseCheckpointClaim(report({ claim: 'counted_lines: -5\ndiff_budget: 400' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /counted_lines/);
});

test('#495: a key stated twice is ambiguous, and ambiguity is an error', () => {
  const r = parseCheckpointClaim(report({ claim: 'counted_lines: 213\ncounted_lines: 999\ndiff_budget: 400' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /more than once/);
});

test('#495: two declared blocks are an error naming the count, not a choice between them', () => {
  const text = `${report()}\n\`\`\`${CHECKPOINT_TAG}\ncounted_lines: 999\ndiff_budget: 400\n\`\`\`\n`;
  const r = parseCheckpointClaim(text);
  assert.equal(r.ok, false);
  assert.equal(r.absent, undefined);
  assert.match(r.error, /2 /, 'the count belongs in the message — the author must know there are two');
});

test('#495: an unterminated declared fence is malformed, not "no block"', () => {
  const r = parseCheckpointClaim(`# R\n\n\`\`\`${CHECKPOINT_TAG}\ncounted_lines: 213\n`);
  assert.equal(r.ok, false);
  assert.equal(r.absent, undefined, 'a truncated block must not read as an absent one');
  assert.match(r.error, /never closed/);
});

// ── the locator: a report is FULL of fences, on purpose ─────────────────────

test('#495: an evidence fence cannot shadow the claim, wherever it sits', () => {
  // THE reason the block is selected by info-string tag rather than by position
  // (design D1). §10 evidence is command output, so a checkpoint report opens
  // with fences as a matter of course — and one of them can contain anything,
  // including text that looks exactly like the contract.
  const text =
    '# Checkpoint\n\n```bash\n$ npm test\ncounted_lines: 999\ndiff_budget: 200\n```\n\n' +
    `\`\`\`${CHECKPOINT_TAG}\ncounted_lines: 213\ndiff_budget: 400\n\`\`\`\n`;
  assert.deepEqual(parseCheckpointClaim(text), { ok: true, countedLines: 213, diffBudget: 400 });
});

test('#495: a claim quoted inside a LONGER fence is content, not a second block', () => {
  // How this contract is documented: the doctrine shows the block inside a
  // ````-fenced example. That example must not read as a declared claim.
  const text =
    `# Doc\n\n\`\`\`\`\n\`\`\`${CHECKPOINT_TAG}\ncounted_lines: 999\ndiff_budget: 200\n\`\`\`\n\`\`\`\`\n\n` +
    `\`\`\`${CHECKPOINT_TAG}\ncounted_lines: 213\ndiff_budget: 400\n\`\`\`\n`;
  assert.deepEqual(parseCheckpointClaim(text), { ok: true, countedLines: 213, diffBudget: 400 });
});

// ── non-string / empty input never throws ───────────────────────────────────

test('#495: junk input answers absent rather than throwing', () => {
  for (const junk of [undefined, null, '', 42, {}]) {
    const r = parseCheckpointClaim(junk);
    assert.equal(r.ok, false, `${String(junk)}: no claim`);
    assert.equal(r.absent, true);
  }
});
