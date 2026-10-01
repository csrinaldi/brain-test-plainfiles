// vcs.contract.test.mjs — the shared, parameterized CONTRACT suite (issue #239
// A3 Phase 3, REQ-A3-5). ONE assertion set, run over BOTH providers
// (`['github', 'gitlab']`), for `labelEvents`, `prView`, `mrCreate`: parity
// means the SAME test body applies to each provider — not two divergent files
// that can silently drift apart.
//
// This is DISTINCT from `../providers.test.mjs` (provider-specific behavior,
// e.g. each provider's own URL-building/CLI-arg details) — this suite only
// asserts what the CONTRACT (vcs-contract.md) promises: normalized shapes,
// `null`-on-uncomputable, ascending ordering, never-throws.
//
// Fixtures live in `../fixtures/*.json` (REQ-A3-6) — recorded from the real
// GitHub API where reachable (github-labelEvents-happy.json,
// github-prView-happy.json, github-prReviews-happy.json — see
// fixtures/record-fixtures.mjs), DERIVED
// (hand-authored from the documented API shape) everywhere else (all
// gitlab-*.json — no live GitLab mirror reachable from this environment,
// deferred to CP-A3b / the self-hosted phase; every github-*-failure.json and
// github-mrCreate-happy.json — forced-failure/mutating-write cases that
// cannot be recorded). `_provenance.recorded`/`_provenance.derived` is always
// present and never both true (lesson #12).
//
// No live network or CLI spawn happens in this suite — every transport is the
// injected fixture reader below (github via the existing `setSpawn` seam,
// gitlab via the existing `fetchImpl` param).

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setSpawn } from '../../vcs/lib/exec.mjs';
// The REAL production parser the reviewer's flow guarantees run on (issue
// #317). Imported here on purpose: the `prReviews` block below feeds this
// suite's REAL normalizer output straight into it, so "the adapter emits a
// parseable verdict" is asserted end-to-end rather than assumed.
import { parseVerdict } from '../../review/lib/parse-verdict.mjs';

import * as github from './adapters/github.mjs';
import * as gitlab from './adapters/gitlab.mjs';
import { UNCOMPUTABLE_REASONS } from '../../vcs/lib/uncomputable-cause.mjs';
import { AUTO_MERGE_REASONS } from '../../vcs/lib/auto-merge-outcome.mjs';

const UNCOMPUTABLE_REASON_VALUES = Object.values(UNCOMPUTABLE_REASONS);
const AUTO_MERGE_REASON_VALUES = Object.values(AUTO_MERGE_REASONS);

afterEach(() => setSpawn(spawnSync));

const FIXTURES_DIR = fileURLToPath(new URL('../../vcs/fixtures/', import.meta.url));

/** Loads and parses a fixture JSON file by name. */
function loadFixture(name) {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}${name}`, 'utf8'));
}

/** Every fixture MUST declare exactly one of recorded/derived (never both, never neither). */
function assertProvenance(fixture, fixtureName) {
  const p = fixture._provenance;
  assert.ok(p, `${fixtureName}: missing _provenance`);
  const recorded = p.recorded === true;
  const derived = p.derived === true;
  assert.ok(recorded || derived, `${fixtureName}: must be marked recorded or derived — never ambiguous (lesson #12)`);
  assert.ok(!(recorded && derived), `${fixtureName}: must not be marked BOTH recorded and derived`);
  assert.ok(p.endpoint, `${fixtureName}: missing _provenance.endpoint`);
  assert.ok(p.date, `${fixtureName}: missing _provenance.date`);
}

// ── Per-provider fixture-reading transport glue ─────────────────────────────
// github verbs read via the `gh` CLI (spawn-based, no fetchImpl param);
// gitlab verbs read via the shared `gitlabApiFetch` (fetchImpl param). Both
// glue functions turn ONE fixture shape ({ data } | { throws, ... }) into
// whatever that provider's real transport seam expects — the fixture format
// itself is provider-agnostic.

function jsonSpawn(data, status = 0) {
  return () => ({ status, stdout: JSON.stringify(data), stderr: '' });
}
function rawSpawn(stdout, status = 0) {
  return () => ({ status, stdout, stderr: '' });
}
function failSpawn(message = 'fixture: simulated failure') {
  return () => ({ status: 1, stdout: '', stderr: message });
}

// Named for the seam (JSON-over-spawn), not the provider — `mrList` proves
// GitLab needs this same spawn glue too (gitlab.mrList spawns `glab` via
// `runJson` rather than fetching over `gitlabApiFetch`, so `gitlabCallArgs`'s
// `fetchImpl` injection does not apply to it).
function jsonSpawnCallArgs(fixture) {
  setSpawn(fixture.throws ? failSpawn(fixture.error) : jsonSpawn(fixture.data));
  return {};
}
function githubRawCallArgs(fixture) {
  setSpawn(fixture.throws ? failSpawn(fixture.error) : rawSpawn(fixture.stdout ?? ''));
  return {};
}
function gitlabCallArgs(fixture) {
  return {
    fetchImpl: async () =>
      fixture.throws
        ? { ok: false, status: fixture.status ?? 500 }
        : { ok: true, json: async () => fixture.data },
  };
}

// gitlab.prReviews (issue #317) is the ONLY verb that reads TWO endpoints —
// MR notes (the verdict thread) and MR approvals (the L6 approver roster) —
// so the uniform single-payload `gitlabCallArgs` above cannot serve it: one
// fixed response for both calls would feed the notes payload to the approvals
// normalizer (and vice versa), producing a green test for the wrong reason.
// This glue dispatches on the request URL, serving each endpoint its own half
// of `fixture.data`. `page`-aware: any page past the first returns `[]`, the
// short-page terminator the verb's pagination loop stops on.
function gitlabPrReviewsCallArgs(fixture) {
  return {
    fetchImpl: async (url) => {
      if (fixture.throws) return { ok: false, status: fixture.status ?? 500 };
      if (url.includes('/approvals')) return { ok: true, json: async () => fixture.data.approvals };
      const firstPage = !/[?&]page=(?!1\b)\d+/.test(url);
      return { ok: true, json: async () => (firstPage ? fixture.data.notes : []) };
    },
  };
}

// authCheck/authLogin (issues #364/#365, M10 Phase 2 ranks 5-6) call the raw
// `run()` wrapper, not `runJson()` — there is no JSON body to parse, only an
// exit status (`run()`'s `ok: r.status === 0`). Reusing `jsonSpawnCallArgs`
// would JSON-serialize the fixture's data as stdout, fabricating a JSON body
// neither verb ever parses. This glue drives `_spawn` directly off the
// fixture's own `status`/`stdout`/`stderr` fields — the exact mechanism both
// verbs' boolean return value depends on (design D1).
function rawStatusCallArgs(fixture) {
  setSpawn(() => ({ status: fixture.status, stdout: fixture.stdout ?? '', stderr: fixture.stderr ?? '' }));
  return {};
}

// repoCloneUrl (issue #385, M10 Phase 2 final Gap-A batch) — an obviously
// synthetic placeholder, never a realistic secret shape (no ghp_/glpat-/gho_
// prefix, no base62 entropy run), matching the existing 'sample-cred-9x7'
// precedent (:739).
const PLACEHOLDER_CREDENTIAL = 'placeholder-not-a-real-token';

const PROVIDERS = {
  github: {
    module: github,
    labelEvents: jsonSpawnCallArgs,
    prView: jsonSpawnCallArgs,
    mrCreate: githubRawCallArgs,
    issueView: jsonSpawnCallArgs,
    mrList: jsonSpawnCallArgs,
    issueList: jsonSpawnCallArgs,
    authCheck: rawStatusCallArgs,
    authLogin: rawStatusCallArgs,
    prReviews: jsonSpawnCallArgs,
    // whoami/commitStatus (issue #385, M10 Phase 2 final Gap-A batch) spawn
    // `gh api` via runJson — the same JSON-over-spawn seam mrList/issueList
    // use.
    whoami: jsonSpawnCallArgs,
    commitStatus: jsonSpawnCallArgs,
    // commitPrs (issue #1086, D3) spawns `gh api --paginate` — the same
    // JSON-over-spawn seam labelEvents/issueList/commitStatus use.
    commitPrs: jsonSpawnCallArgs,
  },
  gitlab: {
    module: gitlab,
    labelEvents: gitlabCallArgs,
    prView: gitlabCallArgs,
    mrCreate: gitlabCallArgs,
    issueView: gitlabCallArgs,
    // gitlab.mrList spawns `glab` via runJson rather than fetching over
    // gitlabApiFetch (design D1) — it shares GitHub's spawn-transport seam,
    // so PROVIDERS.gitlab.mrList is the SAME function object as
    // PROVIDERS.github.mrList. That is the honest encoding of "both
    // providers share one transport for this verb", not a copy-paste error.
    mrList: jsonSpawnCallArgs,
    // gitlab.issueList spawns `glab` via runJson for the same reason
    // gitlab.mrList does (design D1) — same shared function object.
    issueList: jsonSpawnCallArgs,
    // gitlab.authCheck/authLogin spawn `glab` via the raw run() wrapper, the
    // same shared spawn-transport seam github's boolean verbs use — same
    // shared function object, same "one transport, both providers" honesty.
    authCheck: rawStatusCallArgs,
    authLogin: rawStatusCallArgs,
    // gitlab.prReviews reads TWO endpoints over gitlabApiFetch (issue #317),
    // so it needs the URL-dispatching glue rather than the uniform one.
    prReviews: gitlabPrReviewsCallArgs,
    // gitlab.whoami/commitStatus spawn `glab` via runJson for the same reason
    // gitlab.mrList/issueList do (design D1) — SAME shared function object.
    whoami: jsonSpawnCallArgs,
    commitStatus: jsonSpawnCallArgs,
    // gitlab.commitPrs fetches over gitlabApiFetch, same seam as prView.
    commitPrs: gitlabCallArgs,
  },
};

