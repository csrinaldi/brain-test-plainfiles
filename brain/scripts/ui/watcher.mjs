// watcher.mjs — directory watchers over the committed tier only (Q3, D4,
// #881 PR 2). Every watch is a DIRECTORY, never a file: git replaces
// `HEAD`/`packed-refs` via a `.lock`-then-rename, which orphans a file-bound
// `fs.watch`; a directory watch survives the rename (R881-10).
//
// The reflog (`logs/HEAD`) is APPENDED on every HEAD movement and is one
// flat path per worktree — the load-bearing watch target, not `HEAD` itself.
// Every fire is funnelled through one 250 ms trailing debounce (D5),
// serialised so a `git rebase` burst produces at most two recomputes.
//
// `<git-common>/worktrees/` re-scans on its own event via `git worktree list
// --porcelain`, parsed by `collect.mjs`'s exported `parseWorktrees()` — one
// grammar, one reader, no diverging copy (PR 3 follow-up). A worktree's
// `<n>` id is NEVER `basename(path)` (two
// worktrees can share a leaf) — it comes from `<git-common>/worktrees/<n>/gitdir`,
// never a path under the worktree itself (round 8, R881-3).
//
// `openspec/changes/` re-syncs its children the same way (`rescanChangeDirs()`,
// judgment:cold-7); `watchDir()`/`closeWatch()` share one generic
// `trackingId`/`trackingMap` pair between the two resync paths.
//
// A watch that cannot be registered is caught PER DIRECTORY — the watcher
// never throws, `state()` reports which paths failed and why.

