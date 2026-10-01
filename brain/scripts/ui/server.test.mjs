import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { buildSnapshot } from '../status/snapshot.mjs';
import { makeSnapshotFixture as makeFixture } from '../__fixtures__/snapshot-tree.mjs';
import { testTmp } from '../lib/test-tmp.mjs';
import { createForgeCache } from './forge-cache.mjs';
import { createUiServer, parseArgs, main, KNOWN_ROUTES, resolveForgeSource } from './server.mjs';
import { buildChangeView } from './change-route.mjs';
import { fakeGit } from './test-support/fake-git.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const NOW = '2026-09-14T00:00:00Z';
const now = () => new Date(NOW);

/** A `fs.watch`-shaped spy: records every registration, fires listeners on demand. */
function spyWatch() {
  const calls = [];
  const fn = (path, _opts, listener) => {
    calls.push({ path, listener });
    return { close() {} };
  };
  fn.calls = calls;
  fn.fire = (path) => { const c = calls.find((entry) => entry.path === path); if (c) c.listener('change', null); };
  return fn;
}

/** A controllable `setTimeout`/`clearTimeout` pair with exactly one pending timer at a time. */
function fakeScheduler() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn) => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => timers.size,
    runLatest: () => { const id = [...timers.keys()].at(-1); const fn = timers.get(id); timers.delete(id); return fn(); },
    runNext: () => { const id = [...timers.keys()][0]; const fn = timers.get(id); timers.delete(id); return fn(); },
  };
}

/** Every write verb throws — proves a composed port never gets written to. */
function readOnlyWriteVerbs(reads) {
  const port = {};
  for (const w of ['mrCreate', 'mrAutoMerge', 'issueCreate', 'issueUpdate', 'prReviewComment', 'issueComment', 'labelAdd', 'labelRemove', 'branchProtect']) {
    port[w] = async () => { throw new Error(`write verb ${w} called`); };
  }
  return Object.assign(port, reads);
}

/** Same as `readOnlyWriteVerbs`, plus every write verb's name is pushed to `calls` before it throws — so a test can assert a call COUNT, not just "it would have thrown". */
function countedWriteVerbs(calls, reads) {
  const port = {};
  for (const w of ['mrCreate', 'mrAutoMerge', 'issueCreate', 'issueUpdate', 'prReviewComment', 'issueComment', 'labelAdd', 'labelRemove', 'branchProtect']) {
    port[w] = async () => { calls.push(w); throw new Error(`write verb ${w} called`); };
  }
  return Object.assign(port, reads);
}

/** `{path}:{dir-or-size}:{mtimeMs}` for every entry under `root`, sorted — the same walker `snapshot.test.mjs`'s `snapshotTree()` uses, so a before/after diff catches ANY write, not just the ones a specific assertion names. */
function snapshotTree(root) {
  const out = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); const s = statSync(p); out.push(`${p}:${s.isDirectory() ? 'd' : s.size}:${s.mtimeMs}`); if (s.isDirectory()) walk(p); } };
  walk(root);
  return out.sort();
}

/** Reads one `event: ...\ndata: ...\n\n` frame at a time off an SSE response body. */
function frameReader(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const readFrame = async () => {
    while (!buf.includes('\n\n')) buf += dec.decode((await reader.read()).value, { stream: true });
    const frame = buf.slice(0, buf.indexOf('\n\n'));
    buf = buf.slice(buf.indexOf('\n\n') + 2);
    return frame;
  };
  readFrame.reader = reader;
  return readFrame;
}

async function waitUntil(predicate, { timeoutMs = 1000, stepMs = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** A minimal fake `process` double — an `EventEmitter` with a no-op `exit()`
 * — so every `main()` call in this file that does not itself assert on
 * signal handling attaches its SIGINT/SIGTERM listeners here, never on the
 * real process (judgment:cold-5). Named distinctly from the SIGINT/SIGTERM
 * test's own local `fakeProcess`, which asserts on `exit()` directly. */
function makeFakeProcess() {
  const p = new EventEmitter();
  p.exit = () => {};
  return p;
}

/**
 * #881, judgment:cold-6: `main()` now defaults to a REAL `resolveForgeSource()`
 * whenever `deps.forgeSource` is omitted and polling is requested — every
 * test below that calls `main()` without exercising that resolution
 * explicitly MUST inject this, or `node --test` would spawn real dynamic
 * imports against `vcs/cli.mjs` (and, once the poller ticks, a real `gh`
 * subprocess) on every run. Mirrors the old, safe default: no forge port.
 */
function noRealForgeResolution() {
  return async () => ({ ok: false, reason: 'test stub: forge resolution not exercised by this test' });
}

// ── R881-1 S1/S2: default port, static root, ephemeral port ────────────────

test('#881: R881-1 S1 — no --port defaults to port 3000 (parity checked via parseArgs; binding 3000 in a test run would flake CI)', () => {
  assert.equal(parseArgs([]).port, 3000);
});

test('#881: createUiServer defaults to port 3000 before listen() is called', () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  assert.equal(server.port, 3000);
});

test('#881: R881-1 S1 — GET / returns the SPA static placeholder', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  await server.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html');
    const body = await res.text();
    assert.match(body, /brain:ui/, 'the placeholder names the verb it belongs to, proving it is the real static file, not an empty 200');
  } finally {
    await server.close();
  }
});

test('#881: R881-1 S2 — --port 0 listens on an OS-assigned port and reports it', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  await server.listen(0);
  try {
    assert.notEqual(server.port, 0);
    assert.ok(Number.isInteger(server.port) && server.port > 0, `expected a real OS-assigned port, got ${server.port}`);
  } finally {
    await server.close();
  }
});

test('#881: an unmatched path answers 404', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  await server.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/does-not-exist`);
    assert.equal(res.status, 404);
  } finally {
    await server.close();
  }
});

// ── R881-1 S3 / A4: snapshot shape parity ───────────────────────────────────

test('#881: A4 — GET /api/snapshot deep-equals in-process buildSnapshot on the same fixture root, port and clock', async () => {
  const root = makeFixture();
  const cache = createForgeCache();
  cache.setIssueList([{ number: 5, title: 'five' }]);
  cache.setMrList([]);
  const server = createUiServer({ root, vcs: cache.port, project: 'o/r', _now: now });
  await server.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/snapshot`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const fromServer = await res.json();
    const fromModule = await buildSnapshot({ root, now: now(), vcs: cache.port, project: 'o/r' });
    assert.deepEqual(fromServer, JSON.parse(JSON.stringify(fromModule)));
    assert.equal(fromServer.graph.ok, true, 'the seeded cache answered issueList — proof the route composed buildSnapshot with the injected port, not a stub');
    assert.deepEqual(fromServer.graph.value.issuesUnreadable, [{ number: 5, reason: "this issue's body has not been fetched yet (queued)" }], 'issueView was never seeded, so the per-issue read misses in band — and the cache holds lists, so the miss is a queued body, not an un-started poll');
  } finally {
    await server.close();
  }
});

