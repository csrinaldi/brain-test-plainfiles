// run-check.test.mjs — Unit tests for the thin run-check.mjs runner (REQ-L3-1, REQ-L3-2)
//
// CI FRAGILITY: never let these tests read real git state or the real cwd's
// .memory/ — always inject the fakes. The memory-gate is records-only as of
// C4/D4 (REQ-C4-4): the #227 transitional chunks/records union is retired, so
// the gate no longer accepts a `readChunks` dep at all. Memory-gate tests
// inject `readRecords` — never rely on a default that reads the real world
// (finding #10 — a fail-expecting test broke once real records/ existed).
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { runCheck, main, SUBCOMMAND_PORT_REACH } from './run-check.mjs';
import { mapDetectionToWarning } from './detection-policy.mjs';

async function captureLog(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try { await fn(); } finally { console.log = orig; }
  return logs;
}

// ── memory-gate — records-only (C4/D4, REQ-C4-4) ────────────────────────────
//
// The #227 transitional chunks/records union is retired: the gate computes
// its observation set from `records/` ALONE. `readChunkObservations` is no
// longer imported by run-check.mjs at all (pinned repo-wide by
// `brain/scripts/memory/chunk-boundary.test.mjs`, #247). `readRecords` is
// injectable so these tests never touch the real filesystem.

test('runCheck: memory-gate — records has session_summary → pass', async () => {
  const result = await runCheck('memory-gate', {
    readRecords: () => [{ type: 'session_summary', title: 'x' }],
  });
  // #1024: a clean pass now also names its path (no ctx at all here → the
  // pre-existing global presence fallback, unchanged in verdict).
  assert.equal(result.pass, true);
  assert.equal(result.path, 'presence');
});

test('runCheck: memory-gate — records have no session_summary → fail with reason', async () => {
  const result = await runCheck('memory-gate', {
    readRecords: () => [{ type: 'decision' }],
  });
  assert.equal(result.pass, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('runCheck: memory-gate — records empty → fail with reason', async () => {
  const result = await runCheck('memory-gate', {
    readRecords: () => [],
  });
  assert.equal(result.pass, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('runCheck: memory-gate — readRecords receives the injected cwd (uses injected reader, never a raw fs read)', async () => {
  let receivedCwd;
  await runCheck('memory-gate', {
    cwd: '/fake/cwd',
    readRecords: (cwd) => {
      receivedCwd = cwd;
      return [{ type: 'session_summary' }];
    },
  });
  assert.equal(receivedCwd, '/fake/cwd');
});

test('runCheck: memory-gate — only chunks has session_summary (records empty) → FAIL (chunks are no longer read, #227 union retired)', async () => {
  const result = await runCheck('memory-gate', {
    readChunks: () => [{ type: 'session_summary' }],
    readRecords: () => [],
  });
  assert.equal(result.pass, false, 'a readChunks dep, even if passed, must never be consulted — records/ alone decides the verdict');
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

// ── T2.1 (#1024): memory-gate reads the union of the PR tree and
// origin/<default>, per REQ-L3-4/REQ-L3-5. `readDefaultBranchRecords` and
// `fetchPrLabelEvents` are injected — no real git/VCS call in this file.

test('runCheck: memory-gate — a record only on origin/<default> satisfies the scoped check (path=retrieval, no rebase)', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [],
    readDefaultBranchRecords: () => ({
      records: [{ id: 'rec-1', issue: 1024, type: 'session_summary' }],
      error: null,
    }),
  });
  assert.equal(result.pass, true);
  assert.match(result.path, /^retrieval #1024/);
});

// #1024 Batch 3 MINOR (visibility): a full clone reads the LOCAL
// `refs/remotes/origin/<b>` without fetching — a stale ref must not read as
// current evidence. `pathDetail` states the source explicitly.
test('runCheck: memory-gate — pathDetail says "(fetched)" when the default-branch reader ran a live fetch (shallow checkout)', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [],
    readDefaultBranchRecords: () => ({
      records: [{ id: 'rec-1', issue: 1024, type: 'session_summary' }],
      error: null,
      fetched: true,
    }),
  });
  assert.equal(result.pass, true);
  assert.match(result.pathDetail, /records: pr-tree\+origin\/<default> \(fetched\)/);
});

test('runCheck: memory-gate — pathDetail says "(local ref, not fetched)" when the default-branch reader read a full clone\'s existing ref without fetching', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [],
    readDefaultBranchRecords: () => ({
      records: [{ id: 'rec-1', issue: 1024, type: 'session_summary' }],
      error: null,
      fetched: false,
    }),
  });
  assert.equal(result.pass, true);
  assert.match(result.pathDetail, /records: pr-tree\+origin\/<default> \(local ref, not fetched\)/);
});

test('runCheck: memory-gate — a record scoped in both trees with the same id yields a PARTIAL count of 1, not 2', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [{ id: 'rec-1', issue: 1024, type: 'decision' }],
    readDefaultBranchRecords: () => ({
      records: [{ id: 'rec-1', issue: 1024, type: 'decision' }],
      error: null,
    }),
  });
  assert.equal(result.pass, true);
  assert.match(result.reason, /1 memory record\(s\)/);
});

test('runCheck: memory-gate — a PR-tree HIT means the injected default-branch reader is never called (D3, lazy union)', async () => {
  let called = false;
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [{ id: 'rec-1', issue: 1024, type: 'session_summary' }],
    readDefaultBranchRecords: () => { called = true; return { records: [], error: null }; },
  });
  assert.equal(result.pass, true);
  assert.equal(called, false, 'the default-branch reader must never run when the PR tree alone is already a clean HIT');
});

test('runCheck: memory-gate — default branch unreadable AND a PR-tree miss exits 2 at standard (D5, fail closed)', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [],
    readDefaultBranchRecords: () => ({ records: [], error: 'git fetch origin main failed: fatal: boom' }),
    readConfig: () => ({ governance: { tier: 'standard' } }),
  });
  assert.equal(result.pass, false);
  assert.equal(result.uncomputable, true);
  assert.match(result.reason, /origin\/<default> is unreadable/i);
});

test('runCheck: memory-gate — default branch unreadable AND a PR-tree miss is STILL uncomputable at lite (mapDetectionToWarning never downgrades uncomputable — D5)', async () => {
  const code = await main('memory-gate', {
    ctx: { body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [],
    readDefaultBranchRecords: () => ({ records: [], error: 'git fetch origin main failed: fatal: boom' }),
    readConfig: () => ({ governance: { tier: 'lite' } }),
  });
  assert.equal(code, 2, 'an uncomputable result must exit 2 at every tier, including lite — never softened to a warning');
});

test('runCheck: memory-gate — default branch unreadable but the PR tree already has the hit → still passes, citing the PR-tree hit', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [{ id: 'rec-1', issue: 1024, type: 'session_summary' }],
    readDefaultBranchRecords: () => ({ records: [], error: 'git fetch origin main failed: fatal: boom' }),
  });
  assert.equal(result.pass, true);
});

test('runCheck: memory-gate — ctx.body is null with PR_NUMBER set exits 2 at standard (D6, uncomputable body)', async () => {
  const code = await main('memory-gate', {
    ctx: { prNumber: 42, body: null },
    readRecords: () => [],
    readConfig: () => ({ governance: { tier: 'standard' } }),
  });
  assert.equal(code, 2);
});

test('runCheck: memory-gate — ctx.body is null with PR_NUMBER set degrades to path=presence at lite (D6)', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { prNumber: 42, body: null },
    readRecords: () => [{ type: 'session_summary' }],
    readConfig: () => ({ governance: { tier: 'lite' } }),
  });
  assert.equal(result.pass, true);
  assert.equal(result.path, 'presence');
  assert.match(result.pathDetail, /PR description uncomputable/);
});

test('runCheck: memory-gate — regulated PARTIAL pass carries the evidence-gap suffix (D8)', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [{ id: 'rec-1', issue: 1024, type: 'decision' }],
    readDefaultBranchRecords: () => ({ records: [], error: null }),
    readConfig: () => ({ governance: { tier: 'regulated' } }),
  });
  assert.equal(result.pass, true);
  assert.match(result.reason, /evidence gap: the "regulated" tier declares issue-linked-session-summary/);
});

test('runCheck: memory-gate — the manifest reads true for memory-gate (D9)', () => {
  assert.equal(SUBCOMMAND_PORT_REACH['memory-gate'], true);
});

// ── skip:memory-gate override (REQ-L3-5) ────────────────────────────────────

test('runCheck: memory-gate — skip:memory-gate honored at standard, path=skipped, applier named', async () => {
  const result = await runCheck('memory-gate', {
    ctx: {
      body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main',
      labels: ['skip:memory-gate'], author: 'bob',
    },
    readRecords: () => [],
    readConfig: () => ({ governance: { tier: 'standard' } }),
    fetchPrLabelEvents: async () => [{ actor: { login: 'alice' }, action: 'add', label: 'skip:memory-gate' }],
  });
  assert.equal(result.pass, true);
  assert.equal(result.path, 'skipped');
  assert.match(result.pathDetail, /@alice/);
});

test('runCheck: memory-gate — skip:memory-gate refused at regulated, evaluation continues and fails on a scoped miss, refusal visible in the reason', async () => {
  const result = await runCheck('memory-gate', {
    ctx: {
      body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main',
      labels: ['skip:memory-gate'], author: 'bob',
    },
    readRecords: () => [],
    readDefaultBranchRecords: () => ({ records: [], error: null }),
    readConfig: () => ({ governance: { tier: 'regulated' } }),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /no.*scoped to issue #1024|no record scoped to #1024/);
  // #1024 Batch 3 MAJOR: the override's refusal must be visible on the
  // FAILING outcome too (REQ-L3-5/REQ-L3-4), not only inside the honored
  // branch — mirroring runDiffSizeCheck's size:exception tier-refusal append.
  assert.match(result.reason, /not honored at the "regulated" tier/);
});

test('runCheck: memory-gate — skip:memory-gate at lite is noted, not honored (the scoped miss stays a detection-only warning via main()), the note is visible in the printed reason', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let code;
  try {
    code = await main('memory-gate', {
      ctx: {
        body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main',
        labels: ['skip:memory-gate'], author: 'bob',
      },
      readRecords: () => [],
      readDefaultBranchRecords: () => ({ records: [], error: null }),
      readConfig: () => ({ governance: { tier: 'lite' } }),
    });
  } finally {
    console.log = orig;
  }
  assert.equal(code, 0, 'lite is detection-only — a scoped miss must still exit 0');
  // #1024 Batch 3 MAJOR: at lite, the label-present-but-not-consulted note
  // must be visible in the printed (warning) reason, not silently dropped.
  assert.equal(logs.length, 2);
  assert.match(logs[1], /not consulted at the "lite" tier/);
});

test('runCheck: memory-gate — the PR author applying skip:memory-gate is refused, evaluation continues, refusal visible even on a PASS', async () => {
  const result = await runCheck('memory-gate', {
    ctx: {
      body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main',
      labels: ['skip:memory-gate'], author: 'bob',
    },
    readRecords: () => [{ id: 'rec-1', issue: 1024, type: 'session_summary' }],
    readConfig: () => ({ governance: { tier: 'standard' } }),
    fetchPrLabelEvents: async () => [{ actor: { login: 'bob' }, action: 'add', label: 'skip:memory-gate' }],
  });
  // The author's own label is refused, but the PR tree already has a clean
  // hit on its own merits — the refusal must never turn an existing PASS
  // into a fail; it only means the SKIP path was not taken.
  assert.equal(result.pass, true);
  assert.notEqual(result.path, 'skipped');
  // #1024 Batch 3 MAJOR: the refusal must be visible on this PASS outcome
  // too — "append on every outcome (pass, warning, fail, uncomputable)".
  assert.match(result.reason, /PR author \(@bob\) is refused/);
});

test('runCheck: memory-gate — an UNLABELED PR still fails a scoped miss at standard, and the reason names skip:memory-gate as available (REQ-L3-5)', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #2048', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [],
    readDefaultBranchRecords: () => ({ records: [], error: null }),
    readConfig: () => ({ governance: { tier: 'standard' } }),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /skip:memory-gate is available/);
});

test('runCheck: memory-gate — ctx.labels === null (uncomputable) is never read as a skip, evaluation proceeds normally', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main', labels: null },
    readRecords: () => [{ id: 'rec-1', issue: 1024, type: 'session_summary' }],
  });
  assert.equal(result.pass, true);
  assert.notEqual(result.path, 'skipped');
});

// ── decision-gate ────────────────────────────────────────────────────────────

