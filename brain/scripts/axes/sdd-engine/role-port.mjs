// role-port.mjs — the role port (issue #312 slice A, design D1-D5, D7): for
// every stage in the resolved SDD stage set, which inhabitant (SDD engine)
// executes it, with what agent role and abstract model tier.
//
// PURE, in `sdd-layout.mjs`'s discipline: `config` is RECEIVED, never read.
// The single I/O act — an engine NAME turned into a module — is the one
// injectable seam, `loadInhabitant`. `resolveRoles` and `resolveModelSelection`
// take everything else as data.
//
// `roles/` and `stage-engine.mjs` are BOTH consumers of `sdd-layout.mjs`.
// Neither imports the other (design D1) — `sdd.map[stage]` is read here by a
// bare, permissive lookup, not through `stage-engine.mjs`'s `resolveStageEngine`.
// Duplicating that function's validation would be a second copy of one
// refusal (#323's, already exercised by `stage-engine.test.mjs`); a bare read
// is enough because the ONLY thing taken from it here is an opaque `model` id
// that is never interpreted, exactly as #323 already rules for every reader.
//
// Two rules keep the import graph a diamond, never a cycle:
//   1. A backend may not import the dispatcher (platform.mjs:35-38, existing).
//   2. An inhabitant may not import this port. `plain.mjs` declares literal
//      values ('human', null, false) and never imports the vocabulary that
//      validates them — the contract is imposed ON the inhabitant by a test,
//      never imported BY it.

import { resolveStageSet } from '../../lib/sdd-layout.mjs';
import { resolveStageConfigs } from '../../lib/stage-config.mjs';
import { harnessAdapterUrl } from '../lib/harness-adapter-url.mjs';

/**
 * The abstract model tiers a role may declare. `null` is a CHECKED value
 * (Compuerta 2) — "a human executes this stage" — never a fourth tier.
 */
export const ROLE_TIERS = Object.freeze(['cheap', 'balanced', 'deep']);

/**
 * A bare, permissive read of `sdd.map[stage]`'s `model` field. NOT a
 * replacement for `stage-engine.mjs`'s `resolveStageEngine` — that function's
 * refusals (an entry with no engine, a non-string model) are #323's, already
 * exercised where sdd.map is actually ROUTED. Here the id is read opaquely,
 * exactly as #323 rules for every reader: brain never interprets it.
 *
 * Callers of this function are expected to skip it entirely for a stage whose
 * role declares `model_tier: null` — see `resolveRoles` below — so that the
 * "no id was read from sdd.map" claim `resolveModelSelection`'s no-agent note
 * makes is literally true, not a value that was fetched and then discarded.
 */
function readRoutedModel(config, stage) {
  const entry = config?.sdd?.map?.[stage];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? { model: entry.model ?? null } : null;
}

/**
 * Resolves model selection for one role, given what (if anything) `sdd.map`
 * routed for its stage. THREE PATHS, and the order below is LOAD-BEARING
 * (design D4): `model_tier === null` is tested FIRST. An inhabitant that also
 * declares `chooses_model: false` (as `plain` does) would otherwise fall
 * through to `brain-fixes` and report a model id from `sdd.map` for a stage
 * nobody will ever run — a provider that will never report gets a distinct,
 * honest note instead of a shared one that misleads for it.
 *
 * @param {{ engine: string, stage: string, role: {model_tier: string|null, chooses_model: boolean}, routed: {model: string|null}|null }} args
 * @returns {{ path: 'no-agent'|'engine-chooses'|'brain-fixes', tier: string|null, model: string|null, note: string }}
 */
export function resolveModelSelection({ engine, stage, role, routed }) {
  if (role.model_tier === null) {
    return {
      path: 'no-agent', tier: null, model: null,
      note: `${engine} declares model_tier: null for stage "${stage}" — a human executes it. ` +
        'No id was read from sdd.map and none was delegated.',
    };
  }
  if (role.chooses_model === true) {
    return {
      path: 'engine-chooses', tier: role.model_tier, model: null,
      note: `${engine} chooses its own model for stage "${stage}"; brain fixed none.`,
    };
  }
  return {
    path: 'brain-fixes', tier: role.model_tier, model: routed?.model ?? null,
    note: `${engine} does not choose its own model; brain fixed sdd.map["${stage}"].model.`,
  };
}

/**
 * Resolves the full role contract for `engine`'s `inhabitant` module, against
 * `config`'s resolved stage set. Seam absence is enforced TWICE — once for
 * the whole inhabitant (no `declareRoles` export at all) and once per stage
 * (a resolved stage the inhabitant did not declare) — and both are THROWS,
 * never a value read as `disabled`. The third scenario (a role's own field
 * fails validation — a concrete `model_tier`, a missing `chooses_model`) is a
 * third, distinct refusal for the same reason: an inhabitant's malformed
 * declaration is a bug in the inhabitant, not a "stage answered nothing".
 *
 * @param {{ config: object, engine: string, inhabitant: {declareRoles?: (stages: string[]) => Record<string, object>} }} args
 * @returns {Record<string, {stage: string, agent: string, model_tier: string|null, chooses_model: boolean, instructions: string|null, state: 'enabled'|'disabled', reason: string|null, selection: object}>}
 */
