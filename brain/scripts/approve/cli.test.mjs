// cli.test.mjs — brain:approve's F1 flow + the E3 write-side refusal matrix
// (design.md §E3, §F1). Structural locks live in locks.test.mjs; this file
// owns behavior: what gets composed, what gets posted, and every refusal
// reason named in the matrix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIRMATION_WORD, parseArgs, runApprove, defaultReadDenyActors, defaultReadAgentActors } from './cli.mjs';
import { parseDecision } from '../review/lib/decision-block.mjs';
import { testTmp } from '../lib/test-tmp.mjs';

const HEAD_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function makeVcs(overrides = {}) {
  const calls = { whoami: 0, prView: 0, mrList: 0, prReviewComment: 0, prReviews: 0 };
  const posted = { body: null };
  const vcs = {
    calls,
    posted,
    whoami: async (a) => { calls.whoami += 1; return overrides.whoami ? overrides.whoami(a) : { username: 'alice' }; },
    prView: async (a) => { calls.prView += 1; return overrides.prView ? overrides.prView(calls.prView, a) : { headRefOid: HEAD_SHA }; },
    mrList: async (a) => { calls.mrList += 1; return overrides.mrList ? overrides.mrList(a) : [{ number: 7, title: 'x', headBranch: 'feat/x' }]; },
    prReviewComment: async (a) => {
      calls.prReviewComment += 1;
      posted.body = a.body;
      return overrides.prReviewComment ? overrides.prReviewComment(a) : { url: 'https://example.test/pr/7#review-1' };
    },
    prReviews: async (a) => {
      calls.prReviews += 1;
      if (overrides.prReviews) return overrides.prReviews(a, posted);
      return posted.body ? [{ state: 'COMMENTED', author: 'alice', body: posted.body }] : [];
    },
  };
  return vcs;
}

const baseCtx = (vcs, extra = {}) => ({
  argv: ['7'],
  isTTY: true,
  project: 'owner/repo',
  getVcsFn: async () => vcs,
  readDenyActorsFn: () => [],
  readLineFn: async () => CONFIRMATION_WORD,
  nowFn: () => '2026-08-07T12:00:00Z',
  write: () => {},
  ...extra,
});

// ═══════════════════════════════════════════════════════════════════════════
// F1 happy path
// ═══════════════════════════════════════════════════════════════════════════

