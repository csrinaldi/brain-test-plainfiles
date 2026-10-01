// diff.mjs — section-level diff over two snapshots' top-level keys (Q5,
// #881). Pure: no IO, no clock, server-side only.
//
// `generatedAt` is excluded because it is a fresh ISO string on every
// recompute (`status/snapshot.mjs:273`), which would make every event
// "changed". `tier` is excluded because it is the constant `SNAPSHOT_TIER`,
// never a fact worth an event over.
//
// A changed section is returned IN FULL. Sub-section diffing (per node, per
// record) is rejected in design.md Q5: it needs a stable identity and a
// patch vocabulary on the client, a second contract to keep in sync with
// #879's shape, for no measured gain.

import { isDeepStrictEqual } from 'node:util';

const EXCLUDED_KEYS = new Set(['generatedAt', 'tier']);

/**
 * @param {object} previous the last snapshot this server held, or null/undefined for "none yet"
 * @param {object} next the freshly computed snapshot
 * @returns {Array<{name: string, section: unknown}>} one entry per top-level key whose value changed, in `next`'s key order, then keys that `previous` had and `next` does not, each with `section: null`
 */
export function diffSections(previous, next) {
  const changed = [];
  for (const name of Object.keys(next)) {
    if (EXCLUDED_KEYS.has(name)) continue;
    if (!isDeepStrictEqual(previous?.[name], next[name])) changed.push({ name, section: next[name] });
  }
  // A key the previous snapshot had and this one lacks is a change too. The
  // snapshot's key set is a fixed literal today (`status/snapshot.mjs`), so
  // this branch is unreachable until that changes — which is exactly when a
  // diff that only walked the new keys would have gone quiet.
  for (const name of Object.keys(previous ?? {})) {
    if (EXCLUDED_KEYS.has(name) || name in next) continue;
    changed.push({ name, section: null });
  }
  return changed;
}