for (const providerName of Object.keys(PROVIDERS)) {
  const {
    module: vcs,
    labelEvents: labelEventsArgs,
    prView: prViewArgs,
    mrCreate: mrCreateArgs,
    issueView: issueViewArgs,
    mrList: mrListArgs,
    issueList: issueListArgs,
    authCheck: authCheckArgs,
    authLogin: authLoginArgs,
    prReviews: prReviewsArgs,
    whoami: whoamiArgs,
    commitStatus: commitStatusArgs,
    commitPrs: commitPrsArgs,
  } = PROVIDERS[providerName];

  // ── labelEvents ────────────────────────────────────────────────────────
  test(`${providerName}.labelEvents (contract): happy fixture normalizes to the shared shape, ascending by at`, async () => {
    const fixtureName = `${providerName}-labelEvents-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.labelEvents({ project: 'x/y', number: 1, ...labelEventsArgs(fixture) });

    assert.ok(Array.isArray(result), 'labelEvents must return an array on a successful fetch');
    assert.ok(result.length >= 2, 'happy fixture must exercise at least 2 label events');
    for (const entry of result) {
      assert.ok('login' in entry.actor, 'each entry must normalize to { actor: { login } }');
      assert.ok(['add', 'remove'].includes(entry.action), 'action must normalize to add|remove');
      assert.ok('label' in entry, 'each entry must carry a normalized label');
      assert.ok('at' in entry, 'each entry must carry a normalized at timestamp');
      // No provider-specific field name may leak through the contract.
      assert.ok(!('iid' in entry), 'must not leak GitLab iid');
      assert.ok(!('username' in entry), 'must not leak raw username (only actor.login)');
      assert.ok(!('created_at' in entry), 'must not leak raw created_at (only at)');
    }
    const ats = result.map(e => new Date(e.at).getTime());
    const sorted = [...ats].sort((a, b) => a - b);
    assert.deepEqual(ats, sorted, 'labelEvents must be ordered chronologically ascending');
  });

  test(`${providerName}.labelEvents (contract): a fetch failure yields null, never a fabricated []`, async () => {
    const fixtureName = `${providerName}-labelEvents-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.labelEvents({ project: 'x/y', number: 1, ...labelEventsArgs(fixture) });
    assert.equal(result, null, 'an uncomputable labelEvents fetch must return null, never []');
  });

  // ── prView ─────────────────────────────────────────────────────────────
  test(`${providerName}.prView (contract): happy fixture normalizes to { number, labels, body, author }`, async () => {
    const fixtureName = `${providerName}-prView-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.prView({ project: 'x/y', number: 1, ...prViewArgs(fixture) });

    assert.equal(typeof result.number, 'number', 'number must normalize to a number');
    assert.ok(Array.isArray(result.labels), 'labels must normalize to an array of names');
    for (const label of result.labels) assert.equal(typeof label, 'string', 'each label must be a bare name string');
    assert.equal(typeof result.body, 'string', 'body must be a string on a successful fetch');
    // REQ-A3-... (task 3.7 body-parity): `null` means uncomputable, `''` means
    // successfully-empty — a SUCCESSFUL fetch must never surface `null`.
    assert.notEqual(result.body, null, 'a successful prView fetch must never surface body:null (that means uncomputable)');
    assert.notEqual(result.author, undefined, 'author key must be present (null is valid — absent-on-provider — undefined is not)');
    // issue #1086, D1: a successful fetch MUST additively report `absent: false`
    // — existing consumers that do not read `absent` are unaffected by this key.
    assert.equal(result.absent, false, 'a successful prView fetch must report absent:false');
  });

  test(`${providerName}.prView (contract): a fetch failure yields the null-shape, never throws`, async () => {
    const fixtureName = `${providerName}-prView-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.prView({ project: 'x/y', number: 42, ...prViewArgs(fixture) });
    // issue #1086, D1: this fixture is the GENERIC/unreadable failure — the
    // read could not be completed for a reason OTHER than a definitive
    // negative, so `absent` must be `null` (unknown), never `true`.
    assert.deepEqual(result, {
      number: 42,
      labels: null,
      body: null,
      author: null,
      headRefOid: null,
      baseRefOid: null,
      absent: null,
    });
  });

  // issue #1086, D1/D2: the definitive-negative case — the requested number
  // identifies an issue, not a pull/merge request. `labels`/`body` MUST stay
  // `null` (REQ-CIC-2's sentinel is untouched — a consumer that does not read
  // `absent` sees exactly the legacy unreadable shape), and `absent` MUST be
  // `true`, never `null`.
  test(`${providerName}.prView (contract): reports absent:true on the not-found fixture — a number that is an issue, not a PR (#1086)`, async () => {
    const fixtureName = `${providerName}-prView-notfound.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.prView({ project: 'x/y', number: 978, ...prViewArgs(fixture) });
    assert.deepEqual(result, {
      number: 978,
      labels: null,
      body: null,
      author: null,
      headRefOid: null,
      baseRefOid: null,
      absent: true,
    });
  });

  // headRefOid (ADR-0021 Decision 1): the recorded/derived happy fixtures
  // predate this field (queried BEFORE the widening), so they are exercised
  // inline here rather than mutating provenance-tracked fixture files.
  test(`${providerName}.prView (contract): a successful fetch normalizes headRefOid to the API head sha`, async () => {
    const withHead =
      providerName === 'github'
        ? { throws: false, data: { number: 7, labels: [], body: '', author: null, headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d' } }
        : { throws: false, data: { iid: 7, labels: [], description: '', author: null, sha: 'cafef00dcafef00dcafef00dcafef00dcafef00d' } };
    const result = await vcs.prView({ project: 'x/y', number: 7, ...prViewArgs(withHead) });
    assert.equal(result.headRefOid, 'cafef00dcafef00dcafef00dcafef00dcafef00d');
  });

  test(`${providerName}.prView (contract): headRefOid normalizes to null when uncomputable on an otherwise-successful fetch`, async () => {
    const noHead =
      providerName === 'github'
        ? { throws: false, data: { number: 7, labels: [], body: '', author: null } }
        : { throws: false, data: { iid: 7, labels: [], description: '', author: null } };
    const result = await vcs.prView({ project: 'x/y', number: 7, ...prViewArgs(noHead) });
    assert.equal(result.headRefOid, null);
  });

  // Body-parity (task 3.7, empty-vs-uncomputable canonical rule): `null` means
  // uncomputable (the fetch itself failed — asserted above); `''` means the
  // fetch SUCCEEDED and the underlying body/description field was genuinely
  // empty. Prior to A3 Phase 3, GitHub's prView already normalized to `?? ''`
  // but GitLab's normalized bare `r.description` (→ `null`/`undefined` when
  // absent) — indistinguishable from the failure case above. This test would
  // RED on the pre-fix gitlab.mjs.
  test(`${providerName}.prView (contract): a successful fetch with no body/description normalizes to '' (never null — null means uncomputable)`, async () => {
    const emptyFixture =
      providerName === 'github'
        ? { throws: false, data: { number: 7, labels: [], body: null, author: null } }
        : { throws: false, data: { iid: 7, labels: [], description: null, author: null } };
    const result = await vcs.prView({ project: 'x/y', number: 7, ...prViewArgs(emptyFixture) });
    assert.equal(result.body, '', 'a successfully-fetched-but-empty body must normalize to "", not null/undefined');
  });

  // ── issueView (issue #334, M10 Gap-A) ─────────────────────────────────
  // `({ project, number }) -> { number, title, labels, body, author }`. `labels`
  // is always a `string[]`, never null, possibly empty — the source of the
  // issue's `type:*` label consumed by `ship-pr-label-resolution` /
  // `findTypeLabel`. Unlike `prView`, a fetch failure REJECTS (design A5) —
  // `brain-start.mjs:65` already depends on that, so this is PINNED, not fixed.
  test(`${providerName}.issueView (contract): happy fixture normalizes to { number, title, labels, body, author }`, async () => {
    const fixtureName = `${providerName}-issueView-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.issueView({ project: 'x/y', number: 1, ...issueViewArgs(fixture) });

    assert.equal(typeof result.number, 'number', 'number must normalize to a number');
    assert.equal(typeof result.title, 'string', 'title must be a string');
    assert.ok(Array.isArray(result.labels), 'labels must always normalize to an array, never null/undefined');
    for (const label of result.labels) {
      assert.equal(typeof label, 'string', 'each label must be a bare name string — no leaked provider object shape');
    }
    assert.equal(typeof result.body, 'string', 'body must be a string on a successful fetch');
    assert.notEqual(result.author, undefined, 'author key must be present (null is valid — undefined is not)');
  });

  test(`${providerName}.issueView (contract): a fetch failure REJECTS — never a fabricated null/empty shape (A5)`, async () => {
    const fixtureName = `${providerName}-issueView-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    await assert.rejects(
      () => vcs.issueView({ project: 'x/y', number: 9999, ...issueViewArgs(fixture) }),
      'issueView must REJECT on a fetch failure — brain-start.mjs:65 depends on that, unlike prView\'s null-shape',
    );
  });

  test(`${providerName}.issueView (contract): a successful fetch with no labels normalizes to [], never null/undefined`, async () => {
    // The `labels` key is OMITTED from the payload DELIBERATELY. A payload
    // that already carried `labels: []` would satisfy the assertion below
    // without the provider's `?? []` guard ever running — a vacuous test that
    // would still pass if the guard were deleted. With the key absent, `[]`
    // can only come from the guard, so the invariant is genuinely pinned.
    const emptyFixture =
      providerName === 'github'
        ? { throws: false, data: { number: 7, title: 'x', body: '', user: { login: null } } }
        : { throws: false, data: { iid: 7, title: 'x', description: '', author: null } };
    const result = await vcs.issueView({ project: 'x/y', number: 7, ...issueViewArgs(emptyFixture) });
    assert.deepEqual(result.labels, [], 'an empty label set must normalize to [], not null/undefined');
  });

  // ── issueView.state / stateReason (issue #557, D2 — the archive sweep's
  // closed-issue selector) ──────────────────────────────────────────────────
  // The recorded/derived happy fixtures above predate this field (queried
  // BEFORE the widening), so — same discipline as `prView`'s headRefOid tests
  // (:263-282) — these are exercised inline rather than mutating
  // provenance-tracked fixture files.
  test(`${providerName}.issueView (contract): a closed issue with a completed reason normalizes state:'closed', stateReason:'completed' (or GitLab's always-null residual)`, async () => {
    const closedFixture =
      providerName === 'github'
        ? { throws: false, data: { number: 7, title: 'x', body: '', user: null, state: 'closed', state_reason: 'completed' } }
        : { throws: false, data: { iid: 7, title: 'x', description: '', author: null, state: 'closed' } };
    const result = await vcs.issueView({ project: 'x/y', number: 7, ...issueViewArgs(closedFixture) });
    assert.equal(result.state, 'closed', 'a closed issue must normalize state to the literal "closed" on both providers');
    if (providerName === 'github') {
      assert.equal(result.stateReason, 'completed', "GitHub's state_reason passes through unchanged");
    } else {
      assert.equal(result.stateReason, null, "GitLab has no state_reason field — always null, the documented residual (vcs-contract.md)");
    }
  });

  test(`${providerName}.issueView (contract): an open issue normalizes state:'open' — GitHub passes 'open' through, GitLab normalizes 'opened'`, async () => {
    const openFixture =
      providerName === 'github'
        ? { throws: false, data: { number: 8, title: 'x', body: '', user: null, state: 'open', state_reason: null } }
        : { throws: false, data: { iid: 8, title: 'x', description: '', author: null, state: 'opened' } };
    const result = await vcs.issueView({ project: 'x/y', number: 8, ...issueViewArgs(openFixture) });
    assert.equal(result.state, 'open', "GitLab's 'opened' must normalize to the shared 'open' enum, matching GitHub's own literal");
    assert.equal(result.stateReason, null, 'an open issue carries no closure reason on either provider');
  });

  // ── mrList (issue #355, M10 Phase 2 rank-3; issue #930 D1/D2 widening) ──
  // `({ project, state, headBranch }) -> [{ number, title, headBranch, state, merged }]`.
  // `state`/`merged` are additive (#930) — every pre-#930 caller reading only
  // `number`/`title`/`headBranch` keeps working unchanged. `headBranch` is an
  // optional filter (D2); an unfiltered call stays byte-identical to the
  // pre-#930 query. Unlike its sibling read verbs (prView/prReviews/labelEvents/
  // prStatusRollup), `mrList`
  // does NOT wrap its transport call — `runJson` throws on a non-zero exit or
  // malformed JSON (exec.mjs:31-32), and neither provider catches it. This is
  // PINNED here (design D3) because changing it is out of scope for this
  // change, NOT because a caller depends on the throw — the opposite of why
  // issueView's failure-REJECTS test above is pinned.
  test(`${providerName}.mrList (contract): happy fixture normalizes to exactly { number, title, headBranch } per entry`, async () => {
    const fixtureName = `${providerName}-mrList-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.mrList({ project: 'x/y', state: 'open', ...mrListArgs(fixture) });

    assert.ok(result.length >= 2, 'happy fixture must exercise at least 2 entries');
    for (const entry of result) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['headBranch', 'merged', 'number', 'state', 'title'],
        'each mrList entry must normalize to EXACTLY { number, title, headBranch, state, merged } — the additive #930 shape, no narrowed or extra fields',
      );
    }
    // Full-array lock: pins values AND order (neither provider sorts —
    // callers index into the list, so preserving the API's own ordering
    // matters). Expected values are hardcoded from the fixture's own known
    // content rather than re-derived from fixture.data via the same
    // number/head.ref/source_branch mapping the normalizer performs — doing
    // so would let a normalizer bug that mirrors this test's mapping pass
    // undetected. Both fixtures were queried with an open-state filter, so
    // every entry is `state: 'open', merged: false` (a PR that is still open
    // has never merged) — #930's D1 mapping.
    const expected =
      providerName === 'github'
        ? [
            { number: 342, title: 'M10: seam-contract-coverage epic tracker', headBranch: 'feature/m10-seam-contract-coverage', state: 'open', merged: false },
            { number: 331, title: 'fix(governance): re-order release audit gate to audit-then-tag and add audit baseline', headBranch: 'fix/issue-210-fixgovernance-releaseyml-audit-gate-cann', state: 'open', merged: false },
          ]
        : [
            { number: 42, title: 'Add pagination guard to labelList', headBranch: 'feat/label-pagination', state: 'open', merged: false },
            { number: 41, title: 'Fix issueView author normalization', headBranch: 'fix/issue-author-null', state: 'open', merged: false },
          ];
    assert.deepEqual(result, expected);
  });

  // #930 — spec.md's "Both providers report merged state" scenario: a closed,
  // merged PR and a closed, unmerged PR on two different branches, both
  // normalized through the shared {state, merged} pair.
  test(`${providerName}.mrList (contract): both providers report merged state — closed+merged vs closed+unmerged on different branches`, async () => {
    const fixtureName = `${providerName}-mrList-all.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.mrList({ project: 'x/y', state: 'all', ...mrListArgs(fixture) });

    const merged = result.find((r) => r.state === 'closed' && r.merged === true);
    const unmerged = result.find((r) => r.state === 'closed' && r.merged === false);
    assert.ok(merged, 'the `-all` fixture must include a closed, merged PR');
    assert.ok(unmerged, 'the `-all` fixture must include a closed, unmerged PR');
    assert.notEqual(merged.headBranch, unmerged.headBranch, 'the merged and unmerged PRs must be on different branches');
    assert.equal(typeof merged.number, 'number');
    assert.equal(typeof unmerged.number, 'number');
  });

  test(`${providerName}.mrList (contract): an empty open-list yields [], never a fabricated null/undefined`, async () => {
    const fixtureName = `${providerName}-mrList-empty.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.mrList({ project: 'x/y', state: 'open', ...mrListArgs(fixture) });
    assert.deepEqual(result, [], 'board.mjs/queue.mjs iterate the mrList result unguarded — [] is required, null/undefined would crash them');
  });

  test(`${providerName}.mrList (contract): a transport failure REJECTS — pinned as a documented divergence, not fixed here`, async () => {
    const fixtureName = `${providerName}-mrList-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    await assert.rejects(
      () => vcs.mrList({ project: 'x/y', state: 'open', ...mrListArgs(fixture) }),
      'mrList must REJECT on a transport failure — unlike prView/prReviews/labelEvents/prStatusRollup\'s never-throws convention, mrList does not wrap runJson in a try/catch (design D3); this is PINNED because changing it is out of scope here, not because a caller depends on it',
    );
  });

  // ── issueList (issue #362, M10 Phase 2 rank-4) ──────────────────────────
  // `({ project, state, assignee }) -> [{ number, title, labels }]`. Like
  // `mrList`, `issueList` does NOT wrap its transport call — `runJson` throws
  // on a non-zero exit or malformed JSON (exec.mjs:31-32), and neither
  // provider catches it. BUT the reason this throw is pinned is the OPPOSITE
  // of why mrList's is (design D3): every `issueList` call site already
  // ABSORBS the throw — `tracker-board.mjs:44-47`'s `safeList` wraps it in
  // try/catch and returns `[]`; `project-status.mjs:115-130` wraps the call
  // (and the sibling `mrList` call) in its own try/catch. So the throw is
  // CONTAINED and load-bearing here, not merely out of scope to fix.
  //
  // D1 — the `assignee` parameter is DELIBERATELY EXCLUDED from this loop.
  // Every assignee value produces the identical result shape from the
  // identical response payload; only the query string varies, and that is
  // already unit-tested at `cli.test.mjs:110-116`. Tracing what would
  // silently go green if `assignee: 'me'` were added under this loop's
  // uniform-response stub (one fixed response for every spawn call): `
  // whoami()` would receive the ISSUES ARRAY back instead of a user object,
  // so `resp.login`/`resp.username` would be `undefined`;
  // `assigneeParams('github', 'me', undefined)` falls back to a
  // plausible-looking `{ assignee: '@me' }`; `assigneeParams('gitlab', 'me',
  // undefined)` yields `{ assignee_username: undefined }`, which `toQs`
  // filters out but still leaves a truthy `extra`, producing a malformed
  // trailing `&` in the endpoint. The second `runJson` call then returns the
  // same array again and normalizes cleanly — a GREEN test for the WRONG
  // reason. Do not "improve" this coverage by adding `assignee` here.
  test(`${providerName}.issueList (contract): happy fixture normalizes to exactly { number, title, labels } per entry`, async () => {
    const fixtureName = `${providerName}-issueList-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.issueList({ project: 'x/y', state: 'open', ...issueListArgs(fixture) });

    assert.ok(result.length >= 2, 'happy fixture must exercise at least 2 surviving entries');
    for (const entry of result) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['assignees', 'labels', 'number', 'title'],
        'each issueList entry must normalize to EXACTLY { number, title, labels, assignees } — no narrowed or widened shape',
      );
      for (const label of entry.labels) {
        assert.equal(
          typeof label,
          'string',
          'each label must be a bare name string — GitHub unwraps label objects via .map(l => l.name), GitLab is already a flat string array',
        );
      }
    }
    // Full-array lock: pins values AND order (neither provider sorts — the
    // API's own ordering surfaces as-is, and project-status.mjs:118 prints in
    // that order). Expected values are hardcoded from the fixture's own known
    // content rather than re-derived from fixture.data via the same
    // number/iid/labels mapping the normalizer performs — doing so would let
    // a normalizer bug that mirrors this test's mapping pass undetected.
    // `assignees: null` throughout is TRUTHFUL for these fixtures and is not a
    // claim about the endpoints: both payloads were trimmed when recorded/derived
    // and carry no assignee field at all, which is exactly the case
    // `normalizeAssignees` answers `null` to. The populated and genuinely-empty
    // cases are exercised by the *-issueList-assignees.json fixtures (#533).
    const expected =
      providerName === 'github'
        ? [
            { number: 362, title: 'feat(m10-phase2): issueList contract-parity coverage (rank 4)', labels: ['type:feature', 'status:needs-review'], assignees: null },
            { number: 361, title: 'fix(memory): index self-healing is backend-asymmetric — engram.share() reindexes conditionally and engram.pull() never does', labels: [], assignees: null },
            { number: 358, title: 'Q5 — Architecture decision: doctrine tiers (lite/standard/regulated)', labels: [], assignees: null },
            { number: 340, title: 'fix(governance): issue-link local check and CI job implement the same rule differently — brain:check greenlights PRs that CI rejects', labels: ['type:bug', 'status:needs-review'], assignees: null },
            { number: 336, title: 'feat(vcs): M10 Phase 1 — port-verb contract coverage audit (detection only)', labels: ['type:feature', 'status:needs-review'], assignees: null },
            { number: 329, title: 'fix(governance): actor-check L5 and #124 are mutually unsatisfiable for a solo maintainer', labels: ['type:bug'], assignees: null },
          ]
        : [
            { number: 42, title: 'Add pagination guard to labelList', labels: ['type:bug', 'status:needs-review'], assignees: null },
            { number: 41, title: 'Fix issueView author normalization', labels: [], assignees: null },
          ];
    assert.deepEqual(result, expected);
  });

  // ── assignees: THREE outcomes, one assertion set, both providers (#533) ──
  // The whole reason this field was worth an ADR is that `[]` and `null` must not
  // be the same answer. One fixture per outcome, mirrored entry-for-entry across
  // the two providers, so a provider that quietly `?? []`s its way to "nobody is
  // assigned" fails here rather than in a map somebody trusted.
  test(`${providerName}.issueList (contract): assignees distinguish "nobody" ([]) from "cannot see" (null)`, async () => {
    const fixtureName = `${providerName}-issueList-assignees.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.issueList({ project: 'x/y', state: 'open', ...issueListArgs(fixture) });
    const by = (n) => result.find(r => r.number === n);

    assert.deepEqual(by(901).assignees, ['alice', 'bob'], 'the plural array normalizes to bare names');
    assert.deepEqual(by(902).assignees, [], 'read, and nobody is assigned — an EMPTY list, not null');
    assert.deepEqual(by(903).assignees, ['carol'], 'no plural key, but a singular one still answers the question');
    assert.equal(by(904).assignees, null, 'NO assignee field at all is "brain cannot see" — null, never []');

    // The two failing outcomes must be distinguishable by a caller, which is the
    // property `evidence-reader-empty-on-failure` is about. Asserting each value
    // separately above would still pass if both were `[]`.
    assert.notDeepEqual(by(902).assignees, by(904).assignees,
      '"nobody is assigned" and "brain cannot see" must not be the same value');
  });

  test(`${providerName}.issueList (contract): an empty open-list yields [], never a fabricated null/undefined`, async () => {
    const fixtureName = `${providerName}-issueList-empty.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.issueList({ project: 'x/y', state: 'open', ...issueListArgs(fixture) });
    assert.deepEqual(
      result,
      [],
      "tracker-board.mjs:58's myIssues.length is unguarded — null/undefined would crash it with an uncaught TypeError at ESM top level; [] is the only safe return",
    );
  });

  test(`${providerName}.issueList (contract): a transport failure REJECTS — caller-absorbed at both call sites, unlike mrList's out-of-scope pin`, async () => {
    const fixtureName = `${providerName}-issueList-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    await assert.rejects(
      () => vcs.issueList({ project: 'x/y', state: 'open', ...issueListArgs(fixture) }),
      "issueList must REJECT on a transport failure — tracker-board.mjs:44-47's safeList catches it and returns [], and project-status.mjs:115-130 wraps the call in its own try/catch; both sites already absorb the throw, so it is CONTAINED and load-bearing here, not merely pinned because fixing it is out of scope (contrast with mrList's design D3 rationale)",
    );
  });

  // ── authCheck (issue #365, M10 Phase 2 rank-6) ──────────────────────────
  // `({ host }) -> boolean` (vcs-contract.md row 24). Corrected premise
  // (design.md): the originating task brief assumed a `{ username }` object
  // shape; both providers call the raw `run()` wrapper (never `runJson()`)
  // and return `.ok` — a plain boolean. `run()` never throws (exec.mjs:20-23)
  // — a non-zero exit normalizes to `false`, it does not reject. This is the
  // OPPOSITE divergence from mrList/issueList, which are pinned as throwing.
  test(`${providerName}.authCheck (contract): an authenticated session returns exactly true`, async () => {
    const fixtureName = `${providerName}-authCheck-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.authCheck({ host: 'github.com', ...authCheckArgs(fixture) });
    assert.equal(result, true, 'authCheck must return the exact boolean true on an authenticated session, not merely a truthy value');
  });

  test(`${providerName}.authCheck (contract): an unauthenticated session returns exactly false, and never rejects`, async () => {
    const fixtureName = `${providerName}-authCheck-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    await assert.doesNotReject(
      async () => {
        const result = await vcs.authCheck({ host: 'github.com', ...authCheckArgs(fixture) });
        assert.equal(result, false, 'authCheck must return the exact boolean false on a non-zero exit, not merely a falsy value');
      },
      'authCheck must resolve on a non-zero exit — run() never throws (exec.mjs:20-23) — unlike mrList/issueList, which are pinned as rejecting',
    );
  });

  // ── authLogin (issue #364, M10 Phase 2 rank-5) ──────────────────────────
  // `({ host, token }) -> boolean` (vcs-contract.md row 25). Same corrected
  // premise as authCheck — see design.md's "Corrected premise" section.
  test(`${providerName}.authLogin (contract): a successful login returns exactly true`, async () => {
    const fixtureName = `${providerName}-authLogin-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.authLogin({ host: 'github.com', token: 'tok', ...authLoginArgs(fixture) });
    assert.equal(result, true, 'authLogin must return the exact boolean true on a successful login, not merely a truthy value');
  });

  test(`${providerName}.authLogin (contract): a failed login returns exactly false, and never rejects`, async () => {
    const fixtureName = `${providerName}-authLogin-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    await assert.doesNotReject(
      async () => {
        const result = await vcs.authLogin({ host: 'github.com', token: 'tok', ...authLoginArgs(fixture) });
        assert.equal(result, false, 'authLogin must return the exact boolean false on a non-zero exit, not merely a falsy value');
      },
      'authLogin must resolve on a non-zero exit — run() never throws (exec.mjs:20-23)',
    );
  });

  // ── prReviews (issue #317) ──────────────────────────────────────────────
  //
  // `({ project, number, ... }) -> Promise<Array<{ state, author, body }>|null>`.
  //
  // WHY THIS BLOCK EXISTS. Every one of the reviewer's flow guarantees —
  // the anti-loop lock (poster.mjs's `lastVerdict`), the `rev >= 3 -> STOP`
  // bound (verdict.mjs's `priorRevCount`), the §8 prior-verdict doctrine
  // load, and board reconciliation — is reconstructed from ONE input:
  // `cold-boot`'s `doctrine.priorVerdicts`, which is `prReviews(...)` mapped
  // through `parseVerdict`. `parseVerdict` needs a STRING `body`.
  //
  // Before #317 neither provider emitted one. GitHub's normalizer dropped
  // `body`; GitLab's read the APPROVALS endpoint, which has no bodies at all
  // and no verdict thread. So `priorVerdicts` was ALWAYS `[]` in production
  // and all four guarantees were inert — while their unit tests stayed green
  // because cold-boot.test.mjs and board.test.mjs injected a `body` no real
  // adapter ever emitted (cold-boot.mjs even carried a comment admitting it).
  //
  // The masking is what these tests exist to kill, so the central assertion
  // is deliberately NOT "the shape has a body key". It is: run the REAL
  // normalizer output through the REAL `parseVerdict` and require a verdict
  // back. That is the only assertion an adapter cannot satisfy while still
  // being broken in production — a shape-only check would go green again the
  // moment someone normalized `body` to `undefined`, and a hand-written
  // review object in the test would reintroduce exactly the injection this
  // block replaces.
  test(`${providerName}.prReviews (contract): happy fixture normalizes to exactly { state, author, body } per entry`, async () => {
    const fixtureName = `${providerName}-prReviews-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.prReviews({ project: 'x/y', number: 1, ...prReviewsArgs(fixture) });

    assert.ok(Array.isArray(result), 'prReviews must return an array on a successful fetch');
    assert.ok(result.length >= 2, 'happy fixture must exercise at least 2 entries');
    for (const entry of result) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['author', 'body', 'state'],
        'each prReviews entry must normalize to EXACTLY { state, author, body } — a narrowed shape is the #317 defect itself',
      );
      assert.equal(
        typeof entry.body,
        'string',
        'body must ALWAYS be a string — parse-verdict.mjs:36 rejects a non-string outright, so null/undefined silently empties priorVerdicts',
      );
      assert.notEqual(entry.author, undefined, 'author key must be present (null is valid — undefined is not)');
      // No provider-specific field name may leak through the contract.
      assert.ok(!('user' in entry), 'must not leak GitHub user object (only author)');
      assert.ok(!('username' in entry), 'must not leak raw GitLab username (only author)');
      assert.ok(!('system' in entry), 'must not leak GitLab note system flag');
      assert.ok(!('created_at' in entry), 'must not leak raw created_at');
    }
  });

  // THE anti-masking test. This is the assertion #317 turns on.
  test(`${providerName}.prReviews (contract): the REAL normalizer output parses into a verdict via the REAL parseVerdict — priorVerdicts is no longer always empty`, async () => {
    const fixtureName = `${providerName}-prReviews-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.prReviews({ project: 'x/y', number: 1, ...prReviewsArgs(fixture) });

    // Exactly cold-boot.mjs's `reviews.map(r => parseVerdict(r)).filter(Boolean)`
    // — the same expression, not a re-implementation, so a divergence between
    // this suite and production cannot hide here.
    const priorVerdicts = result.map(r => parseVerdict(r)).filter(Boolean);

    assert.ok(
      priorVerdicts.length >= 1,
      'the adapter\'s own output must yield at least one parsed verdict — an empty priorVerdicts is the #317 production defect: anti-loop dead, rev-bound dead, doctrine load dead, board reconciliation dead',
    );
    const latest = priorVerdicts[priorVerdicts.length - 1];
    assert.equal(typeof latest.head_sha, 'string', 'the parsed verdict must carry head_sha — poster.mjs compares it against the current head to suppress a duplicate re-post');
    assert.ok(['APPROVE', 'REVISE', 'STOP'].includes(latest.verdict), 'the parsed verdict must carry a recognized verdict scalar — board.mjs denormalizes it to reviewed:*');
    assert.notEqual(latest.author, undefined, 'the parsed verdict must carry author — poster.mjs\'s anti-loop compares it against the reviewer handle');
  });

  test(`${providerName}.prReviews (contract): a fetch failure yields null, never a fabricated []`, async () => {
    const fixtureName = `${providerName}-prReviews-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.prReviews({ project: 'x/y', number: 1, ...prReviewsArgs(fixture) });
    assert.equal(
      result,
      null,
      'an uncomputable prReviews fetch must return null, never [] — the L6 gate distinguishes "nobody approved" from "could not fetch"',
    );
  });

  if (providerName === 'gitlab') {
    test(`${providerName}.prReviews (contract): malformed notes response (200 OK, non-array body) yields null, matching prStatusRollup discipline`, async () => {
      const fixtureName = `${providerName}-prReviews-malformed.json`;
      const fixture = loadFixture(fixtureName);
      assertProvenance(fixture, fixtureName);

      const result = await vcs.prReviews({ project: 'x/y', number: 1, ...prReviewsArgs(fixture) });
      assert.equal(
        result,
        null,
        'prReviews must return null on a malformed notes response (200 OK with non-array body), not fabricate [] — all-or-nothing invariant',
      );
    });
  }

  // ── whoami (issue #385, M10 Phase 2 final Gap-A batch) ──────────────────
  // `() -> { username }` (vcs-contract.md row 26). Transport is `runJson` on
  // both providers (design D1) — the same seam mrList/issueList use, so a
  // transport failure REJECTS rather than yielding a null-shape. `whoami()`
  // is declared with no parameter list on either provider (github.mjs:30,
  // gitlab.mjs:31) — `whoamiArgs(fixture)` is called purely for its
  // `setSpawn` side effect (design D1 gotcha).
  test(`${providerName}.whoami (contract): happy fixture normalizes to exactly { username }`, async () => {
    const fixtureName = `${providerName}-whoami-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.whoami({ ...whoamiArgs(fixture) });
    // Hardcoded expected value — never re-derived from fixture.data.login/
    // .username, which would let a mirrored normalizer bug pass (design D3,
    // matching the mrList/issueList precedent at :354-360/:442-447).
    assert.deepEqual(
      result,
      providerName === 'github' ? { username: 'csrinaldi' } : { username: 'brain-bot' },
      'whoami must normalize to EXACTLY { username } — no login/id/avatar_url or other raw field name may leak through the contract',
    );
  });

  test(`${providerName}.whoami (contract): a transport failure REJECTS — no null-shape fallback exists for this verb`, async () => {
    const fixtureName = `${providerName}-whoami-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    await assert.rejects(
      () => vcs.whoami({ ...whoamiArgs(fixture) }),
      'whoami must REJECT on a transport failure — runJson throws (exec.mjs:31-32) and neither provider wraps it; a failed lookup must never fabricate { username: undefined }',
    );
  });

  // ── commitStatus (issue #385, M10 Phase 2 final Gap-A batch) ────────────
  // `({ project, sha }) -> Status|null` (vcs-contract.md row 35). Transport is
  // `runJson` on both providers (design D1) — a transport failure REJECTS,
  // the mrList flavor (pinned out-of-scope, design D2), not the issueList
  // flavor (caller-absorbed).
  test(`${providerName}.commitStatus (contract): a completed check normalizes to the canonical enum value`, async () => {
    const fixtureName = `${providerName}-commitStatus-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.commitStatus({ project: 'x/y', sha: 'cafef00d', ...commitStatusArgs(fixture) });
    assert.equal(result, 'success', 'a completed, successful check must normalize to the canonical "success" enum value on both providers');
  });

  test(`${providerName}.commitStatus (contract): no computable status normalizes to null — a SUCCESSFUL call with nothing to report`, async () => {
    const fixtureName = `${providerName}-commitStatus-empty.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.commitStatus({ project: 'x/y', sha: 'cafef00d', ...commitStatusArgs(fixture) });
    assert.equal(result, null, 'an empty check set is a SUCCESSFUL call with nothing to report — null, not a rejection; the failure case below is what rejects');
  });

  test(`${providerName}.commitStatus (contract): a transport failure REJECTS — pinned out-of-scope, not because a caller depends on the throw`, async () => {
    const fixtureName = `${providerName}-commitStatus-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    await assert.rejects(
      () => vcs.commitStatus({ project: 'x/y', sha: 'cafef00d', ...commitStatusArgs(fixture) }),
      'commitStatus must REJECT on a transport failure — runJson throws (exec.mjs:31-32) and neither provider wraps it; PINNED as out-of-scope (the mrList rationale, design D2 there), NOT because a caller depends on the throw',
    );
  });

  // ── commitPrs (issue #1086, D3) ──────────────────────────────────────────
  // `({ project, sha }) -> number[]|null` — the pull requests that contain a
  // commit. Mirrors `commitStatus({project, sha})`'s commit-keyed shape, but
  // NEVER throws (unlike `commitStatus`, pinned above): `[]` on a definitive
  // empty list, `null` on any transport failure, ascending on a real list —
  // `fetchPrMeta`'s fail-closed gate (Phase 4) depends on `null` never being
  // conflated with `[]`.
  test(`${providerName}.commitPrs (contract): happy fixture normalizes to an ascending number[]`, async () => {
    const fixtureName = `${providerName}-commitPrs-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.commitPrs({ project: 'x/y', sha: 'd4cb7f8', ...commitPrsArgs(fixture) });
    assert.deepEqual(result, [991], 'the happy fixture carries exactly one containing pull request, number 991');
    const sorted = [...result].sort((a, b) => a - b);
    assert.deepEqual(result, sorted, 'commitPrs must be ordered ascending');
  });

  test(`${providerName}.commitPrs (contract): a definitive empty list normalizes to [], never null`, async () => {
    const fixtureName = `${providerName}-commitPrs-empty.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.commitPrs({ project: 'x/y', sha: 'deadbeef', ...commitPrsArgs(fixture) });
    assert.deepEqual(result, [], 'no containing pull request is a SUCCESSFUL read with an empty answer — [], not null');
  });

  test(`${providerName}.commitPrs (contract): a transport failure yields null, never throws and never a fabricated []`, async () => {
    const fixtureName = `${providerName}-commitPrs-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.commitPrs({ project: 'x/y', sha: 'deadbeef', ...commitPrsArgs(fixture) });
    assert.equal(result, null, 'an unreadable commitPrs lookup must return null, never []  and never throw');
  });

  // ── projectResolve (issue #385, M10 Phase 2 final Gap-A batch) ──────────
  // `({ project }) -> string` (vcs-contract.md row 38). Both implementations
  // are `return project` — no transport, no failure mode, no empty case
  // (design D6). No fixture, no PROVIDERS key: there is nothing to inject.
  test(`${providerName}.projectResolve (contract): returns the slug unchanged — identity on both providers, the documented extension point`, async () => {
    assert.equal(await vcs.projectResolve({ project: 'x/y' }), 'x/y');
    // Nested GitLab group path: proves projectResolve does NOT url-encode —
    // each verb encodes locally at its own call site (gitlab.mjs:371), so
    // encoding here would double-encode every downstream request.
    assert.equal(await vcs.projectResolve({ project: 'group/sub/repo' }), 'group/sub/repo');
  });

  // ── repoCloneUrl (issue #385, M10 Phase 2 final Gap-A batch) ────────────
  // `({ host, project, token }) -> string` (vcs-contract.md row 36). No
  // transport (design D1) — no fixture, no PROVIDERS key. `new URL()` parses
  // the result rather than grepping it, so the credential is proven to sit in
  // a specific structural position, not merely "somewhere in the string"
  // (design D4) — the string-construction analogue of the authLogin
  // stdin-vs-argv guard (:738-752).
  test(`${providerName}.repoCloneUrl (contract): the credential sits in the userinfo segment, and the provider's user literal is not a caller concern`, async () => {
    const url = await vcs.repoCloneUrl({ host: 'vcs.example.test', project: 'x/y', token: PLACEHOLDER_CREDENTIAL });
    const parsed = new URL(url);

    assert.equal(parsed.protocol, 'https:', 'the clone URL must be https — a git-protocol or http URL would carry the credential in clear');
    assert.equal(parsed.password, PLACEHOLDER_CREDENTIAL, 'the credential must sit in the userinfo PASSWORD position — the only place git consumes it');
    assert.equal(parsed.host, 'vcs.example.test', 'the supplied host must be honored verbatim when present');
    assert.equal(parsed.pathname, '/x/y.git', 'the project slug must reach the path unencoded and .git-suffixed');
    assert.equal(parsed.search, '', 'the credential must NEVER ride in the query string — proxies and servers log query strings, they do not log userinfo');
    assert.ok(parsed.username.length > 0, "a user literal must be present; WHICH literal is provider-specific (x-access-token vs oauth2) and is never compared across providers here");
  });

  // ── patSetupUrl (issue #385, M10 Phase 2 final Gap-A batch) ─────────────
  // `({ host, name, scopes }) -> string` (vcs-contract.md row 37). No
  // transport (design D1) — no fixture, no PROVIDERS key. This verb is mostly
  // NOT parity (divergence locks below, design D5) — this is the thin floor
  // genuinely common to both providers: comparing VALUES, not query KEYS,
  // since the key itself diverges (GH `description=`, GL `name=`).
  test(`${providerName}.patSetupUrl (contract): returns an absolute https URL carrying the requested name and comma-joined scopes`, async () => {
    const parsed = new URL(await vcs.patSetupUrl({ host: 'vcs.example.test', name: 'brain', scopes: ['api', 'read_user'] }));
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.searchParams.get('scopes'), 'api,read_user', 'scopes must be comma-joined on both providers');
    assert.ok([...parsed.searchParams.values()].includes('brain'), 'the requested token name must reach the URL — the query KEY differs per provider (GH description=, GL name=), so only the VALUE is compared in the parity loop');
  });

  // ── mrCreate ───────────────────────────────────────────────────────────
  test(`${providerName}.mrCreate (contract): happy fixture returns { url }`, async () => {
    const fixtureName = `${providerName}-mrCreate-happy.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.mrCreate({
      project: 'x/y',
      title: 'T',
      body: 'B',
      head: 'feat/x',
      base: 'main',
      ...mrCreateArgs(fixture),
    });

    assert.equal(typeof result.url, 'string', 'a successful mrCreate must return a string url');
    assert.ok(result.url.length > 0);
    assert.equal(result.error, undefined, 'a successful mrCreate must not carry an error key');
  });

  test(`${providerName}.mrCreate (contract): a create failure returns { url: null, error }, never throws`, async () => {
    const fixtureName = `${providerName}-mrCreate-failure.json`;
    const fixture = loadFixture(fixtureName);
    assertProvenance(fixture, fixtureName);

    const result = await vcs.mrCreate({
      project: 'x/y',
      title: 'T',
      body: 'B',
      head: 'feat/x',
      base: 'main',
      ...mrCreateArgs(fixture),
    });

    assert.equal(result.url, null, 'a failed mrCreate must never fabricate a url');
    assert.equal(typeof result.error, 'string', 'a failed mrCreate must carry an error string');
  });
}

// ── commitStatus/repoCloneUrl/patSetupUrl divergence locks (issue #385, M10
// Phase 2 final Gap-A batch) ─────────────────────────────────────────────────
//
// Standalone, no loop, same precedent as the authCheck/authLogin divergence
// block below (:819-856) and the github.issueList pull_request-filter test
// (:~890). Three latent production defects are LOCKED as current behavior
// here, never fixed — each assertion message says PINNED NOT FIXED and names
// the follow-up issue filed in Phase 6.

// GitHub-only commitStatus mechanics (design D2) — no fixture-driven parity
// test can see these; the payload SHAPE is the assertion.

test('github.commitStatus (contract): an unfinished check reads status, not conclusion — in_progress normalizes to "running"', async () => {
  setSpawn(jsonSpawn({ check_runs: [{ name: 'ci/build', status: 'in_progress', conclusion: null }] }));
  const result = await github.commitStatus({ project: 'x/y', sha: 'cafef00d' });
  assert.equal(
    result,
    'running',
    'github.mjs:225 reads `status` (not `conclusion`) while status !== "completed" — proven here because conclusion is null and only status carries "in_progress"',
  );
});

test('github.commitStatus (contract): a completed check with conclusion neutral or skipped collapses to null — indistinguishable from "no checks ran"', async () => {
  for (const conclusion of ['neutral', 'skipped']) {
    setSpawn(jsonSpawn({ check_runs: [{ name: 'ci/build', status: 'completed', conclusion }] }));
    const result = await github.commitStatus({ project: 'x/y', sha: 'cafef00d' });
    assert.equal(
      result,
      null,
      `a COMPLETED check with conclusion:'${conclusion}' must normalize to null (normalize.mjs:24-25's GITHUB_STATUS_MAP) — the previously-undocumented collapse this batch adds to vcs-contract.md, indistinguishable at the contract boundary from "no checks ran"`,
    );
  }
});

