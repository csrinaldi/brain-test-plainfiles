// credential-env.mjs — WHICH env vars a spawned producer may not inherit
// (#682 slice 3, judgment:cold-2 of the second cold review on `02ca619`).
//
// THE DEFECT THIS CLOSES. `claude.mjs`'s `runStage` docstring says, in capitals:
// "IT HOLDS NO VCS CREDENTIAL AND POSTS NOTHING", and ADR-0033 makes that the
// producer's load-bearing property — the whole reason a producer may be an
// arbitrary engine is that it cannot reach the pull request. Nothing enforced
// it. `defaultRun` called `spawnSync` with no `env` key, so the child inherited
// `process.env` WHOLE, and the only thing standing between the producer and the
// reviewer's credential was one sentence of prompt text ("You hold no credential
// and the review is not yours to publish"). MEASURED, before the fix:
//
//   BRAIN_REVIEWER_TOKEN=SECRET_ABC GH_TOKEN=SECRET_GH node -e '…defaultRun…'
//   → el hijo vio: {"t":"SECRET_ABC","g":"SECRET_GH"}
//
// That is the ticket's recurring shape once more — a declared oracle with no
// reader — committed by the claim itself. The comment is now the thing this
// module keeps true.
//
// ── WHAT "HOLDS NO CREDENTIAL" CAN MEAN, PRECISELY ──────────────────────────
//
// The producer necessarily holds ONE credential: the engine's own. It cannot
// run otherwise — `claude` authenticates before it reads a diff. So the
// property is not "the child's environment is empty of secrets"; it is
// "the child cannot authenticate AS BRAIN'S POSTER". That set is CLOSED and
// knowable, which is what makes a denylist an honest oracle here rather than a
// guess over an open namespace: it is exactly the env var names brain's own
// posting path reads.
//
// AN ALLOWLIST WAS THE OTHER CANDIDATE AND IS WORSE, for a reason that is about
// oracles rather than taste. Fail-closed on the credential axis, yes — but brain
// would have to enumerate the auth, proxy, CA-bundle, HOME and XDG variables an
// ARBITRARY third-party engine needs, with nothing able to check the list. That
// is a declared oracle with no reader pointed the other way: brain asserting it
// knows an engine's requirements. The first consumer whose engine needs a
// variable brain did not guess gets a refusal brain cannot explain.
//
// ── WHAT THIS DOES NOT CLOSE, SAID OUT LOUD ─────────────────────────────────
//
// 1. #604's AMBIENT channel. Where a proxy injects credentials into every call
//    to the forge, an empty environment authenticates just as well as a full
//    one — that is the whole finding: an invented token, an empty token and NO
//    token resolved to the same login. Scrubbing the environment does nothing
//    about it and this module must not be read as if it did. `identity.mjs`'s
//    negative control is what measures that channel; nothing here replaces it.
// 2. REPO-LOCAL CREDENTIALS ON DISK, AND ONLY THOSE. `.env` holds `VCS_TOKEN`
//    (token.mjs), and an engine told to "read anything in the repository" can
//    read a file. What keeps THAT shut is judgment:cold-3's fix, not this one:
//    the producer runs in a detached worktree at the PR head, where a
//    gitignored `.env` does not exist. Two mechanisms, one property — worth
//    knowing which is which before changing either.
//
//    THAT RAISES THE COST; IT DOES NOT CLOSE THE CHANNEL, and this note said
//    otherwise until the fifth cold review measured it FROM INSIDE the producer:
//    `cwd` is not a confinement — `spawnSync` sets a working directory and
//    nothing else, and the prompt hands the producer an ABSOLUTE path outside
//    the worktree because that is how the artifact gets written. `test -f
//    <operator tree>/.env` returned TRUE from the producer. ADR-0033's table
//    now carries this as `by cost, not by construction`, with the two things
//    that would close it named there.
//
//    THIS HEADING ONCE READ "CREDENTIALS ON DISK" AND THE PARAGRAPH PROVED LESS
//    THAN THE HEADING PROMISED — the third cold review's blocker, and the
//    ticket's own defect class committed inside the fix written to remove one
//    instance of it. A credential STORE outside the repository is on disk too
//    and no worktree touches it: `~/.config/gh` plus the OS keyring, and the
//    engine's own credential wherever its vendor roots it. Measured with all
//    every name in `credentialEnvNames()` unset, `gh auth status` still reported
//    a logged-in account. Stated as the DERIVED set rather than a count: this
//    line said "all seven" and the list holds eight (judgment:cold-5, third
//    cold review), and a stale measurement reads exactly like a current one.
//    `credential-env.test.mjs` now pins the count so the next name added fails
//    a test instead of quietly falsifying a sentence.
//    Closing that channel is `producer-forge-reach.mjs`, which probes it rather
//    than asserting it — because WHERE a credential lives is a property of the
//    DEPLOYMENT, not of the engine (see the slice tracker's F.8: the same engine
//    under a synthetic `$HOME` is denied on one machine and authenticates on
//    another), so nothing here may assume a location.
//
// 3. AN OPEN NAMESPACE, WHICH NOTHING HERE CLAIMS. The producer holds a shell.
//    A credential this module cannot name, read by a tool it cannot enumerate,
//    is not closed by anything in this file and is not claimed to be.
//
// ── DERIVED WHERE THERE IS A SOURCE, LITERAL WHERE THERE IS NOT ─────────────
//
// `REVIEWER_TOKEN_ENV` and `tokenEnvVar()` are the names brain ITSELF reads to
// authenticate, so they are taken from the modules that read them rather than
// respelled here — `identity.mjs` re-exports the first as its `DEFAULT_TOKEN_ENV`
// and `token.mjs` owns the second. Rename either and the scrub follows.
//
// `FORGE_TOKEN_ENV` has no such source and is an honest literal. These are the
// variables the FORGE CLIs read ambiently, not ones brain declares: `gh` gives
// `GH_TOKEN` precedence over its own keyring (github.mjs:63 depends on exactly
// that), and a producer holding one can post through `gh` without ever touching
// brain's config. Same treatment as `SEVERITIES` in assemble-review-prompt.mjs — a
// literal, labelled as one, rather than a constant nothing validates.

