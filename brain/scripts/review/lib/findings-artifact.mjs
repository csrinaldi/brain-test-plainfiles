// findings-artifact.mjs — the file contract between the cold-review STAGE and
// `brain:review` (issue #682 slice 3, ADR-0033).
//
// The stage's engine writes `openspec/reviews/pr-NNN/cold-review.md`; this
// module reads it. The engine never posts: it has no VCS credential and no
// connection to the forge. Everything that touches the forge stays in the
// poster, where reviewer-protocol.md §2's three structural locks already live.
//
// ── WHY THE TAG IS THE SELECTOR, AND NOT `protocol:` ─────────────────────────
//
// #495 D1, carried into ADR-0032, splits fenced blocks into two families: one
// POSTED to the VCS (```yaml + `protocol: <name>`), one a FILE READ BY A VERB
// (```<name>, where the tag itself selects). This is the second.
//
// The rule is load-bearing, not stylistic. `parse-verdict.mjs` accepts any block
// whose `protocol:` reads `brain-review/1|2`, and `cold-boot.mjs` derives `rev`
// and holds the anti-loop lock from the verdict blocks it finds. An artifact
// written in the first family's shape becomes, once committed, a verdict block
// living in the repo — corrupting a count that decides whether a review may run
// at all. So a block carrying that shape is REFUSED here by name.
//
// ── WHY THE PAYLOAD IS JSON, MEASURED RATHER THAN PREFERRED ──────────────────
//
// The obvious move is to reuse the verdict's own findings encoding. Measured on
// `main @ fb96485`, against `parse-verdict.mjs`'s list reader:
//
//   findings list at 2-space indent (what renderVerdict emits) → 1 entry
//   the same list at 0 indent (what `yaml.dump` emits by default) → 0 entries
//   the same list at 4-space indent                              → 0 entries
//
// Its entry regexes are anchored to the exact indentation of one emitter, and a
// list it cannot read comes back as EMPTY rather than as uncomputable. That is
// survivable for a block this repo's own renderer produced; it is not survivable
// for a file written by a model, where indentation is exactly the detail no one
// controls. A dropped finding must never be reachable by a whitespace choice.
//
// JSON has one spelling, escapes its own newlines, and `evidence` in a real cold
// review is paragraphs long.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fencedBlocks } from '../../lib/fenced-blocks.mjs';
import { CARRIED_FIELDS, sanitiseFinding } from '../evaluators/inferential.mjs';

/** The tag that selects this artifact's block. The tag IS the selector (#495 D1). */
export const ARTIFACT_TAG = 'brain-findings/1';

/** The shape this reader refuses out loud, and the reason it exists. */
const POSTED_FAMILY_RE = /^\s*protocol:\s*brain-review\//m;

/**
 * The severity vocabulary, and the ONE place it is enforced.
 *
 * `cold-review-prompt.mjs` used to note that no such constant existed and that
 * adding one "that no validator reads would create the very thing this file
 * avoids" — three values enforced by scattered comparisons and written down in
 * `reviewer-protocol.md`. That objection was right, and judgment:cold-2 removed
 * its premise: this reader now REFUSES on a value outside the set, so the
 * constant has a reader and the prompt derives its menu from here instead of
 * spelling it.
 *
 * `assemble-review-prompt.test.mjs` cross-checks this against the protocol
 * document's own `severity:` line, so the constant cannot drift from the
 * doctrine that defines it.
 */
export const ALLOWED_SEVERITIES = Object.freeze(['blocker', 'correction', 'editorial']);

/**
 * readFindingsArtifact() — PURE over the artifact's text.
 *
 * Four answers, and the first three are FAILURES rather than empty results
 * (REQ-S3-4). `cli.mjs` refuses to post on a failure: a verdict declaring the
 * inferential control applied over findings nobody produced is the
 * uncomputable-evidence APPROVE §10 forbids, and "the file was not there" and
 * "the reader found nothing" are different states that must not render alike.
 * That distinction is the whole of #552, one layer up.
 *
 * @param {string|null|undefined} text
 * @returns {{ok: true, findings: object[]} | {ok: false, reason: string}}
 */
