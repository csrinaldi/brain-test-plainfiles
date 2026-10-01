// github.mjs — GitHub provider (gh CLI). Implements brain/core/methodology/vcs-contract.md.
//
// All verbs return the NORMALIZED shapes from the contract (number, body,
// headBranch, username, canonical commit-status enum). Auth uses the gh session
// (ensured by day:start) unless the port was obtained with a bound identity
// (issue #501), in which case every call carries that credential instead.

import { run, runJson } from '../../../vcs/lib/exec.mjs';
import { classifyProbe } from '../../../vcs/capability-report.mjs';
import { normalizeCommitStatus, providerState, assigneeParams, normalizeAssignees } from '../../../vcs/lib/normalize.mjs';
import { vcsToken } from '../../../vcs/lib/token.mjs';
import { currentIdentity } from '../../../vcs/lib/identity-context.mjs';
import { assertNoApprovalLabel } from '../../../vcs/lib/approval-deny.mjs';
import { uncomputable, UNCOMPUTABLE_REASONS, isNotFound } from '../../../vcs/lib/uncomputable-cause.mjs';
import { armed, refused, AUTO_MERGE_REASONS } from '../../../vcs/lib/auto-merge-outcome.mjs';

export const PROVIDER = 'github';

// ── Contributor-scaffold DELIVERY (issue #570) ─────────────────────────────────
//
// The contributor-facing gate scaffold has exactly one provider-specific half:
// where the platform reads it from, and what the platform calls the thing. GitHub
// auto-applies `.github/PULL_REQUEST_TEMPLATE.md` to every new pull request. The
// TEXT is neutral and lives in ONE place — `vcs/contributor-scaffold.mjs` — which
// substitutes this vocabulary at emission (#340: one source, per-provider
// emission, never two hand-maintained copies).
//
// A DATA constant, deliberately not a function: `verb-contract-drift-guard.test.mjs`
// treats any FUNCTION exported by both providers as a contract verb, and delivery
// data is not a verb.
export const CONTRIBUTOR_SCAFFOLD = Object.freeze({
  provider: PROVIDER,
  path: '.github/PULL_REQUEST_TEMPLATE.md',
  noun: 'pull request',
  nounTitle: 'Pull request',
  abbr: 'PR',
});

// ── the single chokepoint for `gh` (issue #501) ────────────────────────────────
//
// Every verb reaches the network through `gh` / `ghJson` and nothing else, so the
// bound identity is applied once instead of at 21 call sites. It was applied at
// exactly ONE before this: `GH_TOKEN` appeared twice in this file, both inside
// `whoami`. The reviewer therefore VERIFIED as `csrinaldibot` and WROTE as
// whoever `gh` was logged in as — measured on PR #500, review 4887057484.
//
// `GH_TOKEN` takes precedence over gh's keyring auth, and it is set on the CHILD
// env only: `gh auth login --with-token` would mutate the operator's machine-wide
// gh state as a side effect of running a review, and race any concurrent gh use.
//
// With no bound identity the options pass through untouched, so every
// non-reviewer caller — the `brain:vcs` CLI, the governance checks — keeps
// resolving auth exactly as it does today.
//
// An explicit `opts.env` from the caller still wins for every key it sets; the
// identity only fills `GH_TOKEN`, and only when one is bound. That ordering is
// what lets `whoami({ token })` keep verifying a token OTHER than the bound one.
//
// PINNED ON THE SOURCE by `github.identity.drift.test.mjs`: a verb that calls
// `run('gh', …)` directly would bypass this, pass every behavioural test, and
// reopen the exact defect this comment records.
function ghOpts(opts = {}) {
  const identity = currentIdentity();
  if (!identity) return opts;
  return { ...opts, env: { ...process.env, GH_TOKEN: identity, ...(opts.env ?? {}) } };
}

/** `run('gh', …)` under the bound identity — the only way to invoke gh here. */
const gh = (args, opts) => run('gh', args, ghOpts(opts));

/** `runJson('gh', …)` under the bound identity. */
const ghJson = (args, opts) => runJson('gh', args, ghOpts(opts));

const toQs = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

export async function authCheck({ host } = {}) {
  const args = host ? ['auth', 'status', '--hostname', host] : ['auth', 'status'];
  return gh(args).ok;
}

export async function authLogin({ host, token } = {}) {
  const tok = token ?? vcsToken(PROVIDER);
  return gh(['auth', 'login', '--hostname', host || 'github.com', '--with-token'], { input: tok }).ok;
}

// `token` (optional, issue #413): resolves the identity OF THAT TOKEN rather
// than of whatever `gh` happens to be logged in as — `GH_TOKEN` takes
// precedence over gh's keyring auth, so an identity verification cannot be
// satisfied by the operator's ambient login. Without `token` the pre-#413
// behavior (current CLI user) is unchanged.
export async function whoami({ token } = {}) {
  const opts = token ? { env: { ...process.env, GH_TOKEN: token } } : {};
  const resp = ghJson(['api', '/user'], opts);
  return { username: resp.login };
}

// GitHub addresses repos by the owner/repo slug directly — projectResolve is the identity.
export async function projectResolve({ project }) {
  return project;
}

export async function issueView({ project, number }) {
  const r = ghJson(['api', `repos/${project}/issues/${number}`]);
  return {
    number: r.number,
    title: r.title,
    labels: (r.labels ?? []).map(l => l.name),
    body: r.body,
    // `author` (issue #239 A3 TASK1): actor-check.mjs's REQ-L5-1 compares the
    // approval actor against BOTH the PR author and the issue author — the
    // same API call already carries `user.login`, no extra round-trip.
    author: r.user?.login ?? null,
    // `assignees` (issue #533, ADR-0029): `string[]` when the payload carried the
    // field, `null` when it did not. Same call, no extra round-trip.
    assignees: normalizeAssignees(r, 'login'),
    // `state`/`stateReason` (issue #557, D2): the archive sweep's selector needs
    // to know whether an issue is CLOSED and, if so, why — same call, no extra
    // round-trip. `state` passes through GitHub's own `'open'|'closed'` enum
    // unchanged (no normalization needed, unlike GitLab's `'opened'`).
    // `stateReason` is GitHub's native `state_reason` (`'completed'|
    // 'not_planned'|'reopened'|null`), which the selector's row 9 reads to
    // distinguish "shipped" from "abandoned" closures.
    state: r.state,
    stateReason: r.state_reason ?? null,
  };
}

