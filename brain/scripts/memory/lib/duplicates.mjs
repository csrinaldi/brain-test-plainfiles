// duplicates.mjs — the duplicate-line RULE for the durable record store
// (issue #574), and the operator report that makes it audible.
//
// ── The two failure modes of a content-addressed store ──────────────────────
//
//   1. a line whose bytes no longer hash to its `id`  → TAMPER.
//      `rebuildIndex()` has REFUSED this since issue #214, naming file:line.
//   2. the same `id` on more than one physical line   → DUPLICATE.
//      `rebuildIndex()` keys its Map by `id`, so it collapsed them and said
//      nothing. Measured on `main` when this was written: 2177 physical lines,
//      2038 unique ids, 49 repeated ids, 139 excess lines — an index 139
//      entries shorter than the store, reported by no one, on a path where
//      `brain:memory:share` printed nothing at all.
//
// One mode was guarded and the other was mute, and the mute one is the one
// git merges produce.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//
//   A repeated `id` is DEDUPLICATED AND REPORTED — never refused.
//   When the repeated lines DISAGREE, the disagreement is reported SEPARATELY
//   and by name, and resolved deterministically: FIRST WINS (oldest month file,
//   earliest physical line) — the same resolution the fail-open reader uses, so
//   the index and the hydration path can never disagree about which line won.
//
// Refusal keeps the scope it always had: a line whose bytes do not hash to its
// own `id`. That check is untouched.
//
// ── Why deduplicate-and-report, and not refuse ──────────────────────────────
//
// ADR-0017 fixes `merge=union` as the transport for `records/*.jsonl`
// (`.gitattributes`, REQ-MF-3). When two branches both hold the same record, a
// git merge concatenates both copies BY CONSTRUCTION — that is not a
// malfunction, it is the mechanism working. Refusing would turn the
// designed-for, conflict-free path into a hard failure: `brain:memory:reindex` — the
// very command doctrine prescribes for finishing a merge (adr-0017:121-129) —
// would refuse to run right after an ordinary merge, and `share`, `pull`,
// `save` and `setup` would go down with it, since every one of them reindexes.
// Git is the transport, and a transport's normal output cannot be an error.
// ADR-0017 already ruled on this in its own words: "union can leave a rare
// duplicate physical line until the next reindex … Accepted — the alternative
// (rewriting the JSONL) breaks append-only and union safety."
//
// The asymmetry with the tamper path is about INFORMATION, not severity:
//
//   * a tampered line is a record NO producer could have written — the store
//     cannot say which bytes are true, so it must refuse;
//   * a repeated identical line is a record EVERY producer could have written
//     twice — the store knows exactly what it means, and collapsing it loses
//     nothing.
//
// Refuse where the truth is unknowable; report where it is merely redundant.
// What the silent version got wrong was never the collapse — it was the
// silence.
//
// ── The third failure mode: a DISAGREEING duplicate ─────────────────────────
//
// ADR-0017 says the duplicate lines "are byte-identical and share an `id`", so
// the index "collapses them losslessly". That holds only while the repeated
// lines carry equal information — and `id` does NOT hash `source`
// (format.mjs#computeRecordId excludes it as incidental provenance). Two lines
// can therefore share an `id`, each pass the id-integrity check on its own, and
// still disagree. Collapsing THOSE in silence is a last-wins DROP, and it is a
// distinct failure mode that deserves its own line in the report.
//
// It is reported, and NOT refused. The first draft of this rule refused it, on
// the reasoning that the store "cannot say which line is true" — the tamper
// argument. That reasoning was wrong on the facts, and the counter-example is
// brain's own round-trip:
//
//   * `renderFuente` (provenance.mjs) PREPENDS `issue #N` to a `source` that
//     does not already cite the issue, so a record exported → imported →
//     exported comes back with the same `id` and a widened `source`. Measured:
//     `"PR #405"` → `"issue #405 / PR #405"`, same id, different bytes.
//   * That widening is not a bug. `memory-format.md` excludes `source` from the
//     hash precisely so it "must not split one logical record into two ids when
//     two writers cite it slightly differently". Refusing the pair turns the
//     scenario the exclusion EXISTS to tolerate into a hard store-wide failure —
//     strictly worse than the split the doc forbids.
//
// So a disagreeing pair is NOT "a record no producer could have written" — it is
// a record brain's own producers write, which is the exact test this module uses
// to separate the tamper family from the transport family. And refusing it would
// have been a new READ-path rejection over `.memory/**`, which is consumer-owned
// (managed-paths.mjs's `local` array) and therefore un-migratable by brain — the
// precise class format.mjs's header exists to prohibit: "one rejected line makes
// a whole store unreadable … brain cannot migrate what a new read rule would
// break." One `--issue`-carrying record round-tripped on a second machine would
// have bricked `reindex`, `share`, `pull`, `save`, `setup` and `resolve-index`
// at once, on an append-only log with no repair verb.
//
// The resolution is therefore the one the store already had an answer for:
// FIRST WINS, deterministically (month files read in sorted order, lines in
// order), which is what `store.mjs#readRecords` does on the hydration path. The
// index and the reader now agree by construction instead of by coincidence.
// Reporting it is what this ticket was actually about.
//
// ── Strings ─────────────────────────────────────────────────────────────────
//
// Issue #638: the operator text used to live here as literals rather than as
// `memory.duplicates.*` keys in `brain/scripts/i18n/{en,es}.mjs`, on the
// reasoning that issue #574 claimed `brain/scripts/memory/**` and only that.
// The file claim was real, but it made this the one `docs.language: "es"`
// surface that answers in English regardless — `coverage.test.mjs` enforces
// parity for keys that EXIST, and a literal that never became a key is
// invisible to it. Promoted here, mechanically: same English bytes, `es`
// translations added, `formatDuplicateReport()` now async because `t()` is.
//
// Other operator notices still carry their text inline elsewhere in this tree
// (`engram.mjs`'s manifest-restore and symlink lines, `cli.mjs`'s dispatch
// errors) — #638 promotes only this module's strings and leaves the
// inline-vs-catalog rule for the rest of the tree to a follow-up decision.

