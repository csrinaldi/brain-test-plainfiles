// memory-script-prefix.test.mjs — the hazard guard for the `memory:*` →
// `brain:memory:*` rename (issue #961, R7; design.md D3-D4). Test-only: the
// scanner lives here, not in a production `lib/` module, because it has no
// runtime caller and test files cost 0 counted lines against the review
// budget (D3). Four assertions, never overlapping (D4):
//
//   A1 — no `brain:brain:` anywhere in the hazard set (H)
//   A2 — `governance.yml`'s `memory:index-lag` step name is exactly the one
//        line it always was; `brain:memory:index-lag` never appears
//   A3 — no bare `run memory:<NAME>` (with an optional `--silent`) inside
//        the Tier-1 set (T1)
//   A4 — no other bare `memory:<NAME>` token inside T1, EXCLUDING anything
//        A3 already covers — a revert of one site must kill exactly one
//        assertion, never both (design D4)
//
// H = T1 plus `brain/core/**`, `brain/project/**`, `brain/HOME.md`,
// `AGENTS.md` and `CHANGELOG.md`. `openspec/changes/**` is in neither set —
// this change's own artifacts (and every other unarchived change's
// `brain-drafts/`) legitimately name the hazard in prose (R5, D6).
//
// `package.json` is scanned by VALUES only: the KEYS legitimately hold the
// bare `memory:*` alias names (R4) and must never trip A4.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, globSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The eleven verbs R3 renames (R7's rename map). Order does not matter — this
// is only ever used inside a regex alternation.
const NAMES = ['save', 'index', 'share', 'pull', 'resolve-index', 'audit', 'ship', 'reindex', 'split-records', 'collect', 'migrate-v1'];
const NAME_ALT = NAMES.join('|');

// A3: `run memory:X` / `run --silent memory:X`, bare, never `brain:memory:X`
// (the negative lookbehind on `memory:` below would already exclude the
// prefixed form, but A3's own literal shape — `run` then optionally
// `--silent` then `memory:` — never matches a `run brain:memory:X` site at
// all, since the token right after `run ` is `brain:...`, not `memory:...`).
const A3_SOURCE = `\\brun\\s+(?:--silent\\s+)?memory:(?:${NAME_ALT})(?![\\w-])`;

// A4: any bare `memory:X` not preceded by a word char, `:` or `-` (so
// `brain:memory:X` and the alias KEY `memory:X` inside a longer identifier
// like `xmemory:X` are excluded) and not followed by `[\w-]` (so
// `memory:index-lag` never matches on NAME `index`).
const A4_SOURCE = `(?<![\\w:-])memory:(?:${NAME_ALT})(?![\\w-])`;

function scriptValuesOnly(text) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return '';
  }
  return Object.values(pkg.scripts ?? {}).join('\n');
}

// T1 — every live Tier-1 surface (design's Interfaces/Contracts table).
function isT1Path(relPath) {
  if (relPath === 'package.json') return true;
  if (relPath.startsWith('brain/scripts/') && !relPath.endsWith('.test.mjs')) return true;
  if (relPath.startsWith('docs/') && !relPath.startsWith('docs/inbox/')) return true;
  if (relPath === 'README.md' || relPath === '.gitignore') return true;
  if (relPath.startsWith('.github/')) return true;
  if (relPath.startsWith('.gitlab/')) return true;
  if (relPath.startsWith('.claude/')) return true;
  if (relPath.startsWith('.gemini/')) return true;
  if (relPath.startsWith('openspec/specs/')) return true;
  if (relPath.startsWith('test/') && !relPath.endsWith('.test.mjs')) return true;
  return false;
}

// H \ T1 — doctrine and history surfaces that only A1/A2 ever look at.
function isHazardOnlyPath(relPath) {
  if (relPath.startsWith('brain/core/')) return true;
  if (relPath.startsWith('brain/project/')) return true;
  if (relPath === 'brain/HOME.md') return true;
  if (relPath === 'AGENTS.md') return true;
  if (relPath === 'CHANGELOG.md') return true;
  return false;
}

/**
 * Pure scanner. `files`: `{ path, text }[]`, `path` POSIX-relative to repo
 * root. Scope (T1 vs hazard-only vs neither) is derived from `path`, exactly
 * like the real-tree walker below — a caller cannot accidentally widen or
 * narrow scope by mistagging a fixture. Returns `{ a1, a2, a3, a4 }`, each an
 * array of the file paths where that assertion found a violation.
 */
