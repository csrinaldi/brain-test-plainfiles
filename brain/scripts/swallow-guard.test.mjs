// swallow-guard.test.mjs — no NEW unexplained swallowed failure in the install,
// bootstrap, upgrade, memory-CLI and post-merge paths (#1127).
//
// THE CLASS. A step reports success over a failure it observed: #1093 (`Environment
// ready` after two `Cannot find module`), #1089, #1112 item 3, #1113, #1119. Every
// one of them was a swallow — an empty `catch`, a `|| true`, a warn-and-continue —
// that read as innocent until somebody measured what it hid.
//
// WHAT THIS GUARD DOES. It scans the scoped production files and demands that every
// site that can swallow a failure carries a written verdict, in the code, next to it:
//
//   swallow-ok: <reason>   optional. The failure does not change the outcome the step
//                          reports, and the reason says why.
//   surfaced: <how>        the failure is reported by this very block — as a named
//                          value, a warning line, or a captured exit code the caller
//                          branches on — not dropped.
//   follow-up: slice-X <what>
//                          a known defect this change deliberately did not fix; X is a
//                          slice named in the change's design.md (#1127).
//
// A JS `catch` (or `.catch(`) whose body throws or exits is self-explaining and needs
// nothing. Everything else needs a marker. In shell/YAML the sites are `|| true` / `|| :`
// (also followed by a quote, brace or paren, or wrapped as `|| { true; }` / `|| (true)`),
// `|| /bin/true`, `|| return 0`, `|| exit 0`, `|| echo|printf|log*|warn*`, `; true`,
// `if ! cmd; then :; fi` (one line or spread), `set +e`, `set +o errexit` and
// `continue-on-error`. Two catches on one line each need their own marker.
//
// THE ALLOWLIST IS THE REASON. A marker with no reason, or with a one-word reason,
// fails. A marker that no site claims (an orphan) fails. An OWNED_ELSEWHERE entry that
// no site matches (stale) fails — it means the open PR that owned the site landed and
// the entry must be replaced by a real marker.
//
// WHAT IT CANNOT SEE, said plainly: a spawn whose exit status is never read, a
// `console.warn` that is not inside a `catch`, a `.then(ok, () => {})`, a swallow
// spelled through a helper (`ignore(() => x())`). The scan finds the syntactic swallow,
// not every way to lose a failure; the design.md inventory is where the rest is judged
// by a human. It DOES read JS embedded in shell (`node <<'TAG'`, `node -e/-p`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskNonCode } from './lib/mask-non-code.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── Scope ───────────────────────────────────────────────────────────────────

const SCOPE_FILES = [
  // install
  'brain/scripts/lib/init.mjs',
  'brain/scripts/lib/installer.mjs',
  'brain/scripts/lib/env-init-setup.mjs',
  'brain/scripts/cli-entry.mjs',
  'brain/scripts/install-tools.sh',
  // bootstrap
  'brain/scripts/bootstrap.sh',
  'brain/scripts/harness/cli.mjs',
  // upgrade
  'brain/scripts/brain-upgrade.mjs',
  // post-merge workflow and the scripts it runs
  '.github/workflows/governance-postmerge.yml',
  'brain/scripts/brain-audit.mjs',
  'brain/scripts/archive.mjs',
];
const SCOPE_DIRS = [
  'brain/scripts/memory',
  'brain/scripts/axes/memory',
  'brain/scripts/governance/postmerge',
];

/** Area of a scoped path, for the inventory and the "no area went empty" check. */
export function areaOf(rel) {
  if (/^brain\/scripts\/(lib\/(init|installer)\.mjs|cli-entry\.mjs|install-tools\.sh)$/.test(rel)) return 'install';
  if (/^brain\/scripts\/(bootstrap\.sh|harness\/)/.test(rel)) return 'bootstrap';
  if (rel === 'brain/scripts/brain-upgrade.mjs') return 'upgrade';
  if (/^brain\/scripts\/(memory|axes\/memory)\//.test(rel)) return 'memory';
  return 'postmerge';
}

function walk(dir, out = []) {
  for (const name of readdirSync(join(repoRoot, dir))) {
    if (name === 'node_modules' || name === '__fixtures__') continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(repoRoot, rel)).isDirectory()) walk(rel, out);
    else if (/\.(mjs|sh|ya?ml)$/.test(name) && !/\.test\.mjs$/.test(name)) out.push(rel);
  }
  return out;
}

