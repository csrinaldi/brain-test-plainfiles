// engine-blind-gates.test.mjs — #323's deliverable 4, the half no test pinned:
// "zero engine-conditional code in any gate". The produce/verify line the epic
// holds (route who PRODUCES per stage; keep who VERIFIES neutral) is only real
// while no gate can even NAME an engine.
//
// HOW THIS GUARD HOLDS THE LINE — and why it owns no lexer. Three review
// rounds tried a strip-comments-then-scan approach and each round found the
// next token type it mishandled (URLs in strings, template interpolations,
// regex literals): hand-lexing JavaScript with regexes is an arms race with
// no finish line, and this repo ships zero dependencies, so no real lexer is
// available either. The sound observation that replaces it: a WORKING
// engine-conditional needs one of exactly two things —
//   · the engine's NAME: a quoted string literal, scanned on RAW text
//     (comments included — a gate file quoting an engine name deserves a
//     look, and the allowlist with a reason is the exit); or
//   · the engine's MODULE: an import whose specifier crosses into
//     brain/scripts/harness/** (the engines' home), scanned by specifier.
// A bare identifier bound to neither is a ReferenceError, not a fork; a
// binding chain that works ends at a literal in some scanned file (caught
// there) or at a harness import (caught here). Tokens come from platform.mjs,
// never a second list, so a future engine joins the guard the moment it
// joins the platform. Allowlist shape per #802: a reviewed one-line reason,
// never a widened scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SDD_ENGINES } from '../harness/platform.mjs';
import { VERIFICATION_SURFACE } from './governance-tiers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');

// The scanned surface is BRAIN'S OWN DECLARATION (#847 review, maintainer's
// ruling): governance-tiers.mjs's VERIFICATION_SURFACE — the gates' vocabulary
// owner — says what a gate is, platform-neutrally. A forge's CI config is one
// adapter's WIRING of that surface; the drift test below checks the forge
// against the declaration, never the reverse. Round 5's hand-remembered list
// and round 6's read-the-forge derivation were both the same mistake at
// different depths: resolving doctrine from something other than doctrine.
const GATE_ROOTS = VERIFICATION_SURFACE.dirs;
const GATE_FILES = VERIFICATION_SURFACE.scripts;

// A file may buy its way in ONLY with a reviewed one-line reason.
const ALLOWLIST = new Map([
  // The ONE producer inside a verify-side dir: the cold-review runner
  // dispatches the stage to an engine — importing harness is its JOB
  // (#575/#682). Everything else under review/lib is evaluator territory.
  ['brain/scripts/review/lib/run-cold-review-stage.mjs',
    'the cold-review stage runner PRODUCES: it routes to an engine by design'],
]);

/** Pure: brain/scripts/*.mjs references in a forge config's EFFECTIVE lines —
 * YAML comments stripped first (round 6: a commented path is documentation,
 * not an invocation; bootstrap-smoke.yml proves the case). */
export function forgeScriptRefs(yamlText) {
  const out = new Set();
  const effective = yamlText.split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .join('\n');
  for (const m of effective.matchAll(/brain\/scripts\/[a-z0-9/._-]+\.mjs/g)) {
    if (!m[0].endsWith('.test.mjs')) out.add(m[0]);
  }
  return [...out].sort();
}

/** Pure: is this repo-relative path inside the declared surface? */
export function inSurface(rel) {
  if (GATE_FILES.includes(rel)) return true;
  return GATE_ROOTS.some((root) => rel === root || rel.startsWith(root + sep));
}

/** Pure: every quoted engine-name literal in RAW text. */
export function engineLiterals(text, engines) {
  const hits = [];
  for (const engine of engines) {
    if (new RegExp(`['"\`]${engine}['"\`]`).test(text)) {
      hits.push({ engine, form: 'string literal' });
    }
  }
  return hits;
}

