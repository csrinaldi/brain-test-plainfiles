// amendment-draft.mjs — the `brain-amendment/1` draft contract: parser + pure
// planner for brain:promote's in-place amendment path (issue #509, slice 2).
//
// Slice 1 (#378) promotes a NEW ADR file. This module covers the other shape —
// editing an ALREADY-SIGNED brain/** file — which consolidation-protocol.md §1c
// defines as three acts in one commit, plus §1d's cascade.
//
// Everything here is PURE: text in, text out, never touches disk and never
// spawns. The I/O, the confirmation and the git seam stay in brain-promote.mjs,
// so ADR-0028's four locks keep exactly one implementation each.
//
// THE DRAFT DECLARES CONTENT; THE VERB GENERATES SHAPE. A draft cannot get the
// Status-line format, the amendment number, the brain/HOME.md marker or the
// AGENTS.md regeneration wrong, because it does not write them — it declares a
// target, the passages it supersedes, and the prose. Rationale and rejected
// alternatives: openspec/changes/issue-509-promote-amendments/design.md D1-D3.
//
// A draft is an amendment draft when its basename ends `.draft.md` AND it
// carries exactly one fenced `brain-amendment/1` block, plus ordered
// `amend-find`/`amend-replace` fence pairs for §1c act 2:
//
//   ```brain-amendment/1
//   target: brain/project/decisions/adr-0026-governance-doctrine-tiers.md
//   amendment: 2
//   issue: 473
//   home-summary: a signed `brain-decision/1` block is admissible evidence, #473
//   body: ## Amendment 2 — a signed decision block is admissible (issue #473)
//   body-end: ### Promotion is manual
//   ```
//
// Both stopgap scripts this replaces (promote-529.sh, promote-516.sh) anchored
// on exact strings and refused when an anchor was found ≠ 1 times rather than
// editing something adjacent. That property is preserved verbatim, and so is
// idempotence.

// #495 design D2: the fence splitter is shared with `lib/checkpoint-block.mjs`
// and lives in its own module. It was extracted from here as a pure move, not
// copied — a second implementation of "which fenced blocks does this document
// have" is the shape `brain/core/anti-patterns/one-rule-two-implementations.md`
// records.
import { fencedBlocks } from './fenced-blocks.mjs';

/** The fence info-string that marks a draft as an amendment draft. */
export const CONTRACT_TAG = 'brain-amendment/1';

/** Fence info-strings for §1c act 2's ordered find/replace pairs. */
export const FIND_TAG = 'amend-find';
export const REPLACE_TAG = 'amend-replace';

/** Amendment drafts are marked by this suffix — `destinationFor()` returns null for it. */
export const AMENDMENT_DRAFT_SUFFIX = '.draft.md';

/** A target under brain/project/decisions/ takes the ADR shape (one extra act). */
export const ADR_TARGET_RE = /^brain\/project\/decisions\/adr-(\d{4})-[a-z0-9][a-z0-9-]*\.md$/;

const KNOWN_KEYS = Object.freeze(['target', 'amendment', 'issue', 'home-summary', 'body', 'body-end']);

const err = (error) => ({ ok: false, error });

/**
 * Parses the `key: value` scalars inside a contract block. An unknown key is a
 * hard error — a draft that says one thing and promotes another is worse.
 *
 * @param {string} content
 * @returns {{ok:true, fields:object}|{ok:false, error:string}}
 */
export function parseContractFields(content) {
  const fields = {};
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = line.match(/^([a-z][a-z-]*):\s?(.*)$/);
    if (!m) return err(`contract line is not \`key: value\`:\n  ${line}`);
    const [, key, value] = m;
    if (!KNOWN_KEYS.includes(key)) {
      return err(`unknown contract key '${key}'. Known keys: ${KNOWN_KEYS.join(', ')}.`);
    }
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      return err(`contract key '${key}' appears more than once.`);
    }
    fields[key] = value;
  }
  return { ok: true, fields };
}

