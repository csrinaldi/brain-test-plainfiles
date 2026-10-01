// installer-journal.integration.test.mjs — the crash-then-recover contract (#396 slice 2).
//
// Named `.integration.` because one case spawns a real child process and SIGKILLs it.
// That case is the point of the whole slice: SIGKILL runs NO in-process handler, so it
// is the one failure mode slice 1's restore point could not cover, and the only way to
// prove the journal survives it is to actually do it.
//
// The cheap unit cases below pin the same contract without a subprocess, so a
// regression is caught even if the process-spawning case is ever skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  copyManaged,
  createRestorePoint,
  readJournal,
  recoverFromJournal,
  acquireLock,
  inspectRestorePoint,
  RESTORE_POINT_DIR,
  JOURNAL_FILE,
  JOURNAL_VERSION,
} from './installer.mjs';

const LIB = fileURLToPath(new URL('./installer.mjs', import.meta.url));

/** A consumer repo mid-life: one managed path holding bytes the consumer cares about. */
function seed(tmp) {
  const src = join(tmp, 'src');
  const dest = join(tmp, 'dest');
  mkdirSync(join(src, 'brain', 'core'), { recursive: true });
  writeFileSync(join(src, 'brain', 'core', 'a.md'), 'NEW BYTES');
  mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
  writeFileSync(join(dest, 'brain', 'core', 'a.md'), 'CONSUMER ORIGINAL');
  return { src, dest };
}

// ── REQ-J-1: a real SIGKILL leaves a replayable journal ───────────────────────
test('journal: a SIGKILL mid-write leaves a journal, the next run refuses, and --recover restores (REQ-J-1)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j1-'));
  try {
    const { src, dest } = seed(tmp);

    // A child that performs a REAL write and then spins, so only SIGKILL ends it.
    const child = `
      import { writeFileSync, readFileSync } from 'node:fs';
      const { copyManaged } = await import(${JSON.stringify(LIB)});
      copyManaged({
        srcRoot: ${JSON.stringify(src)}, destRoot: ${JSON.stringify(dest)},
        managed: ['brain/core/**'], local: [],
        specialMerge: { 'brain/core/a.md': (dp, sp) => {
          writeFileSync(dp, readFileSync(sp));
          console.log('WROTE');
          for (;;) {}
        } },
      });
    `;
    const proc = spawn(process.execPath, ['--input-type=module', '-e', child]);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child never reached the write')), 20000);
        proc.on('error', (e) => { clearTimeout(timer); reject(e); });
        proc.stdout.on('data', (d) => {
          if (d.toString().includes('WROTE')) { clearTimeout(timer); resolve(); }
        });
      });
    } finally {
      // The child busy-spins by design, so it MUST be killed on every path. Without
      // this the timeout branch leaves it spinning, its handle keeps the test
      // runner's event loop referenced, and the CI job hangs at 100% CPU until its
      // wall clock kills it — a hang is worse than the failure it was reporting.
      proc.kill('SIGKILL');
    }
    await new Promise((resolve) => proc.on('exit', resolve));

    // The tree is half-applied and nothing in-process could have prevented it.
    assert.equal(readFileSync(join(dest, 'brain', 'core', 'a.md'), 'utf8'), 'NEW BYTES',
      'precondition: the kill left the write applied');
    assert.ok(readJournal(dest), 'the journal must survive a kill — it is the only evidence left');

    // A later run must not quietly proceed over it.
    assert.throws(
      () => createRestorePoint({ destRoot: dest, relPaths: ['brain/core/a.md'] }),
      (err) => err.interruptedRun === true && err.coveredPaths === 1,
      'the next run must refuse and say what the interrupted run covered',
    );

    const result = recoverFromJournal({ destRoot: dest });
    assert.deepEqual(result.failed, [], 'recovery must put every covered path back');
    assert.deepEqual(result.recovered, ['brain/core/a.md']);
    assert.equal(readFileSync(join(dest, 'brain', 'core', 'a.md'), 'utf8'), 'CONSUMER ORIGINAL',
      'the tree must return to its pre-upgrade bytes');
    assert.ok(!existsSync(join(dest, RESTORE_POINT_DIR)),
      'a complete recovery consumes its own evidence');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-J-2: absence of a journal is itself the signal ────────────────────────
