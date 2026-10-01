// epic-graph.mjs — the pure half of `brain:epic:map` (issue #459).
//
// #313's body carries lanes, dependencies and priorities as hand-maintained prose,
// and it has drifted at least once — the 2026-08-02 errata records a planning pass
// misdirected by a stale body proposing closed work. A maintained diagram drifts;
// only a derived one cannot lie more than its source.
//
// THE DESIGN QUESTION THE TICKET ASKS TO SETTLE FIRST: dependencies must become
// DATA, not prose. This module answers it with a DECLARED block in the issue body,
// identified by its fence TAG (issue #709; ADR-0032):
//
//   ```brain-graph/1
//   track:    A
//   blocks:   [435, 94]
//   needs:    [479]
//   files:    ["brain/scripts/status/**"]
//   ```
//
// Chosen over the alternative — native provider relations (GitHub sub-issues +
// blocked-by via GraphQL, GitLab issue links) — for one reason, and it is a slicing
// reason rather than a preference: those are NEW PORT VERBS, and widening the port
// is a `decision`-labelled change with an ADR behind it (ADR-0020's own rule). The
// declared block needs no new verb, works identically on both providers because it
// is just issue text, and the two are not exclusive: when the relations land, they
// become a second source feeding the same builder.
//
// It reuses the two readers this repo already has rather than growing a third
// (the defect #340 records): `fenced-blocks.mjs` LOCATES every fence and
// `yaml-block.mjs`'s `scalar` / `parseJsonScalar` READ the fields inside the one
// selected. That is the same split `checkpoint-block.mjs` uses, and it is a split
// by SHAPE OF INPUT.
//
// It used to locate through `extractFencedBlock`, which reads the FIRST fence.
// That is right for a VCS comment our own emitter wrote — one body, one block —
// and wrong here (#639): an issue body is written by a human and routinely opens
// with a snippet, a command, or a log excerpt. `fenced-blocks.mjs` fixed that by
// reading every fence rather than only the first.
//
// THE SELECTOR IS THE FENCE TAG, NOT AN INTERIOR SCALAR (#709; ADR-0032). Until
// #709, the selector filtered every fence for `scalar(content, 'protocol') ===
// 'brain-graph/1'` — a value an author teaching the shape necessarily reproduces
// verbatim, so a body that ILLUSTRATES the protocol and a body that DECLARES it
// were byte-identical to the reader: no code path could tell them apart. #709
// measured the corpus: zero declarations exist anywhere in this repo, and the one
// column-0 `protocol: brain-graph/1` in the whole tree
// (`openspec/changes/issue-459-epic-map-derived/proposal.md:38`) is exactly that
// illustration, sitting in the very proposal that introduced the protocol.
//
// The tag `​```brain-graph/1` is now the identity, compared against the FIRST WORD
// of the fence's info string, exact case — the same rule `brain-amendment/1` and
// `brain-checkpoint/1` already use for the family they belong to. A `​```yaml`
// fence carrying `protocol: brain-graph/1` inside no longer declares; it is
// refused OUT LOUD, naming the retag, never silently read as absent — see
// `parseGraphBlock` below.
//
// `fenced-blocks.mjs` itself is UNTOUCHED by this half of #709, deliberately: it
// stays backtick-only and column-0-only until the splitter half of #709 lands.
// That ordering is a correctness constraint, not a preference (design.md D0) —
// teaching the splitter to see indented or tilde-fenced openers BEFORE the
// selector stopped trusting the interior scalar would make an indented
// illustration newly readable and mint a fabricated edge from it. The tag-based
// selector below is safe under either version of the splitter, because nothing
// but a fence literally tagged `brain-graph/1` can ever match it.

import { fencedBlocks } from '../lib/fenced-blocks.mjs';
import { scalar, parseJsonScalar } from '../review/lib/yaml-block.mjs';

export const GRAPH_PROTOCOL = 'brain-graph/1';

/**
 * The splitter's `skipped.reason` values, rendered for a human (#723).
 *
 * The refusal must name the reason, not only the line — D6 row 4 says "naming line
 * **and** reason", because "cannot be read at line 3" leaves the author guessing
 * which of three CommonMark rules put it there. Keyed off the splitter's own
 * vocabulary so a new reason surfaces as itself rather than as a missing case.
 */
const REFUSAL_REASON = Object.freeze({
  blockquote: 'a blockquote',
  'indented-code': 'an indented code block (four spaces or more)',
  'html-comment': 'an HTML comment',
});

/**
 * A line that OPENS a fence tagged for this protocol, at a CommonMark-legal indent.
 *
 * Used only to locate a declaration swallowed by an unterminated foreign fence
 * (#710 finding 1), where the splitter never sees it as a fence at all.
 */
const GRAPH_FENCE_OPENER = new RegExp(`^ {0,3}(\`{3,}|~{3,})\\s*${GRAPH_PROTOCOL.replace('/', '\\/')}(\\s|$)`);

/**
 * The fence's DECLARED identity: the first whitespace-delimited word of its info
 * string. `fencedBlocks` still returns `tag` as the WHOLE trimmed info string,
 * unchanged (#495 D1 — `amendment-draft.mjs`/`checkpoint-block.mjs` compare it with
 * `===`, and redefining it here would silently widen both). This derivation stays
 * local to the selector rather than moving into `fenced-blocks.mjs` until the
 * splitter half of #709 lands (D0) — the selector needs nothing from the splitter
 * that is not already there.
 *
 * @param {string} tag
 * @returns {string}
 */
