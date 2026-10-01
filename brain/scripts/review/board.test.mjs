// board.test.mjs — Unit tests for REQ-H1-13: rebuild seq:*/reviewed:* from
// the brain-review/1 verdict blocks (protocol §9 — verdicts are truth,
// labels are the derived index). No test spawns a real gh/glab process —
// every I/O seam is injected. Reconciliation is proven to stay strictly
// within the seq:*/reviewed:* namespaces and to route every add/remove
// through the deny-set's guardedLabelAdd/guardedLabelRemove chokepoints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  reviewedLabelForVerdict,
  reconcileBoardLabels,
  reconcileOnePr,
  runBoard,
} from './board.mjs';

// ── reviewedLabelForVerdict (pure) ──────────────────────────────────────────

test('reviewedLabelForVerdict: APPROVE -> reviewed:approved (the spec.md REQ-H1-13 example)', () => {
  assert.equal(reviewedLabelForVerdict('APPROVE'), 'reviewed:approved');
});

test('reviewedLabelForVerdict: REVISE -> reviewed:revised, STOP -> reviewed:stopped', () => {
  assert.equal(reviewedLabelForVerdict('REVISE'), 'reviewed:revised');
  assert.equal(reviewedLabelForVerdict('STOP'), 'reviewed:stopped');
});

test('reviewedLabelForVerdict: an unrecognized verdict scalar returns null, never throws', () => {
  assert.equal(reviewedLabelForVerdict('BOGUS'), null);
  assert.equal(reviewedLabelForVerdict(undefined), null);
});

// ── reconcileBoardLabels (pure) — the desync-rebuild core ───────────────────

test('reconcileBoardLabels: a desynced label is rebuilt from the verdict (spec.md REQ-H1-13 scenario) — missing reviewed:approved is added', () => {
  const { toAdd, toRemove } = reconcileBoardLabels({
    latestVerdict: { head_sha: 'a', verdict: 'APPROVE', rev: 1, author: 'brain-reviewer' },
    currentLabels: [],
  });
  assert.deepEqual(toAdd, ['reviewed:approved']);
  assert.deepEqual(toRemove, []);
});

test('reconcileBoardLabels: already in sync — no add, no remove', () => {
  const { toAdd, toRemove } = reconcileBoardLabels({
    latestVerdict: { head_sha: 'a', verdict: 'APPROVE', rev: 1, author: 'brain-reviewer' },
    currentLabels: ['reviewed:approved'],
  });
  assert.deepEqual(toAdd, []);
  assert.deepEqual(toRemove, []);
});

test('reconcileBoardLabels: a STALE reviewed:* label (from an earlier verdict) is removed while the current one is added', () => {
  const { toAdd, toRemove } = reconcileBoardLabels({
    latestVerdict: { head_sha: 'b', verdict: 'APPROVE', rev: 2, author: 'brain-reviewer' },
    currentLabels: ['reviewed:revised'],
  });
  assert.deepEqual(toAdd, ['reviewed:approved']);
  assert.deepEqual(toRemove, ['reviewed:revised']);
});

test('reconcileBoardLabels: labels OUTSIDE seq:*/reviewed:* are never touched, even when not "desired"', () => {
  const { toAdd, toRemove } = reconcileBoardLabels({
    latestVerdict: { head_sha: 'a', verdict: 'APPROVE', rev: 0, author: 'brain-reviewer' },
    currentLabels: ['decision', 'status:approved', 'needs-ruling'],
  });
  assert.deepEqual(toAdd, ['reviewed:approved']);
  assert.deepEqual(toRemove, [], 'decision/status:approved/needs-ruling are outside the board namespace — never removed');
});

test('reconcileBoardLabels: no latest verdict (empty thread) -> no-op, never throws', () => {
  const { toAdd, toRemove } = reconcileBoardLabels({ latestVerdict: null, currentLabels: ['reviewed:approved'] });
  assert.deepEqual(toAdd, []);
  assert.deepEqual(toRemove, []);
});

