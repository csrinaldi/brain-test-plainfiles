// axis-selector.mjs — ONE precedence for "which implementation does this axis run" (issue #1165).
//
// An axis selector (MEMORY_BACKEND today; SDD_ENGINE and AGENT_PLATFORM are the
// same shape, #1114) has four possible homes, and they are NOT equals:
//
//   1. process env   — a per-run override        (`MEMORY_BACKEND=x npm run …`)
//   2. `.env`        — a per-machine override    (untracked; one checkout only)
//   3. brain.config.json `<configPath>` — the TEAM's choice (tracked; every checkout)
//   4. nothing       — undeclared
//
// The defect this exists to stop: the team's choice used to live ONLY at level 2.
// A second checkout (a teammate, CI, a fresh clone) has no `.env`, so it fell
// through to a hard-coded default and silently ran a different backend than the
// team's. A team decision belongs in a file every checkout has: level 3.
//
// Level 4 is `undeclared`, and it is a RESULT, never a guess: this module has no
// default. What a reader does with `undeclared` (refuse, prompt) is the caller's
// call — the point is that a guess is no longer expressible here.
//
// An empty string is undeclared at every level. `brain.config.json` carries
// `""` for a key a migration declared but nobody set (the `vcs.provider`
// convention), and `KEY=` in `.env` is an unset key, not a value.
//
// PURE over data except `resolveEnv`'s `.env` read, which it already owns.

import { resolveEnv } from './env-read.mjs';

/** Reads a dot-separated path from a plain object; own keys only. */
function readPath(obj, path) {
  let node = obj;
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
    node = node[seg];
  }
  return node;
}

const present = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * @param {object} args
 * @param {string} args.key          env var name, e.g. `MEMORY_BACKEND`
 * @param {string} args.configPath   dotted path in brain.config.json, e.g. `memory.backend`
 * @param {ReadonlyArray<string>} args.allowed  the closed set of valid values
 * @param {object} [args.config]     parsed brain.config.json ({} when absent)
 * @param {object} [args.env]        process env
 * @param {string} [args.root]       where `.env` lives
 * @param {string|null} [args.envFile] explicit `.env` path (test seam)
 * @returns {{value: string|null, source: 'shell'|'file'|'config'|'none',
 *            valid: boolean, allowed: ReadonlyArray<string>,
 *            shadowed: Array<{source: string, value: string}>}}
 *   `value` is null exactly when `source` is 'none'. `valid` is false when a
 *   value WAS declared but is outside `allowed` — a typo is reported as a typo,
 *   never coerced into a different backend.
 */
export function resolveAxisSelector({ key, configPath, allowed, config = {}, env = process.env, root = process.cwd(), envFile = null }) {
  // An EMPTY shell value is an unset one: hand resolveEnv an env without the key
  // so it falls through to `.env` instead of stopping at the empty string.
  const shellEnv = present(env?.[key]) === null ? { ...env, [key]: undefined } : env;
  const fromEnv = resolveEnv(key, { env: shellEnv, root, envFile });
  const fromConfig = present(readPath(config, configPath));
  const envValue = present(fromEnv.value === null || typeof fromEnv.value !== 'string' ? null : fromEnv.value);

  let value = null;
  let source = 'none';
  if (envValue !== null) {
    value = envValue;
    source = fromEnv.source; // 'shell' | 'file'
  } else if (fromConfig !== null) {
    value = fromConfig;
    source = 'config';
  }

  // Every losing declaration is reported, never dropped (#1165 S3): the config value a
  // winning env/.env layer covers, AND the `.env` value a winning shell covers — the
  // latter is computed by resolveEnv and used to be discarded here.
  const shadowed = [];
  if (fromEnv.shadowed && source === 'shell') shadowed.push({ source: 'file', value: fromEnv.shadowed.value });
  if (value !== null && source !== 'config' && fromConfig !== null && fromConfig !== value) {
    shadowed.push({ source: 'config', value: fromConfig });
  }

  return { value, source, valid: value === null || allowed.includes(value), allowed, shadowed };
}
