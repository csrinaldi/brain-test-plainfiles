// tasks-list.mjs — tasks.md -> checklist items with line numbers (R881-8
// Tasks tab). Pure, imported by the browser AND by node:test (D9).
//
// The checkbox grammar is `AGENTS.md`'s "Checked-task pattern": `- [ ]`
// (pending), `- [x]`/`- [X]` (done), matched case-insensitively.
//
// Q2 (design.md): per-line actor/timestamp is NOT in `tasks.md`'s text —
// the SERVER reads it via one `git blame --porcelain` per drawer open
// (`blame.mjs` parses it) and hands this module `{line, actor, ts}` rows.
// This module never shells out; a line with no matching row renders
// `actor: 'unknown'`, never a blank.

const CHECKBOX_RE = /^\s*- \[([ xX])\]\s*(.*)$/;

/**
 * parseTasksList({text, path, attribution}) -> {ok:true, value: Array<Item>} | {ok:false, reason}
 *
 * Item: {line, text, done, actor, ts, source:{path,line}}
 *
 * @param {{text: string|null, path: string, attribution?: Array<{line:number,actor:string,ts:string}>}} input
 */
export function parseTasksList({ text, path, attribution = [] } = {}) {
  if (typeof text !== 'string') return { ok: false, reason: 'no tasks.md text was given' };

  const byLine = new Map(
    attribution.filter((a) => a && typeof a.line === 'number').map((a) => [a.line, a]),
  );

  const items = [];
  text.split(/\r\n|\n/).forEach((line, idx) => {
    const m = CHECKBOX_RE.exec(line);
    if (!m) return;
    const lineNo = idx + 1;
    const attr = byLine.get(lineNo);
    items.push({
      line: lineNo,
      text: m[2].trim(),
      done: m[1].toLowerCase() === 'x',
      actor: attr?.actor ?? 'unknown',
      ts: attr?.ts ?? null,
      source: { path, line: lineNo },
    });
  });

  return { ok: true, value: items };
}