/**
 * Reads the amendment contract and the §1c act-2 edit pairs out of a draft.
 *
 * @param {string} draftText
 * @returns {{ok:true, contract:object, edits:{find:string,replace:string}[]}
 *          |{ok:false, error:string, absent?:true}}
 */
export function parseAmendmentDraft(draftText) {
  const { blocks, unterminated } = fencedBlocks(draftText);
  if (unterminated) {
    return err(
      `the fenced block opened at draft line ${unterminated.line}` +
        `${unterminated.tag ? ` (\`${unterminated.tag}\`)` : ''} is never closed.\n` +
        '  Everything after it reads as block content, so the contract cannot be parsed.',
    );
  }
  const contracts = blocks.filter((b) => b.tag === CONTRACT_TAG);
  if (contracts.length === 0) {
    return { ok: false, absent: true, error: `no \`${CONTRACT_TAG}\` block found` };
  }
  if (contracts.length > 1) {
    return err(`${contracts.length} \`${CONTRACT_TAG}\` blocks found — a draft declares exactly one target.`);
  }

  const parsed = parseContractFields(contracts[0].content);
  if (!parsed.ok) return parsed;
  const f = parsed.fields;

  if (!f.target) return err('contract is missing the required `target:` key.');
  const target = f.target.trim();
  if (!target.startsWith('brain/') || !target.endsWith('.md') || target.includes('..')) {
    return err(
      `target '${target}' is not a brain/** Markdown path.\n` +
        '  This verb amends signed artefacts under brain/ and nothing else.',
    );
  }

  const adrMatch = target.match(ADR_TARGET_RE);
  const isAdr = Boolean(adrMatch);

  let amendment = null;
  if (f.amendment !== undefined) {
    if (!/^[1-9][0-9]*$/.test(f.amendment.trim())) {
      return err(`\`amendment:\` must be a positive integer, got '${f.amendment}'.`);
    }
    amendment = Number(f.amendment.trim());
  }

  const homeSummary = f['home-summary'] === undefined ? null : f['home-summary'].trim();

  if (isAdr) {
    if (amendment === null) return err('an ADR target requires `amendment: N` (§1c act 1 numbers the amendment).');
    if (!homeSummary) {
      return err(
        'an ADR target requires `home-summary: <one line>` — the brain/HOME.md index marker\n' +
          '  is §1c\'s fourth act, and it is the act with no gate behind it (#516).',
      );
    }
    if (!f.body) {
      return err('an ADR target requires `body: ## Amendment N — …` (§1c act 3 appends a signed section).');
    }
  } else {
    if (amendment !== null) {
      return err(`\`amendment:\` applies to ADR targets only — '${target}' has no Status line to number.`);
    }
    if (homeSummary !== null) {
      return err(`\`home-summary:\` applies to ADR targets only — brain/HOME.md indexes decisions, not '${target}'.`);
    }
  }

  const edits = [];
  const pairBlocks = blocks.filter((b) => b.tag === FIND_TAG || b.tag === REPLACE_TAG);
  for (let i = 0; i < pairBlocks.length; i += 2) {
    const find = pairBlocks[i];
    const replace = pairBlocks[i + 1];
    if (find.tag !== FIND_TAG) {
      return err(`\`${REPLACE_TAG}\` block at draft line ${find.line} has no \`${FIND_TAG}\` before it.`);
    }
    if (!replace || replace.tag !== REPLACE_TAG) {
      return err(`\`${FIND_TAG}\` block at draft line ${find.line} has no \`${REPLACE_TAG}\` after it.`);
    }
    if (find.content === '') return err(`the \`${FIND_TAG}\` block at draft line ${find.line} is empty.`);
    edits.push({ find: find.content, replace: replace.content });
  }

  if (isAdr && edits.length === 0) {
    return err(
      'an ADR amendment declares at least one `amend-find`/`amend-replace` pair.\n' +
        '  §1c act 2: every line the amendment supersedes is rewritten or annotated in place —\n' +
        '  "a reader who never scrolls to the amendment must not be left with the superseded rule".',
    );
  }
  if (edits.length === 0 && !f.body) {
    return err('the contract declares no edits and no `body:` — there is nothing to promote.');
  }

  return {
    ok: true,
    contract: {
      target,
      isAdr,
      adrNumber: isAdr ? adrMatch[1] : null,
      slug: isAdr ? target.slice(target.lastIndexOf('/') + 1, -3) : null,
      amendment,
      issue: f.issue === undefined ? null : f.issue.trim().replace(/^#/, ''),
      homeSummary,
      bodyHeading: f.body === undefined ? null : f.body.trim(),
      bodyEndHeading: f['body-end'] === undefined ? null : f['body-end'].trim(),
    },
    edits,
  };
}

/**
 * Formats an ISO `YYYY-MM-DD` as the DD/MM/YYYY the §1c stamps use.
 * @param {string} iso
 * @returns {string}
 */
export function formatStampDate(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(iso);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Counts occurrences of `needle`, INCLUDING self-overlapping ones.
 *
 * `String.split` counts non-overlapping matches, which made the uniqueness gate
 * a lie: `'|---|---|'.split('|---|')` reports one occurrence of `|---|` while
 * the string contains two, sharing a character. A Markdown table separator row
 * is a plausible anchor, so "found exactly once" has to mean "there is exactly
 * one place this text sits", not "one place a left-to-right consuming scan
 * happened to stop".
 *
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
export function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n += 1;
  return n;
}

/**
 * Replaces the line at `index` without touching any other byte.
 *
 * Deliberately NOT split-then-join: the target's EOLs are whatever they are,
 * and a whole-file rejoin rewrites every line to one detected style. One stray
 * CRLF in an LF file used to turn a one-line amendment into a whole-file
 * rewrite that the plan never mentioned, staged under a human signature.
 *
 * @param {string} text
 * @param {number} index  0-based line index (lines split on \n, \r kept as content).
 * @param {string} replacement
 * @returns {string}
 */
export function spliceLine(text, index, replacement) {
  let start = 0;
  for (let i = 0; i < index; i++) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) return text;
    start = nl + 1;
  }
  const nl = text.indexOf('\n', start);
  const endOfLine = nl === -1 ? text.length : nl;
  // A CR immediately before the newline belongs to the line ending, not the line.
  const contentEnd = endOfLine > start && text[endOfLine - 1] === '\r' ? endOfLine - 1 : endOfLine;
  return text.slice(0, start) + replacement + text.slice(contentEnd);
}

