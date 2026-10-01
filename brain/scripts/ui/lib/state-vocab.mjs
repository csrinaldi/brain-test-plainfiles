// state-vocab.mjs — the ONE table of node states (#998 R998-1): code, word,
// mark and CSS class, in colour.mjs's priority. Pure, imported by the browser
// and by node:test (D9), so the status and roadmap strings are literals here;
// `state-vocab.test.mjs` imports the real constants and pins every one.
//
// A state is colour + mark + word so no reader depends on colour alone. The
// marks are the design's glyphs; `unknown` is the renderer's own output when
// this table throws on a status it has never heard of — that throw is
// deliberate (never empty-on-failure) and the per-node guard turns it into a
// said `unknown`, distinct from `not-computed`, which is a roadmap that said
// it could not be computed.

export const UNKNOWN_CODE = 'unknown';

export const STATES = Object.freeze({
  unreadable: Object.freeze({ code: 'unreadable', label: 'Unreadable', mark: '⚠', className: 'status-unreadable' }),
  'not-computed': Object.freeze({ code: 'not-computed', label: 'Not computed', mark: '—', className: 'roadmap-not-computed' }),
  blocked: Object.freeze({ code: 'blocked', label: 'Blocked', mark: '⊘', className: 'status-blocked' }),
  'awaiting-review': Object.freeze({ code: 'awaiting-review', label: 'Awaiting review', mark: '◇', className: 'status-awaiting-review' }),
  // The code is the data's word (`unclassified`, epic-graph.mjs); the label is
  // the screen's word (ruling 5 of 2026-09-16). One mapping, here.
  unclassified: Object.freeze({ code: 'unclassified', label: 'Undeclared', mark: '?', className: 'status-unclassified' }),
  planned: Object.freeze({ code: 'planned', label: 'Planned', mark: '○', className: 'state-planned' }),
  'in-flight': Object.freeze({ code: 'in-flight', label: 'In flight', mark: '◐', className: 'state-in-flight' }),
  done: Object.freeze({ code: 'done', label: 'Done', mark: '●', className: 'state-done' }),
  [UNKNOWN_CODE]: Object.freeze({ code: UNKNOWN_CODE, label: 'Unknown state', mark: '✕', className: 'node-unknown' }),
});

export const STATE_CODES = Object.freeze(Object.keys(STATES));

// The statuses the graph can emit (epic-graph.mjs) and the roadmap states the
// snapshot can emit (snapshot.mjs). `ready` and `blocked` carry no class of
// their own: a ready node takes its roadmap state, and "blocked" is decided by
// an OPEN blocker in `blockedBy`, not by the status word.
const KNOWN_STATUS = new Set(['ready', 'blocked', 'awaiting-human', 'unclassified', 'unreadable']);
const ROADMAP_STATE_CODE = { planned: 'planned', 'in-flight': 'in-flight', done: 'done' };

/**
 * stateOf(node) -> {code, label, mark, className}. Throws on a status or a
 * roadmap state this table does not know — a renamed constant fails the test
 * that imports the real ones instead of quietly painting a node grey.
 *
 * @param {{status:string, blockedBy?:number[], roadmap:{ok:boolean, value?:{state:string}}}} node
 */
export function stateOf(node) {
  if (node.status === 'unreadable') return STATES.unreadable;
  if (!node.roadmap || node.roadmap.ok !== true) return STATES['not-computed'];
  if (Array.isArray(node.blockedBy) && node.blockedBy.length > 0) return STATES.blocked;
  if (node.status === 'awaiting-human') return STATES['awaiting-review'];
  if (node.status === 'unclassified') return STATES.unclassified;
  if (!KNOWN_STATUS.has(node.status)) throw new Error(`state-vocab.mjs: unknown node status "${node.status}" — a constant was renamed, or a new status shipped without updating this table`);
  const code = ROADMAP_STATE_CODE[node.roadmap.value?.state];
  if (!code) throw new Error(`state-vocab.mjs: no state for roadmap "${node.roadmap.value?.state}" — a constant was renamed without updating this table`);
  return STATES[code];
}
