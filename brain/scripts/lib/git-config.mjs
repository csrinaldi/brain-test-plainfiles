// git-config.mjs — the ONE spawn that reads a git config value (#738, design A1).
//
// `capture-provenance.mjs`'s resolvers need `brain.actor` and `brain.agentEnv`
// but must stay pure (no `fs`, no `child_process`). This is the single place
// that touches git for that purpose, beside `git-branch.mjs`'s "current
// branch" primitive — two ad-hoc implementations of "read a fact from git"
// disagreeing is the mistake `git-branch.mjs`'s header already documents; a
// second copy of it for `git config` is avoided at introduction.

import { spawnSync } from 'node:child_process';

/**
 * Returns the value of `git config --get <key>`, or `null` when the key is
 * unset, the command exits non-zero, or the spawn itself throws (git absent /
 * non-git dir). NEVER throws.
 *
 * One `--get` call returns git's own precedence (system → global → local,
 * last wins) — this is intentionally NOT a hand-rolled local-then-global
 * read, which would be a second precedence rule to keep in sync with git's.
 *
 * @param {string} key  e.g. `brain.actor`.
 * @param {string} cwd  The checkout git should resolve config for.
 * @param {{ _spawn?: typeof spawnSync }} [opts]  Injectable spawn seam for tests.
 * @returns {string|null}
 */
export function gitConfigGet(key, cwd, { _spawn = spawnSync } = {}) {
  try {
    const r = _spawn('git', ['config', '--get', key], { cwd, encoding: 'utf8' });
    if (!r || r.status !== 0) return null;
    const value = (r.stdout || '').trim();
    return value || null;
  } catch {
    return null;
  }
}
