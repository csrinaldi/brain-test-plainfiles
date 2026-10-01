#!/usr/bin/env node
// brain-check.mjs — Golden-path verb: run the 4 governance checks + tests + repo:check (REQ-S5-2).
//
// Usage: npm run brain:check
//   Runs the 4 generic checks (diffSize, issueLink, adrPresence, memoryPresence)
//   against the current branch's diff vs base (origin/main), then runs:
//     • npm test          — full test suite
//     • npm run brain:repo:check — prohibited-reference check
//   Aggregates results and exits non-zero if any check fails.
//
// The script performs NO action on import — side effects are guarded at the bottom.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { diffSize } from './governance/checks/diff-size.mjs';
import { adrPresence } from './governance/checks/adr-presence.mjs';
// THE CI EVALUATOR ITSELF, not a second implementation of the same rules (#340).
// `issue-link` and `memory-gate` each apply POLICY on top of a pure check — the
// default-branch-conditional closing keyword, the approved-label verification, the
// issue-scoped record match — and this verb used to call the pure functions bare, so
// it was strictly more permissive than the gate it exists to predict. Two of the six
// checks greenlit PRs CI then rejected. Importing the evaluator is the only version of
// this fix that cannot drift again, because there is nothing left to keep in sync.
import { runCheckWithPolicy as runGovernanceCheck } from './governance/run-check.mjs';
import { readRecordObservations } from './memory/lib/store.mjs';
// Tier resolution (issue #358 Q5, REQ-TIER-9): brain:check is a local
// golden-path verb, not a labeled-PR gate — it has no size:exception surface —
// but its diff-size BUDGET must still come from the single tiered source, not
// a second hardcoded 400 default (diffSize()'s own module-level fallback).
import { resolveTier, tierParams } from './vcs/governance-tiers.mjs';
// What the local gates need to know before a PR exists — the slug, the default branch and
// whether `npm test` applies — resolved the way the rest of the product resolves them
// (#1186, #1187). One module, so brain:ship reads the same answers.
import { resolveProjectSlug, resolveDefaultBranch, npmTestApplicability } from './lib/local-gate-context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── helpers ───────────────────────────────────────────────────────────────────

function git(args, cwd = process.cwd()) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function loadIgnoreList(cwd) {
  const cfg = loadFullConfig(cwd);
  return Array.isArray(cfg?.governance?.ignoreList) ? cfg.governance.ignoreList : [];
}

