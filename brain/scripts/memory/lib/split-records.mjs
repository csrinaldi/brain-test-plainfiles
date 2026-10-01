// split-records.mjs — the one-shot that moves an existing `.memory/records/`
// from the `<yyyy-mm>.jsonl` month log to one file per record (issue #677).
//
// WHY THIS EXISTS AS A VERB AND NOT AS AN UPGRADE STEP. `.memory/**` is
// consumer-owned (`managed-paths.mjs`'s `local` array) — brain never rewrites a
// repository's durable log on upgrade, and `store.mjs`'s read/write note says
// why: brain cannot migrate what it does not own. The read path accepts BOTH
// layouts, so a repository that never runs this keeps working exactly as it
// does today; it just keeps the conflict this ticket exists to remove.
//
// WHAT IT REFUSES, AND WHAT IT MERELY REPORTS — the same split ADR-0017
// Amendment 1 fixed for the index, because a migration that answered these two
// differently would be a second, quieter dedup rule:
//
//   REFUSED (nothing is written, nothing is deleted):
//     * a physical line that does not parse, or that `validateRecord` rejects;
//     * a line whose bytes do not hash to its own `id` (tampered or stale).
//   REPORTED (the migration proceeds, first-wins):
//     * a repeated `id` — the first line of the earliest month file wins, which
//       is the line `readRecords()` and `rebuildIndex()` already resolve to;
//     * a repeated `id` whose lines DIVERGE outside the hashed fields, which is
//       what brain's own export→import→export produces.
//
// The refusal is the important half: the month files are DELETED at the end of
// a real run, and a migration that silently dropped a line it could not read
// would be `evidence-reader-empty-on-failure` written into the durable log —
// a record gone, indistinguishable from one never captured (#574).

import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { parseRecordLine, computeRecordId, canonicalOrNull } from './format.mjs';
import { recordFilename } from './store.mjs';

/** `2026-08.jsonl` — the month log this migration consumes. */
const MONTH_FILE_RE = /^\d{4}-\d{2}\.jsonl$/;

/**
 * planSplit() — read every month file and decide, WITHOUT writing anything,
 * which per-record file each physical line becomes.
 *
 * Pure-ish by construction (it reads, it never writes), so the report a
 * `--dry-run` prints is produced by the same code path that performs the real
 * run rather than by a second implementation that can drift from it (#340).
 *
 * @param {{recordsDir: string}} opts
 * @returns {{monthFiles: string[], lines: number, writes: Array<{filename: string, bytes: string, at: string}>,
 *   duplicates: Array<{id: string, at: string, firstAt: string, divergent: boolean}>,
 *   alreadySplit: number}}
 * @throws {Error} on a corrupt line or an id mismatch — `<filename>:<line>` in the message.
 */
export function planSplit({ recordsDir }) {
  const monthFiles = existsSync(recordsDir)
    ? readdirSync(recordsDir).filter((f) => MONTH_FILE_RE.test(f)).sort()
    : [];
  const alreadySplit = existsSync(recordsDir)
    ? readdirSync(recordsDir).filter((f) => f.endsWith('.jsonl') && !MONTH_FILE_RE.test(f)).length
    : 0;

  const writes = [];
  const duplicates = [];
  /** id → {at, canonical} of the winning (first) line. */
  const firstSeen = new Map();
  let lines = 0;

  for (const filename of monthFiles) {
    const raw = readFileSync(join(recordsDir, filename), 'utf8');
    const physicalLines = raw.split('\n');
    for (let i = 0; i < physicalLines.length; i++) {
      const line = physicalLines[i];
      if (line.trim() === '') continue;
      const at = `${filename}:${i + 1}`;
      lines++;

      let record;
      try {
        record = parseRecordLine(line);
      } catch (err) {
        throw new Error(`planSplit: corrupt record at ${at} — ${err.message}`);
      }
      // The same id-integrity gate `rebuildIndex()` applies, for the same
      // reason and with the same message shape. A store that cannot be indexed
      // must not be migrated either: the migration would carry the bad line
      // into a file of its own and make it permanent.
      const recomputedId = computeRecordId(record);
      if (recomputedId !== record.id) {
        throw new Error(
          `planSplit: id mismatch at ${at} — stored id '${record.id}' does not match the recomputed id '${recomputedId}' (tampered or stale record)`,
        );
      }

      const canonical = canonicalOrNull(record);
      const prior = firstSeen.get(record.id);
      if (prior !== undefined) {
        // FIRST WINS — identical to the read path, so the migrated store holds
        // exactly the line every reader was already resolving to.
        duplicates.push({
          id: record.id,
          at,
          firstAt: prior.at,
          divergent: prior.canonical === null || canonical === null || prior.canonical !== canonical,
        });
        continue;
      }
      firstSeen.set(record.id, { at, canonical });
      writes.push({ filename: recordFilename(record), bytes: line + '\n', at });
    }
  }

  return { monthFiles, lines, writes, duplicates, alreadySplit };
}

