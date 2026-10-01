// test-hygiene.test.mjs — a test that exercises a real entrypoint must not
// write into the real repo root (#1020, same class as #1011/#1013 and
// #1010/#1019). archive.test.mjs 4.1 built its sandbox under
// join(process.cwd(), 'scratch/test-archive-sandbox') and left the
// `scratch/` parent behind on every full-suite run; a cold-review candidate
// that runs the suite (the reviewer role explicitly allows this) then sees
// the real root's entry list change and refuses publication. This guard is
// the "keeps the class closed" half of #1020: a source-level scan, not a
// full-suite-in-a-temp-root run (too expensive to be worth it here).
//
// Scope, deliberately minimal (#1020: "at minimum a source-level scan"):
// flags ONLY a write call — one of WRITE_FNS below — whose OWN argument
// list directly references process.cwd()/resolve('.')/resolve(".") — the
// inline form archive.mjs's mutation test (below) reproduces. A same-file
// variable built from process.cwd() earlier and passed to a write call by
// name (the shape archive.test.mjs actually had, before #1020 unit 2) is
// NOT traced: whole-file, unscoped variable tracking was tried and measured
// to produce real false positives on this repo today —
// brain/scripts/lib/installed-version.test.mjs has four separate
// `const root = ...` bindings across different test() closures, only one
// `process.cwd()`-derived, and an unscoped scan conflates it with the
// OTHER `root`s' unrelated, harmless writeFileSync calls. A per-closure
// scope tracker would close that gap; not built here — direct-only is the
// precise, zero-false-positive floor #1020 asks for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTmp } from './lib/test-tmp.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The roots this guard walks — every *.test.mjs under brain/scripts/** and
// the top-level test/** suite (#1020's own wording); no production-only
// carve-out, since the defect class lives entirely in test code.
const WALK_GLOBS = ['brain/scripts/**/*.test.mjs', 'test/**/*.test.mjs'];

// Never spelled with a trailing `(` anywhere else in this file's raw
// source (including inside the fixture-building strings below) — that
// contiguous substring is exactly what WRITE_CALL_RE matches, and this
// guard scans its own file too (design mirrors chunk-boundary.test.mjs's
// IMPORT_KW/EXPORT_KW trick for the same reason).
const WRITE_FNS = ['mkdirSync', 'writeFileSync', 'symlinkSync', 'cpSync'];

const WRITE_CALL_RE = new RegExp(`\\b(${WRITE_FNS.join('|')})\\s*\\(`, 'g');

// `resolve('.')` with FURTHER segments (`resolve('.', 'x.txt')`) is the same
// defect class as `join(process.cwd(), 'x.txt')` — the bare form has no use as
// a write target, so the match ends at the first `,` or `)` after the dot
// (PR #1022 cold review, blocker).
// `path.resolve()` anchors an all-relative segment list to `process.cwd()`, so
// a resolve whose FIRST segment is a relative string literal (`resolve('x')`,
// `resolve('.', 'x')`) is the same write; an absolute literal (`resolve('/tmp/…')`)
// is not. A variable first segment is out of scope (said non-goal: no
// same-file variable tracing). PR #1022 cold review, rounds 1 and 2.
const CWD_REF_RE = /process\.cwd\(\)|resolve\(\s*['"](?!\/)[^'"]*['"]\s*[,)]/;

/** Returns the text between a call's own `(` (at `openParenIdx`) and its
 * matching `)`, tracking nested parens and skipping over string-literal
 * content so a `)` inside a quoted argument never closes the call early. */
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

/** Scans `globs` (relative to `cwd`) for a write call whose own argument
 * list directly references process.cwd()/resolve('.') — see the module doc
 * comment above for exactly what this does and does not cover. `cwd` is a
 * parameter (not hardcoded to the repo root) so a fixture root can be
 * scanned in isolation for the detection-proof test below. */
function findRealRootWriteViolations(cwd, globs) {
  const files = globSync(globs, { cwd }).map((f) => f.split(sep).join('/'));
  const found = [];
  for (const relFile of files) {
    const src = readFileSync(join(cwd, relFile), 'utf8');
    const re = new RegExp(WRITE_CALL_RE.source, WRITE_CALL_RE.flags);
    let m;
    while ((m = re.exec(src))) {
      const openParenIdx = m.index + m[0].length - 1;
      const argsText = callArgsText(src, openParenIdx);
      if (CWD_REF_RE.test(argsText)) {
        const line = src.slice(0, m.index).split('\n').length;
        found.push({ file: relFile, line, fn: m[1] });
      }
    }
  }
  return { files, found };
}

