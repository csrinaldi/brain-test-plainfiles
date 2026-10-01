// poster.test.mjs — Unit tests for REQ-H1-9: THE security boundary (protocol
// §1-§2, §10; design.md §6). No test spawns a real gh/glab process — the VCS
// is always an injected spy/proxy. Every scenario in the return contract this
// slice must prove lives here: no-approve-path, anti-stale, anti-loop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { postVerdict, deriveInlineComments, wouldRepeatLastVerdict } from './poster.mjs';
import { guardedLabelAdd } from './deny-set.mjs';
import { VERBS } from '../vcs/cli.mjs';

const HEAD = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const MOVED = 'facefacefacefacefacefacefacefacefaceface';

function allowlistSpy({ headRefOid = HEAD } = {}) {
  const calls = [];
  return {
    calls,
    vcs: new Proxy(
      {},
      {
        get(_target, verb) {
          // Guard against the classic Proxy-as-thenable pitfall: `await proxy`
          // probes `proxy.then` to decide whether to chain it as a thenable.
          // Returning a function for `then` would make every `await vcs`
          // (and every `await getVcsFn(...)` that resolves to this proxy)
          // recurse into the trap forever. `then` is not a VCS verb.
          if (verb === 'then') return undefined;
          return (...args) => {
            calls.push(verb);
            if (verb === 'prView') return Promise.resolve({ headRefOid });
            if (verb === 'prReviewComment') return Promise.resolve({ url: 'https://example.test/1' });
            if (verb === 'issueComment') return Promise.resolve({ url: 'https://example.test/2' });
            if (verb === 'labelAdd') return Promise.resolve({ ok: true });
            throw new Error(`poster invoked an unexpected verb outside the COMMENT-only surface: "${String(verb)}"`);
          };
        },
      },
    ),
  };
}

// ── R1: no APPROVE path exists — structural ─────────────────────────────────

test('the port itself defines no approve-like verb (R1, ADR-0020) — belt-and-braces on VERBS', () => {
  assert.ok(!VERBS.some(v => /approve/i.test(v)), `VERBS must never contain an approve verb, found: ${VERBS.join(', ')}`);
});

test('postVerdict (tranche mode): posts via prReviewComment ONLY — no verb outside {prView, prReviewComment} is ever invoked', async () => {
  const { vcs, calls } = allowlistSpy();
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: '```yaml\nprotocol: brain-review/1\n```',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, true);
  assert.deepEqual(calls.sort(), ['prReviewComment', 'prView'].sort());
});

test('postVerdict (ruling mode): posts via issueComment ONLY, never prReviewComment', async () => {
  const { vcs, calls } = allowlistSpy();
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 7,
    provider: 'github',
    mode: 'ruling',
    renderedBody: '```yaml\nprotocol: brain-review/1\n```',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, true);
  assert.ok(calls.includes('issueComment'));
  assert.ok(!calls.includes('prReviewComment'));
});

// ── Anti-stale (§10): head moved mid-run ⇒ post nothing, reviewed:stale ─────

test('anti-stale: head moved mid-run → posts NOTHING, applies reviewed:stale, prReviewComment/issueComment never called', async () => {
  const { vcs, calls } = allowlistSpy({ headRefOid: MOVED });
  const result = await postVerdict({
    headSha: HEAD, // the run's own anchor — stale relative to the re-fetched MOVED head
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, false);
  assert.equal(result.skipped, 'anti-stale');
  assert.ok(!calls.includes('prReviewComment'));
  assert.ok(!calls.includes('issueComment'));
  assert.ok(calls.includes('labelAdd'));
});

test('anti-stale: labelAdd is called with exactly ["reviewed:stale"], no other label', async () => {
  const seenLabels = [];
  const vcs = {
    prView: async () => ({ headRefOid: MOVED }),
    labelAdd: async ({ labels }) => { seenLabels.push(...labels); return { ok: true }; },
    prReviewComment: async () => { throw new Error('must not be called'); },
    issueComment: async () => { throw new Error('must not be called'); },
  };
  await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs },
  });
  assert.deepEqual(seenLabels, ['reviewed:stale']);
});

// ── Anti-loop (§10): last block is this reviewer's AND head_sha unchanged ──

