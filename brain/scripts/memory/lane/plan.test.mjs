// plan.test.mjs — pure unit suite for planLaneCommit (#887 Slice A, the lane
// collector's planner). RED until brain/scripts/memory/lane/plan.mjs exists
// (task A1). Every case here is taken from spec.md's STRICT TDD test map.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildRecord, serializeRecord, validateRecord } from '../lib/format.mjs';
import { emptyDuplicates } from '../lib/duplicates.mjs';
import { planLaneCommit } from './plan.mjs';

const PLAN_MJS_PATH = fileURLToPath(new URL('./plan.mjs', import.meta.url));

const base = {
  ts: '2026-09-01T12:00:00Z',
  actor: '@crinaldi',
  actorKind: 'human',
  type: 'decision',
  project: 'brain',
};

const NO_PARENT = { ref: 'origin/main', tip: null };

/** A valid record's filename + serialized content (store.mjs's naming grammar). */
function recordFixture(content) {
  const rec = buildRecord({ ...base, content });
  const month = rec.ts.slice(0, 7);
  const file = `${month}-${rec.id}.jsonl`;
  return { file, content: serializeRecord(rec) };
}

function candidate({ worktree, file, content, status = '??', path, ...rest }) {
  return { worktree, file, path: path ?? `.memory/records/${file}`, status, content, ...rest };
}

function plan(overrides = {}) {
  return planLaneCommit({
    candidates: [],
    mainPaths: [],
    host: 'my-host',
    date: '2026-09-09',
    parent: NO_PARENT,
    ...overrides,
  });
}

// ── A1.1 candidate selection and skip routing ───────────────────────────────

test('an untracked, clean, off-main file is a candidate', () => {
  const { file, content } = recordFixture('a clean record');
  const p = plan({ candidates: [candidate({ worktree: '/repo/wt-a', file, content })] });
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].file, file);
  assert.equal(p.files[0].worktree, '/repo/wt-a');
  assert.equal(p.files[0].path, `.memory/records/${file}`);
  assert.equal(p.skipped.length, 0);
});

test('modified-tracked, invalid, and already-on-main candidates each skip with their own reason, none collected', () => {
  const modified = recordFixture('modified-tracked candidate');
  const invalid = { file: '2026-09-rec-0000000000000000.jsonl', content: 'not json at all' };
  const onMain = recordFixture('already shipped');

  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-a', file: modified.file, content: modified.content, status: ' M' }),
      candidate({ worktree: '/repo/wt-a', file: invalid.file, content: invalid.content }),
      candidate({ worktree: '/repo/wt-a', file: onMain.file, content: onMain.content }),
    ],
    mainPaths: [`.memory/records/${onMain.file}`],
  });

  assert.equal(p.files.length, 0);
  const reasons = Object.fromEntries(p.skipped.map((s) => [s.file, s.reason]));
  assert.equal(reasons[modified.file], 'modified-tracked');
  assert.equal(reasons[invalid.file], 'invalid');
  assert.equal(reasons[onMain.file], 'already-on-main');
  assert.equal(p.skipped.length, 3);
});

test('well-formed JSON that fails the record schema skips as invalid, carrying validateRecord errors (C1)', () => {
  const parsed = { foo: 'bar' };
  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-a', file: '2026-09-rec-2222222222222222.jsonl', content: JSON.stringify(parsed) }),
    ],
  });
  assert.equal(p.files.length, 0);
  assert.equal(p.skipped.length, 1);
  assert.equal(p.skipped[0].reason, 'invalid');
  assert.deepEqual(p.skipped[0].errors, validateRecord(parsed).errors);
  assert.ok(p.skipped[0].errors.length > 0, 'a schema failure must carry at least one error');
});

test('an unexpected status code skips as unexpected-status, carrying the code', () => {
  const { file, content } = recordFixture('staged mid-commit');
  const p = plan({ candidates: [candidate({ worktree: '/repo/wt-a', file, content, status: 'A ' })] });
  assert.equal(p.files.length, 0);
  assert.equal(p.skipped.length, 1);
  assert.equal(p.skipped[0].reason, 'unexpected-status');
  assert.equal(p.skipped[0].code, 'A ');
});

