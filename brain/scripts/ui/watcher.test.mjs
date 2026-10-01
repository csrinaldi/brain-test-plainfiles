import { test } from 'node:test';
import assert from 'node:assert/strict';

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';

import { testTmp } from '../lib/test-tmp.mjs';
import { createWatcher, resolveGitCommonDir } from './watcher.mjs';

// ── fixtures ─────────────────────────────────────────────────────────────

function makeWatcherFixture() {
  const root = testTmp('watcher-');
  const mk = (p) => mkdirSync(join(root, p), { recursive: true });
  mk('brain/project/decisions');
  mk('brain/core/anti-patterns');
  mk('brain/project/anti-patterns');
  mk('.memory/records');
  mk('openspec/changes/issue-1-a');
  mk('openspec/changes/archive'); // NOT an `issue-<N>-*` dir — must be excluded
  return root;
}

function makeGitCommonFixture() {
  const gitCommonDir = testTmp('git-common-');
  const mk = (p) => mkdirSync(join(gitCommonDir, p), { recursive: true });
  mk('logs');
  mk('worktrees');
  return gitCommonDir;
}

/** Like `makeGitCommonFixture()`, but WITHOUT `worktrees/` — a fresh repo that has never had a linked worktree (round 9, R881-9). */
function makeGitCommonFixtureNoWorktrees() {
  const gitCommonDir = testTmp('git-common-');
  mkdirSync(join(gitCommonDir, 'logs'), { recursive: true });
  return gitCommonDir;
}

/**
 * Writes a REAL `<gitCommonDir>/worktrees/<id>/gitdir` file — the
 * id-resolution source `activeWorktrees()` reads instead of anything under
 * `path` (cold review of PR #971 round 8, R881-3). Content is exactly what
 * git itself writes: `<path>/.git`, one line.
 */
function writeWorktreeGitFile(gitCommonDir, path, id) {
  mkdirSync(join(gitCommonDir, 'worktrees', id, 'logs'), { recursive: true });
  writeFileSync(join(gitCommonDir, 'worktrees', id, 'gitdir'), `${join(path, '.git')}\n`);
}

// ── test doubles ─────────────────────────────────────────────────────────

/** A `fs.watch`-shaped spy: records every registration, fires listeners on demand, counts `.close()` calls. */
function spyWatch() {
  const calls = [];
  const closesByPath = new Map();
  const fn = (path, _opts, listener) => {
    calls.push({ path, listener });
    return { close: () => closesByPath.set(path, (closesByPath.get(path) ?? 0) + 1) };
  };
  fn.calls = calls;
  fn.closesByPath = closesByPath;
  fn.fire = (path) => { const c = calls.find((entry) => entry.path === path); if (c) c.listener('change', null); };
  return fn;
}

/**
 * A `fs.watch`-shaped spy whose handles are REAL `EventEmitter`s, so a test
 * can fire an async `'error'` on a specific registered handle the way a live
 * `FSWatcher` does — late `ENOSPC`/`EPERM`/watched-path-removed, well after
 * registration succeeded. Shaped like `spyWatch()` above (`.calls`, `.fire`)
 * plus each call's `.handle` for direct emission.
 */
function spyWatchEmitter() {
  const calls = [];
  const fn = (path, _opts, listener) => {
    const handle = new EventEmitter();
    handle.close = () => { handle.closed = true; };
    calls.push({ path, listener, handle });
    return handle;
  };
  fn.calls = calls;
  fn.fire = (path) => { const c = calls.find((entry) => entry.path === path); if (c) c.listener('change', null); };
  return fn;
}

/**
 * A `fs.watch`-shaped spy that throws `ENOENT` the FIRST time it is asked to
 * register `throwOncePath`, then behaves like `spyWatch()` for every other
 * call — including later calls for `throwOncePath` itself. `.attempts`
 * counts every registration ATTEMPT for a path (successful or not), unlike
 * `.calls`, which only records attempts that returned a handle.
 */
