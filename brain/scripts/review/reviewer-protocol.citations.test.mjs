// reviewer-protocol.citations.test.mjs — issue #586.
//
// `reviewer-protocol.md` is signed Tier 2 doctrine, and its line-number
// citations rotted twice in two days: #580 found `brain-writes-reviewed.mjs:99`
// had become a JSDoc block, and the fix for it shipped four NEW rotted citations
// into §6.2 because #483 had moved `verdict.mjs` in the same session.
//
// THE RULE: no source line citation anywhere in the document. Cite symbols.
//
// The first version of this guard exempted blockquotes, on the reasoning that a
// blockquote is an aside and the one legitimate use is recording where something
// USED to be. A cold review demolished that: this document uses blockquotes for
// load-bearing CURRENT doctrine (the R2 note, the lock summary, the live-tree
// note), so the exemption permitted line citations in precisely the most
// rot-prone construct in the file — and one had already rotted there,
// `brain.config.json:16`, which the .mjs-only regex missed as well. Both holes
// are closed by having no exemption at all: §2's historical note now describes
// the old citation instead of reproducing it, so nothing needs one.
//
// WHAT THIS DOES NOT CATCH, stated rather than implied: prose forms
// ("line 167 of `foo.mjs`"), GitHub anchor forms (`foo.mjs#L167`), and a
// citation broken across a soft wrap. Those are real bypasses. This guard
// enforces the literal `file.ext:NNN` form, which is the form both incidents
// actually used and the only one checkable without false positives over a
// document full of `status:approved` and `brain-review/2`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const DOC = 'brain/core/methodology/reviewer-protocol.md';

// Any source-ish extension, not just .mjs — the rotted citation the first
// version of this guard missed was a `.json` one.
const LINE_CITATION_RE = /[A-Za-z0-9_.-]+\.(?:mjs|cjs|js|ts|json|ya?ml|md|sh):\d+/;

/**
 * The single detector. BOTH tests below call this one function on purpose: the
 * first version duplicated the filter chain into each test, so widening the
 * chain in the real test left the negative control green and the guard inert —
 * the #335 class inside the guard written to prevent #335. One implementation
 * cannot drift from itself.
 *
 * @param {string[]} lines
 * @returns {Array<{ n: number, text: string }>}
 */
export function findOffenders(lines) {
  return lines
    .map((text, i) => ({ text, n: i + 1 }))
    .filter(({ text }) => LINE_CITATION_RE.test(text));
}

test('#586: reviewer-protocol.md cites symbols — no source line citation anywhere', () => {
  const offenders = findOffenders(readFileSync(join(repoRoot, DOC), 'utf8').split(/\r?\n/));

  assert.deepEqual(offenders, [],
    `${DOC} cites a source line number. Line numbers move; symbols do not, and a doctrine that ` +
    `points at a moving target sends its own verifier to the wrong text (#580, #586). Cite the ` +
    `enclosing function or exported constant. If the point is HISTORICAL — that a citation used ` +
    `to point somewhere — describe it ("cited a line number in x.mjs") rather than reproducing ` +
    `the citation, which is what §2's note does.\nOffending lines:\n` +
    offenders.map(o => `  ${DOC}:${o.n}  ${o.text.trim()}`).join('\n'));
});

test('#586: the guard is a real detector — it fires on every extension, in every construct', () => {
  // Negative control. Every vector here was a demonstrated BYPASS of the first
  // version of this guard, so the fixture is the review's findings turned into a
  // test rather than a hand-waved "it works".
  const vectors = [
    ['body text, .mjs', 'The approver set is built in (`brain-writes-reviewed.mjs:99`).', true],
    ['blockquote, .mjs', '> An earlier revision cited `verdict.mjs:65`.', true],
    ['blockquote, .json', '> not populated (only ignoreList exists, `brain.config.json:16`).', true],
    ['body text, .md', 'See `vcs-contract.md:39` for the verb table.', true],
    ['indented list item', '  - the reader is `actor-check.mjs:838`', true],
    ['no citation at all', 'The approver set is built in `evaluateBrainWritesReviewed`.', false],
    ['a version number, not a citation', 'Pinned at node:20.11 for the runner.', false],
    ['a protocol scalar', 'Every verdict is `brain-review/2` at regulated.', false],
  ];

  for (const [name, line, shouldCatch] of vectors) {
    assert.equal(findOffenders([line]).length, shouldCatch ? 1 : 0,
      `vector "${name}" ${shouldCatch ? 'must be caught' : 'must NOT be caught'}: ${line}`);
  }
});