test('.memory/index.jsonl is excluded by filename grammar — never in files or skipped', () => {
  const p = plan({
    candidates: [candidate({ worktree: '/repo/wt-a', file: 'index.jsonl', content: '{}', path: '.memory/index.jsonl' })],
  });
  assert.equal(p.files.length, 0);
  assert.equal(p.skipped.length, 0);
});

test('a not-a-record name, including a pre-#677 month log, skips pointing at brain:memory:split-records', () => {
  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-a', file: '2026-09.jsonl', content: '{}' }),
      candidate({ worktree: '/repo/wt-a', file: 'notes.txt', content: 'hi' }),
    ],
  });
  assert.equal(p.files.length, 0);
  assert.equal(p.skipped.length, 2);
  for (const s of p.skipped) {
    assert.equal(s.reason, 'not-a-record');
    assert.match(s.hint, /brain:memory:split-records/);
  }
});

test('a candidate that fails to read (unreadable) skips with its error, never invalid', () => {
  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-a', file: '2026-09-rec-1111111111111111.jsonl', content: null, readError: 'ENOENT' }),
    ],
  });
  assert.equal(p.files.length, 0);
  assert.equal(p.skipped.length, 1);
  assert.equal(p.skipped[0].reason, 'unreadable');
  assert.equal(p.skipped[0].error, 'ENOENT');
});

test('an unreadable candidate without a readError omits the error field entirely (E6)', () => {
  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-a', file: '2026-09-rec-3333333333333333.jsonl', content: null }),
    ],
  });
  assert.equal(p.skipped.length, 1);
  assert.deepStrictEqual(p.skipped[0], {
    file: '2026-09-rec-3333333333333333.jsonl',
    worktree: '/repo/wt-a',
    reason: 'unreadable',
  });
  assert.ok(!('error' in p.skipped[0]), 'no readError means no error key at all — not error: undefined');
});

test('a secret-marked candidate routes to skipped with pattern+lineNumber, never appears in files', () => {
  const { file, content } = recordFixture('has a secret in it');
  const p = plan({
    candidates: [
      candidate({
        worktree: '/repo/wt-a',
        file,
        content,
        secret: { pattern: 'ghp_[A-Za-z0-9]{20,}', lineNumber: 1 },
      }),
    ],
  });
  assert.equal(p.files.length, 0);
  assert.equal(p.skipped.length, 1);
  assert.deepEqual(p.skipped[0], {
    file,
    worktree: '/repo/wt-a',
    reason: 'secret',
    pattern: 'ghp_[A-Za-z0-9]{20,}',
    lineNumber: 1,
  });
});

test('a secret-marked WINNER skips the whole group — no fall-through to the runner-up, and the group is not reported as a duplicate (C5)', () => {
  const rec = buildRecord({ ...base, content: 'group with a secret winner' });
  const month = rec.ts.slice(0, 7);
  const file = `${month}-${rec.id}.jsonl`;
  const p = plan({
    candidates: [
      // lexicographically-first worktree path wins C2 and carries the secret mark
      candidate({
        worktree: '/repo/wt-a',
        file,
        content: serializeRecord(rec),
        secret: { pattern: 'ghp_[A-Za-z0-9]{20,}', lineNumber: 1 },
      }),
      candidate({ worktree: '/repo/wt-z', file, content: serializeRecord(rec) }),
    ],
  });
  assert.equal(p.files.length, 0, 'the runner-up must not be collected in place of the secret winner');
  assert.equal(p.skipped.length, 1);
  assert.equal(p.skipped[0].reason, 'secret');
  assert.equal(p.skipped[0].worktree, '/repo/wt-a');
  // C5: a group whose WINNER is secret-skipped must never be counted as a
  // duplicate — occurrences are only registered once the winner clears the
  // secret guard.
  assert.deepStrictEqual(p.duplicates, emptyDuplicates());
});

