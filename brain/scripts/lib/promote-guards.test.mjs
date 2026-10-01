// promote-guards.test.mjs — the content guards brain:promote runs against the
// DESTINATION before it writes anything (issues #675 and #674).
//
// The end-to-end proof (a real fixture repo, a real refusal, an untouched index)
// lives in brain-promote.test.mjs. This file pins the rules themselves: which
// destinations each guard is about, what it says, and — the property both
// tickets turn on — that a guard which could not answer never reads as "clean".
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GUARDS, checkShippedContent, renderGuardSummary } from './promote-guards.mjs';
import { checkSingleStatusLine } from './amendment-draft.mjs';
import { foreignHostsIn } from './shipped-hostnames.mjs';

const ADR_DEST = 'brain/project/decisions/adr-0031-a-slug.md';
const guardNamed = (name) => GUARDS.find((g) => g.name === name);

// Assembled from parts, never written as a literal URL: this file is under
// `brain/**` and is scanned by the very guard it tests — a probe spelled out in
// full would make shipped-hostnames flag its own test (#648's own lesson).
const FOREIGN_HOST = ['session', 'somewhere', 'gov', 'ar'].join('.');

/** The artefact #675 measured, minus the second header. */
const WELL_FORMED = `# ADR-0031 — A title

**Status**: Accepted
**Date**: 2026-08-15 — Fixture Human

## Context

Something.
`;

/** Exactly what brain:promote wrote, staged and printed a commit command for. */
const TWO_STATUS_LINES = `# ADR-0031 — A title

**Status**: Accepted
**Date**: 2026-08-15 — Fixture Human

**Status**: Proposed — pending human signature
**Date**: 2026-08-15 — drafted by agent

## Context

Something.
`;

// ═══════════════════════════════════════════════════════════════════════════
// #675 — single-status-line
// ═══════════════════════════════════════════════════════════════════════════