test('reconcileBoardLabels: sequencing (when the verdict block carries it) contributes seq:* labels to reconcile', () => {
  const { toAdd, toRemove } = reconcileBoardLabels({
    latestVerdict: { head_sha: 'a', verdict: 'APPROVE', rev: 0, author: 'x', sequencing: ['seq:merge-next'] },
    currentLabels: ['seq:blocked-by-#5'],
  });
  assert.deepEqual(toAdd.sort(), ['reviewed:approved', 'seq:merge-next'].sort());
  assert.deepEqual(toRemove, ['seq:blocked-by-#5']);
});

// ── reconcileOnePr: composes fetchPr + fetchReviews, reconciles via the deny-set ─

function fixtureReview(verdict, headSha = 'a', rev = 0) {
  return {
    state: 'COMMENTED',
    author: 'brain-reviewer',
    body: `\`\`\`yaml\nprotocol: brain-review/1\nverdict: ${verdict}\nhead_sha: ${headSha}\nrev: ${rev}\n\`\`\``,
  };
}

test('reconcileOnePr: takes the LATEST verdict on the thread (last review wins), applies via guardedLabelAdd', async () => {
  const labelAddCalls = [];
  const vcs = {
    labelAdd: async ({ labels }) => { labelAddCalls.push(labels); return { ok: true }; },
    labelRemove: async () => { throw new Error('must not be called — nothing to remove'); },
  };
  const result = await reconcileOnePr({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    deps: {
      fetchPr: async () => ({ number: 42, labels: [] }),
      fetchReviews: async () => [fixtureReview('REVISE', 'a', 0), fixtureReview('APPROVE', 'a', 1)],
      getVcs: async () => vcs,
    },
  });
  assert.deepEqual(labelAddCalls, [['reviewed:approved']]);
  assert.deepEqual(result, { number: 42, toAdd: ['reviewed:approved'], toRemove: [], unreadable: [] });
});

test('reconcileOnePr: already-synced PR makes ZERO vcs calls (no add, no remove)', async () => {
  const vcs = {
    labelAdd: async () => { throw new Error('must not be called — already synced'); },
    labelRemove: async () => { throw new Error('must not be called — already synced'); },
  };
  const result = await reconcileOnePr({
    project: 'csrinaldi/brain',
    number: 42,
    provider: 'github',
    deps: {
      fetchPr: async () => ({ number: 42, labels: ['reviewed:approved'] }),
      fetchReviews: async () => [fixtureReview('APPROVE')],
      getVcs: async () => vcs,
    },
  });
  assert.deepEqual(result, { number: 42, toAdd: [], toRemove: [], unreadable: [] });
});

test('reconcileOnePr: a desync calls BOTH guardedLabelAdd and guardedLabelRemove through the real deny-set (removal stays inside seq:*/reviewed:*)', async () => {
  const calls = { labelAdd: [], labelRemove: [] };
  const vcs = {
    labelAdd: async ({ labels }) => { calls.labelAdd.push(labels); return { ok: true }; },
    labelRemove: async ({ labels }) => { calls.labelRemove.push(labels); return { ok: true }; },
  };
  await reconcileOnePr({
    project: 'csrinaldi/brain',
    number: 7,
    provider: 'github',
    deps: {
      fetchPr: async () => ({ number: 7, labels: ['reviewed:revised', 'decision'] }),
      fetchReviews: async () => [fixtureReview('APPROVE')],
      getVcs: async () => vcs,
    },
  });
  assert.deepEqual(calls.labelAdd, [['reviewed:approved']]);
  assert.deepEqual(calls.labelRemove, [['reviewed:revised']], 'decision is outside the board namespace — never sent to labelRemove');
});

