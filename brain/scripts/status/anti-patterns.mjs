// anti-patterns.mjs — the anti-pattern catalogue as data (#879 item 3).
//
// Two directories, one list: `brain/core/anti-patterns/` (generic, upstream)
// and `brain/project/anti-patterns/` (this project's). Each holds one
// anti-pattern per file (`core/anti-patterns/README.md` rule 2) and a README
// that is the index, not an entry. Nothing enumerated them before this; the
// READMEs were hand-written and `brain:nav` only checked that their links resolve.
//
// `issues` are the tickets a file cites — `#N` (current) and `ISSUE-N` (the
// pre-#54 convention four core files still use). Both are read; the reader
// does not care which era wrote the file.
//
// Same edge discipline as `adr-index.mjs`: a dir that cannot be listed is
// reported per scope, never fabricated as empty; an unreadable file is kept in
// place as `{path, ok: false, reason}`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ANTI_PATTERN_DIRS = Object.freeze([
  { scope: 'core', dir: 'brain/core/anti-patterns' },
  { scope: 'project', dir: 'brain/project/anti-patterns' },
]);

const TITLE_RE = /^#\s+(.+?)\s*$/m;
const ISSUE_REF_RE = /(?:#|\bISSUE-)(\d+)\b/g;

/**
 * parseAntiPattern() — one file's text → its catalogue row. PURE.
 * @returns {{ok: true, id: string, title: string, scope: string, path: string, issues: number[]}
 *   | {ok: false, path: string, scope: string, reason: string}}
 */
export function parseAntiPattern(text, { path, scope, id } = {}) {
  if (typeof text !== 'string') return { ok: false, path, scope, reason: 'the file could not be read' };
  const title = text.match(TITLE_RE);
  if (!title) return { ok: false, path, scope, reason: 'no `# Title` line' };
  const issues = new Set();
  for (const m of text.matchAll(ISSUE_REF_RE)) issues.add(Number(m[1]));
  return { ok: true, id, title: title[1], scope, path, issues: [...issues].sort((a, b) => a - b) };
}

/**
 * readAntiPatterns() — every `*.md` but `README.md` under both dirs.
 *
 * @returns {{ok: true, value: {entries: Array, unlistable: Array<{scope: string, dir: string, reason: string}>}}}
 *   The section is always `ok`: one scope's dir being absent is a fact about
 *   that scope (`unlistable`), and the other scope's entries are still real.
 */
export function readAntiPatterns({ root, dirs = ANTI_PATTERN_DIRS, _read, _list } = {}) {
  const read = _read ?? ((p) => readFileSync(join(root, p), 'utf8'));
  const list = _list ?? ((p) => readdirSync(join(root, p)));
  const entries = [];
  const unlistable = [];
  for (const { scope, dir } of dirs) {
    let names;
    try {
      names = list(dir).filter((n) => n.endsWith('.md') && n !== 'README.md').sort();
    } catch (err) {
      unlistable.push({ scope, dir, reason: `${dir} could not be listed: ${err?.message ?? err}` });
      continue;
    }
    for (const name of names) {
      const path = `${dir}/${name}`;
      let text;
      try { text = read(path); } catch { text = null; }
      entries.push(parseAntiPattern(text, { path, scope, id: name.replace(/\.md$/, '') }));
    }
  }
  return { ok: true, value: { entries, unlistable } };
}
