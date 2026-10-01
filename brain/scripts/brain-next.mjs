#!/usr/bin/env node
// brain-next.mjs — Golden-path state machine (REQ-S5-5, issue #890).
// Durable capture is proven by issue provenance in records; feature-branch
// porcelain .memory/ state is deliberately not an input.

import { execSync, spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecordObservations } from './memory/lib/store.mjs';
import { findIssueInBranch } from './lib/branch-grammar.mjs';
import { loadBrainConfigOrThrow } from './lib/brain-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NON_WORKING_BRANCHES = /^(main|master|dev|develop|release\/.*)$/;

function isFeatureBranch(branch) {
  if (!branch || branch === 'HEAD') return false;
  return !NON_WORKING_BRANCHES.test(branch);
}

/** Extract the issue provenance encoded by the branch convention (shared parser, #697). */
export function issueFromBranch(branch) {
  const found = findIssueInBranch(branch);
  return found === null ? undefined : Number(found);
}

function hasIssueRecord(records, issue) {
  return Array.isArray(records) && issue !== undefined && records.some((record) => Number(record?.issue) === issue);
}

/**
 * Derive one next action from branch, VCS PRs, checks, issue-scoped records,
 * and lane configuration. `memoryStatusFn` is intentionally ignored for
 * compatibility with older callers; no porcelain `.memory/` read is made.
 */
export async function deriveNext({
  branch,
  openPRsFn,
  recordsFn = async () => [],
  repoCheckFn,
  config = {},
}) {
  if (!isFeatureBranch(branch)) {
    return { state: 'no-branch', nextCommand: 'brain:start <issue>  — pick an approved issue and start work' };
  }

  const openPRs = await openPRsFn();
  const matchingPR = openPRs.find((pr) => pr.headBranch === branch);
  if (matchingPR) {
    return {
      state: 'open-pr',
      nextCommand: `PR #${matchingPR.number} is open ("${matchingPR.title}"). Monitor CI, address reviews, and wait for merge.`,
    };
  }

  const checkResult = await repoCheckFn();
  if (!checkResult.ok) {
    return { state: 'checks-failing', nextCommand: 'brain:check  — one or more governance checks are failing; fix them first' };
  }

  const issue = issueFromBranch(branch);
  const records = await recordsFn();
  if (issue !== undefined && !hasIssueRecord(records, issue)) {
    return { state: 'needs-memory', nextCommand: `brain:memory:save --issue ${issue}  — capture durable memory before shipping` };
  }

  const laneEnabled = config?.memory?.lane?.enabled === true;
  const laneText = laneEnabled ? 'the enabled memory lane will deliver records' : 'capture is recorded; the memory lane is not enabled';
  return { state: 'ready', nextCommand: `brain:ship  — checks pass; ${laneText}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cwd = process.cwd();
  let branch = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { /* not a git repo */ }

  const repoRoot = resolve(__dirname, '..', '..');
  let providerModule = null;
  let config = {};
  try {
    config = loadBrainConfigOrThrow(repoRoot);
    const provider = config?.vcs?.provider;
    const project = config?.project?.slug;
    if (provider && project) {
      providerModule = await import(`./axes/vcs/adapters/${provider}.mjs`);
      providerModule._project = project;
    }
  } catch { /* best-effort */ }

  const result = await deriveNext({
    branch,
    openPRsFn: async () => {
      if (!providerModule) return [];
      try { return await providerModule.mrList({ project: providerModule._project, state: 'open' }); } catch { return []; }
    },
    recordsFn: async () => readRecordObservations({ recordsDir: resolve(cwd, '.memory', 'records') }),
    repoCheckFn: async () => {
      const r = spawnSync('node', ['brain/scripts/check-refs.mjs'], { encoding: 'utf8', cwd });
      return { ok: r.status === 0 };
    },
    config,
  });

  console.log(`\nbrain:next  [${result.state}]`);
  console.log(`  → ${result.nextCommand}`);
  console.log('');
}