test('runCheck: decision-gate — injected diff has HOME.md but no ADR file → fail with reason', async () => {
  const result = await runCheck('decision-gate', {
    diffNameOnly: () => ['brain/HOME.md', 'src/other.mjs'],
    diffNameOnlyAdded: () => [],
  });
  assert.equal(result.pass, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('runCheck: decision-gate — injected diff has ADR file and HOME.md → pass', async () => {
  const result = await runCheck('decision-gate', {
    diffNameOnly: () => ['brain/project/decisions/adr-0099-foo.md', 'brain/HOME.md'],
    diffNameOnlyAdded: () => ['brain/project/decisions/adr-0099-foo.md'],
  });
  assert.deepEqual(result, { pass: true });
});

test('runCheck: decision-gate — injected diff touches neither ADR nor HOME.md → pass (non-architectural PR)', async () => {
  const result = await runCheck('decision-gate', {
    diffNameOnly: () => ['src/whatever.mjs'], diffNameOnlyAdded: () => [],
  });
  assert.deepEqual(result, { pass: true });
});

// ── decision-gate fail-closed when the diff cannot be computed ──────────────
//
// A REQUIRED gate must never silently pass just because its input could not
// be computed (missing BASE_SHA/HEAD_SHA env, or the git command throwing).
// diffNameOnly() throwing MUST fail the gate closed, not degrade to `[]`
// (which adrPresence would otherwise treat as a harmless empty diff → pass).

test('runCheck: decision-gate — diffNameOnly throws (diff uncomputable) → fail closed with reason', async () => {
  const result = await runCheck('decision-gate', {
    diffNameOnly: () => { throw new Error('BASE_SHA/HEAD_SHA not set'); },
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /cannot compute diff — failing closed/i);
});

test('runCheck: decision-gate — diffNameOnly throws → reason includes the underlying error message', async () => {
  const result = await runCheck('decision-gate', {
    diffNameOnly: () => { throw new Error('git exited with status 128'); },
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /git exited with status 128/);
});

// ── unknown check ────────────────────────────────────────────────────────────

test('runCheck: unknown check name throws', async () => {
  await assert.rejects(() => runCheck('not-a-real-check', {}), /unknown check/i);
});

// ── ci-context seam wiring (ADR-0016) — decision-gate reads ctx.baseSha/headSha ─
//
// The default diff-computation path now sources baseSha/headSha from an
// injected `deps.ctx` (built by ci-context.mjs's loadContext() at the CLI
// entrypoint) instead of reading process.env.BASE_SHA/HEAD_SHA directly.
// `deps.diffNameOnly` still overrides everything (existing tests above never
// pass `ctx` and are unaffected).

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) saved[k] = process.env[k];
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('runCheck: decision-gate — deps.ctx.baseSha/headSha take precedence over process.env.BASE_SHA/HEAD_SHA (ci-context seam)', async () => {
  await withEnv({ BASE_SHA: 'this-is-not-a-real-sha-xyz', HEAD_SHA: 'this-is-not-a-real-sha-abc' }, async () => {
    const result = await runCheck('decision-gate', { ctx: { baseSha: 'HEAD', headSha: 'HEAD' } });
    assert.deepEqual(result, { pass: true }, 'ctx.baseSha/headSha ("HEAD") must win over the bogus env values');
  });
});

test('runCheck: decision-gate — deps.ctx signaling null baseSha/headSha fails closed even when process.env.BASE_SHA/HEAD_SHA are set', async () => {
  await withEnv({ BASE_SHA: 'HEAD', HEAD_SHA: 'HEAD' }, async () => {
    const result = await runCheck('decision-gate', { ctx: { baseSha: null, headSha: null } });
    assert.equal(result.pass, false);
    assert.match(result.reason, /cannot compute diff — failing closed/i);
  });
});

// ── main() — exit-code + printed-reason smoke test ───────────────────────────

test('main: memory-gate passing → returns 0, prints the path line (#1024 — a clean pass now names its path, never nothing)', async () => {
  let code;
  const logs = await captureLog(async () => {
    code = await main('memory-gate', { readRecords: () => [{ type: 'session_summary' }] });
  });
  assert.equal(code, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^memory-gate: path=presence \(no PR context/);
});

test('main: memory-gate failing → returns 1, prints the reason', async () => {
  // The tier is now DECLARED here rather than inherited from whatever
  // brain.config.json this repository happens to carry (#603). It used to be
  // implicit, and that hid two things at once: the assertion depended on
  // brain's own tier, and at `lite` — brain's actual tier — this exit code was
  // the defect #603 fixes, not the contract. `standard` is where memory-gate
  // is `required`, which is what this test has always meant to pin. The lite
  // behaviour is pinned by its own test below.
  let code;
  const logs = await captureLog(async () => {
    code = await main('memory-gate', {
      readRecords: () => [],
      readConfig: () => ({ governance: { tier: 'standard' } }),
    });
  });
  assert.equal(code, 1);
  // #1024: a failing run now ALSO prints the path line (REQ-L3-4 — "every run
  // MUST name the path it took") ahead of the evaluator's own reason.
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^memory-gate: path=presence/);
  assert.ok(logs[1].length > 0);
});

test('main: decision-gate failing → returns 1, prints the reason', async () => {
  let code;
  const logs = await captureLog(async () => {
    code = await main('decision-gate', {
      diffNameOnly: () => ['brain/HOME.md'], diffNameOnlyAdded: () => [],
    });
  });
  assert.equal(code, 1);
  assert.ok(logs.length === 1 && logs[0].length > 0);
});

test('main: decision-gate passing (non-architectural PR) → returns 0, prints nothing', async () => {
  let code;
  const logs = await captureLog(async () => {
    code = await main('decision-gate', {
      diffNameOnly: () => ['src/foo.mjs'], diffNameOnlyAdded: () => [],
    });
  });
  assert.equal(code, 0);
  assert.deepEqual(logs, []);
});

test('main: decision-gate — diff uncomputable → returns 2 (PR5 contract), prints fail-closed reason', async () => {
  let code;
  const logs = await captureLog(async () => {
    code = await main('decision-gate', {
      diffNameOnly: () => { throw new Error('no BASE_SHA/HEAD_SHA'); },
    });
  });
  // PR5 (#310): an infra-uncomputable diff is 2, not a false violation (1).
  assert.equal(code, 2);
  assert.ok(logs.length === 1);
  assert.match(logs[0], /cannot compute diff — failing closed/i);
});

test('neutrality source-scan (REQ-NEUTRALITY-2): run-check.mjs source contains no .claude or SKILL.md literal', () => {
  const srcPath = fileURLToPath(new URL('./run-check.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.equal(src.includes('.claude'), false, 'source must not reference .claude');
  assert.equal(src.includes('SKILL.md'), false, 'source must not reference SKILL.md');
});

// ── Requirement 6 (issue #535) — run-check.mjs is an entry point, never a
//    library, with ONE named exception that has to keep earning itself ──
//
// THE PROPERTY. Per-subcommand resolution (workflow-auth.mjs, Requirement 3)
// reads `SUBCOMMAND_PORT_REACH` for a step that invokes run-check.mjs
// DIRECTLY. Any other CI-invoked entry point is resolved by its whole-file
// import closure instead, with no manifest of its own — so one that reaches
// run-check.mjs inherits every subcommand's port-reach at once, and the
// per-invocation precision this chain exists to buy is gone for that step.
//
// THE SHAPE, AND WHY IT IS NOT A REACHABILITY COMPUTATION. The obvious test
// is "compute which files CI executes, walk their imports, assert none reaches
// run-check.mjs". That form was written, reviewed cold, and REJECTED — every
// step of it under-approximates, and every under-approximation resolves toward
// "fine", which is `evidence-reader-empty-on-failure` three times over:
//
//   · `importClosure` prunes AT `vcs/ci-context.mjs` (the D1 cut vertex), so
//     `ci-context.mjs → any helper → run-check.mjs` is invisible. Proven by
//     mutation, twice, independently, via two different helpers.
//   · The entry-point extraction reads `.github/workflows` only, and this repo
//     ALSO ships `brain/scripts/ci/gitlab-governance.yml`, which invokes the
//     same seven entry points with `script:` lists (ADR-0018). Nothing there
//     was ever scanned.
//   · The extraction resolves `node <path>` and `npm run <verb>` and nothing
//     else — not `npm test`, not `bash wrapper.sh`, not `npx`, not a quoted
//     path. Each unrecognised spelling made the invariant agree with anything
//     on that route.
//
// So this reverts to the BLANKET source-text ban, which has no cut vertex, no
// YAML parsing and no spelling dependence, and pays for that bluntness with a
// single exception that is itself pinned in both directions.
//
// THE EXCEPTION. #546 (#340, merged after this chain branched) makes
// `brain-check.mjs` call `runCheck('issue-link', …)` ON PURPOSE: brain:check
// and CI must be ONE implementation of one rule. That is why the blanket form
// went red on the merge, and reverting the import would re-create the defect
// #340 exists to remove. It is safe for exactly one reason — `brain-check.mjs`
// is a local developer verb that NO CI SURFACE INVOKES — and that reason is a
// fact about the repo that can change without anyone noticing. So it is
// asserted, over-approximatingly and fail-closed: no CI file may so much as
// MENTION brain-check, comments included. The exception set is frozen and
// compared BOTH WAYS, so a second importer is red, and so is silently dropping
// this one.

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const SCRIPTS_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** CI surfaces, both providers. `.github/workflows/**` is GitHub; `brain/scripts/ci/**`
 *  is the GitLab fragment `.gitlab-ci.yml` includes (ADR-0018) — a first-class,
 *  dogfooded surface that the earlier reachability form of this test never read. */
const CI_DIRS = [join(REPO_ROOT, '.github', 'workflows'), join(REPO_ROOT, 'brain', 'scripts', 'ci')];

/** The one module allowed to import run-check.mjs, and why. Frozen: asserted by
 *  equality, so ADDING an importer and DROPPING this one are both red. */
const SANCTIONED_IMPORTERS = Object.freeze([join('brain', 'scripts', 'brain-check.mjs')]);

/** 5-line recursive walker — no readdirSync({ recursive: true }) version bet. */
function walkFiles(dir, ext) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, ext));
    else if (ext.test(entry.name)) out.push(full);
  }
  return out;
}

/** True when the source text pulls in run-check.mjs under ANY spelling — the
 *  static `from '…'` form and the dynamic `import('…')` form alike. The
 *  previous form of this predicate knew only the static one, so a real workflow
 *  entry point rewritten to `await import('../governance/run-check.mjs')` was
 *  invisible: the SPELLING axis the red-proof left unvaried. */
function importsRunCheck(src) {
  return /from\s+['"][^'"]*\brun-check\.mjs['"]/.test(src)
    || /\bimport\s*\(\s*['"][^'"]*\brun-check\.mjs['"]\s*\)/.test(src);
}

test('Requirement 6: run-check.mjs is imported by nothing outside its sanctioned exception', () => {
  const files = walkFiles(SCRIPTS_ROOT, /\.mjs$/).filter(
    f => !f.endsWith('.test.mjs') && !f.endsWith(join('governance', 'run-check.mjs'))
  );
  assert.ok(files.length > 100, `sanity: the walk must visit >100 files, visited ${files.length}`);
  const offenders = files
    .filter(f => importsRunCheck(readFileSync(f, 'utf8')))
    .map(f => relative(REPO_ROOT, f))
    .sort();
  assert.deepEqual(offenders, [...SANCTIONED_IMPORTERS].sort(),
    'run-check.mjs is an entry point, never a library. The only sanctioned importer is ' +
    'brain-check.mjs (#340: brain:check and CI are one implementation of one rule), and it is ' +
    'sanctioned only while no CI surface invokes it — see the test below. Both directions are ' +
    'asserted: a new importer is a violation, and so is this list drifting out of date.');
});

test('Requirement 6: the exception holds only while NO CI surface invokes brain-check — asserted, not assumed', () => {
  const ciFiles = CI_DIRS.flatMap(d => walkFiles(d, /\.ya?ml$/));
  assert.ok(ciFiles.length >= 5,
    `sanity: expected >=5 CI files across ${CI_DIRS.length} surfaces, found ${ciFiles.length}`);
  for (const marker of ['gitlab-governance.yml', 'governance.yml']) {
    assert.ok(ciFiles.some(f => f.endsWith(marker)),
      `sanity: ${marker} must be among the scanned CI files — a surface this test cannot see ` +
      `is a surface where the exception is unguarded`);
  }
  // A raw substring over the WHOLE file, comments included. Deliberately
  // over-approximating: a mention costs a false alarm and one line of thought,
  // while a missed invocation costs the invariant. No `run:`/`script:` parsing,
  // no command-spelling list — those are what made the previous form blind.
  const mentions = ciFiles
    .filter(f => /brain-check|brain:check/.test(readFileSync(f, 'utf8')))
    .map(f => relative(REPO_ROOT, f))
    .sort();
  assert.deepEqual(mentions, [],
    'a CI file mentions brain-check: if CI now invokes it, it is a CI entry point that reaches ' +
    'run-check.mjs by whole-file closure with no manifest of its own, and the #340 import must be ' +
    'replaced by an extraction rather than carried as an exception');
});

test('Requirement 6 mutation: importsRunCheck detects BOTH spellings, and the CI scan detects a mention', () => {
  assert.ok(importsRunCheck(`import { x } from '../governance/run-check.mjs';\n`),
    'the static import spelling must be detected');
  assert.ok(importsRunCheck(`const { x } = await import('../governance/run-check.mjs');\n`),
    'the dynamic import spelling must be detected — the axis the earlier red-proof left unvaried');
  assert.equal(importsRunCheck(`import { x } from './run-checker.mjs';\n`), false,
    'a similarly-named module must NOT match — an over-eager predicate would pass by flagging noise');
  assert.ok(/brain-check|brain:check/.test('    - run: npm run brain:check\n'),
    'the CI scan must detect an npm-verb invocation');
  assert.ok(/brain-check|brain:check/.test('    - node brain/scripts/brain-check.mjs\n'),
    'the CI scan must detect a direct node invocation, including in a GitLab script: list');
});

// ── SUBCOMMAND_PORT_REACH — the manifest matches the dispatch, symmetrically (T7) ──
//
// Per-subcommand resolution (workflow-auth.mjs, Requirement 3) trusts this
// manifest as the authority on which subcommand reaches the VCS port. That
// trust is only sound if the manifest's key set is EXACTLY the set of
// checkNames run-check.mjs actually dispatches — never a superset (a phantom
// entry) or a subset (an undeclared, silently-unresolvable subcommand).

function dispatchedCheckNames(src) {
  return [...src.matchAll(/checkName === '([\w-]+)'/g)].map(m => m[1]).sort();
}

test('T7: SUBCOMMAND_PORT_REACH keys sorted-equal the dispatched checkName cases, both directions', () => {
  const src = readFileSync(fileURLToPath(new URL('./run-check.mjs', import.meta.url)), 'utf8');
  const dispatched = dispatchedCheckNames(src);
  const manifestKeys = Object.keys(SUBCOMMAND_PORT_REACH).sort();
  assert.deepEqual(dispatched, manifestKeys,
    'run-check.mjs dispatches these checkNames but SUBCOMMAND_PORT_REACH does not declare exactly the same set');
});

test('T7 mutation: dispatchedCheckNames is a real extractor, not a constant — a synthetic dispatch branch is detected and breaks symmetry', () => {
  const src = readFileSync(fileURLToPath(new URL('./run-check.mjs', import.meta.url)), 'utf8');
  const withExtra = src + `\nif (checkName === 'frobnicate') {}\n`;
  const dispatched = dispatchedCheckNames(withExtra);
  assert.ok(dispatched.includes('frobnicate'), 'the extractor must detect the synthetic dispatch branch');
  assert.notDeepEqual(dispatched, Object.keys(SUBCOMMAND_PORT_REACH).sort(),
    'the symmetry check must report the gap once a dispatch branch has no manifest entry');
});

// ── SUBCOMMAND_PORT_REACH — the manifest's VALUES, and this scanner's LIMITS ──
//
// T7 above proves the KEY SET is live. It proves nothing about the booleans:
// workflow-auth.mjs trusts a true/false per subcommand completely (D4). T7b
// extracts each dispatch branch's handler name, walks that function's local
// call closure (mirroring importClosure's transitive-walk shape elsewhere in
// this codebase), and looks for getVcs/getVcsFn. A handler dispatched to an
// IMPORTED function (decision-gate → adrPresence) is resolved cross-file (#535).
//
// This is a TEXT scan, so its answer is only as wide as its vocabulary. Rounds
// 1-3 (#535 and after) each WIDENED that vocabulary and each left the same hole:
// an input the scanner could not resolve returned '', which tested false, which
// agreed with a manifest entry of false. The assert passed having checked
// nothing. #551 does not widen the vocabulary. It changes what happens at the
// EDGE of it, for a TOP-LEVEL dispatch call ONLY: bodyClosure/crossFileClosure
// return null there for "could not resolve" and '' only for "resolved, empty",
// and the loop below refuses a null BEFORE testing content — "Undecidable is a
// VIOLATION, never a pass" (vcs/lib/workflow-auth.mjs header), applied to the
// test that guards it. A callee reached WHILE walking an already-resolved body
// is a different case: its own unresolvability is absorbed by the
// accumulator's `?? ''` fallback, not refused — that is the gap route 6 below
// lives in, on purpose: propagating null through that recursion would make
// nearly every closure unresolvable (the walk hits `if(`, `for(`, `keys(`, …
// on almost every body) and this loop permanently red — see the fallback's
// own comment below for the accumulator/resolver contract this respects.
//
// DECIDABLE (this scanner RESOLVES to a string, not null, for these shapes —
// resolving is not the same as reading correctly; see the cross-file bullet
// and route 6 below):
//   • dispatch spelled `if (checkName === 'x')` with a `return <fn>(` in the branch,
//     including a branch inlined to call a governance handler directly — the
//     handler's own body/import still resolves normally
//   • handler declared as `function <fn>(` (async/export prefixes included)
//   • cross-file handler via a named, single-quoted, RELATIVE import — a real
//     RESOLUTION of the handler itself, not a completeness guarantee about
//     what it calls: the walk only re-enters the target module's OWN text, so
//     a helper THAT module calls, which this scanner cannot resolve (arrow-
//     declared, a second import hop, …), is absorbed by the `?? ''`
//     accumulator fallback and silently drops out of the answer — route 6
//     below reproduces exactly this against decision-gate → adrPresence
//   • the dispatch target IS the sentinel itself (`return getVcs()` /
//     `return getVcsFn()`) — a terminal reach, decided without walking a body
//     (#551: walking `getVcs`'s own implementation found no call to itself and
//     read as a resolved-empty '' — a fifth vacuous-pass route this file
//     shipped silently until this fix's base case closed it; see bodyClosure's
//     base case)
//
// NOT DECIDABLE — these now fail LOUD instead of passing vacuously:
//   • arrow / anonymous-expression handlers; default, namespace, double-quoted
//     or dynamic imports
//
// NOT DECIDABLE AND NOT DETECTED — the honest residuals:
//   • NAME SHADOWING/COLLISION: bodyClosure matches `function <name>(` by text
//     with no scope analysis, so a same-named local in a followed module can
//     yield a real-but-WRONG body — a confident wrong answer in either
//     direction. Text matching cannot decide this; only scope analysis or
//     behavioural proof can. Tracked in #569. The `getVcs`/`getVcsFn` sentinel
//     short-circuit (bodyClosure's terminal base case, #551) shares this same
//     no-scope-analysis limitation from the other side: it matches by NAME
//     only, with no module/origin check, so an unrelated function
//     coincidentally named `getVcs` would read as a terminal reach — this
//     fails in the SAFE direction (a spurious red), never silently (it cannot
//     produce a false pass).
//   • SWITCH / LOOKUP-TABLE DISPATCH: invisible to dispatchedCheckNames, so the
//     branch drops out of `dispatched` while the manifest keeps its key and T7's
//     symmetric deepEqual goes RED. Verified by live mutation at #551 apply
//     time, not inferred from the assert text. Sub-case NOT covered: a switch
//     migration AND an emptied manifest ([] === []) — see #569 (verified by
//     execution at #551 apply time that an empty SUBCOMMAND_PORT_REACH makes
//     parseSubcommandManifest return null, falling back to the whole-file
//     closure rule — D2's safe over-approximation in workflow-auth.mjs: it
//     raises false alarms, never misses; not covered by a committed
//     regression test here).
//   • ROUTE 6 (PR #571 review, NOT closed by this fix — see route 6's own
//     tests below and #569): a resolved-looking closure — a real, non-null
//     string — can still be WRONG, silently, because the accumulator absorbs
//     an unresolvable transitive callee rather than refusing it. Three shapes
//     reproduced against real production files:
//       - a transitively-called helper reached through an import this scanner
//         cannot follow (double-quoted, non-relative, dynamic, or a
//         re-export-with-rename) — the `?? ''` accumulator fallback absorbs
//         the unresolvability at ANY recursion depth, not just the top level;
//       - an arrow-declared helper inside checks/adr-presence.mjs, reached
//         from decision-gate's own handler chain: getVcs() is genuinely
//         called at runtime, SUBCOMMAND_PORT_REACH['decision-gate'] stays
//         false, and this suite stays green;
//       - a sentinel name that never appears contiguously in source text,
//         e.g. `const _n = 'get' + 'Vcs'; globalThis[_n]();` — nothing here
//         scans for string concatenation or dynamic property access.
//
// This list is this scanner's current limit as measured, not a claim of
// completeness. Six vacuous-pass routes have been found into this ONE defect
// across four review rounds; five were closed, each by naming and closing the
// specific shape that slipped through — not by a guarantee that no further
// shape exists — and the sixth (route 6 above) is NOT closed here, only named
// and added to the residuals. #569 (raised priority:high) names the
// structural answer: a runtime `getVcs` spy that proves reach by EXECUTION
// instead of by reading text. Until that lands, a resolved (non-null) closure
// from this scanner is not a guarantee the read is complete or correct —
// route 6 is proof of that, not a hypothetical. The narrower property this
// file can still promise: an entry this scanner cannot RESOLVE at the top
// level of a walk is refused as UNVERIFIED by the T7b gates below, rather
// than passing vacuously as '' the way it did before #551.

const GOVERNANCE_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * Walks `entryName`'s local call closure as TEXT.
 *
 * @returns {string|null}
 *   `null` — the entry could not be RESOLVED: no `function <entryName>(` declaration in `src`
 *            and no followable import of that name. NOT a statement about getVcs; a statement
 *            that no statement can be made. The caller MUST refuse it, never test it.
 *   `''`   — RESOLVED via the `seen` short-circuit: this name was already accounted for earlier
 *            in this walk. A real, usable answer meaning "no getVcs found here" — NOT a
 *            genuinely brace-empty body; the brace walk always consumes and includes the
 *            closing `}`, so `function f(ctx) {}` resolves to the literal string `"}"`, never `''`.
 *
 * The null sentinel is meaningful ONLY for a TOP-LEVEL call (fresh `seen`). Recursive callers
 * inside this module coerce it away on purpose — see the nullish-coalescing fallback at the
 * walk below (issue #551).
 */
function bodyClosure(src, entryName, seen = new Set(), dir = GOVERNANCE_DIR) {
  // TERMINAL BASE CASE (issue #551, fifth vacuous-pass route): the sentinel dispatched directly as the
  // handler itself (`return getVcs();` inlined into a dispatch branch) IS the reach —
  // do not attempt to RESOLVE it. Resolving `getVcs` walks to its OWN implementation in
  // vcs/cli.mjs, whose body naturally does not call itself, so the regex below would
  // read a real reach as a resolved-empty '' and agree with a false manifest entry
  // having checked nothing. This is not another vocabulary widening: every other
  // inlined target still resolves correctly (its body's call to getVcs is present in
  // its own text); getVcs is pathological precisely because its body cannot mention
  // itself.
  if (entryName === 'getVcs' || entryName === 'getVcsFn') return entryName;
  if (seen.has(entryName)) return '';
  const head = src.match(new RegExp(`function ${entryName}\\([^)]*\\)[^{]*\\{`));
  if (!head) return crossFileClosure(src, entryName, seen, dir);
  seen.add(entryName);
  let depth = 1, i = head.index + head[0].length;
  const start = i;
  while (depth > 0 && i < src.length) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
  const body = src.slice(start, i);
  let text = body;
  // ACCUMULATOR role (issue #551): an unresolvable transitive callee (if(, for(, keys(, ...)
  // must contribute '' here, not null, to preserve the RESOLVED/UNRESOLVABLE contract boundary
  // between this recursive walk and bodyClosure's top-level entry (see the contract above): the
  // walk tolerates an unresolvable inner name, the top-level caller does not. Note this fallback
  // is defensive, not load-bearing for a crash here — `text` is seeded as a string (`let text =
  // body`), so `text += x` always goes through JS's string-concatenation coercion; even a leaked
  // `null` would degrade to the literal substring "null" (harmless pollution the getVcs regex
  // below ignores), never turn `text` itself into `null`. The nullish-coalescing fallback below
  // is the ONLY coercion in this file; see bodyClosure's/crossFileClosure's contracts above/below
  // for why nowhere else may have one.
  for (const m of body.matchAll(/\b([a-zA-Z_]\w*)\(/g)) text += bodyClosure(src, m[1], seen, dir) ?? '';
  return text;
}

/**
 * Cross-file half of bodyClosure: follows an import to its module and walks THAT source for
 * `entryName` (T7b fix, issue #535).
 *
 * @returns {string|null} `null` when the name is not a followable import (absent, non-relative,
 *   or a spelling importMap does not read), when the module cannot be read, or when the target
 *   module does not resolve the origin name either (propagated from bodyClosure — issue #551:
 *   this propagation is INTENTIONAL and must not be coerced with a nullish-coalescing fallback
 *   here; doing so would restore a vacuous pass for every cross-file handler).
 */
function crossFileClosure(src, entryName, seen, dir) {
  const target = importMap(src).get(entryName);
  if (!target || !target.specifier.startsWith('.')) return null;
  const modulePath = resolve(dir, target.specifier);
  let modSrc;
  try {
    modSrc = readFileSync(modulePath, 'utf8');
  } catch {
    return null;
  }
  return bodyClosure(modSrc, target.orig, seen, dirname(modulePath));
}

/** Maps each locally-bound import name to its origin module specifier. */
function importMap(src) {
  const map = new Map();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (!name) continue;
      const [orig, alias] = name.split(/\s+as\s+/).map(s => s.trim());
      map.set(alias || orig, { orig, specifier: m[2] });
    }
  }
  return map;
}

// Tolerates BOTH the block-brace dispatch form and the single-line form
// (`if (checkName === 'x') return fn(ctx, deps);`, already used elsewhere in
// this codebase — actor-check.mjs, substrate.mjs). The completeness assert
// below is the load-bearing guarantee either way: nothing is silently
// dropped by the extraction format (WARNING, issue #535).
function dispatchedHandlers(src) {
  const heads = [...src.matchAll(/checkName === '([\w-]+)'\)\s*(?:\{|return\s+(\w+)\()/g)];
  return heads.map(({ index, 0: match, 1: checkName, 2: singleLineFn }, n) => {
    if (singleLineFn) return [checkName, singleLineFn];
    const end = heads[n + 1]?.index ?? src.length;
    const fn = src.slice(index, end).match(/\breturn (\w+)\(/);
    return [checkName, fn ? fn[1] : null];
  });
}

/**
 * Runs the T7b gate-guarded verification loop against `src`/`manifest`. Extracted (PR #571
 * review) so a regression test can drive a MUTATED source through the SAME two gates the T7b
 * test below relies on, instead of calling bodyClosure/crossFileClosure directly in isolation —
 * every prior "gate" test did the latter, which is why a reviewer deleting GATE 1, GATE 2, or
 * both from this loop left the suite at 100/100: nothing ran this loop on a source where a real
 * dispatch branch yields an unresolvable name or closure. See the two `T7b gate coverage` tests
 * below.
 */
function verifySubcommandPortReach(src, manifest) {
  const handlers = dispatchedHandlers(src);
  assert.deepEqual(handlers.map(([checkName]) => checkName).sort(), dispatchedCheckNames(src),
    'dispatchedHandlers extraction must be COMPLETE — a format-driven miss must fail loudly, never silently shrink this loop');
  for (const [checkName, fnName] of handlers) {
    // GATE 1 (site 1, issue #551): an unextractable handler NAME is not "does not reach the
    // port" — it is "nobody looked". `fnName != null &&` used to fold it into false.
    assert.ok(typeof fnName === 'string',
      `${checkName}: dispatchedHandlers extracted NO handler function name from this dispatch ` +
      `branch, so SUBCOMMAND_PORT_REACH['${checkName}'] is UNVERIFIED. This assert does not say ` +
      `the manifest value is wrong — it says nothing checked it. The branch shape is outside this ` +
      `scanner's decidable domain: it reads \`return <fn>(\` inside an \`if (checkName === '...')\` ` +
      `branch. Restore that shape, widen dispatchedHandlers for the new one, or verify the reach ` +
      `behaviourally — but do not restore \`fnName != null &&\`, which folded this case into ` +
      `"false" and agreed with a false manifest entry. Undecidable is a VIOLATION, never a pass ` +
      `(brain/scripts/vcs/lib/workflow-auth.mjs header).`);

    const closure = bodyClosure(src, fnName);
    // GATE 2 (sites 2/3). `typeof === 'string'`, NEVER `assert.ok(closure)`: '' is a RESOLVED
    // value (see the seen-guard case above) and must stay green.
    assert.ok(typeof closure === 'string',
      `${checkName} (${fnName}): no call closure could be RESOLVED for this handler, so ` +
      `SUBCOMMAND_PORT_REACH['${checkName}'] is UNVERIFIED. The manifest value is not being ` +
      `reported as wrong — it is being reported as unchecked. \`${fnName}\` matched neither a ` +
      `\`function ${fnName}(\` declaration in run-check.mjs nor a named, single-quoted, relative ` +
      `import this scanner can follow. Widen the scanner for that shape, or prove the reach ` +
      `behaviourally; do not make this green by letting unresolvable read as '' again — that is ` +
      `the defect of issue #551 and of the three rounds before it.`);

    const reaches = /\bgetVcs(Fn)?\b/.test(closure);
    assert.equal(reaches, manifest[checkName],
      `${checkName} (${fnName}): manifest says ${manifest[checkName]}, resolved ` +
      `source scan says ${reaches}. The closure WAS resolved, so this is a genuine disagreement, ` +
      `not an extraction miss — fixing it by editing SUBCOMMAND_PORT_REACH is a separate finding ` +
      `that needs its own issue, not a quiet edit.`);
  }
}

test('T7b: SUBCOMMAND_PORT_REACH values match each handler\'s own local getVcs reach, not just its key set', () => {
  const src = readFileSync(fileURLToPath(new URL('./run-check.mjs', import.meta.url)), 'utf8');
  verifySubcommandPortReach(src, SUBCOMMAND_PORT_REACH);
});

// ── #1024 (D9) retarget: memory-gate NOW legitimately reaches getVcs (the
// applier read for skip:memory-gate, via a named defaultFetchPrLabelEvents
// function the handler calls), so SUBCOMMAND_PORT_REACH['memory-gate'] flips
// to `true`. A mutation test whose PREMISE is "a false-declared handler
// suddenly appears to reach getVcs" no longer says anything about
// memory-gate — that premise now holds for real, by design. These five T7b
// gate/mutation tests are retargeted to `decision-gate`, which STAYS `false`
// (D9) and keeps the exact dispatch shape (`if (checkName === 'decision-gate')
// { ... return adrPresence(changedFiles, addedFiles); }`) these gates guard.
// decision-gate's handler is CROSS-FILE (adrPresence, checks/adr-presence.mjs)
// rather than a local function declaration the way memory-gate's own
// runMemoryGateCheck used to be — the "arrow-form"/"getVcs injected" mutations
// below build a synthetic cross-file module (mirroring the existing
// "T7b sentinel: crossFileClosure's tail call PROPAGATES null" fixture
// pattern already in this file) rather than mutating run-check.mjs's own
// text for those two, since there is no local handler declaration left to
// mutate for a cross-file dispatch.

test('T7b gate coverage: GATE 1 fires inside the ACTUAL loop when a dispatch branch has no extractable handler name', () => {
  // Same mutation as "T7b site 1" below (no `return fn(` left in the branch), but driven through
  // verifySubcommandPortReach itself — the shared loop GATE 1 guards — not through
  // dispatchedHandlers alone. Deleting GATE 1 from that function makes this go green; restoring
  // it makes this go red again (verified by mutation at apply time — see the PR description).
  const src = readFileSync(fileURLToPath(new URL('./run-check.mjs', import.meta.url)), 'utf8');
  const mutated = src.replace(
    '    return adrPresence(changedFiles, addedFiles);',
    '    const result = adrPresence(changedFiles, addedFiles);\n    return result;',
  );
  assert.notEqual(mutated, src, 'the mutation must land');
  // GATE 1's message specifically, not the generic /UNVERIFIED/ both gates' messages share —
  // a null fnName also makes bodyClosure resolve to null, so GATE 2 backstops a missing GATE 1
  // on THIS fixture; a loose regex would stay green with GATE 1 deleted and prove nothing.
  assert.throws(() => verifySubcommandPortReach(mutated, SUBCOMMAND_PORT_REACH),
    /extracted NO handler function name/,
    'GATE 1 must refuse a dispatch branch with no extractable handler name from inside the actual loop');
});

test('T7b gate coverage: GATE 2 fires inside the ACTUAL loop when the cross-file handler\'s import cannot be resolved (double-quoted, outside importMap\'s decidable domain)', () => {
  const src = readFileSync(fileURLToPath(new URL('./run-check.mjs', import.meta.url)), 'utf8');
  const mutated = src.replace(
    "import { adrPresence } from './checks/adr-presence.mjs';",
    'import { adrPresence } from "./checks/adr-presence.mjs";',
  );
  assert.notEqual(mutated, src, 'the mutation must land');
  assert.throws(() => verifySubcommandPortReach(mutated, SUBCOMMAND_PORT_REACH),
    /no call closure could be RESOLVED/,
    'GATE 2 must refuse a cross-file handler whose import this scanner cannot follow (single-quoted only, by design)');
});

test('T7b mutation: a getVcs( reference injected into decision-gate\'s (false-declared) cross-file handler is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-check-t7b-decision-gate-'));
  try {
    writeFileSync(
      join(dir, 'fake-adr-presence.mjs'),
      'export function adrPresence(changedFiles, addedFiles) {\n  getVcs();\n  return { pass: true };\n}\n',
      'utf8',
    );
    const fixtureSrc =
      "import { adrPresence } from './fake-adr-presence.mjs';\n" +
      "if (checkName === 'decision-gate') {\n    return adrPresence(changedFiles, addedFiles);\n}\n";
    const closure = bodyClosure(fixtureSrc, 'adrPresence', new Set(), dir);
    assert.ok(typeof closure === 'string', 'adrPresence must still resolve under this mutation');
    const reaches = /\bgetVcs(Fn)?\b/.test(closure);
    assert.equal(reaches, true);
    assert.notEqual(reaches, SUBCOMMAND_PORT_REACH['decision-gate'],
      'the mutation must break the value correlation for a false-declared handler');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T7b mutation (#551, fifth vacuous-pass route): a dispatch branch inlined to call the sentinel directly is a REACH, not a resolved-empty closure', () => {
  // Reproduces the FIFTH vacuous-pass route: `return getVcs();` inlined straight into the
  // decision-gate dispatch branch. Before bodyClosure's terminal base case, `fnName` resolved
  // to 'getVcs', which has no LOCAL declaration in run-check.mjs, so bodyClosure fell through
  // to crossFileClosure, followed the import to vcs/cli.mjs, and successfully resolved
  // getVcs's OWN implementation body — which naturally does not call itself. That real,
  // non-null closure tested false against the getVcs regex and agreed with the manifest's
  // `false` for decision-gate, having verified nothing.
  const src = readFileSync(fileURLToPath(new URL('./run-check.mjs', import.meta.url)), 'utf8');
  const mutated = src.replace('    return adrPresence(changedFiles, addedFiles);', '    return getVcs();');
  assert.notEqual(mutated, src, 'the mutation must land');
  const closure = bodyClosure(mutated, 'getVcs');
  assert.ok(typeof closure === 'string', 'the sentinel dispatched directly must still resolve — as a REACH, not as undecidable');
  const reaches = /\bgetVcs(Fn)?\b/.test(closure);
  assert.equal(reaches, true, 'dispatching the sentinel directly IS the reach; it must never read as "no getVcs found"');
  assert.notEqual(reaches, SUBCOMMAND_PORT_REACH['decision-gate'],
    'the mutation must break the value correlation for a false-declared handler — this is the assertion ' +
    'that previously passed vacuously (issue #551, fifth vacuous-pass route)');
});

// ── T7b sentinel — issue #551: an unresolvable closure must be null, never '' ──
//
// The tests below pin the RESOLVER/ACCUMULATOR split (design §1.1): bodyClosure
// and crossFileClosure return `null` when an entry cannot be RESOLVED at all, and
// `''` only via the `seen` short-circuit — a name already accounted for earlier
// in this walk (a genuinely brace-empty body is NOT `''`; see the fixture below).
// `null` must stay confined to top-level resolution — an unresolvable
// transitive callee inside an already-resolved body must still contribute `''` to
// the accumulator, not `null` (contract boundary, not a crash-prevention measure —
// see the `?? ''` fallback's comment above for why a leaked `null` here would only
// degrade to harmless literal text, never make `text` itself non-string).

test('T7b sentinel: an entry that cannot be resolved is null, never \'\'', () => {
  assert.equal(bodyClosure('const x = 1;\n', 'runMemoryGateCheck'), null,
    'unresolvable must not read as "no getVcs" — that conflation is issue #551');
});

test('T7b sentinel: a name already resolved earlier in this walk is \'\', not null', () => {
  // Empirically verified (not assumed): the `seen` guard at bodyClosure's
  // top (unchanged by #551) is the reliable source of a literal '' RESOLVED
  // value — a genuinely brace-empty function body (`{}`) is NOT a clean ''
  // here (the brace-walk includes the closing brace itself, a pre-existing
  // extractor property this PR does not touch), so this fixture exercises
  // the SAME contract (resolved, falsy, must not be rejected by gate 2)
  // through the path that actually produces it.
  const c = bodyClosure('function f(ctx) { return 1; }\n', 'f', new Set(['f']));
  assert.equal(c, '');
  assert.equal(typeof c, 'string');
  assert.equal(/\bgetVcs(Fn)?\b/.test(c), false);
});

test('T7b sentinel: an import spelling this scanner cannot follow is null, not \'\'', () => {
  const fixture = 'import { adrPresence } from "./checks/adr-presence.mjs";\n';
  assert.equal(bodyClosure(fixture, 'adrPresence'), null,
    'a double-quoted import is outside importMap\'s decidable domain (single-quoted only) — ' +
    'that must report as UNVERIFIED, never as a resolved empty closure');
});

test('T7b sentinel: an unreadable target module is null, not \'\'', () => {
  const fixture = "import { x } from './definitely-not-here.mjs';\n";
  assert.equal(bodyClosure(fixture, 'x'), null);
});

test('T7b guard: getVcs is still detected alongside unresolvable transitive callees, and the accumulator never leaks the literal "null"', () => {
  // Promoted from a documentation pin (issue #551): the `?? ''` fallback at the accumulator
  // (bodyClosure's recursion site) had ZERO test coverage. Removing it makes an unresolvable
  // transitive callee (if(, keys(, forEach() below) coerce through `text += null` — JS string
  // concatenation turns a leaked `null` into the literal substring "null" appended to the
  // closure, rather than propagating `null` itself (harmless to the getVcs regex, but a real,
  // previously-unverified behaviour of this accumulator). The assertion on `!closure.includes
  // ('null')` is what makes this a live guard rather than a pin: it flips RED when that
  // fallback is removed (verified by mutation at #551 apply time), where the bare
  // "getVcs is still detected" assertion below does not.
  const fixture = 'function h(ctx) {\n  if (ctx) { Object.keys(ctx).forEach(k => k); }\n  return getVcs();\n}\n';
  const closure = bodyClosure(fixture, 'h');
  assert.equal(typeof closure, 'string');
  assert.ok(/\bgetVcs(Fn)?\b/.test(closure));
  assert.ok(!closure.includes('null'),
    'the accumulator must never let an unresolvable transitive callee leak the literal "null" ' +
    'into the closure text — this is the `?? \'\'` fallback at the recursion site, previously ' +
    'uncovered by any test in this file');
});

test('T7b sentinel: crossFileClosure\'s tail call PROPAGATES null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-check-t7b-'));
  try {
    writeFileSync(join(dir, 'mod.mjs'), 'const target = () => {};\n', 'utf8');
    const caller = "import { target } from './mod.mjs';\n";
    assert.equal(bodyClosure(caller, 'target', new Set(), dir), null,
      'a name resolved to a module that does not declare it must stay null — a `?? \'\'` at the ' +
      'crossFileClosure tail call would restore the vacuous pass for every cross-file handler');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T7b site 1: a dispatch branch with no extractable handler name yields null — and the key-completeness assert stays GREEN on that input', () => {
  const src = readFileSync(fileURLToPath(new URL('./run-check.mjs', import.meta.url)), 'utf8');
  const mutated = src.replace(
    '    return adrPresence(changedFiles, addedFiles);',
    '    const result = adrPresence(changedFiles, addedFiles);\n    return result;',
  );
  assert.notEqual(mutated, src, 'the mutation must land');
  const handlers = dispatchedHandlers(mutated);
  const entry = handlers.find(([checkName]) => checkName === 'decision-gate');
  assert.equal(entry[1], null);
  assert.deepEqual(handlers.map(([checkName]) => checkName).sort(), dispatchedCheckNames(mutated),
    'the completeness assert stays green on this input — which is precisely why site 1 needs its ' +
    'own gate and GATE 1 (the `typeof fnName === \'string\'` assert in the T7b test) cannot ' +
    'substitute for it, since GATE 1 never runs on this fixture at all');
});

test('T7b mutation (#551): an arrow-form cross-file handler is REFUSED as unresolvable, not read as "no getVcs"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-check-t7b-decision-gate-arrow-'));
  try {
    writeFileSync(
      join(dir, 'fake-adr-presence.mjs'),
      'export const adrPresence = (changedFiles, addedFiles) => {\n  if (process.env.NEVER === "1") getVcs();\n  return { pass: true };\n};\n',
      'utf8',
    );
    const fixtureSrc =
      "import { adrPresence } from './fake-adr-presence.mjs';\n" +
      "if (checkName === 'decision-gate') {\n    return adrPresence(changedFiles, addedFiles);\n}\n";
    assert.equal(bodyClosure(fixtureSrc, 'adrPresence', new Set(), dir), null,
      "before #551 this returned '', which tested false and agreed with " +
      "SUBCOMMAND_PORT_REACH['decision-gate'] === false — a green that had checked nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// SUBCOMMAND_PORT_REACH['memory-gate'] is now `true` (D9): the applier read
// for skip:memory-gate reaches getVcs through a NAMED function declaration
// (defaultFetchPrLabelEvents) the handler calls — mirroring issue-link's own
// defaultFetchIssue pattern, which T7b already resolves correctly.
test('T7b: memory-gate is now a genuine getVcs reach (D9) — the manifest agrees with the resolved source scan', () => {
  const src = readFileSync(fileURLToPath(new URL('./run-check.mjs', import.meta.url)), 'utf8');
  assert.equal(SUBCOMMAND_PORT_REACH['memory-gate'], true);
  assert.equal(SUBCOMMAND_PORT_REACH['decision-gate'], false);
  const handlers = dispatchedHandlers(src);
  const [, fnName] = handlers.find(([checkName]) => checkName === 'memory-gate');
  const closure = bodyClosure(src, fnName);
  assert.ok(typeof closure === 'string');
  assert.equal(/\bgetVcs(Fn)?\b/.test(closure), true,
    'runMemoryGateCheck\'s own closure must mention getVcs/getVcsFn via defaultFetchPrLabelEvents');
});

test('runCheck: an unknown check name throws even when it superficially resembles a manifest key', () => {
  return assert.rejects(() => runCheck('frobnicate', {}), /unknown check/i);
});

// ── issue-link — THE GOTCHA (issue #231 A2 phase 2, design.md Decision 2) ──
//
// GitLab has no CI_MERGE_REQUEST_DESCRIPTION var and CI_MERGE_REQUEST_LABELS
// freezes at pipeline creation (ADR-0016:45), so issue-link cannot be bash on
// GitLab. run-check.mjs's issue-link case calls the EXISTING pure evaluator
// issueLink(ctx.body) for the reference pattern, THEN verifies the referenced
// issue carries the resolved approved label via an injectable `fetchIssue`
// dep — never a real network call in tests. `readConfig` is injectable too so
// resolveApprovedLabel() never touches the real brain.config.json.

test('runCheck: issue-link — body has "Part of #231", referenced issue carries the approved label → pass (fresh ctx.labels via fetchIssue, never CI_MERGE_REQUEST_LABELS)', async () => {
  // Slice target (targetBranch !== defaultBranch) — "Part of #N" alone is
  // the accepted pattern for a chained-PR slice (task 2.1's original scope).
  const result = await runCheck('issue-link', {
    ctx: { body: 'feat: slice\n\nPart of #231', provider: 'gitlab', targetBranch: 'feature/tracker', defaultBranch: 'main' },
    fetchIssue: async (issueNumber) => {
      assert.equal(issueNumber, 231);
      return { labels: ['status::approved'] };
    },
    readConfig: () => ({}),
  });
  assert.deepEqual(result, { pass: true });
});

test('runCheck: issue-link — body has "Closes #42", referenced issue carries the approved label → pass', async () => {
  // Default-branch target — a closing keyword satisfies both the generic
  // pattern check AND the (addendum) default-branch closing-keyword policy.
  const result = await runCheck('issue-link', {
    ctx: { body: 'fix: bug\n\nCloses #42', provider: 'github', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  assert.deepEqual(result, { pass: true });
});

test('runCheck: issue-link — referenced issue does NOT carry the approved label → fail with reason', async () => {
  const result = await runCheck('issue-link', {
    ctx: { body: 'Part of #5', provider: 'gitlab', targetBranch: 'feature/tracker', defaultBranch: 'main' },
    fetchIssue: async () => ({ labels: ['status::in-review'] }),
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('runCheck: issue-link — fetchIssue throws (network/API failure) → fail closed with reason', async () => {
  const result = await runCheck('issue-link', {
    ctx: { body: 'Closes #9', provider: 'gitlab', targetBranch: 'feature/tracker', defaultBranch: 'main' },
    fetchIssue: async () => { throw new Error('GitLab MR API failed: 500'); },
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /failing closed/i);
});

// ── issue-link — REQUIRED fail-closed on null body (task 2.2) ──────────────

test('runCheck: issue-link — ctx.body is null (uncomputable) → fails closed, never passes (REQUIRED gate)', async () => {
  const result = await runCheck('issue-link', {
    ctx: { body: null, provider: 'gitlab' },
    fetchIssue: async () => { throw new Error('must not be called — body is null'); },
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  // Self-diagnostic message: a null body means the context API fetch failed
  // (token/endpoint), NOT a missing issue reference — the two must be
  // distinguishable in a failing pipeline log.
  assert.match(result.reason, /MR body uncomputable \(context API fetch failed\) — failing closed/);
});

test('main: issue-link — ctx.body is null → returns 2 (PR5: uncomputable, never 0/1) on the REQUIRED gate', async () => {
  const code = await main('issue-link', {
    ctx: { body: null, provider: 'gitlab' },
    fetchIssue: async () => { throw new Error('must not be called'); },
    readConfig: () => ({}),
  });
  assert.equal(code, 2); // PR5: a non-string body (API fetch failed) is uncomputable
});

test('runCheck: issue-link — body with no reference at all → fail, referenced-issue fetch never attempted', async () => {
  let fetchCalled = false;
  const result = await runCheck('issue-link', {
    ctx: { body: 'Some PR description without any link', provider: 'gitlab' },
    fetchIssue: async () => { fetchCalled = true; return { labels: [] }; },
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  // A non-null body with no reference is a GENUINE governance miss — distinct
  // from the null-body (uncomputable) case above.
  assert.match(result.reason, /no issue reference found/);
  assert.equal(fetchCalled, false, 'fetchIssue must not be called when the body carries no reference');
});

test('runCheck: issue-link — defaultFetchIssue selects the provider from ctx.provider, not the config default (finding #14 — GitLab job must not dispatch to the github provider)', async () => {
  let received;
  const fakeVcs = { issueView: async () => ({ iid: 1, labels: ['status::approved'] }) };
  const result = await runCheck('issue-link', {
    // slice target (feature branch) so "Closes #1" passes; provider = the RUNTIME
    // platform hosting the MR (gitlab), which must win over any config default.
    ctx: {
      body: 'Closes #1', provider: 'gitlab', repo: 'x/y',
      targetBranch: 'feature/tracker', defaultBranch: 'main',
    },
    getVcs: async (opts) => { received = opts; return fakeVcs; },
    readConfig: () => ({ governance: { approvedLabel: 'status:approved' } }),
  });
  assert.deepEqual(received, { provider: 'gitlab' }, 'getVcs must be called with the runtime ctx.provider');
  assert.equal(result.pass, true);
});

// ── issue-link — default-branch-conditional (issue #231 A2 phase 2 ADDENDUM) ─
//
// GAP CLOSED: GitHub bash (governance.yml:45-70) is base-branch-conditional —
// base=='main' requires a CLOSING keyword ONLY (Part of #N alone is rejected);
// base!='main' (slice) accepts EITHER. The pure issueLink() evaluator is NOT
// base-branch-aware (by design — REQ-CIC-4, it stays UNCHANGED), so without
// this wrapper-level conditional, a "Part of #N"-only body would wrongly PASS
// the Node path even when targeting the default branch. This wires
// ctx.targetBranch === ctx.defaultBranch through the WRAPPER, never the pure
// evaluator.

test('runCheck: issue-link — target IS the default branch, body has ONLY "Part of #N" (no closing keyword) → FAIL (closing keyword required)', async () => {
  // fetchIssue DELIBERATELY returns the approved label (a would-otherwise-pass
  // result) so this test only goes GREEN because of the closing-keyword
  // policy itself — never because the fetch happened to fail for some other
  // reason (that would be a false-positive RED).
  const result = await runCheck('issue-link', {
    ctx: { body: 'feat: slice\n\nPart of #42', provider: 'github', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('runCheck: issue-link — target IS the default branch, body has "Closes #N" → PASS (closing keyword satisfies the default-branch policy)', async () => {
  const result = await runCheck('issue-link', {
    ctx: { body: 'fix: thing\n\nCloses #42', provider: 'github', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  assert.deepEqual(result, { pass: true });
});

test('runCheck: issue-link — target is NOT the default branch (slice), body has ONLY "Part of #N" → PASS (existing chained-PR pattern preserved)', async () => {
  const result = await runCheck('issue-link', {
    ctx: { body: 'feat: slice\n\nPart of #42', provider: 'github', targetBranch: 'feature/tracker', defaultBranch: 'main' },
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  assert.deepEqual(result, { pass: true });
});

// ── issue-link — FAIL-CLOSED on null defaultBranch (never assume 'main') ────
//
// issue-link is REQUIRED. If ctx.defaultBranch is null (uncomputable — the
// workflow did not map it) the conditional above cannot be decided, so the
// gate MUST fail closed rather than silently assuming 'main' (that would
// reintroduce the rejected hardcoded-'main' option). targetBranch below is
// deliberately NOT 'main' and the body deliberately carries a would-otherwise-
// pass "Part of #N" + an approved issue, to prove the failure is NOT coming
// from anything else — it is specifically the null defaultBranch.

test('runCheck: issue-link — ctx.defaultBranch is null → fails closed, NEVER falls back to a hardcoded "main" comparison', async () => {
  // fetchIssue DELIBERATELY returns the approved label — proves the failure
  // comes from the null-defaultBranch fail-closed path itself, not from the
  // fetch/label check (which would otherwise pass, since targetBranch here is
  // deliberately NOT 'main' — a hardcoded 'main' fallback would treat this as
  // a slice PR and wrongly PASS on the "Part of #N" pattern).
  const result = await runCheck('issue-link', {
    ctx: { body: 'feat: slice\n\nPart of #42', provider: 'github', targetBranch: 'feature/tracker', defaultBranch: null },
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('main: issue-link — ctx.defaultBranch is null → returns 2 (PR5: uncomputable, never 0/1) on the REQUIRED gate', async () => {
  const code = await main('issue-link', {
    ctx: { body: 'Closes #42', provider: 'github', targetBranch: 'main', defaultBranch: null },
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  assert.equal(code, 2); // PR5: an uncomputable branch context is uncomputable, never 1
});

test('runCheck: issue-link — ctx.targetBranch is null (defaultBranch known) → also fails closed (the conditional needs BOTH to be decided)', async () => {
  const result = await runCheck('issue-link', {
    ctx: { body: 'Closes #42', provider: 'github', targetBranch: null, defaultBranch: 'main' },
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
});

// ── issue-link — issue-number extraction precedence (issue #231 CP-A2a
// review, finding m2) ─────────────────────────────────────────────────────
//
// GitHub bash's SLICE branch (governance.yml:66-76) tries Part-of FIRST,
// then falls back to a closing keyword. Before m2, run-check.mjs's
// extractIssueNumber() tried CLOSING first regardless of target — a
// fail-OPEN edge for a body carrying BOTH patterns pointing at DIFFERENT
// issues: bash picks the Part-of issue, Node picked the closing issue. m2
// aligns Node to bash: on a slice target, extract Part-of first; on a
// default-branch target, only the closing ref is ever consulted (the
// default-branch policy already requires it).

test('runCheck: issue-link — slice target, body has BOTH "Closes #42" and "Part of #7" (different issues) → extracts #7 (Part-of-first, matches GitHub bash slice-branch precedence)', async () => {
  let fetchedIssueNumber = null;
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'fix: thing\n\nCloses #42\n\nPart of #7',
      provider: 'github',
      targetBranch: 'feature/tracker',
      defaultBranch: 'main',
    },
    fetchIssue: async (issueNumber) => {
      fetchedIssueNumber = issueNumber;
      return { labels: ['status:approved'] };
    },
    readConfig: () => ({}),
  });
  assert.equal(fetchedIssueNumber, 7, 'slice target must extract the Part-of issue (#7) first, mirroring GitHub bash');
  assert.deepEqual(result, { pass: true });
});

// ── base-branch — D10's eight steps, an injected fetchIssue (issue #967 PR C) ──
//
// The DECISION lives in checks/base-branch.mjs (tested in isolation there).
// These tests exercise the WRAPPER — the IO steps and the fan-out bound —
// through the public `runCheck('base-branch', deps)` entry, same convention
// `issue-link` above uses.

const EPIC_TRACKED_BODY = ['```brain-graph/1', 'kind: epic', 'tracker: feature/brain-ui', '```'].join('\n');
const SLICE_BODY = (parent) => ['```brain-graph/1', `parent: ${parent}`, '```'].join('\n');

test('runCheck: base-branch — ctx.body is null (uncomputable) → fails closed (step 1)', async () => {
  const result = await runCheck('base-branch', {
    ctx: { body: null, targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async () => { throw new Error('must not be called — body is null'); },
  });
  assert.equal(result.pass, false);
  assert.equal(result.uncomputable, true);
  assert.match(result.reason, /PR body uncomputable/);
});

test('runCheck: base-branch — targetBranch/defaultBranch uncomputable → fails closed (step 2)', async () => {
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #1', targetBranch: null, defaultBranch: null },
    fetchIssue: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.pass, false);
  assert.equal(result.uncomputable, true);
});

// PR D (cold review round 2, 2026-09-17): the wrapper's own `feature/` prefix
// shortcut duplicated the exact bug `checks/base-branch.mjs` closed in its
// predicate — deciding "this head is a tracker" from the branch name alone,
// with zero reads. There is no data-free path left: whether `headBranch`
// really is the linked issue's declared tracker can only be known from that
// issue's body, so a `feature/…` head now takes the SAME fetch every other
// head does (still at most two calls total — the fan-out bound below).

test('runCheck: base-branch — a feature/... head is checked against the linked issue\'s OWN declared tracker, one port call, not zero (step 3)', async () => {
  let calls = 0;
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #1', sourceBranch: 'feature/brain-ui', targetBranch: 'feature/other', defaultBranch: 'main' },
    fetchIssue: async () => { calls += 1; return { body: EPIC_TRACKED_BODY }; },
  });
  assert.equal(result.pass, false);
  assert.ok(/default branch/.test(result.reason), `must state a tracker PR targets the default branch, got: ${result.reason}`);
  assert.equal(calls, 1, 'the one fact the rule holds — the linked issue\'s own declaration, not the branch spelling');
});

test('runCheck: base-branch — a feature/... head that is NOT the linked issue\'s declared tracker is an ordinary slice head (measured bug)', async () => {
  // The reviewed bug, at the wrapper: `sourceBranch: 'feature/issue-42-my-feature'`
  // used to trip the old zero-read shortcut and fail a slice already correctly
  // based on its epic's tracker, before the linked issue was ever fetched.
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #337', sourceBranch: 'feature/issue-42-my-feature', targetBranch: 'feature/brain-ui', defaultBranch: 'main' },
    fetchIssue: async (n) => (n === 337 ? { body: SLICE_BODY(878) } : { body: EPIC_TRACKED_BODY }),
  });
  assert.deepEqual(result, { pass: true });
});

test('runCheck: base-branch — no linked issue reference → pass untouched, the standing case (step 4)', async () => {
  let fetchCalled = false;
  const result = await runCheck('base-branch', {
    ctx: { body: 'just prose, no reference', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async () => { fetchCalled = true; return { body: '' }; },
  });
  assert.deepEqual(result, { pass: true });
  assert.equal(fetchCalled, false);
});

// PR #1006 cold review round 2 (blocker): step 4 passed ANY no-issue PR before
// the tracker rule (step 3/R967-7) ever ran, including a head that spells
// itself like a tracker branch (`feature/…`) and targets something other than
// the default branch — exactly the shape R967-7 says MUST target default,
// unconditionally. The prefix alone can never decide tracker-vs-slice (that
// still requires the linked issue's own declaration), but with no issue linked
// at all there is no declaration to read, so the gate cannot tell a tracker
// from a slice and must fail closed and ask for the evidence, not pass.

test('runCheck: base-branch — no linked issue + feature/... head not targeting default → fails closed, names head/target/default, fetchIssue never called (measured bug, PR #1006 review round 2)', async () => {
  let fetchCalled = false;
  const result = await runCheck('base-branch', {
    ctx: {
      body: 'no issue reference at all, oops',
      sourceBranch: 'feature/brain-ui',
      targetBranch: 'feature/other-tracker',
      defaultBranch: 'main',
    },
    fetchIssue: async () => { fetchCalled = true; throw new Error('should never be called'); },
  });
  assert.equal(result.pass, false);
  assert.equal(result.uncomputable, true);
  assert.ok(result.reason.includes('feature/brain-ui'), `must name the head, got: ${result.reason}`);
  assert.ok(result.reason.includes('feature/other-tracker'), `must name the target, got: ${result.reason}`);
  assert.ok(result.reason.includes('main'), `must name the default branch, got: ${result.reason}`);
  assert.equal(fetchCalled, false, 'no issue is linked — there is nothing to fetch');
});

test('runCheck: base-branch — no linked issue + feature/... head targeting default → pass (the tracker rule is satisfied either way)', async () => {
  let fetchCalled = false;
  const result = await runCheck('base-branch', {
    ctx: { body: 'no issue reference at all', sourceBranch: 'feature/brain-ui', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async () => { fetchCalled = true; return { body: '' }; },
  });
  assert.deepEqual(result, { pass: true });
  assert.equal(fetchCalled, false);
});

test('runCheck: base-branch — no linked issue + non-feature head → pass, unchanged (memory-lane / no-issue PRs remain the standing case)', async () => {
  let fetchCalled = false;
  const result = await runCheck('base-branch', {
    ctx: { body: 'no issue reference at all', sourceBranch: 'fix/x', targetBranch: 'feature/other', defaultBranch: 'main' },
    fetchIssue: async () => { fetchCalled = true; return { body: '' }; },
  });
  assert.deepEqual(result, { pass: true });
  assert.equal(fetchCalled, false);
});

test('runCheck: base-branch — fetchIssue(linked) throws → fail closed and uncomputable, never a silent pass (step 5)', async () => {
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #878', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async () => { throw new Error('offline'); },
  });
  assert.equal(result.pass, false);
  assert.equal(result.uncomputable, true);
});

test('runCheck: base-branch — the linked issue is itself kind: epic → pass, no second fetch (step 6)', async () => {
  let calls = 0;
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #878', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async () => { calls += 1; return { body: EPIC_TRACKED_BODY }; },
  });
  assert.deepEqual(result, { pass: true });
  assert.equal(calls, 1, 'the linked issue declaring kind: epic resolves without fetching a parent');
});

test('runCheck: base-branch — fetchIssue(parent) throws → fail closed, never a silent pass (step 7)', async () => {
  const calls = [];
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #337', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async (n) => {
      calls.push(n);
      if (n === 337) return { body: SLICE_BODY(878) };
      throw new Error('epic offline');
    },
  });
  assert.equal(result.pass, false);
  assert.equal(result.uncomputable, true);
  assert.deepEqual(calls, [337, 878]);
});

test('runCheck: base-branch — base equals the parent\'s declared tracker → pass (step 8)', async () => {
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #337', sourceBranch: 'slice/x', targetBranch: 'feature/brain-ui', defaultBranch: 'main' },
    fetchIssue: async (n) => (n === 337 ? { body: SLICE_BODY(878) } : { body: EPIC_TRACKED_BODY }),
  });
  assert.deepEqual(result, { pass: true });
});

test('runCheck: base-branch — base ≠ the parent\'s declared tracker → fail, naming the tracker, epic and actual base (step 8)', async () => {
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #337', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async (n) => (n === 337 ? { body: SLICE_BODY(878) } : { body: EPIC_TRACKED_BODY }),
  });
  assert.equal(result.pass, false);
  assert.ok(result.reason.includes('feature/brain-ui'), `must name the tracker, got: ${result.reason}`);
  assert.ok(result.reason.includes('878'), `must name the epic, got: ${result.reason}`);
  assert.ok(result.reason.includes('main'), `must name the actual base, got: ${result.reason}`);
});

// PR #1006 cold review round 1, finding 1 (blocker): step 6 decided whether to
// fetch the parent from `parseGraphBlock(issue.body)` alone, which is `null`
// for a body carrying no `brain-graph/1` block at all — so a parent declared
// only via prose (`Parent: #878 ...`, no block) was never read, and the exact
// slice-on-main case this gate exists for passed silently, fetching only the
// linked issue. `declaredParent` (PR D) already reads prose with or without a
// block; the gate's own fetch decision now goes through it too.

test('runCheck: base-branch — parent declared only via prose (no brain-graph block) still triggers the parent fetch and fails the slice-on-main case (PR #1006 review round 1, finding 1)', async () => {
  const calls = [];
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #881', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async (n) => {
      calls.push(n);
      if (n === 881) return { body: 'Parent: #878 (Brain UI) — slice 3, Wave B.' };
      return { body: EPIC_TRACKED_BODY };
    },
  });
  assert.equal(result.pass, false, 'a slice-on-main whose parent is declared only via prose must fail, not pass silently');
  assert.deepEqual(calls, [881, 878], 'the parent must be fetched too, not just the linked issue');
});

test('runCheck: base-branch — no block, no prose parent → one fetch, pass (standing case stays green)', async () => {
  const calls = [];
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #900', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async (n) => { calls.push(n); return { body: 'just a plain body, no graph block, no parent line' }; },
  });
  assert.deepEqual(result, { pass: true });
  assert.deepEqual(calls, [900], 'no declared parent (block or prose) means no second fetch');
});

// PR E (tracker PR #1004, round-3 cold review): a parent divergence
// (parent-grammar or parent-ambiguous) short-circuits to the SAME
// uncomputable result the wrapper's own step 5 gives an unreadable linked
// issue — BEFORE `needsParentRead` would otherwise decide a parent fetch is
// owed. `dp.parent === null` reads identically for "no parent declared" and
// "a parent was declared and could not be read", so the wrapper's fetch
// bookkeeping is the one place that proves the epic is never fetched for a
// divergence, not just that the pure predicate says uncomputable.

test('runCheck: base-branch — a parent-grammar divergence in the linked issue is uncomputable, the epic is never fetched', async () => {
  const calls = [];
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #337', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async (n) => {
      calls.push(n);
      return { body: ['```brain-graph/1', 'parent: abc', '```'].join('\n') };
    },
  });
  assert.equal(result.pass, false);
  assert.equal(result.uncomputable, true);
  assert.ok(result.reason.includes('parent-grammar'), `must name the divergence reason, got: ${result.reason}`);
  assert.ok(result.reason.includes('abc'), `must name the offending value, got: ${result.reason}`);
  assert.deepEqual(calls, [337], 'the epic must never be fetched — the parent could not be read, not resolved to none');
});

test('runCheck: base-branch — an ambiguous prose parent in the linked issue is uncomputable, the epic is never fetched', async () => {
  const calls = [];
  const result = await runCheck('base-branch', {
    ctx: { body: 'Closes #337', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async (n) => {
      calls.push(n);
      return { body: ['Parent: #878', 'Parent: #879'].join('\n') };
    },
  });
  assert.equal(result.pass, false);
  assert.equal(result.uncomputable, true);
  assert.ok(result.reason.includes('parent-ambiguous'), `must name the divergence reason, got: ${result.reason}`);
  assert.ok(result.reason.includes('878, 879'), `must name the offending value, got: ${result.reason}`);
  assert.deepEqual(calls, [337], 'the epic must never be fetched — the parent could not be read, not resolved to none');
});

test('runCheck: base-branch — no forge fan-out: zero issueList calls, at most two issueView (fetchIssue) calls', async () => {
  const calls = [];
  await runCheck('base-branch', {
    ctx: { body: 'Closes #337', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async (n) => {
      calls.push(n);
      return n === 337 ? { body: SLICE_BODY(878) } : { body: EPIC_TRACKED_BODY };
    },
  });
  assert.ok(calls.length <= 2, `expected at most two fetchIssue calls, got ${calls.length}`);
  assert.deepEqual(calls, [337, 878]);
});

// ── diff-size — size:exception from FRESH ctx.labels, never CI_MERGE_REQUEST_LABELS (task 2.3) ─

test('runCheck: diff-size — ctx.labels includes "size:exception" → skips the budget check, pass', async () => {
  const result = await runCheck('diff-size', {
    ctx: { labels: ['size:exception'], baseSha: 'BASE', headSha: 'HEAD' },
    diffNumstat: () => { throw new Error('must not be called — size:exception skips the gate'); },
    readConfig: () => ({}),
  });
  assert.equal(result.pass, true);
});

test('runCheck: diff-size — over budget, no size:exception label → fail with reason', async () => {
  const result = await runCheck('diff-size', {
    ctx: { labels: [], baseSha: 'BASE', headSha: 'HEAD' },
    diffNumstat: () => '300\t101\tsrc/big.mjs',
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /401/);
});

test('runCheck: diff-size — under budget, no size:exception label → pass', async () => {
  const result = await runCheck('diff-size', {
    ctx: { labels: [], baseSha: 'BASE', headSha: 'HEAD' },
    diffNumstat: () => '5\t0\tbrain/scripts/foo.mjs',
    readConfig: () => ({}),
  });
  assert.deepEqual(result, { pass: true });
});

test('runCheck: diff-size — reads ignoreList from governance.ignoreList (config), not hardcoded', async () => {
  const result = await runCheck('diff-size', {
    ctx: { labels: [], baseSha: 'BASE', headSha: 'HEAD' },
    diffNumstat: () => '3\t0\t.memory/session.jsonl.gz\n5\t0\tbrain/scripts/foo.mjs',
    readConfig: () => ({ governance: { ignoreList: ['.memory/**'] } }),
  });
  assert.deepEqual(result, { pass: true });
});

test('runCheck: diff-size — diffNumstat throws (git uncomputable) → fail closed with reason', async () => {
  const result = await runCheck('diff-size', {
    ctx: { labels: [], baseSha: null, headSha: null },
    diffNumstat: () => { throw new Error('BASE_SHA/HEAD_SHA not set'); },
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /cannot compute diff — failing closed/i);
});

// ── mapDetectionToWarning (issue #358 Q5, design §8) — the shared helper ────

test('mapDetectionToWarning: a required-policy gate at this tier passes the result through unchanged', () => {
  const result = { pass: false, reason: 'boom' };
  assert.deepEqual(mapDetectionToWarning(result, 'standard', 'diff-size'), result);
});

test('mapDetectionToWarning: a detection-policy gate downgrades a violation to pass:true with a ::warning:: reason naming the tier', () => {
  const result = mapDetectionToWarning({ pass: false, reason: 'no session_summary found' }, 'lite', 'memory-gate');
  assert.equal(result.pass, true);
  assert.match(result.reason, /^::warning::memory-gate:/);
  assert.match(result.reason, /\(tier: lite\)/);
  assert.match(result.reason, /no session_summary found/);
});

test('mapDetectionToWarning: an uncomputable result is never downgraded, even at a detection-policy tier', () => {
  const result = { pass: false, uncomputable: true, reason: 'cannot compute' };
  assert.deepEqual(mapDetectionToWarning(result, 'lite', 'memory-gate'), result);
});

test('mapDetectionToWarning: a passing result is returned unchanged', () => {
  const result = { pass: true };
  assert.deepEqual(mapDetectionToWarning(result, 'lite', 'memory-gate'), result);
});

// ── diff-size — tiered budget + tiered size:exception (issue #358 Q5, REQ-TIER-6/9) ──

test('runCheck: diff-size — regulated tier at 260 lines fails, naming the tier and refusing size:exception', async () => {
  const result = await runCheck('diff-size', {
    ctx: { labels: ['size:exception'], baseSha: 'BASE', headSha: 'HEAD' },
    diffNumstat: () => '200\t60\tsrc/big.mjs', // 260 changed lines
    readConfig: () => ({ governance: { tier: 'regulated' } }),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /260/);
  assert.match(result.reason, /regulated/);
  assert.match(result.reason, /size:exception is not honored/i);
});

test('runCheck: diff-size — lite tier honors the 1000-line budget (400-line-legacy diff passes without exception)', async () => {
  const result = await runCheck('diff-size', {
    ctx: { labels: [], baseSha: 'BASE', headSha: 'HEAD' },
    diffNumstat: () => '500\t200\tsrc/big.mjs', // 700 changed lines — over 400, under 1000
    readConfig: () => ({ governance: { tier: 'lite' } }),
  });
  assert.equal(result.pass, true);
});

test('runCheck: diff-size — standard tier (default) still fails over 400 lines without size:exception', async () => {
  const result = await runCheck('diff-size', {
    ctx: { labels: [], baseSha: 'BASE', headSha: 'HEAD' },
    diffNumstat: () => '300\t101\tsrc/big.mjs', // 401 changed lines
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /401/);
});

test('runCheck: diff-size — regulated tier under its 200-line budget still passes (no waiver needed)', async () => {
  const result = await runCheck('diff-size', {
    ctx: { labels: [], baseSha: 'BASE', headSha: 'HEAD' },
    diffNumstat: () => '100\t50\tsrc/small.mjs', // 150 changed lines
    readConfig: () => ({ governance: { tier: 'regulated' } }),
  });
  assert.deepEqual(result, { pass: true });
});

// ── behavior parity (task 2.6, CP-A2a ruling) ───────────────────────────────
//
// Name parity alone is NOT enough. This table encodes the truth table
// implemented by the GitHub bash paths — issue-link (.github/workflows/
// governance.yml:28-81) and diff-size (:84-113) — for the fixture dimensions
// task 2.6 calls out (body with/without a ref, referenced issue approved/not,
// diff over/under budget, size:exception present/absent), and asserts the
// Node run-check.mjs cases return the SAME pass/fail verdict for the SAME
// inputs. This proves routing through Node changed the TRANSPORT, not the
// VERDICT.
//
// Scope note (UPDATED — issue #231 A2 phase 2 ADDENDUM closes the gap this
// note originally flagged): the bash issue-link job branches on BASE_BRANCH
// — base=='main' requires a closing keyword (Closes|Fixes|Resolves #N)
// ONLY; base!='main' (the slice-PR branch, :55-71) accepts EITHER "Part of
// #N" OR a closing keyword. run-check.mjs's issue-link case now ALSO
// branches — via `requiresClosingKeyword(ctx)`, fed by
// `ctx.targetBranch`/`ctx.defaultBranch` (REQ-CIC-2 delta) — so the Node
// path matches BOTH bash branches, not just the slice-PR one. Rows below
// that omit `targetBranch`/`defaultBranch` default to a SLICE target
// (targetBranch !== defaultBranch, the original task 2.6 scope); the new row
// at the bottom explicitly sets a default-branch target to prove the
// previously-undocumented gap is now closed.
//
// EXPLICIT DIVERGENCE (NOT total parity — pre-existing, out of scope here):
// the GitHub bash literally compares `BASE_BRANCH == 'main'` (a hardcoded
// string), never the repo's actual default branch. A GitHub consumer whose
// default branch is NOT 'main' (e.g. 'develop') would have the bash apply
// the WRONG policy — comparing against a literal that isn't its default —
// while the Node path (this addendum) correctly compares against
// `ctx.defaultBranch` (the real default branch, mapped from
// `github.event.repository.default_branch`). This divergence is a
// pre-existing bash limitation, not introduced by this addendum, and fixing
// the bash side is out of scope here — recorded as a follow-up, not implied
// parity.
//
// VOCABULARY DIMENSION (issue #231 CP-A2a review, finding M1): the rows
// above use "Closes"/"Part of" almost exclusively. The table now also covers
// the full 9-form closing-keyword vocabulary (close, closes, closed, fix,
// fixes, fixed, resolve, resolves, resolved) that GitHub bash's grep
// (close[sd]?|fix(e[sd])?|resolve[sd]?) has always accepted — issueLink()
// and run-check.mjs's own closing-number regex were previously NARROWER (3
// forms only), a fail-closed parity gap now closed by sharing one pattern
// (checks/issue-ref-patterns.mjs) across issueLink(), run-check.mjs, and
// actor-check.mjs.

const issueLinkParityTable = [
  {
    label: 'Closes #N present, issue approved',
    body: 'fix: thing\n\nCloses #42',
    issueLabels: ['status:approved'],
    // bash (governance.yml:59-66): num extracted via Part-of-or-closing regex
    // (finds #42) → (:76-81) gh api fetches issue #42 labels → grep -qx
    // 'status:approved' matches → PASS.
    githubBashVerdict: true,
  },
  {
    label: 'Part of #N present, issue approved',
    body: 'feat: slice\n\nPart of #42',
    issueLabels: ['status:approved'],
    // bash (:59-62): Part-of regex matches #42 → (:76-81) approved → PASS.
    githubBashVerdict: true,
  },
  {
    label: 'Closes #N present, issue NOT approved',
    body: 'fix: thing\n\nCloses #42',
    issueLabels: ['status:in-review'],
    // bash (:76-81): labels fetched but grep -qx 'status:approved' does not
    // match 'status:in-review' → ::error:: not labeled → FAIL.
    githubBashVerdict: false,
  },
  {
    label: 'Part of #N present, issue NOT approved',
    body: 'Part of #7',
    issueLabels: [],
    // bash (:76-81): issue has no labels at all → grep -qx fails → FAIL.
    githubBashVerdict: false,
  },
  {
    label: 'no issue reference at all',
    body: 'chore: tidy up, no link here',
    issueLabels: ['status:approved'], // irrelevant — bash never reaches the fetch
    // bash (:59-70): both num= extractions come up empty → ::error:: must
    // have a reference → exit 1 → FAIL (before any gh api call).
    githubBashVerdict: false,
  },
  {
    label: 'Part of #N present (no closing keyword), base == default branch — RULED ROW (A2 phase 2 addendum)',
    body: 'feat: slice\n\nPart of #42',
    issueLabels: ['status:approved'],
    targetBranch: 'main',
    defaultBranch: 'main',
    // bash (governance.yml:45-54): BASE_BRANCH=='main' branch requires a
    // CLOSING keyword ONLY — the num= extraction on :48-50 (grep for
    // close[sd]?|fix(e[sd])?|resolve[sd]?) finds nothing in a Part-of-only
    // body → num empty → ::error:: PR to main must have a Closes/Fixes/
    // Resolves reference → exit 1 → FAIL.
    // Node (run-check.mjs, THIS ADDENDUM): ctx.targetBranch===ctx.defaultBranch
    // → requiresClosingKeyword() returns true → CLOSING_NUM_RE does not match
    // a Part-of-only body → FAIL. Both paths FAIL — this is the exact input
    // that used to PASS on Node before this addendum (the gap being closed).
    githubBashVerdict: false,
  },

  // ── vocabulary dimension (issue #231 CP-A2a review, finding M1) ───────────
  //
  // Before M1, run-check.mjs's issue-link case (via issueLink() AND its own
  // CLOSING_NUM_RE) only recognized closes|fixes|resolves (3 of the 9
  // GitHub-documented closing forms) — a NARROWER vocabulary than GitHub
  // bash's own grep (close[sd]?|fix(e[sd])?|resolve[sd]?, all 9 forms). A
  // body like "Fixed #42" therefore PASSED GitHub bash but FAILED the Node
  // path — a parity divergence. M1 widens issueLink() and run-check.mjs to
  // the SAME shared broad pattern (checks/issue-ref-patterns.mjs). These
  // rows cover at least one form from each of the three keyword families
  // (close/fix/resolve) on a slice target, PLUS the exact M1 default-branch
  // case below.
  {
    label: 'Fixed #N (past-tense "fix" form), issue approved',
    body: 'Fixed #42',
    issueLabels: ['status:approved'],
    // bash (:74, broad grep matches "Fixed"): finds #42 → approved → PASS.
    githubBashVerdict: true,
  },
  {
    label: 'close #N (bare "close" form), issue approved',
    body: 'close #42',
    issueLabels: ['status:approved'],
    // bash (:74, broad grep matches "close"): finds #42 → approved → PASS.
    githubBashVerdict: true,
  },
  {
    label: 'Resolved #N (past-tense "resolve" form), issue approved',
    body: 'Resolved #42',
    issueLabels: ['status:approved'],
    // bash (:74, broad grep matches "Resolved"): finds #42 → approved → PASS.
    githubBashVerdict: true,
  },
  {
    label: 'Fixed #42 targeting the DEFAULT branch — THE M1 case (broad closing form satisfies the default-branch closing-keyword policy)',
    body: 'Fixed #42',
    issueLabels: ['status:approved'],
    targetBranch: 'main',
    defaultBranch: 'main',
    // bash (governance.yml:55-64, base=='main' branch): the broad grep
    // (close[sd]?|fix(e[sd])?|resolve[sd]?) matches "Fixed" → num=42 →
    // approved → PASS. Before M1, Node's own CLOSING_NUM_RE was narrow
    // (closes|fixes|resolves) and did NOT match "Fixed" → the default-branch
    // closing-keyword policy (requiresClosingKeyword) would wrongly FAIL this
    // — the exact fail-closed parity divergence M1 closes.
    githubBashVerdict: true,
  },
];

for (const row of issueLinkParityTable) {
  test(`behavior parity (issue-link): "${row.label}" → Node verdict matches documented GitHub-bash verdict (${row.githubBashVerdict ? 'PASS' : 'FAIL'})`, async () => {
    // provider: 'github' — the bash's own label literal is the unscoped
    // 'status:approved' (governance.yml:78); the fixture issueLabels above
    // use that same unscoped form, so the Node-side resolver must resolve to
    // the SAME form for an apples-to-apples verdict comparison. Rows that
    // don't specify targetBranch/defaultBranch default to a SLICE target
    // (the original task 2.6 scope, preserved).
    const result = await runCheck('issue-link', {
      ctx: {
        body: row.body,
        provider: 'github',
        targetBranch: row.targetBranch ?? 'feature/tracker',
        defaultBranch: row.defaultBranch ?? 'main',
      },
      fetchIssue: async () => ({ labels: row.issueLabels }),
      readConfig: () => ({}),
    });
    assert.equal(result.pass, row.githubBashVerdict,
      `Node issue-link verdict (${result.pass}) must match GitHub-bash verdict (${row.githubBashVerdict}) for: ${row.label}`);
  });
}

const diffSizeParityTable = [
  {
    label: 'under budget, no size:exception',
    numstat: '5\t0\tbrain/scripts/foo.mjs',
    labels: [],
    // bash (:100-113): LABELS has no size:exception word → git diff --numstat
    // piped to diff-size-count.mjs → changed=5 → 5>400 false → PASS (no error).
    githubBashVerdict: true,
  },
  {
    label: 'over budget, no size:exception',
    numstat: '300\t101\tsrc/big.mjs',
    labels: [],
    // bash (:100-113): no size:exception → changed=401 → 401>400 → ::error:: → FAIL.
    githubBashVerdict: false,
  },
  {
    label: 'over budget, size:exception present',
    numstat: '300\t101\tsrc/big.mjs',
    labels: ['size:exception'],
    // bash (:101-104): grep -qw 'size:exception' on LABELS matches → prints
    // "skipping" → exit 0 → PASS (the budget is never even computed).
    githubBashVerdict: true,
  },
  {
    label: 'under budget, size:exception present',
    numstat: '5\t0\tbrain/scripts/foo.mjs',
    labels: ['size:exception'],
    // bash (:101-104): size:exception present → skip → exit 0 → PASS.
    githubBashVerdict: true,
  },
];

for (const row of diffSizeParityTable) {
  test(`behavior parity (diff-size): "${row.label}" → Node verdict matches documented GitHub-bash verdict (${row.githubBashVerdict ? 'PASS' : 'FAIL'})`, async () => {
    const result = await runCheck('diff-size', {
      ctx: { labels: row.labels, baseSha: 'BASE', headSha: 'HEAD' },
      diffNumstat: () => row.numstat,
      readConfig: () => ({}),
    });
    assert.equal(result.pass, row.githubBashVerdict,
      `Node diff-size verdict (${result.pass}) must match GitHub-bash verdict (${row.githubBashVerdict}) for: ${row.label}`);
  });
}

// ── defaultFetchIssue wiring (issue #231 CP-A2b live-validation finding #12):
// defaultFetchIssue is NEVER exercised directly in tests (design.md Decision
// 2 — "no real network in tests"; every test above injects `fetchIssue`).
// That fixtures-always-inject gap is exactly what hid #12: the real
// vcs.issueView() call crashed on node:22 (no `glab` binary) and nothing
// caught it. A source-level wiring assertion is this repo's established
// pattern for exactly this class of never-directly-exercised default glue
// (see ci-context.test.mjs's "proxy read from standard env" test and
// ci-context-drift-guard.test.mjs's CI-wiring tests) — it proves
// defaultFetchIssue threads the GitLab API config through, without a real
// network call. ─────────────────────────────────────────────────────────
test('wiring: defaultFetchIssue sources { apiBase, token, proxyUrl } from ci-context.mjs\'s gitlabApiConfig() and threads them into vcs.issueView() — never reads process.env.CI_API_V4_URL itself', () => {
  const src = readFileSync(fileURLToPath(new URL('./run-check.mjs', import.meta.url)), 'utf8');
  assert.match(src, /gitlabApiConfig/, 'defaultFetchIssue must obtain the GitLab API config via ci-context.mjs\'s gitlabApiConfig(), not a local env read');
  assert.doesNotMatch(src, /process\.env\.CI_API_V4_URL/, 'run-check.mjs is a GATE_FILE — it must never read CI_API_V4_URL directly (drift-guard forbids it)');

  const fnStart = src.indexOf('function defaultFetchIssue(');
  assert.ok(fnStart !== -1, 'defaultFetchIssue not found');
  const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2);
  assert.match(fnBody, /vcs\.issueView\(\{[^}]*apiBase[^}]*token[^}]*proxyUrl/s,
    'defaultFetchIssue must pass apiBase/token/proxyUrl into vcs.issueView(...)');
});

// #1024 Batch 3 BLOCKER: defaultFetchPrLabelEvents (memory-gate's skip
// override applier read) skipped BOTH of defaultFetchIssue's own disciplines
// — it never threads gitlabApiConfig()'s { apiBase, token, proxyUrl } into
// the call, and it never passes kind: 'mr', so on GitLab it silently read
// ISSUE label events for the MR's own IID and the override could never be
// honored there.
test('wiring: defaultFetchPrLabelEvents sources { apiBase, token, proxyUrl } from ci-context.mjs\'s gitlabApiConfig() and passes kind: \'mr\' into vcs.labelEvents() — never reads process.env.CI_API_V4_URL itself', () => {
  const src = readFileSync(fileURLToPath(new URL('./run-check.mjs', import.meta.url)), 'utf8');
  const fnStart = src.indexOf('function defaultFetchPrLabelEvents(');
  assert.ok(fnStart !== -1, 'defaultFetchPrLabelEvents not found');
  const fnBody = src.slice(fnStart, src.indexOf('\n}', fnStart) + 2);
  assert.match(fnBody, /gitlabApiConfig/, 'defaultFetchPrLabelEvents must obtain the GitLab API config via gitlabApiConfig(), not a local env read');
  assert.match(fnBody, /vcs\.labelEvents\(\{[^}]*kind:\s*'mr'[^}]*apiBase[^}]*token[^}]*proxyUrl/s,
    'defaultFetchPrLabelEvents must pass kind: \'mr\' and apiBase/token/proxyUrl into vcs.labelEvents(...)');
});

test('runCheck: memory-gate — defaultFetchPrLabelEvents requests kind: \'mr\' (GitLab MR label events, not issue events) via an injected getVcs', async () => {
  let seenArgs;
  const fakeVcs = {
    labelEvents: async (args) => {
      seenArgs = args;
      return [{ actor: { login: 'alice' }, action: 'add', label: 'skip:memory-gate' }];
    },
  };
  const result = await runCheck('memory-gate', {
    ctx: {
      body: 'Closes #1024', targetBranch: 'main', defaultBranch: 'main',
      labels: ['skip:memory-gate'], author: 'bob', provider: 'gitlab', repo: 'g/r', prNumber: 7,
    },
    readRecords: () => [],
    readConfig: () => ({ governance: { tier: 'standard' } }),
    getVcs: async () => fakeVcs,
  });
  assert.ok(seenArgs, 'vcs.labelEvents must have been called');
  assert.equal(seenArgs.kind, 'mr', 'must request MR label events, not issue events, on GitLab');
  assert.equal(seenArgs.project, 'g/r');
  assert.equal(seenArgs.number, 7);
  assert.equal(result.path, 'skipped');
});

// ═══════════════════════════════════════════════════════════════════════════
// PR5 (#310) Phase 5.2 — the 0/1/2 exit contract wired across evaluators. An
// INFRA failure (git/IO/API) returns `uncomputable: true` → exit 2; a genuine
// governance miss stays `pass: false` → exit 1. Proven RED-first per check.
// ═══════════════════════════════════════════════════════════════════════════

import { resultToExit } from './postmerge/exit-codes.mjs';

// ── decision-gate (5.2.1/2): a throwing diffNameOnly is uncomputable, not a violation ──
test('PR5 decision-gate: a throwing diff (infra) is uncomputable → 2, not a violation → 1', async () => {
  const r = await runCheck('decision-gate', {
    diffNameOnly: () => { throw new Error('git exploded'); },
  });
  assert.equal(r.uncomputable, true, 'a git failure must be uncomputable, not a false violation');
  assert.equal(resultToExit(r), 2);
});

// ── diff-size (5.2.1/2): a throwing diffNumstat is uncomputable ──
test('PR5 diff-size: a throwing numstat (infra) is uncomputable → 2', async () => {
  const r = await runCheck('diff-size', {
    ctx: { labels: [] },
    diffNumstat: () => { throw new Error('git exploded'); },
  });
  assert.equal(r.uncomputable, true);
  assert.equal(resultToExit(r), 2);
});

// ── issue-link (5.2.3/4): infra paths uncomputable, governance misses stay violations ──
test('PR5 issue-link: a non-string body (API fetch failed) is uncomputable → 2', async () => {
  const r = await runCheck('issue-link', { ctx: { body: null } });
  assert.equal(r.uncomputable, true);
  assert.equal(resultToExit(r), 2);
});

test('PR5 issue-link: an uncomputable branch context is uncomputable → 2', async () => {
  const r = await runCheck('issue-link', {
    ctx: { body: 'Closes #1', targetBranch: null, defaultBranch: null },
  });
  assert.equal(r.uncomputable, true);
  assert.equal(resultToExit(r), 2);
});

test('PR5 issue-link: a throwing fetchIssue (infra) is uncomputable → 2', async () => {
  const r = await runCheck('issue-link', {
    ctx: { body: 'Closes #7', targetBranch: 'x', defaultBranch: 'main' },
    fetchIssue: async () => { throw new Error('network'); },
  });
  assert.equal(r.uncomputable, true);
  assert.equal(resultToExit(r), 2);
});

test('PR5 issue-link: a genuine "not approved" miss stays a VIOLATION → 1 (never uncomputable)', async () => {
  const r = await runCheck('issue-link', {
    ctx: { body: 'Closes #7', targetBranch: 'main', defaultBranch: 'main' },
    fetchIssue: async () => ({ labels: [] }), // exists, but not status:approved
    readConfig: () => ({}),
  });
  assert.notEqual(r.uncomputable, true, 'a real governance miss must NOT be uncomputable');
  assert.equal(r.pass, false);
  assert.equal(resultToExit(r), 1);
});

// ── memory-gate (5.2.5/6): a THROWING read is uncomputable → 2; an EMPTY read
// stays a real violation → 1 (memoryPresence's "re-eval only, never a false
// resolved" property, §3.5/REQ-D2-10a). ──
test('PR5 memory-gate: a throwing readRecords (IO) is uncomputable → 2', async () => {
  const r = await runCheck('memory-gate', {
    readRecords: () => { throw new Error('EACCES'); },
  });
  assert.equal(r.uncomputable, true);
  assert.equal(resultToExit(r), 2);
});

test('PR5 memory-gate: an EMPTY readRecords stays a real VIOLATION → 1 (never uncomputable)', async () => {
  const r = await runCheck('memory-gate', {
    readRecords: () => [], // no session_summary → genuine miss, not infra failure
  });
  assert.notEqual(r.uncomputable, true, 'an empty record set is a real violation, not uncomputable');
  assert.equal(r.pass, false);
  assert.equal(resultToExit(r), 1);
});

// ── memory-gate — issue-scoped (T2.1, REQ-L3-4): runMemoryGateCheck wiring ──
//
// memoryPresence() alone is a GLOBAL existence check, decoupled from which
// issue the current PR is about. T2.1 wires a new runMemoryGateCheck(ctx,
// records) wrapper in front of it: when ctx.body carries a detectable issue
// reference, the gate scopes records to that issue via memoryRetrieval();
// otherwise (no ctx.body, or ctx.body present but no extractable issue
// number) it falls back to the pre-existing global memoryPresence() check —
// preserving every fixture/test above (none of which pass a ctx.body) byte
// for byte.

test('runCheck: memory-gate — no ctx at all (ctx.body undefined) → falls back to the global memoryPresence() check (regression, must still pass with existing fixtures)', async () => {
  const result = await runCheck('memory-gate', {
    readRecords: () => [{ type: 'session_summary' }],
  });
  // #1024: the verdict (pass:true, no reason) is byte-identical to
  // memoryPresence()'s own contract — only the added path/pathDetail fields
  // differ, so this checks the verdict fields directly rather than a full
  // deepEqual against the pre-#1024 bare shape.
  assert.equal(result.pass, true, 'ctx-less call must behave exactly like memoryPresence()');
  assert.equal(result.reason, undefined);
});

test('runCheck: memory-gate — ctx.body has a closing reference + a scoped session_summary → pass clean', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'fix: thing\n\nCloses #379', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [{ type: 'session_summary', issue: 379 }],
  });
  assert.equal(result.pass, true);
  assert.match(result.reason, /379/);
});

test('runCheck: memory-gate — ctx.body has a reference but NO record scoped to that issue → fail', async () => {
  // #1024 incident (batch 2): this is a MISS on the PR tree alone, so D3's
  // lazy union falls through to the default-branch reader — MUST be
  // injected here (a hermetic fake), never left to the production default,
  // which would otherwise touch the REAL repo's git state from this test's
  // real cwd (harmless post-fix, since a non-shallow repo never fetches, but
  // still non-deterministic and not what a unit test should read).
  const result = await runCheck('memory-gate', {
    ctx: { body: 'feat: slice\n\nPart of #379', targetBranch: 'feature/tracker', defaultBranch: 'main' },
    readRecords: () => [{ type: 'session_summary', issue: 12 }],
    readDefaultBranchRecords: () => ({ records: [], error: null }),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /379/);
});

test('runCheck: memory-gate — ctx.body has scoped records but none is session_summary → pass:true with a warn/partial reason (non-blocking)', async () => {
  // #1024 incident (batch 2): a PARTIAL PR-tree result is not a clean HIT
  // (D3), so this also reaches the default-branch reader — injected fake,
  // same reason as above.
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #379', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => [{ type: 'decision', issue: 379 }],
    readDefaultBranchRecords: () => ({ records: [], error: null }),
  });
  assert.equal(result.pass, true);
  assert.match(result.reason, /warn|partial/i);
});

test('runCheck: memory-gate — ctx.body present but no extractable issue number → falls back to the global memoryPresence() check', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'chore: tidy up, no link here', targetBranch: 'feature/tracker', defaultBranch: 'main' },
    readRecords: () => [{ type: 'session_summary', issue: 12 }],
  });
  // Falls back to global memoryPresence(): ANY session_summary anywhere passes,
  // regardless of its .issue — proves the fallback path, not the scoped path.
  assert.equal(result.pass, true);
  assert.equal(result.path, 'presence');
});

test('runCheck: memory-gate — ctx.body present but no extractable issue number, and no session_summary anywhere → fallback fails too', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'chore: tidy up, no link here', targetBranch: 'feature/tracker', defaultBranch: 'main' },
    readRecords: () => [{ type: 'decision', issue: 12 }],
  });
  assert.equal(result.pass, false);
});

