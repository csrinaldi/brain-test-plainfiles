// brain-writes-reviewed.mjs — L6 brain-writes-reviewed evidence check: pure
// evaluator + gh/git I/O wrapper + CLI (design §6.1, REQ-L6-1 evidence path).
// Sibling to actor-check.mjs.
//
// Pure evaluator (evaluateBrainWritesReviewed) takes plain data — no gh, no
// git, no filesystem — so it is fully unit-testable with fixture reviews. The
// I/O wrapper computes the PR's changed files (`git diff --name-only`),
// fetches the PR's reviews via `gh api repos/{repo}/pulls/{n}/reviews`, and
// resolves adminOverride from the PR's labels (same allowlist discipline as
// actor-check). All I/O is dependency-injectable via `deps` (same
// CI-fragility discipline as actor-check.mjs / phase-order-check.mjs) — no
// test spawns a real gh or git process.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBrainConfigOrThrow } from '../lib/brain-config.mjs';
import { loadContext, gitlabApiConfig } from './ci-context.mjs';
import { getVcs } from './cli.mjs';
import { resolveTier, tierParams, resolveGatePolicy, TIERS } from './governance-tiers.mjs';

// ── Pure evaluator (design §6.1) ────────────────────────────────────────────

const BRAIN_MANAGED_PREFIXES = ['brain/core/', 'brain/project/'];

/**
 * Evaluates whether Tier-2 (`brain/core/**` or `brain/project/**`) changes in
 * a PR satisfy REQ-L6-1's tier-scoped evidence form (issue #358 Q5 Phase 4,
 * REQ-L6-1'). Pure — no gh, no git, no filesystem access (fully testable
 * with fixtures).
 *
 * Decision order (design §6.1, extended by design.md §2.A/REQ-L6-1'):
 *   1. No `brain/core/**` or `brain/project/**` file touched → pass (no
 *      Tier-2 requirement — REQ-L6-1 evidence path; avoids false positives on
 *      unrelated PRs).
 *   2. The PR AUTHOR is a listed agent/bot identity (`botAllowlist`,
 *      `governance.reviewActors`) → fail, UNCONDITIONALLY, at every tier —
 *      "agent containment does not tier" (REQ-L6-1'). NOT bypassable by
 *      `adminOverride`: an override is a logged emergency valve for a human
 *      approval decision, never a mechanism for admitting an agent's own
 *      authorship (design.md §2.A: "if an agent can write to `brain/core/**`
 *      unreviewed, 'the human always leads' is void"). This closes the
 *      pre-Phase-4 "undocumented n=1 contradiction" (design.md §0): the old
 *      evaluator only ever asked "is the sole APPROVED reviewer human?",
 *      never "is the AUTHOR itself an agent?" — an agent-authored change with
 *      a human rubber-stamp review could previously pass.
 *   3. `lite`: agent-authorship exclusion is the WHOLE evidence form — once
 *      step 2 hasn't failed, `lite` passes without needing any review at all
 *      (a solo human maintainer satisfies this on their own).
 *   4. `standard`/`regulated` only, from here down — UNCHANGED from the
 *      pre-tiering behavior (REQ-TIER-10's no-op-migration guarantee for the
 *      default `standard` tier):
 *      a. No reviews at all (missing/unsupported reviews API, or zero
 *         reviews yet) → warn + pass (cannot prove/disprove human review on
 *         missing evidence — never fail on missing evidence, mirrors
 *         actor-check's missing-labeled-event branch).
 *      b. `adminOverride` (an allow-listed `override:*` label is present) →
 *         pass, logged — bypasses the self-approval fail below, same as
 *         actor-check's adminOverride branch.
 *      c. Zero APPROVED reviews among the fetched reviews (e.g. only
 *         COMMENTED/CHANGES_REQUESTED) → warn + pass (no approval evidence
 *         yet).
 *      d. At least one deduped APPROVED reviewer whose login is NOT the
 *         author and NOT in `botAllowlist` → pass (a human other than the
 *         author reviewed the brain-writes). `regulated` additionally notes
 *         whether CODEOWNERS review is armed at rung 1 (informational only —
 *         REQ-TIER-5: the enhancement never demotes the pass when the
 *         substrate cannot provide it).
 *      e. Otherwise → fail — the only APPROVED reviewer(s) are the author
 *         itself and/or bot-allow-listed identities; enforces Tier-2 "no
 *         agent writes to `brain/`" (`agent-authorities.md:35`).
 *
 * @param {object} input
 * @param {string[]} [input.changedFiles]  Paths from `git diff --name-only BASE...HEAD`.
 * @param {Array<{ state: string, author: string }>} [input.reviews]  Normalized
 *   PR reviews from the VCS adapter (`state` is GitHub's review state string;
 *   only `'APPROVED'` counts toward approvers). Not consulted at `lite`.
 * @param {string} input.author  PR author login.
 * @param {string[]} [input.botAllowlist]  Actor logins that do NOT count as the
 *   human reviewer at L6 (`config.governance.reviewActors` — a pure identity
 *   list; issue #266 two-key split, R2). Override:* label strings are NOT here;
 *   they resolve separately against `config.governance.approvalActors`.
 * @param {boolean} [input.adminOverride]  Whether an allow-listed `override:*`
 *   label is present on the PR AND honored at this tier (resolved by the
 *   wrapper against `botAllowlist` — never a blanket bypass).
 * @param {boolean} [input.overrideRefused]  Whether an allow-listed
 *   `override:*` label was present but NOT honored at this tier (issue #358
 *   Q5, REQ-TIER-6 — `regulated` refuses the label). When true, the verdict
 *   NAMES the refusal rather than silently proceeding as if the label were
 *   absent.
 * @param {'lite'|'standard'|'regulated'} [input.tier]  Selects the evidence
 *   form (REQ-L6-1') AND the `overrideRefused` message text.
 * @param {boolean} [input.codeownersArmed]  Whether CODEOWNERS review is
 *   armed at rung 1 for this substrate (`detectSubstrate()`'s
 *   `rungs[1].gates.brainWritesReviewed.active`, or an injected override).
 *   Consulted only at `regulated`, and only informationally — REQ-TIER-5
 *   forbids demoting a satisfied `standard` evidence pass because a rung-1
 *   enhancement the substrate cannot provide is unavailable.
 * @returns {{ level: 'pass'|'warn'|'fail', reason: string }}
 */
