// producer-forge-reach.mjs — can the producer still reach the forge AFTER the
// environment scrub? (#682 slice 3, judgment:cold-1 of the THIRD cold review.)
//
// THE DEFECT THIS CLOSES. `credential-env.mjs` removes brain's poster
// credential from the child's environment, and that is real: `spawnSync` hands
// the child an explicit `env` and the kernel does not consult it. But the
// reviewer measured the obvious next thing and it was open — with every name
// `credentialEnvNames()` returns unset, `gh auth status` still reported `Logged in to github.com account
// csrinaldi (keyring)`, scope `repo`. A forge CLI keeps its own store outside
// the repository, so neither the scrub nor the detached worktree touches it, and
// the producer holds a shell.
//
// ── WHY THIS PROBES INSTEAD OF ASSERTING, WHICH IS THE WHOLE DESIGN ─────────
//
// Three earlier shapes for this fix were designed and discarded, each for a
// reason worth keeping so nobody re-proposes one:
//
//   1. Relocate the engine's config dir via its vendor env var. That names ONE
//      vendor, and ADR-0005 makes brain harness-agnostic — claude, antigravity,
//      opencode, codex.
//   2. Spawn the engine with a tool-restriction flag. Same objection one layer
//      down: the flag's vocabulary is one vendor's, and putting it in `sdd.map`
//      leaks a backend detail into the router. It is also enforced by the engine
//      honouring its own flag — brain can prove it ASKED, never that the engine
//      OBEYED.
//   3. Build the producer a synthetic `$HOME` carrying an allowlist of the
//      engine's own paths. The premise is TRUE — every engine roots a global
//      credential under `$HOME` (`~/.claude`, `~/.codex`, `~/.antigravity`,
//      `~/.opencode`) — and the design is still wrong, because a backend author
//      cannot know the DEPLOYMENT. Measured: the same engine under a synthetic
//      `$HOME` is denied on the operator's Linux box (its credential is
//      `~/.claude/.credentials.json`) and authenticates fine in a remote
//      container (no such file; the credential arrives by environment and an
//      inherited descriptor). The same descriptor would be correct on one and
//      inert on the other — removing nothing while reporting that it did.
//
// All three answer "WHERE does the credential live", which is a property of the
// deployment and is not knowable from here. This module asks the question that
// IS answerable — "after the scrub, does a forge CLI still authenticate from
// this environment?" — and refuses when the answer is yes. That inverts the
// failure: an isolation nobody can see failing is worse than none, because the
// ADR then asserts a property no reader checks.
//
// ── WHAT IT DOES NOT CLAIM, SAID OUT LOUD ──────────────────────────────────
//
// The producer holds a shell. A credential this module cannot name, read by a
// tool it cannot enumerate, is not closed here and is NOT claimed to be —
// `curl` against a `~/.netrc`, a git credential helper, an SDK reading a vendor
// file. Enumerating that is the open namespace `credential-env.mjs` refuses to
// pretend it can bound, and the honest scope is the forge CLIs brain itself
// names. ADR-0033's table says which channel carries which warrant.
//
// The AMBIENT channel (#604) is deliberately NOT probed here, and that is an
// ordering fact rather than an omission: `gatherIdentity` runs at `cli.mjs:316`
// and the stage spawns at `cli.mjs:628`, so a proxy-injected environment has
// already refused the whole run before this module is reached. Probing it again
// would be a second reader for a closed channel while the open one went
// unwatched — which is the shape this file exists to remove.
//
// ── THE FORGE CLIS ARE brain'S KNOWLEDGE, NOT THE ENGINE'S ─────────────────
//
// Naming `gh` and `glab` here does not breach ADR-0005. The forge is brain's own
// axis — `FORGE_TOKEN_ENV` in `credential-env.mjs` is a literal for exactly this
// reason, and `github.mjs` already depends on `gh`'s precedence rules. What
// ADR-0005 forbids is brain knowing which AGENT it spawns. This module never
// mentions one.

import { defaultRun } from '../axes/lib/agent-runtime.mjs';

/**
 * How long one probe may take. The forge CLIs answer locally — `auth status`
 * reads a config file and may make one cheap round trip — but this runs on the
 * path to a ten-minute engine spawn, and a probe that hangs would convert a
 * refusal into a hang. A timeout is `indeterminate`, which REFUSES.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * The forge CLIs brain names, as data. `auth status` exits 0 when a session
 * exists and non-zero when none does, on both.
 */
