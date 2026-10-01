// lane-scrub.mjs — required, non-waivable secret check (#905, spec.md
// "lane-scrub is a required, non-waivable secret check", design.md A5/A6, C1).
//
// SOURCE GUARD (design A5's deciding argument): this file NEVER imports
// governance-tiers.mjs. ADR-0034 calls lane-scrub non-waivable; if it routed
// through run-check.mjs's main() and a GATE_MATRIX cell, non-waivability
// would be a property of a matrix a future tier edit could soften. A
// standalone main() that never reaches the tier module makes "fail-closed at
// every tier, no flag" a property of the code — lane-scrub.test.mjs pins the
// absent import by reading this file's own source.
//
// DEPARTURE FROM D3's WORDING (design A6, raised as an open question): every
// other required context prints "not a lane — nothing to check" on a
// non-lane PR. lane-scrub does not — it needs no lane input at all. It scans
// every added `.memory/records/*.jsonl` path on EVERY PR, lane or not,
// because the five #890 feature-PR surfaces are still live: contributors are
// still told to commit records on feature branches
// (vcs/contributor-scaffold.mjs:274), and a scrub that only looked at lane
// PRs would leave that transition window unguarded. Revert path (one
// condition): gate the added-paths filter on classifyLane(...).laneBranch.

import { execFileSync as realExecFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LANE_PATH_RE } from './checks/lane.mjs';
import { resultToExit } from './postmerge/exit-codes.mjs';
import {
  compilePatterns,
  resolveSecretConfig,
  scanTextForSecrets,
} from '../memory/lib/secret-scrub.mjs';
import { loadBrainConfigOrThrow } from '../lib/brain-config.mjs';
import { loadContext } from '../vcs/ci-context.mjs';

/** Same shape as lane-paths.mjs's default — the ADDED half of a three-dot diff. */
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
 * Reads `brain.config.json` for the `governance.memorySecret*` keys, via
 * `loadBrainConfigOrThrow` (#942). ENOENT still returns `{}` (absence stays
 * green, R12/REQ-SCAN-3); every OTHER read/parse failure PROPAGATES (#712,
 * REQ-SCAN-1) — `main()`'s own try/catch below turns that into `uncomputable`
 * (D2/REQ-SCAN-5), this function only reads.
 *
 * `root` is forwarded to `loadBrainConfigOrThrow`; omitted, it defaults to
 * the primitive's own repo-root resolution, so the production call site
 * below (unchanged) still reads brain's own root exactly as before. Exported
 * (D3) so a test can drive the REAL reader against a fixture root, the same
 * reasoning `approve/cli.mjs`'s `defaultReadDenyActors` already applied.
 *
 * @param {string} [root]
 * @returns {object}
 */
export function defaultReadConfig(root) {
  return loadBrainConfigOrThrow(root);
}

/**
 * evaluateLaneScrub() — tier-blind by construction (design A5/C1). Filters
 * `addedFiles` down to `.memory/records/*.jsonl` paths (LANE_PATH_RE, no lane
 * branch consulted at all — A6), then runs the shared secret scanner
 * (`memory/lib/secret-scrub.mjs`) over each one via an injectable `readFile`
 * seam (pure: no `fs` import reached from inside this function). Destructures
 * `{pattern, lineNumber}` from a hit and drops `.line` — the matched text
 * itself is never surfaced (C1's own output discipline).
 *
 * `patterns`/`allowPatterns` may be passed pre-compiled (main() does this —
 * see cold-1, PR #907 cold review — so a bad regex in the secret config
 * surfaces as ITS OWN uncomputable reason, never misattributed to the
 * per-record read loop below). Falls back to compiling from `config` when
 * they are omitted, for direct unit-level calls.
 *
 * @param {{ addedFiles?: string[]|null, config?: object, patterns?: RegExp[], allowPatterns?: RegExp[], readFile: (path: string) => string }} args
 * @returns {{ pass: boolean, reason?: string }}
 */
export function evaluateLaneScrub({ addedFiles, config, patterns, allowPatterns, readFile }) {
  const recordPaths = (addedFiles ?? []).filter((path) => LANE_PATH_RE.test(path));
  if (recordPaths.length === 0) {
    return { pass: true, reason: 'no added record paths — nothing to scan' };
  }

  let compiledPatterns = patterns;
  let compiledAllowPatterns = allowPatterns;
  if (!compiledPatterns || !compiledAllowPatterns) {
    const { patternSources, allowPatternSources } = resolveSecretConfig(config);
    compiledPatterns = compiledPatterns ?? compilePatterns(patternSources);
    compiledAllowPatterns = compiledAllowPatterns ?? compilePatterns(allowPatternSources);
  }

  for (const path of recordPaths) {
    const text = readFile(path);
    const hit = scanTextForSecrets(text, compiledPatterns, compiledAllowPatterns);
    if (hit) {
      // {pattern, lineNumber} only — `hit.line` is dropped, never printed.
      return {
        pass: false,
        reason: `lane-scrub: secret pattern matched in ${path} — pattern=${JSON.stringify(hit.pattern)} lineNumber=${hit.lineNumber}`,
      };
    }
  }
  return { pass: true };
}

