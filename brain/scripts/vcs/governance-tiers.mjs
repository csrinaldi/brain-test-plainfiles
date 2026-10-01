// governance-tiers.mjs — Pure doctrine-tier resolver (Q5, issue #358, design §8).
// No I/O at import, mirroring substrate.mjs's discipline: everything here is
// data + pure functions over that data. The only I/O this file ever performs
// is inside the CLI guard at the bottom (bash consumers only), never at
// module-eval time.
//
// Two axes, never conflated (REQ-TIER-4): the TIER (`governance.tier`) is
// DECLARED — a team's statement about its own operating model. The RUNG
// (substrate.mjs#detectSubstrate) is DETECTED — what the platform can
// structurally enforce. Neither may substitute for the other, and no code
// path here reads a probe, an env var, or a platform capability.
//
// Two tiering MECHANISMS (design §2), deliberately kept distinct:
//   - Position tiering  — a gate's exit POLICY moves between `required` and
//     `detection`. Reserved for proportionality (REQ-TIER-7): per-change
//     ceremony whose benefit scales with team size (memory-gate, phase-order).
//   - Evidence tiering  — the gate stays `required` at every tier; WHAT
//     satisfies it changes (REQ-TIER-5). Reserved for the never-tiered core
//     (REQ-TIER-2) when one evidence form is structurally unsatisfiable at a
//     tier's operating model (actor-check, brain-writes-reviewed, decision-gate).
//
// STAGED ROLLOUT — READ BEFORE TOUCHING PENDING_PROMOTION (issue #358 phases):
// GATE_MATRIX below encodes the FULL, ratified END-STATE doctrine from
// design.md §2 verbatim — including `actor-check` and `brain-writes-reviewed`
// resolving to `required` at every tier (REQ-TIER-2's never-tiered core) and
// `phase-order` resolving to `required` at standard/regulated (design §2.B).
//
// Phase 5 (tasks.md) PROMOTED all three gates: their preconditions are now
// met —
//   - `actor-check`/`brain-writes-reviewed`'s REQ-L5-1'/REQ-L6-1' tiered
//     evidence forms shipped in Phase 4 (commits `21cc250`, `732b243`),
//     unblocked by #328 (PR #370).
//   - `phase-order`'s uncomputable-diff branch now fails closed at this gate's
//     `required` tiers (standard/regulated) — ADR-0015's recorded
//     precondition. At `lite` (this gate's `detection` tier) it still exits 0
//     with a `::warning::` naming the tier, per REQ-TIER-3 (`phase-order-check.mjs`'s
//     `runPhaseOrderCheck`, wired through `run-check.mjs`'s
//     `mapDetectionToWarning` — issue #358 Q5 finding A).
// `PENDING_PROMOTION` is therefore empty: `requiredJobs()` no longer filters
// any gate out of the matrix's raw policy. Before Phase 5, wiring
// `resolveGatePolicy`'s raw 'required' straight into a consumer's
// required-check list would have flipped these into branch-protection-required
// contexts before any repo without a second distinct human approver (or a
// fail-closed phase-order evaluator) could satisfy them — reproducing #329.
// `resolveGatePolicy`/`resolveGateEvidence` always reported the matrix's raw
// (target) values, unfiltered; `requiredJobs()` is the one surface that used
// to differ from them during the staged rollout — a caller that needs "is
// this gate ACTUALLY enforced today" should still prefer `requiredJobs()`
// over `resolveGatePolicy()` directly, since a FUTURE promotion may re-use
// this same list.
//
// This split is what kept REQ-TIER-2's unit test ("never-tiered core always
// resolves to `required`") true — a doctrine fact — while REQ-TIER-10's
// no-op-migration guarantee ("standard reproduces today's exact behaviour")
// also held — an operational safety fact, during the staged rollout. Both are
// ratified requirements; this module satisfied both by keeping "what the
// doctrine says" and "what is safe to enforce today" as two distinct,
// separately-testable functions. Adding a gate to `PENDING_PROMOTION` again in
// the future (a new gate, not yet evidence-ready) remains the sanctioned
// pattern for staging a promotion.

