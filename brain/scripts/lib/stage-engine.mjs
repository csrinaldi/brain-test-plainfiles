// stage-engine.mjs — resolves `stage → { engine, model }` from `sdd.map`.
//
// SDD_LIFECYCLE_STAGES is a RE-EXPORT of sdd-layout.mjs's LIFECYCLE_STAGES
// (issue #456 slice A, design D2): this file used to hold its own bare-name
// literal, one of the THREE declarations of the set §1's measurement found.
// The value is byte-identical — same four, same order, same Object.freeze —
// so assertRoutableStage below needs no change, and its tests stay green
// UNMODIFIED (ADR-0019 Amendment 1 condition 4's load-bearing constraint).
//
// This is M8's router (#323) in embryo, and it is deliberately not called the
// reviewer's anything: the cold review is a STAGE, and the question "which
// engine produces this stage's artifact, with which model" is the same question
// for every stage. #682's `cold-review` is its first inhabitant, not a special
// case (ADR-0033).
//
// WHAT THIS DOES NOT DO, and both are rulings rather than omissions:
//
//   - It does not interpret `model`. #323 ruled the field an opaque
//     pass-through: brain never validates it against a catalogue, maps it to a
//     tier, or infers a default from it. Model ids change monthly; a contract
//     should not.
//   - It does not decide whether a stage MAY be routed. That is the doctrine
//     question ADR-0024 predicted (a stage producing one of the four SDD
//     artifacts is M8's problem, and Compuerta 1 is still open on it).
//     `cold-review` produces none of them, which is why ADR-0033 could land
//     without answering it.

import { LIFECYCLE_STAGES, resolveStageSet } from './sdd-layout.mjs';

/** The stage the cold review runs as. Named here so callers stop spelling it. */
export const COLD_REVIEW_STAGE = 'cold-review';

/**
 * The four stages of the SDD artifact lifecycle — the ones ADR-0019 protects.
 *
 * Their artifacts live in a change dir, are walked by `phase-order`'s Rules A
 * and C, and are consolidated by `change:archive`. ADR-0019's FIRST rejected
 * alternative is that routing them per-backend would fork that lifecycle:
 *
 *   > "Expand `VALID_OPS` to route scaffold/verify/archive per-backend.
 *   >  REJECTED: … the SDD artifact lifecycle would fork per harness instead of
 *   >  staying one evidence contract."
 *
 * Re-exported from `sdd-layout.mjs`'s `LIFECYCLE_STAGES` (issue #456 slice A) —
 * the name survives here because callers already import it from this module;
 * the literal does not, because `sdd-layout.mjs` is now THE ONE declaration.
 * `assertRoutableStage` below refuses against this constant, never against a
 * consumer's resolved (config-dependent) set — additive-only guarantees the
 * four are always present here, so the refusal cannot be relaxed by a
 * consumer's `sdd.stages` declaration.
 */
export const SDD_LIFECYCLE_STAGES = LIFECYCLE_STAGES;

/**
 * assertRoutableStage() — ADR-0019's boundary, made executable.
 *
 * ADR-0033 could land without resolving Compuerta 1 (whether M8's router needs a
 * supersede) for one reason: `cold-review` produces none of the four. That is an
 * argument about which stages are routed, and an argument is only as good as the
 * thing that keeps it true. So the code refuses the case the argument excludes,
 * instead of a comment promising nobody will write it.
 *
 * When M8 decides that a lifecycle stage MAY be routed, this function is where
 * that decision lands — visibly, in a diff, with an ADR beside it.
 *
 * @throws {Error} when the stage is one of the four
 */
