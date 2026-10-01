// brain-metrics.test.mjs — brain-metrics.mjs CLI (issue #324, M9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseArgs, renderMarkdown, renderJson, detectionConclusion, extractIssueNumber, runMetrics,
} from './brain-metrics.mjs';
import { uncomputable } from './vcs/lib/uncomputable-cause.mjs';

const METRICS_SCRIPT = new URL('./brain-metrics.mjs', import.meta.url).pathname;
const REPO_ROOT = dirname(dirname(fileURLToPath(new URL('.', import.meta.url))));

// ── Fixture helpers (mirrors brain-audit.test.mjs's conventions) ────────────

function makeRepo(dir) {
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
  return git;
}

function commit(git, dir, files, message) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(abs.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(abs, content);
  }
  git('add', '-A');
  git('commit', '-m', message);
}

function headShaOf(git) {
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/, `not a 40-hex sha: ${JSON.stringify(sha)}`);
  return sha;
}

function mergeAddingPayload(git, dir, files, label, mergeMsg) {
  git('checkout', '-b', `feat-${label}`, 'main');
  commit(git, dir, files, `${label}: add payload`);
  git('checkout', 'main');
  const m = git('merge', '--no-ff', `feat-${label}`, '-m', mergeMsg);
  assert.equal(m.status, 0, `merge ${label} failed: ${m.stderr}`);
  return headShaOf(git);
}

function makeSessionSummaryRecord() {
  return JSON.stringify({
    id: 'rec-1', ts: '2026-07-12T12:00:00Z', actor: '@test', actorKind: 'human',
    type: 'session_summary', project: 'brain', content: 'Test session summary',
  }) + '\n';
}

// ── parseArgs (Phase 4.1) ────────────────────────────────────────────────────

test('parseArgs: bare invocation defaults to no range, no json, month period', () => {
  assert.deepEqual(parseArgs([]), { range: undefined, json: false, period: 'month' });
});

test('parseArgs: positional git-range, --json, --period=week all combine', () => {
  assert.deepEqual(
    parseArgs(['origin/main..HEAD', '--json', '--period=week']),
    { range: 'origin/main..HEAD', json: true, period: 'week' },
  );
});

test('parseArgs: rejects an unrecognized flag', () => {
  assert.throws(() => parseArgs(['--bogus']), /unrecognized flag/i);
});

test('parseArgs: rejects a second positional argument', () => {
  assert.throws(() => parseArgs(['a..b', 'c..d']), /extra argument/i);
});

test('parseArgs: rejects an invalid --period value', () => {
  assert.throws(() => parseArgs(['--period=quarter']), /period.*month.*week/i);
});

// ── detectionConclusion / extractIssueNumber ─────────────────────────────────

