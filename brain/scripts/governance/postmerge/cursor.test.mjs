// cursor.test.mjs — remote-authoritative tri-state cursor + atomic CAS
// advance (design §2). Every fixture below is copied verbatim from design
// §7.2's shape column (doctrine #900): B1-B6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, chmodSync } from 'node:fs';

import { gitTry, gitOrThrow } from './git-seam.mjs';
import {
  CURSOR_REF, readCursor, resolveWindow, advanceCursor, acceptManually, bootstrapCursor,
} from './cursor.mjs';

const CURSOR_SCRIPT = new URL('./cursor.mjs', import.meta.url).pathname;

// ── Fixture helpers (house pattern — brain-audit.test.mjs) ────────────────────

// Every repo AND every clone must carry its own git identity. `git clone`
// does NOT inherit user.name/user.email, and a fresh runner (actions/checkout)
// has no ambient identity to auto-detect — so a fixture that commits in a
// clone without setting identity fails ONLY off the author's machine. Set it
// on every working tree the fixtures commit into.
function setIdentity(dir) {
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' });
}

function makeRepo(dir) {
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '--initial-branch=main');
  setIdentity(dir);
  return git;
}

function realGit(cwd) {
  return { try: (argv) => gitTry(argv, { cwd }), orThrow: (argv) => gitOrThrow(argv, { cwd }) };
}

// A sha PRODUCER: it must explode loudly, never fabricate an empty string. A
// silent '' here is what let a failed no-identity commit masquerade as a
// legitimate {state:'unknown'} verdict (the environment-dependent B6 blind
// spot). If rev-parse fails or the output is not a 40-hex OID, throw.
function headSha(dir) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  const sha = (r.stdout ?? '').trim();
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(
      `headSha(${dir}): git rev-parse HEAD did not yield a 40-hex sha `
      + `(status=${r.status}, stdout=${JSON.stringify(sha)}, stderr=${(r.stderr ?? '').trim()}). `
      + 'A fixture git step failed — most likely a commit with no configured identity.',
    );
  }
  return sha;
}

/**
 * Build a bare "origin" repo with one commit on main, then a plain clone of
 * it (exactly like actions/checkout: fetches refs/heads/* + tags ONLY —
 * never a custom namespace). Returns { originDir, cloneDir, sha }.
 */
function makeBareOriginAndClone(t, { setCursorRef = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'cursor-fixture-'));
  t.after(() => removeTempTree(scratch));

  const seedDir = join(scratch, 'seed');
  mkdirSync(seedDir);
  const seedGit = makeRepo(seedDir);
  seedGit('commit', '--allow-empty', '-m', 'init');
  const sha = headSha(seedDir);

  const originDir = join(scratch, 'origin.git');
  spawnSync('git', ['clone', '--bare', seedDir, originDir], { encoding: 'utf8' });

  if (setCursorRef) {
    spawnSync('git', ['update-ref', CURSOR_REF, sha], { cwd: originDir, encoding: 'utf8' });
  }

  const cloneDir = join(scratch, 'clone');
  spawnSync('git', ['clone', originDir, cloneDir], { encoding: 'utf8' });
  setIdentity(cloneDir); // clones inherit no identity — fixtures commit here

  return { originDir, cloneDir, sha };
}

/**
 * Build a bare origin with a LINEAR history C0→C1→C2 on main and the cursor
 * ref set to C0 on origin. Returns the three shas plus the scratch dir so
 * callers can make independent clones. A plain `git clone` of this origin
 * fetches refs/heads/* only — it never creates a local refs/governance/*
 * ref, exactly like `actions/checkout` on a fresh runner.
 */
function makeOriginWithLinearHistory(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'cursor-race-'));
  t.after(() => removeTempTree(scratch));

  const originDir = join(scratch, 'origin.git');
  mkdirSync(originDir);
  spawnSync('git', ['init', '--bare', '--initial-branch=main', originDir], { encoding: 'utf8' });

  const builderDir = join(scratch, 'builder');
  mkdirSync(builderDir);
  const bg = makeRepo(builderDir);
  bg('remote', 'add', 'origin', originDir);
  bg('commit', '--allow-empty', '-m', 'C0');
  const c0 = headSha(builderDir);
  bg('commit', '--allow-empty', '-m', 'C1');
  const c1 = headSha(builderDir);
  bg('commit', '--allow-empty', '-m', 'C2');
  const c2 = headSha(builderDir);
  bg('push', 'origin', 'main');
  // Seed the cursor at C0 on origin ONLY — never as a local ref in any clone.
  bg('push', 'origin', `${c0}:${CURSOR_REF}`);

  return {
    scratch, originDir, c0, c1, c2,
  };
}

/** A plain clone of origin — fetches heads+tags only, no governance refs. */
function plainClone(scratch, originDir, name) {
  const dir = join(scratch, name);
  spawnSync('git', ['clone', originDir, dir], { encoding: 'utf8' });
  setIdentity(dir); // hermetic: never depend on ambient runner identity
  return dir;
}

/** Read the cursor sha directly off the bare origin. */
function remoteCursorSha(originDir) {
  return spawnSync('git', ['rev-parse', '--verify', `${CURSOR_REF}^{commit}`], {
    cwd: originDir, encoding: 'utf8',
  }).stdout.trim();
}

