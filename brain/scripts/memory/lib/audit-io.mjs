// audit-io.mjs — the reading half of `brain:memory:audit` (#870). Everything that
// touches fs, git or a backend lives here behind seams; the numbers themselves
// are computed by audit.mjs, which is pure and tested. This file is deliberately
// small: read records with their file names, read the landing commit of each
// file, read the backend's keys as a LIST — then hand plain data to buildReport.

import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildReport } from './audit.mjs';
import { ENGRAM_BIN, probeBinary } from './backend-selection.mjs';
import { topicKeysFromExport } from '../../axes/memory/adapters/engram.mjs';

/**
 * Every PHYSICAL line under records/ as `{...record, file}` — repeats included,
 * because the line accounting needs them. Throws on a missing/unreadable dir:
 * "could not read" is not "zero records".
 */
export function readRecordLines(recordsDir, { _readdir = readdirSync, _read = readFileSync, _exists = existsSync } = {}) {
  if (!_exists(recordsDir)) throw new Error(`brain:memory:audit: records dir not found — ${recordsDir}`);
  const out = [];
  for (const file of _readdir(recordsDir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of _read(join(recordsDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { /* swallow-ok: covers JSON.parse of one line only (no I/O); a corrupt line is the fail-closed rebuildIndex gate's to refuse (store.mjs) */ continue; }
      if (typeof o?.id === 'string' && typeof o?.ts === 'string') out.push({ ...o, file });
    }
  }
  return out;
}

/**
 * id → epoch ms of the commit at which the record's file reached the FIRST-PARENT
 * line of the current branch — "when did it land on main", not "when was it
 * first written on some branch". Files never landed are absent from the map.
 *
 * `-m --first-parent` is what makes the answer exact. Measured on this repo:
 * plain `--diff-filter=A` lists 2383 add lines for 2348 files (side-branch adds
 * repeat) and MISSES a record that reached main only through a merge commit,
 * because `--name-only` prints nothing for a merge unless `-m`. With
 * `-m --first-parent` it is 2348 = 2348 = 2348, one landing per record.
 */
export function readLandingTimes(cwd, { _exec = execFileSync } = {}) {
  const out = _exec('git', ['log', '-m', '--first-parent', '--diff-filter=A', '--format=COMMIT %ct', '--name-only', '--', '.memory/records'], { cwd, encoding: 'utf8' });
  const landed = new Map();
  let ct = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('COMMIT ')) { ct = Number(line.slice(7)) * 1000; continue; }
    const m = /rec-([0-9a-f]+)\.jsonl$/.exec(line.trim());
    if (m && ct !== null) {
      const id = `rec-${m[1]}`;
      // git log walks newest→oldest; the LAST seen add for an id is the first in time.
      landed.set(id, ct);
    }
  }
  return landed;
}

/**
 * The backend's `rec-` keys as a LIST (rows), or `{measured:false, reason}`.
 * engram: a real `engram export`; plainfiles: index.jsonl entries — the vacuity
 * row of the epic's spec, labelled as such. Never throws; never returns zeros.
 */
export function readBackendKeys(backend, root, { _probe = probeBinary, _exec = execFileSync, _read = readFileSync } = {}) {
  try {
    if (backend === 'plainfiles') {
      const indexPath = join(root, '.memory', 'index.jsonl');
      if (!existsSync(indexPath)) return { measured: false, reason: 'plainfiles: index.jsonl not found' };
      const keys = _read(indexPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l).id; } catch { /* swallow-ok: an unparseable index line yields a null key that never matches a record id, so the drift shows in the measured row */ return null; } }).filter(Boolean);
      return { measured: true, mode: 'plainfiles index (vacuity row)', keys };
    }
    if (backend !== 'engram') return { measured: false, reason: `${backend}: no export reader for this backend` };
    const probe = _probe(ENGRAM_BIN);
    if (probe.available !== true) return { measured: false, reason: `engram: ${probe.reason ?? 'binary not available'}` };
    const dir = mkdtempSync(join(tmpdir(), 'brain-memory-audit-'));
    try {
      const file = join(dir, 'state.json');
      const stdout = _exec(ENGRAM_BIN, ['export', file], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      const fileContents = _read(file, 'utf8');
      // The ONE cross-check, reused rather than re-authored (#445): engram
      // reports what it wrote on stdout; if that disagrees with what the file
      // carries — or the schema drifted — this THROWS, and the row below is
      // measured:false with that reason instead of an understated count that
      // looks like a measurement (rev-1 cold review of PR #871, cold-1).
      topicKeysFromExport(stdout, fileContents);
      const parsed = JSON.parse(fileContents);
      const obs = Array.isArray(parsed?.observations) ? parsed.observations : [];
      const keys = obs.map((o) => o?.topic_key).filter((k) => typeof k === 'string' && k.startsWith('rec-'));
      return { measured: true, mode: 'engram export', keys };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) { /* surfaced: returned as `{ measured: false, reason }`: the audit row says why it degraded */
    return { measured: false, reason: `${backend}: ${String(err?.message ?? err).split('\n')[0]}` };
  }
}

/**
 * Reads everything and returns the report object. Throws only for an unreadable
 * records dir. A git failure (not a repository, shallow clone) does not throw:
 * latency becomes `{measured:false, reason}` and the other rows still print.
 */
export function runAudit({ root, backend, sinceMs, nowMs = Date.now(), _readRecordLines = readRecordLines, _readLandingTimes = readLandingTimes, _readBackendKeys = readBackendKeys }) {
  const records = _readRecordLines(join(root, '.memory', 'records'));
  let landedMsById;
  try {
    landedMsById = _readLandingTimes(root);
  } catch (err) { /* surfaced: returned as `{ measured: false, reason }`: the audit row says why it degraded */
    landedMsById = { measured: false, reason: String(err?.message ?? err).split('\n')[0] };
  }
  const backendKeys = _readBackendKeys(backend, root);
  return buildReport({ records, landedMsById, sinceMs, nowMs, backend: backendKeys });
}
