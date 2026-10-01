#!/usr/bin/env node
// day-start.mjs — Daily startup sequence: VCS auth → updates → memory → board.
// Usage: npm run brain:day:start  (deprecated alias: npm run day:start)
//
// For humans: run this at the start of the workday, on any branch.
// For AI agents: run this when resuming a session — sets context before working.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadBrainConfig } from './lib/brain-config.mjs';
import { highestVersion, readInstalledVersion, compareSemver, PACKAGE_NAME } from './lib/installer.mjs';
import { getVcs, resolveProviderName } from './vcs/cli.mjs';
import { originIdentity } from './vcs/lib/repo.mjs';
import { vcsToken } from './vcs/lib/token.mjs';
import { detectPM } from './lib/pm.mjs';
import { t } from './i18n/t.mjs';
import { currentBranch } from './lib/git-branch.mjs';
import { agentRuntimeReport, platformEnvVars, platformConfig } from './axes/lib/agent-runtime.mjs';
import { readEnv } from './lib/env-read.mjs';
import { laneSweepEnabled, runLaneSweep, laneSweepLine, laneSweepBranchLines } from './memory/day-start-sweep.mjs';

const ROOT = process.cwd();
const NODE = process.execPath;
const TOTAL = 6;
let step = 0;

const config = loadBrainConfig();
const { host: VCS_HOST, project: VCS_PROJECT } = originIdentity();
const PM = detectPM(ROOT).name;
let vcsProvider = null;
let vcs = null;
try {
  vcsProvider = resolveProviderName({ config });
  vcs = await getVcs({ config });
} catch { /* provider not configured — the VCS steps degrade with a warning */ }

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
  red:    '\x1b[31m',
  bCyan:  '\x1b[1;36m',
  bGreen: '\x1b[1;32m',
};

const ok   = (msg) => console.log(`  ${C.green}✓${C.reset} ${msg}`);
const warn = (msg) => console.warn(`  ${C.yellow}⚠${C.reset} ${msg}`);
const info = (msg) => console.log(`  ${C.blue}ℹ${C.reset}  ${msg}`);

const sep = (label) => {
  step++;
  const tag = `${step}/${TOTAL}  ${label}`;
  const pad = '─'.repeat(Math.max(0, 58 - tag.length));
  console.log(`\n${C.bCyan}── ${tag} ${pad}${C.reset}`);
};

const run = async (cmd, args = [], opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) {
    const signal = await t('common.signal');
    console.warn(`  ${await t('day.run.exitCode', { code: r.status ?? signal })}`);
  }
};

const capture = (cmd, args = []) =>
  spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', cwd: ROOT });

// One reader, one precedence — the shell wins (#316). This was a byte-for-byte
// copy of `vcs/lib/token.mjs`'s reader, file-first, with `startsWith("KEY=")`
// matching a prefix instead of a key.
const readEnvVar = (key) => readEnv(key, { root: ROOT });

// Propagate NO_PROXY from .env so Go binaries (gh/glab) bypass the internal proxy.
const noProxy = readEnvVar('NO_PROXY') ?? readEnvVar('no_proxy');
if (noProxy) {
  process.env.NO_PROXY = noProxy;
  process.env.no_proxy = noProxy;
}

// ── 1. VCS authentication ────────────────────────────────────────────────────
sep(await t('day.vcs.section'));
if (!vcs) {
  info(await t('day.vcs.notConfigured'));
} else {
  let authed = false;
  try { authed = await vcs.authCheck({ host: VCS_HOST }); } catch { authed = false; }
  if (authed) {
    try {
      const { username } = await vcs.whoami();
      ok(await t('day.auth.ok', { user: username, provider: vcsProvider }));
    } catch {
      ok(await t('day.vcs.authOk', { provider: vcsProvider }));
    }
  } else {
    console.log(`  ${await t('day.vcs.sessionExpired')}`);
    const token = vcsToken(vcsProvider, ROOT);
    if (!token) {
      warn(await t('day.vcs.tokenNotFound'));
    } else {
      let loggedIn = false;
      try { loggedIn = await vcs.authLogin({ host: VCS_HOST, token }); } catch { loggedIn = false; }
      if (loggedIn) {
        ok(await t('day.vcs.authOk', { provider: vcsProvider }));
      } else {
        warn(await t('day.vcs.authFailed'));
      }
    }
  }
}

