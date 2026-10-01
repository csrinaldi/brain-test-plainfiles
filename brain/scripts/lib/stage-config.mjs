// stage-config.mjs — resolves `sdd.configs` (issue #312, D3): per-stage
// configuration general to all stages — today `agent` and `enabled` — keyed
// by the SAME resolved stage set `resolveStageSet` produces. This sits beside
// `stage-engine.mjs` because `sdd.map` and `sdd.configs` are the same kind of
// object (a per-stage lookup keyed by the resolved set) — splitting them
// across directories would split one concept into two places to keep in sync.
//
// PURE, in `sdd-layout.mjs`'s discipline: `config` is RECEIVED, never read.
// The edge that loads `brain.config.json` is responsible for reading it; this
// module only resolves what it is given.
//
// Absent `sdd.configs`, and `sdd.configs: {}`, resolve IDENTICALLY — the same
// absent-or-empty rule `resolveStageSet` states at `sdd-layout.mjs:100-105`.
// That is zero-config identity at its own boundary: a repo that has never
// heard of `sdd.configs` gets exactly the same per-stage shape as one that
// wrote `"configs": {}` on purpose.

import { resolveStageSet } from './sdd-layout.mjs';

/** The only fields a `sdd.configs[stage]` entry may declare. Growing this list
 * is additive; an unrecognized field is refused rather than silently ignored
 * (refusal 2 below) — `sdd.configs` is where per-stage config will grow, and
 * an ignored unknown field is config an operator wrote that brain silently
 * did not apply. */
const KNOWN_FIELDS = Object.freeze(['agent', 'enabled']);

/**
 * Resolves `config.sdd.configs` against `resolveStageSet(config).stages` —
 * never a fixed list of its own. Every resolved stage is present in the
 * returned map, defaulted (`enabled: true`, no `agent`) when the consumer
 * declared nothing for it.
 *
 * Three refusals, each naming what it refuses rather than guessing a shape:
 *
 *   1. An entry for a stage NOT in the resolved set — the mirror, inverted, of
 *      `resolveStageSet`'s omits-a-lifecycle-stage refusal: both are
 *      set-membership refusals against the resolved set that name the
 *      offending name(s). A misspelled stage the operator believes they
 *      configured must not be silently dropped.
 *   2. An UNKNOWN FIELD inside an entry — an ignored unknown field is config
 *      the operator wrote that brain silently did not apply
 *      (`resolveStageEngine`'s "`{}` is not 'no opinion' once the key
 *      exists", `stage-engine.mjs:132-140`).
 *   3. `enabled` written as anything but a STRICT boolean — coercion is the
 *      dangerous branch here, not the strict one: `"false"` is a truthy
 *      string, and an operator who typed it meaning "off" would silently get
 *      a stage that keeps running.
 *
 * `resolveStageSet`'s THIRD refusal (relative order) has no mirror here and
 * gets none: `sdd.configs` is a lookup keyed by stage, not a sequence, so
 * there is no order to violate. Not adding one is deliberate, not an
 * oversight — see design.md D3.
 *
 * @param {{sdd?: {stages?: object, configs?: Record<string, {agent?: string, enabled?: boolean}>}}} [config]
 * @returns {Record<string, {agent?: string, enabled: boolean}>}
 * @throws when a declared entry names a stage outside the resolved set, an
 *   unknown field, or a non-boolean `enabled`.
 */
export function resolveStageConfigs(config) {
  const stages = resolveStageSet(config).stages;
  const declared = config?.sdd?.configs;
  const entries = declared && typeof declared === 'object' ? declared : {};

  for (const name of Object.keys(entries)) {
    if (!stages.includes(name)) {
      throw new Error(
        `stage-config: sdd.configs["${name}"] — "${name}" is not in the resolved stage set ` +
        `(${stages.join(', ')}). A misspelled or removed stage must not be silently ignored — ` +
        'declare it in sdd.stages first, or fix the name here.',
      );
    }
  }

  const result = {};
  for (const stage of stages) {
    const entry = entries[stage] ?? {};

    for (const field of Object.keys(entry)) {
      if (!KNOWN_FIELDS.includes(field)) {
        throw new Error(
          `stage-config: sdd.configs["${stage}"] has unknown field "${field}" — known fields: ` +
          `${KNOWN_FIELDS.join(', ')}. sdd.configs is where per-stage config grows; an ignored ` +
          'unknown field would be config the operator wrote that brain silently did not apply.',
        );
      }
    }

    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
      throw new Error(
        `stage-config: sdd.configs["${stage}"].enabled must be a strict boolean — got ` +
        `${typeof entry.enabled} (${JSON.stringify(entry.enabled)}). A coercing field has a value ` +
        'whose meaning inverts silently: "false" is a truthy string, and an operator who typed it ' +
        'meaning "off" would get a stage that runs.',
      );
    }

    result[stage] = entry.agent !== undefined
      ? { agent: entry.agent, enabled: entry.enabled ?? true }
      : { enabled: entry.enabled ?? true };
  }
  return result;
}