function firstWord(tag) {
  return tag.split(/\s+/)[0];
}

/**
 * A tracker branch name, as a `brain-graph/1` block may declare it (#967 D2).
 *
 * `..` is spelled entirely out of the character class, so the pattern alone admits
 * `feature/../x`; the segment is refused separately below. Anything else that fails
 * this is refused OUT LOUD and left `null` — never repaired into the shape it
 * nearly had, which is the whole point of reading a declaration rather than
 * guessing at one.
 */
const TRACKER_GRAMMAR = /^feature\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * AN ISSUE NUMBER, wherever this module reads one: bare positive digits, no leading
 * zero. Spelled ONCE and composed into the three patterns below, so the block key and
 * the prose line cannot drift into disagreeing about what a number is — which they
 * had, measured: `parent: 007` and `Parent: #007` both became `7` through `Number()`,
 * and `Parent: #0` became `0`, a value the block key's own refused list already names.
 *
 * A leading zero is REFUSED, not normalised, on R967-1's own rule for the other two
 * keys: a declaration is read, never repaired. `7` is not the byte the author wrote,
 * and a parser that quietly decides they meant a different issue than the one they
 * typed is the failure mode this whole channel exists to stop.
 */
const ISSUE_NUMBER = String.raw`[1-9]\d*`;

/** The `parent:` BLOCK key. A key that is present and fails this is MALFORMED and is
 *  said as `parent-grammar` — unlike a prose line, which is simply not a declaration. */
const PARENT_KEY_GRAMMAR = new RegExp(String.raw`^${ISSUE_NUMBER}$`);

/**
 * The VALUE a prose `Parent:` line declares — the run of issue references the key
 * names, and nothing else on the line.
 *
 * IT IS MATCHED AGAINST PROSE, NOT AGAINST THE WHOLE BODY — see `outsideFences`.
 *
 * The value ends where the prose begins (#1029). Until then this matched to END OF
 * LINE and every `#N` on it was counted, so `Parent: #878 (Brain UI) — after slice 3
 * (#881, merged as #970)` read as four competing declarations and the `base-branch`
 * gate refused the PR that linked it (measured on #998, PR #1028). What the key
 * declares is the reference right after it, plus any further reference joined to it
 * as a LIST (`,`, `/`, `and`, or bare whitespace): `Parent: #878, #879` is still two
 * values for one key, refused rather than resolved by writing order, which is the
 * guess this requirement exists to refuse. A reference reached through anything else
 * — a bracket, a dash, a word — is prose about the work, not a second declaration.
 *
 * Every hop into a further reference CONSUMES its own separator — punctuation, or
 * whitespace, each optionally followed by `and` — and ends on a reference. Two
 * adjacent optional whitespace runs around an optional token would let the engine
 * split one run of spaces every way there is: measured on that first draft,
 * `Parent: #1` followed by 65k spaces and a letter took 2.4s, and 160k took 14.5s,
 * against 0ms for the end-of-line pattern this replaced (#1030 cold review).
 *
 * `\b` is still what refuses `#878x`. `g` is for `matchAll`, which clones the regex
 * rather than advancing this one.
 */
const PARENT_PROSE_VALUE = new RegExp(
  String.raw`^Parent:[ \t]*(#${ISSUE_NUMBER}\b(?:(?:[ \t]*(?:,|/)[ \t]*(?:and[ \t]+)?|[ \t]+(?:and[ \t]+)?)#${ISSUE_NUMBER}\b)*)`,
  'gm',
);

/**
 * Every issue reference inside a `Parent:` key's captured VALUE (never the whole
 * line — #1029).
 *
 * The ambiguity rule is stated over the SET of numbers found, not over the count of
 * matches, so the one-line and two-line shapes cannot disagree about what counts as a
 * restatement: `Parent: #878 — see #878` reads 878 (the second reference is prose,
 * outside the value), exactly as two `Parent: #878` lines do.
 */
const ISSUE_REF = new RegExp(String.raw`#(${ISSUE_NUMBER})`, 'g');

/**
 * The body with every FENCED REGION blanked out, line count preserved.
 *
 * The prose reader must see what a READER of the rendered page sees, which is the
 * same argument `fenced-blocks.mjs` settles for the splitter: anywhere the reader
 * and the author's screen disagree, the reader has fabricated something. A fence is
 * the canonical "this is an example, not a statement" shape — it is how this very
 * module's header illustrates the block — and #709 already refused to let an
 * illustration and a declaration be byte-identical to the selector. The prose scan
 * was still reading the whole body, so column zero INSIDE a fence declared a parent.
 *
 * MEASURED, and the third shape is the damaging one: a fenced `Parent: #999` added a
 * parent (plain fence, and inside the `brain-graph/1` fence itself, where `Parent:`
 * is not the block's exact-case `parent:` key); and a fenced example standing ABOVE
 * a real `Parent:` line did not merely add one, it DELETED the real declaration by
 * manufacturing an ambiguity with it.
 *
 * An UNTERMINATED fence is blanked to the end of the document, because that is how
 * far it runs on the page — `fenced-blocks.mjs`'s own contract.
 *
 * Blanking rather than deleting keeps every surviving line at its own index, so
 * nothing below a fence shifts and the `m`-anchored pattern still sees line starts.
 * The span is derived from the splitter's own report, never re-scanned: this module
 * grows no second fence reader (#340). `content === ''` is the one ambiguous count
 * (zero lines, or one empty line), and it is resolved to ZERO — an UNDER-estimate, so
 * the two lines the span may leave uncovered are an empty line and a fence
 * delimiter, neither of which can match a `Parent:` declaration.
 *
 * @param {string} body
 * @param {{content:string, line:number}[]} blocks
 * @param {{line:number}|null} unterminated
 * @returns {string}
 */
