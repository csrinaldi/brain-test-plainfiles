// verb-contract-drift-guard.test.mjs — issue #239 A3 task 3.6 (design Decision
// 6). Before A3 Phase 3, `vcs-contract.md`'s "Required verbs" table and
// `cli.mjs`'s `VERBS` array had drifted independently: the table was missing
// `prView`/`mrCreate` rows, and `VERBS` was missing `mrCreate`/`branchProtect`/
// `capabilities` entries — nothing caught either gap. This guard reconciles
// ALL THREE sources of truth: the doc table, `VERBS`, and the providers'
// ACTUAL exports — a verb both providers implement but that both the table
// AND `VERBS` omit would pass a doc-table-vs-VERBS-only check silently
// forever (a fresh-context review of the first version of this guard proved
// it would have caught the historical `branchProtect` drift but NOT
// `mrCreate`, since a doc-vs-VERBS check can't see the providers themselves).
//
// `capabilities` is a DELIBERATE, DOCUMENTED exception: it is a
// provider-capability PROBE (tracked in the separate "Phase 3 adapter status"
// table below the Required Verbs table), not part of the base contract every
// provider must implement — so it is intentionally absent from the Required
// Verbs table while still exported and CLI-callable. Any other divergence is
// a real drift and must fail this test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { VERBS } from './cli.mjs';
import * as github from '../axes/vcs/adapters/github.mjs';
import * as gitlab from '../axes/vcs/adapters/gitlab.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONTRACT_DOC = join(REPO_ROOT, 'brain', 'core', 'methodology', 'vcs-contract.md');

// See file header — capabilities is a probe verb, documented separately.
const DOCUMENTED_BUT_NOT_REQUIRED = new Set(['capabilities']);
// Verbs implemented and in VERBS whose vcs-contract.md row is still a DRAFT: exempt only until promoted.
// Empty: #1180 promoted `labelCreate` (#1163) and `workflowRunSucceeded` (#1162); #1196 promoted `issueClose` (#1188).
const PENDING_PROMOTION = new Set([]);

// Function-typed exports that BOTH providers legitimately share but that are
// NOT contract verbs (helpers/constants) — reserved for future entries so the
// third check below doesn't false-positive on a genuinely-shared non-verb
// export. Empty today: `PROVIDER` (the only currently-shared non-function
// export) never reaches this list because the check below filters to
// `typeof === 'function'` first; `checkRuns` (github-only, capability-probe
// helper for `brain:protect`) is NOT shared with gitlab.mjs, so it isn't a
// candidate either. Document each entry's reason inline if one is ever added.
const SHARED_NON_VERB_EXPORTS = new Set([]);

/**
 * Returns the sorted list of function-typed export names present in BOTH
 * provider-shaped objects (`a`/`b`) — the actual, ground-truth "what do both
 * providers implement" signal, independent of the doc table or VERBS array.
 * Pure and provider-object-agnostic on purpose: tests below feed it FAKE
 * provider objects to prove it is a real detector, not just a description of
 * the current (already-reconciled) state.
 */
function sharedFunctionExports(a, b) {
  const isFn = (mod, key) => typeof mod[key] === 'function';
  const namesA = new Set(Object.keys(a).filter(key => isFn(a, key)));
  return Object.keys(b).filter(key => isFn(b, key) && namesA.has(key)).sort();
}

/** Extracts every backtick-quoted verb name from the "Required verbs" table. */
function requiredVerbsFromDoc() {
  const src = readFileSync(CONTRACT_DOC, 'utf8');
  const start = src.indexOf('## Required verbs');
  assert.notEqual(start, -1, 'vcs-contract.md must have a "## Required verbs" section');
  const end = src.indexOf('\n## ', start + 1);
  const section = src.slice(start, end === -1 ? undefined : end);
  const verbs = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^\|\s*`([a-zA-Z]+)`\s*\|/);
    if (m) verbs.push(m[1]);
  }
  return verbs;
}

