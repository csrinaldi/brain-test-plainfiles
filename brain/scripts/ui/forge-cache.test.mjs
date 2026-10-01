import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createForgeCache } from './forge-cache.mjs';

// ── D1: exactly the four read verbs `readForge` calls ──────────────────────

test('#881: forge-cache exposes exactly the four read verbs readForge calls', () => {
  const cache = createForgeCache();
  assert.deepEqual(Object.keys(cache.port).sort(), ['issueList', 'issueView', 'mrList', 'prReviews']);
});

// ── a cache miss throws, it never fetches ───────────────────────────────────

test('#881: a cache miss throws "the first forge poll has not completed"', async () => {
  const cache = createForgeCache();
  await assert.rejects(() => cache.port.issueList({ project: 'o/r', state: 'open' }), /the first forge poll has not completed/);
  await assert.rejects(() => cache.port.mrList({ project: 'o/r', state: 'open' }), /the first forge poll has not completed/);
  await assert.rejects(() => cache.port.issueView({ project: 'o/r', number: 5 }), /the first forge poll has not completed/);
  await assert.rejects(() => cache.port.prReviews({ project: 'o/r', number: 10 }), /the first forge poll has not completed/);
});

// ── a filled entry is served from the Map, with no re-fetch ────────────────

test('#881: a filled entry is served from the Map with no re-fetch', async () => {
  const cache = createForgeCache();
  const issues = [{ number: 5, title: 'five' }];
  const prs = [{ number: 10, title: 'pr' }];
  cache.setIssueList(issues);
  cache.setMrList(prs);
  cache.setIssueView(5, { body: 'x', assignees: [] });
  cache.setPrReviews(10, [{ state: 'COMMENTED' }]);

  assert.equal(await cache.port.issueList({ project: 'o/r' }), issues, 'the exact stored reference is served — proof of no re-fetch, not a copy');
  assert.equal(await cache.port.mrList({ project: 'o/r' }), prs);
  assert.deepEqual(await cache.port.issueView({ project: 'o/r', number: 5 }), { body: 'x', assignees: [] });
  assert.deepEqual(await cache.port.prReviews({ project: 'o/r', number: 10 }), [{ state: 'COMMENTED' }]);

  // a number that was never loaded still misses, even once the cache holds other entries —
  // and says so as a queued body, not as a poll that never ran (tracker PR #970 review)
  await assert.rejects(() => cache.port.issueView({ project: 'o/r', number: 999 }), /this issue's body has not been fetched yet \(queued\)/);
});

// ── a never-fetched entry says WHICH miss it is (tracker PR #970 review) ───
//
// One sentence covered two different facts. "The first forge poll has not
// completed" is true before the first tick, and false — misleading — once a
// poll HAS completed but the poller's bounded body lane has not reached that
// number yet: it says the server has not started when what is actually true
// is that this one body is queued behind the cap. `snapshot.mjs` renders the
// throw verbatim as the node's `unreadable` reason, so the operator read a
// working server as a dead one.

test('#881: once the cache holds an answer, a never-fetched number says it is queued, not that the first poll has not completed', async () => {
  const cache = createForgeCache();
  cache.setIssueList([{ number: 5, title: 'five' }]);
  cache.setMrList([{ number: 10, title: 'pr' }]);

  await assert.rejects(
    () => cache.port.issueView({ project: 'o/r', number: 5 }),
    /this issue's body has not been fetched yet \(queued\)/,
    'a poll HAS completed — the body is behind the body lane cap, not waiting on the first tick',
  );
  await assert.rejects(
    () => cache.port.prReviews({ project: 'o/r', number: 10 }),
    /this PR's reviews have not been fetched yet \(queued\)/,
    'the review lane is round-robin beyond its cap, so the same miss is reachable for reviews',
  );
});

test('#881: before any poll completes, both per-number verbs keep the first-poll wording', async () => {
  const cache = createForgeCache();
  await assert.rejects(() => cache.port.issueView({ project: 'o/r', number: 5 }), /^Error: the first forge poll has not completed$/);
  await assert.rejects(() => cache.port.prReviews({ project: 'o/r', number: 10 }), /^Error: the first forge poll has not completed$/);
});
