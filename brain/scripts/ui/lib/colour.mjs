// colour.mjs — (roadmap.value.state, node.status) -> CSS class (R881-6,
// D9-note). Pure, imported by the browser AND by node:test (D9): it cannot
// import `PLANNED`/`READY`/etc. from `status/*.mjs`, so the STRING VALUES
// are repeated here as literals; `colour.test.mjs` imports the real
// constants and asserts every one still maps to a defined class — a
// renamed constant fails that test instead of quietly painting a node grey.
//
// Priority, highest first (R881-6):
//   1. `node.status === 'unreadable'` — the issue body could not be read.
//   2. `roadmap.ok === false` — "not computed", MUST NOT read as `planned`.
//   3. an open `blockedBy` — the blocked mark, overrides the state colour.
//   4. `node.status === 'awaiting-human'` — the RFC's awaiting-review mark.
//   5. otherwise, `roadmap.value.state` (`planned` / `in-flight` / `done`).
// `node.status === 'unclassified'` (no declaring source at all) gets its
// own mark rather than falling through to a roadmap state that describes a
// node nothing ever placed.

import { stateOf, STATES } from './state-vocab.mjs';

// Since #998 the table lives in state-vocab.mjs (code + word + mark + class);
// this module is the class-only view of it, kept so every caller and test of
// colourClass() keeps working unchanged.
export const NOT_COMPUTED_CLASS = STATES['not-computed'].className;

/**
 * colourClass(node) -> a CSS class name. Never returns undefined for a known
 * constant — an unknown value throws rather than degrading to an unlabelled
 * grey node (never empty-on-failure).
 *
 * @param {{status:string, blockedBy?:number[], roadmap:{ok:boolean,value?:{state:string},reason?:string}}} node
 */
export function colourClass(node) {
  return stateOf(node).className;
}
