// theme.mjs — the viewer's own theme choice (#1059 phase 8). Pure, imported by
// the browser AND by node:test (D9).
//
// This is the page's FIRST piece of per-viewer state, and #998's ruling 4 had
// refused exactly that: "prefers-color-scheme, no toggle to persist", because
// a toggle would be state the read model does not hold. The maintainer
// reversed it on 2026-09-19, and the reconciliation is the distinction the
// original ruling did not draw: a viewing preference is about the READER, not
// about the project. It never reaches the repository, no other viewer sees it,
// and nothing on the page derives a fact from it — so it is not a second
// source of truth about anything brain records.

/** The three choices, in the order the control offers them. */
export const THEMES = Object.freeze([
  Object.freeze({ id: 'system', label: 'System' }),
  Object.freeze({ id: 'light', label: 'Light' }),
  Object.freeze({ id: 'dark', label: 'Dark' }),
]);

const IDS = new Set(THEMES.map((t) => t.id));

/**
 * normalizeTheme(stored) -> 'system' | 'light' | 'dark'
 *
 * Storage is a place a value can arrive from that this page never wrote: an
 * older version, another tab, a person editing it. Anything the page does not
 * know falls back to `system`, which is the viewer's own setting rather than
 * a colour scheme chosen for them.
 */
export function normalizeTheme(stored) {
  return typeof stored === 'string' && IDS.has(stored) ? stored : 'system';
}

/**
 * attributeFor(choice) -> 'light' | 'dark' | null
 *
 * What to stamp on the document element. `system` stamps NOTHING: the page
 * then follows `prefers-color-scheme`, which is what the word means. A stamp
 * of "system" would be a third theme the stylesheet does not have.
 */
export function attributeFor(choice) {
  const theme = normalizeTheme(choice);
  return theme === 'system' ? null : theme;
}
