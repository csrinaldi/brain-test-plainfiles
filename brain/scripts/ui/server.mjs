#!/usr/bin/env node
// server.mjs — `brain:ui`: the local read-model server (#881, PR 1 / A1 +
// PR 2 / A2).
//
// Serves the static SPA at `/`, the snapshot at `GET /api/snapshot`, and a
// push stream at `GET /api/stream` — built IN-PROCESS via `buildSnapshot`,
// never shelling out to a CLI (R881-1). `buildSnapshot` is composed with a
// cache-only `vcs` port (`forge-cache.mjs`, D1); `poller.mjs` is the only
// module that ever calls the real forge, filling that cache on a schedule
// (Q1). `watcher.mjs` watches the committed tier (Q3) and triggers a
// debounced recompute; both triggers funnel through ONE in-memory `current`
// snapshot (D1's "rejected — recompute per HTTP request"): `/api/snapshot`
// and the SSE stream's `sync` frame always agree because they serve the
// SAME held value, refreshed only by a completed poll or a debounced watch
// event, never per-request.
//
// Every route accepts GET/HEAD only, EXCEPT the three poller controls
// (`/api/poll/pause|resume|once`), which accept POST only — the method
// check runs BEFORE routing (D7), so any other verb gets 405 on any path,
// known or unknown.

import { createServer as createHttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSnapshot } from '../status/snapshot.mjs';
import { createForgeCache } from './forge-cache.mjs';
import { diffSections } from './diff.mjs';
import { createWatcher, resolveGitCommonDir } from './watcher.mjs';
import { createPoller } from './poller.mjs';
import { buildChangeView } from './change-route.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, 'static');
const LIB_DIR = join(__dirname, 'lib');
const VENDOR_DIR = join(__dirname, 'vendor');
const JS_TYPE = 'application/javascript';
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

// The page is plain ES modules with no build step: the browser loads
// `/app.js`, which imports `./lib/<module>.mjs` — the SAME files `node:test`
// imports (D9). So exactly two directories are served, through an ALLOW-LIST:
// a literal map plus one anchored pattern. No request path is ever joined
// onto a filesystem path, so `..`, an encoded `%2e%2e` (both normalised away
// by the URL parser before routing), a nested path or a `.test.mjs` file
// simply match nothing and fall through to the 404 below.
const STATIC_FILES = new Map([
  ['/app.js', { dir: STATIC_DIR, name: 'app.js', type: JS_TYPE }],
  ['/app.css', { dir: STATIC_DIR, name: 'app.css', type: 'text/css' }],
  // #1198: the one vendored file. A literal entry, not a `/vendor/*` pattern, so
  // the allow-list posture holds: no request path is ever joined onto a path.
  ['/vendor/marked.esm.js', { dir: VENDOR_DIR, name: 'marked.esm.js', type: JS_TYPE }],
]);
const LIB_MODULE_RE = /^\/lib\/([a-z][a-z0-9-]*)\.mjs$/;
const POST_ONLY_PATHS = new Set(['/api/poll/pause', '/api/poll/resume', '/api/poll/once']);
/** `GET /api/change/<N digits>` — a non-numeric id falls through to the 404 below (D8's `change-route.mjs`). */
const CHANGE_ROUTE_RE = /^\/api\/change\/(\d+)$/;

/** Every route this server knows — the R881-10 S3 guard test pins this set: no MCP resource route, no heartbeat/agent-pulse endpoint. */
export const KNOWN_ROUTES = Object.freeze(['/', '/app.js', '/app.css', '/lib/{module}.mjs', '/vendor/marked.esm.js', '/api/snapshot', '/api/stream', '/api/poll/pause', '/api/poll/resume', '/api/poll/once', '/api/change/{issue}']);

const NO_FORGE_REASON = 'no forge port was supplied to the poller';
const noForgeVcs = {
  issueList: async () => { throw new Error(NO_FORGE_REASON); },
  mrList: async () => { throw new Error(NO_FORGE_REASON); },
  issueView: async () => { throw new Error(NO_FORGE_REASON); },
  prReviews: async () => { throw new Error(NO_FORGE_REASON); },
};

