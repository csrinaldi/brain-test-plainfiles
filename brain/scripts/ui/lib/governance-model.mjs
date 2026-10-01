// governance-model.mjs — the governance sub-nav table and the shared row
// helper every one of this ticket's view builders reuses (#882 R882-1).
// Pure, imported by the browser and by node:test (D9): no `node:` builtin,
// no clock, no random, no fetch.

import { sourceLabel, sourceStamp } from './provenance.mjs';

/** The five governance sub-views, in the order the issue body lists them — the whole sub-nav, drawn straight from this table (mirrors view-model.mjs's MODES for the four top-level modes). */
export const GOVERNANCE_VIEWS = Object.freeze([
  Object.freeze({ id: 'roadmap', label: 'Roadmap' }),
  Object.freeze({ id: 'decisions', label: 'Decisions' }),
  Object.freeze({ id: 'anti-patterns', label: 'Anti-patterns' }),
  Object.freeze({ id: 'history', label: 'History' }),
  Object.freeze({ id: 'actors', label: 'By actor' }),
  // #1059: both arrived from the top level, where they had been modes. A
  // project-wide verdict queue and a project-wide slice plan are facts about
  // the whole repository, not about the ticket in front of the reader, and
  // this is where facts about the whole repository live.
  Object.freeze({ id: 'queue', label: 'Verdict queue' }),
  Object.freeze({ id: 'slices', label: 'Implementation slices' }),
]);

export const GOVERNANCE_VIEW_IDS = Object.freeze(GOVERNANCE_VIEWS.map((view) => view.id));

/**
 * The said sentence a sub-view not yet built renders instead of an empty
 * area (never empty-on-failure), mirroring view-model.mjs's own
 * PLACEHOLDERS table for the four top-level modes. As of PR 5 (#882's
 * last slice, By actor), all five sub-views draw real content — every
 * entry is `null`. The table itself stays (`renderGovernance`'s router
 * still reads it as its own defensive fallback for a `governanceView`
 * outside `GOVERNANCE_VIEW_IDS`, which cannot happen today but costs
 * nothing to leave named), so a sixth sub-view added later has an obvious
 * place to say it is not built yet, the same way this one did.
 */
export const GOVERNANCE_PLACEHOLDERS = Object.freeze({
  roadmap: null,
  decisions: null,
  'anti-patterns': null,
  history: null,
  actors: null,
  queue: null,
  slices: null,
});

/**
 * row({title, detail, source, ...rest}) -> {title, detail, source, sourceStamp, ...rest}.
 * One entry shape reused by every governance view builder: `source` (the
 * plain label) and `sourceStamp` (the bracketed stamp) are both derived
 * from the SAME `source` input, through provenance.mjs's own shapers —
 * never a second provenance shaper for one value (R882-1).
 */
export function row({ title, detail, source, ...rest }) {
  return { title, detail, source: sourceLabel(source), sourceStamp: sourceStamp(source), ...rest };
}