test('commitStatus (contract): selection asymmetry — GitHub takes check_runs[0] client-side, GitLab requests per_page=1 server-side', async () => {
  setSpawn(jsonSpawn({
    check_runs: [
      { name: 'ci/build', status: 'completed', conclusion: 'success' },
      { name: 'ci/lint', status: 'completed', conclusion: 'failure' },
    ],
  }));
  const ghResult = await github.commitStatus({ project: 'x/y', sha: 'cafef00d' });
  assert.equal(
    ghResult,
    'success',
    'github.mjs:221 takes check_runs[0] CLIENT-side — with two entries in the fixture, the FIRST one\'s mapped status must win, never the second',
  );

  let gitlabArgs;
  setSpawn((_cmd, args) => { gitlabArgs = args; return { status: 0, stdout: JSON.stringify([{ status: 'success' }]), stderr: '' }; });
  await gitlab.commitStatus({ project: 'x/y', sha: 'cafef00d' });
  assert.ok(
    gitlabArgs.some(a => String(a).includes('per_page=1')),
    'gitlab.mjs:372 selects a single status SERVER-side via `per_page=1` in the request, not by slicing a larger array client-side',
  );
});

// repoCloneUrl / patSetupUrl — the three locks that USED to freeze latent defects
// (issues #386/#387/#388, filed out of #385's test-only slice and fixed here).
//
// #385 pinned all three as "LATENT DEFECT, PINNED NOT FIXED (follow-up filed)".
// That was the right call for a test-only slice — a test that documents wrong
// behaviour is worth more than no test, PROVIDED the follow-up actually lands.
// These are those follow-ups, so each lock is inverted rather than deleted: the
// same call sites, asserting the corrected behaviour, with the defect they used
// to hold named so the history is not lost.

test('repoCloneUrl (contract): BOTH providers default a falsy host — no URL ever carries the literal "undefined" (#386)', async () => {
  const gh = new URL(await github.repoCloneUrl({ project: 'x/y', token: PLACEHOLDER_CREDENTIAL }));
  assert.equal(gh.host, 'github.com', "github substitutes the literal default (host || 'github.com')");
  assert.equal(gh.username, 'x-access-token', 'the GitHub user literal is x-access-token');

  const gl = new URL(await gitlab.repoCloneUrl({ project: 'x/y', token: PLACEHOLDER_CREDENTIAL }));
  assert.equal(
    gl.host,
    'gitlab.com',
    'FIXED (#386) — this asserted the literal string "undefined" until 2026-08-10. `${host}` had no fallback, '
    + 'so an omitted host produced https://oauth2:***@undefined/x/y.git: a URL that parses, reads plausibly in a '
    + 'log, and resolves to nothing.',
  );
  assert.equal(gl.username, 'oauth2', 'the GitLab user literal is oauth2');
});

test('patSetupUrl (contract): BOTH providers are host-driven — a GHES/self-hosted operator reaches THEIR server (#387)', async () => {
  const gh = new URL(await github.patSetupUrl({ host: 'ghes.example.test', name: 'brain', scopes: ['repo'] }));
  assert.equal(
    gh.host,
    'ghes.example.test',
    'FIXED (#387) — this asserted github.com until 2026-08-10. The verb hardcoded the public host and never read '
    + 'its own `host`, so a GitHub Enterprise Server operator was sent to github.com to create a token that would '
    + 'be useless against their own server, with nothing saying why.',
  );
  assert.equal(gh.pathname, '/settings/tokens/new');
  assert.equal(gh.searchParams.get('description'), 'brain', 'GitHub keys the token name as `description`');

  const gl = new URL(await gitlab.patSetupUrl({ host: 'gitlab.example.test', name: 'brain', scopes: ['api'] }));
  assert.equal(gl.host, 'gitlab.example.test', 'GitLab was already host-driven — that was the divergence');
  assert.equal(gl.pathname, '/-/user_settings/personal_access_tokens');
  assert.equal(gl.searchParams.get('name'), 'brain', 'GitLab keys the token name as `name`');
});

test('patSetupUrl (contract): a falsy host still yields each provider\'s public default — the fix adds a default, it does not demand a host (#387)', async () => {
  assert.equal(new URL(await github.patSetupUrl({ name: 'brain', scopes: ['repo'] })).host, 'github.com');
  assert.equal(new URL(await gitlab.patSetupUrl({ name: 'brain', scopes: ['api'] })).host, 'gitlab.com');
});

test('patSetupUrl (contract): BOTH providers URL-encode the token name — an & no longer splits it into a second parameter (#388)', async () => {
  for (const [label, url] of [
    ['github', await github.patSetupUrl({ host: 'h.example.test', name: 'brain & co', scopes: ['repo'] })],
    ['gitlab', await gitlab.patSetupUrl({ host: 'h.example.test', name: 'brain & co', scopes: ['api'] })],
  ]) {
    const parsed = new URL(url);
    assert.equal(
      parsed.searchParams.has(' co'), false,
      `${label}: FIXED (#388) — this asserted the PRESENCE of a spurious " co" parameter until 2026-08-10.`,
    );
    const name = parsed.searchParams.get('description') ?? parsed.searchParams.get('name');
    assert.equal(
      name, 'brain & co',
      `${label}: the whole name must survive the round trip — a truncated one is what the operator would have saved`,
    );
  }
});

test('patSetupUrl (contract): the comma between scopes stays a SEPARATOR, not encoded data (#388)', async () => {
  // Encoding `scopes.join(',')` as one string would send `repo%2Cworkflow` — a
  // single scope by that literal name. Each entry is encoded; the comma is not.
  for (const [label, url] of [
    ['github', await github.patSetupUrl({ host: 'h.example.test', name: 'n', scopes: ['repo', 'workflow'] })],
    ['gitlab', await gitlab.patSetupUrl({ host: 'h.example.test', name: 'n', scopes: ['api', 'read_user'] })],
  ]) {
    const raw = url.slice(url.indexOf('scopes=') + 'scopes='.length);
    assert.ok(raw.includes(','), `${label}: the separator must reach the provider as a literal comma, got: ${raw}`);
    assert.ok(!raw.includes('%2C'), `${label}: an encoded comma would name one scope instead of two, got: ${raw}`);
  }
});

test('repoCloneUrl (contract): a project slug keeps its slashes and encodes only what sits between them (#388)', async () => {
  // encodeURIComponent(project) would turn `group/repo` into `group%2Frepo` and the
  // clone URL would stop resolving. GitLab subgroups make this concrete.
  const gl = new URL(await gitlab.repoCloneUrl({ host: 'h.example.test', project: 'grupo/sub/repo', token: PLACEHOLDER_CREDENTIAL }));
  assert.equal(gl.pathname, '/grupo/sub/repo.git', 'the separators are structure, not data');

  const gh = new URL(await github.repoCloneUrl({ host: 'h.example.test', project: 'owner/my repo', token: PLACEHOLDER_CREDENTIAL }));
  assert.equal(gh.pathname, '/owner/my%20repo.git', 'and what sits between them IS data');
});

// ── authCheck/authLogin argument-building divergence + token security ──────
// (issues #364/#365, M10 Phase 2 ranks 5-6). Both verbs' fixture-driven
// happy/failure tests live in the main parity loop above (they only vary
// `status`, never call args). These three tests assert on the ARGS the
// mocked `_spawn` actually receives — a real per-provider code divergence
// (D4) that no fixture-driven test can see, since fixtures only vary the
// exit status. Standalone tests (no fixture, no loop), same precedent as the
// `github.issueList` pull_request-filter test directly below.

test('authCheck (contract): host-argument-building divergence — GitHub omits --hostname when host is falsy, GitLab always includes it', async () => {
  let githubArgs;
  setSpawn((_cmd, args) => { githubArgs = args; return { status: 0, stdout: '', stderr: '' }; });
  await github.authCheck({});
  assert.ok(
    !githubArgs.includes('--hostname'),
    'github.mjs#authCheck branches on a falsy host and omits --hostname entirely (github.mjs:20-23)',
  );

  let gitlabArgs;
  setSpawn((_cmd, args) => { gitlabArgs = args; return { status: 0, stdout: '', stderr: '' }; });
  await gitlab.authCheck({});
  assert.ok(
    gitlabArgs.includes('--hostname'),
    'gitlab.mjs#authCheck never branches — it always includes --hostname, even passing the omitted host value through as undefined (gitlab.mjs:22-24)',
  );
});