function outsideFences(body, blocks, unterminated) {
  const lines = body.split(/\r?\n/);
  const blank = (from, to) => { for (let i = Math.max(from, 0); i < Math.min(to, lines.length); i++) lines[i] = ''; };
  // `line` is the 1-based OPENER; the closer sits one line past the content.
  for (const b of blocks) blank(b.line - 1, b.line + (b.content === '' ? 0 : b.content.split('\n').length) + 1);
  if (unterminated) blank(unterminated.line - 1, lines.length);
  return lines.join('\n');
}

/**
 * The parent declared in PROSE alone: the line-initial `Parent: #N` reader
 * (R967-2), extracted so it can run WHETHER OR NOT a `brain-graph/1` block
 * exists at all (#967 PR D, cold review round 2, 2026-09-17).
 *
 * MEASURED: `parseGraphBlock` returns `null` before this scan ever ran
 * whenever the body carried no graph-tagged fence at all
 * (`!body.includes(GRAPH_PROTOCOL)`) — so a body that never declared a block
 * left its prose `Parent:` line invisible to `buildGraph`, to
 * `lib/ticket-base.mjs`'s `parentOf`, and to the `base-branch` gate. R967-2's
 * own rule says the fallback applies "block or no block"; the code only ran
 * it inside the block-exists branch. `declaredParent` below is the one entry
 * that answers correctly either way, reusing THIS reader from both sides.
 *
 * Same exclusions as always: every fenced region is blanked first
 * (`outsideFences`, the `brain-graph/1` fence and an unterminated fence
 * included) — an HTML comment is not masked, same standing follow-up.
 *
 * @param {string} body
 * @returns {{ parent: number|null, parentSource: 'prose'|null, ambiguousValue: string|null }}
 */
export function parentFromProse(body) {
  const { blocks, unterminated } = fencedBlocks(body);
  const prose = [...new Set(
    [...outsideFences(body, blocks, unterminated).matchAll(PARENT_PROSE_VALUE)]
      .flatMap(m => [...m[1].matchAll(ISSUE_REF)].map(r => Number(r[1]))),
  )];
  // Ambiguity (more than one DISTINCT number) is reported by the caller that
  // has a `declarationDivergences` channel to say it in (`parseGraphBlock`);
  // this reader hands back the raw value so that caller can still name it.
  if (prose.length > 1) return { parent: null, parentSource: null, ambiguousValue: prose.join(', ') };
  if (prose.length === 1) return { parent: prose[0], parentSource: 'prose', ambiguousValue: null };
  return { parent: null, parentSource: null, ambiguousValue: null };
}

/**
 * The parent DECLARED for a body, from whichever channel actually declares
 * one: the block's `parent:` key when a `brain-graph/1` block reads cleanly
 * and names it, else the line-initial `Parent:` prose — WITH or WITHOUT a
 * block present at all (#967 PR D). `parseGraphBlock` alone only reaches the
 * prose fallback when a block EXISTS and simply omits `parent:`; this is the
 * one entry `buildGraph` and `lib/ticket-base.mjs`'s `parentOf` both need, so
 * neither has to grow a second "read the block, else read the body" caller.
 *
 * A MALFORMED block (`{ok: false}`, an ambiguous or hidden declaration) never
 * falls back to prose — malformed is not absent (#639), and salvaging a
 * refused declaration through a second door would make the refusal optional.
 *
 * `ambiguousValue` carries the same thing `parseGraphBlock`'s own
 * `declarationDivergences` carries for the block-bearing path: MORE THAN ONE
 * distinct `Parent: #N` number, raw, for a caller that has no divergence
 * channel of its own (#967 cold review round 1, finding 2) — `null` whenever
 * a block resolved the parent (its own ambiguity, if any, is already said via
 * `parseGraphBlock`'s `declarationDivergences`) or nothing was declared at all.
 *
 * `divergence` (#967 PR E, tracker PR #1004 round-3 cold review) is the ONE
 * fact `parent === null` alone erases: a `parent:` key that fails
 * `PARENT_KEY_GRAMMAR` and two disagreeing prose `Parent:` lines both land on
 * `parent: null` — the SAME value a body that never mentions a parent at all
 * produces. A caller that only reads `.parent` cannot tell "nothing was
 * declared" from "something was declared and could not be read" — exactly
 * the distinction `base-branch.mjs`'s own header comment (line 18) already
 * demands ("uncomputable, never a silent pass") but its `baseBranchRule`
 * failed to make, because this reader gave it nothing to branch on. `null`
 * when the parent resolved cleanly OR nothing was declared at all; otherwise
 * `{key: 'parent', value, reason: 'parent-grammar'|'parent-ambiguous'}` —
 * the SAME entry shape `declarationDivergences` already uses, for the block
 * case lifted straight from it (filtered to `key === 'parent'`) rather than
 * re-derived, and for the prose-only case built from `parentFromProse`'s own
 * `ambiguousValue` (its ONLY divergence — a non-matching line says nothing,
 * by design).
 *
 * @param {string} body
 * @returns {{ parent: number|null, parentSource: 'block'|'prose'|null, ambiguousValue: string|null,
 *            divergence: {key:'parent', value:string, reason:'parent-grammar'|'parent-ambiguous'}|null }}
 */
