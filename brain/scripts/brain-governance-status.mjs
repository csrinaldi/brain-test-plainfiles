#!/usr/bin/env node
// brain-governance-status.mjs — Report the current state of all three governance layers.
//
// Reads vcs.provider and project.slug from brain.config.json, probes the VCS
// provider's capability API, and prints a per-consumer status table.
//
// USAGE: npm run brain:governance-status
//
// Output example:
//
//   brain:governance status — owner/repo (github)
//
//     hooks       ON  [universal]
//     brain:audit ON  [universal]
//     platform    available  (branch protection APIs accessible)
//
// The script performs NO action on import — the report runs only when invoked as a
// CLI (the guard at the bottom). Importing this module is side-effect-free.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './vcs/lib/exec.mjs';
import { detectSubstrate, POSTMERGE_STALE_LABEL } from './vcs/substrate.mjs';
import { GOVERNANCE_JOBS } from './vcs/governance-checks.mjs';
import { resolveTier, requiredJobs } from './vcs/governance-tiers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function repoFileExists(relPath) {
  return existsSync(resolve(REPO_ROOT, relPath));
}

// ── Real substrate probes (production wiring — design §1) ──────────────────────
//
// These are thin I/O wrappers around `gh api` / filesystem presence, mirroring
// github.mjs's capabilities()/branchProtect() convention: not unit-tested
// directly (no live gh/network call belongs in `node --test`), but exercised
// end-to-end via detectSubstrate()'s already-tested pure orchestration
// (substrate.test.mjs) and reportGovernanceStatus()'s print logic below, which
// IS unit-tested — always via injected `probes` overrides, never these real
// implementations. Called only when the caller does not inject an override.

/**
 * Rung 1 — finer branch-protection read: 200+contexts / 404 / 403. Dispatches
 * on `config.vcs.provider` (issue #244 A4, mirrors realBrainWritesReviewedProbe
 * :78-111). GitLab reads the PER-BRANCH protected-branch endpoint inline
 * (parity with how the GitHub branch below inlines its `gh` read — NOT
 * `capabilities()`, which false-positives 'available' on an empty
 * protected_branches COLLECTION, contradicting the CP-A2b mirror evidence,
 * memory #565) PLUS the new `projectMergeSettings` verb — read off `vcs`
 * (the already-resolved providerModule detectSubstrate threads through,
 * exactly like every other injected probe override in this file's tests), not
 * a fresh dynamic import.
 */
async function realBranchProtectionProbe({ config, vcs }) {
  const provider = config?.vcs?.provider;
  const project = config?.project?.slug;
  const branch = config?.project?.defaultBranch ?? 'main';
  if (!project) return { status: undefined, contexts: [] };

  if (provider === 'gitlab') {
    const enc = encodeURIComponent(project);
    const rb = run('glab', ['api', `projects/${enc}/protected_branches/${encodeURIComponent(branch)}`]);
    let status;
    if (rb.ok) status = 200;
    else if (rb.stderr.includes(': 404')) status = 404;
    else if (rb.stderr.includes(': 401') || rb.stderr.includes(': 403')) status = 403;
    const { onlyAllowMergeIfPipelineSucceeds } = await vcs.projectMergeSettings({ project });
    return { status, contexts: [], pipelineMustSucceed: onlyAllowMergeIfPipelineSucceeds };
  }

  const r = run('gh', ['api', `repos/${project}/branches/${branch}/protection`]);
  if (r.ok) {
    let contexts = [];
    try {
      contexts = JSON.parse(r.stdout)?.required_status_checks?.contexts ?? [];
    } catch {
      contexts = [];
    }
    return { status: 200, contexts };
  }
  if (r.stderr.includes('404')) return { status: 404, contexts: [] };
  if (r.stderr.includes('403') || /upgrade.*pro/i.test(r.stderr)) return { status: 403, contexts: [] };
  return { status: r.status ?? undefined, contexts: [] };
}