// ── Phase 1.2 — tri-state read ────────────────────────────────────────────────

// B1 — the tautological-test trap, reproduced.
test('readCursor: B1 — cursor ref set on origin, plain clone (fetches heads+tags only) → present, via explicit fetch', (t) => {
  const { cloneDir, sha } = makeBareOriginAndClone(t, { setCursorRef: true });
  const git = realGit(cloneDir);

  // First prove the fixture reproduces the real production shape: a plain
  // clone never fetched refs/governance/*, so the local rev-parse fails.
  const before = git.try(['rev-parse', '--verify', `${CURSOR_REF}^{commit}`]);
  assert.notEqual(before.status, 0, 'fixture sanity: local ref must be unresolved before readCursor runs');

  const result = readCursor({ git });
  assert.deepEqual(result, { state: 'present', sha });
});

// B2 — no cursor ref at all.
test('readCursor: B2 — no cursor ref on origin → absent (ls-remote --exit-code = 2)', (t) => {
  const { cloneDir } = makeBareOriginAndClone(t, { setCursorRef: false });
  const git = realGit(cloneDir);

  const result = readCursor({ git });
  assert.deepEqual(result, { state: 'absent' });
});

// B3 — unreachable origin.
test('readCursor: B3 — unreachable origin → unknown, NEVER absent', (t) => {
  const { cloneDir } = makeBareOriginAndClone(t, { setCursorRef: true });
  const git = realGit(cloneDir);

  spawnSync('git', ['remote', 'set-url', 'origin', join(cloneDir, 'does', 'not', 'exist')], {
    cwd: cloneDir, encoding: 'utf8',
  });

  const result = readCursor({ git });
  assert.equal(result.state, 'unknown');
  assert.notEqual(result.state, 'absent');
});

// Malformed ls-remote answer — status 0 but stdout carries no 40-hex sha.
// Must be 'unknown', NEVER silently downgraded to 'absent' (which would be a
// forged proof of absence from a malformed line).
test('readCursor: origin reports status 0 but stdout has no 40-hex sha → unknown, never downgraded to absent', () => {
  const fakeGit = {
    try: (argv) => {
      if (argv[0] === 'ls-remote') return { status: 0, stdout: 'garbage\trefs/governance/audit-cursor\n', stderr: '' };
      throw new Error(`unexpected git call: ${argv.join(' ')}`);
    },
  };
  const result = readCursor({ git: fakeGit });
  assert.deepEqual(result, { state: 'unknown' });
});

// readCursor reads the sha off ls-remote's own stdout — no local ref, no fetch.
test('readCursor: status 0 → present with the sha parsed from ls-remote stdout (remote is the sole authority)', () => {
  const sha = 'b'.repeat(40);
  const calls = [];
  const fakeGit = {
    try: (argv) => {
      calls.push(argv[0]);
      if (argv[0] === 'ls-remote') return { status: 0, stdout: `${sha}\trefs/governance/audit-cursor\n`, stderr: '' };
      throw new Error(`unexpected git call: ${argv.join(' ')}`);
    },
  };
  const result = readCursor({ git: fakeGit });
  assert.deepEqual(result, { state: 'present', sha });
  // No local-ref read and no fetch — the remote answer is authoritative.
  assert.deepEqual(calls, ['ls-remote']);
});

// ── Phase 1.3 — resolveWindow is ALWAYS cursor..HEAD ──────────────────────────

test('resolveWindow: present cursor at C, head H → { present, base: C, range: C..H, head: H }', (t) => {
  const { cloneDir, sha } = makeBareOriginAndClone(t, { setCursorRef: true });
  const git = realGit(cloneDir);
  spawnSync('git', ['commit', '--allow-empty', '-m', 'more'], { cwd: cloneDir, encoding: 'utf8' });
  const head = headSha(cloneDir);

  const result = resolveWindow({ git, head });
  assert.deepEqual(result, { state: 'present', base: sha, range: `${sha}..${head}`, head });
});

// B6 — cursor sha not an ancestor of HEAD (rewritten main).
test('resolveWindow: B6 — cursor is not an ancestor of HEAD → unknown, never a silently enormous window', (t) => {
  const { cloneDir } = makeBareOriginAndClone(t, { setCursorRef: false });
  const git = realGit(cloneDir);

  // Foreign commit unrelated to this repo's history.
  spawnSync('git', ['checkout', '--orphan', 'other'], { cwd: cloneDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'orphan'], { cwd: cloneDir, encoding: 'utf8' });
  const foreignSha = headSha(cloneDir);
  spawnSync('git', ['update-ref', CURSOR_REF, foreignSha], { cwd: cloneDir, encoding: 'utf8' });
  spawnSync('git', ['checkout', 'main'], { cwd: cloneDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'main-work'], { cwd: cloneDir, encoding: 'utf8' });
  const head = headSha(cloneDir);

  // Stub readCursor's dependency so this test does not depend on the ref
  // also being fetchable/present on the (bare) origin remote.
  const fakeGit = {
    try: (argv) => {
      if (argv[0] === 'ls-remote') return { status: 0, stdout: `${foreignSha}\trefs/governance/audit-cursor\n`, stderr: '' };
      return git.try(argv);
    },
  };

  const result = resolveWindow({ git: fakeGit, head });
  assert.deepEqual(result, { state: 'unknown', reason: 'cursor is not an ancestor of HEAD' });
});