/** Pure: every import/re-export specifier in the text — static, dynamic, export-from. */
export function importSpecifiers(text) {
  const out = [];
  const re = /(?:import|export)\s[^'"();]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// The engines' home. Until #1141 it was one directory, brain/scripts/harness/,
// which also held every engine and platform adapter. #1141 moved those
// adapters to the axis directories below WITHOUT changing what this guard
// forbids: a gate reaching an engine's module, wherever the module now lives.
// The VCS and memory axes are deliberately absent — a gate importing a VCS
// adapter is the port working, not a fork per engine.
const ENGINE_HOMES = [
  join('brain', 'scripts', 'harness'),
  join('brain', 'scripts', 'axes', 'platform'),
  join('brain', 'scripts', 'axes', 'sdd-engine'),
  join('brain', 'scripts', 'axes', 'review-engine'),
  join('brain', 'scripts', 'axes', 'lib'),
];

/** Pure: specifiers that resolve into the engines' home, from a file at relDir. */
export function harnessImports(text, relDir) {
  return importSpecifiers(text).filter((spec) => {
    if (!spec.startsWith('.')) return false;
    const resolved = join(relDir, spec);
    // Path-boundary, not prefix (round 5): a sibling named harness-legacy
    // must not read as inside the engines' home.
    return ENGINE_HOMES.some((home) => resolved === home || resolved.startsWith(home + sep));
  });
}

function mjsFilesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) out.push(p);
    }
  };
  walk(join(REPO, root));
  return out;
}

test('#323 S7: the two pure checks catch the binding roads — and only the binding roads', () => {
  const engines = ['gentle-ai', 'plain'];
  // The NAME road: quoted literals, any quote, raw text.
  assert.deepEqual(engineLiterals("const e = 'plain';", engines), [{ engine: 'plain', form: 'string literal' }]);
  assert.deepEqual(engineLiterals('run("gentle-ai")', engines), [{ engine: 'gentle-ai', form: 'string literal' }]);
  assert.deepEqual(engineLiterals('const s = `plain`;', engines), [{ engine: 'plain', form: 'string literal' }]);
  assert.deepEqual(engineLiterals('// in plain terms, explain plaintext', engines), [],
    'unquoted prose stays silent — the word is not the token');
  // The MODULE road: static, dynamic, and re-export specifiers into harness/.
  const dir = join('brain', 'scripts', 'vcs');
  assert.deepEqual(harnessImports("import { plain } from '../harness/backends/plain.mjs';", dir), ['../harness/backends/plain.mjs']);
  assert.deepEqual(harnessImports("const m = await import('../harness/platform.mjs');", dir), ['../harness/platform.mjs']);
  assert.deepEqual(harnessImports("export { runStage } from '../harness/stage-seam.mjs';", dir), ['../harness/stage-seam.mjs']);
  assert.deepEqual(harnessImports("import { resolveTier } from './governance-tiers.mjs';", dir), [],
    'a gate importing another gate is the normal shape — silent');
  // Round 5: the boundary is a path boundary, never a prefix.
  assert.deepEqual(harnessImports("import { x } from '../harness-legacy/old.mjs';", dir), [],
    'a sibling merely PREFIXED harness is not the engines\' home');
  // Round 2/3/4's bypass shapes all reduce to one of the two roads: a bare
  // identifier with neither binding is a ReferenceError, not a fork.
  assert.deepEqual(engineLiterals('if (engine === plain) fork();', engines), [],
    'caught not here but at the binding: `plain` must be imported (module road) or defined from a literal (name road)');
});

test('#323 S7 (round 6 + maintainer): the forge wiring is CHECKED AGAINST the declaration — never the authority', () => {
  // Every script a forge config actually references must live inside brain's
  // own declared surface. A new gate wired in CI without joining
  // VERIFICATION_SURFACE fails HERE — the drift is caught at the boundary,
  // and the fix is the declaration, not this test.
  const wfDir = join(REPO, '.github', 'workflows');
  const outside = [];
  for (const name of readdirSync(wfDir)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    for (const ref of forgeScriptRefs(readFileSync(join(wfDir, name), 'utf8'))) {
      if (!inSurface(ref)) outside.push(`${name} invokes ${ref}`);
    }
  }
  assert.deepEqual(outside, [],
    'a forge config invokes a script outside VERIFICATION_SURFACE — declare it in governance-tiers.mjs (the authority), never here');
});

