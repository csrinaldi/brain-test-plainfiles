// tranche.mjs — REQ-H1-8: the tranche evaluator, THE per-push cold check
// (protocol §6, §8; design.md §2, §4). Mirrors the vcs/ DI-seam house style
// (D1): a pure `evaluateTranche(inputs)` core + `gatherTrancheInputs(deps)`
// that resolves the server-side rollup and re-derives the budget cold.
//
// Required gates come from the server's `prStatusRollup` (ADR-0021), RE-DERIVED
// cold — never read from the PR body / a report. If the rollup is uncomputable
// (`gh` down), this evaluator NEVER approves — it fails closed to REVISE with
// `conditions: [evidence uncomputable]` (protocol §10). Budget is re-derived
// the same way: `git diff --numstat base...head | diff-size-count.mjs`, never
// trusted from a report; when `base`/`head` are not resolvable, the budget is
// ALSO uncomputable and folds into the SAME fail-closed rule — this
// generalizes protocol §10's "never APPROVE on uncomputable evidence" rather
// than inventing a new one. `base` (this file's caller, `cli.mjs`) resolves
// from `ci-context.mjs`'s CI-env BASE_SHA when set, else from `prView`'s
// `baseRefOid` (ADR-0022 Decision 1/2, the port widening that closed
// H1-2C-BASE) — so this fail-closed branch now only fires when BOTH sources
// are genuinely uncomputable (e.g. the `gh`/`glab` fetch itself failed), not
// merely "running outside CI" as before the widening landed.

import { execFileSync } from 'node:child_process';

import { getVcs } from '../../vcs/cli.mjs';
import { loadBrainConfig } from '../../lib/brain-config.mjs';
import { parseDiffNumstat } from '../../vcs/diff-size-count.mjs';
import { REQUIRED_JOBS, DETECTION_JOBS, resolveJobSets } from '../../vcs/governance-checks.mjs';
import { resolveTier, tierParams, sizeExceptionRuling, SIZE_EXCEPTION_LABEL } from '../../vcs/governance-tiers.mjs';
import { isUncomputable } from '../../vcs/lib/uncomputable-cause.mjs';

// The diff budget is TIERED (ADR-0026 §2.C: lite 1000 · standard 400 ·
// regulated 200) and lives in exactly one place — `tierParams(tier).diffBudget`
// — which is also what governance.yml's diff-size gate reads, through
// `governance-tiers.mjs diff-budget`'s CLI printer (REQ-TIER-9, "no second
// budget literal").
//
// Until #443 this file declared `const LINE_BUDGET = 400` and mirrored the
// pre-tiering constant. It was correct at `standard` BY COINCIDENCE, and every
// tranche fixture in the suite sits at `standard` — so the reviewer approved
// 350-line PRs at `regulated` (budget 200) and flagged 500-line PRs at `lite`
// (budget 1000) with a full green suite. Resolve, never re-declare.
const DEFAULT_TIER = 'standard';

const TIER2_PREFIXES = ['brain/core/', 'brain/project/'];
// #671 — the third implementation of the AI-attribution rule, and the only one
// in JS. EXPORTED so hooks/hooks.attribution-parity.test.mjs can drive the real
// value through the shared corpus instead of scraping this source; a guard that
// parses the file it guards fails open the moment the declaration is reformatted.
//
// VENDOR-NEUTRAL, and structured to mirror the two shell hooks line for line.
// brain ships into other people's repositories and the doctrine says "AI
// attribution", not one vendor's: a pattern that only knew `claude` would
// enforce the rule here and silently exempt every consumer using another agent.
//
// OBSERVED SPELLINGS, never a complete detector — no such list can be complete,
// and one claiming to be would be the apparent protection #499 refuses. The
// `generated` shape requires a markdown-link bracket so ordinary prose
// ("generated with cursor pagination") is not caught; the corpus pins both
// directions.
const AI_AGENTS = 'claude|copilot|chatgpt|gpt|gemini|cursor|devin|codex|aider|windsurf';
export const AI_ATTRIBUTION_RE = new RegExp(
  `co-authored-by:\\s*(${AI_AGENTS})` +
  `|(${AI_AGENTS})-session:` +
  `|generated\\s+(with|by)\\s*\\[(${AI_AGENTS})` +
  '|🤖',
  'i',
);

