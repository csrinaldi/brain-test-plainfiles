// audit.mjs — the pure half of `brain:memory:audit` (#870; memory 2.0 task 0.2).
//
// The five numbers that opened memory 2.0 (#864) were hand queries nobody could
// re-run. This module computes them from plain data — no fs, no git, no backend —
// so the baseline pasted on #864 and the exit report (#864 task 6.1) are produced
// by the same definitions. cli.mjs's `audit` op does the reading and calls
// buildReport(); every number is tested here against those definitions
// (design.md D3 of openspec/changes/issue-870-memory-audit).
//
// A number that could not be measured is `null` or `{measured: false, reason}`,
// never 0 — "cannot determine" and "none" are different answers, and collapsing
// them is the evidence-reader-empty-on-failure class this repo keeps paying for.

import { classifyActor } from './format.mjs';

const H = 3600000;

// `HANDLE_RE`/`DEFAULT_BRANCHES`/`classifyActor` moved to `format.mjs` (#738,
// design A4) — the schema owner holds the actor-shape predicate. Re-exported
// here so this module's own callers (and this file's test suite) keep
// importing `classifyActor` from `audit.mjs`, unchanged.
export { classifyActor };

/**
 * Nearest-rank percentile over an ASCENDING list. `null` on an empty list.
 * @param {number[]} sorted
 * @param {number} q  0 < q ≤ 1
 * @returns {number|null}
 */
export function percentile(sorted, q) {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1];
}

/**
 * learn→main latency over `{id, tsMs, landedMs|null}` pairs. Records with no
 * landing commit are EXCLUDED from the percentiles and counted on their own —
 * "not yet on main" is a fact worth a line, not a zero-hour latency.
 */
export function latencyStats(pairs) {
  const hours = pairs
    .filter((p) => Number.isFinite(p.landedMs))
    .map((p) => (p.landedMs - p.tsMs) / H)
    .sort((a, b) => a - b);
  const notLanded = pairs.length - hours.length;
  return {
    n: hours.length,
    notLanded,
    p50h: percentile(hours, 0.5),
    p75h: percentile(hours, 0.75),
    p90h: percentile(hours, 0.9),
    maxH: hours.length ? hours[hours.length - 1] : null,
    within1h: hours.filter((h) => h <= 1).length,
    over24h: hours.filter((h) => h > 24).length,
    over72h: hours.filter((h) => h > 72).length,
  };
}

export function actorShape(records) {
  const out = { total: records.length, legacy: 0, branch: 0, handle: 0, other: 0 };
  for (const r of records) out[classifyActor(r.actor)] += 1;
  return out;
}

/** `issue` counts when it is a number; `supersedes` when it is a non-empty string. */
export function coverage(records) {
  return {
    total: records.length,
    issue: records.filter((r) => typeof r.issue === 'number').length,
    supersedes: records.filter((r) => typeof r.supersedes === 'string' && r.supersedes !== '').length,
  };
}

