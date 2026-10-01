// markdown.mjs — the ONE door between the vendored tokenizer and the page
// (#1198). marked's token shape stops here: everything below this file sees
// only the small tree this module returns. The rulings are applied in this
// file so the DOM builder can be a dumb walk:
//
//   R1  relative / anchor links render as inert text, never as a link
//   R5  raw html (block or inline) is shown as literal text
//   R6  an image is its alt text; its URL never reaches the tree
//   R7  a link is live only for http(s), after `safeHref` has looked at it
//
// Only `Lexer.lex` is used. The renderer and `marked.parse` emit HTML
// strings, and the page never assigns markup (see marked-usage-guard).
//
// Pure and deterministic: no clock, no randomness, no environment.

import { Lexer } from '../vendor/marked.esm.js';

const MAX_DEPTH = 32;
// The route caps a document at 262144 bytes; twice that is the most this adapter
// will hand the tokenizer. Measured: 2000 nested list indents (4 MB) exhaust
// the heap inside marked, 360 (130 KB) take 0.2 s.
const MAX_INPUT = 524288;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const LANG = /^[\w+-]{1,32}$/;
// Control characters, Unicode whitespace, zero-width and bidi controls. A
// browser strips tabs and newlines anywhere inside a URL, so they are
// stripped here before the scheme is read.
const INVISIBLE = /[\u0000-\u0020\u007F-\u00A0\u1680\u2000-\u200F\u2028-\u202F\u205F-\u2064\u3000\uFEFF]/g;

const defaultLex = (text, options) => Lexer.lex(text, options);

/**
 * Classify an href. Only absolute http(s) URLs with a host and no
 * credentials are ok; everything else says why it is not.
 * @returns {{ok:true, href:string}|{ok:false, reason:'relative'|'anchor'|'scheme'|'malformed'}}
 */
export function safeHref(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };
  const s = raw.replace(INVISIBLE, '');
  if (s.startsWith('#')) return { ok: false, reason: 'anchor' };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!scheme) return { ok: false, reason: 'relative' };
  const name = scheme[1].toLowerCase();
  if (name !== 'http' && name !== 'https') return { ok: false, reason: 'scheme' };
  let url;
  try {
    url = new URL(s);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const sane = (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '' && url.password === '';
  return sane ? { ok: true, href: url.href } : { ok: false, reason: 'malformed' };
}

const rawText = (token) => String(token.raw ?? token.text ?? '');

function inline(tokens) {
  return (tokens ?? []).map(inlineNode);
}

function inlineNode(token) {
  switch (token.type) {
    case 'text':
    case 'escape':
      return { t: 'text', text: String(token.text ?? '') };
    case 'strong':
    case 'em':
    case 'del':
      return { t: token.type, children: inline(token.tokens) };
    case 'codespan':
      return { t: 'codespan', text: String(token.text ?? '') };
    case 'br':
      return { t: 'br' };
    case 'image':
      return { t: 'text', text: `[image: ${token.text ?? ''}]` };
    case 'link': {
      const verdict = safeHref(token.href);
      const children = inline(token.tokens);
      return verdict.ok
        ? { t: 'link', href: verdict.href, children }
        : { t: 'inert', target: String(token.href ?? '').trim(), children };
    }
    default:
      // inline html and anything unknown: shown, never interpreted
      return { t: 'text', text: rawText(token) };
  }
}

const trimEol = (s) => s.replace(/\n+$/, '');
const literal = (token) => ({ t: 'literal', text: trimEol(rawText(token)) });

function blocks(tokens, depth) {
  const out = [];
  for (const token of tokens ?? []) {
    const node = blockNode(token, depth);
    if (node) out.push(node);
  }
  return out;
}

function blockNode(token, depth) {
  switch (token.type) {
    case 'space':
    case 'checkbox':
      return null;
    case 'def':
      return typeof token.tag === 'string' && token.tag.startsWith('^') ? literal(token) : null;
    case 'heading':
      return { t: 'heading', level: token.depth, children: inline(token.tokens) };
    case 'paragraph':
    case 'text':
      return { t: 'paragraph', children: token.tokens ? inline(token.tokens) : [{ t: 'text', text: String(token.text ?? '') }] };
    case 'html':
      return literal(token);
    case 'code':
      return { t: 'code', lang: LANG.test(token.lang ?? '') ? token.lang : null, text: String(token.text ?? '') };
    case 'hr':
      return { t: 'hr' };
    case 'blockquote':
      return depth >= MAX_DEPTH ? literal(token) : { t: 'blockquote', blocks: blocks(token.tokens, depth + 1) };
    case 'list':
      if (depth >= MAX_DEPTH) return literal(token);
      return {
        t: 'list',
        ordered: Boolean(token.ordered),
        start: token.ordered ? (Number.isFinite(token.start) ? token.start : 1) : null,
        items: (token.items ?? []).map((item) => ({
          task: Boolean(item.task),
          checked: item.task ? Boolean(item.checked) : null,
          blocks: blocks(item.tokens, depth + 1),
        })),
      };
    case 'table':
      return {
        t: 'table',
        align: (token.align ?? []).map((a) => a ?? null),
        header: (token.header ?? []).map((cell) => inline(cell.tokens)),
        rows: (token.rows ?? []).map((row) => row.map((cell) => inline(cell.tokens))),
      };
    default:
      return literal(token);
  }
}

/**
 * Markdown text to the page's tree. Never throws.
 * `lex` is a seam for tests; production always uses the vendored `Lexer.lex`.
 * @returns {{blocks: object[], notices: string[]}}
 */
export function markdownTree(text, lex = defaultLex) {
  const source = typeof text === 'string' ? text : '';
  const notices = [];
  const out = [];
  if (source.length > MAX_INPUT) {
    notices.push('The document is too large to render as markdown; the text is shown as written.');
    return { blocks: [{ t: 'code', lang: null, text: source }], notices };
  }
  let body = source;
  const fm = FRONTMATTER.exec(source);
  if (fm) {
    out.push({ t: 'frontmatter', text: fm[1] });
    body = source.slice(fm[0].length);
  }
  try {
    // A fresh options object per call: the lexer mutates it and a passed
    // object REPLACES the defaults, so `gfm` must be explicit (tables, task
    // items, strikethrough, autolinks).
    out.push(...blocks(lex(body, { gfm: true, breaks: false, pedantic: false }), 0));
  } catch {
    notices.push('The markdown could not be parsed; the text is shown as written.');
    return { blocks: [{ t: 'code', lang: null, text: source }], notices };
  }
  if (out.length === 0 && source.length > 0) out.push({ t: 'literal', text: source });
  return { blocks: out, notices };
}
