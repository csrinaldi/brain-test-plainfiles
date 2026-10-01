// amendment-draft.test.mjs — the pure half of brain:promote's amendment path
// (issue #509). Everything here is string-in/string-out; the behavioural half
// lives in brain-promote.amendment.test.mjs and the acceptance oracle in
// brain-promote.golden.test.mjs.
//
// Refusals are asserted on the REASON, never only on `ok === false`: a parser
// that rejects everything would satisfy a boolean assertion and nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTRACT_TAG,
  amendHomeLine,
  amendStatusLine,
  amendmentCommitSubject,
  applyEdits,
  appendSection,
  extractBody,
  assessEdit,
  countOccurrences,
  formatStampDate,
  spliceLine,
  parseAmendmentDraft,
  parseContractFields,
  planAmendment,
  stampSigned,
} from './amendment-draft.mjs';

const ADR_TARGET = 'brain/project/decisions/adr-0026-governance-doctrine-tiers.md';

/** A minimal but COMPLETE amendment draft — every required key, one edit pair. */
function draft({
  target = ADR_TARGET,
  amendment = 'amendment: 2\n',
  issue = 'issue: 473\n',
  homeSummary = 'home-summary: the summary line, #473\n',
  body = 'body: ## Amendment 2 — the title (issue #473)\n',
  bodyEnd = '',
  pairs = '```amend-find\nold text\n```\n\n```amend-replace\nnew text\n```\n',
  tail = '\n## Amendment 2 — the title (issue #473)\n\n**Signed**: DD/MM/YYYY — <Name>\n\nWhat changed.\n',
} = {}) {
  return (
    `# A draft\n\n\`\`\`${CONTRACT_TAG}\n` +
    `target: ${target}\n${amendment}${issue}${homeSummary}${body}${bodyEnd}` +
    '```\n\n' +
    `${pairs}${tail}`
  );
}

// ── the fence scanner ────────────────────────────────────────────────────────
// `fencedBlocks` moved to `lib/fenced-blocks.mjs` (#495 design D2); its three
// cases moved with it, verbatim. What stays here is what belongs to THIS
// module: how the amendment contract behaves when the scanner reports an
// unterminated fence.

test('parseAmendmentDraft: an unterminated contract fence is MALFORMED, not "no contract block"', () => {
  const r = parseAmendmentDraft(`# d\n\n\`\`\`${CONTRACT_TAG}\ntarget: brain/x.md\n`);
  assert.equal(r.ok, false);
  assert.equal(r.absent, undefined, 'a truncated contract must not read as an absent one');
  assert.match(r.error, /never closed/);
});

// ── the contract scalars ─────────────────────────────────────────────────────

test('parseContractFields: an UNKNOWN key is a refusal, not a silently ignored line', () => {
  const r = parseContractFields('target: brain/x.md\ntarrget: brain/y.md\n');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown contract key 'tarrget'/);
});

test('parseContractFields: a repeated key is a refusal (which one would have won?)', () => {
  const r = parseContractFields('target: brain/x.md\ntarget: brain/y.md\n');
  assert.equal(r.ok, false);
  assert.match(r.error, /appears more than once/);
});

test('parseContractFields: values keep their inner punctuation verbatim, comments and blanks are skipped', () => {
  const r = parseContractFields('# a comment\n\nhome-summary: a: b — c, #473\n');
  assert.equal(r.ok, true);
  assert.equal(r.fields['home-summary'], 'a: b — c, #473');
});

// ── what makes a draft an amendment draft ────────────────────────────────────

test('parseAmendmentDraft: a draft with no contract block reports ABSENT (distinct from malformed)', () => {
  const r = parseAmendmentDraft('# just prose\n');
  assert.equal(r.ok, false);
  assert.equal(r.absent, true);
});

test('parseAmendmentDraft: two contract blocks are refused — one draft, one target', () => {
  const r = parseAmendmentDraft(`${draft()}\n\`\`\`${CONTRACT_TAG}\ntarget: brain/x.md\n\`\`\`\n`);
  assert.equal(r.ok, false);
  assert.match(r.error, /2 .* blocks found/);
});