test('reconcileOnePr: a thread with no verdict blocks at all -> no-op, zero vcs calls', async () => {
  const vcs = {
    labelAdd: async () => { throw new Error('must not be called'); },
    labelRemove: async () => { throw new Error('must not be called'); },
  };
  const result = await reconcileOnePr({
    project: 'csrinaldi/brain',
    number: 9,
    provider: 'github',
    deps: {
      fetchPr: async () => ({ number: 9, labels: [] }),
      fetchReviews: async () => [{ state: 'COMMENTED', author: 'bob', body: 'just a plain human comment' }],
      getVcs: async () => vcs,
    },
  });
  assert.deepEqual(result, { number: 9, toAdd: [], toRemove: [], unreadable: [] });
});

// ── runBoard: composes listOpenPrs + reconciles each PR ─────────────────────

test('runBoard: composes listOpenPrs (mrList) with reconcileOnePr for every open PR', async () => {
  const seenNumbers = [];
  const vcs = { labelAdd: async () => ({ ok: true }), labelRemove: async () => ({ ok: true }) };
  const results = await runBoard({
    project: 'csrinaldi/brain',
    provider: 'github',
    deps: {
      listOpenPrs: async () => [{ number: 3 }, { number: 11 }],
      fetchPr: async ({ number }) => { seenNumbers.push(number); return { number, labels: [] }; },
      fetchReviews: async () => [fixtureReview('APPROVE')],
      getVcs: async () => vcs,
    },
  });
  assert.deepEqual(seenNumbers, [3, 11]);
  assert.deepEqual(results.map(r => r.number), [3, 11]);
});

test('runBoard: an empty open-PR list returns an empty result, no per-PR fetch happens', async () => {
  const results = await runBoard({
    project: 'csrinaldi/brain',
    provider: 'github',
    deps: {
      listOpenPrs: async () => [],
      fetchPr: async () => { throw new Error('must not be called'); },
      fetchReviews: async () => { throw new Error('must not be called'); },
    },
  });
  assert.deepEqual(results, []);
});

// ── deny-set fold: board.mjs never calls vcs.labelAdd/labelRemove bare ──────