test('anti-loop: last thread verdict is this reviewer\'s and head_sha matches the current head → skip, ZERO vcs calls (no re-fetch either)', async () => {
  const { vcs, calls } = allowlistSpy();
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [
      { head_sha: 'someoldsha', verdict: 'REVISE', author: 'brain-reviewer' },
      { head_sha: HEAD, verdict: 'REVISE', author: 'brain-reviewer' },
    ],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, false);
  assert.equal(result.skipped, 'anti-loop');
  assert.deepEqual(calls, []); // no prView re-fetch, no comment, no label — nothing
});

test('anti-loop: last thread verdict is a DIFFERENT reviewer with the same head_sha → NOT skipped, posts normally', async () => {
  const { vcs, calls } = allowlistSpy();
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [{ head_sha: HEAD, verdict: 'REVISE', author: 'a-human' }],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, true);
  assert.ok(calls.includes('prReviewComment'));
});

test('anti-loop: last thread verdict is THIS reviewer but head_sha differs (new push) → NOT skipped, posts normally', async () => {
  const { vcs, calls } = allowlistSpy();
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [{ head_sha: 'someoldsha', verdict: 'REVISE', author: 'brain-reviewer' }],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, true);
  assert.ok(calls.includes('prReviewComment'));
});

test('no priorVerdicts (first run on the thread) → anti-loop never fires, posts normally', async () => {
  const { vcs, calls } = allowlistSpy();
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, true);
  assert.ok(calls.includes('prReviewComment'));
});

// ── reResolveHead seam override ──────────────────────────────────────────────

test('reResolveHead injected seam overrides the default prView re-fetch', async () => {
  let prViewCalled = false;
  const vcs = {
    prView: async () => { prViewCalled = true; return { headRefOid: HEAD }; },
    prReviewComment: async () => ({ url: 'x' }),
  };
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs, reResolveHead: async () => HEAD },
  });
  assert.equal(result.posted, true);
  assert.equal(prViewCalled, false, 'the injected reResolveHead seam must be used instead of the default prView call');
});

// ── deny-set fold (standing condition 1, issue #266 comment 5004345710) ────
// "The constant is the seed, not the fence" — poster.mjs's anti-stale
// reviewed:stale labelAdd now routes through the SAME hardcoded chokepoint
// (deny-set.mjs's guardedLabelAdd) every other reviewer label add passes
// through, instead of calling vcs.labelAdd bare.

test('poster.mjs source routes its labelAdd call through guardedLabelAdd, not a bare vcs.labelAdd', () => {
  const src = readFileSync(fileURLToPath(new URL('./poster.mjs', import.meta.url)), 'utf8');
  assert.match(src, /guardedLabelAdd/, 'poster.mjs must import and call guardedLabelAdd from deny-set.mjs');
  assert.doesNotMatch(
    src,
    /\bvcs\.labelAdd\(/,
    'poster.mjs must never call vcs.labelAdd directly — it must fold through guardedLabelAdd',
  );
});

test('poster fold guard: the exact chokepoint poster.mjs now shares (guardedLabelAdd) refuses a denied label BEFORE the provider — proves the fold is real, not cosmetic', async () => {
  const calls = [];
  const vcs = {
    labelAdd: async (...args) => {
      calls.push(args);
      throw new Error('labelAdd must NEVER be invoked for a denied label');
    },
  };
  await assert.rejects(
    () => guardedLabelAdd(vcs, { project: 'csrinaldi/brain', number: 42, labels: ['status:approved'] }),
    /refused label/,
  );
  assert.deepEqual(calls, [], 'a hypothetical denied label pushed through the poster\'s gate must never reach vcs.labelAdd');
});

// ── escalation inbox (H1-5b, candidate 4993202904, decided IN by plan
// 5011584432): a POSTED verdict carrying escalate: 'human' applies
// needs-decision, through the SAME guardedLabelAdd chokepoint. ──────────────

test('escalate:"human" on a successfully posted verdict applies needs-decision via guardedLabelAdd (after the comment posts)', async () => {
  const { vcs, calls } = allowlistSpy();
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'ruling',
    renderedBody: '```yaml\nprotocol: brain-review/1\nverdict: STOP\nescalate: human\n```',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    escalate: 'human',
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, true);
  assert.ok(calls.includes('issueComment'));
  assert.ok(calls.includes('labelAdd'), 'needs-decision must be applied on the escalation path');
});

test('escalate:"human" applies EXACTLY ["needs-decision"] via labelAdd, no other label', async () => {
  const seenLabels = [];
  const vcs = {
    prView: async () => ({ headRefOid: HEAD }),
    prReviewComment: async () => ({ url: 'x' }),
    labelAdd: async ({ labels }) => { seenLabels.push(...labels); return { ok: true }; },
  };
  await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    escalate: 'human',
    deps: { getVcs: async () => vcs },
  });
  assert.deepEqual(seenLabels, ['needs-decision']);
});

