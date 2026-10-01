// engines-report.mjs — issue #824 (PR3 of #814's ruled chain): the pure half
// of `brain:engines`, the discovery verb. Interrogates each SDD_ENGINE
// FRAMEWORK (D6 vocabulary — gentle-ai, plain, a future brain-sdd-engine;
// never an AGENT_PLATFORM agent) through the same two calls every consumer of
// the port makes: `loadInhabitant` → `resolveRoles`.
//
// A refusing engine is a ROW, not a crash: the port throws by design (a
// missing seam must never read as "nothing to run"), and this verb's job is
// to REPORT that state beside the healthy ones — one broken framework must
// not silence the survey.
//
// `--record` writes through `config-verb.mjs`'s planner — Compuerta 4's ONE
// validator, at its second caller (the first is `brain:config` itself). While
// the shipped migrations do not declare `sdd.engines`, the planner refuses
// and this module forwards the refusal untouched: a path becomes settable in
// the migration that declares it. That is the gate working, not a bug.

import { resolveRoles, loadInhabitant } from '../axes/sdd-engine/role-port.mjs';
import { resolveStageSet } from '../lib/sdd-layout.mjs';
import { planConfigWrite } from '../config/config-verb.mjs';

/**
 * One row per engine, always — ok:true with resolved roles, or ok:false with
 * the refusal (the port's own words, or the loader's).
 *
 * @param {{config: object, engines: string[], _load?: (engine: string) => Promise<object>}} args
 * @returns {Promise<Array<{engine: string, ok: boolean, roles?: object, refusal?: string}>>}
 */
export async function buildEnginesReport({ config, engines, _load }) {
  const rows = [];
  for (const engine of engines) {
    try {
      const inhabitant = await loadInhabitant(engine, _load ? { _load } : {});
      const roles = resolveRoles({ config, engine, inhabitant });
      rows.push({ engine, ok: true, roles });
    } catch (err) {
      rows.push({ engine, ok: false, refusal: err?.message ?? String(err) });
    }
  }
  return rows;
}

/**
 * The `--record` planner. Refuses a row that refused — a recording VOUCHES,
 * and there is nothing to vouch for in a failed interrogation — then hands
 * the write to `planConfigWrite`, whose known-paths rule decides whether
 * `sdd.engines` is declared at all.
 *
 * @param {{config: object, row: {engine: string, ok: boolean, roles?: object, refusal?: string},
 *          migrations: Array<object>, targetVersion: string, _now?: () => string}} args
 * @returns {{next: object|null, refusal: string|null}}
 */
export function planEngineRecord({ config, row, migrations, targetVersion, _now = () => new Date().toISOString() }) {
  if (row.ok !== true) {
    return {
      next: null,
      refusal: `engines: refusing to record '${row.engine}' — its interrogation refused (${row.refusal}). ` +
        'A recording vouches for a declaration; a failed one has nothing to vouch for.',
    };
  }
  const value = JSON.stringify({ recordedAt: _now(), stages: Object.keys(row.roles) });
  const planned = planConfigWrite({ config, path: `sdd.engines.${row.engine}`, value, migrations, targetVersion });
  return { next: planned.next, refusal: planned.refusal };
}

/** Resolves the stage set once for the CLI — re-exported so it stays one read. */
export { resolveStageSet };