function isGateGreen({ status, conclusion } = {}) {
  const c = (conclusion ?? '').toLowerCase();
  if (c) return c === 'success';
  return (status ?? '').toLowerCase() === 'success';
}

function quoteGate(name, gate) {
  return gate
    ? `prStatusRollup: ${name} status=${gate.status ?? 'null'} conclusion=${gate.conclusion ?? 'null'}`
    : `prStatusRollup: ${name} — not present in rollup`;
}

/**
 * The control classes this evaluator is capable of producing (#683).
 *
 * Every check it runs is mechanical — a fetched gate-status rollup, a
 * `git diff --numstat`, a regex over a body, an `existsSync`, a base-sha
 * reversion — so `deterministic` is the whole of it, for the reason
 * `lib/causal-admission.mjs` already states about the same three evaluators.
 *
 * Declared HERE rather than inferred at the call site: this is the file that
 * would change if the answer ever changed, and a declaration that lives next to
 * the code it describes is the one that gets updated with it.
 */
export const PRODUCES = Object.freeze(['deterministic']);

/**
 * Pure core (design.md §5 style — no seams). Takes the already-fetched rollup
 * + already-re-derived budget and produces `{ conclusion, gates, findings,
 * conditions }`, the shape `buildVerdict` (verdict.mjs) consumes directly.
 *
 * `requiredJobs`/`detectionJobs` (issue #358 Q5 Phase 5 review finding 2)
 * default to the STALE, tier-blind `REQUIRED_JOBS`/`DETECTION_JOBS` snapshot
 * (governance-checks.mjs, captured at the `'standard'` tier) for backward
 * compatibility with callers that don't resolve a tier — `gatherTrancheInputs`
 * below now resolves brain's OWN declared tier and passes the correct,
 * tier-scoped pair through instead of relying on this default.
 *
 * @param {object} input
 * @param {Array<{name:string,status:string|null,conclusion:string|null}>|null} input.requiredGates
 *   The full `prStatusRollup` — `null` means uncomputable (fail-closed).
 * @param {string[]} [input.changedFiles]
 * @param {{lines?:number, uncomputable?:boolean, baseSha?:string, headSha?:string}} [input.budget]
 * @param {string} [input.prBody]
 * @param {string[]} [input.requiredJobs]  Tier-scoped required job names (default: REQUIRED_JOBS, the 'standard'-tier snapshot).
 * @param {string[]} [input.detectionJobs]  Tier-scoped detection job names (default: DETECTION_JOBS, the 'standard'-tier snapshot).
 * @param {number} [input.diffBudget]  Tier-scoped line budget (issue #443). Defaults to
 *   the SAME tier as the job-set defaults above (`standard`) — derived from
 *   `tierParams`, never written as a literal, so a caller that skips the gather seam
 *   still gets one coherent tier's doctrine rather than a `standard` job set judged
 *   against some other tier's budget.
 * @param {string} [input.tier]  The resolved tier NAME. Evidence-only (it makes the
 *   budget finding readable without knowing the tier table); absent for the older
 *   callers that never passed it, and the finding degrades to omitting the suffix.
 * @returns {{ conclusion: 'APPROVE'|'REVISE', gates: {required:string[],detection:string[]}, findings: object[], conditions: string[] }}
 */
// #606: the rollup now reports WHY it could not be read. This renders that
// cause; it never decides anything. The evaluator stays provider-agnostic —
// it knows the SHAPE (`vcs/lib/uncomputable-cause.mjs`) and not one word of
// `gh`'s or `glab`'s vocabulary, which is ruling 2's layering: the port
// carries, the classifier labels, this renders.
//
// `detail` is interpolated WHOLE and last — no truncation (design §5.5,
// D9). Truncating it here would rebuild, in the renderer, the silence the
// port just stopped producing — and `verdict.mjs`'s `yamlScalar` already
// escapes newlines (#481), so a multi-line stderr cannot break the block.
//
// A rollup that is neither an Array nor an Uncomputable (a bare `null` from
// one of the 13 readers still discarding its cause) keeps the ORIGINAL
// string exactly: there is no cause to report, and inventing a
// parenthetical would claim otherwise.
function rollupUncomputableCondition(rollup) {
  if (!isUncomputable(rollup)) return 'evidence uncomputable';
  return `evidence uncomputable: required gate rollup (${rollup.reason}) — ${rollup.detail}`;
}

