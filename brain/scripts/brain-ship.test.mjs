// brain-ship.test.mjs — TDD tests for brain:ship (REQ-S5-4, issue #334)
//
// brain:ship:
//   1. Runs brain:check (via subprocess or injected fn)
//   2. Exits non-zero if any check fails
//   3. Reads the linked issue (issueViewFn) and finds its type:* label
//   4. Confirms that label exists on the remote (labelPreflightFn) — never
//      re-mapped, travels VERBATIM to the write
//   5. Calls mrCreate via the VCS adapter with template + `Closes #<issue>` +
//      the verbatim label; the title prefix is derived from the SAME label
//      via deriveBranchType, independently of what is sent as the label
//   6. Prints PR URL on success
//
// Ordering (design A4): checkFn → issueViewFn → findTypeLabel →
// labelPreflightFn → mrCreateFn. issueViewFn's failure-path stub REJECTS
// (design A5 — issueView throws on the real providers; a stub returning
// `null` would re-commit the exact seam infidelity #334 exists to fix).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Import safety regression ───────────────────────────────────────────────────

test('brain-ship: importing is side-effect-free (CLI guard holds)', async () => {
  const mod = await import('./brain-ship.mjs');
  assert.equal(typeof mod.runShip, 'function', 'runShip must be exported');
});

// ── runShip unit tests (injected dependencies) ────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    issueNumber: '42',
    project: 'o/r',
    branchName: 'feature/42-my-feature',
    base: 'main',
    checkFn: async () => ({ ok: true }),
    headPushedFn: async () => ({ state: 'in-sync' }),
    issueViewFn: async () => ({ number: 42, title: 'add cli i18n', labels: ['type:feature'], body: '', author: 'alice' }),
    labelPreflightFn: async () => ({ exists: true }),
    mrCreateFn: async ({ title, body, head, base, labels }) => ({
      url: 'https://github.com/o/r/pull/99',
    }),
    ...overrides,
  };
}

test('brain-ship: checks pass, type label present + confirmed → exitCode 0, prints URL', async () => {
  const { runShip } = await import('./brain-ship.mjs');
  const result = await runShip(makeCtx());

  assert.equal(result.exitCode, 0,
    `expected exit 0, got ${result.exitCode}: ${result.message}`);
  assert.ok(result.url, 'should have a URL');
  assert.ok(result.url.includes('github.com'), `unexpected URL: ${result.url}`);
});

test('brain-ship: PR label is the issue\'s type:* label VERBATIM — never re-mapped', async () => {
  const { runShip } = await import('./brain-ship.mjs');

  let capturedLabels;
  await runShip(makeCtx({
    issueViewFn: async () => ({ number: 42, title: 'x', labels: ['status:approved', 'type:bug'], body: '', author: 'alice' }),
    mrCreateFn: async ({ labels }) => { capturedLabels = labels; return { url: 'https://github.com/o/r/pull/1' }; },
  }));

  assert.deepEqual(capturedLabels, ['type:bug'], 'mrCreateFn must receive EXACTLY the issue\'s type:* label, verbatim');
});

test('brain-ship: title prefix is derived from the SAME label via deriveBranchType, independent of the label sent', async () => {
  const { runShip } = await import('./brain-ship.mjs');

  let capturedTitle;
  let capturedLabels;
  await runShip(makeCtx({
    branchName: 'feature/42-add-cli-i18n',
    issueViewFn: async () => ({ number: 42, title: 'this issue title is NOT the title source', labels: ['type:feature'], body: '', author: 'alice' }),
    mrCreateFn: async ({ title, labels }) => { capturedTitle = title; capturedLabels = labels; return { url: 'https://github.com/o/r/pull/1' }; },
  }));

  assert.equal(capturedTitle, 'feat: add cli i18n', 'title must be conventional-commit formatted: "<type>: <branch-slug>" — the branch slug, not the issue title');
  assert.deepEqual(capturedLabels, ['type:feature'], 'label must be independent of the title-prefix derivation');
});