export const FORGE_CLIS = Object.freeze([
  Object.freeze({ name: 'gh', bin: 'gh', args: ['auth', 'status'], configDirEnv: 'GH_CONFIG_DIR' }),
  Object.freeze({ name: 'glab', bin: 'glab', args: ['auth', 'status'], configDirEnv: 'GLAB_CONFIG_DIR' }),
]);

/**
 * withForgeConfigDir() — a PLAIN COPY of `env` with every named forge CLI's own
 * config directory pointed at `dir`. Pure. Issue #775.
 *
 * WHY THIS IS NOT THE `$HOME` DESIGN THIS MODULE ALREADY REJECTED. Rejected
 * shape 3 above builds a synthetic `$HOME` carrying an allowlist of the ENGINE's
 * credential paths, and fails because a backend author cannot know the
 * deployment. This names two variables belonging to the two forge CLIs brain
 * itself declares — the same axis argument that lets `FORGE_CLIS` name `gh` and
 * `glab` at all. No engine vendor appears here, so ADR-0005 is untouched.
 *
 * WHAT IT BUYS, MEASURED 2026-08-27 on a logged-in machine. `gh auth status`
 * reported `csrinaldi (keyring)` while `~/.config/gh/hosts.yml` held NO token —
 * only the host→user mapping. With the config dir shadowed, `gh` no longer knows
 * github.com exists, so it never asks the keyring: the probe went from
 * `reachable` to `closed` and the operator's keyring was never touched.
 *
 * WHAT IT DOES NOT BUY, and this belongs in the caller's refusal rather than in
 * a comment nobody reads:
 *
 *   - The secret is still in the keyring. This makes the CLI unable to FIND it.
 *     A tool reading libsecret directly, a `~/.netrc`, or a git credential
 *     helper is the open namespace `credential-env.mjs` declines to bound.
 *   - It is complementary to the scrub, never a replacement. `GH_TOKEN` in the
 *     environment authenticates `gh` whatever the config dir says; what removes
 *     that is `withoutCredentials`. Two mechanisms, one property.
 *   - It is measured on ONE deployment. `gh` keeping the host mapping in the
 *     config dir is what makes this work, and that is a probe result rather than
 *     a contract. Which is why the probe REMAINS the reader: this function
 *     changes what is measured, never whether it is.
 *
 * A BLANK DIRECTORY THROWS. The alternative — return the env unchanged — hands
 * the producer the operator's real config dir while every caller believes it is
 * shadowed, which is the "declared oracle with no reader" shape this whole
 * module exists to remove.
 *
 * @param {object} env
 * @param {string} dir Absolute path to a per-run, disposable directory.
 * @returns {object}
 */
export function withForgeConfigDir(env, dir) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new Error(
      'producer-forge-reach: a per-run forge config directory is required. ' +
      'Refusing to return the environment unshadowed — a caller that believes the ' +
      'forge CLIs are pointed at an empty directory when they are not is worse than one ' +
      'that knows they are not.'
    );
  }
  const out = { ...env };
  for (const cli of FORGE_CLIS) out[cli.configDirEnv] = dir;
  return out;
}

/**
 * Per-CLI facts. Four, and they stay four: a reader that answers the same thing
 * to "it is not installed" and "it would not tell me" reports a silence it never
 * measured — the mistake #614 removed from `agent-runtime.mjs`.
 */
export const CLI_STATES = Object.freeze([
  'absent',          // the binary is not installed — this CLI cannot reach anything
  'unauthenticated', // installed, and it says it holds no session
  'authenticated',   // installed, and it holds one — the producer could post
  'unreadable',      // installed, and it did not reach a verdict (timeout, EACCES)
]);

/** Overall verdicts. Only `closed` permits a spawn. */
export const REACH_STATES = Object.freeze(['closed', 'reachable', 'indeterminate']);

/** Short, non-empty description of why a probe produced no verdict. */
function detailOf(result) {
  const parts = [
    result?.error?.message,
    String(result?.stderr ?? '').trim(),
    String(result?.stdout ?? '').trim(),
  ].filter(Boolean);
  return parts.join(' — ').split('\n')[0] || `exited with status ${result?.status ?? 'unknown'}`;
}