export function scan(files) {
  const a3Re = new RegExp(A3_SOURCE, 'g');
  const a4Re = new RegExp(A4_SOURCE, 'g');
  const findings = { a1: [], a2: [], a3: [], a4: [] };

  for (const { path, text } of files) {
    const inT1 = isT1Path(path);
    const inH = inT1 || isHazardOnlyPath(path);
    if (!inH) continue;

    const scanText = path.endsWith('package.json') ? scriptValuesOnly(text) : text;

    if (/brain:brain:/.test(scanText)) findings.a1.push(path);

    if (path.endsWith('.github/workflows/governance.yml') || path === '.github/workflows/governance.yml') {
      const nameCount = (text.match(/- name: memory:index-lag \(/g) ?? []).length;
      const renamedCount = (text.match(/brain:memory:index-lag/g) ?? []).length;
      if (nameCount !== 1 || renamedCount !== 0) findings.a2.push(path);
    }

    if (!inT1) continue;

    const a3Matches = [...scanText.matchAll(a3Re)];
    if (a3Matches.length > 0) findings.a3.push(path);
    const a3Spans = a3Matches.map((m) => [m.index, m.index + m[0].length]);

    const a4Matches = [...scanText.matchAll(a4Re)].filter(
      (m) => !a3Spans.some(([start, end]) => m.index >= start && m.index < end),
    );
    if (a4Matches.length > 0) findings.a4.push(path);
  }

  return findings;
}

const emptyFindings = { a1: [], a2: [], a3: [], a4: [] };

// ── Fixture tree (design's assertion table) ────────────────────────────────
// A minimal, deliberately CORRECT H tree: one file per T1 category the
// assertions actually touch, plus one hazard-only file (AGENTS.md) so A1
// exercises scope beyond T1 too. Every mutation test below starts from a
// fresh copy of this tree and changes exactly one file.

function baseTree() {
  return [
    {
      path: 'package.json',
      text: JSON.stringify(
        {
          scripts: {
            'memory:save': 'node ./brain/scripts/memory/cli.mjs save',
            'brain:memory:save': 'node ./brain/scripts/memory/cli.mjs save',
          },
        },
        null,
        2,
      ),
    },
    {
      path: '.github/workflows/governance.yml',
      text: '  - name: memory:index-lag (governance)\n    run: node check.mjs\n',
    },
    {
      path: 'README.md',
      text: 'Run `npm run brain:memory:share` to share; see the secret scanner for `brain:memory:share`.\n',
    },
    {
      path: 'AGENTS.md',
      text: 'Run `npm run brain:memory:audit` to audit.\n',
    },
  ];
}

function withFile(tree, path, text) {
  return tree.map((f) => (f.path === path ? { path, text } : f));
}

test('memory-script-prefix scan: a clean H tree has zero findings on all four assertions', () => {
  assert.deepEqual(scan(baseTree()), emptyFindings);
});

test('memory-script-prefix scan A1: `brain:brain:` in a T1 file fails ONLY A1 (mutation: README.md gets brain:brain:memory:ship)', () => {
  const tree = withFile(baseTree(), 'README.md', 'Run `npm run brain:brain:memory:ship` to ship.\n');
  const found = scan(tree);
  assert.deepEqual(found, { a1: ['README.md'], a2: [], a3: [], a4: [] });
});

test('memory-script-prefix scan A1: `brain:brain:` in a hazard-only file (AGENTS.md) still fails A1 (H is wider than T1)', () => {
  const tree = withFile(baseTree(), 'AGENTS.md', 'Run `npm run brain:brain:memory:audit` to audit.\n');
  const found = scan(tree);
  assert.deepEqual(found, { a1: ['AGENTS.md'], a2: [], a3: [], a4: [] });
});

test('memory-script-prefix scan A2: governance.yml rewritten to brain:memory:index-lag fails ONLY A2', () => {
  const tree = withFile(
    baseTree(),
    '.github/workflows/governance.yml',
    '  - name: brain:memory:index-lag (governance)\n    run: node check.mjs\n',
  );
  const found = scan(tree);
  assert.deepEqual(found, { a1: [], a2: ['.github/workflows/governance.yml'], a3: [], a4: [] });
});

test('memory-script-prefix scan A2: a second, duplicate memory:index-lag step name fails A2 (the "exactly once" half)', () => {
  const tree = withFile(
    baseTree(),
    '.github/workflows/governance.yml',
    '  - name: memory:index-lag (governance)\n    run: node check.mjs\n  - name: memory:index-lag (governance)\n    run: node check.mjs\n',
  );
  const found = scan(tree);
  assert.deepEqual(found, { a1: [], a2: ['.github/workflows/governance.yml'], a3: [], a4: [] });
});

test('memory-script-prefix scan A3: a bare `npm run memory:X` in a T1 file fails ONLY A3, never A4 (they never overlap)', () => {
  const tree = withFile(baseTree(), 'README.md', 'Run `npm run memory:share` to share.\n');
  const found = scan(tree);
  assert.deepEqual(found, { a1: [], a2: [], a3: ['README.md'], a4: [] });
});

test('memory-script-prefix scan A4: a bare `memory:X` token outside a run context fails ONLY A4 (mutation: brain:memory:share -> memory:share)', () => {
  const tree = withFile(
    baseTree(),
    'README.md',
    'Run `npm run brain:memory:share` to share; see the secret scanner for `memory:share`.\n',
  );
  const found = scan(tree);
  assert.deepEqual(found, { a1: [], a2: [], a3: [], a4: ['README.md'] });
});

test('memory-script-prefix scan: a bare memory:X token in a hazard-only file (not T1) never fails A3 or A4', () => {
  const tree = withFile(baseTree(), 'AGENTS.md', 'Run `npm run memory:audit` to audit.\n');
  const found = scan(tree);
  assert.deepEqual(found, emptyFindings);
});

test('memory-script-prefix scan: package.json KEYS holding the bare alias names never trip A4 (only scripts VALUES are scanned)', () => {
  const found = scan(baseTree());
  assert.deepEqual(found, emptyFindings, 'the memory:save / memory:index-lag-shaped KEYS in package.json must not be scanned');
});

test('memory-script-prefix scan: memory:index-lag never matches A3/A4 even when the file is T1 (lookahead excludes the trailing "-lag")', () => {
  const tree = withFile(baseTree(), 'README.md', 'See `npm run memory:index-lag` for the CI step.\n');
  const found = scan(tree);
  // "index-lag" is not one of the eleven NAMEs the rename touches, and the
  // `(?![\w-])` lookahead on NAME=index refuses to match before a `-`.
  assert.deepEqual(found, emptyFindings);
});

// ── Real-tree read-only test (gated on `.brain-source`, like
// `chunk-boundary.test.mjs` and `session-start-config.test.mjs`'s
// alias check) ──────────────────────────────────────────────────────────────

const CANDIDATE_GLOBS = [
  'package.json',
  'README.md',
  '.gitignore',
  'AGENTS.md',
  'CHANGELOG.md',
  'brain/**/*',
  'docs/**/*',
  '.github/**/*',
  '.gitlab/**/*',
  '.claude/**/*',
  '.gemini/**/*',
  'openspec/specs/**/*',
  'test/**/*',
];

function realHazardTree(cwd) {
  const candidates = globSync(CANDIDATE_GLOBS, { cwd }).map((f) => f.split(sep).join('/'));
  const files = [];
  for (const relPath of candidates) {
    if (!isT1Path(relPath) && !isHazardOnlyPath(relPath)) continue;
    let stat;
    try {
      stat = statSync(join(cwd, relPath));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    let text;
    try {
      text = readFileSync(join(cwd, relPath), 'utf8');
    } catch {
      continue; // binary or unreadable — never a scan target
    }
    files.push({ path: relPath, text });
  }
  return files;
}

const realTreeSkip = existsSync(join(ROOT, '.brain-source'))
  ? false
  : 'the hazard guard only reads brain\'s own source tree';

test('memory-script-prefix real tree: no brain:brain:, governance.yml unchanged, no bare npm run memory:<eleven> in a Tier-1 surface (#961 R7)', { skip: realTreeSkip }, () => {
  const found = scan(realHazardTree(ROOT));
  assert.deepEqual(found.a1, [], 'a double `brain:brain:` prefix exists somewhere in H');
  assert.deepEqual(found.a2, [], 'governance.yml\'s memory:index-lag step name changed');
  assert.deepEqual(found.a3, [], 'a bare `npm run memory:<eleven>` still exists in a Tier-1 file');
  assert.deepEqual(found.a4, [], 'a bare memory:<eleven> token still exists in a Tier-1 file');
});