export function evaluateTranche({
  requiredGates = null,
  changedFiles = [],
  budget = null,
  prBody = '',
  requiredJobs = REQUIRED_JOBS,
  detectionJobs = DETECTION_JOBS,
  diffBudget = tierParams(DEFAULT_TIER).diffBudget,
  tier = null,
  // #1072: the PR's own labels. The evaluator used to read the tier's budget
  // and ignore its sibling `honorSizeException`, so it blocked on a number the
  // `diff-size` gate had waived eight seconds earlier. `null` is what
  // `gatherTrancheInputs` hands over when the forge refused the read, and it
  // is deliberately NOT a waiver.
  labels = null,
} = {}) {
  if (!Array.isArray(requiredGates)) {
    // Uncomputable evidence — never APPROVE on it (protocol §10, REQ-H1-8
    // scenario "uncomputable evidence never approves"). The GUARD is
    // unchanged and stays `Array.isArray`: #606's cause object is TRUTHY,
    // so a `!requiredGates` check would fall through into
    // `requiredGates.map` and throw.
    return {
      conclusion: 'REVISE',
      gates: { required: [], detection: [] },
      findings: [],
      conditions: [rollupUncomputableCondition(requiredGates)],
      // #750: the softening in verdict.mjs must be able to see WHY this
      // evaluator said REVISE — uncomputable evidence, never a blocker.
      conclusionCauses: ['uncomputable'],
    };
  }

  const findings = [];
  const rollupByName = new Map(requiredGates.map(g => [g.name, g]));

  for (const name of requiredJobs) {
    const gate = rollupByName.get(name);
    if (!gate || !isGateGreen(gate)) {
      findings.push({
        id: `gate:${name}`,
        severity: 'blocker',
        evidence: quoteGate(name, gate),
        cites: 'governance-tiers.mjs requiredJobs(tier)',
      });
    }
  }

  for (const name of detectionJobs) {
    const gate = rollupByName.get(name);
    if (gate && !isGateGreen(gate)) {
      // A detection-level warn is not a blocker — it is surfaced verbatim
      // (REQ-H1-8: "an unquoted warn is a review defect").
      findings.push({ id: `detection:${name}`, severity: 'editorial', evidence: quoteGate(name, gate) });
    }
  }

  if (budget?.uncomputable) {
    // Same fail-closed rule as the rollup, generalized: budget is also
    // required evidence, re-derived cold; if it cannot be computed, the
    // evaluator does not guess a number.
    return {
      conclusion: 'REVISE',
      gates: { required: [...requiredJobs], detection: [...detectionJobs] },
      findings,
      conditions: ['evidence uncomputable: budget diff (base sha unresolvable outside CI)'],
      // #750: `findings` is read AGAIN here, not reused from below — it is
      // still growing (the budget finding below never gets pushed on this
      // path), so this is a second, independent measurement of the same
      // mutating list, not duplicated logic.
      conclusionCauses: [...(findings.some((f) => f.severity === 'blocker') ? ['blocker'] : []), 'uncomputable'],
    };
  }

  if (budget && typeof budget.lines === 'number' && budget.lines > diffBudget) {
    // ONE reading of the label, shared with `governance/run-check.mjs`
    // (#1072). The tier is resolved for the ruling exactly as it is for the
    // budget above it; with no tier in hand the default is used, which is what
    // `diffBudget` already defaults to.
    // ONE resolution, used by the ruling and by every sentence that names the
    // tier (#1073 rev 5, Gemini finding cold-2). Three interpolations carried
    // two spellings — `tier ?? DEFAULT_TIER` in the waived sentence and a bare
    // `tier` in the refused one — so a refused waiver on an unresolved tier
    // would have named the "null" tier. It is not reachable today, because
    // `DEFAULT_TIER` honors the waiver and so `refusedByTier` cannot be true
    // while `tier` is null; it becomes reachable the day that default changes.
    // Resolving once removes the possibility rather than guarding it.
    const resolvedTier = tier ?? DEFAULT_TIER;
    const ruling = sizeExceptionRuling({ labels, tier: resolvedTier });
    const comparison =
      `git diff --numstat ${budget.baseSha}...${budget.headSha} | diff-size-count.mjs = ` +
      `${budget.lines} > ${diffBudget}${tier ? ` (tier: ${tier})` : ''}`;

    if (ruling.honored) {
      // Waiving is not forgetting. The gate returns `pass` WITH a reason, and
      // so does this: an area where a waived 3,101-line diff used to be
      // reported must not become blank, or the verdict stops carrying the
      // fact the maintainer granted an exception about.
      findings.push({
        id: 'budget',
        severity: 'editorial',
        evidence: `${comparison} — ${SIZE_EXCEPTION_LABEL} present and honored at the "${resolvedTier}" tier, so the budget is waived, not met`,
        cites: 'governance-tiers.mjs sizeExceptionRuling',
      });
    } else {
      // A budget blocker where the LABELS could not be read is a different
      // fact from one where the PR genuinely carries no exception, and a
      // reader has to be able to tell them apart: the first may be a refused
      // forge read, the second is a real answer. `null` is what
      // `gatherTrancheInputs` and `review/cli.mjs` hand over for "not read",
      // and this is the sentence that makes that distinction worth keeping
      // (#1073 cold review, finding cold-1).
      const unread = !Array.isArray(labels);
      findings.push({
        id: 'budget',
        severity: 'blocker',
        // The comparison and the tier travel WITH the evidence (protocol §10:
        // findings are self-evidencing). `cites` names the resolving function, not
        // a number — the old `(400-line budget)` parenthetical was a citation to
        // doctrine the evaluator had not actually applied at two of three tiers.
        //
        // REQ-TIER-6: when a tier REFUSES the waiver, the verdict says the
        // label was present and the tier refused it — the same sentence
        // `run-check.mjs` produces. Silence would read as "nobody asked".
        evidence: ruling.refusedByTier
          ? `${comparison} — ${SIZE_EXCEPTION_LABEL} is not honored at the "${resolvedTier}" tier; the change must be sliced`
          : unread
            ? `${comparison} — the PR's labels could not be read, so no waiver could be honored; this block may be a refused read rather than an absent exception`
            : comparison,
        cites: 'governance-tiers.mjs tierParams(tier).diffBudget',
      });
    }
  }

  const tier2Touched = changedFiles.filter(f => TIER2_PREFIXES.some(prefix => f.startsWith(prefix)));
  if (tier2Touched.length > 0) {
    findings.push({
      id: 'tier2-frontier',
      severity: 'correction',
      evidence: `git diff --name-only touches Tier-2: ${tier2Touched.join(', ')}`,
      cites: 'agent-authorities.md Tier-2',
    });
  }

  // #671: this reads the PR BODY and nothing else. It used to cite
  // "CLAUDE.md — never add AI attribution to commits", which was wrong twice
  // over: `CLAUDE.md` does not exist in this repository, and the rule it named
  // is about COMMITS, a surface this evaluator never sees. A finding that
  // claims to enforce a rule it does not measure reads as verified and is not —
  // #580/#586's lesson in its extreme form, sending the reader to no text at
  // all rather than merely to the wrong line.
  //
  // The commit surface is now covered where it can be enforced rather than
  // detected: hooks/commit-msg (client) and hooks/pre-receive (server,
  // bypass-proof). This check keeps the body, and now says so.
  if (AI_ATTRIBUTION_RE.test(prBody ?? '')) {
    findings.push({
      id: 'ai-attribution',
      severity: 'editorial',
      evidence: 'PR body matches an AI-attribution pattern (co-authored-by / claude-session / generated with / 🤖)',
      cites: 'agent-authorities.md Tier 3 — AI attribution is prohibited; commits are gated by hooks/pre-receive, this finding covers the PR body',
    });
  }

  const anyBlocker = findings.some(f => f.severity === 'blocker');
  const conclusion = anyBlocker ? 'REVISE' : 'APPROVE';

  return {
    conclusion,
    gates: { required: [...requiredJobs], detection: [...detectionJobs] },
    findings,
    conditions: [],
    // #750: APPROVE never declares 'blocker' — there is nothing that caused it.
    conclusionCauses: anyBlocker ? ['blocker'] : [],
  };
}