/**
 * Rung 2 — release-gate RAW EVIDENCE, never a verdict (issue #337, design D1).
 * All interpretation (trigger classification, audit-invocation + permissions
 * check) lives in evalRung2/classifyReleaseWorkflow (substrate.mjs), where it
 * stays unit-testable with injected text fixtures. This probe is a dumb I/O
 * wrapper: it reads config + the workflow file and hands back structured
 * evidence. A read failure (missing file caught by existsSync already, or any
 * other fs error) degrades `workflowText` to `null` — never thrown, never
 * silently coerced into a false "not wired".
 */
async function realReleaseGateProbe({ config }) {
  const declared = config?.governance?.releaseGate === true;
  const workflowPresent = repoFileExists('.github/workflows/release.yml');
  let workflowText = null;
  if (workflowPresent) {
    try {
      workflowText = readFileSync(resolve(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');
    } catch {
      workflowText = null; // honestly unparseable — never fabricate content
    }
  }
  return { declared, workflowPresent, workflowText };
}

/**
 * Rung 3 — post-merge CI run-ledger RAW EVIDENCE, never a verdict (issue #468,
 * closing the gap that let a 12-day post-merge CI outage report armed). All
 * interpretation (staleness, conclusion, unproven/uncomputable) lives in
 * evalRung3 (substrate.mjs), where it stays unit-testable with injected
 * evidence fixtures — this probe is a dumb I/O wrapper: fs presence + a
 * WORKFLOW-SCOPED `gh api` read, never the self-referential
 * `env.GITHUB_ACTIONS === 'true'` short-circuit this replaces (that route
 * armed unconditionally from inside CI, including from inside the broken
 * workflow's own run — the second lie identified in the proposal).
 *
 * `observedAt` is injected here, AT THE READ (`Date.now()`), because the
 * clock is I/O — substrate.mjs's pure-orchestrator rule forbids evalRung3
 * from calling it directly; this is the ONLY place `Date.now()` appears for
 * this feature.
 */
async function realPostMergeCiProbe({ config }) {
  const workflowPresent = repoFileExists('.github/workflows/governance-postmerge.yml');
  const observedAt = Date.now();

  if (!workflowPresent) {
    return { workflowPresent, read: 'skipped', lastRun: null, error: null, observedAt };
  }

  if (config?.vcs?.provider !== 'github') {
    // No ledger reader wired for this provider — keeps today's inert +
    // remedy behavior for GitLab (design "Provider safety"), no `gh`/`glab`
    // spawn either way.
    return { workflowPresent, read: 'unsupported', lastRun: null, error: null, observedAt };
  }

  const project = config?.project?.slug;
  if (!project) {
    return { workflowPresent, read: 'failed', lastRun: null, error: 'no project.slug configured', observedAt };
  }
  const branch = config?.project?.defaultBranch ?? 'main';

  // Workflow-scoped endpoint (design's "Endpoint" sub-ruling) — deliberately
  // NOT rerunWorkflowRun's repo-wide `actions/runs?branch=...&per_page=100` +
  // client-side `.path` filter: on a repo where governance.yml fires on every
  // PR push, the post-merge run can fall off page 1 of that repo-wide read,
  // producing a false "zero runs".
  const r = run('gh', [
    'api',
    `repos/${project}/actions/workflows/governance-postmerge.yml/runs?branch=${encodeURIComponent(branch)}&per_page=20`,
  ]);
  if (!r.ok) {
    return { workflowPresent, read: 'failed', lastRun: null, error: r.stderr.trim() || `gh api failed (status ${r.status})`, observedAt };
  }

  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return { workflowPresent, read: 'failed', lastRun: null, error: `malformed run-ledger response: ${e.message}`, observedAt };
  }

  // A parseable-but-wrong-shaped 200 body (proxy/gateway error page, API
  // shape change) must be distinguished from a legitimate zero-runs page —
  // conflating the two would report the honest, claimable postmerge-unproven
  // state (E4) for what is actually an unreadable ledger. The 4-state `read`
  // field exists precisely to keep this distinction (issue #468 hardening).
  if (!Array.isArray(parsed?.workflow_runs)) {
    return { workflowPresent, read: 'failed', lastRun: null, error: 'malformed run-ledger response: workflow_runs is missing or not an array', observedAt };
  }
  const runs = parsed.workflow_runs;
  const completed = runs.find((entry) => entry.status === 'completed');
  const lastRun = completed
    ? { id: completed.id, conclusion: completed.conclusion, completedAt: completed.updated_at, htmlUrl: completed.html_url }
    : null;

  return { workflowPresent, read: 'ok', lastRun, error: null, observedAt };
}

/** rungs[1].gates.brainWritesReviewed — per-provider L6 rung-1 sub-probe. */
async function realBrainWritesReviewedProbe({ config }) {
  const provider = config?.vcs?.provider;

  if (provider === 'github') {
    const project = config?.project?.slug;
    const branch = config?.project?.defaultBranch ?? 'main';
    const codeownersPresent = repoFileExists('.github/CODEOWNERS');
    if (!project) return { requireCodeOwnerReviews: false, codeownersPresent };

    const r = run('gh', ['api', `repos/${project}/branches/${branch}/protection`]);
    let requireCodeOwnerReviews = false;
    if (r.ok) {
      try {
        requireCodeOwnerReviews = Boolean(
          JSON.parse(r.stdout)?.required_pull_request_reviews?.require_code_owner_reviews,
        );
      } catch {
        // leave false — an unparsable response is honestly "not confirmed"
      }
    }
    return { requireCodeOwnerReviews, codeownersPresent };
  }

  if (provider === 'gitlab') {
    // No generic GitLab tier probe wired yet — report honestly as not confirmed
    // rather than guessing; the evidence-based checker remains the guarantee.
    return { premiumOrHigher: false };
  }

  // Bitbucket / unset: substrate.mjs never calls this probe for these
  // providers (nit-a fix), so this branch is unreachable in practice — kept
  // only as a defensive fallback.
  return undefined;
}

const RUNG_GUARANTEE = {
  1: 'merge is blocked until governance checks pass (branch protection armed with required contexts)',
  2: 'the release/tag path fails closed on brain:audit violations before publish',
  3: 'post-merge CI auto-corrects violations after merge (auto-revert)',
};

/**
 * Prints the tier × rung cross-product (issue #358 Q5, REQ-TIER-11). The tier
 * is DECLARED (`governance.tier`); the rung is DETECTED (`detectSubstrate`) —
 * printed as separate, labelled facts, never merged into one verdict that
 * hides which axis produced it (REQ-TIER-4). Per gate, a doctrine-required
 * gate on a substrate that cannot block (rung !== 1) is rendered as
 * "required by doctrine, detection-only in substrate" — never as armed, and
 * never silently omitted. Pure w.r.t. I/O — only writes to console.log, so
 * it is trivially covered by the caller's tests (injected tier + substrate).
 *
 * @param {'lite'|'standard'|'regulated'} tier
 * @param {Awaited<ReturnType<typeof detectSubstrate>>} substrate
 */
function printDoctrineReport(tier, substrate) {
  console.log('  --- governance doctrine (tier x rung) ---');
  console.log(`  tier ${tier} (declared)  ·  rung ${substrate.rung} (detected)`);

  // The ACTUALLY-ENFORCED required set at this tier (governance-tiers.mjs's
  // requiredJobs(), which additionally filters PENDING_PROMOTION gates whose
  // evidence forms haven't landed yet — see governance-tiers.mjs's STAGED
  // ROLLOUT note). Using this, rather than the raw matrix policy, keeps this
  // report consistent with what checkContexts(tier) actually arms — the two
  // consumer surfaces derive from the same source (REQ-TIER-9) and must never
  // disagree here either.
  const required = requiredJobs(tier);

  for (const gate of GOVERNANCE_JOBS) {
    if (required.includes(gate)) {
      const composition = substrate.rung === 1
        ? 'required by doctrine, enforced in substrate (rung 1)'
        : `required by doctrine, detection-only in substrate (rung ${substrate.rung})`;
      console.log(`  ${gate}: ${composition}`);
    } else {
      console.log(`  ${gate}: detection by doctrine (tier ${tier})`);
    }
  }

  console.log('');
}

/**
 * Prints the governance substrate ladder report (REQ-HONESTY-1, REQ-HONESTY-2).
 * Pure w.r.t. I/O — takes the already-computed `substrate` result and only
 * writes to console.log, so it is trivially covered by the caller's tests.
 * @param {Awaited<ReturnType<typeof detectSubstrate>>} substrate
 */
function printSubstrateReport(substrate, { defaultBranch = 'main' } = {}) {
  console.log('  --- governance substrate ---');

  if (substrate.rung === 4) {
    // REQ-HONESTY-2: never a bare "ok" — this is a release-blocking-visible
    // concern, not a passing/neutral status.
    console.log('  RUNG 4 — DETECTION ONLY, no enforcing guarantee');
    console.log(
      '              violations are reported but nothing blocks merge, release, or post-merge',
    );
  } else {
    console.log(`  RUNG ${substrate.rung} — ${RUNG_GUARANTEE[substrate.rung]}`);
  }

  // REQ-HONESTY-1: remedy to climb higher, suppressed only at the ceiling (rung 1).
  if (substrate.rung !== 1 && substrate.remedy) {
    console.log(`              remedy: ${substrate.remedy}`);
  }

  // Rung-1 sub-gate breakdown (issue #244 A4, REQ-A4-2). Driven SOLELY by
  // gates.*.active/verifiable — never a hardcoded independent branch. An
  // API-verified gate (verifiable:true) renders as DETECTED; a config-declared,
  // non-remotely-verifiable gate (verifiable:false) renders the honest caveat —
  // never the word "verified". Data (substrate.mjs) and this rendering change
  // together (the honesty contract).
  const gates = substrate.rungs?.[1]?.gates ?? {};
  if (gates.pipelineMustSucceed?.active) {
    console.log('  merge gate     armed  [only_allow_merge_if_pipeline_succeeds / required checks]');
  }
  if (gates.protectedBranches?.active) {
    console.log('  push gate      armed  [protected branch — direct pushes blocked]');
  }
  if (gates.preReceive?.active) {
    // preReceive is ALWAYS verifiable:false (evalPreReceiveGate, substrate.mjs)
    // — no endpoint can ever confirm a bare-repo server hook is installed. A4's
    // entire point is to never claim detection/verification that can't happen,
    // so there is deliberately no "verified" branch here to keep in sync.
    console.log(
      '  pre-receive    armed (config-declared) — not remotely detectable; verify via install runbook (npm run brain:protect-server)',
    );
  }

  const brainWritesGate = substrate.rungs?.[1]?.gates?.brainWritesReviewed;
  if (brainWritesGate && brainWritesGate.active === false) {
    console.log(
      `  brain-writes-reviewed enforced at evidence rung; CODEOWNERS rung-1 enhancement unavailable: ${brainWritesGate.reason}`,
    );
  }

  // Rung-2 release-gate breakdown (issue #337, REQ-L2-1/REQ-HONESTY-1). Driven
  // SOLELY by rungs[2].active/verifiable/mechanism — never a hardcoded
  // independent branch, mirroring the rung-1 preReceive caveat above. A
  // structurally-proven armed gate (verifiable:true) renders as armed with no
  // caveat; a config-declared armed gate (verifiable:false) renders the honest
  // caveat — never the word "verified". A present-but-inert workflow (e.g.
  // brain's own post-tag release.yml) surfaces its reason + remedy even when
  // rung 2 is not the selected rung, so the ladder's efficacy story never
  // silently disappears once the report demotes below it.
  const rung2 = substrate.rungs?.[2];
  if (rung2?.active && rung2.verifiable === false) {
    // Mirrors preReceive: a bare config declaration is armed but NEVER
    // "verified" — no structural read backs it (unverified, Phase 4 #210
    // would replace the declaration with a proven workflow).
    console.log(
      '  release gate   armed (config-declared) — unverified; not structurally confirmed against a workflow',
    );
  } else if (rung2 && rung2.active === false && rung2.mechanism === 'release-gate-workflow-structural') {
    // The workflow IS structurally readable but cannot block (e.g. brain's own
    // post-tag trigger) — honestly surfaced even though rung 2 is not selected.
    console.log(`  release gate   present but cannot block (post-tag trigger): ${rung2.reason}`);
    if (rung2.remedy) console.log(`                 remedy: ${rung2.remedy}`);
  } else if (rung2?.active && rung2.verifiable) {
    console.log('  release gate   armed  [workflow triggers pre-tag, invokes brain:audit, holds contents:write]');
  }

  // Rung-3 post-merge-CI breakdown (issue #468, REQ-R3-8/REQ-HONESTY-1/2).
  // Driven SOLELY by rungs[3].available/active/verifiable/mechanism — never an
  // independent hardcoded branch, same discipline as rung 1/rung 2 above.
  // Order matters: `available === false` (uncomputable) is checked FIRST so
  // it can never be swallowed by an inert render — the whole point of this
  // change is that a broken/unreachable read must never masquerade as a
  // confirmed "not armed".
  const rung3 = substrate.rungs?.[3];
  if (rung3?.available === false) {
    console.log(`  post-merge CI  UNCOMPUTABLE — ${rung3.reason}`);
    if (rung3.remedy) console.log(`                 remedy: ${rung3.remedy}`);
  } else if (rung3?.active && rung3.verifiable === false) {
    console.log('  post-merge CI  armed (declared) — unverified; no run-ledger evidence');
  } else if (rung3?.active) {
    console.log(`  post-merge CI  armed  [last governance-postmerge run on ${defaultBranch} succeeded within ${POSTMERGE_STALE_LABEL}]`);
  } else if (rung3 && rung3.active === false) {
    console.log(`  post-merge CI  not armed: ${rung3.reason}`);
    if (rung3.remedy) console.log(`                 remedy: ${rung3.remedy}`);
  }
  // REQ-R3-8 names `verifiable` and `mechanism` as the rendered signal, not
  // merely as the render's input. Emitted from ONE site rather than per branch:
  // a per-branch trailer drifts the moment a branch is added, and a rung-3
  // signal that is computed but unrendered is the exact gap this requirement
  // closes. `String(...)` keeps an uncomputed `verifiable` legible as
  // "undefined" instead of asserting a `false` nobody derived.
  if (rung3) {
    console.log(`                 evidence: mechanism=${rung3.mechanism} verifiable=${String(rung3.verifiable)}`);
  }

  console.log('');
}

/**
 * Read brain.config.json and report governance layer status.
 * Side-effecting (may probe the network) — only ever called from the CLI guard
 * with no overrides, so it hits the real config file, VCS provider, and
 * substrate probes. Tests MUST always pass `config`, `providerModule`, and
 * `probes` overrides to stay fully offline.
 *
 * @param {object} [opts]
 * @param {object} [opts.config]         brain.config.json contents (overrides disk read)
 * @param {object} [opts.env]            environment variables (defaults to process.env)
 * @param {object} [opts.providerModule] pre-resolved VCS provider module (overrides dynamic import)
 * @param {object} [opts.probes]         substrate probe overrides (see substrate.mjs)
 */
/**
 * Pure: the `approvals` lines for a capability report (#348).
 *
 * Extracted so R348-3 is testable without driving the whole status report —
 * round 3 measured that the requirement shipped with zero assertions on its
 * output, which is the third time in this PR that one surface got coverage and
 * a sibling did not.
 *
 * The axis is printed BESIDE `platform`, never folded into it: the account
 * types make them independent, and not in the direction a reader expects.
 * GitLab Free reaches rung 1 through its protected branch while brain enforces
 * no approval count there; GitHub Free-private has neither. One line for both
 * would make the stronger case look like the weaker one.
 *
 * @param {{approvalCount?: string, approvalRemedy?: string, approvalDetail?: string}} cap
 * @returns {string[]}
 */
export function approvalLines(cap = {}) {
  if (cap.approvalCount === 'available') {
    return ["  approvals   available  (the tier's requiredReviews is applied)"];
  }
  if (cap.approvalCount === 'unavailable') {
    const out = ['  approvals   NOT ENFORCED'];
    if (cap.approvalRemedy) out.push(`              → ${cap.approvalRemedy}`);
    return out;
  }
  // No else-if: a provider that omits the axis entirely must not vanish from
  // the report. `unknown` is a first-class answer in this module's own words,
  // and a silently missing line is the one thing it may not degrade into.
  const out = ['  approvals   unknown'];
  if (cap.approvalDetail) out.push(`              (${cap.approvalDetail})`);
  else if (cap.approvalCount === undefined) out.push('              (this provider does not report the axis)');
  return out;
}

export async function reportGovernanceStatus({
  config: configOverride,
  env = process.env,
  providerModule: providerModuleOverride,
  probes: probeOverrides,
} = {}) {
  let config = configOverride;
  if (!config) {
    const configPath = resolve(REPO_ROOT, 'brain.config.json');
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (e) {
      console.error(`brain:governance-status: cannot read brain.config.json — ${e.message}`);
      process.exit(1);
    }
  }

  const provider = config?.vcs?.provider ?? 'unknown';
  const project = config?.project?.slug ?? 'unknown';

  console.log(`\nbrain:governance status — ${project} (${provider})\n`);
  // Hooks and brain:audit are always ON regardless of provider tier.
  console.log('  hooks       ON  [universal]');
  console.log('  brain:audit ON  [universal]');
  // pre-receive is NOT universal — it is a rung-1 mechanism, armed only when
  // config-declared (config.vcs.selfHostedPreReceive). Rendered per-gate below,
  // in printSubstrateReport's rung-1 sub-gate breakdown (issue #244 A4).

  // The platform capability section is independent of the substrate ladder
  // below — it never early-returns anymore, so the substrate report (which
  // must print even with no VCS provider wired, per REQ-HONESTY-2) always runs.
  let providerModule = providerModuleOverride;
  let platformKnown = true;

  if (!config?.vcs?.provider) {
    console.log('  platform    UNKNOWN (vcs.provider not configured)');
    platformKnown = false;
  } else if (!providerModule) {
    try {
      providerModule = await import(`./axes/vcs/adapters/${provider}.mjs`);
    } catch (e) {
      console.log(`  platform    UNKNOWN (cannot load provider "${provider}": ${e.message})`);
      platformKnown = false;
    }
  }

  if (platformKnown && typeof providerModule?.capabilities !== 'function') {
    console.log(`  platform    UNKNOWN (provider "${provider}" does not implement capabilities())`);
    platformKnown = false;
  }

  if (platformKnown) {
    const branch = config?.project?.defaultBranch ?? 'main';
    const cap = await providerModule.capabilities({ project, branch });

    if (cap.hardEnforcement === 'available') {
      console.log('  platform    available  (branch protection APIs accessible)');
    } else if (cap.hardEnforcement === 'unavailable') {
      console.log('  platform    UNAVAILABLE');
      if (cap.remedy) console.log(`              → ${cap.remedy}`);
    } else {
      console.log('  platform    unknown');
      if (cap.detail) console.log(`              (${cap.detail})`);
    }

    for (const line of approvalLines(cap)) console.log(line);
  }
  console.log('');

  const probes = {
    branchProtection: probeOverrides?.branchProtection ?? realBranchProtectionProbe,
    releaseGate: probeOverrides?.releaseGate ?? realReleaseGateProbe,
    postMergeCi: probeOverrides?.postMergeCi ?? realPostMergeCiProbe,
    brainWritesReviewed: probeOverrides?.brainWritesReviewed ?? realBrainWritesReviewedProbe,
  };

  const substrate = await detectSubstrate({ config, vcs: providerModule, env, probes });
  printSubstrateReport(substrate, { defaultBranch: config?.project?.defaultBranch ?? 'main' });

  // Tier x rung cross-product (issue #358 Q5, REQ-TIER-11). resolveTier()
  // fails closed on an unrecognized governance.tier (REQ-TIER-1) — an invalid
  // config MUST surface as an actionable error, never a silently-assumed
  // default, so this is intentionally NOT wrapped in a try/catch.
  const tier = resolveTier(config);
  printDoctrineReport(tier, substrate);
}

// CLI guard — the report runs ONLY when this file is invoked directly
// (`node brain/scripts/brain-governance-status.mjs` / `npm run brain:governance-status`),
// NEVER on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await reportGovernanceStatus();
}