export function assertRoutableStage(stage, { routed } = {}) {
  // A NON-STAGE IS REFUSED FIRST, and it used to pass (#682, found while
  // measuring judgment:cold-5). This guard is the executable form of ADR-0019's
  // boundary — the comment above `VALID_OPS` says so in as many words — and it
  // only ever compared against the lifecycle list, so `undefined`, `null` and
  // `''` were all "not a lifecycle stage" and sailed through.
  //
  // That is how the argv path got as far as it did: `runStage('cold-review', p)`
  // destructures a STRING, every field lands `undefined`, and the one thing that
  // should have refused an unnamed stage waved it past. What refused it instead
  // was the prompt check, two lines later, reporting `stage "undefined"` — a
  // true message about the wrong problem.
  //
  // "Not a lifecycle stage" and "not a stage at all" are different facts, and a
  // guard that answers the same thing to both reports a check it never made.
  if (typeof stage !== 'string' || stage.trim() === '') {
    throw new Error(
      `stage-engine: ${JSON.stringify(stage)} is not a stage name. Refusing rather than ` +
      'treating it as routable: an unnamed stage is not a stage outside the lifecycle, it is ' +
      'a caller that lost its argument, and passing it here sends an engine to run nothing.'
    );
  }

  // Round 1 of #834's cold review: the evidence is BOUND, never bearer — it
  // names the stage it was computed for, and a mismatch refuses. Reproduced
  // before fixing: evidence for 'tasks' admitted 'design'.
  if (routed && routed.routed === true && routed.stage !== stage) {
    throw new Error(
      `stage-engine: routed evidence was computed for "${routed.stage}" and handed to "${stage}" — ` +
      'the check proves the four conditions FOR ONE stage, and its result admits only that one.'
    );
  }
  if (SDD_LIFECYCLE_STAGES.includes(stage) && !(routed && routed.routed === true)) {
    // #323 S2 — ADR-0019 Amendment 1, condition 4: "the refusal is REPLACED,
    // not removed". The flat lifecycle throw that held conditions 1-3 true
    // becomes a demand for EVIDENCE: the caller must hand in the result of
    // `assertRoutedStage`, the check that enforces those conditions against
    // the port. A lifecycle spawn that skipped the check still throws.
    throw new Error(
      `stage-engine: "${stage}" is an SDD lifecycle stage and may not be spawned without routed ` +
      'evidence — call assertRoutedStage({config, stage}) first and pass its result as { routed }. ' +
      "ADR-0019 Amendment 1 permits routing the lifecycle ONLY under its four conditions, and the " +
      'check is where they are enforced (condition 4: a check, not a comment).'
    );
  }
}

/**
 * resolveStageEngine() — PURE.
 *
 * @param {{sdd?: {map?: Record<string, {engine?: string, model?: string}>}}} config
 * @param {string} stage
 * @returns {{engine: string, model: string|null}|null} `null` when unrouted
 * @throws {Error} when the entry exists and cannot be read
 */
export function resolveStageEngine(config, stage) {
  if (typeof stage !== 'string' || stage === '') {
    throw new Error('stage-engine: a stage name is required.');
  }

  const map = config?.sdd?.map;
  if (map === undefined || map === null) return null;
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('stage-engine: sdd.map must be an object of stage → { engine, model }.');
  }

  const entry = map[stage];
  // UNROUTED IS NOT AN ERROR. A repo that has not routed a stage has not
  // misconfigured anything, and the caller renders that as "no transport" rather
  // than as a refusal — the distinction slice A already holds one layer down.
  if (entry === undefined || entry === null) return null;

  if (typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(
      `stage-engine: sdd.map["${stage}"] must be an object with an "engine" — got ${Array.isArray(entry) ? 'an array' : typeof entry}.`
    );
  }

  // FAIL CLOSED ON A ROUTED-BUT-UNREADABLE ENTRY. An operator who wrote the key
  // asked for something; giving them silence instead would be the shape #382/#413
  // refuse at boot. `{}` is not "no opinion" once the key exists.
  if (typeof entry.engine !== 'string' || entry.engine.trim() === '') {
    throw new Error(
      `stage-engine: sdd.map["${stage}"] names no engine. Routing a stage to nothing is not a route — ` +
      'remove the entry to leave the stage unrouted.'
    );
  }

  // #323 S2 (D3): an entry for an UNDECLARED stage is an error, never a silent
  // route — the resolved set is the lifecycle plus whatever sdd.stages declares
  // (#456-A), and a stage outside both is a typo or a plan nobody recorded.
  // "Declared" is the resolved set PLUS the stages code itself ships:
  // COLD_REVIEW_STAGE is declared by ADR-0033 in this very module, and the
  // field's live config routes it without an sdd.stages entry — a rule that
  // refused the shipped stage would break the review pipeline it serves.
  const declared = [...resolveStageSet(config).stages, COLD_REVIEW_STAGE];
  if (!declared.includes(stage)) {
    throw new Error(
      `stage-engine: sdd.map["${stage}"] routes a stage that is neither an SDD lifecycle stage nor ` +
      `declared in sdd.stages (resolved set: ${declared.join(', ')}). Declare it or remove the entry.`
    );
  }

  // #323 S2 (condition 1 pin): the value carries {engine, model} and NOTHING
  // path-shaped — an engine normalises INTO the layout; no map entry may smuggle
  // a root, a layout, or a slash toward one.
  const extraKeys = Object.keys(entry).filter((k) => k !== 'engine' && k !== 'model');
  if (extraKeys.length > 0) {
    throw new Error(
      `stage-engine: sdd.map["${stage}"] carries ${extraKeys.join(', ')} — a value holds {engine, model} ` +
      'and nothing else (ADR-0019 Amendment 1, condition 1: one layout, no engine may reshape it).'
    );
  }
  // The slash rule applies to the ENGINE only. The model is OPAQUE by signed
  // ruling (05/08, pinned by test: 'vendor/model:2026-08' passes unchanged) —
  // refusing a slash there would be interpreting the id, the exact thing every
  // reader is forbidden to do. The first cut of this pin covered both and the
  // older ruling's test caught the overreach.
  if (entry.engine.includes('/')) {
    throw new Error(
      `stage-engine: sdd.map["${stage}"] carries a path-shaped engine — refused under condition 1: ` +
      'an engine name is an identifier, never a location.'
    );
  }
  if (entry.model !== undefined && entry.model !== null && typeof entry.model !== 'string') {
    throw new Error(
      `stage-engine: sdd.map["${stage}"].model must be a string id or absent — brain passes it ` +
      'through opaquely and never interprets it (#323).'
    );
  }

  return { engine: entry.engine, model: entry.model ?? null };
}

