// archive-logic.mjs — Pure functions for E1 brain:change:archive (issue 260)
// Resolves logic without direct I/O, leveraging dependency injection.

import { parseChangeId, changeDir, archivePath, isGrandfathered } from './sdd-layout.mjs';

/**
 * Extracts YAML frontmatter and splits it from markdown body content.
 * Pure JS, zero dependencies.
 *
 * @param {string} content
 * @returns {{ frontmatter: object, body: string }}
 */
export function parseYamlFrontmatter(content) {
  const result = { frontmatter: {}, body: content ?? '' };
  if (typeof content !== 'string') return result;

  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return result;

  const endIdx = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIdx === -1) return result;

  const frontmatterLines = lines.slice(1, endIdx + 1);
  const bodyLines = lines.slice(endIdx + 2);

  const frontmatter = {};
  for (const line of frontmatterLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    // Strip surrounding single/double quotes if present
    const cleanValue = value.replace(/^['"]|['"]$/g, '');
    frontmatter[key] = cleanValue;
  }

  result.frontmatter = frontmatter;
  result.body = bodyLines.join('\n');
  return result;
}

/**
 * Merges delta spec content into central spec content.
 * Strips the frontmatter from delta, appends provenance header, and merges body.
 *
 * @param {string} deltaSpecContent
 * @param {string} centralSpecContent
 * @param {string} changeId
 * @param {string} dateStr
 * @returns {string}
 */
export function mergeSpecs(deltaSpecContent, centralSpecContent, changeId, dateStr) {
  const { body } = parseYamlFrontmatter(deltaSpecContent);
  const parsedChange = parseChangeId(changeId);
  const iid = parsedChange?.iid ?? changeId;
  const slug = parsedChange?.slug ?? changeId;

  const provenanceHeader = `### [issue-${iid}] ${slug} — ${dateStr}`;

  let newCentralContent = centralSpecContent ? centralSpecContent.trimEnd() : '';
  if (newCentralContent.length > 0) {
    newCentralContent += '\n\n';
  }
  newCentralContent += provenanceHeader + '\n\n' + body.trim() + '\n';
  return newCentralContent;
}

/**
 * Injected FS orchestrator for archiving changes.
 *
 * @param {object} opts
 * @param {string} opts.changeId
 * @param {object} opts.fs         Object containing exists, listDir, readFile, writeFile, mkdir, rename functions.
 * @param {string} [opts.dateStr]  Optional override date (YYYY-MM-DD).
 */
export async function archiveChange({ changeId, fs, dateStr }) {
  const resolvedDate = dateStr ?? new Date().toISOString().slice(0, 10);
  const parsedChange = parseChangeId(changeId);
  if (!parsedChange && !isGrandfathered(changeId)) {
    throw new Error(`Invalid changeId format: ${changeId}`);
  }
  const iid = parsedChange ? parsedChange.iid : changeId;

  const srcDir = changeDir(changeId);
  const destDir = archivePath(iid);

  if (fs.exists(destDir)) {
    throw new Error(`Destination directory ${destDir} already exists.`);
  }

  if (!fs.exists(srcDir)) {
    throw new Error(`Source directory ${srcDir} does not exist.`);
  }

  const specsDir = `${srcDir}/specs`;
  const flatSpecFile = `${srcDir}/spec.md`;

  const merges = [];

  if (fs.exists(specsDir)) {
    let capabilities = [];
    try {
      capabilities = fs.listDir(specsDir);
    } catch {
      // Ignore directory list failure
    }
    for (const cap of capabilities) {
      const capSpecFile = `${specsDir}/${cap}/spec.md`;
      if (fs.exists(capSpecFile)) {
        merges.push({ capability: cap, deltaPath: capSpecFile });
      }
    }
  } else if (fs.exists(flatSpecFile)) {
    const content = fs.readFile(flatSpecFile);
    const { frontmatter } = parseYamlFrontmatter(content);
    if (frontmatter.capability) {
      merges.push({ capability: frontmatter.capability, deltaPath: flatSpecFile });
    }
    // No 'capability:' declared — the delta is not consolidated into
    // openspec/specs/. This is reported via the `unconsolidated` return flag
    // below (issue #557 D7-b), not a console.warn buried in a loop: the
    // folder is archived anyway (blocking it would leave the directory
    // mostly dead for no benefit), and the caller decides how to surface it.
  }

  for (const { capability, deltaPath } of merges) {
    const centralSpecPath = `openspec/specs/${capability}/spec.md`;
    const deltaContent = fs.readFile(deltaPath);
    let centralContent = '';
    if (fs.exists(centralSpecPath)) {
      centralContent = fs.readFile(centralSpecPath);
    } else {
      fs.mkdir(`openspec/specs/${capability}`);
    }
    const merged = mergeSpecs(deltaContent, centralContent, changeId, resolvedDate);
    fs.writeFile(centralSpecPath, merged);
  }

  fs.mkdir('openspec/changes/archive');
  fs.rename(srcDir, destDir);

  // Additive return value (issue #557 D4) — `mergeSpecs` itself is untouched.
  // `unconsolidated: true` means this archive carried NO spec delta into
  // openspec/specs/ (no flat `capability:` declared, or no nested
  // `specs/*/spec.md` matched anything) — a distinct, reported outcome
  // rather than a silently dropped one.
  const consolidated = [...new Set(merges.map(m => m.capability))];
  return { moved: true, consolidated, unconsolidated: merges.length === 0 };
}