test('a secret-marked LOSER also gets its own skip; the clean winner is still collected (C6)', () => {
  const rec = buildRecord({ ...base, content: 'clean winner, secret loser' });
  const month = rec.ts.slice(0, 7);
  const file = `${month}-${rec.id}.jsonl`;
  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-a', file, content: serializeRecord(rec) }),
      candidate({
        worktree: '/repo/wt-b',
        file,
        content: serializeRecord(rec),
        secret: { pattern: 'ghp_[A-Za-z0-9]{20,}', lineNumber: 3 },
      }),
    ],
  });
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].worktree, '/repo/wt-a', 'the clean, lexicographically-first candidate still wins');
  const secretSkips = p.skipped.filter((s) => s.reason === 'secret');
  assert.equal(secretSkips.length, 1, 'the secret loser must be reported somewhere, not silently dropped');
  assert.equal(secretSkips[0].worktree, '/repo/wt-b');
  assert.equal(secretSkips[0].file, file);
  assert.equal(secretSkips[0].pattern, 'ghp_[A-Za-z0-9]{20,}');
  assert.equal(secretSkips[0].lineNumber, 3);
});

test('a duplicate occurrence location is built from the candidate\'s own path, not a hardcoded records/ prefix (E1)', () => {
  const { file, content } = recordFixture('nested worktree layout');
  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-a', file, content, path: `sub/.memory/records/${file}` }),
      candidate({ worktree: '/repo/wt-b', file, content }),
    ],
  });
  assert.equal(p.duplicates.groups.length, 1);
  assert.deepEqual(p.duplicates.groups[0].occurrences, [
    `/repo/wt-a/sub/.memory/records/${file}:1`,
    `/repo/wt-b/.memory/records/${file}:1`,
  ]);
});

// ── A1.2 deterministic dedup on divergence (D3/C2) ──────────────────────────

test('identical-bytes copies across worktrees collapse to one blob, no divergence reported', () => {
  const { file, content } = recordFixture('same bytes everywhere');
  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-a', file, content }),
      candidate({ worktree: '/repo/wt-b', file, content }),
    ],
  });
  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].worktree, '/repo/wt-a', 'lexicographically-first worktree wins even on identical bytes');
  assert.equal(p.duplicates.ids, 1);
  assert.equal(p.duplicates.divergent, 0);
});

test('diverging copies resolve by lexicographic worktree path; the group is reported as divergent', () => {
  const recA = buildRecord({ ...base, content: 'copy A' });
  const month = recA.ts.slice(0, 7);
  const file = `${month}-${recA.id}.jsonl`;
  // Same id, different bytes OUTSIDE the hash (`source` widening — the real-world
  // divergence case, store.mjs:388-396) — never `localeCompare`, plain code-unit order.
  const recB = { ...recA, source: 'issue #887 / widened' };

  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-z', file, content: serializeRecord(recA) }),
      candidate({ worktree: '/repo/wt-a', file, content: serializeRecord(recB) }),
    ],
  });

  assert.equal(p.files.length, 1);
  assert.equal(p.files[0].worktree, '/repo/wt-a', 'lexicographically-first worktree path wins');
  assert.equal(p.duplicates.ids, 1);
  assert.equal(p.duplicates.divergent, 1);
  assert.equal(p.duplicates.groups[0].divergent, true);
});

test('a key-order-only difference is a duplicate, not a divergence (canonicalOrNull agrees)', () => {
  const rec = buildRecord({ ...base, content: 'order only' });
  const month = rec.ts.slice(0, 7);
  const file = `${month}-${rec.id}.jsonl`;
  const reordered = {};
  for (const k of Object.keys(rec).reverse()) reordered[k] = rec[k];

  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-a', file, content: JSON.stringify(reordered) }),
      candidate({ worktree: '/repo/wt-b', file, content: JSON.stringify(rec) }),
    ],
  });

  assert.equal(p.files.length, 1);
  assert.equal(p.duplicates.ids, 1);
  assert.equal(p.duplicates.divergent, 0, 'key order alone must not count as divergent');
});

// ── A1.3 stability under shuffled enumeration ───────────────────────────────

function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

