// brain/scripts/memory/lib/backend-resolve.mjs — the ONE resolver of the memory
// backend (issue #1165). `memory/cli.mjs` and `bootstrap.sh` (through this file's
// CLI) both ask HERE; nothing else in the tree decides which backend runs.
//
// Precedence (axis-selector.mjs): process env `MEMORY_BACKEND` → `.env` →
// `brain.config.json` `memory.backend` → undeclared. Undeclared is a refusal
// naming the fix, never `engram`: a second checkout with no `.env` used to
// silently run a different backend than the team's (#1165).
//
// This module owns the closed set of backends. The dispatcher's own
// DEFAULT_BACKEND (backend-selection.mjs) is no longer a resolution default — it
// survives only as "the backend that needs the engram binary" for the #641
// probe, which now applies to a DECLARED engram.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveAxisSelector } from '../../lib/axis-selector.mjs';

export const MEMORY_BACKENDS = Object.freeze(['engram', 'plainfiles']);
export const MEMORY_ENV_KEY = 'MEMORY_BACKEND';
export const MEMORY_CONFIG_PATH = 'memory.backend';

/**
 * Exit codes of the refusal, shared by `memory/cli.mjs` and this file's CLI so a caller
 * (a hook, session-start, ticket-start) can tell "no backend declared" from any other
 * failure WITHOUT matching localized text.
 */
export const EXIT_UNDECLARED = 3;
export const EXIT_INVALID = 4;
/** CLI only: nothing declared AND the config could not be read — "could not look" is not "declared nothing". */
export const EXIT_UNREADABLE = 5;

/** The one-line fix, named wherever an undeclared backend is reported. */
export const DECLARE_FIX = 'npm run brain:config -- set memory.backend engram|plainfiles';

/**
 * `brain:upgrade`'s notice (#1165 S4): after the 1.9.1 migration leaves `memory.backend: ""`,
 * and neither the process env nor `.env` declares one, say so ONCE and name the fix.
 * Null when a backend is declared anywhere (nothing to say) or is invalid (the refusal owns it).
 */
export function undeclaredUpgradeNotice({ root, env = process.env }) {
  const r = resolveMemoryBackend({ root, env });
  if (r.status !== 'undeclared') return null;
  return `memory.backend is not declared (brain.config.json, .env, env) — memory commands will refuse until it is. Next: ${DECLARE_FIX}`;
}

/**
 * Reads `<root>/brain.config.json` (or `configFile`). Absent is `{}`; UNREADABLE
 * is `{}` plus a reported `error` — "could not look" must not read as "declared
 * nothing" without saying so.
 */
export function readConfig({ root, configFile = null }) {
  const path = configFile ?? join(root, 'brain.config.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) { // surfaced: an unreadable config is returned as `error` and printed by the refusal
    if (err?.code === 'ENOENT') return { config: {}, error: null, path };
    return { config: {}, error: `${path}: ${err.message}`, path };
  }
  try {
    const parsed = JSON.parse(raw);
    return { config: parsed !== null && typeof parsed === 'object' ? parsed : {}, error: null, path };
  } catch (err) { // surfaced: a malformed config is returned as `error` and printed by the refusal
    return { config: {}, error: `${path}: ${err.message}`, path };
  }
}

/**
 * @param {{root: string, env?: object, envFile?: string|null, configFile?: string|null}} args
 * @returns {{backend: string|null, source: 'shell'|'file'|'config'|'none',
 *            status: 'declared'|'undeclared'|'invalid', invalidValue?: string,
 *            configError: string|null, shadowed: Array<{source: string, value: string}>}}
 */
export function resolveMemoryBackend({ root, env = process.env, envFile = null, configFile = null }) {
  const { config, error } = readConfig({ root, configFile });
  const r = resolveAxisSelector({
    key: MEMORY_ENV_KEY,
    configPath: MEMORY_CONFIG_PATH,
    allowed: MEMORY_BACKENDS,
    config,
    env,
    root,
    envFile,
  });
  if (r.value === null) {
    return { backend: null, source: 'none', status: 'undeclared', configError: error, shadowed: [] };
  }
  if (!r.valid) {
    return { backend: null, source: r.source, status: 'invalid', invalidValue: r.value, configError: error, shadowed: r.shadowed };
  }
  return { backend: r.value, source: r.source, status: 'declared', configError: error, shadowed: r.shadowed };
}

// ---------------------------------------------------------------------------
// CLI — the bash reader. `bootstrap.sh` must not re-implement the precedence in
// shell (that is the second resolver #1165 removes), so it asks this file.
//
//   node backend-resolve.mjs [--root <dir>]
//     declared   → stdout `<backend> <source>`, exit 0
//     undeclared → stdout empty,                 exit 3
//     invalid    → stdout `! <value> <source>`,  exit 4
//     unreadable → the config could not be read and nothing else declares one: stderr says why, exit 5
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  const root = i >= 0 ? process.argv[i + 1] : process.cwd();
  const r = resolveMemoryBackend({ root });
  if (r.status === 'declared') {
    process.stdout.write(`${r.backend} ${r.source}\n`);
  } else if (r.status === 'invalid') {
    process.stdout.write(`! ${r.invalidValue} ${r.source}\n`);
    process.exit(EXIT_INVALID);
  } else if (r.configError) {
    process.stderr.write(`brain.config.json unreadable — ${r.configError}\n`);
    process.exit(EXIT_UNREADABLE);
  } else {
    process.exit(EXIT_UNDECLARED);
  }
}
