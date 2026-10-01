// providers.test.mjs — Integration tests for GitHub and GitLab provider verbs (PR2).
// Uses the exec.mjs test seam (setSpawn) to inject canned CLI output.
// Run with: npm test  (node --test, no dependencies)

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setSpawn } from './lib/exec.mjs';

import * as github from '../axes/vcs/adapters/github.mjs';
import * as gitlab from '../axes/vcs/adapters/gitlab.mjs';

afterEach(() => setSpawn(spawnSync));

/** Returns a fake spawn function that always yields the given data as JSON stdout. */
const fakeSpawn = (data, status = 0) => () => ({
  status,
  stdout: typeof data === 'string' ? data : JSON.stringify(data),
  stderr: '',
});

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Loads and parses a fixture JSON file by name. */
function loadFixture(name) {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}${name}`, 'utf8'));
}

// ── whoami ───────────────────────────────────────────────────────────────────────

test('github.whoami returns normalized username', async () => {
  setSpawn(fakeSpawn({ login: 'testuser' }));
  const result = await github.whoami();
  assert.deepEqual(result, { username: 'testuser' });
});

test('gitlab.whoami returns normalized username', async () => {
  setSpawn(fakeSpawn({ username: 'gluser' }));
  const result = await gitlab.whoami();
  assert.deepEqual(result, { username: 'gluser' });
});

// #413: with `token`, whoami resolves the identity OF THAT TOKEN, not the
// ambient CLI session — GH via GH_TOKEN env precedence, GL via the shared
// gitlabApiFetch transport (PRIVATE-TOKEN header), no spawn at all.

test('github.whoami({ token }) scopes the call to the token via GH_TOKEN (#413)', async () => {
  let seenOpts = null;
  setSpawn((cmd, args, opts) => {
    seenOpts = opts;
    return { status: 0, stdout: JSON.stringify({ login: 'the-bot' }), stderr: '' };
  });
  const result = await github.whoami({ token: 'tok-bot' });
  assert.deepEqual(result, { username: 'the-bot' });
  assert.equal(seenOpts.env.GH_TOKEN, 'tok-bot', 'the token must reach gh as GH_TOKEN — precedence over keyring auth');
});

test('github.whoami() without token passes NO env override — ambient behavior unchanged (#413)', async () => {
  let seenOpts = null;
  setSpawn((cmd, args, opts) => {
    seenOpts = opts;
    return { status: 0, stdout: JSON.stringify({ login: 'cli-user' }), stderr: '' };
  });
  await github.whoami();
  assert.equal(seenOpts.env, undefined, 'no token → spawn env untouched, gh keeps its own auth');
});

test('gitlab.whoami({ token }) uses gitlabApiFetch with PRIVATE-TOKEN, no spawn (#413)', async () => {
  setSpawn(() => { throw new Error('token path must not spawn glab'); });
  let seenUrl = null;
  let seenHeaders = null;
  const fetchImpl = async (url, options) => {
    seenUrl = url;
    seenHeaders = options.headers;
    return { ok: true, json: async () => ({ username: 'the-bot' }) };
  };
  const result = await gitlab.whoami({ token: 'tok-bot', apiBase: 'https://gl.example/api/v4', fetchImpl });
  assert.deepEqual(result, { username: 'the-bot' });
  assert.equal(seenUrl, 'https://gl.example/api/v4/user');
  assert.equal(seenHeaders['PRIVATE-TOKEN'], 'tok-bot');
});

test('gitlab.whoami({ token }) rejects on a transport failure — the contract discipline holds (#413)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    () => gitlab.whoami({ token: 'bad', apiBase: 'https://gl.example/api/v4', fetchImpl }),
    /GitLab API failed: 401/,
  );
});

// ── issueView ────────────────────────────────────────────────────────────────────

test('github.issueView returns normalized shape', async () => {
  setSpawn(fakeSpawn({ number: 42, title: 'Test issue', labels: [{ name: 'bug' }], body: 'Fix this', user: { login: 'alice' }, state: 'open', state_reason: null }));
  const result = await github.issueView({ project: 'o/r', number: 42 });
  assert.deepEqual(result, { number: 42, title: 'Test issue', labels: ['bug'], body: 'Fix this', author: 'alice', assignees: null, state: 'open', stateReason: null });
});

// issueView gains `author` (issue #239 A3 TASK1 — a fresh-context review
// finding): actor-check.mjs's gatherActorCheckInputs needs the issue AUTHOR
// (REQ-L5-1 compares against both the PR author and the issue author), which
// the pre-A3-TASK1 contract never exposed — the same underlying API call
// already returns it (GH `user.login`, GL `author.username`), no extra
// round-trip.
test('github.issueView author defaults to null when the underlying user field is absent', async () => {
  setSpawn(fakeSpawn({ number: 5, title: 't', labels: [], body: '' }));
  const result = await github.issueView({ project: 'o/r', number: 5 });
  assert.equal(result.author, null);
});

// gitlab.issueView (issue #231 CP-A2b live-validation finding #12): migrated
// off the `glab` CLI to a direct GitLab API v4 fetch — the node:22 CI image
// has no `glab` binary, so the REQUIRED issue-link gate's defaultFetchIssue
// crashed on an INFRA trigger. Exercised here via an injected `fetchImpl`
// (never real network in tests) — no `setSpawn` fixture at all, which is
// itself the point: the DEFAULT path must never reach for a CLI.
test('gitlab.issueView returns normalized shape (direct API v4 fetch, no glab CLI)', async () => {
  let seenUrl;
  let seenHeaders;
  const result = await gitlab.issueView({
    project: 'g/r',
    number: 7,
    apiBase: 'https://gitlab.example.com/api/v4',
    token: 'tok-abc',
    fetchImpl: async (url, options) => {
      seenUrl = url;
      seenHeaders = options?.headers;
      return { ok: true, json: async () => ({ iid: 7, title: 'GL issue', labels: ['feat'], description: 'body text', author: { username: 'bob' }, state: 'opened' }) };
    },
  });
  assert.equal(seenUrl, 'https://gitlab.example.com/api/v4/projects/g%2Fr/issues/7');
  assert.equal(seenHeaders?.['PRIVATE-TOKEN'], 'tok-abc');
  assert.deepEqual(result, { number: 7, title: 'GL issue', labels: ['feat'], body: 'body text', author: 'bob', assignees: null, state: 'open', stateReason: null });
});

test('gitlab.issueView author defaults to null when the underlying author field is absent', async () => {
  const result = await gitlab.issueView({
    project: 'g/r',
    number: 9,
    fetchImpl: async () => ({ ok: true, json: async () => ({ iid: 9, title: 't', labels: [], description: '' }) }),
  });
  assert.equal(result.author, null);
});

test('gitlab.issueView defaults apiBase to the public GitLab API when not provided (local/non-CI callers, e.g. ticket-start.mjs)', async () => {
  let seenUrl;
  await gitlab.issueView({
    project: 'g/r',
    number: 3,
    fetchImpl: async (url) => {
      seenUrl = url;
      return { ok: true, json: async () => ({ iid: 3, title: 't', labels: [], description: '' }) };
    },
  });
  assert.match(seenUrl, /^https:\/\/gitlab\.com\/api\/v4\//);
});

// ── Testing-lesson (finding #12 — the fixtures-injected-fetchIssue gap that
// hid this): prove the DEFAULT issueView implementation is CLI-free — it
// must never spawn `glab` (or any child process) regardless of what
// transport is injected. This is the exact regression class that let #12
// through: existing run-check.test.mjs fixtures always injected fetchIssue,
// so defaultFetchIssue's real vcs.issueView() call was never exercised. ────
test('gitlab.issueView never spawns a child process (glab CLI) — proves the default path is CLI-free, not just that injected logic works', async () => {
  let spawnCalled = false;
  setSpawn((...args) => {
    spawnCalled = true;
    return { status: 0, stdout: '{}', stderr: '' };
  });

  await gitlab.issueView({
    project: 'g/r',
    number: 7,
    fetchImpl: async () => ({ ok: true, json: async () => ({ iid: 7, title: 't', labels: [], description: '' }) }),
  });

  assert.equal(spawnCalled, false, 'issueView must never call spawn/execFile (glab CLI) — direct API v4 fetch only');
});

// ── issueList ────────────────────────────────────────────────────────────────────

test('github.issueList filters pull_request entries', async () => {
  setSpawn(fakeSpawn([
    { number: 1, title: 'Issue A', labels: [{ name: 'bug' }] },
    { number: 2, title: 'PR B', labels: [], pull_request: { url: 'https://github.com/o/r/pull/2' } },
  ]));
  const result = await github.issueList({ project: 'o/r', state: 'open' });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { number: 1, title: 'Issue A', labels: ['bug'], assignees: null });
});

test('gitlab.issueList returns normalized array', async () => {
  setSpawn(fakeSpawn([{ iid: 10, title: 'GL Issue', labels: ['backend'] }]));
  const result = await gitlab.issueList({ project: 'g/r', state: 'open' });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { number: 10, title: 'GL Issue', labels: ['backend'], assignees: null });
});

// #459: both verbs used to return a PREFIX of the issue list — GitHub capped at one
// page of 100, GitLab at 50 — and every consumer read that prefix as "the issues".
// `brain:epic:map` draws a dependency graph from it, so a truncated list makes the map
// assert an absence of dependencies it never looked for. Silent truncation, same class
// as the unpaginated `prReviews` fetch that dropped the latest verdict.

test('#459: github.issueList paginates — an unpaginated fetch returned a silent prefix', async () => {
  let argv = null;
  setSpawn((cmd, args) => {
    argv = args;
    return { status: 0, stdout: '[]', stderr: '' };
  });
  await github.issueList({ project: 'o/r', state: 'open' });
  assert.ok(argv.includes('--paginate'), '`gh api` does not auto-paginate: without this flag the list stops at page 1');
});

test('#459: gitlab.issueList follows pages until a short one', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ iid: i + 1, title: `t${i + 1}`, labels: [] }));
  const page2 = [{ iid: 101, title: 't101', labels: [] }];
  const seen = [];
  setSpawn((cmd, args) => {
    const endpoint = args[args.length - 1];
    seen.push(endpoint);
    const page = Number(endpoint.match(/[&?]page=(\d+)/)[1]);
    return { status: 0, stdout: JSON.stringify(page === 1 ? page1 : page === 2 ? page2 : []), stderr: '' };
  });

  const result = await gitlab.issueList({ project: 'g/r', state: 'open' });

  assert.equal(result.length, 101, 'the second page must be fetched and appended, not dropped');
  assert.equal(result[100].number, 101);
  assert.equal(seen.length, 2, 'a short page terminates the walk — it must not keep asking for empty pages');
});

test('#459: gitlab.issueList stops after a single short page — no wasted round-trip', async () => {
  let calls = 0;
  setSpawn(() => {
    calls += 1;
    return { status: 0, stdout: JSON.stringify([{ iid: 10, title: 'GL Issue', labels: [] }]), stderr: '' };
  });
  const result = await gitlab.issueList({ project: 'g/r', state: 'open' });
  assert.equal(result.length, 1);
  assert.equal(calls, 1);
});

// ── mrList ───────────────────────────────────────────────────────────────────────

test('github.mrList returns headBranch from head.ref', async () => {
  setSpawn(fakeSpawn([{ number: 1, title: 'Fix', head: { ref: 'feat/foo' }, state: 'open', merged_at: null }]));
  const result = await github.mrList({ project: 'o/r', state: 'open' });
  assert.deepEqual(result, [{ number: 1, title: 'Fix', headBranch: 'feat/foo', state: 'open', merged: false }]);
});

test('gitlab.mrList returns headBranch from source_branch', async () => {
  setSpawn(fakeSpawn([{ iid: 1, title: 'Fix', source_branch: 'feat/bar', state: 'opened' }]));
  const result = await gitlab.mrList({ project: 'g/r', state: 'open' });
  assert.deepEqual(result, [{ number: 1, title: 'Fix', headBranch: 'feat/bar', state: 'open', merged: false }]);
});

// #930 D1 — the additive `merged`/`state` mapping.

test('github.mrList maps a closed, merged PR to state:closed, merged:true', async () => {
  setSpawn(fakeSpawn([{ number: 2, title: 'Merged', head: { ref: 'feat/m' }, state: 'closed', merged_at: '2026-09-10T12:00:00Z' }]));
  const result = await github.mrList({ project: 'o/r', state: 'all' });
  assert.deepEqual(result[0], { number: 2, title: 'Merged', headBranch: 'feat/m', state: 'closed', merged: true });
});

test('github.mrList maps a closed, unmerged PR to state:closed, merged:false', async () => {
  setSpawn(fakeSpawn([{ number: 3, title: 'Abandoned', head: { ref: 'feat/a' }, state: 'closed', merged_at: null }]));
  const result = await github.mrList({ project: 'o/r', state: 'all' });
  assert.deepEqual(result[0], { number: 3, title: 'Abandoned', headBranch: 'feat/a', state: 'closed', merged: false });
});

test('github.mrList maps a missing merged_at field to merged:null — never guessed', async () => {
  setSpawn(fakeSpawn([{ number: 4, title: 'Unknown', head: { ref: 'feat/u' }, state: 'closed' }]));
  const result = await github.mrList({ project: 'o/r', state: 'all' });
  assert.deepEqual(result[0], { number: 4, title: 'Unknown', headBranch: 'feat/u', state: 'closed', merged: null });
});

test('gitlab.mrList maps native state:merged to state:closed, merged:true', async () => {
  setSpawn(fakeSpawn([{ iid: 2, title: 'Merged', source_branch: 'feat/m', state: 'merged' }]));
  const result = await gitlab.mrList({ project: 'g/r', state: 'all' });
  assert.deepEqual(result[0], { number: 2, title: 'Merged', headBranch: 'feat/m', state: 'closed', merged: true });
});

test('gitlab.mrList maps native state:closed (never merged) to state:closed, merged:false', async () => {
  setSpawn(fakeSpawn([{ iid: 3, title: 'Abandoned', source_branch: 'feat/a', state: 'closed' }]));
  const result = await gitlab.mrList({ project: 'g/r', state: 'all' });
  assert.deepEqual(result[0], { number: 3, title: 'Abandoned', headBranch: 'feat/a', state: 'closed', merged: false });
});

test('gitlab.mrList maps an unrepresentable native state (e.g. locked) to state:null, merged:null', async () => {
  setSpawn(fakeSpawn([{ iid: 4, title: 'Locked', source_branch: 'feat/l', state: 'locked' }]));
  const result = await gitlab.mrList({ project: 'g/r', state: 'all' });
  assert.deepEqual(result[0], { number: 4, title: 'Locked', headBranch: 'feat/l', state: null, merged: null });
});

// #930 D2 — the optional `headBranch` filter and its full-page fail-closed guard.

test('github.mrList unfiltered call stays byte-identical to the pre-#930 query — no head param added', async () => {
  let argv = null;
  setSpawn((cmd, args) => { argv = args; return { status: 0, stdout: '[]', stderr: '' }; });
  await github.mrList({ project: 'o/r', state: 'open' });
  assert.equal(argv[argv.length - 1], 'repos/o/r/pulls?state=open&per_page=100');
});

test('github.mrList({ headBranch }) filters by head=<owner>:<branch>, URL-encoded', async () => {
  let argv = null;
  setSpawn((cmd, args) => { argv = args; return { status: 0, stdout: '[]', stderr: '' }; });
  await github.mrList({ project: 'o/r', state: 'all', headBranch: 'memory/host-2026-01-01' });
  const endpoint = argv[argv.length - 1];
  assert.equal(endpoint, 'repos/o/r/pulls?state=all&head=o%3Amemory%2Fhost-2026-01-01&per_page=100');
});

test('github.mrList({ headBranch }) throws when the page comes back full (100) — fails closed on possible truncation', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `t${i}`, head: { ref: 'memory/host-2026-01-01' }, state: 'open', merged_at: null }));
  setSpawn(fakeSpawn(full));
  await assert.rejects(
    () => github.mrList({ project: 'o/r', state: 'all', headBranch: 'memory/host-2026-01-01' }),
    /full page|truncation/i,
  );
});

test('gitlab.mrList unfiltered call stays byte-identical to the pre-#930 query — no source_branch param, per_page=50', async () => {
  let argv = null;
  setSpawn((cmd, args) => { argv = args; return { status: 0, stdout: '[]', stderr: '' }; });
  await gitlab.mrList({ project: 'g/r', state: 'open' });
  const endpoint = argv[argv.length - 1];
  assert.equal(endpoint, `projects/${encodeURIComponent('g/r')}/merge_requests?state=opened&per_page=50`);
});

test('gitlab.mrList({ headBranch }) filters by source_branch, URL-encoded, per_page=100', async () => {
  let argv = null;
  setSpawn((cmd, args) => { argv = args; return { status: 0, stdout: '[]', stderr: '' }; });
  await gitlab.mrList({ project: 'g/r', state: 'all', headBranch: 'memory/host-2026-01-01' });
  const endpoint = argv[argv.length - 1];
  assert.equal(endpoint, `projects/${encodeURIComponent('g/r')}/merge_requests?state=all&source_branch=${encodeURIComponent('memory/host-2026-01-01')}&per_page=100`);
});

test('gitlab.mrList({ headBranch }) throws when the page comes back full (100) — fails closed on possible truncation', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ iid: i + 1, title: `t${i}`, source_branch: 'memory/host-2026-01-01', state: 'opened' }));
  setSpawn(fakeSpawn(full));
  await assert.rejects(
    () => gitlab.mrList({ project: 'g/r', state: 'all', headBranch: 'memory/host-2026-01-01' }),
    /full page|truncation/i,
  );
});

// ── commitStatus ─────────────────────────────────────────────────────────────────

test('github.commitStatus maps a completed failure → failed', async () => {
  setSpawn(fakeSpawn({ check_runs: [{ status: 'completed', conclusion: 'failure' }] }));
  const result = await github.commitStatus({ project: 'o/r', sha: 'abc' });
  assert.equal(result, 'failed');
});

test('gitlab.commitStatus maps canceled → canceled', async () => {
  setSpawn(fakeSpawn([{ status: 'canceled' }]));
  const result = await gitlab.commitStatus({ project: 'g/r', sha: 'abc' });
  assert.equal(result, 'canceled');
});

test('github.commitStatus maps a running check (status in_progress, conclusion null) → running', async () => {
  setSpawn(fakeSpawn({ check_runs: [{ status: 'in_progress', conclusion: null }] }));
  const result = await github.commitStatus({ project: 'o/r', sha: 'abc' });
  assert.equal(result, 'running');
});

test('github.commitStatus returns null when there are no checks', async () => {
  setSpawn(fakeSpawn({ check_runs: [] }));
  const result = await github.commitStatus({ project: 'o/r', sha: 'abc' });
  assert.equal(result, null);
});

// ── commitPrs (issue #1086 cold-review remediation) ───────────────────────────────
//
// GitLab's merge_requests-for-a-commit endpoint defaults to a small page size
// when no `per_page` is given (unlike GitHub's `commitPrs`, which spawns
// `gh api --paginate` and walks every page automatically — see github.mjs).
// Without an explicit `per_page`, a commit associated with more merge
// requests than the default page could return a SILENTLY TRUNCATED list —
// collapsing a true "two or more containing MRs" (uncomputable, per the
// dispatch table, design D4) into a false "exactly one" (audited as if it
// were unambiguous). Mirrors the `mrList` full-page precedent (#930/#936,
// see the headBranch tests above) — but `commitPrs` NEVER throws (its
// contract, unlike `mrList`'s): a full page means refuse-by-returning-null,
// the same uncomputable value a transport failure already yields.

test('gitlab.commitPrs requests per_page=100 explicitly (never relies on the GitLab default page size)', async () => {
  let seenUrl;
  await gitlab.commitPrs({
    project: 'g/r',
    sha: 'deadbeef',
    fetchImpl: async (url) => {
      seenUrl = url;
      return { ok: true, json: async () => [] };
    },
  });
  assert.match(seenUrl, /[?&]per_page=100(&|$)/, "commitPrs must request per_page=100, matching mrList's headBranch-filtered discipline");
});

test('gitlab.commitPrs returns null when the page comes back FULL (100) — refuses rather than decide on a possibly-truncated page', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ iid: i + 1 }));
  const result = await gitlab.commitPrs({
    project: 'g/r',
    sha: 'deadbeef',
    fetchImpl: async () => ({ ok: true, json: async () => full }),
  });
  assert.equal(result, null, 'a full page must be refused (null), never decided on — the same uncomputable value a transport failure yields');
});

test('gitlab.commitPrs returns the list intact, ascending, when the page is short (< 100)', async () => {
  const short = Array.from({ length: 3 }, (_, i) => ({ iid: 3 - i }));
  const result = await gitlab.commitPrs({
    project: 'g/r',
    sha: 'deadbeef',
    fetchImpl: async () => ({ ok: true, json: async () => short }),
  });
  assert.deepEqual(result, [1, 2, 3], 'a short page is returned intact and ascending — only a FULL page is refused');
});

// ── checkRuns (issue #203 review fix F3 — direct provider-level coverage) ────────

test('github.checkRuns maps check_runs[].name entries to an array of bare names', async () => {
  setSpawn(fakeSpawn({
    check_runs: [{ name: 'issue-link' }, { name: 'diff-size' }],
  }));
  const result = await github.checkRuns({ project: 'o/r', branch: 'main' });
  assert.deepEqual(result, ['issue-link', 'diff-size']);
});

test('github.checkRuns resolves to [] when the seam throws (never throws itself)', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 500: Internal Server Error' }));
  const result = await github.checkRuns({ project: 'o/r', branch: 'main' });
  assert.deepEqual(result, []);
});

test('gitlab.commitStatus maps a running pipeline → running', async () => {
  setSpawn(fakeSpawn([{ status: 'running' }]));
  const result = await gitlab.commitStatus({ project: 'g/r', sha: 'abc' });
  assert.equal(result, 'running');
});

// ── repoCloneUrl ─────────────────────────────────────────────────────────────────

test('github.repoCloneUrl builds x-access-token URL', async () => {
  const result = await github.repoCloneUrl({ host: 'github.com', project: 'o/r', token: 'tok' });
  assert.equal(result, 'https://x-access-token:tok@github.com/o/r.git');
});

test('gitlab.repoCloneUrl builds oauth2 URL', async () => {
  const result = await gitlab.repoCloneUrl({ host: 'gl.example.com', project: 'g/r', token: 'tok' });
  assert.equal(result, 'https://oauth2:tok@gl.example.com/g/r.git');
});

// ── patSetupUrl ──────────────────────────────────────────────────────────────────

// #388 — the scope values are percent-encoded, so `read:user` reaches the URL as
// `read%3Auser`. That is not over-caution, it is the consequence of choosing ONE
// rule: `encodeURIComponent` per value. A narrower hand-rolled encoder that spared
// `:` would be a list of characters someone has to keep correct, and the character
// it eventually misses is the defect. Both standard encoders agree here —
// `URLSearchParams` also emits `%3A` — and every conforming server percent-decodes
// a query value before reading it.
//
// The comma is NOT encoded: it separates scopes, so it is structure, not data.
test('github.patSetupUrl builds settings URL', async () => {
  const result = await github.patSetupUrl({ host: 'github.com', name: 'brain', scopes: ['read:user', 'repo'] });
  assert.equal(result, 'https://github.com/settings/tokens/new?description=brain&scopes=read%3Auser,repo');
});

test('gitlab.patSetupUrl builds settings URL', async () => {
  const result = await gitlab.patSetupUrl({ host: 'gl.example.com', name: 'brain', scopes: ['api', 'read_user'] });
  assert.equal(result, 'https://gl.example.com/-/user_settings/personal_access_tokens?name=brain&scopes=api,read_user');
});

// ── projectResolve ───────────────────────────────────────────────────────────────

test('github.projectResolve returns project slug unchanged', async () => {
  const result = await github.projectResolve({ project: 'o/r' });
  assert.equal(result, 'o/r');
});

test('gitlab.projectResolve returns the slug unchanged (identity)', async () => {
  // GitLab's API accepts the URL-encoded path everywhere, so the slug is the
  // project identifier — no numeric-id lookup, keeping it usable by repoCloneUrl.
  const result = await gitlab.projectResolve({ project: 'g/r' });
  assert.equal(result, 'g/r');
});

// ── branchProtect ─────────────────────────────────────────────────────────────

test('github.branchProtect sends PUT with strict payload and returns {enforced:true} on exit 0', async () => {
  let captured = null;
  setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { status: 0, stdout: '{}', stderr: '' };
  });

  const checks = ['governance / issue-link', 'governance / diff-size'];
  const result = await github.branchProtect({ project: 'o/r', checks });

  assert.ok(captured, 'spawn was called');
  assert.equal(captured.cmd, 'gh');
  assert.deepEqual(captured.args, [
    'api', '-X', 'PUT',
    'repos/o/r/branches/main/protection',
    '--input', '-',
  ]);

  const payload = JSON.parse(captured.opts.input);
  assert.equal(payload.required_status_checks.strict, true);
  assert.deepEqual(
    payload.required_status_checks.checks,
    [{ context: 'governance / issue-link' }, { context: 'governance / diff-size' }]
  );
  assert.equal(payload.enforce_admins, false);
  assert.equal(payload.required_pull_request_reviews.required_approving_review_count, 1);
  assert.equal(payload.restrictions, null);
  assert.equal(payload.allow_force_pushes, false);
  assert.equal(payload.allow_deletions, false);

  assert.deepEqual(result, { enforced: true });
});

test('github.branchProtect respects custom branch and requiredReviews', async () => {
  let captured = null;
  setSpawn((cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { status: 0, stdout: '{}', stderr: '' };
  });

  const result = await github.branchProtect({ project: 'o/r', branch: 'develop', checks: [], requiredReviews: 2 });

  assert.ok(captured.args.includes('repos/o/r/branches/develop/protection'));
  const payload = JSON.parse(captured.opts.input);
  assert.equal(payload.required_pull_request_reviews.required_approving_review_count, 2);
  assert.deepEqual(result, { enforced: true });
});

test('github.branchProtect returns {enforced:false,reason:"tier"} on 403 / upgrade message', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature.',
  }));

  const result = await github.branchProtect({ project: 'o/r', checks: [] });

  assert.equal(result.enforced, false);
  assert.equal(result.reason, 'tier');
  assert.ok(typeof result.remedy === 'string' && result.remedy.length > 0, 'remedy must be non-empty');
});

test('github.branchProtect returns {enforced:false,reason:"unsupported"} on other non-zero exit', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'HTTP 500: Internal Server Error',
  }));

  const result = await github.branchProtect({ project: 'o/r', checks: [] });

  assert.equal(result.enforced, false);
  assert.equal(result.reason, 'unsupported');
  assert.ok(result.remedy.includes('HTTP 500'), 'remedy should include the stderr text');
});

test('github.branchProtect never throws even on non-zero exit', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'some error' }));

  let threw = false;
  try {
    await github.branchProtect({ project: 'o/r', checks: [] });
  } catch (_) {
    threw = true;
  }
  assert.equal(threw, false, 'branchProtect must not throw');
});

test('gitlab.branchProtect sends POST to protected_branches with allow_force_push=false and returns {enforced:true} on exit 0', async () => {
  const calls = [];
  setSpawn((cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: '{}', stderr: '' };
  });

  const checks = ['ci/test', 'ci/lint'];
  const result = await gitlab.branchProtect({ project: 'g/r', branch: 'main', checks });

  // First call must be the POST to protected_branches
  assert.ok(calls.length >= 1, 'spawn was called at least once');
  const postCall = calls[0];
  assert.equal(postCall.cmd, 'glab');
  assert.ok(postCall.args.some(a => a.includes('protected_branches')), 'must POST to protected_branches endpoint');
  assert.ok(
    postCall.args.indexOf('POST') !== -1 &&
    postCall.args[postCall.args.indexOf('-X') + 1] === 'POST',
    'must use -X POST'
  );
  assert.ok(postCall.args.includes('allow_force_push=false'), 'must disable force pushes');

  // #348: protection succeeded AND the approval count was not applied — the
  // result now says both. `requiredReviews` defaults to 1 here, so the note fires.
  assert.equal(result.enforced, true);
  assert.match(result.reason, /NOT applied/, 'the verb states what it could not do');
  assert.deepEqual(Object.keys(result).sort(), ['enforced', 'reason']);
});

test('gitlab.branchProtect makes best-effort pipeline call when checks is non-empty', async () => {
  const calls = [];
  setSpawn((cmd, args) => {
    calls.push(args);
    return { status: 0, stdout: '{}', stderr: '' };
  });

  await gitlab.branchProtect({ project: 'g/r', checks: ['ci/test'] });

  // Second call should be the PUT to enable pipeline enforcement
  assert.ok(calls.length === 2, 'should make two spawn calls when checks is non-empty');
  assert.ok(calls[1].includes('only_allow_merge_if_pipeline_succeeds=true'), 'second call must enable pipeline requirement');
});

test('gitlab.branchProtect skips pipeline call when checks is empty', async () => {
  let callCount = 0;
  setSpawn(() => {
    callCount++;
    return { status: 0, stdout: '{}', stderr: '' };
  });

  await gitlab.branchProtect({ project: 'g/r', checks: [] });

  assert.equal(callCount, 1, 'should make only one spawn call when checks is empty');
});

test('gitlab.branchProtect returns {enforced:true} when branch is already protected (409 — idempotent)', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'POST https://gitlab.example.com/api/v4/projects/g%2Fr/protected_branches: 409\n{"message":"Protected Branch \'main\' already exists"}',
  }));

  const result = await gitlab.branchProtect({ project: 'g/r', checks: [] });
  // #348: protection succeeded AND the approval count was not applied — the
  // result now says both. `requiredReviews` defaults to 1 here, so the note fires.
  assert.equal(result.enforced, true);
  assert.match(result.reason, /NOT applied/, 'the verb states what it could not do');
  assert.deepEqual(Object.keys(result).sort(), ['enforced', 'reason']);
});

test('gitlab.branchProtect returns {enforced:false,reason:"auth"} on 401', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'POST https://gitlab.example.com/api/v4/projects/g%2Fr/protected_branches: 401\n{"message":"401 Unauthorized"}',
  }));

  const result = await gitlab.branchProtect({ project: 'g/r', checks: [] });
  assert.equal(result.enforced, false);
  assert.equal(result.reason, 'auth');
  assert.notEqual(result.reason, 'tier', 'GitLab branchProtect must never return reason:tier');
  assert.ok(typeof result.remedy === 'string' && result.remedy.length > 0, 'remedy must be non-empty');
});

test('gitlab.branchProtect returns {enforced:false,reason:"permission"} on 403 — never reason:"tier"', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'POST https://gitlab.example.com/api/v4/projects/g%2Fr/protected_branches: 403\n{"message":"403 Forbidden"}',
  }));

  const result = await gitlab.branchProtect({ project: 'g/r', checks: [] });
  assert.equal(result.enforced, false);
  assert.equal(result.reason, 'permission');
  assert.notEqual(result.reason, 'tier', 'GitLab branchProtect must never return reason:tier');
  assert.ok(typeof result.remedy === 'string' && result.remedy.length > 0, 'remedy must be non-empty');
});

test('gitlab.branchProtect: a 403 on a slug containing "409" is NOT a false-positive success', async () => {
  // Regression: the status must be matched anchored (": 409"), not anywhere in
  // stderr — a project slug like fix-409-auth must not flip a real 403 into enforced.
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'POST https://gitlab.example.com/api/v4/projects/org%2Ffix-409-auth/protected_branches: 403\n{"message":"403 Forbidden"}',
  }));

  const result = await gitlab.branchProtect({ project: 'org/fix-409-auth', checks: [] });
  assert.equal(result.enforced, false, 'a real 403 must not be misread as already-protected');
  assert.equal(result.reason, 'permission');
});

test('gitlab.branchProtect returns {enforced:true} even when the best-effort pipeline PUT fails', async () => {
  // POST (protect) succeeds; the optional only_allow_merge_if_pipeline_succeeds
  // PUT fails — that failure must NOT flip the result.
  let call = 0;
  setSpawn(() => {
    call += 1;
    return call === 1
      ? { status: 0, stdout: '{}', stderr: '' }                                  // POST succeeds
      : { status: 1, stdout: '', stderr: 'PUT .../projects/g%2Fr: 403\n{"message":"403 Forbidden"}' }; // PUT fails
  });

  const result = await gitlab.branchProtect({ project: 'g/r', checks: ['ci/test'] });
  // #348: protection succeeded AND the approval count was not applied — the
  // result now says both. `requiredReviews` defaults to 1 here, so the note fires.
  assert.equal(result.enforced, true);
  assert.match(result.reason, /NOT applied/, 'the verb states what it could not do');
  assert.deepEqual(Object.keys(result).sort(), ['enforced', 'reason']);
  assert.equal(call, 2, 'both the POST and the best-effort PUT must have been attempted');
});

test('gitlab.branchProtect returns {enforced:false,reason:"unsupported"} on unexpected error', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'POST https://gitlab.example.com/api/v4/projects/g%2Fr/protected_branches: 500\n{"message":"Internal Server Error"}',
  }));

  const result = await gitlab.branchProtect({ project: 'g/r', checks: [] });
  assert.equal(result.enforced, false);
  assert.equal(result.reason, 'unsupported');
  assert.notEqual(result.reason, 'tier', 'GitLab branchProtect must never return reason:tier');
  assert.ok(result.remedy.includes('500') || result.remedy.length > 0, 'remedy should include error detail');
});

test('gitlab.branchProtect never throws even on non-zero exit', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'some error' }));

  let threw = false;
  try {
    await gitlab.branchProtect({ project: 'g/r', checks: [] });
  } catch (_) {
    threw = true;
  }
  assert.equal(threw, false, 'branchProtect must not throw');
});

// ── mrAutoMerge (issue #886) — provider detail the contract layer
// deliberately does not assert (design A6): exact `gh` argv, exact GitLab
// path + payload. `--repo <project>` is pinned because `mrCreate` resolves
// the repo from the git remote instead (github.mjs:579) — a real
// behavioural difference worth pinning here.

test('github.mrAutoMerge sends the exact argv `pr merge <n> --auto --squash --repo <project>`', async () => {
  let captured = null;
  setSpawn((cmd, args) => {
    captured = { cmd, args };
    return { status: 0, stdout: '', stderr: '' };
  });

  const result = await github.mrAutoMerge({ project: 'o/r', number: 42, requiredReviews: 0 });

  assert.equal(captured.cmd, 'gh');
  assert.deepEqual(captured.args, ['pr', 'merge', '42', '--auto', '--squash', '--repo', 'o/r']);
  assert.deepEqual(result, { enabled: true, url: null });
});

test('gitlab.mrAutoMerge PUTs the exact path and payload', async () => {
  let seenUrl;
  let seenOptions;
  const result = await gitlab.mrAutoMerge({
    project: 'g/r',
    number: 42,
    requiredReviews: 0,
    apiBase: 'https://gitlab.example.com/api/v4',
    token: 'tok-abc',
    fetchImpl: async (url, options) => {
      seenUrl = url;
      seenOptions = options;
      return { ok: true, json: async () => ({ web_url: 'https://gitlab.example.com/g/r/-/merge_requests/42' }) };
    },
  });

  assert.equal(seenUrl, 'https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests/42/merge');
  assert.equal(seenOptions.method, 'PUT');
  assert.equal(seenOptions.headers['PRIVATE-TOKEN'], 'tok-abc');
  assert.deepEqual(JSON.parse(seenOptions.body), { merge_when_pipeline_succeeds: true, squash: true });
  assert.deepEqual(result, { enabled: true, url: 'https://gitlab.example.com/g/r/-/merge_requests/42' });
});

// A3 false-positive regression: an MR whose iid happens to be 405 must not
// have a genuine 500 outage misread as "this forge will never do this".
// Sibling precedent: gitlab.branchProtect's anchored `': 409'` test above.
test('gitlab.mrAutoMerge: a 500 on iid 405 classifies transport, not unsupported', async () => {
  const result = await gitlab.mrAutoMerge({
    project: 'x/y',
    number: 405,
    requiredReviews: 0,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'transport', 'a 500 status must never be misread as unsupported merely because the iid is 405');
  assert.match(result.error, /API failed: 500/);
});

// ── capabilities ──────────────────────────────────────────────────────────────

test('github.capabilities returns {hardEnforcement:"available"} when probe succeeds (200)', async () => {
  setSpawn(() => ({ status: 0, stdout: '{"url":"..."}', stderr: '' }));
  const result = await github.capabilities({ project: 'cap/ok', branch: 'main' });
  assert.equal(result.hardEnforcement, 'available');
});

test('github.capabilities returns {hardEnforcement:"available"} on 404 (protection not yet set)', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 404: Not Found' }));
  const result = await github.capabilities({ project: 'cap/noprot', branch: 'main' });
  assert.equal(result.hardEnforcement, 'available');
});

test('github.capabilities returns {hardEnforcement:"unavailable"} on 403', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'HTTP 403: Upgrade to GitHub Pro to enable this feature.',
  }));
  const result = await github.capabilities({ project: 'cap/tier', branch: 'main' });
  assert.equal(result.hardEnforcement, 'unavailable');
  assert.ok(typeof result.remedy === 'string' && result.remedy.length > 0, 'remedy must be present');
});

test('github.capabilities returns {hardEnforcement:"unknown"} on unexpected error', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 500: Internal Server Error' }));
  const result = await github.capabilities({ project: 'cap/err', branch: 'main' });
  assert.equal(result.hardEnforcement, 'unknown');
});

test('gitlab.capabilities returns {hardEnforcement:"available"} when GET protected_branches succeeds', async () => {
  setSpawn(() => ({ status: 0, stdout: '[]', stderr: '' }));
  const result = await gitlab.capabilities({ project: 'gl-cap/ok', branch: 'main' });
  assert.equal(result.hardEnforcement, 'available');
  assert.equal(result.remedy, undefined, 'no remedy when available');
});

test('gitlab.capabilities returns {hardEnforcement:"unavailable"} on 401', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'GET https://gitlab.example.com/api/v4/projects/gl-cap%2Fauth/protected_branches: 401\n{"message":"401 Unauthorized"}',
  }));
  const result = await gitlab.capabilities({ project: 'gl-cap/auth', branch: 'main' });
  assert.equal(result.hardEnforcement, 'unavailable');
  assert.ok(typeof result.remedy === 'string' && result.remedy.length > 0, 'remedy must be present');
});

test('gitlab.capabilities returns {hardEnforcement:"unavailable"} on 403', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'GET https://gitlab.example.com/api/v4/projects/gl-cap%2Fperm/protected_branches: 403\n{"message":"403 Forbidden"}',
  }));
  const result = await gitlab.capabilities({ project: 'gl-cap/perm', branch: 'main' });
  assert.equal(result.hardEnforcement, 'unavailable');
  assert.ok(typeof result.remedy === 'string' && result.remedy.length > 0, 'remedy must be present');
});

test('gitlab.capabilities returns {hardEnforcement:"unknown"} on unexpected error', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 500: Internal Server Error' }));
  const result = await gitlab.capabilities({ project: 'gl-cap/err', branch: 'main' });
  assert.equal(result.hardEnforcement, 'unknown');
});

test('gitlab.capabilities caches result and does not spawn twice for the same project:branch', async () => {
  let spawnCount = 0;
  setSpawn(() => {
    spawnCount++;
    return { status: 0, stdout: '[]', stderr: '' };
  });

  const r1 = await gitlab.capabilities({ project: 'gl-cap/cache', branch: 'main' });
  const r2 = await gitlab.capabilities({ project: 'gl-cap/cache', branch: 'main' });

  assert.equal(spawnCount, 1, 'spawn should be called only once (cache hit on second call)');
  assert.strictEqual(r1, r2, 'second call returns the same cached object reference');
  assert.equal(r1.hardEnforcement, 'available');
});

// ── projectMergeSettings (issue #244 A4) ────────────────────────────────────────
// The project-level merge gate (only_allow_merge_if_pipeline_succeeds) has no
// protected_branches equivalent — capabilities()/branchProtect() cannot surface
// it (design Decision 2). Fixture shape pinned by fixtures/gitlab-project.json
// (derived, _provenance-stamped — REQ-A4-5).

test('gitlab.projectMergeSettings parses only_allow_merge_if_pipeline_succeeds:true from the fixture', async () => {
  const fixture = loadFixture('gitlab-project.json');
  setSpawn(fakeSpawn(fixture.data));
  const result = await gitlab.projectMergeSettings({ project: 'g/r' });
  assert.deepEqual(result, { onlyAllowMergeIfPipelineSucceeds: true });
});

test('gitlab.projectMergeSettings parses only_allow_merge_if_pipeline_succeeds:false', async () => {
  const fixture = loadFixture('gitlab-project.json');
  setSpawn(fakeSpawn({ ...fixture.data, only_allow_merge_if_pipeline_succeeds: false }));
  const result = await gitlab.projectMergeSettings({ project: 'g/r' });
  assert.deepEqual(result, { onlyAllowMergeIfPipelineSucceeds: false });
});

test('gitlab.projectMergeSettings returns {onlyAllowMergeIfPipelineSucceeds:null} on a failed glab api read (never a fabricated false)', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'GET https://gitlab.example.com/api/v4/projects/g%2Fr: 404\n{"message":"404 Not Found"}' }));
  const result = await gitlab.projectMergeSettings({ project: 'g/r' });
  assert.deepEqual(result, { onlyAllowMergeIfPipelineSucceeds: null });
});

test('gitlab.projectMergeSettings returns {onlyAllowMergeIfPipelineSucceeds:null} on unparsable JSON, never throws', async () => {
  setSpawn(() => ({ status: 0, stdout: 'not json', stderr: '' }));
  await assert.doesNotReject(async () => {
    const result = await gitlab.projectMergeSettings({ project: 'g/r' });
    assert.deepEqual(result, { onlyAllowMergeIfPipelineSucceeds: null });
  });
});

test('gitlab.projectMergeSettings returns {onlyAllowMergeIfPipelineSucceeds:null} when the glab api read succeeds but the field is absent from the response (never a fabricated false — GitLab permission-gates some project attributes)', async () => {
  // 200 OK, parseable JSON, but only_allow_merge_if_pipeline_succeeds is
  // simply missing from the payload (a real case, distinct from a read
  // failure or unparsable body) — Boolean(undefined) would fabricate `false`
  // ("readable, not configured") instead of the honest `null` (uncomputable).
  setSpawn(fakeSpawn({ id: 1, path_with_namespace: 'g/r', default_branch: 'main' }));
  const result = await gitlab.projectMergeSettings({ project: 'g/r' });
  assert.deepEqual(result, { onlyAllowMergeIfPipelineSucceeds: null });
});

// ── mrCreate ──────────────────────────────────────────────────────────────────

test('github.mrCreate returns {url} on success', async () => {
  setSpawn(() => ({
    status: 0,
    stdout: 'https://github.com/o/r/pull/42\n',
    stderr: '',
  }));
  const result = await github.mrCreate({
    project: 'o/r',
    title: 'feat: my PR',
    body: 'Closes #10',
    head: 'feature/my-branch',
    base: 'main',
    labels: ['kind:feature'],
  });
  assert.equal(result.url, 'https://github.com/o/r/pull/42');
  assert.equal(result.error, undefined);
});

test('github.mrCreate returns {url:null, error} on failure (never throws)', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'HTTP 422: Validation failed',
  }));
  const result = await github.mrCreate({
    project: 'o/r',
    title: 'feat: bad PR',
    body: 'no issue ref',
    head: 'feature/bad',
    base: 'main',
  });
  assert.equal(result.url, null);
  assert.ok(typeof result.error === 'string' && result.error.length > 0,
    'error should be a non-empty string');
});

// gitlab.mrCreate (issue #239 A3 Phase 2 — un-stub over the shared
// gitlabApiFetch transport, POST /projects/:id/merge_requests). Matches the
// github.mrCreate contract exactly: { url } on success, { url: null, error }
// on failure, never throws.
test('gitlab.mrCreate returns { url } on success, POSTing the normalized payload over gitlabApiFetch', async () => {
  let seenUrl;
  let seenOptions;
  const result = await gitlab.mrCreate({
    project: 'g/r',
    title: 'feat: my MR',
    body: 'Closes #10',
    head: 'feature/my-branch',
    base: 'main',
    labels: ['kind:feature', 'size:m'],
    apiBase: 'https://gitlab.example.com/api/v4',
    token: 'tok-abc',
    fetchImpl: async (url, options) => {
      seenUrl = url;
      seenOptions = options;
      return { ok: true, json: async () => ({ web_url: 'https://gitlab.example.com/g/r/-/merge_requests/42' }) };
    },
  });
  assert.equal(seenUrl, 'https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests');
  assert.equal(seenOptions.method, 'POST');
  assert.equal(seenOptions.headers['PRIVATE-TOKEN'], 'tok-abc');
  assert.deepEqual(JSON.parse(seenOptions.body), {
    source_branch: 'feature/my-branch',
    target_branch: 'main',
    title: 'feat: my MR',
    description: 'Closes #10',
    labels: 'kind:feature,size:m',
  });
  assert.deepEqual(result, { url: 'https://gitlab.example.com/g/r/-/merge_requests/42' });
});

test('gitlab.mrCreate omits the labels field when no labels are given (never sends an empty string)', async () => {
  let seenOptions;
  await gitlab.mrCreate({
    project: 'g/r',
    title: 'T',
    body: 'B',
    head: 'h',
    fetchImpl: async (url, options) => {
      seenOptions = options;
      return { ok: true, json: async () => ({ web_url: 'https://x' }) };
    },
  });
  assert.equal('labels' in JSON.parse(seenOptions.body), false);
});

test('gitlab.mrCreate base defaults to "main" when not provided', async () => {
  let sentBody;
  await gitlab.mrCreate({
    project: 'g/r',
    title: 'T',
    body: 'B',
    head: 'h',
    fetchImpl: async (url, options) => {
      sentBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ web_url: 'https://x' }) };
    },
  });
  assert.equal(sentBody.target_branch, 'main');
});

test('gitlab.mrCreate returns { url: null, error } on failure (never throws)', async () => {
  const result = await gitlab.mrCreate({
    project: 'g/r',
    title: 'T',
    body: 'B',
    head: 'h',
    fetchImpl: async () => ({ ok: false, status: 422 }),
  });
  assert.equal(result.url, null);
  assert.ok(typeof result.error === 'string' && result.error.length > 0,
    'error should be a non-empty string');
});

// ── prView ────────────────────────────────────────────────────────────────────

/**
 * Fake spawn distinguishing the two calls prView now makes: the main
 * `gh pr view --json ...` call (`args[0] === 'pr'`) and the supplementary
 * `gh api repos/{owner}/{repo}/pulls/{n} --jq .base.sha` call
 * (`args[0] === 'api'`, ADR-0022) — which returns a RAW trimmed sha string,
 * not JSON, so it cannot share `fakeSpawn`'s uniform JSON-stringify shape.
 */
function fakePrViewSpawn(mainData, baseSha) {
  return (_cmd, args) =>
    args[0] === 'pr'
      ? { status: 0, stdout: JSON.stringify(mainData), stderr: '' }
      : { status: 0, stdout: `${baseSha}\n`, stderr: '' };
}

test('github.prView returns { number, labels, body, author, headRefOid, baseRefOid } on success', async () => {
  setSpawn(fakePrViewSpawn({
    number: 42,
    labels: [{ name: 'size:exception' }, { name: 'kind:feature' }],
    body: 'Closes #10\n\nDetails here.',
    author: { login: 'alice' },
    headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d',
  }, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
  const result = await github.prView({ project: 'o/r', number: 42 });
  assert.deepEqual(result, {
    number: 42,
    labels: ['size:exception', 'kind:feature'],
    body: 'Closes #10\n\nDetails here.',
    author: 'alice',
    headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d',
    baseRefOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    // issue #1086, D1: a successful fetch additively reports absent:false.
    absent: false,
  });
});

// issue #1086: this is the GENERIC/unreadable failure case (must classify
// `absent: null`, an unresolved read, not a definitive negative) — stderr is
// deliberately a message `isNotFound` does not match, so it stays distinct
// from `github.prView reports absent:true …` below.
test('github.prView returns { number, labels: null, body: null, author: null, headRefOid: null, baseRefOid: null, absent: null } on gh failure (never throws) — REQ-CIC-2 uncomputable, not genuinely-empty', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'gh: fixture simulated failure' }));
  const result = await github.prView({ project: 'o/r', number: 99 });
  assert.deepEqual(result, { number: 99, labels: null, body: null, author: null, headRefOid: null, baseRefOid: null, absent: null });
});

test('github.prView returns { number, labels: null, body: null, author: null, headRefOid: null, baseRefOid: null, absent: null } on malformed JSON (never throws)', async () => {
  setSpawn(() => ({ status: 0, stdout: 'not-json', stderr: '' }));
  const result = await github.prView({ project: 'o/r', number: 5 });
  assert.deepEqual(result, { number: 5, labels: null, body: null, author: null, headRefOid: null, baseRefOid: null, absent: null });
});

test('github.prView reports absent:true when gh pr view stderr is a definitive not-found (#1086)', async () => {
  setSpawn(() => ({
    status: 1,
    stdout: '',
    stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)\n',
  }));
  const result = await github.prView({ project: 'o/r', number: 99 });
  assert.deepEqual(result, { number: 99, labels: null, body: null, author: null, headRefOid: null, baseRefOid: null, absent: true });
});

test('github.prView headRefOid defaults to null when absent from an otherwise-successful response', async () => {
  setSpawn(fakePrViewSpawn({ number: 3, labels: [], body: 'x', author: null }, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
  const result = await github.prView({ project: 'o/r', number: 3 });
  assert.equal(result.headRefOid, null);
});

// baseRefOid (ADR-0022 Decision 1) — the strict supplementary `gh api
// repos/{owner}/{repo}/pulls/{n} --jq .base.sha` call.

