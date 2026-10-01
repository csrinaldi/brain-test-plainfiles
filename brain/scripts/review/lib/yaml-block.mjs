// yaml-block.mjs — low-level primitives shared by every fenced-YAML reader
// in this repo: the inverse of ONE fixed emitter family. Extracted from
// `parse-verdict.mjs` (issue #473, design.md §B1) as a PURE MOVE — zero
// behavior change. `parse-verdict.test.mjs` is the proof: it is edited by
// zero lines across this extraction.
//
// Purpose-built for the two fixed schemas that use it today
// (`brain-review/N` via `parse-verdict.mjs`, `brain-decision/1` via
// `decision-block.mjs`) — not a generic YAML parser (zero npm deps).
//
// Does NOT include the findings/follow_ups list machinery
// (`ENTRY_OPEN_RE` / `ENTRY_CONT_RE` / `TOP_LEVEL_KEYS` / `parseEntryList`),
// which stays private to `parse-verdict.mjs`. That machinery's terminator
// predicate names `brain-review/N`'s OWN column-0 keys, and slice 1 of #473
// has exactly ONE consumer of these primitives that needs a list — none:
// `brain-decision/1` carries no list field yet (proposal D6, deferred). A
// generic terminator parameterized for a single caller is a guard whose
// red-proof is blind by SITE (no second instance to disagree with it) — see
// `brain/core/anti-patterns/red-proof-blind-along-an-unvaried-axis.md` §7.
// When a second protocol needs a list, extract
// `makeEntryListParser({ topLevelKeys })` then — not before.

// The closing fence must START A LINE (issue #487).
//
// It used to be `/```(?:yaml)?\s*\n([\s\S]*?)```/` — non-greedy, with no anchor on the
// terminator — so the FIRST ``` appearing anywhere, including in the middle of a value,
// ended the block. `reviewer-protocol.md:187` defines evidence as a command the reviewer
// actually ran cold, and command output is normally fenced, so the most ordinary shape of
// evidence produced a verdict that read back truncated. `checkpoint.mjs` interpolates raw
// `brain:audit` stdout into `evidence:`, so brain's own verdicts reached this path.
//
// The fix is in the LOCATOR, not the payload. Escaping ``` inside `yamlScalar` would work
// and would make the posted comment less readable for the human it exists to be read by —
// evidence that has to be decoded is evidence nobody checks. Greedy would have been worse
// still: it swallows a LATER legitimate block.
//
// Why the anchor suffices: `yamlScalar` escapes `\n` (issue #481), so a fenced value is
// emitted on ONE physical line and its ``` is never preceded by a real newline. The
// terminator therefore cannot match inside a value at all — not "usually does not".
//
// The reader-side guarantee from #452 is preserved BY the anchor rather than despite it:
// an unterminated block now fails to match and `extractFencedBlock` answers `null`. A
// confident truncated prefix — the end state rounds 2 and 3 of PR #478 closed, reached
// here through a third door — is no longer reachable from this regex.
export const FENCE_RE = /```(?:yaml)?[ \t]*\r?\n([\s\S]*?\r?\n)```[ \t]*(?:\r?\n|$)/;

/** Returns the content of the FIRST fenced block in `body`, or `null` if
 * none is found. Only the first fence is ever read — a stale block quoted
 * above a fresh one is not addressed by a later reader (design.md §E2 rule 17,
 * same discipline as `parseVerdict`'s own single-fence read). */
export function extractFencedBlock(body) {
  const m = body.match(FENCE_RE);
  return m ? m[1] : null;
}

/** Reads `key: value` from a fenced-YAML block. Three states, three
 * answers (#612): a real value returns the trimmed capture; a bare key
 * (`key:`) or a key line carrying ONLY whitespace after the colon
 * (`key: `, `key:\t`) returns `null` — whitespace-only is the ABSENT
 * state, never an empty-string value. The capture is anchored on `\S` so
 * no leading-whitespace start position exists for it to backtrack into;
 * `[ \t]*` (horizontal-only, NOT `\s*`) is what lets the capture skip
 * ordinary indentation without also eating the `\n` that would otherwise
 * let it bleed into the next line under the `m` flag (design.md §D-B). */
export function scalar(block, key) {
  const m = block.match(new RegExp(`^${key}:[ \\t]*(\\S.*)$`, 'm'));
  return m ? m[1].trim() : null;
}

// THE decoder for `verdict.mjs`'s `yamlScalar` — its exact inverse, and the
// ONLY one. Both `unyamlScalar` and `parseJsonScalar` below delegate here.
//
// There used to be two (issue #452, found by the fourth cold review of PR #478
// while it was tracing the consequence into board.mjs's label writes). When
// #481 taught the encoder to escape line terminators, only the entry-field
// reader learned to decode them; the JSON reader kept a generic `\X -> X`
// strip, which turns the `\u2028` escape into the literal text `u2028`:
//
//   in : seq:blocked-on<U+2028>411
//   out: seq:blocked-onu2028411
//
// `sequencing` is the one member of this family with a DESTRUCTIVE live
// consumer — board.mjs reconciles labels by name, so a corrupted name puts the
// real label in `toRemove` and a fabricated one in `toAdd`. One emitter must
// have exactly one inverse; two decoders is the defect, not the escape.
export function decodeYamlEscapes(inner) {
  return inner.replace(/\\(u2028|u2029|.)/g, (_, c) =>
    (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 'u2028' ? '\u2028' : c === 'u2029' ? '\u2029' : c));
}

// Reverses verdict.mjs's `yamlScalar(JSON.stringify(...))` encoding: strips
// the outer quotes (if present) and un-escapes `\X` -> `X` (covers both
// `\\` -> `\` and `\"` -> `"`, the only two escapes yamlScalar ever
// produces), then JSON.parses the result. Never throws — an unparseable
// scalar (hand-edited comment, corruption) yields `null`, tolerated by the
// caller (board.mjs treats an absent/unparseable sequencing as "nothing to
// reconcile from this block", never a crash).
export function parseJsonScalar(raw) {
  try {
    const unquoted =
      raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"'
        ? decodeYamlEscapes(raw.slice(1, -1))
        : raw;
    return JSON.parse(unquoted);
  } catch {
    return null;
  }
}

// Reverses verdict.mjs's `yamlScalar()`: a value it had to quote comes back with
// its outer quotes stripped and its escapes decoded; an unquoted scalar is
// already literal.
//
// `\n` and `\r` decode to the CHARACTERS, not to the letters (issue #481).
// yamlScalar escapes line breaks so a multi-line value cannot terminate the
// findings list mid-way; the generic `\X -> X` rule this used to apply would
// have turned that escape into a bare "n" and lost the newline a different way.
// Every other escape keeps the generic rule, which covers yamlScalar's `\\` and
// `\"` — and, because backslashes are escaped on the way out, `\\n` still decodes
// to a literal backslash followed by "n" rather than to a newline.
export function unyamlScalar(raw) {
  const s = raw.trim();
  if (!(s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"')) return s;
  return decodeYamlEscapes(s.slice(1, -1));
}
