// ticket-base.mjs — where `brain:ticket:start` decides which branch a slice
// starts from (issue #967).
//
// THE DEFECT THIS CLOSES. While an epic is in flight, its slices belong on the
// epic's integration branch, and `harness-contract.md:28` says so: a `<tracker>`
// "is the integration base … not `main`, while an epic is in flight". The verb
// defaulted to `main` and the tracker lived nowhere a machine could read — in a
// PR description, in a chat message, in somebody's memory. So the rule was
// satisfied by whoever happened to remember `--base`, and a rule enforced by
// memory is a rule enforced by luck.
//
// The declaration now lives in the epic's `brain-graph/1` block (`kind: epic`,
// `tracker: feature/…`), and this leaf reads it: issue → `parent` → that node's
// `tracker`. ONE hop, because a walk over a chain would make the base depend on
// how deep someone wrote the tree and turn one read into an unbounded crawl.
//
// WHY A LEAF. `ticket-start.mjs` reads `process.argv` at module scope, exits on
// eight paths and does git and network work at import time, so nothing in it can
// be asked a question without a repository and a forge. Extracting the decision
// is the same move #782 made for the argv parse one file over: a decision nobody
// can test is a decision nobody checks.
//
// WHAT THIS IS NOT. It is not a refusal engine. It emits exactly one refusal —
// an explicit `--base main` against a declared tracker — and every other
// uncertainty resolves to the default branch WITH THE REASON SAID. An epic that
// cannot be read is an outage, and an outage must not stop a session.

import { parseGraphBlock, declaredParent } from '../status/epic-graph.mjs';
import { OFF_TRACKER_FLAG } from './ticket-args.mjs';

/** The declaration is `kind: epic` and nothing else. Not the title, not a label,
 *  not the fact that somebody pointed a `parent:` at it (R967-9). */
const EPIC_KIND = 'epic';

const say = (key, params) => ({ ok: true, base: params.base ?? params.tracker, say: { key, params } });

/**
 * resolveBase() — the issue, the parsed args and a reader in; a base and the
 * reason for it out. PURE: no `process`, no git, no forge client, no clock.
 *
 * `fetchIssue` is a one-argument closure rather than the whole VCS port. A leaf
 * given the port would have to know `project` and `provider` — facts about a
 * deployment, not about this decision — and its test would need a port stub
 * instead of a function. This is the shape `runIssueLinkCheck` already uses.
 *
 * The result carries a message KEY, never a message. `t()` is async and
 * locale-bound: rendering here would make the resolver untestable without i18n
 * and would put operator strings outside the catalogs, where the en/es parity
 * test cannot see them. The caller awaits `t(say.key, say.params)`.
 *
 * @param {{issue: {body?: string}, args: {baseBranch: string, baseExplicit: boolean,
 *          offTracker: boolean}, fetchIssue: (n: number) => Promise<{body?: string}|null>,
 *          defaultBranch?: string}} input
 * @returns {Promise<{ok: true, base: string, say: {key: string, params: object}|null}
 *          | {ok: false, refusal: {key: string, params: object}}>}
 */
