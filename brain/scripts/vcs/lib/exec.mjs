// exec.mjs — Thin wrapper around spawnSync with an injectable test seam.
//
// Use `setSpawn` in tests to inject a fake that returns canned output without
// hitting the real CLI. Reset to `spawnSync` in afterEach.

import { spawnSync } from 'node:child_process';

let _spawn = spawnSync;

/** Replace the spawn implementation — used only in tests. */
export function setSpawn(fn) { _spawn = fn; }

/**
 * Runs a command synchronously and returns a normalized result object.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts  Passed through to spawnSync (e.g. `{ input: token }`).
 * @returns {{ ok: boolean, stdout: string, stderr: string, status: number|null }}
 */
export function run(cmd, args = [], opts = {}) {
  const r = _spawn(cmd, args, { encoding: 'utf8', ...opts });
  // A FAILURE TO LAUNCH (ENOENT — the binary is not installed) arrives in
  // `r.error`, with `status: null` and `stdout`/`stderr` both null. Dropping
  // it made "gh is not installed" indistinguishable from "gh ran and printed
  // nothing to stderr" — the reader-empty-on-failure shape this repo keeps
  // finding. Measured on #604: `brain:review` in a container without `gh`
  // refused with `gh api /user failed (status null): ` and no reason at all,
  // so the operator could not tell a missing binary from a silent rejection.
  // "Could not run" and "ran and said nothing" are DIFFERENT answers.
  const launchFailure = r.error ? `${cmd}: ${r.error.message}` : '';
  const stderr = (r.stderr ?? '') || launchFailure;
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr, status: r.status, error: r.error ?? null };
}

/**
 * Like `run`, but parses stdout as JSON. Throws on non-zero exit or bad JSON.
 * @returns {any}
 */
export function runJson(cmd, args = [], opts = {}) {
  const r = run(cmd, args, opts);
  if (!r.ok) throw new Error(`${cmd} ${args.join(' ')} failed (status ${r.status}): ${r.stderr}`);
  try { return JSON.parse(r.stdout); } catch (e) { throw new Error(`${cmd}: invalid JSON — ${e.message}`); }
}