/** Load the full brain.config.json; returns {} on any error (never throws — resolveTier defaults to 'standard' on {}). */
function loadFullConfig(cwd) {
  try {
    return JSON.parse(readFileSync(resolve(cwd, 'brain.config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * The commit the diff is measured from: the merge-base with the REMOTE's default branch.
 * `origin/main` is tried last, and only as a diff base — never as a policy answer: on a
 * remote whose default is not `main` the old hardcode measured against a branch that did
 * not exist and fell through to an empty diff, which `diffSize` reads as a pass (#1186).
 */
function getBase(cwd, defaultBranch) {
  for (const ref of [defaultBranch && `origin/${defaultBranch}`, 'origin/main']) {
    if (!ref) continue;
    try {
      execSync(`git rev-parse ${ref}`, { encoding: 'utf8', cwd, stdio: 'pipe' });
      return git(`merge-base HEAD ${ref}`, cwd) || 'HEAD';
    } catch { /* surfaced: try the next candidate; 'HEAD' (an empty diff) is the last resort below */ }
  }
  return 'HEAD';
}

/** What an operator can actually do about an UNVERIFIED check (#340). The reason is the check's own (#1186). */
const REMEDY = {
  issueLink: (reason) =>
    `${reason ?? 'evidence unavailable'} — check the network; export DEFAULT_BRANCH if the remote's default branch cannot be resolved`,
};

/**
 * The branch this work will be PROPOSED against — which no local command can know for
 * certain, because the PR does not exist yet (#340).
 *
 * So it defaults to the default branch, and that direction is the whole point: the
 * default-branch rule is the STRICTER one (a closing keyword is required), and #340's
 * ruling is that a local check stricter than CI is an annoyance while a local check
 * laxer than CI is a broken promise. Assuming "slice" would be the permissive guess and
 * would reproduce this ticket exactly.
 *
 * `BASE_BRANCH` overrides it, matching the env var the CI job already reads, so a slice
 * PR author asks for the laxer rule explicitly instead of receiving it by accident.
 */
function getTargetBranch(cwd, env = process.env, defaultBranch = resolveDefaultBranch({ cwd, env })) {
  return env.BASE_BRANCH || defaultBranch;
}

/**
 * The CI gate each local check front-runs (#1187). The maintainer rule is that a local
 * verdict is neither stricter nor looser than CI's for the same inputs, so every local
 * check must name the gate it anticipates; `null` would mean "no CI counterpart" and the
 * output would say so. Pinned against `GOVERNANCE_JOBS` in `local-ci-parity.test.mjs`.
 */
export const CI_COUNTERPART = Object.freeze({
  diffSize: 'diff-size',
  adrPresence: 'decision-gate',
  issueLink: 'issue-link',
  memoryPresence: 'memory-gate',
  npmTest: 'local-checks', // the `npm test` step, which CI runs only in the brain source repo
  repoCheck: 'local-checks', // the `brain:repo:check` step
  navCheck: 'local-checks', // the `brain:nav` step
  indexLag: 'local-checks', // the `memory/index-lag.mjs` step — warning-only in CI, so here too
});

/**
 * Every CI `run:` command brain:check executes (or, for the governance jobs, evaluates through
 * the same predicate). `local-ci-parity.test.mjs` derives the run steps of each mapped job from
 * `.github/workflows/governance.yml` and requires each to be listed here: a step added to a CI
 * job fails that test until brain:check runs it too (#1186, PR #1192 review).
 */
export const CI_STEPS_COVERED = Object.freeze([
  'node brain/scripts/governance/run-check.mjs issue-link',
  'node brain/scripts/governance/run-check.mjs diff-size',
  'node brain/scripts/governance/run-check.mjs memory-gate',
  'node brain/scripts/governance/run-check.mjs decision-gate',
  'npm run brain:repo:check',
  'npm run brain:nav',
  'node brain/scripts/memory/index-lag.mjs',
  'npm test',
]);

function spawnCommand(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd });
  return { ok: r.status === 0, output: (r.stdout ?? '') + (r.stderr ?? '') };
}

// ── core logic (injectable for tests) ────────────────────────────────────────

/**
 * Run all governance checks.
 *
 * @param {object}   ctx
 * @param {string}   ctx.numstat       Raw `git diff --numstat` output.
 * @param {string[]} ctx.changedFiles  Files from `git diff --name-only`.
 * @param {string[]|null} [ctx.addedFiles]  Files from `git diff --diff-filter=A --name-only`.
 *   #510: this verb must reach the SAME verdict the CI gate reaches — a local green
 *   that CI rejects is the defect #340 already records for issue-link.
 * @param {string}   ctx.prBody        Latest commit body (for issueLink check).
 * @param {string[]} ctx.ignoreList    brain.config.json governance.ignoreList.
 * @param {Array}    ctx.observations  Parsed engram observations for memoryPresence.
 *   Injected by tests or read from .memory/chunks/ in the CLI entry-point.
 * @param {number}   [ctx.budget]      Tier-resolved diff-size budget (issue #358
 *   Q5, REQ-TIER-9). Undefined falls through to diffSize()'s own 400-line
 *   default (standard tier) — real callers resolve
 *   `tierParams(resolveTier(config)).diffBudget` and pass it explicitly.
 * @param {string|null} [ctx.targetBranch]  The branch the PR will target (#340). `null`
 *   makes `issueLink` UNCOMPUTABLE rather than assuming the permissive slice rule.
 * @param {string|null} [ctx.defaultBranch] The remote's default branch (#340).
 * @param {Function} [ctx.fetchIssue]   Async (n) → { labels }. The approved-label
 *   lookup CI performs; a network call, so it is injected here and its failure
 *   surfaces as UNVERIFIED rather than as a pass.
 * @param {Function} ctx.npmTestFn     Async fn() → {ok,output}. Injected for tests.
 * @param {Function} ctx.repoCheckFn   Async fn() → {ok,output}. Injected for tests.
 * @returns {Promise<{exitCode:number, failures:Array, unverified:Array, summary:string}>}
 */
export async function runCheck({
  numstat,
  changedFiles,
  addedFiles = null,
  prBody,
  ignoreList,
  observations = [],
  budget,
  targetBranch = null,
  defaultBranch = null,
  fetchIssue,
  // #1024: memory-gate's scoped check now also reads origin/<default> (D3
  // lazy union). Left undefined here, `run-check.mjs` uses the REAL reader —
  // desired for a local `brain:check` run, which should see the same union a
  // CI run would. Tests inject a hermetic fake so this stays a pure unit
  // test with no real git/network call.
  readDefaultBranchRecords,
  // #1186: the repo's own config, so the slug the port is asked about and the tier the
  // gates resolve come from `brain.config.json` — the same source CI's `readConfig` reads.
  // `{}` (tier `standard`, no slug) is the hermetic default for unit tests.
  config = {},
  // Injected in tests; the CLI leaves it to the origin remote.
  identity,
  getVcs,
  // #1187: `{ applicable: false, reason }` makes `npm test` "not applicable" — stated in
  // the output, never run, never a failure. See lib/local-gate-context.mjs.
  npmTestApplicability: npmApplicability = { applicable: true },
  npmTestFn,
  repoCheckFn,
  // The other two steps of CI's `local-checks`. Default to a pass so hermetic unit tests that
  // do not exercise them stay pure; the CLI always injects the real scripts.
  navCheckFn = async () => ({ ok: true }),
  indexLagFn = async () => ({ ok: true }),
}) {
  // The context the CI evaluator reads. ONE object feeding both checks, because
  // `memory-gate` resolves the issue number from the same body `issue-link` does — two
  // contexts would be two chances to disagree about which issue this change is about.
  //
  // `repo` is the slug the port's `issueView` takes as `project`. It was never set, so the
  // default `fetchIssue` asked for `repos/undefined/issues/N` on every fresh consumer (#1186).
  const govCtx = {
    body: prBody,
    targetBranch,
    defaultBranch,
    provider: config?.vcs?.provider,
    repo: resolveProjectSlug({ config, ...(identity ? { identity } : {}) }),
  };
  const govDeps = {
    ctx: govCtx,
    // The config the TIER and the approved-label name come from — the dep CI reads too.
    readConfig: () => config,
    ...(getVcs ? { getVcs } : {}),
    ...(fetchIssue ? { fetchIssue } : {}),
    ...(readDefaultBranchRecords ? { readDefaultBranchRecords } : {}),
  };

  const checks = [
    // diffSize and adrPresence stay on the pure functions, and that is a decision, not
    // an omission (#340's audit). `adrPresence` is already fed the same two lists CI
    // feeds it, so it is aligned by construction. `diffSize` diverges in the SAFE
    // direction only: CI honours a `size:exception` label, and no label exists before
    // the PR does — so local is stricter. Routing it through the CI evaluator would
    // mean inventing a label set, which is the one change that could make local LAXER.
    { check: 'diffSize',        result: diffSize(numstat, ignoreList, budget) },
    { check: 'adrPresence',     result: adrPresence(changedFiles, addedFiles) },
    // Both of these now run THE CI EVALUATOR. `issueLink` gains the
    // default-branch-conditional closing keyword and the approved-label check;
    // `memoryPresence` gains the issue-scoped record match. Each was a documented
    // false green before (#340).
    { check: 'issueLink',       result: await runGovernanceCheck('issue-link', govDeps) },
    {
      check: 'memoryPresence',
      result: await runGovernanceCheck('memory-gate', { ...govDeps, readRecords: () => observations }),
    },
  ];

  // Run async checks. `npm test` runs only where CI runs it (#1187): an inapplicable one
  // is REPORTED as not applicable — never silently omitted, never a failure.
  const npmApplicable = npmApplicability.applicable !== false;
  const [npmResult, repoResult, navResult, lagResult] = await Promise.all([
    npmApplicable ? npmTestFn() : Promise.resolve(null),
    repoCheckFn(),
    navCheckFn(),
    indexLagFn(),
  ]);
  if (npmResult === null) {
    checks.push({ check: 'npmTest', result: { pass: true, notApplicable: true, reason: npmApplicability.reason } });
  } else if (!npmResult.ok) {
    checks.push({ check: 'npmTest', result: { pass: false, reason: npmResult.output?.split('\n').slice(-3).join(' ') || 'npm test failed' } });
  } else {
    checks.push({ check: 'npmTest', result: { pass: true } });
  }
  if (!repoResult.ok) checks.push({ check: 'repoCheck', result: { pass: false, reason: repoResult.output?.split('\n').slice(-3).join(' ') || 'repo:check failed' } });
  else checks.push({ check: 'repoCheck', result: { pass: true } });
  if (!navResult.ok) checks.push({ check: 'navCheck', result: { pass: false, reason: navResult.output?.split('\n').slice(-3).join(' ') || 'brain:nav failed' } });
  else checks.push({ check: 'navCheck', result: { pass: true } });
  // index-lag never blocks in CI (the script always exits 0 and only warns), so it never blocks
  // here either: whatever it printed becomes a `::warning::`, and the check passes.
  const lagText = (lagResult.output ?? '').trim();
  checks.push({
    check: 'indexLag',
    result: { pass: true, ...(lagText ? { reason: `::warning::${lagText.split('\n').join(' ')}` } : {}) },
  });

  // THREE outcomes, not two (#340). A check whose evidence could not be gathered —
  // no network for the approved-label lookup, an unresolvable default branch — is
  // UNVERIFIED. It is not a pass, and printing it as one is exactly the confident false
  // green this ticket is about.
  //
  // It is not an exit-1 either, and that is deliberate: CI fails closed on uncomputable
  // because a merge is at stake, while a local verb that refuses to run offline is a
  // verb people stop running — the "gates are obstacles" lesson from #529's ruling.
  // What it must never do is CLAIM. The `unverified` list is what the CLI prints
  // instead of "Ready to brain:ship".
  const unverified = checks
    .filter(c => !c.result.pass && c.result.uncomputable)
    .map(c => ({ check: c.check, reason: c.result.reason }));

  const failures = checks
    .filter(c => !c.result.pass && !c.result.uncomputable)
    .map(c => ({ check: c.check, reason: c.result.reason }));

  const state = (r) => (r.notApplicable ? 'N/A' : r.pass ? 'PASS' : r.uncomputable ? 'UNVERIFIED' : 'FAIL');
  const lines = checks.map(c =>
    `  [${state(c.result)}] ${c.check}${c.result.reason ? ` — ${c.result.reason}` : ''}`
    + (CI_COUNTERPART[c.check] === null ? ' (local only — no CI counterpart)' : '')
  );

  const summary = lines.join('\n');
  return { exitCode: failures.length > 0 ? 1 : 0, failures, unverified, summary };
}

// ── CLI entry-point ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cwd = process.cwd();
  const config = loadFullConfig(cwd);
  // Resolved ONCE and fed to both the diff base and the policy, so they cannot disagree.
  const defaultBranch = resolveDefaultBranch({ cwd });
  const base = getBase(cwd, defaultBranch);
  const numstat = git(`diff --numstat ${base} HEAD`, cwd);
  const changedFiles = git(`diff --name-only ${base} HEAD`, cwd).split('\n').filter(Boolean);
  const addedFiles = git(`diff --diff-filter=A --name-only ${base} HEAD`, cwd).split('\n').filter(Boolean);
  // Use the last commit body as the PR body proxy for issueLink check.
  const prBody = git('log -1 --format=%B HEAD', cwd);
  const ignoreList = loadIgnoreList(cwd);
  const budget = tierParams(resolveTier(config)).diffBudget;

  const observations = readRecordObservations({ recordsDir: join(cwd, '.memory', 'records') });

  const result = await runCheck({
    numstat,
    changedFiles,
    addedFiles,
    prBody,
    ignoreList,
    observations,
    budget,
    config,
    defaultBranch,
    targetBranch: getTargetBranch(cwd, process.env, defaultBranch),
    npmTestApplicability: npmTestApplicability({ cwd }),
    npmTestFn: () => spawnCommand('npm', ['test'], cwd),
    repoCheckFn: () => spawnCommand('node', ['brain/scripts/check-refs.mjs'], cwd),
    navCheckFn: () => spawnCommand('node', ['brain/scripts/check-brain-nav.mjs'], cwd),
    indexLagFn: () => spawnCommand('node', ['brain/scripts/memory/index-lag.mjs'], cwd),
  });

  console.log('\nbrain:check results:\n');
  console.log(result.summary);
  console.log('');

  if (result.exitCode > 0) {
    console.error(`${result.failures.length} check(s) failed. Fix before brain:ship.`);
  } else if (result.unverified.length > 0) {
    // NOT "Ready to brain:ship" (#340). This verb's whole value is predicting CI, and
    // it cannot predict a check whose evidence it could not read. Naming them is the
    // difference between "I checked and it is fine" and "I could not check".
    console.log(`${result.unverified.length} check(s) could NOT be verified locally — CI will still evaluate them:`);
    for (const u of result.unverified) {
      console.log(`  · ${u.check}${REMEDY[u.check] ? ` — ${REMEDY[u.check](u.reason)}` : ''}`);
    }
    console.log('\nEverything else passed.');
  } else {
    console.log('All checks passed. Ready to brain:ship.');
  }

  process.exit(result.exitCode);
}
