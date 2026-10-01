// locks.test.mjs — the DRIFT-GUARD for issue #473 slice 3's structural locks
// (REQ-473-7, REQ-473-8, REQ-473-9). Mirrors brain-promote.locks.test.mjs's
// shapes exactly (design.md §F2: reused PATTERN, not code).
//
// `brain:approve` posts a human signature as a durable comment. The locks
// below are what make that safe to automate:
//   - the non-TTY refusal is proven against a REAL child process with piped
//     stdio (an exit code alone is blind to "made a network call, then
//     failed");
//   - the no-bypass guarantee is proven BOTH behaviourally (every
//     `-`-prefixed token aborts, before any vcs call) AND structurally
//     (`process.env` occurs ZERO times);
//   - "no new port verb, no APPROVE review, no labels" cannot be a single
//     assertion — each is its own SITE/occurrence count (anti-pattern doc
//     §1: never a boolean where a number is checkable);
//   - the anti-stale re-read is proven by a SITE COUNT (`vcs.prView(`
//     appears exactly twice: compose, then re-read) — a mutation that
//     collapses the two into one call would still "have a headSha" and a
//     boolean-shaped test would not notice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIRMATION_WORD, parseArgs, runApprove } from './cli.mjs';
import { stripComments } from '../brain-promote.mjs';
import { gitlabApiConfig } from '../vcs/ci-context.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MODULE_PATH = join(REPO_ROOT, 'brain/scripts/approve/cli.mjs');
const SOURCE = readFileSync(MODULE_PATH, 'utf8');

const count = (haystack, needle) => haystack.split(needle).length - 1;

const HEAD_SHA = 'a'.repeat(40);

