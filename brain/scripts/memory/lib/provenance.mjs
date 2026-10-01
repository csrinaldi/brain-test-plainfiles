// provenance.mjs — the §4 provenance grammar: ONE shared parser/renderer PAIR
// for the consolidation-protocol.md §4 prose convention (issue #217, C2).
//
// The three markers below are the SINGLE source of truth for the grammar —
// parseProvenance() and renderProvenance() both build their regexes/output
// from these same constants, never from two independently-typed "equivalent"
// literals (the same principle format.mjs applies to computeRecordId: one
// hasher, never a parallel one).
//
// Anchored to brain/core/methodology/consolidation-protocol.md §4:
//   **Actor:**     @crinaldi (humano)  |  claude-sonnet-4-6 (agente)
//   **Fuente:**    issue #78 / MR !72
//   **Supersede:** observación anterior "Spring prohibido"
//
// KNOWN FACT (verified against the real store, 2026-07): 0/278 real engram
// observations carry this prose — this pair exists for FUTURE first-class
// writers and the C4 round-trip contract, not as a description of the
// current store (see engram-export.mjs's fallback convention for that case).

export const ACTOR_MARKER = '**Actor:**';
export const FUENTE_MARKER = '**Fuente:**';
export const SUPERSEDE_MARKER = '**Supersede:**';

const ACTOR_KIND_TO_LABEL = { human: 'humano', agent: 'agente' };
const LABEL_TO_ACTOR_KIND = { humano: 'human', agente: 'agent' };