test('escalate not "human" (null, the default) never calls labelAdd — no escalation label on a normal posted verdict', async () => {
  const { vcs, calls } = allowlistSpy();
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, true);
  assert.ok(!calls.includes('labelAdd'), 'no escalate param passed -> defaults to null -> no needs-decision');
});

test('escalate:"human" on an anti-stale (skipped) run never applies needs-decision — only reviewed:stale, and the post never happened', async () => {
  const seenLabels = [];
  const vcs = {
    prView: async () => ({ headRefOid: MOVED }),
    labelAdd: async ({ labels }) => { seenLabels.push(...labels); return { ok: true }; },
    prReviewComment: async () => { throw new Error('must not be called'); },
    issueComment: async () => { throw new Error('must not be called'); },
  };
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    escalate: 'human',
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, false);
  assert.equal(result.skipped, 'anti-stale');
  assert.deepEqual(seenLabels, ['reviewed:stale'], 'anti-stale wins — the verdict never actually landed at this head, so escalation never fires');
});

test('anti-stale path still applies reviewed:stale (allowed, tightening) end-to-end after the deny-set fold', async () => {
  const seenLabels = [];
  const vcs = {
    prView: async () => ({ headRefOid: MOVED }),
    labelAdd: async ({ labels }) => { seenLabels.push(...labels); return { ok: true }; },
    prReviewComment: async () => { throw new Error('must not be called'); },
    issueComment: async () => { throw new Error('must not be called'); },
  };
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: 'irrelevant',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(result.posted, false);
  assert.equal(result.skipped, 'anti-stale');
  assert.deepEqual(seenLabels, ['reviewed:stale'], 'reviewed:stale matches reviewed:* — allowed through the deny-set unchanged');
});

// The shared `allowlistSpy` records verb NAMES only. These cases need the
// ARGUMENTS — asserting that the anchor reached the verb is the whole point, and
// a name-only spy cannot tell a call with comments from one without.
function recordingSpy({ headRefOid = HEAD, reviewResult = { url: 'https://example.test/1' } } = {}) {
  const calls = [];
  return {
    calls,
    vcs: {
      prView: async (args) => { calls.push({ verb: 'prView', args }); return { headRefOid }; },
      prReviewComment: async (args) => { calls.push({ verb: 'prReviewComment', args }); return reviewResult; },
      issueComment: async (args) => { calls.push({ verb: 'issueComment', args }); return { url: 'https://example.test/2' }; },
      labelAdd: async (args) => { calls.push({ verb: 'labelAdd', args }); return { ok: true }; },
    },
  };
}

// ── #405 T9: the anchors reach the provider through the poster ─────────────