import { fileURLToPath } from 'node:url';
import { loadBrainConfig } from '../lib/brain-config.mjs';
import { artefactFiles } from '../lib/sdd-layout.mjs';

export const TIERS = Object.freeze(['lite', 'standard', 'regulated']);

/**
 * REQ-TIER-2 — the never-tiered core, enumerated in code (never inferred).
 * `resolveGatePolicy(gate, tier)` MUST return `'required'` for every gate here
 * at every tier — position never tiers down for these six. (Evidence MAY
 * still tier — REQ-TIER-5.)
 *
 * @type {string[]}
 */
export const NEVER_TIERED = Object.freeze([
  'issue-link',
  'local-checks',
  'decision-gate',
  'diff-size',
  'actor-check',
  'brain-writes-reviewed',
]);

/**
 * Gates whose GATE_MATRIX-declared policy is the ratified TARGET doctrine but
 * whose promotion into the CONSUMER-FACING `requiredJobs()` surface is
 * explicitly deferred — see the STAGED ROLLOUT note above. Removing a name
 * from this list is the Phase 5 "promote" action (tasks.md); it is a
 * deliberate, reviewed data change, never automatic.
 *
 * Empty as of Q5 Phase 5: `actor-check` and `brain-writes-reviewed` promoted
 * (REQ-L5-1'/REQ-L6-1' evidence forms shipped, Phase 4) and `phase-order`
 * promoted (uncomputable-diff branch fail-closed, ADR-0015 precondition met).
 *
 * @type {string[]}
 */
const PENDING_PROMOTION = Object.freeze([]);

/**
 * The VERIFICATION SURFACE — every dir and entry script whose code judges a
 * change (#323 S7). Declared HERE, in the gates' own vocabulary owner, and
 * nowhere else: "what is a gate" is brain's declaration, platform-neutral.
 * A forge's CI config (.github/workflows, .gitlab-ci.yml) is an ADAPTER's
 * wiring of this surface — it is checked AGAINST this declaration for drift
 * (engine-blind-gates.test.mjs), never read as the authority. That ruling is
 * the maintainer's, from #847's review: a guard that resolves "what is a
 * gate" from one forge's config directory has coupled doctrine to an
 * implementation detail.
 * Consumed by engine-blind-gates.test.mjs (ADR-0019 Amendment 1 condition 2:
 * verification stays neutral — no gate names an engine or reaches its home).
 */
export const VERIFICATION_SURFACE = Object.freeze({
  // Whole verify-side DIRECTORIES, not remembered files (#847 rounds 7–8: a
  // file list missed archive, then missed tranche.mjs — the evaluator's own
  // decision core, split out by the D1 pure-core pattern. Enumerating
  // decision files by hand loses to the next refactor; a directory does not).
  // review/ as a whole stays out: its cli and cold-review runner PRODUCE and
  // import harness by design — the one such file under review/lib carries a
  // reviewed allowlist entry in engine-blind-gates.test.mjs instead.
  dirs: Object.freeze([
    'brain/scripts/vcs',
    'brain/scripts/governance',
    'brain/scripts/review/evaluators',  // the checkpoint evaluator and its decision cores (reader 2)
    'brain/scripts/review/lib',         // the evaluator's parsing/assembly helpers
  ]),
  scripts: Object.freeze([
    'brain/scripts/check-refs.mjs',    // local-checks, reached via npm-script indirection (reader 3)
    'brain/scripts/memory/index-lag.mjs', // local-checks — warns on index/records drift, never fails (#889)
    'brain/scripts/brain-audit.mjs',   // the postmerge/release audit — a gate that runs after merge
    'brain/scripts/archive.mjs',       // change:archive (reader 4)
    'brain/scripts/lib/archive-logic.mjs',
    'brain/scripts/review/poster.mjs', // the verdict's writers — verify-side, outside the dirs above
    'brain/scripts/review/verdict.mjs',
  ]),
});

