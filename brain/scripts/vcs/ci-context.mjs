// ci-context.mjs — normalizes CI provider context into ONE shape (ADR-0016,
// REQ-CIC-1..5, openspec/changes/issue-193-ci-context-design/specs/ci-context/spec.md).
//
// detectCi() resolves which CI provider is running: 'github' | 'gitlab' | 'unknown' | 'local'
// (strict precedence, REQ-CIC-1). loadContext() returns one normalized object regardless
// of provider — every field is its value or `null` when uncomputable (REQ-CIC-2). Gates
// consume ONLY this object; this module is the sole place allowed to read pipeline
// context env vars (BASE_SHA, HEAD_SHA, PR_NUMBER, GITHUB_*, CI_MERGE_REQUEST_*, CI_PROJECT_*,
// PR_BODY) — a drift-guard test (ci-context-drift-guard.test.mjs) enforces this.
//
// Never throws: an internal failure (fetch error, malformed JSON) yields `null` on the
// affected fields only, never an exception (Decision 2 / REQ-CIC-2).

import { getVcs } from './cli.mjs';
import { gitlabApiFetch } from './gitlab-api.mjs';

/**
 * @param {{ env?: NodeJS.ProcessEnv }} [deps]
 * @returns {'github'|'gitlab'|'unknown'|'local'}
 */
export function detectCi(deps = {}) {
  const env = deps.env ?? process.env;
  if (env.GITHUB_ACTIONS === 'true') return 'github';
  if (env.GITLAB_CI === 'true') return 'gitlab';
  if (env.CI === 'true') return 'unknown';
  return 'local';
}

function emptyContext(provider) {
  return {
    provider,
    prNumber: null,
    baseSha: null,
    headSha: null,
    sourceBranch: null,
    targetBranch: null,
    defaultBranch: null,
    labels: null,
    body: null,
    author: null,
    repo: null,
    isMergeRequest: false,
  };
}

// ── GitHub (Decision 3 — extract, don't rewrite; author is net-new via prView) ─

async function loadGithubContext(env, deps) {
  // Guard against a malformed PR_NUMBER: '' → null, 'x' → null (never NaN → prView).
  const prNumber =
    env.PR_NUMBER && Number.isInteger(Number(env.PR_NUMBER)) ? Number(env.PR_NUMBER) : null;
  // THROUGH THE PORT, not the module (issue #130, the residual #479 did not name).
  //
  // This used to call `githubPrView` directly, which bypasses `getVcs()` — and
  // `getVcs()` is where #479 put the credential resolution. The direct call therefore
  // reached `gh` with whatever the environment happened to hold, which is exactly the
  // ambient-auth defect #479 removed one layer up. It looked fine only because every
  // job that needed it also set `GH_TOKEN`, so `gh` authenticated by accident.
  //
  // Measured: migrating `issue-link` to declare only `VCS_TOKEN` turned this job red
  // with "MR body uncomputable (context API fetch failed)" — the seam's last hole,
  // found by removing the accident that was covering it.
  const prView = deps.prView ?? (async (args) => (await getVcs({ provider: 'github' })).prView(args));

  let labels = null;
  let body = null;
  let author = null;
  if (prNumber != null) {
    try {
      const pr = await prView({ number: prNumber });
      labels = pr?.labels ?? null;
      body = pr?.body ?? null;
      author = pr?.author ?? null;
    } catch {
      // prView never throws by contract, but never let a defensive failure escape.
    }
  }

  // author comes from the prView API payload ONLY, never from env (ADR-0016
  // Never-do #3). The actor-check job provides PR_NUMBER (governance.yml) so prView
  // runs; absent a PR, author stays null (uncomputable).
  //
  // defaultBranch (REQ-CIC-2 delta, issue #231 A2 phase 2 addendum): sourced from
  // the MAPPED env var DEFAULT_BRANCH, which governance.yml sets from
  // `github.event.repository.default_branch` — repo metadata, not trigger
  // identity, so this is coherent with ADR-0016 ruling 1 (never a raw GITHUB_*
  // payload var read outside this module). `null` when the workflow does not map
  // it — consumers MUST fail closed on `null`, never assume 'main'.
  return {
    provider: 'github',
    prNumber,
    baseSha: env.BASE_SHA ?? null,
    headSha: env.HEAD_SHA ?? null,
    sourceBranch: env.GITHUB_HEAD_REF ?? null,
    targetBranch: env.BASE_BRANCH ?? null,
    defaultBranch: env.DEFAULT_BRANCH ?? null,
    labels,
    body,
    author,
    repo: env.GITHUB_REPOSITORY ?? null,
    isMergeRequest: env.GITHUB_EVENT_NAME === 'pull_request',
  };
}

// ── GitLab (Decision 4 — designed in A0, built here; REQ-CIC-5 single MR call) ─

