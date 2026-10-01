// substrate.mjs — Capability-aware substrate detector (governance v3, design §1).
//
// Generalizes brain-protect.mjs's { enforced, reason, remedy } shape to ALL of
// governance and reports the highest ARMED rung of the fail-closed degradation
// ladder:
//
//   1 — merge          branch protection (or self-hosted pre-receive) active
//   2 — release        the publish/tag path runs brain:audit fail-closed
//   3 — auto-correct   post-merge brain:audit CI opens an auto-revert PR
//   4 — floor          detection + loud signal only, no enforcing guarantee
//
// detectSubstrate() is a PURE ORCHESTRATOR: it never touches the filesystem, git,
// or the network itself. All evidence comes through the injected `probes` (and the
// `vcs` adapter passed through to them) — mirroring how brain-audit.mjs separates
// pure checks/*.mjs from I/O wrappers (design §0). Callers (e.g.
// brain-governance-status.mjs, PR2b) are responsible for wiring real-world probes
// (fs presence checks, VCS API reads, env). No probes given -> no evidence -> the
// only honest answer is rung 4 (floor). This keeps the module fully unit-testable
// with zero dependencies and immune to CI-fragility (no ambient process.env / cwd
// git-state coupling — see apply-progress notes for issue-144-governance-v3).
//
// Contract (REQ-LADDER-1, REQ-LADDER-2):
//   detectSubstrate({ config, vcs, env, probes }) →
//     { rung: 1|2|3|4, enforced: boolean, reason: string|null, remedy: string|null, rungs }
//
// Never throws. Every probe call is wrapped in try/catch; a throwing probe
// degrades that rung to unavailable (never propagates, never crashes the caller).

import { checkContexts } from './governance-checks.mjs';

/**
 * Runs an injected probe defensively — never throws. Returns `undefined` on any
 * failure (missing probe, probe throws, probe rejects) so callers can treat that
 * uniformly as "no evidence available".
 * @param {Function|undefined} probeFn
 * @param {object} ctx
 * @returns {Promise<any>}
 */
async function safeProbe(probeFn, ctx) {
  if (typeof probeFn !== 'function') return undefined;
  try {
    return await probeFn(ctx);
  } catch {
    return undefined;
  }
}

// ── Rung 4 — floor ───────────────────────────────────────────────────────────────
// Always available and always active: the unconditional fallback so `rung` never
// has "no answer".
function evalRung4() {
  return { available: true, active: true, reason: null, remedy: null };
}

// ── Rung 3 — auto-correct ────────────────────────────────────────────────────────
// Armed when post-merge CI's run LEDGER proves a recent, successful terminal run —
// never from mere file presence or a self-referential "am I currently running in
// CI" check (issue #468, closing the gap that let a 12-day post-merge CI outage
// report armed). Evidence: `probes.postMergeCi({ config, env })` — real wiring
// (realPostMergeCiProbe, brain-governance-status.mjs) reads the GitHub Actions
// workflow-run ledger for governance-postmerge.yml. ALL interpretation happens
// here, in this pure module (design's 13-row decision table: L1-L3 + E1-E9 +
// the unrecognized-read fallback), so it stays
// unit-testable with injected evidence fixtures — the probe itself is a dumb I/O
// wrapper, never a classifier (same D1 split as evalRung2/classifyReleaseWorkflow).

// Two periods of governance-postmerge.yml's daily cron (`0 6 * * *`) — a run
// older than this can no longer be honestly called "recent". Named export: the
// drift-guard test (release-postmerge-workflows.test.mjs) imports this to fail if
// the workflow's cron cadence changes without this constant being updated.
export const POSTMERGE_STALE_MS = 48 * 60 * 60 * 1000;

// Every operator-facing string that states the staleness threshold derives it
// from the constant. Hardcoding the number leaves the drift guard able to force
// an update to POSTMERGE_STALE_MS while the messages keep quoting the old one —
// and the guard's own failure text prescribes exactly that edit, so the drift it
// catches is the drift it would otherwise introduce.
export const POSTMERGE_STALE_LABEL = `${POSTMERGE_STALE_MS / (60 * 60 * 1000)}h`;