test('authLogin (contract): host-default divergence — GitHub defaults to github.com when host is omitted, GitLab does not', async () => {
  let githubArgs;
  setSpawn((_cmd, args) => { githubArgs = args; return { status: 0, stdout: '', stderr: '' }; });
  await github.authLogin({ token: 'tok' });
  assert.ok(
    githubArgs.includes('github.com'),
    "github.mjs#authLogin substitutes the literal default 'github.com' when host is omitted (host || 'github.com', github.mjs:25-28)",
  );

  let gitlabArgs;
  setSpawn((_cmd, args) => { gitlabArgs = args; return { status: 0, stdout: '', stderr: '' }; });
  await gitlab.authLogin({ token: 'tok' });
  const hostnameIdx = gitlabArgs.indexOf('--hostname');
  assert.ok(hostnameIdx !== -1, 'gitlab.mjs#authLogin always passes --hostname');
  assert.equal(
    gitlabArgs[hostnameIdx + 1],
    undefined,
    'gitlab.mjs#authLogin does NOT default host — the omitted value is passed through unguarded, unlike GitHub (gitlab.mjs:26-29)',
  );
});

test('authLogin (contract): the token is delivered via stdin on both providers, never via argv', async () => {
  const CREDENTIAL_VALUE = 'sample-cred-9x7';

  let githubArgs, githubOpts;
  setSpawn((_cmd, args, opts) => { githubArgs = args; githubOpts = opts; return { status: 0, stdout: '', stderr: '' }; });
  await github.authLogin({ host: 'github.com', token: CREDENTIAL_VALUE });
  assert.equal(githubOpts.input, CREDENTIAL_VALUE, 'github.mjs#authLogin must deliver the token via opts.input (stdin)');
  assert.ok(!githubArgs.includes(CREDENTIAL_VALUE), 'the token must never appear in the argv array passed to gh — a credential-leak guard');

  let gitlabArgs, gitlabOpts;
  setSpawn((_cmd, args, opts) => { gitlabArgs = args; gitlabOpts = opts; return { status: 0, stdout: '', stderr: '' }; });
  await gitlab.authLogin({ host: 'gitlab.com', token: CREDENTIAL_VALUE });
  assert.equal(gitlabOpts.input, CREDENTIAL_VALUE, 'gitlab.mjs#authLogin must deliver the token via opts.input (stdin)');
  assert.ok(!gitlabArgs.includes(CREDENTIAL_VALUE), 'the token must never appear in the argv array passed to glab — a credential-leak guard');
});

// ── issueList pull_request filter (issue #362, M10 Phase 2 rank-4) ─────────
// GitHub-only: GitLab's `projects/:id/issues` endpoint returns only issues —
// there is nothing to filter, so an `if (providerName === 'github')` branch
// inside the parity loop above would be exactly the provider-asymmetric
// concern that loop exists to prevent (design D2). This follows the file's
// own precedent for asymmetric concerns (BASE_REF_PROVIDERS below,
// prStatusRollup, labelList). The assertion is ARITHMETIC, not a fixture
// spot-check the reader must count by hand: `prCount >= 1` fails loudly if
// the fixture is ever re-recorded from a repo with no open PRs, rather than
// silently degrading into a tautology — this is the one assertion in this
// change that guards the fixture itself, not the normalizer.
test('github.issueList (contract): the pull_request filter is proven arithmetically against the recorded happy fixture', async () => {
  const fixtureName = 'github-issueList-happy.json';
  const fixture = loadFixture(fixtureName);
  assertProvenance(fixture, fixtureName);
  setSpawn(jsonSpawn(fixture.data));

  const result = await github.issueList({ project: 'x/y', state: 'open' });

  const prCount = fixture.data.filter(r => r.pull_request).length;
  assert.ok(prCount >= 1, 'the recorded fixture must contain at least one PR entry — otherwise this test is vacuous');
  assert.equal(
    result.length,
    fixture.data.length - prCount,
    'every PR-carrying entry must be filtered out, and no non-PR entry may be dropped alongside them',
  );
  for (const entry of result) {
    const source = fixture.data.find(r => r.number === entry.number);
    assert.ok(!source.pull_request, 'no PR-carrying source entry may survive the filter');
  }
});

// ── prView baseRefOid (ADR-0022 Decision 1) ─────────────────────────────────
// GH sources it via a SECOND, supplementary `gh api repos/{owner}/{repo}/
// pulls/{n} --jq .base.sha` call — `gh pr view --json` has no baseRefOid
// field. GL reads the already-fetched MR payload's `diff_refs.base_sha`
// (mirrors headRefOid's diff_refs.head_sha; no second request). GitHub's
// mechanism needs a SECOND spawn call returning a raw (not JSON) sha string —
// this doesn't fit the single-fixture `prViewArgs` glue used by the loop
// above (which mocks one uniform response for every spawn/fetch call), so
// these are exercised per-provider, same discipline as the prStatusRollup
// block below.

const BASE_REF_PROVIDERS = {
  github: {
    module: github,
    ok: (baseSha) => {
      setSpawn((_cmd, args) =>
        args[0] === 'pr'
          ? { status: 0, stdout: JSON.stringify({ number: 7, labels: [], body: '', author: null, headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d' }), stderr: '' }
          : { status: 0, stdout: `${baseSha}\n`, stderr: '' }
      );
      return {};
    },
    supplementFails: () => {
      setSpawn((_cmd, args) =>
        args[0] === 'pr'
          ? { status: 0, stdout: JSON.stringify({ number: 7, labels: [], body: '', author: null, headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d' }), stderr: '' }
          : { status: 1, stdout: '', stderr: 'fixture: simulated failure' }
      );
      return {};
    },
  },
  gitlab: {
    module: gitlab,
    ok: (baseSha) => ({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ iid: 7, labels: [], description: '', author: null, diff_refs: { base_sha: baseSha } }),
      }),
    }),
    supplementFails: () => ({
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ iid: 7, labels: [], description: '', author: null }),
      }),
    }),
  },
};