// ── 2. Main sync ─────────────────────────────────────────────────────────────
sep(await t('day.main.section'));
{
  // Capture the local branch BEFORE fetch/merge — this is the correct reference
  // to detect what arrived new, regardless of whether origin/main was already
  // updated in the local tracking ref.
  const prevLocal = capture('git', ['rev-parse', 'main']).stdout.trim();
  const token = vcs ? vcsToken(vcsProvider, ROOT) : null;

  if (!vcs || !token || !VCS_PROJECT || !VCS_HOST) {
    warn(await t('day.main.noVcs'));
  } else {
    const authRemote = await vcs.repoCloneUrl({ host: VCS_HOST, project: VCS_PROJECT, token });
    const fetchResult = capture('git', ['fetch', authRemote, 'main:refs/remotes/origin/main']);

    if (fetchResult.status !== 0) {
      warn(await t('day.main.fetchFailed', { host: VCS_HOST }));
    } else {
      const newMain = capture('git', ['rev-parse', 'refs/remotes/origin/main']).stdout.trim();
      const activeBranch = currentBranch(ROOT);

      if (activeBranch === 'main') {
        let merge = capture('git', ['merge', '--ff-only', 'refs/remotes/origin/main']);
        if (merge.status !== 0) {
          // If the merge fails due to generated files that would be overwritten, restore them and retry.
          const wouldOverwrite = /serán sobrescritos al fusionar|would be overwritten by merge/;
          if (wouldOverwrite.test(merge.stderr)) {
            const blocked = merge.stderr.split('\n')
              .filter(l => /^\s+\S/.test(l) && !/Por favor|Please|confirma|commit or stash/.test(l))
              .map(l => l.trim()).filter(Boolean);
            for (const f of blocked) capture('git', ['restore', f]);
            merge = capture('git', ['merge', '--ff-only', 'refs/remotes/origin/main']);
          }
        }
        if (merge.status === 0) {
          ok(await t('day.main.updated'));
        } else {
          warn(await t('day.main.pullFailed'));
        }
      } else {
        ok(await t('day.main.remoteUpdated', { branch: activeBranch ?? 'unknown' }));
      }

      if (prevLocal && prevLocal !== newMain) {
        const log = capture('git', [
          'log', '--no-merges',
          '--pretty=format:%H\x1f%h\x1f%aN\x1f%s',
          `${prevLocal}..refs/remotes/origin/main`,
        ]);
        const commits = log.stdout.trim().split('\n').filter(Boolean)
          .map(l => { const [sha, short, author, subject] = l.split('\x1f'); return { sha, short, author, subject }; });

        if (commits.length > 0) {
          // CI status per commit via the VCS adapter (normalized enum).
          const badge = (status) => {
            switch (status) {
              case 'success':  return `${C.green}✓${C.reset}`;
              case 'failed':   return `${C.red}✗${C.reset}`;
              case 'running':
              case 'pending':  return `${C.yellow}~${C.reset}`;
              case 'canceled': return `${C.dim}–${C.reset}`;
              default:         return `${C.dim}·${C.reset}`;
            }
          };

          console.log(`\n  ${C.bold}${await t('day.main.newCommits', { count: commits.length })}${C.reset}\n`);
          for (const { sha, short, author, subject } of commits) {
            let status = null;
            try { status = await vcs.commitStatus({ project: VCS_PROJECT, sha }); } catch { status = null; }
            console.log(`    [${badge(status)}] ${C.dim}${short}${C.reset}  ${C.cyan}${author}${C.reset} — ${subject}`);
          }
          console.log('');
        }
      } else {
        ok(await t('day.main.upToDate'));
      }
    }
  }
}