// `observedAt` is the local wall clock, `completedAt` is GitHub's — a small
// amount of skew is normal (VM resumed from suspend, container without NTP,
// WSL clock drift). Anything beyond this tolerance means the age computation
// itself cannot be trusted: a future-dated `completedAt` or a local clock
// running behind yields a negative age that would otherwise look "fresher
// than fresh" and satisfy the staleness check below. Kept small and named
// (minutes, not hours) — see design.md decision table for the reasoning.
export const POSTMERGE_CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Bare-boolean-or-object evidence normalizer for rung 3 — mirrors
 * `normalizeReleaseGateEvidence` but keeps THREE distinguishable legacy inputs
 * instead of two: `raw === true` -> legacy declared-armed, `raw === false` ->
 * legacy declared-absent, anything else (undefined, null, a throwing probe via
 * `safeProbe`, or a real run-ledger evidence object) -> passed through as
 * `ledger` for evalRung3 to classify further. Splitting `undefined` from `false`
 * is what lets a throwing probe report uncomputable while
 * `postMergeCi: async () => false` stays confirmed-inert — collapsing the two
 * would silently degrade a broken probe into a confident "not armed" verdict.
 */
function normalizePostMergeEvidence(raw) {
  if (raw === true) return { legacy: 'declared-armed' };
  if (raw === false) return { legacy: 'declared-absent' };
  return { legacy: null, ledger: raw && typeof raw === 'object' ? raw : null };
}

/**
 * evalRung3 — pure, offline, total decision table (design "Decision table",
 * rows L1/L2/L3/E1..E9, evaluated top to bottom, first match wins). Every
 * branch returns the full six-field shape (REQ-R3-6). Never calls `Date.now()`
 * — staleness/skew (E7/E8 vs E9) compares `evidence.observedAt` (injected via
 * the probe's evidence object) against `lastRun.completedAt`, never read
 * ambiently (module-doc pure-orchestrator rule).
 */
