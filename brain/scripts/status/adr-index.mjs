// adr-index.mjs — the ADR index as data, and its drift against HOME.md (#879).
//
// The 34 files under `brain/project/decisions/` share three prose conventions:
// a title line `# ADR-NNNN — Title`, a `**Status**: <word> …` line, and
// `## Amendment N — summary (issue #N)` headings. This module reads exactly
// those three and nothing cleverer. A declared data block per ADR (ADR-0032
// style) was ruled OUT until the drift check below shows the convention widely
// broken (#879 ruling 2) — measured on this tree, it is not.
//
// AN UNREADABLE ADR IS KEPT IN PLACE, as `{path, ok: false, reason}`. Dropping
// it would make the drift check say "HOME.md lists an ADR that does not exist"
// about a file that exists and merely failed to parse — the reader-empty-on-
// failure class (`brain/core/anti-patterns/evidence-reader-empty-on-failure.md`).
//
// PURE PARSE, INJECTED READ. `parseAdr`, `homeAdrList` and `adrDrift` take text;
// `readAdrIndex` is the only edge and takes its I/O through seams, the shape
// `release-debt.mjs` uses.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ADR_LINE_RE } from '../lib/home-index.mjs';

export const DECISIONS_DIR = 'brain/project/decisions';
const ADR_FILE_RE = /^adr-(\d{4})-.*\.md$/;
const TITLE_RE = /^#\s+ADR-(\d{4})\s*[—–-]+\s*(.+?)\s*$/m;
const STATUS_RE = /^\*\*Status\*\*:\s*(.+?)\s*$/m;
const DATE_RE = /^\*\*Date\*\*:\s*(.+?)\s*$/m;
const AMENDMENT_RE = /^##\s+Amendment\s+(\d+)\s*[—–-]+\s*(.+?)\s*$/gm;
const AMENDED_ON_RE = /amended\s+(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/i;
const SUPERSEDED_BY_RE = /superseded\s+by\s+ADR-(\d{4})/gi;
const SUPERSEDES_RE = /supersed(?:es|ing)\s+ADR-(\d{4})/gi;
const ISSUE_REF_RE = /#(\d+)\b/g;

/** `dd/mm/yyyy` → `yyyy-mm-dd`; an ISO date passes through; anything else is returned as written. */
export function normalizeDate(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const dmy = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return s || null;
}

function uniqueNumbers(text, re) {
  const out = new Set();
  for (const m of text.matchAll(re)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/**
 * parseAdr() — one file's text → its index row. PURE.
 *
 * @param {string} text
 * @param {{path: string}} opts
 * @returns {{ok: true, path: string, number: number, title: string, status: string,
 *   statusLine: string, date: string|null, amendments: Array<{n: number, date: string|null,
 *   issue: number|null, summary: string}>, supersedes: number[], supersededBy: number|null,
 *   issues: number[]} | {ok: false, path: string, reason: string}}
 */
export function parseAdr(text, { path } = {}) {
  if (typeof text !== 'string') return { ok: false, path, reason: 'the file could not be read' };
  const title = text.match(TITLE_RE);
  if (!title) return { ok: false, path, reason: 'no `# ADR-NNNN — Title` line' };
  const status = text.match(STATUS_RE);
  if (!status) return { ok: false, path, reason: 'no `**Status**:` line' };

  const statusLine = status[1];
  // The first word is the status; everything after it is the amendment trail.
  const statusWord = statusLine.match(/^([A-Za-z]+)/)?.[1] ?? statusLine;
  const amendedOn = normalizeDate(statusLine.match(AMENDED_ON_RE)?.[1] ?? null);

  const amendments = [];
  for (const m of text.matchAll(AMENDMENT_RE)) {
    const heading = m[2];
    const issue = heading.match(/\(issue\s+#(\d+)\)\s*$/i);
    amendments.push({
      n: Number(m[1]),
      // One `amended dd/mm/yyyy` per status line today; a heading carries no
      // date of its own, so every amendment reads the same one. Stated, not hidden.
      date: amendedOn,
      issue: issue ? Number(issue[1]) : null,
      summary: issue ? heading.slice(0, issue.index).trim() : heading.trim(),
    });
  }

  // Supersession is read from the header and the amendment headings only: the
  // body of an ADR discusses other ADRs freely, and "supersedes" in prose is not
  // a relation this index may assert.
  const headerText = [title[0], statusLine, ...amendments.map((a) => a.summary)].join('\n');
  const supersededBy = uniqueNumbers(headerText, SUPERSEDED_BY_RE);
  const supersedes = uniqueNumbers(headerText, SUPERSEDES_RE);

  return {
    ok: true,
    path,
    number: Number(title[1]),
    title: title[2],
    status: statusWord,
    statusLine,
    date: normalizeDate(text.match(DATE_RE)?.[1] ?? null),
    amendments,
    supersedes,
    supersededBy: supersededBy[0] ?? null,
    issues: uniqueNumbers(text, ISSUE_REF_RE),
  };
}

/**
 * readAdrIndex() — every `adr-NNNN-*.md` under the decisions dir, sorted by
 * filename. Never throws: an unlistable dir is the section's own "could not
 * read"; an unreadable file is kept in place (header).
 *
 * @returns {{ok: true, value: Array} | {ok: false, reason: string}}
 */
export function readAdrIndex({ root, dir = DECISIONS_DIR, _read, _list } = {}) {
  const read = _read ?? ((p) => readFileSync(join(root, p), 'utf8'));
  const list = _list ?? ((p) => readdirSync(join(root, p)));
  let names;
  try {
    names = list(dir).filter((n) => ADR_FILE_RE.test(n)).sort();
  } catch (err) {
    return { ok: false, reason: `${dir} could not be listed: ${err?.message ?? err}` };
  }
  const value = names.map((name) => {
    const path = `${dir}/${name}`;
    let text;
    try { text = read(path); } catch { text = null; }
    return parseAdr(text, { path });
  });
  return { ok: true, value };
}

/**
 * homeAdrList() — the ADR numbers `brain/HOME.md` hand-lists, with the path each
 * line links. PURE; the line grammar is `home-index.mjs`'s own.
 * @returns {Array<{number: number, path: string}>}
 */
export function homeAdrList(homeText) {
  const out = [];
  for (const line of String(homeText ?? '').split('\n')) {
    const m = line.match(ADR_LINE_RE);
    if (!m) continue;
    const link = line.match(/\]\((project\/decisions\/[^)]+)\)/);
    out.push({ number: Number(m[1]), path: link ? `brain/${link[1]}` : null });
  }
  return out;
}

/**
 * adrDrift() — where HOME.md's list and the parser's disagree. PURE. Reports
 * three lists and never decides anything: this slice adds no gate (#879 item 7).
 *
 * @param {Array} index  `readAdrIndex().value`
 * @param {Array<{number:number,path:string|null}>} home  `homeAdrList()`
 * @returns {{homeOnly: Array<{number:number,path:string|null}>, filesOnly: Array<{number:number,path:string}>,
 *   unreadable: Array<{path:string,reason:string}>}}
 */
export function adrDrift(index = [], home = []) {
  const readable = new Map(index.filter((a) => a.ok).map((a) => [a.number, a]));
  const unreadable = index.filter((a) => !a.ok).map((a) => ({ path: a.path, reason: a.reason }));
  const listed = new Set(home.map((h) => h.number));
  return {
    // Listed in HOME.md, and the parser has no readable row for it — the file is
    // missing OR it failed to parse; `unreadable` says which.
    homeOnly: home.filter((h) => !readable.has(h.number)),
    filesOnly: [...readable.values()].filter((a) => !listed.has(a.number)).map((a) => ({ number: a.number, path: a.path })),
    unreadable,
  };
}