export function declaredParent(body) {
  if (typeof body !== 'string') return { parent: null, parentSource: null, ambiguousValue: null, divergence: null };
  const block = parseGraphBlock(body);
  if (block && block.ok !== false) {
    const divergence = (block.declarationDivergences ?? []).find((d) => d.key === 'parent') ?? null;
    return { parent: block.parent, parentSource: block.parentSource, ambiguousValue: null, divergence };
  }
  if (block?.ok === false) return { parent: null, parentSource: null, ambiguousValue: null, divergence: null };
  const prose = parentFromProse(body);
  const divergence = prose.ambiguousValue !== null
    ? { key: 'parent', value: prose.ambiguousValue, reason: 'parent-ambiguous' }
    : null;
  return { parent: prose.parent, parentSource: prose.parentSource, ambiguousValue: prose.ambiguousValue, divergence };
}

/** Node states, in the order a reader cares about them. */
export const READY = 'ready';
export const BLOCKED = 'blocked';
export const AWAITING_HUMAN = 'awaiting-human';
export const UNCLASSIFIED = 'unclassified';

/**
 * Reads the declared graph block from an issue body.
 *
 * THE BLOCK IS SELECTED BY ITS FENCE TAG (#709; ADR-0032), never by an interior
 * scalar and never by position: every fence in the body is read via
 * `fencedBlocks`, and the one whose info-string's FIRST WORD, compared exact-case,
 * equals `GRAPH_PROTOCOL` is the declaration. Trailing attributes
 * (`​```brain-graph/1 title="x"`) do not block a match on the first word, and case
 * is exact — `BRAIN-GRAPH/1` is not a match; there is no whitelist of near-misses
 * to forgive.
 *
 * FOUR ANSWERS, and each is a different sentence for the reader:
 *
 * ABSENT IS NOT EMPTY. A body with no `brain-graph/1`-tagged fence, and no mention
 * of the protocol at all, yields `null`, and the builder marks the issue
 * UNCLASSIFIED rather than dropping it or treating it as a free-standing leaf. A
 * node that disappears because it lacks metadata is the same class as a commit the
 * audit never enumerates (#518): the map would report a graph it had not read.
 *
 * MALFORMED IS NOT ABSENT (#639). More than one `brain-graph/1`-tagged fence in one
 * body is ambiguity, and the answer is `{ ok: false, error }` naming the count —
 * never a silent pick of one of them, the same rule `parseAmendmentDraft` and
 * `parseCheckpointClaim` hold. `buildGraph` carries it out in `blocksUnreadable`
 * and `renderSummary` prints it, exactly as it already does for a native read it
 * could not perform: "could not read what it declared" is not "declared nothing".
 *
 * HIDDEN IS NOT ABSENT (design.md D6). A `brain-graph/1`-tagged fence that never
 * closes is not a missing declaration — `fencedBlocks` reports it as
 * `unterminated`, and that is carried out here as `{ ok: false, error }` naming
 * the line, unconditionally, regardless of any other fence's tag. #710 finding 1's
 * attribution ambiguity (whose unterminated fence was it?) is deleted by
 * construction: the caller never asks.
 *
 * THE LEGACY SHAPE IS REFUSED OUT LOUD (design.md D7). Zero tagged fences, but some
 * fence's CONTENT still carries the pre-#709 `protocol: brain-graph/1` scalar — the
 * shape this module used to teach — returns `{ ok: false, error }` naming the
 * retag. "No longer declares" must not silently read as "stopped working". A
 * tagged declaration standing beside a `​```yaml` illustration of the same
 * protocol is NOT this case, and is not ambiguity either: the illustration is not
 * a declaration, so it is ignored and the tagged block reads alone.
 *
 * Success keeps the bare object rather than growing an `ok: true` envelope, because
 * `null`-means-absent is load-bearing here and already distinguishes the case the
 * envelope exists to distinguish elsewhere.
 *
 * @param {string} body
 * @returns {{ track: string|null, kind: string|null, tracker: string|null,
 *            parent: number|null, parentSource: 'block'|'prose'|null,
 *            blocks: number[], needs: number[], files: string[],
 *            declarationDivergences: Array<{key:string,value:string|null,reason:string}> }
 *          |{ ok: false, error: string }
 *          |null}
 */
