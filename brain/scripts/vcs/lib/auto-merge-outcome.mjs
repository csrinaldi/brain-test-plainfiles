// auto-merge-outcome.mjs — issue #886: `mrAutoMerge`'s outcome shapes,
// constructed in exactly one place. Zero imports. Pure. Neither provider
// (`github.mjs`, `gitlab.mjs`) may build `{enabled: ...}` by hand — both
// import ONLY `armed()`/`refused()` from here (enforced by a source guard in
// this file's own test — no provider source may contain an `enabled:`
// literal; the same discipline `uncomputable-cause.mjs` established for the
// `{uncomputable, reason, detail}` shape, and `vcs/lib/` is the proven floor
// for a shared, imported-not-re-exported helper — a RE-EXPORTED helper would
// read as an undeclared contract verb to `verb-contract-drift-guard.test.mjs`).

/** The closed vocabulary `reason` draws from. Frozen so a rename is one edit
 * and a test can assert the outcome's `reason` is a member of it. */
export const AUTO_MERGE_REASONS = Object.freeze({
  REQUIRES_HUMAN_APPROVAL: 'requires-human-approval',
  UNSUPPORTED: 'unsupported',
  TRANSPORT: 'transport',
});

/**
 * The ONLY constructor of the "armed" shape. `url` is taken verbatim from the
 * provider — `string | null`, never constructed from `project` plus a
 * guessed host (design A2/A4/D4).
 *
 * @param {{ url: string | null }} args
 * @returns {{ enabled: true, url: string | null }}
 */
export function armed({ url }) {
  return { enabled: true, url };
}

/**
 * The ONLY constructor of the "refused" shape. `error` is present IFF it is
 * explicitly passed — the tier-refusal branch (`requiredReviews !== 0`) never
 * fabricates one, because no provider was ever asked (design A1): a local
 * decision carries no provider text to report. The unsupported/transport
 * branches always pass `error`, since a provider spoke.
 *
 * @param {{ reason: string, error?: string }} args
 * @returns {{ enabled: false, reason: string } | { enabled: false, reason: string, error: string }}
 */
export function refused({ reason, error }) {
  return error === undefined ? { enabled: false, reason } : { enabled: false, reason, error };
}
