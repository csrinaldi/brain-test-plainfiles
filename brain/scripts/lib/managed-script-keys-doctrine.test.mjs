// managed-script-keys-doctrine.test.mjs — issue #922: MANAGED_SCRIPT_KEYS must
// contain every brain:*/memory:* npm script the doctrine tells an agent to run
// via a literal `npm run <script>` mention, so brain:upgrade actually installs
// the script into a consumer's package.json before the doctrine tells anyone
// to run it. Mirrors the existing `.gitattributes` drift guard in
// managed-paths.test.mjs (same file, "drift guard" pattern).
//
// The catalog lives in brain/core/managed-paths.mjs, which is Tier 2
// (agent-authorities.md Tier 2/3, consolidation-protocol.md §2): a maintainer
// edits it by hand, following the draft under
// openspec/changes/issue-922-managed-scripts/brain-drafts/. If this test goes
// red, doctrine gained an `npm run` the catalog lacks. Fix the catalog, never
// this assertion.
//
// A bare `npm run memory:<verb>` in doctrine still counts: the bare names are
// real scripts in brain's package.json (repo-only aliases, #961 R4) but never
// managed keys (#961 R2), so such a mention fails here. That is the intended
// tripwire for doctrine that forgot the `brain:` prefix. Removing the aliases
// would silently blind it.
//
// Data-driven ON PURPOSE (issue #922 acceptance criteria: "full set reconciled
// against every doctrine `npm run …` mention"): the expected set is EXTRACTED
// from doctrine text at test time, not hardcoded, so a future doctrine edit
// that tells an agent to run a new script re-triggers this guard automatically
// instead of drifting silently again the way `memory:save`/`memory:ship`/
// `memory:audit`/`brain:config` did.
//
// Same shape as `sdd-layout-doc-promotion-tripwire.test.mjs` (#253): it was
// red while the catalog lagged the doctrine, and it went green when the
// maintainer applied the catalog (#922, PR #954). A red run now is a real
// regression — doctrine or catalog drifted — never an expected failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANAGED_SCRIPT_KEYS } from '../../core/managed-paths.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// The doctrine surfaces issue #922 names: brain/core/**, brain/project/**,
// AGENTS.md, CLAUDE.md (checked, absent from this repo today), docs/**.
const DOCTRINE_ROOTS = ['brain/core', 'brain/project', 'AGENTS.md', 'CLAUDE.md', 'docs'];

// EXCEPT docs/inbox/**: `docs/inbox/AGENT-REVIEW-HANDOFF.md` states explicitly
// "`docs/inbox/**` is a capture zone (issue #327) — not a source of truth,
// never governed." A script mentioned only there is a PROPOSAL, not doctrine
// telling an agent to run something. `brain:snapshot`, `brain:status`,
// `brain:review:queue` and `brain:protect-server` are real scripts, and
// `brain:ui` and `brain:credentials` are not; all six appear as `npm run`
// only under docs/inbox/**, so none is a doctrine recommendation today. If
// governed doctrine starts recommending one, this test requires it managed.
const EXCLUDED_DIR_PREFIXES = [join('docs', 'inbox')];

const SCAN_EXTENSIONS = new Set(['.md', '.html', '.mjs', '.js']);

function walk(root) {
  const abs = join(REPO_ROOT, root);
  let st;
  try {
    st = statSync(abs);
  } catch {
    return []; // e.g. CLAUDE.md does not exist in this repo — that is fine, not a defect this test reports.
  }
  if (st.isFile()) return [abs];
  const out = [];
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop();
    const rel = dir.slice(REPO_ROOT.length + 1);
    if (EXCLUDED_DIR_PREFIXES.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (SCAN_EXTENSIONS.has(extname(entry.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

// Real npm scripts, read from package.json — the filter that keeps this test
// data-driven instead of a hand-maintained allowlist. It also naturally drops
// prose that quotes a placeholder or an unshipped proposal without a real
// script behind it (e.g. `npm run backend:build` in AGENTS.md/
// agent-authorities.md is an illustrative example of a CONSUMER's own build
// script, never a brain/memory verb — it has no entry in this repo's
// package.json and is not brain:*/memory:* namespaced either).
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const REAL_SCRIPTS = new Set(Object.keys(pkg.scripts));

const NPM_RUN_RE = /npm run ([a-zA-Z0-9:_-]+)/g;

/**
 * @returns {Set<string>} every brain: or memory: prefixed script doctrine
 *   tells an agent to `npm run`, restricted to scripts that actually exist in
 *   package.json.
 */
function extractRecommendedScripts() {
  const found = new Set();
  for (const root of DOCTRINE_ROOTS) {
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(NPM_RUN_RE)) {
        const key = m[1];
        if ((key.startsWith('brain:') || key.startsWith('memory:')) && REAL_SCRIPTS.has(key)) {
          found.add(key);
        }
      }
    }
  }
  return found;
}

test('every brain:*/memory:* script doctrine tells an agent to `npm run` is in MANAGED_SCRIPT_KEYS (#922)', () => {
  const recommended = extractRecommendedScripts();
  const managed = new Set(MANAGED_SCRIPT_KEYS);
  const missing = [...recommended].filter((k) => !managed.has(k)).sort();

  assert.deepEqual(
    missing,
    [],
    `MANAGED_SCRIPT_KEYS is missing ${missing.length} script(s) the doctrine tells an agent to ` +
      `\`npm run\`: ${missing.join(', ')}.\n` +
      'Add them to brain/core/managed-paths.mjs (Tier 2, a maintainer edit). A bare `memory:<verb>` ' +
      'here means the doctrine forgot the `brain:` prefix (#961): fix the doctrine, not the catalog.',
  );
});

// Companion assertion: guards the OTHER direction so a future promotion that
// adds a key no doctrine mentions (dead weight injected into every
// consumer's package.json) is visible too — not just missing keys.
test('every MANAGED_SCRIPT_KEYS entry is a real npm script (sanity, #922)', () => {
  const unreal = MANAGED_SCRIPT_KEYS.filter((k) => !REAL_SCRIPTS.has(k));
  assert.deepEqual(unreal, [], `MANAGED_SCRIPT_KEYS names script(s) absent from package.json: ${unreal.join(', ')}`);
});