export function evaluateBrainWritesReviewed({
  changedFiles = [],
  reviews = [],
  author,
  botAllowlist = [],
  adminOverride = false,
  overrideRefused = false,
  tier = 'standard',
  codeownersArmed = false,
} = {}) {
  const withRefusalNote = result => {
    if (!overrideRefused || result.level === 'warn') return result;
    return {
      ...result,
      reason: `${result.reason} (an override:* label was present but is not honored at the "${tier}" tier — refusing the bypass, REQ-TIER-6.)`,
    };
  };

  const touchesBrain = changedFiles.some(f =>
    BRAIN_MANAGED_PREFIXES.some(prefix => f.startsWith(prefix))
  );

  if (!touchesBrain) {
    return {
      level: 'pass',
      reason: 'no brain/core/** or brain/project/** files touched — Tier-2 human review not required.',
    };
  }

  if (author && botAllowlist.includes(author)) {
    return {
      level: 'fail',
      reason:
        `"${author}" is an agent/bot identity (governance.reviewActors) — agent containment does not tier: ` +
        'no tier permits an agent-authored brain/core or brain/project change, regardless of any subsequent ' +
        'human review (REQ-L6-1′).',
    };
  }

  if (tier === 'lite') {
    return {
      level: 'pass',
      reason:
        `brain/core or brain/project changes were authored by "${author ?? 'unknown'}", not a listed agent/bot ` +
        'identity — agent-authorship exclusion satisfied at the "lite" tier (REQ-L6-1′).',
    };
  }

  if (reviews.length === 0) {
    return {
      level: 'warn',
      reason:
        'no PR reviews found (missing/unsupported reviews API, or zero reviews yet) — cannot verify ' +
        'Tier-2 human review on brain/ changes; never failing on missing evidence (REQ-L6-1).',
    };
  }

  if (adminOverride) {
    return {
      level: 'pass',
      reason: 'admin override present (allow-listed override:* label) — brain-writes-reviewed check bypassed.',
    };
  }

  const approvers = [
    ...new Set(reviews.filter(r => r.state === 'APPROVED').map(r => r.author)),
  ];

  if (approvers.length === 0) {
    return {
      level: 'warn',
      reason:
        'no APPROVED reviews found yet (only COMMENTED/CHANGES_REQUESTED, or none) — cannot verify ' +
        'Tier-2 human review on brain/ changes; never failing on missing evidence (REQ-L6-1).',
    };
  }

  const humanApprover = approvers.find(a => a !== author && !botAllowlist.includes(a));

  if (humanApprover) {
    let reason = `brain/core or brain/project changes approved by "${humanApprover}", distinct from the PR author "${author}".`;
    if (tier === 'regulated') {
      reason += codeownersArmed
        ? ' CODEOWNERS review is additionally armed at rung 1 (REQ-L6-1′ regulated evidence).'
        : ' CODEOWNERS review is not armed at this substrate\'s rung 1 — the "regulated" enhancement is ' +
          'unavailable here; standard evidence alone still satisfies REQ-L6-1′ (REQ-TIER-5).';
    }
    return withRefusalNote({ level: 'pass', reason });
  }

  return withRefusalNote({
    level: 'fail',
    reason:
      `brain/core or brain/project changes were only self-approved by "${author}" (or approved solely by ` +
      'allow-listed automation) — Tier-2 requires human review distinct from the author (agent-authorities.md).',
  });
}

