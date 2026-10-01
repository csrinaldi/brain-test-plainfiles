// search-model.mjs — #1059: the finder the maintainer asked for, so an epic,
// tracker or ticket can be found by typing a few characters instead of
// scrolling the graph. Pure, imported by the browser and by node:test (D9):
// no `node:` builtin, no clock, no random — every fact comes from
// `graphSection` (epic-graph.mjs's own `nodes` array, read through the
// accessor), never re-fetched or re-derived here.
//
// `kind` and `tracker` are declared node fields (#967) but are null on EVERY
// node in the running snapshot today — no issue body has written `kind:
// epic` yet (#1032 is the ticket that makes kind/parent/tracker real data).
// A finder that quietly filtered `kind === 'epic'` would therefore always
// return zero epics and look broken rather than honest, so this module
// checks the graph it was actually given: if nothing in it carries a kind or
// a tracker, `epicTrackerFacet` SAYS that plainly and names #1032, the same
// way lane-model.mjs's own `epicGrouping` field does for the identical
// reason. The check runs on the live data rather than being hardcoded to
// "always false" so the day #1032 ships, this module starts reporting real
// facets without anyone having to remember to come back and change it.

/**
 * The cap on rendered results (design decision, not the server's): a page
 * that rendered every match for a one-letter query would defeat the point
 * of a finder. `shown` and `total` are both returned so a reader always
 * sees whether the list in front of them is everything or a clipped head.
 */
export const RESULT_CAP = 20;

/**
 * Ranks, lowest wins. An exact issue-number hit is unambiguous — nothing
 * should ever rank ahead of it. A number PREFIX (typing "10" while looking
 * for #1059) is the next most deliberate act a reader can take. An exact
 * label or exact track is a deliberate facet lookup, tied with each other
 * and ranked ahead of substring text matches, which are the broadest and
 * least targeted way a query can hit.
 */
const RANK = Object.freeze({
  NUMBER_EXACT: 0,
  NUMBER_PREFIX: 1,
  LABEL_EXACT: 2,
  TRACK_EXACT: 2,
  TITLE_SUBSTRING: 3,
  LABEL_SUBSTRING: 4,
});

/**
 * Whether, and how, one node matches a normalized (trimmed, lower-cased,
 * leading-"#"-stripped) query. Returns the BEST rank the node earned plus
 * every dimension it matched by (deduped, alphabetical, so the result is
 * deterministic) — a node is never scored twice for matching the same
 * dimension in two ways.
 */
function matchNode(node, query, isNumeric) {
  const numStr = String(node.number);
  const title = typeof node.title === 'string' ? node.title.toLowerCase() : '';
  const track = typeof node.track === 'string' ? node.track.toLowerCase() : null;
  const labels = Array.isArray(node.labels) ? node.labels : [];

  const hits = [];
  if (isNumeric) {
    if (numStr === query) hits.push(['number', RANK.NUMBER_EXACT]);
    else if (numStr.startsWith(query)) hits.push(['number', RANK.NUMBER_PREFIX]);
  }
  if (track !== null && track === query) hits.push(['track', RANK.TRACK_EXACT]);
  if (labels.some((l) => typeof l === 'string' && l.toLowerCase() === query)) hits.push(['label', RANK.LABEL_EXACT]);
  if (title.includes(query)) hits.push(['title', RANK.TITLE_SUBSTRING]);
  if (labels.some((l) => typeof l === 'string' && l.toLowerCase().includes(query))) hits.push(['label', RANK.LABEL_SUBSTRING]);

  if (hits.length === 0) return null;
  hits.sort((a, b) => a[1] - b[1]);
  const matchedBy = [...new Set(hits.map((h) => h[0]))].sort();
  return { rank: hits[0][1], matchedBy };
}

/**
 * The card a result row renders. A node whose body could not be read
 * (`ok: false`) is still returned when it matches — dropping it would be
 * the exact `evidence-reader-empty-on-failure` anti-pattern this page
 * exists to avoid — with its own unreadable state carried as `reason`
 * rather than silently swallowed.
 */
function toResult(node, matchedBy) {
  const result = {
    number: node.number,
    title: typeof node.title === 'string' ? node.title : '',
    track: node.track ?? null,
    labels: Array.isArray(node.labels) ? [...node.labels] : [],
    // `forgeState`, NOT `state`. On a raw graph node from `epic-graph.mjs`
    // this field is the forge's own word — the string "open" or "closed" —
    // while every node `lane-model.mjs` builds carries a `state` OBJECT of
    // `{code, mark, label}` from `state-vocab.mjs`. Two different things under
    // one name in the same page is how `row.state.code` gets written and
    // throws at render; the name is the guard, because a comment warning
    // against the mistake still lets someone make it (#1059).
    forgeState: node.state ?? null,
    status: node.status ?? null,
    kind: node.kind ?? null,
    tracker: node.tracker ?? null,
    parent: node.parent ?? null,
    ok: node.ok !== false,
    matchedBy,
  };
  if (node.ok === false) {
    result.reason = node.reason ?? `issue #${node.number} could not be read; no reason was recorded on the node`;
  }
  return result;
}

