// provenance.mjs — the one place a `source` becomes text (#998 R998-1, A3 of
// #881). Pure, imported by the browser and by node:test (D9).
//
// `sourceLabel` is the plain form the current page renders beside every
// value; it moved here from drawer-model.mjs unchanged. `sourceStamp` is the
// design's stamp — `[repo: path:line]`, `[forge: #n]`, `[git: sha7]` — with
// the href the chip may carry: only an https link to a forge issue or PR
// becomes one; anything else stays text, never markup (untrusted input).

const FORGE_REF = /^https:\/\/[^/]+\/[^/]+\/[^/]+\/(?:issues|pull|-\/issues|-\/merge_requests)\/(\d+)(?:[/#?].*)?$/;

/** {path, line} / {url} -> the one string shown beside a value. Never empty. */
export function sourceLabel(source) {
  if (source?.url) return source.url;
  if (source?.path) return source.line ? `${source.path}:${source.line}` : source.path;
  return 'no source was recorded for this value';
}

/**
 * sourceStamp(source) -> {label, href, kind}. `kind` is repo | forge | git |
 * link | none; `href` is set only for an https URL (a forge ref or a plain
 * link), never for a path, a sha, or a non-https scheme.
 */
export function sourceStamp(source) {
  if (typeof source?.url === 'string') {
    const https = source.url.startsWith('https://');
    const m = source.url.match(FORGE_REF);
    if (m) return { label: `[forge: #${m[1]}]`, href: https ? source.url : null, kind: 'forge' };
    return { label: `[link: ${source.url}]`, href: https ? source.url : null, kind: 'link' };
  }
  if (typeof source?.path === 'string') {
    return { label: source.line ? `[repo: ${source.path}:${source.line}]` : `[repo: ${source.path}]`, href: null, kind: 'repo' };
  }
  if (typeof source?.sha === 'string') return { label: `[git: ${source.sha.slice(0, 7)}]`, href: null, kind: 'git' };
  return { label: `[${sourceLabel(source)}]`, href: null, kind: 'none' };
}
