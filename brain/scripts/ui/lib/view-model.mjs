// view-model.mjs — the mode view and its router (#998 R998-2, retabled in
// #1059). Pure,
// imported by the browser and by node:test (D9): no DOM, no clock, no
// fetch. `app.js` owns turning what this module returns into elements and
// listeners; every decision — which mode is next, which node a keystroke
// selects — lives here.
//
// A "view" IS the current mode's id: there is nothing else to carry yet
// (PR 6 may add per-mode state; until then the id is the whole state).

/**
 * The modes, in the order they switch and the order Tab cycles.
 *
 * #1059 retabled these from four to three, on the maintainer's rule: a mode
 * is a question about the WHOLE PROJECT, and a question about one ticket
 * belongs in the panel that ticket opens. `Implementation slices` and
 * `Reviews` were per-ticket questions wearing a project-wide hat — the panel
 * already answers both for the ticket in front of you.
 *
 * Neither projection was thrown away. The project-wide verdict queue and the
 * project-wide slice plan are global facts, and global facts live under
 * Governance, so both moved there as sub-views rather than being deleted.
 * `memory` takes the freed place: the `.memory/records` ledger is as global
 * as governance is, and it had no home outside two governance sub-views that
 * each read a slice of it.
 */
// #1059 region 02: the glyph is the maintainer's design's own mark for each
// mode. It sits BESIDE the word, never instead of it — a mark alone would make
// the nav unreadable to anyone the glyph does not reach, which is the same
// rule `state-vocab.mjs` holds for a state.
export const MODES = Object.freeze([
  Object.freeze({ id: 'map', glyph: '\u25cf', label: 'Map & tracks' }),
  Object.freeze({ id: 'governance', glyph: '\u25a6', label: 'Governance' }),
  Object.freeze({ id: 'memory', glyph: '\u25c8', label: 'Memory' }),
]);

export const MODE_IDS = Object.freeze(MODES.map((mode) => mode.id));

/**
 * The said sentence a mode without content yet renders instead of an empty
 * area (never empty-on-failure). `map`, `sdd` and `reviews` are `null`:
 * `map` draws the existing canvas + drawer, `sdd` draws the seven-stage
 * matrix (#998 R998-4), `reviews` draws the timeline and verdict queue
 * (#998 R998-5). `governance` is `null` too, from #882 PR 1 on (R882-1):
 * it is a real mode with its own sub-router from that PR, even while some
 * of its five sub-views still show their own said placeholder —
 * `lib/governance-model.mjs`'s own `GOVERNANCE_PLACEHOLDERS` table.
 */
export const PLACEHOLDERS = Object.freeze({
  map: null,
  governance: null,
  memory: null,
});

/** The page before anything has been chosen: the first mode. */
export function initialView() {
  return MODES[0].id;
}

/**
 * switchMode(view, mode) -> the next view. `view` is accepted for symmetry
 * with `nextMode` (a future mode may validate a transition against where it
 * came from); today only the target is checked. Throws on a mode this
 * table does not know — a renamed id fails loudly instead of drawing a nav
 * button that goes nowhere.
 */
export function switchMode(view, mode) {
  if (!MODE_IDS.includes(mode)) {
    throw new Error(`view-model.mjs: unknown mode "${mode}" — a constant was renamed, or MODES is out of date`);
  }
  return mode;
}

/** nextMode(view) -> the mode Tab cycles to, wrapping past the last back to the first. */
export function nextMode(view) {
  const index = MODE_IDS.indexOf(view);
  if (index === -1) {
    throw new Error(`view-model.mjs: unknown mode "${view}" — cannot cycle from a mode this table does not know`);
  }
  return MODE_IDS[(index + 1) % MODE_IDS.length];
}

/** The drawn nodes, sorted top-to-bottom then left-to-right — how a reader's eye moves the canvas. */
function readingOrder(nodes) {
  return [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * traverse(key, nodes, selected) -> a `select` action, or `none` if there is
 * nothing to select. `j`/`k` always land on a node when one exists: past
 * either end the traversal wraps rather than stopping silently, so the
 * result always says which node it moved to.
 */
function traverse(key, nodes, selected) {
  if (nodes.length === 0) return { type: 'none' };
  const ordered = readingOrder(nodes);
  const index = ordered.findIndex((node) => node.number === selected);
  let nextIndex;
  if (index === -1) {
    nextIndex = key === 'j' ? 0 : ordered.length - 1;
  } else if (key === 'j') {
    nextIndex = (index + 1) % ordered.length;
  } else {
    nextIndex = (index - 1 + ordered.length) % ordered.length;
  }
  return { type: 'select', issue: ordered[nextIndex].number };
}

/**
 * keyAction(view, key, {nodes, selected}) -> {type, ...}. The only decision
 * a keystroke makes, with no DOM in sight: `app.js` executes what this
 * returns, it never re-derives it.
 *
 * @param {string} view the current mode id
 * @param {string} key the `KeyboardEvent.key` value
 * @param {{nodes?: Array<{number:number,x:number,y:number}>, selected?: number|null}} drawn what is currently on the canvas
 */
export function keyAction(view, key, { nodes = [], selected = null } = {}) {
  if (key === 'Tab') return { type: 'mode', mode: nextMode(view) };
  if (key === 'Escape') return selected === null ? { type: 'none' } : { type: 'close' };
  if (key === 'j' || key === 'k') return traverse(key, nodes, selected);
  return { type: 'none' };
}