function spyWatchThrowOnceFor(throwOncePath) {
  const calls = [];
  const attempts = new Map();
  const closesByPath = new Map();
  let thrown = false;
  const fn = (path, _opts, listener) => {
    attempts.set(path, (attempts.get(path) ?? 0) + 1);
    if (path === throwOncePath && !thrown) {
      thrown = true;
      const e = new Error('ENOENT: no such file or directory');
      e.code = 'ENOENT';
      throw e;
    }
    calls.push({ path, listener });
    return { close: () => closesByPath.set(path, (closesByPath.get(path) ?? 0) + 1) };
  };
  fn.calls = calls;
  fn.attempts = attempts;
  fn.closesByPath = closesByPath;
  fn.fire = (path) => { const c = calls.find((entry) => entry.path === path); if (c) c.listener('change', null); };
  return fn;
}

/**
 * A `fs.watch`-shaped spy that mirrors REAL directory existence: throws
 * `ENOENT` for a path not yet on disk, succeeds once it exists — round 9's
 * "worktrees/ does not exist until the first worktree" needs a real ENOENT,
 * unlike `spyWatch()`'s always-succeeds registration.
 */
function spyWatchRealFs() {
  const calls = [];
  const fn = (path, _opts, listener) => {
    if (!existsSync(path)) { const e = new Error('ENOENT: no such file or directory'); e.code = 'ENOENT'; throw e; }
    calls.push({ path, listener });
    return { close() {} };
  };
  fn.calls = calls;
  fn.fire = (path) => { const c = calls.find((entry) => entry.path === path); if (c) c.listener('change', null); };
  return fn;
}

/**
 * A `readdirSync`-shaped spy: delegates to the real `readdirSync` for every
 * path, EXCEPT it throws the given error for `flakyPath` while armed via
 * `.throwNext()`. `.stopThrowing()` disarms it, so a test can simulate a
 * transient failure that later recovers on its own — no permanent stub.
 */
function readdirThrowsFor(flakyPath, err) {
  let armed = false;
  const fn = (path, ...rest) => {
    if (path === flakyPath && armed) throw err;
    return readdirSync(path, ...rest);
  };
  fn.throwNext = () => { armed = true; };
  fn.stopThrowing = () => { armed = false; };
  return fn;
}

/** A controllable `setTimeout`/`clearTimeout` pair: `runLatest()` fires only the most recently scheduled callback — the trailing-debounce shape. */
function fakeScheduler() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn) => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => timers.size,
    runLatest: () => {
      const id = [...timers.keys()].at(-1);
      const fn = timers.get(id);
      timers.delete(id);
      fn();
    },
  };
}

// ── R881-3 S1 / R881-10 S1: the watched set is exactly Q3's table ──────────

test('#881: the watcher registers watches only for the Q3 set — an edit anywhere else can never fire an event', () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const _run = () => `worktree ${root}\n`; // only the primary checkout — no linked worktrees this run
  const _watch = spyWatch();
  const w = createWatcher({ root, gitCommonDir, _watch, _run });
  w.start();
  const watched = _watch.calls.map((c) => c.path).sort();
  const expected = [
    root,
    join(root, 'brain'),
    join(root, 'brain/project/decisions'),
    join(root, 'brain/core/anti-patterns'),
    join(root, 'brain/project/anti-patterns'),
    join(root, '.memory/records'),
    join(root, 'openspec/changes'),
    join(root, 'openspec/changes/issue-1-a'),
    gitCommonDir,
    join(gitCommonDir, 'logs'),
    join(gitCommonDir, 'worktrees'),
  ].sort();
  assert.deepEqual(watched, expected);
  assert.equal(w.state().watched, expected.length);
  w.close();
});

// ── R881-3 S2 / A2: a commit in a linked worktree is seen ──────────────────