// ── gh/git I/O wrapper ───────────────────────────────────────────────────────

function defaultDiffNameOnly(cwd) {
  return (baseSha, headSha) => {
    const out = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
      cwd,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  };
}

/**
 * Default `fetchReviews` dep: dispatches `getVcs({ provider }).prReviews(...)`
 * on the RUNTIME-detected `ctx.provider` (issue #239 A3 TASK2 — the
 * class-closure audit's 4th VIOLATION, the same defect class as
 * actor-check.mjs's pre-fix `defaultFetchLabeledEvents`/`defaultFetchIssue`
 * and finding #14). Pre-fix, this wrapper called the `gh` CLI (via
 * `execFileSync`) UNCONDITIONALLY regardless of provider — on GitLab CI (no
 * `gh` binary) it threw ENOENT, masking the L6 gate behind a permanent
 * `warn`. `getVcs` is injectable via `{ getVcs }` for tests, mirroring
 * actor-check.mjs's `defaultFetchLabeledEvents`/`defaultFetchIssue` shape.
 *
 * @param {string} repo
 * @param {string|undefined} provider
 * @param {{ getVcs?: Function }} [deps]
 * @returns {(prNumber: number) => Promise<Array<{ state: string, author: string|null }>>}
 */
function defaultFetchReviews(repo, provider, { getVcs: getVcsFn = getVcs } = {}) {
  return async prNumber => {
    const vcs = await getVcsFn({ provider });
    const { apiBase, token, proxyUrl } = gitlabApiConfig();
    const reviews = await vcs.prReviews({ project: repo, number: prNumber, apiBase, token, proxyUrl });
    return reviews ?? [];
  };
}

/**
 * Default `readBotAllowlist` dep: reads ONLY `governance.reviewActors` (issue
 * #266, design §3 two-key split, binding ruling R2: "no key feeds two gates").
 * L6's botAllowlist key MOVES from `governance.approvalActors` to the NEW,
 * L6-only `governance.reviewActors` — it does NOT union them. `approvalActors`
 * is now L5-only (`actor-check.mjs`'s reader, untouched); reading it here too
 * would keep it feeding both gates, which is exactly the dual-semantics
 * coupling the split exists to dissolve. To exclude an identity from L6's
 * human-approver count, register it in `reviewActors`; to let an identity
 * apply `status:approved`, register it in `approvalActors`; both effects
 * require both registrations — explicit, never implicit.
 *
 * DENY-DIRECTION (issue #942, R1): excludes an identity from L6's human-
 * approver count, so empty is the PERMISSIVE answer — calls
 * `loadBrainConfigOrThrow(cwd)` and does NOT catch. An absent config still
 * resolves to `{}` → `[]` (R11, unchanged); only a present-but-unreadable or
 * unparseable config throws, propagating into `runBrainWritesReviewedCheck`'s
 * tier-aware catch (`:458-476`).
 */
function defaultReadBotAllowlist(cwd) {
  return () => {
    const config = loadBrainConfigOrThrow(cwd);
    return Array.isArray(config?.governance?.reviewActors) ? config.governance.reviewActors : [];
  };
}

