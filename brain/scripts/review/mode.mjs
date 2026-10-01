// mode.mjs — REQ-H1-7: mode is derived from repo state, NEVER declared (R6,
// protocol §H1; design.md §4). Pure over { labels, changedFiles } — the two
// ONLY derivation inputs; the implementer never declares the mode by any
// other in-tree marker.
//
// cli.mjs wires all three derived modes end-to-end: `tranche` (H1-2),
// `checkpoint` (H1-3), `ruling` (H1-4, Option B — the reviewer never
// auto-rules, see evaluators/ruling.mjs).

const CHECKPOINT_REPORT_RE = /(^|\/)checkpoint-report\.md$/;

/**
 * @param {{ labels?: string[], changedFiles?: string[] }} [input]
 * @returns {'ruling'|'checkpoint'|'tranche'}
 */
export function deriveMode({ labels, changedFiles = [] } = {}) {
  // #1073: there is NO `labels = []` default here any more. A default only
  // applies to `undefined`, so it looks like a guard and is not — the
  // identical shape crashed `evaluators/checkpoint.mjs` the moment
  // `review/cli.mjs` began threading an unread label set through as `null`,
  // and a default of `[]` also MINTS a reading nobody performed. The guard is
  // the `Array.isArray` below, which covers every shape at once: a set nobody
  // read cannot claim a ruling was asked for.
  if (Array.isArray(labels) && labels.includes('needs-ruling')) return 'ruling';
  if (changedFiles.some(f => CHECKPOINT_REPORT_RE.test(f))) return 'checkpoint';
  return 'tranche';
}
