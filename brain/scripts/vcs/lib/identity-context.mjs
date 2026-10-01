// identity-context.mjs — the credential a VCS port writes under (issue #501).
//
// WHY A CONTEXT AND NOT A PARAMETER
//
// The obvious shape is a `token` option on every verb. GitLab already has it —
// `token ?? vcsToken(PROVIDER)` at five sites, correct — and the reviewer still
// wrote with the wrong credential, because `poster.mjs` never passed one. GitHub
// never had it at all and fell back to `gh`'s ambient keyring login. Measured on
// PR #500: `whoami` resolved `csrinaldibot`, the review posted as `csrinaldi`.
//
// A parameter a caller may omit is a rule the caller must remember, and
// `reviewer-protocol.md` §2 sets the standard: "That asymmetry cannot be a rule
// the agent remembers… It must be impossible by construction."
//
// So the identity is bound where the PORT is obtained (`getVcs({ identity })`),
// carried on the async context, and read by each provider's single chokepoint.
// A verb cannot opt out because no verb is asked to opt in: there is no argument
// to forget. A verb added tomorrow inherits the binding for free — provided it
// reaches the network through the chokepoint, which is what the drift guard in
// `axes/vcs/adapters/*.drift.test.mjs` exists to keep true.
//
// AsyncLocalStorage rather than a module-level variable: the value must not leak
// between concurrent ports or survive past the call that set it, and a mutable
// module global does both.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Runs `fn` with `identity` as the credential every chokepoint in this call tree
 * will use. `identity` of `null`/`undefined` runs `fn` with NO bound identity —
 * today's resolution (gh's ambient auth, or `vcsToken(PROVIDER)`) is unchanged,
 * which is what keeps every non-reviewer caller working.
 *
 * @template T
 * @param {string|null|undefined} identity
 * @param {() => T} fn
 * @returns {T}
 */
export function runAsIdentity(identity, fn) {
  if (!identity) return fn();
  return storage.run(identity, fn);
}

/**
 * The credential bound to the port whose verb is currently executing, or `null`
 * when the port was obtained without one.
 *
 * @returns {string|null}
 */
export function currentIdentity() {
  return storage.getStore() ?? null;
}
