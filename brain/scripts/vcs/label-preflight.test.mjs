// label-preflight.test.mjs — unit tests for labelPreflight (issue #334,
// vcs-label-preflight spec). Root-cause guard, run BEFORE a mutating write
// (mrCreateFn): the two providers disagree on an unknown label — `gh pr
// create --label` hard-errors, GitLab's MR-create payload SILENTLY CREATES
// it, polluting the project taxonomy (design A2). labelPreflight converts
// both into one uniform, local, actionable, NEVER-THROWING refusal.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { labelPreflight } from './label-preflight.mjs';
import { setSpawn } from './lib/exec.mjs';

afterEach(() => setSpawn(spawnSync));

test('labelPreflight: label exists in the remote set → { exists: true }', async () => {
  const result = await labelPreflight({
    provider: 'github',
    project: 'x/y',
    label: 'type:bug',
    labelListFn: async () => ['type:bug', 'type:feature'],
  });
  assert.deepEqual(result, { exists: true });
});

test('labelPreflight: label absent from the remote set → { exists: false }, no error (a real result, not a failure)', async () => {
  const result = await labelPreflight({
    provider: 'github',
    project: 'x/y',
    label: 'type:missing',
    labelListFn: async () => ['type:bug'],
  });
  assert.equal(result.exists, false);
  assert.equal(result.error, undefined, 'a clean "not found" result must not carry an error key');
});

test('labelPreflight: exact case-sensitive match — differing case does not match', async () => {
  const result = await labelPreflight({
    provider: 'github',
    project: 'x/y',
    label: 'type:bug',
    labelListFn: async () => ['Type:Bug'],
  });
  assert.equal(result.exists, false, 'label matching must be exact and case-sensitive');
});

test('labelPreflight: NEVER throws — a labelListFn rejection resolves to { exists: false, error }, fail CLOSED', async () => {
  const result = await labelPreflight({
    provider: 'github',
    project: 'x/y',
    label: 'type:bug',
    labelListFn: async () => { throw new Error('network down'); },
  });
  assert.equal(result.exists, false, 'an uncomputable lookup must fail CLOSED — never a fabricated exists:true');
  assert.equal(typeof result.error, 'string');
  assert.match(result.error, /network down/);
});

test('labelPreflight: no caching — two calls invoke labelListFn twice (every call re-checks the remote)', async () => {
  let calls = 0;
  const labelListFn = async () => { calls += 1; return ['type:bug']; };
  await labelPreflight({ provider: 'github', project: 'x/y', label: 'type:bug', labelListFn });
  await labelPreflight({ provider: 'github', project: 'x/y', label: 'type:bug', labelListFn });
  assert.equal(calls, 2, 'labelPreflight must never cache — every call re-checks the remote (deliberately unlike capabilities())');
});

test('labelPreflight: gitlab provider — same never-throws, exact-match contract', async () => {
  const found = await labelPreflight({
    provider: 'gitlab',
    project: 'g/p',
    label: 'type::bug',
    labelListFn: async () => ['type::bug', 'status::approved'],
  });
  assert.deepEqual(found, { exists: true });

  const notFound = await labelPreflight({
    provider: 'gitlab',
    project: 'g/p',
    label: 'type::missing',
    labelListFn: async () => ['type::bug'],
  });
  assert.equal(notFound.exists, false);
});

test('labelPreflight: an unsupported provider fails CLOSED rather than throwing', async () => {
  const result = await labelPreflight({ provider: 'bitbucket', project: 'x/y', label: 'type:bug' });
  assert.equal(result.exists, false);
  assert.equal(typeof result.error, 'string');
});

// ── PROVIDER_LABEL_LIST dispatch ───────────────────────────────────────────
// Every test above injects `labelListFn`, which SHORT-CIRCUITS the dispatch
// table — the wiring `labelPreflight` actually uses in production
// (brain-ship.mjs passes only { provider, project, label }) was never
// exercised. These two omit `labelListFn` on purpose and stub the transport
// seam one layer lower instead (github: the exec.mjs `setSpawn` seam; gitlab:
// `globalThis.fetch`), so a broken/renamed PROVIDER_LABEL_LIST entry fails
// here rather than in a real ship. No network, no CLI.

test('labelPreflight: no labelListFn injected + provider "github" → dispatches to github.labelList (gh api)', async () => {
  let capturedCmd;
  let capturedArgs;
  setSpawn((cmd, args) => {
    capturedCmd = cmd;
    capturedArgs = args;
    return { status: 0, stdout: JSON.stringify([{ name: 'type:bug' }, { name: 'type:feature' }]), stderr: '' };
  });

  const result = await labelPreflight({ provider: 'github', project: 'x/y', label: 'type:bug' });

  assert.deepEqual(result, { exists: true }, 'PROVIDER_LABEL_LIST["github"] must resolve to the real github.labelList');
  assert.equal(capturedCmd, 'gh', 'the github dispatch must reach the gh CLI transport');
  assert.ok(
    capturedArgs.some(a => a.includes('repos/x/y/labels')),
    `the github dispatch must query the project's label set: ${JSON.stringify(capturedArgs)}`,
  );
});

test('labelPreflight: no labelListFn injected + provider "gitlab" → dispatches to gitlab.labelList (REST v4)', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    return { ok: true, json: async () => [{ name: 'type::bug' }, { name: 'status::approved' }] };
  };

  try {
    const result = await labelPreflight({ provider: 'gitlab', project: 'g/p', label: 'type::bug' });

    assert.deepEqual(result, { exists: true }, 'PROVIDER_LABEL_LIST["gitlab"] must resolve to the real gitlab.labelList');
    assert.equal(requestedUrls.length, 1, 'a short first page terminates pagination — no second round-trip');
    assert.ok(
      requestedUrls[0].includes('projects/g%2Fp/labels'),
      `the gitlab dispatch must query the project's label set: ${requestedUrls[0]}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