test('#675: the artefact brain:promote actually produced is REFUSED', () => {
  const r = checkShippedContent({ writes: [{ relPath: ADR_DEST, text: TWO_STATUS_LINES }] });
  assert.equal(r.ok, false);
  const text = r.lines.join('\n');
  assert.match(text, /single-status-line/);
  assert.match(text, /2 `\*\*Status\*\*:` line\(s\), expected exactly 1/);
  assert.match(text, new RegExp(ADR_DEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // The refusal has to make the fix one edit: it names the DRAFT-side cause and
  // shows the house shape, which otherwise lives only in transformDraft's
  // docstring — a function the draft's author never reads (#675 req 4).
  assert.match(text, /> \*\*status:\*\*/, 'the refusal must show the preamble blockquote shape');
  assert.match(text, /Nothing was written and nothing was staged/);
  assert.match(text, /every applicable guard reported/);
});

test('#675: ZERO status lines is refused too — malformed is not only "too many"', () => {
  const r = checkShippedContent({ writes: [{ relPath: ADR_DEST, text: '# ADR-0031 — A title\n\n## Context\n' }] });
  assert.equal(r.ok, false);
  assert.match(r.lines.join('\n'), /0 `\*\*Status\*\*:` line\(s\)/);
});

test('#675: a well-formed ADR passes, and the run reports which guards asked', () => {
  const r = checkShippedContent({ writes: [{ relPath: ADR_DEST, text: WELL_FORMED }] });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.ran.map((x) => x.guard).sort(),
    ['shipped-hostnames', 'single-status-line'],
  );
});

test('#675: single-status-line is NOT a third implementation — it delegates', () => {
  // The guard and the module that owns the rule must reach the same verdict on
  // the same bytes. Asserted rather than assumed: a copied regex would agree
  // today and drift on the first edit, which is the #130/#340/#555 shape both
  // halves of this verb were just found to have.
  for (const text of [WELL_FORMED, TWO_STATUS_LINES, '# no status\n']) {
    assert.equal(
      guardNamed('single-status-line').check(text, ADR_DEST).ok,
      checkSingleStatusLine(text).ok,
      'the guard disagreed with checkSingleStatusLine',
    );
  }
});

for (const notAnAdr of ['brain/HOME.md', 'AGENTS.md', 'brain/core/methodology/agent-authorities.md']) {
  test(`#675: single-status-line does not apply to ${notAnAdr} — it correctly has none`, () => {
    assert.equal(guardNamed('single-status-line').applies(notAnAdr), false);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// #674 — shipped-hostnames, keyed on the DESTINATION
// ═══════════════════════════════════════════════════════════════════════════

test('#674: a foreign host in the destination content is refused, before any write', () => {
  const text = `${WELL_FORMED}\nEvidence: ${'https://'}${FOREIGN_HOST}/abc\n`;
  const host = foreignHostsIn(text);
  assert.deepEqual(host, [FOREIGN_HOST], 'the fixture must actually carry one foreign host');

  const r = checkShippedContent({ writes: [{ relPath: ADR_DEST, text }] });
  assert.equal(r.ok, false);
  const out = r.lines.join('\n');
  assert.match(out, /shipped-hostnames/);
  assert.match(out, new RegExp(FOREIGN_HOST.replace(/\./g, '\\.')), 'the refusal must name the offending host');
  assert.match(out, /adr-0031-a-slug\.md/, 'the refusal must name the destination');
  assert.match(out, /DESTINATION is what makes a file shipped/);
});

test('#674: the guard keys on the DESTINATION, not on the draft path — that IS the defect', () => {
  const g = guardNamed('shipped-hostnames');
  assert.equal(g.applies(ADR_DEST), true);
  assert.equal(g.applies('brain/HOME.md'), true);
  // Where the same bytes lived for their entire reviewable life, green:
  assert.equal(g.applies('openspec/changes/issue-671-x/brain-drafts/adr-0031-a-slug.md'), false);
  // Emitted at the repo root, outside the `files` allowlist — the shipped scan
  // does not cover it either, and neither does this.
  assert.equal(g.applies('AGENTS.md'), false);
  // Not text.
  assert.equal(g.applies('brain/assets/logo.png'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// "Could not check" is not "checked clean" (#674 req 5)
// ═══════════════════════════════════════════════════════════════════════════

test('#674: a guard that THROWS refuses the run — it never reads as a pass', () => {
  const exploding = [{
    name: 'explodes',
    applies: () => true,
    check() { throw new Error('the rule could not be evaluated'); },
  }];
  const r = checkShippedContent({ writes: [{ relPath: ADR_DEST, text: WELL_FORMED }], guards: exploding });
  assert.equal(r.ok, false, 'a guard that could not answer must not answer "clean"');
  const out = r.lines.join('\n');
  assert.match(out, /explodes guard FAILED to run/);
  assert.match(out, /the rule could not be evaluated/);
});

test('#674: a run where NO guard applied says so — silence would read as "checked clean"', () => {
  const r = checkShippedContent({ writes: [{ relPath: 'openspec/changes/x/notes.md', text: 'anything' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ran, []);
  assert.match(r.summary, /NONE applied/);
  assert.match(r.summary, /not "checked clean"/);
});

test('#674: the positive summary names every guard/file pair that ran', () => {
  const summary = renderGuardSummary(
    [{ guard: 'single-status-line', relPath: ADR_DEST }, { guard: 'shipped-hostnames', relPath: ADR_DEST }],
    3,
  );
  assert.match(summary, /single-status-line/);
  assert.match(summary, /shipped-hostnames/);
  assert.equal(summary.split(ADR_DEST).length - 1, 2, 'both pairs must be listed, not just the guard names');
});

// ═══════════════════════════════════════════════════════════════════════════
// The registry itself
// ═══════════════════════════════════════════════════════════════════════════

test('#675/#674: every guard names the module that owns its rule', () => {
  assert.ok(GUARDS.length >= 2, 'the registry was emptied — every promotion would then read as checked');
  for (const g of GUARDS) {
    assert.match(g.rule, /^brain\/scripts\/lib\/[a-z-]+\.mjs — /, `${g.name} must cite the module owning its rule`);
    assert.equal(typeof g.applies, 'function');
    assert.equal(typeof g.check, 'function');
  }
});

test('#675/#674: EVERY applicable guard reports — one promote cycle, not one per defect', () => {
  // Both defects on one file, the shape the ADR-0031 promotion actually had.
  // Stopping at the first would send the maintainer through the loop #674 was
  // filed to remove: fix, re-run, discover the second, fix, re-run.
  const bad = `${TWO_STATUS_LINES}\nsee ${'https://'}${FOREIGN_HOST}/x\n`;
  const r = checkShippedContent({ writes: [{ relPath: ADR_DEST, text: bad }] });
  assert.equal(r.ok, false);
  assert.equal(r.findings, 2);
  const out = r.lines.join('\n');
  assert.match(out, /single-status-line/);
  assert.match(out, /shipped-hostnames/);
  assert.match(out, /2 finding\(s\), every applicable guard reported/);
});

test('#674: with a guard unreadable, the report does NOT claim to be complete', () => {
  // The completeness claim is the same evidence rule one level up: a list that
  // says "every applicable guard reported" when one of them could not run is
  // exactly the "could not check" ≡ "checked clean" inversion.
  const mixed = [
    guardNamed('single-status-line'),
    { name: 'explodes', applies: () => true, check() { throw new Error('boom'); } },
  ];
  const r = checkShippedContent({ writes: [{ relPath: ADR_DEST, text: TWO_STATUS_LINES }], guards: mixed });
  assert.equal(r.ok, false);
  assert.equal(r.findings, 2, 'the readable guard still reported — an unreadable one must not silence it');
  const out = r.lines.join('\n');
  assert.match(out, /1 guard\(s\) could not run, so this list may be incomplete/);
  assert.equal(/every applicable guard reported/.test(out), false, 'completeness must not be claimed here');
});

// ═══════════════════════════════════════════════════════════════════════════
// The refusal may not assume which path produced the file
// ═══════════════════════════════════════════════════════════════════════════

test('#675: a duplicate in the PREAMBLE gets the draft-blockquote guidance', () => {
  const out = checkShippedContent({ writes: [{ relPath: ADR_DEST, text: TWO_STATUS_LINES }] }).lines.join('\n');
  assert.match(out, /line 3 \(preamble\)/);
  assert.match(out, /line 6 \(preamble\)/);
  assert.match(out, /More than one in the PREAMBLE/);
  assert.match(out, /> \*\*status:\*\*/);
  assert.equal(/In the BODY/.test(out), false, 'body guidance has no place here');
});

test('#675: a duplicate in the BODY does NOT get told to fix a preamble it does not have', () => {
  // Measured on the amendment path: an amendment whose appended section quotes
  // the line it changes produces two, and the first cut of this message told the
  // reader the verb "prepends the signature header" — which it does not do there.
  const amended = `# ADR-0026 — T

**Status**: Accepted — Amendment 1
**Date**: 2026-01-01 — H

## Amendment 1

The line this amendment changes reads:

**Status**: Proposed
`;
  const out = checkShippedContent({ writes: [{ relPath: ADR_DEST, text: amended }] }).lines.join('\n');
  assert.match(out, /line 10 \(body\)/);
  assert.match(out, /In the BODY/);
  assert.match(out, /matched at LINE START/);
  assert.equal(/More than one in the PREAMBLE/.test(out), false);
  assert.equal(/> \*\*status:\*\*/.test(out), false, 'an amendment draft has no preamble blockquote to fix');
});

test('#675: ZERO status lines says the artefact has none — not that it has too many', () => {
  const out = checkShippedContent({ writes: [{ relPath: ADR_DEST, text: '# ADR-0031 — T\n\n## C\n' }] }).lines.join('\n');
  assert.match(out, /carries NO `\*\*Status\*\*:` line at all/);
  assert.equal(/found at:/.test(out), false, 'there is nothing to locate');
});
