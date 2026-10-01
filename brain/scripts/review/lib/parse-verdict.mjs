// parse-verdict.mjs — parses a `brain-review/1` fenced-YAML block out of a
// review body (protocol §6). Purpose-built for this ONE fixed schema — not a
// generic YAML parser (zero npm deps). Extracts only the scalars H1-1 needs
// (rev derivation + doctrine load); nested findings/gates land with H1-5's
// board. Shared by cold-boot, the anti-loop lock (H1-2), and the board
// (H1-5) — extracted once so they read the same parser (design.md §2).
//
// The low-level fence/scalar primitives (`extractFencedBlock`, `scalar`,
// `decodeYamlEscapes`, `unyamlScalar`, `parseJsonScalar`) live in
// `yaml-block.mjs` (issue #473, design.md §B1) — shared with
// `decision-block.mjs`'s `brain-decision/1` reader, since both protocols ride
// the same fenced-YAML carrier. This module still owns everything specific to
// the `brain-review/N` schema: the two-protocol allowlist below, and the
// findings/follow_ups list machinery (kept private — see yaml-block.mjs's own
// header comment for why it did not move too).

import { extractFencedBlock, scalar, unyamlScalar, parseJsonScalar } from './yaml-block.mjs';
import { CONTROL_CLASSES } from './controls.mjs';

