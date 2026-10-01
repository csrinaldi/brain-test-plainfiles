#!/usr/bin/env node
// brain/scripts/vcs/cli.mjs — vcs.provider dispatcher.
//
// Reads vcs.provider from brain.config.json (or VCS_PROVIDER env override) and
// delegates to axes/vcs/adapters/<provider>.mjs. Mirrors brain/scripts/memory/cli.mjs, but
// the selector is REPO-LEVEL (brain.config.json), not per-dev (.env) — see ADR-0008.
//
// Two usages:
//   - As a library:  import { getVcs } from './vcs/cli.mjs';
//                     const vcs = await getVcs(); await vcs.issueList({ ... });
//   - As a CLI (for .sh callers):
//                     node brain/scripts/vcs/cli.mjs <verb> '<json-args>'
//                     e.g. node brain/scripts/vcs/cli.mjs issue-list '{"state":"open"}'

import { pathToFileURL } from 'node:url';
import { runAsIdentity } from './lib/identity-context.mjs';
import { vcsToken } from './lib/token.mjs';
import { loadBrainConfig } from '../lib/brain-config.mjs';

// The verbs every provider must implement (see vcs-contract.md). Reconciled
// against the "Required verbs" table + provider exports (issue #239 A3 task
// 3.6, design Decision 6) — `mrCreate`/`branchProtect`/`capabilities` were
// implemented by both providers but missing from this array.
// prReviewComment / issueComment / labelAdd / labelRemove (issue #266,
// REQ-266-2): four COMMENT-only write verbs. prReviewComment hardcodes
// event: 'COMMENT' on both providers — no APPROVE code path exists (lock 2,
// REQ-266-3).
// prStatusRollup (ADR-0021 Decision 2): READ-only status-check rollup — no
// write path, no APPROVE path, no label mutation.
// issueUpdate / issueRelations (issue #533, ADR-0029): the first verb that can
// overwrite human prose, and the native-relation READ that feeds the same graph
// builder as the declared `brain-graph/1` block. `issueUpdate` writes `body` and
// nothing else — no title, no state, no labels — so it cannot close a ticket.
// prCommits (issue #358 Q5 Phase 4): READ-only PR/MR commit list, added to
// resolve REQ-L5-1's tiered evidence (lite's distinct-act head-commit
// timestamp; regulated's approver-authored-no-commit check) — see
// axes/vcs/adapters/github.mjs#prCommits / axes/vcs/adapters/gitlab.mjs#prCommits.
// mrAutoMerge (issue #886, ADR-0034 L2): arms auto-merge by tier
// (requiredReviews), never merges, never throws. No flag parsing needed —
// the CLI takes one JSON blob (see below), so requiredReviews arrives as a
// JSON key exactly as branchProtect's does. Adding this entry fires the
// drift guard's check :82 by design (D5) until the maintainer's
// `brain:promote` commit lands the vcs-contract.md doc row on this same
// branch — see openspec/changes/issue-886-mr-auto-merge/design.md.
export const VERBS = [
  'authCheck', 'authLogin', 'whoami',
  'issueView', 'issueList', 'issueCreate', 'issueUpdate', 'issueRelations',
  'mrList', 'prView', 'mrCreate', 'mrAutoMerge', 'labelEvents', 'prReviews',
  'commitStatus', 'repoCloneUrl', 'patSetupUrl', 'projectResolve',
  'branchProtect', 'capabilities',
  'prReviewComment', 'issueComment', 'labelAdd', 'labelRemove',
  'prStatusRollup', 'labelList', 'labelCreate', 'prCommits',
  // issue #1086, D3/D7: fires verb-contract-drift-guard.test.mjs's :82-91
  // check by design until the maintainer's `brain:promote` lands the
  // vcs-contract.md Required Verbs row drafted at
  // openspec/changes/issue-1086-audit-pr-resolution/brain-drafts/vcs-contract-commitprs-row.md
  // on this same branch.
  'commitPrs',
  // issue #1162: fires verb-contract-drift-guard's doc-row check by design; the
  // Required Verbs row is drafted at
  // openspec/changes/issue-1162-postmerge-cursor-bootstrap/brain-drafts/
  // (brain/core is read-only here) and is tracked as DOCUMENTED_BUT_NOT_REQUIRED
  // in the guard until promoted.
  'workflowRunSucceeded',
  // issue #1188: closes the alarm issues a later clean post-merge run resolves. Fires the
  // drift guard's doc-row check by design; the Required Verbs row is drafted at
  // openspec/changes/issue-1188-*/brain-drafts/ and is tracked in PENDING_PROMOTION until promoted.
  'issueClose',
];