/**
 * Default `readOverrideActors` dep: reads `governance.approvalActors` — the
 * whitelist of `override:*` label strings honored at L6 (issue #266,
 * P272-OVERRIDE-KEY option (b)). Kept SEPARATE from `readBotAllowlist`
 * (`reviewActors`, the L6 human-approver exclusion) so `reviewActors` stays a
 * pure identity list — one key, one meaning. `approvalActors` is the same
 * human-trust grant that authorizes `status:approved` at L5
 * (`actor-check.mjs`); the reviewer handle is in neither.
 *
 * ALLOW-DIRECTION, hardened in scope anyway (issue #942, D3 — a measured
 * correction, not a deviation): feeds `overrideActors` → `overrideLabelPresent`
 * (`:396`), where empty means NO override is honoured — the STRICTER answer,
 * so hardening it violates nothing (R1 only REQUIRES the deny direction to
 * propagate; it does not forbid an allow reader from doing so too). Calls
 * `loadBrainConfigOrThrow(cwd)` and does NOT catch. Behaviourally
 * unobservable in production: `readBotAllowlist()` (above) runs first
 * (`:392`) and throws before this reader is ever reached.
 */
function defaultReadApprovalActors(cwd) {
  return () => {
    const config = loadBrainConfigOrThrow(cwd);
    return Array.isArray(config?.governance?.approvalActors) ? config.governance.approvalActors : [];
  };
}

/**
 * Default `readConfig` dep: reads the raw brain.config.json object, used to
 * resolve the tier (issue #358 Q5, REQ-TIER-6) for tier-scoping `override:*`.
 * Never throws — an unreadable/missing config degrades to `{}`, which
 * `resolveTier()` treats as the 'standard' default (REQ-TIER-10).
 */
function defaultReadConfig(cwd) {
  return () => {
    try {
      return JSON.parse(readFileSync(join(cwd, 'brain.config.json'), 'utf8'));
    } catch {
      return {};
    }
  };
}

/**
 * Resolves the tier to attribute a config-read-failure verdict to (issue
 * #942), WITHOUT ever throwing itself — this runs from inside
 * `runBrainWritesReviewedCheck`'s catch, after `gatherBrainWritesReviewedInputs`
 * has already failed, so a second failure here (a corrupt config, an unknown
 * `governance.tier`, OR an unrecognized `deps.tier` injected directly) must
 * degrade rather than escape. Defaults to `'standard'` on any resolution
 * failure — `'standard'` also resolves `brain-writes-reviewed` to `required`
 * (REQ-TIER-2's never-tiered core), so this default is fail-closed-safe
 * regardless of the repo's real tier.
 *
 * `deps.tier` is validated against `TIERS` before being trusted (issue #942
 * review, F2): an invalid `deps.tier` used to be returned as-is, which the
 * caller then fed straight into `resolveGatePolicy` OUTSIDE this function's
 * own try/catch — an unknown tier there throws (no matrix cell), escaping
 * uncaught and breaking this function's documented never-throws contract.
 * An invalid `deps.tier` now falls through to the same config-based
 * resolution (and its catch) as a missing one, exactly like `resolveTier`
 * already fails closed to `'standard'` for an unrecognized
 * `governance.tier` read from disk.
 *
 * DELIBERATELY DUPLICATED from `actor-check.mjs`'s identical-shaped helper
 * (`:1181-1189`) rather than imported: an L5→L6 gate-to-gate import edge is a
 * worse coupling than a ~10-line helper whose whole body is "resolve the
 * tier without throwing" (R4). `actor-check.mjs:1181`'s copy carries the
 * same pre-existing unvalidated-`deps.tier` hazard as this function did
 * before this fix; out of scope here (issue #942 review, F2) — tracked
 * separately, not fixed alongside this one.
 *
 * @param {string} cwd
 * @param {{ tier?: string, readConfig?: () => object }} deps
 * @returns {'lite'|'standard'|'regulated'}
 */
function resolveTierForFailure(cwd, deps) {
  try {
    if (deps.tier && TIERS.includes(deps.tier)) return deps.tier;
    const readConfig = deps.readConfig ?? defaultReadConfig(cwd);
    return resolveTier(readConfig());
  } catch {
    return 'standard';
  }
}

