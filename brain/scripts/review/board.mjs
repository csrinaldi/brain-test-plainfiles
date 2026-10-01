// board.mjs — REQ-H1-13: rebuild seq:*/reviewed:* from the brain-review/1
// verdict blocks (protocol §9 — verdicts are truth, labels are the derived
// index; design.md §7). Composes `mrList` (open PRs) + per-PR `prReviews`
// (the verdict thread) + `prView` (current labels) → `parseVerdict` → the
// LATEST verdict on each thread determines the desired seq:*/reviewed:*
// label set → reconciled against the PR's current labels via
// `guardedLabelAdd`/`guardedLabelRemove` (deny-set.mjs), strictly within
// those two namespaces. A label desync is a rebuildable no-op — the board
// never trusts the label state, it recomputes it cold from the thread.
//
// `sequencing` (optional, protocol §6: "seq:* / reviewed:* only, never
// status:*") is read from the latest parsed verdict when present — no H1
// evaluator emits it yet (H1-2..H1-4 leave `sequencing` unset), so in
// today's tree this contributes nothing; the reconciliation path exists and
// is tested so the first evaluator that DOES set it needs no board change.

import { getVcs } from '../vcs/cli.mjs';
import { gitlabApiConfig } from '../vcs/ci-context.mjs';
import { parseVerdict } from './lib/parse-verdict.mjs';
import { guardedLabelAdd, guardedLabelRemove } from './deny-set.mjs';

const BOARD_PREFIXES = ['seq:', 'reviewed:'];

/**
 * Pure — denormalizes a verdict scalar (APPROVE|REVISE|STOP) to the
 * `reviewed:*` label it implies (spec.md REQ-H1-13's `reviewed:approved`
 * example, extended with the same past-tense convention for the other two
 * conclusions). An unrecognized/missing verdict yields `null` — nothing to
 * denormalize.
 * @param {string} [verdict]
 * @returns {string|null}
 */
export function reviewedLabelForVerdict(verdict) {
  switch (verdict) {
    case 'APPROVE': return 'reviewed:approved';
    case 'REVISE': return 'reviewed:revised';
    case 'STOP': return 'reviewed:stopped';
    default: return null;
  }
}

function inBoardNamespace(label) {
  return BOARD_PREFIXES.some(prefix => label.startsWith(prefix));
}

/**
 * Pure — given the latest parsed verdict on a thread and the PR's current
 * labels, computes what to add/remove to reconcile `seq:*`/`reviewed:*`
 * (protocol §9). Only labels within those two namespaces are ever touched;
 * anything else present on the PR (`decision`, `status:approved`, ...) is
 * left alone even when it is not part of the "desired" set.
 *
 * #477, second half of the maintainer ruling — an UNREADABLE field is not an
 * empty one. `parseVerdict` reports what it could not read on `malformed`; a
 * consumer that ignores it turns the parser's honesty back into the defect,
 * which is why the ruling made this half binding rather than optional.
 *
 * `sequencing` is the field that matters here, and it is the one member of the
 * family with a DESTRUCTIVE reader: this function used to read
 * `latestVerdict.sequencing ?? []`, so an unreadable value produced an empty
 * desired set and every real `seq:*` label on the PR was scheduled for
 * deletion — by name, off evidence nobody could read. Protocol §10 forbids
 * concluding on uncomputable evidence; deleting on it is the same inversion
 * with a write at the end.
 *
 * So `seq:*` becomes UNCOMPUTABLE, not empty: no add, no remove, and the fact
 * is returned rather than left to be inferred from an absence. `reviewed:*` is
 * deliberately NOT frozen with it — it derives from `verdict:`, which is
 * mandatory and readable (`parseVerdict` answers `null` for a block missing
 * it), so freezing it would refuse work that IS computable.
 *
 * @param {{ latestVerdict: object|null, currentLabels?: string[] }} [args]
 * @returns {{ toAdd: string[], toRemove: string[], unreadable: string[] }}
 *   `unreadable` names every field the verdict carried and the parser could not
 *   read — including fields this function does not consume, so the state is
 *   reported rather than silently folded into "nothing to do".
 */
