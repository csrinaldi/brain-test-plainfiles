#!/usr/bin/env node
// brain/scripts/harness/cli.mjs — SDD_HARNESS dispatcher.
//
// Usage: node brain/scripts/harness/cli.mjs <op>
//   op: init
//
// Reads SDD_HARNESS from the environment or .env (default: gentle-ai).
// Imports the corresponding backend from axes/<axis>/adapters/<harness>.mjs
// (harnessAdapterUrl, issue #1141) and
// dispatches the requested operation.
//
// Mirrors brain/scripts/memory/cli.mjs exactly (ADR-0012).
// See also: ADR-0005 (original inline binding), ADR-0012 (this refactor).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseEnvFile } from '../lib/env-read.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// ---------------------------------------------------------------------------
// Read SDD_HARNESS: env var > .env file > default 'gentle-ai'
// ---------------------------------------------------------------------------
// The PARSE is shared (#316); the precedence stays where it always was — at the
// consumption site below, `process.env.X ?? envVars.X`, which is already
// shell-first and is now the rule the whole tree follows. What changed is that
// keys and values are trimmed individually and one matched pair of surrounding
// quotes is stripped: this loop produced the key `"KEY "` for `KEY = v` and left
// `X="y"` as `"y"` with the quotes attached.
function readEnvFile(root = repoRoot) {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return {};
  return parseEnvFile(readFileSync(envPath, 'utf8'));
}

// `resolvePlatform` LIVES IN A LEAF, and is re-exported here so this module's
// own importers are unaffected. It moved because a backend needs it and a
// backend importing THIS file closes a cycle through the top-level await below
// — see `platform.mjs` for the measurement. Re-exported rather than relocated
// silently: `resolvePlatform` has been part of this module's surface since
// ADR-0024, and moving it out from under its callers would be a second defect
// to fix the first.
import { resolvePlatform, SDD_ENGINES } from './platform.mjs';
import { harnessAdapterUrl } from '../axes/lib/harness-adapter-url.mjs';
export { resolvePlatform, SDD_ENGINES };

/**
 * Resolves the active SDD engine.
 * Pure — takes env + envVars + config explicitly for testing.
 *
 * @param {{ env?: object, envVars?: object, config?: object }} [opts]
 * @returns {string}
 */
export function resolveEngine({ env = process.env, envVars = {}, config = {} } = {}) {
  const engineVal = env.SDD_ENGINE ?? envVars.SDD_ENGINE ?? config.engine;
  if (engineVal) return engineVal;

  // SDD_ENGINES (platform.mjs, issue #312 D2) is the ONE declaration of this
  // membership — reading it here, rather than holding a second inline copy,
  // is the whole point of the extraction. Behavior is unchanged: same two
  // names, same fallback.
  const harnessVal = env.SDD_HARNESS ?? envVars.SDD_HARNESS ?? config.harness;
  if (harnessVal && SDD_ENGINES.includes(harnessVal)) {
    return harnessVal;
  }

  return 'gentle-ai';
}

// `resolveMemory` was here and is REMOVED (issue #1165): it was exported, dead (memory/cli.mjs
// re-read the env on its own), and wrong — it read `config.memory` as a string when that key is an
// object, and it defaulted to 'engram'. The memory backend has ONE resolver now:
// memory/lib/backend-resolve.mjs, built on lib/axis-selector.mjs (the shape #1114 generalises).

/**
 * Resolves the active harness name (legacy backwards compatibility).
 *
 * @param {{ env?: object, envVars?: object, config?: object }} [opts]
 * @returns {string}
 */
export function resolveHarness({ env = process.env, envVars = {}, config = {} } = {}) {
  return env.SDD_HARNESS ?? envVars.SDD_HARNESS ?? config.harness ?? resolveEngine({ env, envVars, config });
}