test('resolveWindow: absent/unknown cursor state is propagated without computing a range', (t) => {
  const { cloneDir } = makeBareOriginAndClone(t, { setCursorRef: false });
  const git = realGit(cloneDir);
  const head = headSha(cloneDir);

  const result = resolveWindow({ git, head });
  assert.deepEqual(result, { state: 'absent' });
  assert.equal('range' in result, false);
});

// ── Phase 1.4 — advanceCursor: atomic CAS ─────────────────────────────────────

test('advanceCursor: B4 — no cursor ref on origin → remote lease rejects (never auto-creates), ref still absent afterward', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'cursor-cas-b4-'));
  t.after(() => removeTempTree(scratch));

  const originDir = join(scratch, 'origin.git');
  mkdirSync(originDir);
  spawnSync('git', ['init', '--bare', '--initial-branch=main', originDir], { encoding: 'utf8' });

  const workDir = join(scratch, 'work');
  mkdirSync(workDir);
  const git0 = makeRepo(workDir);
  git0('remote', 'add', 'origin', originDir);
  git0('commit', '--allow-empty', '-m', 'A');
  const from = headSha(workDir);
  git0('commit', '--allow-empty', '-m', 'B');
  const to = headSha(workDir);
  git0('push', 'origin', 'main');
  const git = realGit(workDir);

  // The cursor ref is absent on origin. A 40-hex `from` can never match the
  // ref's null OID, so the remote `--force-with-lease` rejects — the ref is
  // never auto-created.
  assert.throws(() => advanceCursor({ git, from, to }));
  const after = spawnSync('git', ['rev-parse', '--verify', `${CURSOR_REF}^{commit}`], {
    cwd: originDir, encoding: 'utf8',
  });
  assert.notEqual(after.status, 0, 'ref must not have been created on origin');
});

test('advanceCursor: non-40-hex from throws before touching git', () => {
  let called = false;
  const fakeGit = {
    try: () => { called = true; return { status: 0, stdout: '', stderr: '' }; },
    orThrow: () => { called = true; return ''; },
  };
  assert.throws(() => advanceCursor({ git: fakeGit, from: 'short-sha', to: 'a'.repeat(40) }));
  assert.equal(called, false, 'git seam must not be invoked when from fails validation');
});

test('advanceCursor: from that is not an ancestor of to throws (cursor only ever moves forward)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-cas-notancestor-'));
  t.after(() => removeTempTree(dir));
  const git0 = makeRepo(dir);
  git0('commit', '--allow-empty', '-m', 'A');
  const to = headSha(dir);
  git0('checkout', '--orphan', 'unrelated');
  git0('commit', '--allow-empty', '-m', 'B');
  const from = headSha(dir);
  const git = realGit(dir);

  assert.throws(() => advanceCursor({ git, from, to }));
});

// Two-clone cross-runner race (replaces the tautological single-workdir B5).
// Two INDEPENDENT clones each see the cursor at C0. Clone A advances C0→C1 and
// wins. Clone B, still holding the stale C0, tries C0→C2 — the REMOTE
// `--force-with-lease` must reject it, and the rejection must come from the
// PUSH, not any local update-ref (there is none in the new design). HOUSE BAR:
// this test goes RED if `--force-with-lease` is swapped for a plain `--force`
// (see mutation-bar evidence in the remediation report).
test('advanceCursor: two-clone cross-runner race — stale advance rejected by the REMOTE lease, winner stands', (t) => {
  const {
    scratch, originDir, c0, c1, c2,
  } = makeOriginWithLinearHistory(t);

  const cloneA = plainClone(scratch, originDir, 'cloneA');
  const cloneB = plainClone(scratch, originDir, 'cloneB');

  // Both clones observe the cursor at C0 (remote-authoritative read).
  assert.deepEqual(readCursor({ git: realGit(cloneA) }), { state: 'present', sha: c0 });
  assert.deepEqual(readCursor({ git: realGit(cloneB) }), { state: 'present', sha: c0 });

  // Clone A wins: C0 → C1.
  const winA = advanceCursor({ git: realGit(cloneA), from: c0, to: c1 });
  assert.deepEqual(winA, { from: c0, to: c1 });
  assert.equal(remoteCursorSha(originDir), c1);

  // Clone B is stale (still holds C0). Its C0 → C2 lease must be rejected by
  // the remote, whose cursor is now C1.
  assert.throws(() => advanceCursor({ git: realGit(cloneB), from: c0, to: c2 }));

  // The remote cursor is unchanged at the winner (C1) — the stale advance did
  // NOT win.
  assert.equal(remoteCursorSha(originDir), c1);

  // And the rejection came from the push: clone B never wrote a local ref.
  const localB = realGit(cloneB).try(['rev-parse', '--verify', `${CURSOR_REF}^{commit}`]);
  assert.notEqual(localB.status, 0, 'loser must not leave a local governance ref');
});

