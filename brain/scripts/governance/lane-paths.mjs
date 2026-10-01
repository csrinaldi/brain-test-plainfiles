// lane-paths.mjs — required, self-reporting context (#905, spec.md
// "lane-paths is a required, self-reporting context", design.md A5).
//
// Standalone entry script, NOT a run-check.mjs subcommand (design A5): the
// job name IS the check context (governance.yml:3-6), and this mirrors the
// shape vcs/actor-check.mjs / vcs/brain-writes-reviewed.mjs already use.
// Runs and reports on EVERY PR (D3) — a non-lane PR still exits 0, printing
// "not a lane — nothing to check", so a required context always reports.
//
// Pure core (evaluateLanePaths, built on checks/lane.mjs's classifyLane) +
// thin main() + CLI guard, reusing the shared resultToExit 0/1/2 contract
// (postmerge/exit-codes.mjs). Short-circuits on LANE_BRANCH_RE before ever
// touching git (design A4's property 1, mirrored here) — a non-`memory/*`
// head never calls the diff closures at all.

import { execFileSync as realExecFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { LANE_BRANCH_RE, classifyLane } from './checks/lane.mjs';
import { resultToExit } from './postmerge/exit-codes.mjs';
import { loadContext } from '../vcs/ci-context.mjs';

/**
 * Builds the default `git diff --name-only $base...$head` closure, injectable
 * at the `execFileSync` level (never spawns a real git process in tests —
 * mirrors run-check.mjs's fail-closed contract: throws rather than degrading
 * to `[]`).
 */
function buildDefaultDiffNameOnly(ctx, exec) {
  return () => {
    const base = ctx.baseSha;
    const head = ctx.headSha;
    if (!base || !head) {
      throw new Error('BASE_SHA/HEAD_SHA not set — cannot compute diff');
    }
    try {
      const out = exec('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' });
      return out.split('\n').filter(Boolean);
    } catch (err) {
      throw new Error(`git diff failed: ${err.message}`);
    }
  };
}

/** Same as above, for the ADDED half (`--diff-filter=A`). */
function buildDefaultDiffNameOnlyAdded(ctx, exec) {
  return () => {
    const base = ctx.baseSha;
    const head = ctx.headSha;
    if (!base || !head) {
      throw new Error('BASE_SHA/HEAD_SHA not set — cannot compute diff');
    }
    try {
      const out = exec('git', ['diff', '--diff-filter=A', '--name-only', `${base}...${head}`], { encoding: 'utf8' });
      return out.split('\n').filter(Boolean);
    } catch (err) {
      throw new Error(`git diff failed: ${err.message}`);
    }
  };
}

/**
 * evaluateLanePaths() — the loud half (design.md interfaces): built on
 * classifyLane's decomposition. `laneBranch:false` passes with "nothing to
 * check" (D3: never skipped, always reports); `laneBranch:true, lane:false`
 * fails and names every offending path at once.
 *
 * @param {{ sourceBranch: string|null, changedFiles: string[]|null, addedFiles: string[]|null }} input
 * @returns {{ pass: boolean, reason: string }}
 */
const MAX_OFFENDING_PATHS_SHOWN = 20;

export function evaluateLanePaths({ sourceBranch, changedFiles, addedFiles }) {
  const result = classifyLane({ sourceBranch, changedFiles, addedFiles });
  if (!result.laneBranch) {
    return { pass: true, reason: 'not a lane — nothing to check' };
  }
  if (result.lane) {
    return { pass: true };
  }
  if (result.offending.length === 0) {
    // lanePaths:false with no named path (e.g. an empty diff) is not a
    // foreign-path violation — print classifyLane's own reason instead of a
    // blank "offending path(s): ".
    return { pass: false, reason: result.reason };
  }
  const shown = result.offending.slice(0, MAX_OFFENDING_PATHS_SHOWN);
  const rest = result.offending.length - shown.length;
  const suffix = rest > 0 ? `, … and ${rest} more` : '';
  return { pass: false, reason: `lane-paths: offending path(s): ${shown.join(', ')}${suffix}` };
}

/**
 * main() — thin runner. Short-circuits on the branch regex BEFORE computing
 * the diff (non-lane heads pay nothing and cannot be affected by a diff
 * failure). Only a LANE-BRANCH head whose diff is uncomputable reports 2 —
 * everything else this job can decide, it decides.
 *
 * @param {{ ctx?: object, diffNameOnly?: Function, diffNameOnlyAdded?: Function, execFileSync?: Function }} [deps]
 * @returns {Promise<0|1|2>}
 */
export async function main(deps = {}) {
  const ctx = deps.ctx ?? {};
  const sourceBranch = ctx.sourceBranch ?? null;

  if (!LANE_BRANCH_RE.test(sourceBranch ?? '')) {
    console.log('not a lane — nothing to check');
    return resultToExit({ pass: true });
  }

  const exec = deps.execFileSync ?? realExecFileSync;
  const diffNameOnly = deps.diffNameOnly ?? buildDefaultDiffNameOnly(ctx, exec);
  const diffNameOnlyAdded = deps.diffNameOnlyAdded ?? buildDefaultDiffNameOnlyAdded(ctx, exec);

  let changedFiles;
  let addedFiles;
  try {
    changedFiles = diffNameOnly();
    addedFiles = diffNameOnlyAdded();
  } catch (err) {
    const result = {
      pass: false,
      uncomputable: true,
      reason: `lane-paths: cannot compute diff — failing closed (uncomputable): ${err.message}`,
    };
    console.log(result.reason);
    return resultToExit(result);
  }

  const result = evaluateLanePaths({ sourceBranch, changedFiles, addedFiles });
  if (result.reason) console.log(result.reason);
  return resultToExit(result);
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ctx = await loadContext();
  process.exit(await main({ ctx }));
}
