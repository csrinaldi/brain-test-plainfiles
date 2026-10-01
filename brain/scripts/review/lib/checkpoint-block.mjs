// checkpoint-block.mjs — the `brain-checkpoint/1` protocol: a checkpoint
// report's budget claim, DECLARED rather than inferred (issue #495).
//
// Emitter and inverse live in ONE module, following `decision-block.mjs` and
// deliberately NOT the `verdict.mjs` / `parse-verdict.mjs` split, which is a
// historical accident that has already cost this repo two drift bugs (#381,
// #452). One module cannot be edited half-way; two files can.
//
// WHAT THIS REPLACED, and why the shape is what it is. `parseBudgetClaim`
// scanned the ENTIRE report for any `N/M` whose `M` was a budget some tier
// declares. That rejected the shapes brain's reports actually contain — test
// counts (`1269/1269`), slice counts, version pairs — and could not reject a
// sentence that merely mentions another tier's budget. Four such sentences are
// pinned in the test file; one is verbatim from `governance-tiers.test.mjs`, and
// one is exactly what a report DISCUSSING this change would write. Each produced
// a `drift:counted-lines-budget` BLOCKER whose `evidence:` quoted a claim the
// report never made — a false block carrying invented evidence, which
// reviewer-protocol.md §6 forbids more sharply than it forbids silence.
//
// The maintainer ruled option 1 on issue #495: anchor to a declared line and
// parse only that. Prose is not narrowed — it is NOT READ.
//
// THREE ANSWERS, NEVER TWO. `absent` is distinct from plain `!ok` because the
// two produce different sentences for the author: "this report predates the
// declared form" versus "your block is wrong". And neither is `null`, because
// `null` would be indistinguishable from "made no claim" — this ticket's own
// defect, one level up, inside its fix. That is ruling point 2, and the shape is
// `parseAmendmentDraft`'s, key for key.

import { fencedBlocks } from '../../lib/fenced-blocks.mjs';
import { scalar } from './yaml-block.mjs';

/** The fence info-string that marks a declared budget claim. */
export const CHECKPOINT_TAG = 'brain-checkpoint/1';

/** The two required keys, in emission order. */
export const CLAIM_KEYS = Object.freeze(['counted_lines', 'diff_budget']);

const err = (error) => ({ ok: false, error });
const absent = (error) => ({ ok: false, absent: true, error });

/**
 * Renders the declared block. `checkpoint-report.md` carries exactly one.
 *
 * @param {{countedLines: number, diffBudget: number}} claim
 * @returns {string}
 */
export function renderCheckpointClaim({ countedLines, diffBudget } = {}) {
  return [
    '```' + CHECKPOINT_TAG,
    `counted_lines: ${countedLines}`,
    `diff_budget: ${diffBudget}`,
    '```',
  ].join('\n');
}

/**
 * Reads a non-negative integer scalar out of a block, refusing anything else.
 *
 * Values are read with `yaml-block.mjs`'s `scalar` — the neutral `key: value`
 * reader this repo already shares — rather than a third key parser. What is NOT
 * borrowed is `parseContractFields`'s unknown-key rejection: an extra line in a
 * checkpoint report is not the hazard here, a MISSPELLED required key is, and
 * that is caught by requiring both keys below (`counted-lines:` with a hyphen
 * leaves `counted_lines` absent, which is an error, not a shrug).
 */
function integerField(content, key) {
  // `scalar` returns the FIRST match, so a key stated twice would silently
  // resolve to one of them. Two values for one key is ambiguity, and the whole
  // point of this contract is that the reviewer stops picking.
  const occurrences = content.split(/\r?\n/).filter((l) => new RegExp(`^${key}:`).test(l.trim())).length;
  if (occurrences > 1) return err(`\`${key}:\` appears more than once — a claim is stated once.`);

  const raw = scalar(content, key);
  if (raw === null) return err(`the \`${CHECKPOINT_TAG}\` block is missing the required \`${key}:\` key.`);
  if (!/^(0|[1-9][0-9]*)$/.test(raw.trim())) {
    return err(`\`${key}:\` must be a non-negative integer, got '${raw.trim()}'.`);
  }
  return { ok: true, value: Number(raw.trim()) };
}

/**
 * Parses the declared budget claim out of a checkpoint report.
 *
 * Never throws. Never returns `null`.
 *
 * @param {string} reportText
 * @returns {{ok: true, countedLines: number, diffBudget: number}
 *          |{ok: false, absent: true, error: string}
 *          |{ok: false, error: string}}
 */
export function parseCheckpointClaim(reportText) {
  if (typeof reportText !== 'string' || reportText.length === 0) {
    return absent(`no \`${CHECKPOINT_TAG}\` block found (the report is empty or unreadable).`);
  }

  const { blocks, unterminated } = fencedBlocks(reportText);

  const declared = blocks.filter((b) => b.tag === CHECKPOINT_TAG);

  if (declared.length === 0) {
    // An unterminated fence carrying THIS tag is a truncated claim, not a
    // missing one — the same distinction `parseAmendmentDraft` draws, and for
    // the same reason: it sends the author looking for the right mistake.
    if (unterminated && unterminated.tag === CHECKPOINT_TAG) {
      return err(
        `the \`${CHECKPOINT_TAG}\` block opened at report line ${unterminated.line} is never closed.`,
      );
    }
    return absent(
      `no \`${CHECKPOINT_TAG}\` block found — this report states no machine-readable budget claim. ` +
      'Reports written before #495 are all in this state; the claim cannot be checked against the tree.',
    );
  }

  if (declared.length > 1) {
    return err(`${declared.length} \`${CHECKPOINT_TAG}\` blocks found — a report states its claim exactly once.`);
  }

  const content = declared[0].content;
  const counted = integerField(content, 'counted_lines');
  if (!counted.ok) return counted;
  const budget = integerField(content, 'diff_budget');
  if (!budget.ok) return budget;

  return { ok: true, countedLines: counted.value, diffBudget: budget.value };
}