/** Line index of every line for which `predicate` holds. CR-tolerant. */
function lineIndices(text, predicate) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (predicate(lines[i].replace(/\r$/, ''))) out.push(i);
  }
  return out;
}

/**
 * §1c act 1 — rewrites the Status line, and VERIFIES the amendment number: the
 * count is read off the target, so a draft claiming Amendment 5 on an ADR
 * standing at 2 is refused instead of leaving a gap in the record.
 *
 * `previous === amendment` is NOT an error — it is act 1 already applied, which
 * the cascade assessment reads as `done`.
 *
 * @param {string} line   The target's current `**Status**:` line, verbatim.
 * @param {{amendment:number, date:string}} ctx
 * @returns {{ok:true, text:string, previous:number, state:'pending'|'done'}|{ok:false, error:string}}
 */
export function amendStatusLine(line, { amendment, date }) {
  const trailing = line.match(/[ \t]*$/)[0];
  const core = line.trimEnd();
  const m = core.match(/^\*\*Status\*\*:\s*(.+)$/);
  if (!m) return err(`not a Status line: ${line}`);

  const [statusWord, ...markerParts] = m[1].split(' · ');
  let previous = 0;
  if (markerParts.length > 0) {
    const marker = markerParts.join(' · ');
    const mm = marker.match(
      /^\*\*amended\s+\S+\*\*\s+\(Amendments?\s+(?:1\s*[-–]\s*)?(\d+)\s*[—–-]\s*see below\)$/,
    );
    if (!mm) {
      return err(
        `the Status line carries an amendment marker this verb does not recognise:\n  ${marker}\n` +
          '  Expected `**amended DD/MM/YYYY** (Amendment N — see below)`.',
      );
    }
    previous = Number(mm[1]);
  }

  if (previous !== amendment && previous !== amendment - 1) {
    return err(
      `the draft declares Amendment ${amendment}, but ${
        previous === 0 ? 'the target carries no amendment yet' : `the target stands at Amendment ${previous}`
      } — expected ${amendment - 1} (to apply) or ${amendment} (already applied).`,
    );
  }

  const label = amendment === 1 ? 'Amendment 1' : `Amendments 1-${amendment}`;
  return {
    ok: true,
    previous,
    state: previous === amendment ? 'done' : 'pending',
    text: `**Status**: ${statusWord.trim()} · **amended ${date}** (${label} — see below)${trailing}`,
  };
}

