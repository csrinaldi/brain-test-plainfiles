// history-model.mjs — merges merge/release/adr-amended events newest-first
// (#882 R882-5). Pure, imported by the browser and by node:test (D9): no
// `node:` builtin, no clock, no random, no fetch.
//
// REVIEW VERDICTS ARE DELIBERATELY EXCLUDED FROM THIS MODEL (design.md's
// D-numbered decision). No field anywhere in the data carries a review
// round's timestamp — `prReviews` returns `{state, author, body}` only,
// `archive/881/design.md`'s D14 already established this for the Reviews
// tab — so a verdict cannot be placed on a real timeline without
// fabricating an order. History links to the Reviews mode instead of
// rendering a second, undated projection of the same rounds (the same
// "no second projection of the same values" ruling `archive/881/design.md`
// made for the design's rejected `sources` tab).

import { row } from './governance-model.mjs';
import { prUrl } from './forge-url.mjs';

/**
 * A commit's cited-reference URL, built only when BOTH a project and a
 * citation are known — never a fabricated link built from one alone.
 * Built through `lib/forge-url.mjs`'s own `prUrl` (fresh-context review of
 * PR 4, warning: one URL definition, not a second hand-built copy that can
 * drift). A trailing `(#N)` is a CITATION, not proof of a PR (blocker, same
 * review): this repo's own log mixes squash suffixes and hand-written
 * issue citations with no textual signal telling them apart, so nothing
 * here claims "PR" — the link is kept regardless, since issues and pull
 * requests share one forge numbering and the reference resolves to
 * whichever the number actually is. */
function commitSource(commit, project) {
  if (project && commit.citedRef) return { url: prUrl(project, commit.citedRef) };
  return { sha: commit.sha };
}

function commitEvent(commit, project) {
  // `malformed` travels to the event: the reader already said WHY a line could
  // not be split, and an event that dropped it showed an empty title with the
  // generic "date could not be parsed" instead — a reason stated in one layer
  // and lost in the next, for the third time in this chain (#1043 round 5).
  return row({ kind: 'commit', date: commit.date, title: commit.subject, citedRef: commit.citedRef, malformed: commit.malformed ?? null, source: commitSource(commit, project) });
}

/** A tag carries no per-event provenance beyond its own name (already the
 * event's title) — `source: null` renders through `sourceStamp` as the
 * one honest "no source was recorded" label, never a fabricated one. */
function releaseEvent(tag) {
  return row({ kind: 'release', date: tag.date, title: tag.name, malformed: tag.malformed ?? null, source: null });
}

function adrAmendedEvent(adr, amendment) {
  const title = adr.title ? `${adr.title} amended` : `${adr.path} amended`;
  return row({ kind: 'adr-amended', date: amendment.date, title, malformed: null, source: { path: adr.path } });
}

/** One event per ADR amendment that carries a date — an amendment with no
 * date is never placed on the timeline (never a fabricated position). An
 * unreadable `adrsSection` degrades to no adr-amended events at all, never
 * throwing — merge/release events from `history` stand on their own either
 * way (the same "one failed section never blanks another" discipline
 * `decisions-model.mjs`'s `driftWarningsOf` already established). */
function adrAmendedEvents(adrsSection) {
  if (!adrsSection?.ok) return [];
  const events = [];
  for (const adr of adrsSection.value ?? []) {
    if (!adr.ok || !Array.isArray(adr.amendments)) continue;
    for (const amendment of adr.amendments) {
      if (amendment?.date) events.push(adrAmendedEvent(adr, amendment));
    }
  }
  return events;
}

/** An event's own `Date.parse` epoch, or `null` when the date cannot be
 * parsed at all — never `NaN` allowed to leak into a comparator, where an
 * inconsistent (non-total) order silently misplaces the event (#1043 cold
 * review correction 1: a reviewer measured an event dated `'x'` sorting
 * ahead of one dated 2027, because `NaN - anything` is always `NaN`, and a
 * comparator returning `NaN` tells `Array#sort` nothing about order). */
function dateEpoch(date) {
  const t = Date.parse(date);
  return Number.isNaN(t) ? null : t;
}

