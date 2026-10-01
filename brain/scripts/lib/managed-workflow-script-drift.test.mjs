// managed-workflow-script-drift.test.mjs — issue #1094: every `npm run
// <script>` a MANAGED workflow invokes must resolve to a key
// brain:upgrade actually ships (MANAGED_SCRIPT_KEYS, brain/core/managed-paths.mjs).
//
// #922 built the same reconciliation for DOCTRINE PROSE
// (managed-script-keys-doctrine.test.mjs): a `.md`/`.mjs` file telling an
// agent to run a script. Workflows are the OTHER surface naming scripts and
// were never covered — a managed workflow calling a bare alias
// (`repo:check`) that brain's own package.json defines but the INSTALLER
// never injects is invisible to that guard, because a workflow step is not
// doctrine prose. That gap is #1094: `.github/workflows/governance.yml` and
// `brain/scripts/ci/gitlab-governance.yml` both called bare `repo:check`,
// green here forever (this repo's OWN package.json still carries the bare
// legacy alias) while a fresh consumer's first PR hit `npm error Missing
// script: "repo:check"` — brain:upgrade injects `brain:repo:check` only,
// per `MANAGED_SCRIPT_KEYS`.
//
// DISCOVERY IS DATA-DRIVEN, ON PURPOSE: the file list below is never
// hardcoded. `discoverManagedWorkflowFiles()` walks `managed`
// (brain/core/managed-paths.mjs) — literals directly, globs expanded
// against the filesystem — and keeps whatever resolves to a `.yml`/`.yaml`
// file. A future managed workflow (a new literal, or one added under an
// already-managed glob) is covered the moment `managed` lists it; nobody
// has to remember to extend this test.
//
// `npm test` is the one exception, and it is a NAMED, COMMENTED constant
// (ALLOWED_TEST_SCRIPT) rather than a silent regex gap: every npm project
// defines `test` by convention (npm's own docs), so a workflow running it is
// not evidence of drift the way a `brain:`/bare verb is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { managed, MANAGED_SCRIPT_KEYS } from '../../core/managed-paths.mjs';
import { globToRegExp } from './installer.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// npm's own shorthand: `npm test`/`npm start`/`npm stop` run without the
// `run` keyword. Workflows here only ever use the `test` form — this guard
// recognizes exactly that one, and only that one, as the allowed exception.
const ALLOWED_TEST_SCRIPT = 'test';

// A workflow file's only relevant extensions. Filters `managed`'s non-YAML
// entries (`.gitattributes`, `package.json`, `.claude/settings.json`, …) out
// of the scan without hardcoding which files are workflows.
const WORKFLOW_EXTENSIONS = new Set(['.yml', '.yaml']);

/** Recursively lists every file under `absDir` (repo-relative walk helper). */
function walkFiles(absDir) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs));
    } else {
      out.push(abs);
    }
  }
  return out;
}

/** The filesystem root a glob's fixed (non-`*`) prefix resolves to. */
function globWalkRoot(pattern) {
  const starIdx = pattern.indexOf('*');
  let prefix = pattern.slice(0, starIdx);
  if (!prefix.endsWith('/')) prefix = dirname(prefix);
  else prefix = prefix.slice(0, -1);
  return prefix;
}

/**
 * Every managed path (literal entries as-is, glob entries expanded against
 * the real filesystem) that both exists and ends in `.yml`/`.yaml`.
 * @returns {string[]} repo-relative, POSIX-style paths.
 */
function discoverManagedWorkflowFiles() {
  const relPaths = new Set();
  for (const pattern of managed) {
    if (pattern.includes('*')) {
      const rootAbs = join(REPO_ROOT, globWalkRoot(pattern));
      const regex = globToRegExp(pattern);
      for (const abs of walkFiles(rootAbs)) {
        const rel = relative(REPO_ROOT, abs).split(sep).join('/');
        if (regex.test(rel)) relPaths.add(rel);
      }
    } else {
      relPaths.add(pattern);
    }
  }
  return [...relPaths]
    .filter((rel) => WORKFLOW_EXTENSIONS.has(extname(rel)))
    .filter((rel) => existsSync(join(REPO_ROOT, rel)) && statSync(join(REPO_ROOT, rel)).isFile())
    .sort();
}

// Matches both YAML shapes this guard must cover:
//   - GitHub:  run: npm run X
//   - GitLab:  - npm run X && npm run Y && ... && npm test
// and the bare `npm test` shorthand (no `run`), captured via the second
// alternative so ALLOWED_TEST_SCRIPT can name it explicitly rather than the
// regex silently never seeing it.
const NPM_INVOCATION_RE = /npm (?:run\s+([a-zA-Z0-9:_-]+)|(test)\b)/g;

/**
 * @param {string} content
 * @returns {{script: string, line: number, text: string}[]}
 */
function findNpmInvocations(content) {
  const found = [];
  const lines = content.split('\n');
  lines.forEach((lineText, idx) => {
    const re = new RegExp(NPM_INVOCATION_RE);
    let m;
    while ((m = re.exec(lineText)) !== null) {
      const script = m[1] ?? m[2];
      found.push({ script, line: idx + 1, text: lineText.trim() });
    }
  });
  return found;
}

test('discoverManagedWorkflowFiles finds the managed workflow YAML files (sanity, #1094)', () => {
  const files = discoverManagedWorkflowFiles();
  assert.ok(files.length > 0, 'expected at least one managed workflow file — discovery is broken');
  assert.ok(
    files.includes('.github/workflows/governance.yml'),
    `expected governance.yml among discovered managed workflows, got: ${files.join(', ')}`,
  );
  assert.ok(
    files.includes('brain/scripts/ci/gitlab-governance.yml'),
    `expected gitlab-governance.yml among discovered managed workflows, got: ${files.join(', ')}`,
  );
});

test('every `npm run <script>` invocation in every MANAGED workflow resolves to a MANAGED_SCRIPT_KEYS entry (#1094)', () => {
  const files = discoverManagedWorkflowFiles();
  const managedSet = new Set(MANAGED_SCRIPT_KEYS);
  const violations = [];

  for (const rel of files) {
    const content = readFileSync(join(REPO_ROOT, rel), 'utf8');
    for (const { script, line, text } of findNpmInvocations(content)) {
      if (script === ALLOWED_TEST_SCRIPT) continue;
      if (!managedSet.has(script)) {
        violations.push(`${rel}:${line} — \`npm run ${script}\` ("${text}") is not in MANAGED_SCRIPT_KEYS`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `Managed workflow(s) invoke a script brain:upgrade never ships (not in MANAGED_SCRIPT_KEYS):\n` +
      `${violations.join('\n')}\n` +
      'A fresh consumer running this workflow hits `npm error Missing script`. Either use the ' +
      '`brain:`-namespaced verb (#961) or add the key to MANAGED_SCRIPT_KEYS in brain/core/managed-paths.mjs.',
  );
});
