// memory-coverage.mjs — repo-level memory-records coverage snapshot for
// brain-metrics (issue #324/M9). A SINGLE snapshot, never a per-period time
// series (spec "Memory-record coverage" requirement) — the `issue` field's
// adoption is a repo-wide fact, not something that varies merge-to-merge.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readRecords } from '../memory/lib/store.mjs';
import { emptyDuplicates, normalizeDuplicates } from '../memory/lib/duplicates.mjs';

/** Whether a record's `issue` field is populated (non-nullish, non-empty-string). */
function isTagged(record) {
  const issue = record?.issue;
  return issue !== undefined && issue !== null && issue !== '';
}

/**
 * Compute the repo-level memory-records coverage snapshot.
 *
 * The reader returns `[]` both when `.memory/records/` is absent AND when it is
 * present-but-empty — those are semantically distinct (E2: "unavailable" vs. a
 * genuinely empty adoption), so this checks `existsSync` separately to report
 * the honest caveat.
 *
 * `readRecords`, not `readRecordObservations` (issue #634). They return the
 * same records; the difference is that `readRecords` also hands back the
 * duplicate accounting it collapsed, and this function's `total` is a number a
 * human READS. #598 moved it from one-per-line to one-per-`id` — correctly, and
 * it fixed a real leak — but the total dropped by 139 on this repo's corpus in
 * a single commit with nothing anywhere able to explain it. "It got more
 * correct" was not an answer the output could give.
 *
 * So the accounting travels out. `duplicates` is ALWAYS present and always
 * normalized, never `undefined` on the unavailable path: a consumer that has to
 * test for the field's existence before trusting it is the shape this ticket is
 * about.
 *
 * @param {string} cwd
 * @returns {{ available: boolean, total: number, tagged: number, coveragePct: number,
 *   duplicates: {ids: number, lines: number, divergent: number, groups: object[]} }}
 *   `total` is the DEDUPED record count; `total + duplicates.lines` is the
 *   physical line count of the store.
 */
export function computeMemoryCoverage(cwd) {
  const recordsDir = join(cwd, '.memory', 'records');
  const available = existsSync(recordsDir);
  const read = available ? readRecords({ recordsDir }) : null;
  const records = read?.records ?? [];
  const total = records.length;
  const tagged = records.filter(isTagged).length;
  const coveragePct = total === 0 ? 0 : Math.round((tagged / total) * 1000) / 10;
  // An unreadable store has NOTHING to say about duplicates — `emptyDuplicates()`
  // here means "nothing was collapsed", which is true of a read that never
  // happened only because `available` already carries the "I could not look"
  // half. The two fields are read together or not at all.
  return { available, total, tagged, coveragePct, duplicates: available ? normalizeDuplicates(read?.duplicates) : emptyDuplicates() };
}