test('#405 deriveInlineComments: only ANCHORED findings become comments (REQ-405-2)', () => {
  const out = deriveInlineComments([
    { id: 'a', evidence: 'e1', file: 'x.mjs', line: 4 },
    { id: 'b', evidence: 'e2' },                          // no anchor at all
    { id: 'c', evidence: 'e3', file: 'y.mjs' },           // file without line
    { id: 'd', evidence: 'e4', line: 9 },                 // line without file
    // `line: null` was the unpinned SPELLING (round-7 cold review): dropping the
    // `=== null` half of the guard left the suite green, and under it this finding
    // posts at `Number(null)` — line 0 — while `renderVerdict`, which guards both,
    // omits `line:` from the block. That is text on the diff the posted verdict
    // does not support, which is the one thing the anchor rule exists to prevent.
    { id: 'e', evidence: 'e5', file: 'z.mjs', line: null },
    // The spellings rounds 7-10 each found unpinned one at a time. `file: ''` is
    // handled by `!f?.file` and was pinned by nothing — the mutation
    // `f?.file === undefined` survived. The three unusable LINES were worse than
    // unpinned: they were SENT, as `line: null` and `line: 0`, and diff lines are
    // 1-based — anchors already known not to attach, which is the exact cost the
    // guard's own JSDoc says it exists to avoid.
    { id: 'f', evidence: 'e6', file: '', line: 3 },        // empty path
    { id: 'g', evidence: 'e7', file: 'z.mjs', line: 'abc' },// Number() -> NaN
    { id: 'h', evidence: 'e8', file: 'z.mjs', line: '' },   // Number() -> 0
    { id: 'i', evidence: 'e9', file: 'z.mjs', line: 0 },    // no line 0 in a diff
    { id: 'j', evidence: 'e10', file: 'z.mjs', line: 2.5 }, // not an integer
    // …and the one shape that MUST survive all of that: the round-tripped string,
    // which is what `parseVerdict` actually returns.
    { id: 'k', evidence: 'e11', file: 'w.mjs', line: '7' },
  ]);
  // The whole list, whole entries, strict — NOT a projection. Round 16's own
  // comment records that projections let `line` and `body` collapse while `path`
  // stayed correct; round 17 found this assertion was itself still three
  // projections (`map(path)`, two `line` reads, one `match` on `out[0].body`),
  // so the CORRESPONDENCE between a finding and its comment was unpinned inside
  // `deriveInlineComments`: taking `body` from `findings[out.length]` instead of
  // from `f` left the whole suite green, and under it a comment lands on
  // `w.mjs:7` carrying the text of finding `b` — a finding `renderVerdict` emits
  // with no `file:` and no `line:` at all. Text on the diff the posted verdict
  // does not support is the one thing the anchor rule exists to prevent.
  // Two anchors SEPARATED by unanchored findings is what makes an index shift
  // observable; `deepStrictEqual` is what keeps `line: '7'` arriving as the
  // string it was written as from passing. Both halves are load-bearing.
  assert.deepStrictEqual(out, [
    { path: 'x.mjs', line: 4, body: '**a** — e1' },
    { path: 'w.mjs', line: 7, body: '**k** — e11' },
  ], 'a half anchor is not an anchor — GitHub 422s a comment with no line, so a partial one ' +
    'would spend the fallback on a finding we already knew could not attach; and each ' +
    'surviving comment carries ITS OWN finding’s evidence at ITS OWN anchor');
});

test('#405 deriveInlineComments: no anchored finding yields an EMPTY array, and the caller decides what that means (REQ-405-2)', () => {
  // The title used to read "yields NO array, not an empty one", which is the
  // opposite of both this assertion and the function's JSDoc (round-3 cold
  // review, E1). It also claimed to be what stops the poster sending
  // `comments: []`; that is pinned by `#405 T9: with nothing anchored the payload
  // carries NO comments key`, which reds under the always-send mutation. This one
  // does not, and should not: `deriveInlineComments` is pure and returns a list.
  // Deciding that an empty list means "no inline requested" is the POSTER's job,
  // and keeping those two responsibilities apart is why this function has no
  // knowledge of the wire at all.
  assert.deepEqual(deriveInlineComments([{ id: 'a', evidence: 'e' }]), []);
});

test('#405: deriveInlineComments tolerates a non-array findings value (REQ-405-2)', () => {
  // `findings ?? []` and the providers' `Array.isArray(comments)` are defensive
  // guards on lines this change added, and mutation showed nothing pinned them
  // (round-11 cold review, E2). No in-tree caller produces these shapes and no
  // artefact promises null-safety — so they are PINNED rather than removed: an
  // unpinned guard is an invitation to delete it during a refactor and discover
  // the caller that needed it in production.
  assert.deepEqual(deriveInlineComments(undefined), []);
  assert.deepEqual(deriveInlineComments(null), []);
  assert.deepEqual(deriveInlineComments([null, undefined, 0, 'nonsense']), [],
    'entries that are not objects yield no comment, rather than throwing mid-list');
});

test('#405 T9: anchored findings reach prReviewComment as comments[] (REQ-405-1)', async () => {
  const spy = recordingSpy();
  await postVerdict({
    headSha: HEAD, project: 'csrinaldi/brain', number: 42, provider: 'github', mode: 'tranche',
    renderedBody: '```yaml\nprotocol: brain-review/2\n```',
    reviewerHandle: 'brain-reviewer', priorVerdicts: [],
    findings: [{ id: 'f1', evidence: 'boom', file: 'brain/a.mjs', line: 12 }],
    deps: { getVcs: async () => spy.vcs },
  });
  const post = spy.calls.find(c => c.verb === 'prReviewComment');
  assert.ok(post, 'the verdict must still post');
  assert.ok(Array.isArray(post.args.comments) && post.args.comments.length === 1,
    `the anchor must reach the verb: ${JSON.stringify(post.args)}`);
  assert.equal(post.args.comments[0].path, 'brain/a.mjs');
});