import { t } from '../../i18n/t.mjs';

/** The zero accounting — the shape every caller sees when nothing repeats. */
export function emptyDuplicates() {
  return { ids: 0, lines: 0, divergent: 0, groups: [] };
}

/**
 * summarizeDuplicates() — fold a per-id occurrence map into the accounting.
 * Only ids seen more than once become groups; `lines` counts EXCESS physical
 * lines (occurrences − 1 per id), which is the number the index is shorter
 * than the store by. `divergent` counts the subset of those ids whose lines do
 * not carry equal information — reported on its own line, because it is a
 * different fact about the store than a plain repeat.
 *
 * @param {Map<string, string[]>} occurrencesById  id → ['<file>:<line>', …]
 * @param {Set<string>} [divergentIds]  ids whose repeated lines disagree
 * @returns {{ids: number, lines: number, divergent: number,
 *   groups: Array<{id: string, occurrences: string[], divergent: boolean}>}}
 */
export function summarizeDuplicates(occurrencesById, divergentIds = new Set()) {
  const groups = [...occurrencesById.entries()]
    .filter(([, occurrences]) => occurrences.length > 1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, occurrences]) => ({ id, occurrences: [...occurrences], divergent: divergentIds.has(id) }));
  return {
    ids: groups.length,
    lines: groups.reduce((total, g) => total + g.occurrences.length - 1, 0),
    divergent: groups.filter((g) => g.divergent).length,
    groups,
  };
}

/**
 * normalizeDuplicates() — tolerate a caller (or an injected `_rebuildIndex`
 * seam) that predates this accounting and returns only `{count}`. Absent
 * accounting means "nothing was measured", which reports as zero — never as a
 * crash, and never as a fabricated non-zero.
 *
 * @param {unknown} value
 * @returns {{ids: number, lines: number, divergent: number, groups: object[]}}
 */
