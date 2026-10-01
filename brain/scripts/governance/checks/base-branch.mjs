// base-branch.mjs — the `base-branch` gate's pure predicate (issue #967 PR C).
//
// A slice PR belongs on its epic's tracker while that epic is in flight
// (`brain:ticket:start` already enforces this at CREATION time — PR B,
// `lib/ticket-base.mjs`). This is the BACKSTOP: a PR that reached the forge
// with the wrong base anyway must be refused, not merely warned about — a
// warning is what let #953 land on `main` (design.md D9).
//
// PURE, no IO (`issue-link.mjs`'s shape): the caller reads the linked issue's
// and the parent's BODIES and hands them here as strings. The parent → epic →
// tracker grammar is read by `parseGraphBlock` — the SAME reader
// `status/epic-graph.mjs` and `lib/ticket-base.mjs` already use (#340: never a
// second implementation of "parent"/"tracker").
//
// FAIL-CLOSED ON AN UNREADABLE DECLARATION (R967-7 scenario 5, the deny-reader
// rule, #942): a graph block this module cannot parse — two declarations, an
// unterminated fence, the pre-#709 legacy shape — is `uncomputable`, never a
// silent pass. Only a declaration that reads cleanly and simply says nothing
// (no block, no parent, no tracker, a parent that never declared `kind: epic`
// — R967-9) is the standing "pass untouched" case.

import { parseGraphBlock, declaredParent } from '../../status/epic-graph.mjs';

const EPIC_KIND = 'epic';

/**
 * @param {{issueBody?: string|null, epicBody?: string|null, targetBranch: string,
 *          defaultBranch: string, headBranch?: string|null}} input
 * @returns {{pass: boolean, reason?: string, uncomputable?: boolean}}
 */
export function baseBranchRule({ issueBody, epicBody, targetBranch, defaultBranch, headBranch }) {
  // D10 step 4/6 — no linked issue at all is the memory-lane / no-epic
  // standing case (R967-7 S4): pass untouched. (PR D review round 2: this
  // check now runs FIRST — the tracker-head decision below needs the linked
  // issue's own declaration, so there is no data-free branch-name shortcut
  // left to take before it.)
  if (typeof issueBody !== 'string') return { pass: true };

  const issueBlock = parseGraphBlock(issueBody);
  if (issueBlock?.ok === false) {
    return {
      pass: false,
      uncomputable: true,
      reason: `base-branch: the linked issue's graph block cannot be read: ${issueBlock.error}`,
    };
  }

  // D10 step 3, corrected (PR D review round 2): a head is "a tracker's own
  // integration PR" ONLY when it equals THE ONE FACT THE RULE HOLDS — the
  // linked issue's OWN declared tracker (it is itself `kind: epic` and
  // names `headBranch` in its `tracker:` field) — never by `feature/`
  // PREFIX alone. The prior shape trusted any `feature/…`-named head as a
  // tracker before ever reading a declaration, which rejected an ordinary
  // slice whose branch happened to start with `feature/` too (measured:
  // `feature/issue-42-my-feature`, correctly based on its epic's tracker).
  // `stranded.mjs:19-28`'s `feature/` prefix oracle answers a DIFFERENT
  // question — "which open branches look like trackers, to surface them
  // before they have a PR at all" — where no declaration is available yet
  // to check against; it is intentionally left as-is, not duplicated here.
  if (issueBlock?.kind === EPIC_KIND) {
    const ownTracker = issueBlock.tracker;
    if (ownTracker && headBranch === ownTracker) {
      if (targetBranch === defaultBranch) return { pass: true };
      return {
        pass: false,
        reason:
          `base-branch: a tracker PR ("${headBranch}") must target the default branch ` +
          `("${defaultBranch}"), not "${targetBranch}" — a tracker integrates into the ` +
          `default branch, it does not stack onto another tracker`,
      };
    }
    // Any other work against the epic's own issue obeys no parent tracker
    // (D10 step 6) — it is not the tracker's own integration PR.
    return { pass: true };
  }

  // The parent this PR must be checked against is read through `declaredParent`
  // (PR #1006 review round 1, finding 1), not `issueBlock?.parent` alone: a
  // block-less body can still declare its parent via prose (`Parent: #N`), and
  // `issueBlock` is `null` for such a body — the caller (`run-check.mjs`) now
  // fetches that parent, so this predicate must actually read it too, or the
  // fetch happens for nothing and the slice-on-main case keeps passing anyway.
  const dp = declaredParent(issueBody);

  // PR E (tracker PR #1004, round-3 cold review): `dp.parent === null` alone
  // cannot distinguish "nothing was declared" from "something was declared
  // and could not be read" — a `parent:` key failing `PARENT_KEY_GRAMMAR`
  // (e.g. `parent: abc`) or two disagreeing prose `Parent:` lines both land
  // on `null` here, and the line below used to take both straight to a
  // silent `pass: true`. That is the exact defect this module's own header
  // comment refuses: "a graph block this module cannot parse … is
  // uncomputable, never a silent pass" — only a declaration that reads
  // cleanly and says nothing is the standing pass case, and a divergence is
  // not that. `dp.divergence` is the one fact that tells the two apart.
  if (dp.divergence) {
    return {
      pass: false,
      uncomputable: true,
      reason:
        `base-branch: the issue's parent declaration is ${dp.divergence.reason} ` +
        `(${dp.divergence.value}) — cannot resolve the epic, failing closed`,
    };
  }

  const parent = dp.parent;
  if (parent === null) return { pass: true };

  // D10 step 7 — the parent's own declaration. An unreadable parent body is
  // the same fact as an unreachable epic (R967-7 S5): uncomputable, never a
  // silent pass.
  if (typeof epicBody !== 'string') {
    return {
      pass: false,
      uncomputable: true,
      reason: `base-branch: parent #${parent} could not be read — failing closed (uncomputable)`,
    };
  }

  const epicBlock = parseGraphBlock(epicBody);
  if (epicBlock?.ok === false) {
    return {
      pass: false,
      uncomputable: true,
      reason: `base-branch: parent #${parent}'s graph block cannot be read: ${epicBlock.error}`,
    };
  }

  // A `parent:` naming a node that never itself declared `kind: epic` is
  // never inferred to be one (R967-9, ruling 4 — `epic-graph.mjs`'s own
  // precedent): pass untouched.
  if (epicBlock?.kind !== EPIC_KIND) return { pass: true };

  // A malformed `tracker:` on the parent is carried by parseGraphBlock as a
  // said divergence, tracker already `null` — distinguish it from "no
  // tracker declared" so it FAILS, naming the epic and the bad value.
  const malformedTracker = epicBlock.declarationDivergences?.find(
    (d) => d.key === 'tracker' && d.reason === 'tracker-grammar',
  );
  if (malformedTracker) {
    return {
      pass: false,
      reason:
        `base-branch: parent #${parent}'s declared tracker is malformed ` +
        `("${malformedTracker.value}") — cannot resolve the required base`,
    };
  }

  const tracker = epicBlock.tracker;
  if (!tracker) return { pass: true }; // the epic declares no tracker — standing case

  if (targetBranch === tracker) return { pass: true };

  return {
    pass: false,
    reason:
      `base-branch: this PR's base ("${targetBranch}") must be its tracker ` +
      `("${tracker}", declared by parent #${parent}) while the epic is in flight`,
  };
}