test('journal: a leftover snapshot with NO journal is cleared, not replayed (REQ-J-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j2-'));
  try {
    const { src, dest } = seed(tmp);
    // What a run killed DURING its snapshot leaves: bytes, but no journal.
    mkdirSync(join(dest, RESTORE_POINT_DIR, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, RESTORE_POINT_DIR, 'brain', 'core', 'a.md'), 'STALE');

    const result = copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [] });

    assert.ok(result.copied.includes('brain/core/a.md'),
      'no journal means nothing was ever written, so the run must proceed normally');
    assert.equal(readFileSync(join(dest, 'brain', 'core', 'a.md'), 'utf8'), 'NEW BYTES',
      'stale snapshot bytes must never be restored over a tree they did not protect');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-J-3: a journal that cannot be trusted is not guessed at ───────────────
test('journal: an unparseable or unknown-version journal is treated as absent (REQ-J-3)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j3-'));
  try {
    const dir = join(tmp, RESTORE_POINT_DIR);
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, JOURNAL_FILE), 'not json at all');
    assert.equal(readJournal(tmp), null, 'unparseable must read as absent');

    writeFileSync(join(dir, JOURNAL_FILE), JSON.stringify({ version: JOURNAL_VERSION + 99, saved: [], created: [], createdDirs: [] }));
    assert.equal(readJournal(tmp), null, 'an unknown version must read as absent, never be guessed at');

    writeFileSync(join(dir, JOURNAL_FILE), JSON.stringify({ version: JOURNAL_VERSION, saved: 'nope' }));
    assert.equal(readJournal(tmp), null, 'a malformed shape must read as absent');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-J-4: the journal is written before the first write, not after ─────────
