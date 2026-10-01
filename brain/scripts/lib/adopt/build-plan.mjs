// build-plan.mjs — Pure plan assembler for brain:adopt.
//
// Accepts a list of consumer file paths and injected readers, calls the pure
// resolveLogicalName + classifyDivergence functions, and returns a canonical
// plan object conforming to the spec JSON Plan Schema.
//
// Pure: no node:fs, no node:child_process. All I/O is injected via the
// readConsumer and readUpstream functions so the assembler remains testable
// without disk access.
//
// Readers are called with await so they may be sync or async.
//
// See design.md § "Data Flow" and tasks.md § "Phase 5".

import { resolveLogicalName } from './resolve-logical-name.mjs';
import { classifyDivergence } from './classify-divergence.mjs';

/**
 * Maps the classifier's internal divergenceKind to the plan-level divergenceKind
 * and proposedAction. The plan schema has no 'flag-for-review' divergenceKind;
 * the classifier's 'flag-for-review' maps to plan divergenceKind 'drift' +
 * proposedAction 'flag-review'. The classifier's 'drift' (clear EN modification)
 * maps to plan divergenceKind 'drift' + proposedAction 'adopt-upstream' (the
 * consumer has deviated in English from EN upstream; adopt replaces with upstream).
 *
 * @param {'identical'|'translation'|'drift'|'flag-for-review'} internalKind
 * @returns {{ planDivergenceKind: string, proposedAction: string }}
 */
function mapGenericDivergence(internalKind) {
  switch (internalKind) {
    case 'identical':
      return { planDivergenceKind: 'identical', proposedAction: 'adopt-upstream' };
    case 'translation':
      return { planDivergenceKind: 'translation', proposedAction: 'adopt-upstream' };
    case 'drift':
      // EN-modified copy of an EN upstream: diverged but identifiable;
      // adopt-upstream restores the canonical version.
      return { planDivergenceKind: 'drift', proposedAction: 'adopt-upstream' };
    case 'flag-for-review':
      // Ambiguous or structurally diverged — cannot safely auto-adopt.
      // Plan schema maps internal 'flag-for-review' → divergenceKind:'drift' +
      // proposedAction:'flag-review' (see classify-divergence.mjs NOTE comment).
      return { planDivergenceKind: 'drift', proposedAction: 'flag-review' };
    default:
      return { planDivergenceKind: 'drift', proposedAction: 'flag-review' };
  }
}

/**
 * Assembles the canonical brain:adopt plan from injected readers.
 *
 * All I/O is delegated to the caller via:
 *   - readConsumer(path)      → consumer file text (string)
 *   - readUpstream(logicalName) → upstream file text (string) | null (absent)
 *
 * `generatedAt` MUST be injected by the caller (ISO timestamp string). This
 * function never calls Date() so it remains deterministic and testable.
 *
 * @param {object} opts
 * @param {string[]} opts.files
 *   Consumer file paths relative to repo root.
 * @param {function(string): string|Promise<string>} opts.readConsumer
 *   Reads consumer file text by relative path.
 * @param {function(string): string|null|Promise<string|null>} opts.readUpstream
 *   Reads upstream file text by logical name; returns null when the file is
 *   absent from the upstream source (node_modules/brain or self-host).
 * @param {{ managed: string[], local: string[] }} opts.manifest
 *   The managed-paths manifest (from brain/core/managed-paths.mjs).
 * @param {string} opts.generatedAt
 *   ISO 8601 timestamp to embed in the plan envelope.
 * @param {string} opts.manifestSource
 *   'node_modules/brain' | 'self-host'
 * @returns {Promise<object>} Canonical plan object (spec JSON Plan Schema).
 */
export async function buildPlan({ files, readConsumer, readUpstream, manifest, generatedAt, manifestSource }) {
  const fileRecords = [];

  for (const filePath of files) {
    const { logicalName, classification, matchedGlob } = resolveLogicalName(filePath, manifest);

    let divergenceKind, languageSignal, proposedAction, reason;

    if (classification === 'generic') {
      const consumerText = await readConsumer(filePath);
      const upstreamText = await readUpstream(logicalName);

      if (upstreamText === null || upstreamText === undefined) {
        // Upstream file is absent — flag for human decision.
        divergenceKind = 'upstream-missing';
        languageSignal = null;
        proposedAction = 'flag-review';
        reason = `upstream file '${logicalName}' not found in manifest source; cannot classify divergence`;
      } else {
        const classified = classifyDivergence(consumerText, upstreamText);
        const mapped = mapGenericDivergence(classified.divergenceKind);
        divergenceKind = mapped.planDivergenceKind;
        proposedAction = mapped.proposedAction;
        languageSignal = classified.languageSignal;
        reason = classified.reason;
      }
    } else {
      // Project-owned file: no upstream analog; no divergence classification needed.
      divergenceKind = 'absent-upstream';
      languageSignal = null;
      reason = 'no manifest match; consumer-owned file';
      // proposedAction depends on target.shape, which is derived after all records
      // are processed. Set a placeholder and fill in below.
      proposedAction = null;
    }

    // languageFlag: true iff the plan divergenceKind is 'translation' (ADR-0009).
    const languageFlag = divergenceKind === 'translation';

    fileRecords.push({
      sourcePath: filePath,
      logicalName,
      classification,
      matchedGlob,
      divergenceKind,
      languageSignal,
      languageFlag,
      proposedAction,
      reason,
    });
  }

  // Derive target.shape: flat-brain if any generic file found, else no-brain.
  // This is the canonical rule from spec § "No-Brain Repo Inventory".
  const hasGeneric = fileRecords.some(r => r.classification === 'generic');
  const targetShape = hasGeneric ? 'flat-brain' : 'no-brain';

  // Fill in proposedAction for project files now that target.shape is known.
  //   flat-brain → 'keep-as-project'  (file already lives under a brain-like layout)
  //   no-brain   → 'place-under-project' (consumer has no brain/ dir; placement needed)
  for (const record of fileRecords) {
    if (record.classification === 'project') {
      record.proposedAction = targetShape === 'flat-brain'
        ? 'keep-as-project'
        : 'place-under-project';
    }
  }

  // Build summary counters.
  //
  // drift vs flagForReview distinction:
  //   drift        = classifier 'drift'         → plan 'drift' + proposedAction 'adopt-upstream'
  //   flagForReview = classifier 'flag-for-review' → plan 'drift' + proposedAction 'flag-review'
  //   upstreamMissing = generic file with no upstream source
  //
  // upstreamMissing has its own counter; it is NOT double-counted in flagForReview.
  const summary = {
    total: fileRecords.length,
    generic: fileRecords.filter(r => r.classification === 'generic').length,
    project: fileRecords.filter(r => r.classification === 'project').length,
    identical: fileRecords.filter(r => r.divergenceKind === 'identical').length,
    translation: fileRecords.filter(r => r.divergenceKind === 'translation').length,
    drift: fileRecords.filter(
      r => r.divergenceKind === 'drift' && r.proposedAction === 'adopt-upstream',
    ).length,
    flagForReview: fileRecords.filter(
      r => r.proposedAction === 'flag-review' && r.divergenceKind !== 'upstream-missing',
    ).length,
    upstreamMissing: fileRecords.filter(r => r.divergenceKind === 'upstream-missing').length,
  };

  return {
    schemaVersion: '1',
    tool: 'brain:adopt',
    generatedAt,
    target: { shape: targetShape, root: '.' },
    manifestSource,
    summary,
    files: fileRecords,
  };
}