/**
 * Resolves the active provider name. Pure — takes config + env explicitly so it
 * can be unit-tested. VCS_PROVIDER env wins over brain.config.json (for overrides
 * and CI), then vcs.provider from config.
 * @param {{ config?: object, env?: object }} [opts]
 * @returns {string}
 */
export function resolveProviderName({ config, env = process.env, provider } = {}) {
  // Precedence: an explicit `provider` (the RUNTIME-detected platform, e.g.
  // ci-context's ctx.provider — finding #14) wins over VCS_PROVIDER env, which
  // wins over config.vcs.provider. A CI job on GitLab must dispatch to the
  // gitlab provider even when this repo's own config says github.
  const resolved = provider || env.VCS_PROVIDER || config?.vcs?.provider;
  if (!resolved) {
    throw new Error(
      'vcs: no provider configured. Set "vcs": { "provider": "github" } in ' +
      'brain.config.json (or VCS_PROVIDER in the environment). See ADR-0008.',
    );
  }
  return resolved;
}

/**
 * Loads and returns the active provider module (object of verb functions).
 *
 * `identity` (issue #501) BINDS a credential to the returned port: every verb it
 * exposes makes its server calls under that credential.
 *
 * OMITTED, THE PORT FALLS BACK TO `VCS_TOKEN` (issue #479) — brain's one
 * provider-neutral credential (ADR-0007, #33). It used to fall back to nothing,
 * which meant gh's ambient login on GitHub and `VCS_TOKEN` on GitLab: **the same
 * code authenticated under two different conventions depending on provider**, and
 * nothing asserted they stayed in sync. "brain runs on GitLab" was true of the
 * port and false of everything that reached the port without binding an identity.
 *
 * That is why the fallback belongs HERE and not in the audit path. #479's scope
 * offered the choice — thread `vcsToken()` through `merge-walk.mjs`, or close the
 * seam — and noted that a partial thread leaving ambient-auth fallbacks "is a
 * half-seam and should be a deliberate choice, not a leftover". Measured: **one**
 * of the 20+ `getVcs` call sites bound an identity (the reviewer, `review/cli.mjs`).
 * Threading the audit would have fixed the one path #467 happened to expose and
 * left the rest, which is the shape `bindIdentity` below already refuses for verbs:
 * "a hand-maintained list is the shape that failed".
 *
 * With no `VCS_TOKEN` set, `vcsToken()` answers `null` and `runAsIdentity(null, …)`
 * binds nothing — so a developer relying on their ambient `gh` login is unaffected.
 * The change is only ever additive: a credential that was declared and ignored is
 * now used.
 *
 * Bound at the PORT rather than passed per verb, and that is the whole point.
 * GitLab already had a per-verb `token` parameter, at thirteen sites, correct;
 * the reviewer still wrote with the wrong credential because `poster.mjs` never
 * passed one. A parameter a caller may omit is a rule the caller must remember,
 * and `reviewer-protocol.md` §2 requires the opposite: "It must be impossible by
 * construction." Here there is no argument to forget — a verb obtained from a
 * bound port cannot be called unbound, and a verb ADDED tomorrow inherits the
 * binding without knowing it exists.
 *
 * `_import` is a test seam for the dynamic import, so the binding can be driven
 * with a stub provider — the binding under test lives in the wrapper here and is
 * provider-agnostic, and a test that needed a real `gh` could not drive the two
 * DIFFERENT identities the defect only shows under.
 *
 * `_token` is the same kind of seam for the credential read. It exists because
 * `vcsToken()` reads the developer's `.env` before `process.env`, so a test that
 * merely set or deleted `process.env.VCS_TOKEN` would assert one thing on a clean
 * checkout and the opposite on a configured one — an env-dependent guard, which is
 * how the "unbound" assertion below was passing by accident rather than by design.
 *
 * @param {{ config?: object, env?: object, provider?: string, identity?: string|null,
 *   _import?: (url: URL) => Promise<object>, _token?: (provider: string) => string|null }} [opts]
 * @returns {Promise<object>}
 */
