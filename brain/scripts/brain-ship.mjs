#!/usr/bin/env node
// brain-ship.mjs — Golden-path verb: verify checks then open the PR (REQ-S5-4).
//
// Usage: npm run brain:ship
//   1. Runs brain:check (all 4 governance checks + npm test + repo:check).
//   2. Exits non-zero if any check fails.
//   2. Confirms the head branch is on the remote and equal to local HEAD
//      (headPushedFn, #1207) — otherwise refuses and names the push to run.
//      `ship` NEVER pushes: a push is Tier 2 (agent-authorities.md).
//   3. Reads the linked issue (issueViewFn) and finds its type:* label
//      (issue #334 — the label is no longer hardcoded to 'kind:feature',
//      a label that never existed on this repo's remote).
//   4. Confirms that label exists on the remote (labelPreflightFn) BEFORE
//      any write — the two providers disagree on an unknown label (GitHub
//      hard-errors, GitLab silently creates it), so this is caught here,
//      uniformly, first (design A2).
//   5. Creates a PR via the configured VCS provider's mrCreate() verb:
//        • Title = conventional-commit prefix (from the SAME label, via
//          deriveBranchType) + the branch's slug
//        • Body = PR template + `Closes #<issue>` footer
//        • Labels = the issue's type:* label, VERBATIM — never re-mapped
//   6. Prints the PR URL on success.
//
// Ordering (design A4, issue #334; #1207): checkFn → headPushedFn → issueViewFn →
// findTypeLabel → labelPreflightFn → mrCreateFn — headPushedFn is a local+git check
// (no forge call), so it sits right after the gate and before any forge read; it
// preserves REQ-S5-4's gate semantics and
// the stronger invariant that a red tree makes ZERO remote calls.
//
// The script performs NO action on import — side effects are guarded at the bottom.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseIssueBranch } from './lib/branch-grammar.mjs';
import { deriveBranchType, findTypeLabel } from './lib/branch-type.mjs';
import { labelPreflight } from './vcs/label-preflight.mjs';
import { resolveDefaultBranch } from './lib/local-gate-context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── helpers ───────────────────────────────────────────────────────────────────