test('#405 T9: a ruling posts on the ISSUE and carries NO comments (REQ-405-1)', async () => {
  // issueComment has no inline surface. Passing comments there would be a
  // silently-ignored argument at best; asserted so the wiring cannot drift into it.
  const spy = recordingSpy();
  await postVerdict({
    headSha: HEAD, project: 'csrinaldi/brain', number: 7, provider: 'github', mode: 'ruling',
    renderedBody: '```yaml\nprotocol: brain-review/2\n```',
    reviewerHandle: 'brain-reviewer', priorVerdicts: [],
    findings: [{ id: 'f1', evidence: 'boom', file: 'a.mjs', line: 1 }],
    deps: { getVcs: async () => spy.vcs },
  });
  const post = spy.calls.find(c => c.verb === 'issueComment');
  assert.ok(post, 'a ruling posts on the issue thread');
  assert.equal(post.args.comments, undefined, 'no inline surface on an issue comment');
});

test('#405 T9: a dropped anchor is REPORTED, and the verdict is still posted (REQ-405-4)', async () => {
  // The poster must surface the count its caller logs. Without it the run says
  // nothing, and "no inline comments appeared" becomes indistinguishable from
  // "the anchors would not attach" one layer up from the verb that knew.
  const vcs = {
    prView: async () => ({ headRefOid: HEAD }),
    prReviewComment: async () => ({ url: 'https://example.test/#r1', inlineDropped: 1 }),
  };
  const out = await postVerdict({
    headSha: HEAD, project: 'csrinaldi/brain', number: 42, provider: 'github', mode: 'tranche',
    renderedBody: '```yaml\nprotocol: brain-review/2\n```',
    reviewerHandle: 'brain-reviewer', priorVerdicts: [],
    findings: [{ id: 'f1', evidence: 'boom', file: 'a.mjs', line: 99999 }],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(out.posted, true, 'the verdict posted — an inline failure must never cost it');
  assert.equal(out.inlineDropped, 1, 'and the count reached the caller');
});

test('#405 T9: with nothing anchored the payload carries NO comments key (REQ-405-1)', async () => {
  // `comments: []` is not the same request as no `comments` at all: the verbs
  // read the key's PRESENCE to decide whether to attempt an inline review, and
  // GitHub's retry-without-inline fallback keys off the same distinction. An
  // empty array would ask both providers to do inline work for zero anchors.
  const spy = recordingSpy();
  await postVerdict({
    headSha: HEAD, project: 'csrinaldi/brain', number: 42, provider: 'github', mode: 'tranche',
    renderedBody: '```yaml\nprotocol: brain-review/2\n```',
    reviewerHandle: 'brain-reviewer', priorVerdicts: [],
    findings: [{ id: 'f1', evidence: 'boom' }],   // real finding, no anchor
    deps: { getVcs: async () => spy.vcs },
  });
  const post = spy.calls.find(c => c.verb === 'prReviewComment');
  assert.ok(post, 'the verdict must still post');
  assert.equal('comments' in post.args, false,
    `no anchor means no inline request at all: ${JSON.stringify(post.args)}`);
});

test('#405 T9: nothing dropped means NO inlineDropped key, never 0 (REQ-405-4)', async () => {
  // Same rule the verbs follow, one layer up. A literal 0 is a positive claim
  // ("we tried to anchor and lost none") on runs that anchored nothing at all,
  // and it would read as a computed measurement in a caller's log.
  const vcs = {
    prView: async () => ({ headRefOid: HEAD }),
    prReviewComment: async () => ({ url: 'https://example.test/#r1' }),
  };
  const out = await postVerdict({
    headSha: HEAD, project: 'csrinaldi/brain', number: 42, provider: 'github', mode: 'tranche',
    renderedBody: '```yaml\nprotocol: brain-review/2\n```',
    reviewerHandle: 'brain-reviewer', priorVerdicts: [],
    findings: [{ id: 'f1', evidence: 'boom', file: 'a.mjs', line: 3 }],
    deps: { getVcs: async () => vcs },
  });
  assert.equal(out.posted, true);
  assert.equal('inlineDropped' in out, false, `absent, not 0: ${JSON.stringify(out)}`);
});

test('#405: the anchored path holds at EVERY PR mode, and at more than one anchor (REQ-405-1)', async () => {
  // Round 14's C2 asserted the block-vs-wire agreement by calling
  // `deriveInlineComments` DIRECTLY — bypassing `postVerdict`, which is the one
  // call site where drift can actually enter. And that call site has an input
  // dimension nothing varied: `mode`. Every anchored fixture in the tree used
  // `tranche`; only the ANCHORLESS ruling case varied it. So gating the exclusion
  // on `checkpoint` too survived the full suite (round-15 cold review, C2), and
  // `checkpoint` is a live production mode — the block would advertise an anchor
  // the poster refuses to post, which is the drift by name.
  //
  // Anchor COUNT was unvaried at this call site as well: every fixture supplied
  // exactly one, so `.slice(0, 1)` was green too. Both dimensions are driven here.
  //
  // Round 14's own lesson, applied to round 14: a shared predicate stops drift by
  // field value and cannot stop drift introduced at the call site by a dimension
  // the predicate never receives. The fix is to drive the call site, not to share
  // one more function.
  for (const mode of ['tranche', 'checkpoint']) {
    const spy = recordingSpy();
    await postVerdict({
      headSha: HEAD, project: 'csrinaldi/brain', number: 42, provider: 'github', mode,
      renderedBody: '```yaml\nprotocol: brain-review/2\n```',
      reviewerHandle: 'brain-reviewer', priorVerdicts: [],
      findings: [
        { id: 'f1', evidence: 'first', file: 'a.mjs', line: 3 },
        { id: 'f2', evidence: 'second', file: 'b.mjs', line: 8 },
      ],
      deps: { getVcs: async () => spy.vcs },
    });
    const post = spy.calls.find(c => c.verb === 'prReviewComment');
    assert.ok(post, `${mode}: every non-ruling mode posts on the PR path`);
    // The FULL triple, `body` included (round-16 cold review): asserting
    // `(path, line)` is a projection, and a projection is what let the comment
    // body collapse to the first finding's while the coordinates stayed correct.
    assert.deepEqual(post.args.comments, [
      { path: 'a.mjs', line: 3, body: '**f1** — first' },
      { path: 'b.mjs', line: 8, body: '**f2** — second' },
    ], `${mode}: EVERY anchored finding reaches the verb with its OWN triple — got ${JSON.stringify(post.args.comments)}`);
  }
});

test('#405: an inline post does NOT weaken the anti-loop lock (REQ-405-5)', async () => {
  // Asserted in spec REQ-405-5 and design D7-4 and implemented in no test until
  // the round-2 cold review counted them (C-4). The behaviour was already safe —
  // the lock returns before any verb is chosen — but an artefact claiming
  // coverage that does not exist is the same defect class as a red-proof ledger
  // with a fabricated row.
  const spy = recordingSpy();
  const args = {
    headSha: HEAD, project: 'csrinaldi/brain', number: 42, provider: 'github', mode: 'tranche',
    renderedBody: '```yaml\nprotocol: brain-review/2\n```',
    reviewerHandle: 'brain-reviewer',
    findings: [{ id: 'f1', evidence: 'boom', file: 'a.mjs', line: 3 }],
    deps: { getVcs: async () => spy.vcs },
  };
  const first = await postVerdict({ ...args, priorVerdicts: [] });
  assert.equal(first.posted, true);
  assert.ok(spy.calls.some(c => c.verb === 'prReviewComment' && c.args.comments?.length === 1),
    'the first run really did post inline — otherwise the second half proves nothing');

  const second = await postVerdict({
    ...args,
    priorVerdicts: [{ head_sha: HEAD, verdict: 'REVISE', author: 'brain-reviewer' }],
  });
  assert.deepEqual(second, { posted: false, skipped: 'anti-loop' },
    'a second run at the same head must still skip — inline annotations carry no brain-review block, ' +
    'so the lock, which counts parseable verdicts rather than posts, sees exactly what it saw before #405');
  assert.equal(spy.calls.filter(c => c.verb === 'prReviewComment').length, 1,
    'and nothing was posted the second time');
});

test('#405 deriveInlineComments: the line is COERCED to a number (REQ-405-2)', async () => {
  // `parseVerdict` returns entry scalars as TEXT — `verdict.test.mjs` pins
  // `parsed.findings[0].line === '42'`. GitHub's reviews API rejects a string
  // line, so a verdict that made the round trip would lose every anchor and
  // report them as un-anchorable diff lines: our defect, blamed on the diff.
  // The coercion was there and pinned by nothing (round-2 cold review, E-1).
  const [c] = deriveInlineComments([{ id: 'f', evidence: 'e', file: 'a.mjs', line: '42' }]);
  assert.strictEqual(c.line, 42, 'the string form must not reach the provider');
  assert.equal(typeof c.line, 'number');
});

test('#405 deriveInlineComments: the comment names the finding it came from (REQ-405-2)', async () => {
  // Only the evidence half of the body was pinned (round-2 cold review, E-2).
  // The id is what lets a developer match an inline note to the row in the
  // summary block — without it the two artifacts are read as unrelated.
  const [c] = deriveInlineComments([{ id: 'budget', evidence: 'the comparison', file: 'a.mjs', line: 1 }]);
  assert.match(c.body, /budget/, 'the comment must name the finding id');
  assert.match(c.body, /the comparison/, 'and carry its evidence');
});


// ── judgment:cold-2 — the predicate the early guard and the lock SHARE ─────

test('wouldRepeatLastVerdict: this reviewer\'s own last verdict at this head repeats', () => {
  assert.equal(wouldRepeatLastVerdict({
    priorVerdicts: [{ author: 'bot', head_sha: 'abc' }],
    reviewerHandle: 'bot',
    headSha: 'abc',
  }), true);
});

test('wouldRepeatLastVerdict: ANOTHER reviewer\'s verdict does not — it guards a self-loop', () => {
  // The author half is the difference between this lock and the rev bound: the
  // bound counts everyone's verdicts at the head, the lock refuses to repeat
  // ITSELF. Folding them would make the reviewer go silent because someone else
  // spoke.
  assert.equal(wouldRepeatLastVerdict({
    priorVerdicts: [{ author: 'someone-else', head_sha: 'abc' }],
    reviewerHandle: 'bot',
    headSha: 'abc',
  }), false);
});

test('wouldRepeatLastVerdict: a verdict at a DIFFERENT head does not repeat', () => {
  assert.equal(wouldRepeatLastVerdict({
    priorVerdicts: [{ author: 'bot', head_sha: 'old' }],
    reviewerHandle: 'bot',
    headSha: 'new',
  }), false);
});

test('wouldRepeatLastVerdict: no prior verdicts is false, not a crash', () => {
  assert.equal(wouldRepeatLastVerdict({ priorVerdicts: [], reviewerHandle: 'bot', headSha: 'abc' }), false);
  assert.equal(wouldRepeatLastVerdict({ reviewerHandle: 'bot', headSha: 'abc' }), false);
  assert.equal(wouldRepeatLastVerdict(), false);
});

test('wouldRepeatLastVerdict: only the LAST verdict counts', () => {
  // An older self-verdict at this head followed by someone else's is not a
  // repeat: the reviewer would be answering THEM, which is the conversation the
  // lock exists to permit.
  assert.equal(wouldRepeatLastVerdict({
    priorVerdicts: [{ author: 'bot', head_sha: 'abc' }, { author: 'other', head_sha: 'abc' }],
    reviewerHandle: 'bot',
    headSha: 'abc',
  }), false);
});

test('wouldRepeatLastVerdict: postVerdict AGREES with it — one definition, not two', async () => {
  // The whole reason this is exported. If the poster ever stops routing through
  // the predicate, the early guard in cli.mjs starts skipping runs the lock
  // would have posted, and nothing on the run says so.
  const args = { priorVerdicts: [{ author: 'bot', head_sha: 'abc' }], reviewerHandle: 'bot', headSha: 'abc' };
  assert.equal(wouldRepeatLastVerdict(args), true);
  const result = await postVerdict({
    ...args, project: 'o/r', number: 1, mode: 'review', renderedBody: 'x',
    deps: { getVcs: async () => { throw new Error('the poster must not reach the forge on a skip'); } },
  });
  assert.equal(result.skipped, 'anti-loop');
});

// ── #766: the write verb's error is READ, and a failed post fails closed ────
//
// The axis every other case in this file holds fixed. `allowlistSpy` and
// `recordingSpy` both inject a writer that SUCCEEDS, so the poster's handling of
// `{ url: null, error }` — half of the contract `vcs-contract.md` states for
// `prReviewComment` and `issueComment` — had no coverage at all
// (`red-proof-blind-along-an-unvaried-axis`). Measured on PR #765: a 403 from a
// PAT that could read and not write produced a full verdict on stdout, exit 0,
// and nothing on the server.

test('#766: a write verb that returns { url: null, error } does NOT report posted (tranche)', async () => {
  const { vcs } = recordingSpy({ reviewResult: { url: null, error: 'gh: Resource not accessible by personal access token (HTTP 403)' } });
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: '```yaml\nprotocol: brain-review/2\n```',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs },
  });

  assert.notEqual(result.posted, true, 'a verdict the forge refused must never report posted: true');
  assert.equal(result.posted, false);
  assert.match(result.error, /403/, "the verb's own reason must reach the caller, not be replaced by a generic one");
});