/**
 * §2 — the gate distribution matrix (design.md §2, verbatim). One row per
 * `GOVERNANCE_JOBS` name (governance-checks.mjs). REQ-TIER-8's drift-guard
 * (governance-tiers.test.mjs) asserts this key set equals GOVERNANCE_JOBS
 * exactly, in both directions.
 *
 * Row order intentionally mirrors GOVERNANCE_JOBS / governance.yml's job
 * order (REQUIRED jobs, then DETECTION jobs) so `requiredJobs()` — which
 * iterates `Object.keys(GATE_MATRIX)` — preserves that same order.
 *
 * @type {Record<string, Record<'lite'|'standard'|'regulated', {policy: 'required'|'detection', evidence: string}>>}
 */

export const GATE_MATRIX = Object.freeze({
  'issue-link': Object.freeze({
    lite: Object.freeze({ policy: 'required', evidence: 'approved-label' }),
    standard: Object.freeze({ policy: 'required', evidence: 'approved-label' }),
    regulated: Object.freeze({ policy: 'required', evidence: 'approved-label' }),
  }),
  'diff-size': Object.freeze({
    // Position never tiers (REQ-TIER-2); the BUDGET and the size:exception
    // waiver tier instead — see tierParams()/§2.C. Same evidence form
    // (line-count against a budget) at every tier.
    lite: Object.freeze({ policy: 'required', evidence: 'line-count-budget' }),
    standard: Object.freeze({ policy: 'required', evidence: 'line-count-budget' }),
    regulated: Object.freeze({ policy: 'required', evidence: 'line-count-budget' }),
  }),
  'local-checks': Object.freeze({
    lite: Object.freeze({ policy: 'required', evidence: 'test-suite' }),
    standard: Object.freeze({ policy: 'required', evidence: 'test-suite' }),
    regulated: Object.freeze({ policy: 'required', evidence: 'test-suite' }),
  }),
  'memory-gate': Object.freeze({
    // Position-tiered by proportionality (design §2.B / §6): team-continuity
    // discipline scales with team size, so `lite` demotes to detection — the
    // one real, already-safe loss brain accepts by declaring `lite` (design §5).
    lite: Object.freeze({ policy: 'detection', evidence: 'coverage-report' }),
    standard: Object.freeze({ policy: 'required', evidence: 'issue-linked-record' }),
    regulated: Object.freeze({ policy: 'required', evidence: 'issue-linked-session-summary' }),
  }),
  'decision-gate': Object.freeze({
    // Never-tiered by position; evidence tiers (design §2.A). NOTE (design §9
    // open risk): the shipped adr-presence.mjs check is UNCONDITIONAL and does
    // not yet implement the standard/regulated evidence deltas below — these
    // tags record the ratified TARGET evidence, not yet wired into the
    // checker. Flagged for a separate follow-up, not implemented here.
    lite: Object.freeze({ policy: 'required', evidence: 'adr-home-cooccurrence' }),
    standard: Object.freeze({ policy: 'required', evidence: 'adr-home-cooccurrence+decision-label-hard' }),
    regulated: Object.freeze({
      policy: 'required',
      evidence: 'adr-home-cooccurrence+decision-label-hard+recorded-signature',
    }),
  }),
  'phase-order': Object.freeze({
    // Position-tiered by proportionality (design §2.B). Promoted to `required`
    // at standard/regulated in Phase 5, gated on fail-closing the
    // uncomputable-diff branch first (ADR-0015 precondition, met —
    // phase-order-check.mjs's runPhaseOrderCheck now returns `fail` instead of
    // `warn` when the diff is uncomputable). `lite` stays `detection` by
    // design (proportionality), not by PENDING_PROMOTION.
    lite: Object.freeze({ policy: 'detection', evidence: 'artefact-presence' }),
    standard: Object.freeze({ policy: 'required', evidence: 'artefact-presence' }),
    regulated: Object.freeze({ policy: 'required', evidence: 'artefact-presence' }),
  }),
  'actor-check': Object.freeze({
    // Never-tiered by position (REQ-TIER-2); evidence tiers (REQ-TIER-5,
    // REQ-L5-1'). Promoted to `required` at every tier in Phase 5 — the
    // tiered evidence forms shipped in Phase 4 (commit `21cc250`), unblocked
    // by #328 (PR #370).
    lite: Object.freeze({ policy: 'required', evidence: 'distinct-act' }),
    standard: Object.freeze({ policy: 'required', evidence: 'distinct-act+distinct-actor' }),
    regulated: Object.freeze({ policy: 'required', evidence: 'distinct-act+distinct-actor+no-commit-on-branch' }),
  }),
  'brain-writes-reviewed': Object.freeze({
    // Never-tiered by position (REQ-TIER-2); evidence tiers (REQ-TIER-5,
    // REQ-L6-1'). Promoted to `required` at every tier in Phase 5 — the
    // tiered evidence forms shipped in Phase 4 (commit `732b243`), unblocked
    // by #328 (PR #370).
    lite: Object.freeze({ policy: 'required', evidence: 'agent-authorship-exclusion' }),
    standard: Object.freeze({ policy: 'required', evidence: 'human-approved-review' }),
    regulated: Object.freeze({ policy: 'required', evidence: 'human-approved-review+codeowners-rung1' }),
  }),
  // #905 (ADR-0034 L1/C1) — APPENDED AT THE END, mirroring GOVERNANCE_JOBS'
  // append order (design.md A7). Required at every tier by POSITION (not
  // added to NEVER_TIERED — REQ-TIER-2's six-gate core stays untouched; these
  // two are simply matrix rows whose policy happens to be 'required'
  // everywhere, same shape 'diff-size' already has).
  'lane-paths': Object.freeze({
    lite: Object.freeze({ policy: 'required', evidence: 'lane-path-restriction' }),
    standard: Object.freeze({ policy: 'required', evidence: 'lane-path-restriction' }),
    regulated: Object.freeze({ policy: 'required', evidence: 'lane-path-restriction' }),
  }),
  'lane-scrub': Object.freeze({
    lite: Object.freeze({ policy: 'required', evidence: 'secret-scan' }),
    standard: Object.freeze({ policy: 'required', evidence: 'secret-scan' }),
    regulated: Object.freeze({ policy: 'required', evidence: 'secret-scan' }),
  }),
  // #967 PR C (design.md D9, ruling 1) — REQUIRED at every tier INCLUDING
  // `lite`, a deliberate exception to "lite only detects": `detection` would
  // only have warned about the exact failure this gate exists to prevent
  // (the #953 incident — a slice PR that reached `main` with the wrong base).
  'base-branch': Object.freeze({
    lite: Object.freeze({ policy: 'required', evidence: 'declared-tracker' }),
    standard: Object.freeze({ policy: 'required', evidence: 'declared-tracker' }),
    regulated: Object.freeze({ policy: 'required', evidence: 'declared-tracker' }),
  }),
});