/**
 * §1c act 1's invariant, on its own: a signed artefact carries **exactly one**
 * `**Status**:` line.
 *
 * Extracted from `applyStatusAct` as a pure move (#675) rather than copied.
 * `brain-promote`'s ADR path needs the same question answered about the file it
 * is ABOUT TO WRITE, and it had no answer at all: it produced a signed ADR with
 * two Status lines, staged it, and printed a commit command. The amendment path
 * then refused to touch the result — the two halves of one verb disagreeing
 * about whether that artefact may exist. A second implementation of this rule
 * would be the #130/#340/#555 shape inside a single verb, so `brain-promote`
 * calls THIS function rather than re-deriving it.
 *
 * `indices` is returned on the failure branch as well as the count. A refusal
 * that says only "2, expected 1" makes the reader search a signed document for
 * the second one — and the two paths into this state put it in different places
 * (a draft preamble the header rewrite kept, or a body line that happens to
 * start with the marker). Naming WHERE is what lets one caller diagnose both.
 *
 * @param {string} text
 * @returns {{ok:true, index:number}|{ok:false, count:number, indices:number[], error:string}}
 */
export function checkSingleStatusLine(text) {
  const idx = lineIndices(text, (l) => l.startsWith('**Status**:'));
  if (idx.length === 1) return { ok: true, index: idx[0] };
  return {
    ok: false,
    count: idx.length,
    indices: idx,
    error: `${idx.length} \`**Status**:\` line(s), expected exactly 1 (§1c act 1).`,
  };
}

/**
 * Locates and rewrites the single `**Status**:` line. Refuses on ≠ 1 matches —
 * the same anchor discipline the edits use.
 *
 * @param {string} targetText
 * @param {{amendment:number, date:string}} ctx
 * @returns {{ok:true, text:string, before:string, after:string, state:string}|{ok:false, error:string}}
 */
export function applyStatusAct(targetText, ctx) {
  const single = checkSingleStatusLine(targetText);
  if (!single.ok) return err(`the target has ${single.error}`);
  const idx = [single.index];
  const before = targetText.split('\n')[idx[0]].replace(/\r$/, '');
  const rewritten = amendStatusLine(before, ctx);
  if (!rewritten.ok) return rewritten;
  return {
    ok: true,
    state: rewritten.state,
    text: rewritten.state === 'done' ? targetText : spliceLine(targetText, idx[0], rewritten.text),
    before,
    after: rewritten.text,
  };
}

