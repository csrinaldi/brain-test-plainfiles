// memory-model.mjs — the global Memory view's read model (#1059 maintainer
// request: "the active memory records"). Pure, imported by the browser and
// by node:test (D9): no `node:` builtin, no `Date.now`, no `Math.random`, no
// `fetch`, no `innerHTML`. Every fact comes from `snapshot.records`
// (`status/snapshot.mjs`'s reader), never re-read here; "now" for any
// relative-time text is a caller-supplied argument, never the wall clock.
//
// DECISION — no by-actor breakdown here. `actor` on a record is USUALLY A
// BRANCH NAME (`feat/issue-266-...`), not a person; `@legacy` is the one
// named exception. A per-actor count on THIS view would read as "who did
// this work", which a branch name cannot honestly answer — the same branch
// prefix recurs across many people's checkouts, and one person opens many
// branches. `actors-model.mjs` already owns the governance "By actor" view,
// keyed the same way and reconciled against forge review logins with its
// own documented caveats; duplicating that here under a different name
// would give a reader two tables that look like they answer the same
// question and quietly do not. This model surfaces `actorKind` (human vs.
// agent) as a SUMMARY COUNT only — never a per-branch row.
//
// DECISION — empty vs. unreadable are two different facts and must not
// render the same (anti-pattern `evidence-reader-empty-on-failure`).
// `recordsSection.ok === false` means the section could not be READ at all
// — the model itself fails with that reason, exactly like every other
// builder in ui/lib/. Zero records inside an OK section is a real, readable
// state (no memory has been written yet, or a filter matched nothing
// upstream) — the model still returns `ok:true`, with `empty:true` and a
// stated `note` so a renderer never has to guess which of the two silences
// it is looking at.

import { row } from './governance-model.mjs';

/** The seven documented `type` values (task body), in this fixed order —
 * `countsByType` follows it so the summary reads the same way on every
 * render regardless of which types happened to appear first in the data.
 * A type this list does not name is never hidden (a record whose `type`
 * drifted from the documented vocabulary is exactly the kind of fact this
 * repo's other models refuse to swallow silently) — it is appended after
 * the canonical order, alphabetically, so two unlisted types still sort
 * deterministically against each other. */
const TYPE_ORDER = Object.freeze(['architecture', 'session_summary', 'discovery', 'decision', 'pattern', 'bugfix', 'config']);

/**
 * The row a record with no usable `type` lands in (#1067 cold review, finding
 * cold-2). It is NAMED rather than absorbed into an existing type or dropped,
 * which is the rule this module already held for `actorKind` — and it is a
 * string, which is the part that was missing: `countsBy` sorted the keys the
 * canonical order does not name with `localeCompare`, so a null or numeric
 * type threw and took the whole Memory view down over one malformed record.
 */
const NO_TYPE = '(no type declared)';

/** `actorKind` is `human` or `agent` today; a record with neither (or a
 * value neither test fixture nor live data has shown yet) counts as
 * `unknown` rather than being dropped from the summary — the same "state
 * the absence, never omit the row" discipline `actors-model.mjs` uses for
 * `actorKind: null`. */
const ACTOR_KIND_ORDER = Object.freeze(['human', 'agent', 'unknown']);

/** The default cap on the recent-first list (mirrors `search-model.mjs`'s
 * `RESULT_CAP` idiom exactly: a page that rendered all 2421 rows would not
 * be a "recent activity" panel, it would be the whole ledger). `shown` and
 * `total` both travel with the list so a reader always knows whether they
 * are looking at everything or a clipped head — never a silent truncation. */
export const MEMORY_RECENT_CAP = 50;

/** A record's own epoch, or `null` when `ts` cannot be parsed — never `NaN`
 * let loose in a comparator, where an inconsistent order silently misplaces
 * the record (the exact bug `history-model.mjs`'s `dateEpoch` was written to
 * rule out, #1043 cold review correction 1; duplicated here in miniature
 * rather than imported, since this module's "unparseable" field is named
 * `tsUnparseable` for records — a distinct field name from that module's
 * `dateUnparseable` for timeline events — and coupling two independently
 * evolving views to one shared helper for two lines is not worth the
 * coupling). */