function scopedFiles() {
  return [...SCOPE_FILES, ...SCOPE_DIRS.flatMap((d) => walk(d))].filter((f) => existsSync(join(repoRoot, f)));
}

// ── Sites owned by an open PR ───────────────────────────────────────────────
// These files are being rewritten in open pull requests; a marker here would be a
// guaranteed merge conflict. Each entry names the owner and matches by the site's
// own text, so it survives line drift. When the owner lands, the entry goes stale,
// this test fails, and it is replaced by a real marker (or the site is gone).
// Sites owned by an open PR would go here, matched by their own text. Empty since #1154 and
// #1155 merged and every site they brought has its own marker.
const OWNED_ELSEWHERE = [];

// ── Scanner ─────────────────────────────────────────────────────────────────

const MARKER_RE = /(swallow-ok|surfaced|follow-up):\s*([^\n]*?)\s*(?:\*\/|$)/m;
const END = String.raw`(?=[\s;)"'}]|$)`;
const SHELL_SWALLOW_RE = new RegExp([
  String.raw`\|\|\s*(?:true|:|/bin/true|/usr/bin/true)` + END,
  String.raw`\|\|\s*[{(]\s*(?::|true)\s*;?\s*[})]`,
  String.raw`\|\|\s*(?:return\s+0|exit\s+0)\b`,
  String.raw`\|\|\s*(?:echo|printf|log\w*|warn\w*)\b`,
  String.raw`;\s*true\b`,
  String.raw`\bif\s+!\s+[^;]+;\s*then\s+(?::|true)\s*;?\s*fi\b`,
  String.raw`\bset\s+\+e\b`,
  String.raw`\bset\s+\+o\s+errexit\b`,
  String.raw`continue-on-error\s*:`,
].join('|'));