export function parseGraphBlock(body) {
  if (typeof body !== 'string' || !body.includes(GRAPH_PROTOCOL)) return null;

  const { blocks, unterminated, skipped } = fencedBlocks(body);
  const declared = blocks.filter(b => firstWord(b.tag) === GRAPH_PROTOCOL);

  if (declared.length > 1) {
    return {
      ok: false,
      error: `${declared.length} \`${GRAPH_PROTOCOL}\` blocks found (body lines ${declared.map(b => b.line).join(', ')}) — an issue declares its graph exactly once.`,
    };
  }

  if (declared.length === 0) {
    // D6: an unterminated fence that WAS tagged for this protocol hides a
    // declaration — it is not the same fact as "no fence declared one".
    if (unterminated && firstWord(unterminated.tag) === GRAPH_PROTOCOL) {
      return {
        ok: false,
        error: `a \`${GRAPH_PROTOCOL}\` fence opened at body line ${unterminated.line} is never closed — its declaration cannot be read.`,
      };
    }

    // D6 row 4, the half that was never wired (#723). The splitter records every
    // delimiter-shaped line it deliberately refused; `skipped` is that channel,
    // and until now nothing read it. A blockquoted, four-space-indented or
    // HTML-commented graph fence is CONTENT by CommonMark — correctly so — but a
    // reader that answers `null` about it is saying "nobody declared a graph"
    // when it means "one is there and I would not read it".
    //
    // It shipped half-built because task 2.2 was checked against the half that
    // existed: PR #720 landed the selector, `skipped` arrived with PR #722, and
    // D0 sequenced them in that order on purpose. Nothing came back.
    const hiddenBySkip = skipped.find(s => firstWord(s.tag) === GRAPH_PROTOCOL);
    if (hiddenBySkip) {
      return {
        ok: false,
        error: `a \`${GRAPH_PROTOCOL}\` fence at body line ${hiddenBySkip.line} is inside ${REFUSAL_REASON[hiddenBySkip.reason] ?? hiddenBySkip.reason}, so it is content and its declaration cannot be read.`,
      };
    }

    // D6 row 4, second half (#710 finding 1). A runaway fence of ANOTHER tag
    // consumes everything below it, so a well-formed graph fence inside that
    // region never becomes a block at all — and `unterminated.tag` names the
    // foreign fence, not this protocol, which is why the branch above misses it.
    //
    // Keyed on POSITION, not on the protocol appearing anywhere in the body: a
    // mention above the runaway fence is not hidden by it, and widening this to
    // "the string is present" would turn every issue that merely discusses the
    // protocol into an unreadable block — trading a silent omission for a
    // fabricated defect, the exact trade ADR-0032 exists to refuse.
    // A runaway fence reaches the reader in THREE shapes, measured — and only the
    // last two leave `unterminated` set, which is why one detection is not enough:
    //
    //   ```console … ```brain-graph/1 … ```   the graph block's OWN closer closes
    //                                          the foreign fence → one `console`
    //                                          block, `unterminated: null`, the
    //                                          declaration sitting in its content
    //   ```console … ```brain-graph/1         nothing closes it → `unterminated`,
    //   ~~~console … ```brain-graph/1         `blocks: []`, content never exposed
    //
    // Shape 1 is the common one in practice, because an author who forgets a
    // closer usually has a well-formed block below to donate one.
    for (const b of blocks) {
      const at = b.content.split(/\r?\n/).findIndex(l => GRAPH_FENCE_OPENER.test(l));
      if (at === -1) continue;
      return {
        ok: false,
        error: `a \`${b.tag || 'plain'}\` fence opened at body line ${b.line} swallowed the \`${GRAPH_PROTOCOL}\` fence at body line ${b.line + 1 + at} as its content — the declaration cannot be read. Close the \`${b.tag || 'plain'}\` block above it.`,
      };
    }
    if (unterminated) {
      const after = body.split(/\r?\n/).slice(unterminated.line);
      const at = after.findIndex(l => GRAPH_FENCE_OPENER.test(l));
      if (at !== -1) {
        return {
          ok: false,
          error: `a \`${unterminated.tag || 'plain'}\` fence opened at body line ${unterminated.line} is never closed, so the \`${GRAPH_PROTOCOL}\` fence at body line ${unterminated.line + at + 1} is swallowed as its content and cannot be read.`,
        };
      }
    }
    // D7: the pre-#709 shape (```yaml + an interior `protocol:` scalar) is
    // refused out loud, not read as absent — this is the entire migration net.
    const legacy = blocks.find(b => scalar(b.content, 'protocol') === GRAPH_PROTOCOL);
    if (legacy) {
      return {
        ok: false,
        error: `the declaration is the fence tag since #709, not a \`protocol:\` scalar — retag the block at body line ${legacy.line} as \`\`\`${GRAPH_PROTOCOL}\`.`,
      };
    }
    return null;
  }

  const block = declared[0].content;

  const nums = (key) => {
    const raw = scalar(block, key);
    if (raw === null) return [];
    const parsed = parseJsonScalar(raw);
    return Array.isArray(parsed) ? parsed.filter(n => Number.isInteger(n)) : [];
  };
  const strs = (key) => {
    const raw = scalar(block, key);
    if (raw === null) return [];
    const parsed = parseJsonScalar(raw);
    return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : [];
  };

  const track = scalar(block, 'track');

  // #967 D1: three further keys, read from the SAME block by the same reader. One
  // body, one selector — a second parser function for the new keys would have to
  // re-run the fence selection above, the most guard-heavy code in the module.
  //
  // `kind` takes any value verbatim and only `'epic'` ever carries meaning. There is
  // no validation, for the same reason `scalar()` reads only the keys a caller names:
  // unknown-key validation is nowhere in this parser, and forward compatibility is
  // free without it.
  //
  // `track` and `tracker` cannot collide in either direction: `scalar`'s pattern is
  // anchored `^<key>:`, so `^track:` never matches a `tracker:` line.
  const kind = scalar(block, 'kind');

  // D2: every malformed declaration below is SAID — one entry, naming the key, the
  // offending text and a stable reason token. It is never dropped silently, never
  // repaired into the value it nearly was, and never allowed to throw. `reason` is a
  // token rather than a sentence because a later reader has to branch on it, and a
  // reader that string-matches prose is one wording change away from going quiet.
  const declarationDivergences = [];
  const say = (key, value, reason) => { declarationDivergences.push({ key, value, reason }); };

  const trackerRaw = scalar(block, 'tracker');
  let tracker = trackerRaw;
  if (trackerRaw !== null && !(TRACKER_GRAMMAR.test(trackerRaw) && !trackerRaw.includes('..'))) {
    tracker = null;
    say('tracker', trackerRaw, 'tracker-grammar');
  } else if (trackerRaw !== null && kind !== 'epic') {
    // Q7: parsed and carried, honoured nowhere. The mismatch is a said divergence and
    // nothing more — refusing it would make a typo in `kind:` delete a declaration.
    // A tracker already refused on grammar is `null` by now, so there is no carried
    // value left to not-honour and this branch correctly says nothing about it.
    say('tracker', trackerRaw, 'tracker-without-kind-epic');
  }

  // D3: the block key wins and the prose line is then NEVER READ — not even to
  // disagree with it. A `parent:` key present but unreadable is malformed, not
  // absent, so it does not fall through to prose either: salvaging one would make a
  // refused declaration quietly succeed by another door.
  const parentRaw = scalar(block, 'parent');
  let parent = null;
  let parentSource = null;
  if (parentRaw !== null) {
    if (PARENT_KEY_GRAMMAR.test(parentRaw)) {
      parent = Number(parentRaw);
      parentSource = 'block';
    } else {
      say('parent', parentRaw, 'parent-grammar');
    }
  } else {
    // #967 PR D: extracted into `parentFromProse`, reused unchanged here and
    // by `declaredParent` for a body with no block at all. DIFFERENT issues
    // named for one key is ambiguity, and the answer is the one
    // `parseGraphBlock` already gives for two graph blocks: stop picking. The
    // count is over the numbers, not over the lines, so `Parent: #878, #879`
    // on ONE line is the same refusal as the same pair on two — it was
    // resolved to 878 by writing order until this rule was stated over the
    // set. One number said twice, on one line or two, is a restatement
    // rather than a disagreement: exactly one answer, so it reads.
    const prose = parentFromProse(body);
    if (prose.ambiguousValue !== null) say('parent', prose.ambiguousValue, 'parent-ambiguous');
    else if (prose.parent !== null) { parent = prose.parent; parentSource = prose.parentSource; }
  }

  return {
    track: track ?? null,
    kind,
    tracker,
    parent,
    parentSource,
    blocks: nums('blocks'),
    needs: nums('needs'),
    files: strs('files'),
    declarationDivergences,
  };
}

