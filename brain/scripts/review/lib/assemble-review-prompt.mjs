// assemble-review-prompt.mjs — the cold review's PROTOCOL half (#682 D8,
// split by #814 D5).
//
// Until #814 this file was `cold-review-prompt.mjs` and carried the reviewer's
// ROLE too, under a PROVISIONAL header that said: "WHEN #312 LANDS: delete
// this module and read the role from the port. Keep nothing." The role half is
// now exactly there — `roles/first-party/adversary-cold-review.mjs`, handed in
// as an argument — and "keep nothing" turned out to overclaim by one half:
// everything below is derived from the READER's own constants and per-run
// parameters, which no port can serve (`declareRoles` is pure and knows no PR
// number). Content lives with the port; protocol stays beside the reader.
// `ROLE_DEBT_TICKET` is discharged and deleted with the move.
//
// THE PROMPT IS DERIVED FROM THE READER, NOT RESTATED ALONGSIDE IT.
//
// Every machine-checkable element of the contract — the fence tag, the field
// list, the evidence classes, the artifact path — is
// interpolated from the constant the READER uses. A prompt that spelled them out
// as its own literals would be a second declaration of the contract with nothing
// comparing the two, and would go stale the first time a field moved: the engine
// would be told to emit a shape the reader silently drops.
//
// That is the defect class this ticket has now hit six times, and the test does
// not merely assert the interpolation happened. It feeds THE WHOLE PROMPT to
// `readFindingsArtifact` — the real reader, unmocked — and requires the worked
// example inside it to parse. If the example shows the engine a shape the reader
// would refuse, drop a field from, or fail to find, the suite goes red.
//
// `severity` NOW DERIVES LIKE EVERYTHING ELSE, and the paragraph below records
// why it did not until the fifth cold review. The objection was sound — a
// constant no validator reads is the very thing this file avoids — and
// judgment:cold-2 removed its premise: `readFindingsArtifact` now REFUSES a
// value outside the set, so `ALLOWED_SEVERITIES` has a reader and this prompt
// reads the same constant the boundary enforces. The cross-check against
// `reviewer-protocol.md` stays, because the doctrine document is still where the
// vocabulary is DEFINED.
//
// What follows is the original note, kept because the reasoning was right and
// only its premise changed:
//
// `severity` was the one vocabulary with no constant to derive from: no
// `ALLOWED_SEVERITIES` exists — the three values are enforced by scattered
// comparisons (`verdict.mjs`'s uncited-blocker downgrade, `refuter.mjs`'s batch
// selection) and written down in `reviewer-protocol.md`. Adding a constant here
// that no validator reads would create the very thing this file avoids.
//
// So it stays a literal, AND THE TEST GIVES IT A READER ANYWAY: it parses
// `reviewer-protocol.md`'s own `severity:` line and requires the two to agree.
// The protocol document is where the vocabulary is actually written down, so
// that is a real cross-check rather than a second copy compared to itself — and
// it fails the day the protocol changes the set without this file following.
//
// `evidence_class` IS STATED, NOT OFFERED, and it used to be offered — the third
// cold review's judgment:cold-4. This prompt interpolated the whole vocabulary,
// `deterministic | inferential | insufficient`, while `evaluateInferential`
// overwrites the field unconditionally. Measured end to end: a finding written
// as `insufficient` reaches the reader as `insufficient` and leaves the
// evaluator as `inferential`.
//
// THE DIRECTION OF THAT OVERWRITE IS WHAT MAKES IT WORSE THAN A DEAD FIELD.
// `controls.mjs` defines `insufficient` as NOT_A_CONTROL — "there is no such
// thing as running the insufficient control" — so a reviewer honestly reporting
// that it could not establish a claim had that admission upgraded into a control
// class, and the verdict then declared the inferential control applied over it.
// The producer was invited to grade its own admissibility and the grade was
// rewritten in the direction that STRENGTHENS the claim.
//
// The forcing itself stays: a producer claiming `deterministic` would put a
// reasoned claim on the deterministic side of #575 Ruling 3 and skip the refuter
// entirely. What changes is that the prompt stops presenting a menu it does not
// honour, which is `causal_disposition`'s ruling applied to its neighbour —
// STOP ASKING rather than START CARRYING.
//
// HONOURING `insufficient` was the other candidate and is NOT taken here. It
// carries real information and the honest home for it is the controls-coverage
// path, not a field the evaluator rewrites on the way past; that is a change to
// what a verdict CLAIMS, which is ADR territory rather than a prompt fix.
//
// `causal_disposition` IS NOT ASKED FOR, and that is a ruling rather than an
// omission (#682 cold review, judgment:cold-9). This prompt used to document it
// as a field the engine may state. It is not in `CARRIED_FIELDS`, so
// `sanitiseFinding` dropped every stated one at the boundary — which is the
// defect this file's whole design claims to prevent, committed by this file.
//
// The fix is to stop ASKING, not to start carrying, and the direction matters:
// `verdict.mjs` routes `pre-existing`/`base-only` into `follow_ups`, OUT of the
// blocking set, and `annotateDeterministicFindings` spreads `...f` last so a
// producer's own value wins over the default. Carry the field and a cold
// reviewer could de-block its own findings by declaring them pre-existing —
// the producer grading its own admissibility.
//
// AND NOTHING DOWNSTREAM WOULD CATCH IT. The first cut of this note claimed
// `classifyAgainstBase` measures the disposition against the base, so a
// producer's claim would be corrected. THAT IS FALSE, and the second cold
// review measured it: `gateNameOf` is `/^gate:(.+)$/`, a `judgment:*` id does
// not match, and `base-comparison.mjs` returns the finding untouched. A
// producer finding is never measured — it keeps a DEFAULT, and a default is
// not a measurement. Corrected in place rather than deleted: a note promising
// a safety net that does not exist is worse than no note, because it tells the
// next reader the field is safe to carry.
//
// THE ONLY LOCK IS THE ABSENCE FROM `CARRIED_FIELDS`. There is a second one
// today — the refuter escalates on `unchallenged`, so an uncorroborated
// producer finding still reaches a human — but it holds only while no
// challenger is built. The day a `same-model` challenger lands and CORROBORATES
// a finding, that escalation is gone, and a producer-declared `pre-existing`
// would yield a clean APPROVE over a corroborated blocker.
//
// The reader dropping it was already the fail-closed behaviour. The prompt was
// the half that was wrong.