test('detectionConclusion: maps success/failure (real-shaped UPPERCASE GraphQL enums), never fabricates pass/fail for anything else', () => {
  // GitHub's real `gh pr view --json statusCheckRollup` returns `conclusion`
  // as an UPPERCASE GraphQL enum (SUCCESS/FAILURE/NEUTRAL/...), never
  // lowercase — this fixture must match the real provider shape, or the test
  // can pass while the real integration silently reports 0/0 (the bug this
  // fixture regression-guards against).
  const rollup = [
    { name: 'phase-order', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { name: 'actor-check', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'brain-writes-reviewed', status: 'COMPLETED', conclusion: 'NEUTRAL' },
  ];
  assert.equal(detectionConclusion(rollup, 'phase-order'), 'pass');
  assert.equal(detectionConclusion(rollup, 'actor-check'), 'fail');
  assert.equal(detectionConclusion(rollup, 'brain-writes-reviewed'), null);
  assert.equal(detectionConclusion(rollup, 'not-present'), null);
  assert.equal(detectionConclusion(null, 'phase-order'), null);
});

test('detectionConclusion: the #606 uncomputable rollup shape is treated exactly like the old bare null — never a truthy fall-through (no-regression guarantee)', () => {
  // detectionConclusion() itself is NOT modified by #606 — this is a
  // guarantee test, not a code change. `{uncomputable, reason, detail}` is
  // truthy but !Array.isArray, so it must still return null, identical to
  // what this returned for `rollup === null` before this change.
  assert.equal(detectionConclusion(uncomputable({ detail: 'x' }), 'memory-gate'), null);
});

test('detectionConclusion: also accepts lowercase conclusions (defensive — some providers/fixtures may already be lowercase)', () => {
  const rollup = [
    { name: 'phase-order', status: 'completed', conclusion: 'success' },
    { name: 'actor-check', status: 'completed', conclusion: 'failure' },
  ];
  assert.equal(detectionConclusion(rollup, 'phase-order'), 'pass');
  assert.equal(detectionConclusion(rollup, 'actor-check'), 'fail');
});

test('detectionConclusion (C2): falls back to `status` when `conclusion` is null (GitLab-shaped fixture — GitLab has no conclusion field, always null per its own contract)', () => {
  // gitlab.mjs#prStatusRollup ALWAYS normalizes `conclusion: null` (GitLab's
  // commit-status model has no separate conclusion field distinct from its
  // terminal `status`). Before this fix, `detectionConclusion()` only ever
  // read `conclusion`, so every GitLab repo silently reported 0/0 for all
  // three detection jobs, forever.
  const rollup = [
    { name: 'phase-order', status: 'success', conclusion: null },
    { name: 'actor-check', status: 'failed', conclusion: null },
    { name: 'brain-writes-reviewed', status: 'running', conclusion: null },
  ];
  assert.equal(detectionConclusion(rollup, 'phase-order'), 'pass');
  assert.equal(detectionConclusion(rollup, 'actor-check'), 'fail');
  assert.equal(detectionConclusion(rollup, 'brain-writes-reviewed'), null, 'a non-terminal GitLab status must never fabricate pass/fail');
});

test('detectionConclusion (C2): a real (non-null) conclusion is never overridden by an unrelated status value', () => {
  // Guards against the fallback becoming too eager: GitHub's `NEUTRAL`
  // conclusion is a genuine terminal-but-neither-pass-nor-fail result — it
  // must stay null even if `status` happens to say something else.
  const rollup = [
    { name: 'brain-writes-reviewed', status: 'COMPLETED', conclusion: 'NEUTRAL' },
  ];
  assert.equal(detectionConclusion(rollup, 'brain-writes-reviewed'), null);
});

test('extractIssueNumber: reads a closing reference or a chain reference', () => {
  assert.equal(extractIssueNumber('fix: thing\n\nCloses #42'), 42);
  assert.equal(extractIssueNumber('feat: thing\n\nPart of #7'), 7);
  assert.equal(extractIssueNumber('no reference here'), null);
  assert.equal(extractIssueNumber(null), null);
});

// ── Renderers (Phase 4.2/4.3, H2) ────────────────────────────────────────────

function sampleRow(period) {
  return {
    period,
    changesMerged: 3,
    uncomputable: 0,
    medianLeadTimeDays: 2.5,
    gates: {
      'diff-size': { raw: 1, enforced: 0 },
      'issue-link': { raw: 0, enforced: 0 },
      'decision-gate': { raw: 1, enforced: 1 },
    },
    bypass: { sizeException: 1, skipMemoryGate: 0, skipMemoryGateHonored: 0 },
    detection: {
      'phase-order': { pass: 3, fail: 0 },
      'actor-check': { pass: 2, fail: 1 },
      'brain-writes-reviewed': { pass: 0, fail: 0 },
    },
  };
}

test('renderMarkdown: "No data for this period." when rows is empty (E1)', () => {
  const md = renderMarkdown({
    rows: [], memGate: { pass: true }, memCoverage: { available: true, total: 0, tagged: 0, coveragePct: 0 }, range: 'HEAD', period: 'month',
  });
  assert.match(md, /No data for this period\./);
});

test('renderMarkdown: renders period rows, repo-level memory-gate, and coverage caveat', () => {
  const md = renderMarkdown({
    rows: [sampleRow('2026-07')],
    memGate: { pass: false },
    memCoverage: {
      available: true, total: 10, tagged: 2, coveragePct: 20,
    },
    range: 'origin/main..HEAD',
    period: 'month',
  });
  assert.match(md, /2026-07/);
  assert.match(md, /memory-gate \(memoryPresence\) at HEAD: FAIL/);
  assert.match(md, /2\/10 tagged/);
  assert.match(md, /adoption pending/);
  assert.match(md, /issue-approval proxy|ISSUE-APPROVAL proxy/i);
});

// #1024 (design item 7): skip:memory-gate becomes raw/honored, and gains its
// own by-author section (honored-only, mirroring size:exception's).
test('renderMarkdown: skip:memory-gate renders as raw/honored, and honored usage gets its own by-author section', () => {
  const row = { ...sampleRow('2026-07'), bypass: { sizeException: 0, skipMemoryGate: 3, skipMemoryGateHonored: 1 }, skipMemoryGateByAuthor: { alice: 1 } };
  const md = renderMarkdown({
    rows: [row], memGate: { pass: true }, memCoverage: { available: true, total: 0, tagged: 0, coveragePct: 0 }, range: 'HEAD', period: 'month',
  });
  assert.match(md, /skip:memory-gate \(raw\/honored\)/);
  assert.match(md, /\| 3\/1 \|/);
  assert.match(md, /skip:memory-gate usage by author/);
  assert.match(md, /\| 2026-07 \| alice \| 1 \|/);
});

test('renderMarkdown: memory records "Unavailable" caveat when coverage is unavailable (E2)', () => {
  const md = renderMarkdown({
    rows: [sampleRow('2026-07')],
    memGate: { pass: true },
    memCoverage: {
      available: false, total: 0, tagged: 0, coveragePct: 0,
    },
    range: 'HEAD',
    period: 'month',
  });
  assert.match(md, /Unavailable/);
});

test('renderMarkdown: "Exception usage by author" section breaks size:exception down by author and period (spec "by author" requirement)', () => {
  const rowWithAuthors = { ...sampleRow('2026-07'), bypassByAuthor: { alice: 2, bob: 1 } };
  const md = renderMarkdown({
    rows: [rowWithAuthors],
    memGate: { pass: true },
    memCoverage: {
      available: true, total: 0, tagged: 0, coveragePct: 0,
    },
    range: 'HEAD',
    period: 'month',
  });
  assert.match(md, /## Exception usage by author/);
  assert.match(md, /\| 2026-07 \| alice \| 2 \|/);
  assert.match(md, /\| 2026-07 \| bob \| 1 \|/);
});

test('renderMarkdown: "Exception usage by author" prints a no-usage message when no author data exists', () => {
  const md = renderMarkdown({
    rows: [sampleRow('2026-07')],
    memGate: { pass: true },
    memCoverage: {
      available: true, total: 0, tagged: 0, coveragePct: 0,
    },
    range: 'HEAD',
    period: 'month',
  });
  assert.match(md, /## Exception usage by author/);
  assert.match(md, /No `size:exception` usage recorded/);
});

test('renderJson (H2): a flat, parseable array of period objects, superset of the markdown data', () => {
  const out = renderJson({
    rows: [sampleRow('2026-07'), sampleRow('2026-08')],
    memGate: { pass: true },
    memCoverage: {
      available: true, total: 4, tagged: 1, coveragePct: 25,
    },
  });
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed), 'must be a flat array, not a wrapping object');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].period, '2026-07');
  assert.equal(parsed[0].gates['diff-size'].raw, 1);
  assert.equal(parsed[0].memoryGatePassAtHead, true);
  assert.equal(parsed[0].memoryRecordsCoverage.total, 4);
});

