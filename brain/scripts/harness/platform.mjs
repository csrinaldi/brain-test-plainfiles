// brain/scripts/harness/platform.mjs — the platform axis, as a LEAF.
//
// WHY THIS FILE EXISTS: it breaks an ESM cycle that deadlocked the shipped
// bootstrap path (#682 slice 3, judgment:cold-1 of the cold review on `2149cd1`).
//
// The cycle was one edge long, and every hop in it was reasonable on its own:
//
//   harness/cli.mjs            top-level `await dispatch(platform, op, …)`
//     → dynamic import         axes/platform/adapters/claude.mjs        (chosen by the platform)
//       → static import        axes/lib/agent-runtime.mjs (for `defaultRun`)
//         → static import      harness/cli.mjs            (for `resolvePlatform`)
//
// The last hop re-enters a module that is STILL EVALUATING — it is suspended at
// its own top-level await — so the graph never settles. Node reports
// `Detected unsettled top-level await` and exits 13.
//
// MEASURED, on one tree, one environment variable apart:
//
//   node harness/cli.mjs init                        → exit 0
//   AGENT_PLATFORM=claude node harness/cli.mjs init  → exit 13, nothing written
//
// The first resolved to `antigravity` (the default until #1125), whose backend
// closes no cycle, so the defect is invisible unless the platform is the one
// that does. Since #1125 the unset path resolves `claude`, so the plain
// `node harness/cli.mjs init` now walks exactly the edge this file cut. `bootstrap.sh`
// runs exactly this command, so a consumer configuring `claude` — which is every
// repo that would route this slice's stage — got no `.claude/settings.json`.
//
// A STATIC IMPORT OF `claude.mjs` RESOLVES FINE, and that is the trap: ESM does
// tolerate cycles, handing out a partially-initialised namespace. What it cannot
// do is settle a cycle re-entered THROUGH a suspended top-level await. So the
// obvious probe — importing the backend on its own — reports health, and the
// only reproduction is the real dispatch path. A cold review refuted this
// finding on exactly that evidence, having run the command without the platform
// set and read `antigravity` in its own output.
//
// THE RULE THIS ENCODES: a backend may not import the dispatcher. `cli.mjs`
// chooses backends; anything a backend needs from it is not dispatch logic and
// belongs here, where both can reach it and neither depends on the other.
// `cli.mjs` re-exports `resolvePlatform` so its own importers are unaffected.

/**
 * The SDD_ENGINE axis membership (issue #312, design D2 supporting change).
 * Lives here, not `cli.mjs`, for the same reason this whole file does: a
 * backend may not import the dispatcher, and `axes/sdd-engine/role-port.mjs`'s registry
 * assertion needs this list without reaching into `cli.mjs`'s top-level-await
 * module. `cli.mjs`'s `resolveEngine` reads it below instead of holding its
 * own inline literal — one declaration, two readers, the `CLI_OPS`-from-`OPS`
 * (`cli.mjs:136-145`) / `IMPLEMENTED_AXES`-from-`RUNNERS`
 * (`resolve-challenger.mjs:64-74`) house pattern.
 */
export const SDD_ENGINES = Object.freeze(['gentle-ai', 'plain']);

/**
 * The AGENT_PLATFORM axis membership (ADR-0024), and the value a repo gets when
 * it states none (issue #1125, ADR-0024 Amendment 2). `claude` is the default;
 * `antigravity` is the second supported platform; `plain` emits nothing.
 *
 * ONE DECLARATION IN JS, BUT NOT YET ONE RESOLVER. `bootstrap.sh` §6 still
 * resolves the platform in shell before `harness/cli.mjs` runs, and
 * `bootstrap.default-platform.test.mjs` holds it to `resolvePlatform` by a
 * parity table. #1114 retires the second resolver; until then, a change here
 * is a change there too, and the parity test says so.
 */
export const AGENT_PLATFORMS = Object.freeze(['claude', 'antigravity', 'plain']);
export const DEFAULT_PLATFORM = 'claude';

/**
 * Resolves the active agent platform.
 * Pure — takes env + envVars + config explicitly for testing.
 *
 * @param {{ env?: object, envVars?: object, config?: object }} [opts]
 * @returns {string}
 */
export function resolvePlatform({ env = process.env, envVars = {}, config = {} } = {}) {
  const platformVal = env.AGENT_PLATFORM ?? envVars.AGENT_PLATFORM ?? config.platform;
  if (platformVal) return platformVal;

  const harnessVal = env.SDD_HARNESS ?? envVars.SDD_HARNESS ?? config.harness;
  if (harnessVal && AGENT_PLATFORMS.includes(harnessVal)) {
    return harnessVal;
  }

  return DEFAULT_PLATFORM;
}