/**
 * Gathers evaluateBrainWritesReviewed()'s inputs from git + the gh API (or
 * from injected `deps` in tests). `adminOverride` is resolved here — an
 * override:* label is only honored when it is BOTH present on the PR AND listed
 * in `config.governance.approvalActors` (read via `readOverrideActors`, SEPARATE
 * from `botAllowlist`/`reviewActors`; issue #266 P272-OVERRIDE-KEY option (b) —
 * one key, one meaning); an unlisted override:* label grants nothing (no blanket
 * bypass, same discipline as actor-check's `gatherActorCheckInputs`).
 *
 * `provider` (github|gitlab, from `ctx.provider`) selects the VCS adapter
 * (`getVcs({ provider })`, issue #239 A3 TASK2) for the default
 * `fetchReviews` wrapper; an injected `deps.fetchReviews` bypasses
 * resolution entirely (as tests do). This function is async as of A3 TASK2
 * (the default wrapper awaits the `prReviews` CONTRACT verb, a
 * Promise-returning dispatch); an injected sync `deps.fetchReviews` still
 * works unchanged (`await` on a non-Promise resolves immediately).
 *
 * `adminOverride` is tier-scoped (issue #358 Q5, REQ-TIER-6): honored at
 * `lite`/`standard`, refused at `regulated` (`tierParams(tier).honorOverride`).
 * A present-but-refused override sets `overrideRefused: true` instead of
 * silently vanishing — evaluateBrainWritesReviewed() names the refusal.
 *
 * `reviews` is fetched ONLY when the tier's evidence form needs it (issue
 * #358 Q5 Phase 4) — `lite`'s evidence is agent-authorship exclusion alone,
 * so it never calls `fetchReviews` (REQ-TIER-10's no-op-migration guarantee
 * means `standard`/`regulated` are unaffected — they fetch exactly as
 * before). `codeownersArmed` (`regulated`'s rung-1 enhancement,
 * REQ-L6-1') is read via an injectable `deps.codeownersArmed` — real wiring
 * to `detectSubstrate()`'s `rungs[1].gates.brainWritesReviewed.active` is a
 * follow-up (it requires network branch-protection probes this per-PR gate
 * does not otherwise make); defaults to `false` (substrate unknown/not
 * armed), which is always the SAFE direction — REQ-TIER-5 forbids treating
 * an unavailable enhancement as a fail.
 *
 * @param {{ baseSha: string, headSha: string, prNumber: number|string, repo: string, author: string, provider?: string, prLabels?: string[], cwd?: string, tier?: string, deps?: object }} args
 * @returns {Promise<{ changedFiles: string[], reviews: Array, author: string, botAllowlist: string[], adminOverride: boolean, overrideRefused: boolean, tier: string, codeownersArmed: boolean }>}
 */
export async function gatherBrainWritesReviewedInputs({
  baseSha,
  headSha,
  prNumber,
  repo,
  author,
  provider,
  prLabels = [],
  cwd = process.cwd(),
  tier: tierOverride,
  deps = {},
} = {}) {
  const diffNameOnly = deps.diffNameOnly ?? defaultDiffNameOnly(cwd);
  const fetchReviews = deps.fetchReviews ?? defaultFetchReviews(repo, provider, deps);
  const readBotAllowlist = deps.readBotAllowlist ?? defaultReadBotAllowlist(cwd);
  const readOverrideActors = deps.readOverrideActors ?? defaultReadApprovalActors(cwd);
  const readConfig = deps.readConfig ?? defaultReadConfig(cwd);
  const tier = tierOverride ?? deps.tier ?? resolveTier(readConfig());
  const { honorOverride } = tierParams(tier);
  const codeownersArmed = deps.codeownersArmed ?? false;

  const botAllowlist = readBotAllowlist();
  const overrideActors = readOverrideActors();
  const changedFiles = diffNameOnly(baseSha, headSha);
  const reviews = tier === 'lite' ? [] : await fetchReviews(prNumber);
  const overrideLabelPresent = prLabels.some(l => l.startsWith('override:') && overrideActors.includes(l));
  const adminOverride = honorOverride && overrideLabelPresent;
  const overrideRefused = overrideLabelPresent && !honorOverride;

  return { changedFiles, reviews, author, botAllowlist, adminOverride, overrideRefused, tier, codeownersArmed };
}

