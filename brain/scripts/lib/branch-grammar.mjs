// branch-grammar.mjs — the ONE owner of "which issue does this branch belong to" (#697).
//
// Two verbs compose branch names:
//   canonical  {type}/issue-{N}[-{slug}]  brain:ticket:start (documented in harness-contract.md)
//   legacy     {prefix}/{N}-{slug}        brain:start
// The slug may be empty: a title with no ASCII alphanumerics used to yield `fix/issue-5-`.
// Pure, zero I/O. Every reader either calls these exports or DECLARES its difference:
//   - capture-provenance / status snapshot: canonical only (durable writes never guess).
//   - brain-next: uses findIssueInBranch (lenient) so a numbered branch never reads as "ready".
//   - session-start: matches `issue-N` anywhere, case-insensitively, against change-dir names.
// Never returns a fabricated number.
// Known legacy-grammar false positive, accepted: `fix/2026-cleanup` parses as issue 2026 (a
// 4-digit year-led token that is not `-NN`); excluding every 4-digit number would break real issues.

/** Canonical shape. Group 1 = type, 2 = issue number, 3 = slug (may be empty/absent). */
export const CANONICAL_BRANCH_RE = /^([a-z]+)\/issue-(\d+)(?:-(.*))?$/;
const LEGACY = /^([a-z]+)\/(\d+)-(.*)$/;
// Lenient scan (the historical brain-next regex): a number after any `/`, optionally `issue-`.
const LENIENT = /(?:^|\/)(?:issue-)?(\d+)(?:-|$)/;

// A `memory/<host>-<date>` lane branch or a date-looking `YYYY-MM-...` segment is not an issue.
function looksLikeLaneOrDate(branch) {
  return /^memory\//.test(branch) || /(?:^|\/)(?:19|20)\d{2}-\d{2}(?:-|$)/.test(branch);
}

/**
 * Canonical shape only.
 * @param {unknown} branch
 * @returns {{issueNumber: string, type: string, slug: string, shape: 'canonical'} | null}
 */
export function parseCanonicalIssueBranch(branch) {
  const m = CANONICAL_BRANCH_RE.exec(String(branch ?? ''));
  return m ? { issueNumber: m[2], type: m[1], slug: m[3] ?? '', shape: 'canonical' } : null;
}

/**
 * Canonical, then legacy.
 * @param {unknown} branch
 * @returns {{issueNumber: string, type: string, slug: string, shape: 'canonical'|'legacy'} | null}
 */
export function parseIssueBranch(branch) {
  const b = String(branch ?? '');
  const canonical = parseCanonicalIssueBranch(b);
  if (canonical) return canonical;
  if (looksLikeLaneOrDate(b)) return null;
  const m = LEGACY.exec(b);
  return m ? { issueNumber: m[2], type: m[1], slug: m[3], shape: 'legacy' } : null;
}

/**
 * Lenient detection for readers that must fail closed (a numbered branch is never "no issue").
 * Superset of parseIssueBranch: also finds nested/upper-case types and a bare `type/42`.
 * @param {unknown} branch
 * @returns {string|null} the issue number
 */
export function findIssueInBranch(branch) {
  const b = String(branch ?? '');
  const parsed = parseIssueBranch(b);
  if (parsed) return parsed.issueNumber;
  if (looksLikeLaneOrDate(b)) return null;
  const m = LENIENT.exec(b);
  return m ? m[1] : null;
}

/** Producers use this so a title with no ASCII alphanumerics never yields `fix/issue-5-`. */
export function nonEmptySlug(slug) {
  return slug && slug.length > 0 ? slug : 'task';
}

/** Slug of an issue title, exactly as brain:ticket:start has always cut it (never empty). */
export function titleSlug(title) {
  return nonEmptySlug(
    String(title ?? '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 40)
      .replace(/-$/, ''),
  );
}

/** The canonical branch name brain:ticket:start creates. */
export function composeIssueBranch({ type, number, title }) {
  return `${type}/issue-${number}-${titleSlug(title)}`;
}