test('#881: a commit in a linked worktree fires exactly one debounced recompute naming that worktree', async () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const alphaPath = join(dirname(root), 'alpha');
  writeWorktreeGitFile(gitCommonDir, alphaPath, 'alpha');
  const _run = () => `worktree ${root}\n\nworktree ${alphaPath}\n`;
  const _watch = spyWatch();
  const scheduler = fakeScheduler();
  const recomputes = [];
  const w = createWatcher({
    root, gitCommonDir, _watch, _run,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
    onRecompute: async (evt) => { recomputes.push(evt); },
  });
  w.start();
  const alphaLogs = join(gitCommonDir, 'worktrees', 'alpha', 'logs');
  _watch.fire(alphaLogs);
  assert.equal(scheduler.pending(), 1);
  scheduler.runLatest();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(recomputes.length, 1);
  assert.deepEqual(recomputes[0].causes, ['watch:<git-common>/worktrees/alpha/logs/']);
  assert.deepEqual(recomputes[0].refWorktrees, [{ path: alphaPath, id: 'alpha' }]);
  w.close();
});

// ── cold review round 9, R881-9: a fresh repo that has never had a linked
// worktree has no `<git-common>/worktrees/` dir yet — that is "zero
// worktrees so far", not a failure, and the FIRST worktree ever created must
// still be watched once `<git-common>/` itself notices it appear ─────────

test('#881: a repo with no worktrees/ dir yet reports ok, and the first worktree ever created is watched once <git-common>/ fires', async () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixtureNoWorktrees();
  let stanzas = `worktree ${root}\n`;
  const _run = () => stanzas;
  const _watch = spyWatchRealFs();
  const scheduler = fakeScheduler();
  const recomputes = [];
  const w = createWatcher({
    root, gitCommonDir, _watch, _run,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
    onRecompute: async (evt) => { recomputes.push(evt); },
  });
  w.start();

  assert.equal(w.state().ok, true, 'a worktrees/ dir that does not exist yet is not a failure');
  assert.ok(!w.state().failed.some((f) => f.path.includes('worktrees')), 'no failed entry names worktrees');

  const alphaPath = join(dirname(root), 'alpha');
  writeWorktreeGitFile(gitCommonDir, alphaPath, 'alpha'); // creates worktrees/alpha/logs/ and .../gitdir for real
  stanzas = `worktree ${root}\n\nworktree ${alphaPath}\n`;
  _watch.fire(gitCommonDir); // the <git-common>/ event itself — the only watch alive that can notice worktrees/ appear

  const worktreesRoot = join(gitCommonDir, 'worktrees');
  const alphaLogs = join(worktreesRoot, 'alpha', 'logs');
  assert.ok(_watch.calls.some((c) => c.path === worktreesRoot), 'the worktrees/ root is now watched');
  assert.ok(_watch.calls.some((c) => c.path === alphaLogs), 'the first worktree ever created is watched too');

  // drain the debounce the <git-common>/ event itself scheduled, isolating the assertion below to alpha's own event
  scheduler.runLatest();
  await Promise.resolve();
  await Promise.resolve();
  recomputes.length = 0;

  _watch.fire(alphaLogs);
  assert.equal(scheduler.pending(), 1, 'an event on the first worktree ever created really fires the debounce');
  scheduler.runLatest();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(recomputes.length, 1, 'the first worktree ever created is no longer permanently unwatched');
  w.close();
});

// ── worktree add/remove triggers a re-scan ──────────────────────────────────

test('#881: a <git-common>/worktrees/ event re-scans and opens/closes watchers to match', () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const alphaPath = join(dirname(root), 'alpha');
  const betaPath = join(dirname(root), 'beta');
  writeWorktreeGitFile(gitCommonDir, alphaPath, 'alpha');
  writeWorktreeGitFile(gitCommonDir, betaPath, 'beta');
  let stanzas = `worktree ${root}\n\nworktree ${alphaPath}\n`;
  const _run = () => stanzas;
  const _watch = spyWatch();
  const w = createWatcher({ root, gitCommonDir, _watch, _run });
  w.start();
  const alphaLogs = join(gitCommonDir, 'worktrees', 'alpha', 'logs');
  const betaLogs = join(gitCommonDir, 'worktrees', 'beta', 'logs');
  assert.ok(_watch.calls.some((c) => c.path === alphaLogs));
  assert.ok(!_watch.calls.some((c) => c.path === betaLogs));

  stanzas = `worktree ${root}\n\nworktree ${alphaPath}\n\nworktree ${betaPath}\n`;
  _watch.fire(join(gitCommonDir, 'worktrees'));
  assert.ok(_watch.calls.some((c) => c.path === betaLogs), 'the newly added worktree gets watched on re-scan');

  stanzas = `worktree ${root}\n\nworktree ${betaPath}\n`;
  _watch.fire(join(gitCommonDir, 'worktrees'));
  assert.equal(_watch.closesByPath.get(alphaLogs), 1, 'the vanished worktree watcher is closed on re-scan');
  w.close();
});