/**
 * probeForgeCli() — reads ONE forge CLI's authentication state in a given
 * environment. Never throws.
 *
 * Only ENOENT means "not installed", and it is the CODE that says so rather
 * than the message — `spawnSync` also sets `error` for ETIMEDOUT and EACCES,
 * both of which describe a binary that IS there. Reading `error` alone told an
 * operator behind a proxy to install a CLI they already had (#614); here the
 * same conflation would be worse, because it would report a channel closed on
 * the strength of a probe that never ran.
 *
 * @param {{name: string, bin: string, args: string[]}} cli
 * @param {object} env The env the PRODUCER would get — post-scrub, not brain's.
 * @param {{_run?: Function, timeoutMs?: number}} [opts]
 * @returns {{cli: string, state: string, detail: string|null}}
 */
export function probeForgeCli(cli, env, { _run = defaultRun, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = _run(cli.bin, cli.args ?? [], { env, timeoutMs });
  } catch (err) {
    return { cli: cli.name, state: 'unreadable', detail: err.message };
  }

  if (result?.error) {
    if (result.error.code === 'ENOENT') {
      return { cli: cli.name, state: 'absent', detail: null };
    }
    return { cli: cli.name, state: 'unreadable', detail: detailOf(result) };
  }

  // Exit 0 from `auth status` means a session exists. That is the whole signal,
  // and it is deliberately not read out of the human-facing text: the wording
  // ("Logged in to github.com account …") is not a contract and changes between
  // releases, while the exit code is what the CLIs document.
  if (result?.status === 0) {
    return { cli: cli.name, state: 'authenticated', detail: detailOf(result) };
  }
  return { cli: cli.name, state: 'unauthenticated', detail: null };
}

/**
 * evaluateForgeReach() — folds per-CLI facts into one verdict. PURE.
 *
 * FAIL-CLOSED ORDERING, and the order is the point:
 *
 *   any `authenticated`  → `reachable`      REFUSE — measured open
 *   any `unreadable`     → `indeterminate`  REFUSE — "I could not look" is not
 *                                           "there is nothing there"
 *   otherwise            → `closed`         proceed
 *
 * `reachable` is tested before `indeterminate` so a run where one CLI is
 * authenticated and another timed out is reported as what it definitely is,
 * with the stronger, actionable reason, rather than as an inconclusive probe.
 *
 * An EMPTY probe list is `indeterminate`, never `closed`. A caller that passes
 * nothing has measured nothing, and returning "closed" there would manufacture
 * the exact false clearance this module exists to prevent.
 *
 * @param {Array<{cli: string, state: string, detail: string|null}>} results
 * @returns {{state: string, ok: boolean, reason: string|null, results: Array}}
 */
export function evaluateForgeReach(results) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) {
    return {
      state: 'indeterminate',
      ok: false,
      reason: 'no forge CLI was probed — nothing was measured, so nothing is cleared',
      results: list,
    };
  }

  const authenticated = list.filter((r) => r?.state === 'authenticated');
  if (authenticated.length > 0) {
    const names = authenticated.map((r) => r.cli).join(', ');
    return {
      state: 'reachable',
      ok: false,
      reason:
        `${names} still authenticates from the producer's environment, so scrubbing the ` +
        `credential env vars did not take the forge away from it. The credential is in that ` +
        `CLI's own store (its config dir plus the OS keyring), which no worktree and no env ` +
        `scrub touches. Log it out for this environment, or route the stage to a run where it ` +
        `holds no session.`,
      results: list,
    };
  }

  const unreadable = list.filter((r) => r?.state === 'unreadable');
  if (unreadable.length > 0) {
    const detail = unreadable.map((r) => `${r.cli}: ${r.detail ?? 'no detail'}`).join('; ');
    return {
      state: 'indeterminate',
      ok: false,
      reason:
        `a forge-CLI probe reached no verdict (${detail}). Refusing rather than spawning: ` +
        `"could not look" is not "nothing is there", and this check exists because the ` +
        `property it guards was previously asserted without one.`,
      results: list,
    };
  }

  return { state: 'closed', ok: true, reason: null, results: list };
}

/**
 * assertProducerCannotReachForge() — the whole check, as one call.
 *
 * @param {object} env The env the producer would be spawned with (post-scrub).
 * @param {{_run?: Function, clis?: Array, timeoutMs?: number}} [opts]
 * @returns {{state: string, ok: boolean, reason: string|null, results: Array}}
 */
export function assertProducerCannotReachForge(env, { _run = defaultRun, clis = FORGE_CLIS, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const results = (clis ?? []).map((cli) => probeForgeCli(cli, env, { _run, timeoutMs }));
  return evaluateForgeReach(results);
}