function git(args, cwd = process.cwd()) {
  try {
    return execSync(`git ${args}`, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function readTemplate(repoRoot) {
  const tmpl = resolve(repoRoot, '.github/PULL_REQUEST_TEMPLATE.md');
  if (existsSync(tmpl)) return readFileSync(tmpl, 'utf8');
  return '<!-- PR template not found -->';
}

function buildPRBody(template, issueNumber) {
  return `${template.trim()}\n\nCloses #${issueNumber}\n`;
}

/**
 * Is the head branch on the remote and equal to local HEAD? (#1207)
 *
 * Git plumbing only (`ls-remote`, `rev-parse`, `merge-base`) — no forge call, and it
 * never pushes. `gitFn(args) → {ok, out, err}` is injected so the classification is
 * testable without a repository.
 *
 * @returns {Promise<{state: 'in-sync'|'missing'|'behind'|'diverged'|'unknown', error?: string}>}
 */
export async function checkHeadPushed({ branch, gitFn, remote = 'origin' }) {
  const ls = gitFn(['ls-remote', remote, `refs/heads/${branch}`]);
  if (!ls.ok) return { state: 'unknown', error: ls.err || 'git ls-remote failed' };
  const remoteSha = ls.out.split(/\s+/)[0] ?? '';
  if (!remoteSha) return { state: 'missing' };
  const head = gitFn(['rev-parse', 'HEAD']);
  if (!head.ok) return { state: 'unknown', error: head.err || 'git rev-parse HEAD failed' };
  if (remoteSha === head.out) return { state: 'in-sync' };
  // The remote commit is an ancestor of HEAD: a plain push fast-forwards it. Otherwise
  // (or when the object is not even local) the remote holds work this HEAD lacks.
  const behind = gitFn(['merge-base', '--is-ancestor', remoteSha, 'HEAD']);
  return { state: behind.ok ? 'behind' : 'diverged' };
}

function headNotPushedMessage({ state, error }, branch) {
  const head = `brain:ship: the head branch "${branch}" is not on the remote at your HEAD — no PR was opened.\n`;
  if (state === 'missing') {
    return head + `  The branch was never pushed. Run: git push -u origin ${branch}\n  Then re-run brain:ship.`;
  }
  if (state === 'behind') {
    return head + `  The remote branch is behind your HEAD. Run: git push origin ${branch}\n  Then re-run brain:ship.`;
  }
  if (state === 'diverged') {
    return head + `  The remote branch has commits that are not in your local history (it diverged).\n` +
      `  Fetch and integrate them, then push; brain:ship will not push or force for you.`;
  }
  return head + `  Could not read the remote branch${error ? `: ${error}` : ''}.\n  Check the remote is reachable, then re-run brain:ship.`;
}

export function titleFromBranch(branch, type) {
  // e.g. feature/42-add-cli-i18n + 'feat' → "feat: add cli i18n" — conventional
  // commit format (.github/PULL_REQUEST_TEMPLATE.md:73 requires it; the
  // `type` prefix is derived from the issue's type:* label via
  // deriveBranchType, independently of the label sent to mrCreateFn).
  const slug = (parseIssueBranch(branch)?.slug || branch)
    .replace(/-/g, ' ')
    .trim() || branch;
  return `${type}: ${slug}`;
}

/**
 * Resolves the issue number encoded in the branch name
 * (`<type>/issue-<number>-<slug>` from `brain:ticket:start`, or the legacy
 * `<prefix>/<number>-<slug>` from `brain:start`) via the shared parser.
 *
 * FAILS CLOSED rather than falling back to a placeholder: a silent `'0'`
 * fallback produced a PR whose body said `Closes #0` and whose issue lookup
 * queried a non-existent issue — a fabricated answer to an uncomputable
 * question. An unparseable branch is a real, actionable operator error, so it
 * is reported as one.
 *
 * @param {string} branch
 * @returns {{ issueNumber: string } | { exitCode: 1, message: string }}
 */
export function resolveIssueNumber(branch) {
  const parsed = parseIssueBranch(branch);
  if (!parsed) {
    return {
      exitCode: 1,
      message:
        `brain:ship: cannot determine issue number from branch "${branch}" — ` +
        `expected <type>/issue-<number>-<slug> (e.g. fix/issue-42-add-cli-i18n) or ` +
        `the legacy <prefix>/<number>-<slug> (e.g. feature/42-add-cli-i18n). ` +
        `Run "npm run brain:ticket:start -- <id>" to create a correctly-named branch.`,
    };
  }
  return { issueNumber: parsed.issueNumber };
}

// ── core logic (injectable for tests) ────────────────────────────────────────

/**
 * Run the brain:ship flow.
 *
 * Ordering (design A4, #1207): checkFn → headPushedFn → issueViewFn → findTypeLabel →
 * labelPreflightFn → mrCreateFn. A red checkFn makes ZERO remote calls.
 *
 * @param {object} ctx
 * @param {string}   ctx.issueNumber      Issue number (string).
 * @param {string}   ctx.project          VCS project slug.
 * @param {string}   ctx.provider         VCS provider name (passed to labelPreflightFn's default dispatch).
 * @param {string}   ctx.branchName       Current git branch.
 * @param {string}   ctx.base             Target base branch (default: 'main').
 * @param {Function} ctx.checkFn          Async fn() → {ok, output?}. Injected for tests.
 * @param {Function} ctx.headPushedFn     Async fn({branch}) → {state:'in-sync'|'missing'|'behind'|'diverged'|'unknown', error?}.
 *   Git plumbing, no forge call. Anything but 'in-sync' refuses before any forge call (#1207).
 * @param {Function} ctx.issueViewFn      Async fn({project,number}) → {number,title,labels,body,author}.
 *   REJECTS on an unreachable issue (design A5) — matches the real providers, do not stub with `null`.
 * @param {Function} ctx.labelPreflightFn Async fn({provider,project,label}) → {exists,error?}. Never throws.
 * @param {Function} ctx.mrCreateFn       Async fn({title,body,head,base,labels}) → {url,error?}.
 * @returns {Promise<{exitCode:number, message:string, url?:string}>}
 */
export async function runShip({
  issueNumber,
  project,
  provider,
  branchName,
  base = 'main',
  checkFn,
  headPushedFn,
  issueViewFn,
  labelPreflightFn,
  mrCreateFn,
  template = '',
}) {
  // Step 1: run all checks — a red tree makes ZERO remote calls (design A4).
  const checkResult = await checkFn();
  if (!checkResult.ok) {
    return {
      exitCode: 1,
      message:
        `brain:ship: checks failed — fix them before shipping.\n` +
        `  Run "npm run brain:check" for details.\n` +
        (checkResult.output ? `  Output: ${checkResult.output}` : ''),
    };
  }

  // Step 1b (#1207): the head must be on the remote at local HEAD. Refuses instead of
  // letting mrCreate surface a raw provider error; never pushes (Tier 2).
  const pushed = await headPushedFn({ branch: branchName });
  if (pushed.state !== 'in-sync') {
    return { exitCode: 1, message: headNotPushedMessage(pushed, branchName) };
  }

  // Step 2: read the linked issue — the single source of truth for the PR label.
  let issue;
  try {
    issue = await issueViewFn({ project, number: Number(issueNumber) });
  } catch (e) {
    return {
      exitCode: 1,
      message: `brain:ship: issue #${issueNumber} not found or not accessible — ${e.message}`,
    };
  }

  // Step 3: find the issue's type:* label — fail closed if none exists.
  const labels = issue.labels ?? [];
  const typeLabel = findTypeLabel(labels);
  if (!typeLabel) {
    return {
      exitCode: 1,
      message:
        `brain:ship: no type:* label found on issue #${issueNumber}.\n` +
        `  Labels found: [${labels.join(', ')}]\n` +
        `  Add a type:* label before shipping.`,
    };
  }

  // Step 4: confirm the label exists on the remote BEFORE any write (design
  // A2 — GitHub hard-errors on an unknown label, GitLab silently creates it).
  const preflight = await labelPreflightFn({ provider, project, label: typeLabel });
  if (!preflight.exists) {
    return {
      exitCode: 1,
      message:
        `brain:ship: label "${typeLabel}" not found in the remote label set — ` +
        `add it on the remote, or correct issue #${issueNumber}'s type:* label` +
        (preflight.error ? ` — ${preflight.error}` : ''),
    };
  }

  // Step 5: build PR body + title. The label travels VERBATIM to mrCreateFn;
  // deriveBranchType maps the SAME label to the title's conventional-commit
  // prefix only — the two derivations are independent.
  const body = buildPRBody(template, issueNumber);
  const title = titleFromBranch(branchName, deriveBranchType([typeLabel]));

  // Step 6: create PR
  const mrResult = await mrCreateFn({
    title,
    body,
    head: branchName,
    base,
    labels: [typeLabel],
  });

  if (!mrResult.url) {
    return {
      exitCode: 1,
      message: `brain:ship: PR creation failed — ${mrResult.error ?? 'unknown error'}`,
    };
  }

  return {
    exitCode: 0,
    url: mrResult.url,
    message: `brain:ship: PR opened → ${mrResult.url}`,
  };
}

// ── CLI entry-point ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cwd = process.cwd();
  const repoRoot = resolve(__dirname, '..', '..');

  // Read config
  let config;
  try {
    config = JSON.parse(readFileSync(resolve(repoRoot, 'brain.config.json'), 'utf8'));
  } catch (e) {
    console.error(`brain:ship: cannot read brain.config.json — ${e.message}`);
    process.exit(1);
  }

  const provider = config?.vcs?.provider;
  const project = config?.project?.slug;
  if (!provider || !project) {
    console.error('brain:ship: vcs.provider and project.slug must be set in brain.config.json');
    process.exit(1);
  }

  let providerModule;
  try {
    providerModule = await import(`./axes/vcs/adapters/${provider}.mjs`);
  } catch (e) {
    console.error(`brain:ship: cannot load provider "${provider}" — ${e.message}`);
    process.exit(1);
  }

  const branch = git('rev-parse --abbrev-ref HEAD', cwd);
  if (!branch || branch === 'HEAD') {
    console.error('brain:ship: not on a named branch — run brain:ticket:start first');
    process.exit(1);
  }

  // Extract issue number from branch name (feature/<number>-<slug>) — fails
  // closed on an unparseable branch rather than fabricating a placeholder.
  const resolved = resolveIssueNumber(branch);
  if (resolved.exitCode) {
    console.error(resolved.message);
    process.exit(resolved.exitCode);
  }
  const { issueNumber } = resolved;

  const template = readTemplate(repoRoot);

  const result = await runShip({
    issueNumber,
    project,
    provider,
    branchName: branch,
    // The PR's base is the remote's default branch, resolved the way brain:check resolves
    // it (#1186) — `'main'` is only the last resort, for a remote that cannot be asked.
    base: config?.project?.defaultBranch ?? resolveDefaultBranch({ cwd }) ?? 'main',
    template,
    checkFn: async () => {
      const r = spawnSync('npm', ['run', 'brain:check'], { encoding: 'utf8', cwd, stdio: 'inherit' });
      return { ok: r.status === 0 };
    },
    headPushedFn: ({ branch: b }) => checkHeadPushed({
      branch: b,
      gitFn: (args) => {
        const r = spawnSync('git', args, { encoding: 'utf8', cwd });
        return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
      },
    }),
    issueViewFn: (args) => providerModule.issueView(args),
    labelPreflightFn: (args) => labelPreflight(args),
    mrCreateFn: (args) => providerModule.mrCreate({ project, ...args }),
  });

  if (result.exitCode === 0) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }
  process.exit(result.exitCode);
}
