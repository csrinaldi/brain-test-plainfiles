// inferential.mjs — the judgment half of the review (issue #682, slice 2).
// Read-only, additive, and INERT until a transport exists.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS SLICE SHIPS, AND WHAT IT DELIBERATELY DOES NOT.
//
// A producer of REASONED findings needs something to reason with, and brain has
// no outbound model machinery at all — measured on `main` @ `46fb991`, the only
// network call in the tree is `gitlabApiFetch` and the reviewer shells out to
// `git`. That transport is slice 3, behind its own ADR, because it is where
// #682's network, credential and determinism costs actually land.
//
// So this file ships the SHAPE: the evaluator triple, the additive wiring, the
// declaration, and the boundary constraint that keeps `same-model` from being
// self-attestation. With no generator it produces nothing and DOES NOT RUN.
//
// AND THAT IS NOT #552's DEFECT, which is the objection this file has to answer
// out loud. #552's defect was that "no runner" and "runner said nothing"
// rendered BYTE-IDENTICALLY. Here the two states are already distinguished on
// the wire, and they were distinguished before this file existed: `controls.mjs`
// derives the declaration from the evaluators that RAN, and #690's complement
// names the classes that did not. A review with no producer says `inferential`
// did not run. A review with one says it did. A reader can tell.
//
// The ordering is the guarantee, not a coincidence: #683 and #690 landed in
// phase 3 precisely so phase 5 could add a producer without re-creating the
// fold. Never wire this evaluator to run while returning nothing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one class this evaluator can establish. `controls.mjs` unions PRODUCES
 * over the evaluators that ran, so declaring `inferential` here is the whole of
 * REQ-682-3 — `controls.mjs`'s own header promises it: *"a judgment evaluator
 * declares `inferential`, and the day it runs the verdict says so by itself."*
 *
 * Declared beside the code it describes, like every other evaluator: this is
 * the file that would change if the answer changed.
 */
export const PRODUCES = Object.freeze(['inferential']);

// The default round count is IMPORTED, not restated. A second literal `1` here
// would be the same defect REQ-682-5 is about, in miniature: one bound written
// down twice, free to drift.
import { ROUNDS_IN_FORCE_TODAY } from '../lib/convergence.mjs';

/**
 * REQ-682-4 — the fields a reasoned finding may carry to the challenger.
 *
 * The challenger receives findings and never the producer's reasoning. That
 * boundary is only real if the finding object does not smuggle the reasoning
 * through its own fields, so the allowed set is ENUMERATED rather than left to
 * whatever a generator happens to return.
 *
 * `evidence` is the claim's support as a reader of the verdict sees it — not a
 * chain of thought. Anything a generator adds outside this set is dropped by
 * `sanitiseFinding` below, which is what makes REQ-682-4 testable instead of
 * aspirational.
 *
 * `title` WAS in this list and the cold review removed it: `renderVerdict`
 * emits it nowhere (zero hits across verdict.mjs, parse-verdict.mjs and
 * schema-v2.mjs), so it crossed to the challenger invisibly — and it is exactly
 * the free-text field an LLM producer fills with its own framing of the claim,
 * i.e. the reasoning channel this enumeration exists to close.
 *
 * THE MEMBERSHIP TEST IS NOT THIS LIST. A test asserting `CARRIED_FIELDS
 * .includes(k)` compares the list to itself and cannot fail for any member,
 * however un-rendered — that was the first cut's assertion and it is why `title`
 * survived. The test now renders a verdict and asserts against ITS keys.
 */
export const CARRIED_FIELDS = Object.freeze([
  'id', 'severity', 'evidence_class', 'evidence', 'cites', 'file', 'line',
]);

/**
 * The oracle for REQ-682-4, and it is NOT this list.
 *
 * A test asserting membership in `CARRIED_FIELDS` compares the list to itself
 * and cannot fail for any member, however un-rendered — which is exactly how
 * `title` survived here while `renderVerdict` emitted it nowhere. Adding
 * `deliberation_notes` to the list left the whole suite green while the boundary
 * went live.
 *
 * So the property is stated where it can be checked: every carried field must
 * appear in a rendered verdict. `file`/`line` render only through
 * `hasUsableAnchor`, so they are listed as ANCHOR fields — carried, and rendered
 * only as a pair with a usable line.
 */
export const RENDERED_ALWAYS = Object.freeze(['id', 'severity', 'evidence_class', 'evidence', 'cites']);
export const RENDERED_AS_ANCHOR = Object.freeze(['file', 'line']);

