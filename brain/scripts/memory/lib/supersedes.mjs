// supersedes.mjs — issue #805's pure classifier: is a `--supersedes <id>`
// value in the store, and if not, which of three things is wrong?
//
// Pure (ADR-0016): no `fs`, no `child_process`. `upstream` is a
// zero-argument function — a THUNK — called AT MOST ONCE and only when
// `localIds` misses, so "local first, git never touched in the common case"
// is a property of this module, not of caller discipline (design.md A1).
// Precedent: `evaluateLaneScrub({ …, readFile })` (archive/889/design.md:271).

/**
 * The id grammar `format.mjs#computeRecordId` mints (design.md A2). Declared
 * here rather than imported — `store.mjs#RECORD_ID_RE` is private and
 * fs-importing, which would break this module's purity at the import line.
 * Pinned behaviourally against `buildRecord(...).id` in `supersedes.test.mjs`
 * — the producer is the oracle; drift is caught by a test, not by review.
 */
export const SUPERSEDES_ID_RE = /^rec-[0-9a-f]{16}$/;

/**
 * @param {object} args
 * @param {unknown} args.id             the raw `--supersedes` value
 * @param {() => Set<string>} args.localIds
 *   Deferred reader over `store.mjs#readRecordIds({recordsDir})`'s result — a
 *   THUNK, mirroring `upstream` below. Called at most once, and only after
 *   `id` passes the grammar check: a malformed id must cost zero IO, not just
 *   zero upstream IO (cold-review blocker, #805).
 * @param {() => {ok:true, ref?:string, byId:Map<string,string>, configError?:string}
 *            | {ok:false, ref:string|null, reason:string, configError?:string}} args.upstream
 *   Deferred reader (`upstream-records.mjs#upstreamRecordEntries`'s shape). Called
 *   at most once, and only when `localIds()` misses.
 * @returns {{ok:true, source:'local'|'upstream', configError?:string}
 *          |{ok:false, reason:'malformed'|'not-in-store'|'could-not-verify',
 *            detail:object, configError?:string}}
 *   `detail` is the i18n params bag for that reason:
 *     malformed         -> { value }
 *     not-in-store      -> { id, ref }            ref may be null
 *     could-not-verify  -> { id, reason }         reason verbatim from the reader
 */
export function classifySupersedes({ id, localIds, upstream }) {
  if (typeof id !== 'string' || !SUPERSEDES_ID_RE.test(id)) {
    return { ok: false, reason: 'malformed', detail: { value: id } };
  }

  if (localIds().has(id)) {
    return { ok: true, source: 'local' };
  }

  const result = upstream();
  const carry = result.configError === undefined ? {} : { configError: result.configError };

  if (!result.ok) {
    return { ok: false, reason: 'could-not-verify', detail: { id, reason: result.reason }, ...carry };
  }

  if (result.byId.has(id)) {
    return { ok: true, source: 'upstream', ...carry };
  }

  return { ok: false, reason: 'not-in-store', detail: { id, ref: result.ref ?? null }, ...carry };
}