function defaultDiffNumstat({ cwd = process.cwd() } = {}) {
  return (baseSha, headSha) =>
    execFileSync('git', ['diff', '--numstat', `${baseSha}...${headSha}`], { cwd, encoding: 'utf8' });
}

/**
 * Gathers `evaluateTranche`'s inputs. `baseSha`/`headSha`/`changedFiles` are
 * caller-supplied (cli.mjs resolves them once and shares them with
 * `mode.mjs`'s derivation) — this function's own seams are the READ verb
 * (`fetchRollup`) and the local git budget re-derivation (`diffNumstat`).
 *
 * `requiredJobs`/`detectionJobs` (issue #358 Q5 Phase 5 review finding 2):
 * resolved from THIS repo's own declared `governance.tier`
 * (`brain.config.json`, via `resolveTier`/`resolveJobSets` —
 * governance-tiers.mjs/governance-checks.mjs), never the stale
 * `REQUIRED_JOBS`/`DETECTION_JOBS` snapshot `evaluateTranche` still defaults
 * to for callers that skip this seam. For brain's own declared `lite` tier
 * this yields `detectionJobs: ['memory-gate', 'phase-order']` (both
 * position-tiered by proportionality) instead of the stale
 * `['phase-order', 'actor-check', 'brain-writes-reviewed']` — `actor-check`/
 * `brain-writes-reviewed` are `required` at EVERY tier (REQ-TIER-2's
 * never-tiered core) and must never be classified as detection-only.
 * `deps.tier` (a direct override) and `deps.readConfig` (a config-loader
 * override) are both injectable for tests; production defaults to the real
 * `brain.config.json` via `loadBrainConfig`.
 *
 * @param {{ project, number, provider, headSha, baseSha, changedFiles, prBody, deps }} args
 */