test('stability: all 6 permutations of worktree-block enumeration order yield a deep-equal plan; a repeat call matches too', () => {
  const worktrees = ['/repo/wt-a', '/repo/wt-b', '/repo/wt-c'];
  const solo = recordFixture('solo in wt-a');
  const shared = recordFixture('shared identical bytes');
  const divA = buildRecord({ ...base, content: 'diverges across wt-a/wt-b' });
  const divMonth = divA.ts.slice(0, 7);
  const divFile = `${divMonth}-${divA.id}.jsonl`;
  const divB = { ...divA, source: 'issue #887 / widened' };
  const onlyC = recordFixture('solo in wt-c');

  /** Fixed per-worktree candidate blocks — only the BLOCK order is permuted.
   * C2: `stray.txt` (not-a-record) is placed in TWO of the three blocks
   * (wt-a, wt-b), same filename, so the skip entries can only agree across
   * block-order permutations if `skipped` is sorted (file, then worktree) —
   * without the sort, the pre-sort push order tracks block order and the
   * `deepStrictEqual` below would fail on at least one permutation. */
  const byWorktree = {
    '/repo/wt-a': [
      candidate({ worktree: '/repo/wt-a', file: solo.file, content: solo.content }),
      candidate({ worktree: '/repo/wt-a', file: shared.file, content: shared.content }),
      candidate({ worktree: '/repo/wt-a', file: divFile, content: serializeRecord(divA) }),
      candidate({ worktree: '/repo/wt-a', file: 'stray.txt', content: 'not a record' }),
    ],
    '/repo/wt-b': [
      candidate({ worktree: '/repo/wt-b', file: shared.file, content: shared.content }),
      candidate({ worktree: '/repo/wt-b', file: divFile, content: serializeRecord(divB) }),
      candidate({ worktree: '/repo/wt-b', file: 'stray.txt', content: 'not a record either' }),
    ],
    '/repo/wt-c': [
      candidate({ worktree: '/repo/wt-c', file: onlyC.file, content: onlyC.content }),
    ],
  };

  const orders = permutations(worktrees);
  assert.equal(orders.length, 6, 'exhaustive, not randomised');

  let reference = null;
  for (const order of orders) {
    const candidates = order.flatMap((wt) => byWorktree[wt]);
    const p = plan({ candidates });
    if (reference === null) reference = p;
    else assert.deepStrictEqual(p, reference);
  }

  const repeat = plan({ candidates: worktrees.flatMap((wt) => byWorktree[wt]) });
  assert.deepStrictEqual(repeat, reference, 'a repeated call on identical input returns an identical plan');

  // C3: files must come out sorted by path.
  const paths = reference.files.map((f) => f.path);
  const sortedPaths = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepStrictEqual(paths, sortedPaths, 'files must be sorted by path');

  // C2: skipped must come out sorted by (file, then worktree).
  function skipCompare(a, b) {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    const wa = a.worktree ?? '';
    const wb = b.worktree ?? '';
    return wa < wb ? -1 : wa > wb ? 1 : 0;
  }
  const sortedSkipped = [...reference.skipped].sort(skipCompare);
  assert.deepStrictEqual(reference.skipped, sortedSkipped, 'skipped must be sorted by file, then worktree');
  assert.ok(
    reference.skipped.some((s) => s.file === 'stray.txt' && s.worktree === '/repo/wt-a')
    && reference.skipped.some((s) => s.file === 'stray.txt' && s.worktree === '/repo/wt-b'),
    'both stray.txt skips must be present',
  );
});

test('files are sorted by path, not by grouping/basename push order (C3)', () => {
  // Basename order (X before Y) and path order (Y before X, via the '!'
  // prefix) deliberately disagree, so this fails if `files.sort()` is removed
  // and the grouping loop's push order leaks through unsorted.
  const recX = buildRecord({ ...base, content: 'group X' });
  const recY = buildRecord({ ...base, content: 'group Y' });
  const fileX = '2026-09-rec-0000000000000000.jsonl';
  const fileY = '2026-09-rec-ffffffffffffffff.jsonl';
  const p = plan({
    candidates: [
      candidate({ worktree: '/repo/wt-a', file: fileX, content: serializeRecord(recX) }),
      candidate({
        worktree: '/repo/wt-a',
        file: fileY,
        content: serializeRecord(recY),
        path: `!zzz-worktree/.memory/records/${fileY}`,
      }),
    ],
  });
  assert.equal(p.files.length, 2);
  assert.deepEqual(p.files.map((f) => f.path), [
    `!zzz-worktree/.memory/records/${fileY}`,
    `.memory/records/${fileX}`,
  ]);
});

