// normalize.mjs — Shared normalization helpers for VCS providers.
//
// Providers map their host-native shapes to the normalized contract defined in
// brain/core/methodology/vcs-contract.md. These helpers hold the cross-provider
// mappings so each provider doesn't re-implement them. Pure functions — unit
// tested in brain/scripts/vcs/cli.test.mjs.

// Canonical commit-status enum (GitLab style). Providers map their native enum
// to one of these. `null` means "no status available".
export const COMMIT_STATUS = ['success', 'failed', 'running', 'pending', 'canceled'];

// GitHub check-run/commit-status values → canonical enum.
const GITHUB_STATUS_MAP = {
  success: 'success',
  failure: 'failed',
  error: 'failed',
  cancelled: 'canceled',
  canceled: 'canceled',
  timed_out: 'failed',
  action_required: 'pending', // approval gate blocking the run — closest fit is pending (not 'failed')
  pending: 'pending',
  in_progress: 'running', // a check actively running — distinct from queued/pending
  queued: 'pending',
  neutral: null,
  skipped: null,
};

/**
 * Normalizes a provider-native commit/check status to the canonical enum.
 * @param {'github'|'gitlab'} provider
 * @param {string|null|undefined} raw
 * @returns {'success'|'failed'|'running'|'pending'|'canceled'|null}
 */
export function normalizeCommitStatus(provider, raw) {
  if (raw == null) return null;
  if (provider === 'github') return GITHUB_STATUS_MAP[raw] ?? null;
  // GitLab is already canonical, but guard against unknown values.
  return COMMIT_STATUS.includes(raw) ? raw : null;
}

/**
 * Normalizes an issue/MR state filter to the wire value a provider expects.
 * The contract uses 'open'; GitLab's API wants 'opened'.
 * @param {'github'|'gitlab'} provider
 * @param {string} state  Canonical state ('open' | 'closed' | ...).
 * @returns {string}
 */
export function providerState(provider, state = 'open') {
  if (provider === 'gitlab') return state === 'open' ? 'opened' : state;
  return state;
}

/**
 * Normalizes a provider's assignee payload to `string[] | null` (issue #533).
 *
 * ABSENT IS NOT EMPTY, and this helper exists because collapsing the two is the
 * defect the ticket was opened over. `[]` means the fetch SUCCEEDED and nobody is
 * assigned; `null` means the payload carried no assignee field at all and brain
 * cannot see. A reader shown `[]` for both would read "nobody is on this" when the
 * truth is "brain does not know" — `evidence-reader-empty-on-failure`, on the half
 * of the map that makes it actionable.
 *
 * Both providers expose a plural array AND a legacy singular. The singular is read
 * only when the plural key is missing entirely: on GitLab CE the array is present
 * and capped at one, so preferring it costs nothing there and is required on the
 * tiers that carry several.
 *
 * @param {object} raw           The provider's issue payload.
 * @param {'login'|'username'} key  The provider's user-name field.
 * @returns {string[]|null}
 */
export function normalizeAssignees(raw, key) {
  if (!raw || typeof raw !== 'object') return null;
  if (Array.isArray(raw.assignees)) {
    return raw.assignees.map(a => a?.[key]).filter(n => typeof n === 'string');
  }
  // No plural key. A singular one still answers the question; nothing at all does not.
  if (raw.assignee && typeof raw.assignee[key] === 'string') return [raw.assignee[key]];
  if (raw.assignee === null && 'assignee' in raw) return [];
  return null;
}

/**
 * Normalizes an assignee filter ('me' | 'none' | undefined) to provider syntax.
 * Returns an object of query params to merge into the request, so each provider
 * stays declarative.
 * @param {'github'|'gitlab'} provider
 * @param {'me'|'none'|undefined} assignee
 * @param {string} [currentUser] Required by GitLab for the 'me' case.
 * @returns {object}
 */
export function assigneeParams(provider, assignee, currentUser) {
  if (!assignee) return {};
  if (provider === 'gitlab') {
    if (assignee === 'none') return { assignee_id: 'None' };
    if (assignee === 'me') return { assignee_username: currentUser };
  }
  if (provider === 'github') {
    return { assignee: assignee === 'me' ? (currentUser ?? '@me') : 'none' };
  }
  return {};
}