test('#766: the ruling path reads issueComment\'s error too — both write verbs, not just one', async () => {
  const calls = [];
  const vcs = {
    prView: async () => ({ headRefOid: HEAD }),
    issueComment: async () => { calls.push('issueComment'); return { url: null, error: 'gh api failed (status 1)' }; },
    prReviewComment: async () => { throw new Error('ruling mode must not reach prReviewComment'); },
    labelAdd: async () => { calls.push('labelAdd'); return { ok: true }; },
  };
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'ruling',
    renderedBody: '```yaml\nprotocol: brain-review/2\n```',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs },
  });

  assert.equal(result.posted, false);
  assert.match(result.error, /status 1/);
});

test('#766: a failed post does not apply the escalation label — nothing landed to escalate', async () => {
  // The escalation-label branch already states this rule in its own comment
  // ("only reachable once the verdict actually landed at this head") and enforces
  // it for anti-loop and anti-stale. A refused WRITE is the third way a verdict
  // fails to land, and it is the one the branch sits below.
  const { vcs, calls } = recordingSpy({ reviewResult: { url: null, error: 'HTTP 403' } });
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: '```yaml\nprotocol: brain-review/2\n```',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    escalate: 'human',
    deps: { getVcs: async () => vcs },
  });

  assert.equal(result.posted, false);
  assert.ok(
    !calls.some(c => c.verb === 'labelAdd'),
    'needs-decision over a verdict nobody can read points a human at an empty thread',
  );
});