/**
 * createUiServer() — the one factory every caller uses: the CLI entry below
 * for a real process, tests for an ephemeral one (`port: 0`). No
 * process-level concern (argv, signals, exit codes) lives past this
 * factory's boundary — `listen()`/`close()` are the only lifecycle surface.
 *
 * @param {{
 *   root?: string, port?: number, vcs?: object|null, project?: string|null, _now?: () => Date,
 *   forgeSource?: object|null, forgeUnavailable?: string|null, interval?: number, poll?: boolean,
 *   gitCommonDir?: string|null, _watch?: Function, _run?: Function, _readdir?: Function,
 *   _setTimeout?: Function, _clearTimeout?: Function, _recomputeCurrent?: () => Promise<object>,
 * }} opts
 */
export function createUiServer({
  root = process.cwd(), port = 3000, vcs = null, project = null, _now = () => new Date(),
  forgeSource = null, forgeUnavailable = null, interval = 60000, poll = true,
  gitCommonDir = null, _watch, _run, _readdir,
  _setTimeout = setTimeout, _clearTimeout = clearTimeout,
  _recomputeCurrent = null, onServerError = null} = {}) {
  // `opts.maxBuffer` is the only option a caller may pass (#1198): a document read sizes its own buffer.
  const run = _run ?? ((file, args, opts) => execFileSync(file, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...(opts?.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}) }));

  // D1's invariant: `buildSnapshot` NEVER sees a live forge port, only the
  // cache. The server always owns a cache instance so the poller always has
  // somewhere to write; when a caller injects `vcs` directly (tests, mostly),
  // `buildSnapshot` reads THAT instead and the poller's writes into its own
  // cache go unread — harmless, and it keeps PR 1's read-only-port tests
  // untouched by PR 2's wiring.
  const forgeCache = createForgeCache();
  const forgeVcs = vcs ?? forgeCache.port;

  // The ONE in-memory snapshot every route serves (D1 — "rejected: recompute
  // per HTTP request"). Refreshed only by a completed poll or a debounced
  // watch event, never by an HTTP request itself.
  let current = null;
  let resolvedGitCommonDir = gitCommonDir; // lazily resolved below — needed for a linked worktree's --git-dir
  const clients = new Set();

  // `ServerResponse.write()` after its socket has already gone away does NOT
  // throw synchronously — it emits an ASYNC 'error' event
  // (`ERR_STREAM_WRITE_AFTER_END`/`ERR_STREAM_DESTROYED`). An EventEmitter
  // with no 'error' listener throws out of `.emit()`, crashing this whole
  // process (judgment:cold-3). `registerClient()` is the only place a `res`
  // enters `clients`, so it is the one place that attaches the listener —
  // covering both the real path (`serveStream`) and the test-only seam
  // below. `dropClient()` removes a client from every path that can learn it
  // is gone: a write error, the request's own 'close' event, and shutdown.
  function dropClient(res) {
    clients.delete(res);
  }

  function registerClient(res) {
    clients.add(res);
    if (typeof res.on === 'function') res.on('error', () => dropClient(res));
  }

  function sendEvent(res, event, data) {
    if (res.writableEnded || res.destroyed) { dropClient(res); return; }
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // a synchronous write failure (rare, but not impossible) drops the
      // client the same way an async 'error' does — never lets one dead
      // client stop the broadcast loop for the others
      dropClient(res);
    }
  }

  function broadcast(event, data) {
    for (const client of clients) sendEvent(client, event, data);
  }

  // #998 R998-6 T3: the served checkout's branch — `HEAD`'s symbolic ref on
  // the SERVED ROOT's own git dir (never `-C` on a worktree, same posture as
  // every other git call in this file). Read ONCE (memoized): every later
  // `buildMeta()` call — one per status/sync frame — reuses the same value
  // rather than shelling out to `git` on every broadcast. A detached HEAD
  // (`git symbolic-ref` fails on purpose in that case) or any other read
  // failure is a said reason, never a crash and never a blank header.
  let servedBranch = null;
  function resolveServedBranch() {
    if (servedBranch !== null) return servedBranch;
    try {
      const branch = run('git', ['symbolic-ref', '--short', 'HEAD']).trim();
      servedBranch = { ok: true, branch, source: { path: 'HEAD' } };
    } catch (err) {
      servedBranch = { ok: false, reason: err?.message ?? String(err), source: { path: 'HEAD' } };
    }
    return servedBranch;
  }

  function buildMeta() {
    return { project, watcher: watcher.state(), poller: poller.state(), servedBranch: resolveServedBranch() };
  }

  // `_recomputeCurrent` is a test-only seam (default: the real recompute
  // below) — it lets a test force `listen()`'s startup recompute to throw
  // without reaching into `buildSnapshot` itself. Every caller in this
  // module goes through the same `recomputeCurrent()` wrapper, so the seam
  // covers the startup path, `serveSnapshot`, `serveStream`, and
  // `recomputeAndBroadcast` alike — only the startup path (`listen()`) is
  // unprotected against a throw, which is what judgment:cold-2 found.
  //
  // `forgeUnavailable` (#881, judgment:cold-6): set when `main()` could not
  // resolve a live forge port at all (no origin remote, no provider
  // configured, `getVcs()` threw). The poller is constructed paused with
  // the same reason (below), so the cache-only port never fills — but
  // `buildSnapshot`'s own `readForge` would otherwise report a generic
  // "the first forge poll has not completed" forever, which is TRUE but not
  // the actual reason an operator needs. Overriding the three forge
  // sections here says the real reason in band without `buildSnapshot`
  // ever seeing a live port (D1 is unchanged: no forge call happens either
  // way).
  const computeSnapshot = _recomputeCurrent ?? (async () => {
    const snapshot = await buildSnapshot({ root, now: _now(), vcs: forgeVcs, project });
    if (!forgeUnavailable) return snapshot;
    const unreachable = { ok: false, reason: forgeUnavailable };
    return { ...snapshot, graph: unreachable, prs: unreachable, reviews: unreachable };
  });

  async function recomputeCurrent() {
    current = await computeSnapshot();
    return current;
  }

  /**
   * Recompute `current`, diff it against what was held before, and push one
   * `section` frame per changed key (Q5/D6), one `refs` frame per worktree
   * whose ref-tracking dir fired (Q3), then a `status` frame. Never throws:
   * a recompute failure must not crash the server, the watcher's debounce
   * loop, or the poller's tick loop that triggered it — it simply has
   * nothing new to broadcast this cycle.
   */
  async function recomputeAndBroadcast({ causes = ['poll'], refWorktrees = [] } = {}) {
    try {
      const previous = current;
      await recomputeCurrent();
      for (const { name, section } of diffSections(previous, current)) {
        broadcast('section', { name, section, generatedAt: current.generatedAt, cause: causes[0] ?? 'poll' });
      }
      // A worktree's branch is read via `--git-dir` on its own admin dir under
      // the common dir — never `-C worktreePath` — so no path under the
      // worktree itself is ever opened (R881-3: "not even a linked worktree's
      // own `.git` file"). The primary checkout has no admin dir; a plain
      // call (default cwd) resolves its own HEAD instead.
      for (const { path: worktreePath, id } of refWorktrees) {
        let head = null;
        try {
          if (id && resolvedGitCommonDir === null) resolvedGitCommonDir = resolveGitCommonDir({ root, _run: run });
          const args = id
            ? ['--git-dir', join(resolvedGitCommonDir, 'worktrees', id), 'rev-parse', '--abbrev-ref', 'HEAD']
            : ['rev-parse', '--abbrev-ref', 'HEAD'];
          head = run('git', args).trim();
        } catch { head = null; }
        broadcast('refs', { worktree: worktreePath, head, at: _now().toISOString() });
      }
      broadcast('status', buildMeta());
    } catch { /* a failed recompute leaves `current` at its last good value; nothing to broadcast */ }
  }

  const watcher = createWatcher({ root, gitCommonDir, _watch, _run: run, _readdir, _now, _setTimeout, _clearTimeout, onRecompute: recomputeAndBroadcast });
  const poller = createPoller({
    vcs: forgeSource ?? noForgeVcs, cache: forgeCache, project, interval, enabled: poll,
    initialError: forgeUnavailable, _setTimeout, _clearTimeout, _now,
    onTick: () => { recomputeAndBroadcast({ causes: ['poll'] }); },
  });

  const httpServer = createHttpServer((req, res) => {
    handleRequest(req, res).catch((err) => sendInternalError(res, err));
  });

  // A post-bind failure (`EMFILE` on `accept()` is the documented case) fires
  // an ASYNC 'error' event on the live `httpServer`, not just during
  // `listen()`'s own startup window — `listen()`'s `once('error', onError)`
  // below is removed the moment 'listening' fires (see `onListening`). Same
  // defect class as judgment:cold-3: an EventEmitter throws out of `.emit()`
  // when 'error' has no listener, which would crash an otherwise-recoverable
  // accept failure into a process death. This baseline listener never comes
  // off, so 'error' always has somewhere to go for the server's whole
  // lifetime; `_lastServerError` is a test-only seam to observe it.
  let lastServerError = null;
  httpServer.on('error', (err) => {
    lastServerError = err;
    // Recorded is not said: the CLI passes `onServerError` so the operator
    // reads the reason on stderr; a library caller may pass nothing.
    if (onServerError) onServerError(err);
  });

  async function handleRequest(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (POST_ONLY_PATHS.has(pathname)) {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
    } else if (!ALLOWED_METHODS.has(req.method)) {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    if (pathname === '/') return serveStaticFile(res, { dir: STATIC_DIR, name: 'index.html', type: 'text/html' });
    const staticFile = STATIC_FILES.get(pathname);
    if (staticFile) return serveStaticFile(res, staticFile);
    const libMatch = LIB_MODULE_RE.exec(pathname);
    if (libMatch) return serveStaticFile(res, { dir: LIB_DIR, name: `${libMatch[1]}.mjs`, type: JS_TYPE });
    if (pathname === '/api/snapshot') return serveSnapshot(res);
    if (pathname === '/api/stream') return serveStream(req, res);
    if (pathname === '/api/poll/pause') return servePollControl(res, poller.pause);
    if (pathname === '/api/poll/resume') return servePollControl(res, poller.resume);
    if (pathname === '/api/poll/once') return servePollControl(res, poller.once);
    const changeMatch = CHANGE_ROUTE_RE.exec(pathname);
    if (changeMatch) return serveChange(res, Number(changeMatch[1]));
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  /**
   * The only filesystem read on the page's path: `dir` and `name` come from
   * the allow-list above, never from the request. A name the list allows but
   * this checkout does not have (a module renamed without updating `app.js`)
   * is a 404, not a 500 — the browser then says which import failed, which is
   * the fact an operator needs.
   */
  function serveStaticFile(res, { dir, name, type }) {
    let body;
    try {
      body = readFileSync(join(dir, name), 'utf8');
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  }

  async function serveSnapshot(res) {
    if (current === null) await recomputeCurrent();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(current));
  }

  async function serveStream(req, res) {
    if (current === null) await recomputeCurrent();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    registerClient(res);
    req.on('close', () => dropClient(res));
    sendEvent(res, 'sync', { generatedAt: current.generatedAt, snapshot: current, meta: buildMeta() });
  }

  async function servePollControl(res, action) {
    const state = await action();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state));
  }

  // D8/D11: the drawer's IO — `buildChangeView` composes the six `ui/lib/**`
  // shapers over the SAME `current` snapshot every other route serves (D1 —
  // one held value, never a per-request recompute); its own `git blame`/
  // `git cat-file` reads run through the same `run` seam `recomputeAndBroadcast`
  // uses above, on the served root's own git dir, never a worktree's.
  async function serveChange(res, issueNumber) {
    if (current === null) await recomputeCurrent();
    const view = buildChangeView({ root, issue: issueNumber, snapshot: current, project, _run: run });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(view));
  }

  function sendInternalError(res, err) {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`internal error: ${err?.message ?? err}`);
  }

  const api = {
    port,
    listen(overridePort = api.port) {
      return new Promise((resolve, reject) => {
        const onError = (err) => { httpServer.removeListener('listening', onListening); reject(err); };
        const onListening = async () => {
          httpServer.removeListener('error', onError);
          api.port = httpServer.address().port;
          // Every other recompute call site is protected (`handleRequest`'s
          // `.catch`, `recomputeAndBroadcast`'s try/catch); this startup call
          // was not — an uncaught throw here became an unhandled rejection
          // and left `listen()`'s promise settled never, hanging the caller
          // while the httpServer stayed bound. Fail loudly instead: close
          // the listener so the port is released, then reject with the
          // original error.
          try {
            await recomputeCurrent();
          } catch (err) {
            httpServer.close(() => reject(err));
            return;
          }
          watcher.start();
          poller.start();
          resolve(api.port);
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(overridePort, '127.0.0.1');
      });
    },
    close() {
      poller.close();
      watcher.close();
      for (const client of clients) { try { client.end(); } catch { /* best effort */ } }
      clients.clear();
      return new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
    // Test-only seam (judgment:cold-3): lets a test put a fake,
    // EventEmitter-shaped dead `res` into the broadcast set without a real
    // socket race. Not read by any production code path above.
    _clients: clients,
    _registerClient: registerClient,
    // Test-only seam (sweep): lets a test force the server's own post-bind
    // 'error' path deterministically, without a real EMFILE.
    _httpServer: httpServer,
    get _lastServerError() { return lastServerError; },
  };
  return api;
}

// ── argv: a manual loop, the same grammar as `status/snapshot-cli.mjs:18-34` ─

/** @returns {{ok:true,port:number,root:string,interval:number,poll:boolean}|{ok:false,error:string}} */
export function parseArgs(argv = []) {
  const out = { ok: true, port: 3000, root: process.cwd(), interval: 60000, poll: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const v = argv[++i];
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n < 0) return { ok: false, error: '--port needs a non-negative integer' };
      out.port = n;
    } else if (a === '--root') {
      const v = argv[++i];
      if (!v) return { ok: false, error: '--root needs a directory' };
      out.root = v;
    } else if (a === '--interval') {
      const v = argv[++i];
      const n = Number(v);
      if (v === undefined || !Number.isInteger(n) || n < 0) return { ok: false, error: '--interval needs a non-negative integer (milliseconds)' };
      out.interval = n;
    } else if (a === '--no-poll') {
      out.poll = false;
    } else return { ok: false, error: `unknown argument: ${a}` };
  }
  return out;
}

