#!/usr/bin/env node
// brain/scripts/axes/platform/adapters/antigravity.mjs — antigravity harness backend
// (issue #256, Track B / B2 Half 1).
//
// Implements the harness verb contract for Antigravity (design.md §"init()
// shape"). Antigravity reads AGENTS.md — the multi-harness standard file
// (measured, Exp 1, #604) — never a hand-authored file. This backend
// COMPILES that file from brain's canonical source docs (Fork 5: compile,
// never `@path` memport) so every standard reader (Gemini, Codex, Claude-as-
// observer) sees the same self-contained content.
//
// Exported functions are called by brain/scripts/harness/cli.mjs; callers
// should never invoke Antigravity directly. Zero cli.mjs change — the
// dispatcher is already backend-agnostic (plain.mjs/gentle-ai.mjs are the
// n=2 precedent this extends to n=3).
//
// Verbs:
//   init() — reads the 5 SOURCE_DOCS, compiles AGENTS.md via compileAgentsMd(),
//            writes it to AGENTS_EMIT_PATH. Never throws.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, posix as posixPath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileSettingsHooksJson } from '../lib/settings-hooks.mjs';
import { mergeSettings } from '../../../lib/installer.mjs';
import { rolesSection } from '../../../roles/first-party/project-role.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

// ---------------------------------------------------------------------------
// Frozen contract: canonical source docs (design's exact list and order) +
// the emitted file's repo-root-relative path (MEASURED target, Exp 1).
// ---------------------------------------------------------------------------

/** The 5 canonical brain/ docs AGENTS.md is compiled from, in this exact order. */
export const SOURCE_DOCS = Object.freeze([
  'brain/HOME.md',
  'brain/core/methodology/agent-authorities.md',   // Tier table VERBATIM (Exp 4)
  'brain/core/methodology/harness-contract.md',     // verb table
  'brain/core/methodology/sdd-layout.md',           // layout summary
  'brain/core/methodology/workflow-governance.md',  // gate list + skip labels (Fork B)
]);

/** Repo-root-relative path Antigravity reads (measured, Exp 1). */
export const AGENTS_EMIT_PATH = 'AGENTS.md';

/** Repo-root-relative path for Antigravity native settings hooks (issue #305). */
export const GEMINI_SETTINGS_EMIT_PATH = '.gemini/settings.json';

/**
 * No agent runtime to version-check (issue #123).
 *
 * Antigravity is an IDE: it reads AGENTS.md and .gemini/settings.json, and this
 * repo installs no antigravity CLI (`install-tools.sh` installs `claude` and
 * `gentle-ai`, nothing else). Declaring `null` says "there is nothing to probe"
 * — which day-start reports as exactly that, distinct from "the probe failed".
 * The export exists so the seam is uniform across backends: the day a queryable
 * CLI ships, this becomes a descriptor literal, not a new mechanism. A backend
 * that omits the export entirely reports `seam-missing`, not this state (#614).
 */
export const AGENT_RUNTIME = null;

export const REGENERATE_HINT = 'AGENT_PLATFORM=antigravity npm run brain:env:init';

// The settings-hooks payload itself is NOT antigravity-specific and no longer
// lives here (issue #315): it was byte-identical to claude's copy, down to the
// commit-bypass guard string. What is antigravity-specific is
// GEMINI_SETTINGS_EMIT_PATH above. See settings-hooks.mjs.
//
// This comment deliberately does NOT spell out the flag it refers to. Naming it
// would be the only line in this file matching the `no-verify-bypass` rule, and
// keeping the file exempt for the sake of one comment blinds that rule to a real
// invocation added here later — measured, and removed with the exemption.

// ---------------------------------------------------------------------------
// Relative-link rebasing (CP-B2 inaugural-read finding, owner ruling).
//
// A splice-verbatim compile reproduces each source doc's relative markdown
// links UNCHANGED — but a relative link is only correct relative to ITS OWN
// source doc's location. Spliced into AGENTS.md at repo root, the SAME link
// text resolves to a DIFFERENT (often outside-the-repo) target: e.g.
// brain/HOME.md's `../docs/adoption.md` resolves to `<repo>/docs/adoption.md`
// from brain/, but to a path OUTSIDE the repo from AGENTS.md at repo root.
// Antigravity follows the file (Exp 4, #604) — a broken link is a real
// consumer defect. This rewrites each relative link's TARGET (never its
// visible text) to resolve identically from AGENTS_EMIT_PATH's location.
// Left untouched: absolute URLs (scheme://…, mailto:…), pure anchors (#…),
// and links already root-relative (/…).
// ---------------------------------------------------------------------------

const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g;

function isSchemeAnchorOrRootRelative(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return true; // scheme: http:, https:, mailto:, ...
  if (url.startsWith('#')) return true;               // pure anchor
  if (url.startsWith('/')) return true;                // already root-relative
  return false;
}

