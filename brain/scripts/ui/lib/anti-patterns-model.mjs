// anti-patterns-model.mjs — the anti-pattern catalogue, grouped by scope
// (#882 R882-4). Pure, imported by the browser and by node:test (D9): no
// `node:` builtin, no clock, no random, no fetch.
//
// AN UNREADABLE ENTRY IS KEPT IN PLACE (mirrors decisions-model.mjs's own
// rule for an unreadable ADR), sorted last within its own scope — no id to
// sort by, never dropped. `unlistable` is `antiPatterns.value.unlistable`,
// passed through verbatim: a scope whose directory could not be listed at
// all is its own said reason beside the OTHER scope's real rows, never
// rendered as "zero anti-patterns in that scope."

import { issueUrl } from './forge-url.mjs';
import { sourceStamp } from './provenance.mjs';
import { row } from './governance-model.mjs';

/** `core` before `project` — ANTI_PATTERN_DIRS' own declared order
 * (anti-patterns.mjs), restated here so this model's grouping cannot drift
 * from the reader's without both changing together. */
const SCOPE_ORDER = ['core', 'project'];
const scopeRank = (scope) => {
  const i = SCOPE_ORDER.indexOf(scope);
  return i === -1 ? SCOPE_ORDER.length : i;
};

const byScopeThenId = (a, b) => {
  const s = scopeRank(a.scope) - scopeRank(b.scope);
  if (s !== 0) return s;
  if (a.id === undefined) return b.id === undefined ? 0 : 1;
  if (b.id === undefined) return -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** One `antiPatterns.value.entries` item -> its catalogue row. A readable
 * entry goes through `governance-model.mjs`'s own `row()` helper, so its
 * `source`/`sourceStamp` are derived the same way every other governance
 * view derives them (R882-1) — never a second provenance shaper. `issues`
 * is deduplicated and sorted here as this model's own stated contract,
 * independent of whatever the reader already guaranteed. An unreadable
 * entry is kept in place, `{ok:false, path, scope, reason}` — no `id` to
 * sort by (rule zero: never dropped, sorted last within its own scope). */
function antiPatternRow(entry, project) {
  if (!entry.ok) return { ok: false, path: entry.path, scope: entry.scope, reason: entry.reason };
  // A cited ticket is a bare number in the catalogue's prose, so the stamp it
  // deserves depends on whether the page knows which project is served:
  // `issueUrl` (the SAME builder the roadmap rows use — #882 PR 1) makes it a
  // real link, and with no project the words stay exactly as they were rather
  // than claiming a link this view cannot back.
  const issueStamps = [...entry.issues].sort((a, b) => a - b).map((n) => (project
    ? sourceStamp({ url: issueUrl(project, n) })
    : { label: `[forge: #${n}]`, href: null, kind: 'forge' }));
  return row({
    issueStamps,
    source: { path: entry.path },
    id: entry.id,
    title: entry.title,
    scope: entry.scope,
    issues: [...new Set(entry.issues)].sort((a, b) => a - b),
  });
}

/**
 * buildAntiPatternsModel(antiPatternsSection) -> {ok:true, value:{rows,
 * unlistable}} | {ok:false, reason}.
 *
 * `rows` is one row per `antiPatternsSection.value.entries`, grouped `core`
 * before `project` and sorted by `id` within each scope; an unreadable
 * entry has no `id`, sorted last within its own scope. `unlistable` is
 * passed through unchanged — a directory that could not be listed at all is
 * its own said reason, never folded into an empty row list for that scope.
 * The whole section unreadable (`antiPatternsSection.ok === false`) is this
 * model's own reason, unchanged.
 *
 * @param {{ok:boolean, value?:{entries:Array, unlistable:Array}, reason?:string}} antiPatternsSection
 */
export function buildAntiPatternsModel(antiPatternsSection, { project } = {}) {
  if (!antiPatternsSection || typeof antiPatternsSection !== 'object') return { ok: false, reason: 'no anti-patterns section was given' };
  if (antiPatternsSection.ok !== true) return { ok: false, reason: antiPatternsSection.reason };

  const { entries = [], unlistable = [] } = antiPatternsSection.value ?? {};
  const rows = [...entries].map((entry) => antiPatternRow(entry, project)).sort(byScopeThenId);
  return { ok: true, value: { rows, unlistable } };
}