// ── A5: read-only-port proof, composed through forge-cache.mjs ─────────────

test('#881: A5 — every route this PR ships completes with a forge-cache-composed port, no write verb reachable', async () => {
  const root = makeFixture();
  const cache = createForgeCache();
  cache.setIssueList([]);
  cache.setMrList([]);
  assert.deepEqual(Object.keys(cache.port).sort(), ['issueList', 'issueView', 'mrList', 'prReviews'], 'the composed port has no write verb to call, by construction');
  const server = createUiServer({ root, vcs: cache.port, project: 'o/r', _now: now });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    const snap = await fetch(`${base}/api/snapshot`);
    assert.equal(snap.status, 200);
    const body = await snap.json();
    assert.equal(body.graph.ok, true);
    assert.equal(body.prs.ok, true);
  } finally {
    await server.close();
  }
});

// ── R881-5 S1: mutation methods are rejected on every route this PR ships ──

test('#881: R881-5 S1 — POST/PUT/PATCH/DELETE against / and /api/snapshot all return 405 with Allow: GET, HEAD', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const path of ['/', '/api/snapshot']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}${path}`, { method });
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.get('allow'), 'GET, HEAD', `${method} ${path}`);
      }
    }
  } finally {
    await server.close();
  }
});

test('#881: R881-5 S1 — the method check runs before routing, so an unmatched path still answers 405, not 404, on a mutation method', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  await server.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/does-not-exist`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  } finally {
    await server.close();
  }
});

// ── D15: parseArgs, EADDRINUSE ──────────────────────────────────────────────

test('#881: parseArgs — --port and --root, defaults, unknown flags refused', () => {
  assert.deepEqual(parseArgs([]), { ok: true, port: 3000, root: process.cwd(), interval: 60000, poll: true });
  assert.deepEqual(parseArgs(['--port', '4500']), { ok: true, port: 4500, root: process.cwd(), interval: 60000, poll: true });
  assert.deepEqual(parseArgs(['--root', '/tmp/some-dir']), { ok: true, port: 3000, root: '/tmp/some-dir', interval: 60000, poll: true });
  assert.equal(parseArgs(['--bogus']).ok, false);
  assert.equal(parseArgs(['--port', 'nope']).ok, false);
  assert.equal(parseArgs(['--port', '-1']).ok, false);
});

// ── T5: --interval, --no-poll ───────────────────────────────────────────────

test('#881: parseArgs — --interval overrides the 60s default; --no-poll disables the timer entirely', () => {
  assert.deepEqual(parseArgs(['--interval', '5000']), { ok: true, port: 3000, root: process.cwd(), interval: 5000, poll: true });
  assert.deepEqual(parseArgs(['--no-poll']), { ok: true, port: 3000, root: process.cwd(), interval: 60000, poll: false });
  assert.equal(parseArgs(['--interval', 'nope']).ok, false);
  assert.equal(parseArgs(['--interval', '-1']).ok, false);
});

test('#881: --no-poll composes with R881-4 S2 — the poller starts paused, so the timer never fires and the page stays on manual "poll now"', async () => {
  const root = makeFixture();
  const messages = [];
  const result = await main(['--port', '0', '--root', root, '--no-poll'], { say: (m) => messages.push(m), error: () => {}, process: makeFakeProcess() });
  try {
    const base = `http://127.0.0.1:${result.port}`;
    const res = await fetch(`${base}/api/poll/pause`, { method: 'POST' }); // idempotent state check
    assert.equal((await res.json()).paused, true);
  } finally {
    await result.close();
  }
});

test('#881: main exits 2 on an unknown argument', async () => {
  const errors = [];
  const code = await main(['--bogus'], { say: () => {}, error: (m) => errors.push(m), process: makeFakeProcess() });
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /unknown argument: --bogus/);
});

test('#881: EADDRINUSE prints "port <n> is already in use" and exits 2 (D15 — same class as a bad argument)', async () => {
  const blocker = createUiServer({ root: makeFixture() });
  await blocker.listen(0);
  try {
    const port = blocker.port;
    const errors = [];
    const code = await main(['--port', String(port), '--root', makeFixture()], { say: () => {}, error: (m) => errors.push(m), process: makeFakeProcess(), _resolveForgeSource: noRealForgeResolution() });
    assert.equal(code, 2);
    assert.match(errors.join('\n'), new RegExp(`port ${port} is already in use`));
  } finally {
    await blocker.close();
  }
});

// ── judgment:cold-2: a throwing startup recompute must reject listen(), not hang ─
//
// `listen()`'s `onListening` callback runs `await recomputeCurrent()` with no
// try/catch and no `.catch()`. If `buildSnapshot()` ever threw there, the
// exception would become an unhandled rejection and the outer `new Promise`
// in `listen()` would never resolve or reject — the caller hangs forever.
// Every other call site IS protected (`handleRequest`'s `.catch`,
// `recomputeAndBroadcast`'s try/catch). The `_recomputeCurrent` seam lets a
// test force that throw without reaching into `buildSnapshot` itself; it
// defaults to the real recompute (`buildSnapshot({ root, now: _now(), vcs:
// forgeVcs, project })`) for every other test in this file.
//
// A short `timeout` turns a regression back into a HANG (this test itself
// would time out and fail, not the process locking up silently) instead of a
// clean assertion failure — RED for this test must be a failure either way.

test('#881: judgment:cold-2 — a throwing startup recompute rejects listen() and releases the port instead of hanging', { timeout: 3000 }, async () => {
  const root = makeFixture();
  const boom = new Error('boom: startup recompute failed');
  const server = createUiServer({ root, _now: now, _recomputeCurrent: async () => { throw boom; } });

  await assert.rejects(server.listen(0), /boom: startup recompute failed/);
  const failedPort = server.port;
  assert.ok(Number.isInteger(failedPort) && failedPort > 0, 'the port was assigned before the recompute failed');

  // The port must be released, not held by a half-started server: a second,
  // independent server can bind the EXACT same port number right after.
  const second = createUiServer({ root, _now: now });
  await second.listen(failedPort);
  try {
    assert.equal(second.port, failedPort);
  } finally {
    await second.close();
  }
});

