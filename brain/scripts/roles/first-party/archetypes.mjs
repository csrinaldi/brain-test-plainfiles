// archetypes.mjs — issue #576 T1 (M5 step B): the four archetypes, as
// doctrine-carrying DATA on the port's side of the house.
//
// AN ARCHETYPE OWNS ONLY WHAT THE PORT DOES NOT (the 2026-08-12 rescope's
// one rule): `archetype`, an `escalation` rule, an `output_contract` — plus
// the two prose axes that characterize it (what it may WRITE, what it must
// not SEE). The write surface itself stays the port's `writes`; blindness
// stays `reads` inverted. `assertArchetypeShape` makes redeclaration a THROW,
// not a review comment.
//
// EVERY CONTRACT IS LABELLED, AND THE LABEL IS A CHECKED VALUE (#499): a role
// definition is text handed to an agent, and declaring "you must not see X"
// does not make an agent unable to see X. `mechanical` means a test proves
// it; `doctrinal` means it is written down and named as such — the L6
// precedent (#584): recorded, never implied.
//
// A Map, not an object literal: one of the four is named `constructor`, and
// an object lookup would answer for it from the prototype chain — the exact
// trap RUNNERS (resolve-challenger.mjs) documents.

export const CONTRACT_LABELS = Object.freeze(['mechanical', 'doctrinal']);

/** Fields the PORT owns; an archetype redeclaring one is refused. */
const PORT_FIELDS = Object.freeze(['writes', 'reads', 'model_tier', 'chooses_model', 'instructions']);

/**
 * Refuses a definition that reaches into the port's contract or carries an
 * unchecked label. Called on every member below by the test suite — the
 * validator and the data live together so a fifth archetype cannot land
 * unvalidated.
 */
export function assertArchetypeShape(def) {
  for (const field of PORT_FIELDS) {
    if (field in def) {
      throw new Error(
        `archetypes: '${def.archetype}' declares '${field}' — that field belongs to the port's role ` +
        'contract (role-port.mjs), and a second declaration beside it is the failure the 2026-08-12 ' +
        'rescope of #576 exists to prevent.',
      );
    }
  }
  for (const field of ['escalation', 'output_contract']) {
    const label = def?.[field]?.label;
    if (!CONTRACT_LABELS.includes(label)) {
      throw new Error(
        `archetypes: '${def.archetype}'.${field}.label is ${JSON.stringify(label)} — must be one of ` +
        `${CONTRACT_LABELS.join(', ')}. An unlabelled protection is an apparent one (#499).`,
      );
    }
  }
  return def;
}

const define = (def) => Object.freeze(assertArchetypeShape(def));

export const ARCHETYPES = new Map([
  ['coordinator', define({
    archetype: 'coordinator',
    may_write_summary: 'plans, delegation prompts, and synthesis — nothing irreversible; commits, pushes and merges are proposed, never executed.',
    must_not_see_summary: 'nothing is hidden from it — the coordinator sees everything precisely because it executes nothing.',
    escalation: {
      rule: 'Any action beyond its write surface escalates to the human; doubt about the tier is itself sufficient reason (agent-authorities.md).',
      label: 'doctrinal',
    },
    output_contract: {
      shape: 'a plan or handoff another role can execute without re-deriving context',
      label: 'doctrinal',
    },
  })],
  ['constructor', define({
    archetype: 'constructor',
    may_write_summary: 'implementation and tests inside the change\'s declared file claim, under constraints it cannot loosen (budgets, TDD mode, tier).',
    must_not_see_summary: 'the verdict machinery of its own change — a producer that reads its judge optimizes for the judge.',
    escalation: {
      rule: 'A blocked task or an out-of-claim file stops the batch and reports; it never widens its own claim.',
      label: 'doctrinal',
    },
    output_contract: {
      shape: 'work-unit commits whose tests landed RED first',
      label: 'mechanical',
    },
  })],
  ['adversary', define({
    archetype: 'adversary',
    may_write_summary: 'exactly one findings artifact; writing the artifact is its only mutation.',
    must_not_see_summary: 'the producer\'s intent beyond the diff and the tree — blind by design to what it attacks, so agreement cannot be manufactured.',
    escalation: {
      rule: 'A finding it cannot prove routes to a challenger (human by default — the #743 ruling); it never softens a claim to avoid the route.',
      label: 'doctrinal',
    },
    output_contract: {
      shape: 'findings in the reader\'s own schema — derived from the reader, parsed by the reader, or refused by the reader',
      label: 'mechanical',
    },
  })],
  ['verifier', define({
    archetype: 'verifier',
    may_write_summary: 'COMMENT-state verdicts only — read-only against the work, re-derives from the server, never edits what it judges.',
    must_not_see_summary: 'nothing structural — but what it reads it re-derives cold (clean tree, server state), never trusts handed context.',
    escalation: {
      rule: 'escalate: human on any finding whose evidence class the build cannot challenge (reviewer-protocol.md §7 bounds revisions).',
      label: 'doctrinal',
    },
    output_contract: {
      shape: 'a brain-review/2 verdict that CANNOT count as approval — §2\'s three locks, any one of which holds alone',
      label: 'mechanical',
    },
  })],
]);