/**
 * Resolves the GitLab REST v4 API transport config ({ apiBase, token,
 * proxyUrl }) from the sanctioned env source. This is the SAME resolution
 * defaultFetchMr uses for the MR fetch (REQ-CIC-5), exposed as its own
 * function (issue #231 CP-A2b live-validation finding #12) so OTHER
 * CI-consumed GitLab verbs — axes/vcs/adapters/gitlab.mjs's issueView, threaded via
 * run-check.mjs's defaultFetchIssue — can obtain the identical config
 * WITHOUT reading `process.env.CI_API_V4_URL` themselves. gitlab.mjs and
 * run-check.mjs are both GATE_FILEs (ci-context-drift-guard.test.mjs); this
 * function is ci-context.mjs's sole-sanctioned-reader contract extended to a
 * new consumer, never a second env-reading site.
 *
 * Not folded into loadContext()'s returned ctx: this is transport config,
 * not normalized pipeline context, and ctx's field set must stay identical
 * across GitHub/GitLab (REQ-CIC-2).
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [deps]
 * @returns {{ apiBase: string, token: string|undefined, proxyUrl: string|null }}
 */
export function gitlabApiConfig(deps = {}) {
  const env = deps.env ?? process.env;
  return {
    apiBase: env.CI_API_V4_URL ?? 'https://gitlab.com/api/v4',
    token: env.VCS_TOKEN,
    proxyUrl: env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null,
  };
}

/**
 * Fetches MR description + author + labels in exactly ONE GitLab API call
 * (REQ-CIC-5), via the shared gitlab-api.mjs transport (issue #231 CP-A2b
 * finding #12 — "never a second parser": ONE fetcher, N consumers). Never
 * throws by construction; the caller (loadGitlabContext) treats any
 * rejection as "uncomputable" (null).
 */
async function defaultFetchMr({ env, prNumber, fetchImpl }) {
  const { apiBase, token, proxyUrl } = gitlabApiConfig({ env });
  const projectId = encodeURIComponent(env.CI_PROJECT_ID ?? env.CI_PROJECT_PATH ?? '');
  const data = await gitlabApiFetch({
    apiBase,
    token,
    proxyUrl,
    path: `projects/${projectId}/merge_requests/${prNumber}`,
    fetchImpl,
  });
  return { description: data.description, author: data.author, labels: data.labels };
}

async function loadGitlabContext(env, deps) {
  const prNumber = env.CI_MERGE_REQUEST_IID ? Number(env.CI_MERGE_REQUEST_IID) : null;
  const fetchMr = deps.fetchMr ?? ((args) => defaultFetchMr({ ...args, fetchImpl: deps.fetchImpl }));

  let labels = null;
  let body = null;
  let author = null;
  if (prNumber != null) {
    try {
      const mr = await fetchMr({ env, prNumber });
      labels = Array.isArray(mr?.labels) ? mr.labels : null;
      body = typeof mr?.description === 'string' ? mr.description : null;
      author = mr?.author?.username ?? null;
    } catch {
      labels = null;
      body = null;
      author = null;
    }
  }

  // defaultBranch (REQ-CIC-2 delta, issue #231 A2 phase 2 addendum): CI_DEFAULT_BRANCH
  // is a standard GitLab-predefined variable (free — no extra API call), unlike
  // GitHub's mapping which needs a workflow-level `env:` line.
  return {
    provider: 'gitlab',
    prNumber,
    baseSha: env.CI_MERGE_REQUEST_DIFF_BASE_SHA ?? null,
    headSha: env.CI_COMMIT_SHA ?? null,
    sourceBranch: env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ?? null,
    targetBranch: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME ?? null,
    defaultBranch: env.CI_DEFAULT_BRANCH ?? null,
    labels,
    body,
    author,
    repo: env.CI_PROJECT_PATH ?? null,
    isMergeRequest: prNumber != null,
  };
}

/**
 * Returns the normalized pipeline context for the current run (REQ-CIC-2).
 * Every field is its value or `null` when the provider cannot supply it.
 * `labels`/`body` are value-or-`null` too, but `[]`/`''` mean genuinely empty
 * while `null` means uncomputable (the fetch failed) — the two are always
 * distinguished (this is the one deliberate behavior change from the
 * pre-seam `prView()`, Decision 2). Never throws.
 *
 * @param {{ env?: NodeJS.ProcessEnv, provider?: string, prView?: Function, fetchMr?: Function, fetchImpl?: Function }} [deps]
 * @returns {Promise<object>}
 */
export async function loadContext(deps = {}) {
  const env = deps.env ?? process.env;
  const provider = deps.provider ?? detectCi({ env });

  try {
    if (provider === 'github') return await loadGithubContext(env, deps);
    if (provider === 'gitlab') return await loadGitlabContext(env, deps);
    return emptyContext(provider);
  } catch {
    return emptyContext(provider);
  }
}

/**
 * PR_BODY binary policy (design amendment 2): `body` is ALWAYS API-primary on
 * the normalized context — `loadContext()` never mixes in PR_BODY. This is the
 * ONLY sanctioned place a DETECTION consumer (e.g. actor-check.mjs) may fall
 * back to PR_BODY when the API body is uncomputable (`null`). A REQUIRED
 * consumer (e.g. issue-link) MUST read `ctx.body` directly and MUST NOT call
 * this — it must fail closed on `null`, never on a stale env fallback.
 *
 * A genuinely empty API body (`''`) is a real value and is returned as-is;
 * only `null`/`undefined` (uncomputable) triggers the PR_BODY fallback.
 *
 * @param {{ body?: string|null }} ctx
 * @param {{ env?: NodeJS.ProcessEnv }} [deps]
 * @returns {string|null}
 */
export function resolveDetectionBody(ctx, deps = {}) {
  const env = deps.env ?? process.env;
  const body = ctx?.body;
  if (body !== null && body !== undefined) return body;
  return env.PR_BODY ?? null;
}
