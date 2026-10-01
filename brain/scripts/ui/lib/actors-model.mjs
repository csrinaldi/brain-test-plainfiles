// actors-model.mjs — merges the actors and reviews sections into one row
// per actor, humans and agents in the same table under the same schema
// (#882 R882-6). Pure, imported by the browser and by node:test (D9): no
// `node:` builtin, no clock, no random, no fetch.
//
// NOTHING HERE IS SCORED OR RANKED (issue #882's own "must NOT become"):
// rows sort by actor name, never by record count or review count. A
// forge-only reviewer with no memory record still gets a row (`actorKind:
// null`, the stated "kind unknown" reason) — one source must never be
// allowed to silently outrank the other. `reviewsPosted` always carries
// the open-PRs-only caveat verbatim: #880 (review rounds as records) is
// still open, so this count can only ever cover open PRs. `prsMerged` is
// NEVER a bare `0` — no VCS port verb returns a merged-PR list with an
// author (`mrList` is `{number, title, headBranch}`, `state:'open'` only),
// so every row states that absence in the same place a real count would
// render, rather than a silent zero that would read as "merged nothing."

import { row } from './governance-model.mjs';

/** The caveat every `reviewsPosted` count carries, stated once here so the
 * model and the renderer can never drift apart on what the number means
 * (the same single-source-of-truth idiom `decisions-model.mjs`'s
 * `ISSUES_LABEL` already established). */
export const REVIEWS_CAVEAT = 'source: forge review threads on open PRs only — a merged PR\'s rounds are not retained until #880 lands type: review records.';

/** The stated absence every row's `prsMerged` carries — never a fabricated
 * `0`, which would read as "merged nothing" rather than "not measured." */
export const PRS_MERGED_ABSENT = Object.freeze({ ok: false, reason: 'no data source today' });

const NO_RECORD_REASON = 'kind unknown — no record carries it yet';

/** `verdict.author` -> a running count, over every READABLE thread's
 * verdicts only. An unreadable thread (`{ok:false}`) contributes nothing —
 * the same "one failed section never blanks another" discipline every
 * other governance model in this ticket follows. Empty when `reviewsSection`
 * itself is not readable: the caller degrades that per row instead. */
function reviewCountsByAuthor(reviewsSection) {
  const counts = new Map();
  if (!reviewsSection?.ok) return counts;
  for (const thread of reviewsSection.value ?? []) {
    if (!thread?.ok) continue;
    for (const v of thread.verdicts ?? []) {
      const author = typeof v?.author === 'string' ? v.author : null;
      if (!author) continue;
      counts.set(author, (counts.get(author) ?? 0) + 1);
    }
  }
  return counts;
}

/** One row's `reviewsPosted` — a section-shaped value, exactly like every
 * other degraded field this ticket's models produce (`driftWarnings`,
 * R882-3; the finding pattern R882-6 itself names). `reviewsSection` being
 * unreadable is THIS field's own reason, never the whole view's. */
const NOT_ATTRIBUTABLE = 'not attributable: this name comes from the memory records and the forge never used it — the two namespaces are not reconciled, so a count here would be a guess';

function reviewsPostedOf(reviewsSection, actor, counts) {
  if (!reviewsSection || typeof reviewsSection !== 'object' || reviewsSection.ok !== true) {
    return { ok: false, reason: reviewsSection?.reason ?? 'no reviews section was given to By actor' };
  }
  // `counts` is keyed by the forge's own author logins. A name the forge never
  // used has no count in this data, and `?? 0` would turn that absence into a
  // claim — the same fabricated zero this file refuses for `prsMerged`, and
  // the reason the namespaces note exists at all (#1043 round 3).
  if (!counts.has(actor)) return { ok: false, reason: NOT_ATTRIBUTABLE };
  return { ok: true, count: counts.get(actor), caveat: REVIEWS_CAVEAT };
}

/**
 * buildActorsModel(actorsSection, reviewsSection) -> {ok:true, value:{rows}}
 * | {ok:false, reason}.
 *
 * One row per actor, keyed by name: every `actorsSection.value` row PLUS
 * every distinct `verdict.author` the reviews section names that
 * `actorsSection` does not already list (a forge-only reviewer, `actorKind:
 * null`, the stated "kind unknown" reason). Rows sort by actor name —
 * NEVER by record count or review count (no ranking, R882-6). Every row
 * goes through `governance-model.mjs`'s own `row()` helper with `source:
 * null` (an aggregated actor row names no single file or URL of its own —
 * `row(null)` states that honestly, the same choice `history-model.mjs`
 * made for a release event with no per-event provenance). An unreadable
 * `reviewsSection` degrades per row (`reviewsPosted: {ok:false, reason}`),
 * never blanking the rows an ok `actorsSection` still provides.
 *
 * @param {{ok:boolean, value?:Array<{actor:string, actorKind:string|null, records:number, byType:object, first:string|null, last:string|null}>, reason?:string}} actorsSection
 * @param {{ok:boolean, value?:Array<{pr:number, ok:boolean, verdicts?:Array<{author:string|null}>, reason?:string}>, reason?:string}} reviewsSection
 */
/** A record names its actor in brain's own namespace (`@someone`); a review
 * names its author in the forge's (`someone`). They are not the same string
 * and nothing in this data maps one to the other, so a row backed only by a
 * forge login may be a person who already has a row under their record id.
 * The model does NOT guess a mapping — inventing one would merge two people
 * as easily as it would join one. It says what the row is evidence of, so a
 * reader never counts the same human twice without knowing it could be the
 * same human (#1043 cold review, correction 3). */
const FORGE_ONLY_EVIDENCE = 'evidence: a forge review login, not reconciled with the memory records\' actor names — this may be a person who also appears under their record id';

export function buildActorsModel(actorsSection, reviewsSection) {
  if (!actorsSection || typeof actorsSection !== 'object') return { ok: false, reason: 'no actors section was given to By actor' };
  if (actorsSection.ok !== true) return { ok: false, reason: actorsSection.reason };

  const byActor = new Map();
  for (const a of actorsSection.value ?? []) {
    byActor.set(a.actor, {
      actor: a.actor,
      actorKind: a.actorKind ?? null,
      actorKindReason: null,
      records: a.records,
      byType: a.byType,
      first: a.first,
      last: a.last,
    });
  }

  const counts = reviewCountsByAuthor(reviewsSection);
  for (const author of counts.keys()) {
    if (byActor.has(author)) continue;
    byActor.set(author, { actor: author, actorKind: null, actorKindReason: NO_RECORD_REASON, evidenceNote: FORGE_ONLY_EVIDENCE, records: 0, byType: {}, first: null, last: null });
  }

  const rows = [...byActor.values()]
    .map((a) => row({
      source: null,
      actor: a.actor,
      actorKind: a.actorKind,
      actorKindReason: a.actorKindReason,
      evidenceNote: a.evidenceNote ?? null,
      records: a.records,
      byType: a.byType,
      first: a.first,
      last: a.last,
      reviewsPosted: reviewsPostedOf(reviewsSection, a.actor, counts),
      prsMerged: PRS_MERGED_ABSENT,
    }))
    .sort((x, y) => x.actor.localeCompare(y.actor));

  return { ok: true, value: { rows } };
}
