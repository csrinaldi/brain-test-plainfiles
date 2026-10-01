// index-lag.mjs — warn when the committed `.memory/index.jsonl` has drifted
// from `.memory/records/`, never fail (#889, design A9, spec.md "local-checks
// warns on index lag, never fails", refines archive/862/spec.md:49-58).
//
// A pure comparator (`compareIndexToRecords`) over ID SETS, never bytes —
// `serializeIndex()` is deterministic, so a byte compare would flag a
// harmless key-order/newline difference as "lag" and cry wolf on every PR
// that never touched a record. Built on `readRecords()` (never
// `rebuildIndex()`, which writes) — this is a warning surface, not the
// fail-closed integrity gate that owns `.memory/index.jsonl`'s bytes.
//
// Thin `main()` reads the committed index and the records tree, prints one
// WARNING naming both counts when they disagree, and ALWAYS exits 0 — this
// check reports, it never blocks (L3).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readRecords } from './lib/store.mjs';

/**
 * readIndexLines() — best-effort read of the committed index.jsonl, never
 * throws. A missing/unreadable file reads as an empty index (design A9's
 * degenerate-state contract, mirroring store.mjs's own reader shapes).
 *
 * @param {string} indexPath
 * @param {Function} readFile
 * @returns {string[]}
 */
function readIndexLines(indexPath, readFile) {
  let raw;
  try {
    raw = readFile(indexPath, 'utf8');
  } catch { /* surfaced: an unreadable index reads as empty, which then reports as lag (0 indexed) in the same WARNING */
    return []; // absent/unreadable index.jsonl — never throw, read as empty
  }
  return raw.split('\n').filter((line) => line.trim() !== '');
}

/**
 * compareIndexToRecords() — pure comparator over ID SETS (spec "local-checks
 * warns on index lag, never fails"; design A9). `missingFromIndex` is a
 * record id present in `.memory/records/` but absent from the committed
 * index (a lag the next `brain:memory:index`/`brain:memory:reindex` resolves);
 * `staleInIndex` is the reverse (an index entry whose record no longer
 * exists — a stale carry-over). Either direction is `lagged: true`.
 *
 * @param {{indexLines?: string[], records?: Array<{id?: string}>}} [input]
 * @returns {{lagged: boolean, indexed: number, rebuilt: number,
 *   missingFromIndex: string[], staleInIndex: string[]}}
 */
export function compareIndexToRecords({ indexLines = [], records = [] } = {}) {
  const indexedIds = new Set();
  for (const line of indexLines) {
    if (typeof line !== 'string' || line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch { /* surfaced: covers JSON.parse of one index line only (no I/O); the line is not indexed, so its ids show up as missing from the index in the WARNING */
      continue; // a corrupt index line is not this warning's gate to fail on
    }
    if (entry && typeof entry.id === 'string') indexedIds.add(entry.id);
  }

  const rebuiltIds = new Set();
  for (const record of records) {
    if (record && typeof record.id === 'string') rebuiltIds.add(record.id);
  }

  const missingFromIndex = [...rebuiltIds].filter((id) => !indexedIds.has(id)).sort();
  const staleInIndex = [...indexedIds].filter((id) => !rebuiltIds.has(id)).sort();

  return {
    lagged: missingFromIndex.length > 0 || staleInIndex.length > 0,
    indexed: indexedIds.size,
    rebuilt: rebuiltIds.size,
    missingFromIndex,
    staleInIndex,
  };
}

/**
 * main() — thin runner. Reads the committed index and `.memory/records/`
 * (via `readRecords`, never `rebuildIndex` — nothing here is ever written),
 * compares, and prints a warning naming both counts when they disagree.
 * ALWAYS returns 0 — L3 refines the old fail-closed rung into a report.
 *
 * @param {{recordsDir: string, indexPath: string, readFile?: Function, log?: Function}} opts
 * @returns {0}
 */
export function main({ recordsDir, indexPath, readFile = readFileSync, log = console.log }) {
  const indexLines = readIndexLines(indexPath, readFile);
  const { records } = readRecords({ recordsDir });
  const result = compareIndexToRecords({ indexLines, records });

  if (result.lagged) {
    // "indexed N, rebuilt M" alone can read as in-sync when it is not (equal counts
    // with one id swapped for another still passes N === M) and never says WHICH
    // direction the lag runs. Name the missing/stale counts too — counts only, never
    // the ids themselves, which stay in `result` for a caller that wants them.
    log(
      `WARNING: .memory/index.jsonl is out of sync with .memory/records/ — `
      + `indexed ${result.indexed}, rebuilt ${result.rebuilt} record id(s) `
      + `(${result.missingFromIndex.length} missing from the index, `
      + `${result.staleInIndex.length} stale in it). `
      + 'Run `npm run brain:memory:reindex` to resync. Non-blocking — this check never fails.',
    );
  }

  return 0;
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main({
    recordsDir: join(repoRoot, '.memory', 'records'),
    indexPath: join(repoRoot, '.memory', 'index.jsonl'),
  }));
}