/**
 * main() — thin runner. Runs and reports on EVERY PR (never gated on a lane
 * branch — A6). An uncomputable added-diff fails closed (2): C1 is
 * non-waivable, so "cannot verify" must never read as "nothing to scan".
 *
 * @param {{ ctx?: object, diffNameOnlyAdded?: Function, execFileSync?: Function, readConfig?: () => object, readFile?: (path: string) => string }} [deps]
 * @returns {Promise<0|1|2>}
 */
export async function main(deps = {}) {
  const ctx = deps.ctx ?? {};
  const exec = deps.execFileSync ?? realExecFileSync;
  const diffNameOnlyAdded = deps.diffNameOnlyAdded ?? buildDefaultDiffNameOnlyAdded(ctx, exec);
  const readConfig = deps.readConfig ?? defaultReadConfig;
  const readFile = deps.readFile ?? ((path) => readFileSync(path, 'utf8'));

  let addedFiles;
  try {
    addedFiles = diffNameOnlyAdded();
  } catch (err) {
    const result = {
      pass: false,
      uncomputable: true,
      reason: `lane-scrub: cannot compute diff — failing closed (uncomputable): ${err.message}`,
    };
    console.log(result.reason);
    return resultToExit(result);
  }

  // Compute the added-records subset BEFORE touching the secret config at
  // all (cold review, PR #908): resolving/compiling the config is only ever
  // relevant when there is at least one `.memory/records/*.jsonl` path to
  // scan. A PR that adds none of those paths (the overwhelming majority of
  // PRs on this repo) must pass without ever reading the config — otherwise
  // a single bad regex in `governance.memorySecretPatterns` blocks EVERY PR,
  // not just the ones lane-scrub actually needs to check.
  const recordPaths = (addedFiles ?? []).filter((path) => LANE_PATH_RE.test(path));
  if (recordPaths.length === 0) {
    const result = { pass: true, reason: 'no added record paths — nothing to scan' };
    console.log(result.reason);
    return resultToExit(result);
  }

  // #712, D2: this try/catch wraps ONLY `readConfig()` — a NEW, separate
  // try/catch from the pattern-compile block just below, on purpose (design
  // A6/D2's own cold-review lesson, PR #907/#908): a config that cannot be
  // READ and a config that parses but holds an INVALID pattern are both
  // UNCOMPUTABLE (2), but they are different failures with different
  // reasons — folding the read into the compile block's try would print
  // "invalid secret pattern in config" for an unreadable file, which is a
  // lie. It also stays AFTER the `recordPaths.length === 0` early return
  // above (R8): the config is only relevant once there is at least one
  // record path to scan.
  let config;
  try {
    config = readConfig();
  } catch (err) {
    const result = {
      pass: false,
      uncomputable: true,
      reason: `lane-scrub: cannot read the secret config — failing closed (uncomputable): ${err.message}`,
    };
    console.log(result.reason);
    return resultToExit(result);
  }

  // Compile patterns OUTSIDE the read loop's try/catch (cold-1, PR #907 cold
  // review): compilePatterns() throws on an invalid regex source
  // (secret-scrub.mjs:42-44). A single try/catch wrapping both this AND the
  // per-record read loop below misattributed a bad secret-config pattern to
  // "cannot read an added record" — a config problem and a read problem are
  // both UNCOMPUTABLE (2), but they are different failures and must report
  // different reasons. Still computed only once there is at least one
  // record path (see the early return above).
  let patterns;
  let allowPatterns;
  try {
    const { patternSources, allowPatternSources } = resolveSecretConfig(config);
    patterns = compilePatterns(patternSources);
    allowPatterns = compilePatterns(allowPatternSources);
  } catch (err) {
    const result = {
      pass: false,
      uncomputable: true,
      reason: `lane-scrub: invalid secret pattern in config — failing closed (uncomputable): ${err.message}`,
    };
    console.log(result.reason);
    return resultToExit(result);
  }

  let result;
  try {
    result = evaluateLaneScrub({ addedFiles: recordPaths, patterns, allowPatterns, readFile });
  } catch (err) {
    // An added record that cannot be read (e.g. deleted between the diff and
    // this run) is UNCOMPUTABLE, never a false violation: C1 is non-waivable,
    // so "cannot verify" must never surface as "verified clean" (1 would be
    // just as wrong the other way — it would report a secret that was never
    // actually scanned).
    result = {
      pass: false,
      uncomputable: true,
      reason: `lane-scrub: cannot read an added record — failing closed (uncomputable): ${err.message}`,
    };
  }
  if (result.reason) console.log(result.reason);
  return resultToExit(result);
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ctx = await loadContext();
  process.exit(await main({ ctx }));
}