export function normalizeDuplicates(value) {
  if (value === null || typeof value !== 'object') return emptyDuplicates();
  const groups = Array.isArray(value.groups) ? value.groups : [];
  const lines = Number.isInteger(value.lines)
    ? value.lines
    : groups.reduce((total, g) => total + Math.max(0, (g?.occurrences?.length ?? 1) - 1), 0);
  return {
    ids: Number.isInteger(value.ids) ? value.ids : groups.length,
    lines,
    divergent: Number.isInteger(value.divergent) ? value.divergent : groups.filter((g) => g?.divergent).length,
    groups,
  };
}

const MAX_GROUPS = 10;
const MAX_OCCURRENCES = 6;

/**
 * formatDuplicateReport() — the operator-facing lines for a duplicate
 * accounting. Returns `[]` when nothing repeats, so a caller can `for (const
 * line of report) log(line)` unconditionally and stay quiet on a clean store.
 *
 * Prints the counts FIRST (the numbers #574 asked for) and the locations
 * second, capped — a store with 49 repeated ids must not bury the summary under
 * its own evidence. A divergent group is marked inline and gets its own summary
 * line, because "the store holds this record twice" and "the two copies
 * disagree" are different facts and only the second needs a human.
 *
 * `surface` names what the repeats were collapsed INTO, so the verbs that never
 * touch the index (`search`) do not claim they did.
 *
 * `brief` drops the per-id evidence and keeps the counts, for the query verbs:
 * a `search` that matched nothing should not answer with twelve lines about the
 * store's history. The counts still travel — `brain:memory:reindex` prints the
 * locations — so brevity never becomes silence.
 *
 * Issue #638: every line is now a `memory.duplicates.*` catalog key (`t()` is
 * async, so this function is too) — `docs.language: "es"` answers in Spanish
 * for this surface exactly as it already does for `memory.reindex.*` and
 * `memory.share.*`. English bytes are unchanged; see duplicates.test.mjs.
 *
 * @param {{ids: number, lines: number, divergent: number, groups: object[]}} duplicates
 * @param {{indexCount?: number, surface?: string, brief?: boolean}} [opts]
 * @returns {Promise<string[]>}
 */
export async function formatDuplicateReport(duplicates, { indexCount, surface = 'the index', brief = false } = {}) {
  const { ids, lines, divergent, groups } = normalizeDuplicates(duplicates);
  // `divergent` is in the gate too: it is the channel this ticket added, so it
  // is the last thing that may be silent. A half-filled accounting reaching
  // here with only a divergence count would otherwise print nothing.
  if (ids === 0 && lines === 0 && divergent === 0) return [];

  const summary = indexCount === undefined
    ? await t('memory.duplicates.summary', { ids, lines, surface })
    : await t('memory.duplicates.summaryWithIndex', { ids, lines, surface, total: indexCount + lines, indexCount });

  const out = [summary, await t('memory.duplicates.why', { lines })];

  if (divergent > 0) {
    out.push(await t('memory.duplicates.divergent', { count: divergent }));
  }

  if (brief) {
    out.push(await t('memory.duplicates.brief'));
    return out;
  }

  for (const g of groups.slice(0, MAX_GROUPS)) {
    // `?? []`, matching normalizeDuplicates' own guard on the same field. This
    // function is called from INSIDE cli.mjs's try blocks, so a throw here does
    // not merely lose the report — it turns an already-completed `save` into
    // `plainfiles.save() failed …` and exit 1, with the record durably on disk.
    // A reporter may never be the thing that fails the operation it reports on.
    const occurrences = Array.isArray(g?.occurrences) ? g.occurrences : [];
    const shown = occurrences.slice(0, MAX_OCCURRENCES).join(', ');
    const more = occurrences.length > MAX_OCCURRENCES
      ? await t('memory.duplicates.moreOccurrences', { count: occurrences.length - MAX_OCCURRENCES })
      : '';
    const id = g?.id ?? await t('memory.duplicates.unknownId');
    const key = g?.divergent ? 'memory.duplicates.groupDivergent' : 'memory.duplicates.group';
    out.push(await t(key, { id, count: occurrences.length, locations: `${shown}${more}` }));
  }
  if (groups.length > MAX_GROUPS) {
    out.push(await t('memory.duplicates.moreGroups', { count: groups.length - MAX_GROUPS }));
  }
  return out;
}