test('journal: it exists from before the first write, so a kill can never miss it (REQ-J-4)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j4-'));
  try {
    const { src, dest } = seed(tmp);
    let journalAtFirstWrite = null;

    copyManaged({
      srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [],
      // This fn runs as the FIRST write of the run. If the journal is not already on
      // disk here, a kill one instruction earlier would leave an unreplayable snapshot.
      specialMerge: { 'brain/core/a.md': (dp, sp) => {
        journalAtFirstWrite = readJournal(dest);
        writeFileSync(dp, readFileSync(sp));
      } },
    });

    assert.ok(journalAtFirstWrite, 'the journal must already exist when the first write happens');
    assert.deepEqual(journalAtFirstWrite.saved, ['brain/core/a.md']);
    assert.ok(!existsSync(join(dest, RESTORE_POINT_DIR)),
      'and a clean run must leave neither journal nor snapshot behind');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-J-5: concurrent runs cannot shred each other's restore point ──────────
test("journal: a LIVE owner blocks; a DEAD owner lock is reclaimed, not obeyed forever (REQ-J-5)", () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j5-'));
  try {
    const first = acquireLock(tmp);
    assert.throws(() => acquireLock(tmp), /is running in this repo \(pid \d+/,
      'a live owner must block, and the message must name the pid that holds it');

    // Sibling of the snapshot dir, so a run clearing that dir cannot release a lock
    // it does not hold.
    rmSync(join(tmp, RESTORE_POINT_DIR), { recursive: true, force: true });
    assert.throws(() => acquireLock(tmp), /is running in this repo/);

    first.release();
    const second = acquireLock(tmp);
    assert.ok(second.path, 'the lock must be retakeable once released');
    second.release();

    // A SIGKILLed run leaves its lock forever. Obeying a dead owner would strand the
    // repo, so liveness — not mere file existence — decides.
    writeFileSync(join(tmp, RESTORE_POINT_DIR + '.lock'), '999999999\n');
    const third = acquireLock(tmp);
    assert.ok(third.path, "a dead owner's lock must be reclaimed, not obeyed");
    third.release();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal: --recover REFUSES while the owner is alive, instead of reverting under it (REQ-J-8)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j8-'));
  try {
    const { dest } = seed(tmp);
    // A live run that is PART-WAY THROUGH its write loop: the new bytes are already
    // down. Reverting here is precisely the damage — the run would then finish and
    // report success over a tree recovery had silently rolled back underneath it.
    writeFileSync(join(dest, 'brain', 'core', 'a.md'), 'NEW BYTES');
    // Exactly what that run looks like from outside: its lock, plus the journal it
    // wrote before its first write.
    mkdirSync(join(dest, RESTORE_POINT_DIR, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, RESTORE_POINT_DIR, 'brain', 'core', 'a.md'), 'CONSUMER ORIGINAL');
    writeFileSync(join(dest, RESTORE_POINT_DIR, JOURNAL_FILE), JSON.stringify(
      { version: JOURNAL_VERSION, saved: ['brain/core/a.md'], created: [], createdDirs: [] }));
    // A genuinely FOREIGN live owner. Using our own pid would not do: a process must
    // never read its own lock as a competitor, so `mine` would (correctly) suppress the
    // live-run verdict and this test would prove nothing.
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      writeFileSync(join(dest, RESTORE_POINT_DIR + '.lock'), `${owner.pid}\n`);

      assert.throws(() => recoverFromJournal({ destRoot: dest }), (err) => err.liveRun === true,
        'recovery must never revert a tree a live run is still writing');
    } finally {
      owner.kill('SIGKILL');
    }
    assert.equal(readFileSync(join(dest, 'brain', 'core', 'a.md'), 'utf8'), 'NEW BYTES',
      'the live run\'s work must be untouched');
    assert.ok(existsSync(join(dest, RESTORE_POINT_DIR)), 'and its restore point must survive');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-J-6: the real CLI, over the exact state a kill leaves behind ──────────
// REQ-J-1 proves a SIGKILL leaves {journal, snapshot, stale lock}. This stages that
// state and drives the REAL brain-upgrade.mjs over it, which is where the wiring
// lives: three defects (the refusal deleting its own evidence, the stale lock
// blocking the only remedy, and --recover ignoring --dry-run) were all invisible to
// tests that called the library directly.
function stageKilledRun(tmp) {
  const consumer = join(tmp, 'consumer');
  const pkg = join(consumer, 'node_modules', 'brain');
  mkdirSync(join(pkg, 'brain', 'core'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'brain', version: '9.9.9' }));
  writeFileSync(join(pkg, 'brain', 'core', 'managed-paths.mjs'),
    'export const managed = ["brain/core/**"];\nexport const local = [];\nexport const MANAGED_SCRIPT_KEYS = [];\n');
  writeFileSync(join(pkg, 'brain', 'core', 'config-migrations.mjs'), 'export const migrations = [];\n');
  writeFileSync(join(pkg, 'brain', 'core', 'a.md'), 'NEW UPSTREAM BYTES');

  // The consumer tree as the kill left it: half-applied.
  mkdirSync(join(consumer, 'brain', 'core'), { recursive: true });
  writeFileSync(join(consumer, 'brain', 'core', 'a.md'), 'NEW UPSTREAM BYTES');

  // …plus exactly what the dead run left: snapshot + journal + a lock it never released.
  const snap = join(consumer, RESTORE_POINT_DIR);
  mkdirSync(join(snap, 'brain', 'core'), { recursive: true });
  writeFileSync(join(snap, 'brain', 'core', 'a.md'), 'CONSUMER ORIGINAL');
  writeFileSync(join(snap, JOURNAL_FILE), JSON.stringify(
    { version: JOURNAL_VERSION, saved: ['brain/core/a.md'], created: [], createdDirs: [] }));
  writeFileSync(join(consumer, RESTORE_POINT_DIR + '.lock'), '999999999\n'); // > pid_max: always dead, never a live CI process
  return consumer;
}

const CLI = fileURLToPath(new URL('../brain-upgrade.mjs', import.meta.url));
const runCli = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });

test('journal: the real CLI refuses over a killed run WITHOUT destroying its evidence (REQ-J-6)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j6-'));
  try {
    const consumer = stageKilledRun(tmp);
    const snapshotFile = join(consumer, RESTORE_POINT_DIR, 'brain', 'core', 'a.md');

    const r = runCli(consumer, ['v1.2.3', '--no-install']);
    assert.notEqual(r.status, 0, 'a run over an interrupted predecessor must not succeed');
    assert.match(r.stderr + r.stdout, /--recover/, 'it must name the remedy');
    assert.ok(existsSync(snapshotFile),
      'the refusal must NOT delete the snapshot it just told the operator to recover from');
    assert.equal(readFileSync(snapshotFile, 'utf8'), 'CONSUMER ORIGINAL');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('journal: --recover works through a stale lock, and honours --dry-run (REQ-J-7)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j7-'));
  try {
    const consumer = stageKilledRun(tmp);
    const target = join(consumer, 'brain', 'core', 'a.md');

    // A SIGKILL runs no exit handler, so the lock ALWAYS survives — recovery must not
    // be the one command that lock blocks.
    const dry = runCli(consumer, ['--recover', '--dry-run']);
    assert.equal(dry.status, 0, '--dry-run recovery must not fail on the stale lock');
    assert.equal(readFileSync(target, 'utf8'), 'NEW UPSTREAM BYTES',
      '--dry-run must not write, even on the recovery path');

    const real = runCli(consumer, ['--recover']);
    assert.equal(real.status, 0, `recovery must succeed through a stale lock — got: ${real.stderr}`);
    assert.equal(readFileSync(target, 'utf8'), 'CONSUMER ORIGINAL',
      'recovery must return the tree to its pre-upgrade bytes');
    assert.ok(!existsSync(join(consumer, RESTORE_POINT_DIR)),
      'a complete recovery consumes its own evidence');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-J-9: the CLI must actually TAKE the lock ──────────────────────────────
// Every other lock test calls acquireLock directly or stages a lock file by hand.
// None of them noticed when the CLI's `acquireLock(ROOT)` call site was deleted
// outright: 2293 tests stayed green while `live-run` became unreachable in
// production and two concurrent upgrades could shred each other's restore point.
//
// Blocking is deterministic, not timing-based: the consumer's `package.json` is a
// FIFO with no writer, so the snapshot's copyFileSync blocks on it forever. If the
// lock is taken at all, it is held at that moment.
function buildConsumer(tmp) {
  const consumer = join(tmp, 'consumer');
  const pkg = join(consumer, 'node_modules', 'brain');
  mkdirSync(join(pkg, 'brain', 'core'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'brain', version: '9.9.9' }));
  writeFileSync(join(pkg, 'brain', 'core', 'managed-paths.mjs'),
    'export const managed = ["brain/core/**"];\nexport const local = [];\nexport const MANAGED_SCRIPT_KEYS = [];\n');
  writeFileSync(join(pkg, 'brain', 'core', 'config-migrations.mjs'), 'export const migrations = [];\n');
  writeFileSync(join(pkg, 'brain', 'core', 'a.md'), 'NEW');
  mkdirSync(join(consumer, 'brain', 'core'), { recursive: true });
  // A real package.json: `detectPM` reads it at module load, long before the lock, so
  // blocking THERE would prove nothing about the lock.
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'c', version: '1.0.0' }));
  return consumer;
}