async function evalRung3({ config, env, probes }) {
  const raw = await safeProbe(probes.postMergeCi, { config, env });
  const evidence = normalizePostMergeEvidence(raw);

  // L1 — legacy bare `true`: declared-armed, unverified (unreachable from the
  // real probe, which always returns a structured object — locked by a fixture
  // test. Its only live producers are test fixtures and programmatic embedders
  // passing `probes.postMergeCi`; NO config key reaches this row, so it is kept
  // for the injected-probe seam, not for a config-declared override).
  if (evidence.legacy === 'declared-armed') {
    return { available: true, active: true, verifiable: false, mechanism: 'postmerge-ci-declared', reason: null, remedy: null };
  }

  // L2 — legacy bare `false`: declared-absent, unverified.
  if (evidence.legacy === 'declared-absent') {
    return {
      available: true,
      active: false,
      verifiable: false,
      mechanism: 'postmerge-ci-absent',
      reason: 'no post-merge CI declared (postMergeCi probe returned false)',
      remedy: 'add .github/workflows/governance-postmerge.yml running brain:audit with auto-revert on failure',
    };
  }

  const ledger = evidence.ledger;

  // L3 — probe missing, threw (safeProbe -> undefined), or returned a
  // non-object: no run-ledger evidence exists to reason about at all.
  if (!ledger) {
    return {
      available: false,
      active: false,
      verifiable: true,
      mechanism: 'postmerge-run-ledger-uncomputable',
      reason: 'post-merge CI run-ledger evidence is unavailable (no probe wired, or the probe failed)',
      remedy: 'wire a postMergeCi probe that reads the governance-postmerge.yml run ledger',
    };
  }

  // E1 — workflow file absent (probe short-circuited before any network read).
  // Requires an EXPLICIT truthy `workflowPresent` to proceed past this row —
  // evidence that omits the field entirely (malformed/partial probe output)
  // must never be silently treated as "present" and fall through toward the
  // read-state checks below.
  if (ledger.workflowPresent !== true) {
    return {
      available: true, // CI is always something the project can wire — never a tier block
      active: false,
      verifiable: true,
      mechanism: 'postmerge-ci-absent',
      reason: 'no post-merge CI detected (no governance-postmerge.yml)',
      remedy: 'add .github/workflows/governance-postmerge.yml running brain:audit with auto-revert on failure',
    };
  }

  // E2 — non-GitHub provider: no ledger reader is wired for it.
  if (ledger.read === 'unsupported') {
    return {
      available: false,
      active: false,
      verifiable: true,
      mechanism: 'postmerge-run-ledger-unsupported',
      reason: 'post-merge CI run-ledger read is not supported for this VCS provider',
      remedy: 'no action available on this provider — rung 3 cannot be evidenced until a provider-specific run-ledger reader ships (there is no config key that declares it)',
    };
  }

  // E3 — the ledger read itself failed (auth, network, rate-limit, bad JSON).
  if (ledger.read === 'failed') {
    return {
      available: false,
      active: false,
      verifiable: true,
      mechanism: 'postmerge-run-ledger-uncomputable',
      reason: ledger.error
        ? `post-merge CI run-ledger read failed: ${ledger.error}`
        : 'post-merge CI run-ledger read failed',
      remedy: 'verify gh auth/connectivity and Actions API access, then retry',
    };
  }

  // Any read state other than 'ok' at this point is unrecognized — fail closed
  // to uncomputable rather than guessing (totality: no input class silently
  // falls through unmapped).
  if (ledger.read !== 'ok') {
    return {
      available: false,
      active: false,
      verifiable: true,
      mechanism: 'postmerge-run-ledger-uncomputable',
      reason: `post-merge CI run-ledger evidence has an unrecognized read state (${String(ledger.read)})`,
      remedy: 'fix the postMergeCi probe to return one of the four contract read states: skipped, unsupported, failed, ok',
    };
  }

  // E4 — the workflow file exists and the read succeeded, but the page the
  // reader saw contains no terminal run. Deliberately NOT phrased as "has never
  // had a terminal run": the probe reads a bounded page, so an Actions backlog
  // in which every recent entry is still queued/in_progress produces this state
  // on a workflow with years of history. Claiming "never" from a windowed read
  // is `evidence-reader-empty-on-failure` one level up — conflating "genuinely
  // zero" with "none in the window I looked at".
  if (ledger.lastRun === null || ledger.lastRun === undefined) {
    return {
      available: true,
      active: false,
      verifiable: true,
      mechanism: 'postmerge-unproven',
      reason: 'governance-postmerge.yml exists but no terminal run appears in the most recent run-ledger page',
      remedy: 'push to main, or wait for the next scheduled run, to record a terminal run',
    };
  }

  const lastRun = ledger.lastRun;
  const completedAtMs = typeof lastRun.completedAt === 'string' ? Date.parse(lastRun.completedAt) : NaN;
  const observedAt = ledger.observedAt;

  // E5 — malformed lastRun: missing conclusion, unparseable completedAt, or a
  // non-finite observedAt (staleness would be uncomputable). Never silently
  // treated as a fresh success. `Number.isFinite` — not `typeof === 'number'`
  // — because `typeof NaN === 'number'` is true; an unguarded typeof check
  // lets NaN (and +/-Infinity) sail past this row, then produce a NaN `age`
  // below whose `age > POSTMERGE_STALE_MS` comparison is always false,
  // falling through to a false "armed" verdict (issue #468 blocker).
  if (
    typeof lastRun.conclusion !== 'string' ||
    lastRun.conclusion === '' ||
    Number.isNaN(completedAtMs) ||
    !Number.isFinite(observedAt)
  ) {
    return {
      available: false,
      active: false,
      verifiable: true,
      mechanism: 'postmerge-run-ledger-uncomputable',
      reason: 'post-merge CI run-ledger evidence is malformed (missing conclusion, unparseable completedAt, or missing observedAt)',
      remedy: 'verify the run-ledger read returns a well-formed lastRun object with conclusion, completedAt, and observedAt',
    };
  }

  // E6 — the last terminal run did not succeed.
  if (lastRun.conclusion !== 'success') {
    return {
      available: true,
      active: false,
      verifiable: true,
      mechanism: 'postmerge-failing',
      reason: `last governance-postmerge run did not succeed (${lastRun.conclusion}): ${lastRun.htmlUrl ?? 'no run URL available'}`,
      remedy: 'investigate and fix the failing governance-postmerge.yml run',
    };
  }

  const age = observedAt - completedAtMs;

  // E7 — clock skew: `observedAt` (local clock) precedes `completedAt`
  // (GitHub's clock) by more than a small named tolerance — a future-dated
  // `completedAt`, or a local clock running behind (suspended VM, container
  // without NTP, WSL drift). The age computation cannot be trusted here, so
  // this is uncomputable, NOT "fresher than fresh" — without this guard, a
  // negative age fails E8's `age > POSTMERGE_STALE_MS` check and falls
  // through to arm at E9, on a run that is not provably recent at all.
  // `brain:governance-status` runs on a local developer machine, so this is
  // the most likely live path to skew.
  if (age < -POSTMERGE_CLOCK_SKEW_TOLERANCE_MS) {
    return {
      available: false,
      active: false,
      verifiable: true,
      mechanism: 'postmerge-run-ledger-uncomputable',
      reason: `post-merge CI run-ledger age is negative beyond clock-skew tolerance (observedAt precedes completedAt) — cannot compute staleness: ${lastRun.htmlUrl ?? 'no run URL available'}`,
      remedy: 'verify the local clock is synced (NTP) and retry',
    };
  }

  // E8 — succeeded, but the run is older than the staleness window.
  if (age > POSTMERGE_STALE_MS) {
    return {
      available: true,
      active: false,
      verifiable: true,
      mechanism: 'postmerge-stale',
      reason: `last successful governance-postmerge run is stale (older than ${POSTMERGE_STALE_LABEL}): ${lastRun.htmlUrl ?? 'no run URL available'}`,
      remedy: 'trigger a fresh governance-postmerge run (push to main, or wait for the next scheduled run)',
    };
  }

  // E9 — succeeded, within the staleness window and within clock-skew tolerance: the only real-probe row that arms.
  return {
    available: true,
    active: true,
    verifiable: true,
    mechanism: 'postmerge-run-ledger',
    reason: null,
    remedy: null,
  };
}

