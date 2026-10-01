// managed-paths.test.mjs — Unit tests for brain/core/managed-paths.mjs
// Run with: npm test   (node --test, no dependencies)
//
// Covers REQ-S1-4: the two specific governance files must be listed as managed
// paths so they travel with brain on upgrade. The glob `.github/**` must NEVER
// be present — it would clobber a consumer's own workflows, issue templates,
// and CODEOWNERS on brain:upgrade.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  managed,
  local,
  MANAGED_SCRIPT_KEYS,
  RECORDS_UNION_MERGE_GITATTRIBUTES_LINE,
  STRATEGY,
  managedStrategy,
} from '../../core/managed-paths.mjs';
import { matchesAny, strategyFor } from './installer.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('managed includes .github/workflows/governance.yml (exact literal)', () => {
  assert.ok(
    managed.includes('.github/workflows/governance.yml'),
    'managed must contain the exact literal ".github/workflows/governance.yml"',
  );
});

test('managed includes .github/PULL_REQUEST_TEMPLATE.md (exact literal)', () => {
  assert.ok(
    managed.includes('.github/PULL_REQUEST_TEMPLATE.md'),
    'managed must contain the exact literal ".github/PULL_REQUEST_TEMPLATE.md"',
  );
});

test('managed does NOT contain .github/** (never clobber consumer GitHub files)', () => {
  assert.ok(
    !managed.includes('.github/**'),
    'managed must NOT contain ".github/**" — that glob would overwrite consumer workflows on upgrade',
  );
});

// Issue #176 bug 1: the L2 rung-2/rung-3 workflow files must travel with
// brain on upgrade, as exact literals — never the broad .github/** glob.
// Without these, rung-2/rung-3 enforcement never reaches any consumer.
test('managed includes .github/workflows/release.yml (exact literal, issue #176)', () => {
  assert.ok(
    managed.includes('.github/workflows/release.yml'),
    'managed must contain the exact literal ".github/workflows/release.yml"',
  );
});

test('managed includes .github/workflows/governance-postmerge.yml (exact literal, issue #176)', () => {
  assert.ok(
    managed.includes('.github/workflows/governance-postmerge.yml'),
    'managed must contain the exact literal ".github/workflows/governance-postmerge.yml"',
  );
});

// REQ-S3-1: managed declares brain/scripts/**, not scripts/**
test('managed includes brain/scripts/** (REQ-S3-1)', () => {
  assert.ok(
    managed.includes('brain/scripts/**'),
    'managed must contain "brain/scripts/**" (S3 namespace migration)',
  );
});

// REQ-S3-3: consumer root scripts/ is not a managed path
test('managed does NOT contain scripts/** (REQ-S3-3)', () => {
  assert.ok(
    !managed.includes('scripts/**'),
    'managed must NOT contain "scripts/**" — consumer root scripts/ is consumer-owned after S3',
  );
});

// REQ-L6-1: .github/CODEOWNERS (rung-1 enhancement, design §6.2) must travel with
// brain on upgrade, as an exact literal — never the broad .github/** glob, which
// would clobber a consumer's own CODEOWNERS, issue templates, or other workflows.
test('managed includes .github/CODEOWNERS (exact literal, REQ-L6-1)', () => {
  assert.ok(
    managed.includes('.github/CODEOWNERS'),
    'managed must contain the exact literal ".github/CODEOWNERS"',
  );
});

// S5: package.json must be a managed path for specialMerge injection.
test('managed includes package.json (S5)', () => {
  assert.ok(
    managed.includes('package.json'),
    'managed must contain "package.json" so brain:upgrade routes it through specialMerge',
  );
});

// install-home-scaffold REQ-6: brain/HOME.md must stay outside both managed
// and local — managed would clobber curated ADR links on every brain:upgrade,
// local only protects files that already exist at scaffold time. Consumer-owned
// by design.
test('managed does NOT contain an entry matching brain/HOME.md or HOME.md (REQ-6)', () => {
  const hit = managed.find((p) => p === 'brain/HOME.md' || p === 'HOME.md');
  assert.equal(hit, undefined,
    `managed must not contain an entry matching brain/HOME.md or HOME.md — found "${hit}"`);
});

test('local does NOT contain an entry matching brain/HOME.md or HOME.md (REQ-6)', () => {
  const hit = local.find((p) => p === 'brain/HOME.md' || p === 'HOME.md');
  assert.equal(hit, undefined,
    `local must not contain an entry matching brain/HOME.md or HOME.md — found "${hit}"`);
});