/**
 * sanitiseFinding() — PURE. Projects a generated finding onto `CARRIED_FIELDS`.
 *
 * The drop is silent on purpose and it is the safe direction: a field the
 * verdict would not render must not reach the challenger, and a generator that
 * grows a new field does not get to widen the boundary by existing. When a
 * field genuinely belongs on the wire, it is added HERE and to the renderer,
 * together — which is the review this file wants to force.
 *
 * @param {object} finding
 * @returns {object} a new object carrying only the enumerated fields present
 */
export function sanitiseFinding(finding = {}) {
  const out = {};
  for (const k of CARRIED_FIELDS) {
    if (finding[k] !== undefined) out[k] = finding[k];
  }
  return out;
}

/**
 * evaluateInferential() — PURE over an already-gathered generator result.
 *
 * Shape matches the other three evaluators (`{conclusion, gates, findings,
 * conditions, escalate}`) so `cli.mjs` merges it without a special case.
 *
 * Every emitted finding is forced to `evidence_class: 'inferential'`. A judgment
 * evaluator claiming `deterministic` would put a reasoned claim on the
 * deterministic side of #575 Ruling 3 and skip the refuter entirely — the one
 * mislabelling that would make the whole challenger unreachable.
 *
 * @param {{ generated?: Array<object>|null }} input
 * @returns {{conclusion: string|null, gates: {required: string[], detection: string[]}, findings: object[], conditions: string[], escalate: null}}
 */
/**
 * The evidence class `evaluateInferential` FORCES on every finding it emits.
 *
 * Exported so `assemble-review-prompt.mjs` can name it instead of spelling it —
 * judgment:cold-4 of the third cold review. The prompt used to interpolate the
 * whole `ALLOWED_EVIDENCE_CLASSES` menu while this evaluator overwrote the field
 * unconditionally, so the engine was offered a choice that was discarded. Now
 * the prompt states the one value, and it reads it from HERE: the place that
 * decides it. A literal in the prompt would be a second declaration with nothing
 * comparing the two — which is the defect the prompt's own header forbids.
 */
export const FORCED_EVIDENCE_CLASS = 'inferential';

export const ID_PREFIX = 'judgment:';

/**
 * findingKey() — a finding's identity for convergence, by CONTENT.
 *
 * TOTAL BY CONSTRUCTION, because its input is a model's output. `canonicalJson`
 * in `memory/lib/format.mjs` does the same job and THROWS on a value it does
 * not support; used here that would turn a duplicate check into a crash on a
 * finding carrying an unexpected type. Key ordering is normalised recursively
 * so `{a,b}` and `{b,a}` are one finding rather than two, and the whole thing
 * is guarded: no input can make deduplication the thing that fails the review.
 *
 * `null` MEANS "NO KEY", NOT "SOME KEY" — and the difference cost a blocker.
 *
 * This used to return `String(f)` on an unserialisable value, with a comment
 * calling the result "the conservative direction". It is the least conservative
 * outcome available. MEASURED on the shipped code: two DIFFERENT circular
 * findings both key to `"[object Object]"`, so the second reads as a duplicate
 * and is dropped — two blockers in, one blocker out, `failed: false`, no
 * condition, no count and no log line.
 *
 * That is D.3's `judgment:cold-2` returning one layer down INSIDE ITS OWN FIX.
 * The id-keyed version dropped a second finding because a producer reused an
 * id; this dropped one because a producer emitted a value JSON does not
 * describe. Same deletion, same silence, different cause.
 *
 * And it is the exact failure this function's own docstring forbids: "no input
 * can make deduplication the thing that fails the review" — deduplication was
 * instead made the thing that DELETES a finding, which is strictly worse than
 * failing, because failing is visible.
 *
 * So an uncomputable key is reported as ABSENT and the caller decides. The
 * policy — an unkeyable finding is always FRESH — belongs at the dedupe site,
 * not smuggled into a fallback value that looks like a real key. The cost is
 * that genuinely-duplicate unkeyable findings accumulate across rounds, bounded
 * by `maxRounds`; a duplicate blocker reaching a human beats a real one that
 * does not.
 *
 * Whether a model can emit such a value through the shipped artifact reader is
 * a separate question — parsed JSON carries no cycles and no BigInt, so today
 * it cannot. That is not why this is written this way. This function exists
 * precisely for input nobody predicted, and a guard whose failure mode is
 * "silently delete a blocker" is worse than no guard at all.
 *
 * @param {unknown} f
 * @returns {string|null} the content key, or `null` when none can be computed
 */
