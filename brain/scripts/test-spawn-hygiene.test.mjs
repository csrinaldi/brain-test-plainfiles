// test-spawn-hygiene.test.mjs — a sibling of test-hygiene.test.mjs (#1020),
// built for #1012 after #1007: `npm test` spawned a real `cli.mjs ship` and
// pushed a real lane ref, opened a real pull request. The invoker guard
// (ship-invoker.mjs) closes THAT call path; this meta-test closes the
// class — the next test that spawns ANY `brain/scripts/**` runtime
// entrypoint, with no seam and no allowlist entry, fails the scan instead
// of silently passing.
//
// SCOPE. Scans the same globs as test-hygiene.test.mjs (`brain/scripts/**
// /*.test.mjs`, `test/**/*.test.mjs`, which covers `*.e2e.test.mjs`) for
// `spawn`/`spawnSync`/`execFile`/`execFileSync`/`fork` calls. A call is a
// HIT when its first argument is a runtime (`process.execPath`, `'node'`,
// `'npm'`, `'bash'`, `'sh'`), or its first argument resolves to a path
// under `brain/scripts/`, or the callee is `fork`. A pure `-e`/`-p`/
// `--input-type` eval is excluded UNLESS the evaluated text (a literal or a
// same-file identifier's own initializer) mentions `brain/scripts/`.
//
// WHY THIS SCANNER MASKS STRINGS AND COMMENTS BEFORE MATCHING (a
// deliberate improvement over test-hygiene.test.mjs's own WRITE_CALL_RE,
// which matches directly against raw source): a bare textual match for
// `fork(` — or any of the other four callee names — would also fire
// inside an ordinary string literal that happens to spell it (measured:
// `vcs/engine-blind-gates.test.mjs` contains the STRING `'... fork();'`,
// nowhere near a real call). Masking every string/template/comment body to
// blanks before searching means the call-site search only ever matches
// real syntax; `callArgsText` below (duplicated from test-hygiene.test.mjs,
// not exported there) still walks the ORIGINAL, unmasked source once a
// real call site is found, so string-valued arguments are read correctly.
//
// ENTRYPOINT RESOLUTION. Takes the call's first argument. A quoted literal
// is used directly; a bare identifier is resolved against its OWN same-file
// `const|let|var` initializer (the last quoted literal inside it — the
// `join(HERE, 'x.mjs')` shape this codebase's CLI test files all share).
// The resolved text is the entrypoint if it contains `brain/scripts/`;
// otherwise, if it looks like a path (contains `/` or ends in a script
// extension), it is resolved against the TEST FILE's own directory — this
// is what lets `const CLI = join(HERE, 'cli.mjs')` resolve to
// `brain/scripts/memory/cli.mjs` when the test file lives beside it. When
// the command is `'npm'`, the argv array's `run <script>` shape resolves to
// `npm:<script>` instead. Anything that cannot be resolved this way is
// `<unresolved>` — which still counts as a HIT (fail closed) and MUST carry
// a line-pinned allowlist entry (see ALLOWLIST below).
//
// THE ALLOWLIST. `{ file, entrypoint, line?, reason }`. A line-pinned entry
// is matched first; a bare `(file, entrypoint)` entry covers every hit at
// that pair regardless of line, so a new entrypoint appearing in an
// already-allowlisted FILE still has to be re-reviewed. `reason` must be
// one of the four closed values in `REASONS` — anything else fails
// `validateAllowlist`, naming the closed set.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, sep, relative, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTmp } from './lib/test-tmp.mjs';
import { maskNonCode } from './lib/mask-non-code.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const WALK_GLOBS = ['brain/scripts/**/*.test.mjs', 'test/**/*.test.mjs'];

// Never spelled with a trailing `(` anywhere else in this file's raw source
// (including inside the fixture-building strings below) — see
// test-hygiene.test.mjs's own IMPORT_KW/EXPORT_KW precedent, and this
// file's own header comment on why masking makes the risk smaller (but not
// zero, for a fixture-planted string this file's own regex would otherwise
// match against ITSELF once it becomes part of this file's tracked
// history) — belt and suspenders.
const CALL_FNS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
const CALL_RE = new RegExp(`\\b(${CALL_FNS.join('|')})\\s*\\(`, 'g');
const RUNTIME_LITERALS = new Set(['node', 'npm', 'bash', 'sh']);
const PATH_LIKE_RE = /[/]|\.(mjs|js|cjs|sh)$/;

