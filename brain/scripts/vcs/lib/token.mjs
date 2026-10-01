// token.mjs — Read the VCS credential env var (VCS_TOKEN) from .env or process.env.
//
// Credentials live in .env (never in brain.config.json). A single generic env
// var, VCS_TOKEN, is used regardless of the active provider (ADR-0007 / issue #33).
// The provider parameter is kept in all exported signatures for source compatibility
// with callers that pass it, but it is no longer used to select a var name.

import { readEnv } from '../../lib/env-read.mjs';

/** The single env var name used for VCS credentials across all providers. */
const VCS_TOKEN_KEY = 'VCS_TOKEN';

/**
 * Returns the env var name that holds the VCS token.
 * The provider argument is accepted for source compatibility but is ignored —
 * all providers use the same generic VCS_TOKEN variable.
 *
 * @param {string} _provider  (unused)
 * @returns {string}
 */
export function tokenEnvVar(_provider) {
  return VCS_TOKEN_KEY;
}

/**
 * Reads a var: the SHELL first, then `.env`, then nothing (#316).
 *
 * THE PRECEDENCE FLIPPED HERE, and it is the point rather than a side effect.
 * This function read `.env` FIRST and fell back to `process.env` only when the
 * KEY was absent from the file — so a dead line could shadow a live shell value
 * and removing the value was not enough to escape it. Measured 2026-08-27: a
 * dead `VCS_TOKEN` in `.env` shadowed a healthy `gh` keyring session and every
 * port verb answered `HTTP 401 Bad credentials` while `gh auth status` reported
 * a good login. Under shell-first that failure cannot be built.
 *
 * The parse moved with it: `startsWith("KEY=")` matched a prefix rather than a
 * key, so `NO_PROXYN=` sat one character away from answering for `NO_PROXY`.
 * `parseEnvFile` splits on the first `=` and trims the key.
 *
 * @param {string} key
 * @param {string} [root]
 * @returns {string|null}
 */
export function readEnvVar(key, root = process.cwd()) {
  return readEnv(key, { root });
}

/** Reads the credential token for the active provider from VCS_TOKEN. */
export function vcsToken(provider, root) {
  return readEnvVar(tokenEnvVar(provider), root);
}
