// resolve-logical-name.mjs — Maps consumer file paths to canonical upstream
// logical names and classifies each file as 'generic' (managed by brain) or
// 'project' (consumer-owned).
//
// Pure: imports only node:path + installer pure helpers (globToRegExp, matchesAny).
// Zero node:fs, zero node:child_process, zero side effects.
//
// See design.md § "Logical-name resolution" and tasks.md § "Phase 2".

import { globToRegExp, matchesAny } from '../installer.mjs';

// Segments that already have their own top-level namespace in the upstream tree.
// A flat `brain/<seg>/` path where seg ∈ EXEMPT_SEGS is NOT remapped to
// brain/core/<seg>/ — it stays as-is (or is already canonical).
const EXEMPT_SEGS = new Set(['core', 'project', 'scripts']);

/**
 * Converts a file path to a POSIX-style string (forward slashes only).
 * Replaces all backslashes unconditionally so Windows-style paths passed by
 * callers on any platform are handled correctly.
 * @param {string} filePath
 * @returns {string}
 */
function toPosix(filePath) {
  return filePath.replace(/\\/g, '/');
}

/**
 * Returns the first glob in `globs` whose pattern matches `relPath`, or null.
 * @param {string} relPath  POSIX-style relative path
 * @param {string[]} globs
 * @returns {string|null}
 */
function findMatchedGlob(relPath, globs) {
  for (const g of globs) {
    if (globToRegExp(g).test(relPath)) return g;
  }
  return null;
}

/**
 * Resolves the upstream logical name for a consumer file path and classifies it.
 *
 * Mapping rules (applied in order, first match wins):
 *   1. brain/scripts/**                    → as-is (already canonical)
 *   2. scripts/** (root)                   → brain/scripts/** (flat scripts → managed)
 *   3. brain/core/**                       → as-is
 *   4. brain/project/**                    → as-is (consumer-owned; stays project)
 *   5. brain/<seg>/** (seg ∉ EXEMPT_SEGS) → brain/core/<seg>/** (flat doc → core)
 *   6. anything else                       → as-is (.gitattributes, .github/**, root docs)
 *
 * classification:
 *   'generic'  — logicalName matches managed[] AND is NOT matched by local[]
 *   'project'  — everything else (no managed match, or local wins)
 *
 * matchedGlob:
 *   The first managed[] glob that matched logicalName, or null when classification
 *   is 'project'.
 *
 * @param {string} filePath
 *   POSIX-style path relative to the consumer repo root.
 * @param {{ managed: string[], local: string[] }} manifest
 *   The managed-paths manifest arrays (from brain/core/managed-paths.mjs).
 * @returns {{ logicalName: string, classification: 'generic'|'project', matchedGlob: string|null }}
 */
export function resolveLogicalName(filePath, { managed, local }) {
  const p = toPosix(filePath);

  let logicalName;

  if (p.startsWith('brain/scripts/')) {
    // Rule 1: already in the canonical brain/scripts/ namespace.
    logicalName = p;
  } else if (p.startsWith('scripts/')) {
    // Rule 2: flat consumer root scripts/ → brain/scripts/ (managed namespace).
    logicalName = 'brain/' + p;
  } else if (p.startsWith('brain/core/')) {
    // Rule 3: already in the core split; no remapping needed.
    logicalName = p;
  } else if (p.startsWith('brain/project/')) {
    // Rule 4: consumer-owned subtree; stays as-is (local wins).
    logicalName = p;
  } else if (p.startsWith('brain/')) {
    // Rule 5: flat brain/<seg>/ — remap to brain/core/<seg>/ unless seg is exempt.
    const rest = p.slice('brain/'.length); // e.g. "methodology/intro.md"
    const seg = rest.split('/')[0];         // e.g. "methodology"
    logicalName = EXEMPT_SEGS.has(seg) ? p : 'brain/core/' + rest;
  } else {
    // Rule 6: anything else (.gitattributes, .github/**, root-level docs, etc.)
    logicalName = p;
  }

  const isManaged = matchesAny(logicalName, managed);
  const isLocal   = matchesAny(logicalName, local);
  const classification = isManaged && !isLocal ? 'generic' : 'project';
  const matchedGlob = classification === 'generic'
    ? findMatchedGlob(logicalName, managed)
    : null;

  return { logicalName, classification, matchedGlob };
}