test('#881: judgment:cold-2 — main() exits 2 with the message when listen() rejects for a reason other than EADDRINUSE (D15\'s own "same exit-code class" convention)', async () => {
  const root = makeFixture();
  const errors = [];
  const code = await main(['--port', '0', '--root', root], {
    say: () => {}, error: (m) => errors.push(m), process: makeFakeProcess(),
    _recomputeCurrent: async () => { throw new Error('boom: startup recompute failed'); },
    _resolveForgeSource: noRealForgeResolution(),
  });
  assert.equal(code, 2);
  assert.match(errors.join('\n'), /boom: startup recompute failed/);
});

test('#881: main succeeds on a free (ephemeral) port and reports where it listens', async () => {
  const messages = [];
  const result = await main(['--port', '0', '--root', makeFixture()], { say: (m) => messages.push(m), error: () => {}, process: makeFakeProcess(), _resolveForgeSource: noRealForgeResolution() });
  assert.notEqual(typeof result, 'number', 'success returns the started server, not an exit code');
  assert.match(messages.join('\n'), /brain:ui listening on http:\/\/127\.0\.0\.1:\d+/);
  await result.close();
});

test('#881: D15 — SIGINT/SIGTERM stop the poll timer, close every watcher, end every open SSE response, close the listener, and exit 0', async () => {
  const fakeProcess = new EventEmitter();
  const exits = [];
  fakeProcess.exit = (code) => exits.push(code);
  const root = makeFixture();
  const messages = [];
  const result = await main(['--port', '0', '--root', root], { say: (m) => messages.push(m), error: () => {}, process: fakeProcess, _resolveForgeSource: noRealForgeResolution() });
  assert.notEqual(typeof result, 'number');

  try {
    const res = await fetch(`http://127.0.0.1:${result.port}/api/stream`);
    const readFrame = frameReader(res);
    await readFrame(); // the SSE connection is live

    fakeProcess.emit('SIGINT');
    await waitUntil(() => exits.length > 0);
    assert.deepEqual(exits, [0]);
    const { done } = await readFrame.reader.read();
    assert.equal(done, true, 'the open SSE response was ended by the shutdown, not left hanging');

    // a second signal after shutdown is a no-op, not a second exit
    fakeProcess.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(exits, [0]);
  } finally {
    // shutdown already closed it on the happy path; a second close() is a
    // harmless no-op and this is the only safety net if SIGINT never fires
    await result.close().catch(() => {});
  }
});

// ── R881-2 S1/Q4: GET /api/stream — sync frame first ────────────────────────

test('#881: R881-2 S1 — the first SSE frame is `sync`, carrying the whole current snapshot', async () => {
  const root = makeFixture();
  const cache = createForgeCache();
  cache.setIssueList([]);
  cache.setMrList([]);
  const server = createUiServer({ root, vcs: cache.port, project: 'o/r', _now: now, poll: false });
  await server.listen(0);
  const ac = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal: ac.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const readFrame = frameReader(res);
    const frame = await readFrame();
    assert.match(frame, /^event: sync\ndata: \{/);
    const payload = JSON.parse(frame.slice('event: sync\ndata: '.length));
    assert.equal(payload.snapshot.graph.ok, true);
    assert.equal(payload.meta.project, 'o/r');
    ac.abort();
  } finally {
    await server.close();
  }
});

// ── #998 R998-6 T3: buildMeta's servedBranch ────────────────────────────────

test('#998 R998-6 T3: buildMeta\'s servedBranch names the served checkout\'s HEAD via git symbolic-ref, sourced to HEAD, read once and memoized across a second broadcast', async () => {
  const root = makeFixture();
  const cache = createForgeCache();
  cache.setIssueList([]);
  cache.setMrList([]);
  const gitCalls = [];
  const _run = (file, args) => {
    gitCalls.push(args);
    if (args[0] === 'symbolic-ref') return 'feat/issue-998-pr6-door\n';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  const server = createUiServer({ root, vcs: cache.port, project: 'o/r', _now: now, poll: false, _run });
  await server.listen(0);
  const ac = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal: ac.signal });
    const readFrame = frameReader(res);
    const frame = await readFrame();
    const payload = JSON.parse(frame.slice('event: sync\ndata: '.length));
    assert.deepEqual(payload.meta.servedBranch, { ok: true, branch: 'feat/issue-998-pr6-door', source: { path: 'HEAD' } });

    // A manual poll forces a SECOND `buildMeta()` (the `status` frame
    // `recomputeAndBroadcast` sends once the tick settles, win or lose) —
    // `resolveServedBranch()` must not shell out to `git` a second time.
    await fetch(`http://127.0.0.1:${server.port}/api/poll/once`, { method: 'POST' });
    const statusFrame = await readFrame();
    assert.match(statusFrame, /^event: status\ndata: \{/);
    const statusPayload = JSON.parse(statusFrame.slice('event: status\ndata: '.length));
    assert.deepEqual(statusPayload.servedBranch, { ok: true, branch: 'feat/issue-998-pr6-door', source: { path: 'HEAD' } });
    ac.abort();
  } finally {
    await server.close();
  }
  assert.equal(gitCalls.filter((a) => a[0] === 'symbolic-ref').length, 1, 'resolveServedBranch memoizes — one git call across two buildMeta() calls');
});

test('#998 R998-6 T3: a detached or unreadable HEAD is a said reason on servedBranch, never a crash', async () => {
  const root = makeFixture();
  const cache = createForgeCache();
  cache.setIssueList([]);
  cache.setMrList([]);
  const _run = (file, args) => {
    if (args[0] === 'symbolic-ref') throw new Error('fatal: ref HEAD is not a symbolic ref');
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  const server = createUiServer({ root, vcs: cache.port, project: 'o/r', _now: now, poll: false, _run });
  await server.listen(0);
  const ac = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal: ac.signal });
    const readFrame = frameReader(res);
    const frame = await readFrame();
    const payload = JSON.parse(frame.slice('event: sync\ndata: '.length));
    assert.equal(payload.meta.servedBranch.ok, false);
    assert.match(payload.meta.servedBranch.reason, /not a symbolic ref/);
    assert.deepEqual(payload.meta.servedBranch.source, { path: 'HEAD' });
    ac.abort();
  } finally {
    await server.close();
  }
});