import { join, isAbsolute } from 'node:path';

import {
  ARTIFACT_TAG,
  CARRIED_FIELDS,
  artifactPathFor,
} from './findings-artifact.mjs';
import { FORCED_EVIDENCE_CLASS } from '../evaluators/inferential.mjs';
import { ALLOWED_SEVERITIES } from './findings-artifact.mjs';

/**
 * The severity vocabulary — a LITERAL, and unchecked. See the header: no
 * constant exists to derive it from, and inventing one that nothing validates
 * against would be a declared oracle with no reader.
 */
const SEVERITIES = ALLOWED_SEVERITIES.join(' | ');

/**
 * Fields the prompt REFUSES out loud — named here so the refusal has a reader.
 *
 * The second cold review showed why prose is not enough: the converse test
 * parsed bullets with the field name in LEADING position, which is every bullet
 * EXCEPT the refusal this file added, so a new bullet phrased
 * "· When it matters, state `risk_score`" asked for an uncarried field and no
 * oracle could see it. A prompt whose refusals live only in sentences cannot be
 * checked against the reader; a list can.
 *
 * The invariant its test asserts: every backticked identifier in the field spec
 * is CARRIED, a value from a rendered vocabulary, or REFUSED here — and nothing
 * is both carried and refused.
 */
export const REFUSED_FIELDS = Object.freeze(['causal_disposition']);

/**
 * assembleReviewPrompt() — PURE. Interpolates the protocol block around a
 * served role for one PR.
 *
 * `artifactRoot` SPLITS THE READ SURFACE FROM THE WRITE TARGET, and the split is
 * the whole of judgment:cold-3's fix. The engine runs inside the cold worktree —
 * a detached checkout at the PR head — so that what it READS is the code the
 * verdict binds itself to, rather than whatever branch the operator happens to
 * have checked out. But the artifact must land where the READER looks, which is
 * the operator's tree; a relative path would put it in the throwaway worktree
 * and `run-cold-review-stage.mjs` would then report "the engine exited cleanly
 * but wrote no artifact" about a file the engine wrote perfectly.
 *
 * So when `artifactRoot` is given the path renders ABSOLUTE. It is still
 * `artifactPathFor`'s answer underneath — one source for the location, two
 * spellings of it.
 *
 * @param {{prNumber: number|string, baseRef?: string|null, headRef?: string|null,
 *          artifactRoot?: string|null, outputMode?: 'file'|'final-message'}} args
 * @returns {string}
 * @throws {Error} via `artifactPathFor` when the PR number is not one
 */