/**
 * Whether the graph this call was given carries any real kind/tracker data
 * at all. Checked against the ACTUAL nodes passed in, not assumed, so the
 * facet degrades from "no data" to real facets the moment #1032 starts
 * shipping kind/tracker values without this module needing to change.
 */
function buildEpicTrackerFacet(nodes) {
  const anyKind = nodes.some((n) => n.kind != null);
  const anyTracker = nodes.some((n) => n.tracker != null);
  if (!anyKind && !anyTracker) {
    return {
      ok: false,
      reason: '"kind" and "tracker" are null on every node in this graph — no issue body has declared one yet. ' +
        '#1032 is the ticket that makes kind/parent/tracker real data; until it ships, find an epic or tracker ' +
        'by its title text (e.g. "epic") or its track instead.',
    };
  }
  const isKind = (n, word) => typeof n.kind === 'string' && n.kind.toLowerCase() === word;
  return {
    ok: true,
    value: {
      epics: nodes.filter((n) => isKind(n, 'epic')).map((n) => n.number).sort((a, b) => a - b),
      trackers: nodes.filter((n) => isKind(n, 'tracker') || n.tracker != null).map((n) => n.number).sort((a, b) => a - b),
    },
  };
}

/**
 * searchNodes(graphSection, query, {limit}) -> {ok:true, value:{query,
 * results, shown, total, cap, note, epicTrackerFacet}} | {ok:false, reason}
 *
 * A result row is `{number, title, track, labels, forgeState, status, kind,
 * tracker, parent, ok, matchedBy}` plus `reason` when `ok` is false.
 *
 * One query box over the graph's own nodes (#1059): matches by issue number
 * (exact and prefix), title substring, exact track, and exact-or-substring
 * label. Every node is scanned — nothing is filtered out of the search
 * space before matching runs, the same "no node is ever silently dropped"
 * rule lane-model.mjs holds for lanes — so an unreadable node is still
 * findable by number, and its unreadable state travels with the result
 * instead of vanishing.
 *
 * An empty or whitespace-only query is not treated as an error: it means
 * "nothing has been asked yet", so it returns zero results with a `note`
 * naming what to type, never a blank list with no explanation.
 *
 * Determinism: the same nodes, in any order, with the same query, produce a
 * byte-identical result list — ties are broken by ascending issue number.
 *
 * @param {{ok:boolean, value?:{nodes:Array}, reason?:string}} graphSection
 * @param {string} query
 * @param {{limit?:number}} [options] `limit` overrides the default result cap (`RESULT_CAP`).
 */
export function searchNodes(graphSection, query, options = {}) {
  if (!graphSection || typeof graphSection !== 'object') return { ok: false, reason: 'no graph section was given to the search' };
  if (graphSection.ok !== true) return { ok: false, reason: graphSection.reason };

  const nodes = Array.isArray(graphSection.value?.nodes) ? graphSection.value.nodes : [];
  const limit = Number.isInteger(options?.limit) && options.limit > 0 ? options.limit : RESULT_CAP;
  const epicTrackerFacet = buildEpicTrackerFacet(nodes);

  const rawQuery = typeof query === 'string' ? query : '';
  const trimmed = rawQuery.trim();
  const normalized = (trimmed.startsWith('#') ? trimmed.slice(1) : trimmed).toLowerCase();

  if (normalized === '') {
    return {
      ok: true,
      value: {
        query: rawQuery,
        results: [],
        shown: 0,
        total: 0,
        cap: limit,
        note: 'type an issue number, a word from the title, a track, or a label to search',
        epicTrackerFacet,
      },
    };
  }

  const isNumeric = /^\d+$/.test(normalized);
  const matches = [];
  for (const node of nodes) {
    const hit = matchNode(node, normalized, isNumeric);
    if (hit) matches.push({ node, rank: hit.rank, matchedBy: hit.matchedBy });
  }
  matches.sort((a, b) => a.rank - b.rank || a.node.number - b.node.number);

  const total = matches.length;
  const shown = Math.min(total, limit);
  const results = matches.slice(0, limit).map((m) => toResult(m.node, m.matchedBy));

  return {
    ok: true,
    value: {
      query: rawQuery,
      results,
      shown,
      total,
      cap: limit,
      note: total === 0 ? `no epic, tracker, or ticket matches "${rawQuery}"` : null,
      epicTrackerFacet,
    },
  };
}