function tsEpoch(ts) {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/** Newest-first, stable: records with a parseable `ts` sort by epoch
 * descending; records whose `ts` cannot be parsed keep their relative order
 * at the END of the list, each carrying its own `tsUnparseable` reason —
 * never dropped, never sorted first by an accidental `NaN` comparison. */
function sortRecordsByTsDesc(records) {
  const stamped = records.map((r) => ({ r, epoch: tsEpoch(r.ts) }));
  const sortable = stamped.filter((s) => s.epoch !== null).sort((a, b) => b.epoch - a.epoch);
  const unsortable = stamped.filter((s) => s.epoch === null);
  return [
    ...sortable.map((s) => ({ ...s.r, tsUnparseable: null })),
    ...unsortable.map((s) => ({ ...s.r, tsUnparseable: `ts ${JSON.stringify(s.r.ts)} could not be parsed — kept at the end of the list` })),
  ];
}

/** "1 d ago" / "3 h ago" / "5 min ago" / "40 s ago" — the same wording at
 * every scale, no library, mirroring `banners.mjs`'s own `ago()` (not
 * exported there, so duplicated here rather than reaching across a D9
 * boundary two views do not otherwise share). Extended with a day bucket:
 * this view's records span months (2026-06-26 to 2026-09-18 in the live
 * snapshot), where `banners.mjs`'s poll indicator only ever needs seconds
 * to hours. */
function ago(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

/** A recent row's `relativeTime` — `null` when no `now` was supplied (never
 * a fabricated age computed from the wall clock this module is forbidden
 * from reading), computed from the caller's clock otherwise. A record whose
 * own `ts` could not be parsed has no age to state either. */
function relativeTimeOf(ts, now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) return null;
  const epoch = tsEpoch(ts);
  if (epoch === null) return null;
  return ago(now - epoch);
}

/** One recent-list row, through `governance-model.mjs`'s own `row()` helper
 * — `source`/`sourceStamp` derived from the record's own `file`, the exact
 * convention `history-model.mjs`'s `commitEvent` and `actors-model.mjs`'s
 * rows already follow, never a second hand-rolled provenance shaper.
 * `title`/`detail` give a renderer a ready one-line card; `detail`'s
 * "actor (actorKind)" phrasing matches `drawer-model.mjs`'s existing
 * convention for the same two fields, so the same fact reads the same way
 * in both places on this page. */
function recentRow(r, now) {
  return row({
    title: r.type,
    detail: `${r.actor} (${r.actorKind ?? 'unknown'})`,
    source: { path: r.file },
    id: r.id,
    ts: r.ts,
    tsUnparseable: r.tsUnparseable,
    actor: r.actor,
    actorKind: r.actorKind,
    type: r.type,
    relativeTime: relativeTimeOf(r.ts, now),
  });
}

/** `countsByType`/`countsByActorKind` — computed over the FULL record set,
 * never just the capped recent list (rule: the summary leads the detail;
 * a summary that only covered 50 of 2421 rows would misstate the totals it
 * claims to summarize). `order` fixes the canonical prefix; any key that
 * order does not name is appended after it, alphabetically, so nothing an
 * unexpected value produces is ever silently absorbed into "other" or
 * dropped. */
function countsBy(records, keyOf, order) {
  const counts = new Map();
  for (const r of records) {
    const key = keyOf(r);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const known = order.filter((k) => counts.has(k)).map((k) => ({ key: k, count: counts.get(k) }));
  const extra = [...counts.keys()]
    .filter((k) => !order.includes(k))
    // `String(...)` on both sides, always: a key extractor that lets a
    // non-string through must not be able to throw here, because the throw
    // is not local — it destroys the whole view (#1067).
    .sort((a, b) => String(a).localeCompare(String(b)))
    .map((k) => ({ key: k, count: counts.get(k) }));
  return [...known, ...extra];
}

/**
 * The duplicate-id integrity signal (`recordsSection.value.duplicates`),
 * surfaced plainly rather than as a bare number (rule 3). Two records
 * sharing an id with DIVERGENT content is a real data-integrity problem —
 * the note names which ids and where, not just how many. A duplicate set
 * with no divergence still gets a stated sentence (never silence unless the
 * count really is zero — silence that isn't earned by a real zero is
 * exactly the `evidence-reader-empty-on-failure` anti-pattern rule 4 names).
 * Malformed or missing input degrades ONLY this field, never the whole
 * model — the same per-field degrade `actors-model.mjs`'s `reviewsPostedOf`
 * already establishes for a section that arrives broken beside good data.
 */
function buildDuplicates(dup) {
  if (!dup || typeof dup !== 'object') {
    return { ok: false, reason: 'no duplicates data was found alongside the records' };
  }
  const { ids, lines, divergent, groups } = dup;
  if (typeof ids !== 'number' || typeof lines !== 'number' || typeof divergent !== 'number' || !Array.isArray(groups)) {
    return { ok: false, reason: 'the duplicates block is malformed: expected {ids, lines, divergent, groups}' };
  }

  const shapedGroups = groups.map((g) => ({
    id: g?.id ?? null,
    divergent: Boolean(g?.divergent),
    occurrences: Array.isArray(g?.occurrences) ? [...g.occurrences] : [],
  }));
  const divergentGroups = shapedGroups.filter((g) => g.divergent);

  let integrityNote = null;
  if (ids > 0 && divergentGroups.length > 0) {
    const named = divergentGroups.map((g) => `${g.id} (${g.occurrences.join(', ')})`).join('; ');
    integrityNote = `${divergentGroups.length} of ${ids} duplicate id group(s) have DIVERGENT content — the same record id disagrees with itself: ${named}`;
  } else if (ids > 0) {
    integrityNote = `${ids} record id(s) appear more than once (${lines} duplicate line(s) total); none of the duplicate content diverges`;
  }

  return { ok: true, idsWithDuplicates: ids, totalDuplicateLines: lines, divergentCount: divergent, groups: shapedGroups, integrityNote };
}

/**
 * buildMemoryModel(recordsSection, options) -> {ok:true, value:{...}} |
 * {ok:false, reason}.
 *
 * `value` shape:
 *   - `totalRecords`: the full count, independent of any cap.
 *   - `recent`: `{shown, total, cap, records}` — newest-first, capped.
 *   - `countsByType` / `countsByActorKind`: arrays of `{key, count}` pairs
 *     (see `countsBy`'s renaming into `type`/`count` and
 *     `actorKind`/`count` below), computed over ALL records.
 *   - `duplicates`: the integrity signal, `{ok, ...}` shaped (see
 *     `buildDuplicates`) — degrades independently of the rest of the model.
 *   - `empty`: true only when `totalRecords === 0` inside an otherwise
 *     readable section.
 *   - `note`: the stated sentence for the empty case, `null` otherwise —
 *     "empty" and "unreadable" never render the same (rule 4).
 *
 * @param {{ok:boolean, value?:{records:Array, duplicates:object}, reason?:string}} recordsSection
 * @param {{now?:number, cap?:number}} [options] `now`: epoch ms for
 *   relative-time text (never read from the clock inside this module).
 *   `cap`: overrides `MEMORY_RECENT_CAP` for the recent list, mirroring
 *   `search-model.mjs`'s `options.limit` idiom.
 */
export function buildMemoryModel(recordsSection, options = {}) {
  if (!recordsSection || typeof recordsSection !== 'object') {
    return { ok: false, reason: 'no records section was given to Memory' };
  }
  if (recordsSection.ok !== true) return { ok: false, reason: recordsSection.reason };
  if (!Array.isArray(recordsSection.value?.records)) {
    return { ok: false, reason: 'the records section is malformed: no records array' };
  }

  const records = recordsSection.value.records;
  const total = records.length;
  const cap = Number.isInteger(options?.cap) && options.cap > 0 ? options.cap : MEMORY_RECENT_CAP;
  const now = options?.now;

  const sorted = sortRecordsByTsDesc(records);
  const shown = Math.min(total, cap);
  const recentRecords = sorted.slice(0, cap).map((r) => recentRow(r, now));

  const countsByType = countsBy(records, (r) => (typeof r.type === 'string' && r.type !== '' ? r.type : NO_TYPE), TYPE_ORDER)
    .map(({ key, count }) => ({ type: key, count }));
  const countsByActorKind = countsBy(records, (r) => r.actorKind ?? 'unknown', ACTOR_KIND_ORDER).map(({ key, count }) => ({ actorKind: key, count }));

  const empty = total === 0;

  return {
    ok: true,
    value: {
      totalRecords: total,
      recent: { shown, total, cap, records: recentRecords },
      countsByType,
      countsByActorKind,
      duplicates: buildDuplicates(recordsSection.value.duplicates),
      empty,
      note: empty ? 'no memory records exist in this snapshot' : null,
    },
  };
}
