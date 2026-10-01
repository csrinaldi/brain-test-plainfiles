// blame.mjs — git blame --porcelain -> per-line attribution (Q2/D13).
// Pure, imported by the browser AND by node:test (D9): it parses TEXT
// only, no `child_process`, no `node:` builtin. The one `git blame
// --porcelain` subprocess per drawer open is run server-side
// (`change-route.mjs`, injected `_run`); this module never shells out.
//
// Porcelain shape: a header line `<sha> <origLine> <finalLine>[ <numLines>]`,
// then metadata lines (`author …`, `author-time …`, …) THE FIRST TIME a
// commit appears, then the line content prefixed with a tab. A REPEATED
// commit (the common case — most lines in a file share their last commit)
// omits the metadata block entirely; its author/time come from the cache
// built the first time that sha was seen.
//
// Never empty-on-failure: absent, empty, or unparseable input is a said
// failure (`{ok:false, reason}`), never a blank map read as "no history".

const HEADER_RE = /^([0-9a-f]{7,40}) (\d+) (\d+)(?: (\d+))?$/;
const AUTHOR_RE = /^author (.+)$/;
const AUTHOR_TIME_RE = /^author-time (\d+)$/;

/**
 * parseBlame({text}) -> {ok:true, value: Record<number,{sha,author,authorTime}>} | {ok:false, reason}
 *
 * @param {{text: string|null}} input
 */
export function parseBlame({ text } = {}) {
  if (typeof text !== 'string') return { ok: false, reason: 'no git blame output was given' };
  if (text.trim() === '') return { ok: false, reason: 'git blame output was empty' };

  const commits = new Map(); // sha -> {author, authorTime}
  const value = {};
  let current = null; // {sha, finalLine} for the header line currently being read
  let sawContentLine = false;

  for (const line of text.split(/\r\n|\n/)) {
    if (line.startsWith('\t')) {
      if (current) {
        const meta = commits.get(current.sha) ?? {};
        value[current.finalLine] = { sha: current.sha, author: meta.author ?? null, authorTime: meta.authorTime ?? null };
        sawContentLine = true;
      }
      current = null;
      continue;
    }
    const header = HEADER_RE.exec(line);
    if (header) {
      const [, sha, , finalLine] = header;
      current = { sha, finalLine: Number(finalLine) };
      if (!commits.has(sha)) commits.set(sha, {});
      continue;
    }
    if (!current) continue; // a stray line outside any header/content pair — ignored, never crashes
    const author = AUTHOR_RE.exec(line);
    if (author) { commits.get(current.sha).author = author[1]; continue; }
    const authorTime = AUTHOR_TIME_RE.exec(line);
    if (authorTime) commits.get(current.sha).authorTime = new Date(Number(authorTime[1]) * 1000).toISOString();
  }

  if (!sawContentLine) return { ok: false, reason: 'no parseable blame lines were found' };
  return { ok: true, value };
}