for (const providerName of Object.keys(BASE_REF_PROVIDERS)) {
  const { module: vcs, ok, supplementFails } = BASE_REF_PROVIDERS[providerName];

  test(`${providerName}.prView (contract): a successful fetch normalizes baseRefOid to the API base sha`, async () => {
    const result = await vcs.prView({ project: 'x/y', number: 7, ...ok('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef') });
    assert.equal(result.baseRefOid, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  });

  test(`${providerName}.prView (contract): baseRefOid normalizes to null when uncomputable on an otherwise-successful fetch`, async () => {
    const result = await vcs.prView({ project: 'x/y', number: 7, ...supplementFails() });
    assert.equal(result.baseRefOid, null);
  });
}

// ── prStatusRollup (ADR-0021 Decision 2) — READ-only status-check rollup ────
// One assertion set run over both providers: the normalized shape
// `[{ name, status, conclusion }]` is the contract both must satisfy, even
// though GitHub's checks API and GitLab's commit-statuses model differ
// underneath. Inline mocks (no fixture files) — GitLab's normalization
// requires TWO chained calls (resolve the MR head sha, then fetch that sha's
// statuses), which doesn't fit the single-fixture `{data}|{throws}` shape
// used by the loop above.

const ROLLUP_PROVIDERS = {
  github: {
    module: github,
    ok: (checks) => { setSpawn(jsonSpawn({ statusCheckRollup: checks })); return {}; },
    fail: () => { setSpawn(failSpawn('fixture: simulated failure')); return {}; },
    // A SUCCESSFUL exit (status 0) whose `statusCheckRollup` field is not an
    // array — the structural (non-text) MALFORMED_RESPONSE cause (design
    // §4.3). `null` here is deliberately FALSY: this is what M11 (design §7)
    // targets — a mutation from `!Array.isArray(rollup)` to `!rollup` would
    // fabricate `[]` for exactly this payload instead of naming the cause.
    malformed: () => { setSpawn(jsonSpawn({ statusCheckRollup: null })); return {}; },
  },
  gitlab: {
    module: gitlab,
    ok: (checks) => ({
      fetchImpl: async (url) => (
        url.includes('/merge_requests/')
          ? { ok: true, json: async () => ({ sha: 'cafef00dcafef00dcafef00dcafef00dcafef00d' }) }
          : { ok: true, json: async () => checks.map(c => ({ name: c.name, status: c.status })) }
      ),
    }),
    fail: () => ({ fetchImpl: async () => ({ ok: false, status: 500 }) }),
    // A SUCCESSFUL fetch whose statuses payload is not an array — the
    // structural (non-text) MALFORMED_RESPONSE cause (design §4.3).
    malformed: () => ({
      fetchImpl: async (url) => (
        url.includes('/merge_requests/')
          ? { ok: true, json: async () => ({ sha: 'cafef00dcafef00dcafef00dcafef00dcafef00d' }) }
          : { ok: true, json: async () => ({ not: 'an array' }) }
      ),
    }),
  },
};

for (const providerName of Object.keys(ROLLUP_PROVIDERS)) {
  const { module: vcs, ok, fail, malformed } = ROLLUP_PROVIDERS[providerName];

  test(`${providerName}.prStatusRollup (contract): normalizes to [{ name, status, conclusion }], one entry per check`, async () => {
    const checks = [
      { name: 'issue-link', status: 'completed', conclusion: 'success' },
      { name: 'diff-size', status: 'in_progress', conclusion: null },
    ];
    const result = await vcs.prStatusRollup({ project: 'x/y', number: 1, ...ok(checks) });

    assert.ok(Array.isArray(result), 'prStatusRollup must return an array on a successful fetch');
    assert.ok(result.length >= 1, 'the happy case must exercise at least one check');
    for (const entry of result) {
      assert.equal(typeof entry.name, 'string', 'each entry must carry a normalized name');
      assert.ok('status' in entry, 'each entry must carry a normalized status');
      assert.ok('conclusion' in entry, 'each entry must carry a normalized conclusion key (null is valid)');
    }
  });

  test(`${providerName}.prStatusRollup (contract): a fetch failure yields {uncomputable, reason, detail}, never null and never []`, async () => {
    // issue #606 — the two fixtures legitimately classify DIFFERENTLY
    // (github's invented `fixture: simulated failure` text matches no rule
    // -> `unclassified`; gitlab's `{ok:false, status:500}` ->
    // `GitLab API failed: 500 (...)` -> `network`), so this asserts SHAPE
    // and VERBATIM WORDS only, never a shared `reason` value (design §3.2c).
    const FAILURE_TEXT = { github: 'fixture: simulated failure', gitlab: 'GitLab API failed: 500' };
    const result = await vcs.prStatusRollup({ project: 'x/y', number: 1, ...fail() });
    assert.equal(Array.isArray(result), false, 'a failure must never be a fabricated []');
    assert.notEqual(result, null, 'the cause must not be discarded (#606)');
    assert.equal(result.uncomputable, true);
    assert.ok(Object.isFrozen(result), 'the cause object is frozen');
    assert.ok(UNCOMPUTABLE_REASON_VALUES.includes(result.reason), `reason must be in the enum, got ${result.reason}`);
    assert.ok(result.detail.length > 0, 'detail must never be empty');
    assert.ok(result.detail.includes(FAILURE_TEXT[providerName]),
      "the provider's own words must survive verbatim into detail");
  });

  test(`${providerName}.prStatusRollup (contract): a SUCCESSFUL fetch with a non-array rollup field yields {uncomputable, reason:'malformed-response'}, never a fabricated [] (#606, M11)`, async () => {
    // Distinguishes a genuinely-empty successful rollup ([]) from a
    // successful fetch that could not be READ as a rollup at all — the two
    // must never collapse into the same [] (design §4.3, "the fifth fused
    // cause").
    const result = await vcs.prStatusRollup({ project: 'x/y', number: 1, ...malformed() });
    assert.equal(Array.isArray(result), false, 'a malformed response must never be a fabricated []');
    assert.notEqual(result, null);
    assert.equal(result.uncomputable, true);
    assert.equal(result.reason, 'malformed-response');
    assert.ok(Object.isFrozen(result));
    assert.ok(result.detail.length > 0, 'detail must never be empty');
  });

  test(`${providerName}.prStatusRollup (contract): is READ-only — no write-verb call is reachable from its source`, () => {
    const src = readFileSync(fileURLToPath(new URL(`./adapters/${providerName}.mjs`, import.meta.url)), 'utf8');
    const fnBody = src.slice(src.indexOf('export async function prStatusRollup'));
    const fnEnd = fnBody.indexOf('\nexport ', 1);
    const scoped = fnEnd === -1 ? fnBody : fnBody.slice(0, fnEnd);
    assert.doesNotMatch(scoped, /-X['"]?\s*['"]?POST|-X['"]?\s*['"]?PUT|-X['"]?\s*['"]?DELETE|method:\s*['"](POST|PUT|DELETE)['"]/,
      `${providerName}.prStatusRollup must contain no write HTTP method — it is READ-only (ADR-0021 Decision 2)`);
  });
}

// ── prReviewComment / issueComment / labelAdd / labelRemove (issue #266,
// REQ-266-2) — the four COMMENT-only port verbs. ONE assertion set run over
// both providers, same discipline as the loop above: parity means the same
// test body applies to each provider. Inline mocks (no fixture files) — these
// are simple write verbs and the normalized shapes are the whole contract.

// `rejectInline` (issue #405, REQ-405-4) fakes the ONE failure that matters: the
// provider refuses the inline payload but would accept the summary alone —
// GitHub 422s a comment outside the diff, GitLab rejects a stale `position`.
// The first attempt fails, every attempt after it succeeds, so a verb that
// retries without the anchors gets a url and a verb that gives up gets nothing.
// Captures what the verb actually SENT, so the parity case can assert the
// payload rather than the return value. Without this the "rides the same call"
// test passes against a verb that ignores `comments` entirely — it did, before
// the implementation landed.
// `sent` records POST BODIES; `requests` records every call the verb makes, url
// included. The second one exists because the first is blind by construction
// (cold review of PR #490 round 2, C-2): GitLab's fixture answered the
// `diff_refs` GET before recording anything, so a mutation that made an EMPTY
// `comments` array a different request — one extra provider call, and an
// `inlineDropped: 0` the whole change forbids — left the contract suite green.
// A payload log cannot see a call that carries no payload.
const sent = [];
const requests = [];
function resetLogs() { sent.length = 0; requests.length = 0; }

function capturingSpawn(data) {
  return (_cmd, _args, opts) => {
    requests.push('POST /reviews');
    try { sent.push(JSON.parse(opts?.input ?? '{}')); } catch { sent.push({ unparseable: opts?.input }); }
    return { status: 0, stdout: JSON.stringify(data), stderr: '' };
  };
}

// First call succeeds, every later one dies. Discriminates the ORDER: a verb
// that posts the verdict first survives this; one that posts it last does not.
function dieAfterFirstSpawn(data) {
  let n = 0;
  return () => (n++ === 0
    ? { status: 0, stdout: JSON.stringify(data), stderr: '' }
    : { status: 1, stdout: '', stderr: 'transport died' });
}

// Rejects by SHAPE, not by ordering: any request carrying an anchor fails, any
// request without one succeeds. The first version keyed off call order, which
// silently encoded GitHub's sequence (inline first, retry bare) and would have
// rejected GitLab's SUMMARY — the opposite of what it claims to model. Shape is
// provider-agnostic and is what the real providers actually reject.
// (This paragraph sat on `dieAfterFirstSpawn` above until the round-2 cold review
// noticed — E-4, the orphaned-JSDoc defect recurring in the file that fixed it.)
function rejectAnchoredRequests(data) {
  return (_cmd, _args, opts) => {
    const payload = opts?.input ?? '';
    if (/"comments"|"position"/.test(payload)) {
      return { status: 1, stdout: '', stderr: 'HTTP 422: line must be part of the diff' };
    }
    return { status: 0, stdout: JSON.stringify(data), stderr: '' };
  };
}

const WRITE_VERB_PROVIDERS = {
  github: {
    module: github,
    ok: (data) => { setSpawn(jsonSpawn(data)); return {}; },
    fail: () => { setSpawn(failSpawn('fixture: simulated failure')); return {}; },
    rejectInline: (data) => { setSpawn(rejectAnchoredRequests(data)); return {}; },
    capture: (data) => { resetLogs(); setSpawn(capturingSpawn(data)); return {}; },
    dieAfterFirst: (data) => { setSpawn(dieAfterFirstSpawn(data)); return {}; },
    // A SUCCESSFUL call whose body cannot be read: gh exits 0 with stdout that is
    // not JSON. The provider-specific shape of "unusable" differs; the contract
    // does not.
    unusableBody: () => { setSpawn(() => ({ status: 0, stdout: '', stderr: '' })); return {}; },
    // A failing transport that still LOGS. `fail()` and `capture()` both call
    // setSpawn, so spreading both into one call silently kept the last one and
    // left the request log empty — a call-count assertion over it passed having
    // observed nothing.
    failCapturing: () => {
      resetLogs();
      setSpawn((_cmd, _args, opts) => {
        requests.push('POST /reviews');
        try { sent.push(JSON.parse(opts?.input ?? '{}')); } catch { /* shape not under test here */ }
        return { status: 1, stdout: '', stderr: 'transport failed' };
      });
      return {};
    },
    // Refuses the ANCHORED payload and records EVERY one, so a case can inspect
    // what the fallback sends. `capture` alone always succeeds, so on GitHub the
    // retry never fires and its payload is unobservable — which is how a
    // caller-supplied `event` on the retry survived a whole review round.
    rejectInlineCapturing: (data) => {
      resetLogs();
      setSpawn((_cmd, _args, opts) => {
        const payload = opts?.input ?? '';
        requests.push('POST /reviews');
        try { sent.push(JSON.parse(payload)); } catch { sent.push({ unparseable: payload }); }
        if (/"comments"/.test(payload)) return { status: 1, stdout: '', stderr: 'HTTP 422: line must be part of the diff' };
        return { status: 0, stdout: JSON.stringify(data), stderr: '' };
      });
      return {};
    },
    // The anchored attempt fails for a reason that is NOT inline-specific — a
    // transient gateway error. Every other rejecting fixture in this file emits
    // `HTTP 422`, so the retry's TRIGGER was pinned by nothing: narrowing it to a
    // 422 shape left the suite green and lost the verdict on a 502.
    rejectAnchoredNonInline: (data) => {
      resetLogs();
      setSpawn((_cmd, _args, opts) => {
        const payload = opts?.input ?? '';
        requests.push('POST /reviews');
        try { sent.push(JSON.parse(payload)); } catch { sent.push({ unparseable: payload }); }
        if (/"comments"/.test(payload)) return { status: 1, stdout: '', stderr: 'gh: Bad Gateway (HTTP 502)' };
        return { status: 0, stdout: JSON.stringify(data), stderr: '' };
      });
      return {};
    },
    // First attempt refused for its anchors, RETRY succeeds with an unusable body —
    // the path this change created, and the only one where a parse failure can
    // follow a 422.
    unusableOnRetry: () => {
      let n = 0;
      setSpawn(() => (n++ === 0
        ? { status: 1, stdout: '', stderr: 'HTTP 422: line must be part of the diff' }
        : { status: 0, stdout: '', stderr: '' }));
      return {};
    },
    sentPayloads: () => sent,
  },
  gitlab: {
    module: gitlab,
    ok: (data) => ({ fetchImpl: async () => ({ ok: true, json: async () => data }) }),
    fail: () => ({ fetchImpl: async () => ({ ok: false, status: 500 }) }),
    rejectInlineCapturing: (data) => {
      resetLogs();
      return { fetchImpl: async (url, opts) => {
        requests.push(`${opts?.method ?? 'GET'} ${url.replace(/^.*\/api\/v4\//, '')}`);
        if (/merge_requests\/\d+$/.test(url)) return { ok: true, json: async () => ({ diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' } }) };
        try { sent.push(JSON.parse(opts?.body ?? '{}')); } catch { sent.push({ unparseable: opts?.body }); }
        if (/"position"/.test(opts?.body ?? '')) return { ok: false, status: 400, json: async () => ({ message: 'position is invalid' }) };
        return { ok: true, json: async () => data };
      } };
    },
    // Same input class, GitLab side: the discussion fails with a 500, not a
    // position error. GitLab has no retry, so the property under test is that the
    // DROP COUNT is independent of why the anchor failed — narrowing the catch to
    // 40x/position shapes also left the suite green.
    rejectAnchoredNonInline: (data) => {
      resetLogs();
      return { fetchImpl: async (url, opts) => {
        requests.push(`${opts?.method ?? 'GET'} ${url.replace(/^.*\/api\/v4\//, '')}`);
        if (/merge_requests\/\d+$/.test(url)) return { ok: true, json: async () => ({ diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' } }) };
        try { sent.push(JSON.parse(opts?.body ?? '{}')); } catch { sent.push({ unparseable: opts?.body }); }
        if (/"position"/.test(opts?.body ?? '')) return { ok: false, status: 502, json: async () => ({ message: 'Bad Gateway' }) };
        return { ok: true, json: async () => data };
      } };
    },
    rejectInline: (data) => ({
      fetchImpl: async (url, opts) => {
        // Same shape rule. `diff_refs` reads must still succeed — refusing them
        // would test "the MR is unreadable", a different failure.
        if (/"position"/.test(opts?.body ?? '')) return { ok: false, status: 400, json: async () => ({ message: 'position is invalid' }) };
        if (/merge_requests\/\d+$/.test(url)) return { ok: true, json: async () => ({ diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' } }) };
        return { ok: true, json: async () => data };
      },
    }),
    dieAfterFirst: (data) => {
      let n = 0;
      return { fetchImpl: async () => (n++ === 0
        ? { ok: true, json: async () => data }
        : { ok: false, status: 503 })
      };
    },
    capture: (data) => {
      resetLogs();
      return { fetchImpl: async (url, opts) => {
        // Every request is logged BEFORE any of them is answered — including the
        // `diff_refs` GET, which carries no body and was therefore invisible to
        // the payload log alone.
        requests.push(`${opts?.method ?? 'GET'} ${url.replace(/^.*\/api\/v4\//, '')}`);
        if (/merge_requests\/\d+$/.test(url)) return { ok: true, json: async () => ({ diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' } }) };
        try { sent.push(JSON.parse(opts?.body ?? '{}')); } catch { sent.push({ unparseable: opts?.body }); }
        return { ok: true, json: async () => data };
      } };
    },
    unusableBody: () => ({ fetchImpl: async () => ({ ok: true, json: async () => null }) }),
    failCapturing: () => {
      resetLogs();
      return { fetchImpl: async (url, opts) => {
        requests.push(`${opts?.method ?? 'GET'} ${url.replace(/^.*\/api\/v4\//, '')}`);
        throw new Error('transport failed');
      } };
    },
    // No `unusableOnRetry` here: GitLab has no retry — its summary note goes first
    // and is never re-sent. The retry case therefore lives OUTSIDE the shared loop
    // as a github-only test, rather than being faked into existence for a provider
    // that cannot reach it. (Round 3's version of this comment said the case was
    // "skipped for it", describing a skip that does not exist, and left a dead
    // binding in the loop's destructuring — round-4 cold review, E2: the
    // orphaned-comment defect inside the fix for the orphaned-comment defect.)
    sentPayloads: () => sent,
  },
};

for (const providerName of Object.keys(WRITE_VERB_PROVIDERS)) {
  const { module: vcs, ok, fail, rejectInline, capture, sentPayloads, dieAfterFirst, unusableBody, failCapturing, rejectInlineCapturing, rejectAnchoredNonInline } = WRITE_VERB_PROVIDERS[providerName];
  const requestLog = () => requests;

  test(`${providerName}.prReviewComment (contract): posts event:'COMMENT' (hardcoded), returns { url } on success`, async () => {
    const result = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'verdict',
      ...ok({ html_url: 'https://example.test/x/y/pull/1#review-1', id: 1 }),
    });
    assert.equal(typeof result.url, 'string', 'a successful prReviewComment must return a string url');
    assert.equal(result.error, undefined, 'a successful prReviewComment must not carry an error key');
  });

  test(`${providerName}.prReviewComment (contract): a post failure returns { url: null, error }, never throws`, async () => {
    const result = await vcs.prReviewComment({ project: 'x/y', number: 1, body: 'verdict', ...fail() });
    assert.equal(result.url, null, 'a failed prReviewComment must never fabricate a url');
    assert.equal(typeof result.error, 'string', 'a failed prReviewComment must carry an error string');
  });

  // ── #405 REQ-405-1/-2/-4: the optional inline `comments[]` ────────────────
  //
  // ADR-0020 Amendment 1: `prReviewComment` gains an OPTIONAL `comments` array,
  // carried in the SAME provider call as `body`. Verb count stays four, and
  // `event: 'COMMENT'` stays hardcoded — lock 2 (REQ-266-3) preserved by
  // construction on both providers.
  //
  // Parity is forced HERE (REQ-405-6): the implementations differ by design —
  // GitHub widens one payload, GitLab switches from `notes` to `discussions` and
  // must read `diff_refs` first — so the contract is what makes that asymmetry
  // deliberate rather than accidental. A provider that silently no-ops on
  // `comments` fails this block.

  test(`${providerName}.prReviewComment (contract): comments[] is OPTIONAL — omitting it behaves exactly as before (REQ-405-2)`, async () => {
    const result = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'verdict',
      ...ok({ html_url: 'https://example.test/x/y/pull/1#review-1', id: 1 }),
    });
    assert.equal(typeof result.url, 'string');
    assert.equal(result.inlineDropped, undefined,
      'with no comments requested there is nothing to drop — the key must be ABSENT, not 0. ' +
      '"none requested" and "all dropped" are different answers (evidence-reader-empty-on-failure).');
  });

  test(`${providerName}.prReviewComment (contract): an inline rejection NEVER costs the verdict (REQ-405-4)`, async () => {
    // THE load-bearing case, and the reason it is written before the success
    // path: GitHub 422s a comment targeting a line outside the diff, GitLab
    // rejects a stale position. The summary MUST still post, and the verdict
    // MUST report how many anchors were dropped — without that count, "no inline
    // comments appeared" is indistinguishable from "the anchors would not
    // attach", which is evidence-reader-empty-on-failure relocated into a poster.
    const result = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'verdict',
      comments: [{ path: 'a.mjs', line: 9999, body: 'out of diff' }],
      ...rejectInline({ html_url: 'https://example.test/x/y/pull/1#review-2', id: 2 }),
    });
    assert.equal(typeof result.url, 'string',
      'the summary must have posted anyway — losing the verdict to a cosmetic failure trades a working reviewer for a pretty one');
    assert.equal(result.error, undefined, 'a fallback that succeeded is not an error');
    assert.equal(result.inlineDropped, 1,
      'the count is the reader\'s only way to tell "no anchors" from "the anchors would not attach"');
  });

  test(`${providerName}.prReviewComment (contract): N anchors deliver N comments, each keeping its OWN triple (REQ-405-1)`, async () => {
    // CARDINALITY AND CORRESPONDENCE — the axis round 15 held constant. It varied
    // how many anchors are REFUSED (GitLab partial) and how many are DERIVED (the
    // poster call site). What nothing asserted is how many are DELIVERED, and
    // whether the k-th comment still belongs to the k-th finding: every assertion
    // in the tree that inspects an anchor's CONTENT drove exactly one anchored
    // finding, and the two multi-anchor fixtures assert a projection —
    // `(path, line)` at the poster, `path` alone on GitLab.
    //
    // Six mutations were green because of it (round-16 cold review). The sharp one
    // is a single token on the primary provider:
    //
    //     comments: inline   →   comments: inline.slice(0, 1)
    //
    // Every anchor after the first is discarded and `inlineDropped` stays ABSENT —
    // the run reports a perfectly healthy inline review that delivered one comment
    // out of five. That is REQ-405-4's stated failure mode with the sign flipped:
    // the count does not merely fail to distinguish the two states, it positively
    // asserts nothing was lost.
    //
    // Asserted as the FULL TRIPLE per anchor, in order, rather than a projection —
    // a projection is what let `line` and `body` collapse to the first anchor's on
    // both providers while `path` stayed correct.
    const comments = [
      { path: 'a.mjs', line: 11, body: 'finding ONE' },
      { path: 'b.mjs', line: 22, body: 'finding TWO' },
      { path: 'c.mjs', line: 33, body: 'finding THREE' },
    ];
    const result = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'the verdict block',
      comments,
      ...capture({ html_url: 'https://example.test/x/y/pull/1#review-10', id: 10 }),
    });
    assert.equal(typeof result.url, 'string');
    assert.equal(result.inlineDropped, undefined, 'nothing was refused, so nothing may be reported dropped');

    // Each provider carries the anchor differently — GitHub in one `comments[]`,
    // GitLab as one `position` per discussion — so the triple is read back through
    // a per-provider projection and compared as ONE list.
    const payloads = sentPayloads();
    const delivered = providerName === 'github'
      ? (payloads.find(p => Array.isArray(p.comments))?.comments ?? [])
          .map(c => ({ path: c.path, line: c.line, body: c.body }))
      : payloads.filter(p => p.position)
          .map(p => ({ path: p.position.new_path, line: p.position.new_line, body: p.body }));

    assert.deepEqual(delivered, comments,
      `every anchor must arrive, in order, with its OWN path, line and body — ` +
      `got ${JSON.stringify(delivered)}`);
  });

  test(`${providerName}.prReviewComment (contract): an anchored failure that is NOT inline-specific still saves the verdict and counts the loss (REQ-405-4)`, async () => {
    // The FAILURE had one value class. Round 13 widened the value classes of the
    // finding's `line`; every anchored-rejection fixture in this file still emitted
    // `HTTP 422`, so what an inline failure LOOKS like was never varied — and both
    // providers had a live protection resting on that.
    //
    // GitHub: narrowing the retry's trigger to a 422 shape left all 2579 tests
    // green, and on a transient 502 the verdict was LOST:
    //     unmutated  attempts 2 → { url, inlineDropped: 1 }   verdict posted
    //     mutated    attempts 1 → { url: null, error: 502 }   verdict lost
    // The code comment at the retry names exactly that mutation and says why it was
    // rejected — "gating on a 422-shaped stderr would make a transient failure lose
    // the VERDICT, and REQ-405-4 ranks the verdict above the annotation". Nothing
    // forced it.
    //
    // GitLab has no retry, so the same input class tests the sibling property:
    // the drop count must not depend on WHY the anchor failed. Narrowing that catch
    // to 40x/position shapes was green too.
    const result = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'the verdict block',
      comments: [{ path: 'a.mjs', line: 12, body: 'a perfectly good anchor' }],
      ...rejectAnchoredNonInline({ html_url: 'https://example.test/x/y/pull/1#review-9', id: 9 }),
    });
    assert.equal(typeof result.url, 'string',
      'a transient failure on the anchored attempt must never cost the verdict — REQ-405-4 ranks the ' +
      'verdict above the annotation, and the over-count is the deliberate cheaper error');
    assert.equal(result.error, undefined, 'the verdict landed, so this is not an error result');
    assert.equal(result.inlineDropped, 1,
      'and the anchor is still counted as lost, whatever the reason for the loss');
  });

  test(`${providerName}.prReviewComment (contract): the anchor REACHES the provider, and exactly one payload carries the verdict (REQ-405-1/-5)`, async () => {
    // Asserted on what was SENT, not on what came back. The return-value version
    // of this test passed against a verb that ignored `comments` entirely — a
    // provider must not be able to satisfy the contract by silently no-opping
    // (REQ-405-6).
    //
    // CORRECTED while implementing GitLab. This case first asserted ONE call, and
    // spec REQ-405-5 said inline comments "post in the SAME provider call" —
    // true of GitHub, and structurally impossible on GitLab, where discussions
    // are one-per-position so N anchors mean N+1 calls whatever the order. A
    // contract that only one provider can satisfy is not a contract.
    //
    // The invariant that IS provider-agnostic, and the one D5 actually needs:
    // the anchor reaches the provider, and exactly ONE payload carries the
    // verdict body — so the anti-loop lock, which counts parseable verdicts
    // rather than posts, sees exactly what it sees today.
    const result = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'the verdict block',
      comments: [{ path: 'a.mjs', line: 42, body: 'the evidence a developer reads' }],
      ...capture({ html_url: 'https://example.test/x/y/pull/1#review-3', id: 3 }),
    });
    assert.equal(typeof result.url, 'string');
    assert.equal(result.inlineDropped, undefined, 'nothing was dropped, so no count');

    const payloads = sentPayloads();
    const anchored = payloads.filter(p => p.comments || p.position);
    assert.equal(anchored.length >= 1, true,
      `the anchor must reach the provider, not be dropped: ${JSON.stringify(payloads)}`);
    const anchorText = JSON.stringify(anchored);
    assert.match(anchorText, /a\.mjs/, 'the anchored payload must name the path');
    assert.match(anchorText, /42/, 'and the line');
    // The BODY, in the shared loop (round-7 cold review, finding 1). It was
    // asserted on GitHub only, and incidentally — by an e2e case. Replacing
    // GitLab's `body: c.body` with a constant left all 2574 tests green: every
    // anchor still attaches, `inlineDropped` stays absent, and the run reports a
    // perfectly healthy inline review that says nothing.
    //
    // Substring-scanning `JSON.stringify(anchored)` for the path and the line is
    // exactly the weakness B2 was fixed for one round earlier, surviving one field
    // over on the sibling provider — which is why this assertion is here and not
    // in either provider's own case.
    assert.match(anchorText, /the evidence a developer reads/,
      `the anchored payload must carry the FINDING TEXT, not just its coordinates: ${anchorText}`);

    const verdictCarrying = payloads.filter(p => p.body === 'the verdict block');
    assert.equal(verdictCarrying.length, 1,
      `exactly ONE payload may carry the verdict body — a second parseable verdict is what the ` +
      `anti-loop lock cannot deduplicate (design D5). Got: ${JSON.stringify(payloads)}`);
  });

  test(`${providerName}.prReviewComment (contract): the verdict survives a transport that dies MID-SEQUENCE (REQ-405-4, ordering)`, async () => {
    // The ordering half of REQ-405-4, and it was unpinned until this case: the
    // shape-based rejection fixture cannot tell summary-first from
    // summary-last, because in both orders the bare summary eventually posts.
    //
    // What discriminates is a transport that dies AFTER the first call. On a
    // provider that posts the verdict first, it is already safe. On one that
    // leaves it for last, the verdict is lost and only orphaned annotations
    // remain — which is exactly the outcome REQ-405-4 forbids.
    //
    // (Found because a mutation meant to reverse the order turned out to be
    // inert. The green it produced said nothing; the missing test was real.)
    const result = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'the verdict block',
      comments: [{ path: 'a.mjs', line: 42, body: 'here' }],
      ...dieAfterFirst({ html_url: 'https://example.test/x/y/pull/1#review-4', id: 4 }),
    });
    assert.equal(typeof result.url, 'string',
      'the verdict must already be posted when the transport dies — anything else loses the deliverable ' +
      'and keeps the decoration');
  });

  test(`${providerName}.prReviewComment (contract): comments: [] is the SAME request as omitting it (REQ-405-2)`, async () => {
    // The draft contract row asserts "absent and empty are the same request".
    // It was true and forced by nothing (cold review of PR #490 round 1, E3),
    // and the first repair was forced only on GitHub (round 2, C-2): asserting
    // the BODIES sent is blind to a call that carries none, and on GitLab
    // treating `[]` as a request costs an extra `diff_refs` GET and can return
    // `inlineDropped: 0` — the one value REQ-405-4 forbids.
    //
    // So the two runs are compared as CALL SEQUENCES, which is the only form of
    // the claim that both providers can fail.
    const absent = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'verdict',
      ...capture({ html_url: 'https://example.test/x/y/pull/1#review-5a', id: 51 }),
    });
    const absentCalls = [...requestLog()];
    const absentPayloads = JSON.stringify(sentPayloads());

    const empty = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'verdict',
      comments: [],
      ...capture({ html_url: 'https://example.test/x/y/pull/1#review-5b', id: 52 }),
    });

    assert.equal(typeof empty.url, 'string');
    assert.equal(empty.inlineDropped, undefined, 'an empty request drops nothing — and must never report 0');
    assert.equal(absent.inlineDropped, undefined);
    assert.deepEqual(requestLog(), absentCalls,
      `an empty comments array must make exactly the calls omitting it makes. absent=${JSON.stringify(absentCalls)} empty=${JSON.stringify(requestLog())}`);
    assert.equal(JSON.stringify(sentPayloads()), absentPayloads,
      'and send exactly the same payloads — no empty array forwarded to the provider');
  });

  test(`${providerName}.prReviewComment (contract): a non-array \`comments\` is NOT an inline request (REQ-405-2)`, async () => {
    // `Array.isArray(comments)` is a defensive guard on a line this change added,
    // and nothing pinned it (round-11 cold review, E2): relaxing it to
    // `comments && comments.length > 0` left the whole suite green, after which a
    // string reaches the provider as `comments: "…"` — a malformed request that
    // GitHub 422s and that would then be charged to `inlineDropped` as if the diff
    // were at fault. Pinned rather than removed: an unpinned guard is an invitation
    // to delete it in a refactor and meet the caller that needed it in production.
    const result = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'verdict',
      comments: 'a.mjs:42',                                  // a string has .length
      ...capture({ html_url: 'https://example.test/x/y/pull/1#review-9', id: 9 }),
    });
    assert.equal(typeof result.url, 'string');
    assert.equal(result.inlineDropped, undefined, 'nothing was requested, so nothing was dropped');
    for (const p of sentPayloads()) {
      assert.equal(p.comments, undefined,
        `a non-array comments value must never reach the provider: ${JSON.stringify(p)}`);
      assert.equal(p.position, undefined, `and must produce no discussion: ${JSON.stringify(p)}`);
    }
  });

  test(`${providerName}.prReviewComment (contract): inlineDropped counts what was LOST, it is not a flag (REQ-405-4)`, async () => {
    // Every earlier case used exactly ONE anchor, so a verb that hardcoded
    // `inlineDropped: 1` satisfied the whole suite (cold review of PR #490, C2).
    // The count is the entire mechanism of REQ-405-4 — a reader distinguishes
    // "the anchors would not attach" from "there were none" by its MAGNITUDE.
    const result = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'verdict',
      comments: [
        { path: 'a.mjs', line: 9001, body: 'out of diff' },
        { path: 'b.mjs', line: 9002, body: 'also out' },
        { path: 'c.mjs', line: 9003, body: 'and this one' },
      ],
      ...rejectInline({ html_url: 'https://example.test/x/y/pull/1#review-6', id: 6 }),
    });
    assert.equal(typeof result.url, 'string', 'the verdict still posts');
    assert.equal(result.inlineDropped, 3,
      'three anchors were refused, so three is the honest count — a hardcoded 1 satisfied every other case');
  });

  test(`${providerName}.prReviewComment (contract): a SUCCESS whose body cannot be read returns { url: null, error } — never throws`, async () => {
    // Was a GitLab-only case, added because THIS change shipped exactly this
    // regression on GitLab (round 1, C4: the url derivation moved outside the
    // try). Round 3 found the GitHub twin unpinned on a code path this change
    // created — deleting `parse`'s try/catch left all 2569 tests green, and a
    // throw escapes `postVerdict`, which catches nothing, and kills the run.
    //
    // "Never throws" is normative in vcs-contract.md, in ADR-0020 and in this
    // change's own draft row, so it belongs in the SHARED loop: a guarantee
    // asserted for one provider is a guarantee for one provider.
    const result = await vcs.prReviewComment({ project: 'x/y', number: 1, body: 'verdict', ...unusableBody() });
    assert.equal(result.url, null, 'no url can be derived from a body that cannot be read');
    assert.equal(typeof result.error, 'string', 'and the failure is REPORTED, not raised');
  });

  test(`${providerName}.prReviewComment (contract): a plain post failure costs exactly ONE call — the retry is for anchors only`, async () => {
    // `github.mjs` claims "only reachable when anchors were sent, so a plain post
    // failure costs no extra call", and nothing forced it (round 3, E3): making
    // the retry unconditional left the full suite green, so a regression that
    // re-POSTs the verdict on every transient failure would ship silently — and
    // a first call that landed server-side would then post the verdict twice.
    const result = await vcs.prReviewComment({ project: 'x/y', number: 1, body: 'verdict', ...failCapturing() });
    assert.equal(result.url, null, 'the failure is still reported honestly');
    assert.equal(requestLog().length, 1,
      `a failure with no anchors must be attempted exactly once: ${JSON.stringify(requestLog())}`);
  });

  test(`${providerName}.prReviewComment (contract): lock 2 — a hostile \`event\` argument does not reach the payload (REQ-266-3)`, async () => {
    // The source-scan below cannot see this, and neither could anything else
    // (cold review of PR #490, C3): adding `event = 'COMMENT'` as a parameter and
    // threading it into the payloads left the ENTIRE suite green, after which
    // `prReviewComment({ ..., event: 'APPROVE' })` posts an approval — satisfying
    // main's required-approving-review-count with the reviewer's own token.
    //
    // Lock 2 is stated as "no parameter, flag, or branch selects a different
    // event", so it has to be asserted the way an attacker would reach it: by
    // passing one. This is the guard on the mechanism that keeps the automated
    // reviewer structurally unable to approve a merge, and this change is the
    // first widening of the signature it guards.
    // EVERY payload site, and getting to "every" took two rounds of being wrong
    // about how many there are.
    //
    // `github.prReviewComment` builds THREE `event`-carrying literals: the two
    // branches of the anchored/bare ternary, and the retry. `origin/main` had one;
    // this change created the other two. Round 8 found the guard covering only
    // site 1 (its fixture always succeeded, so the retry never fired) and fixed it
    // to cover 1 and 3 — while asserting "both call sites", because the ternary
    // reads as one. Round 9 found site 2 open, and site 2 is the ONLY one a
    // production run reaches today: no evaluator emits `file`/`line`, so
    // `deriveInlineComments` returns `[]` and `comments` is never sent.
    //
    // Parameterising site 2 alone left all 2575 tests green, after which
    // `prReviewComment({ ..., event: 'APPROVE' })` — no anchors needed — posts an
    // APPROVED review with the reviewer's own token, which satisfies `main`'s
    // required-approving-review-count. It does NOT satisfy L6: that gate counts a
    // non-author, NON-ALLOW-LISTED approval, so lock 3 holds independently — which
    // is what reviewer-protocol §2 promises, and round 8's note claimed otherwise
    // while citing §2 as its authority.
    //
    // So the case drives BOTH shapes and asserts across both. A guard that covers
    // the paths the tests exercise, rather than the paths the verb can take, is
    // measuring the fixtures.
    const anchored = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'verdict',
      event: 'APPROVE', comments: [{ path: 'a.mjs', line: 9999, body: 'out of diff' }],
      ...rejectInlineCapturing({ html_url: 'https://example.test/x/y/pull/1#review-7', id: 7 }),
    });
    assert.equal(typeof anchored.url, 'string', 'the verdict still posts — the fallback is one of the paths under test');
    const anchoredPayloads = [...sentPayloads()];
    assert.ok(anchoredPayloads.length >= 2,
      `the fallback must have been exercised, or the retry site goes uninspected: ${JSON.stringify(anchoredPayloads)}`);

    const bare = await vcs.prReviewComment({
      project: 'x/y', number: 1, body: 'verdict',
      event: 'APPROVE',                                   // no `comments` — the production shape
      ...capture({ html_url: 'https://example.test/x/y/pull/1#review-8', id: 8 }),
    });
    assert.equal(typeof bare.url, 'string');
    const barePayloads = [...sentPayloads()];
    assert.ok(barePayloads.length >= 1, 'the no-anchor path must actually have posted');

    for (const p of [...anchoredPayloads, ...barePayloads]) {
      assert.notEqual(p.event, 'APPROVE', `an approving event reached the wire: ${JSON.stringify(p)}`);
      assert.ok(p.event === undefined || p.event === 'COMMENT',
        `only COMMENT (GitHub) or no event at all (GitLab) may be sent: ${JSON.stringify(p)}`);
    }
  });

  test(`${providerName}.prReviewComment (contract): lock 2 — no APPROVE path exists in the source`, () => {
    const src = readFileSync(fileURLToPath(new URL(`./adapters/${providerName}.mjs`, import.meta.url)), 'utf8');
    const fn = src.slice(src.indexOf('export async function prReviewComment'));
    const end = fn.indexOf('\nexport ', 1);
    const scoped = end === -1 ? fn : fn.slice(0, end);
    assert.doesNotMatch(scoped, /APPROVE|REQUEST_CHANGES/,
      `${providerName}.prReviewComment must contain no approving event, even after the #405 widening (ADR-0020 lock 2)`);
  });

  test(`${providerName}.issueComment (contract): returns { url } on success`, async () => {
    const result = await vcs.issueComment({
      project: 'x/y', number: 1, body: 'ruling',
      ...ok({ html_url: 'https://example.test/x/y/issues/1#comment-1', id: 1 }),
    });
    assert.equal(typeof result.url, 'string', 'a successful issueComment must return a string url');
    assert.equal(result.error, undefined);
  });

  test(`${providerName}.issueComment (contract): a post failure returns { url: null, error }, never throws`, async () => {
    const result = await vcs.issueComment({ project: 'x/y', number: 1, body: 'ruling', ...fail() });
    assert.equal(result.url, null, 'a failed issueComment must never fabricate a url');
    assert.equal(typeof result.error, 'string');
  });

  test(`${providerName}.labelAdd (contract): returns { ok: true } on success`, async () => {
    const result = await vcs.labelAdd({
      project: 'x/y', number: 1, labels: ['seq:1'],
      ...ok({ labels: [{ name: 'seq:1' }] }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined, 'a successful labelAdd must not carry an error key');
  });

  test(`${providerName}.labelAdd (contract): a post failure returns { ok: false, error }, never throws`, async () => {
    const result = await vcs.labelAdd({ project: 'x/y', number: 1, labels: ['seq:1'], ...fail() });
    assert.equal(result.ok, false, 'a failed labelAdd must never fabricate ok:true');
    assert.equal(typeof result.error, 'string');
  });

  test(`${providerName}.labelRemove (contract): returns { ok: true } on success`, async () => {
    const result = await vcs.labelRemove({
      project: 'x/y', number: 1, labels: ['seq:1'],
      ...ok({ labels: [] }),
    });
    assert.equal(result.ok, true);
  });

  test(`${providerName}.labelRemove (contract): a post failure returns { ok: false, error }, never throws`, async () => {
    const result = await vcs.labelRemove({ project: 'x/y', number: 1, labels: ['seq:1'], ...fail() });
    assert.equal(result.ok, false, 'a failed labelRemove must never fabricate ok:true');
    assert.equal(typeof result.error, 'string');
  });
}

test('github.prReviewComment (contract): the RETRY\'s never-throws guard holds too', async () => {
  // The path this change created: first attempt refused for its anchors, retry
  // accepted with a body that cannot be parsed. Deleting the try/catch around
  // the retry's parse left all 2569 tests green (round-3 cold review, C1), and a
  // throw here escapes `postVerdict` — which catches nothing — with the verdict
  // lost and a stack trace in its place.
  const result = await github.prReviewComment({
    project: 'x/y', number: 1, body: 'verdict',
    comments: [{ path: 'a.mjs', line: 1, body: 'x' }],
    ...WRITE_VERB_PROVIDERS.github.unusableOnRetry(),
  });
  assert.equal(result.url, null);
  assert.equal(typeof result.error, 'string', 'reported, not raised — on the retry as much as on the first attempt');
});

// ── #405, GitLab-only: the two halves the shared loop structurally cannot reach.
// GitHub's review is atomic, so it has no `diff_refs` read and no per-anchor
// payload. (A THIRD case lived here until round 3 — the never-throws guard for an
// unusable success body — and it was not GitLab-only at all: GitHub had the
// identical failure mode, unpinned, on a path this change created. It is in the
// shared loop now. A block header that miscounts its own contents is the same
// defect as a comment documenting the function above the one it sits on.)

test('gitlab.prReviewComment (contract): an unreadable diff_refs reports EVERY anchor dropped (REQ-405-4, C1)', async () => {
  // `tasks.md` claimed this was red-proofed. It was not: deleting the count
  // (`if (!refs) return { url };`) left the whole suite green, and so did
  // carrying on with undefined shas. The branch exists because unreadable refs
  // make every anchor un-postable — reported, never silently skipped.
  const attempted = [];
  const result = await gitlab.prReviewComment({
    project: 'x/y', number: 1, body: 'the verdict block',
    comments: [
      { path: 'a.mjs', line: 1, body: 'one' },
      { path: 'b.mjs', line: 2, body: 'two' },
    ],
    fetchImpl: async (url) => {
      // The MR read fails; the notes POST succeeds. Attempts on `discussions`
      // are RECORDED rather than thrown: a throw is indistinguishable from a
      // refused anchor, so the weaker mutation `if (!refs) refs = {}` — carry on
      // and build every position out of undefined shas — produced the same
      // count and stayed green. What separates them is whether the call was made.
      if (/merge_requests\/\d+$/.test(url)) return { ok: false, status: 500 };
      if (/discussions/.test(url)) { attempted.push(url); return { ok: false, status: 400 }; }
      return { ok: true, json: async () => ({ id: 9 }) };
    },
  });
  assert.equal(typeof result.url, 'string', 'the verdict posts regardless — it went first');
  assert.equal(result.inlineDropped, 2,
    'both anchors were un-postable, and the count is what tells a reader that from "there were none"');
  assert.deepEqual(attempted, [],
    'and NOT ONE discussion may be attempted without diff_refs — a position built from undefined shas is a ' +
    'request we already know is malformed, and the resulting drop count would blame the diff for our own defect');
});

test('gitlab.prReviewComment (contract): a PARTIAL refusal counts the refused SUBSET, not all of them (REQ-405-4)', async () => {
  // Round 14 varied WHY an anchor fails (422 → 502) and held constant HOW MANY.
  // Every anchored-rejection fixture in this file refuses ALL anchors or none —
  // and on GitLab `dropped` is a PER-ANCHOR counter, which is the only reason the
  // variable exists (GitHub's is `inline.length` by construction, because its
  // review is atomic). So the counter's arithmetic was pinned by nothing: both
  // `inlineDropped: inline.length` and `dropped = inline.length` survived the full
  // suite (round-15 cold review, C1).
  //
  // The partial case is the DESIGNED one, not an edge: `gitlab.mjs` says an anchor
  // on a context or deleted line "is refused by GitLab and counted by
  // `inlineDropped` — bounded and visible". A review with one anchor on an added
  // line and one on a context line is the likeliest real drop there is, and under
  // either mutation it reports every anchor lost — which is REQ-405-4's own
  // failure mode, since the count is the reader's only way to tell "no anchors"
  // from "the anchors would not attach".
  const attempted = [];
  const result = await gitlab.prReviewComment({
    project: 'x/y', number: 1, body: 'the verdict block',
    comments: [
      { path: 'a.mjs', line: 1, body: 'attaches' },
      { path: 'b.mjs', line: 2, body: 'refused' },
      { path: 'c.mjs', line: 3, body: 'attaches' },
    ],
    fetchImpl: async (url, opts) => {
      if (/merge_requests\/\d+$/.test(url)) {
        return { ok: true, json: async () => ({ diff_refs: { base_sha: 'b', head_sha: 'h', start_sha: 's' } }) };
      }
      if (/discussions/.test(url)) {
        const body = opts?.body ?? '';
        attempted.push(JSON.parse(body).position.new_path);
        // ONE of three refused — a strict, non-empty subset.
        if (/b\.mjs/.test(body)) return { ok: false, status: 400, json: async () => ({ message: 'position is invalid' }) };
        return { ok: true, json: async () => ({ id: 1 }) };
      }
      return { ok: true, json: async () => ({ id: 9 }) };
    },
  });
  assert.deepEqual(attempted, ['a.mjs', 'b.mjs', 'c.mjs'],
    'every anchor must be attempted — a refusal must not abort the ones after it');
  assert.equal(typeof result.url, 'string');
  assert.equal(result.inlineDropped, 1,
    `one of three was refused, so the count is one — not three, and not a flag. ` +
    `Got ${JSON.stringify(result.inlineDropped)}.`);
});

test('gitlab.prReviewComment (contract): a 2xx MR body with NO diff_refs takes the same guard (REQ-405-4)', async () => {
  // The `!refs` guard had one route into it — a MR read that THROWS. A 2xx whose
  // body simply carries no `diff_refs` reaches it too, and nothing drove that
  // (round-13 cold review, B5): fabricating shas on that path left the suite green.
  // Round 3's C1 was this same input class on the notes POST, found and moved into
  // the shared loop; this is the other read #405 added, and the class did not
  // follow it here.
  const attempted = [];
  const result = await gitlab.prReviewComment({
    project: 'x/y', number: 1, body: 'the verdict block',
    comments: [
      { path: 'a.mjs', line: 1, body: 'one' },
      { path: 'b.mjs', line: 2, body: 'two' },
    ],
    fetchImpl: async (url) => {
      // 200, valid JSON, no diff_refs — the shape a partial or unusual MR payload has.
      if (/merge_requests\/\d+$/.test(url)) return { ok: true, json: async () => ({ iid: 1 }) };
      if (/discussions/.test(url)) { attempted.push(url); return { ok: false, status: 400 }; }
      return { ok: true, json: async () => ({ id: 9 }) };
    },
  });
  assert.equal(typeof result.url, 'string', 'the verdict posts regardless — it went first');
  assert.equal(result.inlineDropped, 2, 'both anchors un-postable, and counted');
  assert.deepEqual(attempted, [],
    'and NOT ONE discussion attempted — a position built from fabricated shas is a request ' +
    'we already know is malformed, and its refusal would be charged to the diff');
});

test('gitlab.prReviewComment (contract): the discussion position carries the FULL text-position shape (REQ-405-1, B2)', async () => {
  // The only prior assertion on this payload was a substring scan of
  // `JSON.stringify(...)` for the path and the line — satisfied by `new_path`
  // alone. Reducing the position to `{ new_path, new_line }`, deleting
  // `position_type` and all three shas along with the entire justification for
  // the extra `diff_refs` GET, left the suite green.
  //
  // That matters more than coverage hygiene: if the anchor shape is wrong, every
  // discussion 400s, `dropped` equals `inline.length`, and the run reports a
  // plausible-looking count while GitLab inline review has never once worked.
  const posted = [];
  await gitlab.prReviewComment({
    project: 'x/y', number: 1, body: 'the verdict block',
    comments: [{ path: 'a.mjs', line: 42, body: 'here' }],
    fetchImpl: async (url, opts) => {
      if (/merge_requests\/\d+$/.test(url)) {
        return { ok: true, json: async () => ({ diff_refs: { base_sha: 'BASE', head_sha: 'HEAD', start_sha: 'START' } }) };
      }
      if (/discussions/.test(url)) posted.push(JSON.parse(opts?.body ?? '{}'));
      return { ok: true, json: async () => ({ id: 9 }) };
    },
  });
  assert.equal(posted.length, 1, 'one anchor, one discussion');
  assert.deepEqual(posted[0].position, {
    position_type: 'text',
    new_path: 'a.mjs',
    old_path: 'a.mjs',
    new_line: 42,
    base_sha: 'BASE',
    head_sha: 'HEAD',
    start_sha: 'START',
  }, 'GitLab requires position_type, BOTH paths and all three shas on a text position — ' +
     'asserted key-by-key, because a substring scan for the path passed against a position missing everything else');
});

// ── labelList (issue #334, vcs-label-preflight contract) — inline mocks, no
// fixture files: a simple normalized READ verb, same precedent as
// labelAdd/prStatusRollup. `({ project }) -> string[]` — MAY throw like its
// siblings (labelPreflight, not this verb, is the total/never-throws layer —
// design A1). Pagination is exercised explicitly: a repo with >30/>100 labels
// must not silently drop real labels and false-reject a valid ship.

const LABEL_LIST_PROVIDERS = {
  github: {
    module: github,
    ok: (names) => { setSpawn(jsonSpawn(names.map(name => ({ name, color: 'ededed', description: '' })))); return {}; },
    fail: () => { setSpawn(failSpawn('fixture: simulated failure')); return {}; },
  },
  gitlab: {
    module: gitlab,
    ok: (names) => ({
      fetchImpl: async () => ({ ok: true, json: async () => names.map(name => ({ name, color: '#ededed', description: '' })) }),
    }),
    fail: () => ({ fetchImpl: async () => ({ ok: false, status: 500 }) }),
  },
};

for (const providerName of Object.keys(LABEL_LIST_PROVIDERS)) {
  const { module: vcs, ok, fail } = LABEL_LIST_PROVIDERS[providerName];

  test(`${providerName}.labelList (contract): normalizes to an array of bare label name strings`, async () => {
    const result = await vcs.labelList({ project: 'x/y', ...ok(['type:bug', 'type:feature', 'status:approved']) });
    assert.ok(Array.isArray(result), 'labelList must return an array');
    assert.deepEqual([...result].sort(), ['status:approved', 'type:bug', 'type:feature']);
    for (const name of result) assert.equal(typeof name, 'string', 'each entry must be a bare label name string');
  });

  test(`${providerName}.labelList (contract): names pass through verbatim — no case-folding`, async () => {
    const result = await vcs.labelList({ project: 'x/y', ...ok(['Type:Bug']) });
    assert.deepEqual(result, ['Type:Bug']);
  });

  test(`${providerName}.labelList (contract): a fetch failure throws (this verb is a normalized READ, not the total policy layer)`, async () => {
    await assert.rejects(() => vcs.labelList({ project: 'x/y', ...fail() }));
  });
}

test('github.labelList (contract): uses `gh api --paginate` — a many-page label set must not be silently truncated', async () => {
  let capturedArgs;
  setSpawn((_cmd, args) => {
    capturedArgs = args;
    return { status: 0, stdout: JSON.stringify([{ name: 'type:bug' }]), stderr: '' };
  });
  await github.labelList({ project: 'x/y' });
  assert.ok(capturedArgs.includes('--paginate'), 'github.labelList must call `gh api --paginate` — a single unpaginated page can silently drop real labels on a >30-label repo');
});

test('gitlab.labelList (contract): paginates until a short page — a many-page label set must not be silently truncated', async () => {
  let callCount = 0;
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }));
  const shortPage = [{ name: 'type:bug' }];
  const result = await gitlab.labelList({
    project: 'x/y',
    fetchImpl: async () => {
      callCount += 1;
      return { ok: true, json: async () => (callCount === 1 ? fullPage : shortPage) };
    },
  });
  assert.equal(callCount, 2, 'gitlab.labelList must fetch a second page when the first page is full (per_page-sized)');
  assert.ok(result.includes('type:bug'), 'labels from a later page must be included, never dropped');
});