// ── R881-2 S2/A2: a committed-tier change reaches the client ────────────────

test('#881: R881-2 S2/A2 — a committed-tier change (via the watcher) yields a `section` frame within the debounce, no reconnect', async () => {
  const root = makeFixture();
  const cache = createForgeCache();
  cache.setIssueList([]);
  cache.setMrList([]);
  const scheduler = fakeScheduler();
  const _watch = spyWatch();
  const server = createUiServer({
    root, vcs: cache.port, project: 'o/r', _now: now, poll: false,
    _watch, _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
  });
  await server.listen(0);
  const ac = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal: ac.signal });
    const readFrame = frameReader(res);
    await readFrame(); // sync

    writeFileSync(join(root, 'openspec/changes/issue-1-a/tasks.md'), '- [x] done\n- [x] next one\n');
    _watch.fire(join(root, 'openspec/changes/issue-1-a'));
    scheduler.runLatest();

    const frame = await readFrame();
    assert.match(frame, /^event: section\ndata: \{"name":"changes"/);
    ac.abort();
  } finally {
    await server.close();
  }
});

// ── R881-2 S2 (refs): a ref-tracking watch yields a `refs` frame ───────────

test('#881: R881-2 S2 (refs) — a ref-tracking watch (<git-common>/logs) yields a `refs` frame naming {worktree, head}', async () => {
  const root = makeFixture();
  const cache = createForgeCache();
  cache.setIssueList([]);
  cache.setMrList([]);
  const scheduler = fakeScheduler();
  const _watch = spyWatch();
  const gitCommonDir = join(root, '.git'); // never touched on disk — `_watch` is a spy
  const gitCalls = [];
  const _run = (file, args) => {
    gitCalls.push(args);
    if (args[0] === 'worktree') return `worktree ${root}\n`;
    if (args.includes('rev-parse') && args.includes('--abbrev-ref')) return 'feat/example\n';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  const server = createUiServer({
    root, vcs: cache.port, project: 'o/r', _now: now, poll: false,
    gitCommonDir, _watch, _run, _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
  });
  await server.listen(0);
  const ac = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal: ac.signal });
    const readFrame = frameReader(res);
    await readFrame(); // sync

    _watch.fire(join(gitCommonDir, 'logs'));
    scheduler.runLatest();

    const frame = await readFrame();
    assert.match(frame, /^event: refs\ndata: \{/);
    const payload = JSON.parse(frame.slice('event: refs\ndata: '.length));
    assert.equal(payload.worktree, root);
    assert.equal(payload.head, 'feat/example');

    // R881-3, cold review round 9: the primary checkout's own branch is read
    // with a plain call (default cwd), never `-C` on the worktree path.
    const headCall = gitCalls.find((args) => args.includes('rev-parse') && args.includes('--abbrev-ref'));
    assert.deepEqual(headCall, ['rev-parse', '--abbrev-ref', 'HEAD']);
    ac.abort();
  } finally {
    await server.close();
  }
});

test('#881: R881-3 cold review round 9 — a linked worktree resolves its branch via --git-dir on its own admin dir, never -C on the worktree path', async () => {
  const root = makeFixture();
  const cache = createForgeCache();
  cache.setIssueList([]);
  cache.setMrList([]);
  const scheduler = fakeScheduler();
  const _watch = spyWatch();
  const gitCommonDir = testTmp('server-git-common-'); // REAL dir — activeWorktrees() reads its own worktrees/<id>/gitdir file
  const alphaPath = join(dirname(root), 'alpha');
  mkdirSync(join(gitCommonDir, 'worktrees', 'alpha', 'logs'), { recursive: true });
  writeFileSync(join(gitCommonDir, 'worktrees', 'alpha', 'gitdir'), `${join(alphaPath, '.git')}\n`);
  const gitCalls = [];
  const _run = (file, args) => {
    gitCalls.push(args);
    if (args[0] === 'worktree') return `worktree ${root}\n\nworktree ${alphaPath}\n`;
    if (args.includes('rev-parse') && args.includes('--abbrev-ref')) return 'feat/alpha\n';
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  const server = createUiServer({
    root, vcs: cache.port, project: 'o/r', _now: now, poll: false,
    gitCommonDir, _watch, _run, _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
  });
  await server.listen(0);
  const ac = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal: ac.signal });
    const readFrame = frameReader(res);
    await readFrame(); // sync

    _watch.fire(join(gitCommonDir, 'worktrees', 'alpha', 'logs'));
    scheduler.runLatest();

    const frame = await readFrame();
    assert.match(frame, /^event: refs\ndata: \{/);
    const payload = JSON.parse(frame.slice('event: refs\ndata: '.length));
    assert.equal(payload.worktree, alphaPath);
    assert.equal(payload.head, 'feat/alpha');

    const headCall = gitCalls.find((args) => args.includes('rev-parse') && args.includes('--abbrev-ref'));
    assert.deepEqual(headCall, ['--git-dir', join(gitCommonDir, 'worktrees', 'alpha'), 'rev-parse', '--abbrev-ref', 'HEAD']);
    assert.ok(!headCall.includes('-C'), 'never opens the worktree path itself');
    ac.abort();
  } finally {
    await server.close();
  }
});

// ── R881-2 S3: a forge change reaches the client ─────────────────────────────

test('#881: R881-2 S3 — a forge change (via the poller) yields a `section` frame on the next tick', async () => {
  const root = makeFixture();
  const scheduler = fakeScheduler();
  let issues = [{ number: 5, title: 'five', labels: [], assignees: [] }];
  const forgeSource = {
    issueList: async () => issues.map((i) => ({ ...i })),
    mrList: async () => [],
    issueView: async ({ number }) => ({ number, body: '' }),
    prReviews: async () => [],
  };
  const server = createUiServer({
    root, project: 'o/r', _now: now, forgeSource,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
  });
  await server.listen(0); // the cold-start tick runs immediately
  const ac = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal: ac.signal });
    const readFrame = frameReader(res);
    await readFrame(); // sync

    issues = [{ number: 5, title: 'five', labels: ['status:approved'], assignees: [] }]; // the label moves
    assert.equal(scheduler.pending(), 1);
    scheduler.runNext();

    const frame = await readFrame();
    assert.match(frame, /^event: section\ndata: \{"name":"graph"/);
    ac.abort();
  } finally {
    await server.close();
  }
});