/**
 * §2.C — doctrine parameters (not CI jobs; design.md §2.C verbatim).
 *
 * THREE PARAMETERS LEFT THIS TABLE — the 2026-08-20 ruling on #743.
 *
 * `reviewProtocol`, `inferentialEnabled` and `challengerAxis` used to live
 * here. They answered a question the tier does not ask:
 *
 *   > *"The tiers do not define the review system. The judgment half is an
 *   > on/off capability, and the protocol is always `brain-review/2`."*
 *
 * ADR-0026's invariant 7 already forbade it — position tiering applies to
 * ceremony, never to correctness — and the drift was measured in #743's own
 * audit: a schema version is not ceremony, and a control that FINDS DEFECTS is
 * exactly the correctness invariant 7 excludes. The cost was paid before it was
 * named: `standard` shipped `{inferentialEnabled: true, reviewProtocol: '/1'}`,
 * so the producer was asked for and the protocol gate refused it, and every
 * `standard` verdict carried a condition saying so.
 *
 * Where they went: the protocol is `PRODUCED_PROTOCOL` below (one value, not a
 * default per tier), and the capability is `reviewer.inferential.enabled`, read
 * by `resolveJudgment` in `review/lib/resolve-challenger.mjs`.
 *
 * What the tier still answers is the approval question, and only that: can this
 * team satisfy an approval requirement (#329, the n=1 self-approval case).
 *
 * 
 * @type {Record<'lite'|'standard'|'regulated', {
 *   diffBudget: number,
 *   artefacts: string[],
 *   honorSizeException: boolean,
 *   honorOverride: boolean,
 *   honorSkipMemoryGate: boolean,
 *   memoryAssertion: string,
 * }>}
 */
