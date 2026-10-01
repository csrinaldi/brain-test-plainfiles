#!/usr/bin/env node
// cli.mjs — `brain:status`: cold boot for the human (issue #280, slice 1).
//
// A long session dies mid-slice. The human comes back and needs the last real
// state of issue X. Today that answer is scattered across a worktree, a
// `tasks.md`, a branch on the server and a verdict thread, and reassembling it
// is archaeology.
//
// THE GOVERNING PRINCIPLE, and it is #280's own: **state is re-derived from disk
// and server, never remembered.** A crash must not matter. Nothing here caches,
// nothing here persists, and two runs on the same world render identically.
//
// THE TICKET IS THE SPINE, ruled on #280 before implementation. Everything read
// from disk is local EVIDENCE that may have drifted from the authority, and the
// drift is the product rather than noise — measured on this repository, four
// artefacts stated something false in nine days and the ticket was right every
// time.
//
// READ-ONLY, AND PROVED RATHER THAN PROMISED. `cli.test.mjs` hands this function
// a port whose every write verb throws. "Read-only" asserted in a docstring is
// the class of claim this repo keeps finding unenforced; here the port refuses.
//
// FIELD-LEVEL DEGRADATION. An unreachable forge is a degraded report, not a
// failed run: the disk sections stay intact and the server ones say why they
// could not be computed. An all-or-nothing report gives the operator nothing at
// exactly the moment they have least.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderReport } from './report.mjs';
import { deriveTicket, deriveChain, deriveTasks, deriveDivergence } from './derive.mjs';
import { deriveReview, deriveWorkingMemory, deriveStandingItems } from './derive-review.mjs';

/** Git facts, each `null` when git did not answer. Never throws. */
function defaultGitFacts(root = process.cwd(), tracker = 'origin/main') {
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? (r.stdout ?? '').trim() : null;
  };
  const count = (range) => {
    const out = git('rev-list', '--count', range);
    return out === null ? null : Number(out);
  };
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const headSha = git('rev-parse', '--short', 'HEAD');
  const dirty = git('status', '--porcelain');
  const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  return {
    branch,
    headSha,
    ahead: count(`${tracker}..HEAD`),
    behind: count(`HEAD..${tracker}`),
    dirtyFiles: dirty === null ? null : dirty.split('\n').filter(Boolean).length,
    // No upstream is not an error since #785 — a task branch is born without one.
    // It is simply a fact this comparison cannot be made from.
    pushed: upstream === null ? null : count(`${upstream}..HEAD`) === 0,
  };
}

/** `tasks.md` for a change dir, or `null` with the path in the reason. */
function defaultReadTasks(root, changeDirName) {
  if (!changeDirName) return null;
  try {
    return readFileSync(join(root, 'openspec/changes', changeDirName, 'tasks.md'), 'utf8');
  } catch {
    return null;
  }
}

/** `resume.md` for a change dir — the OPERATIONAL artefact, never the reviewer's. */
function defaultReadResume(root, changeDirName) {
  if (!changeDirName) return null;
  try {
    return readFileSync(join(root, 'openspec/changes', changeDirName, 'resume.md'), 'utf8');
  } catch {
    return null;
  }
}

/**
 * runStatus() — derive and print. Returns an exit code and writes nothing.
 *
 * An unreachable forge returns 0: this is a report, not a gate. #280's
 * non-goals are explicit and the read-only rule is the first of them.
 */