// ── D15/Q4: server.close() ends every open SSE response ─────────────────────

test('#881: D15/Q4 — server.close() ends every open SSE response before closing the listener, no hang under node --test', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now, poll: false });
  await server.listen(0);
  const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`);
  const readFrame = frameReader(res);
  await readFrame(); // the connection is live
  await server.close();
  const { done } = await readFrame.reader.read();
  assert.equal(done, true, 'the SSE response was ended by close(), not left hanging');
});

// ── judgment:cold-3: a dead SSE client's write error never crashes the server ─
//
// `ServerResponse.write()` after the response has ended does NOT throw
// synchronously — it emits an ASYNC 'error' event
// (`ERR_STREAM_WRITE_AFTER_END`) and, with no `res.on('error')` handler,
// crashes the process. `sendEvent()`/`broadcast()` wrote to every client
// with no error handler at all; the only removal path was `req.on('close',
// ...)`, asynchronous and not guaranteed to have run before the next
// broadcast iterates `clients`. A fake, `EventEmitter`-shaped dead `res` —
// injected through the `_registerClient`/`_clients` test-only seam — makes
// this deterministic instead of racing a real socket teardown against a
// real broadcast.

test('#881: judgment:cold-3 — a dead SSE client\'s write error is handled per client, never crashes the process, and the client is dropped', { timeout: 3000 }, async () => {
  const root = makeFixture();
  const cache = createForgeCache();
  cache.setIssueList([]);
  cache.setMrList([]);
  const server = createUiServer({ root, vcs: cache.port, project: 'o/r', _now: now, poll: false });
  await server.listen(0);
  const ac = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal: ac.signal });
    const readFrame = frameReader(res);
    await readFrame(); // sync frame — the real client is live

    // A `res` whose underlying socket has already gone away: `write()`
    // does not throw synchronously, it schedules an async 'error' — exactly
    // Node's own documented behaviour for `ERR_STREAM_WRITE_AFTER_END`.
    const dead = new EventEmitter();
    dead.writableEnded = false;
    dead.destroyed = false;
    dead.write = () => { queueMicrotask(() => dead.emit('error', Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' }))); };
    dead.end = () => {};
    server._registerClient(dead);
    assert.equal(server._clients.size, 2, 'both the real and the fake dead client are registered');

    // Trigger a broadcast through the real recompute path every other SSE
    // test in this file already uses — the dead client's async write error
    // must not stop it, and must not crash the process.
    const pollRes = await fetch(`http://127.0.0.1:${server.port}/api/poll/once`, { method: 'POST' });
    assert.equal(pollRes.status, 200, 'the request completed normally — the dead client\'s write error did not crash the server');

    const frame = await readFrame();
    assert.match(frame, /^event: status\ndata: \{/, 'the surviving client still receives the next frame');

    await waitUntil(() => server._clients.size === 1);
    assert.ok(!server._clients.has(dead), 'the dead client was dropped after its write errored');
    ac.abort();
  } finally {
    await server.close();
  }
});

// ── sweep: a post-bind httpServer 'error' event never crashes the process ──
//
// Same defect class as judgment:cold-3, one level up: `listen()`'s own
// `once('error', onError)` is removed the moment 'listening' fires
// (`onListening` calls `httpServer.removeListener('error', onError)`), so
// after a successful `listen()` the live `httpServer` has NO 'error'
// listener at all. A post-bind failure (`EMFILE` on `accept()` is the
// documented case) fires an async 'error' on the server itself — with zero
// listeners, that throws out of `.emit()` and crashes an otherwise
// recoverable accept failure into a process death.

test('#881: sweep — a post-bind httpServer "error" event (e.g. EMFILE, fired after listen() already resolved) never crashes the process', { timeout: 3000 }, async () => {
  const server = createUiServer({ root: makeFixture(), _now: now, poll: false });
  await server.listen(0);
  try {
    setImmediate(() => server._httpServer.emit('error', new Error('EMFILE: too many open files')));
    await waitUntil(() => server._lastServerError !== null);
    assert.match(server._lastServerError.message, /EMFILE/);

    // the server is still alive and answering requests after the error
    const res = await fetch(`http://127.0.0.1:${server.port}/api/snapshot`);
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

// ── judgment:cold-5: main() removes its SIGINT/SIGTERM listeners on close ──
//
// `main()` attached `proc.on('SIGINT'/'SIGTERM', ...)` with no matching
// removal, tied to the real `process` whenever `deps.process` was not
// overridden. Every successful `main()` call in this file (five of them, no
// fake process) leaked two listeners on the real process; the listener
// itself also outlives a caller's own `server.close()` when no signal ever
// fires, which is the common case in this file's tests.

test('#881: judgment:cold-5 — main() removes its SIGINT/SIGTERM listeners once the server closes, whether closed by a signal or directly', async () => {
  const proc = makeFakeProcess();
  const root = makeFixture();
  const result = await main(['--port', '0', '--root', root], { say: () => {}, error: () => {}, process: proc, _resolveForgeSource: noRealForgeResolution() });
  assert.equal(proc.listenerCount('SIGINT'), 1);
  assert.equal(proc.listenerCount('SIGTERM'), 1);

  await result.close(); // closed directly, not via a signal — this is the leak main() had

  assert.equal(proc.listenerCount('SIGINT'), 0, 'the SIGINT listener came off when the server closed, even without a signal firing');
  assert.equal(proc.listenerCount('SIGTERM'), 0, 'the SIGTERM listener came off too');
});

// ── R881-5 S1 (re-run) / R881-5 S2: the now-complete route table ────────────

test('#881: R881-5 S1 (re-run) — mutation methods are rejected on every non-control route, including /api/stream', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now, poll: false });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const path of ['/', '/api/snapshot', '/api/stream']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}${path}`, { method });
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.get('allow'), 'GET, HEAD', `${method} ${path}`);
      }
    }
  } finally {
    await server.close();
  }
});

test('#881: R881-5 S2 — the three poll-control routes accept POST only, and POST mutates only in-process state', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now, poll: false });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const path of ['/api/poll/pause', '/api/poll/resume', '/api/poll/once']) {
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}${path}`, { method });
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.get('allow'), 'POST', `${method} ${path}`);
      }
    }
    const pauseRes = await fetch(`${base}/api/poll/pause`, { method: 'POST' });
    assert.equal(pauseRes.status, 200);
    assert.equal(pauseRes.headers.get('content-type'), 'application/json');
    assert.equal((await pauseRes.json()).paused, true);

    const resumeRes = await fetch(`${base}/api/poll/resume`, { method: 'POST' });
    assert.equal((await resumeRes.json()).paused, false);
  } finally {
    await server.close();
  }
});