export async function resolveBase({ issue, args, fetchIssue, defaultBranch = 'main' }) {
  const { baseBranch, baseExplicit, offTracker } = args;

  // AN EXPLICIT BASE THAT IS NOT THE DEFAULT IS AN ANSWER, not a question. This
  // path is byte-identical to the behaviour before #967 — including the absence
  // of a message and, deliberately, the absence of a network call: reading the
  // epic here would spend a round trip and risk a failure to produce a line
  // nobody asked for.
  if (baseExplicit && baseBranch !== defaultBranch) {
    return { ok: true, base: baseBranch, say: null };
  }

  const parent = parentOf(issue?.body);
  if (parent.number === null) {
    // PR E (tracker PR #1004, round-3 cold review): a parent that could not
    // be read (parent-grammar, parent-ambiguous) is not the same fact as a
    // body that never mentions one — R967-5's fail-open answer still applies
    // (base: main, no refusal, no forge call for a number that does not
    // exist), but the STATED reason must name which it was, the same
    // distinction `declaredParent`'s own `divergence` field exists to carry.
    return say('ticket.base.noEpic', {
      base: defaultBranch,
      reason: parent.divergence ? parent.divergence.reason : 'no-parent',
    });
  }

  // ONE READ, and every way it can go wrong FAILS OPEN. The freshness check one
  // screen away in `ticket-start.mjs:151-154` states the rule this follows: "a
  // wrong warning is noise; a wrong refusal is a stopped session". A forge
  // outage must not be able to stop every session that starts a slice.
  let epic;
  try {
    epic = await fetchIssue(parent.number);
  } catch (e) {
    return say('ticket.base.epicUnreadable', {
      base: defaultBranch, epic: parent.number, message: e?.message ?? String(e),
    });
  }
  if (!epic || typeof epic.body !== 'string') {
    return say('ticket.base.epicUnreadable', {
      base: defaultBranch, epic: parent.number, message: 'not found',
    });
  }

  const block = parseGraphBlock(epic.body);
  // `{ok: false}` is the parser refusing to pick between two declarations — a
  // body that cannot be read, which is the same fact as an unreachable epic and
  // gets the same fail-open answer. `null` is a body that simply declares
  // nothing, which is not a failure at all.
  if (block?.ok === false) {
    return say('ticket.base.epicUnreadable', {
      base: defaultBranch, epic: parent.number, message: block.error,
    });
  }

  // A `tracker:` on a node that never declared `kind: epic` is carried by the
  // parser as a said divergence and honoured by nobody (design Q7): refusing it
  // there would let a typo in `kind:` delete a declaration, and honouring it
  // here would let one redirect a branch.
  const tracker = block?.kind === EPIC_KIND ? block.tracker : null;
  if (!tracker) {
    return say('ticket.base.noEpic', {
      base: defaultBranch,
      reason: block?.kind === EPIC_KIND ? 'epic-declares-no-tracker' : 'parent-not-epic',
    });
  }

  // THE OPT-OUT IS A DECISION SAID OUT LOUD, the shape `--in-place` established
  // for this verb: it survives, and the run names it rather than leaving an
  // operator to infer it from a base that is not the one the epic declared.
  if (offTracker) {
    return say('ticket.base.offTracker', {
      base: defaultBranch, tracker, epic: parent.number,
    });
  }

  // THE ONE REFUSAL. An explicit `main` against a declared tracker is the exact
  // mistake this change exists to catch — a slice pointed at the default branch
  // while its epic is still integrating — and it is a stated intent, not an
  // omission, so answering it with the tracker would be overruling an operator
  // silently. It names the tracker and the way through.
  if (baseExplicit) {
    return {
      ok: false,
      refusal: {
        key: 'ticket.error.baseIsTracked',
        params: { base: baseBranch, tracker, epic: parent.number, flag: OFF_TRACKER_FLAG },
      },
    };
  }

  return say('ticket.base.fromEpic', {
    tracker, epic: parent.number, source: parent.source,
  });
}

/**
 * The issue's own declaration, read by the same reader the graph uses
 * (`declaredParent` — #967 PR D, review round 2). An unreadable or absent
 * block declares no parent, a MALFORMED block never falls back to prose, and
 * a `needs:` edge is never read as one (R967-10) — but a body with NO block
 * at all still resolves its prose `Parent:` line, which the old direct
 * `parseGraphBlock` call here could not see (measured: it returns `null`
 * before ever scanning prose when no graph-tagged fence exists).
 *
 * Always returns an object, never `null` (PR E, tracker PR #1004 round 3):
 * `number` is `null` for BOTH "nothing declared" and "something declared and
 * unreadable" (`declaredParent`'s own `parent === null` cannot tell them
 * apart either), and `divergence` is the one field that does — carried
 * through so `resolveBase` can state which it was rather than reading both
 * as `reason: 'no-parent'`.
 */
function parentOf(body) {
  const { parent, parentSource, divergence } = declaredParent(body);
  if (parent === null) return { number: null, source: null, divergence };
  return { number: parent, source: parentSource, divergence: null };
}