// accept on a plain checkout (production symptom-2): a clone that NEVER fetched
// refs/governance/* has NO local cursor ref, yet the remote cursor exists at
// C0. A human accept with correct from=C0,to=C1 must SUCCEED via the remote
// lease alone. PRE-FIX this aborted at the local `update-ref <ref> C1 C0`
// because the local ref was absent — the sole human escape hatch was
// inoperative in production.
test('acceptManually: succeeds on a plain checkout with NO local governance ref (remote lease is the only gate)', (t) => {
  const {
    scratch, originDir, c0, c1,
  } = makeOriginWithLinearHistory(t);

  const cloneDir = plainClone(scratch, originDir, 'human');
  // Fixture sanity: the human's clone genuinely has no local governance ref.
  const localBefore = realGit(cloneDir).try(['rev-parse', '--verify', `${CURSOR_REF}^{commit}`]);
  assert.notEqual(localBefore.status, 0, 'fixture: local governance ref must be absent on a plain checkout');

  const git = realGit(cloneDir);
  const result = acceptManually({
    git, from: c0, to: c1, reason: 'owner-approved forward-fix',
  });
  assert.deepEqual(result, { from: c0, to: c1 });
  assert.equal(remoteCursorSha(originDir), c1);
});

// Lease rejection leaves NO local divergence: a rejected advance must not
// leave a stray local governance ref pointing at the rejected `to`. In the
// new design nothing writes the ref locally, so its absence is the invariant.
test('advanceCursor: a lease-rejected advance leaves no divergent local governance ref', (t) => {
  const {
    scratch, originDir, c0, c1, c2,
  } = makeOriginWithLinearHistory(t);

  const cloneA = plainClone(scratch, originDir, 'winner');
  const cloneB = plainClone(scratch, originDir, 'loser');

  advanceCursor({ git: realGit(cloneA), from: c0, to: c1 });
  assert.throws(() => advanceCursor({ git: realGit(cloneB), from: c0, to: c2 }));

  // Loser has no local ref at all — certainly not one diverged to c2.
  const localB = realGit(cloneB).try(['rev-parse', '--verify', `${CURSOR_REF}^{commit}`]);
  assert.notEqual(localB.status, 0, 'no stray local governance ref may exist after a rejected lease');
  // And the authority (remote) is exactly the winner.
  assert.equal(remoteCursorSha(originDir), c1);
});

test('acceptManually: refuses an empty --reason', (t) => {
  const { cloneDir, sha } = makeBareOriginAndClone(t, { setCursorRef: true });
  const git = realGit(cloneDir);
  assert.throws(() => acceptManually({
    git, from: sha, to: headSha(cloneDir), reason: '',
  }));
});

test('acceptManually: caller-supplied `from` matches the live cursor → CAS succeeds, echoes reason (positive case)', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'cursor-accept-'));
  t.after(() => removeTempTree(scratch));

  const originDir = join(scratch, 'origin.git');
  mkdirSync(originDir);
  spawnSync('git', ['init', '--bare', '--initial-branch=main', originDir], { encoding: 'utf8' });

  const workDir = join(scratch, 'work');
  mkdirSync(workDir);
  const git0 = makeRepo(workDir);
  git0('remote', 'add', 'origin', originDir);
  git0('commit', '--allow-empty', '-m', 'A');
  const from = headSha(workDir);
  git0('push', 'origin', 'main');
  git0('update-ref', CURSOR_REF, from);
  git0('push', 'origin', `${CURSOR_REF}:${CURSOR_REF}`);

  git0('commit', '--allow-empty', '-m', 'B');
  const to = headSha(workDir);

  const git = realGit(workDir);
  const result = acceptManually({
    git, from, to, reason: 'owner-approved forward-fix',
  });
  assert.deepEqual(result, { from, to });

  // Assert on the REMOTE cursor — the sole authority. The new design never
  // writes a local ref, so the local ref would still be stale here.
  const after = spawnSync('git', ['rev-parse', '--verify', `${CURSOR_REF}^{commit}`], {
    cwd: originDir, encoding: 'utf8',
  });
  assert.equal(after.stdout.trim(), to);
});

// Owner-ruled fix: `from` is the caller's (human's) explicit assertion of the
// cursor value they reviewed — NOT read from the live cursor. If the live
// (remote) cursor moved between review and accept, the remote lease must
// reject the stale assertion instead of silently advancing from wherever the
// cursor now is (the skip-over class). This is the CROSS-RUNNER race: an
// automatic cron on a different runner advances the remote cursor C0→C1 in the
// window between the human's review of C0 and their accept call.
test('acceptManually: RACE — human asserts stale from=C0 but the REMOTE cursor already advanced to C1 → lease rejects, remote left at C1', (t) => {
  const {
    scratch, originDir, c0, c1, c2,
  } = makeOriginWithLinearHistory(t);

  // The cron runner advances the REMOTE cursor C0 → C1 in the race window.
  const cronClone = plainClone(scratch, originDir, 'cron');
  advanceCursor({ git: realGit(cronClone), from: c0, to: c1 });
  assert.equal(remoteCursorSha(originDir), c1);

  // The human runs accept on their own (plain) checkout, asserting the stale
  // from=C0 they reviewed, targeting C2. The remote lease (origin is now C1,
  // not C0) must reject.
  const humanClone = plainClone(scratch, originDir, 'human');
  assert.throws(() => acceptManually({
    git: realGit(humanClone), from: c0, to: c2, reason: 'owner-approved forward-fix',
  }));

  // The remote cursor is UNCHANGED at C1 — the stale accept did not skip over.
  assert.equal(remoteCursorSha(originDir), c1);
});