test('B2.2 (#889, design A9): brain/scripts/memory/index-lag.mjs is declared in VERIFICATION_SURFACE.scripts', () => {
  // index-lag.mjs lives under brain/scripts/memory/, which is NOT one of
  // VERIFICATION_SURFACE.dirs — it must be declared by name, beside
  // check-refs.mjs, or the local-checks warning wired into governance.yml
  // becomes a gate the drift guard above cannot see.
  assert.ok(VERIFICATION_SURFACE.scripts.includes('brain/scripts/memory/index-lag.mjs'),
    'the local-checks index-lag warning script must join the verification surface declaration');
});

test('#323 S7 (round 6): a commented path in a forge config is documentation, not an invocation', () => {
  const yaml = 'on: push\n# bootstrap.sh runs brain/scripts/lib/brain-config.mjs ensure, which imports things\njobs:\n  x:\n    steps:\n      - run: node brain/scripts/brain-audit.mjs   # the audit gate\n';
  assert.deepEqual(forgeScriptRefs(yaml), ['brain/scripts/brain-audit.mjs'],
    'the comment-only mention stays out; the run-line reference stays in');
});

test('#323 S7: gate surfaces carry ZERO engine names and ZERO harness imports — verification stays neutral', () => {
  const files = [...new Set([
    ...GATE_ROOTS.flatMap(mjsFilesUnder),
    ...GATE_FILES.map((f) => join(REPO, f)),
  ])];
  assert.ok(files.length > 20, `the scan must actually see the gate tree (saw ${files.length} files)`);
  const offenders = [];
  for (const file of files) {
    const rel = relative(REPO, file);
    if (ALLOWLIST.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    for (const { engine, form } of engineLiterals(text, SDD_ENGINES)) {
      offenders.push(`${rel} names '${engine}' (${form})`);
    }
    for (const spec of harnessImports(text, dirname(rel))) {
      offenders.push(`${rel} imports the engines' home ('${spec}')`);
    }
  }
  assert.deepEqual(offenders, [],
    `a gate that can name an engine or reach its module can fork per engine — ADR-0019 Amendment 1 ` +
    `condition 2. If a specific site genuinely must, add a reviewed ALLOWLIST entry with a one-line ` +
    `reason; never widen the scan to stop seeing it.`);
});

test('#323 S7 (round 7): every reader ADR-0019 Amendment 1 condition 2 names is INSIDE the surface', () => {
  // The condition's own enumeration is the neutrality boundary: phase-order,
  // the checkpoint evaluator, check-refs, change:archive. Two lived outside
  // vcs/governance and were unguarded until this round.
  const four = [
    'brain/scripts/vcs/phase-order-check.mjs',
    'brain/scripts/review/evaluators/checkpoint.mjs',
    'brain/scripts/check-refs.mjs',
    'brain/scripts/archive.mjs',
  ];
  for (const reader of four) {
    assert.ok(inSurface(reader), `${reader} — a reader the ADR names must be a reader the guard scans`);
  }
  // Round 8: the evaluator's decision CORE, split into a sibling by the D1
  // pure-core pattern, must ride the dir — a file list loses to refactors.
  assert.ok(inSurface('brain/scripts/review/evaluators/tranche.mjs'),
    'the tranche core is the checkpoint verdict — inside, by directory, not by memory');
});

test('#323 S7: the token list is the PLATFORM\'s, not a copy — a new engine joins this guard automatically', () => {
  assert.ok(SDD_ENGINES.length >= 2, 'the epic shipped two engines; the guard reads them from platform.mjs');
  assert.ok(SDD_ENGINES.includes('plain') && SDD_ENGINES.includes('gentle-ai'), 'the two wired engines are the tokens scanned');
});