// ── A1.4 ref/message naming and empty-input shape ───────────────────────────

test('host slug: lowercase, non-alnum collapsed to -, trimmed, truncated to 40', () => {
  const p = plan({ host: '  My.Host_Name!!  ' });
  assert.equal(p.ref, 'refs/heads/memory/my-host-name-2026-09-09');
});

test('slug truncation to 40 that lands exactly on a dash is stripped again (C4)', () => {
  // 39 'a's + a single space (becomes '-' at index 39) + 5 'b's — slice(0, 40)
  // keeps the 39 'a's plus that dash as its 40th char; the post-truncation
  // strip must remove the trailing dash it lands on.
  const host = `${'a'.repeat(39)} ${'b'.repeat(5)}`;
  const p = plan({ host });
  assert.equal(p.ref, `refs/heads/memory/${'a'.repeat(39)}-2026-09-09`);
});

test('the finished ref matches L1s grammar exactly', () => {
  const p = plan({ host: 'host1' });
  assert.match(p.ref, /^refs\/heads\/memory\/[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}$/);
});

test('an empty host slug throws memory.collect.badHost', () => {
  assert.throws(() => plan({ host: '!!!' }), /memory\.collect\.badHost/);
});

test('a malformed date throws memory.collect.badDate — never badHost, when the host is fine (E2)', () => {
  assert.throws(() => plan({ host: 'valid-host', date: '2026/09/09' }), /memory\.collect\.badDate/);
});

test('an empty host slug with a well-formed date still throws memory.collect.badHost, not badDate (E2)', () => {
  assert.throws(() => plan({ host: '!!!', date: '2026-09-09' }), /memory\.collect\.badHost/);
});

test('message is "memory: <host-slug> <date> (<n> records)"', () => {
  const { file, content } = recordFixture('one record');
  const p = plan({ candidates: [candidate({ worktree: '/repo/wt-a', file, content })] });
  assert.equal(p.message, 'memory: my-host 2026-09-09 (1 records)');
});

test('parent resolves to the given tip when present, else the input ref', () => {
  const p1 = plan({ parent: { ref: 'origin/main', tip: null } });
  assert.equal(p1.parent, 'origin/main');
  const p2 = plan({ parent: { ref: 'origin/main', tip: 'deadbeefdeadbeef' } });
  assert.equal(p2.parent, 'deadbeefdeadbeef');
});

test('a plan built from zero candidates returns an empty duplicates/files/skipped shape and no commit key (E5)', () => {
  const p = plan();
  assert.deepStrictEqual(p.duplicates, emptyDuplicates());
  assert.deepStrictEqual(p.files, []);
  assert.deepStrictEqual(p.skipped, []);
  // E5: the planner is pure and never touches git — `commit` is the shell's
  // (collect.mjs) field to own, after it actually runs `commit-tree`.
  assert.ok(!('commit' in p), 'planLaneCommit must not return a commit field at all');
});

// ── source guard: pure module, no fs/spawn/clock/os ─────────────────────────

test('plan.mjs imports no node:fs, node:child_process, node:os, and reads no wall clock, env, or dynamic module (E3)', () => {
  const src = readFileSync(PLAN_MJS_PATH, 'utf8');
  assert.doesNotMatch(src, /from ['"]node:fs['"]/);
  assert.doesNotMatch(src, /from ['"]node:child_process['"]/);
  assert.doesNotMatch(src, /from ['"]node:os['"]/);
  assert.doesNotMatch(src, /new Date\(/);
  assert.doesNotMatch(src, /Date\.now\(/);
  assert.doesNotMatch(src, /process\.env/);
  assert.doesNotMatch(src, /createRequire/);
  assert.doesNotMatch(src, /import\(/);
});