export async function gatherTrancheInputs({
  project,
  number,
  provider,
  headSha,
  baseSha,
  changedFiles = [],
  prBody = '',
  // #1072: an INPUT, never a fetch. Both production callers already hold the
  // PR's labels — `review/cli.mjs` reads `boot.prView.labels` twice before it
  // gets here, and `evaluators/checkpoint.mjs` takes them as a parameter of
  // its own — so taking them costs the forge nothing and keeps them consistent
  // with the `prBody` gathered beside them.
  //
  // A fallback that fetched them when a caller passed none was tried and
  // REVERTED: it made this function reach the network, and every existing test
  // that did not pass labels started doing so. On this machine `gh` is
  // authenticated and the call returned an array, so the suite was green; in
  // CI there is no such credential, the call threw, and
  // `gatherTrancheInputs: standard's evidence TEXT does change` failed on the
  // evidence string. A unit suite whose result depends on whether the machine
  // can reach a forge is not a unit suite.
  labels: givenLabels,
  deps = {},
} = {}) {
  const fetchRollup =
    deps.fetchRollup ?? (async () => (await (deps.getVcs ?? getVcs)({ provider })).prStatusRollup({ project, number }));
  const requiredGates = await fetchRollup();

  const diffNumstat = deps.diffNumstat ?? defaultDiffNumstat(deps);
  const readIgnoreList = deps.readIgnoreList ?? (() => loadBrainConfig().governance?.ignoreList ?? []);

  let budget;
  if (!baseSha || !headSha) {
    budget = { uncomputable: true };
  } else {
    const raw = diffNumstat(baseSha, headSha);
    budget = { lines: parseDiffNumstat(raw, readIgnoreList()), baseSha, headSha, uncomputable: false };
  }

  const readConfig = deps.readConfig ?? loadBrainConfig;
  const tier = deps.tier ?? resolveTier(readConfig());
  const { required: requiredJobs, detection: detectionJobs } = resolveJobSets(tier);
  // Issue #443: the budget rides the SAME resolution as the job sets. Before
  // this, the tier was resolved here and then dropped before reaching the
  // budget comparison, which used a file-local constant instead.
  const { diffBudget } = tierParams(tier);

  // #1072: a refusal is `null`, never `[]`. An empty array would say "this PR
  // carries no exception", which is a claim nobody can make when the labels
  // were never read. `sizeExceptionRuling` treats a non-array as no waiver, so
  // an unread set fails CLOSED, and `evaluateTranche` says which of the two
  // happened rather than letting a reader guess.
  const labels = Array.isArray(givenLabels) ? givenLabels : null;

  return { requiredGates, changedFiles, budget, prBody, requiredJobs, detectionJobs, diffBudget, tier, labels };
}