// ── Rung 2 — release ─────────────────────────────────────────────────────────────
// Armed when the publish/tag path can STRUCTURALLY block a release/tag before it
// exists — never inferred from mere file presence (issue #337, REQ-L2-1). Evidence:
// `probes.releaseGate({ config, env })` — real wiring (realReleaseGateProbe,
// brain-governance-status.mjs) reads config.governance.releaseGate and the raw text
// of .github/workflows/release.yml. ALL interpretation happens here, in this pure
// module, so it stays unit-testable with injected text fixtures (design D1) — the
// probe itself is a dumb I/O wrapper, never a classifier.
//
// The efficacy distinction (design D3): a workflow's ability to block a tag depends
// on its TRIGGER, not merely on whether an audit-gate job exists. brain's own
// release.yml already has an audit-gate job, but it fires `on: push: tags` — the
// tag has already been created by the time the workflow starts, so nothing
// downstream can un-create it (post-fact). A workflow can only gate a release if it
// fires BEFORE the tag exists (antecedent-capable: workflow_dispatch or push:
// branches) AND it invokes brain:audit AND it holds `permissions: contents: write`
// (the workflow must itself be able to create the tag it gates, per #210's target
// shape). That triple is what issue #210 will rebuild release.yml to satisfy — until
// then, brain's own repo honestly demotes rung 2 -> rung 3 (see PR body).

/**
 * Bare-boolean-or-object evidence normalizer. A bare `true`/`false` (legacy probe
 * shape, and still how `config.governance.releaseGate === true` short-circuits)
 * is treated as a DECLARATION, not a verification — same honesty shape as
 * `evalPreReceiveGate` (config-declared, verifiable:false). An evidence object
 * carries the raw probe read: `{ declared, workflowPresent, workflowText }`.
 */
function normalizeReleaseGateEvidence(raw) {
  if (raw === true) return { declared: true, workflowPresent: false, workflowText: null };
  if (!raw || typeof raw !== 'object') return { declared: false, workflowPresent: false, workflowText: null };
  return {
    declared: raw.declared === true,
    workflowPresent: Boolean(raw.workflowPresent),
    workflowText: typeof raw.workflowText === 'string' ? raw.workflowText : null,
  };
}

/**
 * classifyReleaseWorkflowTrigger — pure text-scan classifier (design D2: no
 * js-yaml, brain has zero runtime dependencies; line-scan the `on:` block,
 * mirroring release-postmerge-workflows.test.mjs's extractRunScript precedent).
 *
 * Isolates the top-level `on:` block, then classifies it as:
 *   - 'post-fact'          — push:tags, release:, workflow_run: — the tag/release
 *                            ALREADY EXISTS when the workflow starts; nothing it
 *                            does can prevent that tag from having been created.
 *   - 'antecedent-capable' — workflow_dispatch: or push:branches: — the workflow
 *                            can run and fail BEFORE the tag is created.
 *   - 'unknown'            — no recognizable `on:` block (unparseable).
 *
 * @param {string} workflowText raw release.yml contents
 * @returns {{ type: 'post-fact'|'antecedent-capable'|'unknown', trigger: string, reason: string }}
 */
