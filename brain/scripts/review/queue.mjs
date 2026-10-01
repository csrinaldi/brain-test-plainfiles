// queue.mjs — REQ-H1-12: the review queue + escalation inbox (protocol §9's
// mailbox). Composes SHIPPED port verbs only — `mrList` (open PRs) →
// `prView` per PR (labels) — NO port change. Read-only: applies no labels,
// posts nothing.
//
// Ordering (owner ruling, issue #266 comment 5011731983, Option A): sorted
// by PR NUMBER ASCENDING. This is EXACT creation order, not a proxy — PR/
// issue numbers are monotonic counters assigned at creation by both GitHub
// and GitLab (verified against the fork 5011695053 and the verification
// comment 5011702460, finding H15B-FORK-BFREE), so ascending-number sort IS
// oldest-first with zero approximation error. The N+1 `prView` cost (one
// list call + one view call per open PR) is accepted at H1 scale (ruling
// §2, not optimized here); folding it into a single list read is deferred
// to the holistic prView/list-read unification fast-follow — see the
// durable record minted for this slice (`.memory/records/`).
//
// Escalation inbox (queue half, candidate 4993202904, decided IN by plan
// 5011584432): PRs carrying `needs-decision` are ALSO listed, as a separate
// section — pending human decisions the poster applies (see poster.mjs,
// H1-5b) on a verdict with `escalate: 'human'`.

import { getVcs } from '../vcs/cli.mjs';

const REVIEW_LABELS = new Set(['needs-review', 'needs-ruling']);
const ESCALATION_LABEL = 'needs-decision';

function byNumberAscending(a, b) {
  return a.number - b.number;
}

/**
 * Pure — given a list of `{ number, title, labels }`, splits into the
 * review queue (`needs-review`/`needs-ruling`) and the escalation inbox
 * (`needs-decision`), each sorted by PR number ascending (exact creation
 * order, ruling comment 5011731983). A PR may appear in both sections.
 * @param {Array<{ number: number, title?: string, labels?: string[] }>} prsWithLabels
 * @returns {{ reviewQueue: object[], escalations: object[] }}
 */
export function partitionQueue(prsWithLabels) {
  const reviewQueue = prsWithLabels
    .filter(pr => (pr.labels ?? []).some(l => REVIEW_LABELS.has(l)))
    .sort(byNumberAscending);
  const escalations = prsWithLabels
    .filter(pr => (pr.labels ?? []).includes(ESCALATION_LABEL))
    .sort(byNumberAscending);
  return { reviewQueue, escalations };
}

function defaultListOpenPrs({ getVcs: getVcsFn = getVcs } = {}) {
  return async ({ project, provider }) => (await getVcsFn({ provider })).mrList({ project, state: 'open' });
}

function defaultFetchLabels({ getVcs: getVcsFn = getVcs } = {}) {
  return async ({ project, number, provider }) => {
    const { labels } = await (await getVcsFn({ provider })).prView({ project, number });
    return labels ?? [];
  };
}

/**
 * Composes `mrList` (open PRs) + per-PR `prView` (labels) → `partitionQueue`.
 * Read-only — applies no labels, posts nothing (REQ-H1-12).
 * @param {{ project?: string, provider?: string, deps?: { listOpenPrs?: Function, fetchLabels?: Function } }} [args]
 * @returns {Promise<{ reviewQueue: object[], escalations: object[] }>}
 */
export async function gatherQueue({ project, provider, deps = {} } = {}) {
  const listOpenPrs = deps.listOpenPrs ?? defaultListOpenPrs(deps);
  const fetchLabels = deps.fetchLabels ?? defaultFetchLabels(deps);

  const prs = await listOpenPrs({ project, provider });
  const withLabels = [];
  for (const pr of prs) {
    const labels = await fetchLabels({ project, number: pr.number, provider });
    withLabels.push({ ...pr, labels });
  }
  return partitionQueue(withLabels);
}
