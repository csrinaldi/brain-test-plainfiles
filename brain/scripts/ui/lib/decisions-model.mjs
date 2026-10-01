// decisions-model.mjs — the ADR table and its drift warnings (#882 R882-3).
// Pure, imported by the browser and by node:test (D9): no `node:` builtin,
// no clock, no random, no fetch.
//
// AN UNREADABLE ADR IS KEPT IN PLACE (mirrors `adr-index.mjs`'s own rule),
// sorted last — no number to sort by, never dropped. `issues` passes through
// exactly as `parseAdr` extracted it, labelled "referenced," never "driving":
// the parser does not distinguish a driving ticket from an incidentally
// cited one, and this model must not claim a precision the data does not
// carry. `driftWarnings` is `adrDrift`'s own result, passed through — never
// a second drift computation.

import { row } from './governance-model.mjs';

/** The label every issues list carries — stated once here so the app.js
 * renderer and this model can never drift apart on what the data means. */
export const ISSUES_LABEL = 'issues referenced in this ADR';

const byNumber = (a, b) => {
  if (a.number === null) return b.number === null ? 0 : 1;
  if (b.number === null) return -1;
  return a.number - b.number;
};

/** One `adrs.value` entry -> its table row. A readable ADR goes through
 * `governance-model.mjs`'s own `row()` helper, so its `source`/`sourceStamp`
 * are derived the same way every other governance view derives them — never
 * a second provenance shaper. An unreadable ADR is kept in place, `number:
 * null` (rule zero: never dropped, sorted last). */
function decisionRow(adr) {
  if (!adr.ok) return { number: null, ok: false, path: adr.path, reason: adr.reason };
  return row({
    source: { path: adr.path },
    number: adr.number,
    title: adr.title,
    status: adr.status,
    amendments: adr.amendments,
    issues: adr.issues,
    issuesLabel: ISSUES_LABEL,
    supersedes: adr.supersedes,
    supersededBy: adr.supersededBy,
  });
}

/** `driftSection` -> a section-shaped passthrough: `{ok:true, value:{homeOnly,
 * filesOnly, unreadable}}` verbatim from `adr-index.mjs`'s own `adrDrift`, or
 * `{ok:false, reason}` when the drift section itself could not be computed.
 * Never fails the whole view: the table above stands on its own either way
 * (spec R882-3: "drift warnings ride beside the table, not instead of it"). */
function driftWarningsOf(driftSection) {
  if (!driftSection || typeof driftSection !== 'object') return { ok: false, reason: 'no drift section was given to decisions' };
  if (driftSection.ok !== true) return { ok: false, reason: driftSection.reason };
  const { homeOnly = [], filesOnly = [], unreadable = [] } = driftSection.value ?? {};
  return { ok: true, value: { homeOnly, filesOnly, unreadable } };
}

/**
 * buildDecisionsModel(adrsSection, driftSection) -> {ok:true, value:{rows,
 * driftWarnings}} | {ok:false, reason}.
 *
 * `rows` is one entry per `adrs.value` item, sorted by ADR number (unreadable
 * rows, with no number, sort last). `driftWarnings` is `driftSection`'s own
 * result, passed through unchanged. An unreadable `adrsSection` is the whole
 * view's own reason, regardless of `driftSection` (a readable drift section
 * over an unreadable ADR index would be reporting drift against data this
 * view could not itself read).
 *
 * @param {{ok:boolean, value?:Array, reason?:string}} adrsSection
 * @param {{ok:boolean, value?:{homeOnly:Array, filesOnly:Array, unreadable:Array}, reason?:string}} driftSection
 */
export function buildDecisionsModel(adrsSection, driftSection) {
  if (!adrsSection || typeof adrsSection !== 'object') return { ok: false, reason: 'no ADR section was given to decisions' };
  if (adrsSection.ok !== true) return { ok: false, reason: adrsSection.reason };

  const rows = [...(adrsSection.value ?? [])].map(decisionRow).sort(byNumber);
  return { ok: true, value: { rows, driftWarnings: driftWarningsOf(driftSection) } };
}