test('github.prView baseRefOid comes from the supplementary gh api .../pulls/{n} --jq .base.sha call', async () => {
  setSpawn(fakePrViewSpawn(
    { number: 7, labels: [], body: '', author: null, headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d' },
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  ));
  const result = await github.prView({ project: 'o/r', number: 7 });
  assert.equal(result.baseRefOid, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
});

test('github.prView baseRefOid defaults to null when the supplementary call fails but the main fetch succeeded (other fields preserved)', async () => {
  setSpawn((_cmd, args) =>
    args[0] === 'pr'
      ? { status: 0, stdout: JSON.stringify({ number: 7, labels: [], body: '', author: null, headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d' }), stderr: '' }
      : { status: 1, stdout: '', stderr: 'not found' }
  );
  const result = await github.prView({ project: 'o/r', number: 7 });
  assert.equal(result.baseRefOid, null);
  assert.equal(result.headRefOid, 'cafef00dcafef00dcafef00dcafef00dcafef00d', 'a failed supplementary call must not blank out fields the main fetch already resolved');
  assert.equal(result.body, '', 'a failed supplementary call must not blank out fields the main fetch already resolved');
});

test('github.prView baseRefOid is null (not the string "null") when the supplementary call returns a JSON-null base.sha', async () => {
  // `gh api --jq .base.sha` prints the literal "null" when base.sha is JSON-null;
  // it must normalize to null, matching gitlab.mjs's `diff_refs?.base_sha ?? null` discipline.
  setSpawn(fakePrViewSpawn(
    { number: 7, labels: [], body: '', author: null, headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d' },
    'null',
  ));
  const result = await github.prView({ project: 'o/r', number: 7 });
  assert.equal(result.baseRefOid, null);
});

test('github.prView does not attempt the supplementary gh api call when the main gh pr view call fails', async () => {
  let calls = 0;
  setSpawn(() => { calls++; return { status: 1, stdout: '', stderr: 'not found' }; });
  await github.prView({ project: 'o/r', number: 99 });
  assert.equal(calls, 1, 'a main-fetch failure must short-circuit before the supplementary call — never a second spawn');
});

test('github.prView body defaults to "" (genuinely empty) when field absent in an otherwise-successful response', async () => {
  setSpawn(fakeSpawn({ number: 3, labels: [], body: null, author: null }));
  const result = await github.prView({ project: 'o/r', number: 3 });
  assert.equal(result.body, '');
});

test('github.prView author defaults to null when absent from an otherwise-successful response', async () => {
  setSpawn(fakeSpawn({ number: 3, labels: [], body: 'x' }));
  const result = await github.prView({ project: 'o/r', number: 3 });
  assert.equal(result.author, null);
});

// gitlab.prView (issue #239 A3 Phase 2 — un-stub over the shared
// gitlabApiFetch transport, GET /projects/:id/merge_requests/:iid). Exercised
// via an injected fetchImpl (no setSpawn fixture), same discipline as
// issueView/labelEvents/prReviews — the DEFAULT path must never reach for the
// glab CLI.
test('gitlab.prView returns { number, labels, body, author, headRefOid, baseRefOid } normalized, over the shared gitlabApiFetch transport', async () => {
  let seenUrl;
  let seenHeaders;
  const result = await gitlab.prView({
    project: 'g/r',
    number: 42,
    apiBase: 'https://gitlab.example.com/api/v4',
    token: 'tok-abc',
    fetchImpl: async (url, options) => {
      seenUrl = url;
      seenHeaders = options?.headers;
      return {
        ok: true,
        json: async () => ({
          iid: 42,
          labels: ['size:exception', 'kind:feature'],
          description: 'Closes #10\n\nDetails here.',
          author: { username: 'alice' },
          sha: 'cafef00dcafef00dcafef00dcafef00dcafef00d',
          diff_refs: { base_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
        }),
      };
    },
  });
  assert.equal(seenUrl, 'https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests/42');
  assert.equal(seenHeaders?.['PRIVATE-TOKEN'], 'tok-abc');
  assert.deepEqual(result, {
    number: 42,
    labels: ['size:exception', 'kind:feature'],
    body: 'Closes #10\n\nDetails here.',
    author: 'alice',
    headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d',
    baseRefOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    // issue #1086, D1: a successful fetch additively reports absent:false.
    absent: false,
  });
});

test('gitlab.prView headRefOid falls back to diff_refs.head_sha when the top-level sha is absent', async () => {
  const result = await gitlab.prView({
    project: 'g/r',
    number: 42,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        iid: 42,
        labels: [],
        description: '',
        author: { username: 'alice' },
        diff_refs: { head_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
      }),
    }),
  });
  assert.equal(result.headRefOid, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
});

test('gitlab.prView headRefOid defaults to null when neither sha nor diff_refs.head_sha is present', async () => {
  const result = await gitlab.prView({
    project: 'g/r',
    number: 42,
    fetchImpl: async () => ({ ok: true, json: async () => ({ iid: 42, labels: [], description: '', author: null }) }),
  });
  assert.equal(result.headRefOid, null);
});

// baseRefOid (ADR-0022 Decision 1) — read directly off the already-fetched MR
// payload's diff_refs.base_sha, no second request (unlike GitHub).

test('gitlab.prView baseRefOid normalizes from diff_refs.base_sha', async () => {
  const result = await gitlab.prView({
    project: 'g/r',
    number: 42,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ iid: 42, labels: [], description: '', author: null, diff_refs: { base_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } }),
    }),
  });
  assert.equal(result.baseRefOid, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
});

test('gitlab.prView baseRefOid defaults to null when diff_refs.base_sha is absent on an otherwise-successful fetch', async () => {
  const result = await gitlab.prView({
    project: 'g/r',
    number: 42,
    fetchImpl: async () => ({ ok: true, json: async () => ({ iid: 42, labels: [], description: '', author: null }) }),
  });
  assert.equal(result.baseRefOid, null);
});

// issue #1086: GENERIC/unreadable failure — status corrected from 404 to
// 500 (a 404 collides with classifyUncomputableCause's numeric not-found
// rule and would misclassify this as absent:true; see the dedicated
// absent:true test below for that case).
test('gitlab.prView returns { number, labels: null, body: null, author: null, headRefOid: null, baseRefOid: null, absent: null } on fetch failure (never throws) — uncomputable, not genuinely-empty', async () => {
  const result = await gitlab.prView({
    project: 'g/r',
    number: 99,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.deepEqual(result, { number: 99, labels: null, body: null, author: null, headRefOid: null, baseRefOid: null, absent: null });
});

test('gitlab.prView reports absent:true when gitlabApiFetch fails with a 404 (definitive not-found, #1086)', async () => {
  const result = await gitlab.prView({
    project: 'g/r',
    number: 99,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.deepEqual(result, { number: 99, labels: null, body: null, author: null, headRefOid: null, baseRefOid: null, absent: true });
});

test('gitlab.prView author defaults to null when absent from an otherwise-successful response', async () => {
  const result = await gitlab.prView({
    project: 'g/r',
    number: 3,
    fetchImpl: async () => ({ ok: true, json: async () => ({ iid: 3, labels: [], description: '' }) }),
  });
  assert.equal(result.author, null);
});

test('gitlab.prView defaults apiBase to the public GitLab API when not provided (local/non-CI callers)', async () => {
  let seenUrl;
  await gitlab.prView({
    project: 'g/r',
    number: 3,
    fetchImpl: async (url) => {
      seenUrl = url;
      return { ok: true, json: async () => ({ iid: 3, labels: [], description: '' }) };
    },
  });
  assert.match(seenUrl, /^https:\/\/gitlab\.com\/api\/v4\//);
});

test('gitlab.prView never spawns a child process (glab CLI) — proves the default path is CLI-free', async () => {
  let spawnCalled = false;
  setSpawn(() => {
    spawnCalled = true;
    return { status: 0, stdout: '{}', stderr: '' };
  });

  await gitlab.prView({
    project: 'g/r',
    number: 7,
    fetchImpl: async () => ({ ok: true, json: async () => ({ iid: 7, labels: [], description: '' }) }),
  });

  assert.equal(spawnCalled, false, 'prView must never call spawn/execFile (glab CLI) — direct API v4 fetch only');
});

// ── labelEvents (issue #239 A3, D1 — the labelEvents CONTRACT verb) ──────────
//
// GitHub: EXTRACTED from actor-check.mjs's inline defaultFetchLabeledEvents
// (m3 close), preserving --paginate. GitLab: over gitlabApiFetch
// (resource_label_events), never the glab CLI (a GATE_FILE, same discipline
// as issueView). Both normalize to { actor: { login }, action, label, at },
// ascending by `at`; a thrown fetch → null (never a fabricated []).

test('github.labelEvents normalizes labeled/unlabeled events to the shared shape, ascending by at, dropping non-label events', async () => {
  setSpawn(fakeSpawn([
    { event: 'commented', actor: { login: 'carol' }, created_at: '2024-01-01T00:00:00Z' },
    { event: 'unlabeled', label: { name: 'status:approved' }, actor: { login: 'alice' }, created_at: '2024-01-03T00:00:00Z' },
    { event: 'labeled', label: { name: 'status:approved' }, actor: { login: 'bob' }, created_at: '2024-01-02T00:00:00Z' },
  ]));
  const result = await github.labelEvents({ project: 'o/r', number: 42 });
  assert.deepEqual(result, [
    { actor: { login: 'bob' }, action: 'add', label: 'status:approved', at: '2024-01-02T00:00:00Z' },
    { actor: { login: 'alice' }, action: 'remove', label: 'status:approved', at: '2024-01-03T00:00:00Z' },
  ]);
});

test('github.labelEvents returns null (never []) when the underlying gh api call throws', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 500: Internal Server Error' }));
  const result = await github.labelEvents({ project: 'o/r', number: 42 });
  assert.equal(result, null);
});

test('gitlab.labelEvents normalizes resource_label_events to the shared shape, ascending by at, over the shared gitlabApiFetch transport', async () => {
  let seenUrl;
  const result = await gitlab.labelEvents({
    project: 'g/r',
    number: 7,
    apiBase: 'https://gitlab.example.com/api/v4',
    token: 'tok-abc',
    fetchImpl: async (url) => {
      seenUrl = url;
      return {
        ok: true,
        json: async () => ([
          { user: { username: 'alice' }, action: 'remove', label: { name: 'status::approved' }, created_at: '2024-01-03T00:00:00Z' },
          { user: { username: 'bob' }, action: 'add', label: { name: 'status::approved' }, created_at: '2024-01-02T00:00:00Z' },
        ]),
      };
    },
  });
  assert.equal(seenUrl, 'https://gitlab.example.com/api/v4/projects/g%2Fr/issues/7/resource_label_events');
  assert.deepEqual(result, [
    { actor: { login: 'bob' }, action: 'add', label: 'status::approved', at: '2024-01-02T00:00:00Z' },
    { actor: { login: 'alice' }, action: 'remove', label: 'status::approved', at: '2024-01-03T00:00:00Z' },
  ]);
});

// #1024 (design item 7): the memory-gate override's applier read needs
// GitLab MR label events, not issue label events — `brain-metrics.mjs:511`
// already reads issue events for an MR number on GitLab, which is the SAME
// bug this optional `kind` param fixes at the call site. Default (no `kind`,
// or `kind: 'issue'`) is UNCHANGED (`issues/:iid/resource_label_events`).
test('gitlab.labelEvents({ kind: "mr" }) requests merge_requests/:iid/resource_label_events, not the issue-events path', async () => {
  let seenUrl;
  await gitlab.labelEvents({
    project: 'g/r',
    number: 7,
    kind: 'mr',
    apiBase: 'https://gitlab.example.com/api/v4',
    token: 'tok-abc',
    fetchImpl: async (url) => { seenUrl = url; return { ok: true, json: async () => [] }; },
  });
  assert.equal(seenUrl, 'https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests/7/resource_label_events');
});

test('gitlab.labelEvents default (no kind, or kind: "issue") is unchanged — issues/:iid/resource_label_events', async () => {
  let seenUrlDefault;
  await gitlab.labelEvents({
    project: 'g/r',
    number: 7,
    apiBase: 'https://gitlab.example.com/api/v4',
    token: 'tok-abc',
    fetchImpl: async (url) => { seenUrlDefault = url; return { ok: true, json: async () => [] }; },
  });
  assert.equal(seenUrlDefault, 'https://gitlab.example.com/api/v4/projects/g%2Fr/issues/7/resource_label_events');

  let seenUrlExplicitIssue;
  await gitlab.labelEvents({
    project: 'g/r',
    number: 7,
    kind: 'issue',
    apiBase: 'https://gitlab.example.com/api/v4',
    token: 'tok-abc',
    fetchImpl: async (url) => { seenUrlExplicitIssue = url; return { ok: true, json: async () => [] }; },
  });
  assert.equal(seenUrlExplicitIssue, 'https://gitlab.example.com/api/v4/projects/g%2Fr/issues/7/resource_label_events');
});

test('github.labelEvents accepts and ignores a kind parameter (documentation-only — GitHub\'s events endpoint is already PR/issue-unified)', async () => {
  setSpawn(fakeSpawn([]));
  const result = await github.labelEvents({ project: 'o/r', number: 42, kind: 'mr' });
  assert.deepEqual(result, []);
});

// FIX1 fail-open guard, MOVED with the extraction (issue #239 A3, m3 close):
// `gh api` does NOT auto-paginate. GitHub's Events API is oldest-first, so on
// an issue with more than ~30 events the most recent approved-label event
// (including a late self-applied one) lands on page 2+ and is silently
// dropped — self-approval would then wrongly PASS. Guard via source-scan
// (mirrors the neutrality source-scan style in phase-order-check.test.mjs and
// actor-check.test.mjs's pre-A3 FIX1 guard, now here alongside the code).
test('github.labelEvents source includes --paginate on the gh api events call (FIX1 fail-open guard)', async () => {
  const srcPath = fileURLToPath(new URL('../axes/vcs/adapters/github.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  const fnStart = src.indexOf('export async function labelEvents');
  assert.notEqual(fnStart, -1, 'labelEvents not found in github.mjs');
  const fnEnd = src.indexOf('\nexport async function ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.match(fnBody, /issues\/\$\{number\}\/events/, 'sanity: events endpoint present');
  assert.match(
    fnBody,
    /--paginate/,
    'events fetch must use --paginate — otherwise a truncated page 1 can hide the newest labeled event (fail-open)'
  );
});

test('gitlab.labelEvents returns null (never []) when the underlying fetch throws', async () => {
  const result = await gitlab.labelEvents({
    project: 'g/r',
    number: 7,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(result, null);
});

// ── prReviews (issue #239 A3 TASK2/4th-violation fix — the brain-writes-reviewed
// L6 gate's defaultFetchReviews was STILL gh-CLI-hardcoded, the same defect
// class as labelEvents pre-fix and finding #14). GitHub: EXTRACTED from
// brain-writes-reviewed.mjs's inline defaultFetchReviews, preserving
// --paginate.
//
// Issue #317 widened this verb on BOTH providers from `{ state, author }` to
// `{ state, author, body }`, and CHANGED GitLab's source endpoints. `body`
// carries the reviewer's `brain-review/N` block, which `parse-verdict.mjs`
// needs; without it cold-boot's `priorVerdicts` was always `[]` in production
// and the anti-loop lock, the rev-bound, the doctrine load and board
// reconciliation were all inert.
//
// GitLab now reads TWO endpoints: MR **notes** (where verdicts are actually
// posted — approvals carries no body at all, so the verdict thread used to be
// structurally invisible on GitLab) plus **approvals**, still the only source
// of `state:'APPROVED'` and therefore the only thing the L6 gate counts. The
// cross-provider shape parity, the parseVerdict round-trip, the
// notes-are-never-APPROVED security boundary, the ordering/pagination locks
// and the all-or-nothing failure rule live in the shared contract suite
// (axes/vcs/contract.test.mjs); these are the provider-local unit tests.

test('github.prReviews normalizes gh reviews to { state, author, body }', async () => {
  setSpawn(fakeSpawn([
    { state: 'COMMENTED', user: { login: 'carol' }, body: 'looks good' },
    { state: 'APPROVED', user: { login: 'bob' }, body: '' },
  ]));
  const result = await github.prReviews({ project: 'o/r', number: 144 });
  assert.deepEqual(result, [
    { state: 'COMMENTED', author: 'carol', body: 'looks good' },
    { state: 'APPROVED', author: 'bob', body: '' },
  ]);
});

test('github.prReviews returns null (never []) when the underlying gh api call throws', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 500: Internal Server Error' }));
  const result = await github.prReviews({ project: 'o/r', number: 144 });
  assert.equal(result, null);
});

test('github.prReviews source includes --paginate on the gh api reviews call (fail-open guard, moved with the extraction)', () => {
  const srcPath = fileURLToPath(new URL('../axes/vcs/adapters/github.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  const fnStart = src.indexOf('export async function prReviews');
  assert.notEqual(fnStart, -1, 'prReviews not found in github.mjs');
  const fnEnd = src.indexOf('\nexport async function ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.match(fnBody, /pulls\/\$\{number\}\/reviews/, 'sanity: PR reviews endpoint present');
  assert.match(fnBody, /--paginate/, 'reviews fetch must use --paginate — otherwise a truncated page 1 can hide later reviews');
});

test('gitlab.prReviews normalizes notes to {state:"COMMENTED", author, body} and approvals.approved_by to {state:"APPROVED", author, body:""}, both over the shared gitlabApiFetch transport', async () => {
  const seenUrls = [];
  const seenHeaders = [];
  const result = await gitlab.prReviews({
    project: 'g/r',
    number: 7,
    apiBase: 'https://gitlab.example.com/api/v4',
    token: 'tok-abc',
    fetchImpl: async (url, options) => {
      seenUrls.push(url);
      seenHeaders.push(options?.headers);
      if (url.includes('/approvals')) {
        return { ok: true, json: async () => ({ approved_by: [{ user: { username: 'bob' } }] }) };
      }
      return {
        ok: true,
        json: async () => [
          { id: 1, body: 'changed title', author: { username: 'gitlab-bot' }, system: true },
          { id: 2, body: 'a human comment', author: { username: 'carol' }, system: false },
        ],
      };
    },
  });

  assert.deepEqual(seenUrls, [
    'https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests/7/notes?order_by=created_at&sort=asc&per_page=100&page=1',
    'https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests/7/approvals',
  ]);
  for (const headers of seenHeaders) assert.equal(headers?.['PRIVATE-TOKEN'], 'tok-abc');
  // The system note is dropped; the human note becomes COMMENTED (never
  // APPROVED — see the security-boundary test in the contract suite); the
  // approver is appended after the chronological notes.
  assert.deepEqual(result, [
    { state: 'COMMENTED', author: 'carol', body: 'a human comment' },
    { state: 'APPROVED', author: 'bob', body: '' },
  ]);
});

test('gitlab.prReviews returns [] (genuinely zero notes AND zero approvals, not uncomputable) when both endpoints come back empty', async () => {
  const result = await gitlab.prReviews({
    project: 'g/r',
    number: 7,
    fetchImpl: async (url) =>
      url.includes('/approvals')
        ? { ok: true, json: async () => ({ approved_by: [] }) }
        : { ok: true, json: async () => [] },
  });
  assert.deepEqual(result, []);
});

test('gitlab.prReviews returns null (never []) when the underlying fetch throws', async () => {
  const result = await gitlab.prReviews({
    project: 'g/r',
    number: 7,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(result, null);
});

// ── prCommits (issue #358 Q5 Phase 4 — REQ-L5-1' evidence tiering) ──────────
//
// Resolves the "distinct act" (lite, head-commit timestamp) and "no commit
// on the branch" (regulated, approver-authored-commit check) evidence
// actor-check.mjs's tiered evaluator needs. GitHub normalizes the
// account-linked `author.login`; GitLab has no equivalent without a second
// per-commit user lookup this verb does not make, so `login` normalizes to
// `null` on every GitLab entry — a documented residual, not a bug.

test('github.prCommits normalizes gh commits to { sha, login, at }', async () => {
  setSpawn(fakeSpawn([
    { sha: 'aaa111', author: { login: 'alice' }, commit: { author: { date: '2024-01-01T00:00:00Z' } } },
    { sha: 'bbb222', author: { login: 'bob' }, commit: { author: { date: '2024-01-01T00:10:00Z' } } },
  ]));
  const result = await github.prCommits({ project: 'o/r', number: 144 });
  assert.deepEqual(result, [
    { sha: 'aaa111', login: 'alice', at: '2024-01-01T00:00:00Z' },
    { sha: 'bbb222', login: 'bob', at: '2024-01-01T00:10:00Z' },
  ]);
});

test('github.prCommits normalizes a commit with no linked GitHub account to login: null', async () => {
  setSpawn(fakeSpawn([
    { sha: 'ccc333', author: null, commit: { author: { date: '2024-01-01T00:00:00Z' } } },
  ]));
  const result = await github.prCommits({ project: 'o/r', number: 144 });
  assert.deepEqual(result, [{ sha: 'ccc333', login: null, at: '2024-01-01T00:00:00Z' }]);
});

test('github.prCommits returns null (never []) when the underlying gh api call throws', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 500: Internal Server Error' }));
  const result = await github.prCommits({ project: 'o/r', number: 144 });
  assert.equal(result, null);
});

test('github.prCommits source includes --paginate on the gh api commits call', () => {
  const srcPath = fileURLToPath(new URL('../axes/vcs/adapters/github.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  const fnStart = src.indexOf('export async function prCommits');
  assert.notEqual(fnStart, -1, 'prCommits not found in github.mjs');
  const fnEnd = src.indexOf('\nexport async function ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.match(fnBody, /pulls\/\$\{number\}\/commits/, 'sanity: PR commits endpoint present');
  assert.match(fnBody, /--paginate/, 'commits fetch must use --paginate — a truncated page 1 could hide a later commit');
});

test('gitlab.prCommits normalizes MR commits to { sha, login: null, at }, over the shared gitlabApiFetch transport', async () => {
  let seenUrl;
  const result = await gitlab.prCommits({
    project: 'g/r',
    number: 7,
    apiBase: 'https://gitlab.example.com/api/v4',
    token: 'tok-abc',
    fetchImpl: async (url) => {
      seenUrl = url;
      return {
        ok: true,
        json: async () => [
          { id: 'sha1', author_name: 'Alice', author_email: 'alice@example.com', committed_date: '2024-01-01T00:00:00Z' },
        ],
      };
    },
  });
  assert.equal(seenUrl, 'https://gitlab.example.com/api/v4/projects/g%2Fr/merge_requests/7/commits');
  assert.deepEqual(result, [{ sha: 'sha1', login: null, at: '2024-01-01T00:00:00Z' }]);
});

test('gitlab.prCommits returns null (never []) when the underlying fetch throws', async () => {
  const result = await gitlab.prCommits({
    project: 'g/r',
    number: 7,
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(result, null);
});

test('gitlab.prCommits returns null when the response body is not an array (malformed, not a fabricated [])', async () => {
  const result = await gitlab.prCommits({
    project: 'g/r',
    number: 7,
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: 'not found' }) }),
  });
  assert.equal(result, null);
});

// ── issueRelations — the SECOND edge source (#533, ADR-0029 Decision 2) ──────
//
// Everything below is about what the verb REFUSES to report, because that is
// where a native-relation reader goes wrong: a containment relation read as an
// ordering one, a "see also" read as a blocker, a cross-repo number drawn against
// this repo's issue of the same number, and a failed fetch read as "no relations".

/** Dispatches one canned payload per GitHub dependencies endpoint. */
const ghRelSpawn = (blocking, blockedBy, { fail } = {}) => (_cmd, args) => {
  const endpoint = args[args.length - 1];
  if (fail && endpoint.includes(fail)) return { status: 1, stdout: '', stderr: 'HTTP 404' };
  const body = endpoint.endsWith('/blocking') ? blocking : blockedBy;
  return { status: 0, stdout: JSON.stringify(body), stderr: '' };
};

test('#533: github.issueRelations maps blocking→blocks and blocked_by→needs', async () => {
  setSpawn(ghRelSpawn([{ number: 20 }], [{ number: 10 }]));
  const r = await github.issueRelations({ project: 'o/r', number: 5 });
  assert.deepEqual(r, { blocks: [20], needs: [10], foreign: 0 });
});

test('#533: github.issueRelations COUNTS cross-repo relations instead of drawing them', async () => {
  // Issue numbers are per-repo. A foreign #12 rendered as a node asserts an edge to
  // THIS repo's #12 — a fabricated dependency, which is worse than an omitted one.
  setSpawn(ghRelSpawn(
    [{ number: 12, repository: { full_name: 'other/repo' } }, { number: 13, repository: { full_name: 'o/r' } }],
    [],
  ));
  const r = await github.issueRelations({ project: 'o/r', number: 5 });
  assert.deepEqual(r.blocks, [13], 'the same-repo relation survives');
  assert.equal(r.foreign, 1, 'and the dropped one is COUNTED — an omission nobody can hear is a silent lie');
});

test('#533: github.issueRelations returns null when EITHER side fails — half a graph reports absent edges', async () => {
  setSpawn(ghRelSpawn([{ number: 20 }], [], { fail: 'blocked_by' }));
  assert.equal(await github.issueRelations({ project: 'o/r', number: 5 }), null);

  setSpawn(ghRelSpawn([], [{ number: 10 }], { fail: '/blocking' }));
  assert.equal(await github.issueRelations({ project: 'o/r', number: 5 }), null);
});

test('#533: github.issueRelations distinguishes "no relations" from "could not read"', async () => {
  setSpawn(ghRelSpawn([], []));
  assert.deepEqual(await github.issueRelations({ project: 'o/r', number: 5 }), { blocks: [], needs: [], foreign: 0 });
  setSpawn(ghRelSpawn([], [], { fail: '/blocking' }));
  assert.equal(await github.issueRelations({ project: 'o/r', number: 5 }), null);
});

test('#533: github.issueRelations NEVER reads sub-issues — containment is not ordering', async () => {
  // A slice is "part of" its epic, not a blocker on it. Feeding sub-issues into a
  // blocking graph would make every slice of #313 appear to block #313.
  const seen = [];
  setSpawn((_cmd, args) => {
    seen.push(args[args.length - 1]);
    return { status: 0, stdout: '[]', stderr: '' };
  });
  await github.issueRelations({ project: 'o/r', number: 5 });
  assert.ok(seen.length > 0, 'sanity: the verb must actually call something');
  for (const endpoint of seen) {
    assert.ok(!endpoint.includes('sub_issue'), `sub-issues must not be read — saw ${endpoint}`);
  }
});

const glLinks = (links) => ({
  project: 'g/r', number: 7,
  fetchImpl: async () => ({ ok: true, json: async () => links }),
});

test('#533: gitlab.issueRelations maps blocks/is_blocked_by and DROPS relates_to', async () => {
  // `relates_to` is not a start-order constraint. Reading it as one turns every
  // "see also" a human clicked into a blocker.
  const r = await gitlab.issueRelations(glLinks([
    { iid: 20, link_type: 'blocks', references: { relative: '#20' } },
    { iid: 10, link_type: 'is_blocked_by', references: { relative: '#10' } },
    { iid: 30, link_type: 'relates_to', references: { relative: '#30' } },
  ]));
  assert.deepEqual(r, { blocks: [20], needs: [10], foreign: 0 });
});

test('#533: gitlab.issueRelations counts cross-project links, and an undecidable reference is foreign', async () => {
  const r = await gitlab.issueRelations(glLinks([
    { iid: 12, link_type: 'blocks', references: { relative: 'other/proj#12' } },
    { iid: 13, link_type: 'blocks' },
  ]));
  assert.deepEqual(r.blocks, [], 'neither is drawn');
  assert.equal(r.foreign, 2, 'a missing `references` is undecidable, and undecidable must not become a local edge');
});

test('#533: gitlab.issueRelations returns null on a failed fetch, never a fabricated empty graph', async () => {
  const r = await gitlab.issueRelations({
    project: 'g/r', number: 7,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.equal(r, null);
  assert.deepEqual(await gitlab.issueRelations(glLinks([])), { blocks: [], needs: [], foreign: 0 });
});

// ── issueUpdate — the first verb that can overwrite human prose (#533) ───────

test('#533: github.issueUpdate PATCHes the body and nothing else', async () => {
  let seen = null;
  setSpawn((_cmd, args, opts) => {
    seen = { args, payload: JSON.parse(opts.input) };
    return { status: 0, stdout: JSON.stringify({ html_url: 'https://x/1' }), stderr: '' };
  });
  const r = await github.issueUpdate({ project: 'o/r', number: 5, body: 'nuevo' });
  assert.deepEqual(r, { ok: true, url: 'https://x/1' });
  assert.deepEqual(seen.payload, { body: 'nuevo' },
    'body is the ONLY writable field — a payload that could carry state/title would make this the verb that closes a ticket');
  assert.ok(seen.args.includes('PATCH'));
});

test('#533: gitlab.issueUpdate PUTs `description` and nothing else', async () => {
  let seen = null;
  const r = await gitlab.issueUpdate({
    project: 'g/r', number: 7, body: 'nuevo',
    fetchImpl: async (url, options) => {
      seen = { url, method: options.method, payload: JSON.parse(options.body) };
      return { ok: true, json: async () => ({ web_url: 'https://gl/7' }) };
    },
  });
  assert.deepEqual(r, { ok: true, url: 'https://gl/7' });
  assert.equal(seen.method, 'PUT');
  assert.deepEqual(seen.payload, { description: 'nuevo' });
  assert.match(seen.url, /projects\/g%2Fr\/issues\/7$/);
});

test('#533: issueUpdate refuses a non-string body on BOTH providers, without calling the network', async () => {
  let called = false;
  setSpawn(() => { called = true; return { status: 0, stdout: '{}', stderr: '' }; });
  const gh = await github.issueUpdate({ project: 'o/r', number: 5, body: undefined });
  const gl = await gitlab.issueUpdate({
    project: 'g/r', number: 7, body: { toString: () => 'sneaky' },
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; },
  });
  assert.equal(gh.ok, false);
  assert.equal(gl.ok, false);
  assert.equal(called, false, 'a body that is not a string must never reach the wire — an object stringifies to "[object Object]" and would REPLACE the epic with it');
});

test('#533: a zero-exit write whose echo is unparseable stays ok:true — the overwrite already landed', async () => {
  // Reporting a successful write as a failure sends the caller into retrying an
  // overwrite that has already happened.
  setSpawn(() => ({ status: 0, stdout: 'not json', stderr: '' }));
  assert.deepEqual(await github.issueUpdate({ project: 'o/r', number: 5, body: 'x' }), { ok: true, url: null });
});

test('#533: issueUpdate reports a transport failure rather than throwing', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 403' }));
  const gh = await github.issueUpdate({ project: 'o/r', number: 5, body: 'x' });
  assert.equal(gh.ok, false);
  assert.match(gh.error, /403/);

  const gl = await gitlab.issueUpdate({
    project: 'g/r', number: 7, body: 'x',
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
  });
  assert.equal(gl.ok, false);
});

// ── #348: the approvalCount axis, on the real providers ─────────────────────
// Round 1's blocker: the MUST requirement's primary deliverable shipped with
// its pure classifier tested and NOT one assertion on either provider's actual
// capabilities() output. A test that passes is not a suite that covers.

test('#348: github.capabilities reports approvalCount alongside hardEnforcement — one probe, two axes', async () => {
  setSpawn(() => ({ status: 0, stdout: '{"url":"..."}', stderr: '' }));
  const r = await github.capabilities({ project: 'cap/348a', branch: 'main' });
  assert.equal(r.hardEnforcement, 'available');
  assert.equal(r.approvalCount, 'available',
    'GitHub applies required_approving_review_count through the endpoint just probed — same answer, no second call');
});

test('#348: github.capabilities — a plan-gated 403 makes BOTH axes unavailable, with the remedy', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 403: upgrade to GitHub Pro' }));
  const r = await github.capabilities({ project: 'cap/348b', branch: 'main' });
  assert.equal(r.hardEnforcement, 'unavailable');
  assert.equal(r.approvalCount, 'unavailable');
  assert.match(r.approvalRemedy, /Pro|public/, 'the operator is told what would change it');
});

test('#348: gitlab.capabilities — protected branches available, approvals NOT enforced by brain', async () => {
  setSpawn(() => ({ status: 0, stdout: '[]', stderr: '' }));
  const r = await gitlab.capabilities({ project: 'cap/348c', branch: 'main' });
  assert.equal(r.hardEnforcement, 'available', 'GitLab protected branches ship on all plans');
  assert.equal(r.approvalCount, 'unavailable',
    'and brain enforces no approval count there under ANY plan — the ratified limitation (#348)');
  assert.match(r.approvalRemedy, /Premium/, 'naming what would offer it');
  assert.match(r.approvalRemedy, /gate floor|status:approved|actor-check/,
    'and that the human signature does not depend on it — the point an operator needs');
});

test('#348: the two axes are INDEPENDENT — GitLab Free is not GitHub Free-private', async () => {
  setSpawn(() => ({ status: 0, stdout: '[]', stderr: '' }));
  const gl = await gitlab.capabilities({ project: 'cap/348d', branch: 'main' });
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 403: upgrade to GitHub Pro' }));
  const gh = await github.capabilities({ project: 'cap/348e', branch: 'main' });

  assert.equal(gl.hardEnforcement, 'available');
  assert.equal(gh.hardEnforcement, 'unavailable');
  assert.equal(gl.approvalCount, gh.approvalCount, 'both lack the count');
  assert.notEqual(gl.hardEnforcement, gh.hardEnforcement,
    'but only one reaches rung 1 — collapsing the axes into one boolean would make the STRONGER case look like the weaker');
});

test('#348 (round 3): an unreadable probe carries its diagnostic onto the approvals axis too', async () => {
  // The status surface reads `approvalDetail`; nothing set it, so an operator
  // saw "approvals unknown" with no cause while "platform unknown" one row
  // above showed it — for the identical probe failure.
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'dial tcp: lookup api.github.com: no such host' }));
  const r = await github.capabilities({ project: 'cap/348f', branch: 'main' });
  assert.equal(r.hardEnforcement, 'unknown');
  assert.equal(r.approvalCount, 'unknown', 'an unreadable probe answers neither axis');
  assert.match(r.approvalDetail, /no such host/, 'and both carry what it could not read');
  assert.equal(r.approvalRemedy, undefined, 'no remedy — we do not know there is anything to remedy');
});

// ── workflowRunSucceeded (issue #1162) ───────────────────────────────────────────
// The evidence that tells a never-created audit cursor (bootstrap) from a deleted
// one (a prior successful run advanced it). Never throws; GitLab is `unsupported`,
// which callers treat as unknown — never as "none".

function recordingSpawn(data, status = 0) {
  const calls = [];
  const fn = (cmd, args) => { calls.push([cmd, ...args]); return { status, stdout: JSON.stringify(data), stderr: status ? 'boom' : '' }; };
  fn.calls = calls;
  return fn;
}

test('github.workflowRunSucceeded: a successful run on the branch → succeeded, filtered by workflow, branch and status', async () => {
  const spawn = recordingSpawn([{ databaseId: 7 }]);
  setSpawn(spawn);
  const r = await github.workflowRunSucceeded({ project: 'o/r', workflow: 'governance-postmerge.yml', branch: 'main' });
  assert.equal(r.state, 'succeeded');
  const argv = spawn.calls[0].join(' ');
  assert.match(argv, /run list/);
  assert.match(argv, /--workflow governance-postmerge\.yml/);
  assert.match(argv, /--branch main/, 'a success on another branch must not count');
  assert.match(argv, /--status success/);
});

test('github.workflowRunSucceeded: no successful run → none', async () => {
  setSpawn(recordingSpawn([]));
  assert.equal((await github.workflowRunSucceeded({ workflow: 'w.yml', branch: 'main' })).state, 'none');
});

test('github.workflowRunSucceeded: a failing read → unknown, never none, never throws', async () => {
  setSpawn(recordingSpawn([], 1));
  const r = await github.workflowRunSucceeded({ workflow: 'w.yml', branch: 'main' });
  assert.equal(r.state, 'unknown');
});

test('github.workflowRunSucceeded: a malformed response → unknown', async () => {
  setSpawn(recordingSpawn({ nope: true }));
  assert.equal((await github.workflowRunSucceeded({ workflow: 'w.yml', branch: 'main' })).state, 'unknown');
});

test('github.workflowRunSucceeded: no branch → unknown (an unfiltered answer would count other branches)', async () => {
  setSpawn(recordingSpawn([{ databaseId: 1 }]));
  assert.equal((await github.workflowRunSucceeded({ workflow: 'w.yml' })).state, 'unknown');
});

test('gitlab.workflowRunSucceeded: explicitly unsupported (never "none")', async () => {
  const r = await gitlab.workflowRunSucceeded({ workflow: 'w.yml', branch: 'main' });
  assert.equal(r.state, 'unsupported');
});
