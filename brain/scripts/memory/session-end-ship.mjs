#!/usr/bin/env node
// brain/scripts/memory/session-end-ship.mjs — the SessionEnd hook launcher
// (#906, design.md A1-A3, ruling D1). The compiled SessionEnd hook
// (axes/platform/lib/settings-hooks.mjs) runs `npm run brain:memory:session-end`
// UNCONDITIONALLY on every platform (D2: emit-always, guard at runtime) — this
// file is that runtime guard.
//
// Order, exactly as design.md's A1 table:
//   1. `_loadConfig()` → `memory.lane.enabled === true`; false or absent ⇒
//      exit 0, spawn nothing, print nothing (loadBrainConfig parses raw JSON,
//      no migration, so an absent key reads as undefined — false by
//      construction).
//   2. `ensurePrivateDir(${tmpdir()}/brain-lane-<uid>/, uid)` — an owner-only
//      (0o700) directory this process trusts, created if absent, verified
//      (not a symlink, a real directory, owned by `uid`, no group/other
//      bits) whether created or pre-existing. Then
//      `openSync(log, O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW, 0o600)` inside
//      it, followed by `fstatSync` on the opened fd, verified the same way
//      (regular file, owned by `uid`, no group/other bits, one hard link).
//      Two independent checks, both required (#906 cold review C7):
//      `O_NOFOLLOW` only refuses a pre-existing SYMLINK, and `open`'s `mode`
//      argument only applies when the call itself CREATES the file — a
//      local user who pre-creates the log path as an ordinary 0o666 file
//      defeats `O_NOFOLLOW` and the create-mode entirely; the directory
//      check keeps attacker-owned directories out, and the `fstat` check on
//      the already-open fd is what still catches a pre-created file even if
//      the directory check were somehow satisfied. Any failure routes
//      through step 5's catch.
//   3. `_spawn(execPath, [cli.mjs, 'ship', '--json', '--invoker', 'hook'],
//      { detached: true, stdio: ['ignore', fd, fd] })`, then `.unref()`,
//      then `closeSync(fd)`. #1012: `--invoker hook` declares this caller
//      to `cli.mjs ship`'s own invoker guard.
//   4. Return / exit 0, ALWAYS — the child's own exit code is never read.
//      `ship` exits 1 on a raced push; a session must not end red for that.
//   5. Any throw along the way ⇒ exactly one stderr line, still exit 0.
//
// `env: process.env` is passed UNCHANGED (A2) — `credentialEnvNames()`
// (lib/credential-env.mjs) includes FORGE_TOKEN_ENV, so a reflexive scrub
// would drop GH_TOKEN/GITLAB_TOKEN and kill the ambient `lite` identity
// ADR-0034 L5 permits, invisibly, inside a detached child. Do not "harden"
// this by scrubbing — that is the exact trap A2 documents.
//
// `--json` (not the human-readable form): the tmp log is the ONLY record a
// detached run leaves, and `t()` would translate a human-readable line into
// the operator's `docs.language` — a locale-dependent postmortem. `ship`
// writes its stderr evidence regardless of `--json`, so the log keeps both.

import {
  openSync, closeSync, constants as fsConstants, lstatSync, fstatSync, mkdirSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname, tmpdir as osTmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBrainConfig } from '../lib/brain-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const CLI_PATH = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** `process.getuid` when available (POSIX); `os.userInfo().username`
 * otherwise. Used both to scope the private log directory and to verify
 * ownership of the directory and the log file it holds. */
function defaultUid() {
  return typeof process.getuid === 'function' ? process.getuid() : userInfo().username;
}

/**
 * Ensures `dir` is an owner-only directory this process can trust as the
 * home for the session-end log, creating it (mode 0o700) if absent.
 * Whether created here or pre-existing, `lstatSync`s it and refuses
 * (throws) a symlink, a non-directory, a directory owned by someone else,
 * or one with any group/other permission bit set — the first of two
 * independent checks C7 requires (see the header comment).
 */