test('board.mjs source routes every add/remove through guardedLabelAdd/guardedLabelRemove, never a bare vcs.labelAdd/labelRemove', () => {
  const src = readFileSync(fileURLToPath(new URL('./board.mjs', import.meta.url)), 'utf8');
  assert.match(src, /guardedLabelAdd/);
  assert.match(src, /guardedLabelRemove/);
  assert.doesNotMatch(src, /\bvcs\.labelAdd\(/);
  assert.doesNotMatch(src, /\bvcs\.labelRemove\(/);
});

// ── #477: an UNREADABLE verdict is not a clean one ──────────────────────────
//
// The maintainer ruling on #477 (2026-08-12), second half: the consumers that
// count findings must treat an unreadable field as NOT clean — "without that,
// option 3 collapses into option 1, a flag nobody reads".
//
// `parseVerdict` records what it could not read on `result.malformed` (#477's
// first half, PR #592). Here is why that matters at THIS consumer: `sequencing`
// is the one member of the family with a live, DESTRUCTIVE reader. Before this,
// `latestVerdict.sequencing ?? []` turned an unreadable value into an empty
// desired set, so every real `seq:*` label on the PR landed in `toRemove` —
// labels deleted by name off a value nobody could read. Protocol §10 forbids
// concluding on uncomputable evidence; this is that inversion in the writer.
//
// The rule: `seq:*` is UNCOMPUTABLE when `sequencing` is unreadable. Not empty
// — uncomputable. The board makes no `seq:*` change at all and says so.

import { parseVerdict } from './lib/parse-verdict.mjs';

test('#477: an unreadable `sequencing` freezes the seq:* namespace — no real label is deleted off a value nobody could read', () => {
  const { toAdd, toRemove, unreadable } = reconcileBoardLabels({
    latestVerdict: { verdict: 'APPROVE', malformed: ['sequencing'] },
    currentLabels: ['seq:after-411', 'seq:blocked-on-412', 'reviewed:approved'],
  });
  assert.deepEqual(toRemove, [], 'a live label scheduled for deletion off an unreadable verdict is data loss');
  assert.deepEqual(toAdd, []);
  assert.deepEqual(unreadable, ['sequencing'], 'and the board must SAY the namespace was uncomputable');
});

test('#477: freezing seq:* does not freeze reviewed:* — only the namespace whose input was unreadable', () => {
  // `verdict:` is mandatory and readable (parseVerdict returns null otherwise),
  // so the reviewed:* half is still computable and must still reconcile.
  // Refusing everything would be its own overreach.
  const { toAdd, toRemove } = reconcileBoardLabels({
    latestVerdict: { verdict: 'REVISE', malformed: ['sequencing'] },
    currentLabels: ['seq:after-411', 'reviewed:approved'],
  });
  assert.deepEqual(toAdd, ['reviewed:revised']);
  assert.deepEqual(toRemove, ['reviewed:approved'], 'the stale reviewed:* label is still corrected');
  assert.equal(toRemove.includes('seq:after-411'), false, 'the seq:* label must survive untouched');
});

test('#477: an unreadable field the board does not READ is still reported — never silently folded', () => {
  // `findings` drives no label. The ruling still requires the state to be
  // visible: "an unreadable verdict is reported, never silently folded into
  // either of the other two."
  const { toAdd, toRemove, unreadable } = reconcileBoardLabels({
    latestVerdict: { verdict: 'APPROVE', sequencing: ['seq:x'], malformed: ['findings'] },
    currentLabels: ['seq:x', 'reviewed:approved'],
  });
  assert.deepEqual(unreadable, ['findings']);
  assert.deepEqual(toAdd, [], 'a readable sequencing still reconciles normally');
  assert.deepEqual(toRemove, []);
});

test('#477: a fully READABLE verdict is unaffected — the control', () => {
  const { toAdd, toRemove, unreadable } = reconcileBoardLabels({
    latestVerdict: { verdict: 'APPROVE', sequencing: ['seq:merge-next'] },
    currentLabels: ['seq:stale', 'reviewed:approved'],
  });
  assert.deepEqual(toAdd, ['seq:merge-next']);
  assert.deepEqual(toRemove, ['seq:stale'], 'a readable verdict still drives real removals — the fix must not freeze the feature');
  assert.deepEqual(unreadable, []);
});

test('#477: reconcileOnePr carries `unreadable` through — including on the zero-write path', async () => {
  const calls = [];
  const result = await reconcileOnePr({
    project: 'o/r',
    number: 7,
    deps: {
      fetchPr: async () => ({ number: 7, labels: ['seq:after-411', 'reviewed:approved'] }),
      fetchReviews: async () => [{
        body: ['```yaml', 'protocol: brain-review/2', 'head_sha: abc123', 'verdict: APPROVE',
          'sequencing: not-valid-json', '```'].join('\n'),
        author: 'brain-reviewer',
      }],
      getVcs: async () => ({ labelAdd: async (a) => calls.push(a), labelRemove: async (a) => calls.push(a) }),
    },
  });
  assert.deepEqual(result.toAdd, []);
  assert.deepEqual(result.toRemove, []);
  assert.deepEqual(result.unreadable, ['sequencing'],
    'the zero-write early return must not drop the report — that is the silence the ruling names');
  assert.deepEqual(calls, [], 'and NOTHING is written to the PR');
});

// THE acceptance test for #477's second half: the real parser feeding the real
// consumer. A parser-level guard alone cannot demonstrate this property — the
// end state it exists to prevent is reachable only here, where the write happens.
test('#477 acceptance: a corrupt verdict from the REAL parser never deletes a live seq:* label', () => {
  const body = [
    '```yaml',
    'protocol: brain-review/2',
    'head_sha: abc123',
    'verdict: APPROVE',
    'sequencing: [{"broken"',          // truncated — a clipped comment, a bad hand-edit
    'findings: [{"id"',
    '```',
  ].join('\n');

  const parsed = parseVerdict({ body, author: 'brain-reviewer' });
  assert.deepEqual(parsed.malformed, ['sequencing', 'findings'], 'precondition: the parser reported both');

  const { toAdd, toRemove, unreadable } = reconcileBoardLabels({
    latestVerdict: parsed,
    currentLabels: ['seq:after-411', 'seq:blocked-on-412', 'reviewed:approved'],
  });
  assert.deepEqual(toRemove, [],
    'MEASURED on main before this change: toRemove was ["seq:after-411","seq:blocked-on-412"] — ' +
    'two real labels deleted because a verdict could not be read');
  assert.deepEqual(toAdd, []);
  assert.deepEqual(unreadable, ['sequencing', 'findings']);
});

test('#477: the `malformed` flag WINS over a value supplied beside it — found by mutation, not by design', () => {
  // The first mutation run on this change removed the `if (!sequencingUnreadable)`
  // guard and the suite stayed GREEN: `parseVerdict` omits an unreadable field,
  // so `sequencing` is undefined on every verdict the real producer emits and
  // the namespace filter carried that case by itself. An unexercised guard is
  // not a protection — it is a claim.
  //
  // This is the case that makes it one. `reconcileBoardLabels` is exported and
  // pure; a caller assembling a verdict by hand (a test fixture, a future
  // merger of two blocks, a migration) can present BOTH a half-read value and
  // the flag saying it was not readable. The flag must win, or the defect walks
  // back in through a producer that is not parseVerdict.
  const { toAdd, toRemove, unreadable } = reconcileBoardLabels({
    latestVerdict: {
      verdict: 'APPROVE',
      sequencing: ['seq:from-a-half-read-value'],
      malformed: ['sequencing'],
    },
    currentLabels: ['seq:after-411', 'reviewed:approved'],
  });
  assert.deepEqual(toAdd, [],
    'a label invented from a value the parser said it could not read must never be added');
  assert.deepEqual(toRemove, [], 'and the real label must not be deleted in its favour');
  assert.deepEqual(unreadable, ['sequencing']);
});

test('#477/review: a block-sequence `sequencing` never reaches guardedLabelAdd as an object', async () => {
  // The consumer-level half of the regression. `assertAllowed` threw
  // `refused label "[object Object]"` OUT of reconcileOnePr, so runBoard's loop
  // died and every remaining open PR went unreconciled.
  const body = ['```yaml', 'protocol: brain-review/2', 'head_sha: abc123', 'verdict: APPROVE',
    'sequencing:', '  - seq:after-411', '```'].join('\n');
  const results = await runBoard({
    project: 'o/r',
    deps: {
      listOpenPrs: async () => [{ number: 1 }, { number: 2 }],
      // `reviewed:approved` is already present, so the ONLY movement this
      // fixture can produce is the seq:* damage under test — the reviewed:*
      // half is deliberately still reconciled and would be a legitimate write.
      fetchPr: async () => ({ number: 1, labels: ['seq:after-411', 'reviewed:approved'] }),
      fetchReviews: async () => [{ body, author: 'brain-reviewer' }],
      getVcs: async () => ({
        labelAdd: async () => { throw new Error('must not write off an unreadable verdict'); },
        labelRemove: async () => { throw new Error('must not write off an unreadable verdict'); },
      }),
    },
  });
  assert.equal(results.length, 2, 'the loop must survive — a throw here strands every remaining PR');
  assert.deepEqual(results[0].unreadable, ['sequencing']);
  assert.deepEqual(results[0].toAdd, []);
  assert.deepEqual(results[0].toRemove, [], 'and the real seq:* label is not deleted either');
});