/**
 * §1c act 2 — is this edit applied, applicable, or neither?
 *
 * The naive key (`text.includes(replace)`) is wrong in both directions, and both
 * were reproduced against real doctrine files:
 *
 *   - a replacement that legitimately appears elsewhere in the document made a
 *     GENUINE first promotion report "already done" and leave the superseded
 *     passage standing — the exact harm §1c act 2 exists to prevent;
 *   - an anchor that is a PREFIX of its own replacement (`## Lockout Recovery`
 *     → `## Lockout Recovery (amended …)`) still occurs once after the edit
 *     lands, so an anchor-count key alone double-applies and stacks it.
 *
 * The key that is right in both directions counts FREE anchors, rather than
 * testing presence. Let f = occurrences of `find` in the text, r = occurrences
 * of `replace`, and k = occurrences of `find` INSIDE `replace`. Then r × k of
 * those anchors are accounted for — they are the ones sitting inside an already
 * applied replacement — and the rest are free:
 *
 *   free    = f − r × k
 *   done    ⇔ r ≥ 1 and free === 0    (every anchor is inside a replacement)
 *   pending ⇔ free === 1              (exactly one anchor left to edit)
 *   blocked ⇔ anything else           (drifted, or more than one free anchor)
 *
 * One tie is worth naming because counting cannot break it: a document holding
 * one applied replacement and one free anchor is arithmetically identical to a
 * never-amended document that happens to quote the replacement elsewhere. The
 * tie resolves to `pending`, because the alternative is BLOCKER 2 — refusing a
 * genuine first application and leaving the superseded passage standing, which
 * is the harm §1c act 2 exists to prevent. The human still reads the
 * before/after in the plan before typing the word.
 *
 * @param {string} text
 * @param {{find:string, replace:string}} edit
 * @returns {{state:'done'|'pending'|'blocked', f:number, r:number, k:number, free:number}}
 */
export function assessEdit(text, { find, replace }) {
  const f = countOccurrences(text, find);
  const r = countOccurrences(text, replace);
  const k = countOccurrences(replace, find);
  const free = f - r * k;
  if (r >= 1 && free === 0) return { state: 'done', f, r, k, free };
  if (free === 1) return { state: 'pending', f, r, k, free };
  return { state: 'blocked', f, r, k, free };
}

/**
 * §1c act 2 — applies the declared edits in order. Every edit must be `pending`
 * at the moment it is applied; anything else refuses, rather than editing
 * something adjacent.
 *
 * @param {string} text
 * @param {{find:string, replace:string}[]} edits
 * @returns {{ok:true, text:string}|{ok:false, error:string}}
 */
export function applyEdits(text, edits) {
  let out = text;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const { state, f, r, k } = assessEdit(out, edit);
    if (state !== 'pending') {
      return err(
        `edit ${i + 1}: refusing — its \`${FIND_TAG}\` anchor occurs ${f} time(s) in the target, ` +
          `its \`${REPLACE_TAG}\` text ${r} time(s)${k > 0 ? ` (the anchor occurs ${k} time(s) inside it)` : ''}.\n` +
          `  Expected exactly one free anchor. ${
            state === 'done' ? 'This edit looks ALREADY APPLIED.' : 'The file moved under the draft.'
          }\n` +
          '  Re-anchor the draft; this verb will not edit something adjacent.\n' +
          '  ───\n' +
          find_block(edit.find) +
          '\n  ───',
      );
    }
    out = out.replace(edit.find, () => edit.replace);
  }
  return { ok: true, text: out };
}

const find_block = (find) =>
  find
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n');


/**
 * Extracts the signed section from the draft: the `body:` heading line through
 * the `body-end:` heading (exclusive) or the end of the draft.
 *
 * @param {string} draftText
 * @param {{bodyHeading:string, bodyEndHeading:string|null}} ctx
 * @returns {{ok:true, text:string}|{ok:false, error:string}}
 */