// ── 3. Ecosystem updates ─────────────────────────────────────────────────────
sep(await t('day.ecosystem.section'));
const gaCheck = capture('gentle-ai', ['--version']);
if (gaCheck.status !== 0) {
  info(await t('day.ecosystem.notAvailable'));
  console.log(`       ${await t('day.ecosystem.install')}`);
} else {
  console.log(`  ${C.dim}${await t('day.ecosystem.checking')}${C.reset}`);
  const check = capture('gentle-ai', ['update']);
  if (check.status === 0) {
    const updates = (check.stdout ?? '')
      .split('\n')
      .filter(l => l.includes('[UP]'));

    if (updates.length === 0) {
      ok(await t('day.ecosystem.allUpToDate'));
    } else {
      console.log(`  ${C.yellow}${await t('day.ecosystem.updatesAvailable', { count: updates.length })}${C.reset}\n`);
      for (const line of updates) {
        const m = line.match(/\[UP\]\s+(\S+)\s+installed:\s+(\S+)\s+latest:\s+(\S+)/);
        if (m) {
          console.log(`    ${C.cyan}%-20s${C.reset}  ${C.dim}%s${C.reset} → ${C.green}%s${C.reset}`, m[1], m[2], m[3]);
        } else {
          console.log(`   ${line.trim()}`);
        }
      }
      console.log(`\n  ${await t('day.ecosystem.applying')}`);
      await run('gentle-ai', ['upgrade']);
      ok(await t('day.ecosystem.done'));
    }
  }
  capture('gentle-ai', ['skill-registry', 'refresh']);
  ok(await t('day.ecosystem.skillRegistry'));
}

// ── 4. brain (core) version ──────────────────────────────────────────────────
// Check-and-notify: detects if there is a new core version and WARNS. Does NOT
// auto-update — respects brain/core/anti-patterns/instaladores-autoactualizantes-no-inocuos.md.
// Upgrade is always a conscious decision.
//
// THE SOURCE IS THE REGISTRY (ADR-0030, issue #627). This asked
// `git ls-remote --tags` against a hardcoded github.com URL, which was the
// authoritative answer under ADR-0006 — there, the tag WAS the artifact. Under
// ADR-0030 the version a consumer can install is what the registry publishes,
// and the two sets differ: a tag can exist unpublished, and a published version
// can be deprecated while its tag remains.
//
// Check-and-notify itself is NOT superseded — ADR-0006 Amendment 1 lists it
// under "what is NOT superseded", and notes a registry makes auto-update easier
// to reach for, which makes the anti-pattern MORE load-bearing here, not less.
// What changed is which source is asked and what is recommended.
//
// Three outcomes, never collapsed into two: up to date, a new version, or
// COULD NOT CHECK — each said in its own words. The old code reported an
// unreachable host as "no network", which is the wrong problem to hand someone
// whose registry is a mirror they can reach perfectly well.
sep(await t('day.brain.section'));
{
  const installed = readInstalledVersion(ROOT);
  if (!installed) {
    info(await t('day.brain.unknownInstalled'));
  } else {
    // `npm view` rather than a hand-rolled fetch: it honours the consumer's own
    // registry, scope mapping, proxy and auth from their .npmrc. A mirrored or
    // air-gapped consumer is a supported configuration, and asking npm is how
    // this check inherits their configuration instead of contradicting it.
    const view = capture('npm', ['view', PACKAGE_NAME, 'versions', '--json']);
    if (view.status !== 0) {
      info(await t('day.brain.registryUnreachable', { pkg: PACKAGE_NAME }));
    } else {
      let versions = null;
      try {
        const parsed = JSON.parse(view.stdout);
        // npm prints a bare string when exactly one version exists.
        versions = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        versions = null;
      }
      // `highestVersion` excludes prereleases BY RULE (#644): `compareSemver`
      // reads only major.minor.patch, so an rc compares equal to its release and
      // a plain sort would return whichever the registry happened to list last.
      // This path must never tell an operator to install an rc.
      const latest = versions === null ? null : highestVersion(versions);
      if (!latest) {
        info(await t('day.brain.notPublished', { pkg: PACKAGE_NAME }));
      } else if (compareSemver(latest, installed) > 0) {
        warn(await t('day.brain.newVersion', { installed, latest }));
        console.log(`       ${await t('day.brain.upgrade', { latest, pm: PM })}`);
        console.log(`       ${C.dim}${await t('day.brain.noAutoApply')}${C.reset}`);
      } else {
        ok(await t('day.brain.upToDate', { installed }));
      }
    }
  }
}

