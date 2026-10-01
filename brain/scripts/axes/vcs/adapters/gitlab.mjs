// gitlab.mjs — GitLab provider (glab CLI + /api/v4). Implements brain/core/methodology/vcs-contract.md.
//
// Reproduces the CURRENT behavior of the harness scripts (parity), so a revert
// leaves the GitLab flow intact. Auth uses the glab session (ensured by day:start);
// the token is only needed by the URL-building verbs, which receive it from the
// caller. All verbs return the NORMALIZED shapes from the contract. GitLab's REST
// API accepts the URL-encoded project path everywhere, so the slug is used directly.

import { run, runJson } from '../../../vcs/lib/exec.mjs';
import { unappliedNote } from '../../../vcs/capability-report.mjs';
import { normalizeCommitStatus, providerState, assigneeParams, normalizeAssignees } from '../../../vcs/lib/normalize.mjs';
import { vcsToken } from '../../../vcs/lib/token.mjs';
import { currentIdentity } from '../../../vcs/lib/identity-context.mjs';
import { gitlabApiFetch } from '../../../vcs/gitlab-api.mjs';
import { assertNoApprovalLabel } from '../../../vcs/lib/approval-deny.mjs';
import { uncomputable, UNCOMPUTABLE_REASONS, isNotFound } from '../../../vcs/lib/uncomputable-cause.mjs';
import { armed, refused, AUTO_MERGE_REASONS } from '../../../vcs/lib/auto-merge-outcome.mjs';

export const PROVIDER = 'gitlab';

// ── Contributor-scaffold DELIVERY (issue #570) ─────────────────────────────────
//
// The GitLab sibling of github.mjs's record, and the half that did not exist: a
// GitLab consumer opting into `brain/scripts/ci/gitlab-governance.yml` received
// `issue-link` as a REQUIRED job parsing merge-request descriptions for a closing
// reference, and no scaffold telling a contributor to write one.
//
// `Default.md` is load-bearing, not a name: GitLab auto-applies the description
// template called `Default` to every new merge request, exactly as GitHub
// auto-applies `PULL_REQUEST_TEMPLATE.md`. Any other filename ships a template
// that a contributor must know to select — i.e. a scaffold that does not scaffold.
// It is REFUSE-classified for the same reason its GitHub sibling is — with the
// first-ship caveat spelled out in managed-paths.mjs: on the release that
// introduces the path, a consumer who already owns that filename is overwritten,
// because the refusal needs a previously-shipped copy to compare against.
export const CONTRIBUTOR_SCAFFOLD = Object.freeze({
  provider: PROVIDER,
  path: '.gitlab/merge_request_templates/Default.md',
  noun: 'merge request',
  nounTitle: 'Merge request',
  abbr: 'MR',
});

// The single credential resolver (issue #501). Thirteen verbs resolved
// `token ?? vcsToken(PROVIDER)` inline. The parameter was correct and the
// reviewer still wrote with the wrong credential, because poster.mjs never passed
// one — GitLab fell back to the GENERIC VCS_TOKEN while GitHub fell back to gh's
// ambient login. Two mechanisms, one failure: the identity was not bound where the
// port is obtained.
//
// Order is load-bearing. An explicit `token` argument still wins, so a caller
// deliberately acting as someone else — whoami() verifying a candidate credential —
// is unaffected. Then the identity bound to this port. Only then the generic
// credential, which is what every non-reviewer caller keeps using.
//
// PINNED ON THE SOURCE by the identity drift test: a verb resolving
// vcsToken(PROVIDER) inline again would ignore the binding and stay green.
const glToken = (token) => token ?? currentIdentity() ?? vcsToken(PROVIDER);

const toQs = (params) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

export async function authCheck({ host }) {
  return run('glab', ['auth', 'status', '--hostname', host]).ok;
}

export async function authLogin({ host, token } = {}) {
  const tok = glToken(token);
  return run('glab', ['auth', 'login', '--hostname', host, '--git-protocol', 'https', '--stdin'], { input: tok }).ok;
}

// `token` (optional, issue #413): resolves the identity OF THAT TOKEN via the
// shared `gitlabApiFetch` transport (PRIVATE-TOKEN header) rather than glab's
// ambient session, so an identity verification cannot be satisfied by the
// operator's own login. Rejects on transport failure on BOTH paths (runJson
// throws / gitlabApiFetch throws) — the contract's discipline for this verb.
// Without `token` the pre-#413 behavior (current CLI user) is unchanged.
export async function whoami({ token, apiBase, proxyUrl, fetchImpl } = {}) {
  if (!token) {
    const resp = runJson('glab', ['api', '/user']);
    return { username: resp.username };
  }
  const base = apiBase ?? 'https://gitlab.com/api/v4';
  const resp = await gitlabApiFetch({
    apiBase: base,
    token,
    proxyUrl: proxyUrl ?? null,
    path: 'user',
    fetchImpl,
  });
  return { username: resp.username };
}

// GitLab's API accepts the URL-encoded path everywhere, so the slug is the
// project identifier — projectResolve is the identity, like GitHub.
export async function projectResolve({ project }) {
  return project;
}

/**
 * issueView — DIRECT GitLab API v4 fetch (issue #231 CP-A2b live-validation
 * finding #12), not the `glab` CLI: this verb is CI-consumed (the REQUIRED
 * issue-link gate's defaultFetchIssue, run-check.mjs), and the node:22 CI
 * image has no `glab` binary — the CLI dependency crashed the gate on an
 * INFRA trigger. `apiBase`/`token`/`proxyUrl` are threaded in as parameters
 * from the caller (never read from the GitLab API base URL pipeline var
 * directly here — gitlab.mjs is a GATE_FILE and that read is forbidden by
 * ci-context-drift-guard.test.mjs; the sanctioned resolver is
 * ci-context.mjs's `gitlabApiConfig()`). Defaults exist so LOCAL/non-CI
 * callers (ticket-start.mjs, brain-start.mjs) keep working unchanged: public
 * gitlab.com API base, VCS_TOKEN via the existing `vcsToken()` helper (not a
 * direct env read either — token.mjs already owns that), no proxy.
 *
 * The other GitLab verbs (issueList, mrList, etc.) are NOT migrated — they
 * are local-interactive only (glab session auth), out of this scope (A3
 * territory).
 *
 * @param {{ project: string, number: number, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 */
