// issue-ref-patterns.mjs — canonical issue-reference regex patterns, shared
// by every governance file that needs to recognize or extract a
// closing/chain issue reference from a PR/MR body or commit message.
//
// PURE CONSTANT MODULE: no ci-context import, no I/O. Pure evaluators (e.g.
// checks/issue-link.mjs) may import this without becoming ci-context-aware —
// REQ-CIC-4 protects pure evaluators from a pipeline-context seam dependency,
// not from importing a sibling pure-constants module.
//
// BEFORE this module existed, THREE regexes independently encoded this
// vocabulary and had drifted (issue #231 CP-A2a review, finding M1):
//   - checks/issue-link.mjs's own CLOSING_RE — NARROW (closes|fixes|resolves
//     only, 3 of the 9 GitHub-documented forms).
//   - governance/run-check.mjs's CLOSING_NUM_RE — a duplicate of the same
//     narrow 3-form pattern.
//   - vcs/actor-check.mjs's CLOSING_KEYWORD_RE — already BROAD (all 9 forms),
//     matching GitHub bash's own grep (.github/workflows/governance.yml).
// The narrow pattern caused a real fail-closed parity divergence: "Fixed
// #42" merging to the default branch passed GitHub bash and actor-check but
// was REJECTED by issue-link.mjs / run-check.mjs. RULED: widen the narrow
// two to match the broad one, and unify all three into this ONE constant
// module, imported by all three call sites — never a second parser (the
// hasher / §4-grammar precedent). See design.md Decision 2 ADDENDUM (M1
// ruling note) for the full rationale.

// Closing keywords per GitHub's documented auto-close vocabulary
// (case-insensitive), all 9 forms: close, closes, closed, fix, fixes, fixed,
// resolve, resolves, resolved. Capture group 1 = the matched keyword, group
// 2 = the referenced issue number.
export const CLOSING_RE = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i;

// Chained-PR partial reference: "Part of #N" (used by slice PRs in a
// chained-PR flow — never closes the referenced issue). Capture group 1 =
// the referenced issue number.
export const CHAIN_RE = /\bpart\s+of\s+#(\d+)/i;