// ── 4b. AI agent runtime — a sub-step of the version block above ─────────────
// Check-and-notify, mirroring the brain-tag check above (ADR-0006 and
// brain/core/anti-patterns/instaladores-autoactualizantes-no-inocuos.md): this
// NEVER runs an update command.
//
// Harness-agnostic by construction (ADR-0005): it asks whichever platform the
// repo declares (AGENT_PLATFORM / SDD_HARNESS / brain.config.json's optional
// `harness` — the ADR-0024 axes, resolved by harness/cli.mjs's resolvePlatform,
// which this entrypoint used to bypass) for its own AGENT_RUNTIME descriptor.
// Nothing here names a vendor; a backend declaring no runtime says so, and a
// probe that could not read one says THAT instead of reporting silence.
//
// Deliberately NOT its own sep() step: test/bootstrap-smoke/smoke.mjs asserts
// day:start reaches the literal `6/6`, so a seventh step turns that smoke test
// red (measured on PR #594). Renumbering would be a one-word edit in a file
// outside this change's claim; a sub-step needs none and reads the same.
//
// Strings are English literals, not `t()` keys: the catalogs under
// brain/scripts/i18n/** are outside this change's file claim (see the PR).
{
  console.log(`\n  ${C.bold}AI agent runtime${C.reset}`);
  const { platform, notice } = await agentRuntimeReport({
    env: process.env,
    envVars: platformEnvVars(readEnvVar),
    config: platformConfig(config),
  });
  console.log(`  ${C.dim}harness: ${platform}${C.reset}`);
  ({ ok, warn, info }[notice.level] ?? info)(notice.message);
  if (notice.hint) console.log(`       ${C.dim}${notice.hint}${C.reset}`);
}

// ── 5. Team memory ───────────────────────────────────────────────────────────
sep(await t('day.memory.section'));

// 4a. Auto-install/repair the pre-push hook that checkpoints feature working memory
//     and runs repository checks before push (day.memory.hookMissing / hookActive).
//     Does not depend on re-running bootstrap: ensured on every startup, so devs
//     who already have the system running receive it without manual action, and it
//     re-installs itself if someone disables it. Durable team records travel through
//     the memory lane, never on a feature push.
const HOOKS_PATH = 'brain/scripts/hooks';
const hookFile = join(ROOT, HOOKS_PATH, 'pre-push');
if (!existsSync(hookFile)) {
  warn(await t('day.memory.hookMissing', { path: HOOKS_PATH }));
} else {
  const currentHooks = capture('git', ['config', '--get', 'core.hooksPath']).stdout?.trim();
  if (currentHooks !== HOOKS_PATH) {
    const r = capture('git', ['config', 'core.hooksPath', HOOKS_PATH]);
    if (r.status === 0) ok(await t('day.memory.hookActivated', { hooksPath: HOOKS_PATH }));
    else warn(await t('day.memory.hookFailed'));
  } else {
    ok(await t('day.memory.hookActive'));
  }
}

