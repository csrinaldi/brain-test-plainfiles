// cold-boot.test.mjs — Unit tests for the reviewer's cold boot (REQ-H1-2,
// REQ-H1-3; design.md §4). No test spawns a real gh/glab/git process — every
// I/O seam is injected via `deps`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { removeTempTree } from '../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { evaluateSelfReview, gatherColdBoot, defaultCloneDetached } from './cold-boot.mjs';
// Imported for the #317 end-to-end guards at the bottom of this file, which
// exercise the REAL provider normalizer and the REAL downstream locks rather
// than an injected review shape — see the block comment there.
import { setSpawn } from '../vcs/lib/exec.mjs';
import * as github from '../axes/vcs/adapters/github.mjs';
import { postVerdict } from './poster.mjs';
import { buildVerdict } from './verdict.mjs';
import { verdictsAtHead } from './lib/parse-verdict.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const PR = { project: 'csrinaldi/brain', number: 42, provider: 'github' };

// headRefOid now comes from prView (ADR-0021 Decision 3) — the H1-1 cold-boot
// `fetchHead` DI-seam reader is retired, no separate seam exists.
function baseDeps(overrides = {}) {
  return {
    fetchPr: async () => ({ number: 42, author: 'alice', labels: [], body: '', headRefOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    cloneDetached: async () => ({ detached: true }),
    readRecords: () => [],
    fetchReviews: async () => [],
    ...overrides,
  };
}

// ── evaluateSelfReview (pure) ────────────────────────────────────────────────

test('evaluateSelfReview: reviewer handle equals author → true', () => {
  assert.equal(evaluateSelfReview({ reviewerHandle: 'brain-reviewer', author: 'brain-reviewer' }), true);
});

test('evaluateSelfReview: reviewer handle differs from author → false', () => {
  assert.equal(evaluateSelfReview({ reviewerHandle: 'brain-reviewer', author: 'alice' }), false);
});

// ── gatherColdBoot: anchor is the API headRefOid, detached ──────────────────

test('gatherColdBoot: checks out detached at prView\'s headRefOid, never a branch name', async () => {
  const cloneCalls = [];
  const fetchPrCalls = [];
  const result = await gatherColdBoot({
    ...PR,
    reviewerHandle: 'brain-reviewer',
    deps: baseDeps({
      fetchPr: async (args) => {
        fetchPrCalls.push(args);
        return { number: 42, author: 'alice', labels: [], body: '', headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d' };
      },
      cloneDetached: async (args) => { cloneCalls.push(args); return { detached: true }; },
    }),
  });

  assert.equal(result.abstain, false);
  assert.equal(result.headSha, 'cafef00dcafef00dcafef00dcafef00dcafef00d');
  assert.equal(cloneCalls.length, 1);
  // The clone seam receives shas only — `sha` (head) + `baseSha` (null here, the
  // fixture has no baseRefOid). NO `branch` key exists on the call (R2 — the
  // anchor is always an oid, never a branch name).
  assert.deepEqual(cloneCalls[0], { sha: 'cafef00dcafef00dcafef00dcafef00dcafef00d', baseSha: null });
  assert.deepEqual(fetchPrCalls[0], { project: PR.project, number: PR.number, provider: PR.provider });
});

// ── gatherColdBoot: the base tip flows to the clone (issue #291) ─────────────

test('gatherColdBoot: prView.baseRefOid flows to cloneDetached as baseSha (so the diff/reversion have the base)', async () => {
  const cloneCalls = [];
  await gatherColdBoot({
    ...PR,
    reviewerHandle: 'brain-reviewer',
    deps: baseDeps({
      fetchPr: async () => ({
        number: 42, author: 'alice', labels: [], body: '',
        headRefOid: 'cafef00dcafef00dcafef00dcafef00dcafef00d',
        baseRefOid: 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e',
      }),
      cloneDetached: async (args) => { cloneCalls.push(args); return { detached: true }; },
    }),
  });

  assert.deepEqual(cloneCalls[0], {
    sha: 'cafef00dcafef00dcafef00dcafef00dcafef00d',
    baseSha: 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e',
  });
});

// ── gatherColdBoot: doctrine is only records + prior verdicts ───────────────

test('gatherColdBoot: doctrine loads decision|architecture records + prior brain-review/1 blocks, excludes note records', async () => {
  const records = [
    { type: 'decision', id: 'd1' },
    { type: 'architecture', id: 'a1' },
    { type: 'note', id: 'n1' },
  ];
  const reviews = [
    { state: 'COMMENTED', author: 'brain-reviewer', body: '```yaml\nprotocol: brain-review/1\nverdict: REVISE\nhead_sha: aaa\nrev: 0\n```' },
    { state: 'COMMENTED', author: 'bob', body: 'just a plain human comment' },
  ];

  const result = await gatherColdBoot({
    ...PR,
    reviewerHandle: 'brain-reviewer',
    deps: baseDeps({
      readRecords: () => records,
      fetchReviews: async () => reviews,
    }),
  });

  assert.equal(result.abstain, false);
  assert.deepEqual(result.doctrine.records, [
    { type: 'decision', id: 'd1' },
    { type: 'architecture', id: 'a1' },
  ]);
  assert.equal(result.doctrine.priorVerdicts.length, 1);
  assert.equal(result.doctrine.priorVerdicts[0].head_sha, 'aaa');
  assert.equal(result.doctrine.priorVerdicts[0].author, 'brain-reviewer');
});

// ── gatherColdBoot: self-review abstention (REQ-H1-3) ────────────────────────

test('gatherColdBoot: reviewer handle equals PR author → abstains, no doctrine load, no boot I/O', async () => {
  const calls = { cloneDetached: 0, readRecords: 0, fetchReviews: 0 };
  const result = await gatherColdBoot({
    ...PR,
    reviewerHandle: 'alice',
    deps: baseDeps({
      fetchPr: async () => ({ number: 42, author: 'alice', labels: [], body: '', headRefOid: 'x' }),
      cloneDetached: async () => { calls.cloneDetached++; },
      readRecords: () => { calls.readRecords++; return []; },
      fetchReviews: async () => { calls.fetchReviews++; return []; },
    }),
  });

  assert.equal(result.abstain, true);
  assert.equal(result.headSha, undefined);
  assert.deepEqual(calls, { cloneDetached: 0, readRecords: 0, fetchReviews: 0 });
});

// ── fetchHead seam retirement (ADR-0021 Decision 3, Fork A condition 2) ─────

test('cold-boot.mjs source carries no fetchHead seam or TODO(#266) retirement marker — retired, headRefOid now comes from prView', () => {
  const src = readFileSync(fileURLToPath(new URL('./cold-boot.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /fetchHead/i, 'the fetchHead DI-seam reader must be fully removed');
  assert.doesNotMatch(src, /defaultFetchHead/, 'defaultFetchHead must be fully removed');
  assert.doesNotMatch(src, /TODO\(#266\)/, 'the TODO(#266) retirement marker must be removed once retired');
});

// ── COLDBOOT-CWD (real default, issue #266): protocol §8 "own clone/worktree" ─
// The ONE test that exercises the REAL defaultCloneDetached against real git —
// only the network fetch is stubbed (I/O, not the isolation logic). It must
// create an isolated detached worktree and NEVER move the operator's HEAD.

test('COLDBOOT-CWD (real default): defaultCloneDetached checks out a SEPARATE detached worktree and never moves the operator HEAD', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'brain-review-op-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'brain-review-wt-'));
  t.after(() => {
    try { git(repo, 'worktree', 'prune'); } catch { /* best effort */ }
    removeTempTree(repo);
    removeTempTree(wtParent);
  });

  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'f.txt'), 'hi');
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-q', '-m', 'a');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const branch = git(repo, 'symbolic-ref', '--short', 'HEAD');

  // Real default; only the network fetch is stubbed (the sha is already local).
  const clone = defaultCloneDetached({ cwd: repo, fetch: () => {}, tmp: wtParent })({ sha });

  // isolated worktree, detached at the reviewed sha
  assert.ok(existsSync(clone.worktreePath), 'an isolated worktree must be created');
  assert.equal(git(clone.worktreePath, 'rev-parse', 'HEAD'), sha, 'worktree HEAD is the reviewed sha');
  assert.throws(() => git(clone.worktreePath, 'symbolic-ref', '-q', 'HEAD'), 'worktree HEAD must be DETACHED (no branch ref)');

  // the operator's HEAD did NOT move — still on its branch, still at the same sha
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), branch, 'operator HEAD stays on its branch — never detached in cwd');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), sha, 'operator HEAD did not move');
});

// ── COLDBOOT-DEPTH (issue #291): fetch BOTH head and base WITH history ───────
// Second instance of the COLDBOOT-CWD class — "a DI seam tested only through its
// injected stub never exercises the real default". The `--depth 1` head-only
// fetch left the head a shallow graft (no ancestors → no merge-base) and never
// brought the base at all, so downstream `git diff base...head` (cli.mjs
// getChangedFiles) and `git checkout base -- <files>` (checkpoint §10.4
// reversion) both fail — the exact #290 crash (`fatal: <base>...<head>: no
// merge base`). Real git, real fetch from a local bare remote where the
// operator starts WITHOUT either commit (I291-AMBIENT-STATE: cold boot must be
// self-sufficient, never leaning on the operator's ambient clone state).
test('COLDBOOT-DEPTH (real default): defaultCloneDetached fetches head AND base with history — base...head diff resolves and the §10.4 base checkout works', (t) => {
  const remote = mkdtempSync(join(tmpdir(), 'brain-review-remote-'));
  const seed = mkdtempSync(join(tmpdir(), 'brain-review-seed-'));
  const op = mkdtempSync(join(tmpdir(), 'brain-review-op-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'brain-review-wt-'));
  t.after(() => {
    try { git(op, 'worktree', 'prune'); } catch { /* best effort */ }
    for (const d of [remote, seed, op, wtParent]) removeTempTree(d);
  });

  // Bare remote: a base and a head that DIVERGE from a common ancestor A.
  git(remote, 'init', '-q', '--bare');
  git(seed, 'init', '-q');
  git(seed, 'config', 'user.email', 't@t.t'); git(seed, 'config', 'user.name', 't');
  writeFileSync(join(seed, 'impl.mjs'), 'export const x = 1;\n');
  git(seed, 'add', 'impl.mjs'); git(seed, 'commit', '-q', '-m', 'A (common ancestor)');
  git(seed, 'checkout', '-q', '-b', 'base-branch');
  writeFileSync(join(seed, 'base-only.txt'), 'base\n');
  git(seed, 'add', 'base-only.txt'); git(seed, 'commit', '-q', '-m', 'B (base tip)');
  const baseSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'checkout', '-q', '-b', 'head-branch', 'base-branch~1'); // diverge from A
  writeFileSync(join(seed, 'impl.mjs'), 'export const x = 2;\n');
  git(seed, 'add', 'impl.mjs'); git(seed, 'commit', '-q', '-m', 'H (head tip)');
  const headSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'base-branch', 'head-branch');

  // Operator repo: valid, but does NOT yet have base or head.
  git(op, 'init', '-q');
  git(op, 'config', 'user.email', 't@t.t'); git(op, 'config', 'user.name', 't');
  writeFileSync(join(op, 'unrelated.txt'), 'x'); git(op, 'add', 'unrelated.txt'); git(op, 'commit', '-q', '-m', 'unrelated');
  git(op, 'remote', 'add', 'origin', remote);

  // Real default fetch (no stub): must bring head AND base with history.
  const clone = defaultCloneDetached({ cwd: op, tmp: wtParent })({ sha: headSha, baseSha });
  assert.equal(clone.sha, headSha);

  // 1) the three-dot diff (cli.mjs getChangedFiles) resolves a merge-base (A)
  const changed = git(op, 'diff', '--name-only', `${baseSha}...${headSha}`);
  assert.match(changed, /impl\.mjs/, 'base...head diff must resolve — merge-base A reachable');

  // 2) the §10.4 reversion actually runs: inside the detached head worktree,
  //    `git checkout <base> -- impl.mjs` must succeed and revert the file to
  //    its base content (proves the base TREE — not just the commit — is local).
  git(clone.worktreePath, 'checkout', baseSha, '--', 'impl.mjs');
  assert.equal(
    readFileSync(join(clone.worktreePath, 'impl.mjs'), 'utf8'),
    'export const x = 1;\n',
    'the base checkout must revert impl.mjs to its base content (§10.4 TDD-RED reversion)',
  );
});

// ── COLDBOOT-SHALLOW (issue #293): a SHALLOW operator clone truncates history ─
// #291/#292 fixed the "base never fetched" half, but the REAL operator repo is a
// shallow clone AND the base/head tips are ALREADY present as depth-1 grafts
// (the #290 reality: the tracker already had both). Re-`git fetch origin <sha>`
// on an already-present graft is a no-op — it never deepens — so the merge-base
// (M, below both grafts) stays absent and base...head still fails. Third
// instance of the class: the fixture must match the real ENVIRONMENT (shallow +
// grafts already local), not merely exercise the real default.
// defaultCloneDetached must DEEPEN (unshallow) so the merge-base connects.
//
// History: root R -> M (merge-base); base = M->Pb->B; head = M->Ph->H. The op is
// a depth-1 clone of base-branch (has B, graft at Pb) + a depth-1 fetch of
// head-branch (has H, graft at Ph) — so M is two commits below each graft and
// absent, exactly like feature/v2.0.0 vs issue-266.
test('COLDBOOT-SHALLOW (real default): shallow op with both tips already grafted is deepened so base...head resolves and the §10.4 base checkout works', (t) => {
  const remote = mkdtempSync(join(tmpdir(), 'brain-review-remote-'));
  const seed = mkdtempSync(join(tmpdir(), 'brain-review-seed-'));
  const opParent = mkdtempSync(join(tmpdir(), 'brain-review-opp-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'brain-review-wt-'));
  const op = join(opParent, 'op');
  t.after(() => {
    try { git(op, 'worktree', 'prune'); } catch { /* best effort */ }
    for (const d of [remote, seed, opParent, wtParent]) removeTempTree(d);
  });

  git(remote, 'init', '-q', '--bare');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@t.t'); git(seed, 'config', 'user.name', 't');
  writeFileSync(join(seed, 'r.txt'), 'r\n');
  git(seed, 'add', 'r.txt'); git(seed, 'commit', '-q', '-m', 'R (root)');
  writeFileSync(join(seed, 'impl.mjs'), 'export const x = 0;\n');
  git(seed, 'add', 'impl.mjs'); git(seed, 'commit', '-q', '-m', 'M (merge-base)');
  const m = git(seed, 'rev-parse', 'HEAD');
  // base-branch: M -> Pb -> B  (B's grandparent is M)
  git(seed, 'checkout', '-q', '-b', 'base-branch', m);
  writeFileSync(join(seed, 'pb.txt'), 'pb\n'); git(seed, 'add', 'pb.txt'); git(seed, 'commit', '-q', '-m', 'Pb');
  writeFileSync(join(seed, 'impl.mjs'), 'export const x = 1;\n');
  git(seed, 'add', 'impl.mjs'); git(seed, 'commit', '-q', '-m', 'B (base tip)');
  const baseSha = git(seed, 'rev-parse', 'HEAD');
  // head-branch: M -> Ph -> H
  git(seed, 'checkout', '-q', '-b', 'head-branch', m);
  writeFileSync(join(seed, 'ph.txt'), 'ph\n'); git(seed, 'add', 'ph.txt'); git(seed, 'commit', '-q', '-m', 'Ph');
  writeFileSync(join(seed, 'impl.mjs'), 'export const x = 2;\n');
  git(seed, 'add', 'impl.mjs'); git(seed, 'commit', '-q', '-m', 'H (head tip)');
  const headSha = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main', 'base-branch', 'head-branch');

  // Operator repo: shallow, with BOTH tips already present as depth-1 grafts and
  // the merge-base M absent. `file://` so git honours --depth (a local-path
  // clone hardlinks the full store and ignores --depth).
  git(opParent, 'clone', '-q', '--depth', '1', '--branch', 'base-branch', `file://${remote}`, op);
  git(op, 'fetch', '-q', '--depth', '1', 'origin', 'head-branch');
  assert.equal(git(op, 'rev-parse', '--is-shallow-repository'), 'true', 'fixture must be a shallow clone');
  assert.throws(() => git(op, 'merge-base', baseSha, headSha), 'precondition: the merge-base is absent before the fix deepens');

  // Real default: fetch both shas (no-ops — already grafted) AND deepen.
  const clone = defaultCloneDetached({ cwd: op, tmp: wtParent })({ sha: headSha, baseSha });
  assert.equal(clone.sha, headSha);

  const changed = git(op, 'diff', '--name-only', `${baseSha}...${headSha}`);
  assert.match(changed, /impl\.mjs/, 'base...head must resolve from a shallow clone — merge-base M reachable after deepen');

  git(clone.worktreePath, 'checkout', baseSha, '--', 'impl.mjs');
  assert.equal(
    readFileSync(join(clone.worktreePath, 'impl.mjs'), 'utf8'),
    'export const x = 1;\n',
    'the §10.4 base checkout must revert to base content from a shallow clone too',
  );
});

// ── #317 end-to-end guard: the REAL adapter, not an injected review shape ────
//
// Every other test in this file injects `deps.fetchReviews` and hands
// `gatherColdBoot` a hand-written review object that already carries a
// `body`. That injection is precisely what let issue #317 sit undetected:
// the real `prReviews` normalizer dropped `body` (GitHub) and read the
// body-less approvals endpoint (GitLab), so `doctrine.priorVerdicts` was
// ALWAYS `[]` in production while these tests stayed green on a shape no
// adapter ever emitted — cold-boot.mjs even carried a comment saying so.
//
// This test mocks ONE LAYER LOWER (the same discipline
// brain-writes-reviewed.test.mjs uses for its GitLab default-path test):
// `deps.getVcs` returns the REAL github provider module, and the `gh` CLI
// itself is stubbed via `setSpawn` with the RECORDED API response
// (fixtures/github-prReviews-happy.json — real traffic from PR #360,
// carrying real `brain-review/1` blocks). So the chain under test is the
// production one end to end: gh response -> real prReviews normalizer ->
// real defaultFetchReviews -> real parseVerdict -> priorVerdicts -> the
// real anti-loop lock. Nothing between the API payload and the guarantee is
// faked.

const PR_REVIEWS_FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../vcs/fixtures/github-prReviews-happy.json', import.meta.url)), 'utf8'),
);
// The recorded thread's LAST review — the one the anti-loop compares against.
const LAST_RECORDED = PR_REVIEWS_FIXTURE.data[PR_REVIEWS_FIXTURE.data.length - 1];
const LAST_RECORDED_AUTHOR = LAST_RECORDED.user.login;
const LAST_RECORDED_HEAD = LAST_RECORDED.body.match(/^head_sha:[ \t]*(.+)$/m)[1].trim();

function withRecordedReviews(fn) {
  setSpawn(() => ({ status: 0, stdout: JSON.stringify(PR_REVIEWS_FIXTURE.data), stderr: '' }));
  return fn().finally(() => setSpawn(spawnSync));
}

test('#317 end-to-end: gatherColdBoot builds a NON-EMPTY priorVerdicts through the REAL prReviews normalizer (no injected fetchReviews, no injected body)', async () => {
  const result = await withRecordedReviews(() =>
    gatherColdBoot({
      ...PR,
      reviewerHandle: 'nobody-in-particular',
      deps: {
        fetchPr: async () => ({ number: 42, author: 'alice', labels: [], body: '', headRefOid: LAST_RECORDED_HEAD }),
        cloneDetached: async () => ({ detached: true }),
        readRecords: () => [],
        // fetchReviews is DELIBERATELY NOT injected — the real
        // defaultFetchReviews wrapper runs, dispatching through getVcs.
        getVcs: async () => github,
      },
    }),
  );

  assert.equal(result.abstain, false);
  assert.equal(
    result.doctrine.priorVerdicts.length,
    PR_REVIEWS_FIXTURE.data.length,
    'every recorded review carrying a brain-review block must survive into priorVerdicts — `[]` here is the #317 production defect',
  );
  const latest = result.doctrine.priorVerdicts[result.doctrine.priorVerdicts.length - 1];
  assert.equal(latest.head_sha, LAST_RECORDED_HEAD);
  assert.equal(latest.author, LAST_RECORDED_AUTHOR, 'author must be carried through so the anti-loop can compare it against the reviewer handle');
});

test('#317 end-to-end: the anti-loop lock FIRES on a rerun of the same head, driven by priorVerdicts from the REAL normalizer', async () => {
  const boot = await withRecordedReviews(() =>
    gatherColdBoot({
      ...PR,
      reviewerHandle: LAST_RECORDED_AUTHOR,
      deps: {
        fetchPr: async () => ({ number: 42, author: 'alice', labels: [], body: '', headRefOid: LAST_RECORDED_HEAD }),
        cloneDetached: async () => ({ detached: true }),
        readRecords: () => [],
        getVcs: async () => github,
      },
    }),
  );

  // Same reviewer, same head as the last recorded verdict → protocol §10's
  // "comment loop" must be suppressed. Pre-#317 priorVerdicts was `[]`, so
  // `lastVerdict` was null, so this posted a DUPLICATE verdict on every rerun.
  const rerun = await postVerdict({
    headSha: LAST_RECORDED_HEAD,
    ...PR,
    mode: 'tranche',
    renderedBody: 'would be a duplicate',
    reviewerHandle: LAST_RECORDED_AUTHOR,
    priorVerdicts: boot.doctrine.priorVerdicts,
    deps: {
      getVcs: async () => { throw new Error('anti-loop must short-circuit BEFORE any vcs call'); },
    },
  });
  assert.deepEqual(rerun, { posted: false, skipped: 'anti-loop' });

  // Control: a DIFFERENT head is a new tranche, so the lock must NOT fire —
  // proving the assertion above is the lock working, not a blanket refusal.
  let posted = false;
  const advanced = await postVerdict({
    headSha: 'ffffffffffffffffffffffffffffffffffffffff',
    ...PR,
    mode: 'tranche',
    renderedBody: 'a genuinely new verdict',
    reviewerHandle: LAST_RECORDED_AUTHOR,
    priorVerdicts: boot.doctrine.priorVerdicts,
    deps: {
      getVcs: async () => ({
        prReviewComment: async () => { posted = true; return { url: 'https://example.test/r/1' }; },
      }),
      reResolveHead: async () => 'ffffffffffffffffffffffffffffffffffffffff',
    },
  });
  assert.equal(advanced.posted, true);
  assert.equal(posted, true, 'a new head must still post — the anti-loop is head-bound, not a mute switch');
});

test('#317 end-to-end: the rev-bound sees a real priorRevCount — rev >= 3 REVISE escalates to STOP', async () => {
  const boot = await withRecordedReviews(() =>
    gatherColdBoot({
      ...PR,
      reviewerHandle: 'nobody-in-particular',
      deps: {
        fetchPr: async () => ({ number: 42, author: 'alice', labels: [], body: '', headRefOid: LAST_RECORDED_HEAD }),
        cloneDetached: async () => ({ detached: true }),
        readRecords: () => [],
        getVcs: async () => github,
      },
    }),
  );

  // cli.mjs:207 computes priorRevCount exactly this way.
  const priorRevCount = boot.doctrine.priorVerdicts.length;
  assert.ok(priorRevCount >= 3, 'the recorded thread must supply a real count — pre-#317 this was permanently 0, defeating the §7 infinite-REVISE guard');

  const bounded = buildVerdict({ headSha: LAST_RECORDED_HEAD, conclusion: 'REVISE', priorRevCount });
  assert.equal(bounded.verdict, 'STOP', 'a REVISE at rev >= 3 must escalate to STOP — unreachable while priorRevCount was stuck at 0');
  assert.equal(bounded.escalate, 'human', 'the bound must also escalate to a human (protocol §7, REQ-H1-6)');

  // Control: the same conclusion below the bound stays REVISE, proving the
  // assertion above is the bound firing rather than an unconditional STOP.
  const unbounded = buildVerdict({ headSha: LAST_RECORDED_HEAD, conclusion: 'REVISE', priorRevCount: 0 });
  assert.equal(unbounded.verdict, 'REVISE');
});

// ═══════════════════════════════════════════════════════════════════════════
// #506 — the rev bound counts an ITERATION, and the escalation has an exit.
//
// The ticket's red-proof duty, stated there and honoured here: every existing test
// of the bound drives `priorRevCount` DIRECTLY, so none of them exercises the
// counting RULE at all. These derive the count from a review list — which is the
// only shape that can tell "the bound triggers at 4" from "the bound triggers at 4
// verdicts about the same diff".
//
// Measured on PR #505 before the fix: four runs at the same head_sha `3ae6eb9`,
// same single finding, nothing changed in the code — run 4 returned STOP +
// escalate:human, and every run after it did too. A new commit did not reset it
// (no head filter). Dismissing the reviews did not (a dismissed review keeps its
// body). The only exit was closing the PR and losing the history the escalation
// exists to summarise.

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function verdictReview(headSha, rev, author = 'brain-reviewer') {
  return {
    state: 'COMMENTED',
    author,
    body: `\`\`\`yaml\nprotocol: brain-review/1\nverdict: REVISE\nhead_sha: ${headSha}\nrev: ${rev}\n\`\`\``,
  };
}

function decisionReview(headSha, actor = 'csrinaldi') {
  return {
    state: 'COMMENTED',
    author: actor,
    body: `\`\`\`yaml\nprotocol: brain-decision/1\ndecision: APPROVE\nhead_sha: ${headSha}\nactor: ${actor}\n\`\`\``,
  };
}

async function bootWith(reviews, headSha = HEAD_A) {
  return gatherColdBoot({
    ...PR,
    reviewerHandle: 'brain-reviewer',
    deps: baseDeps({
      fetchPr: async () => ({ number: 42, author: 'alice', labels: [], body: '', headRefOid: headSha }),
      fetchReviews: async () => reviews,
    }),
  });
}

test('#506: three verdicts at OLD heads do not count toward the bound at the current head', async () => {
  const boot = await bootWith([
    verdictReview(HEAD_B, 1), verdictReview(HEAD_B, 2), verdictReview(HEAD_B, 3),
    verdictReview(HEAD_A, 1),
  ]);

  assert.equal(boot.doctrine.priorVerdicts.length, 4, 'the raw list is unfiltered — other consumers need it whole');
  const atHead = verdictsAtHead(boot.doctrine.priorVerdicts, boot.headSha);
  assert.equal(atHead.length, 1, 'only the verdict about THIS diff is this iteration');

  // The count is what buildVerdict receives. Before the fix this was 4 → STOP on a
  // PR whose author had just pushed a fix.
  const v = buildVerdict({
    headSha: boot.headSha, conclusion: 'REVISE',
    priorRevCount: atHead.length,
    findings: [{ id: 'f1', severity: 'blocker', evidence: 'e', cites: 'c' }],
  });
  assert.equal(v.verdict, 'REVISE', 'pushing a fix must re-arm the loop, not leave it escalated');
  assert.equal(v.escalate, null);
});

test('#506: FOUR verdicts at the CURRENT head still escalate — the bound is not weakened, only re-aimed', async () => {
  const boot = await bootWith([
    verdictReview(HEAD_A, 1), verdictReview(HEAD_A, 2),
    verdictReview(HEAD_A, 3), verdictReview(HEAD_A, 4),
  ]);
  const atHead = verdictsAtHead(boot.doctrine.priorVerdicts, boot.headSha);
  assert.equal(atHead.length, 4);

  const v = buildVerdict({
    headSha: boot.headSha, conclusion: 'REVISE',
    priorRevCount: atHead.length,
    findings: [{ id: 'f1', severity: 'blocker', evidence: 'e', cites: 'c' }],
  });
  assert.equal(v.verdict, 'STOP', 'arguing four times about one diff IS what §7 escalates');
  assert.equal(v.escalate, 'human');
});

test('#506: cold boot surfaces brain-decision/1 blocks from the SAME review list', async () => {
  const boot = await bootWith([verdictReview(HEAD_A, 1), decisionReview(HEAD_A)]);
  assert.equal(boot.doctrine.priorVerdicts.length, 1, 'a decision block is not a verdict');
  assert.equal(boot.doctrine.priorDecisions.length, 1, 'and a verdict is not a decision');
  assert.equal(boot.doctrine.priorDecisions[0].head_sha, HEAD_A);
});

test('#506: a human ruling at the current head CLEARS the escalation — the trapdoor becomes a door', async () => {
  const boot = await bootWith([
    verdictReview(HEAD_A, 1), verdictReview(HEAD_A, 2),
    verdictReview(HEAD_A, 3), verdictReview(HEAD_A, 4),
    decisionReview(HEAD_A),
  ]);
  const atHead = verdictsAtHead(boot.doctrine.priorVerdicts, boot.headSha);
  const rulingAtHead = boot.doctrine.priorDecisions.some(d => d.head_sha === boot.headSha);
  assert.equal(atHead.length, 4, 'the count is still past the bound');
  assert.equal(rulingAtHead, true);

  const v = buildVerdict({
    headSha: boot.headSha, conclusion: 'REVISE',
    priorRevCount: atHead.length, rulingAtHead,
    findings: [{ id: 'f1', severity: 'blocker', evidence: 'e', cites: 'c' }],
  });
  assert.equal(v.verdict, 'REVISE', 'the human was summoned and ruled — the escalation is answered');
  assert.equal(v.escalate, null);
});

test('#506: a ruling at an OLD head does not clear an escalation at the current one', async () => {
  const boot = await bootWith([
    verdictReview(HEAD_A, 1), verdictReview(HEAD_A, 2),
    verdictReview(HEAD_A, 3), verdictReview(HEAD_A, 4),
    decisionReview(HEAD_B),
  ]);
  const rulingAtHead = boot.doctrine.priorDecisions.some(d => d.head_sha === boot.headSha);
  assert.equal(rulingAtHead, false, 'a push is work the human has not ruled on — the same rule actor-check applies');

  const v = buildVerdict({
    headSha: boot.headSha, conclusion: 'REVISE',
    priorRevCount: verdictsAtHead(boot.doctrine.priorVerdicts, boot.headSha).length,
    rulingAtHead,
    findings: [{ id: 'f1', severity: 'blocker', evidence: 'e', cites: 'c' }],
  });
  assert.equal(v.verdict, 'STOP');
});

// The exit is scoped to ONE escalation. `unknownCausality` says "the reviewer cannot
// determine whether this finding is caused by the diff" — a ruling about going around
// in circles does not answer that, and a fix that cleared both would silently widen
// what a signature means.
test('#506: a ruling does NOT clear the unknown-causality escalation — two questions, one answer', async () => {
  const v = buildVerdict({
    headSha: HEAD_A, conclusion: 'REVISE', priorRevCount: 0, rulingAtHead: true,
    protocol: 'brain-review/2',
    findings: [{ id: 'f1', severity: 'blocker', evidence: 'e', cites: 'c', causal_disposition: 'unknown' }],
  });
  assert.equal(v.verdict, 'STOP');
  assert.equal(v.escalate, 'human');
});

// ── #477: an UNREADABLE prior verdict is named, not folded ──────────────────
//
// The maintainer ruling on #477 (2026-08-12), second half: `cold-boot` must
// distinguish THREE states — clean, has-findings, and unreadable — and "an
// unreadable verdict is reported, never silently folded into either of the
// other two."
//
// `parseVerdict` now records what it could not read on `result.malformed`
// (#477's first half). Carrying that field through `priorVerdicts` is necessary
// and is not sufficient: nothing downstream walks the list looking for it, so a
// verdict whose findings list was garbage sits in `doctrine.priorVerdicts`
// looking exactly like one that found nothing. `unreadableVerdicts` is the
// named surface a reader can act on without re-deriving the question.
//
// `priorVerdicts` itself is NOT filtered. An unreadable verdict is still a
// review iteration — it must keep counting toward the §7 rev bound and the
// anti-loop lock, or refusing to read one would become a way to reset them.

test('#477: an unreadable prior verdict is named in doctrine.unreadableVerdicts', async () => {
  const reviews = [
    { state: 'COMMENTED', author: 'brain-reviewer', body: '```yaml\nprotocol: brain-review/1\nverdict: APPROVE\nhead_sha: aaa\nrev: 0\nfindings: []\n```' },
    // Truncated findings list — the shape a clipped comment body produces.
    { state: 'COMMENTED', author: 'brain-reviewer', body: '```yaml\nprotocol: brain-review/2\nverdict: APPROVE\nhead_sha: bbb\nrev: 1\nfindings: [{"id": "F-1"\n```' },
  ];

  const result = await gatherColdBoot({
    ...PR,
    reviewerHandle: 'brain-reviewer',
    deps: baseDeps({ fetchReviews: async () => reviews }),
  });

  assert.equal(result.doctrine.priorVerdicts.length, 2,
    'an unreadable verdict is still an iteration — it must not be dropped from the rev count');
  assert.deepEqual(result.doctrine.unreadableVerdicts, [
    { head_sha: 'bbb', author: 'brain-reviewer', malformed: ['findings'] },
  ], 'the corrupt verdict must be nameable without re-parsing — it read as "found nothing" before');

  // The property the ruling is actually about, stated as a consumer would ask it.
  const clean = v => (v.findings ?? []).length === 0 && (v.malformed ?? []).length === 0;
  assert.equal(clean(result.doctrine.priorVerdicts[0]), true, 'the APPROVE with findings: [] is genuinely clean');
  assert.equal(clean(result.doctrine.priorVerdicts[1]), false, 'the corrupt one must not count as clean');
});

test('#477: a thread of fully readable verdicts reports nothing unreadable — the control', async () => {
  const reviews = [
    { state: 'COMMENTED', author: 'brain-reviewer', body: '```yaml\nprotocol: brain-review/1\nverdict: REVISE\nhead_sha: aaa\nrev: 0\n```' },
    { state: 'COMMENTED', author: 'bob', body: 'just a plain human comment' },
  ];
  const result = await gatherColdBoot({
    ...PR,
    reviewerHandle: 'brain-reviewer',
    deps: baseDeps({ fetchReviews: async () => reviews }),
  });
  assert.deepEqual(result.doctrine.unreadableVerdicts, [],
    'a false positive here would teach every reader to ignore the field inside a week');
});

test('#842: the detached review checkout dies with the process — the exit hook removes AND unregisters it', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'brain-review-op-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'brain-review-wt-'));
  t.after(() => {
    try { git(repo, 'worktree', 'prune'); } catch { /* best effort */ }
    removeTempTree(repo);
    removeTempTree(wtParent);
  });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'f.txt'), 'hi');
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-q', '-m', 'a');
  const sha = git(repo, 'rev-parse', 'HEAD');

  const hooks = [];
  const clone = defaultCloneDetached({ cwd: repo, fetch: () => {}, tmp: wtParent, _registerCleanup: (fn) => hooks.push(fn) })({ sha });
  assert.equal(hooks.length, 1, 'exactly one cleanup registered per checkout');
  assert.ok(existsSync(clone.worktreePath), 'the checkout exists while the review runs');

  hooks[0]();
  assert.ok(!existsSync(clone.worktreePath), 'the checkout is gone at exit');
  assert.ok(!git(repo, 'worktree', 'list').includes(clone.worktreePath), 'UNREGISTERED, not just deleted — a bare rm leaves a stale worktree entry');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), sha, 'the operator repo is untouched');
});