function classifyReleaseWorkflowTrigger(workflowText) {
  if (typeof workflowText !== 'string' || workflowText.trim() === '') {
    return { type: 'unknown', trigger: 'none', reason: 'workflow text is empty or unreadable' };
  }

  const lines = workflowText.split('\n');
  const onIdx = lines.findIndex((l) => /^on:/.test(l));
  if (onIdx === -1) {
    return { type: 'unknown', trigger: 'none', reason: 'no top-level "on:" trigger block found' };
  }
  let onEnd = lines.length;
  for (let i = onIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { onEnd = i; break; }
  }
  const onBlock = lines.slice(onIdx, onEnd).join('\n');

  const isPostFact = /\btags\s*:/.test(onBlock) || /^\s*release\s*:/m.test(onBlock) || /\bworkflow_run\s*:/.test(onBlock);
  if (isPostFact) {
    return {
      type: 'post-fact',
      trigger: onBlock.trim(),
      reason: 'workflow cannot block tags (fires post-tag)',
    };
  }

  const isAntecedentCapable = /\bworkflow_dispatch\s*:/.test(onBlock) || /\bbranches\s*:/.test(onBlock);
  if (isAntecedentCapable) {
    return {
      type: 'antecedent-capable',
      trigger: onBlock.trim(),
      reason: 'workflow can run before the tag/release is created',
    };
  }

  return { type: 'unknown', trigger: onBlock.trim(), reason: 'unrecognized "on:" trigger shape' };
}

/**
 * classifyReleaseWorkflow — composes the trigger classification with the
 * remaining two legs of the D3 blocking triple (audit invocation + write
 * permissions) into a single verdict for evalRung2.
 *
 * @param {string} workflowText raw release.yml contents
 * @returns {{ blocking: boolean, verifiable: boolean, reason: string, remedy: string }}
 */
function classifyReleaseWorkflow(workflowText) {
  const trigger = classifyReleaseWorkflowTrigger(workflowText);

  if (trigger.type === 'unknown') {
    return {
      blocking: false,
      verifiable: false,
      reason: `workflow structure could not be parsed (${trigger.reason})`,
      remedy: 'ensure release.yml has a recognizable "on:" trigger block, or set governance.releaseGate=true to declare it manually',
    };
  }

  if (trigger.type === 'post-fact') {
    return {
      blocking: false,
      verifiable: true,
      reason: trigger.reason,
      remedy: 'rebuild release.yml to trigger before the tag exists (workflow_dispatch or push:branches), invoke brain:audit, and grant permissions: contents: write — see #210',
    };
  }

  // antecedent-capable — the remaining two legs of the D3 triple.
  const hasAuditInvocation = /brain[-:\s]*audit/i.test(workflowText);
  const hasContentsWrite = /contents:\s*write/.test(workflowText);

  if (hasAuditInvocation && hasContentsWrite) {
    return { blocking: true, verifiable: true, reason: null, remedy: null };
  }

  const missing = !hasAuditInvocation && !hasContentsWrite
    ? 'does not invoke brain:audit and lacks permissions: contents: write'
    : !hasAuditInvocation
      ? 'does not invoke brain:audit before creating the release/tag'
      : 'lacks permissions: contents: write to gate the tag it audits';

  return {
    blocking: false,
    verifiable: true,
    reason: `workflow ${missing}`,
    remedy: 'add brain:audit invocation and permissions: contents: write so the workflow can gate the release/tag it fires before — see #210',
  };
}