// ── cold review of PR #971 round 6, R881-3: two worktrees whose paths share
// a leaf directory name get DISTINCT ids from git — `basename(path)` would
// collide and silently drop the second one from `watchedWorktrees` forever ──

test('#881: two worktrees whose paths share a leaf name ("foo") are both watched under their own admin-dir ids', async () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const parent = dirname(root);
  const fooPath = join(parent, 'a', 'foo');
  const foo1Path = join(parent, 'b', 'foo'); // same LEAF name "foo", different worktree
  writeWorktreeGitFile(gitCommonDir, fooPath, 'foo');
  writeWorktreeGitFile(gitCommonDir, foo1Path, 'foo1'); // git's own admin dir, never "foo" again
  const _run = () => `worktree ${root}\n\nworktree ${fooPath}\n\nworktree ${foo1Path}\n`;
  const _watch = spyWatch();
  const scheduler = fakeScheduler();
  const recomputes = [];
  const w = createWatcher({
    root, gitCommonDir, _watch, _run,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
    onRecompute: async (evt) => { recomputes.push(evt); },
  });
  w.start();

  const fooLogs = join(gitCommonDir, 'worktrees', 'foo', 'logs');
  const foo1Logs = join(gitCommonDir, 'worktrees', 'foo1', 'logs');
  assert.ok(_watch.calls.some((c) => c.path === fooLogs), 'the first "foo" worktree is watched');
  assert.ok(
    _watch.calls.some((c) => c.path === foo1Logs),
    'the second "foo" worktree (admin id foo1) is ALSO watched — not skipped as a duplicate of the first',
  );

  _watch.fire(foo1Logs);
  assert.equal(scheduler.pending(), 1, "an event on the second worktree really schedules a debounce — its handle is live, not a bookkeeping ghost");
  scheduler.runLatest();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(recomputes.length, 1, 'a commit in the second "foo" worktree is seen, not silently invisible behind the first');
  w.close();
});

// ── cold review of PR #971 rev 1 (judgment:cold-1), R881-3: a worktree whose
// watch failed is retried on the next rescan, never marked watched forever ──

test("#881: a worktree whose watch failed is retried on the next rescan, never left permanently unwatched", async () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const alphaPath = join(dirname(root), 'alpha');
  const betaPath = join(dirname(root), 'beta');
  writeWorktreeGitFile(gitCommonDir, alphaPath, 'alpha');
  writeWorktreeGitFile(gitCommonDir, betaPath, 'beta');
  const alphaLogs = join(gitCommonDir, 'worktrees', 'alpha', 'logs');
  const betaLogs = join(gitCommonDir, 'worktrees', 'beta', 'logs');
  let stanzas = `worktree ${root}\n\nworktree ${alphaPath}\n`;
  const _run = () => stanzas;
  const _watch = spyWatchThrowOnceFor(alphaLogs);
  const scheduler = fakeScheduler();
  const recomputes = [];
  const w = createWatcher({
    root, gitCommonDir, _watch, _run,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
    onRecompute: async (evt) => { recomputes.push(evt); },
  });
  w.start();

  assert.equal(_watch.attempts.get(alphaLogs), 1, 'the first rescan attempted alpha/logs exactly once');
  assert.ok(
    w.state().failed.some((f) => f.path === '<git-common>/worktrees/alpha/logs/'),
    'the failed watch is recorded in state()',
  );

  // a second worktree appears -> a `<git-common>/worktrees/` event re-scans
  stanzas = `worktree ${root}\n\nworktree ${alphaPath}\n\nworktree ${betaPath}\n`;
  _watch.fire(join(gitCommonDir, 'worktrees'));

  assert.equal(
    _watch.attempts.get(alphaLogs), 2,
    'the rescan retried alpha/logs — a worktree that never got watched must not be skipped forever',
  );
  assert.ok(
    !w.state().failed.some((f) => f.path === '<git-common>/worktrees/alpha/logs/'),
    'the failure entry is cleared once the retry succeeds — state() stops lying about alpha',
  );
  assert.ok(_watch.calls.some((c) => c.path === betaLogs), 'the newly added worktree is watched too');

  // the retried handle is really open, not a bookkeeping-only success
  _watch.fire(alphaLogs);
  assert.equal(scheduler.pending(), 1, 'the retried alpha handle really fires the debounce');
  scheduler.runLatest();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(recomputes.length, 1, 'a commit in alpha is no longer silently invisible for the rest of the process');

  w.close();
});