// Symmetric `to` validation (owner-ruled, Fix 1): `to` is the human's asserted
// target and MUST be a pinned 40-hex OID — never a symbolic/moving ref like
// 'main' resolved at push time. A symbolic `to` would let the cursor jump to
// main's LIVE tip, skipping PAST unreviewed commits (main's tip is a descendant
// of C0, so the ancestor check alone passes). HOUSE/MUTATION BAR: this test goes
// RED if the `HEX40.test(to)` guard in advanceCursor is removed — without it,
// `to:'main'` would advance instead of throwing.
test('acceptManually: non-40-hex `to` (symbolic "main" or garbage) throws, remote cursor UNCHANGED', (t) => {
  const {
    scratch, originDir, c0,
  } = makeOriginWithLinearHistory(t);

  const humanClone = plainClone(scratch, originDir, 'human');
  const git = realGit(humanClone);

  // Symbolic moving ref — the exact hole: main's live tip is a descendant of C0.
  assert.throws(
    () => acceptManually({
      git, from: c0, to: 'main', reason: 'owner-approved forward-fix',
    }),
    /to must be a 40-hex sha/,
  );
  assert.equal(remoteCursorSha(originDir), c0, 'remote cursor must be unchanged after symbolic `to` rejection');

  // Garbage non-hex target.
  assert.throws(
    () => acceptManually({
      git, from: c0, to: 'not-a-sha', reason: 'owner-approved forward-fix',
    }),
    /to must be a 40-hex sha/,
  );
  assert.equal(remoteCursorSha(originDir), c0, 'remote cursor must be unchanged after garbage `to` rejection');
});

// Positive path: the returned `to` is the validated 40-hex OID passed in (never
// a raw pre-validation input), and it equals the OID the remote cursor lands on.
test('acceptManually: positive path returns the 40-hex OID passed as `to`', (t) => {
  const {
    scratch, originDir, c0, c1,
  } = makeOriginWithLinearHistory(t);

  const humanClone = plainClone(scratch, originDir, 'human');
  const git = realGit(humanClone);

  const result = acceptManually({
    git, from: c0, to: c1, reason: 'owner-approved forward-fix',
  });
  assert.equal(result.to, c1, 'returned `to` must be the 40-hex OID passed in');
  assert.match(result.to, /^[0-9a-f]{40}$/, 'returned `to` must be a full 40-hex OID, never a symbolic name');
  assert.equal(remoteCursorSha(originDir), c1);
});

// ── CLI mode ───────────────────────────────────────────────────────────────

test('CLI: `cursor.mjs window` prints PRESENT <base> <head> and exits 0', (t) => {
  const { cloneDir, sha } = makeBareOriginAndClone(t, { setCursorRef: true });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'more'], { cwd: cloneDir, encoding: 'utf8' });
  const head = headSha(cloneDir);

  const r = spawnSync('node', [CURSOR_SCRIPT, 'window'], { cwd: cloneDir, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), `PRESENT ${sha} ${head}`);
  assert.equal(r.status, 0);
});

test('CLI: `cursor.mjs window` prints ABSENT and exits 2 when the cursor ref is absent', (t) => {
  const { cloneDir } = makeBareOriginAndClone(t, { setCursorRef: false });

  const r = spawnSync('node', [CURSOR_SCRIPT, 'window'], { cwd: cloneDir, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'ABSENT');
  assert.equal(r.status, 2);
});

test('CLI: `cursor.mjs window` prints UNKNOWN <reason> and exits 2 when origin is unreachable', (t) => {
  const { cloneDir } = makeBareOriginAndClone(t, { setCursorRef: true });
  spawnSync('git', ['remote', 'set-url', 'origin', join(cloneDir, 'nope')], { cwd: cloneDir, encoding: 'utf8' });

  const r = spawnSync('node', [CURSOR_SCRIPT, 'window'], { cwd: cloneDir, encoding: 'utf8' });
  assert.match(r.stdout.trim(), /^UNKNOWN/);
  assert.equal(r.status, 2);
});

test('CLI: `cursor.mjs accept <from> <to> --reason "<text>"` invokes acceptManually', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'cursor-cli-accept-'));
  t.after(() => removeTempTree(scratch));

  const originDir = join(scratch, 'origin.git');
  mkdirSync(originDir);
  spawnSync('git', ['init', '--bare', '--initial-branch=main', originDir], { encoding: 'utf8' });

  const workDir = join(scratch, 'work');
  mkdirSync(workDir);
  const git0 = makeRepo(workDir);
  git0('remote', 'add', 'origin', originDir);
  git0('commit', '--allow-empty', '-m', 'A');
  const from = headSha(workDir);
  git0('push', 'origin', 'main');
  git0('update-ref', CURSOR_REF, from);
  git0('push', 'origin', `${CURSOR_REF}:${CURSOR_REF}`);
  git0('commit', '--allow-empty', '-m', 'B');
  const to = headSha(workDir);

  const r = spawnSync('node', [CURSOR_SCRIPT, 'accept', from, to, '--reason', 'owner-approved'], {
    cwd: workDir, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /owner-approved/);

  // Discriminates a CLI that only reads the FIRST positional arg (pre-fix
  // shape: `accept <to>`, `from` sourced internally) from one that reads
  // BOTH positionals (`accept <from> <to>`): the REMOTE cursor must land on
  // the real target `to`, not silently no-op at `from`.
  const after = spawnSync('git', ['rev-parse', '--verify', `${CURSOR_REF}^{commit}`], {
    cwd: originDir, encoding: 'utf8',
  });
  assert.equal(after.stdout.trim(), to);
});