async function evalRung2({ config, env, probes }) {
  const raw = await safeProbe(probes.releaseGate, { config, env });
  const evidence = normalizeReleaseGateEvidence(raw);

  // Declared (config.governance.releaseGate === true, or a bare-boolean-true
  // legacy probe): armed, but a declaration is not a verification (design D4) —
  // same honesty shape as evalPreReceiveGate.
  if (evidence.declared) {
    return {
      available: true,
      active: true,
      verifiable: false,
      mechanism: 'release-gate-config-declared',
      reason: null,
      remedy: null,
    };
  }

  if (!evidence.workflowPresent) {
    return {
      available: true, // the project always controls its own release path
      active: false,
      verifiable: true,
      mechanism: 'release-gate-absent',
      reason: 'no release-gate wired (no release.yml, governance.releaseGate not set)',
      remedy: 'add .github/workflows/release.yml running brain:audit fail-closed before tag, or set governance.releaseGate=true',
    };
  }

  // The workflow file exists but its text could not be read (probe-level read
  // error, e.g. a permissions error or a race with a deletion) — distinct from
  // "not wired": something IS wired, but we cannot honestly confirm what it
  // does. Routed through classifyReleaseWorkflow(null), which reports this as
  // unparseable (verifiable:false), never a confirmed absent (verifiable:true).
  const verdict = classifyReleaseWorkflow(evidence.workflowText);
  return {
    available: true,
    active: verdict.blocking,
    verifiable: verdict.verifiable,
    mechanism: verdict.verifiable ? 'release-gate-workflow-structural' : 'release-gate-unparseable',
    reason: verdict.blocking ? null : verdict.reason,
    remedy: verdict.blocking ? null : verdict.remedy,
  };
}

// ── Rung 1 — merge ───────────────────────────────────────────────────────────────
// Armed when ANY of three per-provider sub-gates is active — pipelineMustSucceed
// (GitLab's required_status_checks analog, load-bearing per CP-A2b),
// protectedBranches (complementary push gate), or preReceive (config-declared,
// non-remotely-verifiable server hook). This is the finer read `capabilities()`
// cannot do (github.mjs:96-100 maps both 200 and 404 to 'available' — correct for
// "can I call brain:protect?", but blind to armed-vs-unset). The 200/404/403
// interpretation lives HERE (unit-testable); the raw HTTP read is the injected
// `probes.branchProtection` (issue #244 A4, design Decision 1).

/**
 * evalPipelineMustSucceedGate — MERGE gate, GitHub required_status_checks analog.
 * GitLab: API-readable project setting (verifiable:true). GitHub/unset: the
 * EXISTING contexts-based 200/404/403/unknown ladder, reproduced byte-for-byte
 * (behavior-preservation — issue #244 A4 Phase 3).
 */
function evalPipelineMustSucceedGate({ provider, status, hasOurContexts, result }) {
  if (provider === 'gitlab') {
    // Three-way, never a fabricated false: true=armed, false=readable-but-unset,
    // null/undefined=uncomputable (the GET /projects/:id read failed or was
    // unreachable — REQ-A4-3 scenario 2 requires this to report available:false,
    // not silently collapse into "not armed").
    const raw = result?.pipelineMustSucceed;
    if (raw === true) {
      return { available: true, active: true, verifiable: true, mechanism: 'branch-merge-gate-api', reason: null, remedy: null };
    }
    if (raw === false) {
      return {
        available: true,
        active: false,
        verifiable: true,
        mechanism: 'branch-merge-gate-api',
        reason: 'no GitLab merge gate configured (only_allow_merge_if_pipeline_succeeds is not set)',
        remedy: 'run npm run brain:protect to enable only_allow_merge_if_pipeline_succeeds',
      };
    }
    return {
      available: false,
      active: false,
      verifiable: true,
      mechanism: 'branch-merge-gate-api',
      reason: 'GitLab merge-gate setting is uncomputable (GET /projects/:id failed or unreachable)',
      remedy: 'verify glab auth/connectivity and GitLab API access, then retry',
    };
  }

  // else (github / unset) — today's contexts-based logic, verbatim.
  if (status === 200 && hasOurContexts) {
    return { available: true, active: true, verifiable: true, mechanism: 'branch-merge-gate-api', reason: null, remedy: null };
  }
  if (status === 200) {
    return {
      available: true,
      active: false,
      verifiable: true,
      mechanism: 'branch-merge-gate-api',
      reason: 'branch protection active but missing our required governance check contexts',
      remedy: 'run npm run brain:protect to (re)apply the required check contexts',
    };
  }
  if (status === 404) {
    return {
      available: true,
      active: false,
      verifiable: true,
      mechanism: 'branch-merge-gate-api',
      reason: 'branch protection available but not configured (unset) — not armed',
      remedy: 'run npm run brain:protect to activate branch protection',
    };
  }
  if (status === 403) {
    return {
      available: false,
      active: false,
      verifiable: true,
      mechanism: 'branch-merge-gate-api',
      reason: 'branch protection unavailable — tier-locked',
      remedy: 'upgrade plan (e.g. GitHub Pro for private repos) or make the repo public',
    };
  }
  return {
    available: false,
    active: false,
    verifiable: true,
    mechanism: 'branch-merge-gate-api',
    reason: 'branch protection status unknown (no probe wired, or probe failed)',
    remedy: 'wire a branchProtection probe and verify VCS provider connectivity',
  };
}

