// promote-guards.mjs — "is the artefact I am about to sign well formed?",
// asked BEFORE brain:promote writes anything (issues #675 and #674).
//
// TWO FINDINGS, ONE SLOT. Both were found on the same promotion (ADR-0031,
// PR #672), both are the same defect at different layers, and both are cured by
// asking one question one step earlier:
//
//  1. **#675 — the verb wrote a corrupt signed ADR and staged it.** The draft
//     carried a bare `**Status**:` line where the house shape puts it inside the
//     stripped preamble blockquote, `transformDraft` prepended its own header,
//     and the result carried TWO. The maintainer typed `PROMOTE`, ran the
//     printed commit and pushed. The rule was already written next door —
//     `applyStatusAct` refuses to *touch* a file with two Status lines — so the
//     two halves of one verb disagreed about whether that artefact may exist.
//     This one fails OPEN, which is why it outranks its siblings.
//
//  2. **#674 — a guard whose surface excludes its subject.** `brain/**` ships;
//     drafts live in `openspec/changes/**/brain-drafts/**` and do not. So
//     `shipped-hostnames` could not see the file until promotion had already
//     put it there — after the signature. The DESTINATION is what makes a file
//     shipped, so the check belongs at the moment the destination is chosen.
//
// NOT A THIRD IMPLEMENTATION. Every guard below DELEGATES to the module that
// already owns its rule (`amendment-draft.mjs`, `shipped-hostnames.mjs`). What
// is new here is the registry and the call site, not the rules — copying either
// one would be #130/#340/#555 exactly where two of them were just found.
//
// PURE. Text in, verdict out; no disk, no spawn. The I/O, the confirmation and
// the git seam stay in brain-promote.mjs, so ADR-0028's four locks keep one
// implementation each.

import { ADR_TARGET_RE, checkSingleStatusLine } from './amendment-draft.mjs';
import { TEXT, foreignHostsIn } from './shipped-hostnames.mjs';

/** The package `files` allowlist entry that makes a path reach consumers' disks. */
export const SHIPPED_PREFIX = 'brain/';

/**
 * Names WHERE the offending `**Status**:` lines are, and gives the guidance that
 * fits each position — never guidance for a shape the artefact does not have.
 *
 * THE MESSAGE MAY NOT ASSUME WHICH PATH PRODUCED THE FILE. The first cut of this
 * guard was written for the new-ADR path alone: it told the reader the verb
 * "prepends the signature header itself" and to fix "the preamble blockquote".
 * Measured, the guard also fires on the AMENDMENT path — an amendment whose
 * appended body carries a line starting with `**Status**:` produces two — and
 * there the message described a header the verb never writes and a blockquote
 * an amendment draft does not have. A refusal with a correct verdict and an
 * invented cause is the shape that cost #604 three token rotations.
 *
 * So the diagnosis is derived from the TEXT: a duplicate above the first `## `
 * heading is the preamble that survived the header rewrite; one below it is
 * ordinary prose at line start. Both, neither, or one — whatever is true.
 *
 * @param {string} text
 * @param {number[]} indices  0-based line indices, from checkSingleStatusLine
 * @returns {string[]}
 */