test('runCheck: memory-gate — readRecords throwing still returns uncomputable:true even with a ctx.body present (regression)', async () => {
  const result = await runCheck('memory-gate', {
    ctx: { body: 'Closes #379', targetBranch: 'main', defaultBranch: 'main' },
    readRecords: () => { throw new Error('EACCES'); },
  });
  assert.equal(result.uncomputable, true);
  assert.equal(resultToExit(result), 2);
});

// ── #510: a MODIFIED ADR is not an added one ────────────────────────────────
//
// The defect these pin: adrPresence decided on `git diff --name-only`, which cannot
// tell added from modified, so correcting one line in an ADR from months ago demanded
// re-indexing it in brain/HOME.md. Found blocking PR #507.
//
// A fixture built only from ADDED paths cannot see this — the whole defect lives in
// the gap between the two lists, so the modified case has to be driven explicitly.

test('runCheck: decision-gate — a MODIFIED ADR without HOME.md passes (#510)', async () => {
  const result = await runCheck('decision-gate', {
    diffNameOnly: () => ['brain/project/decisions/adr-0013-auto-adr-onboarding.md'],
    diffNameOnlyAdded: () => [],
  });
  assert.deepEqual(result, { pass: true },
    'touching an existing ADR must not require re-indexing it in brain/HOME.md');
});