function makeVcs(overrides = {}, provider = 'gitlab') {
  const calls = { whoami: 0, prView: 0, mrList: 0, prReviewComment: 0, prReviews: 0 };
  const posted = { body: null };
  return {
    PROVIDER: provider,
    calls,
    posted,
    whoami: async (a) => { calls.whoami += 1; return overrides.whoami ? overrides.whoami(a) : { username: 'alice' }; },
    prView: async (a) => { calls.prView += 1; return overrides.prView ? overrides.prView(calls.prView, a) : { headRefOid: HEAD_SHA }; },
    mrList: async (a) => { calls.mrList += 1; return overrides.mrList ? overrides.mrList(a) : [{ number: 7, headBranch: 'feat/x' }]; },
    prReviewComment: async (a) => {
      calls.prReviewComment += 1;
      posted.body = a.body;
      return overrides.prReviewComment ? overrides.prReviewComment(a) : { url: 'https://example.test/1' };
    },
    prReviews: async (a) => {
      calls.prReviews += 1;
      if (overrides.prReviews) return overrides.prReviews(a, posted);
      return posted.body ? [{ state: 'COMMENTED', author: 'alice', body: posted.body }] : [];
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ-473-7 lock 1 — TTY, before anything else
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-473-7 lock 1: the REAL entry point on a REAL non-TTY exits non-zero and never touches the network', () => {
  const r = spawnSync(process.execPath, [MODULE_PATH], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  assert.notEqual(r.status, 0, `expected non-zero on a non-TTY; got ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /interactive terminal|non-TTY/i);
});

test('REQ-473-7 lock 1 (unit): isTTY:false refuses before any vcs call is made', async () => {
  const vcs = makeVcs();
  const res = await runApprove({
    argv: [],
    isTTY: false,
    project: 'o/r',
    getVcsFn: async () => vcs,
    readLineFn: async () => CONFIRMATION_WORD,
    write: () => {},
  });
  assert.notEqual(res.exitCode, 0);
  assert.equal(vcs.calls.whoami, 0, 'TTY gate must run before whoami');
  assert.equal(vcs.calls.prView, 0, 'TTY gate must run before any prView');
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-473-7 lock 2 — no bypass. Behavioural, then structural.
// ═══════════════════════════════════════════════════════════════════════════

const BYPASS_FLAGS = [
  '--yes', '-y', '--force', '-f', '--non-interactive', '--no-confirm',
  '--assume-yes', '--auto', '--confirm=SIGN', '--skip-confirmation',
];

for (const flag of BYPASS_FLAGS) {
  test(`REQ-473-7 lock 2: \`${flag}\` is an ABORT, not a bypass and not a silent no-op`, async () => {
    const vcs = makeVcs();
    let prompted = 0;
    const res = await runApprove({
      argv: [flag],
      isTTY: true,
      project: 'o/r',
      getVcsFn: async () => vcs,
      readLineFn: async () => { prompted += 1; return CONFIRMATION_WORD; },
      write: () => {},
    });
    assert.notEqual(res.exitCode, 0, `${flag} must abort even when the typed word would be supplied`);
    assert.equal(prompted, 0, `${flag} must abort BEFORE the prompt`);
    assert.equal(vcs.calls.whoami, 0, `${flag} must abort before touching the network`);
  });
}

test('REQ-473-7 lock 2: the module reads process.env ZERO times (kills the env-bypass CLASS)', () => {
  assert.equal(
    count(SOURCE, 'process.env'),
    0,
    'cli.mjs must not read the environment at all — identity comes from ambient vcs credentials only (design.md §F3)',
  );
});

test('REQ-473-7 lock 2: no bypass flag literal appears anywhere in the code (there is no branch to reach)', () => {
  for (const flag of ['--yes', '--force', '--non-interactive', '--assume-yes', '--no-confirm', '--auto']) {
    assert.equal(count(SOURCE, flag), 0, `'${flag}' must not appear in approve/cli.mjs`);
  }
});

test('REQ-473-7 lock 2: no BRAIN_HUMAN_TOKEN or new token env var (design.md §F3 — rejected)', () => {
  assert.equal(count(SOURCE, 'BRAIN_HUMAN_TOKEN'), 0);
  assert.equal(count(SOURCE, 'TOKEN_ENV'), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Cold-review round 1, Fix 1 (MAJOR) — every vcs call shares ONE resolved
// GitLab transport config. Before this fix, `whoami` resolved identity via
// ambient `glab` session credentials while `prView`/`prReviewComment`/
// `prReviews` fell back to `vcsToken()` + a hardcoded gitlab.com apiBase
// inside the provider — two different credential mechanisms. On self-hosted
// GitLab this broke entirely; even on gitlab.com the deny-check could
// evaluate an identity different from the one that ultimately posts.
//
// Cold-review round 2, Fix 1 (MAJOR) — the round-1 fix threaded
// `gitlabApiConfig()` UNCONDITIONALLY into every call site. Correct on
// GitLab (every site honors it — one credential source). WRONG on GitHub
// (this repo's ACTIVE provider, brain.config.json's `vcs.provider`):
// `whoami({token})` overrides identity to the TOKEN's account
// (axes/vcs/adapters/github.mjs:35-39) while `prView`/`mrList`/`prReviews`/
// `prReviewComment` ignore `token`/`apiBase`/`proxyUrl` entirely and use the
// ambient `gh` session — with `VCS_TOKEN` divergent from the `gh` login,
// whoami claims one identity and the post lands under another. Fix: thread
// `gitlabApiConfig()` ONLY when `vcs.PROVIDER === 'gitlab'` — mirrors
// identity.mjs's `defaultWhoami` guard exactly
// (`if (vcs.PROVIDER === 'gitlab') { ... }`). On GitHub every site receives
// `{}` — ambient `gh` everywhere, including whoami, never a token.
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-473-CONFIG (gitlab): whoami, prView (both calls), prReviewComment, and prReviews all receive the SAME threaded transport config object', async () => {
  // makeVcs's stubs already implement the correct compose→post→verify data
  // flow (posted body, matching author); this test only needs to WATCH the
  // args each call receives, so it wraps the real stubs rather than
  // reimplementing their behavior.
  const vcs = makeVcs({}, 'gitlab');
  const captured = { whoami: null, prView: [], prReviewComment: null, prReviews: null };
  const origWhoami = vcs.whoami;
  const origPrView = vcs.prView;
  const origPrReviewComment = vcs.prReviewComment;
  const origPrReviews = vcs.prReviews;
  vcs.whoami = async (a) => { captured.whoami = a; return origWhoami(a); };
  vcs.prView = async (a) => { captured.prView.push(a); return origPrView(a); };
  vcs.prReviewComment = async (a) => { captured.prReviewComment = a; return origPrReviewComment(a); };
  vcs.prReviews = async (a) => { captured.prReviews = a; return origPrReviews(a); };

  const res = await runApprove({
    argv: ['7'],
    isTTY: true,
    project: 'o/r',
    getVcsFn: async () => vcs,
    readLineFn: async () => CONFIRMATION_WORD,
    write: () => {},
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res));

  // Pinned against the REAL `gitlabApiConfig()` output, not merely against
  // each other — two call sites that both omit apiBase/token/proxyUrl would
  // be "equal" (all `undefined`) without threading ANYTHING, which would
  // make an equality-only assertion pass on the unfixed code too. Asserting
  // a concrete, non-empty `apiBase` is what makes this red against the
  // pre-fix code (each site got `{}`/`{project,number[,body]}` — no
  // apiBase key at all).
  const expected = gitlabApiConfig();
  assert.equal(typeof expected.apiBase, 'string');
  assert.ok(expected.apiBase.length > 0);

  const configShape = ({ apiBase, token, proxyUrl }) => ({ apiBase, token, proxyUrl });
  assert.deepEqual(configShape(captured.whoami), expected, 'whoami must receive the resolved transport config');
  assert.equal(captured.prView.length, 2, 'sanity: both prView calls were captured');
  for (const call of captured.prView) {
    assert.deepEqual(configShape(call), expected, 'prView must receive the SAME resolved transport config');
  }
  assert.deepEqual(configShape(captured.prReviewComment), expected, 'prReviewComment must receive the SAME resolved transport config');
  assert.deepEqual(configShape(captured.prReviews), expected, 'prReviews must receive the SAME resolved transport config');
});

test('REQ-473-CONFIG (gitlab, SITE completeness): mrList on the branch-resolution path receives the SAME threaded transport config', async () => {
  // The round-1 fix threaded five call sites; mrList lives on a PATH the
  // number-given fixture never reaches (argv omitted → resolve via branch),
  // which is exactly how a SITE slips a config sweep. This drives that path.
  const vcs = makeVcs({}, 'gitlab');
  let capturedMrList = null;
  const origMrList = vcs.mrList;
  vcs.mrList = async (a) => { capturedMrList = a; return origMrList(a); };

  const res = await runApprove({
    argv: [],
    isTTY: true,
    project: 'o/r',
    getVcsFn: async () => vcs,
    branchFn: () => 'feat/x',
    readLineFn: async () => CONFIRMATION_WORD,
    write: () => {},
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res));

  const expected = gitlabApiConfig();
  const configShape = ({ apiBase, token, proxyUrl }) => ({ apiBase, token, proxyUrl });
  assert.deepEqual(
    configShape(capturedMrList),
    expected,
    'mrList must receive the SAME resolved transport config as every other call site',
  );
});

test('REQ-473-CONFIG (github): whoami receives NO token key — ambient `gh` session decides identity, exactly like every other site', async () => {
  // github.mjs's whoami({token}) OVERRIDES identity to the token's account
  // when `token` is present (axes/vcs/adapters/github.mjs:35-39: `GH_TOKEN` env
  // override). Passing gitlabApiConfig()'s VCS_TOKEN here would silently
  // diverge whoami's identity from what the ambient `gh` session posts under.
  const vcs = makeVcs({}, 'github');
  let capturedWhoami = null;
  const origWhoami = vcs.whoami;
  vcs.whoami = async (a) => { capturedWhoami = a; return origWhoami(a); };

  const res = await runApprove({
    argv: ['7'],
    isTTY: true,
    project: 'o/r',
    getVcsFn: async () => vcs,
    readLineFn: async () => CONFIRMATION_WORD,
    write: () => {},
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.equal('token' in capturedWhoami, false, 'whoami must never be passed a `token` key on GitHub');
  assert.equal(capturedWhoami.token, undefined);
});

test('REQ-473-CONFIG (github): no call site receives a gitlab-derived apiBase — every site gets an empty config', async () => {
  const vcs = makeVcs({}, 'github');
  const captured = { whoami: null, prView: [], mrList: null, prReviewComment: null, prReviews: null };
  const origWhoami = vcs.whoami;
  const origPrView = vcs.prView;
  const origMrList = vcs.mrList;
  const origPrReviewComment = vcs.prReviewComment;
  const origPrReviews = vcs.prReviews;
  vcs.whoami = async (a) => { captured.whoami = a; return origWhoami(a); };
  vcs.prView = async (a) => { captured.prView.push(a); return origPrView(a); };
  vcs.mrList = async (a) => { captured.mrList = a; return origMrList(a); };
  vcs.prReviewComment = async (a) => { captured.prReviewComment = a; return origPrReviewComment(a); };
  vcs.prReviews = async (a) => { captured.prReviews = a; return origPrReviews(a); };

  // argv omitted (→ resolve via branch, exercising mrList) covers all 6 sites
  // in one run, same shape as the gitlab SITE-completeness test above.
  const res = await runApprove({
    argv: [],
    isTTY: true,
    project: 'o/r',
    getVcsFn: async () => vcs,
    branchFn: () => 'feat/x',
    readLineFn: async () => CONFIRMATION_WORD,
    write: () => {},
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.equal(captured.prView.length, 2, 'sanity: both prView calls were captured');

  const gitlabApiBase = gitlabApiConfig().apiBase;
  for (const [name, call] of [
    ['whoami', captured.whoami],
    ['mrList', captured.mrList],
    ['prView[0]', captured.prView[0]],
    ['prView[1]', captured.prView[1]],
    ['prReviewComment', captured.prReviewComment],
    ['prReviews', captured.prReviews],
  ]) {
    assert.equal(call.apiBase, undefined, `${name} must not receive a gitlab-derived apiBase on GitHub`);
    assert.notEqual(call.apiBase, gitlabApiBase, `${name} must not receive the gitlab apiBase value on GitHub`);
    assert.equal(call.token, undefined, `${name} must not receive a token on GitHub`);
    assert.equal(call.proxyUrl, undefined, `${name} must not receive a proxyUrl on GitHub`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Cold-review round 1, Fix 2 (MINOR) — behavioral env-bypass mirror of
// brain-promote.locks.test.mjs:133-165. Red-impossible against correct code
// by construction (cli.mjs reads process.env ZERO times by Lock 2 above) —
// its value is PINNING that future, the same rationale promote's own suite
// states for its BYPASS_ENV loop.
// ═══════════════════════════════════════════════════════════════════════════

const BYPASS_ENV = ['BRAIN_APPROVE_YES', 'CI', 'YES', 'NONINTERACTIVE', 'BRAIN_NON_INTERACTIVE'];

for (const name of BYPASS_ENV) {
  test(`REQ-473-7 lock 2 (behavioral): \`${name}\` in the environment does not skip or satisfy the prompt`, async () => {
    const had = Object.prototype.hasOwnProperty.call(process.env, name);
    const prev = process.env[name];
    process.env[name] = CONFIRMATION_WORD;
    const vcs = makeVcs();
    let prompted = 0;
    try {
      const res = await runApprove({
        argv: ['7'],
        isTTY: true,
        project: 'o/r',
        getVcsFn: async () => vcs,
        readLineFn: async () => { prompted += 1; return 'n'; },
        write: () => {},
      });
      // Liveness: if the env var short-circuited the gate, the prompt would
      // never have been reached — the count proves the bypass absent, not
      // merely the refusal (a wrong answer alone would also produce that).
      assert.equal(prompted, 1, `${name} must not short-circuit the prompt`);
      assert.notEqual(res.exitCode, 0);
      assert.equal(vcs.calls.prReviewComment, 0, 'nothing may post while an env var claims confirmation');
    } finally {
      if (had) process.env[name] = prev; else delete process.env[name];
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ-473-8 — head_sha race safety: SITE COUNT, not a boolean
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-473-8 SITE COUNT: `vcs.prView(` appears exactly twice — compose, then the anti-stale re-read', () => {
  // Enumerated from the CODE (anti-pattern doc: enumerate sites from the code,
  // not the sentence). A mutation that reuses the composed head instead of
  // re-reading it would collapse this to 1 and go undetected by any
  // boolean-shaped assertion.
  assert.equal(count(SOURCE, 'vcs.prView('), 2, 'exactly one compose read and one anti-stale re-read');
});

test('SITE COUNT: `vcs.prReviewComment(` appears exactly once — guards a future duplicate-post path', () => {
  assert.equal(count(SOURCE, 'vcs.prReviewComment('), 1, 'the post verb may only be called once per run');
});

test('SITE COUNT: `vcs.whoami(` appears exactly once — guards a second mid-run identity resolution', () => {
  assert.equal(count(SOURCE, 'vcs.whoami('), 1, 'identity must be resolved exactly once and reused, never re-checked mid-run');
});

test('REQ-473-8 (unit): head moved between compose and post → refuses, posts NOTHING', async () => {
  let prViewCall = 0;
  const vcs = makeVcs({
    prView: () => {
      prViewCall += 1;
      return prViewCall === 1 ? { headRefOid: HEAD_SHA } : { headRefOid: 'b'.repeat(40) };
    },
  });
  const res = await runApprove({
    argv: ['7'],
    isTTY: true,
    project: 'o/r',
    getVcsFn: async () => vcs,
    readLineFn: async () => CONFIRMATION_WORD,
    write: () => {},
  });
  assert.notEqual(res.exitCode, 0);
  assert.equal(vcs.calls.prReviewComment, 0, 'a stale head must never reach the post verb');
});

test('REQ-473-8 (unit): head unchanged → posts as composed', async () => {
  const vcs = makeVcs();
  const res = await runApprove({
    argv: ['7'],
    isTTY: true,
    project: 'o/r',
    getVcsFn: async () => vcs,
    readLineFn: async () => CONFIRMATION_WORD,
    write: () => {},
  });
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.equal(vcs.calls.prReviewComment, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-473-9 — no new port verb, no APPROVE review, zero labels
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-473-9: cli.mjs never calls labelAdd — this verb writes zero labels', () => {
  assert.equal(count(SOURCE, 'labelAdd'), 0, 'brain:approve must never write a label (design.md §F1 step 8 note)');
});

test('REQ-473-9: the prReviewComment call site passes no `event` key', () => {
  const idx = SOURCE.indexOf('vcs.prReviewComment(');
  assert.notEqual(idx, -1, 'the post verb must be called');
  const callSite = SOURCE.slice(idx, SOURCE.indexOf(')', SOURCE.indexOf('{', idx)) + 40);
  assert.doesNotMatch(callSite, /event\s*:/, 'no event key may be passed — event:\'COMMENT\' stays hardcoded provider-side');
});

test('REQ-473-9: "APPROVE" appears in CODE (stripped of comments) only as the block\'s `decision` value, never as a compared control token', () => {
  const stripped = stripComments(SOURCE);
  const codeOccurrences = [...stripped.matchAll(/APPROVE/g)].length;
  assert.equal(codeOccurrences, 1, `expected exactly one APPROVE literal in CODE (the decision value), found ${codeOccurrences}`);
  assert.doesNotMatch(stripped, /answer.*APPROVE|APPROVE.*===|CONFIRMATION_WORD\s*=\s*['"]APPROVE['"]/, 'APPROVE must never be a comparison/confirmation token');
});

test('REQ-473-9: brain:approve never imports or calls a new port verb — VERBS in vcs/cli.mjs is untouched by this change', () => {
  const vcsCliPath = join(REPO_ROOT, 'brain/scripts/vcs/cli.mjs');
  const vcsCliSource = readFileSync(vcsCliPath, 'utf8');
  assert.doesNotMatch(vcsCliSource, /'approve'|"approve"/, 'no new "approve" verb may be added to the VCS port');
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-473-7 — the confirmation is the typed word SIGN, compared exactly
// ═══════════════════════════════════════════════════════════════════════════

test('CONFIRMATION_WORD is the literal SIGN, not APPROVE (design.md §F4)', () => {
  assert.equal(CONFIRMATION_WORD, 'SIGN');
  assert.notEqual(CONFIRMATION_WORD, 'APPROVE');
  assert.ok(CONFIRMATION_WORD.length > 1);
});

const REFUSING_ANSWERS = [
  'y', 'Y', 'yes', 'YES', 'sign', 'Sign', 'sIGN', 'SIGN!', 'SIGNX',
  'SIGN ME', 'APPROVE', '', '\n', 'n', 'no', 'ok', '1', 'true', null, undefined,
];

for (const answer of REFUSING_ANSWERS) {
  test(`REQ-473-7 lock 4: answer ${JSON.stringify(answer)} aborts with ZERO posts`, async () => {
    const vcs = makeVcs();
    const res = await runApprove({
      argv: ['7'],
      isTTY: true,
      project: 'o/r',
      getVcsFn: async () => vcs,
      readLineFn: async () => answer,
      write: () => {},
    });
    assert.notEqual(res.exitCode, 0, `${JSON.stringify(answer)} must not be accepted`);
    assert.equal(vcs.calls.prReviewComment, 0, 'a declined run posts nothing at all');
  });
}

for (const answer of [CONFIRMATION_WORD, `  ${CONFIRMATION_WORD}  `, `${CONFIRMATION_WORD}\n`]) {
  test(`REQ-473-7 lock 4: answer ${JSON.stringify(answer)} is accepted (surrounding whitespace only)`, async () => {
    const vcs = makeVcs();
    const res = await runApprove({
      argv: ['7'],
      isTTY: true,
      project: 'o/r',
      getVcsFn: async () => vcs,
      readLineFn: async () => answer,
      write: () => {},
    });
    assert.equal(res.exitCode, 0, JSON.stringify(res));
    assert.equal(vcs.calls.prReviewComment, 1);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// parseArgs — pure unit
// ═══════════════════════════════════════════════════════════════════════════

test('parseArgs: no positionals → ok, number:null (resolve from branch)', () => {
  assert.deepEqual(parseArgs([]), { ok: true, number: null });
});

test('parseArgs: one numeric positional → ok, number set', () => {
  assert.deepEqual(parseArgs(['42']), { ok: true, number: 42 });
});

test('parseArgs: two positionals → error', () => {
  const r = parseArgs(['42', '43']);
  assert.equal(r.ok, false);
});

test('parseArgs: a non-numeric positional → error', () => {
  const r = parseArgs(['not-a-number']);
  assert.equal(r.ok, false);
});

test('parseArgs: any option-shaped token → error, regardless of position', () => {
  assert.equal(parseArgs(['--yes']).ok, false);
  assert.equal(parseArgs(['42', '--yes']).ok, false);
  assert.equal(parseArgs(['-y', '42']).ok, false);
});