test('brain-ship: GitLab-scoped type::bug label maps title to "fix:" while the label itself stays verbatim', async () => {
  const { runShip } = await import('./brain-ship.mjs');

  let capturedTitle;
  let capturedLabels;
  await runShip(makeCtx({
    branchName: 'fix/42-my-feature',
    issueViewFn: async () => ({ number: 42, title: 'my feature', labels: ['type::bug'], body: '', author: 'alice' }),
    mrCreateFn: async ({ title, labels }) => { capturedTitle = title; capturedLabels = labels; return { url: 'https://gitlab.com/o/r/-/merge_requests/1' }; },
  }));

  assert.equal(capturedTitle, 'fix: my feature');
  assert.deepEqual(capturedLabels, ['type::bug']);
});

test('brain-ship: brain:check fails → exits 1, no issue lookup, no PR created (zero remote calls on a red tree)', async () => {
  const { runShip } = await import('./brain-ship.mjs');

  let issueViewed = false;
  let prCreated = false;
  const result = await runShip(makeCtx({
    checkFn: async () => ({ ok: false, output: '1 check failed' }),
    issueViewFn: async () => { issueViewed = true; return { number: 42, title: 'x', labels: ['type:bug'], body: '', author: null }; },
    mrCreateFn: async () => { prCreated = true; return { url: 'X' }; },
  }));

  assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
  assert.equal(issueViewed, false, 'issueViewFn must not be called when checks fail (design A4 ordering)');
  assert.equal(prCreated, false, 'PR must not be created when checks fail');
});

test('brain-ship: issueViewFn rejects (issue not found) → exits 1, no PR created', async () => {
  const { runShip } = await import('./brain-ship.mjs');

  let prCreated = false;
  const result = await runShip(makeCtx({
    // A5: the real providers THROW on an unreachable issue — the stub must
    // reject too, not return null, or this test re-commits the seam bug.
    issueViewFn: async () => { throw new Error('HTTP 404: Not Found'); },
    mrCreateFn: async () => { prCreated = true; return { url: 'X' }; },
  }));

  assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
  assert.ok(result.message.includes('42'), `message should reference the issue number: ${result.message}`);
  assert.equal(prCreated, false, 'PR must not be created when the issue cannot be fetched');
});

test('brain-ship: no type:* label on the issue → exits 1, actionable message, no PR created', async () => {
  const { runShip } = await import('./brain-ship.mjs');

  let prCreated = false;
  const result = await runShip(makeCtx({
    issueViewFn: async () => ({ number: 42, title: 'x', labels: ['status:approved', 'good first issue'], body: '', author: null }),
    mrCreateFn: async () => { prCreated = true; return { url: 'X' }; },
  }));

  assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
  assert.match(result.message, /no type:\* label/i, `message must explain the missing type:* label: ${result.message}`);
  assert.match(result.message, /42/, `message must reference the issue number: ${result.message}`);
  assert.equal(prCreated, false, 'PR must not be created when no type:* label is found');
});

test('brain-ship: label not confirmed on the remote (preflight exists:false) → exits 1, no PR created', async () => {
  const { runShip } = await import('./brain-ship.mjs');

  let prCreated = false;
  const result = await runShip(makeCtx({
    issueViewFn: async () => ({ number: 42, title: 'x', labels: ['type:bug'], body: '', author: null }),
    labelPreflightFn: async () => ({ exists: false }),
    mrCreateFn: async () => { prCreated = true; return { url: 'X' }; },
  }));

  assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
  assert.match(result.message, /type:bug/, `message must reference the missing label: ${result.message}`);
  assert.equal(prCreated, false, 'PR must not be created when the label preflight rejects');
});

test('brain-ship: label preflight lookup itself failed (fail closed) → exits 1, no PR created', async () => {
  const { runShip } = await import('./brain-ship.mjs');

  let prCreated = false;
  const result = await runShip(makeCtx({
    issueViewFn: async () => ({ number: 42, title: 'x', labels: ['type:bug'], body: '', author: null }),
    labelPreflightFn: async () => ({ exists: false, error: 'network down' }),
    mrCreateFn: async () => { prCreated = true; return { url: 'X' }; },
  }));

  assert.equal(result.exitCode, 1, `expected exit 1, got ${result.exitCode}`);
  assert.match(result.message, /network down/, `message must surface the underlying lookup error: ${result.message}`);
  assert.equal(prCreated, false, 'PR must not be created when the label preflight is uncomputable (fail closed)');
});