// ---------------------------------------------------------------------------
// Valid ops
// ---------------------------------------------------------------------------
// `run-stage` is ADDITIVE, and ADR-0019's SECOND rejected alternative is the
// authority — the one never cited in this discussion:
//
//   > "Treat the single-`init`-op surface as the normative ceiling. REJECTED: it
//   >  would force a future legitimate surface op … the four surfaces are the
//   >  invariant, THE OP COUNT IS JUST TODAY'S STATE."
//
// So growing this list needs no amendment. What ADR-0019 forbids is the SDD
// artifact LIFECYCLE forking per harness, and `assertRoutableStage` refuses that
// case in code rather than promising it in a comment (#682 slice B, ADR-0033).
// ── ONE DECLARATION, TWO SURFACES (#682, judgment:cold-5) ───────────────────
//
// `dispatch()` is reached two ways and they are NOT the same surface:
//
//   programmatically — `stage-seam.mjs` calls `dispatch(engine, 'run-stage',
//                      [{stage, prompt, model, cwd, credentialEnv}])`, ONE
//                      options object, and READS the `{ok, reason}` it returns.
//   from argv        — this file's `isMain` block, written when `init` was the
//                      only op: `process.argv.slice(3)`, raw strings, result
//                      discarded, and the op run on BOTH axes.
//
// `run-stage` was in one list, so adding it to `dispatch` published it on the
// command line too. MEASURED on the shipped tree:
//
//   $ node harness/cli.mjs run-stage cold-review "review the diff"
//   → exit 0, no output
//
// `dispatch` spreads its args, so the backend got `runStage('cold-review',
// 'review the diff')` — two positionals where the contract is one object.
// Destructuring a STRING yields `undefined` for every field, `runStage`
// returned `{ok: false, reason: 'no prompt for stage "undefined" …'}`, and the
// entry point threw the answer away. **You ask it to run a stage, it does not
// run one, and it reports success in silence.** That is #552's fold — "it
// broke" collapsed into "there was nothing to do" — in the entry point of the
// very op this slice added to prevent it.
//
// THE FIX IS THE SURFACE, NOT THE PARSING. There is no coherent argv spelling
// for this op: its payload is a PROMPT built by `assembleReviewPrompt()` from
// the reader's own constants, plus a cwd and a credential scrub-list. A human
// typing it would have to paste a generated document as a shell argument. The
// op is not a CLI op and never was — it leaked onto the command line because
// one list served both readers.
//
// So the classification lives with the op instead of in a second list that
// could drift from the first. Adding an op means answering `cli:` for it;
// there is no default, and no list to forget to update.
const OPS = Object.freeze([
  { name: 'init', cli: true },
  { name: 'run-stage', cli: false },
]);

/** Every op `dispatch()` accepts — the programmatic surface. */
export const VALID_OPS = OPS.map((o) => o.name);

/** The subset the argv entry point exposes. Derived, never respelled. */
export const CLI_OPS = OPS.filter((o) => o.cli).map((o) => o.name);

// Normalize hyphenated op to camelCase function name.
// e.g. 'feature-checkpoint' → 'featureCheckpoint'
const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Backend loader (injectable seam for testing)
// ---------------------------------------------------------------------------
async function defaultBackendLoader(harness) {
  const url = harnessAdapterUrl(harness);
  try {
    return await import(url);
  } catch (err) {
    throw new Error(
      `harness/cli: backend '${harness}' not found at ${url.pathname} — ${err.message}`,
    );
  }
}