function escapeMarker(marker) {
  return marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ACTOR_LINE_RE = new RegExp(`^${escapeMarker(ACTOR_MARKER)}\\s*(\\S+)\\s*\\((humano|agente)\\)\\s*$`);
const FUENTE_LINE_RE = new RegExp(`^${escapeMarker(FUENTE_MARKER)}\\s*(.+)$`);
const SUPERSEDE_LINE_RE = new RegExp(`^${escapeMarker(SUPERSEDE_MARKER)}\\s*(.+)$`);
const ISSUE_IN_FUENTE_RE = /issue #(\d+)/;

/**
 * issueFromFuente() — the SINGLE rule for "which `issue` does this Fuente text
 * carry". Both halves of the pair use it: parseProvenance() to RECOVER the
 * field, and renderProvenance() to CHECK that the line it is about to emit
 * parses back to the record's own `issue`. Never two independently-typed
 * notions of "this text mentions the issue" — the same one-grammar discipline
 * this module's header declares for the markers themselves.
 *
 * @param {string|undefined} text  the Fuente line's text (marker already stripped)
 * @returns {number|undefined} the cited issue number, or `undefined` if none
 */
export function issueFromFuente(text) {
  const match = ISSUE_IN_FUENTE_RE.exec(text ?? '');
  return match ? Number(match[1]) : undefined;
}

/**
 * parseProvenance() — recover `{actor, actorKind, issue?, supersedes?, source?}`
 * from §4 prose, plus the CLEANED content (the provenance block + its one
 * blank-line separator removed).
 *
 * Provenance is ONLY the contiguous LEADING block of `content`
 * (consolidation-protocol.md §4: "Actor: First line of body") — never a
 * whole-content scan. This is a fixed-order state machine, not a per-line
 * regex scan: start at line 0, require an `**Actor:**` line first (its
 * absence means there is no provenance block at all), then optionally an
 * immediately-following `**Fuente:**` line, then optionally an
 * immediately-following `**Supersede:**` line. The first line that does not
 * continue this expected sequence ends the block; everything from that point
 * on — including the one blank-line separator `renderProvenance()` always
 * emits — is `content`, returned byte-for-byte unchanged. This makes the BODY
 * inert: a marker-shaped line inside the body (after the block has already
 * ended) is never scraped into a field, so `parse(render(record))` is
 * lossless even when the body itself contains `**Actor:**`/`**Fuente:**`/
 * `**Supersede:**`-shaped text.
 *
 * A `content` with no leading §4 prose returns every field `undefined` and
 * `content` unchanged — this is the expected shape for the current real
 * store (0/278 observations carry the prose; see engram-export.mjs's
 * fallback path).
 *
 * @param {string} content
 * @returns {{actor?:string, actorKind?:string, issue?:number, supersedes?:string,
 *            source?:string, content:string}}
 */
export function parseProvenance(content) {
  if (typeof content !== 'string') return { content };

  const lines = content.split('\n');
  const result = {};
  let idx = 0;

  const actorMatch = ACTOR_LINE_RE.exec(lines[idx] ?? '');
  if (!actorMatch) {
    // No leading Actor line — there is no provenance block at all (Actor
    // must be the first line of the block per §4). Content is untouched.
    return { content };
  }
  result.actor = actorMatch[1];
  result.actorKind = LABEL_TO_ACTOR_KIND[actorMatch[2]];
  idx += 1;

  const fuenteMatch = FUENTE_LINE_RE.exec(lines[idx] ?? '');
  if (fuenteMatch) {
    result.source = fuenteMatch[1].trim();
    const issue = issueFromFuente(result.source);
    if (issue !== undefined) result.issue = issue;
    idx += 1;
  }

  const supersedeMatch = SUPERSEDE_LINE_RE.exec(lines[idx] ?? '');
  if (supersedeMatch) {
    result.supersedes = supersedeMatch[1].trim();
    idx += 1;
  }

  // The block is followed by exactly one blank-line separator (the render
  // side always emits `\n\n` between the block and the body when any field
  // is present) — consume that ONE separator only, never more.
  if (lines[idx] === '') idx += 1;

  result.content = lines.slice(idx).join('\n');
  return result;
}

/**
 * fuenteText() — narrow a `source` to the ONE physical line the Fuente slot
 * can hold: its first line, trimmed; an empty result means "no text at all".
 *
 * This is a TOLERANT read, deliberately: `renderProvenance()` below composes
 * physical lines, so a `source` carrying a newline would spill its tail into
 * the BODY — displacing the issue citation off the Fuente line AND prepending
 * bytes to `content`, which IS hashed. Both are silent id drift. Normalizing
 * here makes the emitted block exactly the lines it intends for ANY input,
 * so no stored record can produce a corrupted round-trip.
 *
 * It is a read-side narrowing rather than a validator rejection on purpose:
 * `validateRecord()` is on the READ path (`parseRecordLine` throws on it), and
 * `.memory/**` is consumer-owned (`managed-paths.mjs`'s `local` array), so a
 * rejection there would make one bad line brick a whole consumer store that
 * brain has no way to migrate. The matching WRITE-side rule — brain never
 * *creates* a multi-line `source` — is `validateWritableRecord()` in
 * format.mjs, enforced by `appendRecord()`.
 *
 * `source` is hash-excluded, so narrowing it costs nothing the id contract
 * measures — the same reason widening it (below) is free.
 *
 * @param {string|undefined} source
 * @returns {string|undefined}
 */
function fuenteText(source) {
  if (source === undefined) return undefined;
  return source.split('\n')[0].trim() || undefined;
}

/**
 * renderFuente() — compose the Fuente line's text from BOTH structured
 * provenance fields it carries, `issue` and `source`.
 *
 * The asymmetry that governs this function: `issue` IS part of the record's
 * id hashInput (format.mjs#computeRecordId), `source` is NOT. So the line
 * this emits is only correct if `issueFromFuente()` maps it back to the
 * record's own `issue` — anything else silently changes the id on re-import
 * (issue #404). `source`, being hash-excluded, may round-trip lossily: a
 * prepended citation widens it and `fuenteText()` may narrow it, and neither
 * costs anything the contract measures.
 *
 * The three shapes (`source` here means `fuenteText(source)`):
 *   - no `issue`             → `source` verbatim (the whole real store today,
 *                              incl. the `@legacy` migration prose)
 *   - `issue`, no `source`   → `issue #N`
 *   - both                   → `source` untouched WHEN it already cites
 *                              exactly this issue (the canonical
 *                              `"issue #201 / PR #204"` shape of ADR-0017);
 *                              otherwise `issue #N / <source>`, which is that
 *                              same canonical shape, built.
 *
 * @param {{issue?:number, source?:string}} fields
 * @returns {string|undefined} the Fuente text, or `undefined` for no Fuente line
 */
function renderFuente({ issue, source }) {
  const text = fuenteText(source);
  if (issue === undefined) return text;
  if (text === undefined) return `issue #${issue}`;
  return issueFromFuente(text) === issue ? text : `issue #${issue} / ${text}`;
}

/**
 * renderProvenance() — the inverse of parseProvenance(): re-serialize a
 * record's structured provenance fields back into §4 prose, prepended to
 * `content`. Fields are rendered in Actor → Fuente → Supersede order,
 * matching the canonical convention. A record with no provenance fields at
 * all passes `content` through unchanged (no empty block, no stray blank
 * line).
 *
 * Round-trip note: `source` is the literal Fuente text; `issue` is a
 * structured extraction FROM that text on the parse side. renderFuente()
 * (above) yields this record's `issue` back, so
 * `parseProvenance(renderProvenance(record)).issue === record.issue` — for
 * every record whose `issue` is a `number`, which is what the schema declares
 * (memory-format.md). `source` may widen or narrow; it is hash-excluded and
 * free-form by design.
 *
 * The bound is stated rather than dropped because it is REAL: `validateRecord`
 * does not type-check `issue`, so `issue: "404"` (a string) is admitted on the
 * read path and comes back as the number `404` — a different `id`. Brain never
 * writes that shape (`validateWritableRecord`'s W2, enforced by
 * `appendRecord`), but a hand-edited store line can carry it. Claiming the
 * property for "every record the format admits" would be false, and a false
 * absolute in a module header is the exact defect issue #404 exists to correct.
 *
 * KNOWN-AMBIGUOUS, and NOT resolved here: a record with NO `issue` whose
 * `source` nonetheless cites `issue #N` emits a Fuente line byte-identical to
 * the one a record with `issue: N` emits, so re-import fabricates an `issue`
 * it never had. The shape is ambiguous ON THE WIRE — no renderer or parser
 * change fixes it alone; it needs either a new §4 marker or a validation rule.
 * Tracked as a decision, not patched here: issue #461.
 *
 * @param {{actor?:string, actorKind?:string, issue?:number, supersedes?:string,
 *          source?:string, content:string}} record
 * @returns {string}
 */
export function renderProvenance({ actor, actorKind, issue, supersedes, source, content }) {
  const lines = [];
  if (actor !== undefined && actorKind !== undefined) {
    const label = ACTOR_KIND_TO_LABEL[actorKind];
    if (!label) throw new Error(`renderProvenance: unknown actorKind '${actorKind}'`);
    lines.push(`${ACTOR_MARKER} ${actor} (${label})`);
  }
  const fuente = renderFuente({ issue, source });
  if (fuente !== undefined) {
    lines.push(`${FUENTE_MARKER} ${fuente}`);
  }
  if (supersedes !== undefined) {
    lines.push(`${SUPERSEDE_MARKER} ${supersedes}`);
  }
  if (lines.length === 0) return content;
  return `${lines.join('\n')}\n\n${content}`;
}