const TIER_PARAMS = Object.freeze({
  lite: Object.freeze({
    diffBudget: 1000,
    // #94: the platform's `required_approving_review_count`. ZERO at lite is not
    // laxity — `brain-writes-reviewed` already rules that a human author suffices
    // for a brain/core write here (REQ-L6-1'), so arming 1 would impose a
    // `standard` posture on a repo that declares `lite`. It is also unsatisfiable
    // at n=1: GitHub forbids a PR author approving their own PR.
    requiredReviews: 0,
    artefacts: Object.freeze(['spec']),
    honorSizeException: true,
    honorOverride: true,
    // memory-gate is `detection` at lite — skip:memory-gate has nothing to skip.
    honorSkipMemoryGate: false,
    memoryAssertion: 'coverage-report',
  }),
  standard: Object.freeze({
    diffBudget: 400,
    // L6's human approver is `approvers.find(a => a !== author && !botAllowlist
    // .includes(a))` — a non-author human is the point of this tier.
    requiredReviews: 1,
    artefacts: Object.freeze(['proposal', 'spec', 'design', 'tasks']),
    honorSizeException: true,
    honorOverride: true,
    // #1024 (design item D7): load-bearing as of this change —
    // `memory-gate-override.mjs#decideMemoryGateOverride` reads this flag to
    // decide whether `skip:memory-gate` short-circuits REQ-L3-4's scoped
    // check. `brain-metrics.mjs` reports the label raw/honored (design item 7).
    honorSkipMemoryGate: true,
    memoryAssertion: 'issue-linked-record',
  }),
  regulated: Object.freeze({
    diffBudget: 200,
    // ONE, deliberately not two. ADR-0026's "panel >= 2, consensus-gated" row is
    // the REVIEWER VERDICT MODE, not the human approval count; reading it as an
    // approval count would be inventing doctrine (reviewer-protocol.md §5).
    requiredReviews: 1,
    artefacts: Object.freeze(['proposal', 'spec', 'design', 'tasks', 'verification']),
    honorSizeException: false,
    honorOverride: false,
    honorSkipMemoryGate: false,
    memoryAssertion: 'issue-linked-session-summary',
  }),
});

/**
 * Resolves `governance.tier` from a brain.config.json-shaped object.
 * Defaults to `'standard'` when absent (REQ-TIER-10) — but an EXPLICIT,
 * unrecognized value fails closed rather than silently defaulting
 * (REQ-TIER-1): a typo in `governance.tier` must never quietly downgrade a
 * repo's doctrine.
 *
 * @param {{ governance?: { tier?: string } }} [config]
 * @returns {'lite'|'standard'|'regulated'}
 */
export function resolveTier(config) {
  const raw = config?.governance?.tier;
  if (raw === undefined || raw === null) return 'standard';
  if (!TIERS.includes(raw)) {
    throw new Error(
      `governance-tiers: unknown governance.tier "${raw}" — must be one of: ${TIERS.join(', ')}.`
    );
  }
  return raw;
}

