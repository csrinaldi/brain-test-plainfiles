// identity.mjs — REQ-H1-1: fail-closed reviewer identity gate (protocol §11).
// Reads `reviewer: { handle, tokenEnv }` — config carries the env var NAME,
// never the token VALUE (issue #266 comment 4992662021). Absent
// `env[tokenEnv]` refuses to run before any server call: missing var,
// provider `patSetupUrl`, setup doc path. No silent degradation.
//
// Issue #413: the handle is additionally VERIFIED against the token — a
// `whoami({ token })` port read resolves who the token actually belongs to,
// and a disagreement with `reviewer.handle` refuses the run. Before this the
// handle was taken straight from config, so the §10 self-review abstention
// and the anti-loop lock both compared a CLAIMED identity: an author could
// review their own PR by pointing the token env var at their own token while
// config claimed a bot handle. A verification ERROR also refuses (§10
// "uncomputable evidence" discipline — never proceed on an unverified
// identity). An unset handle skips verification: there is nothing to compare
// against, and cli.mjs's #382 gate refuses that case with its own message.

import { loadBrainConfig } from '../lib/brain-config.mjs';
import { REVIEWER_TOKEN_ENV } from '../lib/credential-env.mjs';
import { getVcs } from '../vcs/cli.mjs';
import { gitlabApiConfig } from '../vcs/ci-context.mjs';

// Re-exported, not respelled: `credential-env.mjs` owns this name because the
// harness has to strip it from a producer's environment (judgment:cold-2) and
// cannot import the review port to learn it. One source, two readers.
export const DEFAULT_TOKEN_ENV = REVIEWER_TOKEN_ENV;
export const DEFAULT_SETUP_DOC_PATH = 'docs/reviewer-setup.md';

// ── The negative control (#604 half 1) ──────────────────────────────────────
//
// #413 made the handle VERIFIED rather than claimed. #604 measured that the
// verification itself can be ambient: behind a proxy that injects credentials
// into every `api.github.com` call, an invented token, an empty token and NO
// credential all resolve to the same authenticated login (HTTP 200,
// `csrinaldi`), reproduced in this repo's own cloud container. `whoami({ token })`
// then reports an identity the token did not establish, and a `reviewer.handle`
// set to that ambient login makes the check PASS on a credential never used.
//
// The control is a probe, not a fix: resolve identity with a token that is
// deliberately invalid FIRST. In an environment that honours credentials the
// probe is rejected; where it RESOLVES, the environment is answering for the
// caller and no token-scoped read from it can be trusted. Two API calls.
//
// It cannot be defeated by rotating a token, because it never uses a real one.
// It does not — and cannot — prove the reviewer is cold (that is §10/half 2);
// it proves only that the identity evidence is the token's own.
export const NEGATIVE_CONTROL_SENTINEL = 'ghp_brainNegativeControl0000NotARealToken';

// Only a RECOGNISED authentication rejection clears the control. An
// unrecognised failure is `unusable`, never `rejected`: a probe that cannot
// run to a verdict has established nothing, and scoring it as clean would
// rebuild the very defect this control exists to catch — a reader that on
// failure returns something indistinguishable from "nothing to report".
const AUTH_REJECTION = /\b401\b|bad credentials|unauthorized|requires authentication/i;

// The control's own blast radius, classified separately (#604 self-review F1).
//
// This control sends ONE deliberately-invalid credential per run, and repeated
// invalid attempts are exactly what providers throttle: GitHub answers a burst
// of them with `403 Maximum number of login attempts exceeded`, which then
// rejects VALID credentials too until the window expires.
//
// So the control can cause the condition that stops it working. Left inside
// `unusable`, that surfaced as "could not establish whether this environment
// honours the reviewer token" — which sends the operator hunting for a proxy
// that is not there. That is the same mis-diagnosis shape that cost three
// token rotations, re-introduced by the fix that exists to prevent it.
//
// It stays a REFUSAL: a lockout is not evidence the environment honours
// credentials. (It is suggestive — a credential-injecting proxy would never
// produce one, because the sentinel never reaches the provider AS an invalid
// credential — but inferring a clearance from a failure is precisely the
// inversion this control was built to remove.) What changes is that the
// operator is told what happened and what not to do about it.
const PROVIDER_LOCKOUT = /maximum number of login attempts|rate limit/i;

