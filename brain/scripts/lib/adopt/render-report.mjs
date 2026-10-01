// render-report.mjs — Pure Markdown report renderer for brain:adopt plans.
//
// Accepts a canonical plan object (spec JSON Plan Schema) and returns a
// Markdown string. No node:fs, no node:child_process — pure, deterministic,
// and testable without disk access.
//
// ADR-0009 compliance: translated files are ALWAYS listed explicitly in the
// "Replacements" section. Silent reclassification or omission is prohibited.
//
// See design.md § "Testing Strategy" and tasks.md § "Phase 4".

/**
 * Renders a brain:adopt plan as a human-readable Markdown report.
 *
 * Sections (in order):
 *   1. Summary — counts table + envelope metadata
 *   2. Generic Files — all generic files with divergence + proposed action
 *   3. Auto-adopted from upstream — drift files with proposedAction 'adopt-upstream'
 *      (warns that the local copy will be overwritten)
 *   4. Replacements (translations to be adopted from upstream) — languageFlag:true files
 *   5. Flagged for Review — files with proposedAction 'flag-review'
 *   6. Project Files — consumer-owned files
 *
 * @param {object} plan - canonical plan object from buildPlan()
 * @returns {string} Markdown report
 */
export function renderReport(plan) {
  const lines = [];

  // ── 1. Summary ─────────────────────────────────────────────────────────────

  lines.push('# brain:adopt Report');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`Generated: \`${plan.generatedAt}\``);
  lines.push(`Target shape: \`${plan.target.shape}\`  |  Root: \`${plan.target.root}\``);
  lines.push(`Manifest source: \`${plan.manifestSource}\``);
  lines.push('');
  lines.push('| Category | Count |');
  lines.push('|---|---|');
  lines.push(`| Total files | ${plan.summary.total} |`);
  lines.push(`| Generic (brain-managed) | ${plan.summary.generic} |`);
  lines.push(`| Project-owned | ${plan.summary.project} |`);
  lines.push(`| Identical | ${plan.summary.identical} |`);
  lines.push(`| Translations | ${plan.summary.translation} |`);
  lines.push(`| Drift | ${plan.summary.drift} |`);
  lines.push(`| Flagged for review | ${plan.summary.flagForReview} |`);
  lines.push(`| Upstream missing | ${plan.summary.upstreamMissing} |`);
  lines.push('');

  // ── 2. Generic Files ───────────────────────────────────────────────────────

  const genericFiles = plan.files.filter(f => f.classification === 'generic');
  lines.push('## Generic Files');
  lines.push('');
  if (genericFiles.length === 0) {
    lines.push('No brain-managed files found (no-brain repo).');
  } else {
    lines.push('| Source path | Logical name | Divergence | Action |');
    lines.push('|---|---|---|---|');
    for (const f of genericFiles) {
      lines.push(
        `| \`${f.sourcePath}\` | \`${f.logicalName}\` | ${f.divergenceKind} | \`${f.proposedAction}\` |`,
      );
    }
  }
  lines.push('');

  // ── 3. Auto-adopted from upstream (drift files that will be overwritten) ──────
  //
  // Drift files with proposedAction 'adopt-upstream' will have their local copy
  // overwritten by the upstream version. Unlike 'identical' (no change) or
  // 'translation' (listed in Replacements), these are EN files the consumer has
  // modified; a human could easily miss the overwrite risk in the generic table alone.

  const autoAdopted = plan.files.filter(
    f => f.divergenceKind === 'drift' && f.proposedAction === 'adopt-upstream',
  );
  lines.push('## Auto-adopted from upstream (local copy will be overwritten)');
  lines.push('');
  if (autoAdopted.length === 0) {
    lines.push('No drift files scheduled for automatic upstream adoption.');
  } else {
    lines.push(
      'The following files have drifted from upstream in English. ' +
      'The local copy **will be overwritten** with the upstream version when adopt is applied. ' +
      'Review them before proceeding.',
    );
    lines.push('');
    lines.push('| Source path | Logical name | Reason |');
    lines.push('|---|---|---|');
    for (const f of autoAdopted) {
      const safeReason = f.reason.replace(/\|/g, '\\|');
      lines.push(`| \`${f.sourcePath}\` | \`${f.logicalName}\` | ${safeReason} |`);
    }
  }
  lines.push('');

  // ── 4. Replacements (translations to be adopted from upstream) ──────────────
  //
  // ADR-0009: every languageFlag:true file MUST appear in this section.
  // Omitting a translated file from the report is prohibited.

  const translations = plan.files.filter(f => f.languageFlag);
  lines.push('## Replacements (translations to be adopted from upstream)');
  lines.push('');
  if (translations.length === 0) {
    lines.push('No translated files detected.');
  } else {
    lines.push(
      'The following files are Spanish translations of brain upstream content. ' +
      'Adopting upstream will replace them with the canonical English version.',
    );
    lines.push('');
    lines.push('| Source path | Language signal | Action |');
    lines.push('|---|---|---|');
    for (const f of translations) {
      const ls = f.languageSignal
        ? `es=${f.languageSignal.es}, en=${f.languageSignal.en} (${f.languageSignal.verdict})`
        : '—';
      lines.push(`| \`${f.sourcePath}\` | ${ls} | \`${f.proposedAction}\` |`);
    }
  }
  lines.push('');

  // ── 5. Flagged for Review ──────────────────────────────────────────────────

  const flagged = plan.files.filter(f => f.proposedAction === 'flag-review');
  lines.push('## Flagged for Review');
  lines.push('');
  if (flagged.length === 0) {
    lines.push('No files flagged for review.');
  } else {
    lines.push('These files require human decision before any adopt action is applied.');
    lines.push('');
    lines.push('| Source path | Divergence kind | Reason |');
    lines.push('|---|---|---|');
    for (const f of flagged) {
      // Escape pipe characters in the reason so the Markdown table renders correctly.
      const safeReason = f.reason.replace(/\|/g, '\\|');
      lines.push(`| \`${f.sourcePath}\` | ${f.divergenceKind} | ${safeReason} |`);
    }
  }
  lines.push('');

  // ── 6. Project Files ───────────────────────────────────────────────────────

  const projectFiles = plan.files.filter(f => f.classification === 'project');
  lines.push('## Project Files');
  lines.push('');
  if (projectFiles.length === 0) {
    lines.push('No project-owned files found.');
  } else {
    lines.push('These files are owned by the consumer repo and are not managed by brain.');
    lines.push('');
    lines.push('| Source path | Proposed action |');
    lines.push('|---|---|');
    for (const f of projectFiles) {
      lines.push(`| \`${f.sourcePath}\` | \`${f.proposedAction}\` |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