// Matches the two line shapes renderVerdict emits inside a findings /
// follow_ups list: `  - key: value` opens an entry, `    key: value` extends
// the entry above it. Anchored to the exact indentation the renderer uses —
// this parser is the inverse of ONE fixed emitter, not a general YAML reader.
const ENTRY_OPEN_RE = /^ {2}- ([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/;
const ENTRY_CONT_RE = /^ {4}([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.*)$/;
// The only lines that legitimately END a list: THIS PROTOCOL's own top-level
// keys, at zero indentation — what renderVerdict emits after a list.
//
// Naming them is load-bearing (third cold review of PR #478). A generic
// `/^[A-Za-z_][A-Za-z0-9_]*:/` accepted ANY `word:` at column 0, so unreadable
// content whose first line merely LOOKED like a key was read as a clean end and
// the truncated prefix came back as a confident, complete list — the same
// defect the "unreadable → null at any entry count" rule was written to close,
// surviving in its own predicate. The falsifying shape is the likeliest one in
// production, not a corner case: `brain-governance-status`'s stdout, which
// checkpoint.mjs interpolates into `evidence:`, contains lines like `Tier: 2`.
//
// Kept in sync with verdict.mjs by a drift test that renders a fully-populated
// verdict and asserts every column-0 key it emits is accepted here.
const TOP_LEVEL_KEYS = [
  'protocol', 'verdict', 'head_sha', 'rev', 'gates',
  'findings', 'follow_ups', 'conditions', 'controls', 'controls_not_applied',
  'pin', 'sequencing', 'escalate',
  // #682 REQ-682-3. Added WITH its reader below, not ahead of it: a key that
  // terminates a list but is never assigned would stop corrupting the findings
  // list and still be invisible to every consumer — half a fix that reads as a
  // whole one.
  'challenger_axis',
];
const TOP_LEVEL_KEY_RE = new RegExp(`^(?:${TOP_LEVEL_KEYS.join('|')}):`);

/**
 * The key was PRESENT and its value could not be read (issue #477).
 *
 * `null` already means "the key is absent". Before this sentinel it ALSO meant
 * "the key is here and unreadable", and `parseVerdict`'s `!== null` guard erased
 * the difference by dropping the field either way — so a corrupt findings list
 * and a block that never mentioned findings produced the same object, and a
 * consumer counting findings read the corrupt one as zero. That is
 * `evidence-reader-empty-on-failure` in the reader that feeds §10's evaluators,
 * and it fails in the reassuring direction: unreadable reads as clean.
 *
 * A module-private `Symbol` rather than a `null`/`undefined`/`{}` marker because
 * it must be impossible for a PARSED value to collide with it: every other answer
 * this function returns comes from `JSON.parse` or an object literal built here,
 * and neither can produce this symbol. It never leaves this module — `parseVerdict`
 * translates it into `result.malformed`, a plain array of field names.
 *
 * Maintainer ruling on #477 (2026-08-12) chose this shape (the ticket's option 3)
 * over `parseVerdict` returning `null` for the whole block (option 2), which
 * `cold-boot`/`board`'s `.filter(Boolean)` would have turned into a silently
 * vanished verdict — the same silence one layer up, with nothing left to inspect.
 */
const UNREADABLE = Symbol('brain-review: field present but unreadable');

// "Did the block mention `sequencing` at all?" — asked separately from "could I
// read it", because those are the two states #477 exists to keep apart and
// `scalar()` collapses them (it answers `null` for both a missing key and a key
// whose inline value it could not capture).
const SEQUENCING_KEY_RE = /^sequencing:/m;
const CONTROLS_KEY_RE = /^controls:/m;
const CONTROLS_NOT_APPLIED_KEY_RE = /^controls_not_applied:/m;

/**
 * Parses a findings-shaped key in EITHER encoding (issue #381):
 *   - same-line  — `findings: []`, and any JSON-scalar form, via parseJsonScalar
 *   - list       — the multi-line `- id:` / `severity:` block renderVerdict
 *                  actually emits for a non-empty array
 *
 * Before #381 only the same-line form was read, so every non-empty findings
 * array the renderer produced was silently dropped on re-parse — the empty
 * case (`findings: []`) round-tripped, which is why the defect stayed hidden.
 *
 * States and answers on the LIST encoding (issue #452; the UNREADABLE row and
 * then its "at any entry count" qualifier were each added by a cold-review
 * round on PR #478 — the drafts conflated them with the rows above):
 *
 *   key absent                            → `null`
 *   key present, scan ended cleanly:
 *      nothing parsed                     → `[]`     genuinely empty
 *      entries parsed                     → the entries
 *   key present, scan stopped on content
 *   it could not read — AT ANY ENTRY
 *   COUNT                                 → `null`   uncomputable, never `[]`
 *                                                    and never a truncated prefix
 *
 * "Unreadable" is real and common, and not only for foreign input:
 *   - these entry regexes are anchored to the exact indentation ONE emitter
 *     produces, so a verdict written in 0-indent YAML block sequence — what
 *     `yaml.dump` emits by default — carries findings this parser cannot read;
 *   - `renderVerdict` quotes but does not ESCAPE newlines, so brain's own
 *     multi-line `evidence:` (checkpoint.mjs interpolates command stdout) emits
 *     a block no parser can read. Measured: a two-finding verdict re-parsed to
 *     ONE finding, silently dropping a blocker. The renderer defect is its own
 *     ticket; what this function owes is to refuse the partial read rather than
 *     present it as the whole set.
 *
 * The INLINE encoding answers the same three states, as of #477:
 *
 *   key absent                            → `null`
 *   key present, value parses to an array → the array (`[]` when empty)
 *   key present, value does not           → `UNREADABLE`
 *
 * "Does not" covers both halves of the same defect: a value `parseJsonScalar`
 * could not read at all (truncated JSON, a bad hand-edit — it answers `null`,
 * which used to be returned verbatim and dropped), and a value that parses but
 * is not a list (`findings: 3`, `findings: null`). The second half was assigned
 * verbatim before, so `result.findings` could be a number that every consumer
 * treats as an array — `board.mjs`'s `for (… of latestVerdict.sequencing ?? [])`
 * reached `for … of 3` and threw, taking down the whole board run.
 *
 * Until #452 the last line collapsed the middle state into `null`, so
 * `parseVerdict`'s `!== null` guard dropped the field and a consumer could not
 * tell "the block said nothing about this" from "the block said: nothing" —
 * `evidence-reader-empty-on-failure` in the parser, and the third appearance
 * of the #381 class in this pair of functions.
 *
 * @returns {Array<object>|null|symbol} the entries when readable, `null` when
 *   the key is ABSENT, and `UNREADABLE` when the key is present and its value
 *   could not be read — in EITHER encoding (#477). The `null` overload that
 *   also meant "unreadable" is gone; the never-throws guarantee it was
 *   protecting is not — this function still cannot raise, and the contract of
 *   the two surviving answers is unchanged.
 */
function parseEntryList(block, key) {
  const inline = scalar(block, key);
  if (inline !== null) {
    const parsed = parseJsonScalar(inline);
    // A list field has no scalar reading. `parseJsonScalar` answers `null` both
    // for an unreadable value and for the literal `null`; neither is a list, and
    // neither may be handed on as one.
    return Array.isArray(parsed) ? parsed : UNREADABLE;
  }

  const lines = block.split('\n');
  const start = lines.findIndex(l => l.trimEnd() === `${key}:`);
  if (start === -1) return null;

  const entries = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const open = lines[i].match(ENTRY_OPEN_RE);
    if (open) {
      entries.push({ [open[1]]: unyamlScalar(open[2]) });
      continue;
    }
    const cont = lines[i].match(ENTRY_CONT_RE);
    if (cont && entries.length > 0) {
      entries[entries.length - 1][cont[1]] = unyamlScalar(cont[2]);
      continue;
    }
    break; // a line this parser does not recognise as list content
  }
  // The `start === -1` early return established that the key's line WAS found,
  // so how the scan ENDED is what separates the remaining answers, and the
  // anti-pattern doctrine requires them to differ:
  //
  //   evidence-reader-empty-on-failure.md — "null = uncomputable (the fetch
  //   failed), [] / '' = genuinely empty."
  //
  // The scan ended CLEANLY if only blank lines remain before the next top-level
  // key or the end of the block. Otherwise there was a body here that these two
  // indentation-anchored regexes could not read — a foreign 0-indent YAML
  // sequence, a tab, a quoted entry key, or a multi-line scalar the renderer
  // emitted unescaped.
  //
  // This test is applied REGARDLESS of how many entries parsed (second cold
  // review of PR #478). A first correction ran it only when nothing parsed, so
  // a list that read one entry and then hit unreadable content returned the
  // truncated prefix as a confident, complete list — the same inversion one
  // branch further up, and reachable from brain's OWN renderer: a two-finding
  // verdict with multi-line `evidence:` re-parsed to ONE finding, silently
  // dropping a blocker, with `'findings' in result === true`.
  //
  //   unreadable (any entry count) → UNREADABLE — uncomputable, never a prefix
  //   clean end, nothing parsed    → `[]`       — genuinely empty
  //   clean end, entries parsed    → the entries
  //
  // #452 answered `null` on the first row, which the `start === -1` line above
  // had already spent on "the key is absent". Both dropped the field, so the
  // 0-indent foreign list this row exists to catch still reached the consumer as
  // a block that never mentioned findings (#477). Same rule, distinct answer.
  while (i < lines.length && lines[i].trim() === '') i++;
  const endedCleanly = i >= lines.length || TOP_LEVEL_KEY_RE.test(lines[i]);
  if (!endedCleanly) return UNREADABLE;
  return entries;
}

/**
 * @returns {{ head_sha: string, rev: number|null, verdict: string, author: string|null,
 *   sequencing?: *, findings?: Array<object>, follow_ups?: Array<object>,
 *   malformed?: string[] } | null}
 *
 * `malformed` (#477) lists, in read order, every field the block CARRIED and
 * this parser could not read. It is present only when non-empty, so a readable
 * verdict — including one brain's own renderer produced — round-trips with the
 * exact key set it had before. An unreadable field is still omitted from the
 * result: the ruling chose visibility WITHOUT a control-flow change, so a
 * consumer that ignores `malformed` behaves exactly as it did.
 *
 * A consumer counting findings must read `malformed` and refuse to call the
 * verdict clean. Doctrine already requires the equivalent one layer up —
 * `reviewer-protocol.md` §6.1, "'no findings' and 'findings discarded' must
 * never look identical to the reader" (#483) — and §10 forbids concluding on
 * uncomputable evidence.
 *
 * The consumers HAVE adopted it (#477's second half, same change): `board.mjs`
 * treats `seq:*` as uncomputable rather than empty when `sequencing` is
 * unreadable, and `cold-boot.mjs` names the affected prior verdicts in
 * `doctrine.unreadableVerdicts`, which `cli.mjs` reports on both the board and
 * the reviewer run. A future consumer that ignores `malformed` reintroduces the
 * defect on its own path — this field is the evidence, not the enforcement.
 */
export function parseVerdict({ body, author = null } = {}) {
  if (typeof body !== 'string' || body.length === 0) return null;

  const block = extractFencedBlock(body);
  if (block === null) return null;

  const proto = scalar(block, 'protocol');
  if (proto !== 'brain-review/1' && proto !== 'brain-review/2') return null;

  const headSha = scalar(block, 'head_sha');
  const verdict = scalar(block, 'verdict');
  if (!headSha || !verdict) return null;

  const revRaw = scalar(block, 'rev');
  const result = {
    head_sha: headSha,
    rev: revRaw !== null ? Number(revRaw) : null,
    verdict,
    author,
  };
  if (proto === 'brain-review/2') {
    result.protocol = proto;
  }

  // #682 REQ-682-3 — the axis that challenged this verdict's reasoned findings.
  //
  // It rendered and did NOT parse back: `parseVerdict` returned it absent and
  // did not even report it in `malformed`, so the one field that distinguishes a
  // same-model-challenged verdict from a cross-family-challenged one was
  // write-only. Worse, it was missing from TOP_LEVEL_KEYS, so a block placing it
  // after a findings list terminated nothing and the WHOLE LIST was lost.
  //
  // This field's neighbours have shipped a render/parse asymmetry once already
  // (#381); the round trip is asserted rather than assumed.
  const axisMatch = block.match(/^challenger_axis:\s*(.+)$/m);
  if (axisMatch) result.challenger_axis = unyamlScalar(axisMatch[1].trim());

  // #477 — every field below is a list this parser may fail to read. An
  // unreadable one is named here instead of being silently indistinguishable
  // from a field the block never carried.
  const malformed = [];

  /** Assigns `key` when readable; records it when the block carried it and this
   * parser could not read it; leaves both alone when it is simply absent. */
  const readList = (key) => {
    const value = parseEntryList(block, key);
    if (value === UNREADABLE) malformed.push(key);
    else if (value !== null) result[key] = value;
  };

  // Optional (H1-5c board.mjs) — only set when the block actually carries a
  // readable `sequencing:` line; omitted otherwise (not `null`), so a block
  // without it round-trips through parseVerdict unchanged.
  //
  // `sequencing` gets its OWN reader, deliberately NOT `parseEntryList` (review
  // of this change). It is a flat list of label STRINGS; `parseEntryList` is the
  // inverse of the findings/follow_ups entry emitter. Routing one through the
  // other made `  - seq:after-411` match `ENTRY_OPEN_RE` and parse to
  // `[{ seq: 'after-411' }]` — accepted as readable, then handed to
  // `guardedLabelAdd`, which threw `refused label "[object Object]"` out of
  // runBoard's per-PR loop and stranded every remaining open PR. Two readers
  // because there are two shapes on the wire, not one reader stretched over both.
  //
  // The membership test is the load-bearing part: board.mjs compares and DELETES
  // labels by name, so a non-string member is not a label under any reading and
  // must reach the consumer as "unreadable", never as a value.
  if (SEQUENCING_KEY_RE.test(block)) {
    const raw = scalar(block, 'sequencing');
    const parsed = raw !== null ? parseJsonScalar(raw) : null;
    if (Array.isArray(parsed) && parsed.every(label => typeof label === 'string')) {
      result.sequencing = parsed;
    } else {
      // Covers every remaining shape: unparseable, non-array, non-string members,
      // and the block-sequence form (`scalar` finds no inline value, and this
      // parser has no reader for that encoding). The key WAS here, so "absent" is
      // not an available answer — #477's whole point.
      malformed.push('sequencing');
    }
  }

  // Optional (v2 REQ-H2-2, fixed in #381) — findings and follow_ups are read
  // in whichever encoding the block carries. Both are rendered as YAML lists
  // by renderVerdict; `follow_ups` was never parsed at all before #381.
  readList('findings');
  readList('follow_ups');

  // #683 — `controls` is a FLAT LIST OF STRINGS, so it gets `sequencing`'s
  // treatment and NOT `readList`. Same reason, written next door: `parseEntryList`
  // is the inverse of the findings/follow_ups ENTRY emitter, and pointing it at a
  // flat list parsed `  - deterministic` into `[{...}]` — accepted as readable,
  // then handed to a consumer that reasons over strings. It happens to work today
  // only because this field is always emitted inline; relying on the emitter never
  // using the other encoding is the assumption that produced the sequencing bug.
  //
  // A member outside the known vocabulary is UNREADABLE, not a value. This field
  // is a CLAIM about what was checked, and a verdict claiming a control that does
  // not exist would be believed — strictly worse than the silence #683 replaces.
  const readControlList = (key, keyRe) => {
    if (!keyRe.test(block)) return;
    const raw = scalar(block, key);
    const parsed = raw !== null ? parseJsonScalar(raw) : null;
    if (Array.isArray(parsed) && parsed.every(c => typeof c === 'string' && CONTROL_CLASSES.includes(c))) {
      result[key] = parsed;
    } else {
      malformed.push(key);
    }
  };
  readControlList('controls', CONTROLS_KEY_RE);
  // #690 — the complement rides the SAME reader. Two call sites of one rule, not
  // two implementations of it: the vocabulary check and the three-state answer
  // must stay identical across both halves of one declaration.
  readControlList('controls_not_applied', CONTROLS_NOT_APPLIED_KEY_RE);

  if (malformed.length > 0) result.malformed = malformed;

  return result;
}

/**
 * THE definition of "the same review iteration" (issue #506).
 *
 * §7's bound says *"this has gone around too many times, a human must rule"* — a
 * statement about iterations on a DISAGREEMENT. Counting over a PR's whole life
 * measures something else entirely: how many times the reviewer was invoked,
 * including runs where the diff never moved. A long-lived PR reviewed once at each
 * of four successive heads, correctly every time, was indistinguishable from one
 * that argued four times about the same diff — and the fourth run turned a REVISE
 * into STOP + escalate:human with nothing in the code changed (measured on PR #505,
 * four runs at `3ae6eb9`).
 *
 * Worse, it had no exit. A new commit did not reset it (no head filter). Dismissing
 * the reviews did not (a dismissed review keeps its body, so it still parses). Past
 * the bound every future run returned STOP. The only way out was closing the PR and
 * losing the history the escalation exists to summarise.
 *
 * This exists as ONE exported function because the ticket requires it: the anti-loop
 * lock (`poster.mjs`) already filtered by head while the bound did not, and nothing
 * said why. Now both cite this. The anti-loop adds an AUTHOR condition on top — that
 * difference is real and stated where it is applied, not hidden in a second notion of
 * sameness.
 *
 * @param {Array<{head_sha?: string}>} priorVerdicts  parsed verdicts, any head
 * @param {string} headSha  the head under review
 * @returns {Array} the subset belonging to this iteration
 */
export function verdictsAtHead(priorVerdicts, headSha) {
  if (!Array.isArray(priorVerdicts) || !headSha) return [];
  return priorVerdicts.filter(v => v?.head_sha === headSha);
}