const engram = capture('engram', ['--version']);
if (engram.status === 0) {
  // 4a. Import team memory from .memory/ → local engram (import-only, no git pull).
  //     Step 2 already ran git fetch + merge, so the working tree is up-to-date.
  //     Using "import" avoids a redundant network call and eliminates any risk
  //     of post-merge hook recursion.
  console.log(`  ${C.dim}${await t('day.memory.importing')}${C.reset}`);
  await run(NODE, ['brain/scripts/memory/cli.mjs', 'import']);

  // 4b. Re-project brain/ → ~/.engram (ADRs, anti-patterns, domain)
  console.log(`  ${C.dim}${await t('day.memory.reprojecting')}${C.reset}`);
  await run(NODE, ['brain/scripts/brain-to-engram.mjs']);

  // 4c. Export ~/.engram → .memory/ in the repo (closes the loop: without this step, nothing flows)
  console.log(`  ${C.dim}${await t('day.memory.exporting')}${C.reset}`);
  const exportResult = capture('engram', ['sync', '--export']);
  if (exportResult.status === 0) {
    ok(await t('day.memory.exported'));
  } else {
    warn(await t('day.memory.exportFailed', { pm: PM }));
  }
} else {
  info(await t('day.memory.notAvailable'));
  console.log(`       ${await t('day.memory.install')}`);
}

// 5a. Lane sweep — a synchronous sub-step, own timeout (#906, design.md A7).
// NOT its own sep(): TOTAL stays 6 (test/bootstrap-smoke/smoke.mjs pins the
// literal 6/6), the same reasoning as the AI-runtime block above (4b).
// Silent skip when memory.lane.enabled is false or absent; exactly one line
// when it ran; a non-zero or unparseable outcome WARNS, never fails
// day:start — this block only ever renders what the PURE laneSweepLine()
// decides (day-start.test.mjs pins that it never calls die; day-start-
// sweep.test.mjs pins laneSweepLine's own four branches, #906 cold review C5).
{
  const laneEnabled = laneSweepEnabled(config);
  if (laneEnabled) {
    console.log(`  ${C.dim}${await t('day.memory.laneSweep.running')}${C.reset}`);
  }
  const laneResult = runLaneSweep({ config, enabled: laneEnabled });
  const line = laneSweepLine(laneResult);
  if (line.level === 'warn') {
    const detail = await t(line.params.detailKey, line.params.detailParams);
    warn(await t(line.key, { detail }));
  } else if (line.level === 'ok') {
    ok(await t(line.key, line.params));
  }
  // #936 (D-sweep step 5.7): one line per cross-day sweep row, in ADDITION
  // to the single-line summary above — `laneResult.outcome?.sweep` is `null`
  // whenever today's own run never reached the sweep (flag off, a non-zero
  // exit, unparseable output, or --dry-run), so `laneSweepBranchLines()`
  // returns `[]` and this loop is a no-op.
  for (const branchLine of laneSweepBranchLines(laneResult.outcome?.sweep ?? null)) {
    if (branchLine.level === 'warn') warn(await t(branchLine.key, branchLine.params));
    else ok(await t(branchLine.key, branchLine.params));
  }
}

// ── 6. Ticket board ──────────────────────────────────────────────────────────
sep(await t('day.board.section'));
await run(NODE, ['brain/scripts/tracker-board.mjs']);

// ── Done ─────────────────────────────────────────────────────────────────────
const div = `${C.dim}${'─'.repeat(62)}${C.reset}`;
console.log('\n' + div);
console.log(`  ${C.bGreen}${await t('day.done.withTicket')}${C.reset}`);
console.log(`    ${C.bold}${await t('day.done.ticketStart')}${C.reset}`);
console.log(`    ${C.bold}${await t('day.done.ticketStartAgent')}${C.reset}`);
console.log('');
console.log(`  ${C.bCyan}${await t('day.done.noTicket')}${C.reset}`);
console.log(`    ${C.bold}${await t('day.done.sddExplore')}${C.reset}`);
console.log(`    ${C.bold}${await t('day.done.gitlabIssue')}${C.reset}`);
console.log('');
console.log(`  ${C.dim}${await t('day.done.beforePush')}${C.reset}`);
console.log(`    ${C.bold}${await t('day.done.checkCmd', { pm: PM })}${C.reset}`);
console.log(div + '\n');