test('CLI: `cursor.mjs accept` with a missing --reason exits non-zero with a usage message', (t) => {
  const { cloneDir, sha } = makeBareOriginAndClone(t, { setCursorRef: true });

  const r = spawnSync('node', [CURSOR_SCRIPT, 'accept', sha, sha], { cwd: cloneDir, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Usage/);
});

// ── #1162 — bootstrap: a NEW repository's absent cursor is a bootstrap state,
// a DELETED cursor is an alarm. The two are told apart by evidence the
// workflow can read (a prior successful run of itself), never by a guess. ────

const WORKFLOW = '.github/workflows/governance-postmerge.yml';

/**
 * Bare origin + clone with history: R (root, pre-adoption) → A (adds the
 * postmerge workflow = the adoption commit) → M (a later merge-to-main).
 * NO cursor ref anywhere — exactly a fresh consumer.
 */
function makeFreshConsumer(t, { adoptionIsRoot = false } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'cursor-boot-'));
  t.after(() => removeTempTree(scratch));
  const originDir = join(scratch, 'origin.git');
  mkdirSync(originDir);
  spawnSync('git', ['init', '--bare', '--initial-branch=main', originDir], { encoding: 'utf8' });
  const dir = join(scratch, 'work');
  mkdirSync(dir);
  const g = makeRepo(dir);
  g('remote', 'add', 'origin', originDir);
  const shas = {};
  if (!adoptionIsRoot) {
    writeFileSync(join(dir, 'README.md'), 'hello\n'); g('add', '.'); g('commit', '-m', 'R');
    shas.root = headSha(dir);
  }
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, WORKFLOW), 'name: x\n'); g('add', '.'); g('commit', '-m', 'A adoption');
  shas.adoption = headSha(dir);
  writeFileSync(join(dir, 'later.txt'), 'x\n'); g('add', '.'); g('commit', '-m', 'M');
  shas.head = headSha(dir);
  g('push', 'origin', 'main');
  return { scratch, originDir, dir, ...shas };
}

const prior = (v) => () => v;

test('bootstrapCursor: #1162 (a) fresh repo, no prior audited run → cursor created AT the adoption commit, remote only', async (t) => {
  const f = makeFreshConsumer(t);
  const r = await bootstrapCursor({ git: realGit(f.dir), workflowPath: WORKFLOW, priorAudit: prior('none') });
  assert.equal(r.state, 'bootstrapped');
  assert.equal(r.base, f.adoption);
  assert.equal(remoteCursorSha(f.originDir), f.adoption);
});