/** Pure core of the #604 control. Classifies one probe outcome:
 *  - `resolved` — an invalid token produced an identity → credentials are
 *    injected upstream; every token-scoped read here is ambient. REFUSE.
 *  - `rejected` — the provider refused the invalid token → the environment
 *    honours credentials. The control PASSES.
 *  - `lockout` — the provider is throttling authentication attempts, possibly
 *    because of this control. REFUSE, with its own message and remedy.
 *  - `unusable` — the probe failed for some other reason (binary missing,
 *    network, unparsed error). REFUSE, with its own message.
 *
 * `lockout` is tested BEFORE `rejected` so a message carrying both a status
 * code and throttling text can never be read as a plain auth rejection. */
export function evaluateNegativeControl({ resolved = null, error = null } = {}) {
  if (resolved) return { control: 'resolved', ambientAs: resolved };
  if (!error) return { control: 'unusable', reason: 'the probe returned no identity and no error' };
  if (PROVIDER_LOCKOUT.test(error)) return { control: 'lockout', reason: error };
  return AUTH_REJECTION.test(error)
    ? { control: 'rejected' }
    : { control: 'unusable', reason: error };
}

const PROVIDER_SCOPES = { github: ['repo'], gitlab: ['api'] }; // for the "get a token" link

/** Pure core: resolves identity from config + env, or reports exactly why it
 * cannot. Never touches the network — `patSetupUrl` is pre-resolved by the caller. */
export function evaluateIdentity({ reviewerConfig = {}, env = {}, patSetupUrl = null, setupDocPath = DEFAULT_SETUP_DOC_PATH } = {}) {
  const tokenEnv = reviewerConfig.tokenEnv || DEFAULT_TOKEN_ENV;
  const token = env[tokenEnv];
  if (!token) return { ok: false, missingVar: tokenEnv, patSetupUrl, setupDocPath };
  return { ok: true, handle: reviewerConfig.handle ?? null, token };
}

/** Pure core of the #413 check: does the token's REAL login match the
 * configured handle? Logins are case-insensitive on both providers, so the
 * comparison folds case — `CsRinaldiBot` and `csrinaldibot` are the same
 * account, and refusing on a case difference would be a false positive. */
export function evaluateVerifiedIdentity({ claimed, actual }) {
  if (!actual) return { verified: false, claimed, actual: actual ?? null };
  return String(claimed).toLowerCase() === String(actual).toLowerCase()
    ? { verified: true, actual }
    : { verified: false, claimed, actual };
}

async function defaultGetPatUrl({ host }) {
  const vcs = await getVcs();
  const scopes = PROVIDER_SCOPES[vcs.PROVIDER] ?? ['repo'];
  return vcs.patSetupUrl({ host, name: 'brain-reviewer', scopes });
}

// Default #413 verifier: the port's `whoami` scoped to the reviewer token.
// GitLab's token path runs over `gitlabApiFetch`, which needs the resolved
// apiBase/proxy — the same `gitlabApiConfig()` wiring cold-boot.mjs uses for
// `prReviews`; GitHub needs only the token (GH_TOKEN precedence).
async function defaultWhoami({ token }) {
  const vcs = await getVcs();
  if (vcs.PROVIDER === 'gitlab') {
    const { apiBase, proxyUrl } = gitlabApiConfig();
    return vcs.whoami({ token, apiBase, proxyUrl });
  }
  return vcs.whoami({ token });
}

/** Gathers evaluateIdentity()'s inputs from config + env (or injected `deps`
 * in tests). `getPatUrl` runs ONLY on the failure path; `whoami` runs ONLY
 * when a token AND a handle are both present (the #413 verification). */