test('brain-ship: PR body contains Closes #<issue>', async () => {
  const { runShip } = await import('./brain-ship.mjs');

  let capturedBody = '';
  await runShip(makeCtx({
    mrCreateFn: async ({ body }) => { capturedBody = body; return { url: 'https://github.com/o/r/pull/1' }; },
  }));

  assert.ok(/closes\s+#42/i.test(capturedBody),
    `PR body must contain "Closes #42": "${capturedBody}"`);
});

test('brain-ship: mrCreate failure → exits 1 with error message', async () => {
  const { runShip } = await import('./brain-ship.mjs');

  const result = await runShip(makeCtx({
    mrCreateFn: async () => ({ url: null, error: 'HTTP 422: Validation failed' }),
  }));

  assert.equal(result.exitCode, 1, `expected exit 1 on mrCreate failure`);
  assert.ok(result.message.includes('422') || result.message.toLowerCase().includes('failed'),
    `message should include error: ${result.message}`);
});

// ── resolveIssueNumber (branch → issue number, fails CLOSED) ──────────────────
// The CLI entry-point used to fall back to '0' on an unparseable branch, which
// fabricated a `Closes #0` footer and looked up a non-existent issue. An
// uncomputable issue number is now an actionable refusal, not a placeholder.

test('brain-ship: resolveIssueNumber extracts the issue number from a conventional branch name', async () => {
  const { resolveIssueNumber } = await import('./brain-ship.mjs');

  assert.deepEqual(resolveIssueNumber('feature/42-add-cli-i18n'), { issueNumber: '42' });
  assert.deepEqual(resolveIssueNumber('fix/7-thing'), { issueNumber: '7' });
  assert.deepEqual(resolveIssueNumber('chore/334-brain-ship-labels'), { issueNumber: '334' });
});

test('brain-ship: resolveIssueNumber reads the canonical branch brain:ticket:start emits (#697)', async () => {
  const { resolveIssueNumber } = await import('./brain-ship.mjs');

  assert.deepEqual(resolveIssueNumber('fix/issue-639-some-slug'), { issueNumber: '639' });
  assert.deepEqual(resolveIssueNumber('feat/issue-3-x'), { issueNumber: '3' });
});

test('brain-ship: refusal names BOTH accepted shapes and brain:ticket:start (#697)', async () => {
  const { resolveIssueNumber } = await import('./brain-ship.mjs');

  const { message } = resolveIssueNumber('claude/some-slug');
  assert.match(message, /<type>\/issue-<number>-<slug>/);
  assert.match(message, /<prefix>\/<number>-<slug>/);
  assert.match(message, /brain:ticket:start/);
});

test('brain-ship: titleFromBranch drops the issue- marker on the canonical shape (#697)', async () => {
  const { titleFromBranch } = await import('./brain-ship.mjs');

  assert.equal(titleFromBranch('fix/issue-639-some-slug', 'fix'), 'fix: some slug');
  assert.equal(titleFromBranch('feature/42-add-cli-i18n', 'feat'), 'feat: add cli i18n');
});

test('brain-ship: resolveIssueNumber on an unparseable branch → exitCode 1, NEVER a fabricated "0"', async () => {
  const { resolveIssueNumber } = await import('./brain-ship.mjs');

  const result = resolveIssueNumber('main');

  assert.equal(result.exitCode, 1, 'an unparseable branch must fail closed, not fall back to issue "0"');
  assert.equal(result.issueNumber, undefined, 'no issue number may be fabricated when the branch does not encode one');
  assert.match(result.message, /main/, `message must quote the offending branch: ${result.message}`);
  assert.match(result.message, /<prefix>\/<number>-<slug>/, `message must state the expected shape: ${result.message}`);
});

test('brain-ship: resolveIssueNumber rejects branches that carry no <number>- segment', async () => {
  const { resolveIssueNumber } = await import('./brain-ship.mjs');

  for (const branch of ['feature/no-number-here', 'feature/42', '42-no-prefix', '', undefined]) {
    const result = resolveIssueNumber(branch);
    assert.equal(result.exitCode, 1, `branch "${branch}" must not resolve to an issue number`);
  }
});

// ── #1207: the head must be on the remote and equal to local HEAD ─────────────