export function locateStatusLines(text, indices = []) {
  const lines = text.split('\n');
  if (indices.length === 0) {
    return [
      '',
      '  The artefact carries NO `**Status**:` line at all. A signed ADR opens with one',
      '  (§1c act 1 rewrites it on every amendment, and refuses when it cannot find it).',
    ];
  }
  const firstHeading = lines.findIndex((l) => /^##\s/.test(l));
  const inPreamble = indices.filter((i) => firstHeading === -1 || i < firstHeading);
  const inBody = indices.filter((i) => firstHeading !== -1 && i >= firstHeading);

  const out = ['', '  found at:'];
  for (const i of indices) {
    const where = firstHeading === -1 || i < firstHeading ? 'preamble' : 'body';
    out.push(`    line ${i + 1} (${where})  ${lines[i].replace(/\r$/, '').slice(0, 72)}`);
  }
  if (inPreamble.length > 1) {
    out.push(
      '',
      '  More than one in the PREAMBLE. brain:promote writes the signature header itself,',
      '  so a draft must not carry a `**Status**:` line of its own as ordinary text — the',
      '  house shape puts it in the blockquote this verb strips:',
      '',
      '      > **status:** proposed — pending human promotion | **date:** <date> | **owner:** <handle>',
    );
  }
  if (inBody.length > 0) {
    out.push(
      '',
      '  In the BODY. The marker is matched at LINE START, so prose that quotes it — an',
      '  amendment section describing the line it changes, for instance — reads as a second',
      '  status. Indent it, inline it, or write it generically (`**Status**` without the colon).',
    );
  }
  return out;
}

/**
 * The guards, in the order they run. Each declares WHICH destination paths it
 * is about — a rule that applied to every write would fire `single-status-line`
 * on `brain/HOME.md`, which correctly has none.
 *
 * `applies` keys on the DESTINATION path, never on the draft path. That is the
 * whole of #674 in one line: the draft path is outside the shipped surface, so
 * asking about it is asking the wrong question.
 */
export const GUARDS = Object.freeze([
  Object.freeze({
    name: 'single-status-line',
    rule: 'brain/scripts/lib/amendment-draft.mjs — checkSingleStatusLine (§1c act 1)',
    applies: (relPath) => ADR_TARGET_RE.test(relPath),
    check(text, relPath) {
      const single = checkSingleStatusLine(text);
      if (single.ok) return { ok: true };
      return {
        ok: false,
        lines: [
          '✗ single-status-line — the artefact this run would write is malformed:',
          `    ${relPath}`,
          `    ${single.error}`,
          ...locateStatusLines(text, single.indices),
          '',
          '  The amendment path already refuses to touch a file with two of them, so a',
          '  promote that produced one could not be repaired by the sanctioned route —',
          '  only by reverting the signing commit (#675).',
        ],
      };
    },
  }),
  Object.freeze({
    name: 'shipped-hostnames',
    rule: 'brain/scripts/lib/shipped-hostnames.mjs — foreignHostsIn (#648)',
    applies: (relPath) => relPath.startsWith(SHIPPED_PREFIX) && TEXT.test(relPath),
    check(text, relPath) {
      const hosts = [...new Set(foreignHostsIn(text))];
      if (hosts.length === 0) return { ok: true };
      return {
        ok: false,
        lines: [
          '✗ shipped-hostnames — the artefact this run would write names a host that is',
          '  neither reserved (RFC 2606/6761) nor on brain\'s allowlist:',
          ...hosts.map((h) => `    ${h}  @ ${relPath}`),
          '',
          '  The DESTINATION is what makes a file shipped: `brain/**` is in the package',
          '  `files` allowlist, so this text lands on every consumer\'s disk. The draft path',
          '  is outside that surface, which is why every check up to now was green (#674).',
          '',
          '  Use a reserved name (example.com, *.test, *.invalid), describe the host instead',
          '  of quoting it, or — if brain genuinely integrates with it — add it to',
          '  ALLOWED_REAL in brain/scripts/lib/shipped-hostnames.mjs with the reason.',
        ],
      };
    },
  }),
]);

/**
 * Runs every applicable guard over the content each write would produce.
 *
 * "COULD NOT CHECK" IS NOT "CHECKED CLEAN" (#674 req 5, and the
 * `evidence-reader-empty-on-failure` family). Two consequences, both deliberate:
 *
 *  - A guard that THROWS is a refusal, not a skip. A reader that reports nothing
 *    when it failed is indistinguishable from one that found nothing, and that
 *    is the shape this repository keeps closing.
 *  - The summary states how many guard/file pairs actually ran, and says so
 *    explicitly when the answer is zero. A silent clean run and a run where
 *    nothing was applicable must not look the same to the human about to sign.
 *
 * @param {{writes: {relPath:string, text:string}[], guards?: typeof GUARDS}} ctx
 * @returns {{ok:true, ran:{guard:string, relPath:string}[], summary:string}
 *          |{ok:false, lines:string[]}}
 */
export function checkShippedContent({ writes, guards = GUARDS }) {
  const ran = [];
  const findings = [];
  let unreadable = 0;

  for (const { relPath, text } of writes) {
    for (const guard of guards) {
      if (!guard.applies(relPath)) continue;
      let verdict;
      try {
        verdict = guard.check(text, relPath);
      } catch (error) {
        // Recorded and kept going, not returned. A guard that could not answer
        // is its own finding, and stopping here would hide the ones that CAN.
        unreadable += 1;
        findings.push([
          `✗ the ${guard.name} guard FAILED to run against ${relPath}:`,
          `    ${error.message}`,
          '',
          '  Refusing rather than proceeding. A guard that could not answer has not',
          '  answered "clean", and this run would sign the file it could not read.',
        ]);
        continue;
      }
      if (!verdict.ok) {
        findings.push(verdict.lines);
        continue;
      }
      ran.push({ guard: guard.name, relPath });
    }
  }

  if (findings.length > 0) return { ok: false, lines: renderFindings(findings, unreadable), findings: findings.length };
  return { ok: true, ran, summary: renderGuardSummary(ran, writes.length) };
}

/**
 * EVERY applicable guard reports, not just the first to fail.
 *
 * Stopping at the first finding costs a whole promote cycle per defect, and the
 * artefact that motivated both tickets had TWO — so the first cut of this
 * function would have sent the maintainer through exactly the loop #674 was
 * filed to remove: fix, re-run, discover the second, fix, re-run.
 *
 * The completeness claim is qualified rather than assumed. When a guard could
 * not run, the list is explicitly NOT stated to be everything — the same rule
 * that makes an unreadable guard a refusal in the first place.
 *
 * @param {string[][]} findings
 * @param {number} unreadable
 * @returns {string[]}
 */
export function renderFindings(findings, unreadable) {
  const lines = [];
  for (const [i, f] of findings.entries()) {
    if (i > 0) lines.push('');
    lines.push(...f);
  }
  lines.push('');
  lines.push(
    unreadable > 0
      ? `  Nothing was written and nothing was staged — ${findings.length} finding(s), and ` +
        `${unreadable} guard(s) could not run, so this list may be incomplete.`
      : `  Nothing was written and nothing was staged — ${findings.length} finding(s), ` +
        'every applicable guard reported.',
  );
  return lines;
}

/**
 * The positive report. Shown next to the plan, so the human signing knows which
 * questions were asked about the bytes rather than inferring it from silence.
 *
 * @param {{guard:string, relPath:string}[]} ran
 * @param {number} writeCount
 * @returns {string}
 */
export function renderGuardSummary(ran, writeCount) {
  if (ran.length === 0) {
    return [
      `  guards — NONE applied to the ${writeCount} file(s) this run writes.`,
      '           That is "not checked", not "checked clean".',
      '',
    ].join('\n');
  }
  const width = Math.max(...ran.map((r) => r.guard.length));
  return [
    '  guards — ran against the DESTINATION content, before this plan:',
    ...ran.map((r) => `      ${r.guard.padEnd(width)}  ${r.relPath}`),
    '',
  ].join('\n');
}