/**
 * Rebases one relative link target so it resolves identically from
 * `emitDir` as it did from `sourceDir`. Preserves any `#anchor` suffix.
 */
function rebaseLinkTarget(url, sourceDir, emitDir) {
  const hashIdx = url.indexOf('#');
  const rawPath = hashIdx === -1 ? url : url.slice(0, hashIdx);
  const anchor = hashIdx === -1 ? '' : url.slice(hashIdx);
  const resolved = posixPath.join(sourceDir, rawPath);
  const rebased = posixPath.relative(emitDir, resolved) || '.';
  return rebased + anchor;
}

/**
 * Rewrites every relative markdown link `[text](url)` in `content` — whose
 * own location is `sourceRelPath` — to resolve to the SAME target from
 * `emitRelPath`'s location. Fs-free, pure.
 */
function rebaseRelativeLinks(content, sourceRelPath, emitRelPath) {
  const sourceDir = posixPath.dirname(sourceRelPath);
  const emitDir = posixPath.dirname(emitRelPath);

  return content.replace(MARKDOWN_LINK_RE, (match, text, url, title) => {
    if (isSchemeAnchorOrRootRelative(url)) return match;
    return `[${text}](${rebaseLinkTarget(url, sourceDir, emitDir)}${title})`;
  });
}

// ---------------------------------------------------------------------------
// Pure compiler — fs-free by design (design's "one coherent unit" rationale):
// the same function is exercised by the unit test AND the drift-guard, so a
// non-deterministic compiler would make byte-equality flaky by construction.
// ---------------------------------------------------------------------------

/**
 * Compiles the self-contained AGENTS.md content from an injected docs map.
 * Splices each SOURCE_DOCS entry's content behind a provenance banner —
 * verbatim except for relative markdown links, which are REBASED (target
 * only, never the visible text) so they resolve correctly from
 * AGENTS_EMIT_PATH's location instead of the source doc's own location
 * (REQ-B2-2 binds the outcome — a working, provenance-declared file — not a
 * byte-identical splice of link targets that would only be correct in situ).
 *
 * REFUSES an incomplete docs map (#509). It used to fall back to `?? ''` per
 * section, so passing an ARRAY — the shape a new caller reaches for first —
 * keyed nothing, emitted five empty sections, deleted 543 lines from AGENTS.md
 * and returned normally (measured while promoting #529 by hand; caught only by
 * reading the diff). `init()` never relied on that fallback — it substitutes ''
 * explicitly on a read failure and warns — so a missing key means the CALLER is
 * wrong: the evidence-reader-empty-on-failure anti-pattern, one layer down.
 *
 * @param {{ [relPath: string]: string }} docs Keyed by SOURCE_DOCS relative path.
 * @returns {string} The compiled AGENTS.md content.
 * @throws {TypeError} When any SOURCE_DOCS key is missing or is not a string.
 */
// #576 T3: `roles` is ADDITIVE and OPTIONAL — omitted or empty, the output is
// byte-identical to the five-doc compile (proven by test against the committed
// AGENTS.md); provided, a first-party roles section APPENDS. The base document
// never moves.
export function compileAgentsMd(docs, { roles } = {}) {
  const missing = SOURCE_DOCS.filter((relPath) => typeof docs?.[relPath] !== 'string');
  if (missing.length > 0) {
    throw new TypeError(
      `compileAgentsMd: docs must be an object keyed by SOURCE_DOCS relative path — ` +
        `${missing.length} of ${SOURCE_DOCS.length} missing or not a string: ${missing.join(', ')}. ` +
        `Got ${Array.isArray(docs) ? 'an array' : typeof docs}. ` +
        'Compiling with empty sections would silently gut AGENTS.md (#509).',
    );
  }

  const banner =
    `<!-- generated from ${SOURCE_DOCS.join(', ')} — do not edit.\n` +
    `     Regenerate: ${REGENERATE_HINT}\n` +
    `     Drift-guarded by antigravity.drift.test.mjs — hand-edits fail CI. -->`;

  const sections = SOURCE_DOCS.map((relPath) => {
    const rebased = rebaseRelativeLinks(docs[relPath], relPath, AGENTS_EMIT_PATH);
    return `<!-- source: ${relPath} -->\n\n${rebased}`;
  });

  const base = [banner, ...sections].join('\n\n---\n\n') + '\n';
  if (!Array.isArray(roles) || roles.length === 0) return base;   // byte-identity when absent
  return base + '\n---\n\n' + rolesSection(roles) + '\n';
}

// ---------------------------------------------------------------------------
// Default injectable implementations
// ---------------------------------------------------------------------------

function _defaultReadDoc(relPath, root) {
  return readFileSync(join(root, relPath), 'utf8');
}