test('happy path: composes, posts, verifies, exits 0 and prints the URL', async () => {
  const vcs = makeVcs();
  const chunks = [];
  const res = await runApprove(baseCtx(vcs, { write: (s) => chunks.push(s) }));
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.equal(vcs.calls.prReviewComment, 1);
  const out = chunks.join('');
  assert.match(out, /https:\/\/example\.test\/pr\/7#review-1/);
});

test('happy path: the posted body is a valid brain-decision/1 block, actor = resolved login, head_sha = PR head', async () => {
  const vcs = makeVcs();
  await runApprove(baseCtx(vcs));
  const parsed = parseDecision({ body: vcs.posted.body });
  assert.ok(parsed, 'the posted body must parse as brain-decision/1');
  assert.equal(parsed.protocol, 'brain-decision/1');
  assert.equal(parsed.decision, 'APPROVE');
  assert.equal(parsed.head_sha, HEAD_SHA);
  assert.equal(parsed.actor, 'alice');
});

test('happy path: no `event` key and no `comments` key reach prReviewComment', async () => {
  const vcs = makeVcs();
  let seenArgs = null;
  vcs.prReviewComment = async (a) => { seenArgs = a; return { url: 'https://example.test/1' }; };
  await runApprove(baseCtx(vcs));
  assert.equal(seenArgs.event, undefined);
  assert.equal(seenArgs.comments, undefined);
});

test('PR number resolution: omitted argv resolves via the current branch + mrList', async () => {
  const vcs = makeVcs({
    mrList: () => [{ number: 99, headBranch: 'feat/my-branch' }, { number: 5, headBranch: 'other' }],
  });
  const res = await runApprove(baseCtx(vcs, { argv: [], branchFn: () => 'feat/my-branch' }));
  assert.equal(res.exitCode, 0, JSON.stringify(res));
  assert.equal(vcs.calls.mrList, 1);
});

test('PR number resolution: no open PR matches the current branch → refuse', async () => {
  const vcs = makeVcs({ mrList: () => [{ number: 5, headBranch: 'other' }] });
  const res = await runApprove(baseCtx(vcs, { argv: [], branchFn: () => 'feat/my-branch' }));
  assert.notEqual(res.exitCode, 0);
  assert.equal(vcs.calls.prView, 0);
});

test('PR number resolution: no resolvable branch and no PR number given → refuse', async () => {
  const vcs = makeVcs();
  const res = await runApprove(baseCtx(vcs, { argv: [], branchFn: () => null }));
  assert.notEqual(res.exitCode, 0);
  assert.equal(vcs.calls.mrList, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// E3 — identity verification before composing
// ═══════════════════════════════════════════════════════════════════════════

test('E3: caller identity is a reviewActors identity → refuses before composing or posting', async () => {
  const vcs = makeVcs();
  const res = await runApprove(baseCtx(vcs, { readDenyActorsFn: () => ['alice'] }));
  assert.notEqual(res.exitCode, 0);
  assert.equal(vcs.calls.prView, 0, 'must refuse before ANY prView (compose) call');
  assert.equal(vcs.calls.prReviewComment, 0);
});

test('E3: caller identity verified and not denied → proceeds, actor = resolved login', async () => {
  const vcs = makeVcs({ whoami: () => ({ username: 'bob' }) });
  await runApprove(baseCtx(vcs, { readDenyActorsFn: () => ['alice'] }));
  const parsed = parseDecision({ body: vcs.posted.body });
  assert.equal(parsed.actor, 'bob');
});

test('E3: whoami throws → refuses, never proceeds on an unverified identity', async () => {
  const vcs = makeVcs({ whoami: () => { throw new Error('token revoked'); } });
  const res = await runApprove(baseCtx(vcs));
  assert.notEqual(res.exitCode, 0);
  assert.equal(vcs.calls.prView, 0);
});

test('E3: whoami resolves no login (falsy username) → refuses', async () => {
  const vcs = makeVcs({ whoami: () => ({ username: null }) });
  const res = await runApprove(baseCtx(vcs));
  assert.notEqual(res.exitCode, 0);
  assert.equal(vcs.calls.prView, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// E3 — head_sha race safety
// ═══════════════════════════════════════════════════════════════════════════

test('E3: head moves between compose and post → refuses to post the stale block; no review created', async () => {
  let call = 0;
  const vcs = makeVcs({
    prView: () => { call += 1; return call === 1 ? { headRefOid: HEAD_SHA } : { headRefOid: OTHER_SHA }; },
  });
  const res = await runApprove(baseCtx(vcs));
  assert.notEqual(res.exitCode, 0);
  assert.equal(vcs.calls.prReviewComment, 0);
});

test('E3: head unresolvable at compose time (prView returns null headRefOid) → refuses', async () => {
  const vcs = makeVcs({ prView: () => ({ headRefOid: null }) });
  const res = await runApprove(baseCtx(vcs));
  assert.notEqual(res.exitCode, 0);
  assert.equal(vcs.calls.prReviewComment, 0);
});

test('E3: head unchanged between compose and post → posts the composed block', async () => {
  const vcs = makeVcs();
  const res = await runApprove(baseCtx(vcs));
  assert.equal(res.exitCode, 0);
  assert.equal(vcs.calls.prReviewComment, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// E3 — post result handling
// ═══════════════════════════════════════════════════════════════════════════

test('E3: prReviewComment returns {url:null} → exits non-zero, never reports a signature that did not land', async () => {
  const vcs = makeVcs({ prReviewComment: () => ({ url: null, error: 'network blip' }) });
  const chunks = [];
  const res = await runApprove(baseCtx(vcs, { write: (s) => chunks.push(s) }));
  assert.notEqual(res.exitCode, 0);
  assert.doesNotMatch(chunks.join(''), /✓/, 'must never print a success marker on a failed post');
});

// ═══════════════════════════════════════════════════════════════════════════
// E3 — post-then-verify: landed author must equal the block's actor
// ═══════════════════════════════════════════════════════════════════════════

test('E3: landed review author != block actor → exits non-zero with instructions', async () => {
  const vcs = makeVcs({
    prReviews: (a, posted) => [{ state: 'COMMENTED', author: 'mallory', body: posted.body }],
  });
  const chunks = [];
  const res = await runApprove(baseCtx(vcs, { write: (s) => chunks.push(s) }));
  assert.notEqual(res.exitCode, 0);
  const out = chunks.join('');
  assert.match(out, /mallory/i);
  assert.doesNotMatch(out, /✓ signed/);
});

test('E3: landed review not found among prReviews() at all (posted but unverifiable) → exits non-zero', async () => {
  const vcs = makeVcs({ prReviews: () => [] });
  const res = await runApprove(baseCtx(vcs));
  assert.notEqual(res.exitCode, 0);
});

test('E3: prReviews() uncomputable (null) after a successful post → exits non-zero, never claims success', async () => {
  const vcs = makeVcs({ prReviews: () => null });
  const chunks = [];
  const res = await runApprove(baseCtx(vcs, { write: (s) => chunks.push(s) }));
  assert.notEqual(res.exitCode, 0);
  assert.doesNotMatch(chunks.join(''), /✓ signed/);
});

test('E3: landed review author == block actor (case-folded) → succeeds', async () => {
  const vcs = makeVcs({
    whoami: () => ({ username: 'Alice' }),
    prReviews: (a, posted) => [{ state: 'COMMENTED', author: 'alice', body: posted.body }],
  });
  const res = await runApprove(baseCtx(vcs));
  assert.equal(res.exitCode, 0, JSON.stringify(res));
});

// ═══════════════════════════════════════════════════════════════════════════
// parseArgs re-export sanity (full coverage lives in locks.test.mjs)
// ═══════════════════════════════════════════════════════════════════════════

test('parseArgs is exported and pure', () => {
  assert.deepEqual(parseArgs(['7']), { ok: true, number: 7 });
});

// ── #124 round 2: the write-side lock is the read side's twin, or it is not ──
// This file carried its OWN deny reader claiming to mirror L5 rule 15. When
// #124 widened L5, the copy silently stopped mirroring and `brain:approve`
// would have let a registered agent sign. One rule, two implementations, and
// the second one wrong.

test('#124: the write side and the read side compute the SAME deny-set', async () => {
  const { approvalDenySet } = await import('../vcs/actor-check.mjs');
  const config = { governance: { reviewActors: ['bot'], agentActors: ['claude'] } };
  assert.deepEqual(approvalDenySet(config).sort(), ['bot', 'claude'],
    'both identity lists deny an APPROVAL — the union is the rule, and it lives in one place');
  assert.deepEqual(approvalDenySet({}), [], 'an absent config denies nobody');
  assert.deepEqual(approvalDenySet({ governance: { reviewActors: 'not-a-list' } }), [],
    'a scalar where a list was configured denies nobody rather than throwing');
});

test('#124: this file states the rule by IMPORTING it, never by restating it', () => {
  const src = readFileSync(new URL('./cli.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*approvalDenySet[^}]*\} from '\.\.\/vcs\/actor-check\.mjs'/,
    'the deny-set rule is imported from its owner');
  assert.doesNotMatch(src, /governance\?\.reviewActors/,
    'and is not re-derived here — a local copy is how the twin stopped being one');
});

test('#124 (round 3): a throwing agent-list reader cannot turn a refusal into a crash', async () => {
  // The first cut called loadBrainConfig() a SECOND time, unguarded, inside the
  // deny branch — to build the MESSAGE. That function throws by contract on a
  // missing or malformed config, so the graceful refusal every other branch
  // preserves became a raw exception for exactly the callers the injectable
  // exists to serve. The property is not "our reader is safe" but "a message
  // cannot crash a verdict", so the call site is guarded too.
  const vcs = makeVcs();
  const res = await runApprove(baseCtx(vcs, {
    readDenyActorsFn: () => ['alice'],
    readAgentActorsFn: () => { throw new Error('no brain.config.json here'); },
  })).catch((e) => ({ threw: e }));
  assert.ok(!res.threw, `the refusal must not throw: ${res.threw?.message}`);
  assert.notEqual(res.exitCode, 0, 'and it still refuses');
  assert.equal(vcs.calls.prReviewComment, 0, 'without posting anything');
});

test('#124: the refusal names the AGENT key when the actor is an agent identity', async () => {
  const vcs = makeVcs();
  const res = await runApprove(baseCtx(vcs, {
    readDenyActorsFn: () => ['alice'],
    readAgentActorsFn: () => ['alice'],
  }));
  assert.match(res.output, /governance\.agentActors/, 'the operator is sent to the key they must edit');
  assert.doesNotMatch(res.output, /registered in governance\.reviewActors/);
});

test('#124 (round 5): a denied identity spelled with different CASE does not walk past the write-side lock', async () => {
  // Reproduced by the reviewer before this fix: whoami returning `Alice` against
  // a deny-set holding `alice` proceeded through compose/confirm/post and printed
  // "✓ signed" with exit 0. The read side had learned to fold case; this twin had
  // not — the third time in one PR that one half of a pair was fixed alone.
  const vcs = makeVcs({ whoami: () => ({ username: 'Alice' }) });
  const res = await runApprove(baseCtx(vcs, {
    readDenyActorsFn: () => ['alice'],
    readAgentActorsFn: () => ['alice'],
  }));
  assert.notEqual(res.exitCode, 0, 'a denied identity is denied in any casing');
  assert.equal(vcs.calls.prReviewComment, 0, 'and nothing is posted');
  assert.match(res.output, /governance\.agentActors/);
});

test('#124: both twins answer the deny question with the SAME function', async () => {
  const { isDeniedActor } = await import('../vcs/actor-check.mjs');
  assert.equal(isDeniedActor('Alice', ['alice']), true, 'case folds');
  assert.equal(isDeniedActor('alice', 'alice'), true, 'a scalar is a one-element list, never an empty one');
  assert.equal(isDeniedActor('bob', ['alice']), false);
  assert.equal(isDeniedActor(undefined, ['alice']), false, 'no actor is not a denied actor');

  const src = readFileSync(new URL('./cli.mjs', import.meta.url), 'utf8');
  assert.match(src, /isDeniedActor\(actor, denyActors\)/, 'the write side ASKS the shared predicate');
  assert.doesNotMatch(src, /denyActors\.includes\(/, 'and does not restate the rule — that is how it diverged three times');
});

// ═══════════════════════════════════════════════════════════════════════════
// issue #942 (R1, R5, R11): a deny list that cannot be read denies nobody —
// refuse instead. defaultReadDenyActors/defaultReadAgentActors now call
// loadBrainConfigOrThrow(root) and propagate; the call site at runApprove's
// deny check wraps that throw into the existing say('✗ …'); done(1) shape.
// ═══════════════════════════════════════════════════════════════════════════

test('T9: defaultReadDenyActors(tmpDir) — unparseable brain.config.json → throws, message names the file', () => {
  const dir = testTmp('approve-cli-cfg-');
  writeFileSync(join(dir, 'brain.config.json'), '{oops');
  assert.throws(
    () => defaultReadDenyActors(dir),
    (err) => {
      assert.match(err.message, /brain\.config\.json/);
      return true;
    },
  );
});

test('T10: defaultReadDenyActors(tmpDir) — no config at all → returns [] (R11)', () => {
  const dir = testTmp('approve-cli-cfg-');
  assert.deepEqual(defaultReadDenyActors(dir), []);
});

test('T9b: defaultReadAgentActors(tmpDir) — unparseable brain.config.json → throws, message names the file', () => {
  const dir = testTmp('approve-cli-cfg-');
  writeFileSync(join(dir, 'brain.config.json'), '{oops');
  assert.throws(
    () => defaultReadAgentActors(dir),
    (err) => {
      assert.match(err.message, /brain\.config\.json/);
      return true;
    },
  );
});

test('T10b: defaultReadAgentActors(tmpDir) — no config at all → returns [] (R11)', () => {
  const dir = testTmp('approve-cli-cfg-');
  assert.deepEqual(defaultReadAgentActors(dir), []);
});

// ═══════════════════════════════════════════════════════════════════════════
// issue #975: loadBrainConfigOrThrow's shape check — JSON that parses but is
// not a plain object (`null`, `[]`, `42`, `"x"`) used to degrade exactly like
// `{}` because every reader here uses optional chaining. `defaultReadDenyActors`
// and `defaultReadAgentActors` call `loadBrainConfigOrThrow` unchanged, so
// they propagate the new shape-check throw exactly like T9/T9b's parse-failure
// throw.
// ═══════════════════════════════════════════════════════════════════════════

test('#975: defaultReadDenyActors(tmpDir) — non-object brain.config.json ([]) → throws, names the type', () => {
  const dir = testTmp('approve-cli-cfg-');
  writeFileSync(join(dir, 'brain.config.json'), '[]');
  assert.throws(
    () => defaultReadDenyActors(dir),
    (err) => {
      assert.match(err.message, /brain\.config\.json/);
      assert.match(err.message, /must contain a JSON object/);
      assert.match(err.message, /got array/);
      return true;
    },
  );
});

test('#975: defaultReadAgentActors(tmpDir) — non-object brain.config.json (null) → throws, names the type', () => {
  const dir = testTmp('approve-cli-cfg-');
  writeFileSync(join(dir, 'brain.config.json'), 'null');
  assert.throws(
    () => defaultReadAgentActors(dir),
    (err) => {
      assert.match(err.message, /brain\.config\.json/);
      assert.match(err.message, /got null/);
      return true;
    },
  );
});

test('#975: runApprove refuses closed when the REAL defaultReadDenyActors hits a non-object config — the real entry point, not the loader alone', async () => {
  const dir = testTmp('approve-cli-cfg-');
  writeFileSync(join(dir, 'brain.config.json'), '42');
  const vcs = makeVcs();
  const res = await runApprove(baseCtx(vcs, {
    // Wires the REAL production reader (not a stub) against a fixture dir
    // whose config is a non-object — proves the caller, not just the loader.
    readDenyActorsFn: () => defaultReadDenyActors(dir),
  })).catch((e) => ({ threw: e }));
  assert.ok(!res.threw, `the refusal must not throw past runApprove: ${res.threw?.message}`);
  assert.notEqual(res.exitCode, 0, 'a non-object config must refuse the approval, not let it through');
  assert.equal(vcs.calls.prReviewComment, 0, 'without posting anything');
});

test('T11: runApprove — readDenyActorsFn throws → exitCode 1, stdout starts with ✗, promise does not reject, prReviewComment never called', async () => {
  const vcs = makeVcs();
  const res = await runApprove(baseCtx(vcs, {
    readDenyActorsFn: () => { throw new Error('brain.config.json at /tmp/x could not be parsed: Unexpected token'); },
  })).catch((e) => ({ threw: e }));
  assert.ok(!res.threw, `runApprove must never reject: ${res.threw?.message}`);
  assert.equal(res.exitCode, 1);
  assert.match(res.output, /^✗/m);
  assert.equal(vcs.calls.prReviewComment, 0);
});
