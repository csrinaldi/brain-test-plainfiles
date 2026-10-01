// capture-provenance.mjs — the capture door's three provenance questions
// (#738, design A1/A2; spec "a record carries its provenance").
//
// Pure: no `fs`, no `child_process`. Every git/env fact this module reasons
// about is read by the caller (`plainfiles.mjs`, via `lib/git-config.mjs`'s
// `gitConfigGet` and `process.env`) and passed in — that is what keeps these
// resolvers zero-seam unit tests.
//
// Named for what it does, not `actor-identity.mjs` (the proposal's name):
// this module also derives `issue` from the branch, and `provenance.mjs` is
// already the §4 prose parser (`engram-export.mjs`) — it must not become two
// things.

import { HANDLE_RE } from './format.mjs';
import { parseCanonicalIssueBranch } from '../../lib/branch-grammar.mjs';

/** Default agent-marker env var name, overridable via `git config brain.agentEnv`. */
export const AGENT_ENV_DEFAULT = 'AI_AGENT';

/**
 * Default agent-marker env NAMES checked, in this order, absent a
 * `git config brain.agentEnv` override (#939, audit finding M4: a Codex
 * session exporting only `CODEX_THREAD_ID` — no `AI_AGENT` — was recorded
 * `human`, because `AI_AGENT` was the only marker this list ever consulted).
 * `brain.agentEnv` still wins over every entry here (`resolveActorKind`
 * below never consults this list when an override is configured) — this is
 * the way an operator adds a runtime the list below does not know.
 *
 * Each entry is a runtime brain has ACTUALLY verified, not a guess at what
 * a platform "probably" exports:
 *
 *   - `AI_AGENT`        — brain's own generic marker (pre-existing default;
 *                         any adapter/runner may export it directly for a
 *                         decisive signal with no platform coupling).
 *   - `CLAUDECODE`      — Claude Code CLI (Anthropic). Verified LIVE: this
 *                         module was edited from inside a Claude Code
 *                         session, and `env | rg CLAUDECODE` in that same
 *                         session prints `CLAUDECODE=1`.
 *   - `CODEX_THREAD_ID` — OpenAI Codex CLI. Verified by the #939 audit
 *                         session itself (finding M4): present on that
 *                         Codex run while `AI_AGENT` was absent — the exact
 *                         case this widening exists to close.
 *
 * A runtime NOT in this list is not "unsupported" — it is "not yet
 * independently verified here". Add it via `brain.agentEnv` first; promote
 * it to this list once verified, per the pattern above, not on inference.
 *
 * Accepted cost (#939 ruling, 2026-09-12): a human typing inside a terminal
 * that exports one of these markers is recorded `actorKind: agent`, because
 * the session genuinely carries the marker — this list cannot and does not
 * try to tell a human's keystrokes apart from the agent runtime hosting them.
 */
export const AGENT_ENV_DEFAULTS = [AGENT_ENV_DEFAULT, 'CLAUDECODE', 'CODEX_THREAD_ID'];

/**
 * Actor values `resolveActor` refuses regardless of shape. `@legacy` is the
 * export fallback's sentinel (`engram-export.mjs`) — without this refusal,
 * `git config brain.actor @legacy` mints that sentinel through the capture
 * door and the "brain's own capture path never emits @legacy" guard (spec)
 * is true only by convention.
 */
export const RESERVED_ACTORS = new Set(['@legacy']);

/** `<type>/issue-<N>` or `<type>/issue-<N>-<slug>` — never a bare number, never case-insensitive. */

// The positive handle shape (design A2). Owned by `format.mjs` as `HANDLE_RE`
// (#738 unit 3, also used there for the write-gate's own classification) and
// imported here rather than duplicated: `format.mjs` has no `fs`/`child_process`
// dependency either, so importing it does not weaken this module's "pure, zero
// I/O" contract, and a single definition is the only way both modules are
// GUARANTEED to agree on the shape instead of merely being asserted to by two
// separate test suites (MINOR-1, fresh-context review).
/**
 * Resolves `actor` from the raw `git config brain.actor` read.
 *
 * @param {{ configured: string|null|undefined }} input
 * @returns {{ok:true, actor:string, evidence:string} | {ok:false, reason:'unset'|'malformed'|'reserved', value: string|null}}
 */
export function resolveActor({ configured }) {
  const value = typeof configured === 'string' ? configured.trim() : '';
  if (!value) return { ok: false, reason: 'unset', value: configured ?? null };
  if (RESERVED_ACTORS.has(value)) return { ok: false, reason: 'reserved', value };
  if (!HANDLE_RE.test(value)) return { ok: false, reason: 'malformed', value };
  return { ok: true, actor: value, evidence: 'actor from git config brain.actor' };
}