test('runCheck: decision-gate — an ADDED ADR without HOME.md still fails, and names it (#510)', async () => {
  const result = await runCheck('decision-gate', {
    diffNameOnly: () => ['brain/project/decisions/adr-0099-new.md'],
    diffNameOnlyAdded: () => ['brain/project/decisions/adr-0099-new.md'],
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /adr-0099-new\.md/,
    'the reason must name the ADR — the pre-#510 message asserted "added" on evidence that could not establish it');
});

test('runCheck: decision-gate — an uncomputable ADDED list fails closed, never defaults (#510)', async () => {
  const result = await runCheck('decision-gate', {
    diffNameOnly: () => ['brain/project/decisions/adr-0099-new.md'],
    diffNameOnlyAdded: () => { throw new Error('git exploded'); },
  });
  assert.equal(result.pass, false);
  assert.equal(result.uncomputable, true,
    'a missing added-list is absent evidence, not evidence of absence');
});

// The three above inject `diffNameOnlyAdded`, so none of them ever executes the REAL
// reader. Mutation M3 proved the cost: turning `defaultDiffNameOnlyAdded`'s catch into
// `return []` left every one of them green while the shipped gate silently degraded to
// "nothing was added" on any git failure — which reads every added ADR as modified and
// re-opens #510 from the opposite side, this time fail-OPEN.
//
// So this one drives the default: `diffNameOnly` is injected (it is not what is under
// test) and the added-list read runs for real against a rev that does not exist.
test('runCheck: decision-gate — the REAL added-list reader fails closed when git fails (#510)', async () => {
  const result = await runCheck('decision-gate', {
    ctx: { baseSha: 'no-such-ref-510', headSha: 'HEAD' },
    diffNameOnly: () => ['brain/project/decisions/adr-0099-new.md'],
    // diffNameOnlyAdded deliberately NOT injected — defaultDiffNameOnlyAdded runs.
  });
  assert.equal(result.pass, false);
  assert.equal(result.uncomputable, true,
    'the shipped reader must fail closed too — an injected-only guarantee guards nothing');
  assert.match(result.reason, /uncomputable/);
});

// ── #516: what the DOCTRINE claims decision-gate does, pinned against the code ──
//
// `workflow-governance.md` invariant 4 describes a TWO-STEP, LABEL-CONDITIONAL gate:
// step 1 fires "if the PR carries the `decision` label", step 2 scans architectural
// surfaces and warns. Neither step exists. `adrPresence` reads no labels and scans no
// surfaces — it is keyed on the diff alone and runs on every PR.
//
// The code half was already well pinned (the #510 tests above). What had NO pin was
// the doctrine's claim, so the two could drift for as long as nobody happened to read
// both — which is #499's class and how #516 was found. These two tests are the
// machine-readable half of the sentence #516 corrects: if someone later IMPLEMENTS
// label-conditionality or the heuristic, they fail here, and the failure names the
// doctrine files that must move in the same change.

test('runCheck: decision-gate — the verdict is IDENTICAL with and without the `decision` label (#516)', async () => {
  const diff = {
    diffNameOnly: () => ['brain/project/decisions/adr-0099-new.md'],
    diffNameOnlyAdded: () => ['brain/project/decisions/adr-0099-new.md'],
  };
  const withLabel = await runCheck('decision-gate', { ...diff, ctx: { labels: ['decision'] } });
  const without = await runCheck('decision-gate', { ...diff, ctx: { labels: [] } });

  assert.deepEqual(withLabel, without,
    'decision-gate reads no labels. If this fails, the gate became label-conditional — ' +
    'update brain/core/methodology/workflow-governance.md invariant 4 and ' +
    'brain/project/decisions/adr-0026 GATE_MATRIX in the SAME change (#516).');
  assert.equal(withLabel.pass, false, 'sanity: the case under test must be one the gate actually decides');
});

test('runCheck: decision-gate — an architectural change with NO ADR passes; there is no step-2 heuristic (#516)', async () => {
  // The doctrine names `brain/core/`, `scripts/.*/providers/` and `package.json` as
  // surfaces a heuristic scans. Nothing scans them. A PR touching all three, carrying
  // no ADR and no HOME.md, is simply a pass — no warning, no verdict, no scan.
  const result = await runCheck('decision-gate', {
    diffNameOnly: () => [
      'brain/core/methodology/workflow-governance.md',
      'brain/scripts/axes/vcs/adapters/github.mjs',
      'package.json',
    ],
    diffNameOnlyAdded: () => [],
  });
  assert.deepEqual(result, { pass: true },
    'no architectural-surface heuristic exists. If this fails, step 2 was implemented — ' +
    'the doctrine describing it must stop being aspirational in the same change (#516).');
});

// ── #603: the tier decides the exit code, in ONE place ──────────────────────
// REQ-TIER-3's scenario is normative — "every job whose lite policy is
// detection exits 0 with a warning annotation stating the tier as the reason".
// phase-order-check.mjs and actor-check.mjs already route through
// mapDetectionToWarning; run-check.mjs did not, so `memory-gate` exited 1 at
// `lite`. On GitHub branch protection filtered that; on GitLab, where no such
// layer exists, it BLOCKED an MR on a gate the tier calls advisory.

test('#603: memory-gate failing at LITE → exits 0 and says which gate and which tier', async () => {
  let code;
  const logs = await captureLog(async () => {
    code = await main('memory-gate', {
      readRecords: () => [],
      readConfig: () => ({ governance: { tier: 'lite' } }),
    });
  });
  assert.equal(code, 0, 'detection at this tier — REQ-TIER-3 says 0, not 1');
  // #1024: the path line (REQ-L3-4) now prints ahead of the tier-policied
  // warning — two lines, not one.
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^memory-gate: path=presence/);
  assert.match(logs[1], /memory-gate/, 'the annotation names the gate');
  assert.match(logs[1], /lite/, 'and states the tier as the reason');
  assert.match(logs[1], /::warning::/, 'and is a warning, not silence');
});

