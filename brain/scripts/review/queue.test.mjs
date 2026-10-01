// queue.test.mjs — Unit tests for REQ-H1-12: the review queue + escalation
// inbox (protocol §9's mailbox). No test spawns a real gh/glab process — the
// VCS list/read seams are always injected. Read-only: proves zero write
// verbs are ever reachable from this module.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { partitionQueue, gatherQueue } from './queue.mjs';

// ── partitionQueue (pure) ────────────────────────────────────────────────

test('partitionQueue: keeps only PRs carrying needs-review or needs-ruling, sorted by number ASCENDING (exact creation order)', () => {
  const prs = [
    { number: 30, title: 'C', labels: ['needs-review'] },
    { number: 5, title: 'A', labels: ['needs-ruling'] },
    { number: 17, title: 'B', labels: ['needs-review'] },
    { number: 9, title: 'no label', labels: [] },
    { number: 2, title: 'unrelated label', labels: ['size:exception'] },
  ];

  const { reviewQueue } = partitionQueue(prs);

  assert.deepEqual(
    reviewQueue.map(pr => pr.number),
    [5, 17, 30],
    'ascending by PR number — the exact creation order (numbers are monotonic at creation)',
  );
});

test('partitionQueue: escalation inbox lists PRs carrying needs-decision, also sorted ascending', () => {
  const prs = [
    { number: 40, title: 'late escalation', labels: ['needs-decision'] },
    { number: 8, title: 'early escalation', labels: ['needs-decision'] },
    { number: 12, title: 'plain review', labels: ['needs-review'] },
  ];

  const { escalations } = partitionQueue(prs);

  assert.deepEqual(escalations.map(pr => pr.number), [8, 40]);
});

test('partitionQueue: a PR carrying both needs-review and needs-decision appears in BOTH sections', () => {
  const prs = [{ number: 3, title: 'both', labels: ['needs-review', 'needs-decision'] }];
  const { reviewQueue, escalations } = partitionQueue(prs);
  assert.deepEqual(reviewQueue.map(pr => pr.number), [3]);
  assert.deepEqual(escalations.map(pr => pr.number), [3]);
});

test('partitionQueue: no matching PRs → both sections empty, never throws', () => {
  const { reviewQueue, escalations } = partitionQueue([{ number: 1, title: 'x', labels: ['decision'] }]);
  assert.deepEqual(reviewQueue, []);
  assert.deepEqual(escalations, []);
});

test('partitionQueue: missing labels array on a PR is treated as no labels, never throws', () => {
  const { reviewQueue, escalations } = partitionQueue([{ number: 1, title: 'x' }]);
  assert.deepEqual(reviewQueue, []);
  assert.deepEqual(escalations, []);
});

// ── gatherQueue: composes mrList + per-PR prView(labels), read-only ────────

test('gatherQueue: composes listOpenPrs (mrList) + fetchLabels (prView) per PR, partitions the result', async () => {
  const listCalls = [];
  const labelCalls = [];
  const result = await gatherQueue({
    project: 'csrinaldi/brain',
    provider: 'github',
    deps: {
      listOpenPrs: async (args) => {
        listCalls.push(args);
        return [
          { number: 20, title: 'B' },
          { number: 4, title: 'A' },
        ];
      },
      fetchLabels: async (args) => {
        labelCalls.push(args);
        return args.number === 4 ? ['needs-review'] : ['needs-decision'];
      },
    },
  });

  assert.deepEqual(listCalls, [{ project: 'csrinaldi/brain', provider: 'github' }]);
  assert.deepEqual(labelCalls.sort((a, b) => a.number - b.number), [
    { project: 'csrinaldi/brain', number: 4, provider: 'github' },
    { project: 'csrinaldi/brain', number: 20, provider: 'github' },
  ]);
  assert.deepEqual(result.reviewQueue.map(pr => pr.number), [4]);
  assert.deepEqual(result.escalations.map(pr => pr.number), [20]);
});

test('gatherQueue: read-only — no labelAdd/labelRemove seam is ever consulted, an empty PR list returns empty sections', async () => {
  const result = await gatherQueue({
    project: 'csrinaldi/brain',
    provider: 'github',
    deps: {
      listOpenPrs: async () => [],
      fetchLabels: async () => { throw new Error('must not be called — no PRs to label-fetch'); },
    },
  });
  assert.deepEqual(result, { reviewQueue: [], escalations: [] });
});

test('queue.mjs source never calls labelAdd/labelRemove/guardedLabelAdd/guardedLabelRemove — read-only by construction', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('./queue.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /labelAdd|labelRemove/, 'queue.mjs must apply no labels and post nothing (REQ-H1-12)');
});