// ── branchProtect (M10 Phase 2, issue #335 rank 2) — mutating write verb.
// `({ project, branch?, checks, requiredReviews? }) -> { enforced: boolean,
// reason?: string, remedy?: string }`. Both providers' impls call `run()`
// from the SAME shared spawn seam (github via `gh`, gitlab via `glab`), so
// ONE setSpawn-based glue serves both providers — unlike WRITE_VERB_PROVIDERS,
// no gitlab `fetchImpl` branch is needed here (design D2). `checks` is always
// supplied, even on the failure path: `github.branchProtect` does
// `checks.map()` with no default and THROWS on `undefined` — omitting it
// would fail the never-throws test for the wrong reason (an unhandled
// TypeError building the request payload, not the branchProtect contract).
// `reason`/`remedy` vocabulary legitimately differs per provider ('tier' is
// GitHub-only; 'auth'/'permission' are GitLab-only) — only type/presence is
// asserted here, never exact-string equality across providers (design D4).

const BRANCH_PROTECT_PROVIDERS = {
  github: {
    module: github,
    ok: (checks) => { setSpawn(rawSpawn('', 0)); return { checks }; },
    // Trips github.mjs's `r.stderr.includes('403') || /upgrade.*pro/i.test(r.stderr)` tier-block branch.
    fail: (checks) => { setSpawn(failSpawn('403: upgrade to GitHub Pro for private-repo branch protection')); return { checks }; },
  },
  gitlab: {
    module: gitlab,
    ok: (checks) => { setSpawn(rawSpawn('', 0)); return { checks }; },
    // Trips gitlab.mjs's `r.stderr.includes(': 403') || /forbidden/i.test(r.stderr)` permission-block branch.
    fail: (checks) => { setSpawn(failSpawn('glab: 403 Forbidden')); return { checks }; },
  },
};