test('#766: a write verb answering with neither url nor error still fails closed', async () => {
  // The contract says `{ url } | { url: null, error }`. A provider that returns
  // neither is off-contract, and the poster must not read that silence as success.
  const { vcs } = recordingSpy({ reviewResult: {} });
  const result = await postVerdict({
    headSha: HEAD,
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    mode: 'tranche',
    renderedBody: '```yaml\nprotocol: brain-review/2\n```',
    reviewerHandle: 'brain-reviewer',
    priorVerdicts: [],
    deps: { getVcs: async () => vcs },
  });

  assert.equal(result.posted, false);
  assert.ok(result.error, 'an off-contract answer still owes the caller a reason');
});

// ── issue #829 — the lock reads CONTROLS, not existence ─────────────────────

const halfVerdictMineAtHead = () => ({
  author: 'me',
  controls_not_applied: ['inferential'],
});

test('#829: a half-verdict of mine does NOT arm the lock against a run that would apply the missing half', () => {
  assert.equal(wouldRepeatLastVerdict({
    priorVerdicts: [{ ...halfVerdictMineAtHead(), body: '', head_sha: 'abc' }],
    reviewerHandle: 'me',
    headSha: 'abc',
    nextAppliesInferential: true,
  }), false, 'there IS no reasoned output at this head — running adds the half, it repeats nothing');
});

test('#829: the same half-verdict still arms the lock when the next run would ALSO be deterministic-only', () => {
  assert.equal(wouldRepeatLastVerdict({
    priorVerdicts: [{ ...halfVerdictMineAtHead(), body: '', head_sha: 'abc' }],
    reviewerHandle: 'me',
    headSha: 'abc',
    nextAppliesInferential: false,
  }), true, 'a half repeated by a half is exactly the loop the lock exists to break');
});

test('#829: a FULL last verdict arms the lock even against an inferential run — loop safety is preserved', () => {
  assert.equal(wouldRepeatLastVerdict({
    priorVerdicts: [{ author: 'me', body: '', head_sha: 'abc', controls_not_applied: [] }],
    reviewerHandle: 'me',
    headSha: 'abc',
    nextAppliesInferential: true,
  }), true);
});

test('#829: a LEGACY verdict with no controls line arms the lock — conservative, never guessed', () => {
  assert.equal(wouldRepeatLastVerdict({
    priorVerdicts: [{ author: 'me', body: '', head_sha: 'abc' }],
    reviewerHandle: 'me',
    headSha: 'abc',
    nextAppliesInferential: true,
  }), true, 'absence of the field is not evidence the half was skipped');
});