test('bootstrapCursor: #1162 (c) the window after initialization starts AFTER the adoption commit and holds every later commit', async (t) => {
  const f = makeFreshConsumer(t);
  await bootstrapCursor({ git: realGit(f.dir), workflowPath: WORKFLOW, priorAudit: prior('none') });
  const w = resolveWindow({ git: realGit(f.dir), head: f.head });
  assert.equal(w.state, 'present');
  const commits = spawnSync('git', ['rev-list', w.range], { cwd: f.dir, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.ok(!commits.includes(f.adoption), 'a gate is not authoritative over the commit that installs it');
  assert.deepEqual(commits, [f.head], 'every commit AFTER the adoption is inside the window');
});

test('bootstrapCursor: #1162 adoption commit is the root → base is the adoption (same rule in every shape)', async (t) => {
  const f = makeFreshConsumer(t, { adoptionIsRoot: true });
  const r = await bootstrapCursor({ git: realGit(f.dir), workflowPath: WORKFLOW, priorAudit: prior('none') });
  assert.equal(r.state, 'bootstrapped');
  assert.equal(r.base, f.adoption);
});

test('bootstrapCursor: #1162 (b) DELETED cursor — a prior audited run exists → refused, cursor stays absent (alarm)', async (t) => {
  const f = makeFreshConsumer(t);
  const r = await bootstrapCursor({ git: realGit(f.dir), workflowPath: WORKFLOW, priorAudit: prior('some') });
  assert.equal(r.state, 'refused');
  assert.match(r.reason, /prior/i);
  assert.equal(remoteCursorSha(f.originDir), '', 'no cursor may be created');
});

test('bootstrapCursor: #1162 the evidence cannot be read → unknown, never a bootstrap', async (t) => {
  const f = makeFreshConsumer(t);
  const r = await bootstrapCursor({ git: realGit(f.dir), workflowPath: WORKFLOW, priorAudit: prior('unknown') });
  assert.equal(r.state, 'unknown');
  assert.equal(remoteCursorSha(f.originDir), '');
});

test('bootstrapCursor: #1162 a cursor already present is never overwritten', async (t) => {
  const f = makeFreshConsumer(t);
  spawnSync('git', ['push', 'origin', `${f.adoption}:${CURSOR_REF}`], { cwd: f.dir, encoding: 'utf8' });
  const r = await bootstrapCursor({ git: realGit(f.dir), workflowPath: WORKFLOW, priorAudit: prior('none') });
  assert.equal(r.state, 'present');
  assert.equal(remoteCursorSha(f.originDir), f.adoption);
});

test('bootstrapCursor: #1162 no adoption commit found on the first-parent line → unknown, never a guessed base', async (t) => {
  const f = makeFreshConsumer(t);
  const r = await bootstrapCursor({ git: realGit(f.dir), workflowPath: 'nope/never-added.yml', priorAudit: prior('none') });
  assert.equal(r.state, 'unknown');
  assert.equal(remoteCursorSha(f.originDir), '');
});

test('bootstrapCursor: #1162 creation is a CAS — a cursor that appears in the race is not clobbered', async (t) => {
  const f = makeFreshConsumer(t);
  const racer = (real) => ({
    try: (argv) => {
      if (argv[0] === 'push') {
        spawnSync('git', ['push', 'origin', `${f.head}:${CURSOR_REF}`], { cwd: f.dir, encoding: 'utf8' });
      }
      return real.try(argv);
    },
    orThrow: (argv) => {
      if (argv[0] === 'push') {
        spawnSync('git', ['push', 'origin', `${f.head}:${CURSOR_REF}`], { cwd: f.dir, encoding: 'utf8' });
      }
      return real.orThrow(argv);
    },
  });
  const r = await bootstrapCursor({ git: racer(realGit(f.dir)), workflowPath: WORKFLOW, priorAudit: prior('none') });
  assert.equal(r.state, 'present', 'a lost race re-reads the ref and proceeds');
  assert.equal(r.sha, f.head);
  assert.equal(remoteCursorSha(f.originDir), f.head, 'the racing cursor stands');
});

// ── #1162 END-TO-END: the REAL brain-audit over the bootstrapped window. ──────
// The adoption installs the gate, so it cannot be judged by it: an over-budget
// adoption (workflow + a 3000-line file, no issue link, no memory) must NOT be
// an offender, while a compliant commit after it must still be audited clean.

const AUDIT_SCRIPT = new URL('../../brain-audit.mjs', import.meta.url).pathname;

function compliantCommit(g, dir) {
  mkdirSync(join(dir, '.memory/records'), { recursive: true });
  writeFileSync(join(dir, '.memory/records/2026-07.jsonl'), JSON.stringify({
    id: 'r1', type: 'session_summary', title: 't', content: 'c', issue: 1, created_at: '2026-07-01T00:00:00Z',
  }) + '\n');
  g('add', '.'); g('commit', '-m', 'feat: compliant Closes #1');
}

function bigAdoptionFiles(dir) {
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, WORKFLOW), 'name: x\n');
  writeFileSync(join(dir, 'big.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n') + '\n');
}

async function e2e(t, { mergeAdoption }) {
  const scratch = mkdtempSync(join(tmpdir(), 'cursor-e2e-'));
  t.after(() => removeTempTree(scratch));
  const originDir = join(scratch, 'origin.git');
  mkdirSync(originDir);
  spawnSync('git', ['init', '--bare', '--initial-branch=main', originDir], { encoding: 'utf8' });
  const dir = join(scratch, 'work');
  mkdirSync(dir);
  const g = makeRepo(dir);
  g('remote', 'add', 'origin', originDir);
  writeFileSync(join(dir, 'README.md'), 'init\n'); g('add', '.'); g('commit', '-m', 'init');
  if (mergeAdoption) {
    g('checkout', '-b', 'adopt');
    bigAdoptionFiles(dir); g('add', '.'); g('commit', '-m', 'adopt brain');
    g('checkout', 'main');
    g('merge', '--no-ff', 'adopt', '-m', 'Merge adopt brain');
  } else {
    bigAdoptionFiles(dir); g('add', '.'); g('commit', '-m', 'adopt brain');
  }
  compliantCommit(g, dir);
  g('push', 'origin', 'main');
  const boot = await bootstrapCursor({ git: realGit(dir), workflowPath: WORKFLOW, priorAudit: prior('none') });
  assert.equal(boot.state, 'bootstrapped');
  const head = headSha(dir);
  const w = resolveWindow({ git: realGit(dir), head });
  const r = spawnSync('node', [AUDIT_SCRIPT, w.range], { cwd: dir, encoding: 'utf8' });
  return { r, boot, dir };
}