export async function issueView({ project, number, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const encoded = encodeURIComponent(project);
  const r = await gitlabApiFetch({
    apiBase: apiBase ?? 'https://gitlab.com/api/v4',
    token: glToken(token),
    proxyUrl: proxyUrl ?? null,
    path: `projects/${encoded}/issues/${number}`,
    fetchImpl,
  });
  return {
    number: r.iid,
    title: r.title,
    labels: r.labels ?? [],
    body: r.description,
    // `author` (issue #239 A3 TASK1): actor-check.mjs's REQ-L5-1 compares the
    // approval actor against BOTH the PR author and the issue author — the
    // same API call already carries `author.username`, no extra round-trip.
    author: r.author?.username ?? null,
    // `assignees` (issue #533, ADR-0029): `string[]` when the payload carried the
    // field, `null` when it did not. GitLab CE caps the array at one entry rather
    // than omitting it, so the plural key is read on every tier.
    assignees: normalizeAssignees(r, 'username'),
    // `state`/`stateReason` (issue #557, D2): same call, no extra round-trip.
    // GitLab's issue `state` is `'opened'|'closed'`, normalized to the shared
    // `'open'|'closed'` enum GitHub already uses. `stateReason` is a documented
    // residual (vcs-contract.md): GitLab issues carry no `state_reason` field,
    // so this is ALWAYS `null` here — the selector's row 9 (not-planned) never
    // fires on GitLab, and a closed-as-abandoned change is archived like any
    // other closure. `null` here means "the provider does not distinguish",
    // deliberately distinct from `readIssueState` itself returning `null`
    // (no answer at all).
    state: r.state === 'opened' ? 'open' : r.state,
    stateReason: null,
  };
}

/**
 * issueUpdate — the port's first verb that can OVERWRITE HUMAN PROSE (issue #533,
 * ADR-0029 Decision 3). GitHub's twin, over `PUT /projects/:id/issues/:iid`.
 *
 * `body` maps to GitLab's `description`, and it is the ONLY field written: a
 * payload that could also carry `state_event` would make this the verb that closes
 * a ticket, which is a governance act, not a body edit.
 *
 * The containment lives at the caller (`replaceMapRegion` + `outsideRegion`) and is
 * asserted by test before this verb exists — see the GitHub twin's note.
 *
 * `{ apiBase, token, proxyUrl }` are threaded in as PARAMETERS, same discipline as
 * `issueCreate`/`prView` — this file is a GATE_FILE and never reads pipeline env.
 * Never throws.
 *
 * @param {{ project: string, number: number, body: string, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<{ ok: true, url: string|null } | { ok: false, error: string }>}
 */
export async function issueUpdate({ project, number, body, apiBase, token, proxyUrl, fetchImpl } = {}) {
  if (typeof body !== 'string') {
    return { ok: false, error: 'issueUpdate: `body` must be a string' };
  }
  try {
    const r = await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encodeURIComponent(project)}/issues/${number}`,
      method: 'PUT',
      body: { description: body },
      fetchImpl,
    });
    return { ok: true, url: r?.web_url ?? null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * issueRelations — the provider's NATIVE dependency graph (issue #533, ADR-0029
 * Decision 2), read from `GET /projects/:id/issues/:iid/links`.
 *
 * GitLab states the direction in `link_type`, from the perspective of the issue
 * asked about:
 *   `blocks`        → this issue blocks that one     → `blocks`
 *   `is_blocked_by` → this issue needs that one      → `needs`
 *   `relates_to`    → DROPPED, deliberately
 *
 * `relates_to` is not an ordering relation. Reading it as one would turn every
 * "see also" a human clicked into a blocker, and the graph's whole job is to answer
 * *can this start now* — an edge that does not constrain start order is noise that
 * blocks work.
 *
 * CROSS-PROJECT links are counted, never mapped, for the reason the GitHub twin
 * records: iids are per-project, so a foreign `#12` drawn as a node asserts an edge
 * to THIS project's #12. `references.relative` is the decidable signal — GitLab
 * renders it as `#12` within the project and `group/proj#12` outside it.
 *
 * Never throws, and NEVER fabricates an empty graph: a fetch failure returns `null`
 * (uncomputable), distinct from a successful read of an issue with no links.
 *
 * @param {{ project: string, number: number, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<{ blocks: number[], needs: number[], foreign: number }|null>}
 */
export async function issueRelations({ project, number, apiBase, token, proxyUrl, fetchImpl } = {}) {
  let links;
  try {
    links = await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encodeURIComponent(project)}/issues/${number}/links`,
      fetchImpl,
    });
  } catch {
    return null;
  }
  if (!Array.isArray(links)) return null;

  const out = { blocks: [], needs: [], foreign: 0 };
  for (const l of links) {
    const key = l?.link_type === 'blocks' ? 'blocks' : l?.link_type === 'is_blocked_by' ? 'needs' : null;
    if (!key) continue;
    const relative = l.references?.relative;
    // A missing `references` block is undecidable, and undecidable must not become
    // a local edge — the same direction `filesOverlap` takes when it cannot decide.
    if (typeof relative !== 'string' || !relative.startsWith('#')) { out.foreign += 1; continue; }
    if (Number.isInteger(l.iid)) out[key].push(l.iid);
  }
  return out;
}

/**
 * prView — DIRECT GitLab API v4 fetch (issue #239 A3 Phase 2, un-stubbing
 * REQ-A3-4) over `GET /projects/:id/merge_requests/:iid`, via the shared
 * `gitlabApiFetch` transport — the same discipline as `issueView`. Normalizes
 * `iid`/`description`/`author.username` to `number`/`body`/`author`.
 *
 * `headRefOid` (ADR-0021 Decision 1) — the API's head sha for the MR, the
 * anchor a cold caller checks out **detached** at — normalizes from the
 * payload's top-level `sha`, falling back to `diff_refs.head_sha` (both
 * carry the same value on GitLab's MR response). Widened additively:
 * existing callers reading only `number`/`labels`/`body`/`author` are
 * unaffected.
 *
 * `baseRefOid` (ADR-0022 Decision 1) — the base branch's tip sha, normalized
 * from the payload's `diff_refs.base_sha` (the mirror of how `headRefOid`
 * uses `diff_refs.head_sha`). Unlike GitHub, no second request is needed —
 * the already-fetched MR payload carries it. Widened additively, same
 * discipline as `headRefOid`.
 *
 * `{ apiBase, token, proxyUrl }` are threaded in as PARAMETERS from the
 * caller (`gitlabApiConfig()`), never read from pipeline env directly here —
 * this file is a GATE_FILE (drift-guard forbids it). Defaults exist so
 * LOCAL/non-CI callers keep working unchanged: public gitlab.com API base,
 * `vcsToken()`, no proxy.
 *
 * Never throws: a fetch failure is caught and normalized to
 * `{ number, labels: null, body: null, author: null, headRefOid: null,
 * baseRefOid: null }` (uncomputable) — never a fabricated empty `[]`/`''`,
 * matching the `github.prView` contract.
 *
 * Body-parity (issue #239 A3 Phase 3 task 3.7): `null` means uncomputable
 * (the fetch itself failed — the `catch` branch below); `''` means the fetch
 * SUCCEEDED and the underlying `description` was genuinely empty. `?? ''` on
 * the success path aligns this with `github.mjs#prView`, which already
 * normalized this way — pre-A3-Phase-3 this branch returned bare
 * `r.description` (`null`/`undefined` when GitLab omits it), indistinguishable
 * from the failure case above.
 *
 * `absent` (issue #1086, D1) is an ADDITIVE third field on the same failure
 * shape, computed from `isNotFound(err.message)` in the `catch` below —
 * `gitlabApiFetch` throws `GitLab API failed: ${status} (${path})`, so a 404
 * on this MR-by-iid lookup classifies `not-found` via the shared classifier's
 * numeric-code rule, same discipline as `github.mjs#prView`. `false` on a
 * successful fetch, `true` on a definitive negative, `null` on any other
 * failure. `labels`/`body` stay `null` in both failure branches.
 *
 * @param {{ project: string, number: number, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<{ number: number, labels: string[]|null, body: string|null, author: string|null, headRefOid: string|null, baseRefOid: string|null, absent: boolean|null }>}
 */
export async function prView({ project, number, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const encoded = encodeURIComponent(project);
  try {
    const r = await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/merge_requests/${number}`,
      fetchImpl,
    });
    return {
      number: r.iid,
      labels: r.labels ?? [],
      body: r.description ?? '',
      author: r.author?.username ?? null,
      headRefOid: r.sha ?? r.diff_refs?.head_sha ?? null,
      baseRefOid: r.diff_refs?.base_sha ?? null,
      absent: false,
    };
  } catch (err) {
    return {
      number,
      labels: null,
      body: null,
      author: null,
      headRefOid: null,
      baseRefOid: null,
      absent: isNotFound(err?.message ?? '') ? true : null,
    };
  }
}

/**
 * prStatusRollup — the provider-agnostic READ verb `prStatusRollup`
 * (ADR-0021 Decision 2). Returns the full status-check rollup for an MR's
 * head commit, normalized to `[{ name, status, conclusion }]` — one entry
 * per check. This is a READ: no write path exists on this verb.
 *
 * GitLab has no single "checks rollup" endpoint like GitHub's — this
 * resolves the MR's head sha (the same `sha`/`diff_refs.head_sha` fallback
 * as `prView`), then reads `GET projects/:id/repository/commits/:sha/statuses`
 * (the same endpoint `commitStatus` reads, but the FULL list rather than
 * `[0]`). GitLab's commit-status model has no separate "conclusion" field
 * distinct from its terminal `status` (success/failed/canceled/etc.) — each
 * entry normalizes to `conclusion: null`, satisfying the shared SHAPE (the
 * contract both providers must meet) without fabricating a field GitLab
 * doesn't have.
 *
 * `{ apiBase, token, proxyUrl }` are threaded in as PARAMETERS from the
 * caller, same discipline as `prView` — this file is a GATE_FILE and never
 * reads pipeline env directly. Never throws: a fetch failure, or an
 * unresolvable head sha, normalizes to the frozen shape `uncomputable()`
 * builds — `reason` + `detail`, flagged (issue #606) — never bare `null`
 * and never a fabricated `[]`. `detail` carries the provider's own words (or
 * this file's own sentence for a structural refusal) verbatim; `reason` is
 * the shared classifier's advisory label (`vcs/lib/uncomputable-cause.mjs`).
 * This file never constructs the flagged shape by hand and never writes a
 * `reason` literal — `uncomputable()` is the sole constructor (enforced by
 * a source guard, `uncomputable-cause.test.mjs`).
 *
 * @param {{ project: string, number: number, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<Array<{ name: string, status: string|null, conclusion: null }>|ReturnType<typeof import('../../../vcs/lib/uncomputable-cause.mjs').uncomputable>>}
 */
export async function prStatusRollup({ project, number, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const encoded = encodeURIComponent(project);
  const base = apiBase ?? 'https://gitlab.com/api/v4';
  const tok = glToken(token);
  try {
    const mr = await gitlabApiFetch({
      apiBase: base,
      token: tok,
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/merge_requests/${number}`,
      fetchImpl,
    });
    const sha = mr.sha ?? mr.diff_refs?.head_sha ?? null;
    if (!sha) {
      return uncomputable({
        reason: UNCOMPUTABLE_REASONS.MALFORMED_RESPONSE,
        detail: `the MR ${number} payload carried neither \`sha\` nor \`diff_refs.head_sha\``,
      });
    }
    const statuses = await gitlabApiFetch({
      apiBase: base,
      token: tok,
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/repository/commits/${sha}/statuses`,
      fetchImpl,
    });
    if (!Array.isArray(statuses)) {
      return uncomputable({
        reason: UNCOMPUTABLE_REASONS.MALFORMED_RESPONSE,
        detail: `GET projects/:id/repository/commits/${sha}/statuses returned ${typeof statuses}, not an array`,
      });
    }
    return statuses.map(s => ({ name: s.name ?? null, status: s.status ?? null, conclusion: null }));
  } catch (err) {
    return uncomputable({ detail: err.message });
  }
}

/**
 * labelEvents — the provider-agnostic `labelEvents` CONTRACT verb (issue
 * #239 A3, D1) over GitLab's resource-label-events API (`GET
 * /projects/:id/issues/:iid/resource_label_events`), via the shared
 * `gitlabApiFetch` transport (never a second hand-rolled fetch). Normalizes
 * `user.username` → `actor.login`, native `action` (`'add'|'remove'`) passes
 * through, `label.name` → `label`, `created_at` → `at`; ascending by `at`.
 *
 * `{ apiBase, token, proxyUrl }` are threaded in as PARAMETERS from the
 * caller (`gitlabApiConfig()`), exactly like `issueView` — this file is a
 * GATE_FILE and never reads pipeline env directly. Never throws: a fetch
 * failure is caught and normalized to `null` (uncomputable) — never a
 * fabricated `[]`.
 *
 * `kind` (issue #1024, design item 7): `'issue'` (default, UNCHANGED) reads
 * `issues/:iid/resource_label_events`; `'mr'` reads
 * `merge_requests/:iid/resource_label_events` instead — the memory-gate
 * override's applier read (`decideMemoryGateOverride`) needs the MR's OWN
 * label events, and `brain-metrics.mjs`'s `size:exception`/`skip:memory-gate`
 * by-author reporting reads label events for a GitLab MR number today via the
 * issues path, which is the same bug this fixes at the call site.
 *
 * @param {{ project: string, number: number, kind?: 'issue'|'mr', apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<Array<{ actor: { login: string }, action: 'add'|'remove', label: string, at: string }>|null>}
 */
export async function labelEvents({ project, number, kind = 'issue', apiBase, token, proxyUrl, fetchImpl } = {}) {
  const encoded = encodeURIComponent(project);
  const resource = kind === 'mr' ? 'merge_requests' : 'issues';
  let events;
  try {
    events = await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/${resource}/${number}/resource_label_events`,
      fetchImpl,
    });
  } catch {
    return null;
  }
  return events
    .map(e => ({
      actor: { login: e.user?.username },
      action: e.action,
      label: e.label?.name,
      at: e.created_at,
    }))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

/**
 * prReviews — the provider-agnostic `prReviews` CONTRACT verb (issue #239
 * A3 TASK2/4th-violation fix; verdict-thread half added by issue #317) over
 * TWO GitLab endpoints, both via the shared `gitlabApiFetch` transport:
 *
 *   1. `GET /projects/:id/merge_requests/:iid/notes` — the MR discussion
 *      thread. This is where the reviewer's `brain-review/N` verdict blocks
 *      actually LIVE (poster.mjs posts them as MR notes), so it is the only
 *      endpoint that can carry a parseable `body`. Each non-system note
 *      normalizes to `{ state: 'COMMENTED', author, body }`.
 *   2. `GET /projects/:id/merge_requests/:iid/approvals` — the approval
 *      roster. GitLab has no per-reviewer review-STATE history like GitHub's
 *      Reviews API, so each entry in `approved_by` normalizes to one
 *      `{ state: 'APPROVED', author, body: '' }` entry.
 *
 * WHY BOTH (issue #317): this one verb feeds two unrelated consumers with
 * disjoint needs, and before #317 it served only the second.
 *   - The L6 `brain-writes-reviewed` gate reads ONLY `state === 'APPROVED'`
 *     + `author`. Approvals is its source; notes must never satisfy it.
 *   - The reviewer's verdict thread (`cold-boot`'s `doctrine.priorVerdicts`,
 *     `board`'s reconciliation) reads ONLY `body`, through `parseVerdict`.
 *     Approvals carries no body at all, so on GitLab the verdict thread was
 *     STRUCTURALLY INVISIBLE — `priorVerdicts` was always `[]`, and with it
 *     the anti-loop lock, the `rev >= 3 -> STOP` bound, the §8 doctrine load
 *     and board reconciliation were all inert in production.
 *
 * SECURITY BOUNDARY (do not "simplify" this): notes normalize to
 * `'COMMENTED'`, NEVER `'APPROVED'`. Mapping a mere MR comment to APPROVED
 * would let anyone clear the L6 self-approval gate by typing a comment.
 *
 * ORDERING is load-bearing: `sort=asc&order_by=created_at` makes notes
 * oldest-first, matching GitHub's Reviews API, because `poster.mjs` and
 * `board.mjs` both take the LAST parsed verdict as the current one. GitLab's
 * notes endpoint defaults to newest-first, which would invert that.
 *
 * PAGINATION is load-bearing for the same reason `--paginate` is on the
 * GitHub side, and more sharply: with `sort=asc`, page 1 holds the OLDEST
 * notes, so an unpaginated fetch drops the LATEST verdict — precisely the
 * fail-open the anti-loop lock exists to prevent. Fetched page-by-page
 * (`per_page=100`, stop on a short page), the same termination condition
 * `labelList` uses, because `gitlabApiFetch` returns only the parsed body
 * and cannot follow a `Link` header.
 *
 * FAILURE IS ALL-OR-NOTHING: if EITHER fetch fails the whole result is
 * `null` (uncomputable). Returning notes-only on an approvals failure would
 * hand L6 an empty approver set that looks like a genuine "nobody approved"
 * — a fail-OPEN on the security gate. `null` is what its callers already
 * treat as "couldn't compute".
 *
 * `{ apiBase, token, proxyUrl }` are threaded in as PARAMETERS from the
 * caller (`gitlabApiConfig()`), exactly like `issueView`/`labelEvents` —
 * this file is a GATE_FILE and never reads pipeline env directly. Never
 * throws: a fetch failure is caught and normalized to `null` (uncomputable)
 * — never a fabricated `[]`.
 *
 * @param {{ project: string, number: number, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<Array<{ state: 'COMMENTED'|'APPROVED', author: string|null, body: string }>|null>}
 */
export async function prReviews({ project, number, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const encoded = encodeURIComponent(project);
  const base = apiBase ?? 'https://gitlab.com/api/v4';
  const tok = glToken(token);
  const perPage = 100;

  let notes;
  let approvals;
  try {
    notes = [];
    for (let page = 1; ; page += 1) {
      const arr = await gitlabApiFetch({
        apiBase: base,
        token: tok,
        proxyUrl: proxyUrl ?? null,
        path: `projects/${encoded}/merge_requests/${number}/notes?order_by=created_at&sort=asc&per_page=${perPage}&page=${page}`,
        fetchImpl,
      });
      if (!Array.isArray(arr)) return null;
      notes.push(...arr);
      if (arr.length < perPage) break;
    }
    approvals = await gitlabApiFetch({
      apiBase: base,
      token: tok,
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/merge_requests/${number}/approvals`,
      fetchImpl,
    });
  } catch {
    return null;
  }

  // System notes ("changed title from ...", "assigned to @x") are GitLab's own
  // activity records, never reviewer speech — they can never carry a verdict
  // block, so they are dropped rather than passed through as noise.
  const commented = notes
    .filter(n => n?.system !== true)
    .map(n => ({ state: 'COMMENTED', author: n?.author?.username ?? null, body: n?.body ?? '' }));

  const approved = (approvals?.approved_by ?? []).map(a => ({
    state: 'APPROVED',
    author: a.user?.username ?? null,
    body: '',
  }));

  // Approvals are appended AFTER the chronological notes rather than
  // interleaved: the approvals endpoint exposes no per-approver timestamp, so
  // any interleaving would be fabricated. Safe for the "last verdict wins"
  // readers because an approval's `body` is `''`, which `parseVerdict`
  // rejects — an approval can never displace the latest real verdict.
  return [...commented, ...approved];
}

/**
 * prCommits — the provider-agnostic `prCommits` CONTRACT verb (issue #358
 * Q5 Phase 4) over GitLab's MR-commits endpoint
 * (`merge_requests/:iid/commits`). GitLab's commit entries carry only
 * free-text git identity (`author_name`/`author_email`) — there is no
 * account-linked commit author like GitHub's `author.login`, and resolving
 * one would need a SECOND per-commit user lookup this verb does not make.
 * `login` therefore normalizes to `null` for every entry — a documented
 * residual (issue #358 Phase 6 KNOWN-LIMITATIONS): REQ-L5-1'-regulated's
 * "approver authored no commit on the branch" evidence is uncomputable on
 * GitLab today, and callers (`actor-check.mjs`) must treat an all-null
 * login set as "cannot verify", never as "the approver authored zero
 * commits". `at` (`committed_date`) still normalizes for `lite`'s
 * distinct-act evidence, which needs only the head commit's timestamp, not
 * authorship.
 *
 * `{ apiBase, token, proxyUrl }` are threaded in as PARAMETERS from the
 * caller (`gitlabApiConfig()`), exactly like `issueView`/`labelEvents` —
 * this file is a GATE_FILE and never reads pipeline env directly. Never
 * throws: a fetch failure (or a malformed, non-array response) is
 * normalized to `null` (uncomputable) — never a fabricated `[]`.
 *
 * @param {{ project: string, number: number, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<Array<{ sha: string, login: null, at: string|undefined }>|null>}
 */
export async function prCommits({ project, number, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const encoded = encodeURIComponent(project);
  let commits;
  try {
    commits = await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/merge_requests/${number}/commits`,
      fetchImpl,
    });
  } catch {
    return null;
  }
  if (!Array.isArray(commits)) return null;
  return commits.map(c => ({ sha: c.id, login: null, at: c.committed_date }));
}

export async function issueList({ project, state = 'open', assignee } = {}) {
  let currentUser;
  if (assignee === 'me') currentUser = (await whoami()).username;
  const encoded = encodeURIComponent(project);
  const assigneePs = assigneeParams('gitlab', assignee, currentUser);
  const extra = Object.keys(assigneePs).length > 0 ? '&' + toQs(assigneePs) : '';
  // Paginated for the reason the GitHub side carries `--paginate`, and more sharply:
  // this endpoint capped at 50, so truncation began at half GitHub's threshold. Fetched
  // page-by-page (stop on a short page), the same termination condition `prReviews` and
  // `labelList` use, because `runJson` returns only the parsed body and cannot follow a
  // `Link` header. A prefix of the issue list is what makes `brain:epic:map` (#459) draw
  // a graph missing nodes and say nothing about it.
  const perPage = 100;
  const arr = [];
  for (let page = 1; ; page += 1) {
    const endpoint = `projects/${encoded}/issues?state=${providerState('gitlab', state)}&per_page=${perPage}&page=${page}${extra}`;
    const chunk = runJson('glab', ['api', endpoint]);
    if (!Array.isArray(chunk)) break;
    arr.push(...chunk);
    if (chunk.length < perPage) break;
  }
  // `assignees` (issue #533, ADR-0029) — the list endpoint already carries them,
  // so the map's "who is executing this" costs no extra round-trip. `null` when
  // the payload has no assignee field; `[]` only when it has one and it is empty.
  return arr.map(r => ({
    number: r.iid,
    title: r.title,
    labels: r.labels ?? [],
    assignees: normalizeAssignees(r, 'username'),
  }));
}

/** D1 — GitLab's native merge_requests `state` has no distinct GitHub-shaped
 * `merged` boolean of its own; it folds `merged` into `state` as a third
 * value. Mapped to the shared { state, merged } pair GitHub also reports:
 * `opened`→`open`/`false`, `closed`→`closed`/`false`, `merged`→`closed`/
 * `true`. Anything else (e.g. `locked`) is unrepresentable in the shared
 * enum and reports `null`/`null` rather than guessing. */
function mapGitlabMrState(raw) {
  if (raw === 'opened') return { state: 'open', merged: false };
  if (raw === 'closed') return { state: 'closed', merged: false };
  if (raw === 'merged') return { state: 'closed', merged: true };
  return { state: null, merged: null };
}

/**
 * mrList — widened additively by #930 (D1/D2). See github.mjs#mrList's
 * docstring for the shared rationale; this is the GitLab half.
 *
 * D2: an optional `headBranch` filter narrows the query to
 * `source_branch=<branch>` (URL-encoded) and switches the page size to 100
 * (matching GitHub's). Unfiltered calls stay byte-identical to the pre-#930
 * query (`per_page=50`, no `source_branch` param). When `headBranch` is set
 * and the page comes back full (100), this THROWS rather than risk a
 * silently truncated result.
 */
export async function mrList({ project, state = 'open', headBranch } = {}) {
  const encoded = encodeURIComponent(project);
  const endpoint = headBranch !== undefined
    ? `projects/${encoded}/merge_requests?state=${providerState('gitlab', state)}&source_branch=${encodeURIComponent(headBranch)}&per_page=100`
    : `projects/${encoded}/merge_requests?state=${providerState('gitlab', state)}&per_page=50`;
  const arr = runJson('glab', ['api', endpoint]);
  if (headBranch !== undefined && arr.length === 100) {
    throw new Error(`mrList: a full page (100) came back for headBranch ${headBranch} — cannot rule out truncation, failing closed`);
  }
  return arr.map(r => {
    const { state: mrState, merged } = mapGitlabMrState(r.state);
    return { number: r.iid, title: r.title, headBranch: r.source_branch, state: mrState, merged };
  });
}

export async function commitStatus({ project, sha }) {
  const encoded = encodeURIComponent(project);
  const arr = runJson('glab', ['api', `projects/${encoded}/commits/${sha}/statuses?per_page=1`]);
  return normalizeCommitStatus('gitlab', arr[0]?.status);
}

/**
 * commitPrs — the merge requests that contain a commit (issue #1086, D3).
 * Same contract as `github.mjs#commitPrs`: `[]` on a successful read with no
 * containing merge request, `null` on ANY transport failure — never a
 * fabricated `[]`, never a throw. Transport is `gitlabApiFetch`, the same
 * seam `prView` uses (unlike `commitStatus` above, which spawns `glab`) —
 * `GET projects/:enc/repository/commits/:sha/merge_requests`, mapped to
 * `r.iid`, ascending.
 *
 * Cold-review remediation (#1086): explicitly requests `per_page=100`
 * rather than relying on GitLab's (smaller) default page size. UNLIKE
 * GitHub's sibling above (`gh api --paginate`, which walks every page for
 * free), this endpoint is read as a single page — deliberately asymmetric,
 * because `gitlabApiFetch` has no pagination loop of its own. A commit
 * associated with more containing MRs than one page could otherwise return a
 * SILENTLY TRUNCATED list, collapsing a true "two or more" (uncomputable,
 * per the dispatch table) into a false "exactly one" (audited as
 * unambiguous) — the same truncation hazard `mrList`'s `headBranch` filter
 * guards against (#930/#936). `mrList` fails closed by THROWING; this verb's
 * contract never throws, so it fails closed by returning `null` instead —
 * the same uncomputable value a transport failure already yields, and
 * `fetchPrMeta` already treats a `null` `commitPrs` result as uncomputable.
 *
 * @param {{ project: string, sha: string, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<number[]|null>}
 */
export async function commitPrs({ project, sha, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const encoded = encodeURIComponent(project);
  try {
    const r = await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/repository/commits/${sha}/merge_requests?per_page=100`,
      fetchImpl,
    });
    if (!Array.isArray(r)) return null;
    if (r.length === 100) return null; // full page — cannot rule out truncation, refuse rather than decide
    return r.map(mr => mr.iid).sort((a, b) => a - b);
  } catch {
    return null;
  }
}

/**
 * workflowRunSucceeded — the provider-agnostic READ verb (issue #1162). GitLab
 * has no per-workflow-file run history equivalent, and this provider's
 * governance fragment ships no post-merge audit job or cursor, so there is
 * nothing to ask. It answers `unsupported` explicitly: a caller must treat that
 * as `unknown` (an alarm), never as "none" (a bootstrap). Never throws.
 *
 * @returns {Promise<{ state: 'unsupported', detail: string }>}
 */
export async function workflowRunSucceeded() {
  return { state: 'unsupported', detail: 'GitLab has no post-merge audit workflow or cursor; run history by workflow file is not modelled' };
}

/**
 * Posts a COMMENT-state merge request review (issue #266, REQ-266-2).
 * GitLab's notes API has no review-event concept (APPROVE/COMMENT/REQUEST
 * CHANGES) — a plain note is posted, which structurally cannot become an
 * approval either (lock 2, REQ-266-3: no such code path exists on this
 * provider). The API response carries no `web_url`, so the display url is
 * derived from `apiBase` (stripping the trailing `/api/v4`). Never throws.
 *
 * `comments` (issue #405) is an optional array of `{ path, line, body }` inline
 * anchors. Absent and empty are the SAME request — no discussion is attempted.
 * The summary note goes first and it is the ONLY payload carrying the verdict body
 * (this provider has no retry, so unlike GitHub it never sends the body twice);
 * each anchor is then its own `discussions` POST, because GitLab's discussions
 * are one-per-position. `inlineDropped` counts anchors that did not attach and is
 * ABSENT when none were, never 0.
 *
 * @param {{ project: string, number: number, body: string, comments?: Array<{path: string, line: number, body: string}>, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<{ url: string } | { url: string, inlineDropped: number } | { url: null, error: string }>}
 */
export async function prReviewComment({ project, number, body, comments, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const base = apiBase ?? 'https://gitlab.com/api/v4';
  const encoded = encodeURIComponent(project);
  const tok = glToken(token);
  const call = (path, method, payload) =>
    gitlabApiFetch({ apiBase: base, token: tok, proxyUrl: proxyUrl ?? null, path, method, body: payload, fetchImpl });

  const inline = Array.isArray(comments) && comments.length > 0 ? comments : null;

  // ── the summary note ALWAYS goes first (issue #405, REQ-405-4) ────────────
  //
  // GitHub carries `comments[]` in the same payload as `body`, so its review is
  // atomic. GitLab cannot: discussions are ONE PER POSITION, so N anchors mean
  // N+1 calls no matter the order. Given that, the verdict goes first — if
  // anything after it fails, the deliverable is already posted. That is the
  // opposite of GitHub's order (which attempts anchored, then retries bare) and
  // it is the same rule underneath: the verdict is never lost to an inline
  // failure.
  //
  // The anti-loop lock survives the extra calls because it counts PARSEABLE
  // VERDICTS, not posts: only this summary note carries a `brain-review/N`
  // block, and cold-boot.mjs filters out everything `parseVerdict` rejects.
  // Pinned by a test rather than left as an argument.
  // The url derivation stays INSIDE the try (cold review of PR #490, C4). An
  // earlier version of this widening moved it out, so a 2xx whose JSON body was
  // `null` threw a TypeError on `note.id` where the pre-#405 verb returned
  // `{ url: null, error }` — silently breaking the "Never throws" discipline
  // that this row of vcs-contract.md, ADR-0020 and the poster's error handling
  // all depend on.
  let url;
  try {
    const note = await call(`projects/${encoded}/merge_requests/${number}/notes`, 'POST', { body });
    url = `${base.replace(/\/api\/v4\/?$/, '')}/${project}/-/merge_requests/${number}#note_${note.id}`;
  } catch (err) {
    return { url: null, error: err.message };
  }
  if (!inline) return { url };

  // ── the anchors, as discussions ───────────────────────────────────────────
  //
  // `position` needs the MR's own diff_refs. Read inside the verb rather than
  // through a widened `prView` (design D4): prView's normalized shape is
  // consumed by cold-boot, tranche, checkpoint and anti-stale, and a
  // GitLab-only field for one caller does not belong there.
  let refs;
  try {
    const mr = await call(`projects/${encoded}/merge_requests/${number}`, 'GET');
    refs = mr?.diff_refs;
  } catch {
    refs = null;
  }
  // Unreadable refs mean every anchor is un-postable — reported as dropped, not
  // silently skipped, and never as a failed verdict.
  if (!refs) return { url, inlineDropped: inline.length };

  let dropped = 0;
  for (const c of inline) {
    try {
      await call(`projects/${encoded}/merge_requests/${number}/discussions`, 'POST', {
        body: c.body,
        // GitLab's Discussions API requires BOTH paths on a text position, not
        // just the one being annotated (cold review of PR #490, B2 — the first
        // version sent `new_path` alone).
        //
        // `new_line` alone, deliberately: `old_line` is what an anchor on an
        // unchanged (context) or DELETED line needs, and the `{path, line}` anchor
        // shape has no field to supply it. Such an anchor is refused by GitLab and
        // counted by `inlineDropped` — bounded and visible, not silently lost. It is
        // unreachable today (no evaluator anchors) and would be the first thing to
        // revisit if the anchor shape ever widens. For an added or modified line the two
        // are the same file; a rename would need the pre-rename path, which this
        // anchor shape has no way to know and which `deriveInlineComments` never
        // produces. The three shas come from the MR's own `diff_refs` — that read
        // is the whole reason for the extra GET above, so the payload is pinned
        // key-by-key rather than by a substring scan that `new_path` alone
        // satisfied.
        position: {
          position_type: 'text',
          new_path: c.path,
          old_path: c.path,
          new_line: c.line,
          base_sha: refs.base_sha,
          head_sha: refs.head_sha,
          start_sha: refs.start_sha,
        },
      });
    } catch {
      dropped += 1;
    }
  }
  // Absent when nothing was dropped, never 0 — "none requested" and "all
  // dropped" must not be the same answer to a reader.
  return dropped > 0 ? { url, inlineDropped: dropped } : { url };
}

/**
 * Posts a plain issue comment — rulings on issues (issue #266, REQ-266-2).
 * Never throws.
 *
 * @param {{ project: string, number: number, body: string, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<{ url: string } | { url: null, error: string }>}
 */
export async function issueComment({ project, number, body, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const base = apiBase ?? 'https://gitlab.com/api/v4';
  const encoded = encodeURIComponent(project);
  try {
    const r = await gitlabApiFetch({
      apiBase: base,
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/issues/${number}/notes`,
      method: 'POST',
      body: { body },
      fetchImpl,
    });
    return { url: `${base.replace(/\/api\/v4\/?$/, '')}/${project}/-/issues/${number}#note_${r.id}` };
  } catch (err) {
    return { url: null, error: err.message };
  }
}

/**
 * Adds labels to an issue (issue #266, REQ-266-2). Targets the issues
 * endpoint, matching `labelEvents`' issues-only precedent on this provider.
 * The CALLER enforces the deny-set (REQ-266-9, monotonic label tightening) —
 * this verb performs the label API call only, no policy. Never throws.
 *
 * @param {{ project: string, number: number, labels: string[], apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function labelAdd({ project, number, labels, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const encoded = encodeURIComponent(project);
  try {
    await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/issues/${number}`,
      method: 'PUT',
      body: { add_labels: labels.join(',') },
      fetchImpl,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Removes labels from an issue — monotonic-tightening removals only (issue
 * #266, REQ-266-9); the caller enforces the deny-set. Never throws.
 *
 * @param {{ project: string, number: number, labels: string[], apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function labelRemove({ project, number, labels, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const encoded = encodeURIComponent(project);
  try {
    await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/issues/${number}`,
      method: 'PUT',
      body: { remove_labels: labels.join(',') },
      fetchImpl,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * labelList — the provider-agnostic `labelList` verb (issue #334,
 * vcs-label-preflight spec): the remote's full declared label set, normalized
 * to bare name strings. Consumed by `labelPreflight` as the pre-write
 * conformance check — GitLab's MR-create payload otherwise SILENTLY CREATES
 * an unknown label, polluting the project taxonomy (design A2); a pre-flight
 * catches that BEFORE the write.
 *
 * `gitlabApiFetch` returns only the parsed JSON body (no response headers),
 * so pagination cannot follow GitLab's `Link` header the way `gh api
 * --paginate` does — instead this fetches page-by-page (`per_page=100`) and
 * stops once a page comes back short (fewer than `per_page` entries), the
 * standard REST-pagination termination condition. Load-bearing, same as
 * GitHub's `--paginate`: a repo with >100 labels must not silently drop a
 * real label and false-reject a valid ship.
 *
 * `{ apiBase, token, proxyUrl }` are threaded in as PARAMETERS from the
 * caller, same discipline as every other verb in this GATE_FILE. May throw
 * like its sibling normalized READs — `labelPreflight`, not this verb, is
 * the total/never-throws policy layer (design A1).
 *
 * @param {{ project: string, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} opts
 * @returns {Promise<string[]>}
 */
export async function labelList({ project, apiBase, token, proxyUrl, fetchImpl } = {}) {
  const encoded = encodeURIComponent(project);
  const base = apiBase ?? 'https://gitlab.com/api/v4';
  const tok = glToken(token);
  const perPage = 100;
  const names = [];
  let page = 1;
  for (;;) {
    const arr = await gitlabApiFetch({
      apiBase: base,
      token: tok,
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/labels?per_page=${perPage}&page=${page}`,
      fetchImpl,
    });
    for (const l of arr) names.push(l.name);
    if (arr.length < perPage) break;
    page += 1;
  }
  return names;
}

/**
 * labelCreate — creates a label DEFINITION in the project's label set (issue
 * #1163); see the GitHub adapter for the contract. GitLab answers a duplicate
 * with 409, which is `{ ok: true, created: false }`. GitLab requires a
 * `#`-prefixed colour. Never throws.
 *
 * @param {{ project: string, name: string, color?: string, description?: string, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<{ ok: true, created: boolean } | { ok: false, error: string }>}
 */
export async function labelCreate({ project, name, color, description, apiBase, token, proxyUrl, fetchImpl } = {}) {
  try {
    await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encodeURIComponent(project)}/labels`,
      method: 'POST',
      body: { name, color: `#${String(color ?? 'ededed').replace(/^#/, '')}`, description: description ?? '' },
      fetchImpl,
    });
    return { ok: true, created: true };
  } catch (err) {
    if (/failed: 409 /.test(err.message)) return { ok: true, created: false };
    return { ok: false, error: err.message };
  }
}

/**
 * issueClose — closes an issue (issue #1188). The payload is `state_event` and
 * nothing else. Never throws.
 *
 * @param {{ project: string, number: number, apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function issueClose({ project, number, apiBase, token, proxyUrl, fetchImpl } = {}) {
  try {
    await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encodeURIComponent(project)}/issues/${number}`,
      method: 'PUT',
      body: { state_event: 'close' },
      fetchImpl,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

/**
 * The clone URL, with a host default (#386).
 *
 * `${host}` had no fallback, so an omitted host produced the literal string
 * `https://oauth2:***@undefined/x/y.git` — a URL that parses, looks plausible in a
 * log, and resolves to nothing. GitHub's equivalent has always defaulted; this is
 * the same default in the same shape, on the provider that lacked it.
 */
export async function repoCloneUrl({ host, project, token }) {
  return `https://oauth2:${token}@${host || 'gitlab.com'}/${encPath(project)}.git`;
}

export async function patSetupUrl({ host, name, scopes }) {
  return `https://${host || 'gitlab.com'}/-/user_settings/personal_access_tokens`
    + `?name=${enc(name)}&scopes=${scopes.map(enc).join(',')}`;
}

/**
 * Apply (or refresh) branch protection on GitLab via the protected branches API.
 * GitLab protected branches are available on all tiers for private repos — no
 * tier block exists unlike GitHub Free.
 *
 * Note: approval-count enforcement (requiredReviews) requires GitLab Premium's
 * approval rules API and is NOT enforced here. The protected branch itself is
 * the hard gate floor.
 *
 * @param {{ project: string, branch?: string, checks?: string[], requiredReviews?: number }}
 * @returns {{ enforced: boolean, reason?: string, remedy?: string }}
 */
export async function branchProtect({ project, branch = 'main', checks, requiredReviews = 1 } = {}) {
  const enc = encodeURIComponent(project);

  // Step 1: Protect the branch (the core hard gate).
  // push_access_level=0 → no direct pushes; everything must go through MRs.
  // merge_access_level=40 → Maintainers can merge.
  // allow_force_push=false → force pushes are blocked.
  const r = run('glab', [
    'api', '-X', 'POST',
    `projects/${enc}/protected_branches`,
    '-f', `name=${branch}`,
    '-f', 'push_access_level=0',
    '-f', 'merge_access_level=40',
    '-f', 'allow_force_push=false',
  ]);

  // Determine whether the branch is now protected (success OR already protected).
  // Match the HTTP status anchored with its `: ` prefix (glab prints "...: 409")
  // so a project slug that happens to contain "409" can't false-positive into
  // claiming the branch is protected when it is not.
  const alreadyProtected = r.stderr.includes(': 409') || /already protected/i.test(r.stderr);
  const isProtected = r.ok || alreadyProtected;

  if (!isProtected) {
    if (r.stderr.includes(': 401') || /unauthorized/i.test(r.stderr)) {
      return {
        enforced: false,
        reason: 'auth',
        remedy: 'authenticate: glab auth login (or set VCS_TOKEN)',
      };
    }
    if (r.stderr.includes(': 403') || /forbidden/i.test(r.stderr)) {
      return {
        enforced: false,
        reason: 'permission',
        remedy: 'requires Maintainer or Owner on the project',
      };
    }
    return {
      enforced: false,
      reason: 'unsupported',
      remedy: r.stderr.trim() || 'unknown error from glab api',
    };
  }

  // Step 2: Best-effort — require green pipelines when checks are provided.
  // Failure here does NOT flip the result; the protected branch is the floor.
  if (Array.isArray(checks) && checks.length > 0) {
    run('glab', ['api', '-X', 'PUT', `projects/${enc}`, '-f', 'only_allow_merge_if_pipeline_succeeds=true']);
  }

  // What was applied, and what was not (#348). Returning a bare `enforced: true`
  // over a `requiredReviews` this function never enforces is the shape brain
  // removes everywhere else: a result claiming success for work it did not do.
  // Silent when nothing was asked — at `lite` the tier's value is 0.
  const note = unappliedNote({
    requiredReviews,
    approvalCount: 'unavailable',
    remedy: 'brain does not enforce approval counts on GitLab (#348); the protected branch is the gate floor',
  });
  return note ? { enforced: true, reason: note } : { enforced: true };
}

// Capability cache — keyed by "project:branch" to avoid cross-test interference.
const _capabilityCache = new Map();

/**
 * Probe the GitLab API to determine whether branch protection APIs are accessible
 * for the given project+branch. Caches the result per project:branch for the
 * lifetime of the Node.js process.
 *
 * GitLab protected branches are free for private repos (no tier restriction),
 * so the result is generally 'available' when auth and permissions are satisfied.
 *
 * @param {{ project?: string, branch?: string }}
 * @returns {{ hardEnforcement: 'available' | 'unavailable' | 'unknown', remedy? }}
 */
export async function capabilities({ project = '', branch = 'main' } = {}) {
  const key = `${project}:${branch}`;
  if (_capabilityCache.has(key)) return _capabilityCache.get(key);

  const enc = encodeURIComponent(project);
  const r = run('glab', ['api', `projects/${enc}/protected_branches`]);

  let result;
  if (r.ok) {
    result = { hardEnforcement: 'available' };
  } else if (r.stderr.includes(': 401') || /unauthorized/i.test(r.stderr)) {
    result = { hardEnforcement: 'unavailable', remedy: 'authenticate (glab auth login / VCS_TOKEN)' };
  } else if (r.stderr.includes(': 403') || /forbidden/i.test(r.stderr)) {
    result = { hardEnforcement: 'unavailable', remedy: 'requires Maintainer on the project' };
  } else {
    result = { hardEnforcement: 'unknown', detail: r.stderr.trim() || 'unexpected error from glab api' };
  }

  // The SECOND axis (#348) — and the question it answers is BRAIN'S, not the
  // platform's. #348 ratified NOT implementing GitLab's approval-rules call, so
  // brain will not enforce an approval count on GitLab under ANY plan. Probing
  // the endpoint would answer a question nobody asked ("could Premium do it?")
  // at the cost of a second spawn, and this function's contract is one spawn
  // per project:branch — a test caught that immediately.
  //
  // So the answer is structural and needs no network: unavailable, with the
  // remedy naming both halves of the truth — the plan that would offer it, and
  // the fact that the protected branch is the gate floor regardless.
  result = {
    ...result,
    approvalCount: 'unavailable',
    approvalRemedy:
      'brain does not enforce approval counts on GitLab (#348 ratified): it needs the Premium '
      + 'approval-rules API. The protected branch is the gate floor, and brain\'s human signature '
      + 'is `status:approved` + actor-check, which does not depend on this.',
  };

  _capabilityCache.set(key, result);
  return result;
}

/**
 * projectMergeSettings — the project-level merge gate with no protected-branch
 * equivalent (issue #244 A4, Decision 2). only_allow_merge_if_pipeline_succeeds
 * is GitLab's analog of GitHub required_status_checks and the load-bearing
 * signal that actually blocks MRs (CP-A2b). Uses the glab session like
 * capabilities()/branchProtect() — no pipeline-env read (GATE_FILE). `null` =
 * uncomputable (read failed or unparsable), NEVER a fabricated `false`.
 *
 * @param {{ project?: string }}
 * @returns {Promise<{ onlyAllowMergeIfPipelineSucceeds: boolean|null }>}
 */
export async function projectMergeSettings({ project = '' } = {}) {
  const enc = encodeURIComponent(project);
  const r = run('glab', ['api', `projects/${enc}`]);
  if (!r.ok) return { onlyAllowMergeIfPipelineSucceeds: null };
  try {
    const v = JSON.parse(r.stdout).only_allow_merge_if_pipeline_succeeds;
    // A 200 + parseable body does NOT guarantee the field is present — GitLab
    // permission-gates some project attributes, so a missing field is a real,
    // distinct case from "read failed"/"unparsable". `Boolean(undefined)`
    // would fabricate `false` ("readable, not configured"); only a genuine
    // boolean in the payload counts as computed — anything else is `null`
    // (uncomputable), never a fabricated `false`.
    return { onlyAllowMergeIfPipelineSucceeds: typeof v === 'boolean' ? v : null };
  } catch {
    return { onlyAllowMergeIfPipelineSucceeds: null };
  }
}

/**
 * mrCreate — un-stubbed (issue #239 A3 Phase 2, REQ-A3-4) over
 * `POST /projects/:id/merge_requests`, via the shared `gitlabApiFetch`
 * transport (never a second hand-rolled fetch). `labels` normalizes to
 * GitLab's comma-separated string, omitted entirely when empty (never a
 * fabricated empty-string label). `{ apiBase, token, proxyUrl }` threaded in
 * as PARAMETERS, same discipline as `prView`/`issueView` — this file is a
 * GATE_FILE and never reads pipeline env directly.
 *
 * Never throws: matches the `github.mrCreate` contract exactly — `{ url }`
 * on success, `{ url: null, error }` on failure.
 *
 * @param {{ project: string, title: string, body: string, head: string, base?: string, labels?: string[], apiBase?: string, token?: string, proxyUrl?: string|null, fetchImpl?: Function }} params
 * @returns {Promise<{ url: string } | { url: null, error: string }>}
 */
/**
 * issueCreate — open an issue through the port (issue #528). GitHub's twin above.
 *
 * The refusal resolves the approval label through `resolveApprovedLabel`, which maps
 * it to GitLab's SCOPED form (`status::approved`). A hardcoded `status:approved`
 * would never match here, so the guard would be inert on this provider only — the
 * exact shape of "green in test, inert in production" that epic #335 exists to close.
 *
 * @param {{ project: string, title: string, body?: string, labels?: string[], config?: object, apiBase?: string, token?: string, proxyUrl?: string, fetchImpl?: Function }} params
 * @returns {Promise<{ number: number|null, url: string|null, error?: string }>}
 */
export async function issueCreate({
  project, title, body = '', labels = [], config,
  apiBase, token, proxyUrl, fetchImpl,
} = {}) {
  assertNoApprovalLabel(labels, { config, provider: 'gitlab' });

  const payload = { title, description: body };
  if (labels.length > 0) payload.labels = labels.join(',');

  try {
    const r = await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encodeURIComponent(project)}/issues`,
      method: 'POST',
      body: payload,
      fetchImpl,
    });
    return { number: r.iid ?? null, url: r.web_url ?? null };
  } catch (err) {
    return { number: null, url: null, error: err.message };
  }
}

export async function mrCreate({
  project,
  title,
  body,
  head,
  base = 'main',
  labels = [],
  apiBase,
  token,
  proxyUrl,
  fetchImpl,
} = {}) {
  const encoded = encodeURIComponent(project);
  const payload = {
    source_branch: head,
    target_branch: base,
    title,
    description: body,
  };
  if (labels.length > 0) payload.labels = labels.join(',');

  try {
    const r = await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/merge_requests`,
      method: 'POST',
      body: payload,
      fetchImpl,
    });
    return { url: r.web_url };
  } catch (err) {
    return { url: null, error: err.message };
  }
}

// Anchored on `API failed:` (gitlab-api.mjs:65's own wrapper text), never a
// bare `\b405\b` — an MR whose iid happens to be 405 would otherwise produce
// `GitLab API failed: 500 (projects/x%2Fy/merge_requests/405/merge)` and a
// bare digit rule would misread that outage as "this forge will never do
// this" (design A3). Sibling precedent: gitlab.branchProtect's anchored
// `': 409'` check.
const GITLAB_MR_AUTO_MERGE_UNSUPPORTED_RE = /API failed:\s*(?:405|406)\b/;

/**
 * Arms auto-merge (squash, hardcoded, pipeline-gated) via
 * `PUT projects/{enc}/merge_requests/{number}/merge`, or refuses when
 * `requiredReviews` says a human gate is still required. The refusal is the
 * FIRST statement (design A4) — no `gitlabApiFetch` call is ever made on
 * that path. Never throws.
 *
 * @param {{ project: string, number: number, requiredReviews?: number,
 *   apiBase?: string, token?: string, proxyUrl?: string, fetchImpl?: Function }} params
 * @returns {Promise<{enabled:true,url:string|null}|{enabled:false,reason:string}|{enabled:false,reason:string,error:string}>}
 */
export async function mrAutoMerge({
  project,
  number,
  requiredReviews = 1,
  apiBase,
  token,
  proxyUrl,
  fetchImpl,
} = {}) {
  // Only the NUMBER 0 may arm (cold-review blocker 1). `> 0` is false for
  // null/NaN/-1 too — a naive predicate ARMS on all three, a fail-open gate
  // on a mutating write verb. `!== 0` makes exact-zero the only permission;
  // a string `'0'` stays refused because strict equality never coerces.
  if (requiredReviews !== 0) return refused({ reason: AUTO_MERGE_REASONS.REQUIRES_HUMAN_APPROVAL });

  const encoded = encodeURIComponent(project);
  try {
    const r = await gitlabApiFetch({
      apiBase: apiBase ?? 'https://gitlab.com/api/v4',
      token: glToken(token),
      proxyUrl: proxyUrl ?? null,
      path: `projects/${encoded}/merge_requests/${number}/merge`,
      method: 'PUT',
      body: { merge_when_pipeline_succeeds: true, squash: true },
      fetchImpl,
    });
    return armed({ url: r?.web_url ?? null });
  } catch (err) {
    // `err` is not always an `Error` — a `fetchImpl` may reject with a bare
    // string or `null` (correction 4). `err?.message` is safe on `null`
    // (optional chaining short-circuits to `undefined`, never throws), and
    // `?? String(err)` covers the non-Error case instead of leaving `error`
    // `undefined` and breaking the pinned transport key set.
    const message = err?.message ?? String(err);
    if (GITLAB_MR_AUTO_MERGE_UNSUPPORTED_RE.test(message)) {
      return refused({ reason: AUTO_MERGE_REASONS.UNSUPPORTED, error: message });
    }
    return refused({ reason: AUTO_MERGE_REASONS.TRANSPORT, error: message });
  }
}
