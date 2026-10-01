#!/usr/bin/env node
// ticket-start.mjs — Take an issue and create the working branch.
// Provider-agnostic: fetches the issue and the base branch through the VCS
// adapter (scripts/vcs/cli.mjs), so it works with GitHub, GitLab, or any host
// configured via vcs.provider in brain.config.json.
//
// Usage: npm run brain:ticket:start -- <id>                 (in-place checkout from main)
//        npm run brain:ticket:start -- <id> --worktree      (isolated worktree from main)
//        npm run brain:ticket:start -- <id> --base <branch> (different base, e.g. a story tracker)
//        npm run brain:ticket:start -- <id> --off-tracker   (start from main although the epic declares a tracker)
//        node brain/scripts/ticket-start.mjs <id> [--worktree] [--base <branch>] [--off-tracker]
//
// With no --base the base is READ FROM THE EPIC (#967): the issue's `parent`,
// that node's declared `tracker`. The run always says which base it took and why.
// Deprecated alias: npm run ticket:start (same target)

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadBrainConfig } from './lib/brain-config.mjs';
import { deriveBranchType } from './lib/branch-type.mjs';
import { composeIssueBranch } from './lib/branch-grammar.mjs';
import { getVcs, resolveProviderName } from './vcs/cli.mjs';
import { originIdentity } from './vcs/lib/repo.mjs';
import { vcsToken, readEnvVar } from './vcs/lib/token.mjs';
import { detectPM } from './lib/pm.mjs';
import { t } from './i18n/t.mjs';
import { tryFeatureResume } from './memory/lib/auto-resume.mjs';
import { parseTicketArgs } from './lib/ticket-args.mjs';
import { resolveBase } from './lib/ticket-base.mjs';
import { requireTypeLabel } from './lib/ticket-type.mjs';
import { worktreeAddArgs, inPlaceCheckoutArgs } from './lib/ticket-branch.mjs';
import { evaluateFreshness } from './lib/checkout-freshness.mjs';

const ROOT = process.cwd();
const PM = detectPM(ROOT).name;

// THE PARSE LIVES IN A LEAF (#782), so the DEFAULT can be tested without a repo,
// a network or a git process. It defaulted to a branch in the main checkout —
// the thing `harness-contract.md:28` calls NEVER — and nothing could ask it what
// it did with no flags without running the whole verb.
const argv = process.argv.slice(2);
const parsed = parseTicketArgs(argv);
if (!parsed.ok) {
  if (parsed.error === 'base-requires-arg') {
    console.error(`  ${await t('ticket.error.baseRequiresArg')}`);
    process.exit(1);
  }
  if (parsed.error === 'contradictory-modes') {
    console.error(`  ${await t('ticket.error.contradictoryModes')}`);
    process.exit(1);
  }
  console.error(await t('ticket.error.usage'));
  console.error(await t('ticket.error.usageExample1'));
  console.error(await t('ticket.error.usageExample2'));
  process.exit(1);
}
const { id, useWorktree } = parsed;

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, stdio: 'pipe', ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};

// ── Resolve the VCS provider + repo identity ──────────────────────────────────
const { host, project } = originIdentity();
if (!project) {
  console.error(`  ${await t('ticket.error.noRemote')}`);
  process.exit(1);
}

let vcsProvider;
let vcs;
try {
  const config = loadBrainConfig();
  vcsProvider = resolveProviderName({ config });
  vcs = await getVcs({ config });
} catch (e) {
  console.error(`  ${await t('ticket.error.vcsInit', { message: e.message })}`);
  process.exit(1);
}

const token = vcsToken(vcsProvider, ROOT);
if (!token) {
  console.error(`  ${await t('ticket.error.tokenNotFound')}`);
  process.exit(1);
}

// Propagate NO_PROXY from .env so Go binaries (gh/glab) bypass the internal proxy.
const noProxy = readEnvVar('NO_PROXY', ROOT) ?? readEnvVar('no_proxy', ROOT);
if (noProxy) {
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
}

// ── Fetch the issue through the adapter ───────────────────────────────────────
console.log(`\n  ${await t('ticket.fetching', { id })}`);
let issue;
try {
  issue = await vcs.issueView({ project, number: id });
} catch (e) {
  console.error(`  ${await t('ticket.error.fetchFailed', { id, message: e.message })}`);
  process.exit(1);
}
if (!issue?.number) {
  console.error(`  ${await t('ticket.error.notFound', { id, project })}`);
  process.exit(1);
}

