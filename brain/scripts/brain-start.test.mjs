// brain-start.test.mjs — TDD tests for brain:start (REQ-S5-1)
//
// brain:start <issue>
//   1. Calls issueView() via VCS adapter
//   2. Asserts status:approved label → creates branch
//   3. Exits non-zero if unapproved or not found
//   4. Importing is side-effect-free

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Import safety regression ───────────────────────────────────────────────────

test('brain-start: importing is side-effect-free (CLI guard holds)', async () => {
  const mod = await import('./brain-start.mjs');
  assert.equal(typeof mod.runStart, 'function', 'runStart must be exported');
});

// ── runStart unit tests (injected dependencies) ───────────────────────────────

test('brain-start: status:approved issue → creates branch and exits 0', async () => {
  const { runStart } = await import('./brain-start.mjs');

  const branchesCreated = [];
  const result = await runStart({
    issueNumber: '42',
    project: 'o/r',
    issueViewFn: async () => ({
      number: 42,
      title: 'Add a great feature',
      labels: ['status:approved', 'kind:feature'],
      body: 'Do something awesome.',
    }),
    createBranchFn: async (branch) => { branchesCreated.push(branch); return { ok: true }; },
  });

  assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.message}`);
  assert.equal(branchesCreated.length, 1, 'branch must be created exactly once');
  assert.ok(branchesCreated[0].includes('42'), 'branch name must include issue number');
});

test('brain-start: missing status:approved → refuses with clear message (exit 1)', async () => {
  const { runStart } = await import('./brain-start.mjs');

  const result = await runStart({
    issueNumber: '7',
    project: 'o/r',
    issueViewFn: async () => ({
      number: 7,
      title: 'Unapproved idea',
      labels: ['status:draft'],
      body: 'Not ready.',
    }),
    createBranchFn: async () => { throw new Error('should not be called'); },
  });

  assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
  assert.ok(result.message.toLowerCase().includes('approved'),
    `message should mention "approved": ${result.message}`);
});

test('brain-start: issue not found (issueViewFn throws) → exits 1 with clear message', async () => {
  const { runStart } = await import('./brain-start.mjs');

  const result = await runStart({
    issueNumber: '999',
    project: 'o/r',
    issueViewFn: async () => { throw new Error('HTTP 404: Not Found'); },
    createBranchFn: async () => { throw new Error('should not be called'); },
  });

  assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
  assert.ok(result.message.toLowerCase().includes('not found') || result.message.includes('999'),
    `message should reference the issue or error: ${result.message}`);
});

test('brain-start: branch name is derived from issue number and title slug', async () => {
  const { runStart } = await import('./brain-start.mjs');

  const branchesCreated = [];
  await runStart({
    issueNumber: '13',
    project: 'o/r',
    issueViewFn: async () => ({
      number: 13,
      title: 'Add CLI support for i18n',
      labels: ['status:approved'],
      body: '',
    }),
    createBranchFn: async (branch) => { branchesCreated.push(branch); return { ok: true }; },
  });

  assert.equal(branchesCreated.length, 1);
  // branch must include the issue number
  assert.ok(branchesCreated[0].includes('13'),
    `branch "${branchesCreated[0]}" must include "13"`);
  // branch must be slug-safe (no spaces, no special chars beyond / and -)
  assert.ok(/^[a-z0-9/._-]+$/i.test(branchesCreated[0]),
    `branch "${branchesCreated[0]}" has non-slug chars`);
});

// ── REQ-A2-3 (issue #231 A2 phase 1): the approved label is config-driven ──────

test('REQ-A2-3: brain-start.mjs source contains no literal status:approved (reads the resolved governance.approvedLabel value)', () => {
  const srcPath = fileURLToPath(new URL('./brain-start.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.equal(src.includes('status:approved'), false,
    'source must not hardcode the approved-label literal — use resolveApprovedLabel()');
});

test('brain-start: runStart honors a custom approvedLabel override (config-driven, provider-resolved)', async () => {
  const { runStart } = await import('./brain-start.mjs');

  const branchesCreated = [];
  const result = await runStart({
    issueNumber: '55',
    project: 'o/r',
    approvedLabel: 'ready:approved',
    issueViewFn: async () => ({
      number: 55,
      title: 'Custom approved label',
      labels: ['ready:approved'],
      body: '',
    }),
    createBranchFn: async (branch) => { branchesCreated.push(branch); return { ok: true }; },
  });

  assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}: ${result.message}`);
  assert.equal(branchesCreated.length, 1);
});

test('brain-start: with a custom approvedLabel override, the default label no longer satisfies approval', async () => {
  const { runStart } = await import('./brain-start.mjs');

  const result = await runStart({
    issueNumber: '56',
    project: 'o/r',
    approvedLabel: 'ready:approved',
    issueViewFn: async () => ({
      number: 56,
      title: 'Default label present but override configured',
      labels: ['status:approved'],
      body: '',
    }),
    createBranchFn: async () => { throw new Error('should not be called'); },
  });

  assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
});

for (const title of ['!!!', '日本語']) {
  test(`brain-start: title "${title}" with no ASCII alphanumerics → feature/<N>-task (#697)`, async () => {
    const { runStart } = await import('./brain-start.mjs');
    const created = [];
    const result = await runStart({
      issueNumber: '42', project: 'o/r',
      issueViewFn: async () => ({ number: 42, title, labels: ['status:approved'], body: '' }),
      createBranchFn: async (b) => { created.push(b); return { ok: true }; },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(created, ['feature/42-task']);
  });
}
