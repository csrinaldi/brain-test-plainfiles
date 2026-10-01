// brain/scripts/memory/day-start-sweep.mjs — the synchronous day:start lane
// sweep (#906, design.md A7). Sibling of session-end-ship.mjs's detaching
// launcher: this one WAITS and REPORTS, with its OWN timeout — day-start.mjs's
// `run()` (used for the surrounding steps) passes none, so a hung `gh` call
// there would hang the whole day start. This module never inherits that gap.
//
// Never throws: a non-zero `ship` exit or an unparseable `--json` line comes
// back as data on the returned outcome, so the caller (day-start.mjs step 5)
// can warn without ever failing the run.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Pure: is the lane sweep armed? Absent or false reads as false — same rule as the launcher. */
export function laneSweepEnabled(config) {
  return config?.memory?.lane?.enabled === true;
}

/**
 * Runs `memory/cli.mjs ship --json --invoker sweep` synchronously, with a
 * 60s timeout this module owns outright, and parses its single stdout
 * line. `--invoker sweep` declares this caller to the ship op's own
 * invoker guard (#1012).
 *
 * `enabled` lets a caller that already computed `laneSweepEnabled(config)`
 * (day-start.mjs step 5, to decide whether to print the progress line
 * first) pass that result through instead of this function re-deriving it
 * from `config` a second time. Callers that have not computed it get the
 * same default either way.
 *
 * @param {{ config: object, enabled?: boolean, _spawnSync?: Function }} [args]
 * @returns {{ skipped: boolean, status: number|null, outcome: object|null, unparsed: boolean }}
 */
export function runLaneSweep({ config, enabled = laneSweepEnabled(config), _spawnSync = spawnSync } = {}) {
  if (!enabled) {
    return { skipped: true, status: null, outcome: null, unparsed: false };
  }

  const result = _spawnSync(
    process.execPath,
    [CLI_PATH, 'ship', '--json', '--invoker', 'sweep'],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 },
  );

  const status = result.status ?? null;
  const line = (result.stdout ?? '').trim();

  if (!line) {
    return { skipped: false, status, outcome: null, unparsed: false };
  }

  try {
    return { skipped: false, status, outcome: JSON.parse(line), unparsed: false };
  } catch { /* surfaced: returned as `unparsed: true`, which the day-start renderer reports */
    return { skipped: false, status, outcome: null, unparsed: true };
  }
}

/**
 * Pure: decides what `day-start.mjs` should render for a `runLaneSweep()`
 * result. Never calls `t()`, never touches I/O, never throws — the wiring
 * this feeds is `warn`/`ok`/nothing, nothing else (#906 cold review C5: the
 * step-5 wiring had zero behavioural coverage, so a `warn` → fatal mutant
 * was invisible; this function is the independently testable decision that
 * wiring is now required to just render, not re-derive).
 *
 * `detailKey`/`detailParams` name an i18n key for the `warn` branch's
 * `{detail}` placeholder rather than a hardcoded English string — `t()`
 * resolves it, in both catalogs, the same as every other user-facing string
 * in this file.
 *
 * @param {{ skipped: boolean, status: number|null, outcome: object|null, unparsed: boolean }} sweep
 * @returns {{ level: 'skip'|'ok'|'warn', key: string|null, params: object }}
 */
