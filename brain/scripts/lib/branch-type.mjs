// branch-type.mjs — derive a conventional branch-type prefix from issue labels.
//
// This repo namespaces its labels (`type:bug`, `type:feature`, …), so the
// `type:` prefix is stripped before the lookup — otherwise no label ever matches
// and every ticket falls back to `feat/` regardless of its real type (#101).
//
// This is the ONE module that knows the `type:` vocabulary (design A3, issue
// #334) — `findTypeLabel` is co-located here rather than threaded as a
// provider-scoping parameter through brain-ship.mjs, because the label
// already arrives correctly scoped FROM the provider; nothing is
// reconstructed, so there is nothing to get wrong.

const LABEL_TYPE = {
  feat: 'feat', feature: 'feat',
  fix: 'fix', bug: 'fix',
  chore: 'chore',
  docs: 'docs',
  refactor: 'refactor',
  ci: 'ci',
  build: 'build',
};

// Matches both GitHub's `type:bug` and GitLab's scoped `type::bug` forms
// (issue #334 design A3 — widened from `/^type:/`, which left GitLab's `::`
// separator's second colon in place, yielding `:bug` — no LABEL_TYPE entry
// matches a leading colon, so the branch type silently fell back to `feat`
// for every GitLab-sourced type label. Fixed here.).
const TYPE_PREFIX = /^type::?/i;

/**
 * Maps an issue's labels to a conventional branch-type prefix.
 * The `type:`/`type::` namespace is stripped (so `type:bug` / `type::bug` →
 * `fix`); non-type labels (`status:approved`, `good first issue`, …) simply
 * don't match. The first label that maps wins; falls back to `feat` when
 * none do.
 *
 * @param {string[]} labels  Issue label names (namespaced or bare).
 * @returns {string} A branch-type prefix: feat | fix | chore | docs | refactor | ci | build.
 */
export function deriveBranchType(labels) {
  const list = Array.isArray(labels) ? labels : [];
  return (
    list
      .map((l) => LABEL_TYPE[String(l).toLowerCase().replace(TYPE_PREFIX, '')])
      .find(Boolean) ?? 'feat'
  );
}

/**
 * Finds the first `type:*` label on an issue and returns it VERBATIM — no
 * case-folding, no re-mapping (issue #334, `ship-pr-label-resolution` spec).
 * The label travels unchanged to the PR/MR write; `deriveBranchType` (above)
 * is the ONLY consumer that maps it further, and only for the title prefix.
 * Provider-agnostic: matches GitHub's `type:` and GitLab's scoped `type::`
 * forms with the same regex used by `deriveBranchType`.
 *
 * @param {string[]} labels  Issue label names (namespaced or bare).
 * @returns {string|undefined} The first matching label, verbatim, or `undefined`.
 */
export function findTypeLabel(labels) {
  const list = Array.isArray(labels) ? labels : [];
  return list.find((l) => TYPE_PREFIX.test(String(l)));
}
