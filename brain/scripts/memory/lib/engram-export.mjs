// engram-export.mjs — engram observation → brain record (the export half of
// the C0 loss contract, REQ-MF-6, issue #217 C2).
//
// Pure: no filesystem, no engram dependency, no child processes (mirrors
// format.mjs's contract). Reuses buildRecord()/computeRecordId() — never a
// second id hasher — and validateRecord() as a defensive final gate.

import { buildRecord, validateRecord, RECORD_TYPES, classifyActor } from './format.mjs';
import { parseProvenance } from './provenance.mjs';

/** The declared convention for a legacy record with no recoverable §4 prose
 * (REQ-MF-6): the store owner stands in as the ULTIMATE author of record — a
 * DECLARED convention, NOT a factual authorship claim. Never added to the
 * `actorKind` enum ("unknown" is deliberately absent from format.mjs's
 * human|agent set) — legacy records are declared `human` by this convention.
 *
 * #874: this no-recovery fallback (and the door it sits behind) is LEGACY —
 * it retires when engram's own `mem_save`/`save()` stub is addressed. Until
 * then it stays exactly as it is; only a RECOVERED branch-shaped actor gets
 * the new #738 guard below, never this path. */
export const LEGACY_ACTOR = '@legacy';
export const LEGACY_ACTOR_KIND = 'human';

/**
 * toUtcSeconds() — engram's naive `"YYYY-MM-DD HH:MM:SS"` timestamp (no `T`,
 * no timezone) becomes an ISO-8601 UTC `ts` under the ONE canonical rule fixed
 * by REQ-MF-2: engram's timezone-less timestamps are treated as UTC.
 *
 * @param {string} engramTs
 * @returns {string} `YYYY-MM-DDTHH:MM:SSZ`
 */
export function toUtcSeconds(engramTs) {
  const iso = `${engramTs.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`toUtcSeconds: invalid engram timestamp '${engramTs}'`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * exportObservation() — migrate ONE engram observation into a brain record.
 *
 * Order of decisions (REQ-MF-6):
 *   1. `scope: personal` → filtered, never exported (REQ-MF-5). Returns
 *      `{ skipped: 'scope:personal' }`.
 *   2. A non-enum `type` (e.g. the observed `"manual"`/`"preference"`) →
 *      REJECTED, never coerced. Returns `{ rejected: {id, title, type, reason} }`.
 *   3. Try §4 recovery via `parseProvenance(observation.content)`. If an
 *      `actor`/`actorKind` pair is found, use the recovered structured fields
 *      and the CLEANED content (prose stripped).
 *   4. Otherwise — the fallback convention (KNOWN FACT: 0/278 real
 *      observations recover; this is the expected path for the whole current
 *      store) — `actor: '@legacy'`, `actorKind: 'human'`, and a `source`
 *      documenting the unknown provenance + the originating chunk id.
 *   5. `title` folds into `content` via the shared `buildRecord()` (R2); the
 *      resulting record is validated as a final defensive gate (never silently
 *      emit a record that fails its own schema).
 *
 * @param {object} observation  one engram chunk observation (see ADR-0017)
 * @returns {{record:object, recovered:boolean}|{skipped:string}|{rejected:{id:string,title:string,type:string,reason:string}}}
 */
export function exportObservation(observation) {
  if (observation.scope === 'personal') {
    return { skipped: 'scope:personal' };
  }

  const obsRef = observation.sync_id ?? String(observation.id);

  if (!RECORD_TYPES.includes(observation.type)) {
    return {
      rejected: {
        id: obsRef,
        title: observation.title ?? '',
        type: observation.type,
        reason: `non-enum type '${observation.type}' — rejected, not coerced (REQ-MF-6)`,
      },
    };
  }

  const parsed = parseProvenance(observation.content ?? '');
  const recovered = Boolean(parsed.actor && parsed.actorKind);

  const fields = {
    ts: toUtcSeconds(observation.created_at),
    type: observation.type,
    project: observation.project,
    title: observation.title,
    content: recovered ? parsed.content : observation.content,
  };

  if (recovered) {
    // #738 (design A5): a §4 block CAN recover a branch-shaped `actor`
    // (`ACTOR_LINE_RE` accepts any non-whitespace token) — W3 (format.mjs)
    // would refuse it at appendRecord, turning a genuine recovery into a
    // THROW inside `share`/`migrate-v1`. Soft-reject it here instead, the
    // same shape as the non-enum-type rejection above. Measured vacuous
    // today (0/278 real observations recover at all), which is exactly why
    // it is cheap to make honest before it is ever load-bearing.
    if (classifyActor(parsed.actor) === 'branch') {
      return {
        rejected: {
          id: obsRef,
          title: observation.title ?? '',
          type: observation.type,
          reason: `recovered actor is branch-shaped: '${parsed.actor}' (W3, #738) — a branch answers WHERE, not WHO`,
        },
      };
    }
    fields.actor = parsed.actor;
    fields.actorKind = parsed.actorKind;
    if (parsed.issue !== undefined) fields.issue = parsed.issue;
    if (parsed.supersedes !== undefined) fields.supersedes = parsed.supersedes;
    if (parsed.source !== undefined) fields.source = parsed.source;
  } else {
    fields.actor = LEGACY_ACTOR;
    fields.actorKind = LEGACY_ACTOR_KIND;
    fields.source = `provenance unknown — migrated from engram chunk ${obsRef}`;
  }

  const record = buildRecord(fields);
  const { valid, errors } = validateRecord(record);
  if (!valid) {
    return {
      rejected: {
        id: obsRef,
        title: observation.title ?? '',
        type: observation.type,
        reason: `validateRecord failed: ${errors.join('; ')}`,
      },
    };
  }

  return { record, recovered };
}