for (const bad of ['scripts/x.md', 'brain/../etc/passwd.md', 'brain/HOME.txt']) {
  test(`parseAmendmentDraft: target '${bad}' is refused — the verb amends brain/** Markdown only`, () => {
    const r = parseAmendmentDraft(draft({ target: bad, amendment: '', homeSummary: '', body: '' }));
    assert.equal(r.ok, false);
    assert.match(r.error, /not a brain\/\*\* Markdown path/);
  });
}

test('parseAmendmentDraft: an ADR target with no amend-find pair is refused (§1c act 2)', () => {
  const r = parseAmendmentDraft(draft({ pairs: '' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /at least one `amend-find`/);
});

test('parseAmendmentDraft: an ADR target with no home-summary is refused (§1c\'s ungated fourth act)', () => {
  const r = parseAmendmentDraft(draft({ homeSummary: '' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /home-summary/);
});

test('parseAmendmentDraft: a NON-ADR target carrying `amendment:` is refused — it has no Status line', () => {
  const r = parseAmendmentDraft(
    draft({ target: 'brain/core/methodology/workflow-governance.md', homeSummary: '', body: '' }),
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /applies to ADR targets only/);
});

test('parseAmendmentDraft: a NON-ADR target needs no amendment number, no summary and no body', () => {
  const r = parseAmendmentDraft(
    draft({ target: 'brain/core/methodology/workflow-governance.md', amendment: '', homeSummary: '', body: '' }),
  );
  assert.equal(r.ok, true, r.error);
  assert.equal(r.contract.isAdr, false);
  assert.equal(r.edits.length, 1);
});

test('parseAmendmentDraft: an unpaired amend-find is refused (a replace that never arrives)', () => {
  const r = parseAmendmentDraft(draft({ pairs: '```amend-find\nold\n```\n' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /has no `amend-replace` after it/);
});

test('parseAmendmentDraft: `issue: #473` and `issue: 473` both yield 473', () => {
  assert.equal(parseAmendmentDraft(draft({ issue: 'issue: #473\n' })).contract.issue, '473');
  assert.equal(parseAmendmentDraft(draft()).contract.issue, '473');
});

// ── §1c act 1 — the Status line ──────────────────────────────────────────────

test('amendStatusLine: an unamended ADR takes Amendment 1', () => {
  const r = amendStatusLine('**Status**: Accepted', { amendment: 1, date: '11/08/2026' });
  assert.equal(r.text, '**Status**: Accepted · **amended 11/08/2026** (Amendment 1 — see below)');
});

test('amendStatusLine: Amendment 1 → "Amendments 1-2", and the trailing two spaces SURVIVE', () => {
  const r = amendStatusLine('**Status**: Accepted · **amended 04/08/2026** (Amendment 1 — see below)  ', {
    amendment: 2,
    date: '08/08/2026',
  });
  assert.equal(r.text, '**Status**: Accepted · **amended 08/08/2026** (Amendments 1-2 — see below)  ');
  assert.equal(r.previous, 1);
});

test('amendStatusLine: "Amendments 1-3" → "Amendments 1-4"', () => {
  const r = amendStatusLine('**Status**: Accepted · **amended 09/08/2026** (Amendments 1-3 — see below)', {
    amendment: 4,
    date: '11/08/2026',
  });
  assert.equal(r.text, '**Status**: Accepted · **amended 11/08/2026** (Amendments 1-4 — see below)');
});

for (const [declared, line, why] of [
  [3, '**Status**: Accepted · **amended 04/08/2026** (Amendment 1 — see below)', 'skips number 2'],
  [2, '**Status**: Accepted', 'claims 2 on an unamended ADR'],
]) {
  test(`amendStatusLine: a draft that ${why} is refused — the record must not gain a gap`, () => {
    const r = amendStatusLine(line, { amendment: declared, date: '11/08/2026' });
    assert.equal(r.ok, false);
    assert.match(r.error, /expected \d+/);
  });
}

test('amendStatusLine: the number the target ALREADY carries reads as done, not as an error', () => {
  const r = amendStatusLine('**Status**: Accepted · **amended 04/08/2026** (Amendment 1 — see below)', {
    amendment: 1,
    date: '11/08/2026',
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'done');
});

test('amendStatusLine: an amendment marker in an unrecognised shape is refused, not overwritten', () => {
  const r = amendStatusLine('**Status**: Accepted · amended sometime (lots of amendments)', {
    amendment: 1,
    date: '11/08/2026',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not recognise/);
});

test('formatStampDate: ISO in, DD/MM/YYYY out — the shape §1c writes', () => {
  assert.equal(formatStampDate('2026-08-08'), '08/08/2026');
});

// ── §1c act 2 — the anchors ──────────────────────────────────────────────────

test('applyEdits: an anchor found exactly once is replaced; the replacement is LITERAL ($& is not expanded)', () => {
  const r = applyEdits('a X b\n', [{ find: 'X', replace: '$& and $1' }]);
  assert.equal(r.text, 'a $& and $1 b\n');
});

for (const [text, count] of [
  ['no anchor here\n', 0],
  ['X and X\n', 2],
]) {
  test(`applyEdits: an anchor occurring ${count} times REFUSES and names the count`, () => {
    const r = applyEdits(text, [{ find: 'X', replace: 'Y' }]);
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(`anchor occurs ${count} time`));
  });
}

test('applyEdits: edits apply in order, and a later anchor may be text an earlier edit created', () => {
  const r = applyEdits('one\n', [
    { find: 'one', replace: 'two' },
    { find: 'two', replace: 'three' },
  ]);
  assert.equal(r.text, 'three\n');
});

// ── §1c act 3 — the appended signed section ──────────────────────────────────

test('extractBody: the body runs from the heading to body-end (exclusive), trailing blanks trimmed', () => {
  const d = '# x\n\n## Amendment 2 — t\n\nbody line\n\n\n### Promotion is manual\n\nnot this\n';
  const r = extractBody(d, { bodyHeading: '## Amendment 2 — t', bodyEndHeading: '### Promotion is manual' });
  assert.equal(r.text, '## Amendment 2 — t\n\nbody line\n');
});

test('extractBody: with no body-end the body runs to the end of the draft', () => {
  const r = extractBody('## H\n\na\n', { bodyHeading: '## H', bodyEndHeading: null });
  assert.equal(r.text, '## H\n\na\n');
});

test('extractBody: a heading that appears twice is refused — which one is the body?', () => {
  const r = extractBody('## H\n\na\n\n## H\n', { bodyHeading: '## H', bodyEndHeading: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /occurs 2 times/);
});

test('stampSigned: the draft placeholder is REPLACED — the verb writes this line, never the draft', () => {
  const r = stampSigned('## H\n\n**Signed**: DD/MM/YYYY — <Name> *(filled in at promotion)*\n', {
    date: '08/08/2026',
    gitUserName: 'Ada Lovelace',
    required: true,
  });
  assert.equal(r.text, '## H\n\n**Signed**: 08/08/2026 — Ada Lovelace\n');
});

test('stampSigned: an ADR section with no Signed line is refused (§1c act 3)', () => {
  const r = stampSigned('## H\n\nno signature\n', { date: 'd', gitUserName: 'n', required: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /Signed/);
});

test('appendSection: exactly one blank line separates the existing text from the section', () => {
  assert.equal(appendSection('body.\n', '## A\n\nx\n'), 'body.\n\n## A\n\nx\n');
});

// ── §1c's fourth act — the brain/HOME.md marker ──────────────────────────────

test('amendHomeLine: a line ending in ")" gains "; **Amendment N, date** — summary" INSIDE the parens', () => {
  const home = '### Architecture decisions\n\n- [ADR-0026](project/decisions/adr-0026-x.md) — Tiers (resolves #329)\n';
  const r = amendHomeLine(home, { slug: 'adr-0026-x', amendment: 2, date: '08/08/2026', summary: 'a summary, #473' });
  assert.equal(
    r.after,
    '- [ADR-0026](project/decisions/adr-0026-x.md) — Tiers (resolves #329; **Amendment 2, 08/08/2026** — a summary, #473)',
  );
});

test('amendHomeLine: a line with no trailing parenthesis gains its own parenthetical', () => {
  const home = '- [ADR-0025](project/decisions/adr-0025-x.md) — Ordering\n';
  const r = amendHomeLine(home, { slug: 'adr-0025-x', amendment: 1, date: '11/08/2026', summary: 's, #1' });
  assert.equal(r.after, '- [ADR-0025](project/decisions/adr-0025-x.md) — Ordering (**Amendment 1, 11/08/2026** — s, #1)');
});

test('amendHomeLine: no index line for that ADR is a REFUSAL, not an insert', () => {
  const r = amendHomeLine('- [ADR-0001](project/decisions/adr-0001-y.md) — Y\n', {
    slug: 'adr-0026-x',
    amendment: 2,
    date: 'd',
    summary: 's',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /has 0 index lines/);
});

test('amendHomeLine: two index lines for the same ADR are a REFUSAL — a tool must not guess', () => {
  const dup = '- [ADR-0026](project/decisions/adr-0026-x.md) — A\n- [ADR-0026](project/decisions/adr-0026-x.md) — B\n';
  const r = amendHomeLine(dup, { slug: 'adr-0026-x', amendment: 2, date: 'd', summary: 's' });
  assert.equal(r.ok, false);
  assert.match(r.error, /has 2 index lines/);
});

// ── the commit subject ───────────────────────────────────────────────────────

test('amendmentCommitSubject: the ADR shape names the ADR, the amendment and the ticket', () => {
  const subject = amendmentCommitSubject({
    contract: { isAdr: true, adrNumber: '0026', amendment: 2, issue: '473', target: ADR_TARGET },
    bodyHeading: '## Amendment 2 — a signed block is admissible (issue #473)',
  });
  assert.equal(subject, 'docs(brain): ADR-0026 Amendment 2 — a signed block is admissible (#473)');
});

test('amendmentCommitSubject: the doc shape names the file, and the ticket is still there', () => {
  const subject = amendmentCommitSubject({
    contract: { isAdr: false, issue: '529', target: 'brain/core/methodology/workflow-governance.md' },
    bodyHeading: null,
  });
  assert.equal(subject, 'docs(brain): amend brain/core/methodology/workflow-governance.md (#529)');
});

test('amendmentCommitSubject: with no issue anywhere, the placeholder is visible rather than silently absent', () => {
  const subject = amendmentCommitSubject({ contract: { isAdr: false, issue: null, target: 'brain/x.md' }, bodyHeading: null });
  assert.match(subject, /#<issue-number>/);
});

// ── the whole plan ───────────────────────────────────────────────────────────

const TARGET_TEXT =
  '# ADR-0026 — X\n\n**Status**: Accepted · **amended 04/08/2026** (Amendment 1 — see below)  \n' +
  '**Date**: 31/07/2026 — Someone\n\n## Context\n\nold text\n';
const HOME_TEXT = '### Architecture decisions\n\n- [ADR-0026](project/decisions/adr-0026-governance-doctrine-tiers.md) — Tiers (#329)\n';

test('planAmendment: one accepted plan carries all four acts, in §1c order', () => {
  const r = planAmendment({
    draftText: draft(),
    targetText: TARGET_TEXT,
    homeText: HOME_TEXT,
    gitUserName: 'Ada Lovelace',
    today: '2026-08-08',
  });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.plan.acts.map((a) => a.act), ['1', '2', '3', '4']);
  assert.match(r.plan.targetText, /\*\*Status\*\*: Accepted · \*\*amended 08\/08\/2026\*\* \(Amendments 1-2 — see below\)/);
  assert.match(r.plan.targetText, /new text/);
  assert.match(r.plan.targetText, /\*\*Signed\*\*: 08\/08\/2026 — Ada Lovelace/);
  assert.match(r.plan.homeText, /\*\*Amendment 2, 08\/08\/2026\*\*/);
});

test('planAmendment: the plan SHOWN is the plan APPLIED — every act\'s "after" is in the produced text', () => {
  const r = planAmendment({
    draftText: draft(),
    targetText: TARGET_TEXT,
    homeText: HOME_TEXT,
    gitUserName: 'Ada Lovelace',
    today: '2026-08-08',
  });
  for (const act of r.plan.acts) {
    const haystack = act.what === 'brain/HOME.md marker' ? r.plan.homeText : r.plan.targetText;
    assert.ok(haystack.includes(act.after), `act ${act.act} rendered "${act.after}" but did not apply it`);
  }
});

test('planAmendment: a re-run over the fully amended text reports cascadeComplete and plans nothing', () => {
  const first = planAmendment({
    draftText: draft(),
    targetText: TARGET_TEXT,
    homeText: HOME_TEXT,
    gitUserName: 'Ada',
    today: '2026-08-08',
  });
  const second = planAmendment({
    draftText: draft(),
    targetText: first.plan.targetText,
    homeText: first.plan.homeText,
    gitUserName: 'Ada',
    today: '2026-08-09',
  });
  assert.equal(second.ok, true);
  assert.equal(second.cascadeComplete, true);
  assert.equal(second.plan, undefined);
  assert.deepEqual([...new Set(second.acts.map((a) => a.state))], ['done']);
});

test('planAmendment: `issueFallback` fills in only when the contract omits `issue:`', () => {
  const withIssue = planAmendment({
    draftText: draft(),
    targetText: TARGET_TEXT,
    homeText: HOME_TEXT,
    gitUserName: 'Ada',
    today: '2026-08-08',
    issueFallback: '999',
  });
  assert.match(withIssue.plan.commitSubject, /\(#473\)$/);

  const without = planAmendment({
    draftText: draft({ issue: '' }),
    targetText: TARGET_TEXT,
    homeText: HOME_TEXT,
    gitUserName: 'Ada',
    today: '2026-08-08',
    issueFallback: '999',
  });
  assert.match(without.plan.commitSubject, /\(#999\)$/);
});

test('planAmendment: the ADR shape with no brain/HOME.md refuses rather than dropping the fourth act', () => {
  const r = planAmendment({
    draftText: draft(),
    targetText: TARGET_TEXT,
    homeText: null,
    gitUserName: 'Ada',
    today: '2026-08-08',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /HOME\.md/);
});

// ═══════════════════════════════════════════════════════════════════════════
// The idempotence key — the cold review's BLOCKER 1 and BLOCKER 2.
//
// Both directions, on the same function, because a key that only refuses is as
// wrong as one that only accepts: BLOCKER 2 was a key that said "already done"
// about a document that had never been amended, and BLOCKER 1 was a key that
// said "already done" about a cascade three-quarters undone.
// ═══════════════════════════════════════════════════════════════════════════

test('countOccurrences: counts SELF-OVERLAPPING matches, which String.split does not', () => {
  // A Markdown table separator row is a plausible anchor, and the old key
  // reported it unique when it is not: the uniqueness gate was a lie.
  assert.equal('|---|---|'.split('|---|').length - 1, 1, 'the old counting rule reports 1…');
  assert.equal(countOccurrences('|---|---|', '|---|'), 2, '…while the string holds 2 overlapping');
});

const EDIT = { find: 'the old rule', replace: 'the old rule **[Amended by Amendment 2]**' };

test('assessEdit: BLOCKER 2 — a replacement that ALREADY appears elsewhere still leaves the edit PENDING', () => {
  // The document quotes the amended sentence in a summary AND still carries the
  // unamended anchor. The old key (`includes(replace)`) declared victory and
  // left the superseded passage standing — the exact harm §1c act 2 prevents.
  const text = `intro\n${EDIT.replace}\n\nbody: ${EDIT.find} applies.\n`;
  const r = assessEdit(text, EDIT);
  assert.equal(r.state, 'pending', `expected pending, got ${r.state} (f=${r.f} r=${r.r} k=${r.k})`);
});

test('assessEdit: the same edit reads DONE once actually applied', () => {
  const text = `intro\n${EDIT.replace}\n\nbody: ${EDIT.replace} applies.\n`;
  assert.equal(assessEdit(text, EDIT).state, 'done');
});

test('assessEdit: an anchor that is a PREFIX of its own replacement is DONE after applying, not pending again', () => {
  const edit = { find: '## Lockout Recovery', replace: '## Lockout Recovery (amended, #509)' };
  assert.equal(assessEdit('a\n## Lockout Recovery\nb\n', edit).state, 'pending');
  assert.equal(assessEdit('a\n## Lockout Recovery (amended, #509)\nb\n', edit).state, 'done');
});

test('assessEdit: a drifted anchor with no replacement anywhere is BLOCKED, never silently done', () => {
  assert.equal(assessEdit('nothing relevant here\n', EDIT).state, 'blocked');
});

test('assessEdit: two free anchors are BLOCKED — the verb must not pick one', () => {
  assert.equal(assessEdit(`${EDIT.find}\n${EDIT.find}\n`, EDIT).state, 'blocked');
});

test('assessEdit: one applied replacement plus one free anchor is PENDING — the tie counting cannot break', () => {
  // Arithmetically identical to the BLOCKER 2 case above (f=2, r=1, k=1), so the
  // two cannot be told apart by counting. It resolves to pending on purpose:
  // refusing here would refuse a genuine first application, which is BLOCKER 2.
  const r = assessEdit(`${EDIT.replace}\n${EDIT.find}\n`, EDIT);
  assert.equal(r.state, 'pending');
  assert.equal(r.free, 1);
});

test('assessEdit: TWO free anchors beside an applied one is BLOCKED — the verb must not pick', () => {
  assert.equal(assessEdit(`${EDIT.replace}\n${EDIT.find}\n${EDIT.find}\n`, EDIT).state, 'blocked');
});

// ── BLOCKER 1 — the cascade is one unit ──────────────────────────────────────

/** The target with only the signed section pasted in — how a human does it by hand. */
const HAND_PASTED = `${TARGET_TEXT}\n## Amendment 2 — the title (issue #473)\n\n**Signed**: 08/08/2026 — Ada\n\nWhat changed.\n`;

test('BLOCKER 1: a hand-pasted signed section with the rest of the cascade undone REFUSES — it is not "already promoted"', () => {
  const r = planAmendment({
    draftText: draft(),
    targetText: HAND_PASTED,
    homeText: HOME_TEXT,
    gitUserName: 'Ada',
    today: '2026-08-08',
  });
  assert.equal(r.ok, false, 'a partial cascade must never report success');
  assert.equal(r.partial, true);
  // The refusal names every act's state — the human has to know which three are missing.
  assert.match(r.error, /act 1 — Status line: PENDING/);
  assert.match(r.error, /act 3 — appended signed section: DONE/);
  assert.match(r.error, /act 4 — brain\/HOME\.md marker: PENDING/);
});

test('BLOCKER 1: the brain/HOME.md marker alone does not make the cascade complete either', () => {
  const homeMarked = HOME_TEXT.replace('(#329)', '(#329; **Amendment 2, 08/08/2026** — s)');
  const r = planAmendment({
    draftText: draft(),
    targetText: TARGET_TEXT,
    homeText: homeMarked,
    gitUserName: 'Ada',
    today: '2026-08-08',
  });
  assert.equal(r.ok, false);
  assert.equal(r.partial, true);
  assert.match(r.error, /act 4 — brain\/HOME\.md marker: DONE/);
});

test('BLOCKER 1: with every act applied, the disposition is cascadeComplete — and it lists the acts as evidence', () => {
  const first = planAmendment({
    draftText: draft(),
    targetText: TARGET_TEXT,
    homeText: HOME_TEXT,
    gitUserName: 'Ada',
    today: '2026-08-08',
  });
  const r = planAmendment({
    draftText: draft(),
    targetText: first.plan.targetText,
    homeText: first.plan.homeText,
    gitUserName: 'Ada',
    today: '2026-08-09',
  });
  assert.equal(r.cascadeComplete, true);
  assert.equal(r.acts.length, 4);
});

// ── EOL safety ───────────────────────────────────────────────────────────────

test('spliceLine: rewrites ONE line and leaves every other byte, CRLF included, untouched', () => {
  const text = 'a\r\nb\nc\r\n';
  assert.equal(spliceLine(text, 1, 'B'), 'a\r\nB\nc\r\n');
});

test('a single stray CRLF does not turn a one-line amendment into a whole-file rewrite', () => {
  // The old code detected the file's EOL as CRLF because ONE line had one, then
  // re-joined every line with it. The plan showed four acts; the diff was 300.
  const mixed = TARGET_TEXT.replace('## Context', '## Context\r');
  const r = planAmendment({
    draftText: draft(),
    targetText: mixed,
    homeText: HOME_TEXT,
    gitUserName: 'Ada',
    today: '2026-08-08',
  });
  assert.equal(r.ok, true, r.error);
  const before = mixed.split('\n');
  const after = r.plan.targetText.split('\n');
  const changed = before.filter((l, i) => after[i] !== l).length;
  assert.equal(changed, 2, `only the Status line and the edited line may change, got ${changed}`);
});