test('journal: a real brain:upgrade HOLDS the lock while it works, and a second one is refused (REQ-J-9)', async (t) => {
  if (spawnSync('mkfifo', ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('mkfifo unavailable — cannot block the write deterministically here');
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j9-'));
  let blocked;
  try {
    const consumer = buildConsumer(tmp);
    // A FIFO with no writer at a MANAGED path: the snapshot's copyFileSync blocks
    // reading it, which happens after the lock is taken. (Note this also makes the
    // child unkillable by SIGTERM — the handlers are queued behind a synchronous
    // syscall — so the cleanup below must use SIGKILL.)
    spawnSync('mkfifo', [join(consumer, 'brain', 'core', 'a.md')]);

    blocked = spawn(process.execPath, [CLI, 'v1', '--no-install'], { cwd: consumer });

    const lockPath = join(consumer, RESTORE_POINT_DIR + '.lock');
    const deadline = Date.now() + 15000;
    while (!existsSync(lockPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    assert.ok(existsSync(lockPath),
      'a running brain:upgrade must hold the lock — without this the live-run verdict can never fire in production');
    assert.equal(readFileSync(lockPath, 'utf8').trim(), String(blocked.pid),
      'the lock must record the pid of the run that holds it, so liveness is checkable');

    const second = spawnSync(process.execPath, [CLI, 'v1', '--no-install'], { cwd: consumer, encoding: 'utf8' });
    assert.notEqual(second.status, 0, 'a second concurrent upgrade must be refused');
    assert.match(second.stderr + second.stdout, /is running in this repo/,
      'and it must say why, naming the live owner');
  } finally {
    if (blocked) { blocked.kill('SIGKILL'); await new Promise((r) => blocked.on('exit', r)); }
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-J-10: the product actually works ─────────────────────────────────────
// Six review rounds, 2294 passing tests, and NOTHING asserted that a plain
// `brain:upgrade` succeeds. Every CLI test asserted a refusal or a recovery, so
// two consecutive "fixes" shipped green: one was a no-op (the lock call site was
// deleted), the next was a brick (the run refused its own lock).
//
// Note this test alone would NOT have caught the deleted call site — the upgrade
// worked fine without a lock. REQ-J-9 catches that. Neither is sufficient alone:
// J-9 proves the lock is taken, J-10 proves the upgrade still completes. The pair
// is the invariant.
test('journal: a plain brain:upgrade SUCCEEDS end to end and leaves no residue (REQ-J-10)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j10-'));
  try {
    const consumer = buildConsumer(tmp);
    writeFileSync(join(consumer, 'brain', 'core', 'a.md'), 'CONSUMER ORIGINAL');

    const r = spawnSync(process.execPath, [CLI, 'v1', '--no-install'], { cwd: consumer, encoding: 'utf8' });

    assert.equal(r.status, 0, `a normal upgrade must succeed — got ${r.status}: ${r.stderr}`);
    assert.equal(readFileSync(join(consumer, 'brain', 'core', 'a.md'), 'utf8').trim(), 'NEW',
      'and it must actually write the new bytes — an exit code alone proves nothing');
    assert.ok(!existsSync(join(consumer, RESTORE_POINT_DIR)),
      'a clean run consumes its own restore point');
    assert.ok(!existsSync(join(consumer, RESTORE_POINT_DIR + '.lock')),
      'and releases its lock, or the next run is stranded');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-J-11: an unowned lock is reclaimed, never obeyed ─────────────────────
// A zero-length lock is the canonical post-power-cut residue — create and write are
// not one atomic step and the lock is not fsynced — and power loss is this feature's
// whole threat model. Treating "occupied but naming no owner" as "held" manufactured
// a permanent lockout on precisely the event the feature exists to survive.
test('journal: a lock naming no live owner is reclaimed in every shape (REQ-J-11)', () => {
  const shapes = {
    empty: (p) => writeFileSync(p, ''),
    garbage: (p) => writeFileSync(p, 'not-a-pid\n'),
    directory: (p) => mkdirSync(p),
    danglingLink: (p) => symlinkSync(join(tmpdir(), 'no-such-target-ever'), p),
  };
  for (const [name, make] of Object.entries(shapes)) {
    const tmp = mkdtempSync(join(tmpdir(), 'brain-j11-'));
    try {
      make(join(tmp, RESTORE_POINT_DIR + '.lock'));
      const l = acquireLock(tmp);
      assert.ok(l.path, `an unowned lock (${name}) must be reclaimed, not obeyed forever`);
      l.release();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

// ── REQ-J-12: "could not read it" is not "nobody owns it" ────────────────────
// Widening the reclaim to unowned locks accidentally widened it to UNREADABLE ones,
// inverting this feature's stated safety property from "it strands, it never permits"
// to permitting: a live owner's lock that merely could not be read — EACCES from a
// lock written under another uid, EIO from the failing disk this exists for, EMFILE
// under CI fd pressure, ESTALE on NFS — was reclaimed out from under it.
test('journal: an UNREADABLE lock fails closed; only structurally unowned ones are reclaimed (REQ-J-12)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j12-'));
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    const lockPath = join(tmp, RESTORE_POINT_DIR + '.lock');
    writeFileSync(lockPath, `${owner.pid}\n`);
    chmodSync(lockPath, 0o000);

    if (process.getuid?.() === 0) return; // root reads anything; nothing to prove here

    const state = inspectRestorePoint(tmp);
    assert.equal(state.state, 'live-run',
      'an unreadable lock must fail CLOSED — refusing costs a re-run, permitting costs the consumer their work');
    assert.match(state.reason, /cannot be read/, 'and it must say it is unsure, not invent an owner');
    assert.throws(() => acquireLock(tmp), /cannot be read|is running/,
      'acquireLock must not reclaim a lock it could not read');

    // A structurally unowned lock is still reclaimed — the fix must not re-strand those.
    chmodSync(lockPath, 0o644);
    writeFileSync(lockPath, '');
    const l = acquireLock(tmp);
    assert.ok(l.path, 'an empty lock names no owner and must still be reclaimable');
    l.release();
  } finally {
    owner.kill('SIGKILL');
    try { chmodSync(join(tmp, RESTORE_POINT_DIR + '.lock'), 0o644); } catch { /* gone */ }
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-J-13: recovery reports removals as removals ──────────────────────────
// On a first adoption almost every covered path is one the interrupted run CREATED,
// so recovery DELETES it. Reporting that as "restored to its pre-upgrade bytes" told
// operators their files were put back while they were being removed — and anything
// hand-written at those paths after the crash went with them, unmentioned.
test('journal: recovery separates restorations from removals, and warns about the latter (REQ-J-13)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-j13-'));
  try {
    const consumer = buildConsumer(tmp);
    writeFileSync(join(consumer, 'brain', 'core', 'kept.md'), 'CONSUMER ORIGINAL');
    const snap = join(consumer, RESTORE_POINT_DIR);
    mkdirSync(join(snap, 'brain', 'core'), { recursive: true });
    writeFileSync(join(snap, 'brain', 'core', 'kept.md'), 'CONSUMER ORIGINAL');
    writeFileSync(join(snap, JOURNAL_FILE), JSON.stringify({
      version: JOURNAL_VERSION,
      saved: ['brain/core/kept.md'],
      created: ['brain/core/added.md'],   // did not exist before → must be REMOVED
      createdDirs: [],
    }));
    writeFileSync(join(consumer, 'brain', 'core', 'added.md'), 'HAND REPAIR AFTER THE CRASH');
    writeFileSync(join(consumer, RESTORE_POINT_DIR + '.lock'), '999999999\n'); // dead owner

    const r = spawnSync(process.execPath, [CLI, '--recover'], { cwd: consumer, encoding: 'utf8' });
    const out = r.stdout + r.stderr;

    assert.equal(r.status, 0, `recovery must succeed: ${r.stderr}`);
    assert.match(out, /Restored 1 managed path/, 'a genuine restoration is reported as one');
    assert.match(out, /Removed 1 managed path/, 'a deletion must NOT be reported as a restoration');
    assert.match(out, /repairs made by hand/, 'and the operator must be warned that removals take their edits with them');
    assert.ok(!existsSync(join(consumer, 'brain', 'core', 'added.md')), 'the created path is removed');
    assert.ok(!existsSync(join(consumer, RESTORE_POINT_DIR + '.lock')),
      "recovery must clear the dead run's lock — a SIGKILL never released it, and leaving it strands the next upgrade");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-M-1: a corrupt consumer file must not lock the consumer out ──────────
// #396 already made this failure SAFE — the tree rolls back and the error names the
// file, the line and the column. What it did not do is make it ESCAPABLE: a single
// unparseable file blocks all 366 managed paths, 364 of which have nothing to do with
// it, and it fails only after step 1 has already installed the new package.
function corruptConsumer(tmp, { corrupt = '.claude/settings.json' } = {}) {
  const consumer = join(tmp, 'consumer');
  const pkg = join(consumer, 'node_modules', 'brain');
  mkdirSync(join(pkg, 'brain', 'core'), { recursive: true });
  mkdirSync(join(pkg, '.claude'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'brain', version: '9.9.9' }));
  writeFileSync(join(pkg, 'brain', 'core', 'managed-paths.mjs'),
    'export const managed = ["brain/core/**", ".claude/settings.json"];\nexport const local = [];\nexport const MANAGED_SCRIPT_KEYS = [];\n');
  writeFileSync(join(pkg, 'brain', 'core', 'config-migrations.mjs'), 'export const migrations = [];\n');
  writeFileSync(join(pkg, 'brain', 'core', 'a.md'), 'NEW');
  writeFileSync(join(pkg, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
  mkdirSync(join(consumer, 'brain', 'core'), { recursive: true });
  mkdirSync(join(consumer, '.claude'), { recursive: true });
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'c', version: '1.0.0' }));
  writeFileSync(join(consumer, 'brain', 'core', 'a.md'), 'OLD');
  writeFileSync(join(consumer, corrupt), '{ "permissions": { broken json here');
  return consumer;
}

test('upgrade: a corrupt consumer file is caught BEFORE any work, naming the file and the escape (REQ-M-1)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-m1-'));
  try {
    const consumer = corruptConsumer(tmp);
    const r = spawnSync(process.execPath, [CLI, 'v1', '--no-install'], { cwd: consumer, encoding: 'utf8' });
    const out = r.stdout + r.stderr;

    assert.notEqual(r.status, 0, 'it must refuse');
    assert.match(out, /\.claude\/settings\.json/, 'it must name the file that cannot be parsed');
    assert.match(out, /--skip-merge/, 'and it must name the way out, or the consumer is locked out');
    assert.ok(!existsSync(join(consumer, RESTORE_POINT_DIR)),
      'a pre-flight refusal must not have built a snapshot it never needed');
    assert.equal(readFileSync(join(consumer, 'brain', 'core', 'a.md'), 'utf8'), 'OLD',
      'and nothing may be written');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('upgrade: --skip-merge upgrades everything else and leaves the corrupt file untouched (REQ-M-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-m2-'));
  try {
    const consumer = corruptConsumer(tmp);
    const before = readFileSync(join(consumer, '.claude', 'settings.json'), 'utf8');

    const r = spawnSync(process.execPath,
      [CLI, 'v1', '--no-install', '--skip-merge', '.claude/settings.json'],
      { cwd: consumer, encoding: 'utf8' });
    const out = r.stdout + r.stderr;

    assert.equal(r.status, 0, `the rest of the upgrade must proceed: ${r.stderr}`);
    assert.equal(readFileSync(join(consumer, 'brain', 'core', 'a.md'), 'utf8'), 'NEW',
      'the 364 paths that have nothing to do with the corrupt file must upgrade');
    assert.equal(readFileSync(join(consumer, '.claude', 'settings.json'), 'utf8'), before,
      'the skipped file must be left exactly as it was — never clobbered as a consolation');
    assert.match(out, /skipped/i, 'and the run must say loudly what it skipped');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-M-3: the #180 invariant, asserted on BEHAVIOUR ───────────────────────
// The pre-existing guard is a source-TEXT regex, and #399 moved it from the call site
// to the declaration — which is not the invariant. The wiring is. With that regex,
// `specialMerge: mergeMap` → `specialMerge: {}` reproduced issue #180 verbatim (the
// consumer's project identity replaced by brain's) with all 2300 tests green.
//
// A text assertion can only pin the shape someone thought to write down. This drives
// the real CLI and asserts what #180 is actually about: the consumer's package.json
// survives an upgrade.
test('upgrade: the consumer package.json identity survives an upgrade (issue #180, REQ-M-3)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-m3-'));
  try {
    const consumer = corruptConsumer(tmp);
    // A VALID consumer package.json this time, with identity worth losing.
    writeFileSync(join(consumer, 'package.json'), JSON.stringify(
      { name: 'my-consumer', version: '2.3.4', scripts: { test: 'echo mine' } }, null, 2));
    writeFileSync(join(consumer, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash'] } }));

    const r = spawnSync(process.execPath, [CLI, 'v1', '--no-install'], { cwd: consumer, encoding: 'utf8' });
    assert.equal(r.status, 0, `the upgrade must succeed: ${r.stderr}`);

    const pkg = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'my-consumer', "the consumer's project name must survive — this IS issue #180");
    assert.equal(pkg.version, '2.3.4', 'and its version');
    assert.equal(pkg.scripts.test, 'echo mine', 'and its own scripts');

    const settings = JSON.parse(readFileSync(join(consumer, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings.permissions.allow, ['Bash'], 'consumer settings content must survive the merge too');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('upgrade: a corrupt package.json is caught by the pre-flight too, not only .claude (REQ-M-4)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-m4-'));
  try {
    // The `corrupt` parameter existed and no caller ever used it — so the more
    // dangerous of the two merge targets went untested.
    const consumer = corruptConsumer(tmp, { corrupt: 'package.json' });
    writeFileSync(join(consumer, '.claude', 'settings.json'), JSON.stringify({ permissions: {} }));

    const r = spawnSync(process.execPath, [CLI, 'v1', '--no-install'], { cwd: consumer, encoding: 'utf8' });
    const out = r.stdout + r.stderr;

    assert.notEqual(r.status, 0, 'it must refuse');
    assert.match(out, /package\.json/, 'naming package.json');
    assert.match(out, /repair/i, 'and for package.json the only real remedy is to repair it — npm cannot run a script without it');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-D-*: a downgrade must not silently ratchet the config schema ─────────
// `migrateConfig` only ever moves schemaVersion UP, so installing an older tag leaves
// the consumer with OLD code and a NEW config schema — a combination no tag ever
// shipped. Measured before the fix: schemaVersion 0.9.0 survived an install of 0.3.0,
// the managed files went backwards, and the run printed "Done." with exit 0.
function downgradeConsumer(tmp, { pkgVersion = '0.3.0', schemaVersion = '0.9.0' } = {}) {
  const consumer = join(tmp, 'consumer');
  const pkg = join(consumer, 'node_modules', 'brain');
  mkdirSync(join(pkg, 'brain', 'core'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'brain', version: pkgVersion }));
  writeFileSync(join(pkg, 'brain', 'core', 'managed-paths.mjs'),
    'export const managed = ["brain/core/**"];\nexport const local = [];\nexport const MANAGED_SCRIPT_KEYS = [];\n');
  writeFileSync(join(pkg, 'brain', 'core', 'config-migrations.mjs'),
    "export const migrations = [\n"
    + "  { version: '0.1.0', description: 'base', defaults: { project: { slug: '' } } },\n"
    + "  { version: '0.9.0', description: 'later', defaults: { governance: { reviewActors: [] } } },\n"
    + "];\n");
  writeFileSync(join(pkg, 'brain', 'core', 'a.md'), 'OLD UPSTREAM');
  mkdirSync(join(consumer, 'brain', 'core'), { recursive: true });
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'c', version: '1.0.0' }));
  writeFileSync(join(consumer, 'brain', 'core', 'a.md'), 'CONSUMER');
  writeFileSync(join(consumer, 'brain.config.json'), JSON.stringify(
    { project: { slug: 'c' }, governance: { tier: 'lite' }, schemaVersion }, null, 2) + '\n');
  return consumer;
}

test('upgrade: a downgrade is refused by default, naming both versions (REQ-D-1)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-d1-'));
  try {
    const consumer = downgradeConsumer(tmp);
    const r = spawnSync(process.execPath, [CLI, 'v0.3.0', '--no-install'], { cwd: consumer, encoding: 'utf8' });
    const out = r.stdout + r.stderr;

    assert.notEqual(r.status, 0, 'a downgrade must not silently succeed');
    assert.match(out, /0\.9\.0/, 'it must name the schema the consumer is on');
    assert.match(out, /0\.3\.0/, 'and the version being installed');
    assert.match(out, /--allow-downgrade/, 'and the flag that proceeds anyway');
    assert.equal(readFileSync(join(consumer, 'brain', 'core', 'a.md'), 'utf8'), 'CONSUMER',
      'and nothing may be written');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('upgrade: --allow-downgrade proceeds and names the config keys left ahead (REQ-D-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-d2-'));
  try {
    const consumer = downgradeConsumer(tmp);
    const r = spawnSync(process.execPath, [CLI, 'v0.3.0', '--no-install', '--allow-downgrade'],
      { cwd: consumer, encoding: 'utf8' });
    const out = r.stdout + r.stderr;

    assert.equal(r.status, 0, `it must proceed when asked explicitly: ${r.stderr}`);
    assert.equal(readFileSync(join(consumer, 'brain', 'core', 'a.md'), 'utf8'), 'OLD UPSTREAM',
      'the downgrade happens');
    // The whole point: say WHICH keys the consumer is left carrying that this tag's
    // migrations never introduced. "Downgraded, good luck" is not a warning.
    assert.match(out, /governance\.reviewActors/,
      'it must name the config keys that are ahead of the target tag schema');
    assert.match(out, /0\.9\.0/, 'and that the config schema stays at the newer version');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('upgrade: a non-semver tag is not mistaken for a downgrade (REQ-D-3)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-d3-'));
  try {
    const consumer = downgradeConsumer(tmp, { pkgVersion: '0.9.0' });
    // `parseSemver` yields [0,0,0] for anything unparseable, which would compare as
    // older than everything — a refusal for a tag that is not a downgrade at all.
    const r = spawnSync(process.execPath, [CLI, 'latest', '--no-install'], { cwd: consumer, encoding: 'utf8' });
    assert.equal(r.status, 0, `an unparseable tag must not be read as a downgrade: ${r.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('upgrade: an ordinary upgrade is untouched by the guard (REQ-D-4)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-d4-'));
  try {
    const consumer = downgradeConsumer(tmp, { pkgVersion: '1.2.0', schemaVersion: '0.9.0' });
    const r = spawnSync(process.execPath, [CLI, 'v1.2.0', '--no-install'], { cwd: consumer, encoding: 'utf8' });
    assert.equal(r.status, 0, `a normal upgrade must be unaffected: ${r.stderr}`);
    assert.equal(readFileSync(join(consumer, 'brain', 'core', 'a.md'), 'utf8'), 'OLD UPSTREAM');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REQ-D-5: the population the gate actually exists for ─────────────────────
// `brain.config.json`'s schemaVersion has TWO writers with DIFFERENT meanings:
// `ensureBrainConfig` (env:init) writes the newest MIGRATION version, `migrateConfig`
// (brain:upgrade) writes the installed PACKAGE version. Migrations top out below the
// package, so a freshly-adopted consumer sits at the migration number while running
// newer code — and a guard that trusted that field alone left every tag above the
// newest migration unguarded. On the real repo that was the six most recent of sixteen.
test('upgrade: a fresh adopter whose config lags the installed package is still guarded (REQ-D-5)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-d5-'));
  try {
    // env:init wrote the newest migration version (0.9.0) …
    // … while the package they actually installed is 1.0.0.
    const consumer = downgradeConsumer(tmp, { pkgVersion: '1.0.0', schemaVersion: '0.9.0' });

    const r = spawnSync(process.execPath, [CLI, 'v0.9.1', '--no-install'], { cwd: consumer, encoding: 'utf8' });
    const out = r.stdout + r.stderr;

    assert.notEqual(r.status, 0,
      'v0.9.1 is below the installed 1.0.0 — trusting schemaVersion (0.9.0) alone would have let it through');
    assert.match(out, /1\.0\.0/, 'the floor must be what is really installed, not only what the config recorded');
    assert.equal(readFileSync(join(consumer, 'brain', 'core', 'a.md'), 'utf8'), 'CONSUMER',
      'and nothing may be written');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('upgrade: --no-install with no tag is guarded too (REQ-D-6)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-d6-'));
  try {
    // No tag: the installed package IS what gets applied, so the config is the floor.
    const consumer = downgradeConsumer(tmp, { pkgVersion: '0.9.1', schemaVersion: '1.0.0' });

    const r = spawnSync(process.execPath, [CLI, '--no-install'], { cwd: consumer, encoding: 'utf8' });
    assert.notEqual(r.status, 0,
      'applying an older installed package with no tag is still a downgrade — the guard must not depend on a tag being passed');
    assert.equal(readFileSync(join(consumer, 'brain', 'core', 'a.md'), 'utf8'), 'CONSUMER');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
