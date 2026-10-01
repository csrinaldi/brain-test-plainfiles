// decision-block.mjs — the `brain-decision/1` protocol: render + parse in
// ONE module (issue #473, design.md §B2). Emitter and inverse live together
// on purpose — `review/verdict.mjs` / `review/lib/parse-verdict.mjs`'s split
// is a historical accident that has already cost this repo two drift bugs
// (#381, #452) and needs its own drift test to survive. One module cannot be
// edited half-way in a different file; two files can.
//
// The fence/scalar primitives are shared with `parse-verdict.mjs` via
// `yaml-block.mjs` (design.md §B1) — NOT a private inline copy.
// `yaml-block.drift.test.mjs` guards against a future re-inline of a
// divergent copy (task 1.7/1.8: this module used to own its own inline
// primitives, and the drift test caught two real divergences before this
// import replaced them).

import { extractFencedBlock, scalar } from './yaml-block.mjs';

const PROTOCOL = 'brain-decision/1';
const HEAD_SHA_RE = /^[0-9a-f]{40}$/i;

/** Renders a `brain-decision/1` fenced YAML block (design.md §E1). Hand-rolled
 * — zero npm deps, this schema is fixed, not generic YAML. `at` is required
 * to WRITE (audit trail) though unread by every check; `in_reply_to` is
 * optional, emitted only when provided. */
export function renderDecision({ protocol = PROTOCOL, decision, head_sha, actor, at, in_reply_to } = {}) {
  const lines = [
    '```yaml',
    `protocol: ${protocol}`,
    `decision: ${decision}`,
    `head_sha: ${head_sha}`,
    `actor: ${actor}`,
    `at: ${at}`,
  ];
  if (in_reply_to !== undefined && in_reply_to !== null) {
    lines.push(`in_reply_to: ${in_reply_to}`);
  }
  lines.push('```');
  return lines.join('\n');
}

/** Parses a `brain-decision/1` fenced block out of a review body
 * (design.md §E1/§E2, parse-level rules only — REQ-473-1, REQ-473-5).
 * Never throws; unreadable, incomplete, or wrong-protocol/wrong-version
 * input returns `null`. Admissibility against PR state (head freshness,
 * actor identity, deny-set) is `evaluateSignedDecision`'s job (slice 2), not
 * this parser's — same layering as `parseVerdict` vs its callers.
 *
 * @returns {{ protocol: string, decision: string, head_sha: string, actor: string, at?: string, in_reply_to?: string } | null} */
export function parseDecision({ body } = {}) {
  if (typeof body !== 'string' || body.length === 0) return null;

  const block = extractFencedBlock(body);
  if (block === null) return null;

  const protocol = scalar(block, 'protocol');
  if (protocol !== PROTOCOL) return null;

  const decision = scalar(block, 'decision');
  if (decision !== 'APPROVE') return null;

  const headSha = scalar(block, 'head_sha');
  if (!headSha || !HEAD_SHA_RE.test(headSha)) return null;

  const actor = scalar(block, 'actor');
  if (!actor) return null;

  const result = { protocol, decision, head_sha: headSha, actor };

  // `at`/`in_reply_to`: audit-only, never validated, never block admission
  // (design.md §E2 rules 18-19). Present verbatim when the block carries
  // them, omitted (not `null`) otherwise — round-trips exactly like
  // `parseVerdict`'s optional `sequencing` field.
  const at = scalar(block, 'at');
  if (at !== null) result.at = at;

  const inReplyTo = scalar(block, 'in_reply_to');
  if (inReplyTo !== null) result.in_reply_to = inReplyTo;

  return result;
}