// ── cold review of PR #971 round 8, R881-3: the id comes ONLY from
// `<git-common>/worktrees/<id>/gitdir` — a malformed or unreadable one is a
// said failure for that one admin entry, never a crash, and never takes
// down the rest of the scan ─────────────────────────────────────────────────

test('#881: a worktree whose gitdir file is malformed is a said failure — the OTHER worktree stays watched and still fires', async () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const alphaPath = join(dirname(root), 'alpha');
  const betaPath = join(dirname(root), 'beta');
  mkdirSync(join(gitCommonDir, 'worktrees', 'alpha', 'logs'), { recursive: true });
  writeFileSync(join(gitCommonDir, 'worktrees', 'alpha', 'gitdir'), '   \n'); // malformed — no trailing "/.git"
  writeWorktreeGitFile(gitCommonDir, betaPath, 'beta');
  const _run = () => `worktree ${root}\n\nworktree ${alphaPath}\n\nworktree ${betaPath}\n`;
  const _watch = spyWatch();
  const scheduler = fakeScheduler();
  const recomputes = [];
  const w = createWatcher({
    root, gitCommonDir, _watch, _run,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
    onRecompute: async (evt) => { recomputes.push(evt); },
  });
  w.start();

  assert.ok(
    w.state().failed.some((f) => f.path === '<git-common>/worktrees/alpha/gitdir' && /malformed/.test(f.reason)),
    'the malformed gitdir file is recorded as a said failure naming that admin entry',
  );
  assert.equal(w.state().ok, false);

  const betaLogs = join(gitCommonDir, 'worktrees', 'beta', 'logs');
  assert.ok(_watch.calls.some((c) => c.path === betaLogs), 'the OTHER worktree is still watched');
  _watch.fire(betaLogs);
  scheduler.runLatest();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(recomputes.length, 1, 'the other worktree still fires — one malformed gitdir does not take down the scan');
  w.close();
});

test('#881: a porcelain worktree path with no matching worktrees/*/gitdir admin entry is a said failure, not silently dropped', () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const ghostPath = join(dirname(root), 'ghost'); // reported by `git worktree list`, but no admin dir maps back to it
  const _run = () => `worktree ${root}\n\nworktree ${ghostPath}\n`;
  const _watch = spyWatch();
  const w = createWatcher({ root, gitCommonDir, _watch, _run });
  w.start();

  assert.ok(
    w.state().failed.some((f) => f.path === '<git-common>/worktrees' && f.reason.includes(ghostPath)),
    'the unmatched porcelain path is recorded as a said failure naming the path',
  );
  assert.equal(w.state().ok, false);
  w.close();
});

// ── cold review of PR #971 rev 5 (judgment:cold-7), R881-3, design.md:228:
// a change dir created AFTER start() is watched from then on — the CHANGES_ROOT
// event re-syncs its children exactly like the worktrees root re-syncs worktrees ──