/**
 * Resolves `actorKind` by MEASURING the agent-marker env, never a hardcoded
 * constant. `agentEnvConfig` is the raw `git config brain.agentEnv` value —
 * a comma-separated list of variable NAMES (default: `AGENT_ENV_DEFAULTS`,
 * the widened list above). The first name whose value is non-empty wins. A
 * marker set but EMPTY counts as absent (⇒ `human`), recorded in evidence
 * rather than silently treated the same as "never set" (#888 set-but-blank
 * discipline).
 *
 * @param {{ env: Record<string,string|undefined>, agentEnvConfig?: string|null }} input
 * @returns {{actorKind:'human'|'agent', marker:string|null, rawValue:string|null, evidence:string}}
 */
export function resolveActorKind({ env = {}, agentEnvConfig } = {}) {
  const names = typeof agentEnvConfig === 'string' && agentEnvConfig.trim()
    ? agentEnvConfig.split(',').map((s) => s.trim()).filter(Boolean)
    : [...AGENT_ENV_DEFAULTS];

  const emptyNames = [];
  for (const name of names) {
    const raw = env ? env[name] : undefined;
    if (raw === undefined) continue;
    if (raw === '') {
      emptyNames.push(name);
      continue;
    }
    // `emptyNames` gathered so far is deliberately DROPPED on this path
    // (fresh-context review F6): the record is already decisively `agent` —
    // a blank sibling marker (e.g. `AI_AGENT=''` beside a set `CLAUDECODE`)
    // is not evidence the decision needs, only the marker that actually won
    // is. The #888 set-but-blank discipline this array exists for applies to
    // the HUMAN path below, where "checked but blank" is the only fact
    // available; here a stronger fact (a live marker) already settled it.
    return { actorKind: 'agent', marker: name, rawValue: raw, evidence: `actorKind agent from env ${name}` };
  }

  const evidence = emptyNames.length
    ? `actorKind human — ${emptyNames.join(',')} set but empty`
    : `actorKind human — no agent marker among ${names.join(',')}`;
  return { actorKind: 'human', marker: null, rawValue: null, evidence };
}

/**
 * Resolves `issue`: `declared` (from `--issue`) wins; otherwise derived from
 * `branch` matching the canonical grammar (`branch-grammar.mjs`); otherwise absent, NEVER fabricated.
 *
 * @param {{ declared: number|string|undefined|null, branch: string|null|undefined }} input
 * @returns {{issue: number|undefined, derived: boolean, branch?: string, evidence: string|null}}
 */
export function deriveIssue({ declared, branch }) {
  if (declared !== undefined && declared !== null && declared !== '') {
    const n = Number(declared);
    if (Number.isInteger(n)) {
      return { issue: n, derived: false, evidence: `issue ${n} declared via --issue` };
    }
  }
  if (typeof branch === 'string') {
    const m = parseCanonicalIssueBranch(branch);
    if (m) {
      const n = Number(m.issueNumber);
      return { issue: n, derived: true, branch, evidence: `issue ${n} derived from branch ${branch}` };
    }
  }
  return { issue: undefined, derived: false, evidence: null };
}

/**
 * Whitespace-collapsed, `#`-stripped, 64-char-sliced — agent-controlled text
 * landing in a durable field (design A2). `#` is stripped because `source`
 * shares the `**Fuente:**` line the §4 parser reads back (`provenance.mjs`'s
 * `issueFromFuente`, `/issue #(\d+)/`): an unfiltered instrument value like
 * `AI_AGENT="issue #999 runner"` would fabricate `issue: 999` on re-import
 * even though the record never declared or derived that issue (MINOR-2,
 * #461 class).
 */
function collapseAndTruncate(value) {
  return value.replace(/\s+/g, ' ').trim().replace(/#/g, '').slice(0, 64);
}

/**
 * Composes ONE trimmed physical line (W1-safe, `format.mjs`'s `source` rule)
 * from the other three resolvers' results plus the capturing host and the
 * backend that actually ran.
 *
 * `backend` is the caller's own identity string — `plainfiles.mjs#save()` and
 * `engram.mjs#save()` each pass the same literal they already use elsewhere
 * in that file (e.g. `unsupportedOp("search", "engram", ...)`); this function
 * does not invent a new identity string (cold review C1, #924 — engram is the
 * default backend after the #874 unpin, so a hardcoded "plainfiles" here
 * mislabeled every engram-backed capture's `source` field).
 *
 * @param {{ host: string, backend: string, actor: {evidence:string}, kind: {actorKind:string, marker:string|null, rawValue:string|null, evidence:string}, issue: {evidence:string|null} }} input
 * @returns {string}
 */
export function composeSource({ host, backend, actor, kind, issue }) {
  const parts = [`${backend} save on ${host}`];
  if (actor && actor.evidence) parts.push(actor.evidence);
  if (kind) {
    if (kind.actorKind === 'agent' && kind.rawValue) {
      parts.push(`actorKind agent from env ${kind.marker}=${collapseAndTruncate(kind.rawValue)}`);
    } else if (kind.evidence) {
      parts.push(kind.evidence);
    }
  }
  if (issue && issue.evidence) parts.push(issue.evidence);
  return parts.join('; ').replace(/\s+/g, ' ').trim();
}