/**
 * Do two file claims overlap? The question that decides whether two agents can work
 * at once, and the reason `files` exists at all.
 *
 * Glob-aware only to the depth the claims need: a `**` suffix is a prefix claim.
 * Deliberately NOT a full glob engine — an approximate matcher that silently answers
 * "no overlap" would license two agents onto one file, so anything it cannot decide
 * it must call an OVERLAP. Conservative in the safe direction.
 *
 * @param {string[]} a @param {string[]} b @returns {boolean}
 */
export function filesOverlap(a = [], b = []) {
  const norm = (p) => String(p).replace(/\/?\*\*$/, '/').replace(/\/+$/, '/');
  for (const x of a) {
    for (const y of b) {
      const nx = norm(x);
      const ny = norm(y);
      if (nx === ny) return true;
      if (nx.endsWith('/') && ny.startsWith(nx)) return true;
      if (ny.endsWith('/') && nx.startsWith(ny)) return true;
      // Neither is a prefix of the other AND neither is a bare path we can compare:
      // an unrecognised glob (`*` in the middle, `?`, braces) is UNDECIDABLE, and
      // undecidable must read as overlapping.
      if (/[*?{[]/.test(nx.slice(0, -1)) || /[*?{[]/.test(ny.slice(0, -1))) return true;
    }
  }
  return false;
}

/** The two sources an edge can come from (#533, ADR-0029). */
export const SRC_DECLARED = 'declared';
export const SRC_NATIVE = 'native';

/**
 * Builds the execution graph from a set of issues.
 *
 * `needs` edges are honoured in BOTH directions: `A needs B` and `B blocks A` are the
 * same edge declared from either end, and a graph that only read one would go quiet
 * the moment someone declared it from the other. Duplicates collapse.
 *
 * TWO SOURCES, ONE GRAPH (#533 slice 2, ADR-0029 Decision 2). The declared
 * `brain-graph/1` block and the provider's native relations (`issue.relations`, from
 * the `issueRelations` verb) both assert edges, and the graph takes their UNION —
 * neither overrides the other.
 *
 * Precedence was the open question, and the answer is that precedence is a way of
 * DISCARDING an assertion. An edge either source knows about is a real constraint on
 * start order, and dropping it because the other source is silent makes the map say
 * "there is no dependency" — the stronger and falser statement this whole module
 * refuses (the out-of-scope stub in `renderMermaid`, the pagination fix behind
 * `issueList`, #518's unenumerated commits). Union is also the safe direction: an
 * extra blocker delays one ticket, a missing one licenses two agents onto colliding
 * work.
 *
 * The union is only honest with the DIVERGENCE REPORTED. Every edge present in one
 * source and absent from the other lands in `divergences`, and `renderSummary` prints
 * it. That is what answers the ticket's worry about "a relation someone clicked by
 * accident": a wrong click shows up in a list a human can act on, where a silently
 * overridden one never would. A silent merge of two sources is how a derived artefact
 * starts lying again.
 *
 * `relations === null` means UNCOMPUTABLE — the native side could not be read for that
 * issue — and it is carried through to `relationsUnreadable` rather than being read as
 * "no native relations". `undefined` means the caller did not ask for them at all.
 *
 * The DECLARED side has the same distinction (#639): a body whose graph block could
 * not be read lands in `blocksUnreadable` with the reason, and its node stays
 * UNCLASSIFIED — the honest status, since no source placed it — instead of being
 * counted among the issues that simply never declared one.
 *
 * An edge to an issue that is CLOSED or absent from the set does not block — the work
 * is done or out of scope. An edge to an OPEN issue does.
 *
 * @param {Array<{number:number,title:string,labels:string[],state:string,body?:string,assignees?:string[]|null,relations?:{blocks:number[],needs:number[],foreign?:number}|null}>} issues
 * @returns {{ nodes: Array, edges: Array<{from:number,to:number,sources:string[]}>, tracks: Map, divergences: Array, declarationDivergences: Array<{number:number,key:string,value:string|number|null,reason:string}>, relationsUnreadable: number[], blocksUnreadable: Array<{number:number,error:string}>, foreignRelations: number }}
 */
export function buildGraph(issues = []) {
  const byNumber = new Map(issues.map(i => [i.number, i]));
  const nodes = [];
  /** @type {Map<string, Set<string>>} edge key → the sources that assert it. */
  const edgeSources = new Map();
  const addEdge = (key, source) => {
    if (!edgeSources.has(key)) edgeSources.set(key, new Set());
    edgeSources.get(key).add(source);
  };
  const relationsUnreadable = [];
  const blocksUnreadable = [];
  /** What the bodies said about their own declarations (#967 D2), stamped with the
   * issue that said it, plus the one thing only this function can see (D5). */
  const declarationDivergences = [];
  let foreignRelations = 0;

  for (const issue of issues) {
    const parsed = parseGraphBlock(issue.body ?? '');
    if (parsed?.ok === false) blocksUnreadable.push({ number: issue.number, error: parsed.error });
    // An unreadable block asserts NOTHING — it is not half a declaration to be
    // salvaged. It places no node and draws no edge; `blocksUnreadable` is what
    // keeps that from reading as "this issue declared nothing".
    const g = parsed?.ok === false ? null : parsed;
    // #967 PR D: `parent`/`parentSource` are resolved through `declaredParent`,
    // NOT through `g` alone — a body with no `brain-graph/1` block at all still
    // has its prose `Parent:` line read this way (measured: `g` is `null` for
    // such a body, and `g?.parent` would silently discard it). `declared`
    // below stays keyed on `g !== null` on purpose: a prose-only parent is a
    // RELATION this issue stated, not a graph BLOCK it declared.
    const dp = declaredParent(issue.body ?? '');
    // `needs` → an edge INTO this node. `blocks` → an edge OUT of it. Same relation,
    // two ends; declaring either is enough.
    for (const d of g?.declarationDivergences ?? []) declarationDivergences.push({ number: issue.number, ...d });
    // #967 cold review round 1, finding 2: an ambiguous prose parent (`Parent: #878,
    // #879`) for a body with NO block at all is said here too — `g` is `null` for
    // such a body, so `g?.declarationDivergences` never carries it, the same gap
    // `parseGraphBlock`'s own block-bearing fallback already closed for itself
    // (~line 502-504). `dp.ambiguousValue` is `null` whenever a block resolved the
    // parent, so this never double-reports a block's own ambiguity.
    if (g === null && dp.ambiguousValue !== null) {
      declarationDivergences.push({ number: issue.number, key: 'parent', value: dp.ambiguousValue, reason: 'parent-ambiguous' });
    }
    for (const n of g?.needs ?? []) addEdge(`${n}->${issue.number}`, SRC_DECLARED);
    for (const b of g?.blocks ?? []) addEdge(`${issue.number}->${b}`, SRC_DECLARED);

    const rel = issue.relations;
    if (rel === null) relationsUnreadable.push(issue.number);
    let nativeTouches = false;
    if (rel) {
      foreignRelations += rel.foreign ?? 0;
      for (const n of rel.needs ?? []) { addEdge(`${n}->${issue.number}`, SRC_NATIVE); nativeTouches = true; }
      for (const b of rel.blocks ?? []) { addEdge(`${issue.number}->${b}`, SRC_NATIVE); nativeTouches = true; }
    }

    // `sources` is what PLACES a node in the graph. A repo that never declares a
    // block still gets one when the provider carries the relations, which is the
    // property the ticket asked for; a node no source places stays UNCLASSIFIED
    // rather than silently becoming a free-standing leaf.
    const sources = [];
    if (g !== null) sources.push(SRC_DECLARED);
    if (nativeTouches) sources.push(SRC_NATIVE);

    nodes.push({
      number: issue.number,
      title: issue.title,
      labels: issue.labels ?? [],
      state: issue.state,
      track: g?.track ?? null,
      // #967 D4: four further declared values, beside `track` and read the same way.
      // Nothing else in the tree reads them yet — the verb and the gate that do
      // arrive in the next two slices, and the UI's node projection is #882's.
      kind: g?.kind ?? null,
      tracker: g?.tracker ?? null,
      parent: dp.parent,
      parentSource: dp.parentSource,
      files: g?.files ?? [],
      declared: g !== null,
      sources,
      // `assignees` passes through UNCHANGED, `null` included (#533): `[]` is
      // "nobody is assigned", `null` is "brain cannot see", and `?? []` here would
      // erase exactly the distinction the port was widened to carry.
      assignees: issue.assignees ?? null,
    });
  }

  // D5 / ruling 4: the one divergence no single body can see. A node named as
  // `parent` that does not itself declare `kind: epic` is SAID — never inferred to
  // be an epic because someone pointed at it, never a tracker, never a failure.
  //
  // A parent ABSENT from the set produces nothing: it may be closed or in another
  // repository, and "not in this list" is not "not an epic" — the same distinction
  // the native-read gate below makes for exactly the same reason.
  const byNode = new Map(nodes.map(n => [n.number, n]));
  for (const node of nodes) {
    const p = node.parent === null ? undefined : byNode.get(node.parent);
    if (p && p.kind !== 'epic') {
      declarationDivergences.push({ number: node.number, key: 'parent', value: node.parent, reason: 'parent-not-epic' });
    }
  }

  const edges = [...edgeSources].map(([k, srcs]) => {
    const [from, to] = k.split('->').map(Number);
    return { from, to, sources: [...srcs].sort() };
  });

  // Only edges whose endpoints BOTH had a native read can diverge: if the native
  // side was unreadable for an endpoint, "absent from native" is not a fact about
  // the relation, it is a fact about the fetch — and reporting it as disagreement
  // would manufacture divergences out of an outage.
  const nativeRead = new Set(
    issues.filter(i => i.relations != null).map(i => i.number),
  );
  const askedNative = nativeRead.size > 0 || relationsUnreadable.length > 0;
  const divergences = !askedNative ? [] : edges
    .filter(e => e.sources.length === 1)
    .filter(e => nativeRead.has(e.from) || nativeRead.has(e.to))
    .map(e => ({ from: e.from, to: e.to, only: e.sources[0] }))
    .sort((a, b) => a.from - b.from || a.to - b.to);

  // Classify. An OPEN prerequisite blocks; a closed or unknown one does not.
  const openBlockers = new Map();
  for (const { from, to } of edges) {
    const src = byNumber.get(from);
    if (src && src.state === 'open') openBlockers.set(to, [...(openBlockers.get(to) ?? []), from]);
  }

  for (const node of nodes) {
    const blockers = openBlockers.get(node.number) ?? [];
    node.blockedBy = blockers;
    if (node.sources.length === 0) node.status = UNCLASSIFIED;
    else if (blockers.length > 0) node.status = BLOCKED;
    else if (!node.labels.includes('status:approved')) node.status = AWAITING_HUMAN;
    else node.status = READY;
  }

  // Parallelisability is COMPUTED from `files`, never taken from a declaration.
  // A declared boolean would be an assertion with no evidence behind it — the shape
  // this repo has paid for repeatedly. Two ready nodes in one track conflict when
  // their file claims overlap.
  const tracks = new Map();
  for (const node of nodes) {
    const key = node.track ?? '?';
    tracks.set(key, [...(tracks.get(key) ?? []), node]);
  }
  for (const [, members] of tracks) {
    const ready = members.filter(n => n.status === READY);
    for (const n of ready) {
      n.conflictsWith = ready
        .filter(o => o.number !== n.number && filesOverlap(n.files, o.files))
        .map(o => o.number);
      // A node with NO file claim yields an empty `conflictsWith`, which reads as
      // "proven parallelisable" when nothing was proven. Native relations make this
      // routine rather than rare — they carry no `files` at all — so the absence is
      // marked instead of being left to look like a clean result (#533).
      n.filesUnknown = n.files.length === 0;
    }
  }

  return { nodes, edges, tracks, divergences, declarationDivergences, relationsUnreadable, blocksUnreadable, foreignRelations };
}