/**
 * issueUpdate — the port's first verb that can OVERWRITE HUMAN PROSE (issue #533,
 * ADR-0029 Decision 3).
 *
 * Every other write verb on this port appends: `issueComment` adds a comment,
 * `labelAdd` adds a label, `prReviewComment` posts a review. This one replaces a
 * body, and there is no undo behind it — GitHub keeps an edit history a human can
 * read, not one this port can restore from.
 *
 * The containment is at the CALLER and it is a precondition, not a nicety:
 * `epic-render.mjs`'s `replaceMapRegion` is marker-bounded, and `outsideRegion`
 * proves byte-equality outside the markers before `epic-map.mjs` ever calls this.
 * Both properties are asserted by test. The verb itself cannot enforce them —
 * a body is opaque here — which is exactly why the proof had to exist first.
 *
 * `body` is the only writable field. Adding `title`/`state`/`labels` would make
 * this the verb that can close a ticket, and closing is a governance act
 * (`issue-link` reads the closing keyword). Widening it is a `decision`.
 *
 * Never throws — `mrCreate`'s discipline, not `issueCreate`'s: there is no
 * refusal here that a caller must not retry.
 *
 * @param {{ project: string, number: number, body: string }} opts
 * @returns {Promise<{ ok: true, url: string|null } | { ok: false, error: string }>}
 */
export async function issueUpdate({ project, number, body } = {}) {
  if (typeof body !== 'string') {
    return { ok: false, error: 'issueUpdate: `body` must be a string' };
  }
  const r = gh(
    ['api', '-X', 'PATCH', `repos/${project}/issues/${number}`, '--input', '-'],
    { input: JSON.stringify({ body }) },
  );
  if (!r.ok) return { ok: false, error: r.stderr.trim() || `gh api failed (status ${r.status})` };
  try {
    return { ok: true, url: JSON.parse(r.stdout).html_url ?? null };
  } catch {
    // The write LANDED — a non-zero exit is the only failure signal, and this was
    // zero. Only the echo was unreadable, so `url` folds to null and `ok` stays
    // true: reporting a successful write as a failure would send a caller into a
    // retry of an overwrite that already happened.
    return { ok: true, url: null };
  }
}

/**
 * issueRelations — the provider's NATIVE dependency graph (issue #533, ADR-0029
 * Decision 2), read from GitHub's issue-dependencies API:
 *   `blocking`   → issues this one blocks  → `blocks`
 *   `blocked_by` → issues this one needs   → `needs`
 *
 * Sub-issues (`/issues/:n/sub_issues`) are deliberately NOT read. They are a
 * CONTAINMENT relation ("this epic holds that slice"), not an ordering one, and
 * feeding them into a blocking graph would make every slice of #313 appear to
 * block the epic that merely lists it.
 *
 * CROSS-REPO relations are counted, never mapped. GitHub's dependencies may point
 * at another repository, and issue numbers are per-repo: a foreign `#12` drawn as
 * a node would assert an edge to THIS repo's #12, which is a fabricated
 * dependency rather than a missing one. They land in `foreign` so the map can say
 * how many it dropped instead of dropping them quietly.
 *
 * Never throws, and NEVER fabricates an empty graph: a fetch failure returns
 * `null` (uncomputable), distinct from a successful read of an issue that has no
 * relations (`{ blocks: [], needs: [], foreign: 0 }`). A caller that collapsed the
 * two would report "no native dependency" for an endpoint it could not reach.
 *
 * @param {{ project: string, number: number }} opts
 * @returns {Promise<{ blocks: number[], needs: number[], foreign: number }|null>}
 */