/**
 * assertRoutedStage() — issue #323 S2: THE CHECK ADR-0019 Amendment 1's
 * condition 4 demanded. Async because the enforcement surface is M5's port —
 * `loadInhabitant` + `resolveRoles`, the same two calls every consumer makes;
 * no second registry, no parallel list.
 *
 * The stage-class split is OPTION A (maintainer, 02/09/2026), stated here and
 * in the refusal below rather than implied: a LIFECYCLE stage routes only to
 * an SDD_ENGINES member that declares it, enabled; a CUSTOM stage may name a
 * transport (ADR-0033's word) — the one-vocabulary debt is #833's, filed the
 * same day the split was ruled.
 *
 * @param {{config: object, stage: string, _load?: (engine: string) => Promise<object>}} args
 * @returns {Promise<{routed: false} | {routed: true, routing: {engine: string, model: string|null}, role?: object}>}
 */
export async function assertRoutedStage({ config, stage, _load } = {}) {
  const routing = resolveStageEngine(config, stage);
  if (routing === null) return { routed: false, stage };

  if (!SDD_LIFECYCLE_STAGES.includes(stage)) {
    // A custom stage: transport naming allowed (option A). The routing is the
    // whole answer — there is no declaration to demand from a transport.
    return { routed: true, stage, routing };
  }

  const { SDD_ENGINES } = await import('../harness/platform.mjs');
  if (!SDD_ENGINES.includes(routing.engine)) {
    throw new Error(
      `stage-engine: sdd.map["${stage}"] routes a lifecycle stage to "${routing.engine}", which is ` +
      `not an SDD_ENGINE framework (${SDD_ENGINES.join(', ')}). Platforms EXECUTE; engines DECLARE ` +
      '(the D6 vocabulary) — a lifecycle stage routes only to an engine whose declaration the port ' +
      'can interrogate. Custom stages may name a transport; one vocabulary for both is #833.'
    );
  }

  const { loadInhabitant, resolveRoles } = await import('../axes/sdd-engine/role-port.mjs');
  const inhabitant = await loadInhabitant(routing.engine, _load ? { _load } : {});
  // The port's own refusals travel untouched: no declareRoles, an unanswered
  // stage, a malformed declaration — each is the port's sentence, not ours.
  const roles = resolveRoles({ config, engine: routing.engine, inhabitant });
  const role = roles[stage];
  if (role.state === 'disabled') {
    throw new Error(
      `stage-engine: sdd.map["${stage}"] routes to ${routing.engine}, but the stage is disabled ` +
      `(${role.reason}). Routing a disabled stage would spawn an engine its own config told to stand down.`
    );
  }
  // `role` is condition 3's HOOK: what was routed, exposed, so S4's parity
  // suite can compare two engines' answers for one stage. The proof is S4's.
  return { routed: true, stage, routing, role };
}