export function readFindingsArtifact(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'the artifact is missing or empty' };
  }

  // Checked BEFORE block selection: a file may carry the posted family's shape
  // without ever declaring our tag, and that file is still the hazard.
  if (POSTED_FAMILY_RE.test(text)) {
    return {
      ok: false,
      reason:
        'the artifact carries a `protocol: brain-review/...` line — that is the shape of a ' +
        'block POSTED to the VCS, and parse-verdict.mjs would read this file as a verdict, ' +
        `corrupting rev and the anti-loop lock. A repo file declares itself by its FENCE TAG: ` +
        `use a \`\`\`${ARTIFACT_TAG} block (#495 D1, ADR-0032).`,
    };
  }

  const { blocks } = fencedBlocks(text);
  const found = blocks.filter((b) => b.tag === ARTIFACT_TAG);

  if (found.length === 0) {
    return { ok: false, reason: `no \`\`\`${ARTIFACT_TAG} block in the artifact` };
  }
  // Two blocks are an authoring mistake with no safe resolution: picking the
  // first would silently drop findings, and merging would invent an order the
  // author did not write.
  if (found.length > 1) {
    return { ok: false, reason: `${found.length} \`\`\`${ARTIFACT_TAG} blocks — expected exactly 1` };
  }

  let payload;
  try {
    payload = JSON.parse(found[0].content);
  } catch (err) {
    return { ok: false, reason: `the ${ARTIFACT_TAG} block is not valid JSON: ${err.message}` };
  }

  const list = Array.isArray(payload) ? payload : payload?.findings;
  if (!Array.isArray(list)) {
    return {
      ok: false,
      reason: `the ${ARTIFACT_TAG} block must be a JSON array of findings, or an object with a "findings" array`,
    };
  }
  if (!list.every((f) => f !== null && typeof f === 'object' && !Array.isArray(f))) {
    return { ok: false, reason: `every entry of ${ARTIFACT_TAG} must be an object` };
  }

  // SEVERITY IS THE ONE FIELD WHOSE VALUE DECIDES WHETHER A FINDING BLOCKS, and
  // until the fifth cold review it was carried across this boundary unread
  // (judgment:cold-2). The reader validated the field SET and no field's VALUE,
  // while the vocabulary reached a NON-DETERMINISTIC producer as prompt prose.
  //
  // MEASURED on the shipped modules: `severity: 'critical'` — the obvious
  // near-miss for `blocker` — passed here, survived `sanitiseFinding`, kept its
  // value through `evaluateInferential`, and `buildVerdict` returned `null`
  // where the identical finding spelled `blocker` returns `REVISE`. It also
  // escapes the challenger: `refuter.mjs` selects its batch on
  // `severity === 'blocker'`. So a mislabelled blocker is neither blocked nor
  // refuted, and nothing anywhere reported that the vocabulary was violated —
  // #552's fold at the exact boundary this slice exists to prevent it:
  // "the reviewer found a blocker and spelled it wrong" rendered byte-identically
  // to "the reviewer found nothing blocking".
  //
  // IT REFUSES RATHER THAN COERCES, and that is the whole ruling. The other two
  // vocabularies at this boundary are handled by knowing the answer:
  // `evidence_class` is FORCED (the evaluator knows every finding here is
  // reasoned) and `causal_disposition` is DROPPED (a producer may not grade its
  // own admissibility). Severity is neither — brain does NOT know how heavy a
  // finding is, so it can neither supply nor correct the value. Coercing up
  // would invent a weight; coercing down would silently weaken the verdict,
  // which is the direction that already hurt. Refusing is the same channel the
  // reader already uses for two blocks and for the posted-family shape.
  const badSeverity = list.find((f) => !ALLOWED_SEVERITIES.includes(f?.severity));
  if (badSeverity) {
    return {
      ok: false,
      reason:
        `a finding carries severity ${JSON.stringify(badSeverity.severity ?? null)}, which is not one of ` +
        `${ALLOWED_SEVERITIES.join(' | ')}. Refusing the whole artifact rather than carrying it: severity ` +
        'decides whether a finding blocks, brain cannot know the right value, and a near-miss like ' +
        '"critical" reads downstream as a finding that blocks nothing.',
    };
  }

  // Projected onto CARRIED_FIELDS here, at the boundary, so a generator that
  // grows a field does not widen it by existing (REQ-682-4). The membership
  // oracle is not this list — see inferential.mjs.
  return { ok: true, findings: list.map(sanitiseFinding) };
}

/** The fields an artifact entry may carry. Re-exported so a writer has one import. */
export { CARRIED_FIELDS };

// ── the file layer: where the stage writes, and what "absent" means ──────────

/** Where review artifacts live. Keyed by PR, because a review reads a DIFF. */
export const REVIEWS_ROOT = 'openspec/reviews';

/**
 * artifactPathFor() — the repo-relative path for one PR's artifact.
 *
 * The number is re-validated HERE even though `cli.mjs` already checked its
 * argv (`args.pr`): this value becomes a path segment, and a boundary that
 * trusts its caller's validation is a boundary that stops being one the day a
 * second caller appears. `pr-../../etc` is not a PR number.
 *
 * @param {number|string} prNumber
 * @returns {string}
 * @throws {Error} on anything that is not a positive integer
 */
export function artifactPathFor(prNumber) {
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `findings-artifact: ${JSON.stringify(prNumber)} is not a PR number — refusing to build a path from it.`
    );
  }
  return join(REVIEWS_ROOT, `pr-${n}`, 'cold-review.md');
}

/**
 * makeArtifactGenerate() — a `deps.generate` that reads a file instead of
 * calling a model (slice A; the spawn is slice B).
 *
 * THE THREE STATES, AND WHY THE FIRST IS NOT A FAILURE:
 *
 *   file absent    → `null`. The caller then supplies no `generate`, `shouldRun`
 *                    is false, and the verdict carries "enabled but no transport
 *                    is configured" — the state that ships today. A repo that
 *                    never ran the stage has not failed at anything.
 *   file present,
 *   unreadable     → a function that THROWS. `gatherInferentialInputs` catches
 *                    it into `{failed: true, reason}` and `cli.mjs` refuses to
 *                    post. An artifact that exists and cannot be read is a
 *                    transport that ran and broke — never "found nothing".
 *   file present,
 *   readable       → a function returning the sanitised findings, `[]` included.
 *
 * The middle state is the one worth the words: it is why the reader's refusal is
 * raised rather than returned. The existing failure path already fails closed on
 * a throw, so mapping onto it adds no second mechanism to keep honest.
 *
 * @param {{prNumber: number|string, root?: string, deps?: {exists?: Function, readFile?: Function}}} args
 * @returns {(() => Promise<object[]>)|null}
 */
export function makeArtifactGenerate({ prNumber, root = process.cwd(), deps = {} } = {}) {
  const exists = deps.exists ?? ((p) => existsSync(join(root, p)));
  const readFile = deps.readFile ?? ((p) => readFileSync(join(root, p), 'utf8'));

  const relPath = artifactPathFor(prNumber);
  if (!exists(relPath)) return null;

  return async () => {
    const result = readFindingsArtifact(readFile(relPath));
    if (!result.ok) {
      throw new Error(`the cold-review artifact at ${relPath} could not be read — ${result.reason}`);
    }
    return result.findings;
  };
}