// ── Package script wiring (Phase 4.4) ────────────────────────────────────────

test('package.json declares the brain:metrics script pointing at brain-metrics.mjs', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['brain:metrics'], 'node ./brain/scripts/brain-metrics.mjs');
});

// ── E1/E3 edge cases + integration smoke (Phase 7/8) ─────────────────────────

test('E1 — an empty range prints "No data" and exits 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-e1-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const head = headShaOf(git);

  const r = spawnSync('node', [METRICS_SCRIPT, `${head}..${head}`], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /No data for this period\./);
});

test('E1 — an empty range with --json prints an empty array and exits 0', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-e1-json-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const head = headShaOf(git);

  const r = spawnSync('node', [METRICS_SCRIPT, `${head}..${head}`, '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0\n${r.stdout}\n${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('E3 — an invalid git range prints an actionable error and exits non-zero', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-e3-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  const r = spawnSync('node', [METRICS_SCRIPT, 'not-a-real-ref..HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, `expected non-zero exit\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /invalid git range/i);
  assert.match(r.stdout, /brain:audit|valid range/i);
});

test('integration smoke — a small real history produces sane markdown counts (Phase 8)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-smoke-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);

  // A clean pass.
  mergeAddingPayload(git, dir, { 'src/a.mjs': 'export const a = 1;\n' }, 'A', 'A: small clean Closes #1');
  // An oversized diff WITH size:exception is unreachable without a real VCS
  // adapter (labels come from prView), so this fixture exercises the
  // no-VCS-configured path: prLabels stays null, sizeSkipped is false, and
  // the oversized merge is a genuine raw+enforced diff-size failure.
  const bigFile = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n';
  mergeAddingPayload(git, dir, { 'src/big.mjs': bigFile }, 'B', 'B: oversized Closes #2');

  const r = spawnSync('node', [METRICS_SCRIPT, `${base}..HEAD`, '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0\n${r.stdout}\n${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.length, 1, 'every commit lands in the same month bucket');
  assert.equal(parsed[0].changesMerged, 2);
  assert.equal(parsed[0].gates['diff-size'].raw, 1);
  assert.equal(parsed[0].gates['diff-size'].enforced, 1, 'no VCS configured — no size:exception label reachable, so raw === enforced');
  assert.equal(parsed[0].uncomputable, 0);
});

// ── VCS injection seam (issue #324 C1 review finding) ────────────────────────
// Before this fix, `runMetrics()` always resolved the VCS adapter internally
// via `resolveVcs()`/`getVcs()`, with no way to substitute a fake in a test.
// None of the fixtures above configure `vcs.provider` in `brain.config.json`,
// so `resolveVcs()` silently returns `null` in every test above — the
// lead-time, detection-rollup, and by-author code paths (all gated on
// `vcs` being truthy in `evaluateOneMerge`) had ZERO test coverage. This is
// exactly how the uppercase-conclusion bug (fix round, commit b9cc412)
// shipped undetected. `runMetrics({ ..., vcs })` now accepts an injected
// fake so these three paths are directly testable, offline, no real
// network/gh calls.

test('lead-time (C1): an injected vcs.labelEvents resolves the ISSUE\'s status:approved label-add timestamp', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-vcs-leadtime-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const base = headShaOf(git);
  mergeAddingPayload(
    git, dir, { 'src/a.mjs': 'export const a = 1;\n' }, 'A',
    'Merge pull request #5 from x/y\n\nCloses #1',
  );

  let queriedNumber;
  const mockVcs = {
    prView: async () => ({ labels: [], body: 'Closes #1' }),
    labelEvents: async ({ number }) => {
      queriedNumber = number;
      return [
        { action: 'add', label: 'status:approved', at: '2026-07-01T00:00:00Z', actor: { login: 'reviewer' } },
      ];
    },
  };

  const { output, exitCode } = await runMetrics({ argv: [`${base}..HEAD`, '--json'], cwd: dir, vcs: mockVcs });
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 1);
  assert.equal(queriedNumber, 1, 'lead time must query the ISSUE number (#1), not the PR number (#5)');
  assert.ok(
    typeof parsed[0].medianLeadTimeDays === 'number' && parsed[0].medianLeadTimeDays > 0,
    `expected a positive computed lead time, got ${parsed[0].medianLeadTimeDays}`,
  );
});

// issue #358 Q5 Phase 5 review finding 2: this fixture used to assert BOTH
// `phase-order` AND `actor-check` render as "detection, never blocking"
// columns — that was only ever true because DETECTION_JOB_NAMES was a
// hardcoded, tier-blind literal. `actor-check` is `required` at EVERY tier
// (REQ-TIER-2's never-tiered core, GATE_MATRIX) — it should never have been
// classified as a detection-only signal, at any tier. The fixture now declares
// `governance.tier: 'lite'` (brain's own real declared tier) explicitly, so
// the resolved detectionJobs list is `['phase-order']` only — `actor-check`
// must NOT appear in the rendered `detection` map at all.
test('detection rollup (C1): an injected vcs.prStatusRollup populates tier-scoped detection pass/fail counts — actor-check is excluded (required at every tier)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-vcs-detection-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    'brain.config.json': JSON.stringify({ governance: { tier: 'lite' } }),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  mergeAddingPayload(
    git, dir, { 'src/a.mjs': 'export const a = 1;\n' }, 'A',
    'Merge pull request #7 from x/y\n\nCloses #2',
  );

  let queriedNumber;
  const mockVcs = {
    prView: async () => ({ labels: [], body: 'Closes #2' }),
    // Lead time also fires (issue #2 is referenced) — a fake with no
    // `labelEvents` would throw synchronously inside evaluateOneMerge's lead-
    // time block, folding the WHOLE merge into 'uncomputable' before the
    // detection-rollup block below ever runs. Stub it out (no qualifying
    // approval event) so this test isolates the detection-rollup path only.
    labelEvents: async () => null,
    prStatusRollup: async ({ number }) => {
      queriedNumber = number;
      return [
        { name: 'phase-order', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'actor-check', status: 'COMPLETED', conclusion: 'FAILURE' },
      ];
    },
  };

  const { output, exitCode } = await runMetrics({ argv: [`${base}..HEAD`, '--json'], cwd: dir, vcs: mockVcs });
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 1);
  assert.equal(queriedNumber, 7, 'detection rollup must query the PR number (#7)');
  assert.deepEqual(parsed[0].detection['phase-order'], { pass: 1, fail: 0 });
  assert.equal(
    parsed[0].detection['actor-check'], undefined,
    'actor-check is required at every tier (REQ-TIER-2) — it must never render as a detection-only column',
  );
});

test('by-author (C1): an injected vcs.labelEvents resolves the size:exception label-adding actor', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-vcs-byauthor-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const base = headShaOf(git);
  const bigFile = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n';
  mergeAddingPayload(
    git, dir, { 'src/big.mjs': bigFile }, 'A',
    'Merge pull request #9 from x/y\n\nCloses #3',
  );

  const mockVcs = {
    prView: async () => ({ labels: ['size:exception'], body: 'Closes #3' }),
    labelEvents: async () => ([
      { action: 'add', label: 'size:exception', at: '2026-07-01T00:00:00Z', actor: { login: 'alice' } },
    ]),
  };

  const { output, exitCode } = await runMetrics({ argv: [`${base}..HEAD`, '--json'], cwd: dir, vcs: mockVcs });
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].bypassByAuthor, { alice: 1 });
});

// #1024 (design item 7): skip:memory-gate's "honored" count/by-author is
// resolved via decideMemoryGateOverride at merge time, using the PR's own
// label events, prAuthor and the tier — not a raw label count.
test('by-author (#1024): an injected vcs.labelEvents resolves skip:memory-gate\'s HONORED applier (standard tier, distinct from the PR author)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-vcs-skipmemorygate-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const base = headShaOf(git);
  mergeAddingPayload(
    git, dir, { 'src/b.mjs': 'export const b = 1;\n' }, 'A',
    'Merge pull request #11 from x/y\n\nCloses #4',
  );

  let seenKind;
  const mockVcs = {
    prView: async () => ({ labels: ['skip:memory-gate'], body: 'Closes #4', author: 'bob' }),
    labelEvents: async ({ kind }) => {
      seenKind = kind;
      return [{ action: 'add', label: 'skip:memory-gate', at: '2026-07-01T00:00:00Z', actor: { login: 'alice' } }];
    },
  };

  const { output, exitCode } = await runMetrics({ argv: [`${base}..HEAD`, '--json'], cwd: dir, vcs: mockVcs });
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed.length, 1);
  assert.equal(seenKind, 'mr', 'the PR/MR\'s own label events must be fetched with kind: "mr", not the issue-events default');
  assert.equal(parsed[0].bypass.skipMemoryGate, 1, 'raw count');
  assert.equal(parsed[0].bypass.skipMemoryGateHonored, 1, 'honored at the default "standard" tier, applier distinct from the author');
  assert.deepEqual(parsed[0].skipMemoryGateByAuthor, { alice: 1 });
});

test('by-author (#1024): skip:memory-gate applied by the PR author is counted RAW but never HONORED', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-vcs-skipmemorygate-author-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');
  const base = headShaOf(git);
  mergeAddingPayload(
    git, dir, { 'src/c.mjs': 'export const c = 1;\n' }, 'A',
    'Merge pull request #12 from x/y\n\nCloses #5',
  );

  const mockVcs = {
    prView: async () => ({ labels: ['skip:memory-gate'], body: 'Closes #5', author: 'bob' }),
    labelEvents: async () => ([{ action: 'add', label: 'skip:memory-gate', at: '2026-07-01T00:00:00Z', actor: { login: 'bob' } }]),
  };

  const { output, exitCode } = await runMetrics({ argv: [`${base}..HEAD`, '--json'], cwd: dir, vcs: mockVcs });
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(output);
  assert.equal(parsed[0].bypass.skipMemoryGate, 1);
  assert.equal(parsed[0].bypass.skipMemoryGateHonored, 0);
  assert.deepEqual(parsed[0].skipMemoryGateByAuthor, {});
});

// ── auditBaseline parity (issue #324 B2 fix round) ───────────────────────────
// brain-audit respects `governance.auditBaseline` (skips pre-baseline merges
// rather than failing them). Before this fix, brain-metrics had no baseline
// awareness at all, so a pre-baseline merge that brain-audit itself never
// evaluated (and never failed) would still show up as a raw/enforced gate
// failure in brain-metrics — a measurement that diverges from brain-audit's
// own verdict (spec's Historical re-execution requirement, REQ-7).
//
// Pattern mirrors brain-audit.test.mjs's baseline fixture exactly:
//   A (initial) → MERGE_BAD (no issue link, oversized) → E (config, tag v0.1.0) → MERGE_GOOD (Closes #1)
test('brain-metrics: a pre-baseline merge is skipped, not counted as a raw gate failure (parity with brain-audit)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-baseline-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);

  commit(git, dir, { 'README.md': 'init' }, 'chore: initial (#0)');

  // MERGE_BAD: pre-baseline, no issue link AND an oversized diff — would be
  // TWO raw gate failures (issue-link, diff-size) if metrics evaluated it.
  git('checkout', '-b', 'feature/bad');
  const bigFile = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n';
  commit(git, dir, { 'src/bad.mjs': bigFile }, 'feat: pre-baseline oversized work');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/bad', '-m', 'Merge feature/bad (no issue ref)');

  // Config carrying the baseline, tagged v0.1.0 AFTER MERGE_BAD.
  commit(git, dir, {
    'brain.config.json': JSON.stringify({ governance: { auditBaseline: 'v0.1.0' } }),
  }, 'chore: add audit config Closes #9');   // #518: on the audited line now
  git('tag', 'v0.1.0');

  // MERGE_GOOD: after the baseline tag, all invariants satisfied.
  git('checkout', '-b', 'feature/good');
  commit(git, dir, { '.memory/records/2026-07.jsonl': makeSessionSummaryRecord() },
    'feat: after baseline Closes #1');
  git('checkout', 'main');
  git('merge', '--no-ff', 'feature/good', '-m', 'Merge feature/good Closes #1');

  const r = spawnSync('node', [METRICS_SCRIPT, '--json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0\n${r.stdout}\n${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.length, 1, 'every commit lands in the same month bucket');

  // 4 changes on the audited line since #518 — the two merges plus the two
  // ordinary commits, which the merges-only walk used to skip. MERGE_BAD still
  // contributes ZERO raw gate failures: brain-audit never evaluated it either, and
  // that parity — not the count — is what this test is about.
  assert.equal(parsed[0].changesMerged, 4);
  assert.equal(parsed[0].gates['issue-link'].raw, 0,
    'pre-baseline merge has no issue link, but brain-audit never evaluated it — metrics must not either');
  assert.equal(parsed[0].gates['diff-size'].raw, 0,
    'pre-baseline merge is oversized, but brain-audit never evaluated it — metrics must not either');
  assert.equal(parsed[0].uncomputable, 0, 'a baseline-skip is a deliberate skip, not an uncomputable failure');
});

// ── --help + error-prefix dedup (issue #324 C3 review finding) ───────────────
// Before this fix: `node brain-metrics.mjs --help` exited 1 with a DOUBLED
// prefix (`parseArgs` already prefixes its thrown message with
// "brain-metrics: "; `runMetrics`'s catch re-prefixed it a second time), and
// `--help` was not a recognized flag at all — it fell through to the generic
// "unrecognized flag" rejection.

test('--help (C3): prints usage and exits 0, via runMetrics directly (no subprocess)', async () => {
  const { output, exitCode } = await runMetrics({ argv: ['--help'], cwd: '.' });
  assert.equal(exitCode, 0);
  assert.match(output, /Usage: brain:metrics/i);
  assert.doesNotMatch(output, /unrecognized flag/i);
});

test('--help (C3): CLI subprocess exits 0 and prints usage, not the doubled-prefix error', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-help-'));
  t.after(() => removeTempTree(dir));
  const r = spawnSync('node', [METRICS_SCRIPT, '--help'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /Usage: brain:metrics/i);
  assert.doesNotMatch(r.stdout, /brain-metrics: brain-metrics:/, 'error prefix must never be doubled');
});

test('parseArgs rejection (C3): the error message is never double-prefixed', async () => {
  const { output, exitCode } = await runMetrics({ argv: ['--bogus'], cwd: '.' });
  assert.equal(exitCode, 1);
  assert.doesNotMatch(output, /brain-metrics: brain-metrics:/);
  assert.match(output, /^brain-metrics: unrecognized flag/);
});

test('--period=week buckets the same history into ISO week keys', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-week-'));
  t.after(() => removeTempTree(dir));
  const git = makeRepo(dir);
  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');
  const base = headShaOf(git);
  mergeAddingPayload(git, dir, { 'src/a.mjs': 'export const a = 1;\n' }, 'A', 'A: small clean Closes #1');

  const r = spawnSync('node', [METRICS_SCRIPT, `${base}..HEAD`, '--json', '--period=week'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, `expected exit 0\n${r.stdout}\n${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.length, 1);
  assert.match(parsed[0].period, /^\d{4}-W\d{2}$/);
});