/** The two `brain-review` verdict protocol versions. Not tiered — the tier picks a
 *  DEFAULT among them (T2.3 design §3.4: "never forbids the other version at any
 *  tier"). */
export const REVIEW_PROTOCOLS = Object.freeze(['brain-review/1', 'brain-review/2']);

/**
 * The protocol brain PRODUCES — one value, at every tier (#743 ruling,
 * 2026-08-20). `/1` stays in `REVIEW_PROTOCOLS` because the parsers must keep
 * reading it: every verdict already posted on a merged PR is a `/1` block, and
 * `cold-boot.mjs` reads that history to compute `rev` and to hold the anti-loop
 * lock. Retiring it from the READER would rewrite the past to simplify the
 * present.
 *
 * Read: `/1` is legible forever, and nothing emits it by default.
 */
export const PRODUCED_PROTOCOL = 'brain-review/2';

/**
 * Resolves the reviewer protocol: an explicit `reviewer.protocol` wins, otherwise the
 * tier's default (issue #442, the D5 middle path).
 *
 * THE OVERRIDE EXISTS BECAUSE THE TIER CANNOT MOVE. `/2` is `regulated`'s default, and
 * brain cannot declare `regulated`: at that tier `actor-check` requires an approver
 * distinct from the author who authored no commit on the branch, which is structurally
 * unsatisfiable for a solo maintainer — the #329 contradiction ADR-0026 exists to
 * resolve. So the protocol had to become separable from the tier for `/2` to be
 * DOGFOODED rather than only tested. No new doctrine was needed: T2.3 §3.4 already
 * says the tier sets a default and not a ceiling, and this function is the one it
 * names.
 *
 * THE TIER NO LONGER ANSWERS THIS (#743 ruling, 2026-08-20). The default is
 * `PRODUCED_PROTOCOL` at every tier. The paragraphs above are kept as the record
 * of why the seam exists at all — it was built so `/2` could be dogfooded at
 * `lite`, and the ruling generalised that from an override into the only answer.
 *
 * An EXPLICIT `reviewer.protocol: 'brain-review/1'` is still honoured. The
 * ruling retired `/1` as a DEFAULT, and reading it as also forbidding an
 * operator's explicit choice would be inventing doctrine (reviewer-protocol.md
 * §5). What such a repo gets is stated on the wire, not hidden: `resolveJudgment`
 * refuses to run the judgment half at `/1` and says why in `conditions[]`.
 *
 * FAIL-CLOSED ON AN UNKNOWN VALUE, exactly like `resolveTier` above and for the same
 * reason: a typo in `reviewer.protocol` must never silently fall back to a default.
 * Silently downgrading `/2` to `/1` would drop causal admission — the annotation, the
 * base comparison, the refuter fork — while the operator believed they had it, which
 * is the #382/#413 boot-refusal shape.
 *
 * @param {{ reviewer?: { protocol?: string } }} [config]
 * @returns {'brain-review/1'|'brain-review/2'}
 */
export function resolveReviewProtocol(config) {
  const raw = config?.reviewer?.protocol;
  if (raw === undefined || raw === null) return PRODUCED_PROTOCOL;
  if (!REVIEW_PROTOCOLS.includes(raw)) {
    throw new Error(
      `governance-tiers: unknown reviewer.protocol "${raw}" — must be one of: ${REVIEW_PROTOCOLS.join(', ')}.`
    );
  }
  return raw;
}

function requireGateRow(gate) {
  const row = GATE_MATRIX[gate];
  if (!row) {
    throw new Error(
      `governance-tiers: no matrix row for gate "${gate}" — add one to GATE_MATRIX (REQ-TIER-8).`
    );
  }
  return row;
}