export function laneSweepLine(sweep) {
  if (sweep.skipped) {
    return { level: 'skip', key: null, params: {} };
  }
  if (sweep.unparsed) {
    return {
      level: 'warn',
      key: 'day.memory.laneSweep.warn',
      params: { detailKey: 'day.memory.laneSweep.detailUnparsed', detailParams: {} },
    };
  }
  if (sweep.status !== 0) {
    return {
      level: 'warn',
      key: 'day.memory.laneSweep.warn',
      params: {
        detailKey: 'day.memory.laneSweep.detailExitCode',
        detailParams: { status: sweep.status ?? 'unknown' },
      },
    };
  }
  if (sweep.outcome?.pushed) {
    return {
      level: 'ok',
      key: 'day.memory.laneSweep.shipped',
      params: { ref: sweep.outcome.ref ?? '', number: sweep.outcome.pr?.number ?? '?' },
    };
  }
  // R11 (#920): a reconciliation-without-a-push (find/create + arm ran, zero
  // new commits) is still work — never "nothing to ship". Checked after
  // `pushed` so a run that both pushed AND reconciled still renders as
  // "shipped" (pushed wins), and before the `nothing` fallback.
  if (sweep.outcome?.reconciled) {
    return {
      level: 'ok',
      key: 'day.memory.laneSweep.reconciled',
      params: { ref: sweep.outcome.ref ?? '', number: sweep.outcome.pr?.number ?? '?' },
    };
  }
  // F2 (cold review): `ship --json`'s own `--json` outcome already carries
  // `skippedWorktrees` (#921) — read from it directly, never from stderr
  // (this function never sees stderr at all; `runLaneSweep()` above discards
  // it, by design, since the SessionEnd trigger's own redirect of the ship
  // child's stdout+stderr is the surface that needs it, not this one).
  // Checked ONLY as a replacement for the `nothing` fallback below: this is
  // the exact indistinguishability #921/#923 named — an operator reading
  // `Lane sweep: nothing to ship.` while a worktree silently went
  // uninspected. A `pushed`/`reconciled` run that ALSO skipped a worktree
  // still renders as "shipped"/"reconciled" above — that combination is not
  // this fix's scope; the count+paths are still available via `--json` and
  // the SessionEnd log either way.
  const skippedWorktrees = sweep.outcome?.skippedWorktrees ?? [];
  if (skippedWorktrees.length > 0) {
    return {
      level: 'ok',
      key: 'day.memory.laneSweep.worktreeSkipped',
      params: {
        count: skippedWorktrees.length,
        paths: skippedWorktrees.map((w) => `${w.path} (${w.reason})`).join(', '),
      },
    };
  }
  return { level: 'ok', key: 'day.memory.laneSweep.nothing', params: {} };
}

// R8 REVERSAL (#920 -> #936, D4) also reaches here through `closedUnmerged`:
// a row this action never re-pushes or reopens, so it MUST print as `warn`,
// not `ok` — the operator has to see it to ever act on it.
const WARN_BRANCH_ACTIONS = new Set(['closedUnmerged', 'unknown', 'diverged', 'failed', 'remoteOnly']);

/**
 * laneSweepBranchLines() — pure, mirrors `laneSweepLine()`'s own contract
 * (#936, design.md's module map: `day-start-sweep: laneSweepLine (unchanged)
 * + laneSweepBranchLines(outcome.sweep)`). One row in, one line out — never
 * calls `t()`, never touches I/O, never throws.
 *
 * `sweep` is `outcome.sweep` from a `ship --json` outcome: `null` (a
 * `--dry-run` run, or a run whose sweep never executed) yields `[]` — never
 * a crash on a missing key. Each branch's `action` maps to
 * `day.memory.laneSweep.branch.<action>` — `deleted`/`shipped`/`reconciled`
 * render `ok`; `closedUnmerged`/`unknown`/`diverged`/`failed`/`remoteOnly`
 * render `warn` (design.md's own table).
 *
 * #936 remediation (cold review WARNING): `sweep` can also be the fail-closed
 * marker `{ failed: true, reason }` — cli.mjs's own isolation of a throw from
 * `sweepLanes()`'s pre-loop code (the shared fetch/listLocalBranches/
 * listRemoteBranches/slugifyHost, none of which run inside the per-branch
 * try/catch). That shape has no `branches` array by construction, so it is
 * checked FIRST and rendered as exactly one `warn` line, distinct from the
 * "nothing ran" `[]` case above.
 *
 * @param {{ remoteListed: boolean, branches: Array<object> } | { failed: true, reason: string } | null} sweep
 * @returns {Array<{ level: 'ok'|'warn', key: string, params: object }>}
 */
export function laneSweepBranchLines(sweep) {
  if (!sweep) return [];
  if (sweep.failed) {
    return [{ level: 'warn', key: 'day.memory.laneSweep.sweepFailed', params: { reason: sweep.reason ?? '' } }];
  }
  if (!Array.isArray(sweep.branches)) return [];
  return sweep.branches.map((row) => ({
    level: WARN_BRANCH_ACTIONS.has(row.action) ? 'warn' : 'ok',
    key: `day.memory.laneSweep.branch.${row.action}`,
    params: {
      branch: row.branch,
      date: row.date,
      number: row.pr?.number ?? null,
      reason: row.reason ?? '',
    },
  }));
}