/**
 * evalProtectedBranchesGate — PUSH gate, complementary NOT equivalent to the
 * merge gate. GitLab: per-branch protected-branch presence (verifiable:true).
 * GitHub/unset: does NOT independently arm rung-1 — governance arming is keyed
 * on required checks (pipelineMustSucceed); a bare protected branch alone must
 * stay `rung !== 1` (behavior-preservation).
 */
function evalProtectedBranchesGate({ provider, status }) {
  if (provider === 'gitlab') {
    const active = status === 200;
    return {
      available: status !== 403,
      active,
      verifiable: true,
      mechanism: 'protected-branch-api',
      reason: active ? null : 'no protected-branch push gate configured for the default branch',
      remedy: active ? null : 'run npm run brain:protect to protect the default branch (push_access_level=0)',
    };
  }

  // else (github / unset) — never independently arms rung-1 on this provider.
  return {
    available: status !== 403,
    active: false,
    verifiable: true,
    mechanism: 'protected-branch-api',
    reason: 'protected-branch presence does not independently arm rung-1 on this provider',
    remedy: null,
  };
}

/**
 * evalPreReceiveGate — server-side hook, NOT remotely detectable (provider-
 * agnostic). Replaces the :98-100 short-circuit: same arming truth
 * (config.vcs.selfHostedPreReceive), now carrying the honest verifiable:false
 * signal instead of masquerading as a verified probe result.
 */
function evalPreReceiveGate({ config }) {
  const active = config?.vcs?.selfHostedPreReceive === true;
  return {
    available: true,
    active,
    verifiable: false,
    mechanism: 'pre-receive-config-declared',
    reason: active ? null : 'self-hosted pre-receive not declared (vcs.selfHostedPreReceive !== true)',
    remedy: active ? null : 'install the server hook (docs/inbox/self-hosted-pre-receive.md) and set vcs.selfHostedPreReceive=true',
  };
}

async function evalRung1({ config, vcs, env, probes }) {
  const provider = config?.vcs?.provider;
  const result = await safeProbe(probes.branchProtection, { config, vcs, env });
  const status = result?.status;
  const contexts = Array.isArray(result?.contexts) ? result.contexts : [];
  const ourContexts = checkContexts();
  const hasOurContexts = ourContexts.length > 0 && ourContexts.every(c => contexts.includes(c));

  const gates = {
    pipelineMustSucceed: evalPipelineMustSucceedGate({ provider, status, hasOurContexts, result }),
    protectedBranches: evalProtectedBranchesGate({ provider, status }),
    preReceive: evalPreReceiveGate({ config }),
  };
  const active = gates.pipelineMustSucceed.active || gates.protectedBranches.active || gates.preReceive.active;

  if (active) {
    return { available: true, active: true, reason: null, remedy: null, gates };
  }

  // Not armed by ANY sub-gate — surface the primary (merge-gate) blocker,
  // preserving today's exact strings (403-without-preReceive stays available:false).
  // `active` is always false here (guarded by the `if (active) return` above),
  // so the availability is just the primary gate's own — no OR needed.
  const primary = gates.pipelineMustSucceed;
  return {
    available: primary.available,
    active: false,
    reason: primary.reason,
    remedy: primary.remedy,
    gates,
  };
}