/** Returns the text between a call's own `(` (at `openParenIdx`) and its
 * matching `)`, tracking nested parens and skipping over string-literal
 * content so a `)` inside a quoted argument never closes the call early.
 * Duplicated from test-hygiene.test.mjs:63-81 (not exported there). */
function callArgsText(src, openParenIdx) {
  let depth = 0;
  let inString = null;
  for (let i = openParenIdx; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') { i += 1; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inString = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openParenIdx + 1, i);
    }
  }
  return src.slice(openParenIdx + 1);
}

/** Splits `text` on top-level commas — the same paren/bracket/brace/string
 * tracking as callArgsText, generalized to `[`/`{` too so an inline array
 * or object argument is never split on its own internal commas. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let inString = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i += 1; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inString = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

/** Finds `const|let|var NAME = <init>;` in the SAME file (module scope is
 * assumed — every caller of this in this codebase declares its CLI/HERE
 * constants at module top level) and returns the initializer text. */
function findDeclInit(name, src) {
  const re = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*`);
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 0;
  let inString = null;
  const start = i;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      if (c === '\\') { i += 1; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inString = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ';' && depth === 0) break;
  }
  return src.slice(start, i);
}

function literalsIn(text) {
  const out = [];
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2]);
  return out;
}

/** Resolves one call argument token to its best-effort string value: a
 * literal directly, `process.execPath` as itself, or an identifier's own
 * same-file declaration (last quoted literal inside it — the
 * `join(HERE, 'x.mjs')` shape). Returns `null` when nothing resolves. */
function resolveToken(token, src) {
  const t = token.trim();
  if (t === 'process.execPath') return 'process.execPath';
  const lit = t.match(/^['"]([^'"]*)['"]$/);
  if (lit) return lit[1];
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) {
    const init = findDeclInit(t, src);
    if (init) {
      const lits = literalsIn(init);
      if (lits.length) return lits[lits.length - 1];
    }
    return null;
  }
  const lits = literalsIn(t);
  return lits.length ? lits[lits.length - 1] : null;
}


function scanAll(cwd = repoRoot, globs = WALK_GLOBS) {
  const files = globSync(globs, { cwd }).map((f) => f.split(sep).join('/'));
  const hits = [];
  for (const relFile of files) {
    const src = readFileSync(join(cwd, relFile), 'utf8');
    const masked = maskNonCode(src);
    const testDir = dirname(join(cwd, relFile));
    const re = new RegExp(CALL_RE.source, CALL_RE.flags);
    let m;
    while ((m = re.exec(masked))) {
      const fn = m[1];
      const openParenIdx = m.index + m[0].length - 1;
      const argsText = callArgsText(src, openParenIdx);
      const args = splitTopLevel(argsText);
      const line = src.slice(0, m.index).split('\n').length;

      const arg0Value = args[0] ? resolveToken(args[0], src) : null;
      const isRuntimeArg0 = arg0Value === 'process.execPath' || RUNTIME_LITERALS.has(arg0Value);
      const arg0PathHit = arg0Value ? resolveUnderBrainScripts(arg0Value, testDir, cwd) : null;
      const isForkCallee = fn === 'fork';

      let isEvalExcluded = false;
      if (isRuntimeArg0 && arg0Value !== 'npm') {
        const hasEvalFlag = /(^|[\s,'"])(-e|-p|--input-type)([\s='"]|$)/.test(argsText);
        if (hasEvalFlag) {
          let mentionsBrainScripts = argsText.includes('brain/scripts/');
          if (!mentionsBrainScripts) {
            const idents = new Set([...argsText.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)].map((mm) => mm[0]));
            for (const id of idents) {
              const init = findDeclInit(id, src);
              if (init && init.includes('brain/scripts/')) { mentionsBrainScripts = true; break; }
            }
          }
          if (!mentionsBrainScripts) isEvalExcluded = true;
        }
      }

      const isHit = !isEvalExcluded && (isRuntimeArg0 || arg0PathHit !== null || isForkCallee);
      if (!isHit) continue;

      let entrypoint = '<unresolved>';
      if (arg0PathHit && !isRuntimeArg0) {
        entrypoint = arg0PathHit;
      } else if (arg0Value === 'npm') {
        const arrText = args[1] ?? '';
        const arrParts = arrText.startsWith('[')
          ? splitTopLevel(arrText.slice(1, -1)).map((t) => resolveToken(t, src))
          : [];
        if (arrParts[0] === 'run' && arrParts[1]) entrypoint = `npm:${arrParts[1]}`;
      } else if (isForkCallee) {
        const r = arg0Value ? resolveUnderBrainScripts(arg0Value, testDir, cwd) : null;
        if (r) entrypoint = r;
      } else if (isRuntimeArg0) {
        const arrText = args[1] ?? '';
        if (arrText.startsWith('[')) {
          const first = splitTopLevel(arrText.slice(1, -1))[0];
          const firstValue = first ? resolveToken(first, src) : null;
          const r = firstValue ? resolveUnderBrainScripts(firstValue, testDir, cwd) : null;
          if (r) entrypoint = r;
        }
      }

      hits.push({ file: relFile, line, fn, entrypoint });
    }
  }
  return { files, hits };
}

/** Resolves `value` to a repo-relative path under `brain/scripts/`, if any:
 * directly (the literal already contains it) or by treating it as a
 * trailing file literal relative to the TEST FILE's own directory. Bare
 * command names (`git`, `gh`) never resolve — only path-shaped values.
 * `cwd`-parametrized (not pinned to the real `repoRoot`) so the
 * self-proving fixture test below can scan an isolated fixture root. */
function resolveUnderBrainScripts(value, testDir, cwd) {
  if (!value) return null;
  if (value.includes('brain/scripts/')) return value.slice(value.indexOf('brain/scripts/'));
  if (!PATH_LIKE_RE.test(value)) return null;
  try {
    const abs = pathResolve(testDir, value);
    const rel = relative(cwd, abs).split(sep).join('/');
    return rel.startsWith('brain/scripts/') ? rel : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The allowlist (REQ-SHIP-4). Every hit the real scan reports below must be
// covered by exactly one of these entries — a line-pinned entry first, else
// the (file, entrypoint) pair. Reasons classify WHY the spawn is safe:
//
//   no-vcs-capability    — the spawned entrypoint's code path never imports
//                           or calls a VCS/gh port at all (every memory
//                           cli.mjs op below EXCEPT `ship` — `ship` is the
//                           only op that ever imports vcs/cli.mjs — plus
//                           read-only/report CLIs, hooks that never reach a
//                           real push, and `which`/`git --version`-style
//                           probes).
//   fixture-root-local-git — the spawn issues REAL git commands, but only
//                           ever against a local, disposable fixture repo
//                           (a bare "origin" under testTmp/mkdtemp) —
//                           never a real remote or a real credential.
//   vcs-port-substituted — the spawn's target code substitutes the real
//                           VCS port for a fake one via an injected seam
//                           (BRAIN_VCS_TEST_MODULE, an equivalent fixture
//                           port, or a fake-token e2e harness).
//   refusal-asserted      — the test specifically proves a guard refuses
//                           before any VCS call is reached.
// ---------------------------------------------------------------------------

const REASONS = Object.freeze([
  'no-vcs-capability',
  'fixture-root-local-git',
  'vcs-port-substituted',
  'refusal-asserted',
]);

const ALLOWLIST = [
  // ── #1012's own files ──────────────────────────────────────────────────
  { file: 'brain/scripts/memory/cli.ship.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'vcs-port-substituted' },
  { file: 'brain/scripts/memory/cli.ship-invoker.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'refusal-asserted' },
  { file: 'brain/scripts/memory/cli.ship-invoker.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', line: 120, reason: 'no-vcs-capability' }, // case (c): --dry-run structurally sets vcs:null — never binds any port, fake or real.
  { file: 'test/lane-ship-invoker.e2e.test.mjs', entrypoint: 'npm:brain:memory:session-end', reason: 'vcs-port-substituted' },
  { file: 'test/lane-ship-invoker.e2e.test.mjs', entrypoint: 'npm:brain:memory:ship', reason: 'vcs-port-substituted' },
  { file: 'test/lane-ship-invoker.e2e.test.mjs', entrypoint: '<unresolved>', line: 207, reason: 'vcs-port-substituted' }, // sweep chain, fake port
  { file: 'test/lane-ship-invoker.e2e.test.mjs', entrypoint: '<unresolved>', line: 244, reason: 'refusal-asserted' }, // sweep chain, no-port variant asserts the refusal

  // ── the explorer's seven (design.md's own classification) ──────────────
  { file: 'brain/scripts/harness/engines-cli.test.mjs', entrypoint: 'brain/scripts/harness/engines-cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/config/cli.test.mjs', entrypoint: 'brain/scripts/config/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/context/cli.test.mjs', entrypoint: 'brain/scripts/context/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/status/snapshot-cli.test.mjs', entrypoint: 'brain/scripts/status/snapshot-cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/brain-promote.locks.test.mjs', entrypoint: 'brain/scripts/brain-promote.mjs', reason: 'fixture-root-local-git' },
  { file: 'brain/scripts/brain-promote.amendment.test.mjs', entrypoint: 'brain/scripts/brain-promote.mjs', reason: 'fixture-root-local-git' },
  { file: 'brain/scripts/approve/locks.test.mjs', entrypoint: 'brain/scripts/approve/cli.mjs', reason: 'refusal-asserted' },
  { file: 'brain/scripts/harness/run-stage.test.mjs', entrypoint: 'brain/scripts/harness/cli.mjs', reason: 'refusal-asserted' },

  // ── memory cli.mjs ops OTHER than ship never import vcs/cli.mjs at all ──
  { file: 'brain/scripts/memory/cli.audit.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.backend-fallback.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.collect.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.heal-duplicates.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.migrate-v1.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.reindex-duplicates.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.save-search.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.split-records-duplicates.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/axes/memory/no-artifact.parity.test.mjs', entrypoint: 'brain/scripts/axes/memory/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/axes/memory/adapters/plainfiles.save-index-failure.test.mjs', entrypoint: 'brain/scripts/axes/memory/adapters/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/lib/supersedes.integration.test.mjs', entrypoint: 'brain/scripts/memory/lib/cli.mjs', reason: 'no-vcs-capability' },

  // ── `which`/`git`-probe helpers: local, read-only, no push ──────────────
  { file: 'brain/scripts/memory/capture-reachable.test.mjs', entrypoint: '<unresolved>', line: 50, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/capture-reachable.test.mjs', entrypoint: '<unresolved>', line: 51, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/capture-reachable.test.mjs', entrypoint: '<unresolved>', line: 70, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/capture-reachable.test.mjs', entrypoint: '<unresolved>', line: 124, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.backend-fallback.test.mjs', entrypoint: '<unresolved>', line: 56, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.backend-fallback.test.mjs', entrypoint: '<unresolved>', line: 59, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.save-search.test.mjs', entrypoint: '<unresolved>', line: 241, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.save-search.test.mjs', entrypoint: '<unresolved>', line: 242, reason: 'no-vcs-capability' },

  // ── report/read-only CLIs and their nav-integrity callers ───────────────
  { file: 'brain/scripts/archive.test.mjs', entrypoint: 'brain/scripts/archive.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/brain-audit.test.mjs', entrypoint: 'brain/scripts/brain-audit.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/brain-audit.test.mjs', entrypoint: '<unresolved>', line: 1866, reason: 'fixture-root-local-git' }, // "There is no remote here, so the CAS push cannot succeed" — own comment
  { file: 'brain/scripts/brain-metrics-audit-parity.test.mjs', entrypoint: 'brain/scripts/brain-audit.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/brain-metrics-audit-parity.test.mjs', entrypoint: 'brain/scripts/brain-metrics.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/brain-metrics.test.mjs', entrypoint: 'brain/scripts/brain-metrics.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/brain-upgrade.test.mjs', entrypoint: 'brain/scripts/brain-upgrade.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/lib/installer-journal.integration.test.mjs', entrypoint: 'brain/scripts/brain-upgrade.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/check-brain-nav.citations.test.mjs', entrypoint: 'brain/scripts/check-brain-nav.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/check-brain-nav.test.mjs', entrypoint: 'brain/scripts/check-brain-nav.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/lib/home-index-nav-integrity.test.mjs', entrypoint: 'brain/scripts/check-brain-nav.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/lib/home-scaffold-nav-integrity.test.mjs', entrypoint: 'brain/scripts/check-brain-nav.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/lib/home-index.test.mjs', entrypoint: 'brain/scripts/lib/home-index.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/check-refs.test.mjs', entrypoint: 'brain/scripts/check-refs.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/governance/postmerge/parse-failures.test.mjs', entrypoint: '<unresolved>', line: 65, reason: 'no-vcs-capability' }, // bash redirects a file onto parse-failures.mjs (#1221)
  { file: 'brain/scripts/new-change.test.mjs', entrypoint: 'brain/scripts/new-change.mjs', reason: 'no-vcs-capability' },

  // ── postmerge cursor: real git push, local bare origin only ────────────
  { file: 'brain/scripts/governance/postmerge/cursor.test.mjs', entrypoint: 'brain/scripts/governance/postmerge/cursor.mjs', reason: 'fixture-root-local-git' },
  { file: 'brain/scripts/governance/postmerge/cursor.test.mjs', entrypoint: 'brain/scripts/brain-audit.mjs', reason: 'no-vcs-capability' },

  // ── git hooks: run directly, never through a real `git push`/network ───
  { file: 'brain/scripts/hooks/commit-msg.test.mjs', entrypoint: 'brain/scripts/hooks/commit-msg', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/hooks/commit-msg.first-commit.test.mjs', entrypoint: '<unresolved>', line: 112, reason: 'no-vcs-capability' }, // runs the commit-msg hook directly, no VCS port
  { file: 'brain/scripts/hooks/hooks.attribution-parity.test.mjs', entrypoint: 'brain/scripts/hooks/commit-msg', reason: 'no-vcs-capability' },
  // #1127: bash runs install-tools.sh's provider-resolution and summary snippets, lifted verbatim, in a scratch dir with a gentle-ai shim — no apt, no network.
  // #1127 slice A: bash runs bootstrap.sh's step snippets, lifted verbatim, against failing stand-in scripts in a scratch dir — no git remote, no network.
  { file: 'brain/scripts/bootstrap.required-steps.test.mjs', entrypoint: '<unresolved>', line: 58, reason: 'no-vcs-capability' },
  // #1127 round 3: the REAL bootstrap.sh in a hermetic box — HOME/XDG under the temp root, a PATH of only shimmed host tools (no gh, glab, engram, gentle-ai, codex; a python3 grep), stdin closed, a COPY of the brain tree; the unhealthy case pulls from a local bare repo, never a network.
  { file: 'brain/scripts/bootstrap.e2e.test.mjs', entrypoint: 'brain/scripts/bootstrap.sh', line: 43, reason: 'no-vcs-capability' },
  // #1165: the same e2e box runs `config set memory.backend` (the write env:init performs on a TTY) and the resolver CLI bash asks — both local, read/write of the fixture's own brain.config.json.
  { file: 'brain/scripts/bootstrap.e2e.test.mjs', entrypoint: 'brain/scripts/config/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.e2e.test.mjs', entrypoint: 'brain/scripts/memory/lib/backend-resolve.mjs', reason: 'no-vcs-capability' },
  // #1165: a real origin + FRESH CLONE carrying a copy of the brain, driving memory/cli.mjs (plainfiles/refusal paths only; PATH has no engram).
  { file: 'brain/scripts/memory/cli.backend-declaration.test.mjs', entrypoint: 'brain/scripts/memory/cli.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/cli.backend-declaration.test.mjs', entrypoint: '<unresolved>', line: 29, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/memory/lib/backend-resolve.test.mjs', entrypoint: 'brain/scripts/memory/lib/backend-resolve.mjs', reason: 'no-vcs-capability' },
  // #1127: `brain-config.mjs ensure` run from a COPY of the tree in a temp repo, to pin its exit code.
  { file: 'brain/scripts/lib/brain-config.ensure-cli.test.mjs', entrypoint: 'brain/scripts/lib/brain-config.mjs', line: 28, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/install-tools.test.mjs', entrypoint: '<unresolved>', line: 34, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/install-tools.test.mjs', entrypoint: '<unresolved>', line: 93, reason: 'no-vcs-capability' }, // `command -v` lookups for the no-node PATH
  { file: 'brain/scripts/install-tools.test.mjs', entrypoint: '<unresolved>', line: 97, reason: 'no-vcs-capability' }, // the same snippet with node off PATH
  { file: 'brain/scripts/brain-promote.golden.test.mjs', entrypoint: 'brain/scripts/hooks/commit-msg', reason: 'no-vcs-capability' }, // #1127: masked away by the old masker (a regex literal holding a quote); runs the hook on a message file, no VCS
  { file: 'brain/scripts/hooks/pre-commit.test.mjs', entrypoint: 'brain/scripts/hooks/pre-commit', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/hooks/pre-push.test.mjs', entrypoint: 'brain/scripts/hooks/pre-push', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/hooks/post-merge.undeclared.test.mjs', entrypoint: 'brain/scripts/hooks/post-merge', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/hooks/hooks.stream-discipline.test.mjs', entrypoint: '<unresolved>', line: 98, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/axes/platform/lib/settings-hooks.test.mjs', entrypoint: '<unresolved>', line: 93, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.worktree.test.mjs', entrypoint: '<unresolved>', line: 64, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.worktree.test.mjs', entrypoint: '<unresolved>', line: 145, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.cross-tree-code.test.mjs', entrypoint: '<unresolved>', line: 72, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.cross-tree-code.test.mjs', entrypoint: '<unresolved>', line: 187, reason: 'no-vcs-capability' },
  // #1124: bootstrap.sh's own brain-config.mjs ensure line — reads `git remote get-url origin` only, never the network
  { file: 'brain/scripts/bootstrap.tier-notice.test.mjs', entrypoint: '<unresolved>', line: 71, reason: 'no-vcs-capability' },
  // #1125: bash runs bootstrap.sh's env helpers and §6 platform block, lifted verbatim, in a scratch dir — no git, no network, no push.
  { file: 'brain/scripts/bootstrap.default-platform.test.mjs', entrypoint: '<unresolved>', line: 85, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.default-platform.test.mjs', entrypoint: 'brain/scripts/parity.sh', line: 182, reason: 'no-vcs-capability' }, // #1221: the script is a temp file now, not stdin; same bash-in-scratch-dir shape

  // ── i18n shell-catalog eval: bash -c, zero VCS surface ──────────────────
  { file: 'brain/scripts/i18n/coverage.test.mjs', entrypoint: '<unresolved>', line: 161, reason: 'no-vcs-capability' }, // #1061 shifted this line by inserting the memory.heal.* parity test earlier in the file

  // ── #1061 heal-duplicates cli spawn test's own `which` resolution ───────
  { file: 'brain/scripts/memory/cli.heal-duplicates.test.mjs', entrypoint: '<unresolved>', line: 24, reason: 'no-vcs-capability' },

  // ── cli-entry / bin shape: prints help, never touches VCS ───────────────
  { file: 'brain/scripts/lib/init.test.mjs', entrypoint: 'brain/scripts/cli-entry.mjs', reason: 'no-vcs-capability' },
  { file: 'brain/scripts/lib/init.test.mjs', entrypoint: '<unresolved>', line: 236, reason: 'no-vcs-capability' }, // same cli-entry.mjs, invoked through a symlink — the literal argv element is the symlink path, not resolvable

  // ── the two line-pinned <unresolved> entries design.md calls out ───────
  { file: 'brain/scripts/memory/lib/hydration-guard.processes.integration.test.mjs', entrypoint: '<unresolved>', line: 40, reason: 'no-vcs-capability' },

  // ── postmerge release workflow: real git, extracted YAML steps, local fixture repo ──
  { file: 'brain/scripts/vcs/release-postmerge-workflows.test.mjs', entrypoint: '<unresolved>', line: 135, reason: 'fixture-root-local-git' },

  // ── regulated-review e2e: vendored review binary against a fixture PR ──
  { file: 'test/review-regulated/regulated-review.e2e.test.mjs', entrypoint: '<unresolved>', line: 47, reason: 'fixture-root-local-git' },

  // ── npm pack: no VCS surface at all ──────────────────────────────────────
  { file: 'test/publish-allowlist.e2e.test.mjs', entrypoint: '<unresolved>', line: 90, reason: 'no-vcs-capability' },

  // ── #1112: bootstrap.sh fragments lifted verbatim into a scratch/fixture
  //    dir, and brain-to-engram.mjs run against a fake `engram` stub — none
  //    of the four ever import or call a VCS/gh port.
  { file: 'brain/scripts/bootstrap.env-gitignore.test.mjs', entrypoint: '<unresolved>', line: 60, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.memory-backend-case.test.mjs', entrypoint: '<unresolved>', line: 109, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.vcs-provider-validate.test.mjs', entrypoint: '<unresolved>', line: 66, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/brain-to-engram.test.mjs', entrypoint: '<unresolved>', line: 141, reason: 'no-vcs-capability' },

  // ── #1112 cold-review follow-up (blockers 2/3): more bootstrap.sh
  //    fragments, lifted verbatim into scratch/fixture dirs — none imports
  //    or calls a VCS/gh port.
  { file: 'brain/scripts/bootstrap.memory-backend-validate.test.mjs', entrypoint: '<unresolved>', line: 68, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.memory-backend-validate.test.mjs', entrypoint: '<unresolved>', line: 173, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.pat-secret-guard.test.mjs', entrypoint: '<unresolved>', line: 58, reason: 'no-vcs-capability' },
  // #1112 cold-review round 3 (blocker 1, symlink handling): shifted from
  // line 113 by the new symlink/non-regular-file tests added above it.
  { file: 'brain/scripts/bootstrap.pat-secret-guard.test.mjs', entrypoint: '<unresolved>', line: 176, reason: 'no-vcs-capability' },

  // ── #1112 cold-review round 3 (should-fix 2): REQUIRED_FAILURES / exit
  //    code fragments, lifted verbatim — no VCS/gh port anywhere in them.
  //    (The e2e test in bootstrap.pat-refusal-e2e.test.mjs spawns `python3`,
  //    not a tracked runtime, so it is not a hit here at all — see that
  //    file's own header for why a real pty was needed.)
  { file: 'brain/scripts/bootstrap.required-failure.test.mjs', entrypoint: '<unresolved>', line: 68, reason: 'no-vcs-capability' },
  { file: 'brain/scripts/bootstrap.required-failure.test.mjs', entrypoint: '<unresolved>', line: 104, reason: 'no-vcs-capability' },
  // #1112 final cold review: the e2e's `sh -c 'command -v gh'` proves the shims resolve first; no VCS port involved.
  { file: 'brain/scripts/bootstrap.pat-refusal-e2e.test.mjs', entrypoint: '<unresolved>', line: 186, reason: 'no-vcs-capability' },
];

function validateAllowlist(entries) {
  for (const entry of entries) {
    if (!REASONS.includes(entry.reason)) {
      throw new Error(`test-spawn-hygiene: allowlist reason '${entry.reason}' for ${entry.file} (${entry.entrypoint}) is not in the closed set: ${REASONS.join(', ')}`);
    }
  }
}

/** Matches `hit` against `allowlist`: a line-pinned entry first, then a
 * bare (file, entrypoint) entry. Returns the matched entry or `undefined`. */
function matchEntry(hit, allowlist) {
  return (
    allowlist.find((e) => e.file === hit.file && e.entrypoint === hit.entrypoint && e.line === hit.line)
    ?? allowlist.find((e) => e.file === hit.file && e.entrypoint === hit.entrypoint && e.line === undefined)
  );
}

test('#1012 every brain/scripts/** runtime spawn under brain/scripts/**/*.test.mjs and test/**/*.test.mjs is allowlisted with a closed-set reason (REQ-SHIP-4)', () => {
  validateAllowlist(ALLOWLIST);

  const { files, hits } = scanAll();
  assert.ok(files.length > 0, 'the scan must actually walk files, not silently see nothing');

  const uncovered = hits.filter((h) => !matchEntry(h, ALLOWLIST));
  assert.deepEqual(
    uncovered,
    [],
    `${uncovered.length} spawn(s) are not covered by the allowlist — a reviewer must classify each: ${JSON.stringify(uncovered, null, 2)}`,
  );

  // No stale entries: every ALLOWLIST entry must match at least one real hit.
  const stale = ALLOWLIST.filter((e) => !hits.some((h) => h.file === e.file && h.entrypoint === e.entrypoint && (e.line === undefined || e.line === h.line)));
  assert.deepEqual(stale, [], `${stale.length} allowlist entr(y/ies) no longer match any real spawn: ${JSON.stringify(stale, null, 2)}`);
});

test('#1012 validateAllowlist rejects a reason outside the closed set', () => {
  assert.throws(
    () => validateAllowlist([{ file: 'x', entrypoint: 'y', reason: 'looks-safe' }]),
    /not in the closed set/,
  );
});

// ── self-proving fixtures ────────────────────────────────────────────────

test('#1012 self-proving: a planted fixture with a runtime spawn, an npm run spawn, and a pure eval returns exactly the two real hits, both uncovered against an empty allowlist', () => {
  const fixtureRoot = testTmp('spawn-hygiene-fixture-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });

  // Callee names built by concatenation (test-hygiene.test.mjs:132's own
  // precedent) — belt and suspenders alongside this file's string-masking,
  // so this planted TEXT is never mistaken for a real call site by this
  // scanner running over ITS OWN committed source later.
  const SPAWN_KW = 'spawn' + 'Sync';
  const EXEC_KW = 'exec' + 'FileSync';
  const plantedSource = [
    "import { spawnSync, execFileSync } from 'node:child_process';",
    "const CLI = 'brain/scripts/memory/cli.mjs';",
    `${SPAWN_KW}(process.execPath, [CLI, 'ship'], {});`,
    `${EXEC_KW}('npm', ['run', 'brain:memory:ship'], {});`,
    `${SPAWN_KW}(process.execPath, ['--input-type=module', '-e', 'console.log(1)'], {});`,
    '',
  ].join('\n');
  writeFileSync(join(fixtureDir, 'planted.test.mjs'), plantedSource, 'utf8');

  const { hits } = scanAll(fixtureRoot, ['brain/scripts/**/*.test.mjs']);
  const simplified = hits.map(({ file, fn, entrypoint }) => ({ file, fn, entrypoint }));
  assert.deepEqual(
    simplified.sort((a, b) => a.fn.localeCompare(b.fn)),
    [
      { file: 'brain/scripts/planted.test.mjs', fn: 'execFileSync', entrypoint: 'npm:brain:memory:ship' },
      { file: 'brain/scripts/planted.test.mjs', fn: 'spawnSync', entrypoint: 'brain/scripts/memory/cli.mjs' },
    ].sort((a, b) => a.fn.localeCompare(b.fn)),
  );

  const uncovered = hits.filter((h) => !matchEntry(h, []));
  assert.equal(uncovered.length, 2, 'both planted hits must be uncovered against an empty allowlist');
});

test('#1012 self-proving: validateAllowlist rejects reason:\'looks-safe\', and a line-pinned entry matching nothing is reported stale', () => {
  assert.throws(() => validateAllowlist([{ file: 'a', entrypoint: 'b', reason: 'looks-safe' }]), /not in the closed set/);

  const fakeAllowlist = [{ file: 'brain/scripts/does-not-exist.test.mjs', entrypoint: 'brain/scripts/nope.mjs', line: 999, reason: 'no-vcs-capability' }];
  const { hits } = scanAll();
  const stale = fakeAllowlist.filter((e) => !hits.some((h) => h.file === e.file && h.entrypoint === e.entrypoint && h.line === e.line));
  assert.deepEqual(stale, fakeAllowlist, 'an entry matching no real hit must be reported stale');
});