test('#603: the SAME failure at STANDARD still exits 1 — the softening is policy-scoped', async () => {
  let code;
  await captureLog(async () => {
    code = await main('memory-gate', {
      readRecords: () => [],
      readConfig: () => ({ governance: { tier: 'standard' } }),
    });
  });
  assert.equal(code, 1, 'memory-gate is required at standard — nothing softens it');
});

test('#603: a REQUIRED gate at lite is untouched — only detection policies soften', async () => {
  let code;
  await captureLog(async () => {
    code = await main('decision-gate', {
      readConfig: () => ({ governance: { tier: 'lite' } }),
      diffNameOnly: () => ['brain/HOME.md'], diffNameOnlyAdded: () => [],
    });
  });
  assert.equal(code, 1, 'decision-gate is required at EVERY tier — lite does not reach it');
});

test('#603: uncomputable is never softened — absent evidence is not a passing gate', async () => {
  let code;
  await captureLog(async () => {
    code = await main('memory-gate', {
      readRecords: () => { throw new Error('store unreadable'); },
      readConfig: () => ({ governance: { tier: 'lite' } }),
    });
  });
  assert.equal(code, 2, 'uncomputable stays 2 at a detection tier — the helper refuses to soften it');
});

// ── #967 PR C ruling 1: base-branch is REQUIRED at every tier, lite included ─
// A deliberate exception to "lite only detects" (design.md D9): detection
// would only have warned about the exact failure this gate exists to prevent
// (the #953 incident). Proven through the full registration surface — the
// dispatch, GATE_MATRIX and mapDetectionToWarning all agree.