// ── D7: "asserts after a POST /api/poll/pause that no file under the served
// root, no git ref and no forge stub call changed" ──────────────────────────

test('#881: D7 — POST /api/poll/pause, /resume and /once leave the served root, the refs and the forge untouched', async () => {
  const root = makeFixture();
  const writeCalls = [];
  const readCalls = [];
  const forgeSource = countedWriteVerbs(writeCalls, {
    issueList: async () => { readCalls.push('issueList'); return []; },
    mrList: async () => { readCalls.push('mrList'); return []; },
    issueView: async () => { readCalls.push('issueView'); return {}; },
    prReviews: async () => { readCalls.push('prReviews'); return []; },
  });
  const server = createUiServer({ root, project: 'o/r', _now: now, forgeSource, poll: false });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const before = snapshotTree(root);

    const pauseRes = await fetch(`${base}/api/poll/pause`, { method: 'POST' });
    assert.equal(pauseRes.status, 200);
    const resumeRes = await fetch(`${base}/api/poll/resume`, { method: 'POST' });
    assert.equal(resumeRes.status, 200);
    // `once` may legitimately read the forge (it triggers a real poll on
    // demand) — the assertion below is only about WRITE verbs, never about
    // whether a read happened.
    const onceRes = await fetch(`${base}/api/poll/once`, { method: 'POST' });
    assert.equal(onceRes.status, 200);

    const after = snapshotTree(root);
    assert.deepEqual(after, before, 'no file under the served root changed for pause, resume or once');
    assert.equal(writeCalls.length, 0, 'no write verb was ever invoked by any poll control');
    assert.ok(readCalls.includes('issueList'), 'once actually ran a poll against the composed port (proves this is not a vacuous pass)');

    // The fixture root `makeFixture()` builds (`__fixtures__/snapshot-tree.mjs`)
    // never runs `git init` — there is no `.git` to rev-parse here, so the
    // "no git ref changed" leg of D7's promise is skipped for that stated
    // reason. It is a no-op by construction: none of these three routes ever
    // calls `run('git', [...])` in the first place (`server.mjs`'s
    // `servePollControl` only calls the poller's own pause/resume/once).
  } finally {
    await server.close();
  }
});

test('#881: R881-5 S3 / A5 (re-run) — with the poller wired in, a full poll cycle plus every route completes with no write verb ever invoked', async () => {
  const root = makeFixture();
  const callLog = [];
  const forgeSource = readOnlyWriteVerbs({
    issueList: async () => { callLog.push('issueList'); return []; },
    mrList: async () => { callLog.push('mrList'); return []; },
    issueView: async () => { callLog.push('issueView'); return {}; },
    prReviews: async () => { callLog.push('prReviews'); return []; },
  });
  const server = createUiServer({ root, project: 'o/r', _now: now, forgeSource });
  await server.listen(0); // the cold-start tick runs against the write-throwing port
  try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/api/snapshot`)).status, 200);
    assert.equal((await fetch(`${base}/api/poll/once`, { method: 'POST' })).status, 200);
    assert.ok(callLog.includes('issueList'), 'the poller actually ran against the composed port');
  } finally {
    await server.close();
  }
});

// ── R881-10 S3: no MCP resource route, no heartbeat/agent-pulse endpoint ────

test('#881: R881-10 S3 — the route table has no MCP resource route and no heartbeat/agent-pulse endpoint', () => {
  assert.deepEqual(KNOWN_ROUTES, ['/', '/app.js', '/app.css', '/lib/{module}.mjs', '/vendor/marked.esm.js', '/api/snapshot', '/api/stream', '/api/poll/pause', '/api/poll/resume', '/api/poll/once', '/api/change/{issue}']);
  assert.ok(!KNOWN_ROUTES.some((r) => /mcp|heartbeat|pulse/i.test(r)));
});

// ── T7: GET /api/change/{issue} — the drawer's IO (D8, D11) ────────────────

test('#881: GET /api/change/<N> deep-equals buildChangeView() on the same held snapshot; GET /api/change/x is 404; mutation methods are 405', async () => {
  const root = makeFixture();
  mkdirSync(join(root, 'openspec/changes/issue-1-a'), { recursive: true });
  writeFileSync(join(root, 'openspec/changes/issue-1-a/spec.md'), '### R1-1: a\n#### Scenario: s\n- **WHEN** w\n- **THEN** t\n');
  writeFileSync(join(root, 'openspec/changes/issue-1-a/tasks.md'), '- [x] done\n- [ ] next one\n');
  const _run = fakeGit({
    files: {
      'openspec/changes/issue-1-a/spec.md': '### R1-1: a\n#### Scenario: s\n- **WHEN** w\n- **THEN** t\n',
      'openspec/changes/issue-1-a/tasks.md': '- [x] done\n- [ ] next one\n',
    },
    blame: 'abc1234abc1234abc1234abc1234abc1234abc1 1 1 1\nauthor csrinaldi\nauthor-time 1694700000\n\tdone\n',
  });
  const gitCalls = _run.calls;
  const server = createUiServer({ root, project: 'o/r', _now: now, poll: false, _run });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/api/change/1`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const fromRoute = await res.json();

    const snapshot = await (await fetch(`${base}/api/snapshot`)).json();
    const fromDirect = buildChangeView({ root, issue: 1, snapshot, project: 'o/r', _run });
    assert.deepEqual(fromRoute, JSON.parse(JSON.stringify(fromDirect)));
    assert.equal(fromRoute.ok, true);
    assert.equal(fromRoute.value.spec.ok, true);

    const notFound = await fetch(`${base}/api/change/x`);
    assert.equal(notFound.status, 404);

    const mutation = await fetch(`${base}/api/change/1`, { method: 'POST' });
    assert.equal(mutation.status, 405);
    assert.equal(mutation.headers.get('allow'), 'GET, HEAD');

    const blameCall = gitCalls.find((args) => args[0] === 'blame');
    assert.ok(blameCall.includes('HEAD'), 'the blame argv must carry HEAD — the committed version, never the working tree');
    assert.ok(!gitCalls.some((args) => args.includes('-C')), 'no git call in this route ever opens a worktree with -C (R881-3)');
  } finally {
    await server.close();
  }
});