/**
 * Dispatch an op to the resolved harness backend.
 *
 * @param {string} harness       The harness name (e.g. 'gentle-ai').
 * @param {string} op            The operation to run (e.g. 'init').
 * @param {string[]} [args]      Extra positional args forwarded to the backend function.
 * @param {{ backendLoader?: (harness: string) => Promise<object> }} [opts]
 *   Injectable backend factory — defaults to a real ESM dynamic import.
 *   Tests pass in a fake loader to avoid touching real backends.
 * @returns {Promise<*>} whatever the backend's op returned.
 * @throws {Error} if the op is unknown, the backend is not found, or the
 *   backend does not implement the requested op.
 *
 * THE RESULT IS RETURNED, and until #682 slice B.6 it was DISCARDED — the line
 * was `await backend[fn](...args);` with `@returns {Promise<void>}` beside it.
 * That was harmless while `init` was the only op: `init` answers nothing, so
 * there was nothing to drop. B.3 added `run-stage`, whose entire purpose is its
 * `{ok, reason}` answer, and the dispatcher swallowed it — a failed engine
 * reached the caller as `undefined`.
 *
 * Reproduced before fixing: a backend returning
 * `{ok: false, reason: 'the engine exited with status 137'}` came back from
 * `dispatch` as `undefined`, while calling the backend directly returned the
 * object. Same shape as #734, where `runSingle` discards `archiveChange`'s
 * return value and reports a fusion it did not perform — a caller that drops an
 * answer nobody notices is missing, because the absent value reads as a quiet
 * success.
 */
export async function dispatch(harness, op, args = [], { backendLoader = defaultBackendLoader } = {}) {
  if (!VALID_OPS.includes(op)) {
    throw new Error(
      `harness/cli: unknown op '${op}'. Valid ops: ${VALID_OPS.join(', ')}`,
    );
  }

  const fn = kebabToCamel(op);
  const backend = await backendLoader(harness);

  if (typeof backend[fn] !== 'function') {
    throw new Error(
      `harness/cli: backend '${harness}' does not implement op '${op}'`,
    );
  }

  return await backend[fn](...args);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const envVars = readEnvFile();
  const platform = resolvePlatform({ env: process.env, envVars });
  const engine = resolveEngine({ env: process.env, envVars });

  const op = process.argv[2];
  if (!op) {
    console.error(`harness/cli: missing <op>. Valid ops: ${CLI_OPS.join(', ')}`);
    process.exit(1);
  }

  // CLI_OPS, NOT VALID_OPS — see the OPS table above. A programmatic op named
  // here gets its own refusal rather than the generic one, because "unknown op"
  // about an op that plainly exists sends the reader looking for a typo.
  if (!CLI_OPS.includes(op)) {
    const known = VALID_OPS.includes(op);
    console.error(
      known
        ? `harness/cli: '${op}' is not a command-line op. It is dispatched programmatically ` +
          `(brain/scripts/harness/stage-seam.mjs) because its payload is a generated prompt, ` +
          `not something argv can carry. Command-line ops: ${CLI_OPS.join(', ')}`
        : `harness/cli: unknown op '${op}'. Valid ops: ${CLI_OPS.join(', ')}`,
    );
    process.exit(1);
  }

  try {
    // THE ANSWER IS READ, and today nothing answers. `init` returns undefined,
    // so this branch is unreachable on the shipped tree — stated plainly rather
    // than left to look like a tested path. It is here because the alternative
    // is a discard that becomes wrong SILENTLY the day a command-line op starts
    // answering, which is exactly how `run-stage` shipped broken: `dispatch`
    // itself discarded its result for as long as `init` was the only op, and
    // that was harmless right up until it was not.
    //
    // `undefined` stays success. Only an explicit `{ok: false}` is a failure —
    // an op that answers nothing has not failed at anything.
    const results = [await dispatch(platform, op, process.argv.slice(3))];
    if (engine !== platform) {
      // BOTH AXES, deliberately, and only `init` reaches here now. A repo can
      // declare a platform and an engine separately (ADR-0024), and `init` must
      // land in both: that is what makes a repo running `antigravity` + a
      // `gentle-ai` engine get both harnesses configured from one command.
      results.push(await dispatch(engine, op, process.argv.slice(3)));
    }

    const failed = results.find((r) => r && r.ok === false);
    if (failed) {
      console.error(`harness/cli: ${op}() failed — ${failed.reason ?? 'no reason given'}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`harness/cli: ${op}() failed — ${err.message}`);
    process.exit(1);
  }
}