export function assembleReviewPrompt({
  role, prNumber, baseRef = null, headRef = null, artifactRoot = null, outputMode = 'file',
} = {}) {
  // Refused, not defaulted, for the same reason the path below is thrown on:
  // a prompt with no role half sends an engine to work as nobody in
  // particular, and the output would still parse — the worst kind of wrong.
  if (typeof role?.text !== 'string' || role.text.length === 0) {
    throw new Error('assemble-review-prompt: no role was handed in — serve one from roles/first-party (or an inhabitant) and pass it as `role`.');
  }
  // Thrown, not defaulted: a prompt naming the wrong artifact path sends the
  // engine's whole run to a file nobody reads, and it fails silently — the
  // reader reports "missing", which is indistinguishable from "never ran".
  const relPath = artifactPathFor(prNumber);
  const artifactPath = artifactRoot ? join(artifactRoot, relPath) : relPath;
  if (!['file', 'final-message'].includes(outputMode)) {
    throw new Error(`assemble-review-prompt: unsupported output mode ${JSON.stringify(outputMode)}`);
  }

  const diffCommand = baseRef && headRef
    ? `git diff ${baseRef}...${headRef}`
    : 'the diff of this pull request against its base branch';

  return `${role.text}

Review ${diffCommand} in the current working directory.${artifactRoot && isAbsolute(artifactPath) ? `

The working directory is a DETACHED CHECKOUT at the head this review is about.
It is not the operator's branch, and nothing you read here is affected by
whatever they have checked out or left uncommitted. The one path below is
absolute and deliberately points OUTSIDE this directory — that is where the
reader looks for your findings.

This working directory is snapshotted before you start and again after you
finish, and ANY added, removed, or changed path inside it — not just the one
you may have meant to touch — refuses publication of the whole review. So you
create, edit, and delete nothing under the working directory: no scratch files,
no notes, no installed modules, no test artefacts left behind. The only file
you write is the artifact path above, and it is OUTSIDE this directory
precisely so writing it cannot trip this rule. If you need scratch space for
anything — a downloaded dependency, an intermediate file, a note to yourself —
use the OS temp dir, never here.` : ''}

## What you must produce

${outputMode === 'file'
  ? `Write exactly one file: \`${artifactPath}\``
  : 'Return exactly the artifact bytes as your final message. Say nothing else.'}

It contains EXACTLY ONE fenced block, tagged \`${ARTIFACT_TAG}\`, whose content is
a JSON array of findings. **Two blocks with that tag are refused outright** and
your whole run is wasted — so do not echo the worked example below above your
own findings, and do not leave a second copy anywhere in the file. The TAG is
what selects the block — not a \`protocol:\` scalar inside it. A file carrying a
\`protocol: brain-review/...\` line is read by brain as a POSTED VERDICT and
corrupts the review's round counter, so the reader refuses any artifact
containing one.

Each finding may carry these fields, and only these — anything else is dropped
silently at the boundary:

${CARRIED_FIELDS.map((f) => `  - ${f}`).join('\n')}

  · \`severity\` — one of: ${SEVERITIES}
  · \`cites\` is MANDATORY when \`severity\` is \`blocker\`. An uncited blocker is
    downgraded to \`correction\` — cite an ADR, a REQ, a spec line, or a gate.
  · \`evidence_class\` is ALWAYS \`${FORCED_EVIDENCE_CLASS}\` — you reasoned to these findings;
    a gate did not compute them. It is not a choice, so do not state another
    value: \`evaluateInferential\` sets it and any other value you write is
    overwritten.
  · You do NOT state ${REFUSED_FIELDS.map((f) => `\`${f}\``).join(', ')}. A finding
    marked pre-existing leaves the blocking set entirely, so a producer stating
    its own disposition would be grading its own admissibility — and nothing
    downstream re-measures it for you. The field is not carried across this
    boundary; state it and it is dropped.
  · \`file\` and \`line\` together anchor a finding to a line of the diff, and that
    is what makes it appear as an inline comment on the pull request rather than
    only in the summary. Anchor everything you can.
  · \`evidence\` is what you MEASURED, not what you suspect. "X and Y render
    byte-identically, measured" is evidence. "This could be confusing" is not.

## The empty case is a real answer

If you find nothing, ${outputMode === 'file' ? 'write the file' : 'return the artifact'} with an empty array. "The reviewer ran and
found nothing" and "the reviewer never ran" are different states, and only the
first one is yours to report. Do not omit the file to signal that you found
nothing — an absent file reads as a failure and the verdict will say so.

## Example — the exact shape

\`\`\`${ARTIFACT_TAG}
[
  {
    "id": "cold-1",
    "severity": "blocker",
    "evidence_class": "inferential",
    "evidence": "readFindingsArtifact() returns {ok:false} on a missing file, and the caller at cli.mjs:557 destructures .findings without checking .ok — measured: an absent artifact yields findings=undefined and the verdict renders as if the control ran.",
    "cites": "REQ-S3-4",
    "file": "brain/scripts/review/cli.mjs",
    "line": 557
  },
  {
    "id": "cold-2",
    "severity": "correction",
    "evidence_class": "inferential",
    "evidence": "The migration's docstring says the default is empty, and the shipped defaults object is empty — but no test reads the shipped object, so the two are free to diverge. No anchor: the claim is about an absence, not a line."
  }
]
\`\`\`

The first finding anchors and becomes an inline comment. The second does not and
stays in the summary. Both are legitimate.

${outputMode === 'file' ? 'Write the file. Say nothing else — brain does not read your stdout.' : 'Return the artifact bytes. Say nothing else.'}
`;
}