function requireCell(gate, tier) {
  const row = requireGateRow(gate);
  const cell = row[tier];
  if (!cell) {
    throw new Error(
      `governance-tiers: gate "${gate}" has no matrix cell for tier "${tier}" — must be one of: ${TIERS.join(', ')}.`
    );
  }
  return cell;
}

/**
 * Resolves a gate's exit policy at a tier — the ratified DOCTRINE value from
 * GATE_MATRIX. See the STAGED ROLLOUT note: this is NOT automatically what
 * `requiredJobs()` enforces today for a `PENDING_PROMOTION` gate.
 *
 * @param {string} gate
 * @param {'lite'|'standard'|'regulated'} tier
 * @returns {'required'|'detection'}
 */
export function resolveGatePolicy(gate, tier) {
  return requireCell(gate, tier).policy;
}

/**
 * Resolves a gate's evidence-form tag at a tier.
 *
 * @param {string} gate
 * @param {'lite'|'standard'|'regulated'} tier
 * @returns {string}
 */
export function resolveGateEvidence(gate, tier) {
  return requireCell(gate, tier).evidence;
}

/**
 * Resolves the doctrine parameters for a tier (§2.C).
 *
 * @param {'lite'|'standard'|'regulated'} tier
 * @returns {{ diffBudget: number, artefacts: string[], honorSizeException: boolean, honorOverride: boolean, honorSkipMemoryGate: boolean, memoryAssertion: string }}
 */
/**
 * The artifact FILENAMES a change dir must carry at `tier` — the single
 * resolution, and the only place the `.md` extension is applied (#555).
 *
 * There were two sets before this. This table honoured ADR-0026 and `phase-order`
 * read it (#358 Q5); a fixed `REQUIRED_ARTIFACTS` lived in `lib/sdd-layout.mjs`,
 * and its two consumers — `local-checks` via `check-refs.mjs` and the reviewer's
 * checkpoint — demanded all four at every tier. They differed in three ways at
 * once: contents, extension (`spec` vs `spec.md`), and fixed-versus-tiered. At
 * `lite`, the tier brain declares for ITSELF, doctrine said `spec` suffices and
 * two gates blocked. The same change passed one gate and failed the other.
 *
 * WHY HERE and not in `sdd-layout.mjs`, where the `.md` convention arguably
 * belongs: that module advertises "Pure ESM, no side effects at import" and a
 * fixture copies it ALONE into a tmp dir. Importing this module from there drags
 * in `brain-config` → `repo.mjs` + `installer.mjs` + `config-migrations.mjs` —
 * four modules into one that promises none. The first attempt at #555 did exactly
 * that and the fixture caught it. The tier table owns the resolution; `sdd-layout`
 * receives the answer.
 *
 * @param {string} tier  `lite` | `standard` | `regulated`.
 * @returns {string[]}   e.g. `['spec.md']` at `lite`.
 */
export function requiredArtifactsFor(tier) {
  return artefactFiles(tierParams(tier).artefacts);
}

export function tierParams(tier) {
  const params = TIER_PARAMS[tier];
  if (!params) {
    throw new Error(`governance-tiers: unknown tier "${tier}" — must be one of: ${TIERS.join(', ')}.`);
  }
  return params;
}

/**
 * The one label that waives the diff-size budget. Exported so no call site
 * retypes the string: a typo in a second literal would read as "no exception
 * asked for", which is the silent half of the defect #1072 names.
 */
export const SIZE_EXCEPTION_LABEL = 'size:exception';