// ── #1198: the vendored tokenizer is served from a literal allow-list entry ──

const VENDOR_FILE = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'marked.esm.js');

test('#1198 R1198-11: GET /vendor/marked.esm.js serves the pinned file as JavaScript', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  await server.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/vendor/marked.esm.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/javascript');
    const served = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
    const pinned = /sha256:([0-9a-f]{64}) marked\.esm\.js/.exec(readFileSync(join(dirname(VENDOR_FILE), 'VERSIONS'), 'utf8'))[1];
    assert.equal(served, pinned);
  } finally {
    await server.close();
  }
});

test('#1198 R1198-11: nothing else under /vendor/ is served, and traversal out of it is refused', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const path of ['/vendor/x.js', '/vendor/VERSIONS', '/vendor/LICENSE.marked', '/vendor/vendor.test.mjs', '/vendor/../server.mjs', '/vendor/%2e%2e/server.mjs', '/vendor/', '/vendor/sub/marked.esm.js']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, `${path} must not be served`);
      assert.doesNotMatch(await res.text(), /createUiServer/, `${path} must serve no file outside ui/vendor/`);
    }
  } finally {
    await server.close();
  }
});

// ── #1198 R1198-3/4: the default `run` forwards maxBuffer, proven against a real repository ──

test('#1198 R1198-3/4: through the real git seam a 2 MB committed design is truncated, not unreadable (the third `run` argument reaches execFileSync)', async () => {
  const root = testTmp('server-docs-');
  const dir = 'openspec/changes/issue-7-big';
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'design.md'), `# big\n${'x'.repeat(2 * 1024 * 1024)}\n`);
  writeFileSync(join(root, dir, 'proposal.md'), '# small\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed');
  const server = createUiServer({ root, project: 'o/r', _now: now, poll: false });
  await server.listen(0);
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.port}/api/change/7`)).json();
    assert.equal(body.value.documents.design.state, 'truncated');
    assert.equal(body.value.documents.design.truncatedAt, 262144);
    assert.equal(body.value.documents.proposal.state, 'present');
    assert.equal(body.value.documents.proposal.text, '# small\n');
    assert.equal(body.value.documents.verify.state, 'missing');
  } finally {
    await server.close();
  }
});

// ── package.json: brain:ui verb and engines (D8, D16) ───────────────────────

test('#881: package.json exposes "brain:ui" and "engines.node" >= 22', () => {
  const pkgPath = fileURLToPath(new URL('../../../package.json', import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  assert.equal(pkg.scripts['brain:ui'], 'node ./brain/scripts/ui/server.mjs');
  assert.equal(pkg.engines.node, '>=22');
});

// ── fresh review of round 3, suggestion 2: a post-bind server error reaches the operator ──
//
// The baseline `httpServer.on('error')` keeps the process alive, but a value
// only a test-only getter can read is a silent degradation for whoever runs
// `npm run brain:ui`. The CLI must print the reason and say it is still
// serving, the same in-band vocabulary every other section uses.

test('#881: a post-bind httpServer "error" is printed by the CLI, not only recorded for tests', { timeout: 3000 }, async () => {
  const errors = [];
  const result = await main(['--port', '0', '--root', makeFixture(), '--no-poll'], { say: () => {}, error: (m) => errors.push(m), process: makeFakeProcess() });
  try {
    setImmediate(() => result._httpServer.emit('error', new Error('EMFILE: too many open files')));
    await waitUntil(() => errors.some((m) => /EMFILE/.test(m)));
    assert.match(errors.join('\n'), /server error: EMFILE: too many open files/);
    assert.match(errors.join('\n'), /still serving/);
    const res = await fetch(`http://127.0.0.1:${result.port}/api/snapshot`);
    assert.equal(res.status, 200, 'still serving means still serving');
  } finally {
    await result.close();
  }
});

// ── judgment:cold-6 (cold review round 4 of PR #971): the real entry point ──
// never resolved a live forge port ──────────────────────────────────────────
//
// `server.mjs`'s guard resolved `project` via `originIdentity()` but never
// resolved a `forgeSource` — `main()` always ran with `deps.forgeSource`
// undefined, `createUiServer` composed the poller with `noForgeVcs`, and
// every one of its four verbs threw "no forge port was supplied to the
// poller". Every real `npm run brain:ui` invocation ticked forever against a
// throwing port: `prs`, `reviews` and issue bodies never left `{ok:false}`
// in production, ever. `resolveForgeSource()` (mirroring
// `snapshot-cli.mjs:54-69`) closes that gap; `main()` calls it whenever
// `deps.forgeSource` is omitted and polling was requested.