test('#967 ruling 1: base-branch failing at LITE still exits 1 — mapDetectionToWarning does not soften it', async () => {
  let code;
  await captureLog(async () => {
    code = await main('base-branch', {
      ctx: { body: 'Closes #337', sourceBranch: 'slice/x', targetBranch: 'main', defaultBranch: 'main' },
      fetchIssue: async (n) => (n === 337 ? { body: SLICE_BODY(878) } : { body: EPIC_TRACKED_BODY }),
      readConfig: () => ({ governance: { tier: 'lite' } }),
    });
  });
  assert.equal(code, 1, 'base-branch is required at every tier, including lite (ruling 1) — nothing softens it');
});

// ── issue-link — recomputes the lane predicate before exempting (#905, spec.md
// "issue-link recomputes the predicate before exempting", design.md A4) ─────
//
// `runIssueLinkCheck` short-circuits on `ctx.sourceBranch` against
// `LANE_BRANCH_RE` BEFORE touching git (property 1) — a non-`memory/*` head
// never calls the diff closures at all. Only when the branch matches does it
// call `classifyLane` (needing the three-dot diff); a lane PR skips
// `issueLink()` entirely. `deps.issueLink` overrides the real evaluator so
// these tests can assert it was never consulted with a literal call-count spy.

test('runCheck: issue-link — a lane-classified ctx passes with no closing keyword, and issueLink() is never consulted (spy asserts zero calls)', async () => {
  let issueLinkCalls = 0;
  const spyIssueLink = () => {
    issueLinkCalls += 1;
    return { pass: false, reason: 'no issue reference found' };
  };
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'memory: host1 2026-09-10 (2 records)', // no closing keyword, no Part-of
      provider: 'github',
      sourceBranch: 'memory/host1-2026-09-10',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameOnly: () => ['.memory/records/a.jsonl', '.memory/records/b.jsonl'],
    diffNameOnlyAdded: () => ['.memory/records/a.jsonl', '.memory/records/b.jsonl'],
    issueLink: spyIssueLink,
    fetchIssue: async () => { throw new Error('must not be called — a lane PR never fetches the issue'); },
    readConfig: () => ({}),
  });
  assert.deepEqual(result, { pass: true });
  assert.equal(issueLinkCalls, 0, 'a lane-classified PR must skip issueLink() entirely');
});