for (const mergeAdoption of [false, true]) {
  test(`bootstrapCursor: #1162 e2e — an over-budget ${mergeAdoption ? 'merge-commit' : 'direct-push'} adoption is never an offender; the real audit over the window exits 0`, async (t) => {
    const { r, boot } = await e2e(t, { mergeAdoption });
    assert.doesNotMatch(r.stdout, new RegExp(`\\[FAIL(-SHA)?\\][^\\n]*${boot.adoption.slice(0, 7)}`), `the adoption must not be flagged:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /\[FAIL-SHA\]/, `nothing may be nominated for auto-revert:\n${r.stdout}`);
    assert.equal(r.status, 0, `audit over the bootstrapped window must be clean:\n${r.stdout}\n${r.stderr}`);
  });
}

test('bootstrapCursor: #1162 the refusal names WHICH kind of unreadable evidence it was (unsupported vs unknown)', async (t) => {
  const f = makeFreshConsumer(t);
  const un = await bootstrapCursor({ git: realGit(f.dir), workflowPath: WORKFLOW, priorAudit: () => ({ evidence: 'unknown', why: 'unsupported' }) });
  assert.equal(un.state, 'unknown');
  assert.match(un.reason, /unsupported/);
  const uk = await bootstrapCursor({ git: realGit(f.dir), workflowPath: WORKFLOW, priorAudit: () => ({ evidence: 'unknown', why: 'unknown' }) });
  assert.doesNotMatch(uk.reason, /unsupported/);
  assert.match(uk.reason, /unknown/);
});

// ── #1162 review: `bootstrap` parses flags BEFORE the positional ─────────────
// A recording `gh` on PATH proves what the CLI actually asked the port for.
function bootstrapCli(t, args) {
  const f = makeFreshConsumer(t);
  const bin = join(f.scratch, 'bin');
  mkdirSync(bin);
  const log = join(f.scratch, 'gh.log');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "gh $*" >> ${log}\nprintf '[]'\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  const r = spawnSync('node', [CURSOR_SCRIPT, 'bootstrap', ...args], {
    cwd: f.dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VCS_PROVIDER: 'github' },
  });
  return { r, ghLog: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

test('CLI: `bootstrap --branch main` uses the default workflow path, not `--branch`', (t) => {
  const { r, ghLog } = bootstrapCli(t, ['--branch', 'main']);
  assert.match(ghLog, /--workflow governance-postmerge\.yml --branch main/, `stdout=${r.stdout}\n${ghLog}`);
  assert.match(r.stdout, /^BOOTSTRAPPED /);
});

test('CLI: `bootstrap <path> --branch main` takes the positional path and the branch', (t) => {
  const { ghLog } = bootstrapCli(t, [WORKFLOW, '--branch', 'main']);
  assert.match(ghLog, /--workflow governance-postmerge\.yml --branch main/);
});

test('CLI: `bootstrap --branch main <path>` (flag first) still finds the positional', (t) => {
  const { ghLog } = bootstrapCli(t, ['--branch', 'main', WORKFLOW]);
  assert.match(ghLog, /--workflow governance-postmerge\.yml --branch main/);
});

// ── #1162 round 2 (cold-1): the default branch must come from a source present on
// EVERY trigger. `github.event.repository.default_branch` is empty on `schedule`,
// so an empty `--branch` resolves from the remote's own HEAD (ls-remote --symref).
test('CLI: `bootstrap --branch ""` (a schedule run) resolves the default branch from the remote HEAD', (t) => {
  const { ghLog, r } = bootstrapCli(t, ['--branch', '']);
  assert.match(ghLog, /--workflow governance-postmerge\.yml --branch main/, `stdout=${r.stdout}\n${ghLog}`);
  assert.match(r.stdout, /^BOOTSTRAPPED /);
});

test('CLI: `bootstrap` with no --branch at all resolves the default branch from the remote HEAD', (t) => {
  const { ghLog } = bootstrapCli(t, []);
  assert.match(ghLog, /--workflow governance-postmerge\.yml --branch main/);
});

// ── #1162 round 2 (cold-3): what an ALREADY-installed consumer gets. Its runs all
// failed at ABSENT, so evidence is `none` and the base is its (possibly old)
// adoption: every merge since is audited for the first time, and a tree-keyed
// offender among them IS nominated. Pinned so the design's residual stays true.
test('bootstrapCursor: #1162 an already-installed consumer\'s first window audits every merge since adoption and nominates an old offender', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'cursor-old-'));
  t.after(() => removeTempTree(scratch));
  const originDir = join(scratch, 'origin.git');
  mkdirSync(originDir);
  spawnSync('git', ['init', '--bare', '--initial-branch=main', originDir], { encoding: 'utf8' });
  const dir = join(scratch, 'work');
  mkdirSync(dir);
  const g = makeRepo(dir);
  g('remote', 'add', 'origin', originDir);
  writeFileSync(join(dir, 'README.md'), 'init\n'); g('add', '.'); g('commit', '-m', 'init');
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  writeFileSync(join(dir, WORKFLOW), 'name: x\n'); g('add', '.'); g('commit', '-m', 'adopt brain');
  // weeks later, never audited: an over-budget commit with no issue link
  writeFileSync(join(dir, 'big.txt'), Array.from({ length: 3000 }, (_, i) => `l${i}`).join('\n') + '\n');
  g('add', '.'); g('commit', '-m', 'old offender');
  compliantCommit(g, dir);
  g('push', 'origin', 'main');
  const boot = await bootstrapCursor({ git: realGit(dir), workflowPath: WORKFLOW, priorAudit: prior('none') });
  assert.equal(boot.state, 'bootstrapped');
  const w = resolveWindow({ git: realGit(dir), head: headSha(dir) });
  const r = spawnSync('node', [AUDIT_SCRIPT, w.range], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /\[FAIL-SHA\]/);
});