// install-home-scaffold REQ-6, hardened: the two literal-only assertions above
// would not catch a future BROAD glob (e.g. `brain/**`) that silently pulls
// brain/HOME.md into `managed` without ever containing the literal string
// "brain/HOME.md". Assert via the actual glob matcher the installer uses
// (matchesAny, from installer.mjs) that no managed pattern MATCHES the path —
// not just that no entry equals it literally.
test('no managed glob MATCHES brain/HOME.md, via the real glob matcher (REQ-6, hardened)', () => {
  assert.equal(matchesAny('brain/HOME.md', managed), false,
    'brain/HOME.md must not match any managed glob — it would be clobbered on brain:upgrade');
});

// install-home-scaffold REQ-7: brain/scripts/lib/home-index.mjs must be
// covered by a managed glob so it ships to every consumer via brain:upgrade.
test('a managed glob covers brain/scripts/lib/home-index.mjs (REQ-7)', () => {
  assert.equal(matchesAny('brain/scripts/lib/home-index.mjs', managed), true,
    'brain/scripts/lib/home-index.mjs must be reachable by a managed glob (e.g. brain/scripts/**)');
});

// S5 + #154 + #906 A5 + #922: the invariants every managed script key must
// hold. #906 A5 (measured): brain:upgrade injects package.json scripts ONLY for
// keys listed here — the launcher FILE travels via brain/scripts/** regardless,
// but its npm script does not exist on any consumer unless the key is in this
// list.
//
// #922 replaced the exact-count assertion (`length === 10`) with invariants.
// The catalog's CONTENT is pinned by managed-script-keys-doctrine.test.mjs,
// against two independent sources: every script the doctrine tells an agent to
// `npm run` must be in this list, and every entry must be a real package.json
// script. An exact count added nothing to those, broke on every legitimate
// addition, and still passed when one key was swapped for another. Do not
// reintroduce it. If a count is ever wanted, compare against an independent
// source — never against MANAGED_SCRIPT_KEYS.length itself, which cannot fail.
//
// Every key is `brain:`-namespaced (#961 R2): the memory verbs a consumer
// receives are `brain:memory:*`. Bare `memory:*` names survive only as
// repo-only aliases in brain's own package.json (#961 R4) and are never managed.
test('MANAGED_SCRIPT_KEYS entries are unique and namespaced brain: (S5, #906 A5, #922, #961)', () => {
  assert.equal(new Set(MANAGED_SCRIPT_KEYS).size, MANAGED_SCRIPT_KEYS.length,
    'MANAGED_SCRIPT_KEYS must not repeat a key');
  for (const key of MANAGED_SCRIPT_KEYS) {
    assert.match(key, /^brain:[a-z]/,
      `every key must start with "brain:" — got "${key}"`);
  }
});

test('MANAGED_SCRIPT_KEYS includes brain:memory:session-end (#906 A5)', () => {
  assert.ok(
    MANAGED_SCRIPT_KEYS.includes('brain:memory:session-end'),
    'brain:memory:session-end must be a managed script key or the SessionEnd hook ' +
      'points at a script that does not exist on any adopter (#906 A5, measured)',
  );
});

test('#906 A5: mergePackageJson delivers brain:memory:session-end into an empty consumer package.json', async (t) => {
  const { mergePackageJson } = await import('./installer.mjs');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { removeTempTree } = await import('../__fixtures__/tmp-tree.mjs');

  const root = mkdtempSync(join(tmpdir(), 'brain-906-managed-'));
  t.after(() => removeTempTree(root));
  const dest = join(root, 'package.json');
  const src = join(root, 'package.json.incoming');
  writeFileSync(dest, JSON.stringify({ name: 'consumer', scripts: {} }, null, 2), 'utf8');
  writeFileSync(src, JSON.stringify({
    scripts: Object.fromEntries(MANAGED_SCRIPT_KEYS.map((k) => [k, `node ./brain/scripts/${k}.mjs`])),
  }, null, 2), 'utf8');

  mergePackageJson(dest, src);

  const merged = JSON.parse(readFileSync(dest, 'utf8'));
  assert.ok(
    Object.hasOwn(merged.scripts, 'brain:memory:session-end'),
    'an empty consumer package.json must receive the brain:memory:session-end script on upgrade',
  );
});

// issue #231, A2 phase 3: the GitLab governance pipeline fragment ships as a
// managed LITERAL (never a root .gitlab-ci.yml — that would clobber the
// consumer's single pipeline file, design.md Decision 1 / REQ-A2-1).
test('managed includes brain/scripts/ci/gitlab-governance.yml (exact literal, issue #231 A2)', () => {
  assert.ok(
    managed.includes('brain/scripts/ci/gitlab-governance.yml'),
    'managed must contain the exact literal "brain/scripts/ci/gitlab-governance.yml"',
  );
});