/** A total, stable order: events with a parseable date sort newest-first;
 * events whose date cannot be parsed keep their relative order (stable
 * `.sort` + `.filter`, never re-shuffled) at the END of the list, each
 * carrying its OWN stated reason on `dateUnparseable` — never silently
 * sorted first (the `NaN` bug this replaces), never dropped (this repo
 * already refuses that anti-pattern elsewhere). A parseable event's
 * `dateUnparseable` is `null`, the same "state the absence" idiom every
 * other field in this ticket's models uses. */
function sortEventsByDateDesc(events) {
  const stamped = events.map((event) => ({ event, epoch: dateEpoch(event.date) }));
  const sortable = stamped.filter((s) => s.epoch !== null).sort((a, b) => b.epoch - a.epoch);
  const unsortable = stamped.filter((s) => s.epoch === null);
  return [
    ...sortable.map((s) => ({ ...s.event, dateUnparseable: null })),
    ...unsortable.map((s) => ({ ...s.event, dateUnparseable: `date ${JSON.stringify(s.event.date)} could not be parsed — kept at the end of the timeline` })),
  ];
}

/**
 * buildHistoryModel({history, adrs, project}) -> {ok:true, value:{events}} |
 * {ok:false, reason}. `history.ok === false` passes its reason straight
 * through — the merge/release events derive from it, so an unreadable
 * `history` fails the whole view. `adrs` degrades independently (see
 * `adrAmendedEvents`). `project` (an `owner/repo` string) is the only
 * source of the merge event's forge URL; with no project known, a commit
 * citing a number still becomes an event, sourced to git instead (never a
 * fabricated forge link).
 *
 * @param {{history?: {ok:boolean, value?:{commits:Array, tags:Array}, reason?:string},
 *   adrs?: {ok:boolean, value?:Array, reason?:string}, project?: string|null}} opts
 */
/**
 * `capNote(cap)` -> the sentence a reader needs, or `null` when there is
 * nothing to say.
 *
 * The commit list is capped (`gatherHistoryFacts` asks git for a fixed
 * number) while tags and ADR amendments are not, so an older release can
 * appear with no merges around it. Saying the cap is what keeps that from
 * reading as "nothing happened" (#1043 cold review, correction 2).
 *
 * It never claims a total this code did not read: with `total` unknown the
 * weaker sentence is the honest one, and under the cap there is nothing
 * partial to warn about at all.
 */
export function capNote(cap) {
  if (!cap || cap.reached !== true) return null;
  const n = cap.requested;
  // `git rev-list --count HEAD` counts what is REACHABLE FROM HEAD, which on a
  // shallow or detached checkout is not the branch's history — so the sentence
  // says what the number counts rather than implying a project total. And a
  // total equal to the cap carries no information at all (#1043 round 2).
  // A shallow clone's count is the fetched depth, not the history, so the
  // sentence says that instead of quoting a number that understates it.
  if (cap.shallow === true) return `the newest ${n} commits of a shallow checkout; how much history exists is not readable here`;
  // A known total equal to the cap rules out anything older: claiming the
  // opposite would be a small untruth the data itself disproves. An UNKNOWN
  // total still warns, because it rules nothing out (#1043 round 5).
  if (typeof cap.total === 'number' && cap.total <= n) return null;
  return typeof cap.total === 'number' && cap.total > n
    ? `the newest ${n} commits of ${cap.total} reachable from HEAD`
    : `the newest ${n} commits; older commits are not listed`;
}

/** An ADR amendment carries a DATE ('2026-09-18', which parses as UTC
 * midnight); a commit or a tag carries a time with an offset. So two events on
 * the same day of different kinds order by an accident of parsing rather than
 * by when they happened, and an order that looks deliberate and is not is the
 * quiet kind of wrong. The reader is told (#1043 round 4). */
export const SAME_DAY_NOTE = 'events on the same day are ordered by kind, not by time: an ADR amendment carries a date only, a commit or tag carries a time';

export function buildHistoryModel({ history, adrs, project = null } = {}) {
  if (!history || typeof history !== 'object') return { ok: false, reason: 'no history section was given to History' };
  if (history.ok !== true) return { ok: false, reason: history.reason };

  const { commits = [], tags = [], cap = null } = history.value ?? {};
  const events = sortEventsByDateDesc([
    ...commits.map((c) => commitEvent(c, project)),
    ...tags.map(releaseEvent),
    ...adrAmendedEvents(adrs),
  ]);

  return { ok: true, value: { events, cap, sameDayNote: SAME_DAY_NOTE } };
}