import { tokenEnvVar } from '../vcs/lib/token.mjs';

/**
 * The reviewer credential's env var NAME — the one thing `reviewer.tokenEnv`
 * defaults to. Owned here rather than in `identity.mjs` so the harness can
 * reach it without importing the review port (and without re-opening the ESM
 * cycle platform.mjs exists to keep shut). `identity.mjs` re-exports it under
 * its established name.
 */
export const REVIEWER_TOKEN_ENV = 'BRAIN_REVIEWER_TOKEN';

/**
 * The lane ship op's credential env var NAME (issue #888, D3/A5) — the name
 * `memory/lane/ship.mjs`'s caller reads to bind an unattended host's identity.
 * A LITERAL, labelled as one: there is no module this name is derived FROM
 * (unlike `REVIEWER_TOKEN_ENV`/`tokenEnvVar()` above) — the `ship` op is the
 * one and only reader, so this constant IS the source, exported here so the
 * denylist and the op agree on the same name by construction rather than by
 * two independently spelled literals drifting apart.
 */
export const MEMORY_TOKEN_ENV = 'BRAIN_MEMORY_TOKEN';

/**
 * Forge-CLI credentials — a LITERAL, and labelled as one. See the header: these
 * are read by `gh`/`glab`, not declared by brain, so there is no constant to
 * derive them from and inventing one would be the defect this file avoids.
 */
export const FORGE_TOKEN_ENV = Object.freeze([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITLAB_TOKEN',
  'CI_JOB_TOKEN',
]);

/**
 * credentialEnvNames() — every env var name a spawned producer must not inherit.
 *
 * `extra` is how a repo's CONFIGURED `reviewer.tokenEnv` gets in: this layer
 * cannot read `brain.config.json` (`loadBrainConfig` resolves `CONFIG_PATH`
 * from the MODULE's location, which in a consumer is inside `node_modules`),
 * so the caller that holds the config widens the set. Absent, the default
 * still covers the default name — the caller can only widen, never narrow.
 *
 * @param {{extra?: Array<string|null|undefined>}} [opts]
 * @returns {string[]}
 */
export function credentialEnvNames({ extra = [] } = {}) {
  const names = [REVIEWER_TOKEN_ENV, tokenEnvVar(), MEMORY_TOKEN_ENV, ...FORGE_TOKEN_ENV, ...extra];
  return [...new Set(names.filter((n) => typeof n === 'string' && n.trim() !== ''))];
}

/**
 * withoutCredentials() — a PLAIN COPY of `env` with those names removed. Pure.
 *
 * The copy is the point: `spawnSync` given an explicit `env` hands the child
 * exactly that object, so returning a reference to `process.env` would scrub
 * nothing and returning a partial object would strip the engine's PATH.
 *
 * Matching is CASE-INSENSITIVE. On Windows env var names are, so a child
 * spawned with an explicit `env` containing `Gh_Token` would read it as
 * `GH_TOKEN`; comparing case-sensitively would leave it in. Insensitivity can
 * only ever remove MORE, never less, so it is safe on POSIX too — where the
 * cost is a var deliberately named `gh_token` alongside `GH_TOKEN`, which is
 * not a configuration anyone has.
 *
 * @param {object} env
 * @param {string[]} names
 * @returns {object}
 */
export function withoutCredentials(env, names) {
  const drop = new Set(names.map((n) => String(n).toLowerCase()));
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (drop.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}