test('managed does NOT contain a root .gitlab-ci.yml entry (issue #231 A2, REQ-A2-1)', () => {
  const hit = managed.find((p) => p === '.gitlab-ci.yml');
  assert.equal(hit, undefined,
    'managed must not contain ".gitlab-ci.yml" — the consumer root pipeline file stays LOCAL, brain never manages it');
});

// issue #214, C1b: the records/*.jsonl union-merge .gitattributes line is a
// single-source-of-truth constant (mirrors the MANAGED_SCRIPT_KEYS pattern
// above), so this repo's own .gitattributes can be drift-guarded against it.
test('RECORDS_UNION_MERGE_GITATTRIBUTES_LINE is the exact expected literal', () => {
  assert.equal(
    RECORDS_UNION_MERGE_GITATTRIBUTES_LINE,
    '/.memory/records/*.jsonl merge=union',
  );
});

test('.gitattributes contains the exact RECORDS_UNION_MERGE_GITATTRIBUTES_LINE literal (drift guard)', () => {
  const content = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8');
  const lines = content.split('\n').map((l) => l.trim());
  assert.ok(
    lines.includes(RECORDS_UNION_MERGE_GITATTRIBUTES_LINE),
    `.gitattributes must contain the exact line: ${RECORDS_UNION_MERGE_GITATTRIBUTES_LINE}`,
  );
});

// issue #256 B2 / REQ-B2-4 originally made AGENTS.md a managed COPY target, on
// the reasoning that its sources (brain/core/**) are already managed.
//
// SUPERSEDED by #397 / REQ-397-4. That reasoning missed one of the five sources:
// `brain/HOME.md` is CONSUMER-OWNED (managed: false, local: false). So copying
// the compiled artifact does not merely risk losing a consumer's edit — it hands
// every consumer brain's own AGENTS.md, compiled from brain's HOME.md. A file
// describing the wrong repository, in every consumer repo, from the first
// upgrade onward. There is no merge strategy that fixes a build output whose
// inputs straddle the ownership line; it has to be REBUILT, not copied.
test('managed does NOT contain AGENTS.md — it is regenerated, never copied (REQ-397-4)', () => {
  assert.ok(
    !managed.includes('AGENTS.md'),
    'AGENTS.md must NOT be a plain-copy target: it is compiled from brain/HOME.md, which the CONSUMER owns',
  );
});

test('no managed glob MATCHES AGENTS.md, via the real glob matcher (REQ-397-4, hardened)', () => {
  // The literal being absent is not enough — a future `**/*.md` or a root glob
  // would put it back without anyone editing the AGENTS.md line.
  assert.equal(
    matchesAny('AGENTS.md', managed), false,
    'no managed glob may match AGENTS.md, however it is spelled',
  );
});

// issue #305: .gemini/settings.json must travel with brain on upgrade
test('managed includes .gemini/settings.json (exact literal, issue #305)', () => {
  assert.ok(
    managed.includes('.gemini/settings.json'),
    'managed must contain the exact literal ".gemini/settings.json"',
  );
});

// ── Per-path upgrade strategy (issue #397, REQ-397-5) ─────────────────────────
//
// The table below is a TRANSCRIPTION of the classification ratified on
// 04/08/2026 (openspec/changes/issue-397-clobber-asymmetry/brain-drafts/
// managed-path-strategy.md). It is duplicated here ON PURPOSE: the point of a
// signed table is that code cannot drift from it silently, and a test that
// imported the same constant it checks would agree with any future edit.
// Changing a row here without a new human signature is the failure this guards.
const RATIFIED_STRATEGY = Object.freeze({
  '.claude/settings.json': 'merge',
  '.gemini/settings.json': 'merge',
  'package.json': 'merge',
  '.github/CODEOWNERS': 'refuse',
  '.github/PULL_REQUEST_TEMPLATE.md': 'refuse',
  // Issue #570 — the GitLab emission of the SAME scaffold. A new path, not a
  // changed row: the signed 04/08/2026 classification is untouched and this one
  // extends it to the sibling artifact.
  '.gitlab/merge_request_templates/Default.md': 'refuse',
  '.github/workflows/governance.yml': 'refuse',
  '.github/workflows/release.yml': 'refuse',
  '.github/workflows/governance-postmerge.yml': 'refuse',
  'brain/scripts/ci/gitlab-governance.yml': 'refuse',
  'AGENTS.md': 'regenerate',
  '.gitattributes': 'copy',
  'brain/core/**': 'copy',
  'brain/scripts/**': 'copy',
});

