// git-branch.mjs — single source of truth for "current git branch" detection
// (issue #138, design §1.2).
//
// Two implementations used to disagree:
//   - day-start.mjs        → `git branch --show-current` (empty string on detached HEAD)
//   - engram.mjs _getGitBranch → `git rev-parse --abbrev-ref HEAD` (literal "HEAD" on detached HEAD)
//
// This extracts ONE implementation (`rev-parse --abbrev-ref HEAD`) and
// normalizes every "no usable branch name" case — detached HEAD, non-zero
// git status, and git-absent/non-git directories — to a single `null`
// signal. Callers handle exactly one "no branch" case instead of two.

import { spawnSync } from 'node:child_process';

/**
 * Returns the current branch name, or `null` when there is no usable branch
 * name (detached HEAD, non-zero git status, git absent, non-git directory).
 * NEVER throws.
 *
 * @param {string} cwd  Repo root to run git in.
 * @param {{ _spawn?: typeof spawnSync }} [opts]  Injectable spawn seam for tests.
 * @returns {string|null}
 */
export function currentBranch(cwd, { _spawn = spawnSync } = {}) {
  try {
    const r = _spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' });
    if (r.status !== 0) return null;
    const name = (r.stdout || '').trim();
    if (!name || name === 'HEAD') return null; // detached HEAD sentinel
    return name;
  } catch {
    return null; // git absent / non-git dir
  }
}
