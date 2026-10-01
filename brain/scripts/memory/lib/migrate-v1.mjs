// migrate-v1.mjs — one-shot engram chunk → brain record migration (issue
// #217, C2).
//
// C2a scope: the DRY-RUN report — record count, types histogram,
// unparseable-chunk list, rejection report, and the provenance
// recovered/fallback histogram.
//
// C2-migrate scope (this slice, #219): `runMigration()` — the real-run CODE,
// proven only against a synthetic fixture store (never the live `.memory/`).
// The real EXECUTION against the TRUE store (dual-write pipeline, import,
// scrub re-point, and the cutover runbook itself) is C2b — see design.md
// Decision 1.

import { existsSync, readdirSync, readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

import { exportObservation } from './engram-export.mjs';
import { appendRecord, rebuildIndex } from './store.mjs';

/**
 * collectChunkObservations() — decompress every `*.jsonl.gz` chunk under
 * `chunksDir` and flatten their `.observations` arrays. NEVER throws: chunks
 * are sorted into exactly one of three buckets, never conflated:
 *
 *   - `unparseable`  — the chunk genuinely failed to gunzip or JSON.parse.
 *     This is real corruption; only THIS bucket may ever feed a future
 *     fail-closed migration gate.
 *   - `emptyObservations` — the chunk parsed FINE as JSON but its
 *     `observations` field is `null`/`undefined`/non-array. Verified against
 *     real data: legitimate sessions/prompts-only chunks take this shape
 *     (`observations: null` with `sessions` populated) — this is NOT
 *     corruption and must never be reported as such.
 *   - (no bucket) — `observations` is a valid array; its entries are
 *     flattened into the returned `observations` list as before.
 *
 * One corrupt chunk must not abort the whole migration report.
 *
 * @param {string} chunksDir
 * @returns {{observations: object[], unparseable: string[], emptyObservations: string[]}}
 */
export function collectChunkObservations(chunksDir) {
  const observations = [];
  const unparseable = [];
  const emptyObservations = [];
  if (!existsSync(chunksDir)) return { observations, unparseable, emptyObservations };

  const files = readdirSync(chunksDir).filter((f) => f.endsWith('.jsonl.gz')).sort();
  for (const file of files) {
    let parsed;
    try {
      const raw = gunzipSync(readFileSync(join(chunksDir, file))).toString('utf8');
      parsed = JSON.parse(raw);
    } catch { /* surfaced: pushed to `unparseable`, which the migration report lists */
      unparseable.push(file);
      continue;
    }
    if (Array.isArray(parsed.observations)) {
      observations.push(...parsed.observations);
    } else {
      emptyObservations.push(file);
    }
  }
  return { observations, unparseable, emptyObservations };
}

/**
 * buildMigrationReport() — pure: run exportObservation() over every
 * observation and produce the mandatory dry-run report (REQ-MF-6): the
 * exported record count, a types histogram (over successfully exported
 * records only), the count of `scope:personal` skips, the full rejection
 * report (id/title/type/reason per rejected observation), and the provenance
 * histogram (recovered vs fallback — for the CURRENT real store this MUST
 * read `{recovered: 0, fallback: N}`, proving §4 recovery ran and found no
 * prose anywhere, per the verified 0/278 fact).
 *
 * `chunkStats` (optional, from `collectChunkObservations()`) carries the
 * chunk-level buckets so the report's accounting narrative stays honest
 * (MAJOR-3): `emptyObservationsChunks` are provably 0 observations (a
 * legitimate sessions/prompts-only chunk shape, never corruption) and are
 * passed through as-is. `unparseableChunks` chunks NEVER parsed at all, so
 * the observation count they would have contributed is fundamentally
 * unknowable — the report surfaces this EXPLICITLY via `unparseableNote`
 * rather than silently treating it as zero. `records + skippedPersonal +
 * rejected.length` therefore only ever accounts for observations that were
 * actually readable; it is never claimed to be the grand total when any
 * chunk was unparseable.
 *
 * @param {object[]} observations
 * @param {{unparseable?: string[], emptyObservations?: string[]}} [chunkStats]
 * @returns {{recordCount:number, skippedPersonal:number, typesHistogram:Record<string,number>,
 *            provenanceHistogram:{recovered:number, fallback:number},
 *            rejected:{id:string,title:string,type:string,reason:string}[],
 *            records:object[], unparseableChunks:string[], emptyObservationsChunks:string[],
 *            unparseableNote?:string}}
 */
export function buildMigrationReport(observations, chunkStats = {}) {
  const records = [];
  const rejected = [];
  const typesHistogram = {};
  const provenanceHistogram = { recovered: 0, fallback: 0 };
  let skippedPersonal = 0;

  for (const obs of observations) {
    let result;
    try {
      result = exportObservation(obs);
    } catch (err) { /* surfaced: pushed to `rejected` with its reason; one corrupt observation must not abort the report */
      // A throwing export (e.g. toUtcSeconds() on a malformed created_at)
      // must reject THAT one observation only — one corrupt observation
      // must never abort the whole migration report (MINOR-4).
      rejected.push({
        id: obs.sync_id ?? String(obs.id),
        title: obs.title ?? '',
        type: obs.type,
        reason: err.message,
      });
      continue;
    }
    if (result.skipped) {
      skippedPersonal += 1;
      continue;
    }
    if (result.rejected) {
      rejected.push(result.rejected);
      continue;
    }
    records.push(result.record);
    typesHistogram[result.record.type] = (typesHistogram[result.record.type] ?? 0) + 1;
    provenanceHistogram[result.recovered ? 'recovered' : 'fallback'] += 1;
  }

  const unparseableChunks = chunkStats.unparseable ?? [];
  const emptyObservationsChunks = chunkStats.emptyObservations ?? [];

  const report = {
    recordCount: records.length,
    skippedPersonal,
    typesHistogram,
    provenanceHistogram,
    rejected,
    records,
    unparseableChunks,
    emptyObservationsChunks,
  };

  if (unparseableChunks.length > 0) {
    report.unparseableNote = `${unparseableChunks.length} chunk(s) could not be read — observation count unknown`;
  }

  return report;
}

const REJECTION_REPORT_FILE = 'migration-rejected.json';

/**
 * runMigration() — the real-run CODE (C2-migrate, #219). Fixture-tested only
 * (design.md Decision 1): proven against a synthetic temp-dir store, never
 * executed here against the live `.memory/`. Deps are injected (`_`-prefixed,
 * mirroring axes/memory/adapters/engram.mjs's seam pattern) so tests drive a real
 * filesystem in a temp dir.
 *
 * Order (design.md Decision 2 + 3):
 *   1. Idempotency abort FIRST, before any work: a `recordsDir` that already
 *      has `.jsonl` content means a prior run (or a C2b dual-write `share`)
 *      already populated it — throw, routing the operator to the runbook.
 *   2. Collect + export every chunk observation; accepted → `appendRecord`
 *      (bucketed by `ts` month); rejected/`scope:personal` → accumulated,
 *      never dropped.
 *   3. Persist the report under `legacyDir` naming EVERY non-migrated category
 *      — rejected, `scope:personal` skips, unparseable + empty-obs chunks —
 *      each present even when empty (a zero is counted-evidence, not silence).
 *   4. MOVE every original chunk file to `legacyDir` (never delete in place).
 *   5. `rebuildIndex()`.
 *
 * @param {object} opts
 * @param {string} opts.chunksDir
 * @param {string} opts.recordsDir
 * @param {string} opts.legacyDir
 * @param {string} opts.indexPath
 * @param {typeof collectChunkObservations} [opts._collectChunkObservations]
 * @param {typeof exportObservation} [opts._exportObservation]
 * @param {typeof appendRecord} [opts._appendRecord]
 * @param {typeof rebuildIndex} [opts._rebuildIndex]
 * @param {typeof existsSync} [opts._existsSync]
 * @param {typeof readdirSync} [opts._readdirSync]
 * @param {typeof mkdirSync} [opts._mkdirSync]
 * @param {typeof renameSync} [opts._renameSync]
 * @param {typeof writeFileSync} [opts._writeFileSync]
 * @returns {{written:number, rejected:number, skipped:number,
 *            unparseableChunks:number, emptyObservationsChunks:number,
 *            legacyDir:string, reportPath:string, indexCount:number}}
 * @throws {Error} if `recordsDir` already has migrated `.jsonl` content —
 *   message names `recordsDir` and contains "run the cutover runbook".
 */
export function runMigration({
  chunksDir,
  recordsDir,
  legacyDir,
  indexPath,
  _collectChunkObservations = collectChunkObservations,
  _exportObservation = exportObservation,
  _appendRecord = appendRecord,
  _rebuildIndex = rebuildIndex,
  _existsSync = existsSync,
  _readdirSync = readdirSync,
  _mkdirSync = mkdirSync,
  _renameSync = renameSync,
  _writeFileSync = writeFileSync,
}) {
  const alreadyMigrated =
    _existsSync(recordsDir) && _readdirSync(recordsDir).some((f) => f.endsWith('.jsonl'));
  if (alreadyMigrated) {
    throw new Error(
      `runMigration: '${recordsDir}' already has migrated records — refusing to re-run this one-shot migration; run the cutover runbook (C2b) instead of brain:memory:migrate-v1`,
    );
  }

  const { observations, unparseable, emptyObservations } = _collectChunkObservations(chunksDir);

  const rejected = [];
  const skipped = [];
  let written = 0;

  for (const obs of observations) {
    const obsRef = obs.sync_id ?? String(obs.id);
    let result;
    try {
      result = _exportObservation(obs);
    } catch (err) { /* surfaced: pushed to `rejected` with its reason; the migration report lists it */
      rejected.push({ id: obsRef, title: obs.title ?? '', type: obs.type, reason: err.message });
      continue;
    }
    if (result.skipped) {
      skipped.push({ id: obsRef, title: obs.title ?? '', type: obs.type, reason: result.skipped });
      continue;
    }
    if (result.rejected) {
      rejected.push(result.rejected);
      continue;
    }
    _appendRecord(result.record, { recordsDir });
    written += 1;
  }

  // Persist EVERY non-migrated category — NAMED, not merely counted (design.md
  // Decision 3): rejected + scope:personal skips + unparseable + empty-obs
  // chunks. The empty arrays are kept ON PURPOSE: a zero IN the report is
  // evidence the category was counted, not silently ignored (same principle as
  // the 0-recovered provenance histogram).
  _mkdirSync(legacyDir, { recursive: true });
  const reportPath = join(legacyDir, REJECTION_REPORT_FILE);
  const persistedReport = {
    rejected,
    skipped,
    unparseableChunks: unparseable,
    emptyObservationsChunks: emptyObservations,
  };
  _writeFileSync(reportPath, JSON.stringify(persistedReport, null, 2) + '\n', 'utf8');

  if (_existsSync(chunksDir)) {
    for (const file of _readdirSync(chunksDir).filter((f) => f.endsWith('.jsonl.gz'))) {
      _renameSync(join(chunksDir, file), join(legacyDir, file));
    }
  }

  const { count: indexCount } = _rebuildIndex({ recordsDir, indexPath });

  return {
    written,
    rejected: rejected.length,
    skipped: skipped.length,
    unparseableChunks: unparseable.length,
    emptyObservationsChunks: emptyObservations.length,
    legacyDir,
    reportPath,
    indexCount,
  };
}