test('#881: a change dir created after start() is watched — the CHANGES_ROOT event re-syncs its children like the worktrees root', async () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const _run = () => `worktree ${root}\n`;
  const _watch = spyWatch();
  const scheduler = fakeScheduler();
  const recomputes = [];
  const w = createWatcher({
    root, gitCommonDir, _watch, _run,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
    onRecompute: async (evt) => { recomputes.push(evt); },
  });
  w.start();

  const newDir = join(root, 'openspec/changes/issue-999-test');
  mkdirSync(newDir, { recursive: true });
  _watch.fire(join(root, 'openspec/changes')); // the CHANGES_ROOT event
  assert.ok(_watch.calls.some((c) => c.path === newDir), 'the new change dir is watched after the CHANGES_ROOT re-sync');

  // drain the debounce+recompute the root event itself scheduled, so the
  // assertion below isolates the NEW dir's own event
  scheduler.runLatest();
  await Promise.resolve();
  await Promise.resolve();
  recomputes.length = 0;

  writeFileSync(join(newDir, 'tasks.md'), '- [ ] one\n');
  _watch.fire(newDir);
  assert.equal(scheduler.pending(), 1, 'the new dir is really watched — an edit inside it schedules a debounce');
  scheduler.runLatest();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(recomputes.length, 1, 'the edit inside the new change dir fires a second recompute — previously zero, ever');
  w.close();
});

test('#881: a removed change dir has its watch closed on the next CHANGES_ROOT event', () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const _run = () => `worktree ${root}\n`;
  const _watch = spyWatch();
  const w = createWatcher({ root, gitCommonDir, _watch, _run });
  w.start();

  const dirPath = join(root, 'openspec/changes/issue-1-a');
  assert.ok(_watch.calls.some((c) => c.path === dirPath));
  const before = w.state().watched;

  rmSync(dirPath, { recursive: true, force: true });
  _watch.fire(join(root, 'openspec/changes'));

  assert.equal(_watch.closesByPath.get(dirPath), 1, 'the vanished change dir watcher is closed on re-sync');
  assert.equal(w.state().watched, before - 1, 'the handle count goes back down');
  w.close();
});

// ── pre-push cold review of PR #971, R881-9: an unreadable changes root is a
// said failure that keeps the current watches, never an empty list that
// closes them (mirrors activeWorktrees()/rescanWorktrees() above) ─────────

test('#881: a CHANGES_ROOT rescan that cannot read the dir keeps every currently-watched change dir open, then recovers', () => {
  const root = testTmp('watcher-');
  mkdirSync(join(root, 'openspec/changes/issue-1-a'), { recursive: true });
  mkdirSync(join(root, 'openspec/changes/issue-2-b'), { recursive: true });
  const gitCommonDir = makeGitCommonFixture();
  const _run = () => `worktree ${root}\n`;
  const _watch = spyWatch();
  const changesRoot = join(root, 'openspec/changes');
  const emfile = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
  const _readdir = readdirThrowsFor(changesRoot, emfile);
  const w = createWatcher({ root, gitCommonDir, _watch, _run, _readdir });
  w.start();

  const dirA = join(changesRoot, 'issue-1-a');
  const dirB = join(changesRoot, 'issue-2-b');
  assert.ok(_watch.calls.some((c) => c.path === dirA));
  assert.ok(_watch.calls.some((c) => c.path === dirB));
  const watchedBefore = w.state().watched;

  _readdir.throwNext();
  _watch.fire(changesRoot); // the CHANGES_ROOT event — readdir throws EMFILE this time

  assert.equal(_watch.closesByPath.get(dirA), undefined, 'issue-1-a stays open — an unreadable root must not close it');
  assert.equal(_watch.closesByPath.get(dirB), undefined, 'issue-2-b stays open — an unreadable root must not close it');
  assert.equal(w.state().watched, watchedBefore, 'the handle count is unchanged — no reconciliation ran on a failed read');
  assert.equal(w.state().ok, false);
  assert.ok(
    w.state().failed.some((f) => f.path === 'openspec/changes' && /EMFILE/.test(f.reason)),
    'the unreadable root is recorded as a said failure',
  );

  _readdir.stopThrowing();
  _watch.fire(changesRoot); // a later root event, the root is readable again

  assert.ok(
    !w.state().failed.some((f) => f.path === 'openspec/changes'),
    'the failure entry clears once the root is readable again',
  );
  assert.equal(w.state().ok, true);
  w.close();
});