function _defaultWriteFile(relPath, content, root) {
  const fullPath = join(root, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

/**
 * Reads relPath's raw content, or `null` if it does not exist. Mirrors
 * claude.mjs's read seam (issue #1139) — a malformed-but-present file's
 * JSON.parse failure is the caller's business (it knows the path).
 */
function _defaultReadFile(relPath, root) {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf8');
}

// ---------------------------------------------------------------------------
// Verb: init
// ---------------------------------------------------------------------------

/**
 * Compiles and writes AGENTS.md from the 5 canonical SOURCE_DOCS and
 * emits .gemini/settings.json hooks. Never throws.
 *
 * @param {object} [opts] Injectable seams.
 * @param {(relPath: string) => string} [opts._readDoc]
 *   Reads one source doc's content. Defaults to real readFileSync from _repoRoot.
 * @param {(relPath: string, content: string) => void} [opts._writeAgents]
 *   Writes the compiled content to relPath.
 * @param {() => (string|null)} [opts._readGeminiSettings]
 *   Reads the existing .gemini/settings.json raw content, or `null` if absent
 *   (issue #1139). Defaults to real readFileSync from _repoRoot.
 * @param {(relPath: string, content: string) => void} [opts._writeGeminiSettings]
 *   Writes the compiled .gemini/settings.json content.
 * @param {string} [opts._repoRoot] Repo root used by the default seams.
 * @returns {Promise<{ missingDocs: string[], agentsWritten: boolean, geminiWritten: boolean, geminiSettingsError?: string }>}
 *   Additive report of what init() could not read or write. No `ok` field —
 *   `init()` keeps its "never throws" contract; only its return value grows
 *   (design.md "Additive report object, not `{ ok: false }`"). A caller that
 *   discards or never inspects the resolved value observes no behavior change.
 *   `geminiSettingsError` is present ONLY when the existing
 *   `.gemini/settings.json` could not be parsed as JSON — the one case where
 *   `init()` refuses to write it rather than silently overwrite (#1127: no
 *   report-success-over-a-failure). `geminiWritten` is `false` in that case too.
 */
export async function init({
  _readDoc,
  _writeAgents,
  _readGeminiSettings,
  _writeGeminiSettings,
  _repoRoot = repoRoot,
} = {}) {
  const readDoc = _readDoc ?? ((relPath) => _defaultReadDoc(relPath, _repoRoot));
  const writeAgents = _writeAgents ?? ((relPath, content) => _defaultWriteFile(relPath, content, _repoRoot));
  const readGeminiSettings = _readGeminiSettings ?? (() => _defaultReadFile(GEMINI_SETTINGS_EMIT_PATH, _repoRoot));
  const writeGeminiSettings = _writeGeminiSettings ?? ((relPath, content) => _defaultWriteFile(relPath, content, _repoRoot));

  const missingDocs = [];
  const docs = {};
  for (const relPath of SOURCE_DOCS) {
    try {
      docs[relPath] = readDoc(relPath);
    } catch (err) {
      console.warn(`  harness: antigravity could not read ${relPath} — ${err.message}`);
      docs[relPath] = '';
      missingDocs.push(relPath);
    }
  }

  const content = compileAgentsMd(docs);

  let agentsWritten = true;
  try {
    writeAgents(AGENTS_EMIT_PATH, content);
  } catch (err) {
    console.warn(`  harness: antigravity could not write ${AGENTS_EMIT_PATH} — ${err.message}`);
    agentsWritten = false;
  }

  // .gemini/settings.json is MERGED into any existing file (issue #1139),
  // through the same mergeSettings core claude.mjs and brain:upgrade use —
  // never overwritten unconditionally.
  const brainSettings = JSON.parse(compileSettingsHooksJson());

  let geminiWritten = true;
  let geminiSettingsError;
  const existingRaw = readGeminiSettings();
  let existingGeminiSettings = null;
  if (existingRaw != null) {
    try {
      existingGeminiSettings = JSON.parse(existingRaw);
    } catch (err) {
      geminiSettingsError =
        `antigravity: ${GEMINI_SETTINGS_EMIT_PATH} is not valid JSON — ${err.message}. ` +
        `Fix or remove the file, then re-run brain:env:init.`;
      console.warn(`  harness: ${geminiSettingsError}`);
    }
  }

  if (geminiSettingsError) {
    geminiWritten = false;
  } else {
    const merged = mergeSettings(existingGeminiSettings, brainSettings);
    const settingsContent = JSON.stringify(merged, null, 2) + '\n';
    try {
      writeGeminiSettings(GEMINI_SETTINGS_EMIT_PATH, settingsContent);
    } catch (err) {
      console.warn(`  harness: antigravity could not write ${GEMINI_SETTINGS_EMIT_PATH} — ${err.message}`);
      geminiWritten = false;
    }
  }

  return {
    missingDocs,
    agentsWritten,
    geminiWritten,
    ...(geminiSettingsError ? { geminiSettingsError } : {}),
  };
}