export async function issueRelations({ project, number } = {}) {
  const fetchSide = (side) => {
    try {
      const arr = ghJson(['api', '--paginate', `repos/${project}/issues/${number}/dependencies/${side}`]);
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  };
  const blocking = fetchSide('blocking');
  const blockedBy = fetchSide('blocked_by');
  // One side unreadable makes the WHOLE answer partial. Returning the half that
  // resolved would report a graph missing edges and say nothing about it.
  if (blocking === null || blockedBy === null) return null;

  let foreign = 0;
  const local = (arr) => {
    const out = [];
    for (const r of arr) {
      const owner = r.repository?.full_name ?? r.repository?.fullName ?? null;
      if (owner && owner !== project) { foreign += 1; continue; }
      if (Number.isInteger(r.number)) out.push(r.number);
    }
    return out;
  };
  return { blocks: local(blocking), needs: local(blockedBy), foreign };
}

/**
 * issueCreate — open an issue through the port (issue #528).
 *
 * brain could read issues, list them and open merge requests, and could not open an
 * issue. So the first step of its own workflow — `issue-link` refuses any PR to main
 * without an APPROVED issue behind it — was the one step brain did not support, and
 * every ticket in this repository was authored outside the adapter boundary.
 *
 * `assertNoApprovalLabel` THROWS rather than filtering the label out. Silently
 * dropping it would create the issue and report success while the caller believed it
 * had approved something — the caller must learn that the request was refused, not
 * discover later that half of it was ignored.
 *
 * @param {{ project: string, title: string, body?: string, labels?: string[], config?: object }} params
 * @returns {Promise<{ number: number|null, url: string|null, error?: string }>}
 */
export async function issueCreate({ project, title, body = '', labels = [], config } = {}) {
  assertNoApprovalLabel(labels, { config, provider: 'github' });

  const args = ['issue', 'create', '--repo', project, '--title', title, '--body', body];
  for (const label of labels) args.push('--label', label);

  const r = gh(args);
  if (!r.ok) {
    return { number: null, url: null, error: r.stderr.trim() || `gh issue create failed (status ${r.status})` };
  }
  // `gh issue create` prints the URL. The number is its last path segment — parsed
  // rather than re-fetched, and `null` when it does not parse, because a fabricated
  // number is worse than an absent one for a caller about to write `Closes #N`.
  const url = r.stdout.trim();
  const m = url.match(/\/(\d+)\s*$/);
  return { number: m ? Number(m[1]) : null, url };
}

export async function branchProtect({ project, branch = 'main', checks, requiredReviews = 1 }) {
  const payload = {
    required_status_checks: {
      strict: true,
      checks: checks.map(context => ({ context })),
    },
    enforce_admins: false,
    required_pull_request_reviews: {
      required_approving_review_count: requiredReviews,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
  const r = gh(
    ['api', '-X', 'PUT', `repos/${project}/branches/${branch}/protection`, '--input', '-'],
    { input: JSON.stringify(payload) },
  );
  if (r.ok) return { enforced: true };
  // Tier / plan limitation — GitHub free plan blocks protection on private repos
  if (r.stderr.includes('403') || /upgrade.*pro/i.test(r.stderr)) {
    return {
      enforced: false,
      reason: 'tier',
      remedy: 'GitHub Pro for private repos, or make the repo public',
    };
  }
  return {
    enforced: false,
    reason: 'unsupported',
    remedy: r.stderr.trim() || 'unknown error from gh api',
  };
}

/**
 * Optional, non-contract verb (github only — `brain:protect`'s arm-and-verify
 * step, issue #203). Returns the check-run names reported for the branch's
 * latest commit. Never throws: a fetch failure degrades to `[]`, which
 * `verifyArmedProtection` (brain-protect.mjs) treats as "unverifiable" rather
 * than a crash.
 *
 * @param {{ project: string, branch?: string }} opts
 * @returns {Promise<string[]>}
 */
export async function checkRuns({ project, branch = 'main' } = {}) {
  try {
    const resp = ghJson(['api', `repos/${project}/commits/${branch}/check-runs`]);
    return (resp.check_runs ?? []).map(cr => cr.name);
  } catch {
    return [];
  }
}

// Capability cache — keyed by "project:branch" to avoid cross-test interference.
const _capabilityCache = new Map();

/**
 * Probe the GitHub API to determine whether branch protection APIs are accessible
 * for the given project+branch. Caches the result per project:branch for the
 * lifetime of the Node.js process.
 *
 * Returns: { hardEnforcement: 'available' | 'unavailable' | 'unknown', remedy?, detail? }
 */
export async function capabilities({ project = '', branch = 'main' } = {}) {
  const key = `${project}:${branch}`;
  if (_capabilityCache.has(key)) return _capabilityCache.get(key);

  const r = gh(['api', `repos/${project}/branches/${branch}/protection`]);
  // Classified through the shared pure function (#348): a 404 here means the
  // API answered and nothing is configured yet, which is what `available`
  // claims — an opt-in this axis has and a plan-gated endpoint would not.
  const probe = classifyProbe(r, {
    notFoundIsAvailable: true,
    remedies: [{ match: /403|upgrade.*pro/i, remedy: 'GitHub Pro for private repos, or make the repo public' }],
  });
  let result;
  if (probe.state === 'available') {
    result = { hardEnforcement: 'available' };
  } else if (probe.state === 'unavailable') {
    result = {
      hardEnforcement: 'unavailable',
      remedy: probe.remedy,
    };
  } else {
    result = { hardEnforcement: 'unknown', ...(probe.detail ? { detail: probe.detail } : {}) };
  }

  // The second axis (#348). GitHub applies `required_approving_review_count`
  // through the same protection endpoint just probed, so its availability is
  // the SAME answer — no second call, and no assumption either: it is derived
  // from the probe that already happened, not from a plan name.
  result = {
    ...result,
    approvalCount: result.hardEnforcement,
    ...(result.hardEnforcement === 'unavailable' && result.remedy ? { approvalRemedy: result.remedy } : {}),
    // The DIAGNOSTIC travels with the axis (#348 round 3). The status surface
    // reads `approvalDetail` and nothing set it, so an unreadable probe printed
    // "approvals unknown" bare while the platform line one row above showed the
    // cause for the very same failure. "A probe we could not read is not a probe
    // that said no" is only useful if the reader is told what it could not read.
    ...(result.hardEnforcement === 'unknown' && result.detail ? { approvalDetail: result.detail } : {}),
  };

  _capabilityCache.set(key, result);
  return result;
}

/**
 * Fetch a PR's metadata (number, label names, body, author, the head commit
 * sha, and the base commit sha) via `gh pr view`. Uses the current repo's
 * git remote — `project` is accepted for contract compatibility but not
 * required by the gh CLI when run from the repo root.
 *
 * `headRefOid` (ADR-0021 Decision 1) is the API's head sha for the PR — the
 * anchor a cold caller checks out **detached** at (never a branch name).
 *
 * `baseRefOid` (ADR-0022 Decision 1) is the base branch's tip sha. `gh pr
 * view --json` does NOT expose it (verified: its field set offers
 * `baseRefName`/`headRefName`/`headRefOid`, but no `baseRefOid` — `gh pr view
 * --json baseRefOid` errors "Unknown JSON field"). So it is sourced via a
 * SECOND, supplementary call: `gh api repos/{owner}/{repo}/pulls/{number}
 * --jq .base.sha` (the REST endpoint's authoritative `base.sha`; `gh` itself
 * expands the literal `{owner}/{repo}` placeholders from the current repo's
 * git remote, preserving this verb's "works from repo root, `project`
 * optional" property). The main `gh pr view --json …,headRefOid` call above
 * is left UNTOUCHED — `baseRefOid` is a strictly additive supplement: if it
 * fails, every other field from the main fetch is still returned, only
 * `baseRefOid` folds to `null`.
 *
 * Widened additively (both ADR-0021 and ADR-0022): existing callers reading
 * only `number`/`labels`/`body`/`author` are unaffected.
 *
 * Never throws: returns { number, labels: null, body: null, author: null,
 * headRefOid: null, baseRefOid: null } on ANY main-fetch failure
 * (ci-context.mjs's REQ-CIC-2 uncomputable signal) — distinct from a
 * genuinely empty `[]`/`''` on an otherwise-successful response. Callers
 * that need "no labels" vs "couldn't fetch labels" distinguished (e.g. a
 * REQUIRED gate) MUST treat `null` as uncomputable, never collapse it to a
 * fabricated empty default.
 *
 * `absent` (issue #1086, D1) is an ADDITIVE third field on the same failure
 * shape, computed from `isNotFound(r.stderr)`: `false` on a successful
 * fetch, `true` when `gh pr view`'s own stderr is a definitive "that number
 * is not a pull request" (`isNotFound` — the module's shared not-found
 * predicate, never a provider-local regex), `null` on any other failure
 * (including the JSON-parse catch below — a malformed response is not a
 * negative). `labels`/`body` stay `null` in BOTH failure branches,
 * byte-identical to today, so a consumer that does not read `absent`
 * behaves exactly as before this change.
 *
 * @param {{ project?: string, number: number }} opts
 * @returns {Promise<{ number: number, labels: string[]|null, body: string|null, author: string|null, headRefOid: string|null, baseRefOid: string|null, absent: boolean|null }>}
 */
export async function prView({ project, number } = {}) {
  const r = gh(['pr', 'view', String(number), '--json', 'number,labels,body,author,headRefOid']);
  if (!r.ok) {
    return {
      number,
      labels: null,
      body: null,
      author: null,
      headRefOid: null,
      baseRefOid: null,
      absent: isNotFound(r.stderr) ? true : null,
    };
  }
  try {
    const data = JSON.parse(r.stdout);
    const br = gh(['api', `repos/{owner}/{repo}/pulls/${number}`, '--jq', '.base.sha']);
    // `gh api --jq .base.sha` prints the literal "null" on a JSON-null base.sha —
    // normalize it to null, matching gitlab.mjs's `diff_refs?.base_sha ?? null`.
    const baseSha = br.ok ? br.stdout.trim() : '';
    const baseRefOid = baseSha && baseSha !== 'null' ? baseSha : null;
    return {
      number: data.number,
      labels: (data.labels ?? []).map(l => l.name),
      body: data.body ?? '',
      author: data.author?.login ?? null,
      headRefOid: data.headRefOid ?? null,
      baseRefOid,
      absent: false,
    };
  } catch {
    // A malformed response is not a negative — `absent: null`, same as any
    // other unreadable state.
    return { number, labels: null, body: null, author: null, headRefOid: null, baseRefOid: null, absent: null };
  }
}

export async function issueList({ project, state = 'open', assignee } = {}) {
  let currentUser;
  if (assignee === 'me') currentUser = (await whoami()).username;
  const assigneePs = assigneeParams('github', assignee, currentUser);
  const extra = Object.keys(assigneePs).length > 0 ? '&' + toQs(assigneePs) : '';
  const endpoint = `repos/${project}/issues?state=${providerState('github', state)}&per_page=100${extra}`;
  // `--paginate` is load-bearing, same discipline as `labelEvents`/`prReviews`/
  // `labelList`: `gh api` does not auto-paginate, so a repo with more than one page
  // of open issues silently returned a PREFIX. Every consumer of this verb reads the
  // result as "the issues", and `brain:epic:map` (#459) draws a dependency graph from
  // it — a truncated list makes the map assert there is no dependency where there is
  // one, which is a stronger and falser statement than admitting it cannot see.
  const arr = ghJson(['api', '--paginate', endpoint]);
  // GitHub /issues returns both issues and PRs — filter out PRs.
  return arr
    .filter(r => !r.pull_request)
    // `assignees` (issue #533, ADR-0029) — the list endpoint already carries them,
    // so the map's "who is executing this" costs no extra round-trip. `null` when
    // the payload has no assignee field; `[]` only when it has one and it is empty.
    .map(r => ({
      number: r.number,
      title: r.title,
      labels: (r.labels ?? []).map(l => l.name),
      assignees: normalizeAssignees(r, 'login'),
    }));
}

/**
 * mrList — widened additively by #930 (D1/D2).
 *
 * D1: every entry now also carries `state` ('open'|'closed', GitHub's own
 * literal, passed through unchanged) and `merged` (boolean|null): `true`/
 * `false` when `merged_at` is present (non-null vs null), `null` only when
 * the payload carries no `merged_at` field at all — an uncomputable read,
 * never guessed. Pre-#930 callers reading only `number`/`title`/`headBranch`
 * are unaffected (additive, never narrowed).
 *
 * D2: an optional `headBranch` filter narrows the query to
 * `head=<owner>:<branch>` (`owner` derived from `project`, URL-encoded).
 * Unfiltered calls stay byte-identical to the pre-#930 query — no `head=`
 * param is ever added unless `headBranch` is explicitly passed. When
 * `headBranch` is set and the page comes back full (100), this THROWS
 * rather than risk returning a silently truncated result — the caller
 * (the lane sweep, #936) must not decide a closed-PR outcome from a partial
 * page.
 */
export async function mrList({ project, state = 'open', headBranch } = {}) {
  const owner = project.split('/')[0];
  const headParam = headBranch !== undefined ? `&head=${encodeURIComponent(`${owner}:${headBranch}`)}` : '';
  const arr = ghJson(['api', `repos/${project}/pulls?state=${providerState('github', state)}${headParam}&per_page=100`]);
  if (headBranch !== undefined && arr.length === 100) {
    throw new Error(`mrList: a full page (100) came back for headBranch ${headBranch} — cannot rule out truncation, failing closed`);
  }
  return arr.map(r => ({
    number: r.number,
    title: r.title,
    headBranch: r.head.ref,
    state: r.state,
    merged: r.merged_at !== undefined ? r.merged_at !== null : null,
  }));
}

export async function commitStatus({ project, sha }) {
  const resp = ghJson(['api', `repos/${project}/commits/${sha}/check-runs`]);
  const cr = resp.check_runs?.[0];
  if (!cr) return null;
  // An unfinished check has conclusion=null; its live state lives in `status`
  // (queued/in_progress). Use status until completed, then the conclusion.
  const raw = cr.status === 'completed' ? cr.conclusion : cr.status;
  return normalizeCommitStatus('github', raw);
}

/**
 * commitPrs — the pull requests that contain a commit (issue #1086, D3). The
 * shared merge-evidence layer (`fetchPrMeta`, `merge-walk.mjs`) opens this
 * lookup ONLY when `prView` reports a definitive `absent`, so its answer must
 * distinguish "definitively none" from "could not read" as sharply as
 * `issueRelations` does (`:194-197`): `[]` on a successful read with no
 * containing pull request, `null` on ANY transport failure or malformed
 * response — NEVER a fabricated `[]` for a failure, and never a throw.
 * Ascending on a real list; numbers only (the caller re-enters `prView` for
 * every other field, so no second evidence shape is introduced — design D3).
 *
 * Mirrors `commitStatus({ project, sha })`'s commit-keyed shape, but UNLIKE
 * `commitStatus` (pinned to reject on a transport failure, out of scope)
 * this verb never throws — the fail-closed dispatch in `fetchPrMeta` depends
 * on `null` being distinguishable from `[]` without a try/catch at the call
 * site.
 *
 * @param {{ project: string, sha: string }} opts
 * @returns {Promise<number[]|null>}
 */
export async function commitPrs({ project, sha } = {}) {
  const r = gh(['api', '--paginate', `repos/${project}/commits/${sha}/pulls`]);
  if (!r.ok) return null;
  try {
    const data = JSON.parse(r.stdout);
    if (!Array.isArray(data)) return null;
    return data.map(pr => pr.number).sort((a, b) => a - b);
  } catch {
    return null;
  }
}

/**
 * prStatusRollup — the provider-agnostic READ verb `prStatusRollup`
 * (ADR-0021 Decision 2). Returns the full status-check rollup for a PR's
 * head commit, normalized to `[{ name, status, conclusion }]` — one entry
 * per check. This is a READ: no write path exists on this verb, and it
 * carries no APPROVE/label-mutation code path (the reviewer's four
 * COMMENT-only write verbs from ADR-0020 are unaffected).
 *
 * Unlike `commitStatus` (which needs a sha as input and collapses to
 * `check_runs[0]`, a single check), `prStatusRollup` takes the PR number and
 * returns the FULL rollup via `gh pr view --json statusCheckRollup` — every
 * required check the tranche evaluator (H1-2c) re-derives cold, not a
 * collapsed single status.
 *
 * Never throws: a fetch failure, or a response with no computable rollup,
 * normalizes to the frozen shape `uncomputable()` builds — `reason` +
 * `detail`, flagged (issue #606) — never bare `null` and never a fabricated
 * `[]`. `detail` carries `gh`'s own words verbatim; `reason` is the shared
 * classifier's advisory label (`vcs/lib/uncomputable-cause.mjs`). This file
 * never constructs the flagged shape by hand and never writes a `reason`
 * literal — `uncomputable()` is the sole constructor (enforced by a source
 * guard, `uncomputable-cause.test.mjs`).
 *
 * @param {{ project?: string, number: number }} opts
 * @returns {Promise<Array<{ name: string, status: string|null, conclusion: string|null }>|ReturnType<typeof import('../../../vcs/lib/uncomputable-cause.mjs').uncomputable>>}
 */
export async function prStatusRollup({ project, number } = {}) {
  let data;
  try {
    data = ghJson(['pr', 'view', String(number), '--json', 'statusCheckRollup']);
  } catch (err) {
    return uncomputable({ detail: err.message });
  }
  const rollup = data.statusCheckRollup;
  if (!Array.isArray(rollup)) {
    // The fifth fused cause: the fetch SUCCEEDED and the field is not a
    // rollup. No provider text describes this, so the reason is passed
    // explicitly and the detail is this file's own sentence — still the
    // words of whoever knows (design §4.3).
    return uncomputable({
      reason: UNCOMPUTABLE_REASONS.MALFORMED_RESPONSE,
      detail: `gh pr view --json statusCheckRollup returned ${typeof rollup} for PR ${number}, not an array`,
    });
  }
  return rollup.map(c => ({
    name: c.name ?? c.context ?? null,
    status: c.status ?? c.state ?? null,
    conclusion: c.conclusion ?? null,
  }));
}

/**
 * workflowRunSucceeded — the provider-agnostic READ verb (issue #1162): has the
 * named workflow EVER completed successfully on `branch`? It is the evidence
 * that tells a repository whose audit cursor was never created (a bootstrap
 * state) from one whose cursor was deleted (a successful run advanced it once).
 *
 * Returns `{ state, detail }`, never throws:
 *   'succeeded' — at least one successful run exists on `branch`
 *   'none'      — the read succeeded and there is none
 *   'unknown'   — the read failed or was malformed; `detail` carries the words
 * Filtered by `branch` (the default branch): a success on another branch says
 * nothing about the cursor on the audited one.
 *
 * @param {{ project?: string, workflow: string, branch: string }} opts
 * @returns {Promise<{ state: 'succeeded'|'none'|'unknown', detail: string|null }>}
 */
export async function workflowRunSucceeded({ project, workflow, branch } = {}) {
  if (!workflow || !branch) return { state: 'unknown', detail: 'workflow and branch are both required' };
  let runs;
  try {
    runs = ghJson([
      'run', 'list', '--workflow', workflow, '--branch', branch, '--status', 'success',
      '--limit', '1', '--json', 'databaseId', ...(project ? ['-R', project] : []),
    ]);
  } catch (err) {
    return { state: 'unknown', detail: err.message };
  }
  if (!Array.isArray(runs)) return { state: 'unknown', detail: `gh run list returned ${typeof runs}, not an array` };
  return { state: runs.length > 0 ? 'succeeded' : 'none', detail: null };
}

/**
 * prReviews — the provider-agnostic `prReviews` CONTRACT verb (issue #239
 * A3 TASK2/4th-violation fix, closing the L6 brain-writes-reviewed gate's
 * gh-CLI-hardcoded `defaultFetchReviews`). Wraps GitHub's Reviews API
 * (`pulls/N/reviews`), normalizing `state`/`user.login`/`body` to `{ state,
 * author, body }`. EXTRACTED from brain-writes-reviewed.mjs's inline
 * `defaultFetchReviews`, preserving the load-bearing `--paginate` VERBATIM:
 * `gh api` does not auto-paginate, and a long-lived PR with many re-review
 * cycles can exceed one page — an unpaginated fetch can silently drop the
 * one human APPROVED review that would flip a self-approval verdict.
 *
 * `body` (issue #317) is LOAD-BEARING, not cosmetic: the reviewer's
 * `brain-review/N` verdict block lives in the review body, and
 * `parse-verdict.mjs` requires a string body to recover it. Without `body`
 * on this shape, `cold-boot`'s `doctrine.priorVerdicts` is ALWAYS `[]` in
 * production — which silently kills the anti-loop lock (poster.mjs's
 * `lastVerdict` never fires, so a duplicate verdict is re-posted on every
 * rerun of the same head), the `rev >= 3 -> STOP` bound (verdict.mjs's
 * `priorRevCount` never leaves 0), the §8 prior-verdict doctrine load, and
 * board reconciliation. This is the field whose absence made all four
 * guarantees inert while their tests stayed green on injected fixtures.
 *
 * `body` follows the same uncomputable-vs-empty discipline as `prView.body`
 * (issue #239 A3 task 3.7): a review with no comment normalizes to `''`,
 * never `null`/`undefined` — `null` is reserved for "couldn't fetch", which
 * on this verb is signalled by the WHOLE result being `null`.
 *
 * Never throws: a fetch failure is caught and normalized to `null`
 * (uncomputable) — never a fabricated `[]`, so callers (the DETECTION gate)
 * can distinguish "zero reviews" from "couldn't fetch".
 *
 * @param {{ project: string, number: number }} params
 * @returns {Promise<Array<{ state: string, author: string|null, body: string }>|null>}
 */
export async function prReviews({ project, number } = {}) {
  let reviews;
  try {
    reviews = ghJson(['api', '--paginate', `repos/${project}/pulls/${number}/reviews`]);
  } catch {
    return null;
  }
  return reviews.map(r => ({ state: r.state, author: r.user?.login ?? null, body: r.body ?? '' }));
}

/**
 * Create a pull request via `gh pr create`.
 * Returns { url: string } on success or { url: null, error: string } on failure.
 * Never throws.
 */
export async function mrCreate({
  project,
  title,
  body,
  head,
  base = 'main',
  labels = [],
} = {}) {
  // gh pr create resolves the repo from the git remote; project is validated
  // implicitly.  Pass title + body + branch refs explicitly.
  const args = [
    'pr', 'create',
    '--title', title,
    '--body', body,
    '--head', head,
    '--base', base,
  ];
  for (const label of labels) {
    args.push('--label', label);
  }

  const r = gh(args);
  if (r.ok) return { url: r.stdout.trim() };
  return { url: null, error: r.stderr.trim() || `gh pr create failed (status ${r.status})` };
}

// fixtures/github-mrAutoMerge-unsupported.json, `recorded: true` as of the
// task 2.1 live capture (2026-09-09, PR #895, csrinaldi/brain,
// allow_auto_merge:false): `GraphQL: Auto merge is not allowed for this
// repository (enablePullRequestAutoMerge)`. Note the real text has a SPACE
// ("Auto merge"), not a hyphen ("auto-merge") — the pre-capture placeholder
// assumed the hyphenated form and would have silently misclassified this as
// `transport`. `[- ]?` tolerates either separator (and none) so a future
// GraphQL message-wording tweak on either side doesn't reopen this gap.
const GITHUB_MR_AUTO_MERGE_UNSUPPORTED_RE = /auto[- ]?merge is not allowed/i;

/**
 * Arms auto-merge (squash, hardcoded) via `gh pr merge --auto --squash`, or
 * refuses when `requiredReviews` says a human gate is still required.
 * The refusal is the FIRST statement (design A4) — no `gh` call is ever
 * made on that path. Never throws.
 *
 * `url` is unconditionally `null` (design A2): `gh pr merge --auto` prints a
 * human confirmation line, not a URL, so stdout is never parsed.
 *
 * @param {{ project: string, number: number, requiredReviews?: number }} params
 * @returns {Promise<{enabled:true,url:null}|{enabled:false,reason:string}|{enabled:false,reason:string,error:string}>}
 */
export async function mrAutoMerge({ project, number, requiredReviews = 1 } = {}) {
  // Only the NUMBER 0 may arm (cold-review blocker 1). `> 0` is false for
  // null/NaN/-1 too — a naive predicate ARMS on all three, a fail-open gate
  // on a mutating write verb. `!== 0` makes exact-zero the only permission;
  // a string `'0'` stays refused because strict equality never coerces.
  if (requiredReviews !== 0) return refused({ reason: AUTO_MERGE_REASONS.REQUIRES_HUMAN_APPROVAL });

  // The seam itself can THROW (e.g. a launch failure re-raised instead of
  // returned) — `run()`/`gh()` carry no try/catch of their own. Without
  // this wrapper such a throw would reject the returned promise, breaking
  // the never-throws contract (correction 4).
  let r;
  try {
    r = gh(['pr', 'merge', String(number), '--auto', '--squash', '--repo', project]);
  } catch (err) {
    const message = err?.message ?? String(err);
    return refused({ reason: AUTO_MERGE_REASONS.TRANSPORT, error: message });
  }
  if (r.ok) return armed({ url: null });

  const text = r.stderr.trim() || `gh pr merge failed (status ${r.status})`;
  if (GITHUB_MR_AUTO_MERGE_UNSUPPORTED_RE.test(text)) {
    return refused({ reason: AUTO_MERGE_REASONS.UNSUPPORTED, error: text });
  }
  return refused({ reason: AUTO_MERGE_REASONS.TRANSPORT, error: text });
}

/**
 * labelEvents — the provider-agnostic `labelEvents` CONTRACT verb (issue
 * #239 A3, D1). Wraps GitHub's Events API (`issues/N/events`), normalizing
 * `event:'labeled'|'unlabeled'` + `actor.login`/`label.name`/`created_at` to
 * the shared shape `{ actor: { login }, action: 'add'|'remove', label, at }`,
 * ascending by `at`. Non-label events (e.g. `commented`) are dropped.
 *
 * EXTRACTED from actor-check.mjs's inline `defaultFetchLabeledEvents` (the
 * A2 `m3` finding close) — preserves the load-bearing `--paginate`
 * VERBATIM: `gh api` does not auto-paginate, and the Events API is
 * oldest-first, so an unpaginated fetch silently drops page-2+ events
 * (including a late self-applied approved label), which would wrongly PASS
 * the actor-check (fail-open).
 *
 * Never throws: a fetch failure (no `gh` binary, rate limit, non-zero exit)
 * is caught and normalized to `null` (uncomputable) — never a fabricated
 * `[]`, so callers (the actor-check DETECTION gate) can distinguish "no
 * events" from "couldn't fetch".
 *
 * `kind` (issue #1024, design item 7) is accepted and IGNORED here,
 * documentation-only: GitHub's Events API is already PR/issue-unified (a PR
 * IS an issue under the hood, same events endpoint either way) — only
 * GitLab's provider distinguishes `issues/…` from `merge_requests/…`.
 *
 * @param {{ project: string, number: number, kind?: 'issue'|'mr' }} params
 * @returns {Promise<Array<{ actor: { login: string|undefined }, action: 'add'|'remove', label: string|undefined, at: string|undefined }>|null>}
 */
export async function labelEvents({ project, number, kind: _kind } = {}) {
  let events;
  try {
    events = ghJson(['api', '--paginate', `repos/${project}/issues/${number}/events`]);
  } catch {
    return null;
  }
  return events
    .filter(e => e.event === 'labeled' || e.event === 'unlabeled')
    .map(e => ({
      actor: { login: e.actor?.login },
      action: e.event === 'labeled' ? 'add' : 'remove',
      label: e.label?.name,
      at: e.created_at,
    }))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

/**
 * prCommits — the provider-agnostic `prCommits` CONTRACT verb (issue #358
 * Q5 Phase 4, REQ-L5-1' regulated evidence: "the approver authored no
 * commit on the branch"). Wraps GitHub's PR-commits API
 * (`pulls/{n}/commits`), normalizing to `{ sha, login, at }`. The API
 * itself returns commits oldest-first (unlike `labelEvents`/`prReviews`,
 * which need an explicit sort) — the LAST entry is the branch's head
 * commit, which `actor-check.mjs`'s `lite` distinct-act evidence compares
 * the approval timestamp against (REQ-L5-1' lite evidence).
 *
 * `login` is GitHub's account-linked commit author
 * (`commit-object.author.login`) — nullable when the commit's author email
 * is not linked to any GitHub account. This is the identity
 * `regulated`'s no-commit-on-branch evidence compares the approving actor
 * against; a commit with `login: null` can never match an actor login (a
 * safe direction — it simply cannot prove that specific commit was
 * authored by the approver).
 *
 * Never throws: a fetch failure is caught and normalized to `null`
 * (uncomputable) — never a fabricated `[]` (same discipline as
 * `labelEvents`/`prReviews`).
 *
 * @param {{ project: string, number: number }} params
 * @returns {Promise<Array<{ sha: string, login: string|null, at: string|undefined }>|null>}
 */
export async function prCommits({ project, number } = {}) {
  let commits;
  try {
    commits = ghJson(['api', '--paginate', `repos/${project}/pulls/${number}/commits`]);
  } catch {
    return null;
  }
  return commits.map(c => ({
    sha: c.sha,
    login: c.author?.login ?? null,
    at: c.commit?.author?.date,
  }));
}

/**
 * Posts a COMMENT-state pull request review (issue #266, REQ-266-2). `event`
 * is HARDCODED to `'COMMENT'` — no parameter, flag, or branch selects a
 * different review event (lock 2, REQ-266-3). Never throws.
 *
 * `comments` (issue #405) is an optional array of `{ path, line, body }` inline
 * anchors riding the SAME `/reviews` payload as `body`, so the review stays
 * atomic. Absent and empty are the SAME request — no inline is attempted. A
 * refused anchored payload is retried ONCE bare, and `inlineDropped` then counts
 * what was lost; it is ABSENT when nothing was, never 0. Widening this signature
 * does not widen `event`: there is no parameter for it, and a contract test
 * asserts that ALL THREE payload sites — the ternary's anchored branch, its bare
 * branch, and the retry — still carry `COMMENT` when a caller passes a hostile
 * `event` argument. Three, and counting them took two review rounds: `main` had
 * ONE site, this function now builds three, and the ternary reads as one. Round 8
 * covered sites 1 and 3 and called it "both"; round 9 found site 2 open — the
 * only one a production run reaches today, since no evaluator anchors.
 *
 * @param {{ project: string, number: number, body: string, comments?: Array<{path: string, line: number, body: string}> }} opts
 * @returns {Promise<{ url: string } | { url: string, inlineDropped: number } | { url: null, error: string }>}
 */
export async function prReviewComment({ project, number, body, comments } = {}) {
  const args = ['api', '-X', 'POST', `repos/${project}/pulls/${number}/reviews`, '--input', '-'];
  const post = (payload) => gh(args, { input: JSON.stringify(payload) });
  const parse = (r, extra) => {
    try {
      return { url: JSON.parse(r.stdout).html_url, ...extra };
    } catch (err) {
      return { url: null, error: err.message };
    }
  };

  const inline = Array.isArray(comments) && comments.length > 0 ? comments : null;

  // `comments` rides the SAME payload as `body` and `event` — one call, so the
  // review is atomic and no second postable artifact exists for the anti-loop
  // lock to miss (ADR-0020 Amendment 1, #405 design D1/D5).
  const first = post(inline ? { body, event: 'COMMENT', comments: inline } : { body, event: 'COMMENT' });
  if (first.ok) return parse(first);

  // REQ-405-4 — the verdict is never lost to an inline failure. GitHub 422s a
  // comment targeting a line outside the diff; the summary alone would have been
  // accepted. Retry WITHOUT the anchors and report how many were dropped.
  //
  // Only reachable when anchors were sent, so a plain post failure costs no extra
  // call.
  //
  // The ATTRIBUTION is not certain, and an earlier version of this comment claimed
  // it was ("the retry differs in exactly one way, so if dropping the comments
  // makes it succeed, the comments were the cause"). The retry fires on ANY
  // non-zero first exit, so a transient 5xx that clears by the second attempt is
  // reported as dropped anchors — the CLI then prints "could not be anchored",
  // charging a network blip to the diff. Round-2 cold review, E-3.
  //
  // Retrying anyway is the deliberate trade: gating on a 422-shaped stderr would
  // make a transient failure lose the VERDICT, and REQ-405-4 ranks the verdict
  // above the annotation. What is fixed here is the CLAIM, not the behaviour — an
  // over-count of dropped anchors costs a confusing line in a log; a lost verdict
  // costs the review. (A first call that landed server-side but exited non-zero
  // would post the verdict twice; that is the anti-loop lock's problem and needs
  // provider idempotency this port does not have.)
  //
  // `inlineDropped` is ABSENT when nothing was dropped, never 0 — "none
  // requested" and "all dropped" must not be the same answer to a reader
  // (evidence-reader-empty-on-failure, applied to a poster).
  if (inline) {
    const retry = post({ body, event: 'COMMENT' });
    if (retry.ok) return parse(retry, { inlineDropped: inline.length });
  }

  return { url: null, error: first.stderr.trim() || `gh api failed (status ${first.status})` };
}

/**
 * Posts a plain issue comment — rulings on issues (issue #266, REQ-266-2).
 * Never throws.
 *
 * @param {{ project: string, number: number, body: string }} opts
 * @returns {Promise<{ url: string } | { url: null, error: string }>}
 */
export async function issueComment({ project, number, body } = {}) {
  const r = gh(
    ['api', '-X', 'POST', `repos/${project}/issues/${number}/comments`, '--input', '-'],
    { input: JSON.stringify({ body }) },
  );
  if (!r.ok) return { url: null, error: r.stderr.trim() || `gh api failed (status ${r.status})` };
  try {
    return { url: JSON.parse(r.stdout).html_url };
  } catch (err) {
    return { url: null, error: err.message };
  }
}

/**
 * Adds labels to an issue or PR (issue #266, REQ-266-2). The CALLER enforces
 * the deny-set (REQ-266-9, monotonic label tightening) — this verb performs
 * the label API call only, no policy. Never throws.
 *
 * @param {{ project: string, number: number, labels: string[] }} opts
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function labelAdd({ project, number, labels } = {}) {
  const r = gh(
    ['api', '-X', 'POST', `repos/${project}/issues/${number}/labels`, '--input', '-'],
    { input: JSON.stringify({ labels }) },
  );
  if (r.ok) return { ok: true };
  return { ok: false, error: r.stderr.trim() || `gh api failed (status ${r.status})` };
}

/**
 * Removes labels from an issue or PR — monotonic-tightening removals only
 * (issue #266, REQ-266-9); the caller enforces the deny-set. GitHub has no
 * bulk-remove endpoint — each label is deleted individually, stopping at the
 * first failure. Never throws.
 *
 * @param {{ project: string, number: number, labels: string[] }} opts
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function labelRemove({ project, number, labels } = {}) {
  for (const label of labels) {
    const r = gh(['api', '-X', 'DELETE', `repos/${project}/issues/${number}/labels/${encodeURIComponent(label)}`]);
    if (!r.ok) return { ok: false, error: r.stderr.trim() || `gh api failed (status ${r.status})` };
  }
  return { ok: true };
}

/**
 * labelList — the provider-agnostic `labelList` verb (issue #334,
 * vcs-label-preflight spec): the remote's full declared label set, normalized
 * to bare name strings. Consumed by `labelPreflight` (vcs/label-preflight.mjs)
 * as the pre-write conformance check before `mrCreate` — a hard-error on an
 * unknown GitHub label, caught BEFORE the write rather than after (design A2).
 *
 * `--paginate` is load-bearing, same discipline as `labelEvents`/`prReviews`:
 * a repo with more labels than one page would otherwise silently drop a real
 * label and false-reject a valid ship. May throw like its sibling normalized
 * READs (`prView` fixture aside) — `labelPreflight`, not this verb, is the
 * total/never-throws policy layer (design A1).
 *
 * @param {{ project: string }} opts
 * @returns {Promise<string[]>}
 */
export async function labelList({ project } = {}) {
  const arr = ghJson(['api', '--paginate', `repos/${project}/labels?per_page=100`]);
  return arr.map(l => l.name);
}

/**
 * labelCreate — creates a label DEFINITION in the remote's label set (issue
 * #1163). The write half of `labelList`: it applies the label to nothing, so
 * it cannot hand anyone an approval (that is `labelAdd`'s deny-set). "Already
 * exists" (HTTP 422 `already_exists`) is a SUCCESS with `created: false`,
 * which is what makes the caller idempotent. Never throws.
 *
 * @param {{ project: string, name: string, color?: string, description?: string }} opts
 * @returns {Promise<{ ok: true, created: boolean } | { ok: false, error: string }>}
 */
export async function labelCreate({ project, name, color, description } = {}) {
  const r = gh(
    ['api', '-X', 'POST', `repos/${project}/labels`, '--input', '-'],
    { input: JSON.stringify({ name, color: String(color ?? 'ededed').replace(/^#/, ''), description: description ?? '' }) },
  );
  if (r.ok) return { ok: true, created: true };
  if (/already_exists/.test(`${r.stdout}${r.stderr}`)) return { ok: true, created: false };
  return { ok: false, error: r.stderr.trim() || `gh api failed (status ${r.status})` };
}

/**
 * issueClose — closes an issue as completed (issue #1188). The post-merge
 * workflow closes the alarm issues a later clean run resolves. The payload is
 * `state` and `state_reason` and nothing else: no body, title or labels travel
 * with it, the mirror of `issueUpdate`'s refusal to carry `state`. Never throws.
 *
 * @param {{ project: string, number: number }} opts
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function issueClose({ project, number } = {}) {
  const r = gh(
    ['api', '-X', 'PATCH', `repos/${project}/issues/${number}`, '--input', '-'],
    { input: JSON.stringify({ state: 'closed', state_reason: 'completed' }) },
  );
  if (r.ok) return { ok: true };
  return { ok: false, error: r.stderr.trim() || `gh api failed (status ${r.status})` };
}

/**
 * rerunWorkflowRun — GitHub-only capability (issue #328, closing the
 * stale-GREEN re-evaluation bug). Not a base contract verb (no GitLab
 * equivalent implemented, deliberately out of scope) — callers reach it via
 * `getVcs({ provider: 'github' }).rerunWorkflowRun(...)`, module-namespace
 * access outside cli.mjs's `VERBS` dispatch (adding a GitHub-only entry there
 * would trip verb-contract-drift-guard.test.mjs's "both providers implement
 * it" check for the wrong reason).
 *
 * Finds the most recent run of `workflow` for `ref` (`gh api
 * repos/{project}/actions/runs?branch={ref}`, API-ordered newest-first;
 * client-side filtered to the target workflow's `path`) and forces a FULL
 * rerun (`POST .../actions/runs/{run_id}/rerun`) — deliberately NEVER
 * `rerun-failed-jobs`, which only reruns jobs that already failed and would
 * silently skip an already-green job stuck on stale evidence (actor-check's
 * REQ-L5-2 warn-pass on missing approval history) — the exact bug this verb
 * exists to fix (a PR merged on a verdict computed before the fact it
 * depends on existed).
 *
 * Never throws: a list-runs failure, no matching run, or a rerun-POST
 * failure all degrade to `{ ok: false, reason }`.
 *
 * @param {{ project: string, ref: string, workflow?: string }} opts
 * @returns {Promise<{ ok: true, runId: number } | { ok: false, reason: string }>}
 */
export async function rerunWorkflowRun({ project, ref, workflow = 'governance.yml' } = {}) {
  let runsResp;
  try {
    runsResp = ghJson(['api', `repos/${project}/actions/runs?branch=${encodeURIComponent(ref)}&per_page=100`]);
  } catch (err) {
    return { ok: false, reason: `could not list workflow runs: ${err.message}` };
  }

  const targetPath = `.github/workflows/${workflow}`;
  const match = (runsResp.workflow_runs ?? []).find(r => r.path === targetPath);
  if (!match) {
    return { ok: false, reason: `no run of ${workflow} found for ref '${ref}'` };
  }

  const r = gh(['api', '-X', 'POST', `repos/${project}/actions/runs/${match.id}/rerun`]);
  if (!r.ok) {
    return { ok: false, reason: r.stderr.trim() || `gh api failed (status ${r.status})` };
  }
  return { ok: true, runId: match.id };
}

/**
 * Percent-encode a value that is about to be interpolated into a URL (#388).
 *
 * `patSetupUrl` builds a query string by hand on both providers. An unencoded
 * `name` containing `&` does not merely look wrong — it SPLITS: `brain & co`
 * becomes `description=brain ` plus a second, spurious ` co` parameter, and the
 * page opens with a truncated token name the operator then saves.
 *
 * Scopes are encoded PER ENTRY and joined with a literal comma, never encoded as
 * one string: the comma is the separator the provider parses, not data. Encoding
 * it would send `repo%2Cworkflow` as a single scope name.
 */
const enc = (v) => encodeURIComponent(String(v));

/**
 * Percent-encode a project slug for a URL PATH, segment by segment (#388).
 *
 * `encodeURIComponent(project)` would be wrong here: a slug is `group/repo` — and
 * on GitLab `group/subgroup/repo` — so encoding it whole turns the separators into
 * `%2F` and the clone URL stops resolving. The slashes are structure; only what
 * sits between them is data.
 */
const encPath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

export async function repoCloneUrl({ host, project, token }) {
  return `https://x-access-token:${token}@${host || 'github.com'}/${encPath(project)}.git`;
}

/**
 * The PAT-creation page for the host the caller named (#387).
 *
 * This used to hardcode `github.com` and never read its own `host` parameter, so a
 * GitHub Enterprise Server operator who passed their GHES hostname was silently
 * sent to the PUBLIC github.com token page — where any token they created would be
 * useless against their own server, with nothing saying why. GitLab's equivalent
 * has always been host-driven; this is the divergence that made self-hosted GitLab
 * work while GHES did not.
 *
 * `host || 'github.com'` mirrors `repoCloneUrl` directly above — the same default,
 * spelled the same way, in the same file.
 */
export async function patSetupUrl({ host, name, scopes }) {
  return `https://${host || 'github.com'}/settings/tokens/new`
    + `?description=${enc(name)}&scopes=${scopes.map(enc).join(',')}`;
}