export function resolveRoles({ config, engine, inhabitant }) {
  if (!inhabitant || typeof inhabitant.declareRoles !== 'function') {
    throw new Error(
      `roles: engine '${engine}' exports no declareRoles — every inhabitant must declare a role for ` +
      'each resolved stage. A missing seam is refused, the same reasoning agent-runtime.mjs applies ' +
      "to a missing AGENT_RUNTIME export: a reader that answers 'nothing' to both 'there is nothing' " +
      "and 'I could not look' reports a silence it never measured.",
    );
  }

  const stages = resolveStageSet(config).stages;
  const configs = resolveStageConfigs(config);
  const declared = inhabitant.declareRoles(stages);

  const result = {};
  for (const stage of stages) {
    const role = declared?.[stage];
    if (!role) {
      throw new Error(
        `roles: engine '${engine}' declares no role for stage "${stage}" — a resolved stage with no ` +
        'declaration is refused, and MUST NOT be read as disabled. Declare it explicitly, even when ' +
        'the declaration is "no agent runs this stage" (model_tier: null, chooses_model: false).',
      );
    }

    if (role.model_tier !== null && !ROLE_TIERS.includes(role.model_tier)) {
      throw new Error(
        `roles: engine '${engine}' declares model_tier ${JSON.stringify(role.model_tier)} for stage ` +
        `"${stage}" — must be one of ${ROLE_TIERS.join(', ')}, or null. A concrete model id is ` +
        'refused: model_tier is an ABSTRACT capability, never a vendor identifier (#323).',
      );
    }
    if (typeof role.chooses_model !== 'boolean') {
      throw new Error(
        `roles: engine '${engine}' declares chooses_model=${JSON.stringify(role.chooses_model)} for ` +
        'stage "' + stage + '" — must be a strict boolean, never absent. A missing capability ' +
        "declaration is refused for the same reason AGENT_RUNTIME may not be '?? null'-ed.",
      );
    }
    // #814 T3: `instructions` — what the role IS, what it may look at, what it
    // must produce. `null` is a CHECKED value ("a human executes; there is no
    // prompt"), mirroring `model_tier: null`. An empty string is refused: "no
    // prompt" already has a spelling, and a prompt with nothing in it is a
    // declaration nobody can act on. Absence is refused like a missing
    // `chooses_model` — an unfilled field must never be readable as a filled one.
    const okInstructions = role.instructions === null ||
      (typeof role.instructions === 'string' && role.instructions.length > 0);
    if (!okInstructions) {
      throw new Error(
        `roles: engine '${engine}' declares instructions=${JSON.stringify(role.instructions)} for ` +
        `stage "${stage}" — must be a non-empty string, or null as the checked no-prompt state. ` +
        'Absence is refused for the same reason a missing chooses_model is.',
      );
    }

    const stageConfig = configs[stage];
    const agent = stageConfig.agent ?? role.agent;
    // See readRoutedModel's own doc comment: skipped entirely when
    // model_tier is null, so the no-agent path's "no id was read" note stays
    // literally true rather than a value fetched and then discarded.
    const routed = role.model_tier === null ? null : readRoutedModel(config, stage);
    const selection = resolveModelSelection({ engine, stage, role, routed });

    result[stage] = {
      stage,
      agent,
      model_tier: role.model_tier,
      chooses_model: role.chooses_model,
      instructions: role.instructions,
      // #814 round 2: an answer the recording cannot vouch for must SAY so on
      // the resolved role too — dropping the mark here laundered a guess into
      // a recording. Strict boolean, always present: the shape is identical
      // across stages, the value tells the truth.
      derived: role.derived === true,
      state: stageConfig.enabled ? 'enabled' : 'disabled',
      reason: stageConfig.enabled ? null : `disabled by sdd.configs["${stage}"].enabled = false`,
      selection,
    };
  }
  return result;
}

async function defaultLoad(engine) {
  return import(harnessAdapterUrl(engine));
}

/**
 * Turns an engine NAME into its inhabitant module. The one I/O act this port
 * performs — `agentRuntimeReport`'s `_loadBackend` seam (`agent-runtime.mjs:325-327,345`),
 * not `cli.mjs`'s dynamic `dispatch`: a backend may not import the dispatcher
 * (`platform.mjs:35-38`), so this port reaches backends the same way
 * `agent-runtime.mjs` does, never through `cli.mjs`.
 *
 * @param {string} engine
 * @param {{ _load?: (engine: string) => Promise<object> }} [opts]
 * @returns {Promise<object>}
 */
export async function loadInhabitant(engine, { _load = defaultLoad } = {}) {
  return _load(engine);
}
