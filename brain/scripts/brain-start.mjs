#!/usr/bin/env node
// brain-start.mjs — Golden-path verb: start work on an approved issue (REQ-S5-1).
//
// Usage: npm run brain:start <issue-number>
//   1. Calls issueView() via the configured VCS provider.
//   2. Checks that the issue has the approved label (governance.approvedLabel,
//      provider-resolved — issue #231 A2 phase 1, design.md Decision 4).
//   3. Creates a local branch: feature/<number>-<title-slug>.
//   4. Exits 0 on success; exits 1 if unapproved or issue not found.
//
// The script performs NO action on import — side effects are guarded at the bottom.
// Import this module; get runStart() — no network calls, no process.exit.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { nonEmptySlug } from './lib/branch-grammar.mjs';
import { resolveApprovedLabel } from './governance/approved-label.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── helpers ───────────────────────────────────────────────────────────────────

/** Convert a title string to a safe branch-name segment. */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Create a local git branch via spawnSync. Returns { ok, error }. */
function gitCreateBranch(branch) {
  const r = spawnSync('git', ['checkout', '-b', branch], { encoding: 'utf8' });
  if (r.status === 0) return { ok: true };
  return { ok: false, error: r.stderr.trim() || `git checkout -b failed (status ${r.status})` };
}

// ── core logic (injectable for tests) ────────────────────────────────────────

/**
 * Run the brain:start flow.
 *
 * @param {object} opts
 * @param {string} opts.issueNumber     Issue number (string or number).
 * @param {string} opts.project         VCS project slug (e.g. "owner/repo").
 * @param {Function} opts.issueViewFn   Async fn({project,number}) → issue object. Injected for tests.
 * @param {Function} opts.createBranchFn Async fn(branchName) → {ok,error?}. Injected for tests.
 * @param {string} [opts.approvedLabel] Resolved approved label (governance.approvedLabel,
 *   provider-resolved). Defaults to resolveApprovedLabel()'s base form when omitted.
 * @returns {Promise<{exitCode: number, message: string}>}
 */
export async function runStart({ issueNumber, project, issueViewFn, createBranchFn, approvedLabel }) {
  const label = approvedLabel ?? resolveApprovedLabel({}, undefined);
  const num = parseInt(issueNumber, 10);
  if (!num || num <= 0) {
    return { exitCode: 1, message: `brain:start: invalid issue number: ${issueNumber}` };
  }

  let issue;
  try {
    issue = await issueViewFn({ project, number: num });
  } catch (e) {
    return {
      exitCode: 1,
      message: `brain:start: issue #${num} not found — ${e.message}`,
    };
  }

  const labels = issue.labels ?? [];
  if (!labels.includes(label)) {
    return {
      exitCode: 1,
      message:
        `brain:start: issue #${num} ("${issue.title}") is not approved.\n` +
        `  Labels found: [${labels.join(', ')}]\n` +
        `  Add "${label}" before starting work.`,
    };
  }

  const branch = `feature/${num}-${nonEmptySlug(slugify(issue.title))}`;
  const created = await createBranchFn(branch);
  if (!created.ok) {
    return {
      exitCode: 1,
      message: `brain:start: could not create branch "${branch}" — ${created.error}`,
    };
  }

  return {
    exitCode: 0,
    message: `brain:start: branch "${branch}" created. Start working on issue #${num}.`,
  };
}

// ── CLI entry-point ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const issueNumber = process.argv[2];
  if (!issueNumber) {
    console.error('Usage: npm run brain:start <issue-number>');
    process.exit(1);
  }

  const configPath = resolve(__dirname, '..', '..', 'brain.config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`brain:start: cannot read brain.config.json — ${e.message}`);
    process.exit(1);
  }

  const provider = config?.vcs?.provider;
  const project = config?.project?.slug;

  if (!provider || !project) {
    console.error('brain:start: vcs.provider and project.slug must be set in brain.config.json');
    process.exit(1);
  }

  let providerModule;
  try {
    providerModule = await import(`./axes/vcs/adapters/${provider}.mjs`);
  } catch (e) {
    console.error(`brain:start: cannot load provider "${provider}" — ${e.message}`);
    process.exit(1);
  }

  const result = await runStart({
    issueNumber,
    project,
    issueViewFn: (args) => providerModule.issueView(args),
    createBranchFn: gitCreateBranch,
    approvedLabel: resolveApprovedLabel(config, provider),
  });

  if (result.exitCode === 0) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }
  process.exit(result.exitCode);
}
