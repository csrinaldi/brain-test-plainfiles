// derive-review.mjs — the server-side sections of `brain:status`, and the one
// this port cannot answer yet (issue #280, slice 2). PURE: facts in, sections out.
//
// CONSUMES, NEVER DUPLICATES. #280 is explicit: *"verdict parsing, tasks
// conventions, and worktree layout are the existing ones; if a piece is missing
// upstream, the fix is upstream."* So the verdict here is read through
// `review/lib/parse-verdict.mjs` — the same parser the reviewer's own anti-loop
// lock reads with. A second implementation of "what is a verdict" would be the
// `one-rule-two-implementations` defect, and it would drift on the day the
// protocol grows a field.
//
// ── THE SECTION THIS PORT CANNOT ANSWER, AND WHY IT SAYS SO ─────────────────
//
// Standing items live in the tracker issue's index comment. The VCS port has
// `issueComment` — which WRITES — and **no verb that reads issue comments**
// (`vcs/cli.mjs`'s `VERBS`). So that fact is unreachable from inside the port.
//
// The alternatives were both worse. Calling `gh` directly would bypass the port
// in a command whose whole subject is what the port can and cannot see —
// reporting on a contract by breaking it. Rendering "no standing items" would
// state an absence nobody measured, which is the defect `evaluateForgeReach`
// refuses one layer down where an empty probe list is `indeterminate` and never
// `closed`.
//
// So it renders uncomputable and NAMES THE MISSING VERB. That is the honest
// shape, and it makes the gap visible to the person best placed to close it —
// which is what #280 means by "the fix is upstream".

import { field, uncomputable } from './report.mjs';
import { parseVerdict } from '../review/lib/parse-verdict.mjs';

/**
 * The last brain verdict on the PR, what it binds to, and whether the server's
 * head is the one on this disk.
 */
export function deriveReview({
  reviews = null, prHeadSha = null, localHeadSha = null, reason = null,
} = {}) {
  if (!Array.isArray(reviews)) {
    const why = reason ?? 'the pull request could not be read';
    return {
      title: 'Review state (server)',
      fields: [
        ['verdict', uncomputable(why)],
        ['rev', uncomputable(why)],
        ['verdict binds', uncomputable(why)],
        ['pr head vs local', uncomputable(why)],
      ],
    };
  }

  // Last parseable verdict wins: the thread is chronological and a later verdict
  // supersedes an earlier one, which is the same reading `verdictsAtHead` uses.
  let latest = null;
  for (const r of reviews) {
    const parsed = parseVerdict({ body: r?.body ?? '', author: r?.author ?? null });
    if (parsed) latest = parsed;
  }

  // NO VERDICT IS A FACT, NOT A FAILURE. A PR reviewed by a human and never by
  // brain is a normal state; rendering it uncomputable would report a failure
  // where there is none, and teach the operator to distrust the field.
  if (!latest) {
    return {
      title: 'Review state (server)',
      fields: [
        ['verdict', field('none posted')],
        ['rev', field('—')],
        ['verdict binds', field('—')],
        ['pr head vs local', headComparison(prHeadSha, localHeadSha)],
      ],
    };
  }

  const bindsTo = latest.head_sha;
  const stale = prHeadSha && bindsTo && prHeadSha !== bindsTo;
  return {
    title: 'Review state (server)',
    fields: [
      ['verdict', field(latest.verdict)],
      ['rev', field(latest.rev ?? '—')],
      // The fact an operator actually needs after a crash: the verdict they
      // remember may not describe the code they are looking at.
      ['verdict binds', field(
        stale
          ? `${bindsTo} — STALE, the PR head is ${prHeadSha}`
          : `${bindsTo}${prHeadSha ? ' (current)' : ''}`,
      )],
      ['pr head vs local', headComparison(prHeadSha, localHeadSha)],
    ],
  };
}

function headComparison(prHeadSha, localHeadSha) {
  if (!prHeadSha || !localHeadSha) {
    return uncomputable('one of the two heads is unknown, and this is a comparison');
  }
  return field(prHeadSha === localHeadSha
    ? 'agree'
    : `DIVERGE — server ${prHeadSha}, local ${localHeadSha}`);
}

/**
 * `resume.md`'s tail — the operational artefact whose designed audience is
 * exactly this reader: the human and the next implementer session, never the
 * reviewer (#280).
 *
 * THE TAIL, not the head: a returning human needs the last thing written, and a
 * long file's opening is the part they already know.
 */
export function deriveWorkingMemory({ resumeText = null, tailLines = 12 } = {}) {
  if (typeof resumeText !== 'string') {
    // ABSENT IS A FACT. Most changes have no resume.md and that is fine;
    // uncomputable would report a failure over a file nobody promised.
    return { title: 'Working memory', fields: [['resume.md (tail)', field('absent')]] };
  }
  const lines = resumeText.split('\n').filter((l) => l.trim() !== '');
  const tail = lines.slice(-tailLines);
  return {
    title: 'Working memory',
    fields: [['resume.md (tail)', field(tail.length ? `\n    ${tail.join('\n    ')}` : 'empty')]],
  };
}

/**
 * Standing items — open findings and pending human decisions, from the tracker
 * issue's index comment.
 *
 * UNREACHABLE TODAY, and it says which verb is missing rather than guessing.
 * See this module's header for why neither a bare `gh` call nor a cheerful
 * "none" was acceptable.
 */
export function deriveStandingItems({ items = null, reason = null } = {}) {
  if (!Array.isArray(items)) {
    return {
      title: 'Standing items',
      fields: [['open findings', uncomputable(
        reason ??
        'the VCS port has no verb that READS issue comments — `issueComment` writes only, ' +
        'so the tracker index comment is unreachable from inside the port (#699 owns the gap)',
      )]],
    };
  }
  return {
    title: 'Standing items',
    fields: [['open findings', field(items.length ? items.join('\n    ') : 'none')]],
  };
}