/**
 * runSplit() — perform the migration, then PROVE it before deleting anything.
 *
 * The order is the whole design. Write every per-record file, verify that the
 * new layout reproduces every record the month files held, and only then remove
 * the month files. A verification failure leaves BOTH layouts on disk and
 * throws: the store is then duplicated (which `rebuildIndex` deduplicates and
 * reports) rather than short a record (which nothing can detect).
 *
 * Idempotent: a record whose file already exists with the same bytes is left
 * alone. A pre-existing file with DIFFERENT bytes for the same `id` is a
 * divergent pair, resolved first-wins in favour of what is already on disk —
 * never overwritten, because the file on disk may be the one another branch
 * merged in.
 *
 * `_writeFile` is a test seam, not an option: the verify-before-delete branch is
 * the one that matters most and the one a passing writer never reaches, so the
 * suite drives it with a writer that does not land. Same convention as
 * `_appendRecord` / `_rebuildIndex` elsewhere in this backend.
 *
 * @param {{recordsDir: string, apply?: boolean, _writeFile?: Function}} opts
 * @returns {{monthFiles: string[], lines: number, written: number, alreadyPresent: number,
 *   duplicates: Array<object>, alreadySplit: number, applied: boolean, verified: boolean}}
 * @throws {Error} on a corrupt/tampered line (before any write) or on a failed
 *   verification (after the writes, before any delete).
 */
export function runSplit({ recordsDir, apply = false, _writeFile = writeFileSync }) {
  const plan = planSplit({ recordsDir });
  const result = {
    monthFiles: plan.monthFiles,
    lines: plan.lines,
    written: 0,
    alreadyPresent: 0,
    duplicates: plan.duplicates,
    alreadySplit: plan.alreadySplit,
    applied: false,
    verified: false,
  };
  if (!apply || plan.monthFiles.length === 0) return result;

  for (const { filename, bytes } of plan.writes) {
    const target = join(recordsDir, filename);
    if (existsSync(target)) {
      result.alreadyPresent++;
      continue;
    }
    _writeFile(target, bytes, 'utf8');
    result.written++;
  }

  // VERIFY BEFORE DELETING. Not "the writes returned without throwing" — that
  // is the writer's own account of itself. Read the per-record files back and
  // require that every id the month files held is present in one of them.
  const present = new Set();
  for (const f of readdirSync(recordsDir).filter((x) => x.endsWith('.jsonl') && !MONTH_FILE_RE.test(x))) {
    for (const line of readFileSync(join(recordsDir, f), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record.id === 'string') present.add(record.id);
      } catch { /* swallow-ok: only collects ids already present; a corrupt line is refused by the rebuildIndex gate (store.mjs) */
        continue;
      }
    }
  }
  const missing = plan.writes
    .map((w) => w.filename.replace(/^\d{4}-\d{2}-/, '').replace(/\.jsonl$/, ''))
    .filter((id) => !present.has(id));
  if (missing.length > 0) {
    throw new Error(
      `runSplit: refusing to delete the month files — ${missing.length} of ${plan.writes.length} record(s) did not read back from the new layout (first: ${missing[0]}). Both layouts are on disk; nothing was lost.`,
    );
  }

  for (const filename of plan.monthFiles) rmSync(join(recordsDir, filename));
  result.applied = true;
  result.verified = true;
  return result;
}