// ── pre-push cold review of PR #971 round 6 (judgment:cold-8), R881-9: an
// unreadable worktree list is a said failure that keeps the current watches,
// never an empty list that closes them — the sibling of the listChangeDirs
// EMFILE fix above, for activeWorktrees()/rescanWorktrees() ────────────────

test('#881: a <git-common>/worktrees/ rescan that cannot list worktrees keeps every currently-watched worktree open, then recovers', () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const alphaPath = join(dirname(root), 'alpha');
  const betaPath = join(dirname(root), 'beta');
  writeWorktreeGitFile(gitCommonDir, alphaPath, 'alpha');
  writeWorktreeGitFile(gitCommonDir, betaPath, 'beta');
  const stanzas = `worktree ${root}\n\nworktree ${alphaPath}\n\nworktree ${betaPath}\n`;
  const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  let armed = false;
  const _run = () => { if (armed) throw enospc; return stanzas; };
  const _watch = spyWatch();
  const w = createWatcher({ root, gitCommonDir, _watch, _run });
  w.start();

  const alphaLogs = join(gitCommonDir, 'worktrees', 'alpha', 'logs');
  const betaLogs = join(gitCommonDir, 'worktrees', 'beta', 'logs');
  assert.ok(_watch.calls.some((c) => c.path === alphaLogs));
  assert.ok(_watch.calls.some((c) => c.path === betaLogs));
  const watchedBefore = w.state().watched;

  armed = true;
  _watch.fire(join(gitCommonDir, 'worktrees')); // the worktrees root event — `git worktree list` fails this time

  assert.equal(_watch.closesByPath.get(alphaLogs), undefined, 'alpha stays open — an unreadable worktree list must not close it');
  assert.equal(_watch.closesByPath.get(betaLogs), undefined, 'beta stays open — an unreadable worktree list must not close it');
  assert.equal(w.state().watched, watchedBefore, 'the handle count is unchanged — no reconciliation ran on a failed read');
  assert.equal(w.state().ok, false);
  assert.ok(
    w.state().failed.some((f) => f.path === '<git-common>/worktrees' && /ENOSPC/.test(f.reason)),
    'the unreadable worktree list is recorded as a said failure',
  );

  armed = false;
  _watch.fire(join(gitCommonDir, 'worktrees')); // a later root event, `git worktree list` succeeds again

  assert.ok(
    !w.state().failed.some((f) => f.path === '<git-common>/worktrees'),
    'the failure entry clears once the worktree list is readable again',
  );
  assert.equal(w.state().ok, true);
  w.close();
});

// ── D5: a rebase-sized burst collapses to at most two recomputes ───────────

test('#881: a rebase-sized burst of HEAD moves collapses to at most two recomputes, never forty', async () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const _run = () => `worktree ${root}\n`;
  const _watch = spyWatch();
  const scheduler = fakeScheduler();
  let resolveFirst;
  const firstGate = new Promise((resolve) => { resolveFirst = resolve; });
  let recomputeCount = 0;
  const w = createWatcher({
    root, gitCommonDir, _watch, _run,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
    onRecompute: async () => {
      recomputeCount += 1;
      if (recomputeCount === 1) await firstGate;
    },
  });
  w.start();
  const logsPath = join(gitCommonDir, 'logs');

  _watch.fire(logsPath);
  scheduler.runLatest(); // debounce fires -> dispatch() starts, recomputing = true, awaiting firstGate

  for (let i = 0; i < 40; i++) _watch.fire(logsPath); // the rest of the rebase's HEAD moves
  scheduler.runLatest(); // the trailing debounce from the burst fires while still recomputing -> queues ONE follow-up

  resolveFirst();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(recomputeCount, 2, 'the in-flight recompute plus exactly one queued follow-up — never forty');
  w.close();
});

// ── Q3 "when the watcher fails" ─────────────────────────────────────────────