function ensurePrivateDir(dir, uid) {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) { /* swallow-ok: ONLY EEXIST continues (the directory exists, and the lstat checks below refuse a symlink, a foreign owner or loose permissions); every other error is re-thrown */
    if (err?.code !== 'EEXIST') throw err;
  }
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw new Error(`refusing symlinked private dir: ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`refusing non-directory at private dir path: ${dir}`);
  }
  if (st.uid !== uid) {
    throw new Error(`refusing private dir not owned by the current user: ${dir}`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`refusing private dir with group/other permissions: ${dir}`);
  }
}

/**
 * `fstatSync`-verifies the just-opened fd is a REGULAR file this process
 * owns, private (no group/other bits), with no other hard link — the
 * second of C7's two independent checks, and the one that still holds even
 * if a local user shares this uid and somehow satisfies
 * `ensurePrivateDir` above: it defeats a pre-created 0o666 regular file at
 * the log path, which `O_NOFOLLOW` and `open`'s create-only `mode`
 * argument do not.
 *
 * Does NOT close `fd` itself on refusal — `shipOnSessionEnd`'s single
 * `finally` is the only place that closes `fd`, on every path (refusal,
 * `_spawn`/`.unref()` throwing after this check already passed, or
 * success). A prior version closed `fd` here AND guarded a second close in
 * the caller's `finally` with a boolean; that guard collapsed any
 * post-check failure (this function throwing vs. `_spawn` throwing) into
 * the same branch, so a `_spawn`/`.unref()` throw AFTER this check passed
 * skipped the `finally` close entirely and leaked the fd. One close site
 * has no such ambiguity.
 */
function ensureTrustedFd(fd, uid, logPath) {
  const st = fstatSync(fd);
  if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0 || st.nlink !== 1) {
    throw new Error(`refusing untrusted log file: ${logPath}`);
  }
}

/**
 * Ships the lane, detached, IFF `memory.lane.enabled` is true. Never throws,
 * never reports a non-zero outcome to its caller — the hook that invokes
 * this must always see exit 0.
 *
 * @param {{ _loadConfig?: Function, _spawn?: Function, _tmpdir?: Function, _now?: Function, _uid?: Function, _closeSync?: Function }} [seams]
 * @returns {{ spawned: boolean, logPath: string|null }}
 */
export function shipOnSessionEnd({
  _loadConfig = loadBrainConfig,
  _spawn = spawn,
  _tmpdir = osTmpdir,
  _now = () => new Date(),
  _uid = defaultUid,
  _closeSync = closeSync,
} = {}) {
  try {
    const config = _loadConfig();
    if (config?.memory?.lane?.enabled !== true) {
      return { spawned: false, logPath: null };
    }

    const uid = _uid();
    // `tmpdir()` is a predictable, world-writable directory: a local user
    // can pre-create anything at a predictable path inside it before this
    // ever runs. `ensurePrivateDir` confines the log to an owner-only
    // (0o700) subdirectory scoped by uid, verified whether created here or
    // pre-existing (#906 cold review C7).
    const privateDir = join(_tmpdir(), `brain-lane-${uid}`);
    ensurePrivateDir(privateDir, uid);

    const date = _now().toISOString().slice(0, 10);
    const logPath = join(privateDir, `brain-lane-ship-${hostname()}-${date}.log`);
    // A plain `openSync(logPath, 'a')` (default flags, default mode 0664)
    // would FOLLOW a pre-existing symlink at the log path and append the
    // ship op's stderr evidence into whatever file the attacker named
    // (#906 cold review C2). `O_NOFOLLOW` refuses instead of following —
    // the resulting ELOOP is caught by the outer `catch` below, which
    // already does exactly the right thing: one stderr line, exit 0, no
    // spawn. `0o600` denies read to every other local user, but ONLY for a
    // freshly created file — `mode` is a no-op against a file that already
    // existed before this call (#906 cold review C7), which is why
    // `ensureTrustedFd` below re-checks the opened fd regardless.
    const fd = openSync(
      logPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
      0o600,
    );
    // Single close site, unconditional: whether ensureTrustedFd refuses,
    // _spawn/.unref() throws AFTER the fd was already trusted, or the spawn
    // succeeds outright, this is the only place `fd` is closed — no bool
    // guard, no branch that can skip it and leak the fd (post-merge fix).
    try {
      ensureTrustedFd(fd, uid, logPath);
      const child = _spawn(
        process.execPath,
        [CLI_PATH, 'ship', '--json', '--invoker', 'hook'],
        {
          detached: true,
          stdio: ['ignore', fd, fd],
          cwd: REPO_ROOT,
          env: process.env,
        },
      );
      child.unref();
    } finally {
      _closeSync(fd);
    }

    return { spawned: true, logPath };
  } catch (err) { /* surfaced: the SessionEnd hook must exit 0 so it never blocks closing a session; the error is written to stderr and returned as spawned: false */
    process.stderr.write(`brain:memory:session-end: ${err?.message ?? String(err)}\n`);
    return { spawned: false, logPath: null };
  }
}

// Main-module guard (lib/brain-config.mjs:240 pattern) — importable for
// tests, executable as the SessionEnd hook. Exit 0 always (step 4).
if (process.argv[1] === __filename) {
  shipOnSessionEnd();
  process.exit(0);
}