export async function getVcs({ config, env, provider, identity = null, _import, _token = vcsToken } = {}) {
  const cfg = config ?? loadBrainConfig();
  const name = resolveProviderName({ config: cfg, env, provider });
  // Guard the dynamic import path: provider names are simple identifiers, never
  // path fragments. Rejecting anything else prevents path traversal and yields a
  // clearer error than a generic "module not found".
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`vcs: invalid provider name '${name}' — must match [a-z][a-z0-9-]*.`);
  }
  let mod;
  try {
    const url = new URL(`../axes/vcs/adapters/${name}.mjs`, import.meta.url);
    mod = _import ? await _import(url) : await import(url);
  } catch (err) {
    throw new Error(
      `vcs: provider '${name}' not found at axes/vcs/adapters/${name}.mjs — ${err.message}`,
    );
  }
  // An explicit `identity` always wins — the reviewer verifies and writes as a
  // specific credential and must not be silently redirected to the generic one.
  const bound = identity ?? _token(name);
  if (!bound) return mod;
  return bindIdentity(mod, bound);
}

/**
 * Wraps every FUNCTION export so its call runs inside the identity context. Non
 * -function exports (`PROVIDER`) pass through unchanged.
 *
 * Wrapping is exhaustive by construction — it enumerates the module rather than a
 * list of verb names — because a hand-maintained list is the shape that failed:
 * `whoami` was the one call site that applied the credential, and it stayed the
 * only one for the whole life of #413 while nineteen others did not follow.
 *
 * @param {object} mod
 * @param {string} identity
 * @returns {object}
 */
function bindIdentity(mod, identity) {
  const bound = {};
  for (const [key, value] of Object.entries(mod)) {
    bound[key] =
      typeof value === 'function'
        ? (...args) => runAsIdentity(identity, () => value(...args))
        : value;
  }
  return bound;
}

const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// ── CLI entry ──────────────────────────────────────────────────────────────────
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const verb = kebabToCamel(process.argv[2] ?? '');
  if (!verb) {
    console.error(`vcs: missing <verb>. One of: ${VERBS.join(', ')}`);
    process.exit(1);
  }
  if (!VERBS.includes(verb)) {
    console.error(`vcs: unknown verb '${process.argv[2]}'. One of: ${VERBS.join(', ')}`);
    process.exit(1);
  }
  let args = {};
  if (process.argv[3]) {
    try {
      args = JSON.parse(process.argv[3]);
    } catch (err) {
      console.error(`vcs: args must be JSON — ${err.message}`);
      process.exit(1);
    }
  }
  try {
    const vcs = await getVcs();
    const result = await vcs[verb](args);
    if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
    // Boolean verbs (authCheck/authLogin) map false → non-zero exit so shell
    // callers can branch on the exit code (`if node cli.mjs auth-check …`).
    if (result === false) process.exit(1);
  } catch (err) {
    console.error(`vcs: ${err.message}`);
    process.exit(1);
  }
}