test('#881: resolveForgeSource — a throwing _getVcs degrades to {ok:false, reason}, never throws', async () => {
  const result = await resolveForgeSource({
    _originIdentity: () => ({ host: 'github.com', project: 'o/r' }),
    _getVcs: async () => { throw new Error('vcs: no provider configured. Set "vcs": { "provider": "github" } …'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no provider configured/);
});

test('#881: resolveForgeSource — a resolving _getVcs and a real origin yield {ok:true, vcs, project}', async () => {
  const stub = { issueList: async () => [] };
  const result = await resolveForgeSource({
    _originIdentity: () => ({ host: 'github.com', project: 'o/r' }),
    _getVcs: async () => stub,
  });
  assert.deepEqual(result, { ok: true, vcs: stub, project: 'o/r' });
});

test('#881: resolveForgeSource — no origin remote degrades to {ok:false, reason} without ever calling _getVcs', async () => {
  let called = false;
  const result = await resolveForgeSource({
    _originIdentity: () => ({ host: null, project: null }),
    _getVcs: async () => { called = true; return {}; },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /origin/);
  assert.equal(called, false, 'a project-less origin is not worth resolving a port for');
});

test('#881: judgment:cold-6 — main() resolves a live forge port for the poller when deps.forgeSource is omitted, and the poller actually uses it', async () => {
  const root = makeFixture();
  const calls = [];
  const stubVcs = readOnlyWriteVerbs({
    issueList: async () => { calls.push('issueList'); return [
      { number: 1, title: 'one', labels: [], assignees: [] },
      { number: 2, title: 'two', labels: [], assignees: [] },
    ]; },
    mrList: async () => { calls.push('mrList'); return [{ number: 10, title: 'pr ten', headBranch: 'feat/issue-1-x' }]; },
    issueView: async ({ number }) => { calls.push(`issueView:${number}`); return { number, body: '' }; },
    prReviews: async () => { calls.push('prReviews'); return []; },
  });
  const result = await main(['--port', '0', '--root', root], {
    say: () => {}, error: () => {}, process: makeFakeProcess(),
    _resolveForgeSource: async () => ({ ok: true, vcs: stubVcs, project: 'o/r' }),
  });
  try {
    const base = `http://127.0.0.1:${result.port}`;
    await fetch(`${base}/api/poll/once`, { method: 'POST' }); // drives (or joins) the first tick

    // `once()` awaits the tick itself; the recompute it triggers is a
    // separate fire-and-forget step (`onTick` -> `recomputeAndBroadcast`),
    // so poll for `/api/snapshot` to catch up rather than assume one fetch
    // is enough — this is RED today regardless, because the poller never
    // even sees `stubVcs`.
    let snap = null;
    for (let i = 0; i < 40; i++) {
      snap = await (await fetch(`${base}/api/snapshot`)).json();
      if (snap.prs.ok === true) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(snap.prs.ok, true, 'RED today: main() never resolved a forge port, so the poller only ever saw noForgeVcs');
    assert.equal(snap.prs.value.length, 1);
    assert.equal(snap.graph.ok, true);
    assert.equal(snap.graph.value.nodes.length, 2);
    assert.ok(calls.includes('issueList'), 'the resolved stub actually served the poller, not noForgeVcs');
  } finally {
    await result.close();
  }
});

test('#881: judgment:cold-6 — a failed forge resolution says the reason on stderr, starts the poller paused with that reason, and the reason reaches /api/snapshot in band', async () => {
  const root = makeFixture();
  const errors = [];
  const result = await main(['--port', '0', '--root', root], {
    say: () => {}, error: (m) => errors.push(m), process: makeFakeProcess(),
    _resolveForgeSource: async () => ({ ok: false, reason: 'no VCS token' }),
  });
  try {
    assert.match(errors.join('\n'), /✗ forge: no VCS token — polling paused; tree sections still served/);

    const base = `http://127.0.0.1:${result.port}`;
    const snap = await (await fetch(`${base}/api/snapshot`)).json();
    assert.equal(snap.prs.ok, false);
    assert.match(snap.prs.reason, /no VCS token/);
    assert.equal(snap.graph.ok, false);
    assert.match(snap.graph.reason, /no VCS token/);
    assert.equal(snap.reviews.ok, false);
    assert.match(snap.reviews.reason, /no VCS token/);

    const pauseRes = await fetch(`${base}/api/poll/pause`, { method: 'POST' }); // idempotent state read
    const state = await pauseRes.json();
    assert.equal(state.paused, true);
    assert.match(state.lastError, /no VCS token/);
    assert.ok(state.lastPolledAt, 'the reason carries a time, not just text');
  } finally {
    await result.close();
  }
});

// ── PR 4 / B2: the static assets the browser loads ─────────────────────────
//
// The page is plain ES modules with no build step and no dependency
// (maintainer ruling, 2026-09-14): the browser loads `/app.js`, which imports
// `./lib/*.mjs` — the SAME files `node:test` imports — so the server has to
// serve two directories and nothing else. The allow-list is a literal set
// plus one anchored pattern; no request path is ever joined onto a filesystem
// path, so traversal cannot reach a file the list does not name.

test('#881: R881-1 S1 — GET / serves the real SPA shell: the canvas, drawer, banner and status mounts app.js writes into', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  await server.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html');
    const body = await res.text();
    for (const id of ['banners', 'canvas', 'drawer', 'status']) {
      assert.match(body, new RegExp(`id="${id}"`), `the shell must mount #${id} for app.js to render into`);
    }
    assert.match(body, /<script type="module" src="\/app\.js"><\/script>/, 'the page loads app.js as a module, with no build step');
    assert.doesNotMatch(body, /src="https?:/, 'no external resource: no CDN, no vendored library (ruling)');
    assert.doesNotMatch(body, /\son[a-z]+=/, 'no inline event handler — app.js wires every listener');
  } finally {
    await server.close();
  }
});

test('#881: the three static assets answer with their own content-type: /app.js, /app.css, /lib/<module>.mjs', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const cases = [
      ['/app.js', 'application/javascript', /import .* from '\.\/lib\//],
      ['/app.css', 'text/css', /\.state-planned/],
      ['/lib/layout.mjs', 'application/javascript', /export function layout/],
      ['/lib/colour.mjs', 'application/javascript', /export function colourClass/],
    ];
    for (const [path, type, bodyRe] of cases) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, `${path} must be served`);
      assert.equal(res.headers.get('content-type'), type, `${path} content-type`);
      assert.match(await res.text(), bodyRe, `${path} must be the real file, not an empty 200`);
    }
  } finally {
    await server.close();
  }
});

test('#881: the static allow-list refuses everything it does not name — traversal, test files, other directories', async () => {
  const server = createUiServer({ root: makeFixture(), _now: now });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const refused = [
      '/lib/%2e%2e/server.mjs', // encoded traversal, normalised by the URL parser before routing
      '/lib/../server.mjs',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/lib/layout.test.mjs', // a test file is not part of the page
      '/lib//layout.mjs',
      '/lib/sub/layout.mjs',
      '/index.html', // the shell is served at / only
      '/server.mjs',
      '/lib/',
    ];
    for (const path of refused) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, `${path} must not be served`);
    }
  } finally {
    await server.close();
  }
});

test('#881: the static routes answer through main() too, with every seam defaulted except the forge resolver', async () => {
  const result = await main(['--port', '0', '--root', makeFixture()], {
    say: () => {}, error: () => {}, process: makeFakeProcess(), _resolveForgeSource: noRealForgeResolution(),
  });
  try {
    const base = `http://127.0.0.1:${result.port}`;
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/app.css`)).status, 200);
    assert.equal((await fetch(`${base}/lib/layout.mjs`)).status, 200);
    assert.equal((await fetch(`${base}/lib/nope.mjs`)).status, 404);
  } finally {
    await result.close();
  }
});