// Annotated allowlist (design: chunk-boundary.test.mjs's ALLOWLIST
// pattern) — empty today, kept as a real data structure rather than a bare
// assertion so a future genuinely-safe direct match has one documented
// place to land instead of a silent scanner tweak.
const ALLOWLIST = [];

const sortFound = (rows) =>
  [...rows]
    .map(({ file, line, fn }) => ({ file, line, fn }))
    .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

test('no *.test.mjs under brain/scripts/** or test/** writes into the real repo root via a literal process.cwd()/resolve(\'.\') argument (#1020)', () => {
  const { files, found } = findRealRootWriteViolations(repoRoot, WALK_GLOBS);
  assert.ok(files.length > 0, 'the scan must actually walk files, not silently see nothing');
  assert.deepEqual(sortFound(found), sortFound(ALLOWLIST));
});

test('the scanner detects the violation it exists to catch, in an isolated fixture root', () => {
  // Fixture only — testTmp (#842), never brain/scripts/** itself. The
  // planted source is built via concatenation (MKDIR_KW): this file's own
  // text never spells the write-call name immediately followed by `(` —
  // see the module doc comment for why that self-match matters here.
  const fixtureRoot = testTmp('test-hygiene-fixture-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const MKDIR_KW = 'mkdir' + 'Sync';
  const plantedSource = [
    "import { mkdirSync } from 'node:fs';",
    "import { join } from 'node:path';",
    `${MKDIR_KW}(join(process.cwd(), 'x'), { recursive: true });`,
    '',
  ].join('\n');
  writeFileSync(join(fixtureDir, 'planted.test.mjs'), plantedSource, 'utf8');

  const { found } = findRealRootWriteViolations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(found, [{ file: 'brain/scripts/planted.test.mjs', line: 3, fn: 'mkdirSync' }]);
});

test("the scanner also catches resolve('.', ...) with further segments — the multi-segment form is the same defect class (PR #1022 cold review)", () => {
  const fixtureRoot = testTmp('test-hygiene-fixture-resolve-');
  const fixtureDir = join(fixtureRoot, 'test');
  mkdirSync(fixtureDir, { recursive: true });
  const WRITE_KW = 'writeFile' + 'Sync';
  const plantedSource = [
    "import { writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    `${WRITE_KW}(resolve('.', 'x.txt'), 'data');`,
    `${WRITE_KW}(resolve(".", "sub", "y.txt"), 'data');`,
    '',
  ].join('\n');
  writeFileSync(join(fixtureDir, 'planted.e2e.test.mjs'), plantedSource, 'utf8');

  const { found } = findRealRootWriteViolations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(found, [
    { file: 'test/planted.e2e.test.mjs', line: 3, fn: 'writeFileSync' },
    { file: 'test/planted.e2e.test.mjs', line: 4, fn: 'writeFileSync' },
  ]);
});

test("the scanner catches resolve() whose first segment is a RELATIVE string literal, and leaves an absolute literal alone (PR #1022 cold review round 2)", () => {
  // path.resolve() anchors any all-relative segment list to process.cwd(), so
  // `resolve('scratch-dir')` is the same real-root write as
  // `join(process.cwd(), 'scratch-dir')` without spelling either token.
  const fixtureRoot = testTmp('test-hygiene-fixture-relative-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const MKDIR_KW = 'mkdir' + 'Sync';
  const WRITE_KW = 'writeFile' + 'Sync';
  const plantedSource = [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    `${MKDIR_KW}(resolve('scratch-dir'), { recursive: true });`,
    `${WRITE_KW}(resolve("scratch", "x.txt"), 'data');`,
    `${WRITE_KW}(resolve('/tmp/brain-fixture', 'x.txt'), 'data');`,
    '',
  ].join('\n');
  writeFileSync(join(fixtureDir, 'planted.test.mjs'), plantedSource, 'utf8');

  const { found } = findRealRootWriteViolations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(found, [
    { file: 'brain/scripts/planted.test.mjs', line: 3, fn: 'mkdirSync' },
    { file: 'brain/scripts/planted.test.mjs', line: 4, fn: 'writeFileSync' },
  ]);
});

// ---------------------------------------------------------------------------
// Second guard rule (#1026, same "keeps the class closed" spirit as #1020's
// WRITE_FNS/CWD_REF_RE guard above, but a different shape): #1020's guard
// only catches a LITERAL process.cwd()/resolve('.') in the test's OWN call
// arguments. #1026 slipped past it because the write is not spelled in the
// test at all — it is a *default parameter* inside a production function
// (engram.mjs's `pullMemory`) that the test reaches simply by omitting
// `root`. engram.pull.test.mjs's own header comment asserted (without
// verification) that this was "pre-existing and out of scope"; empirically
// only some of its tests actually reached the real root (#1026 fix, this
// same commit's sibling).
//
// Read against engram.mjs (verified by source, not assumed): NINE exported
// functions default their `root` parameter to the real repoRoot —
// `ensureMemorySymlink(root = repoRoot)` (root is a BARE positional
// argument), and eight more that take `root` as a key inside an options
// object (`share`, `importMemory`, `pullMemory`, `setup`, `hydrate` — root
// in hydrate's FIRST object arg — and `save`/`featureCheckpoint`/
// `featureResume` — root in their SECOND object arg, after a leading
// positional `title`/`feature`). `rebuildIndex` (brain/scripts/memory/lib/
// store.mjs:157) is NOT in this list: it takes `{recordsDir, indexPath}`
// with no default, and is only reachable via the `_rebuildIndex` seam of
// the functions above — it never itself defaults to the repo root.
// `pull()` (engram.mjs's own zero-arg `pullMemory()` wrapper) is
// deliberately NOT included: "pull" is too generic an identifier to scan by
// bare name without a false-positive storm, and no test in this repo calls
// it directly today (verified via `rg '\bpull\(\)'` across every
// *.test.mjs).
//
// Design choice — source-level static scan, not a suite-level snapshot:
// the issue's own text offered a suite-level "hash .memory/index.jsonl
// before/after the whole memory suite" as a fallback "if a source-level
// rule is too blunt". It is not too blunt here, PROVIDED it is import-alias
// aware: several existing, already-compliant call sites in this repo import
// these functions under an alias (`import { save as engramSave }` in
// save-parity.test.mjs; `import { share as engramShare, pullMemory as
// engramPullMemory }` in reindex-parity.test.mjs and
// no-artifact.parity.test.mjs) — a plain bare-identifier regex would
// silently produce FALSE NEGATIVES on those real files (measured: `rg
// '\bpullMemory\('` finds zero matches in reindex-parity.test.mjs, which
// calls the function three times, always as `engramPullMemory`). The scan
// below resolves each file's own import bindings first (however aliased)
// and only then checks call sites under the LOCAL name, closing that gap.
// It also strips `//` and `/* */` comments before scanning — engram.mjs's
// own exported names are common enough in prose ("pullMemory()",
// "importMemory():") that an unstripped scan would flag doc comments in
// files that do import one of these names (engram.pull.test.mjs's own
// header, pre-#1026-fix, said "pullMemory()" in a comment on line 1).
//
// Same non-goal as the WRITE_FNS guard above: no same-file variable
// tracing. `const opts = { root: X }; pullMemory(opts)` is NOT traced —
// direct-only, matching this file's established zero-known-false-positive
// floor. No call site in this repo today uses that indirection (verified:
// every real call either inlines the options object or spreads
// `...defaultDeps(...)` alongside an inline `root`/`root,`).

// Root-defaulting engram.mjs exports (verified against source, see the
// comment block above): functions whose `root` is a KEY inside an options
// object vs. functions whose `root` is a BARE positional argument.
const ROOT_KEY_FNS = ['share', 'importMemory', 'pullMemory', 'setup', 'hydrate', 'save', 'featureCheckpoint', 'featureResume'];
const ROOT_POSITIONAL_FNS = ['ensureMemorySymlink'];
const ROOT_DEFAULTING_FNS = [...ROOT_KEY_FNS, ...ROOT_POSITIONAL_FNS];

/** Blanks out `//` line comments and `/* *‍/` block comments to spaces
 * (preserving every other character and all newlines, so byte offsets and
 * line numbers computed against the result still match the original file)
 * while leaving string/template literal contents untouched. Needed because
 * engram.mjs's export names read naturally in prose — an unstripped scan
 * self-flags doc comments in any file that also imports one of them. */
function stripComments(src) {
  let out = '';
  let inString = null;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inLine) {
      out += c === '\n' ? '\n' : ' ';
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === '*' && src[i + 1] === '/') { inBlock = false; out += '  '; i += 1; }
      else out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { i += 1; out += src[i] ?? ''; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inString = c; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') { inLine = true; out += '  '; i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { inBlock = true; out += '  '; i += 1; continue; }
    out += c;
  }
  return out;
}

/** Blanks string/template literal CONTENT to spaces (delimiters kept,
 * length/newlines preserved) on top of an already comment-stripped source.
 * Needed because these export names also read naturally in prose INSIDE a
 * string — a test name or assert message ("`save() must not warn…`",
 * `test('T-E1 — … save() reject …')`) spells `save(` or `importMemory(`
 * immediately followed by `(` just as validly as a real call does, and
 * `stripComments` alone does not touch string contents (it must not, since
 * the import specifier — `'./engram.mjs'` — is itself a string this scan
 * still needs to read). Measured: without this, the guard below self-flagged
 * on its own sibling commit's assertion message in engram.pull.test.mjs
 * ("… reached pullMemory()'s production repoRoot default") and on multiple
 * test names in engram.save.test.mjs/engram.share.test.mjs/
 * engram.feature.test.mjs. */
function blankStrings(commentStrippedSrc) {
  let out = '';
  let inString = null;
  for (let i = 0; i < commentStrippedSrc.length; i++) {
    const c = commentStrippedSrc[i];
    if (inString) {
      if (c === '\\') {
        const next = commentStrippedSrc[i + 1];
        out += ' ' + (next === '\n' ? '\n' : ' ');
        i += 1;
        continue;
      }
      if (c === inString) { inString = null; out += c; continue; }
      out += c === '\n' ? '\n' : ' ';
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { inString = c; out += c; continue; }
    out += c;
  }
  return out;
}

/** Map<localName, realName> for every ROOT_DEFAULTING_FNS binding a
 * (comment-stripped) file imports from a `...engram.mjs` specifier,
 * however aliased (`{ save as engramSave }` → `engramSave` -> `save`). */
function engramRootFnAliases(strippedSrc) {
  const map = new Map();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*engram\.mjs['"]/g;
  let m;
  while ((m = importRe.exec(strippedSrc))) {
    const specs = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const spec of specs) {
      const parts = spec.split(/\s+/);
      const realName = parts[0];
      const alias = parts.length >= 3 && parts[1] === 'as' ? parts[2] : realName;
      if (ROOT_DEFAULTING_FNS.includes(realName)) map.set(alias, realName);
    }
  }
  return map;
}

/** Scans `globs` (relative to `cwd`) for a call to an imported
 * ROOT_DEFAULTING_FNS binding whose own argument list never mentions
 * `root` (object-key functions) or supplies no argument at all
 * (`ensureMemorySymlink`, whose `root` is positional) — see the module
 * comment above this section for exactly what this does and does not
 * cover. `cwd` is a parameter so a fixture root can be scanned in
 * isolation for the detection-proof tests below. */
function findMissingRootViolations(cwd, globs) {
  const files = globSync(globs, { cwd }).map((f) => f.split(sep).join('/'));
  const found = [];
  for (const relFile of files) {
    const commentStripped = stripComments(readFileSync(join(cwd, relFile), 'utf8'));
    const aliasMap = engramRootFnAliases(commentStripped);
    if (aliasMap.size === 0) continue;
    // Blank string content too, ONLY for the call-scanning phase — a real
    // call is never itself inside a string literal, but a prose mention
    // of the same name ("save() must…") reads exactly like one to a plain
    // regex. The import-specifier parse above needs real string content
    // ('./engram.mjs'), so it runs on `commentStripped`, not this.
    const src = blankStrings(commentStripped);
    const localNames = [...aliasMap.keys()];
    const callRe = new RegExp(`\\b(${localNames.join('|')})\\s*\\(`, 'g');
    let m;
    while ((m = callRe.exec(src))) {
      const localName = m[1];
      const realName = aliasMap.get(localName);
      const openParenIdx = m.index + m[0].length - 1;
      const argsText = callArgsText(src, openParenIdx);
      const hasRoot = ROOT_POSITIONAL_FNS.includes(realName)
        ? argsText.trim().length > 0
        : /\broot\b/.test(argsText);
      if (!hasRoot) {
        const line = src.slice(0, m.index).split('\n').length;
        found.push({ file: relFile, line, fn: realName });
      }
    }
  }
  return { files, found };
}

// Annotated allowlist for the missing-root guard — same design as
// ALLOWLIST above.
const ROOT_ALLOWLIST = [
  // engram.import.test.mjs (#820 shape / guard-release tests): every
  // importMemory() call here omits `root`, but importMemory's ONLY use of
  // `root` is `_readRecords(root)` (engram.mjs:399) — and every one of
  // these calls also overrides `_readRecords` with a fixture stub
  // (`() => fixtureRecords(...)`), so the real repoRoot value is
  // constructed but never dereferenced against the filesystem. Verified by
  // reading engram.mjs's importMemory body, not assumed.
  { file: 'brain/scripts/axes/memory/adapters/engram.import.test.mjs', line: 248, fn: 'importMemory' },
  { file: 'brain/scripts/axes/memory/adapters/engram.import.test.mjs', line: 253, fn: 'importMemory' },
  { file: 'brain/scripts/axes/memory/adapters/engram.import.test.mjs', line: 285, fn: 'importMemory' },
  { file: 'brain/scripts/axes/memory/adapters/engram.import.test.mjs', line: 310, fn: 'importMemory' },
  { file: 'brain/scripts/axes/memory/adapters/engram.import.test.mjs', line: 311, fn: 'importMemory' },
  { file: 'brain/scripts/axes/memory/adapters/engram.import.test.mjs', line: 318, fn: 'importMemory' },
  { file: 'brain/scripts/axes/memory/adapters/engram.import.test.mjs', line: 327, fn: 'importMemory' },
  // save-parity.test.mjs: every `save()`/`engramSave()` call passes root
  // through a local `pinnedSeams(root)`/`noActorSeams(root)` helper that
  // DOES set `root` on the returned seams object — the same "same-file
  // indirection is not traced" non-goal already documented on the
  // WRITE_FNS guard above (direct-only is the zero-false-positive floor).
  // Each call site's own `root` argument (`pinnedSeams(engramRoot)` etc.)
  // is a real, isolated tmpRoot() — never the repoRoot default.
  { file: 'brain/scripts/axes/memory/save-parity.test.mjs', line: 58, fn: 'save' },
  { file: 'brain/scripts/axes/memory/save-parity.test.mjs', line: 80, fn: 'save' },
  { file: 'brain/scripts/axes/memory/save-parity.test.mjs', line: 95, fn: 'save' },
];

test('no *.test.mjs under brain/scripts/** or test/** calls a root-defaulting engram.mjs export without passing root (#1026)', () => {
  const { files, found } = findMissingRootViolations(repoRoot, WALK_GLOBS);
  assert.ok(files.length > 0, 'the scan must actually walk files, not silently see nothing');
  assert.deepEqual(sortFound(found), sortFound(ROOT_ALLOWLIST));
});

test('the missing-root scanner detects an object-key root-defaulting call with no root, in an isolated fixture root (#1026)', () => {
  // Built via concatenation, same reasoning as MKDIR_KW above: this file's
  // own source must never spell `pullMemory(` or `.../engram.mjs'`
  // contiguously, or the guard test above would flag ITSELF.
  const PULL_FN = 'pull' + 'Memory';
  const ENGRAM_SPEC = './engram' + '.mjs';
  const fixtureRoot = testTmp('test-hygiene-fixture-root-key-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource = [
    "import { test } from 'node:test';",
    `import { ${PULL_FN} } from '${ENGRAM_SPEC}';`,
    "test('x', async () => {",
    `  await ${PULL_FN}({ _gitPull: () => {}, _import: () => {} });`,
    '});',
    '',
  ].join('\n');
  writeFileSync(join(fixtureDir, 'planted.test.mjs'), plantedSource, 'utf8');

  const { found } = findMissingRootViolations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(found, [{ file: 'brain/scripts/planted.test.mjs', line: 4, fn: 'pullMemory' }]);
});

test('the missing-root scanner detects a no-argument call to the positional-root export (#1026)', () => {
  const ENSURE_FN = 'ensureMemorySymlink';
  const ENGRAM_SPEC = './engram' + '.mjs';
  const fixtureRoot = testTmp('test-hygiene-fixture-root-positional-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource = [
    "import { test } from 'node:test';",
    `import { ${ENSURE_FN} } from '${ENGRAM_SPEC}';`,
    "test('x', () => {",
    `  ${ENSURE_FN}();`,
    '});',
    '',
  ].join('\n');
  writeFileSync(join(fixtureDir, 'planted.test.mjs'), plantedSource, 'utf8');

  const { found } = findMissingRootViolations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(found, [{ file: 'brain/scripts/planted.test.mjs', line: 4, fn: 'ensureMemorySymlink' }]);
});

test('the missing-root scanner follows an aliased import to catch a missing root, and stays quiet when root IS passed (#1026)', () => {
  const SAVE_FN = 'save';
  const SHARE_FN = 'share';
  const ENGRAM_SPEC = './engram' + '.mjs';
  const fixtureRoot = testTmp('test-hygiene-fixture-root-alias-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource = [
    "import { test } from 'node:test';",
    `import { ${SAVE_FN} as engramSave, ${SHARE_FN} as engramShare } from '${ENGRAM_SPEC}';`,
    "test('x', async () => {",
    // Violation: aliased, and its call omits root.
    "  await engramSave('t', 'c', { type: 'discovery' }, { getBranch: () => 'main' });",
    // Compliant: aliased, but its call DOES pass root (shorthand form).
    '  const root = "/fake/root";',
    '  await engramShare({ root, _rebuildIndex: () => ({ count: 0 }) });',
    '});',
    '',
  ].join('\n');
  writeFileSync(join(fixtureDir, 'planted.test.mjs'), plantedSource, 'utf8');

  const { found } = findMissingRootViolations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(found, [{ file: 'brain/scripts/planted.test.mjs', line: 4, fn: 'save' }]);
});

test('the missing-root scanner ignores a root-defaulting name mentioned only in a comment (#1026)', () => {
  const PULL_FN = 'pull' + 'Memory';
  const ENGRAM_SPEC = './engram' + '.mjs';
  const fixtureRoot = testTmp('test-hygiene-fixture-root-comment-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource = [
    "import { test } from 'node:test';",
    `import { ${PULL_FN} } from '${ENGRAM_SPEC}';`,
    `// unit tests for ${PULL_FN}() — this mention must not be flagged.`,
    "test('x', async () => {",
    `  await ${PULL_FN}({ root: '/fake/root', _gitPull: () => {}, _rebuildIndex: () => ({ count: 0 }), _import: () => {} });`,
    '});',
    '',
  ].join('\n');
  writeFileSync(join(fixtureDir, 'planted.test.mjs'), plantedSource, 'utf8');

  const { found } = findMissingRootViolations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(found, [], 'a bare mention of pullMemory() inside a comment must not be flagged');
});

test('the missing-root scanner ignores a root-defaulting name mentioned only inside a string literal — test name or assert message (#1026)', () => {
  // This is the false positive the real-codebase guard test above actually
  // caught while building this guard: engram.pull.test.mjs's own new assert
  // message says "…reached pullMemory()'s production repoRoot default", and
  // engram.save.test.mjs/engram.share.test.mjs/engram.feature.test.mjs all
  // have test NAME strings like "save() must not warn…" / "share() still
  // completes…" / "featureCheckpoint (#102): …" — none of those are calls.
  const PULL_FN = 'pull' + 'Memory';
  const ENGRAM_SPEC = './engram' + '.mjs';
  const fixtureRoot = testTmp('test-hygiene-fixture-root-string-');
  const fixtureDir = join(fixtureRoot, 'brain', 'scripts');
  mkdirSync(fixtureDir, { recursive: true });
  const plantedSource = [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import { ${PULL_FN} } from '${ENGRAM_SPEC}';`,
    `test('unit tests for ${PULL_FN}()', async () => {`,
    `  await ${PULL_FN}({ root: '/fake/root', _gitPull: () => {}, _rebuildIndex: () => ({ count: 0 }), _import: () => {} });`,
    `  assert.ok(true, 'reached ${PULL_FN}() with an explicit root');`,
    '});',
    '',
  ].join('\n');
  writeFileSync(join(fixtureDir, 'planted.test.mjs'), plantedSource, 'utf8');

  const { found } = findMissingRootViolations(fixtureRoot, WALK_GLOBS);
  assert.deepEqual(found, [], 'a mention inside a string literal (test name or assert message) must not be flagged');
});
