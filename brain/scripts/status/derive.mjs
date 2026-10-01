// derive.mjs — facts in, report sections out. PURE (issue #280, slice 1).
//
// THE TICKET IS THE SPINE. Ruled on #280 before implementation: the issue is the
// authority and everything read from disk is local evidence that may have
// drifted from it. Measured on this repository over nine days, four artefacts
// stated something false and none of them was wrong when written —
// `ROADMAP-M5-M8.md` twice, a branch cut before #316 reversed the `.env`
// precedence it documented, and `issue-682`'s `tasks.md`, which left `C.6`
// unchecked while the issue itself was `closed/completed`.
//
// The ticket was right all four times. An issue is the only one of those a human
// updates as a DECISION rather than a snapshot someone has to remember to
// refresh.
//
// So divergence is not noise here, it is the product. Nothing said those four
// disagreed with reality; each was found by reading both sides by hand.
//
// EVERY DERIVATION IS PURE and takes facts rather than fetching them, for the
// reason the whole repo keeps re-learning: an oracle that reads the world cannot
// be tested against a world it did not read. The I/O lives in `cli.mjs`.

import { field, uncomputable } from './report.mjs';

/**
 * The issue, at the top, because a reader learns what is TRUE before they learn
 * what is on their disk.
 */
export function deriveTicket({ issue = null, reason = null } = {}) {
  if (!issue) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(
        'status/derive: deriveTicket needs an issue or a reason. A section rendering ' +
        '"uncomputable ()" reaches the operator looking like an answer and carries none.',
      );
    }
    return {
      title: 'Ticket',
      fields: [
        ['state', uncomputable(reason)],
        ['labels', uncomputable(reason)],
      ],
    };
  }
  const state = issue.stateReason ? `${issue.state} (${issue.stateReason})` : issue.state;
  return {
    title: `Ticket #${issue.number}`,
    fields: [
      ['title', field(issue.title ?? '—')],
      ['state', field(state)],
      ['labels', field((issue.labels ?? []).join(' · ') || '—')],
    ],
  };
}

/** Where the local branch sits. `null` for a fact git could not answer. */
export function deriveChain({ branch, ahead, behind, dirtyFiles, pushed } = {}) {
  const num = (v, why) => (typeof v === 'number' ? field(v) : uncomputable(why));
  return {
    title: 'Chain position (local)',
    fields: [
      ['branch', typeof branch === 'string' ? field(branch) : uncomputable('git could not name HEAD')],
      ['ahead of tracker', num(ahead, 'git log tracker..HEAD did not answer')],
      ['behind tracker', num(behind, 'git log HEAD..tracker did not answer')],
      // ZERO IS A VALUE. "no dirty files" is a fact; collapsing it into absence
      // is how a clean tree and an unreadable one come to look the same.
      ['dirty files', num(dirtyFiles, 'git status did not answer')],
      ['pushed', typeof pushed === 'boolean' ? field(pushed ? 'yes' : 'no') : uncomputable('no upstream to compare against')],
    ],
  };
}

/** What `tasks.md` claims. Claims — the ticket is what decides. */
export function deriveTasks({ tasksText = null, reason = null } = {}) {
  if (typeof tasksText !== 'string') {
    const why = reason ?? 'no tasks.md was read';
    return {
      title: 'Tasks (local artefact)',
      fields: [['checked', uncomputable(why)], ['open', uncomputable(why)], ['next', uncomputable(why)]],
    };
  }
  const lines = tasksText.split('\n');
  const checked = lines.filter((l) => /^\s*- \[x\]/i.test(l)).length;
  const openLines = lines.filter((l) => /^\s*- \[ \]/.test(l));
  const next = openLines[0]?.replace(/^\s*- \[ \]\s*/, '').trim();
  return {
    title: 'Tasks (local artefact)',
    fields: [
      ['checked', field(checked)],
      ['open', field(openLines.length)],
      ['next', field(next || '—')],
    ],
  };
}

/**
 * deriveDivergence() — where the local evidence and the authority disagree.
 *
 * DIVERGENCE IS A RELATION, so it cannot be derived from one side. With no
 * ticket it is uncomputable, never "no divergence": reporting agreement nobody
 * measured is the defect `evaluateForgeReach` refuses one layer down, where an
 * empty probe list is `indeterminate` and never `closed`.
 *
 * IT REPORTS AND NEVER RECONCILES. #280's non-goals are explicit — this command
 * writes nothing. Naming the disagreement is the whole job; fixing it is a
 * human's, and which side to fix is never in doubt: the ticket wins.
 */
export function deriveDivergence({ issue = null, openTasks = null, headPushed = null, reason = null } = {}) {
  const fields = [];

  if (!issue) {
    const why = reason ?? 'the ticket could not be read, and divergence needs both sides';
    fields.push(['tasks vs ticket', uncomputable(why)]);
  } else if (typeof openTasks !== 'number') {
    fields.push(['tasks vs ticket', uncomputable('tasks.md could not be read, and divergence needs both sides')]);
  } else {
    const closed = issue.state === 'closed';
    fields.push(['tasks vs ticket', field(
      closed && openTasks > 0
        // The measured case: issue-682's C.6, unchecked, on a closed ticket.
        ? `DIVERGE — ticket is closed and tasks.md has ${openTasks} open; the ticket wins, the artefact is stale`
        : `agree (ticket ${issue.state}, ${openTasks} open)`,
    )]);
  }

  fields.push(['local vs server', typeof headPushed === 'boolean'
    ? field(headPushed ? 'agree (head is pushed)' : 'DIVERGE — local commits are not pushed; the server cannot see them')
    : uncomputable('no upstream to compare against')]);

  return { title: 'Divergence', fields };
}
