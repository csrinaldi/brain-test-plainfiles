// fenced-blocks.mjs — the ONE fence splitter for declared blocks in Markdown
// FILES (issue #495, design D2). Extracted from `lib/amendment-draft.mjs` as a
// PURE MOVE: the function body below was byte-identical to the one that lived
// there, and its three cases moved verbatim into `fenced-blocks.test.mjs`.
//
// WHY IT IS SEPARATE FROM `review/lib/yaml-block.mjs`, which also reads fences.
// They answer different questions and neither subsumes the other:
//
//   yaml-block.mjs   the inverse of ONE emitter family, over a VCS COMMENT —
//                    a body that IS a single ```yaml block carrying
//                    `protocol: brain-review/2`. `extractFencedBlock` reads the
//                    FIRST fence, which is right when there is only one, and its
//                    FENCE_RE is hardened (#487) so a fence inside a VALUE cannot
//                    truncate the block.
//
//   this module      a DOCUMENT with many blocks, where the block wanted is
//                    identified by its info-string tag (```brain-amendment/1,
//                    ```amend-find, ```brain-checkpoint/1, ```brain-graph/1). Position
//                    is not a selector here: a checkpoint report is definitionally full
//                    of fences, because the reviewer's evidence is command output.
//
// The split is by SHAPE OF INPUT, not by taste, and it is recorded here so the
// next reader does not "unify" them into a parser that is wrong for both.
//
// ── THE RULE, SINCE #709 (design D2): THIS SPLITTER AGREES WITH THE RENDERER ──
//
// Its input is prose a human wrote, read back by code that decides whether a
// dependency EXISTS. So the only defensible contract is the one the renderer the
// author was looking at already applies — CommonMark. Anywhere the two disagree, the
// author's screen wins the argument and the reader has fabricated something.
//
//   Opener     ≤3 leading spaces, then ≥3 identical ` or ~. 4+ spaces is an indented
//              code block, so the "fence" is content — which is what the page shows.
//   Info       rest of the line, trimmed. A BACKTICK fence may not carry ` in its info
//              string; a tilde fence may. (CommonMark; also what the old `[^`]*?`
//              already enforced for backticks.)
//   Closer     same delimiter char, run >= the opener's, ≤3 leading spaces, nothing
//              after it but whitespace. Independent of the opener's indent.
//   In FENCE   every line is content, including a fence of the other type or a shorter
//              run. ` and ~ are peers and NEVER close each other.
//   Content    de-indented by up to the OPENER's indent. At indent 0 that removes
//              nothing — byte-for-byte identical, which is what D14 rests on.
//   Nesting    none, in either direction. First opener wins; only its matching closer
//              exits. Inside a fence CommonMark reparses nothing, and neither do
//              GitHub or GitLab.
//
// THE CLOSER RULE IS DECIDED IN THE LOOSE DIRECTION, DELIBERATELY (#710 finding 3):
// an indented closer closes, and a longer-run closer closes. The tempting analogy is
// REQ-487-5, which made `yaml-block.mjs` strict — and it does NOT transfer, because it
// answers a different question about a different input. `yaml-block.mjs` reads a
// single-block artefact OUR OWN EMITTER wrote, where `yamlScalar` escapes newlines so a
// fence cannot occur inside a value at all: exactness is provably free there. This
// module reads human prose with no escaping guarantee, so strictness is not free — it
// would report a CommonMark-legal document as "never closed" and publish a refusal
// about a document that is fine. A false refusal here is a fabricated fact, and this
// module exists to stop those.
//
// THREE STATES — TEXT, FENCE, COMMENT. No recursion, no CommonMark library, no
// dependency. The opener is HAND-SCANNED rather than matched by a regex (D8): the old
// /^(`{3,})\s*([^`]*?)\s*$/ backtracks roughly cubically on a line of backticks, a long
// run of spaces and a later backtick, and issue bodies are the input.
//
// TWO SHAPES DO NOT DECLARE, AND SAY SO through `skipped` rather than by vanishing:
//   blockquote (D3)   a `>`-prefixed fence is literally quotation — the canonical
//                     "someone else wrote this" shape. Reading fences inside block
//                     containers needs marker stripping plus lazy-continuation rules,
//                     the CommonMark rabbit hole this change refuses to enter. Honest
//                     cost: a genuine declaration inside a blockquote is not read. That
//                     is an omission, which is the safe direction.
//   html-comment (D4) `<!-- … -->` renders as NOTHING, so wrapping a block in one says
//                     more clearly than any other shape that it must not be read.
// Plus `indented-code`, the 4+-space opener. All three are RECORDED, so a caller can
// tell "nobody declared" apart from "someone declared somewhere I refuse to look".

/**
 * Scans one line for a fence delimiter. Hand-rolled, single pass, no backtracking (D8).
 * Applies no indent limit — the caller decides what an over-indented fence means.
 *
 * @param {string} line
 * @returns {{indent:number, char:string, run:number, info:string}|null}
 */
function scanFence(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  const indent = i;
  const char = line[i];
  if (char !== '`' && char !== '~') return null;
  let run = 0;
  while (i + run < line.length && line[i + run] === char) run++;
  if (run < 3) return null;
  const info = line.slice(i + run).trim();
  // CommonMark: a backtick fence's info string may not contain a backtick, so a line
  // like ``` `code` ``` opens nothing. Tilde fences carry no such restriction.
  if (char === '`' && info.includes('`')) return null;
  return { indent, char, run, info };
}