test('runCheck: issue-link — a memory/x-2026-09-10 branch whose diff includes one path outside .memory/records/ is refused by the ordinary issueLink rule, not silently exempted', async () => {
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'no reference at all',
      provider: 'github',
      sourceBranch: 'memory/host1-2026-09-10',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameOnly: () => ['.memory/records/a.jsonl', 'src/index.mjs'],
    diffNameOnlyAdded: () => ['.memory/records/a.jsonl', 'src/index.mjs'],
    fetchIssue: async () => { throw new Error('must not be called — no reference was found'); },
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /no issue reference found/);
});

test('runCheck: issue-link — a memory/x-2026-09-10 branch with one MODIFIED path under .memory/records/ is refused by the ordinary rule, not silently exempted', async () => {
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'no reference at all',
      provider: 'github',
      sourceBranch: 'memory/host1-2026-09-10',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameOnly: () => ['.memory/records/a.jsonl'],
    diffNameOnlyAdded: () => [], // a.jsonl was modified, never added
    fetchIssue: async () => { throw new Error('must not be called — no reference was found'); },
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /no issue reference found/);
});

test('runCheck: issue-link — a THROWING diff on a lane-shaped branch demotes to standard rules, NEVER reported as uncomputable', async () => {
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'Closes #42',
      provider: 'github',
      sourceBranch: 'memory/host1-2026-09-10',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameOnly: () => { throw new Error('git exited with status 128'); },
    diffNameOnlyAdded: () => ['.memory/records/a.jsonl'],
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  // Standard rules apply: "Closes #42" satisfies issueLink() and the
  // default-branch closing-keyword policy, so this passes on the ORDINARY
  // path — never on a silent lane exemption, and never uncomputable:true.
  assert.equal(result.pass, true);
  assert.notEqual(result.uncomputable, true);
});