test('#881: a caught fs.watch failure leaves the server running and shapes {ok:false, reason, watched, failed}', () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const _run = () => `worktree ${root}\n`;
  const failingPath = join(root, 'brain/project/anti-patterns');
  const _watch = (path) => {
    if (path === failingPath) { const e = new Error('ENOSPC: no space left'); e.code = 'ENOSPC'; throw e; }
    return { close() {} };
  };
  const w = createWatcher({ root, gitCommonDir, _watch, _run });
  w.start();
  const state = w.state();
  assert.equal(state.ok, false);
  assert.match(state.reason, /1 watch\(es\) failed/);
  assert.deepEqual(state.failed, [{ path: 'brain/project/anti-patterns/', reason: 'ENOSPC: no space left' }]);
  assert.ok(state.watched > 0, 'every OTHER directory is still watched — one failure does not stop the rest');
  w.close();
});

// ── R881-9 / Q3 "when the watcher fails": a live handle's ASYNC error ──────

test("#881: a live watcher handle's async 'error' is a said state, not a crash — the OTHER handles stay open and a healthy one still fires", async () => {
  const root = makeWatcherFixture();
  const gitCommonDir = makeGitCommonFixture();
  const _run = () => `worktree ${root}\n`;
  const _watch = spyWatchEmitter();
  const scheduler = fakeScheduler();
  const recomputes = [];
  const w = createWatcher({
    root, gitCommonDir, _watch, _run,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
    onRecompute: async (evt) => { recomputes.push(evt); },
  });
  w.start();

  const failingPath = join(root, 'brain/project/anti-patterns');
  const failingEntry = _watch.calls.find((c) => c.path === failingPath);
  assert.ok(failingEntry, 'the fixture registers a watch for this directory');

  // A live handle emitting 'error' with no listener would throw synchronously
  // out of this very call (Node's EventEmitter special-cases 'error') and
  // crash the test/process — so simply reaching the assertions below proves
  // the process did not crash.
  failingEntry.handle.emit('error', new Error('ENOSPC: no space left'));

  const state = w.state();
  assert.equal(state.ok, false);
  assert.deepEqual(
    state.failed.find((f) => f.path === 'brain/project/anti-patterns/'),
    { path: 'brain/project/anti-patterns/', reason: 'ENOSPC: no space left' },
    'the failure is recorded in the same {path, reason} shape as a synchronous registration failure',
  );

  const otherEntries = _watch.calls.filter((c) => c.path !== failingPath);
  assert.ok(otherEntries.length > 0);
  assert.ok(otherEntries.every((c) => !c.handle.closed), 'every OTHER handle stays open — one handle\'s async error does not touch the rest');

  // a later event on a healthy handle still triggers the debounced callback
  const healthyPath = join(root, 'brain');
  _watch.fire(healthyPath);
  assert.equal(scheduler.pending(), 1);
  scheduler.runLatest();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(recomputes.length, 1, 'a healthy handle keeps firing after a sibling handle failed asynchronously');

  w.close();
});

// ── gitCommonDir resolution failure degrades gracefully ─────────────────────

test('#881: an unresolvable git-common-dir degrades to tree-only watching, never throws', () => {
  const root = makeWatcherFixture();
  const _run = () => { throw new Error('fatal: not a git repository'); };
  const _watch = spyWatch();
  const w = createWatcher({ root, _watch, _run }); // no gitCommonDir injected
  assert.doesNotThrow(() => w.start());
  const state = w.state();
  assert.equal(state.ok, false);
  assert.ok(state.failed.some((f) => f.path === '<git-common>'));
  assert.ok(!_watch.calls.some((c) => String(c.path).includes('worktrees')), 'no git-tracking watch is attempted once git-common-dir cannot be resolved');
  w.close();
});

// ── resolveGitCommonDir ──────────────────────────────────────────────────

test('#881: resolveGitCommonDir resolves a relative "git rev-parse --git-common-dir" answer against root', () => {
  assert.equal(resolveGitCommonDir({ root: '/repo', _run: () => '.git\n' }), '/repo/.git');
});

test('#881: resolveGitCommonDir keeps an already-absolute answer as-is', () => {
  assert.equal(resolveGitCommonDir({ root: '/repo', _run: () => '/elsewhere/.git\n' }), '/elsewhere/.git');
});