function lineOf(text, idx) {
  let n = 1;
  for (let i = 0; i < idx; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function matchingBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

function matchingParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '(') depth += 1;
    else if (masked[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** The marker found in `text`, or null. `kind` is one of the three verdict words. */
function markerIn(text) {
  const m = MARKER_RE.exec(text);
  return m ? { kind: m[1], reason: m[2].replace(/\s*\*\/.*$/, '').trim() } : null;
}

/**
 * True when the catch body (masked, braces included) ends the failure at its own top
 * level: a statement-start `throw`, `die(`, `process.exit(<non-zero>)` or
 * `process.exitCode = <non-zero>`. A throw under an `if`, inside a nested function, or
 * an `exitCode` that is merely an identifier does NOT count (#1127 cold review, S3).
 */
export function endsTheFailure(bodyMasked) {
  // Keep only the body's own top level: nested {…}, (…) and […] contents are dropped, so
  // an `if (x) throw` (its `)` precedes the keyword) and a throw inside a nested
  // function are not seen as statement starts.
  let top = '';
  let depth = 0;
  let inner = '';
  for (const ch of bodyMasked.slice(1, -1)) {
    if ('{(['.includes(ch)) { if (depth === 0) { top += ch; inner = ''; } depth += 1; if (depth > 1) inner += ch; continue; }
    if ('})]'.includes(ch)) {
      depth -= 1;
      if (depth === 0) {
        // Keep a one-character stand-in for a call's argument so `exit(0)` and `exit(1)` differ.
        if (ch === ')') top += inner.trim() === '0' ? '0' : inner.trim() === '' ? '' : '_';
        top += ch;
      } else inner += ch;
      continue;
    }
    if (depth === 0) top += ch; else inner += ch;
  }
  return /(?:^\s*|[;{}]\s*)(?:throw\b|die\s*\(|process\s*\.\s*exit\s*\(\s*[^)0\s]|process\s*\.\s*exitCode\s*=\s*(?!0\b))/.test(top);
}

/**
 * scanJs() — every `catch {}` and `.catch()` in `src`. The verdict window is the
 * catch's own lines through its closing brace, plus the line directly above ONLY when
 * that line is a standalone comment: a marker inline on the previous line belongs to
 * the previous site and must not be inherited (#1127 cold review, S3).
 */
export function scanJs(rel, src, lineOffset = 0) {
  const masked = maskNonCode(src);
  const opens = [...masked.matchAll(/\{/g)].length;
  const closes = [...masked.matchAll(/\}/g)].length;
  if (opens !== closes) {
    throw new Error(`${rel}: masked source has ${opens} '{' and ${closes} '}' — the scanner lost sync (a regex literal?)`);
  }
  const lines = src.split('\n');
  const sites = [];
  const push = (kind, startIdx, endIdx, bodyMasked) => {
    const first = lineOf(src, startIdx);
    const last = lineOf(src, endIdx);
    const above = first >= 2 && /^\s*(?:\/\/|\/\*)/.test(lines[first - 2]) ? 1 : 0;
    const window = lines.slice(first - 1 - above, last).join('\n');
    // The verdict is searched in THIS catch's own text (so two catches on one line never
    // share one), a standalone comment line directly above, and a trailing comment after
    // its closing brace when no other catch follows on that line.
    const lineEnd = src.indexOf('\n', endIdx) === -1 ? src.length : src.indexOf('\n', endIdx);
    const rest = src.slice(endIdx + 1, lineEnd);
    const trailing = /\bcatch\b/.test(maskNonCode(rest)) ? '' : rest;
    const aboveText = above ? lines[first - 2] : '';
    const ownText = `${aboveText}\n${src.slice(startIdx, endIdx + 1)}\n${trailing}`;
    sites.push({
      file: rel, line: first + lineOffset, kind, window,
      context: lines.slice(Math.max(0, first - 5), last).join('\n'),
      winStart: first - above + lineOffset,
      selfExplaining: endsTheFailure(bodyMasked),
      marker: markerIn(ownText),
      text: lines[first - 1].trim(),
    });
  };
  for (const m of masked.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchingBrace(masked, open);
    push('catch', m.index, close, masked.slice(open, close + 1));
  }
  for (const m of masked.matchAll(/\.catch\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchingParen(masked, open);
    // A promise handler is a function body: judge the top level of its braces, if any.
    const inner = masked.slice(open, close + 1);
    const brace = inner.indexOf('{');
    push('.catch', m.index, close, brace === -1 ? '{}' : inner.slice(brace, inner.lastIndexOf('}') + 1));
  }
  return sites;
}

/**
 * embeddedJs() — JS living inside a shell/YAML file: heredoc bodies fed to `node`, and
 * the quoted argument of `node -e` / `-p` / `--eval` / `--print`. Each snippet is
 * returned with the line it starts on, so its sites report real file lines.
 */
export function embeddedJs(src) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const doc = /\bnode\b[^\n]*<<-?\s*(['"]?)(\w+)\1/.exec(lines[i]);
    if (doc) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== doc[2]) j += 1;
      out.push({ code: lines.slice(i + 1, j).join('\n'), startLine: i + 2 });
      i = j;
      continue;
    }
    const ev = /\bnode\b[^\n]*?\s(?:-e|-p|--eval|--print)\s+(["'])/.exec(lines[i]);
    if (ev) {
      const quote = ev[1];
      let text = lines[i].slice(ev.index + ev[0].length);
      let j = i;
      const closeAt = (t) => {
        for (let k = 0; k < t.length; k += 1) {
          if (t[k] === '\\' && quote === '"') { k += 1; continue; }
          if (t[k] === quote) return k;
        }
        return -1;
      };
      let end = closeAt(text);
      while (end === -1 && j + 1 < lines.length) { j += 1; text += `\n${lines[j]}`; end = closeAt(text); }
      if (end !== -1) out.push({ code: text.slice(0, end).replace(/\\(["\\$`])/g, '$1'), startLine: i + 1 });
    }
  }
  return out;
}

/** scanShell() — the swallow-shaped lines of a shell or YAML `run:` script, plus the sites
 * of any JS embedded in it. */
export function scanShell(rel, src) {
  const lines = src.split('\n');
  const sites = [];
  lines.forEach((raw, i) => {
    let code = raw.replace(/^\s*#.*$/, '');
    // `cmd ||` (or `cmd || \`) with the swallow on the next line is one statement.
    if (/\|\|\s*\\?\s*$/.test(code) && i + 1 < lines.length) code = `${code.replace(/\\\s*$/, '')} ${lines[i + 1].trim()}`;
    // `if ! cmd; then` / `:` / `fi` spread over lines is one swallow.
    if (/\bif\s+!\s/.test(code) && /\bthen\s*$/.test(code)) code = `${code} ${lines.slice(i + 1, i + 3).map((l) => l.trim()).join(' ')}`;
    if (!SHELL_SWALLOW_RE.test(code)) return;
    // The verdict is on the line itself or in the contiguous comment block above.
    let from = i;
    while (from > 0 && /^\s*#/.test(lines[from - 1])) from -= 1;
    const window = lines.slice(from, i + 1).join('\n');
    sites.push({
      file: rel, line: i + 1, kind: 'shell', window, context: window, winStart: from + 1,
      selfExplaining: false, marker: markerIn(window), text: raw.trim(),
    });
  });
  for (const { code, startLine } of embeddedJs(src)) {
    for (const site of scanJs(rel, code, startLine - 1)) sites.push({ ...site, kind: `embedded-${site.kind}` });
  }
  return sites;
}

export function scanFile(rel, src) {
  return /\.mjs$/.test(rel) ? scanJs(rel, src) : scanShell(rel, src);
}

const REASON_MIN = 15;
const WEAK = /^(todo|tbd|n\/a|na|none|ignore|ok|fine|best effort)\.?$/i;

/** classify() — one site's verdict. */
export function classify(site, owned = OWNED_ELSEWHERE) {
  if (site.selfExplaining) return { verdict: 'fails', reason: 'the block throws or exits' };
  const own = owned.find((o) => o.file === site.file && (site.context ?? site.window).includes(o.contains));
  if (own) return { verdict: 'owned', reason: `${own.owner}: ${own.reason}`, owner: own };
  if (!site.marker) return { verdict: 'unexplained', reason: '' };
  const { kind, reason } = site.marker;
  if (reason.length < REASON_MIN || WEAK.test(reason)) return { verdict: 'weak', reason };
  if (kind === 'follow-up' && !/^slice-[A-Z]\b/.test(reason)) return { verdict: 'weak', reason };
  return { verdict: kind === 'swallow-ok' ? 'optional' : kind === 'surfaced' ? 'surfaced' : 'follow-up', reason };
}

/** Every marker occurrence in `src`, by line — to find orphans. */
function markerLines(src) {
  const out = [];
  src.split('\n').forEach((l, i) => { if (/(?:swallow-ok|surfaced|follow-up):\s*\S/.test(l)) out.push(i + 1); });
  return out;
}

export function scanAll() {
  const results = [];
  const orphans = [];
  for (const rel of scopedFiles()) {
    const src = readFileSync(join(repoRoot, rel), 'utf8');
    const sites = scanFile(rel, src);
    for (const s of sites) results.push({ ...s, ...classify(s) });
    // A marker line is claimed when it lies inside some site's window.
    for (const l of markerLines(src)) {
      const inWindow = sites.some((s) => {
        const end = s.winStart + s.window.split('\n').length - 1;
        return l >= s.winStart && l <= end;
      });
      if (!inWindow) orphans.push(`${rel}:${l}`);
    }
  }
  return { results, orphans };
}

// ── The guard ───────────────────────────────────────────────────────────────

test('#1127 guard: no unexplained swallow in the install / bootstrap / upgrade / memory / post-merge paths', () => {
  const { results } = scanAll();
  const bad = results.filter((r) => r.verdict === 'unexplained' || r.verdict === 'weak');
  assert.deepEqual(
    bad.map((r) => `${r.file}:${r.line}  ${r.verdict}  ${r.text.slice(0, 80)}`),
    [],
    'every swallow needs `swallow-ok: <reason>`, `surfaced: <how>` or `follow-up: slice-X <what>` '
    + `(reason >= ${REASON_MIN} chars) in or just above it — or it must throw/exit. Fix the site instead if the failure matters.`,
  );
});

test('#1127 guard: no orphan marker (a verdict comment that no swallow site claims)', () => {
  assert.deepEqual(scanAll().orphans, [], 'a marker that guards nothing is a stale claim — remove it');
});

test('#1127 guard: no stale OWNED_ELSEWHERE entry', () => {
  const { results } = scanAll();
  const stale = OWNED_ELSEWHERE.filter((o) => !results.some((r) => r.verdict === 'owned' && r.owner === o));
  assert.deepEqual(stale.map((o) => `${o.file} ~ ${o.contains}`), [], 'the owner landed — replace the entry with a marker');
});

test('#1127 guard: every area of the sweep still has scanned sites (the scope cannot silently empty)', () => {
  const { results } = scanAll();
  const byArea = {};
  for (const r of results) byArea[areaOf(r.file)] = (byArea[areaOf(r.file)] ?? 0) + 1;
  for (const area of ['install', 'bootstrap', 'upgrade', 'memory', 'postmerge']) {
    assert.ok((byArea[area] ?? 0) > 0, `area ${area} scanned no site — SCOPE drifted`);
  }
});

// ── The scanner is a real detector (proven on synthetic sources) ────────────

const verdictsOf = (rel, src) => scanFile(rel, src).map((s) => classify(s, []).verdict);

test('#1127 scanner: an unmarked empty catch is unexplained; a marked one is optional', () => {
  assert.deepEqual(verdictsOf('x.mjs', 'try { a(); } catch { }\n'), ['unexplained']);
  assert.deepEqual(
    verdictsOf('x.mjs', 'try { a(); } catch { /* swallow-ok: the probe is advisory, the caller re-reads */ }\n'),
    ['optional'],
  );
});

test('#1127 scanner: a catch that throws or exits explains itself', () => {
  assert.deepEqual(verdictsOf('x.mjs', 'try { a(); } catch (e) { throw new Error("x", { cause: e }); }\n'), ['fails']);
  assert.deepEqual(verdictsOf('x.mjs', 'try { a(); } catch (e) { console.error(e); process.exit(1); }\n'), ['fails']);
});

test('#1127 scanner: a bare or one-word reason does not count', () => {
  assert.deepEqual(verdictsOf('x.mjs', 'try { a(); } catch { /* swallow-ok: ok */ }\n'), ['weak']);
  assert.deepEqual(verdictsOf('x.mjs', 'try { a(); } catch { /* swallow-ok: */ }\n'), ['weak']);
});

test('#1127 scanner: follow-up must name a slice', () => {
  assert.deepEqual(verdictsOf('x.mjs', 'try { a(); } catch { /* follow-up: later maybe someday */ }\n'), ['weak']);
  assert.deepEqual(verdictsOf('x.mjs', 'try { a(); } catch { /* follow-up: slice-B report through the summary */ }\n'), ['follow-up']);
});

test('#1127 scanner: `.catch(` and a catch inside a string or comment', () => {
  assert.deepEqual(verdictsOf('x.mjs', 'p.catch(() => {});\n'), ['unexplained']);
  assert.deepEqual(verdictsOf('x.mjs', 'const s = "try {} catch { }"; // catch { }\n'), []);
});

test('#1127 scanner: shell `|| true`, `set +e`, `|| warn` need a verdict on the line or the comment block above', () => {
  assert.deepEqual(verdictsOf('x.sh', 'rm -f x || true\n'), ['unexplained']);
  assert.deepEqual(verdictsOf('x.sh', 'rm -f x || true # swallow-ok: the file may already be gone, that is the goal\n'), ['optional']);
  assert.deepEqual(
    verdictsOf('x.yml', '  # surfaced: the exit code is captured on the next line and branched on\n  set +e\n'),
    ['surfaced'],
  );
  assert.deepEqual(verdictsOf('x.sh', 'do_it || warn "failed"\n'), ['unexplained']);
  assert.deepEqual(verdictsOf('x.sh', '# rm -f x || true\n'), [], 'a commented-out swallow is not a site');
});

test('#1127 scanner: adjacent catches do not inherit each other\'s marker', () => {
  const src = 'try { a(); } catch { /* swallow-ok: the first probe is advisory only */ }\ntry { b(); } catch { }\n';
  assert.deepEqual(verdictsOf('x.mjs', src), ['optional', 'unexplained']);
});

test('#1127 scanner: only an unconditional top-level throw / exit(non-zero) explains itself', () => {
  const v = (body) => verdictsOf('x.mjs', `try { a(); } catch (e) { ${body} }\n`)[0];
  assert.equal(v('if (e.code !== "X") throw e;'), 'unexplained', 'a conditional throw swallows the other branch');
  assert.equal(v('const exitCode = 1; log(exitCode);'), 'unexplained', 'an identifier named exitCode is not an exit');
  assert.equal(v('const f = () => { throw e; }; log(f);'), 'unexplained', 'a throw in an uncalled nested function');
  assert.equal(v('process.exit(0);'), 'unexplained', 'exit(0) is success');
  assert.equal(v('log(e); throw e;'), 'fails');
  assert.equal(v('process.exitCode = 2;'), 'fails');
  assert.equal(v('die("nope");'), 'fails');
});

test('#1127 scanner: shell evasions are sites — return 0, log, printf, /bin/true, ; true, { :; }, set +o errexit, || newline true', () => {
  for (const line of [
    'x || return 0', 'x || log "meh"', 'x || printf "meh"', 'x || /bin/true', 'x; true', 'x || { :; }',
    'set +o errexit', 'x ||\n  true', 'x || \\\n  true', 'x || exit 0',
  ]) {
    assert.deepEqual(verdictsOf('x.sh', `${line}\n`), ['unexplained'], line);
  }
});

test('#1127 scanner: shell evasions round 2 — quote after true, || { true; }, || (true), if ! cmd; then :; fi', () => {
  for (const line of [
    'sh -c "x || true"', "sh -c 'x || :'", 'cmd || { true; }', 'cmd || (true)', 'cmd || { :; }',
    'if ! cmd; then :; fi', 'if ! cmd; then true; fi', 'if ! cmd; then\n  :\nfi',
  ]) {
    assert.deepEqual(verdictsOf('x.sh', `${line}\n`), ['unexplained'], line);
  }
});

test('#1127 scanner: two catches on ONE line each need their own marker', () => {
  const src = 'try { a(); } catch { /* swallow-ok: the first probe is advisory only */ } try { b(); } catch { }\n';
  assert.deepEqual(verdictsOf('x.mjs', src), ['optional', 'unexplained']);
  const laterMarker = 'try { a(); } catch { } try { b(); } catch { /* swallow-ok: only the second probe is advisory */ }\n';
  assert.deepEqual(verdictsOf('x.mjs', laterMarker), ['unexplained', 'optional'], 'the second catch\'s marker is not the first\'s');
  const both = 'try { a(); } catch { /* swallow-ok: the first probe is advisory only */ } try { b(); } catch { /* swallow-ok: the second probe is advisory too */ }\n';
  assert.deepEqual(verdictsOf('x.mjs', both), ['optional', 'optional']);
});

test('#1127 scanner: JS embedded in shell is scanned — heredoc and node -e/-p', () => {
  const heredoc = "node --input-type=module <<'NODE'\nimport x from 'y';\ntry { a(); } catch {}\nNODE\n";
  const [h] = scanFile('x.sh', heredoc);
  assert.equal(h.kind, 'embedded-catch');
  assert.equal(h.line, 3, 'reports the real file line');
  assert.deepEqual(verdictsOf('x.sh', 'node -e "try { a(); } catch (e) { }"\n'), ['unexplained']);
  assert.deepEqual(verdictsOf('x.sh', "node -p 'try { a(); } catch { }'\n"), ['unexplained']);
  assert.deepEqual(verdictsOf('x.sh', 'node -e "try { a(); } catch (e) { throw e; }"\n'), ['fails']);
});

test('#1127 scanner: an owned site is recognised by its own text, not its line number', () => {
  const owned = [{ file: 'x.sh', contains: 'do_it || warn', owner: '#0', reason: 'being rewritten' }];
  const [s] = scanFile('x.sh', '\n\n\ndo_it || warn "failed"\n');
  assert.equal(classify(s, owned).verdict, 'owned');
});

test('#1127 scanner: losing sync on a source it cannot mask is a loud failure, not a silent miss', () => {
  assert.throws(() => scanJs('x.mjs', 'const a = {;\n'), /lost sync/);
});

// Not a test: `SWALLOW_INVENTORY=1 node --test brain/scripts/swallow-guard.test.mjs`
// prints the inventory table design.md carries, straight from the markers.
if (process.env.SWALLOW_INVENTORY === '1') {
  const { results } = scanAll();
  const esc = (t) => String(t).replace(/\|/g, '\\|');
  for (const r of results) {
    console.log(`| ${areaOf(r.file)} | ${relative('.', r.file)}:${r.line} | ${esc(r.text.slice(0, 70))} | ${r.verdict} | ${esc(r.reason)} |`);
  }
}