export async function gatherIdentity({ deps = {} } = {}) {
  const readConfig = deps.readConfig ?? (() => loadBrainConfig().reviewer ?? {});
  const readEnv = deps.readEnv ?? (() => process.env);
  const getPatUrl = deps.getPatUrl ?? defaultGetPatUrl;
  const whoami = deps.whoami ?? defaultWhoami;
  const setupDocPath = deps.setupDocPath ?? DEFAULT_SETUP_DOC_PATH;

  const reviewerConfig = readConfig() ?? {};
  const env = readEnv();
  const tokenEnv = reviewerConfig.tokenEnv || DEFAULT_TOKEN_ENV;
  if (!env[tokenEnv]) {
    const host = deps.host ?? loadBrainConfig().project?.gitHost ?? 'github.com';
    const patSetupUrl = await getPatUrl({ host });
    return evaluateIdentity({ reviewerConfig, env, patSetupUrl, setupDocPath });
  }

  const identity = evaluateIdentity({ reviewerConfig, env, setupDocPath });

  // #413 verification — only with a handle to compare against; an unset
  // handle is cli.mjs's #382 refusal, not a verification question.
  if (!identity.handle) return identity;

  // #604 negative control — runs BEFORE the real verification, because its
  // question is whether the verification's ANSWER can mean anything. Ordered
  // first so a proxy-injected environment is named as such rather than
  // surfacing as a `mismatch`, which sent the maintainer through three token
  // rotations chasing a refusal no rotation could have fixed.
  let control;
  try {
    const { username } = await whoami({ token: NEGATIVE_CONTROL_SENTINEL });
    control = evaluateNegativeControl({ resolved: username ?? null });
  } catch (err) {
    control = evaluateNegativeControl({ error: err.message });
  }
  if (control.control === 'resolved') {
    return { ok: false, ambientIdentity: control.ambientAs, tokenEnv, setupDocPath };
  }
  if (control.control === 'lockout') {
    return { ok: false, controlLockout: control.reason, tokenEnv, setupDocPath };
  }
  if (control.control === 'unusable') {
    return { ok: false, controlError: control.reason, tokenEnv, setupDocPath };
  }

  let actual;
  try {
    ({ username: actual } = await whoami({ token: identity.token }));
  } catch (err) {
    return { ok: false, verifyError: err.message, tokenEnv, setupDocPath };
  }

  const check = evaluateVerifiedIdentity({ claimed: identity.handle, actual });
  if (!check.verified) {
    return { ok: false, mismatch: { claimed: identity.handle, actual: check.actual }, tokenEnv, setupDocPath };
  }
  return { ...identity, verifiedAs: check.actual };
}

// Runs the gate and prints the fail-closed instructions. Never throws.
export async function main(deps = {}) {
  const result = await gatherIdentity({ deps });
  if (!result.ok) {
    if (result.missingVar) {
      console.error(`brain:review: refusing to run — env var "${result.missingVar}" is not set.`);
      console.error(`  Get a token: ${result.patSetupUrl}`);
      console.error(`  Setup doc: ${result.setupDocPath}`);
    } else if (result.ambientIdentity) {
      console.error(`brain:review: refusing to run — this environment resolved a deliberately INVALID token to "${result.ambientIdentity}".`);
      console.error('  Credentials are being injected upstream (a proxy, or an ambient CLI session), so a');
      console.error(`  token-scoped identity read cannot establish who ${result.tokenEnv} belongs to (issue #604).`);
      console.error('  Rotating the token cannot fix this — the token is never what answers.');
      console.error('  Run brain:review where credentials are not injected: the maintainer machine, or CI with the PAT as a secret.');
    } else if (result.controlLockout) {
      console.error(`brain:review: refusing to run — the provider is temporarily refusing authentication attempts: ${result.controlLockout}`);
      console.error('  This check sends one deliberately-invalid credential per run, and repeated invalid');
      console.error('  attempts are what trigger that lockout — so it may have caused this itself (issue #604).');
      console.error('  Wait for the window to expire and re-run. Do NOT rotate the token, and do not read');
      console.error('  this as a credential-injecting environment — neither is what happened.');
    } else if (result.controlError) {
      console.error(`brain:review: refusing to run — could not establish whether this environment honours the reviewer token: ${result.controlError}`);
      console.error('  The negative control did not reach a verdict, and "could not establish" is not "established clean" (issue #604).');
    } else if (result.mismatch) {
      console.error(`brain:review: refusing to run — the reviewer token belongs to "${result.mismatch.actual}", but reviewer.handle claims "${result.mismatch.claimed}".`);
      console.error('  §10 abstention and the anti-loop lock would compare a claimed identity, not a real one (issue #413).');
    } else {
      console.error(`brain:review: refusing to run — could not verify the reviewer identity against the token: ${result.verifyError}`);
      console.error('  Never proceed on an unverified identity (§10 fail-closed, issue #413).');
    }
    return 1;
  }
  return 0;
}
