// engram-heal.mjs — the pure planning half of the engram duplicate heal
// (#1061, #864 task 1.2a). Implements memory-backend-contract.md's Deletion
// clause: "The adapter MAY delete its own rows for reconciliation (a
// duplicated key …). Records are never deleted." This module never touches
// `.memory/`, never runs `engram`, never mutates anything — it takes a
// PARSED `engram export` and returns a decision: keep/delete groups, or a
// refusal naming exactly what it would not classify.
//
// Pure: no filesystem, no engram dependency, no child processes (mirrors
// engram-export.mjs/engram-import.mjs's own contract).

/** The only engram line this heal is measured against (design.md's own
 *  "Measured by the orchestrator" section, engram 1.20.0). Widening this
 *  range is a code change plus a re-run of the integration test, not a
 *  silent guess — the update banner engram prints on every run means a
 *  newer binary is a routine event, not a rare one. */
export const TESTED_ENGRAM = Object.freeze({ major: 1, minor: 20 });

/** Fields whose equality decides "the same duplicate" vs "divergent copies"
 *  (proposal.md's decision record: content, title and type — never project,
 *  since a key already hashes the project in, per format.mjs). */
const IDENTITY_FIELDS = Object.freeze(['content', 'title', 'type']);

/**
 * parseEngramVersion() — the first `\d+.\d+.\d+` on STDOUT only.
 *
 * engram's update banner ("Update available: 1.20.0 -> 2.0.0") lives on
 * STDERR and carries TWO version numbers; this function is never handed that
 * text by its caller (axes/memory/adapters/engram.mjs reads `engram version`'s stdout
 * alone) but stays defensive about the shape regardless — a caller error
 * here must surface as `null`, never as a wrong guess.
 *
 * @param {unknown} stdout
 * @returns {{major:number, minor:number, patch:number} | null}
 */
export function parseEngramVersion(stdout) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(stdout ?? ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * isTestedVersion() — strict major.minor match against TESTED_ENGRAM. A
 * patch difference is fine (1.20.1 is still "1.20.x"); a minor or major
 * difference is not — engram 2.0.0 exists and is untested, so it refuses
 * rather than silently widening the range (design.md's own ruling).
 *
 * @param {{major:number, minor:number} | null} version
 * @returns {boolean}
 */
export function isTestedVersion(version) {
  return Boolean(version) && version.major === TESTED_ENGRAM.major && version.minor === TESTED_ENGRAM.minor;
}

/**
 * planDuplicateHeal() — groups a PARSED `engram export` by `rec-`-prefixed
 * `topic_key`, keeps the lowest observation id per group, and reports every
 * other live row in that group as a delete candidate.
 *
 * Order of guards (REQ-MB-1, REQ-MB-3):
 *   1. `observations` must be an array or `null` (`null` is the legitimately
 *      empty store, per #445's own finding — reused here, not re-derived).
 *      Anything else refuses `shape` before classifying a single row.
 *   2. Only LIVE `rec-`-prefixed rows are ever candidates: a row carrying
 *      `deleted_at` is never counted, never grouped, never a delete target.
 *   3. Every live `rec-` row must carry an integer `id` and string
 *      `content`/`title`/`type` — one malformed row refuses `shape` for the
 *      WHOLE run (skipping it would under-count, the
 *      `evidence-reader-empty-on-failure` class design.md names).
 *   4. A key with 3+ live rows refuses `tooMany` — this heal only
 *      understands a keeper and ONE non-keeper.
 *   5. A key's two rows must agree on `content`, `title` AND `type`
 *      (strict `===`); any difference refuses `divergent`, naming every
 *      field that disagreed.
 *   6. Whatever remains: the lower `id` is kept, the higher is a delete
 *      candidate.
 *
 * A single refusal refuses the WHOLE run (REQ-MB-3) — the first offending
 * key encountered (export order) is the one named.
 *
 * @param {{observations: object[] | null | unknown}} parsed
 * @returns {{ok:true, rows:number, distinct:number, groups:{key:string,keep:number,delete:number[]}[]}
 *          |{ok:false, refusal:'divergent'|'tooMany'|'shape', key?:string, fields?:string[], count?:number, reason?:string}}
 */
export function planDuplicateHeal(parsed) {
  const observations = parsed?.observations;
  if (observations != null && !Array.isArray(observations)) {
    return {
      ok: false,
      refusal: 'shape',
      reason: `'observations' is ${typeof observations}, not an array — this heal was not written against this export shape`,
    };
  }

  // `null` is the legitimately empty store (measured, #445) — zero rows,
  // zero groups, never a refusal.
  const all = observations ?? [];
  const live = all.filter(
    (o) => o && typeof o.topic_key === 'string' && o.topic_key.startsWith('rec-') && o.deleted_at == null,
  );

  for (const o of live) {
    const shapeOk =
      Number.isInteger(o.id) &&
      typeof o.content === 'string' &&
      typeof o.title === 'string' &&
      typeof o.type === 'string';
    if (!shapeOk) {
      return {
        ok: false,
        refusal: 'shape',
        key: o.topic_key,
        reason: `'${o.topic_key}' has a row with no integer id or no string content/title/type`,
      };
    }
  }

  const byKey = new Map();
  for (const o of live) {
    if (!byKey.has(o.topic_key)) byKey.set(o.topic_key, []);
    byKey.get(o.topic_key).push(o);
  }

  const groups = [];
  for (const [key, items] of byKey) {
    if (items.length < 2) continue;
    if (items.length > 2) {
      return { ok: false, refusal: 'tooMany', key, count: items.length };
    }
    const [a, b] = items;
    const fields = IDENTITY_FIELDS.filter((f) => a[f] !== b[f]);
    if (fields.length > 0) {
      return { ok: false, refusal: 'divergent', key, fields };
    }
    const ids = [a.id, b.id].sort((x, y) => x - y);
    groups.push({ key, keep: ids[0], delete: [ids[1]] });
  }

  return { ok: true, rows: live.length, distinct: byKey.size, groups };
}