/** The DECLARED identity of a fence: the first whitespace-delimited word of its info
 *  string. `tag` deliberately keeps its original meaning — the whole trimmed info
 *  string — because `amendment-draft.mjs` and `checkpoint-block.mjs` compare it with
 *  `===`, and redefining it under them would silently widen both (#495 D1). */
function firstWord(info) {
  const s = String(info ?? '').trim();
  const cut = s.search(/\s/);
  return cut === -1 ? s : s.slice(0, cut);
}

/** Strips up to `n` leading spaces. At n === 0 this returns the line unchanged, byte
 *  for byte — the no-op `amend-find`'s exact-anchor extraction depends on (D14). */
function deindent(line, n) {
  let k = 0;
  while (k < n && line[k] === ' ') k++;
  return line.slice(k);
}

/** Is this line a blockquote marker line? Hand-scanned for the same reason as the
 *  fence: ≤3 spaces, then `>`. Returns the remainder after the quote markers. */
function scanBlockquote(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3 || line[i] !== '>') return null;
  while (i < line.length && (line[i] === '>' || line[i] === ' ')) i++;
  return line.slice(i);
}

/** Does this line open an HTML comment (CommonMark HTML block type 2)? ≤3 spaces,
 *  then `<!--`. Mutually exclusive with a fence opener by first character, so the
 *  precedence between them needs no tie-break (D4). */
function opensComment(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return false;
  return line.startsWith('<!--', i);
}

/**
 * Splits Markdown into its fenced blocks, agreeing with the renderer that produced the
 * text (D2). Sequential — once inside a fence only the matching closer is looked for,
 * so a fence quoted inside another is content.
 *
 * @param {string} text
 * `unterminated` deliberately does NOT gain a `lang` field, unlike `blocks[]`. D14's
 * additive-contract argument is what makes this change safe for the two sibling
 * consumers, and `fenced-blocks.test.mjs`'s third original case asserts the whole
 * object with `deepEqual` — so one extra field there is a BREAKING change wearing an
 * additive costume, and the verbatim case is the sentinel that says so. Callers that
 * need the first word derive it; `epic-graph.mjs` already does.
 *
 * @returns {{
 *   blocks: {tag:string, lang:string, content:string, line:number}[],
 *   unterminated: {tag:string, line:number}|null,
 *   unterminatedComment: {line:number}|null,
 *   skipped: {line:number, tag:string, lang:string, reason:'blockquote'|'indented-code'|'html-comment'}[],
 * }}
 */
export function fencedBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  const skipped = [];
  let open = null;
  let comment = null;

  const skip = (i, info, reason) =>
    skipped.push({ line: i + 1, tag: info, lang: firstWord(info), reason });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── FENCE ── every line is content until the matching closer. Checked FIRST, so a
    // `<!--`, a `>` or a fence of the other type inside a block is content, as rendered.
    if (open !== null) {
      const f = scanFence(line);
      const closes =
        f !== null && f.indent <= 3 && f.char === open.char && f.run >= open.run && f.info === '';
      if (closes) {
        blocks.push({ tag: open.tag, lang: firstWord(open.tag), content: open.body.join('\n'), line: open.line });
        open = null;
        continue;
      }
      open.body.push(deindent(line, open.indent));
      continue;
    }

    // ── COMMENT ── renders as nothing, so nothing inside it declares. A fence opener
    // in here is recorded, never read.
    if (comment !== null) {
      const f = scanFence(line);
      if (f !== null && f.run >= 3) skip(i, f.info, 'html-comment');
      if (line.includes('-->')) comment = null;
      continue;
    }

    // ── TEXT ──
    if (opensComment(line)) {
      // A comment that opens and closes on one line never enters COMMENT state.
      if (!line.slice(line.indexOf('<!--') + 4).includes('-->')) comment = { line: i + 1 };
      continue;
    }

    const quoted = scanBlockquote(line);
    if (quoted !== null) {
      const f = scanFence(quoted);
      if (f !== null) skip(i, f.info, 'blockquote');
      continue;
    }

    const f = scanFence(line);
    if (f === null) continue;
    if (f.indent > 3) {
      // 4+ spaces is an indented code block. The renderer shows this as content, and
      // so does this reader — but it says which line it declined to open on.
      skip(i, f.info, 'indented-code');
      continue;
    }
    open = { char: f.char, run: f.run, indent: f.indent, tag: f.info, line: i + 1, body: [] };
  }

  // An unterminated fence is reported, never silently dropped: a contract block whose
  // closing fence is missing used to read as "this draft carries no contract at all",
  // which sends the human looking for the wrong mistake.
  //
  // It is reported UNCONDITIONALLY — the splitter never asks whose fence it was (D5).
  // An unterminated opener runs to the end of the document, so nothing below it can be
  // a block and there is no attribution decision to make. Blocks closed ABOVE it are
  // complete and stand. A caller that filters this report by tag reintroduces exactly
  // the attribution ambiguity #710 finding 1 records.
  //
  // An unterminated COMMENT gets its own field. Overloading `unterminated` would make
  // `amendment-draft.mjs` print "the fenced block opened at draft line N is never
  // closed" about a comment — a true-shaped sentence about the wrong thing.
  return {
    blocks,
    unterminated: open === null ? null : { tag: open.tag, line: open.line },
    unterminatedComment: comment,
    skipped,
  };
}
