// brain/scripts/memory/lib/ship-invoker.mjs — the pure decision behind
// `cli.mjs ship`'s invoker guard (#1012, design.md's Interfaces/Contracts
// section). Mirrors `lib/backend-selection.mjs`'s shape: a pure decision
// module a CLI dispatcher consumes, with no I/O of its own, so the full
// branch matrix is cheap to test in process without spawning anything.
//
// ── Why this exists ─────────────────────────────────────────────────────
//
// #1007: `npm test` pushed a real lane ref and opened a real pull request.
// `ship` reached its VCS port because nothing on the call path checked WHO
// was calling — a test spawning the CLI directly looked identical to a
// human running it by hand. This guard makes the caller declare itself
// before any credential read or VCS call, and refuses a test-runner
// process independent of that declaration (REQ-SHIP-1, REQ-SHIP-2).
//
// ── Check order (load-bearing) ─────────────────────────────────────────
//
//   (1) argv syntax  — a malformed --invoker is refused REGARDLESS of what
//       follows. A malformed marker is a bug in the CALLER's own code
//       (session-end-ship.mjs, day-start-sweep.mjs, or a hand-typed
//       command), and refusing it even under a seam means the seam-level
//       and e2e tests — which all run bypassed — still catch a mangled
//       marker instead of silently passing it through.
//   (2) bypass       — BRAIN_VCS_TEST_MODULE's PRESENCE (not truthiness)
//       or --dry-run excuses a MISSING marker, never a malformed one (see
//       (1)). Presence, not truthiness, so the blank-seam refusal that
//       lives downstream in cli.mjs stays reachable — a blank value is
//       still "present" here and gets excused at this layer, then refused
//       at the next.
//   (3) NODE_TEST_CONTEXT — refused independent of a valid --invoker. This
//       is what catches a test that spawns the CLI WITHOUT a seam but WITH
//       a syntactically valid marker — the marker alone is not proof of a
//       legitimate caller.
//   (4) presence      — no marker, no bypass, no test context: refused as
//       a plain missing invoker.

/** The three declared invokers a caller may claim. Order is stable, used
 * only for iteration/messages — never for precedence. */
export const INVOKERS = Object.freeze(['hook', 'sweep', 'manual']);

/** The three refusal keys this module can return, matching the
 * `memory.ship.*` i18n catalog entries cli.mjs resolves them against. */
export const REFUSAL = Object.freeze({
  MISSING: 'invokerMissing',
  UNDER_TEST: 'invokerUnderTest',
  INVALID: 'invokerInvalid',
});

/** Parses `--invoker <value>` out of an argv array. Only the two-token
 * form is accepted — `--invoker=value` is always invalid (matches the
 * `--supersedes`/`--since` precedent cli.mjs already uses elsewhere: no
 * `=` form, last-value-wins is rejected in favor of failing closed on any
 * repeat). Returns `{ value, invalid, token }`: `value` is the accepted
 * invoker or `null`; `invalid` is true for any malformed form (missing
 * value, a value that looks like another flag, an unrecognized value, or
 * a repeated flag); `token` is the best-effort rejected value, echoed by
 * the invokerInvalid message.
 *
 * @param {string[]} args
 */
function parseInvoker(args) {
  let value = null;
  let invalid = false;
  let token = '';
  let occurrences = 0;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--invoker') {
      occurrences += 1;
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        invalid = true;
        token = next ?? '';
        continue;
      }
      i += 1; // consume the value token
      if (!INVOKERS.includes(next)) {
        invalid = true;
      }
      token = next;
      value = INVOKERS.includes(next) ? next : null;
    } else if (arg.startsWith('--invoker=')) {
      occurrences += 1;
      invalid = true;
      token = arg.slice('--invoker='.length);
    }
  }

  if (occurrences > 1) {
    return { value: null, invalid: true, token };
  }
  return { value, invalid, token };
}

/**
 * decideShipInvoker — the pure decision `cli.mjs`'s `ship` op consumes.
 *
 * @param {object} params
 * @param {string[]} [params.args]   `process.argv.slice(3)` — the ship op's
 *                                    own remaining argv.
 * @param {Record<string,string|undefined>} [params.env]   `process.env`.
 * @returns {{allowed: true, invoker: 'hook'|'sweep'|'manual'|null, bypass: 'vcs-test-module'|'dry-run'|null}
 *          |{allowed: false, key: 'invokerInvalid'|'invokerUnderTest'|'invokerMissing', params: object}}
 */
export function decideShipInvoker({ args = [], env = {} } = {}) {
  const parsed = parseInvoker(args);

  // (1) argv syntax — refused before anything else considers a bypass.
  if (parsed.invalid) {
    return { allowed: false, key: REFUSAL.INVALID, params: { value: parsed.token ?? '' } };
  }

  // (2) bypass — presence, not truthiness (see module doc comment).
  const bypass = env.BRAIN_VCS_TEST_MODULE !== undefined
    ? 'vcs-test-module'
    : args.includes('--dry-run')
      ? 'dry-run'
      : null;
  if (bypass !== null) {
    return { allowed: true, invoker: parsed.value, bypass };
  }

  // (3) NODE_TEST_CONTEXT — refused independent of a valid --invoker.
  if (env.NODE_TEST_CONTEXT !== undefined) {
    return { allowed: false, key: REFUSAL.UNDER_TEST, params: {} };
  }

  // (4) presence.
  if (parsed.value === null) {
    return { allowed: false, key: REFUSAL.MISSING, params: {} };
  }

  return { allowed: true, invoker: parsed.value, bypass: null };
}