/**
 * Runs the full L6 brain-writes-reviewed check: gathers inputs (git + gh API),
 * evaluates the pure rule. Never throws — but a gh/git/config failure inside
 * `gatherBrainWritesReviewedInputs` no longer unconditionally degrades to
 * `warn` (issue #942, R6, R7). This job is `required` at EVERY tier
 * (`GATE_MATRIX['brain-writes-reviewed']`, promoted out of detection in
 * Phase 5) — the docstring's former claim that it is "detection-only
 * (DETECTION_JOBS)" was FALSE (`DETECTION_JOBS` is empty,
 * `checkContexts('standard')` returns ten required contexts): a gh/git
 * failure, or a `brain.config.json` a hardened deny/exclusion reader could
 * not read or parse, means the Tier-2 human-review evidence CANNOT BE
 * VERIFIED, which is not the same thing as "no reviews yet" (the
 * genuinely-computed missing-evidence branches still handled inside
 * `evaluateBrainWritesReviewed`, unchanged). The catch resolves the tier via
 * `resolveTierForFailure` (never throws) and `resolveGatePolicy` — `fail`
 * when `required`, `warn` only if a future matrix change ever demotes this
 * gate's position to `detection` (not true today), mirroring
 * `actor-check.mjs`'s identical catch shape exactly.
 *
 * baseSha/headSha/prNumber/repo/author/prLabels source from the normalized
 * ci-context (`ctx.*`, ADR-0016) — never from process.env directly (a
 * drift-guard test enforces this). `ctx.labels` is already an array, so it
 * replaces the former `PR_LABELS` space-separated env parsing outright.
 *
 * This function is async as of issue #239 A3 TASK2 — `gatherBrainWritesReviewedInputs`
 * dispatches the `prReviews` CONTRACT verb via `getVcs({ provider })`, a
 * Promise-returning call.
 *
 * @param {{ baseSha?: string, headSha?: string, prNumber?: number|string, repo?: string, author?: string, prLabels?: string[], cwd?: string, ctx?: object } & object} [deps]
 * @returns {Promise<{ level: 'pass'|'warn'|'fail', reason: string }>}
 */
export async function runBrainWritesReviewedCheck(deps = {}) {
  const ctx = deps.ctx ?? {};
  const baseSha = deps.baseSha ?? ctx.baseSha ?? undefined;
  const headSha = deps.headSha ?? ctx.headSha ?? undefined;
  const prNumber = deps.prNumber ?? ctx.prNumber ?? undefined;
  const repo = deps.repo ?? ctx.repo ?? undefined;
  const author = deps.author ?? ctx.author ?? undefined;
  const provider = deps.provider ?? ctx.provider ?? undefined;
  // ctx.labels may be null (uncomputable fetch); collapsing to [] here is the SAFE
  // direction for this DETECTION gate — no labels ⇒ no admin-override applies ⇒
  // stricter enforcement, never a fail-open (unlike the empty-on-failure anti-pattern).
  const prLabels = deps.prLabels ?? ctx.labels ?? [];
  const cwd = deps.cwd ?? process.cwd();

  if (!baseSha || !headSha || !prNumber || !repo || !author) {
    return {
      level: 'warn',
      reason:
        'BASE_SHA/HEAD_SHA/PR_NUMBER/GITHUB_REPOSITORY/PR_AUTHOR not set — cannot verify brain-writes ' +
        'review; skipping brain-writes-reviewed check.',
    };
  }

  let inputs;
  try {
    inputs = await gatherBrainWritesReviewedInputs({ baseSha, headSha, prNumber, repo, author, provider, prLabels, cwd, deps });
  } catch (err) {
    const tier = resolveTierForFailure(cwd, deps);
    // `resolveGatePolicy` is injectable via `deps` for the same reason every
    // other I/O in this wrapper already is (test discipline, above) — the
    // production default is always the real, imported function. `required`
    // at every tier today (GATE_MATRIX), so the `warn` branch is
    // dead-but-correct, exactly as in `actor-check.mjs` (guarded by T8).
    const resolvePolicy = deps.resolveGatePolicy ?? resolveGatePolicy;
    if (resolvePolicy('brain-writes-reviewed', tier) === 'required') {
      return {
        level: 'fail',
        reason:
          `brain-writes-reviewed: could not gather inputs (gh/git or brain.config.json failure) — ` +
          `${err.message} — failing closed: this gate is required at the "${tier}" tier.`,
      };
    }
    return {
      level: 'warn',
      reason: `brain-writes-reviewed: could not gather inputs (gh/git or brain.config.json failure) — ${err.message} (detection-tier at "${tier}").`,
    };
  }

  return evaluateBrainWritesReviewed(inputs);
}

/**
 * Runs the check, prints the verdict + reason, and returns the process exit
 * code — kept separate from `process.exit()` itself so it stays testable
 * (mirrors actor-check.mjs's main()). Exit 0 on pass/warn, 1 on fail. Async
 * as of A3 TASK2 (awaits `runBrainWritesReviewedCheck`).
 *
 * @param {object} [deps]
 * @returns {Promise<0|1>}
 */
export async function main(deps = {}) {
  const result = await runBrainWritesReviewedCheck(deps);
  console.log(`brain-writes-reviewed: ${result.level}`);
  if (result.reason) console.log(`  ${result.reason}`);
  return result.level === 'fail' ? 1 : 0;
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ctx = await loadContext();
  process.exit(await main({ ctx }));
}
