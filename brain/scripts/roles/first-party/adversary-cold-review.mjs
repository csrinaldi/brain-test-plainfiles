// adversary-cold-review.mjs — issue #814 T4 (proposal D5): the Adversary
// archetype's first instance, and brain's first FIRST-PARTY role.
//
// This text lived in `review/lib/cold-review-prompt.mjs` since #682, under a
// header that said, verbatim: "delete this module and read the role from the
// port. Keep nothing." This is that deletion's landing site — the ROLE half.
// The header's "keep nothing" overclaimed by one half: the machine-checkable
// protocol block (fence tag, field list, severities, artifact path) is DERIVED
// from the reader's own constants and stays beside the reader
// (`review/lib/assemble-review-prompt.mjs`), which takes THIS text as an
// argument. Content here, protocol there — the split is what keeps this file
// free of every literal a reader change would stale.
//
// #576 grows the four-archetype reference set (Coordinator / Constructor /
// Adversary / Verifier) around this instance. It is deliberately NOT an
// inhabitant: an inhabitant must answer every resolved stage
// (`role-port.mjs`), and brain's first-party content claims exactly the
// stages it has content for.
//
// NEUTRALITY (ADR-0019 Amendment 1, condition 2): this object carries content
// only. No engine, no map, no model — who RUNS the stage is routed elsewhere
// and may never be influenced from here. `first-party.test.mjs` asserts it.

/** The Adversary instance for the cold-review stage. */
export const ADVERSARY_COLD_REVIEW = Object.freeze({
  stage: 'cold-review',
  archetype: 'adversary',
  _provenance: Object.freeze({
    authored: true,
    origin: 'review/lib/cold-review-prompt.mjs (#682 slice 3, D8) — moved verbatim under #814 D5',
    date: '2026-09-02',
  }),
  text: `You are a COLD REVIEWER. You have not seen this change before, you did not
write it, and you are not here to be agreeable.

## What you may use

Read anything in the repository: the diff, the files it touches, the files it does
NOT touch, the tests, \`openspec/\`, \`brain/project/decisions/\`. Run the test
suite if you need to. Reproduce before you claim.

## What you must NOT do

- Do not post anything anywhere. You hold no credential and the review is not
  yours to publish. Your entire output is one file.
- Do not commit, stage, or amend. Writing the artifact is your only mutation.
- Do not edit the code you are reviewing. A reviewer who fixes what they found
  has destroyed the evidence that it was there.`,
});