export function extractBody(draftText, { bodyHeading, bodyEndHeading }) {
  const lines = draftText.split(/\r?\n/);
  const at = (needle) => lines.reduce((acc, l, i) => (l.trimEnd() === needle ? [...acc, i] : acc), []);

  const starts = at(bodyHeading);
  if (starts.length !== 1) {
    return err(`the \`body:\` heading occurs ${starts.length} times in the draft, expected exactly 1:\n  ${bodyHeading}`);
  }
  let end = lines.length;
  if (bodyEndHeading) {
    const ends = at(bodyEndHeading);
    if (ends.length !== 1) {
      return err(
        `the \`body-end:\` heading occurs ${ends.length} times in the draft, expected exactly 1:\n  ${bodyEndHeading}`,
      );
    }
    if (ends[0] <= starts[0]) return err('`body-end:` must come after `body:` in the draft.');
    end = ends[0];
  }

  const body = lines.slice(starts[0], end);
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  return { ok: true, text: `${body.join('\n')}\n` };
}

/**
 * §1c act 3 — stamps the section's `**Signed**:` line. The draft's placeholder
 * is never trusted: the verb writes this line.
 *
 * @param {string} body
 * @param {{date:string, gitUserName:string, required:boolean}} ctx
 * @returns {{ok:true, text:string}|{ok:false, error:string}}
 */
export function stampSigned(body, { date, gitUserName, required }) {
  const lines = body.split('\n');
  const idx = lines.reduce((acc, l, i) => (l.startsWith('**Signed**:') ? [...acc, i] : acc), []);
  if (idx.length === 0) {
    if (!required) return { ok: true, text: body };
    return err(
      'the signed section has no `**Signed**:` line.\n' +
        '  §1c act 3: the appended section opens with `**Signed**: DD/MM/YYYY — <Name>`.',
    );
  }
  if (idx.length > 1) return err(`the signed section has ${idx.length} \`**Signed**:\` lines, expected 1.`);
  lines[idx[0]] = `**Signed**: ${date} — ${gitUserName}`;
  return { ok: true, text: lines.join('\n') };
}

/**
 * Appends the signed section to the target, separated by one blank line —
 * the shape `be2d143` (ADR-0026 Amendment 2) produced by hand.
 *
 * @param {string} targetText
 * @param {string} body
 * @returns {string}
 */
export function appendSection(targetText, body) {
  const base = targetText.endsWith('\n') ? targetText : `${targetText}\n`;
  return `${base}\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

/**
 * §1c's fourth act — the brain/HOME.md index marker. The verb owns the FORMAT
 * (`**Amendment N, DD/MM/YYYY** — <summary>`); the draft supplies the summary.
 * Nothing else enforces this step (#516), so performing it IS the net.
 *
 * @param {string} homeText
 * @param {{slug:string, amendment:number, date:string, summary:string}} ctx
 * @returns {{ok:true, text:string, before:string, after:string}
 *          |{ok:false, error:string, alreadyPresent?:true}}
 */
export function amendHomeLine(homeText, { slug, amendment, date, summary }) {
  const needle = `](project/decisions/${slug}.md)`;
  const idx = lineIndices(homeText, (l) => l.includes(needle));
  if (idx.length !== 1) {
    return err(
      `brain/HOME.md has ${idx.length} index lines for ${slug}, expected exactly 1 (§1b).\n` +
        '  Fix the index by hand first — an ambiguous index is not something a tool should guess at.',
    );
  }

  const before = homeText.split('\n')[idx[0]].replace(/\r$/, '');
  // Already carrying this amendment's marker is act 4 DONE, not an error — the
  // cascade assessment decides what that means for the run as a whole.
  if (before.includes(`**Amendment ${amendment},`)) {
    return { ok: true, state: 'done', text: homeText, before, after: before };
  }

  const marker = `**Amendment ${amendment}, ${date}** — ${summary}`;
  const trailing = before.match(/[ \t]*$/)[0];
  const core = before.trimEnd();
  const after = core.endsWith(')')
    ? `${core.slice(0, -1)}; ${marker})${trailing}`
    : `${core} (${marker})${trailing}`;

  return { ok: true, state: 'pending', text: spliceLine(homeText, idx[0], after), before, after };
}

/**
 * Derives the commit-message subject the human runs. Conventional Commits plus
 * a `#N` reference — both required by the commit-msg hook.
 *
 * @param {{contract:object, bodyHeading:string|null}} ctx
 * @returns {string}
 */
