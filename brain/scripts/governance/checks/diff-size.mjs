// diff-size.mjs — check that a diff's changed-line count is within the 400-line budget.
// Delegates line counting to parseDiffNumstat (scripts/vcs/diff-size-count.mjs).
// Returns { pass: boolean, reason?: string }.

import { parseDiffNumstat } from '../../vcs/diff-size-count.mjs';

const DEFAULT_BUDGET = 400;

/**
 * @param {string}   rawNumstat  Raw output from `git diff --numstat`.
 * @param {string[]} ignoreList  Glob patterns to exclude (brain.config.json syntax).
 * @param {number}   [budget=400]
 * @returns {{ pass: boolean, reason?: string }}
 */
export function diffSize(rawNumstat, ignoreList, budget = DEFAULT_BUDGET) {
  const total = parseDiffNumstat(rawNumstat, ignoreList);
  if (total <= budget) return { pass: true };
  return {
    pass: false,
    reason: `diff size ${total} lines exceeds budget of ${budget} (use size:exception if justified)`,
  };
}
