// home-index.mjs — Pure helper to insert an ADR link into brain/HOME.md's
// '### Architecture decisions' section, plus a thin CLI for file I/O.
//
// Agent-agnostic (REQ-7): no agent-coupled logic — this helper knows nothing
// about which AI agent invokes it. Any current or future agent adapter calls
// this same CLI instead of re-implementing the HOME.md-patch algorithm in prose
// (install-home-scaffold, REQ-5). Enforced by home-helpers-neutrality.test.mjs.
//
// insertAdrLink is a pure string→string function (input text in, patched
// text out, never touches disk) — the CLI below is the only I/O layer.
//
// Usage:
//   import { insertAdrLink } from './lib/home-index.mjs';
//   const { text, inserted, reason, linesToAdd } = insertAdrLink(homeText, { number, slug, description });
//
//   node brain/scripts/lib/home-index.mjs insert --home <path> --number <n> --slug <s> --desc <d>

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEADING = '### Architecture decisions';
const HEADING_RE = /^###\s+Architecture decisions\s*$/;
// Bounds the section: the next `---` separator or any `## ` heading closes it.
const SECTION_BOUNDARY_RE = /^(---|## )/;
// Exported for `status/adr-index.mjs`'s drift check (#879): the ONE definition
// of what a HOME.md ADR line is, so the writer and the reader cannot disagree.
export const ADR_LINE_RE = /^- \[ADR-(\d{4})\]\(project\/decisions\/[^)]+\)/;

function formatLine({ number, slug, description }) {
  const nnnn = String(number).padStart(4, '0');
  return `- [ADR-${nnnn}](project/decisions/${slug}.md) — ${description}`;
}

/**
 * Inserts (or no-ops) a single ADR link into the '### Architecture decisions'
 * section of homeText. Pure — never mutates the input, never touches disk.
 *
 * Branches (design Decision 4):
 *   1. Idempotent — the link is already present → { inserted: false, reason: 'already-present' }.
 *   2. Anchor absent/ambiguous → fail-safe, input untouched + linesToAdd.
 *   3. Section has ≥1 existing ADR link → insert immediately after the LAST one.
 *   4. Section is empty (heading only) → insert immediately after the heading.
 *
 * @param {string} homeText
 * @param {{ number: number|string, slug: string, description: string }} adr
 * @returns {{ text: string, inserted: boolean, reason?: string, linesToAdd?: string[] }}
 */
export function insertAdrLink(homeText, adr) {
  const line = formatLine(adr);
  const linkPath = `project/decisions/${adr.slug}.md`;
  // Newline-style-agnostic: detect the file's EOL and split/join with it so a
  // CRLF HOME.md round-trips as CRLF (never silently converted to LF).
  const eol = homeText.includes('\r\n') ? '\r\n' : '\n';
  const lines = homeText.split(/\r?\n/);

  const headingIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i].trimEnd())) headingIndices.push(i);
  }

  if (headingIndices.length === 0) {
    return { text: homeText, inserted: false, reason: 'anchor-not-found', linesToAdd: [line] };
  }
  if (headingIndices.length > 1) {
    return { text: homeText, inserted: false, reason: 'anchor-ambiguous', linesToAdd: [line] };
  }

  const headingIdx = headingIndices[0];
  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (SECTION_BOUNDARY_RE.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }

  let lastAdrIdx = -1;
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    if (lines[i].includes(`](${linkPath})`)) {
      return { text: homeText, inserted: false, reason: 'already-present' };
    }
    if (ADR_LINE_RE.test(lines[i])) lastAdrIdx = i;
  }

  const insertAt = lastAdrIdx === -1 ? headingIdx + 1 : lastAdrIdx + 1;
  const newLines = [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)];
  return { text: newLines.join(eol), inserted: true };
}

// ── CLI (I/O only — keeps insertAdrLink pure) ────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--home') args.home = argv[++i];
    else if (argv[i] === '--number') args.number = argv[++i];
    else if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--desc') args.desc = argv[++i];
  }
  return args;
}

/**
 * Runs the `insert` CLI: reads --home, calls insertAdrLink, writes on success.
 * @param {string[]} argv - process.argv.slice(3) (after the `insert` verb).
 * @returns {number} exit code — 0 patched/no-op, 1 I/O or unexpected error, 2 bad usage, 3 fail-safe.
 */
export function runInsertCli(argv) {
  const { home, number, slug, desc } = parseArgs(argv);
  if (!home || !number || !slug || !desc) {
    console.error('Usage: node home-index.mjs insert --home <path> --number <n> --slug <s> --desc <d>');
    return 2;
  }

  let homeText;
  try {
    homeText = readFileSync(home, 'utf8');
  } catch (err) {
    console.error(`HOME.md patch FAILED — could not read '${home}': ${err.code ?? err.message}`);
    return 1;
  }

  const result = insertAdrLink(homeText, { number, slug, description: desc });
  const nnnn = String(number).padStart(4, '0');

  if (result.inserted) {
    try {
      writeFileSync(home, result.text, 'utf8');
    } catch (err) {
      console.error(`HOME.md patch FAILED — could not write '${home}': ${err.code ?? err.message}`);
      return 1;
    }
    console.log(`HOME.md patched: inserted ADR-${nnnn}`);
    return 0;
  }
  if (result.reason === 'already-present') {
    console.log(`HOME.md: ADR-${nnnn} already indexed`);
    return 0;
  }
  console.error("HOME.md patch ABORTED — could not locate an unambiguous '### Architecture decisions' anchor.");
  console.error('HOME.md was NOT modified. Add these lines manually:');
  for (const l of result.linesToAdd ?? []) console.error(`  ${l}`);
  return 3;
}

// Main-module guard: run as `node brain/scripts/lib/home-index.mjs insert …`
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename && process.argv[2] === 'insert') {
  process.exit(runInsertCli(process.argv.slice(3)));
}
