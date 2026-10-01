#!/usr/bin/env node
// brain-protect.mjs — One-time operator command to activate branch protection on main.
//
// Reads vcs.provider and project.slug from brain.config.json, then calls the
// provider's branchProtect verb with the current governance check contexts.
//
// USAGE: npm run brain:protect
//
// IMPORTANT: This script is a one-time ADMIN action, not a per-developer step.
// Run it ONCE after S3 merges to the tracker branch, after all open non-compliant
// branches have been merged, rebased, or explicitly documented as exceptions.
// See ADR-0014 and brain/core/methodology/workflow-governance.md.
//
// The command is idempotent — re-running refreshes protection without side effects.
// It performs NO action on import — the activation runs only when invoked as a CLI
// (the guard at the bottom). Importing this module is side-effect-free.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkContexts, diffArmedChecks } from './vcs/governance-checks.mjs';
import { resolveTier, tierParams } from './vcs/governance-tiers.mjs';
import { t } from './i18n/t.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The protection this repo's DECLARED TIER warrants. Pure — no I/O, no network.
 *
 * `checks` was already tier-derived (REQ-TIER-9). `requiredReviews` was not: the
 * call site omitted it and `github.mjs`'s `branchProtect` defaults the parameter
 * to 1, so the value armed on the platform came from a function signature rather
 * than from doctrine (#94). Both now come from one resolution, so a run cannot
 * produce a protection state the tier table contradicts.
 *
 * Returning `tier` alongside them is deliberate: the caller PRINTS it. The defect
 * this closes was never a wrong number — it was a number nobody could see the
 * origin of.
 *
 * @param {object} config  Parsed `brain.config.json`.
 * @returns {{ tier: string, checks: string[], requiredReviews: number }}
 */
export function protectionFor(config) {
  const tier = resolveTier(config);
  return { tier, checks: checkContexts(tier), requiredReviews: tierParams(tier).requiredReviews };
}

/**
 * Best-effort post-arm verification (issue #203, design.md §3 — arm-and-verify).
 * Warns, never fails: a freshly protected branch legitimately has zero
 * check-runs before its first PR runs, so zero runs yields ONE "unverifiable"
 * note rather than one warning per required context. `listCheckRuns` is
 * injectable so tests never spawn a real `gh` (mirrors ci-context.mjs's `deps`
 * seam).
 *
 * @param {{ checks: string[], project: string, branch?: string, listCheckRuns: (args: {project: string, branch: string}) => Promise<string[]>, log?: (msg: string) => void }} opts
 */
export async function verifyArmedProtection({ checks, project, branch = 'main', listCheckRuns, log = console.log }) {
  let runNames;
  try {
    runNames = await listCheckRuns({ project, branch });
  } catch {
    // A provider's listCheckRuns/checkRuns rejecting is a verification-layer bug,
    // not an armed-protection failure — branch protection already succeeded by
    // the time this runs. Degrade to the same unverifiable note (issue #203
    // review fix F1) rather than letting the rejection propagate into
    // activateProtection and look like the arm step itself failed.
    log(await t('protect.verify.unverifiable', { branch }));
    return;
  }
  const { unverifiable, missing } = diffArmedChecks(checks, runNames);
  if (unverifiable) {
    log(await t('protect.verify.unverifiable', { branch }));
    return;
  }
  for (const context of missing) {
    log(await t('protect.verify.missing', { context }));
  }
}

/**
 * Dispatches post-arm verification based on provider capability (issue #203
 * review fix F2). A provider without a `checkRuns` verb (e.g. a hypothetical
 * GitLab provider) has no way to ever self-resolve the "no runs yet" note — it
 * will NEVER report runs, so that note would be misleading. Such a provider
 * gets a distinct "not supported" note instead, and run-based verification
 * (`verifyArmedProtection`) is skipped entirely.
 *
 * Exported for testing — activateProtection's provider module is loaded via a
 * real dynamic import with no seam, so this dispatch step is factored out to be
 * exercised directly with a fake provider module.
 *
 * @param {{ checks: string[], project: string, branch: string, provider: string, providerModule: object, log?: (msg: string) => void }} opts
 */
export async function verifyAfterArm({ checks, project, branch, provider, providerModule, log = console.log }) {
  if (typeof providerModule.checkRuns === 'function') {
    await verifyArmedProtection({ checks, project, branch, listCheckRuns: providerModule.checkRuns, log });
  } else {
    log(await t('protect.verify.unsupported', { provider }));
  }
}

/**
 * Activate branch protection on main via the configured VCS provider.
 * Side-effecting (network) — only ever called from the CLI guard below.
 */
export async function activateProtection({ _config = null, _providerModule = null } = {}) {
  // `_config`/`_providerModule` are TEST SEAMS, mirroring the `listCheckRuns`
  // injection above — they exist so a test can observe what this function ARMS
  // without spawning `gh`. #94's defect lived exactly here: the arguments sent to
  // `branchProtect`. A source-scan assertion would be blind by spelling, so the
  // call itself has to be observable.
  const configPath = resolve(__dirname, '..', '..', 'brain.config.json');
  let config = _config;
  if (!config) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error(`brain:protect: cannot read brain.config.json — ${e.message}`);
      process.exit(1);
    }
  }

  const provider = config?.vcs?.provider;
  const project = config?.project?.slug;

  if (!provider) {
    console.error('brain:protect: vcs.provider not set in brain.config.json');
    process.exit(1);
  }
  if (!project) {
    console.error('brain:protect: project.slug not set in brain.config.json');
    process.exit(1);
  }

  let providerModule = _providerModule;
  try {
    if (!providerModule) providerModule = await import(`./axes/vcs/adapters/${provider}.mjs`);
  } catch (e) {
    console.error(`brain:protect: cannot load provider "${provider}" — ${e.message}`);
    process.exit(1);
  }

  if (typeof providerModule.branchProtect !== 'function') {
    console.error(`brain:protect: provider "${provider}" does not implement branchProtect`);
    process.exit(1);
  }

  // Tier-aware (issue #358 Q5, REQ-TIER-9): checkContexts() derives its
  // required-context list from the SAME governance-tiers.mjs resolution
  // run-check.mjs's exit-policy mapping uses — arming a stricter/looser set
  // never drifts from what actually blocks merge at this repo's declared tier.
  const { tier, checks, requiredReviews } = protectionFor(config);
  // Single-sourced (issue #203 review fix F5): branchProtect and verifyAfterArm
  // must agree on the armed branch by construction, not by coincidence — both
  // are passed this same variable explicitly rather than each hardcoding 'main'
  // independently.
  const branch = 'main';
  console.log(`Activating branch protection on ${project} (provider: ${provider})`);
  console.log(`  Required checks: ${checks.join(', ')}`);
  // #94: the armed review count and the tier that produced it, on the same
  // surface as the checks. The old failure was silent, not wrong.
  console.log(`  Required reviews: ${requiredReviews} (from declared tier "${tier}")`);

  let result;
  try {
    result = await providerModule.branchProtect({ project, checks, branch, requiredReviews });
  } catch (e) {
    // branchProtect should not throw in the v2 adapter, but guard against
    // unexpected runtime errors (e.g. network timeout, unhandled edge case).
    console.error(`brain:protect failed unexpectedly: ${e.message}`);
    process.exit(1);
  }

  if (result.enforced) {
    console.log('Branch protection activated successfully.');
    // A PARTIAL success says so, here, where the operator is looking (#348).
    // The verb was taught to report the approval count it could not apply, and
    // this branch read `reason` only on failure — so the value became honest
    // while the surface stayed silent, which is the same defect one layer up.
    // A reader learns it from the output, not from the return value they never
    // see (spec R348-2).
    if (result.reason) console.log(`  Note   : ${result.reason}`);
    // Dispatches to run-based verification only when the provider supports it,
    // else logs a distinct "unsupported" note (issue #203 review fix F2).
    await verifyAfterArm({ checks, project, branch, provider, providerModule });
  } else {
    console.log('Branch protection could not be enforced.');
    console.log(`  Reason : ${result.reason ?? 'unknown'}`);
    if (result.remedy) console.log(`  Remedy : ${result.remedy}`);
    // Exit 0 — {enforced:false} is a known, non-error outcome (e.g. tier limitation).
    // Reserve exit 1 for configuration errors and unexpected failures above.
  }
}

// CLI guard — the activation runs ONLY when this file is invoked directly
// (`node brain/scripts/brain-protect.mjs` / `npm run brain:protect`), NEVER on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await activateProtection();
}
