// ticket-args.mjs — the argv contract of `brain:ticket:start`, as a pure
// function so the DEFAULT can be tested (issue #782).
//
// THE DEFECT THIS CLOSES. `harness-contract.md:28` is canonical, compiled into
// `AGENTS.md`, and read by every agent:
//
//   "Always an isolated worktree; NEVER a branch in the main checkout when
//    parallel work is possible."
//
// And the verb defaulted to the branch that row calls NEVER. `ticket-start.mjs`
// read `argv.includes('--worktree')`, so the plain spelling — the one an
// operator or an agent types — did the forbidden thing. A rule that says
// *always* while asking you to remember a flag in order to satisfy it is a rule
// enforced by memory, and memory is what fails.
//
// It failed measurably: an agent session on 2026-08-27 (PRs #777–#781) created
// FIVE branches in the main checkout with `AGENTS.md` loaded and the rule in it
// the whole time. Nothing broke, because the work happened to be serial — that
// is luck, not correctness — and it still cost a `git stash` mid-rebase because
// the shared working tree carried local modifications.
//
// WHY THE PARSE MOVED HERE AT ALL. It was five lines at the top of a script that
// also does git, network and filesystem work, so the only way to ask "what does
// this verb do with no flags?" was to run the whole thing against a real repo.
// A default nobody can test is a default nobody checks — which is how this one
// survived the doctrine that forbade it.
//
// WHAT THIS DOES NOT CLOSE. Nothing here stops `git checkout -b` in the main
// checkout, which is what actually happened. The default is the cheap half;
// #782's slice 2 (a guard that refuses) and slice 3 (the orchestrator owns
// isolation, the shape `cold-boot.mjs` already uses for the reviewer) are the
// halves that make the rule unexpressible rather than merely inconvenient.

/** The flag every doc, skill and habit in the ecosystem already spells. */
export const WORKTREE_FLAG = '--worktree';

/** The named opt-out. `harness-contract.md` allows in-place for "strictly solo,
 *  serial work" — so it survives, as a decision an operator states rather than
 *  the default they never chose. */
export const IN_PLACE_FLAG = '--in-place';

/** The named opt-out off an epic's declared tracker (#967). Not a mode: a
 *  statement that this branch deliberately does not start where its epic says,
 *  which is why the refusal points at it by name. It takes no value, so the id
 *  rule below is untouched by it. */
export const OFF_TRACKER_FLAG = '--off-tracker';

/**
 * parseTicketArgs() — argv in, intent out. PURE.
 *
 * @param {string[]} argv
 * @returns {{ok: true, id: string, baseBranch: string, baseExplicit: boolean,
 *            offTracker: boolean, useWorktree: boolean}
 *          | {ok: false, error: 'usage'|'base-requires-arg'|'contradictory-modes'}}
 */
export function parseTicketArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];

  const askedWorktree = args.includes(WORKTREE_FLAG);
  const askedInPlace = args.includes(IN_PLACE_FLAG);

  // BOTH IS REFUSED, NOT RESOLVED. Choosing a winner would hand an operator who
  // asked for two things one of them, silently — the fold this repo keeps
  // removing one layer at a time.
  if (askedWorktree && askedInPlace) return { ok: false, error: 'contradictory-modes' };

  const baseIdx = args.indexOf('--base');
  const baseBranch = baseIdx >= 0 ? args[baseIdx + 1] : 'main';
  if (baseIdx >= 0 && !baseBranch) return { ok: false, error: 'base-requires-arg' };

  // THE DEFAULT SURVIVES AND THE FACT IS ADDED BESIDE IT (#967). `baseBranch`
  // answers "what base"; it cannot answer "did anyone ask", and an explicit
  // `--base main` against an epic that declares a tracker is refused while an
  // absent `--base` is resolved from that epic. Making the default `null`
  // instead would push it back into `ticket-start.mjs` — the direction #782
  // moved it away from, for the reason written at the top of this file.
  const baseExplicit = baseIdx >= 0;

  // The id is the first numeric argument that is NOT `--base`'s value: a tracker
  // branch may legitimately be all digits.
  const id = args.find((a, i) => /^\d+$/.test(a) && (baseIdx < 0 || i !== baseIdx + 1));
  if (!id) return { ok: false, error: 'usage' };

  // THE DEFAULT IS THE FIX. `--worktree` stays accepted and means what it always
  // meant; it is simply no longer load-bearing.
  return {
    ok: true,
    id,
    baseBranch,
    baseExplicit,
    offTracker: args.includes(OFF_TRACKER_FLAG),
    useWorktree: !askedInPlace,
  };
}