test('every verb documented in vcs-contract.md\'s Required Verbs table is present in cli.mjs VERBS', () => {
  const docVerbs = requiredVerbsFromDoc();
  assert.ok(docVerbs.length > 5, 'sanity: the Required Verbs table must be parseable and non-trivial');
  for (const verb of docVerbs) {
    assert.ok(VERBS.includes(verb), `vcs-contract.md documents '${verb}' but cli.mjs VERBS is missing it`);
  }
});

test('every DOCUMENTED_BUT_NOT_REQUIRED / PENDING_PROMOTION entry is still ABSENT from the Required Verbs table — promoting a row must remove its exception in the same commit', () => {
  const docVerbs = new Set(requiredVerbsFromDoc());
  for (const verb of [...DOCUMENTED_BUT_NOT_REQUIRED, ...PENDING_PROMOTION]) {
    assert.ok(!docVerbs.has(verb), `'${verb}' is now in vcs-contract.md's Required Verbs table: remove it from DOCUMENTED_BUT_NOT_REQUIRED`);
  }
});

test('every verb in cli.mjs VERBS is either documented in the Required Verbs table or a listed deliberate exception', () => {
  const docVerbs = new Set(requiredVerbsFromDoc());
  for (const verb of VERBS) {
    assert.ok(
      docVerbs.has(verb) || DOCUMENTED_BUT_NOT_REQUIRED.has(verb) || PENDING_PROMOTION.has(verb),
      `cli.mjs exposes '${verb}' but it is neither in the Required Verbs table nor ` +
        'DOCUMENTED_BUT_NOT_REQUIRED — document it in vcs-contract.md or add it here with a reason',
    );
  }
});

// ── THIRD source: the providers' actual exports (not just the two docs above) ──
// A verb both providers implement but that is missing from BOTH the doc table
// AND VERBS would pass the two checks above silently forever — they only
// cross-check each other, never the ground truth. This is the exact class
// that let `mrCreate` slip prior to task 3.6's original fix (proven below by
// simulating that class against FAKE provider objects before trusting the
// real ones).

test('sharedFunctionExports: detects a function exported by BOTH FAKE providers but absent from VERBS (proves the check is a real detector, not a no-op)', () => {
  // Simulate the exact drift class this check exists to catch: a verb both
  // providers implement (here: injected onto copies of the real modules) that
  // never made it into VERBS or the allowlist.
  const fakeGithub = { ...github, ghostVerb: async () => 'gh' };
  const fakeGitlab = { ...gitlab, ghostVerb: async () => 'gl' };

  const shared = sharedFunctionExports(fakeGithub, fakeGitlab);
  assert.ok(shared.includes('ghostVerb'), 'sanity: the injected shared export must be detected as shared');

  const undeclared = shared.filter(name => !VERBS.includes(name) && !SHARED_NON_VERB_EXPORTS.has(name));
  assert.deepEqual(
    undeclared,
    ['ghostVerb'],
    'a function exported by both providers but missing from VERBS/the allowlist must be flagged — ' +
      'this is the exact drift class (mrCreate) a doc-table-vs-VERBS-only check cannot see',
  );
});

test('every function exported by BOTH REAL providers is present in cli.mjs VERBS or the documented non-verb allowlist', () => {
  const shared = sharedFunctionExports(github, gitlab);
  assert.ok(shared.length > 5, 'sanity: the real providers must share a non-trivial set of function exports');
  const undeclared = shared.filter(name => !VERBS.includes(name) && !SHARED_NON_VERB_EXPORTS.has(name));
  assert.deepEqual(
    undeclared,
    [],
    `axes/vcs/adapters/github.mjs and axes/vcs/adapters/gitlab.mjs both export ${JSON.stringify(undeclared)} but ` +
      'cli.mjs VERBS (and SHARED_NON_VERB_EXPORTS) omit them — add the verb to VERBS + vcs-contract.md, ' +
      'or document it in SHARED_NON_VERB_EXPORTS if it is a legitimately-shared non-verb export',
  );
});