/** Physical lines vs distinct ids over the id of EVERY line, repeats listed. */
export function lineAccounting(ids) {
  const times = new Map();
  for (const id of ids) times.set(id, (times.get(id) ?? 0) + 1);
  const repeated = [...times]
    .filter(([, n]) => n > 1)
    .map(([id, n]) => ({ id, times: n }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { lines: ids.length, distinct: times.size, excess: ids.length - times.size, repeated };
}

/**
 * Rows vs distinct keys on the backend side, from a LIST of keys — a Set
 * cannot count rows, which is why `topicKeysFromExport` is not reused here.
 * `{measured: false, reason}` passes through untouched: no numbers on failure.
 */
export function backendAccounting(input) {
  if (!input || input.measured !== true) {
    return { measured: false, reason: input?.reason ?? 'no backend export available' };
  }
  const times = new Map();
  for (const k of input.keys) times.set(k, (times.get(k) ?? 0) + 1);
  const duplicated = [...times]
    .filter(([, n]) => n > 1)
    .map(([key, n]) => ({ key, times: n }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { measured: true, mode: input.mode ?? 'export', rows: input.keys.length, distinct: times.size, duplicated };
}

/**
 * The report. `records` is every PHYSICAL line parsed (repeats included — the
 * line accounting needs them); shapes and coverage dedup by id, first-wins,
 * matching how the index resolves a repeated line. `landedMsById` maps a record
 * id to the epoch ms of the commit that first added its file to the current
 * history; absent means not landed.
 */
export function buildReport({ records, landedMsById, sinceMs, nowMs, backend }) {
  const firstById = new Map();
  for (const r of records) if (!firstById.has(r.id)) firstById.set(r.id, r);
  const unique = [...firstById.values()];
  const inWindow = unique.filter((r) => Date.parse(r.ts) >= sinceMs);

  // landedMsById is a Map, or {measured:false, reason} when git could not be
  // read — 'could not read' must not render as 'nothing landed'.
  const latency = landedMsById instanceof Map
    ? latencyStats(inWindow.map((r) => ({
        id: r.id,
        tsMs: Date.parse(r.ts),
        landedMs: landedMsById.has(r.id) ? landedMsById.get(r.id) : null,
      })))
    : { measured: false, reason: landedMsById?.reason ?? 'landing times unavailable' };

  return {
    generatedAt: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    window: { sinceIso: new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), records: inWindow.length },
    latency,
    lines: lineAccounting(records.map((r) => r.id)),
    actors: { window: actorShape(inWindow), allTime: actorShape(unique) },
    coverage: { window: coverage(inWindow), allTime: coverage(unique) },
    backend: backendAccounting(backend),
  };
}

const h = (x) => (x === null ? 'n/a' : `${x.toFixed(1)} h`);

/** Plain lines, one per number, deterministic. `null` renders as n/a, never 0. */
export function renderReport(r) {
  const L = r.latency;
  const lines = [
    `brain:memory:audit — ${r.generatedAt} — window since ${r.window.sinceIso} (${r.window.records} records)`,
    L.measured === false
      ? `learn→main: not measured — ${L.reason}`
      : `learn→main   n ${L.n} · p50 ${h(L.p50h)} · p75 ${h(L.p75h)} · p90 ${h(L.p90h)} · max ${h(L.maxH)} · ≤1h ${L.within1h} · >24h ${L.over24h} · >72h ${L.over72h} · not landed ${L.notLanded}`,
    `records      lines ${r.lines.lines} · distinct ${r.lines.distinct} · excess ${r.lines.excess}` +
      (r.lines.repeated.length ? ` · repeated ${r.lines.repeated.map((x) => `${x.id}×${x.times}`).join(' ')}` : ''),
    `actor        window  @legacy ${r.actors.window.legacy} · branch ${r.actors.window.branch} · handle ${r.actors.window.handle} · other ${r.actors.window.other} (of ${r.actors.window.total})`,
    `             all     @legacy ${r.actors.allTime.legacy} · branch ${r.actors.allTime.branch} · handle ${r.actors.allTime.handle} · other ${r.actors.allTime.other} (of ${r.actors.allTime.total})`,
    `coverage     window  issue ${r.coverage.window.issue}/${r.coverage.window.total} · supersedes ${r.coverage.window.supersedes}/${r.coverage.window.total}`,
    `             all     issue ${r.coverage.allTime.issue}/${r.coverage.allTime.total} · supersedes ${r.coverage.allTime.supersedes}/${r.coverage.allTime.total}`,
  ];
  const B = r.backend;
  lines.push(
    B.measured
      ? `backend      ${B.mode} · rows ${B.rows} · distinct ${B.distinct} · duplicated ${B.duplicated.length}` +
          (B.duplicated.length ? ` · ${B.duplicated.map((x) => `${x.key}×${x.times}`).join(' ')}` : '')
      : `backend: not measured — ${B.reason}`,
  );
  return lines;
}