test('#843: many checkouts in one process share ONE exit listener — no MaxListeners warning at the 11th review', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'brain-review-op-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'brain-review-wt-'));
  t.after(() => {
    try { git(repo, 'worktree', 'prune'); } catch { /* best effort */ }
    removeTempTree(repo);
    removeTempTree(wtParent);
  });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'f.txt'), 'hi');
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-q', '-m', 'a');
  const sha = git(repo, 'rev-parse', 'HEAD');

  const before = process.listenerCount('exit');
  const clone = defaultCloneDetached({ cwd: repo, fetch: () => {}, tmp: wtParent });
  clone({ sha });
  clone({ sha });
  clone({ sha });
  assert.ok(process.listenerCount('exit') - before <= 1, 'three checkouts, at most ONE new exit listener');
});

test('#843 r2: a checkout someone rm\'d by hand still gets UNREGISTERED at exit — the failure branch, real git', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'brain-review-op-'));
  const wtParent = mkdtempSync(join(tmpdir(), 'brain-review-wt-'));
  t.after(() => {
    try { git(repo, 'worktree', 'prune'); } catch { /* best effort */ }
    removeTempTree(repo);
    removeTempTree(wtParent);
  });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'f.txt'), 'hi');
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-q', '-m', 'a');
  const sha = git(repo, 'rev-parse', 'HEAD');

  const hooks = [];
  const clone = defaultCloneDetached({ cwd: repo, fetch: () => {}, tmp: wtParent, _registerCleanup: (fn) => hooks.push(fn) })({ sha });

  // Someone (or a tmp reaper) deleted the checkout out from under git: the
  // `worktree remove` in the hook now FAILS — the branch round 2 caught untested.
  removeTempTree(clone.worktreePath);
  assert.ok(git(repo, 'worktree', 'list').includes(clone.worktreePath.split('/').pop()), 'precondition: the stale registration exists');

  hooks[0]();
  assert.ok(!git(repo, 'worktree', 'list').includes(clone.worktreePath.split('/').pop()),
    'the stale .git/worktrees/ entry is pruned — the operator repo never keeps a zombie registration');
});