import { watch as fsWatch, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

import { ANTI_PATTERN_DIRS } from '../status/anti-patterns.mjs';
import { CHANGES_ROOT, parseChangeId } from '../lib/sdd-layout.mjs';
import { parseWorktrees } from '../memory/lane/collect.mjs';

const DEBOUNCE_MS = 250;

function defaultRun(root) {
  return (file, args) => execFileSync(file, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** `git rev-parse --git-common-dir`, resolved to an absolute path. */
export function resolveGitCommonDir({ root, _run } = {}) {
  const run = _run ?? defaultRun(root);
  const out = run('git', ['rev-parse', '--git-common-dir']).trim();
  return isAbsolute(out) ? out : join(root, out);
}

/**
 * createWatcher() — directory watchers, debounce, worktree re-scan.
 *
 * @param {{
 *   root: string,
 *   gitCommonDir?: string|null,
 *   _watch?: Function, _run?: Function, _readdir?: Function, _readFile?: Function, _now?: () => Date,
 *   debounceMs?: number, _setTimeout?: Function, _clearTimeout?: Function,
 *   onRecompute?: (evt: {causes: string[], refWorktrees: string[], at: Date}) => Promise<void>|void,
 * }} opts
 * @returns {{start(): void, close(): void, state(): {ok: boolean, reason?: string, watched: number, failed: Array<{path:string,reason:string}>}}}
 */
export function createWatcher({
  root,
  gitCommonDir = null,
  _watch = fsWatch,
  _run,
  _readdir = readdirSync,
  _readFile = readFileSync,
  _now = () => new Date(),
  debounceMs = DEBOUNCE_MS,
  _setTimeout = setTimeout,
  _clearTimeout = clearTimeout,
  onRecompute = () => {},
} = {}) {
  const run = _run ?? defaultRun(root);
  const handles = new Map(); // absPath -> {handle, label, kind, worktreePath}
  const watchedWorktrees = new Map(); // id -> path
  const watchedChangeDirs = new Map(); // name -> absPath
  let failed = [];
  let resolvedGitCommonDir = gitCommonDir;
  let debounceTimer = null;
  let pendingCauses = new Set();
  let pendingRefWorktrees = new Map(); // path -> admin id (null for the primary checkout)
  let recomputing = false;
  let queuedAfterRecompute = false;

  function recordFailure(label, err) {
    failed = failed.filter((f) => f.path !== label);
    failed.push({ path: label, reason: err?.message ?? String(err) });
  }

  function watchDir(absPath, label, kind, worktreePath, trackingId, trackingMap, { ignoreEnoent = false } = {}) {
    if (handles.has(absPath)) return;
    try {
      const handle = _watch(absPath, { persistent: false }, () => onFire(absPath));
      // A LIVE `FSWatcher` can fail asynchronously, well after registration
      // succeeded — a late `ENOSPC`, `EPERM`, or the watched path itself
      // disappearing. `fs.watch`'s `EventEmitter` throws synchronously out of
      // `.emit()` if 'error' has no listener, which would crash this whole
      // process (R881-9: a watcher failure is a said state, never a crash).
      // Guarded by `typeof handle.on === 'function'` so test doubles that
      // return a plain `{close()}` (no EventEmitter) keep working unchanged.
      if (typeof handle.on === 'function') {
        handle.on('error', (err) => {
          recordFailure(label, err);
          closeWatch(absPath); // a failed handle cannot fire again
        });
      }
      handles.set(absPath, { handle, label, kind, worktreePath, trackingId, trackingMap });
      failed = failed.filter((f) => f.path !== label);
    } catch (err) {
      if (ignoreEnoent && err?.code === 'ENOENT') return; // not created yet — retried on the next <git-common>/ event, round 9
      recordFailure(label, err);
    }
  }

  function closeWatch(absPath) {
    const entry = handles.get(absPath);
    if (!entry) return;
    try { entry.handle.close(); } catch { /* best effort */ }
    handles.delete(absPath);
    // A tracked child (a worktree's logs/, a change dir) handle carries its
    // `trackingId` + `trackingMap`. Closing it — either because the child
    // vanished (a rescan's removal loop) or because its handle errored
    // asynchronously (the `handle.on('error', ...)` path above) — must make
    // the child eligible for `watchDir()` again on the NEXT rescan. The
    // tracking map only ever records a child whose watch is actually open
    // right now (see rescanWorktrees()/rescanChangeDirs()), so it must be
    // cleared here too, not just on removal (R881-3, judgment:cold-1, cold-7).
    if (entry.trackingId !== undefined) entry.trackingMap.delete(entry.trackingId);
  }

  function onFire(absPath) {
    const entry = handles.get(absPath);
    if (!entry) return;
    pendingCauses.add(`watch:${entry.label}`);
    if (absPath === resolvedGitCommonDir) maybeOpenWorktreesRoot();
    if (entry.kind === 'refs') pendingRefWorktrees.set(entry.worktreePath ?? root, entry.trackingId ?? null);
    if (entry.kind === 'worktrees') rescanWorktrees();
    if (entry.kind === 'changes') rescanChangeDirs();
    scheduleDebounce();
  }

  function scheduleDebounce() {
    if (debounceTimer) _clearTimeout(debounceTimer);
    debounceTimer = _setTimeout(fireDebounce, debounceMs);
  }

  function fireDebounce() {
    debounceTimer = null;
    if (recomputing) { queuedAfterRecompute = true; return; }
    dispatch();
  }

  async function dispatch() {
    const causes = [...pendingCauses];
    const refWorktrees = [...pendingRefWorktrees].map(([path, id]) => ({ path, id }));
    pendingCauses = new Set();
    pendingRefWorktrees = new Map();
    recomputing = true;
    try {
      await onRecompute({ causes, refWorktrees, at: _now() });
    } finally {
      recomputing = false;
      if (queuedAfterRecompute) {
        queuedAfterRecompute = false;
        dispatch();
      }
    }
  }

  /**
   * `null` on failure — NEVER `[]` — so a caller can tell "the root could not
   * be read right now" apart from "the root really has zero change dirs".
   * Collapsing those two into the same empty value is exactly the shape
   * `brain/core/anti-patterns/evidence-reader-empty-on-failure.md` names, and
   * is what let a transient `EMFILE`/`EACCES` close every watched change dir
   * as "vanished" (cold review of PR #971 pre-push, R881-9). Mirrors
   * `activeWorktrees()` above: catch here, record the failure here, return a
   * sentinel the caller cannot mistake for real data.
   */
  function listChangeDirs() {
    try {
      return _readdir(join(root, CHANGES_ROOT)).filter((n) => parseChangeId(n) !== null);
    } catch (err) {
      recordFailure(CHANGES_ROOT, err);
      return null;
    }
  }

  /**
   * A `<root>/openspec/changes/` event re-syncs its children exactly like a
   * `<git-common>/worktrees/` event re-syncs worktrees (rescanWorktrees()
   * below): open a watch for every change dir now present and not yet
   * watched, close the watches of dirs that vanished. Same retry-on-next-
   * event rule as judgment:cold-1 — a dir whose `watchDir()` call failed
   * stays eligible and is retried on the NEXT `CHANGES_ROOT` event, never
   * marked watched after one failed attempt (R881-3, cold-7).
   *
   * When the root itself cannot be read (`listChangeDirs()` returns `null`),
   * the failure is already recorded and reconciliation is SKIPPED entirely —
   * every currently-watched change dir stays open. Treating an unreadable
   * root as "zero change dirs" would close all of them on one transient
   * error, with no root event left to ever re-open them (R881-9, pre-push
   * cold review of PR #971).
   */
  function rescanChangeDirs() {
    const names = listChangeDirs();
    if (names === null) return;
    failed = failed.filter((f) => f.path !== CHANGES_ROOT); // the root is readable again — drop a stale failure entry
    const current = new Set(names);
    for (const [name] of watchedChangeDirs) {
      if (!current.has(name)) {
        closeWatch(join(root, CHANGES_ROOT, name));
        watchedChangeDirs.delete(name);
      }
    }
    for (const name of current) {
      if (!watchedChangeDirs.has(name)) {
        const absPath = join(root, CHANGES_ROOT, name);
        watchDir(absPath, `${CHANGES_ROOT}/${name}/`, 'tree', undefined, name, watchedChangeDirs);
        if (handles.has(absPath)) watchedChangeDirs.set(name, absPath);
      }
    }
  }

  /**
   * `null` on failure — NEVER `[]` — same sentinel as `listChangeDirs()`
   * above, for the same reason: a `git worktree list` failure must read as
   * "could not be read right now", not "zero linked worktrees" (R881-9,
   * pre-push cold review of PR #971 round 6).
   *
   * The id is NEVER `basename(path)` (round 6, R881-3): distinct admin dirs
   * (`worktrees/foo`, `worktrees/foo1`) can share a path leaf. The path->id
   * map comes from listing `<git-common>/worktrees/` and reading each
   * entry's `gitdir` file (`<path>/.git`) — never anything under the
   * worktree's own path, since `<git-common>/` is git's own metadata and a
   * worktree's path is a working tree (round 8). A missing, unreadable, or
   * malformed `gitdir`, or an unmatched porcelain path, is a said failure
   * (`recordFailure()`), not a silent drop.
   */
  function activeWorktrees() {
    let stdout;
    try { stdout = run('git', ['worktree', 'list', '--porcelain']); } catch (err) { recordFailure('<git-common>/worktrees', err); return null; }
    const stanzas = parseWorktrees(stdout).slice(1).filter((s) => !s.bare);
    const adminDir = join(resolvedGitCommonDir, 'worktrees');
    let ids;
    try { ids = _readdir(adminDir); } catch (err) {
      if (err?.code === 'ENOENT') return []; // no worktrees/ yet — genuinely zero, not a read failure (round 9)
      recordFailure('<git-common>/worktrees', err); return null;
    }
    const idByPath = new Map();
    for (const id of ids) {
      const label = `<git-common>/worktrees/${id}/gitdir`;
      try {
        const raw = _readFile(join(adminDir, id, 'gitdir'), 'utf8').trim();
        if (!raw.endsWith('/.git')) throw new Error(`malformed gitdir at ${label}`);
        idByPath.set(resolve(raw.slice(0, -5)), id); failed = failed.filter((f) => f.path !== label);
      } catch (err) { recordFailure(label, err); }
    }
    failed = failed.filter((f) => f.path !== '<git-common>/worktrees');
    const current = [];
    for (const s of stanzas) {
      const id = idByPath.get(resolve(s.path));
      if (id !== undefined) { current.push({ path: s.path, id }); continue; }
      recordFailure('<git-common>/worktrees', new Error(`no gitdir admin entry matches ${s.path}`));
    }
    return current;
  }

  /** The only watch that can notice `worktrees/` appear after a start() that found none — swallowed ENOENT is retried here (round 9, R881-9). */
  function maybeOpenWorktreesRoot() {
    const absPath = join(resolvedGitCommonDir, 'worktrees');
    if (handles.has(absPath)) return;
    watchDir(absPath, '<git-common>/worktrees/', 'worktrees', undefined, undefined, undefined, { ignoreEnoent: true });
    if (handles.has(absPath)) rescanWorktrees();
  }

  function rescanWorktrees() {
    if (!resolvedGitCommonDir) return;
    const current = activeWorktrees();
    if (current === null) return; // the failure is already recorded — skip reconciliation, leave every current watch untouched
    // `activeWorktrees()` owns the `<git-common>/worktrees` label now — clearing it here too would erase a mismatch it just recorded.
    const currentIds = new Set(current.map((w) => w.id));
    for (const [id] of watchedWorktrees) {
      if (!currentIds.has(id)) {
        closeWatch(join(resolvedGitCommonDir, 'worktrees', id, 'logs'));
        watchedWorktrees.delete(id);
      }
    }
    // Retry is driven by rescan events only (a `<git-common>/worktrees/` dir
    // event), never by a timer of its own — this is what the cold review of
    // PR #971 rev 1 (judgment:cold-1) measured. `watchedWorktrees.has(w.id)`
    // is true ONLY when a handle for that worktree is actually open right
    // now (see below and closeWatch()), so a worktree whose watchDir() call
    // failed — or whose live handle later errored — stays eligible and gets
    // retried the next time this function runs, instead of being marked
    // watched forever after one failed attempt (R881-3: a commit in a linked
    // worktree must be seen, not silently invisible for the rest of the
    // process).
    for (const w of current) {
      if (!watchedWorktrees.has(w.id)) {
        const absPath = join(resolvedGitCommonDir, 'worktrees', w.id, 'logs');
        watchDir(absPath, `<git-common>/worktrees/${w.id}/logs/`, 'refs', w.path, w.id, watchedWorktrees);
        if (handles.has(absPath)) watchedWorktrees.set(w.id, w.path);
      }
    }
  }

  function start() {
    watchDir(root, '<root>', 'tree');
    watchDir(join(root, 'brain'), 'brain/', 'tree');
    watchDir(join(root, 'brain/project/decisions'), 'brain/project/decisions/', 'tree');
    for (const { dir } of ANTI_PATTERN_DIRS) watchDir(join(root, dir), `${dir}/`, 'tree');
    watchDir(join(root, '.memory/records'), '.memory/records/', 'tree');
    watchDir(join(root, CHANGES_ROOT), `${CHANGES_ROOT}/`, 'changes');
    rescanChangeDirs();

    if (resolvedGitCommonDir === null) {
      try { resolvedGitCommonDir = resolveGitCommonDir({ root, _run: run }); } catch (err) { recordFailure('<git-common>', err); }
    }
    if (resolvedGitCommonDir) {
      watchDir(resolvedGitCommonDir, '<git-common>/', 'refs', root);
      watchDir(join(resolvedGitCommonDir, 'logs'), '<git-common>/logs/', 'refs', root);
      watchDir(join(resolvedGitCommonDir, 'worktrees'), '<git-common>/worktrees/', 'worktrees', undefined, undefined, undefined, { ignoreEnoent: true });
      rescanWorktrees();
    }
  }

  function close() {
    if (debounceTimer) { _clearTimeout(debounceTimer); debounceTimer = null; }
    for (const absPath of [...handles.keys()]) closeWatch(absPath);
    watchedWorktrees.clear();
  }

  function state() {
    return failed.length === 0
      ? { ok: true, watched: handles.size, failed: [] }
      : { ok: false, reason: `${failed.length} watch(es) failed`, watched: handles.size, failed: failed.map((f) => ({ ...f })) };
  }

  return { start, close, state };
}