export function findingKey(f) {
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? String(v);
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`;
  };
  try {
    return walk(f);
  } catch {
    return null;
  }
}

/**
 * uniqueId() — #682 round-1 review. Namespacing was cross-class only.
 *
 * `evaluateRefuter` keys outcomes by id ALONE and applies each to EVERY finding
 * carrying it. The prefix stops a produced finding from addressing a
 * deterministic one, and that half holds — no deterministic id can begin
 * `judgment:`. It does nothing WITHIN the produced set: a generator emitting two
 * findings under `J1`, or two with no `id` at all, produced `judgment:J1` twice
 * and `judgment:undefined` twice. Refuting one then downgraded BOTH, and stamped
 * the second with a rationale written about the first — a genuinely-true blocker
 * dropped on the strength of a challenge to a different claim.
 *
 * A missing id gets an ordinal rather than the string "undefined": `undefined`
 * is not a name, and two of them are not the same finding.
 *
 * @param {unknown} raw     the generator's id, possibly absent or repeated
 * @param {Set<string>} seen ids already issued in this batch
 * @returns {string}
 */
export function uniqueId(raw, seen) {
  const stem = (raw === undefined || raw === null || raw === '')
    ? `unnamed-${seen.size + 1}`
    : String(raw);
  let id = `${ID_PREFIX}${stem}`;
  let n = 2;
  while (seen.has(id)) id = `${ID_PREFIX}${stem}#${n++}`;
  seen.add(id);
  return id;
}

export function evaluateInferential({ generated = null } = {}) {
  const seen = new Set();
  const findings = (generated ?? []).map(f => ({
    ...sanitiseFinding(f),
    // #682 cold review B4 — the producer is the first thing in brain that lets a
    // NON-DETERMINISTIC source choose finding ids, and `evaluateRefuter` keys
    // outcomes by id alone and applies them to EVERY finding carrying it. A
    // producer emitting `gate:phase-order` (which an LLM asked to review a PR
    // reaches for unprompted) meant that refuting the REASONED claim flipped the
    // genuinely-failing required gate to `severity: 'correction'`. Fail-open, on
    // a real gate, from a claim nothing verified.
    //
    // Namespaced here rather than validated: a collision check would have to
    // know every id every evaluator can emit, and that list grows. A reserved
    // prefix cannot collide by construction.
    id: uniqueId(f.id, seen),
    evidence_class: FORCED_EVIDENCE_CLASS,
  }));

  return {
    conclusion: null,
    gates: { required: [], detection: [] },
    findings,
    conditions: [],
    // NEVER escalates on its own. Escalation for a reasoned finding is the
    // CHALLENGER's decision (`resolve-challenger.mjs`, REQ-682-6) — a producer
    // that escalated its own claims would be judging them, which is the
    // self-attestation ADR-0031 refuses.
    escalate: null,
  };
}

/**
 * gatherInferentialInputs() — the DI seam, matching the other evaluators.
 *
 * `deps.generate` is the transport. There is no production default and this
 * file will not invent one: slice 3's ADR decides whether it is an SDK call, a
 * spawned agent, or the harness, and that decision changes the reviewer's
 * network, credential and determinism surface.
 *
 * Returns `{ generated: null }` when no generator is supplied — and the CALLER
 * must then not run this evaluator at all, rather than run it and declare
 * `inferential` over an empty list. `shouldRun()` below is that decision, kept
 * next to this one so the two cannot drift.
 *
 * It passes COORDINATES, not a diff string: `worktreePath` + `baseSha` +
 * `headSha` + `changedFiles`. `cli.mjs` computes the changed-file list but never
 * materialises the diff text, so accepting a `diff` parameter here would mean
 * handing the generator an empty string while pretending it had the diff —
 * `evidence-reader-empty-on-failure` at the seam this whole ticket is about. The
 * generator reads the diff itself, from the cold worktree the reviewer already
 * cloned (protocol §8).
 *
 * `maxRounds` is REQ-682-5's bound, and it bounds THIS loop — the produce rounds
 * inside one run. It is not §7's `rev >= 3`, which counts posted revisions on the
 * PR and lives in `verdict.mjs`; see `convergence.mjs` for why the two must not be
 * one number read twice. The default is 1, which is what ran before the key
 * existed, so an unset key changes nothing.
 *
 * ROUNDS STOP EARLY WHEN ONE PRODUCES NOTHING NEW. A generator that repeats itself
 * has converged, and re-asking it is spending a model call to receive the same
 * answer. With today's file transport that happens on round 2 by construction: the
 * artifact is a static file, so every round after the first is entirely duplicates.
 *
 * @param {{ worktreePath?: string|null, baseSha?: string|null, headSha?: string|null,
 *           changedFiles?: string[], prBody?: string, maxRounds?: number,
 *           deps?: {generate?: Function} }} args
 * @returns {Promise<{generated: Array<object>|null, failed: boolean, reason?: string, rounds?: number}>}
 */