export async function runStatus({ issueNumber, log = console.log, deps = {} } = {}) {
  const root = deps.root ?? process.cwd();
  const project = deps.project ?? null;
  const gitFacts = deps.gitFacts ?? (() => defaultGitFacts(root, deps.tracker ?? 'origin/main'));
  const readTasks = deps.readTasks ?? (() => defaultReadTasks(root, deps.changeDir));

  // ── stranded trackers (#323 S5 / #713): health ≠ silence ─────────────────
  {
    const { gatherStranded } = await import('./stranded.mjs');
    const s = await gatherStranded({ vcs: deps.vcs, project, root, tracker: deps.tracker ?? 'origin/main', _run: deps._strandedRun });
    if (s.stranded.length > 0) {
      log(`⚠ stranded tracker(s) — commits ahead of the default with NO open PR carrying them (#713):`);
      for (const b of s.stranded) log(`    ${b.name}  (+${b.aheadOfDefault})`);
    } else if (s.reason) {
      log(`stranded check: not computed — ${s.reason}`);
    }
  }

  // ── release debt (#860): what is published, and what is not ──────────────
  // Same surface and same ruling as the stranded block above (#713): report,
  // never refuse. A repo mid-cycle is HEALTHY, and a gate here would make the
  // honest state look like a failure. The line exists because the alternative —
  // a cadence policy in a document — is a hand-maintained fact whose failure
  // mode is silence, and that silence is what left three migrations promoted,
  // signed and unreachable for weeks.
  {
    const { gatherReleaseFacts, releaseDebt } = await import('./release-debt.mjs');
    const facts = deps.releaseFacts ?? gatherReleaseFacts({ root, _run: deps._releaseRun });
    for (const line of releaseDebt(facts).lines) log(line);
  }

  // ── the authority ────────────────────────────────────────────────────────
  let issue = null;
  let issueReason = null;
  if (!deps.vcs) {
    issueReason = 'no VCS port was supplied';
  } else if (!project) {
    issueReason = 'no project could be resolved for the forge read';
  } else {
    try {
      issue = await deps.vcs.issueView({ project, number: issueNumber });
      if (!issue) issueReason = `the forge returned no issue #${issueNumber}`;
    } catch (err) {
      // IN BAND, not thrown. One unreachable server must not take the disk
      // sections with it — that is the whole of field-level degradation.
      issueReason = err?.message ?? String(err);
    }
  }

  // ── local evidence ───────────────────────────────────────────────────────
  const facts = gitFacts() ?? {};
  const tasksText = readTasks();

  const tasksSection = deriveTasks({
    tasksText,
    reason: typeof tasksText === 'string' ? null : 'no tasks.md was found for this issue',
  });
  const openField = Object.fromEntries(tasksSection.fields).open;

  // ── the PR thread (slice 2) ──────────────────────────────────────────────
  // Read through the port like everything else. `prNumber` is supplied by the
  // caller for now; deriving it from the branch is its own read and its own
  // failure mode, and #280's non-goals keep this command from guessing.
  let reviews = null;
  let prHeadSha = null;
  let reviewReason = null;
  if (deps.prNumber && deps.vcs && project) {
    try {
      reviews = await deps.vcs.prReviews({ project, number: deps.prNumber });
      const pr = await deps.vcs.prView({ project, number: deps.prNumber });
      prHeadSha = pr?.headRefOid ? String(pr.headRefOid).slice(0, 7) : null;
      if (!Array.isArray(reviews)) reviewReason = 'the forge returned no reviews list';
    } catch (err) {
      reviewReason = err?.message ?? String(err);
      reviews = null;
    }
  } else if (!deps.prNumber) {
    reviewReason = 'no pull request number was given (--pr)';
  } else {
    reviewReason = issueReason ?? 'the forge could not be reached';
  }

  const resumeText = (deps.readResume ?? (() => defaultReadResume(root, deps.changeDir)))();

  const sections = [
    deriveTicket(issue ? { issue } : { reason: issueReason ?? 'the ticket could not be read' }),
    deriveChain(facts),
    tasksSection,
    deriveReview({
      reviews,
      prHeadSha,
      localHeadSha: facts.headSha ?? null,
      reason: reviewReason,
    }),
    deriveWorkingMemory({ resumeText }),
    deriveStandingItems({}),
    deriveDivergence({
      issue,
      openTasks: openField?.ok ? openField.value : null,
      headPushed: typeof facts.pushed === 'boolean' ? facts.pushed : null,
      reason: issue ? null : (issueReason ?? 'the ticket could not be read, and divergence needs both sides'),
    }),
  ];

  log(renderReport(sections));
  return 0;
}

// ── entry point ────────────────────────────────────────────────────────────
// Kept below `runStatus` and guarded, so importing this module for a test never
// spawns git or reaches a forge.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--issue');
  const issueNumber = i >= 0 ? Number(argv[i + 1]) : null;
  const p = argv.indexOf('--pr');
  const prNumber = p >= 0 ? Number(argv[p + 1]) : null;
  const c = argv.indexOf('--change');
  const changeDir = c >= 0 ? argv[c + 1] : null;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    console.error('usage: npm run brain:status -- --issue <N> [--pr <N>] [--change <dir>]');
    process.exit(1);
  }
  const { getVcs } = await import('../vcs/cli.mjs');
  const { originIdentity } = await import('../vcs/lib/repo.mjs');
  let vcs = null;
  let project = null;
  try {
    // `getVcs` is ASYNC and resolves the provider from the config itself — the
    // await is load-bearing, and passing a bare `resolveProviderName()` throws
    // "no provider configured" because that function takes its config
    // explicitly. Both measured while wiring this entry point; both degraded
    // in band rather than crashing, which is the contract working.
    vcs = await getVcs();
    project = originIdentity()?.project ?? null;
  } catch { /* degrades to an uncomputable ticket section, never a crash */ }
  process.exit(await runStatus({ issueNumber, deps: { vcs, project, prNumber, changeDir } }));
}