export function reconcileBoardLabels({ latestVerdict, currentLabels = [] } = {}) {
  if (!latestVerdict) return { toAdd: [], toRemove: [], unreadable: [] };

  const unreadable = Array.isArray(latestVerdict.malformed) ? latestVerdict.malformed : [];
  const sequencingUnreadable = unreadable.includes('sequencing');

  const desired = new Set();
  const reviewedLabel = reviewedLabelForVerdict(latestVerdict.verdict);
  if (reviewedLabel) desired.add(reviewedLabel);
  // The flag WINS over any value present beside it. `parseVerdict` never emits
  // both (an unreadable field is omitted), so this branch is unreachable from
  // that producer — but this function is exported and pure, and a caller
  // assembling a verdict by hand must not be able to reintroduce the defect by
  // supplying a half-read value. Pinned by test rather than left as an
  // unexercised belt: the first mutation run proved the filter below already
  // carried the parser-driven case alone.
  if (!sequencingUnreadable) {
    for (const seqLabel of latestVerdict.sequencing ?? []) desired.add(seqLabel);
  }

  // Held OUT of the reconciliation entirely when their input was unreadable —
  // not compared against an empty desired set, which is what produced the
  // deletions. Absent from both `toAdd` and `toRemove` means "the board did not
  // form an opinion", the only honest answer available here.
  const currentInNamespace = currentLabels
    .filter(inBoardNamespace)
    .filter(label => !(sequencingUnreadable && label.startsWith('seq:')));

  const toAdd = [...desired].filter(label => !currentInNamespace.includes(label));
  const toRemove = currentInNamespace.filter(label => !desired.has(label));

  return { toAdd, toRemove, unreadable };
}

function defaultListOpenPrs({ getVcs: getVcsFn = getVcs } = {}) {
  return async ({ project, provider }) => (await getVcsFn({ provider })).mrList({ project, state: 'open' });
}

function defaultFetchPr({ getVcs: getVcsFn = getVcs } = {}) {
  return async ({ project, number, provider }) => (await getVcsFn({ provider })).prView({ project, number });
}

// Mirrors cold-boot.mjs's defaultFetchReviews — same `prReviews` verb, same
// gitlab API-config wiring.
function defaultFetchReviews({ getVcs: getVcsFn = getVcs } = {}) {
  return async ({ project, number, provider }) => {
    const vcs = await getVcsFn({ provider });
    const { apiBase, token, proxyUrl } = gitlabApiConfig();
    const reviews = await vcs.prReviews({ project, number, apiBase, token, proxyUrl });
    return reviews ?? [];
  };
}

/**
 * Reconciles ONE PR's `seq:*`/`reviewed:*` labels against its verdict
 * thread. Makes ZERO write calls when already in sync.
 * @param {{ project?: string, number: number, provider?: string, deps?: object }} args
 * @returns {Promise<{ number: number, toAdd: string[], toRemove: string[] }>}
 */
export async function reconcileOnePr({ project, number, provider, deps = {} } = {}) {
  const fetchPr = deps.fetchPr ?? defaultFetchPr(deps);
  const fetchReviews = deps.fetchReviews ?? defaultFetchReviews(deps);
  const getVcsFn = deps.getVcs ?? getVcs;

  const [prView, reviews] = await Promise.all([
    fetchPr({ project, number, provider }),
    fetchReviews({ project, number, provider }),
  ]);
  const verdicts = reviews.map(r => parseVerdict(r)).filter(Boolean);
  const latestVerdict = verdicts.length > 0 ? verdicts[verdicts.length - 1] : null;

  const { toAdd, toRemove, unreadable } = reconcileBoardLabels({ latestVerdict, currentLabels: prView.labels ?? [] });
  // `unreadable` rides the zero-write path too (#477). An unreadable verdict
  // usually HAS nothing to write — that is the whole point of freezing the
  // namespace — so dropping the report here would put the silence back exactly
  // where the ruling took it out.
  if (toAdd.length === 0 && toRemove.length === 0) return { number, toAdd, toRemove, unreadable };

  const vcs = await getVcsFn({ provider });
  if (toAdd.length > 0) await guardedLabelAdd(vcs, { project, number, labels: toAdd });
  if (toRemove.length > 0) await guardedLabelRemove(vcs, { project, number, labels: toRemove });
  return { number, toAdd, toRemove, unreadable };
}

/**
 * Composes `mrList` (open PRs) + `reconcileOnePr` for each (REQ-H1-13).
 * @param {{ project?: string, provider?: string, deps?: object }} [args]
 * @returns {Promise<Array<{ number: number, toAdd: string[], toRemove: string[] }>>}
 */
export async function runBoard({ project, provider, deps = {} } = {}) {
  const listOpenPrs = deps.listOpenPrs ?? defaultListOpenPrs(deps);
  const prs = await listOpenPrs({ project, provider });

  const results = [];
  for (const pr of prs) {
    results.push(await reconcileOnePr({ project, number: pr.number, provider, deps }));
  }
  return results;
}