// ── Does the issue carry a type:* label? (#1206) ──────────────────────────────
// `brain:ship` refuses an untyped issue at the LAST step. Said here, it is a
// one-line fix before any work; said there, it is a surprise after the work. Same
// `findTypeLabel` as `ship` (via the leaf), and before a branch or worktree exists.
const typed = requireTypeLabel({ issue });
if (!typed.ok) {
  console.error(`  ${await t(typed.refusal.key, typed.refusal.params)}`);
  process.exit(1);
}

// ── Which branch does this slice start from? (#967) ───────────────────────────
// THE DECISION IS NOT HERE. `resolveBase` is a pure leaf with the reader
// injected, so every row of it — the tracker, the three reasons there is none,
// the fail-open on an unreadable epic, the one refusal — is tested without a
// repository or a forge (`lib/ticket-base.test.mjs`). What is left here is a
// print and an exit, before any git work: a refusal creates nothing.
const resolved = await resolveBase({
  issue,
  args: parsed,
  fetchIssue: (number) => vcs.issueView({ project, number: String(number) }),
});
if (!resolved.ok) {
  console.error(`  ${await t(resolved.refusal.key, resolved.refusal.params)}`);
  process.exit(1);
}
const baseBranch = resolved.base;
// `say` is null only on an explicit `--base <other>` — the path that predates
// this change and stays byte-identical, message included.
if (resolved.say) console.log(`\n  ${await t(resolved.say.key, resolved.say.params)}`);

// ── Determine the branch type from labels ─────────────────────────────────────
// deriveBranchType strips the `type:` namespace before mapping (#101).
const labels = issue.labels ?? [];
const branchType = deriveBranchType(labels);

// ── Build the slug from the title ─────────────────────────────────────────────
const branchName = composeIssueBranch({ type: branchType, number: issue.number, title: issue.title });

// ── Show the issue context ────────────────────────────────────────────────────
console.log('');
console.log(`  #${issue.number}  ${issue.title}`);
if (labels.length > 0) console.log(`  ${await t('ticket.labels', { labels: labels.join(', ') })}`);
if (issue.body?.trim()) {
  const preview = issue.body.trim().split('\n').slice(0, 6).join('\n');
  console.log('\n' + preview.split('\n').map(l => `  ${l}`).join('\n'));
}
console.log(`\n  \x1b[1m${await t('ticket.branch', { branch: branchName })}\x1b[0m`);

// ── Update the base branch ────────────────────────────────────────────────────
console.log(`\n  ${await t('ticket.updatingBase', { base: baseBranch })}`);
const authenticatedRemote = await vcs.repoCloneUrl({ host, project, token });
const fetchRes = spawnSync('git',
  ['fetch', authenticatedRemote, `${baseBranch}:refs/remotes/origin/${baseBranch}`],
  { cwd: ROOT, encoding: 'utf8' });
if (fetchRes.status !== 0) {
  console.error(`  ${await t('ticket.error.fetchBase', { branch: baseBranch })}`);
  console.error(await t('ticket.error.fetchBaseHint'));
  process.exit(1);
}
const startPoint = `origin/${baseBranch}`;

// ── Is the checkout we are RUNNING FROM behind what we just fetched? (#787) ──
// The fetch above refreshed the START POINT. It did not refresh this checkout,
// and the copy of this file Node already loaded is whatever `ROOT` had. A run
// from a stale checkout executes old behaviour and creates a branch from new
// content — measured 2026-08-28, when that produced an in-place branch hours
// after #784 made the worktree the default.
//
// IT WARNS, IT DOES NOT REFUSE. Slice 2 of #782 catches the consequence: a
// commit on an in-place branch in the main checkout is refused by
// `hooks/pre-commit`. A wrong warning is noise; a wrong refusal is a stopped
// session.
const headSha = sh('git', ['rev-parse', '--short', 'HEAD']);
const baseSha = sh('git', ['rev-parse', '--short', startPoint]);
const scriptsDiff = sh('git', ['diff', '--quiet', 'HEAD', startPoint, '--', 'brain/scripts/']);
const ancestor = sh('git', ['merge-base', '--is-ancestor', 'HEAD', startPoint]);
const freshness = evaluateFreshness({
  headSha: headSha.ok ? headSha.out : null,
  baseSha: baseSha.ok ? baseSha.out : null,
  // `git diff --quiet` exits 1 when there IS a difference, so `!ok` is "differ".
  // Both reads are guarded: a git call that did not answer leaves the fact null
  // and `evaluateFreshness` returns fresh rather than inventing a verdict.
  scriptsDiffer: headSha.ok && baseSha.ok ? !scriptsDiff.ok : null,
  headIsAncestor: headSha.ok && baseSha.ok ? ancestor.ok : null,
});
if (freshness.stale) {
  console.log(`\n  ${await t('ticket.staleCheckout', {
    head: freshness.headSha, base: freshness.baseSha, branch: baseBranch,
  })}`);
  console.log(`  ${await t('ticket.staleCheckoutHint', { root: ROOT, branch: baseBranch })}`);
}