test('#1207 an unpushed branch is refused with ZERO forge calls, naming git push -u', async () => {
  const { runShip } = await import('./brain-ship.mjs');
  const calls = [];
  const result = await runShip(makeCtx({
    headPushedFn: async () => ({ state: 'missing' }),
    issueViewFn: async () => { calls.push('issueView'); return { labels: ['type:feature'] }; },
    labelPreflightFn: async () => { calls.push('preflight'); return { exists: true }; },
    mrCreateFn: async () => { calls.push('mrCreate'); return { url: 'u' }; },
  }));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, [], 'no forge call of any kind before the head is on the remote');
  assert.match(result.message, /git push -u origin feature\/42-my-feature/);
  assert.ok(!/GraphQL/.test(result.message));
});

test('#1207 a remote ref behind local HEAD is refused, naming git push', async () => {
  const { runShip } = await import('./brain-ship.mjs');
  let created = false;
  const result = await runShip(makeCtx({
    headPushedFn: async () => ({ state: 'behind' }),
    mrCreateFn: async () => { created = true; return { url: 'u' }; },
  }));
  assert.equal(result.exitCode, 1);
  assert.equal(created, false);
  assert.match(result.message, /git push origin feature\/42-my-feature/);
  assert.ok(!/push -u/.test(result.message));
});

test('#1207 a remote ref that diverged is refused and does not suggest a plain push', async () => {
  const { runShip } = await import('./brain-ship.mjs');
  const result = await runShip(makeCtx({ headPushedFn: async () => ({ state: 'diverged' }) }));
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /diverged|not in your local history/i);
});

test('#1207 an unreadable remote refuses, naming the cause', async () => {
  const { runShip } = await import('./brain-ship.mjs');
  const result = await runShip(makeCtx({ headPushedFn: async () => ({ state: 'unknown', error: 'could not resolve host' }) }));
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /could not resolve host/);
});

test('#1207 a red check still wins: head check is not consulted, ordering checkFn -> headPushedFn -> issueViewFn', async () => {
  const { runShip } = await import('./brain-ship.mjs');
  const order = [];
  await runShip(makeCtx({
    checkFn: async () => { order.push('check'); return { ok: false }; },
    headPushedFn: async () => { order.push('head'); return { state: 'in-sync' }; },
  }));
  assert.deepEqual(order, ['check']);
  order.length = 0;
  await runShip(makeCtx({
    checkFn: async () => { order.push('check'); return { ok: true }; },
    headPushedFn: async () => { order.push('head'); return { state: 'in-sync' }; },
    issueViewFn: async () => { order.push('issue'); return { labels: ['type:feature'] }; },
  }));
  assert.deepEqual(order.slice(0, 3), ['check', 'head', 'issue']);
});

test('#1207 checkHeadPushed: git plumbing only, classifies missing / in-sync / behind / diverged / unknown', async () => {
  const { checkHeadPushed } = await import('./brain-ship.mjs');
  const make = ({ remote, head = 'aaa', ancestor = false, lsOk = true }) => {
    const seen = [];
    const gitFn = (args) => {
      seen.push(args.join(' '));
      if (args[0] === 'ls-remote') return { ok: lsOk, out: remote ? `${remote}\trefs/heads/b` : '', err: lsOk ? '' : 'boom' };
      if (args[0] === 'rev-parse') return { ok: true, out: head };
      if (args[0] === 'merge-base') return { ok: ancestor, out: '' };
      return { ok: false, out: '' };
    };
    return { gitFn, seen };
  };
  let c = make({ remote: '' });
  assert.deepEqual(await checkHeadPushed({ branch: 'b', gitFn: c.gitFn }), { state: 'missing' });
  assert.deepEqual(c.seen[0].split(' ').slice(0, 3), ['ls-remote', 'origin', 'refs/heads/b']);
  c = make({ remote: 'aaa' });
  assert.deepEqual(await checkHeadPushed({ branch: 'b', gitFn: c.gitFn }), { state: 'in-sync' });
  c = make({ remote: 'bbb', ancestor: true });
  assert.deepEqual(await checkHeadPushed({ branch: 'b', gitFn: c.gitFn }), { state: 'behind' });
  c = make({ remote: 'bbb', ancestor: false });
  assert.deepEqual(await checkHeadPushed({ branch: 'b', gitFn: c.gitFn }), { state: 'diverged' });
  c = make({ remote: '', lsOk: false });
  assert.deepEqual(await checkHeadPushed({ branch: 'b', gitFn: c.gitFn }), { state: 'unknown', error: 'boom' });
});
