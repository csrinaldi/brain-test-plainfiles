// label-preflight.mjs — labelPreflight, the TOTAL (never-throws) policy
// wrapper over each provider's `labelList` (issue #334, vcs-label-preflight
// spec). Confirms a label exists in the remote's declared label set BEFORE a
// mutating write (mrCreateFn) — root-cause guard for #334: a derived
// mrCreate fixture would have re-encoded the same wrong belief that
// 'kind:feature' exists.
//
// Why this layer exists at all (design A2): the two providers DISAGREE on an
// unknown label. `gh pr create --label` hard-errors; GitLab's MR-create
// payload SILENTLY CREATES the missing label, polluting the project
// taxonomy. labelPreflight converts both into ONE uniform, local, actionable
// refusal before any write ever happens.
//
// Deliberately UNCACHED (unlike axes/vcs/adapters/*.mjs's `capabilities()` memo) —
// every call re-checks the remote, per spec.

import { labelList as githubLabelList } from '../axes/vcs/adapters/github.mjs';
import { labelList as gitlabLabelList } from '../axes/vcs/adapters/gitlab.mjs';

const PROVIDER_LABEL_LIST = {
  github: githubLabelList,
  gitlab: gitlabLabelList,
};

/**
 * Confirms whether `label` exists (exact, case-sensitive match) in the
 * remote's current label set. NEVER throws — any failure to compute the
 * answer (unsupported provider, a rejecting `labelListFn`/provider call)
 * resolves to `{ exists: false, error }`, i.e. FAILS CLOSED: an uncomputable
 * lookup must never be treated as "label exists" (that would silently let
 * GitLab create the label anyway — the exact defect this layer exists to
 * close).
 *
 * @param {{
 *   provider: string,
 *   project: string,
 *   label: string,
 *   labelListFn?: (opts: { project: string }) => Promise<string[]>,
 * }} opts
 * @returns {Promise<{ exists: boolean, error?: string }>}
 */
export async function labelPreflight({ provider, project, label, labelListFn }) {
  const listFn = labelListFn ?? PROVIDER_LABEL_LIST[provider];
  if (!listFn) {
    return { exists: false, error: `label-preflight: unsupported provider "${provider}"` };
  }

  let names;
  try {
    names = await listFn({ project });
  } catch (e) {
    return { exists: false, error: e.message };
  }

  return { exists: Array.isArray(names) && names.includes(label) };
}