export function amendmentCommitSubject({ contract, bodyHeading }) {
  const ref = contract.issue ? `#${contract.issue}` : '#<issue-number>';
  if (contract.isAdr) {
    const title = String(bodyHeading ?? '')
      .replace(/^#+\s*/, '')
      .replace(/^Amendment\s+\d+\s*[—–-]\s*/, '')
      .replace(/\s*\(issue\s*#\d+\)\s*$/, '')
      .trim();
    const head = `ADR-${contract.adrNumber} Amendment ${contract.amendment}`;
    return `docs(brain): ${title ? `${head} — ${title}` : head} (${ref})`;
  }
  return `docs(brain): amend ${contract.target} (${ref})`;
}

/**
 * Reads the state of every §1c act WITHOUT changing anything.
 *
 * The cascade is one unit. Deciding "already promoted" from any single act is
 * how a run reported success with the rest of the cascade undone: pasting the
 * signed section by hand — which is how all three cited precedents were
 * actually done — set act 3 and left acts 1, 2 and 4 unwritten, `brain/HOME.md`
 * marker included, the one act with no gate behind it (#516).
 *
 * `promote-516.sh` keyed on the LAST act (`grep -qF "Amendment 4, …" HOME.md`).
 * Keying on any single act is a guess about the others; reading them all is not.
 *
 * @param {object} ctx
 * @returns {{ok:true, acts:object[]}|{ok:false, error:string}}
 */
export function assessCascade({ contract, edits, targetText, homeText, date }) {
  const acts = [];

  if (contract.isAdr) {
    const status = applyStatusAct(targetText, { amendment: contract.amendment, date });
    if (!status.ok) return status;
    acts.push({ act: '1', what: 'Status line', state: status.state, before: status.before, after: status.after });
  }

  for (let i = 0; i < edits.length; i++) {
    const { state, f, r, k } = assessEdit(targetText, edits[i]);
    acts.push({
      act: '2',
      what: `in-place edit ${i + 1}`,
      state,
      before: edits[i].find,
      after: edits[i].replace,
      counts: { f, r, k },
    });
  }

  if (contract.bodyHeading) {
    const present = countOccurrences(targetText, `\n${contract.bodyHeading}`) > 0;
    acts.push({
      act: '3',
      what: 'appended signed section',
      state: present ? 'done' : 'pending',
      before: null,
      after: contract.bodyHeading,
    });
  }

  if (contract.isAdr) {
    if (typeof homeText !== 'string') return err('brain/HOME.md could not be read — the ADR shape needs it (§1b).');
    const home = amendHomeLine(homeText, {
      slug: contract.slug,
      amendment: contract.amendment,
      date,
      summary: contract.homeSummary,
    });
    if (!home.ok) return home;
    acts.push({ act: '4', what: 'brain/HOME.md marker', state: home.state, before: home.before, after: home.after });
  }

  return { ok: true, acts };
}

/** Renders the per-act state table used in a partial-cascade refusal. */
function actTable(acts) {
  return acts
    .map((a) => `    act ${a.act} — ${a.what}: ${a.state.toUpperCase()}`)
    .join('\n');
}

/**
 * The whole amendment as ONE pure value: the plan shown and the plan applied
 * are the same object, never two code paths.
 *
 * Three dispositions, and no fourth:
 *   - every act pending  → `plan`, the full cascade;
 *   - every act done     → `cascadeComplete` (the caller still checks whether
 *                          `AGENTS.md` is current — §1d act 3 is part of the
 *                          cascade, so "done" is not "done" without it);
 *   - anything mixed     → REFUSE, naming each act's state. All-or-nothing is
 *                          the whole point: a partial state is exactly what
 *                          this verb exists to stop a human from producing, so
 *                          it will not produce one and will not paper over one.
 *
 * @param {object} ctx
 * @param {string} ctx.draftText
 * @param {string} ctx.targetText   The signed artefact as it stands today.
 * @param {string|null} ctx.homeText  brain/HOME.md — required for the ADR shape.
 * @param {string} ctx.gitUserName
 * @param {string} ctx.today        ISO `YYYY-MM-DD`.
 * @param {string|null} [ctx.issueFallback]  Used when the contract omits `issue:`.
 * @returns {{ok:true, plan:object}|{ok:true, cascadeComplete:true, contract:object, acts:object[]}
 *          |{ok:false, error:string, partial?:true}}
 */
export function planAmendment({ draftText, targetText, homeText, gitUserName, today, issueFallback = null }) {
  const parsed = parseAmendmentDraft(draftText);
  if (!parsed.ok) return parsed;
  const { edits } = parsed;
  const contract = { ...parsed.contract, issue: parsed.contract.issue ?? issueFallback };
  const date = formatStampDate(today);

  const assessed = assessCascade({ contract, edits, targetText, homeText, date });
  if (!assessed.ok) return assessed;
  const { acts } = assessed;

  const blocked = acts.filter((a) => a.state === 'blocked');
  if (blocked.length > 0) {
    const first = blocked[0];
    return err(
      `act ${first.act} (${first.what}) cannot be assessed: ` +
        `its anchor occurs ${first.counts.f} time(s) and its replacement ${first.counts.r} time(s).\n` +
        '  Expected exactly one free anchor, or a cleanly applied edit. The file moved under\n' +
        '  the draft — re-anchor it; this verb will not edit something adjacent.\n' +
        `${actTable(acts)}`,
    );
  }

  const done = acts.filter((a) => a.state === 'done');
  const pending = acts.filter((a) => a.state === 'pending');

  if (done.length > 0 && pending.length > 0) {
    return {
      ok: false,
      partial: true,
      error:
        `${contract.target} is PARTIALLY amended — ${done.length} of ${acts.length} acts are already applied.\n` +
        `${actTable(acts)}\n` +
        '  §1c is three acts in ONE commit, so this verb applies the whole cascade or none of it.\n' +
        '  Revert the applied acts (`git checkout -- <path>`) and re-run, or finish by hand —\n' +
        '  but do not leave the index describing a different version than the ADR.',
    };
  }

  if (pending.length === 0) {
    return { ok: true, cascadeComplete: true, contract, acts };
  }

  // ── Every act is pending: build the texts ─────────────────────────────────
  let text = targetText;

  if (contract.isAdr) {
    const status = applyStatusAct(text, { amendment: contract.amendment, date });
    if (!status.ok) return status;
    text = status.text;
  }

  const edited = applyEdits(text, edits);
  if (!edited.ok) return edited;
  text = edited.text;

  let body = null;
  if (contract.bodyHeading) {
    const extracted = extractBody(draftText, contract);
    if (!extracted.ok) return extracted;
    const signed = stampSigned(extracted.text, { date, gitUserName, required: contract.isAdr });
    if (!signed.ok) return signed;
    body = signed.text;
    text = appendSection(text, body);
  }

  let newHomeText = null;
  if (contract.isAdr) {
    const home = amendHomeLine(homeText, {
      slug: contract.slug,
      amendment: contract.amendment,
      date,
      summary: contract.homeSummary,
    });
    if (!home.ok) return home;
    newHomeText = home.text;
  }

  return {
    ok: true,
    plan: {
      contract,
      date,
      acts,
      body,
      targetText: text,
      homeText: newHomeText,
      commitSubject: amendmentCommitSubject({ contract, bodyHeading: contract.bodyHeading }),
    },
  };
}