export async function gatherInferentialInputs({
  worktreePath = null, baseSha = null, headSha = null,
  changedFiles = [], prBody = '', maxRounds = ROUNDS_IN_FORCE_TODAY, deps = {},
} = {}) {
  if (typeof deps.generate !== 'function') return { generated: null, failed: false };

  // #682 acceptance criterion 6, and the cold review caught it pre-broken HERE.
  // The first cut coerced with `Array.isArray(generated) ? generated : []`, so a
  // transport that swallowed its own error and returned `undefined` produced an
  // empty finding list — and the verdict then declared the judgment control
  // APPLIED with nothing found. "The model was unreachable" folded into "it
  // found nothing", in the file whose header rails against exactly that.
  //
  // A throw and a non-array are both FAILURES, reported as such. The caller
  // fails closed on them rather than rendering a green judgment half.
  const collected = [];
  const seen = new Set();
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;

    let produced;
    try {
      produced = await deps.generate({ worktreePath, baseSha, headSha, changedFiles, prBody, round });
    } catch (err) {
      // A FAILURE IN ANY ROUND FAILS THE WHOLE GATHER, and the earlier rounds'
      // findings go with it. Keeping them would hand the verdict a PARTIAL list
      // it would render as complete — "the model became unreachable after round
      // 1" presented as "this is what the reviewer found", which is the same
      // fold as the coercion below, one loop iteration further in.
      return { generated: null, failed: true, reason: `the generator threw on round ${round} of ${maxRounds}: ${err.message}` };
    }
    if (!Array.isArray(produced)) {
      return {
        generated: null, failed: true,
        reason: `the generator returned ${produced === undefined ? 'undefined' : typeof produced} on round ${round} of ${maxRounds}, not an array of findings`,
      };
    }

    // Deduplicated by the finding's CONTENT, never by its label alone. A round
    // that repeats itself has converged, and the repeat is not a second
    // sighting of anything — but two findings are "the same" only when they SAY
    // the same thing.
    //
    // THE FIRST CUT KEYED ON `f?.id`, AND IT WAS FAIL-OPEN. #682's own cold
    // review measured it: a generator emitting two distinct blockers under one
    // id — first claim, second claim — returned 2 findings at the base commit
    // and 1 here. The second BLOCKER left the verdict with no condition, no
    // count and no log line, on the DEFAULT bound of one round, so the loop was
    // not even involved. `uniqueId`'s own docstring names "a generator emitting
    // two findings under `J1`" as real producer behaviour and exists to
    // disambiguate it with `#2`; keying on the id dropped the finding before
    // `evaluateInferential` could. A convergence check silently became a filter
    // that trusts a non-deterministic producer to label its claims uniquely.
    const fresh = produced.filter((f) => {
      const key = findingKey(f);
      // NO KEY → ALWAYS FRESH. `null` is "this finding has no computable
      // identity", which is not the same as "it is identical to the last one
      // that also had none". Deduplicating on a shared placeholder deleted a
      // second blocker in silence; keeping it lets `evaluateInferential` and a
      // human decide, which is what an unreadable value deserves.
      if (key === null) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    collected.push(...fresh);

    if (fresh.length === 0) break;
  }

  return { generated: collected, failed: false, rounds };
}

/**
 * shouldRun() — whether the judgment half runs at all on this review.
 *
 * TWO conditions, both required, and the second is the one that keeps this
 * honest: the tier/config must enable the producer, AND a generator must exist.
 * An enabled producer with no transport does not run, does not declare
 * `inferential`, and therefore cannot make the verdict claim a control it never
 * applied.
 *
 * @param {{ enabled?: boolean, generate?: unknown }} args
 * @returns {boolean}
 */
export function shouldRun({ enabled = false, generate = null } = {}) {
  return Boolean(enabled) && typeof generate === 'function';
}