/**
 * sizeExceptionRuling({labels, tier}) -> {present, honored, refusedByTier}
 *
 * THE single reading of `size:exception`, for every authority that has an
 * opinion about the diff budget.
 *
 * #1072, measured on PR #1067: the `diff-size` CI gate passed (`run-check.mjs`
 * read the label, and `lite` carries `honorSizeException: true`) while the
 * cold reviewer emitted a `blocker` on the same 3,101 lines eight seconds
 * later, because `review/evaluators/tranche.mjs` read `tierParams(tier)
 * .diffBudget` and never read the label at all. It took one field of this
 * module's frozen params and ignored its sibling. A budget decision readable
 * two ways from two files is not a policy — it is a contradiction a
 * maintainer cannot act on, because removing the label to satisfy the
 * reviewer fails the gate and keeping it fails the review.
 *
 * The three states are kept APART on purpose, and `refusedByTier` is why:
 * REQ-TIER-6 requires a tier that refuses the waiver to report that the label
 * WAS present and the tier is what refused it, never to behave as though
 * nobody asked. A caller that only checked `honored` would collapse "no
 * exception requested" into "exception refused" and lose the sentence the
 * requirement exists to produce.
 *
 * A label set the caller could not read is not a waiver. Waiving a budget on
 * the strength of a fetch that failed would grant the exception by accident,
 * which is the one direction this must never fail.
 *
 * @param {{labels?: string[]|null, tier: string}} input
 */
export function sizeExceptionRuling({ labels, tier } = {}) {
  const present = Array.isArray(labels) && labels.includes(SIZE_EXCEPTION_LABEL);
  const honored = present && tierParams(tier).honorSizeException === true;
  return { present, honored, refusedByTier: present && !honored };
}


/**
 * Derives the ACTUALLY-ENFORCED required-job set for a tier — replaces the
 * old `REQUIRED_JOBS` constant (design §8, REQ-TIER-9). This is
 * `resolveGatePolicy`'s raw matrix value MINUS `PENDING_PROMOTION` (see the
 * STAGED ROLLOUT note at the top of this file): a gate whose evidence form
 * hasn't landed yet never becomes an actually-required branch-protection
 * context through this function, no matter what the ratified matrix says its
 * target policy is. As of Q5 Phase 5, `PENDING_PROMOTION` is empty — every
 * gate's raw matrix policy is now also its enforced policy.
 *
 * Pre-Phase-5, `requiredJobs('standard')` equalled the pre-tiering
 * `REQUIRED_JOBS` literal exactly, in the same order — REQ-TIER-10's
 * no-op-migration guarantee, which held for the duration of the staged
 * rollout (Phases 1-4). Phase 5's promotions are a deliberate, ratified
 * departure from that guarantee (design §4.1) — `standard` now also requires
 * `phase-order`, `actor-check`, and `brain-writes-reviewed`.
 *
 * @param {'lite'|'standard'|'regulated'} tier
 * @returns {string[]}
 */
export function requiredJobs(tier) {
  return Object.keys(GATE_MATRIX).filter(
    gate => resolveGatePolicy(gate, tier) === 'required' && !PENDING_PROMOTION.includes(gate)
  );
}

// ── CLI printer (bash consumers — REQ-TIER-9: no second budget literal) ──────
//
// Mirrors approved-label.mjs's CLI-printer convention: a thin stdout-printing
// entrypoint so shell scripts (governance.yml, hooks/pre-push) never hardcode
// a tiered parameter themselves. Reads brain.config.json for real ONLY when
// invoked as a CLI (the guard below) — never at import (module stays pure).

function readConfigSafe() {
  try {
    return loadBrainConfig();
  } catch {
    return {};
  }
}

/**
 * Prints the tier-resolved diff-size budget for shell consumption.
 * Injectable `loadConfig` for tests; defaults to the real brain.config.json
 * reader. Propagates resolveTier's fail-closed throw on an unknown tier
 * (never silently prints a stale/default budget).
 *
 * @param {() => object} [loadConfig]
 * @returns {string}
 */
export function printDiffBudget(loadConfig = readConfigSafe) {
  const tier = resolveTier(loadConfig());
  return String(tierParams(tier).diffBudget);
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'diff-budget') {
    console.log(printDiffBudget());
  } else {
    console.error(`governance-tiers.mjs: unknown command "${cmd ?? ''}" (expected: diff-budget)`);
    process.exit(1);
  }
}
