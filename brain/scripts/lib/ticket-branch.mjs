// ticket-branch.mjs — how `brain:ticket:start` creates the task branch, as pure
// argument builders (issue #785).
//
// THE DEFECT THIS CLOSES, and it is about what GIT SAYS rather than what brain
// does. Both creation paths branched from a remote-tracking ref:
//
//   ticket-start.mjs:140   const startPoint = `origin/${baseBranch}`;
//   ticket-start.mjs:160   ['worktree', 'add', path, '-b', branch, startPoint]
//   ticket-start.mjs:189   ['checkout', '-b', branch, startPoint]
//
// `branch.autoSetupMerge` defaults to `true`, so a branch created from a
// remote-tracking ref gets that ref as its upstream. Git did exactly what it
// documents. The consequence is the problem:
//
//   $ git push
//   fatal: The upstream branch of your current branch does not match
//   the name of your current branch. …
//       git push origin HEAD:main
//
// That is git's FIRST suggested remedy, and it lands a task branch on the
// default branch — past the pull request and past `issue-link`, `diff-size`,
// `decision-gate`, `actor-check`, `brain-writes-reviewed` and the rest. The
// maintainer hit it on #782's own branch on 2026-08-28.
//
// AND THE SAFE CASE IS ONLY SAFE BY CONFIGURATION. The refusal above is
// `push.default = simple`, which compares branch NAMES. Under
// `push.default = upstream` — a documented, common setting — a bare `git push`
// pushes to the upstream, which here IS `origin/main`. The exposure is a config
// an operator may reasonably hold, not a mistake they have to make.
//
// THE FIX IS `--no-track`, and it is chosen for what it changes in the ERROR.
// With no upstream at all, git's only suggestion becomes
// `git push --set-upstream origin <branch>` — which is what
// `ticket-start.mjs`'s own printed step 4 has always said. The verb's
// instructions and git's stop disagreeing.
//
// WHAT THIS DOES NOT DO. It does not push, and it does not create a remote
// branch at task start: doing the operator's `-u` for them would make task
// start a network write it is not today, and would create a remote branch
// before there is anything to put on it. Recorded here because it was the other
// candidate, and rejecting it in a comment is cheaper than rejecting it twice.
//
// EXISTING BRANCHES ARE NOT REWRITTEN by any of this. It applies to branches
// created after it; an already-created branch keeps whatever upstream it has.

/**
 * Arguments for `git worktree add` — the default path since #782.
 *
 * A branch that already exists is ATTACHED, not created, so it acquires no
 * upstream and `--no-track` has nothing to act on (git also refuses the pair).
 *
 * @param {{worktreePath: string, branchName: string, startPoint: string,
 *          branchExists: boolean}} args
 * @returns {string[]}
 */
export function worktreeAddArgs({ worktreePath, branchName, startPoint, branchExists }) {
  return branchExists
    ? ['worktree', 'add', worktreePath, branchName]
    : ['worktree', 'add', '--no-track', worktreePath, '-b', branchName, startPoint];
}

/**
 * Arguments for the in-place `git checkout -b` path.
 *
 * BOTH PATHS, and that is the point rather than symmetry: `:189` had the same
 * defect as `:160`, so a fix covering only the worktree would have left the mode
 * `harness-contract.md` reserves for strictly solo work as the broken one.
 *
 * @param {{branchName: string, startPoint: string}} args
 * @returns {string[]}
 */
export function inPlaceCheckoutArgs({ branchName, startPoint }) {
  return ['checkout', '--no-track', '-b', branchName, startPoint];
}