for (const providerName of Object.keys(BRANCH_PROTECT_PROVIDERS)) {
  const { module: vcs, ok, fail } = BRANCH_PROTECT_PROVIDERS[providerName];

  test(`${providerName}.branchProtect (contract): a successful protect returns the contract shape, and only it`, async () => {
    const result = await vcs.branchProtect({ project: 'x/y', ...ok(['ci']) });
    // PARITY IS THE CONTRACT, NOT THE ANSWER (#348). This assertion used to
    // demand `deepEqual({ enforced: true })` from both providers — and that is
    // the one thing they must NOT agree on, because they did different work:
    // GitHub applies `required_approving_review_count`, GitLab does not and
    // now says so. Forcing identical objects would force GitLab to hide the
    // difference, which is exactly what #348 ruled against.
    assert.equal(result.enforced, true);
    const allowed = ['enforced', 'reason', 'remedy'];
    assert.deepEqual(
      Object.keys(result).filter((k) => !allowed.includes(k)),
      [],
      'no enabled/rules leakage into the contract shape — the shape is shared even where the answer is not',
    );
  });

  test(`${providerName}.branchProtect (#348): the result says what was NOT applied, or says nothing`, async () => {
    const asked = await vcs.branchProtect({ project: 'x/y', requiredReviews: 1, ...ok(['ci']) });
    const silent = await vcs.branchProtect({ project: 'x/y', requiredReviews: 0, ...ok(['ci']) });
    assert.equal(silent.reason, undefined,
      'at requiredReviews 0 — the lite tier value — there is nothing unapplied to announce');
    if (asked.reason) {
      assert.match(asked.reason, /NOT applied|UNKNOWN/,
        'a provider that could not apply the count names it rather than returning a bare success');
    }
  });

  test(`${providerName}.branchProtect (contract): a protect failure returns { enforced: false, reason, remedy } — never throws`, async () => {
    const result = await vcs.branchProtect({ project: 'x/y', ...fail(['ci']) });
    assert.equal(result.enforced, false, 'a failed branchProtect must never fabricate enforced:true');
    assert.deepEqual(Object.keys(result).sort(), ['enforced', 'reason', 'remedy'].sort(), 'a failed branchProtect must return exactly these three keys — no enabled/rules/requiredReviews leakage into the contract shape');
    assert.equal(typeof result.reason, 'string', 'reason must be a string — vocabulary is provider-specific, asserted in providers.test.mjs, not here');
    assert.equal(typeof result.remedy, 'string', 'remedy must be a string — presence/type only, never compared across providers');
  });

  test(`${providerName}.branchProtect (contract): never throws, even under a mocked transport failure`, async () => {
    await assert.doesNotReject(
      () => vcs.branchProtect({ project: 'x/y', ...fail(['ci']) }),
      `${providerName}.branchProtect must resolve, not throw, on a mocked transport failure`,
    );
  });
}

// ── mrAutoMerge (issue #886, design.md) — mutating write verb. `({ project,
// number, requiredReviews?, apiBase?, token?, proxyUrl?, fetchImpl? }) ->
// {enabled:true,url}|{enabled:false,reason}|{enabled:false,reason,error}`.
// GitHub via the `gh` spawn seam (setSpawn); GitLab via the injected
// `fetchImpl`. The refusal (`requiredReviews !== 0`) is the FIRST statement in
// both implementations (design A4) — proved with a COUNTING seam, never a
// throwing one: a throwing seam would fail the never-throws test for the
// wrong reason (design A4's own trap note).

/** A github spawn glue that counts calls instead of answering — proves the
 * tier refusal never reaches `gh` (design A4). */
function countingFailSpawn() {
  const state = { calls: 0 };
  const seam = () => { state.calls += 1; return { status: 1, stdout: '', stderr: 'seam must not be called' }; };
  return { state, seam };
}

const MR_AUTO_MERGE_PROVIDERS = {
  github: {
    module: github,
    // `gh pr merge --auto` prints a human confirmation line, not a URL (A2) —
    // stdout content is irrelevant, `url` is unconditionally `null`.
    armedArgs: () => { setSpawn(rawSpawn('✓ Auto-merge enabled for pull request #1\n', 0)); return {}; },
    unsupportedArgs: () => {
      const fixtureName = 'github-mrAutoMerge-unsupported.json';
      const fixture = loadFixture(fixtureName);
      assertProvenance(fixture, fixtureName);
      setSpawn(failSpawn(fixture.stderr));
      return { fixture };
    },
    transportArgs: () => { setSpawn(failSpawn('HTTP 500: Internal Server Error')); return {}; },
    countingArgs: () => {
      const { state, seam } = countingFailSpawn();
      setSpawn(seam);
      return { args: {}, state };
    },
    // Correction 4: the `gh` seam itself THROWS (not a failing spawn
    // result) — e.g. a launch failure the wrapper re-throws instead of
    // returning. `axes/vcs/adapters/github.mjs#mrAutoMerge` had no try/catch around
    // the `gh()` call, so this used to reject the promise instead of
    // classifying to `transport`.
    throwingArgs: () => { setSpawn(() => { throw new Error('gh: spawn EACCES'); }); return {}; },
  },
  gitlab: {
    module: gitlab,
    armedArgs: () => ({ fetchImpl: async () => ({ ok: true, json: async () => ({ web_url: 'https://gitlab.test/x/y/-/merge_requests/1' }) }) }),
    unsupportedArgs: (status = 405) => ({ fetchImpl: async () => ({ ok: false, status }) }),
    transportArgs: () => ({ fetchImpl: async () => ({ ok: false, status: 500 }) }),
    countingArgs: () => {
      const state = { calls: 0 };
      const fetchImpl = async () => { state.calls += 1; return { ok: false, status: 500 }; };
      return { args: { fetchImpl }, state };
    },
    // Correction 4: `fetchImpl` REJECTS with an Error, the well-behaved
    // case — `err.message` reading is safe. The string/null-rejection edge
    // cases (`err.message` throwing a TypeError on `null`) are pinned by
    // dedicated standalone tests below, since they need per-case shapes a
    // shared loop test cannot express.
    throwingArgs: () => ({ fetchImpl: async () => { throw new Error('network exploded'); } }),
  },
};

for (const providerName of Object.keys(MR_AUTO_MERGE_PROVIDERS)) {
  const { module: vcs, armedArgs, transportArgs, countingArgs, throwingArgs } = MR_AUTO_MERGE_PROVIDERS[providerName];

  test(`${providerName}.mrAutoMerge (contract): an omitted requiredReviews refuses`, async () => {
    const result = await vcs.mrAutoMerge({ project: 'x/y', number: 1 });
    assert.deepEqual(result, { enabled: false, reason: 'requires-human-approval' });
  });

  test(`${providerName}.mrAutoMerge (contract): requiredReviews>0 refuses, provider seam UNCALLED`, async () => {
    const { args, state } = countingArgs();
    const result = await vcs.mrAutoMerge({ project: 'x/y', number: 1, requiredReviews: 1, ...args });
    assert.deepEqual(result, { enabled: false, reason: 'requires-human-approval' });
    assert.equal(state.calls, 0, 'the provider seam must never be touched when the tier refuses');
  });

  // Cold-review blocker 1: only the NUMBER 0 may arm. `requiredReviews > 0`
  // is false for null/NaN/-1 too, so a naive predicate ARMS on all three —
  // a fail-open gate on a mutating write verb. The fix is `!== 0`, the only
  // permission is exact-zero. `'0'` (a string) is included to pin that
  // strict equality, not loose coercion, decides the gate.
  test(`${providerName}.mrAutoMerge (contract): only requiredReviews===0 arms — null/NaN/-1/"0" all refuse, seam UNCALLED`, async () => {
    for (const requiredReviews of [null, NaN, -1, '0']) {
      const { args, state } = countingArgs();
      const result = await vcs.mrAutoMerge({ project: 'x/y', number: 1, requiredReviews, ...args });
      assert.deepEqual(
        result,
        { enabled: false, reason: 'requires-human-approval' },
        `requiredReviews=${String(requiredReviews)} must refuse — only the number 0 may arm`,
      );
      assert.equal(state.calls, 0, `requiredReviews=${String(requiredReviews)} must never touch the provider seam`);
    }
  });

  test(`${providerName}.mrAutoMerge (contract): armed shape carries no merged/sha field`, async () => {
    const result = await vcs.mrAutoMerge({ project: 'x/y', number: 1, requiredReviews: 0, ...armedArgs() });
    assert.equal(result.enabled, true);
    assert.deepEqual(Object.keys(result).sort(), ['enabled', 'url'], 'armed must carry exactly enabled+url — no merged, no sha');
  });

  test(`${providerName}.mrAutoMerge (contract): network/5xx/401/403 → transport, carries error`, async () => {
    const result = await vcs.mrAutoMerge({ project: 'x/y', number: 1, requiredReviews: 0, ...transportArgs() });
    assert.equal(result.enabled, false);
    assert.equal(result.reason, 'transport');
    assert.ok(AUTO_MERGE_REASON_VALUES.includes(result.reason), 'reason must be a member of the closed AUTO_MERGE_REASONS vocabulary (editorial 6)');
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(Object.keys(result).sort(), ['enabled', 'error', 'reason']);
  });

  test(`${providerName}.mrAutoMerge (contract): outcome key set is pinned, exactly`, async () => {
    const tier = await vcs.mrAutoMerge({ project: 'x/y', number: 1 });
    assert.deepEqual(Object.keys(tier).sort(), ['enabled', 'reason']);
    assert.ok(AUTO_MERGE_REASON_VALUES.includes(tier.reason), 'reason must be a member of the closed AUTO_MERGE_REASONS vocabulary (editorial 6)');
    const ok = await vcs.mrAutoMerge({ project: 'x/y', number: 1, requiredReviews: 0, ...armedArgs() });
    assert.deepEqual(Object.keys(ok).sort(), ['enabled', 'url']);
    const bad = await vcs.mrAutoMerge({ project: 'x/y', number: 1, requiredReviews: 0, ...transportArgs() });
    assert.deepEqual(Object.keys(bad).sort(), ['enabled', 'error', 'reason']);
    assert.ok(AUTO_MERGE_REASON_VALUES.includes(bad.reason), 'reason must be a member of the closed AUTO_MERGE_REASONS vocabulary (editorial 6)');
  });

  test(`${providerName}.mrAutoMerge (contract): never throws, even under a mocked transport failure`, async () => {
    await assert.doesNotReject(
      () => vcs.mrAutoMerge({ project: 'x/y', number: 1, requiredReviews: 0, ...transportArgs() }),
      `${providerName}.mrAutoMerge must resolve, not throw, on a mocked transport failure`,
    );
  });

  // Correction 4: the prior "never throws" case reused `transportArgs()` —
  // a non-throwing FAILING RESULT — which duplicates the assertions of
  // "network/5xx/401/403 → transport, carries error" above without ever
  // exercising a seam that actually throws. This is the real case: the
  // provider seam itself THROWS synchronously (a launch failure the
  // wrapper re-raises, or any other exception), never a returned failure
  // object.
  test(`${providerName}.mrAutoMerge (contract): never throws — not even when the provider seam itself throws`, async () => {
    const result = await vcs.mrAutoMerge({ project: 'x/y', number: 1, requiredReviews: 0, ...throwingArgs() });
    assert.equal(result.enabled, false);
    assert.equal(result.reason, 'transport', 'a thrown seam must still classify as transport, never crash the caller');
    assert.ok(AUTO_MERGE_REASON_VALUES.includes(result.reason), 'reason must be a member of the closed AUTO_MERGE_REASONS vocabulary (editorial 6)');
    assert.equal(typeof result.error, 'string');
    assert.deepEqual(Object.keys(result).sort(), ['enabled', 'error', 'reason']);
  });
}

test('github.mrAutoMerge (contract): armed → {enabled:true,url} via gh pr merge --auto --squash', async () => {
  setSpawn(rawSpawn('✓ Auto-merge enabled for pull request #1\n', 0));
  const result = await github.mrAutoMerge({ project: 'x/y', number: 1, requiredReviews: 0 });
  assert.deepEqual(result, { enabled: true, url: null }, 'GitHub never parses stdout for a URL (design A2)');
});

test('gitlab.mrAutoMerge (contract): armed → {enabled:true,url} via PUT .../merge, pipeline+squash', async () => {
  const result = await gitlab.mrAutoMerge({
    project: 'x/y', number: 1, requiredReviews: 0,
    fetchImpl: async () => ({ ok: true, json: async () => ({ web_url: 'https://gitlab.test/x/y/-/merge_requests/1' }) }),
  });
  assert.deepEqual(result, { enabled: true, url: 'https://gitlab.test/x/y/-/merge_requests/1' });
});

