// shipped-hostnames.mjs — which hostnames a file that SHIPS may name (#648).
//
// EXTRACTED FROM `shipped-hostnames.test.mjs` AS A PURE MOVE (#674). The rule
// itself is unchanged; what changed is who can ask it.
//
// It used to be reachable only by walking `brain/**`. A draft destined for
// `brain/**` is not in `brain/**` — so the guard's surface excluded the artefact
// for its whole reviewable life, and the first instant it could see the file was
// the instant a human had already typed `PROMOTE`, signed the commit and pushed.
// That is measured, not hypothetical: ADR-0031 went green through `npm test`,
// `brain:repo:check` and CI, and went red on the signing commit.
//
// `brain:promote` now asks THIS module the same question about the text it is
// about to write, at the destination path. One implementation, two callers —
// the test still walks the tree, the verb checks one artefact.
//
// This module is itself under `brain/**` and IS scanned by its own guard. Every
// host named below is allowlisted or reserved on purpose: a guard that had to
// exempt itself would be the self-sustaining defect #647 D6 records, and the
// first draft of the test file had exactly that.

/**
 * Real hosts brain legitimately names, each with the reason it is here.
 *
 * The list is short on purpose. Adding an entry is a deliberate act — that is
 * the whole protection, since a hostname is otherwise indistinguishable from
 * any other string.
 */
export const ALLOWED_REAL = Object.freeze({
  'github.com': 'the forge brain integrates with',
  'api.github.com': 'GitHub REST',
  'docs.github.com': 'cited in provider docs',
  'raw.githubusercontent.com': 'raw fetches in install docs',
  'avatars.githubusercontent.com': 'appears inside recorded API fixtures',
  'gitlab.com': 'the second forge brain integrates with (ADR-0018)',
  'docs.gitlab.com': 'cited as the source shape for hand-authored fixtures',
  'registry.npmjs.org': 'the registry ADR-0030 publishes to',
  // Not an integration: `document.createElementNS` compares this string by
  // value to decide an element is SVG, so brain:ui's canvas (#881) must ship
  // it literally. Nothing ever resolves or contacts it, and the page's own
  // source guard pins it as the ONLY absolute URL `static/app.js` may contain.
  'www.w3.org': 'the SVG namespace identifier brain:ui\'s canvas passes to createElementNS (#881) — compared by value, never contacted',
});

/** RFC 2606 / RFC 6761 names, reserved precisely so fixtures can use them. */
export const RESERVED = Object.freeze([
  /(^|\.)example\.(com|net|org)$/,
  /(^|\.)example$/,
  /\.test$/,
  /\.invalid$/,
  /\.localhost$/,
  /^localhost$/,
  /^127\.0\.0\.1$/,
  /^0\.0\.0\.0$/,
]);

/** Files whose bytes are text worth scanning. Matched against a basename or a path. */
export const TEXT = /\.(mjs|js|json|md|ya?ml|sh|txt)$/;

/**
 * Every `scheme://host` in a file, with userinfo and port stripped.
 *
 * Userinfo matters: `https://oauth2:tok@gl.example.com` must be read as the
 * host `gl.example.com`, not as `oauth2`. A parser that skips that step reports
 * a pile of fake "hosts" and buries the one real offender among them —
 * measured, on the first version of this guard.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function hostsIn(text) {
  const out = [];
  for (const m of text.matchAll(/https?:\/\/([^/\s'"`)\\<>]+)/g)) {
    let h = m[1];
    if (h.includes('@')) h = h.slice(h.lastIndexOf('@') + 1);
    h = h.replace(/:\d+$/, '').toLowerCase();
    if (h) out.push(h);
  }
  return out;
}

/** @param {string} h */
export const isReserved = (h) => RESERVED.some((re) => re.test(h));

/**
 * A hostname is `[a-z0-9.-]` with at least one dot, and nothing else.
 *
 * Checked positively rather than by excluding known junk. The first version
 * asked `!h.includes('.')`, which let `…#v1.0.0` — an ellipsis-truncated URL in
 * a doc comment — through as a "foreign host", because the version number
 * supplied the dot. A rule written as a blocklist of the shapes you happened to
 * see is a rule that reports the next shape as a finding.
 *
 * @param {string} h
 */
export const isNotAHostname = (h) => !/^[a-z0-9][a-z0-9.-]*$/.test(h) || !h.includes('.');

/**
 * The rule, applied to one file's text: every host it names that is neither
 * reserved nor allowlisted, in order of appearance and WITHOUT deduplication.
 *
 * No deduplication here on purpose — this is the classifier, and the two callers
 * want different groupings (the tree walk dedupes by `file::host`, the verb
 * dedupes within one file). Folding one caller's grouping in here would make the
 * other one's correct behaviour depend on a choice made for somebody else.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function foreignHostsIn(text) {
  return hostsIn(text).filter((h) => !isNotAHostname(h) && !isReserved(h) && !(h in ALLOWED_REAL));
}