test('runCheck: issue-link — a THROWING diff on a lane-shaped branch, body carries no reference → fails on the ordinary rule, never uncomputable', async () => {
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'no reference here',
      provider: 'github',
      sourceBranch: 'memory/host1-2026-09-10',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameOnly: () => { throw new Error('git exited with status 128'); },
    diffNameOnlyAdded: () => { throw new Error('git exited with status 128'); },
    fetchIssue: async () => { throw new Error('must not be called'); },
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.notEqual(result.uncomputable, true);
  assert.match(result.reason, /no issue reference found/);
});

test('runCheck: issue-link — a non-memory/* head never calls the diff closures (spy asserts zero calls) — short-circuit before touching git', async () => {
  let diffCalls = 0;
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'Closes #42',
      provider: 'github',
      sourceBranch: 'feat/some-feature',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameOnly: () => { diffCalls += 1; return []; },
    diffNameOnlyAdded: () => { diffCalls += 1; return []; },
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  assert.equal(diffCalls, 0, 'a non-memory/* head must never touch git for the lane predicate');
  assert.deepEqual(result, { pass: true });
});

test('runCheck: issue-link — ctx.sourceBranch absent/null → standard rules apply, diff closures never called', async () => {
  let diffCalls = 0;
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'Closes #42',
      provider: 'github',
      sourceBranch: null,
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameOnly: () => { diffCalls += 1; return []; },
    diffNameOnlyAdded: () => { diffCalls += 1; return []; },
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  assert.equal(diffCalls, 0, 'an absent sourceBranch must never touch git for the lane predicate');
  assert.deepEqual(result, { pass: true });
});

// ── issue-link — recomputes the archive-sweep predicate before exempting
// (#557 phase 9 gap-close, design.md D6 amendment) ──────────────────────
//
// Same discipline as the memory-lane block above: `runIssueLinkCheck`
// short-circuits on `ctx.sourceBranch` against `SWEEP_BRANCH_RE` BEFORE
// touching git; only a matching branch calls `classifySweepDiff` (needing
// the -M100% three-dot diff). A sweep-classified PR skips `issueLink()`
// (and its default-branch closing-keyword requirement) entirely.

test('runCheck: issue-link — a real-shaped sweep diff on auto-archive/<date> passes with "Part of #557." alone, issueLink() never consulted', async () => {
  let issueLinkCalls = 0;
  const spyIssueLink = () => {
    issueLinkCalls += 1;
    return { pass: false, reason: 'no issue reference found' };
  };
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'Part of #557.',
      provider: 'github',
      sourceBranch: 'auto-archive/2026-09-23',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameStatus: () => [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/proposal.md',
      'M\topenspec/specs/existing-cap/spec.md',
      'A\topenspec/specs/new-cap/spec.md',
    ],
    diffNumstatRenames: () => [
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/proposal.md',
      '4\t0\topenspec/specs/existing-cap/spec.md',
      '1\t0\topenspec/specs/new-cap/spec.md',
    ],
    issueLink: spyIssueLink,
    fetchIssue: async () => { throw new Error('must not be called — a sweep-classified PR never fetches the issue'); },
    readConfig: () => ({}),
  });
  assert.deepEqual(result, { pass: true });
  assert.equal(issueLinkCalls, 0, 'a sweep-classified PR must skip issueLink() entirely');
});

test('runCheck: issue-link — an auto-archive/<date> diff carrying one extra code file falls to the ordinary rule and fails (no closing keyword)', async () => {
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'Part of #557.',
      provider: 'github',
      sourceBranch: 'auto-archive/2026-09-23',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameStatus: () => [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/proposal.md',
      'M\tbrain/scripts/governance/run-check.mjs',
    ],
    diffNumstatRenames: () => [
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/proposal.md',
      '10\t2\tbrain/scripts/governance/run-check.mjs',
    ],
    fetchIssue: async () => { throw new Error('must not be called — "Part of" alone never resolves on the default branch'); },
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /must use a closing keyword/);
});

test('runCheck: issue-link — a spec-only edit with no archive rename on auto-archive/<date> falls to the ordinary rule and fails (the hole this predicate closes)', async () => {
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'Part of #557.',
      provider: 'github',
      sourceBranch: 'auto-archive/2026-09-23',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameStatus: () => ['M\topenspec/specs/existing-cap/spec.md'],
    diffNumstatRenames: () => ['4\t0\topenspec/specs/existing-cap/spec.md'],
    fetchIssue: async () => { throw new Error('must not be called — "Part of" alone never resolves on the default branch'); },
    readConfig: () => ({}),
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /must use a closing keyword/);
});

test('runCheck: issue-link — a non-auto-archive/* head with a pure archive-diff shape still needs a closing keyword, diff closures never called', async () => {
  let diffCalls = 0;
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'Part of #557.',
      provider: 'github',
      sourceBranch: 'feat/some-feature',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameStatus: () => { diffCalls += 1; return []; },
    diffNumstatRenames: () => { diffCalls += 1; return []; },
    fetchIssue: async () => { throw new Error('must not be called — "Part of" alone never resolves on the default branch'); },
    readConfig: () => ({}),
  });
  assert.equal(diffCalls, 0, 'a non-auto-archive/* head must never touch git for the sweep predicate');
  assert.equal(result.pass, false);
  assert.match(result.reason, /must use a closing keyword/);
});

test('runCheck: issue-link — a THROWING diff on an auto-archive/<date>-shaped branch demotes to standard rules, NEVER reported as uncomputable', async () => {
  const result = await runCheck('issue-link', {
    ctx: {
      body: 'Closes #557',
      provider: 'github',
      sourceBranch: 'auto-archive/2026-09-23',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameStatus: () => { throw new Error('git exited with status 128'); },
    diffNumstatRenames: () => { throw new Error('git exited with status 128'); },
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    readConfig: () => ({}),
  });
  assert.equal(result.pass, true);
  assert.notEqual(result.uncomputable, true);
});

test('runCheck: issue-link — the ACTUAL body sweep.mjs renders (renderReport) passes on auto-archive/<date> with a real sweep diff', async () => {
  const { renderReport } = await import('./postmerge/sweep.mjs');
  const body = renderReport({
    dateStr: '2026-09-23',
    archived: [{ name: 'issue-9-foo', iid: '9', consolidated: ['existing-cap'], unconsolidated: false }],
    blocked: [],
  });
  assert.match(body, /Part of #557\.\n$/);
  let issueLinkCalls = 0;
  const result = await runCheck('issue-link', {
    ctx: {
      body,
      provider: 'github',
      sourceBranch: 'auto-archive/2026-09-23',
      targetBranch: 'main',
      defaultBranch: 'main',
    },
    diffNameStatus: () => [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/proposal.md',
      'M\topenspec/specs/existing-cap/spec.md',
    ],
    diffNumstatRenames: () => [
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/proposal.md',
      '4\t0\topenspec/specs/existing-cap/spec.md',
    ],
    issueLink: () => { issueLinkCalls += 1; return { pass: false, reason: 'no issue reference found' }; },
    fetchIssue: async () => { throw new Error('must not be called — a sweep-classified PR never fetches the issue'); },
    readConfig: () => ({}),
  });
  assert.deepEqual(result, { pass: true });
  assert.equal(issueLinkCalls, 0);
});