test('managedStrategy matches the RATIFIED classification row for row (REQ-397-5)', () => {
  for (const [rel, expected] of Object.entries(RATIFIED_STRATEGY)) {
    assert.equal(
      managedStrategy[rel],
      expected,
      `"${rel}" must be classified "${expected}" — the table was signed 04/08/2026 and a row may not change without a new signature`,
    );
  }
});

test('managedStrategy has no row that is not in the ratified table (REQ-397-5)', () => {
  for (const rel of Object.keys(managedStrategy)) {
    assert.ok(
      Object.hasOwn(RATIFIED_STRATEGY, rel),
      `"${rel}" is classified but absent from the signed table — an unsigned row`,
    );
  }
});

test('STRATEGY enumerates exactly the four ratified strategies (REQ-397-5)', () => {
  assert.deepEqual(
    Object.values(STRATEGY).sort(),
    ['copy', 'merge', 'refuse', 'regenerate'],
  );
});

test('every managed glob carries a strategy — no managed path is unclassified (REQ-397-5)', () => {
  for (const glob of managed) {
    assert.ok(
      Object.hasOwn(managedStrategy, glob),
      `managed glob "${glob}" has no entry in managedStrategy — its upgrade behaviour would be inferred, not declared`,
    );
  }
});

// REGENERATE is the one strategy that means "brain owns producing this path, but
// NEVER by copying it" — so its rows are deliberately absent from `managed`.
// That is the whole content of the decision (REQ-397-4), not an oversight, and
// the exemption is scoped to REGENERATE alone so a MERGE or COPY row that fell
// out of `managed` still fails loudly.
test('every non-REGENERATE classified path is actually managed (REQ-397-5)', () => {
  for (const [rel, strategy] of Object.entries(managedStrategy)) {
    if (strategy === STRATEGY.REGENERATE) continue;
    assert.ok(
      managed.includes(rel),
      `managedStrategy classifies "${rel}", which is not in managed — a rule with nothing to apply to`,
    );
  }
});

test('a REGENERATE path is never in managed — copying it is the defect (REQ-397-4)', () => {
  for (const [rel, strategy] of Object.entries(managedStrategy)) {
    if (strategy !== STRATEGY.REGENERATE) continue;
    assert.ok(
      !managed.includes(rel),
      `"${rel}" is classified REGENERATE but sits in managed — it would be plain-copied, which is exactly what REQ-397-4 forbids`,
    );
  }
});

// The one row where a literal and a glob overlap. `brain/scripts/**` is COPY,
// but `brain/scripts/ci/gitlab-governance.yml` sits under it and is REFUSE.
// If the resolver let the glob win, the signed REFUSE row would be dead text.
test('strategyFor: an exact literal beats a glob that also matches it (REQ-397-5)', () => {
  assert.equal(strategyFor('brain/scripts/ci/gitlab-governance.yml', managedStrategy), 'refuse');
  assert.equal(strategyFor('brain/scripts/lib/installer.mjs', managedStrategy), 'copy');
  assert.equal(strategyFor('brain/core/managed-paths.mjs', managedStrategy), 'copy');
});

test('strategyFor: an unclassified path defaults to copy (REQ-397-5)', () => {
  assert.equal(strategyFor('some/unknown/file.txt', managedStrategy), 'copy');
});


// ── #603: the requirement is per PROVIDER, not per platform ─────────────────
// The GitHub literal above is pinned by name because it is the path this
// repository itself uses. But `openspec/specs/governance` stated the whole
// requirement over that one path, while the code has emitted a scaffold per
// provider since #570 — so the spec under-specified the code and named one
// platform as the system. This test states the requirement the way the spec
// now does: over `SCAFFOLD_DELIVERY`, which is the one place the providers and
// their paths are declared. A third provider joins this guard by joining that
// table, with nobody remembering to widen a list here.
test('#603: EVERY provider brain emits a scaffold for has that scaffold managed', async () => {
  const { SCAFFOLD_DELIVERY, SCAFFOLD_PROVIDERS } = await import('../vcs/contributor-scaffold.mjs');
  assert.ok(SCAFFOLD_PROVIDERS.length >= 2, `the emission table must carry the providers (saw ${SCAFFOLD_PROVIDERS.length})`);
  const unmanaged = SCAFFOLD_PROVIDERS
    .map((p) => SCAFFOLD_DELIVERY[p].path)
    .filter((path) => !managed.includes(path));
  assert.deepEqual(unmanaged, [],
    'a provider whose contributor scaffold is emitted but NOT managed gets a file brain writes once and then '
    + 'never maintains — the shape #570 built the per-provider emission to avoid (#603).');
});
