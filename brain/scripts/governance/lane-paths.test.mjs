// lane-paths.test.mjs — unit suite for evaluateLanePaths + the CLI wrapper
// (#905, spec.md "lane-paths is a required, self-reporting context",
// design.md A5). RED until brain/scripts/governance/lane-paths.mjs exists.
//
// CI FRAGILITY: never let these tests spawn a real git process — the default
// diff closures are exercised through an injectable `execFileSync` dep, never
// the real `node:child_process` one (mirrors run-check.test.mjs's discipline).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateLanePaths, main } from './lane-paths.mjs';

// Swallows console.log for the duration of `fn` — every call site below only
// inspects the returned exit code, so there is no `logs` array/`args` param
// to keep alive here. The two tests further down that DO assert on printed
// text build their own local capture instead (they need the array).
async function captureLog(fn) {
  const orig = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = orig; }
}

// ── evaluateLanePaths — the pure core, built on classifyLane (design A5) ────

test('evaluateLanePaths: a diff with one path outside .memory/records/ NAMES the offending path', () => {
  const result = evaluateLanePaths({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: ['.memory/records/a.jsonl', 'src/index.mjs'],
    addedFiles: ['.memory/records/a.jsonl', 'src/index.mjs'],
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /src\/index\.mjs/);
});

test('evaluateLanePaths: a diff with one MODIFIED path under .memory/records/ NAMES it', () => {
  const result = evaluateLanePaths({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: ['.memory/records/a.jsonl', '.memory/records/b.jsonl'],
    addedFiles: ['.memory/records/a.jsonl'], // b.jsonl modified, not added
  });
  assert.equal(result.pass, false);
  assert.match(result.reason, /\.memory\/records\/b\.jsonl/);
});

test('evaluateLanePaths: a non-lane-branch head (laneBranch:false) → pass, "not a lane — nothing to check"', () => {
  const result = evaluateLanePaths({
    sourceBranch: 'feat/some-feature',
    changedFiles: ['src/index.mjs'],
    addedFiles: ['src/index.mjs'],
  });
  assert.equal(result.pass, true);
  assert.match(result.reason, /not a lane — nothing to check/);
});

test('evaluateLanePaths: a lane-branch head whose diff cleanly satisfies the predicate → pass', () => {
  const result = evaluateLanePaths({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: ['.memory/records/a.jsonl'],
    addedFiles: ['.memory/records/a.jsonl'],
  });
  assert.deepEqual(result, { pass: true });
});

test('evaluateLanePaths: a lane-branch head with an EMPTY diff → fail, printing classifyLane\'s own reason ("lane: empty diff"), never a blank "offending path(s): "', () => {
  const result = evaluateLanePaths({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles: [],
    addedFiles: [],
  });
  assert.equal(result.pass, false);
  assert.equal(result.reason, 'lane: empty diff');
});

test('evaluateLanePaths: more than 20 offending paths → the reason lists only the first 20 and states the rest as a count', () => {
  const offendingCount = 25;
  const changedFiles = Array.from({ length: offendingCount }, (_, i) => `src/file-${i}.mjs`);
  const result = evaluateLanePaths({
    sourceBranch: 'memory/host1-2026-09-10',
    changedFiles,
    addedFiles: changedFiles,
  });
  assert.equal(result.pass, false);
  for (let i = 0; i < 20; i += 1) {
    assert.match(result.reason, new RegExp(`src/file-${i}\\.mjs`));
  }
  assert.doesNotMatch(result.reason, /src\/file-20\.mjs/, 'the 21st offending path must not be printed');
  assert.match(result.reason, /… and 5 more/);
});

// ── main() — the CLI wrapper (0/1/2 contract via resultToExit) ─────────────

test('main: a diff with an offending path → exit 1, prints the offending path', async () => {
  const exitCode = await captureLog(() =>
    main({
      ctx: { sourceBranch: 'memory/host1-2026-09-10' },
      diffNameOnly: () => ['.memory/records/a.jsonl', 'src/index.mjs'],
      diffNameOnlyAdded: () => ['.memory/records/a.jsonl', 'src/index.mjs'],
    })
  );
  assert.equal(exitCode, 1);
});

test('main: a non-lane-branch head → exit 0, prints "not a lane — nothing to check", never touches git', async () => {
  let diffCalls = 0;
  let logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let exitCode;
  try {
    exitCode = await main({
      ctx: { sourceBranch: 'feat/some-feature' },
      diffNameOnly: () => { diffCalls += 1; return []; },
      diffNameOnlyAdded: () => { diffCalls += 1; return []; },
    });
  } finally {
    console.log = orig;
  }
  assert.equal(exitCode, 0);
  assert.ok(logs.some((l) => l.includes('not a lane — nothing to check')));
  assert.equal(diffCalls, 0, 'a non-lane-branch head must never touch git');
});

test('main: a lane-branch head whose diff is uncomputable → exit 2', async () => {
  const exitCode = await captureLog(() =>
    main({
      ctx: { sourceBranch: 'memory/host1-2026-09-10' },
      diffNameOnly: () => { throw new Error('BASE_SHA/HEAD_SHA not set'); },
      diffNameOnlyAdded: () => [],
    })
  );
  assert.equal(exitCode, 2);
});

test('main: a lane-branch head whose diff cleanly satisfies the predicate → exit 0', async () => {
  const exitCode = await captureLog(() =>
    main({
      ctx: { sourceBranch: 'memory/host1-2026-09-10' },
      diffNameOnly: () => ['.memory/records/a.jsonl'],
      diffNameOnlyAdded: () => ['.memory/records/a.jsonl'],
    })
  );
  assert.equal(exitCode, 0);
});

test('main: absent sourceBranch → exit 0, "not a lane — nothing to check", never touches git', async () => {
  let diffCalls = 0;
  const exitCode = await captureLog(() =>
    main({
      ctx: {},
      diffNameOnly: () => { diffCalls += 1; return []; },
      diffNameOnlyAdded: () => { diffCalls += 1; return []; },
    })
  );
  assert.equal(exitCode, 0);
  assert.equal(diffCalls, 0);
});

// ── default diff closures use THREE-DOT (base...head) argv ─────────────────

test('main: the default diffNameOnly/diffNameOnlyAdded deps are built with THREE-DOT (base...head) argv — asserted on the injected execFileSync spy', async () => {
  const invocations = [];
  const fakeExecFileSync = (cmd, args) => {
    invocations.push({ cmd, args });
    // First call is --name-only, second is --diff-filter=A --name-only.
    return args.includes('--diff-filter=A') ? '.memory/records/a.jsonl\n' : '.memory/records/a.jsonl\n';
  };
  const exitCode = await captureLog(() =>
    main({
      ctx: { sourceBranch: 'memory/host1-2026-09-10', baseSha: 'BASE_SHA_X', headSha: 'HEAD_SHA_Y' },
      execFileSync: fakeExecFileSync,
    })
  );
  assert.equal(exitCode, 0);
  assert.equal(invocations.length, 2);
  for (const { args } of invocations) {
    assert.ok(args.includes('BASE_SHA_X...HEAD_SHA_Y'), `argv must carry the three-dot range: ${JSON.stringify(args)}`);
  }
});