test('gitlab.mrAutoMerge (contract): url is null when the provider reports none', async () => {
  const result = await gitlab.mrAutoMerge({
    project: 'x/y', number: 1, requiredReviews: 0,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  assert.deepEqual(result, { enabled: true, url: null });
});

// Correction 4: `axes/vcs/adapters/gitlab.mjs#mrAutoMerge` assumed the thrown value
// was an `Error`. A `fetchImpl` rejecting with a bare STRING left `error`
// undefined (`err.message` is `undefined` on a string) — breaking the
// pinned `['enabled','error','reason']` transport key set. A `fetchImpl`
// rejecting with `null` threw a `TypeError` reading `.message` off `null`,
// which propagated out and broke the never-throws contract outright.
test('gitlab.mrAutoMerge (contract): a fetchImpl that rejects with a bare string still classifies as transport, key set pinned', async () => {
  const result = await gitlab.mrAutoMerge({
    project: 'x/y', number: 1, requiredReviews: 0,
    fetchImpl: async () => { throw 'network exploded'; },
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'transport');
  assert.ok(AUTO_MERGE_REASON_VALUES.includes(result.reason), 'reason must be a member of the closed AUTO_MERGE_REASONS vocabulary (editorial 6)');
  assert.equal(typeof result.error, 'string', 'error must be a string even when the rejection value was not an Error');
  assert.deepEqual(Object.keys(result).sort(), ['enabled', 'error', 'reason']);
});

test('gitlab.mrAutoMerge (contract): a fetchImpl that rejects with null never throws a TypeError reading .message', async () => {
  const result = await gitlab.mrAutoMerge({
    project: 'x/y', number: 1, requiredReviews: 0,
    fetchImpl: async () => { throw null; },
  });
  assert.equal(result.enabled, false);
  assert.equal(result.reason, 'transport');
  assert.ok(AUTO_MERGE_REASON_VALUES.includes(result.reason), 'reason must be a member of the closed AUTO_MERGE_REASONS vocabulary (editorial 6)');
  assert.equal(typeof result.error, 'string');
  assert.deepEqual(Object.keys(result).sort(), ['enabled', 'error', 'reason']);
});

// Task 2.1's live capture landed 2026-09-09 against this change's own PR
// (#895, csrinaldi/brain, allow_auto_merge:false): `gh pr merge 895 --auto
// --squash --repo csrinaldi/brain` → GraphQL: Auto merge is not allowed for
// this repository (enablePullRequestAutoMerge). The fixture now ships
// recorded:true with that verbatim stderr — see
// fixtures/github-mrAutoMerge-unsupported.json. The `_provenance.recorded`
// assertion below stays as the gate against any future regression back to a
// placeholder/derived fixture (correction 3).
test('github.mrAutoMerge (contract): captured "auto-merge not allowed" stderr → unsupported', async () => {
  const { fixture } = MR_AUTO_MERGE_PROVIDERS.github.unsupportedArgs();
  assert.equal(fixture._provenance.recorded, true, 'the unsupported class must come from a live capture (design A5)');
  const result = await github.mrAutoMerge({ project: 'x/y', number: 1, requiredReviews: 0 });
  assert.deepEqual(result, { enabled: false, reason: 'unsupported', error: fixture.stderr });
  assert.ok(AUTO_MERGE_REASON_VALUES.includes(result.reason), 'reason must be a member of the closed AUTO_MERGE_REASONS vocabulary (editorial 6)');
});

test('gitlab.mrAutoMerge (contract): 405/406 merge response → unsupported', async () => {
  for (const status of [405, 406]) {
    const result = await gitlab.mrAutoMerge({
      project: 'x/y', number: 1, requiredReviews: 0,
      ...MR_AUTO_MERGE_PROVIDERS.gitlab.unsupportedArgs(status),
    });
    assert.equal(result.enabled, false, `status ${status} must classify unsupported`);
    assert.equal(result.reason, 'unsupported');
    assert.ok(AUTO_MERGE_REASON_VALUES.includes(result.reason), 'reason must be a member of the closed AUTO_MERGE_REASONS vocabulary (editorial 6)');
    assert.match(result.error, new RegExp(`API failed: ${status}`));
  }
});

// ── rerunWorkflowRun (GitHub-only, issue #328) ──────────────────────────────
// No GitLab equivalent is implemented (deliberately out of scope) — this verb
// is absent from cli.mjs's VERBS array on purpose (that array is reserved for
// verbs BOTH providers implement, enforced by verb-contract-drift-guard's
// "every function exported by BOTH REAL providers" check; since gitlab.mjs
// has no sibling export, this verb never trips it). GitHub-only, hence no
// parity loop over PROVIDERS — a single direct suite against `github.mjs`,
// same precedent as the `github.issueList` pull_request-filter test and the
// `github.labelList --paginate` test above (both GitHub-only, both outside
// the shared loop).

test('github.rerunWorkflowRun (contract): picks the newest run matching the target workflow path and POSTs a FULL rerun (never rerun-failed-jobs)', async () => {
  const fixtureName = 'github-rerunWorkflowRun-happy.json';
  const fixture = loadFixture(fixtureName);
  assertProvenance(fixture, fixtureName);

  const calls = [];
  setSpawn((_cmd, args) => {
    calls.push(args);
    if (args.includes('-X')) return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: JSON.stringify(fixture.data), stderr: '' };
  });

  const result = await github.rerunWorkflowRun({ project: 'x/y', ref: 'fix/issue-328-x', workflow: 'governance.yml' });

  assert.deepEqual(
    result,
    { ok: true, runId: 55500 },
    'must pick the newest governance.yml run (55500) — never the non-matching release.yml run (55501) above it, nor the older governance.yml run (55499) below it',
  );

  const rerunCall = calls.find(a => a.includes('-X'));
  assert.ok(rerunCall, 'a rerun API call must have been made');
  assert.ok(
    rerunCall.some(a => /\/actions\/runs\/55500\/rerun$/.test(a)),
    'must POST to the FULL rerun endpoint for the matched run (55500)',
  );
  assert.ok(
    !rerunCall.some(a => /rerun-failed-jobs/.test(a)),
    'must NEVER call rerun-failed-jobs — that silently skips an already-green job stuck on stale evidence, the exact stale-GREEN bug this verb exists to fix (issue #328)',
  );
});

test('github.rerunWorkflowRun (contract): no run matches the target workflow — returns { ok: false, reason }, never throws', async () => {
  const fixtureName = 'github-rerunWorkflowRun-empty.json';
  const fixture = loadFixture(fixtureName);
  assertProvenance(fixture, fixtureName);
  setSpawn(jsonSpawn(fixture.data));

  const result = await github.rerunWorkflowRun({ project: 'x/y', ref: 'fix/issue-328-x', workflow: 'governance.yml' });
  assert.equal(result.ok, false, 'no matching run must never fabricate ok:true');
  assert.equal(typeof result.reason, 'string', 'must carry a reason string');
});

test('github.rerunWorkflowRun (contract): a list-runs API failure returns { ok: false, reason }, never throws', async () => {
  setSpawn(failSpawn('fixture: simulated failure'));
  const result = await github.rerunWorkflowRun({ project: 'x/y', ref: 'fix/issue-328-x' });
  assert.equal(result.ok, false, 'a transport failure must never fabricate ok:true');
  assert.equal(typeof result.reason, 'string', 'must carry a reason string');
});

// ── REQ-266-3 (lock 2): no code path can emit an APPROVE review, on any provider ──

test('REQ-266-3 lock 2: github.prReviewComment sends event:\'COMMENT\' to the API regardless of input — no argument selects a different event', async () => {
  let sentPayload;
  setSpawn((_cmd, _args, opts) => {
    sentPayload = JSON.parse(opts.input);
    return { status: 0, stdout: JSON.stringify({ html_url: 'https://example.test/x/y/pull/1#review-1' }), stderr: '' };
  });
  await github.prReviewComment({ project: 'x/y', number: 1, body: 'anything, even an approval-sounding body' });
  assert.equal(sentPayload.event, 'COMMENT', 'the review event sent to the API must always be COMMENT, never derived from input');
});

test('REQ-266-3 lock 2: no exported verb on either provider references an approval review-event literal — source scan', () => {
  for (const modName of ['github.mjs', 'gitlab.mjs']) {
    const src = readFileSync(fileURLToPath(new URL(`./adapters/${modName}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(
      src,
      /event\s*:\s*['"](?!COMMENT['"])[A-Z_]+['"]/,
      `${modName} must not contain any review "event:" literal other than 'COMMENT' — no code path may reach an approval event`,
    );
  }
});

// ── branchProtect requiredReviews no-op (M10 Phase 2, design D1/D3) —
// FUNCTION-SCOPED source-scan lock. gitlab.mjs's branchProtect accepts a
// `requiredReviews` param but never enforces it (GitLab's approval-count
// enforcement needs the Premium approval-rules API, not called here — see
// the JSDoc above the function). This scan is deliberately scoped to the
// branchProtect function body's OWN source slice, never file-wide: a
// file-wide scan for /approvals/ would false-positive on gitlab.mjs:271
// (prReviews), which legitimately calls `.../approvals` for an unrelated,
// correct reason. The lock is intentionally BIDIRECTIONAL — if a future
// change adds an approval-rules call inside branchProtect, this test FAILS
// and forces that decision into the open (design D1), rather than drifting
// silently either way.
test('branchProtect (M10 Phase 2): GitLab requiredReviews is accepted but never enforced — scoped source-scan lock', () => {
  const src = readFileSync(fileURLToPath(new URL('./adapters/gitlab.mjs', import.meta.url)), 'utf8');
  const start = src.indexOf('export async function branchProtect');
  assert.ok(start !== -1, 'gitlab.mjs must still export branchProtect');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end !== -1, 'branchProtect function body must have a closing brace at column 0');
  const body = src.slice(start, end);

  // Function-scoped: no approval/approval-rules endpoint call inside branchProtect's own body.
  assert.doesNotMatch(
    body,
    /approvals|approval[_-]?rules/i,
    'gitlab.branchProtect must not call any approvals/approval-rules endpoint — requiredReviews is accepted but not enforced (pinned, not fixed, per design D1)',
  );

  // #348 CHANGED WHAT THIS HALF ASSERTS, deliberately and with the ruling behind
  // it. The lock was written to prove `requiredReviews` is "declared but never
  // read", and it did its job: the moment #348 read the parameter, it fired.
  //
  // But "never read" was a PROXY for the thing worth protecting, which the
  // assertion above states directly: no approvals/approval-rules call in this
  // body. #348 ratified that limitation and ruled the opposite of silence —
  // the verb must now READ `requiredReviews` in order to report the count it
  // did NOT apply, instead of returning a bare `{ enforced: true }` over an
  // ignored parameter.
  //
  // So the proxy is replaced by what it stood for: the parameter is read, and
  // it is read ONLY to report. If enforcement is ever added, the scan above
  // fails — that half is untouched and still forces the decision into the open.
  assert.match(body, /requiredReviews/, 'the parameter is still declared');
  assert.match(
    body,
    /unappliedNote|NOT applied/,
    'and it is read to REPORT what was not applied (#348) — a verb that accepts a parameter and '
    + 'ignores it while returning success is the shape this ruling removed',
  );

  // Proves the narrow scope above is load-bearing, not incidentally passing:
  // the SAME pattern DOES match file-wide, via prReviews' legitimate
  // .../approvals call (~gitlab.mjs:271). A file-wide doesNotMatch on `src`
  // would fail here — this is the false positive the scoped scan avoids.
  assert.match(
    src,
    /approvals|approval[_-]?rules/i,
    'the full gitlab.mjs file DOES contain an approvals reference (prReviews) — proving the branchProtect-scoped scan above is a genuine narrowing, not a no-op',
  );
});

// ── prReviews provider-specific divergences (issue #317) ────────────────────
//
// The parameterized block above pins what BOTH providers must promise. These
// pin the two places they legitimately differ, plus the security boundary
// that difference creates.

test('github.prReviews (contract): a review with no comment normalizes body to \'\' (never null — null means uncomputable)', async () => {
  // GitHub returns `body: null` for a review submitted with no comment (the
  // common case for a bare APPROVED). The key is present in the payload but
  // null, so `''` can only come from the normalizer's `?? ''` guard — the
  // same empty-vs-uncomputable rule prView.body follows (A3 task 3.7).
  setSpawn(jsonSpawn([{ state: 'APPROVED', user: { login: 'bob' }, body: null }]));
  const result = await github.prReviews({ project: 'o/r', number: 144 });
  assert.deepEqual(result, [{ state: 'APPROVED', author: 'bob', body: '' }]);
});

test('github.prReviews (contract): body passes through VERBATIM — no trimming, no re-encoding of the fenced verdict block', async () => {
  // parseVerdict matches on the fence and on line-anchored `key: value`
  // scalars, so any normalization of whitespace or fences would break the
  // recovery while leaving a plausible-looking string in place.
  const body = '```yaml\nprotocol: brain-review/1\nverdict: STOP\nhead_sha: abc123\nrev: 4\n```';
  setSpawn(jsonSpawn([{ state: 'COMMENTED', user: { login: 'brain-reviewer' }, body }]));
  const [entry] = await github.prReviews({ project: 'o/r', number: 144 });
  assert.equal(entry.body, body, 'body must be byte-identical to the API payload');
  assert.deepEqual(parseVerdict(entry), { head_sha: 'abc123', rev: 4, verdict: 'STOP', author: 'brain-reviewer' });
});

// SECURITY BOUNDARY. GitLab's verdict thread lives in MR notes, but the L6
// brain-writes-reviewed gate counts ONLY `state === 'APPROVED'`. If notes
// normalized to APPROVED, anyone could clear the self-approval gate by typing
// a comment. The happy fixture's approver ('bob') is a different identity from
// every note author, so this cannot pass by coincidence.
test('gitlab.prReviews (contract): MR notes normalize to COMMENTED and NEVER to APPROVED — only the approvals endpoint may produce an approver', async () => {
  const fixture = loadFixture('gitlab-prReviews-happy.json');
  const result = await gitlab.prReviews({
    project: 'g/r',
    number: 7,
    ...gitlabPrReviewsCallArgs(fixture),
  });

  const approvers = result.filter(r => r.state === 'APPROVED').map(r => r.author);
  assert.deepEqual(
    approvers,
    ['bob'],
    'the ONLY APPROVED entry must be the approvals endpoint\'s approver — a note author appearing here would let a plain MR comment clear the L6 self-approval gate',
  );

  const noteAuthors = new Set(result.filter(r => r.state === 'COMMENTED').map(r => r.author));
  assert.ok(noteAuthors.has('brain-reviewer'), 'the reviewer\'s verdict note must be present, as COMMENTED');
  assert.ok(noteAuthors.has('alice'), 'a plain human note must be present, as COMMENTED');
  assert.ok(!noteAuthors.has('bob'), 'sanity: the approver is not also a note author, so the assertion above is load-bearing');
});

test('gitlab.prReviews (contract): GitLab system notes are dropped — activity records are not reviewer speech', async () => {
  const fixture = loadFixture('gitlab-prReviews-happy.json');
  const result = await gitlab.prReviews({
    project: 'g/r',
    number: 7,
    ...gitlabPrReviewsCallArgs(fixture),
  });
  assert.ok(
    fixture.data.notes.some(n => n.system === true),
    'sanity: the fixture must actually contain a system note, or this assertion is vacuous',
  );
  assert.ok(
    !result.some(r => r.author === 'gitlab-bot'),
    'the system note\'s author must not appear — system notes ("changed target branch from ...") are GitLab\'s own activity records',
  );
});

test('gitlab.prReviews (contract): requests notes oldest-first — poster.mjs/board.mjs take the LAST parsed verdict as current', async () => {
  // GitLab's notes endpoint defaults to NEWEST-first, which would invert
  // "latest verdict wins" and make the anti-loop compare against the oldest
  // verdict on the thread. The sort must be requested explicitly.
  const urls = [];
  await gitlab.prReviews({
    project: 'g/r',
    number: 7,
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => (url.includes('/approvals') ? { approved_by: [] } : []) };
    },
  });
  const notesUrl = urls.find(u => u.includes('/notes'));
  assert.ok(notesUrl, 'sanity: a notes request must have been made');
  assert.match(notesUrl, /sort=asc/, 'notes must be requested ascending — GitLab defaults to newest-first');
  assert.match(notesUrl, /order_by=created_at/, 'notes must be ordered by created_at, not the default id ordering');
});

test('gitlab.prReviews (contract): paginates the notes thread — with sort=asc an unpaginated fetch drops the LATEST verdict', async () => {
  // This is sharper than GitHub's --paginate guard: page 1 holds the OLDEST
  // notes, so truncation loses exactly the verdict the anti-loop needs.
  const perPage = 100;
  const page1 = Array.from({ length: perPage }, (_, i) => ({
    id: i,
    body: 'noise',
    author: { username: 'alice' },
    created_at: '2026-07-10T10:00:00.000Z',
    system: false,
  }));
  const page2 = [{
    id: 999,
    body: '```yaml\nprotocol: brain-review/1\nverdict: REVISE\nhead_sha: deadbeef\nrev: 2\n```',
    author: { username: 'brain-reviewer' },
    created_at: '2026-07-10T12:00:00.000Z',
    system: false,
  }];
  const result = await gitlab.prReviews({
    project: 'g/r',
    number: 7,
    fetchImpl: async (url) => {
      if (url.includes('/approvals')) return { ok: true, json: async () => ({ approved_by: [] }) };
      const page = Number(new URL(url).searchParams.get('page'));
      return { ok: true, json: async () => (page === 1 ? page1 : page === 2 ? page2 : []) };
    },
  });

  assert.equal(result.length, perPage + 1, 'both pages of notes must be present');
  const verdicts = result.map(r => parseVerdict(r)).filter(Boolean);
  assert.equal(verdicts.length, 1, 'the page-2 verdict must survive');
  assert.equal(verdicts[0].head_sha, 'deadbeef', 'the LATEST verdict lives on page 2 — an unpaginated fetch would silently lose it');
});

test('gitlab.prReviews (contract): an approvals failure yields null even when notes succeed — a notes-only result would fail-OPEN on the L6 gate', async () => {
  // The dangerous shape: returning the notes half alone hands
  // evaluateBrainWritesReviewed an empty approver set that is
  // indistinguishable from a genuine "nobody approved".
  const result = await gitlab.prReviews({
    project: 'g/r',
    number: 7,
    fetchImpl: async (url) =>
      url.includes('/approvals')
        ? { ok: false, status: 403 }
        : { ok: true, json: async () => [{ id: 1, body: 'hi', author: { username: 'alice' }, system: false }] },
  });
  assert.equal(result, null, 'a partial fetch must degrade to null (uncomputable), never to a half-populated array');
});

test('gitlab.prReviews (contract): a notes failure yields null even when approvals succeed — a half result would silently empty the verdict thread', async () => {
  const result = await gitlab.prReviews({
    project: 'g/r',
    number: 7,
    fetchImpl: async (url) =>
      url.includes('/approvals')
        ? { ok: true, json: async () => ({ approved_by: [{ user: { username: 'bob' } }] }) }
        : { ok: false, status: 500 },
  });
  assert.equal(result, null, 'losing the notes half must be uncomputable, not a verdict-free approvals list');
});

test('gitlab.prReviews (contract): source reads BOTH the notes and approvals endpoints — neither half may be dropped', () => {
  // Structural companion to the behavioral tests above: a regression that
  // reverts to approvals-only (the #317 defect) or drops approvals in favor
  // of notes-only (the fail-open) is caught here even if a future fixture
  // stops exercising one half.
  const src = readFileSync(fileURLToPath(new URL('./adapters/gitlab.mjs', import.meta.url)), 'utf8');
  const start = src.indexOf('export async function prReviews');
  assert.notEqual(start, -1, 'gitlab.mjs must still export prReviews');
  const end = src.indexOf('\nexport ', start + 1);
  const body = src.slice(start, end === -1 ? undefined : end);

  assert.match(body, /merge_requests\/\$\{number\}\/notes/, 'prReviews must fetch MR notes — the verdict thread lives there, and approvals alone carries no body (the #317 defect)');
  assert.match(body, /merge_requests\/\$\{number\}\/approvals/, 'prReviews must still fetch approvals — the L6 brain-writes-reviewed gate reads only APPROVED entries');
});

// ── issueCreate (issue #528) ────────────────────────────────────────────────
//
// The port could READ an issue, LIST issues and OPEN a merge request, and could not
// open an issue. So the first step of brain's own workflow — `issue-link` refuses any
// PR to main without an APPROVED issue behind it — was the one step brain did not
// support, and every ticket in this repository was authored outside the adapter.
//
// Parity here is the SHAPE, not the transport: GH shells `gh issue create` and parses
// the printed URL; GL POSTs and reads `iid`. Both must answer `{ number, url }` and
// both must normalise a transport failure to `{ number: null, url: null, error }`
// rather than throwing — `mrCreate`'s discipline, because a caller about to write
// `Closes #N` needs a value it can test, not an exception to catch.

test('github.issueCreate (contract): returns { number, url }, with the number parsed from the printed URL', async () => {
  setSpawn(() => ({ status: 0, stdout: 'https://github.com/acme/x/issues/531\n', stderr: '' }));
  const r = await github.issueCreate({ project: 'acme/x', title: 'T', body: 'B', labels: ['type:bug'] });
  assert.deepEqual(r, { number: 531, url: 'https://github.com/acme/x/issues/531' });
});

test('github.issueCreate (contract): an unparseable URL yields number null — never a fabricated one', async () => {
  // A caller is about to write `Closes #N`. A guessed number would link the PR to
  // somebody else's ticket, which is worse than having no number at all.
  setSpawn(() => ({ status: 0, stdout: 'created, see the dashboard\n', stderr: '' }));
  const r = await github.issueCreate({ project: 'acme/x', title: 'T' });
  assert.equal(r.number, null);
  assert.equal(r.url, 'created, see the dashboard');
});

test('github.issueCreate (contract): a transport failure normalises to { number: null, url: null, error } — never a throw', async () => {
  setSpawn(() => ({ status: 1, stdout: '', stderr: 'HTTP 403\n' }));
  const r = await github.issueCreate({ project: 'acme/x', title: 'T' });
  assert.deepEqual(r, { number: null, url: null, error: 'HTTP 403' });
});

test('gitlab.issueCreate (contract): returns { number, url } from iid + web_url', async () => {
  const r = await gitlab.issueCreate({
    project: 'grp/x', title: 'T', body: 'B', labels: ['type::bug'],
    token: PLACEHOLDER_CREDENTIAL,
    fetchImpl: async () => ({ ok: true, status: 201, json: async () => ({ iid: 77, web_url: 'https://gitlab.test/grp/x/-/issues/77' }) }),
  });
  assert.deepEqual(r, { number: 77, url: 'https://gitlab.test/grp/x/-/issues/77' });
});

test('gitlab.issueCreate (contract): a transport failure normalises the same way', async () => {
  const r = await gitlab.issueCreate({
    project: 'grp/x', title: 'T', token: PLACEHOLDER_CREDENTIAL,
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(r.number, null);
  assert.equal(r.url, null);
  assert.match(r.error, /ECONNRESET/);
});

// The one deliberate divergence from `mrCreate`'s never-throws rule, and the reason
// it is deliberate: a refused approval label is a POLICY refusal, not an outage. A
// caller that gets `{ error }` back may reasonably retry; a caller that tried to
// self-approve must not be handed something retryable.
test('issueCreate (contract): the approval refusal THROWS on both providers, unlike a transport failure', async () => {
  await assert.rejects(() => github.issueCreate({ project: 'a/b', title: 'T', labels: ['status:approved'] }), /HUMAN signature/);
  await assert.rejects(() => gitlab.issueCreate({ project: 'a/b', title: 'T', labels: ['status::approved'] }), /HUMAN signature/);
});

// ── labelCreate (issue #1163) — the write half of `labelList`. Creates a label
// DEFINITION in the remote's label set; it applies nothing to any issue, so it
// cannot hand anyone the approval (that is `labelAdd`'s deny-set, not this).
// `({ project, name, color?, description? }) -> { ok: true, created } | { ok: false, error }`.
// "Already exists" is a SUCCESS with `created: false` — that is what makes
// `env:init`'s label step idempotent. Never throws.

test('github.labelCreate (contract): POSTs the label to the labels endpoint and reports created', async () => {
  let captured;
  setSpawn((_cmd, args, opts) => { captured = { args, input: opts?.input }; return { status: 0, stdout: '{}', stderr: '' }; });
  const r = await github.labelCreate({ project: 'x/y', name: 'status:approved', color: '#0E8A16', description: 'Approved' });
  assert.deepEqual(r, { ok: true, created: true });
  assert.ok(captured.args.includes('repos/x/y/labels'), 'must target the labels collection');
  assert.ok(captured.args.includes('POST'));
  assert.deepEqual(JSON.parse(captured.input), { name: 'status:approved', color: '0E8A16', description: 'Approved' });
});

test('github.labelCreate (contract): 422 already_exists is { ok: true, created: false }', async () => {
  setSpawn(() => ({ status: 1, stdout: '{"message":"Validation Failed","errors":[{"resource":"Label","code":"already_exists","field":"name"}]}', stderr: 'gh: Validation Failed (HTTP 422)' }));
  assert.deepEqual(await github.labelCreate({ project: 'x/y', name: 'type:bug' }), { ok: true, created: false });
});

test('github.labelCreate (contract): any other failure is { ok: false, error }, never throws', async () => {
  setSpawn(failSpawn('gh: Resource not accessible (HTTP 403)'));
  const r = await github.labelCreate({ project: 'x/y', name: 'type:bug' });
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
});

test('gitlab.labelCreate (contract): POSTs name, a #-prefixed color and description; reports created', async () => {
  let seen;
  const r = await gitlab.labelCreate({
    project: 'g/p', name: 'status::approved', color: '0E8A16', description: 'Approved',
    fetchImpl: async (url, o) => { seen = { url, o }; return { ok: true, json: async () => ({}) }; },
  });
  assert.deepEqual(r, { ok: true, created: true });
  assert.match(seen.url, /projects\/g%2Fp\/labels$/);
  assert.equal(seen.o.method, 'POST');
  assert.deepEqual(JSON.parse(seen.o.body), { name: 'status::approved', color: '#0E8A16', description: 'Approved' });
});

test('gitlab.labelCreate (contract): 409 is { ok: true, created: false }; other failures are { ok: false, error }', async () => {
  const conflict = await gitlab.labelCreate({ project: 'g/p', name: 'x', fetchImpl: async () => ({ ok: false, status: 409 }) });
  assert.deepEqual(conflict, { ok: true, created: false });
  const denied = await gitlab.labelCreate({ project: 'g/p', name: 'x', fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /403/);
});

// ── issueClose (issue #1188) — closes an issue, nothing else. The post-merge
// workflow closes the alarm issues a later clean run resolves. The field set is
// empty on purpose: no body, title or labels travel with it (`issueUpdate`'s
// refusal to carry `state` is the mirror of this verb's refusal to carry anything
// but it). `({ project, number }) -> { ok: true } | { ok: false, error }`. Never throws.

test('github.issueClose (contract): PATCHes state=closed on the issue and nothing else', async () => {
  let captured;
  setSpawn((_cmd, args, opts) => { captured = { args, input: opts?.input }; return { status: 0, stdout: '{}', stderr: '' }; });
  const r = await github.issueClose({ project: 'x/y', number: 4 });
  assert.deepEqual(r, { ok: true });
  assert.ok(captured.args.includes('repos/x/y/issues/4'));
  assert.ok(captured.args.includes('PATCH'));
  assert.deepEqual(JSON.parse(captured.input), { state: 'closed', state_reason: 'completed' });
});

test('github.issueClose (contract): a failure is { ok: false, error }, never throws', async () => {
  setSpawn(failSpawn('gh: Resource not accessible (HTTP 403)'));
  const r = await github.issueClose({ project: 'x/y', number: 4 });
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
});

test('gitlab.issueClose (contract): PUTs state_event=close on the issue and nothing else', async () => {
  let seen;
  const r = await gitlab.issueClose({
    project: 'g/p', number: 4,
    fetchImpl: async (url, o) => { seen = { url, o }; return { ok: true, json: async () => ({}) }; },
  });
  assert.deepEqual(r, { ok: true });
  assert.match(seen.url, /projects\/g%2Fp\/issues\/4$/);
  assert.equal(seen.o.method, 'PUT');
  assert.deepEqual(JSON.parse(seen.o.body), { state_event: 'close' });
});

test('gitlab.issueClose (contract): a failure is { ok: false, error }, never throws', async () => {
  const r = await gitlab.issueClose({ project: 'g/p', number: 4, fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
});