// ── Create the branch ─────────────────────────────────────────────────────────
// Two modes: in-place (checkout on the current working tree) or an isolated
// worktree (sibling folder with its own branch, for parallel work without clashes).
const branchExists = sh('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]).ok;
let worktreePath = null;

if (useWorktree) {
  worktreePath = join(dirname(ROOT), `${basename(ROOT)}-issue-${id}`);

  if (existsSync(worktreePath)) {
    console.error(`  ${await t('ticket.error.worktreeExists', { path: worktreePath })}`);
    console.error(await t('ticket.error.worktreeExistsHint'));
    process.exit(1);
  }

  // If the branch already exists, attach it to the worktree; otherwise create it
  // from the base — `--no-track`, so the new branch does not inherit
  // `origin/<base>` as its upstream (#785). See `lib/ticket-branch.mjs` for what
  // that inheritance made git suggest.
  const wt = sh('git', worktreeAddArgs({ worktreePath, branchName, startPoint, branchExists }));
  if (!wt.ok) {
    console.error(`  ${await t('ticket.error.worktreeCreate', { error: wt.err })}`);
    process.exit(1);
  }
  console.log(`  ${await t('ticket.worktreeCreated', { path: worktreePath })}`);

  // Auto-resume: when attaching to an existing branch, surface the feature context.
  // tryFeatureResume is fully isolated — any failure returns null, never throws.
  if (branchExists) {
    const resumeOutput = tryFeatureResume(worktreePath);
    if (resumeOutput != null) {
      console.log(resumeOutput);
    } else {
      console.log(`  ${await t('ticket.resume.noContext')}`);
    }
  }

  // Gotcha: the worktree does NOT inherit untracked/ignored files like .env (which
  // holds the VCS token, needed by this script and the adapter). Copy it over.
  const srcEnv = join(ROOT, '.env');
  if (existsSync(srcEnv)) {
    copyFileSync(srcEnv, join(worktreePath, '.env'));
    console.log(`  ${await t('ticket.envCopied')}`);
  } else {
    console.log(`  ${await t('ticket.noEnv', { root: ROOT })}`);
  }
} else {
  const create = sh('git', inPlaceCheckoutArgs({ branchName, startPoint }));
  if (!create.ok) {
    if (branchExists || create.err.includes('already exists')) {
      console.log(`  ${await t('ticket.branchExists')}`);
      spawnSync('git', ['checkout', branchName], { stdio: 'inherit', cwd: ROOT });
      // Auto-resume: surface feature context when re-checking out an existing branch.
      // tryFeatureResume is fully isolated — any failure returns null, never throws.
      const resumeOutput = tryFeatureResume(ROOT);
      if (resumeOutput != null) {
        console.log(resumeOutput);
      } else {
        console.log(`  ${await t('ticket.resume.noContext')}`);
      }
    } else {
      console.error(`  ${await t('ticket.error.branchCreate', { error: create.err })}`);
      process.exit(1);
    }
  } else {
    console.log(`  ${await t('ticket.branchCreated')}`);
  }
}

// ── Next steps ────────────────────────────────────────────────────────────────
// THE MODE IS SAID OUT LOUD (#782 acceptance 4). In-place is allowed for
// strictly solo, serial work — and an operator who lands there without choosing
// it is exactly the failure this ticket is about, so the run names which one it
// took rather than leaving it to be inferred from whether a path was printed.
console.log(`  ${await t(useWorktree ? 'ticket.mode.worktree' : 'ticket.mode.inPlace')}`);

const cdStep = useWorktree
  ? `\n${await t('ticket.nextSteps.cd', { path: worktreePath })}`
  : '';
console.log(`
  ${await t('ticket.nextSteps.header')}${cdStep}
${await t('ticket.nextSteps.step1', { id })}
${await t('ticket.nextSteps.step2', { pm: PM })}
${await t('ticket.nextSteps.step3', { pm: PM })}
${await t('ticket.nextSteps.step4', { branch: branchName })}
`);