/**
 * resolveForgeSource() — mirrors `status/snapshot-cli.mjs:54-69`: resolves a
 * REAL, live forge port (D1's ONLY legitimate holder is the poller). Every
 * failure mode — no git origin remote, no provider configured
 * (`resolveProviderName` throws), `getVcs()`'s dynamic import failing —
 * degrades to `{ok:false, reason}` rather than throwing, so `main()` never
 * has to guard a throw from this call: the entry point that used to run
 * with an unresolved, always-throwing forge port (#881, judgment:cold-6)
 * now either gets a real one or a said reason, never a crash.
 *
 * `_getVcs`/`_originIdentity` are the same test seams `snapshot-cli.mjs`
 * exposes — a fixture with no remote or no token exercises this function
 * directly, with no dynamic import and no real `git`/`gh` process.
 *
 * @param {{ _getVcs?: Function, _originIdentity?: Function }} [opts]
 * @returns {Promise<{ok:true, vcs:object, project:string}|{ok:false, reason:string}>}
 */
export async function resolveForgeSource({ _getVcs, _originIdentity } = {}) {
  try {
    const originIdentityFn = _originIdentity ?? (await import('../vcs/lib/repo.mjs')).originIdentity;
    const { project } = originIdentityFn() ?? {};
    if (!project) return { ok: false, reason: 'no git origin remote — cannot resolve a forge project' };
    const getVcsFn = _getVcs ?? (await import('../vcs/cli.mjs')).getVcs;
    const vcs = await getVcsFn();
    return { ok: true, vcs, project };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}

/**
 * main() — the CLI's own logic, deps-injected for tests. `EADDRINUSE` is
 * D15's same class of error as a bad argument (the operator gave this verb
 * something it cannot use), so it takes the same exit code, 2.
 *
 * @returns {Promise<number|object>} an exit code on failure, or the started
 *   server on success — the guard below only exits on the numeric case, so a
 *   real run keeps listening.
 */
export async function main(argv = [], deps = {}) {
  const say = deps.say ?? console.log;
  const error = deps.error ?? console.error;
  const proc = deps.process ?? process;
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    error(`✗ ${parsed.error}\n  Usage: npm run brain:ui -- [--port <n>] [--root <dir>] [--interval <ms>] [--no-poll]`);
    return 2;
  }

  // #881, judgment:cold-6: the real entry point never resolved a live forge
  // port — `deps.forgeSource` was always `undefined` here, so the poller's
  // four verbs always threw and `prs`/`reviews`/issue bodies never left
  // `{ok:false}` outside a test that injected a stub. Resolve one now,
  // exactly when a caller has not already supplied `forgeSource` AND
  // polling was even requested — `--no-poll` means no forge resolution is
  // attempted at all, matching R881-4 S2's existing contract.
  let project = deps.project ?? null;
  let forgeSource = deps.forgeSource ?? null;
  let forgeUnavailable = null;
  if (deps.forgeSource === undefined && parsed.poll) {
    const resolve = deps._resolveForgeSource ?? resolveForgeSource;
    const resolved = await resolve();
    if (resolved.ok) {
      forgeSource = resolved.vcs;
      if (project === null) project = resolved.project;
    } else {
      forgeUnavailable = resolved.reason;
      error(`✗ forge: ${resolved.reason} — polling paused; tree sections still served`);
    }
  }

  const server = createUiServer({
    root: parsed.root, vcs: deps.vcs ?? null, project,
    forgeSource, forgeUnavailable, interval: parsed.interval, poll: parsed.poll,
    _recomputeCurrent: deps._recomputeCurrent ?? null,
    onServerError: (err) => error(`✗ server error: ${err?.message ?? err} — still serving`),
  });
  try {
    await server.listen(parsed.port);
  } catch (err) {
    // EADDRINUSE and a throwing startup recompute are the same class of
    // failure (D15): the operator gave this verb something it cannot use,
    // right now, on this host — both exit 2 with the message, never an
    // uncaught throw out of `main()`.
    if (err?.code === 'EADDRINUSE') {
      error(`✗ port ${parsed.port} is already in use`);
    } else {
      error(`✗ ${err?.message ?? err}`);
    }
    return 2;
  }
  say(`brain:ui listening on http://127.0.0.1:${server.port}`);

  // D15: SIGINT/SIGTERM stop the poll timer, close every watcher, end every
  // open SSE response, close the listener, then exit 0. A second signal
  // after shutdown has already started is a no-op, not a second exit.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    say(`brain:ui received ${signal}, shutting down`);
    await server.close();
    proc.exit(0);
  };
  const onSigint = () => { shutdown('SIGINT'); };
  const onSigterm = () => { shutdown('SIGTERM'); };
  proc.on('SIGINT', onSigint);
  proc.on('SIGTERM', onSigterm);

  // judgment:cold-5: nothing ever removed these two listeners. Every
  // successful `main()` call leaked them on whatever `process` it was given
  // — against the real process (the default), enough calls print
  // `MaxListenersExceededWarning`, and the listener itself keeps the process
  // alive past a caller's own `server.close()`. Whichever path closes the
  // server — a real signal via `shutdown()` above, or a caller/test closing
  // it directly without a signal ever firing — the listeners come off too,
  // by wrapping `close()` once here rather than duplicating the removal in
  // both places.
  const realClose = server.close.bind(server);
  server.close = () => {
    proc.off('SIGINT', onSigint);
    proc.off('SIGTERM', onSigterm);
    return realClose();
  };

  return server;
}

// Guarded like `status/snapshot-cli.mjs:54-69`: importing this module never
// starts a server or reaches the forge on its own. `project` is resolved
// here the same cheap way `snapshot-cli.mjs` does (`originIdentity()`, one
// local `git` call, no network) so it is available even on a path that
// never touches the forge (`--no-poll`, or a resolution failure inside
// `main()` below). The forge PORT itself is NOT resolved here — that used
// to be true by design (D1) and is now true by an unfixed bug instead
// (#881, judgment:cold-6): `main()` never resolved one, so every real
// `npm run brain:ui` run polled with `deps.forgeSource` undefined and the
// poller's four verbs always threw. `main()` now resolves a live port
// itself (unless `--no-poll`), with the poller starting paused and the
// reason said in band on any resolution failure — this guard stays thin on
// purpose and lets `main()` own that decision.
if (import.meta.url === `file://${process.argv[1]}`) {
  let project = null;
  try {
    const { originIdentity } = await import('../vcs/lib/repo.mjs');
    project = originIdentity()?.project ?? null;
  } catch { /* degrades to uncomputable forge sections, never a crash */ }
  const result = await main(process.argv.slice(2), { project });
  if (typeof result === 'number') process.exit(result);
}
