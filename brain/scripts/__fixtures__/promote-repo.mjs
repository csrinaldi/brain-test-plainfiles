// __fixtures__/promote-repo.mjs — builds a REAL, consistent temporary git repo
// for the brain:promote tests (issue #378).
//
// Not a test. Shared by brain-promote.test.mjs and brain-promote.locks.test.mjs
// so the two suites cannot drift on what "a repo brain:promote can run in" means.
//
// The fixture copies the REAL brain/HOME.md and the REAL four remaining
// SOURCE_DOCS out of this checkout, then compiles AGENTS.md with the SAME
// compiler production uses. So the fixture starts byte-consistent by
// construction, and any AGENTS.md drift a test observes is caused by the code
// under test rather than by the fixture being stale.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCE_DOCS, AGENTS_EMIT_PATH, compileAgentsMd } from '../axes/platform/adapters/antigravity.mjs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where a draft lands inside the fixture — the `issue-378` segment is load-bearing. */
export const FIXTURE_CHANGE_DIR = 'openspec/changes/issue-378-brain-promote/brain-drafts';

/** A draft in the exact shape the live drafts use (status blockquote + Tier 2 banner). */
export const SAMPLE_DRAFT = `# ADR-0028 — A sample decision for the promote fixture

> **status:** proposed — pending human promotion | **date:** 2026-08-07 | **owner:** @crinaldi

> **Tier 2 draft.** \`brain/project/decisions/**\` is human-promoted (\`agent-authorities.md\`
> Tier 2). Promoting this file also requires updating \`brain/HOME.md\`.

## Context

Something happened.

> A blockquote INSIDE the body. It is content and must survive the header rewrite.

## Decision

Do the thing.
`;

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * Creates a temporary git repo containing the five real SOURCE_DOCS, a
 * consistent compiled AGENTS.md, an empty brain/project/decisions/, and one
 * draft. Makes exactly ONE commit so `git rev-list --count HEAD` is a stable 1.
 *
 * @param {object} [opts]
 * @param {string} [opts.draftName]  Draft basename. Default `adr-0028-sample-decision.md`.
 * @param {string} [opts.draftBody]  Draft content. Default SAMPLE_DRAFT.
 * @param {string} [opts.userName]   git config user.name inside the fixture.
 * @returns {{ root: string, draftRel: string, draftAbs: string, destRel: string }}
 */
export function makeFixtureRepo({
  draftName = 'adr-0028-sample-decision.md',
  draftBody = SAMPLE_DRAFT,
  userName = 'Fixture Human',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brain-promote-'));

  for (const rel of SOURCE_DOCS) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    cpSync(join(REPO_ROOT, rel), join(root, rel));
  }
  mkdirSync(join(root, 'brain/project/decisions'), { recursive: true });
  mkdirSync(join(root, FIXTURE_CHANGE_DIR), { recursive: true });

  const docs = {};
  for (const rel of SOURCE_DOCS) docs[rel] = readFileSync(join(root, rel), 'utf8');
  writeFileSync(join(root, AGENTS_EMIT_PATH), compileAgentsMd(docs), 'utf8');

  const draftRel = `${FIXTURE_CHANGE_DIR}/${draftName}`;
  writeFileSync(join(root, draftRel), draftBody, 'utf8');

  git(['init', '--quiet'], root);
  git(['config', 'user.name', userName], root);
  git(['config', 'user.email', 'fixture@example.invalid'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['add', '-A'], root);
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'chore: fixture baseline (#378)'], root);

  return {
    root,
    draftRel,
    draftAbs: join(root, draftRel),
    destRel: `brain/project/decisions/${draftName}`,
  };
}

/**
 * Creates a temporary git repo from an explicit relPath → content map, with one
 * commit. Used by the amendment suites (issue #509), whose starting tree is a
 * REAL historical tree rather than the current checkout.
 *
 * @param {{[relPath:string]: string}} files
 * @param {{userName?:string}} [opts]
 * @returns {{root:string}}
 */
export function makeRepoFromFiles(files, { userName = 'Fixture Human' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brain-amend-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content, 'utf8');
  }
  git(['init', '--quiet'], root);
  git(['config', 'user.name', userName], root);
  git(['config', 'user.email', 'fixture@example.invalid'], root);
  git(['config', 'commit.gpgsign', 'false'], root);
  git(['add', '-A'], root);
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'chore: fixture baseline (#509)'], root);
  return { root };
}

/** Porcelain status of the fixture — '' means nothing was written or staged. */
export function statusOf(root) {
  return spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim();
}

/** Number of commits reachable from HEAD. */
export function commitCount(root) {
  return spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
}

/** Staged paths, sorted. */
export function stagedPaths(root) {
  return spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean).sort();
}