// ── rungs[1].gates.brainWritesReviewed — per-provider L6 rung-1 sub-probe ────────
// Rung 1 is not monolithic: "required code-owner review" is a platform-specific
// mechanism. This is only an OPTIONAL rung-1 ENHANCEMENT for L6 — the real
// enforcement is the evidence-based brain-writes-reviewed checker (design §6.1,
// active at detection / rung 2 / rung 3 regardless of this gate). Reported
// honestly when unavailable, per provider, never inferred.
async function evalBrainWritesReviewedGate({ config, vcs, env, probes }) {
  const provider = config?.vcs?.provider;

  // The probe is only meaningful for providers that actually expose a rung-1
  // code-owner-review mechanism. Calling it for Bitbucket (no such capability)
  // or an unset provider would be a wasted probe/network call — so the call is
  // scoped to the github/gitlab branches only, never invoked otherwise.

  if (provider === 'github') {
    const result = await safeProbe(probes.brainWritesReviewed, { config, vcs, env });
    const { requireCodeOwnerReviews, codeownersPresent } = result ?? {};
    if (requireCodeOwnerReviews && codeownersPresent) {
      return { available: true, active: true, reason: null, remedy: null };
    }
    const reason = !codeownersPresent
      ? 'GitHub rung-1 code-owner review requires a .github/CODEOWNERS file'
      : 'GitHub rung-1 code-owner review requires branch protection require_code_owner_reviews';
    return {
      available: false,
      active: false,
      reason,
      remedy: 'add .github/CODEOWNERS and enable require_code_owner_reviews in branch protection',
    };
  }

  if (provider === 'gitlab') {
    const result = await safeProbe(probes.brainWritesReviewed, { config, vcs, env });
    const { premiumOrHigher } = result ?? {};
    if (premiumOrHigher) {
      return { available: true, active: true, reason: null, remedy: null };
    }
    return {
      available: false,
      active: false,
      reason: 'GitLab rung-1 code-owner review requires Premium tier or higher',
      remedy: 'upgrade to GitLab Premium+ to enable required code-owner approvals, or rely on the evidence checker',
    };
  }

  if (provider === 'bitbucket') {
    return {
      available: false,
      active: false,
      reason: 'Bitbucket has no rung-1 required-code-owner-review capability',
      remedy: 'rely on the evidence-based brain-writes-reviewed checker (rung 2/3)',
    };
  }

  return {
    available: false,
    active: false,
    reason: `rung-1 code-owner review capability unknown for provider "${provider ?? 'unset'}"`,
    remedy: 'configure vcs.provider in brain.config.json, or rely on the evidence-based brain-writes-reviewed checker',
  };
}

// ── Rung selection ───────────────────────────────────────────────────────────────
// Highest-armed-rung wins: check 1, then 2, then 3; 4 is the guaranteed floor.
function selectRung(rungs) {
  for (const r of [1, 2, 3, 4]) {
    if (rungs[r]?.active) return r;
  }
  return 4;
}

/**
 * Detects the highest-armed rung of the governance substrate ladder.
 *
 * @param {object} [opts]
 * @param {object} [opts.config]  brain.config.json contents (or a fixture)
 * @param {object} [opts.vcs]     resolved VCS provider adapter (see vcs/cli.mjs getVcs())
 * @param {object} [opts.env]     environment variables (ALWAYS pass explicitly in
 *                                tests — defaulting to process.env is only safe for
 *                                real production callers)
 * @param {object} [opts.probes]  injectable evidence sources — see module doc
 * @returns {Promise<{ rung: 1|2|3|4, enforced: boolean, reason: string|null, remedy: string|null, rungs: object }>}
 */
export async function detectSubstrate({ config = {}, vcs, env = process.env, probes = {} } = {}) {
  const rungs = {};

  rungs[1] = await evalRung1({ config, vcs, env, probes });
  rungs[1].gates.brainWritesReviewed = await evalBrainWritesReviewedGate({ config, vcs, env, probes });
  rungs[3] = await evalRung3({ config, env, probes });
  rungs[2] = await evalRung2({ config, env, probes });
  rungs[4] = evalRung4();

  const rung = selectRung(rungs);
  const enforced = rung <= 3;
  // At the ceiling (rung 1) there is nowhere higher to climb — no reason/remedy
  // needed. Below the ceiling, surface the nearest unattained rung's reason/remedy:
  // it is always the single, most actionable next step to climb the ladder.
  const blocker = rung === 1 ? null : rungs[rung - 1];

  return {
    rung,
    enforced,
    reason: blocker?.reason ?? null,
    remedy: blocker?.remedy ?? null,
    rungs,
  };
}
