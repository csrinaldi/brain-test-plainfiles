#!/usr/bin/env node
// sweep.mjs — the CI-facing orchestrator for the governance archive sweep
// (issue #557, design D5/D6, module contracts). Consumes the closed-issue
// selector (lib/archive-sweep.mjs) exactly as `archive.mjs --backfill` does —
// reused, not re-invented — applies `archiveChange` to every ARCHIVABLE
// folder, and renders the markdown report the workflow's bash turns into the
// `auto-archive/<date>` PR body.
//
// NO git here: the workflow's bash still does the commit/push — the same
// node/bash boundary the revert step already draws (design, "Module
// contracts"). `readIssueState` reaches the network through the VCS port
// (via `getVcs()`), the existing, already-tested boundary `archive.mjs`'s
// own `makeReadIssueState` draws — reused here rather than re-implemented.
//
// #1106 rework: opening the sweep's own PR/MR ALSO goes through the VCS port
// (`getVcs().mrCreate`, see `openArchivePr` below) — never the `gh` CLI's own
// PR-creation subcommand, in workflow bash. The earlier shape shelled that
// subcommand directly from the workflow, which (a) tied PR creation to GitHub
// specifically, when the port
// already implements `mrCreate` for both providers (#239), and (b) left the
// App-token identity nowhere provider-neutral to be threaded. The workflow
// still owns the git plumbing that is unavoidably GitHub-Actions-specific
// (secrets check, minting the App token, pushing the branch); this module
// owns the decision of whether and how the PR gets opened.
//
// Fail-closed (design D3): if the selector could not read every issue state,
// NOTHING is archived — not even folders already classified `archivable`
// before the unreadable one was hit. Blocked folders (collision / not-planned
// / destination-exists / no-issue-key / not-a-change) are reported, never an
// alarm (design D5) — only an incomplete selection or an archive-write
// failure exits non-zero.
//
// Usage:
//   node sweep.mjs --apply --report <file>
//   node sweep.mjs --open-pr --head <branch> --base <branch> --archived <n> --report <file>
//
// Exit codes (--apply):
//   0 — the selector answered completely; the report (if any) was written
//   3 — incomplete (an issue read failed) or an archive write itself failed —
//       nothing was archived; the workflow files its own alarm and exits 0
//
// Exit codes (--open-pr):
//   0 — the PR/MR was opened; stdout carries `SWEEP-PR url=<url>`
//   1 — mrCreate failed (a real failure — a bad token, a rejected request);
//       stdout carries `SWEEP-PR failed=<error>`
//   2 — skipped: no token was available (BRAIN_SWEEP_TOKEN unset/empty — a
//       legitimate, reportable state, see design.md); stdout carries
//       `SWEEP-PR skipped=no-token`
//
// Prints, on stdout, the one summary line the workflow's bash parses per mode:
//   SWEEP archived=<N> blocked=<M> unconsolidated=<K>          (--apply)
//   SWEEP-PR url=<url> | skipped=<reason> | failed=<error>     (--open-pr)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveChange } from '../../lib/archive-logic.mjs';
import { OUTCOME, selectSweep } from '../../lib/archive-sweep.mjs';
import { makeFs, makeReadIssueState } from '../../archive.mjs';
import { originIdentity } from '../../vcs/lib/repo.mjs';
import { loadBrainConfig } from '../../lib/brain-config.mjs';
import { getVcs } from '../../vcs/cli.mjs';

/** Outcomes rendered in the "blocked" table — every non-archivable outcome
 * EXCEPT `open` (expected steady-state, left out of the daily report
 * entirely) and `container` (not a folder). Reported, never an alarm cause
 * (design D5's failure-semantics table). */
const BLOCKED_REPORT_OUTCOMES = new Set([
  OUTCOME.COLLISION,
  OUTCOME.DESTINATION_EXISTS,
  OUTCOME.NOT_PLANNED,
  OUTCOME.NO_ISSUE_KEY,
  OUTCOME.NOT_A_CHANGE,
]);

/**
 * Renders the deterministic markdown report: archived folders grouped by
 * capability, the unconsolidated list, the blocked table with reasons, and
 * the `Part of #557.` trailer (design D6). Sorted throughout so two runs over
 * the same classification produce byte-identical output regardless of
 * `entries` order.
 *
 * @param {{ dateStr: string, archived: Array<{name: string, iid: string, consolidated: string[], unconsolidated: boolean}>, blocked: Array<{name: string, iid: string|null, outcome: string, detail: string|null}> }} args
 * @returns {string}
 */
export function renderReport({ dateStr, archived, blocked }) {
  const lines = [];
  lines.push(`# OpenSpec Archive Sweep — ${dateStr}`);
  lines.push('');

  const consolidatedList = archived.filter((a) => !a.unconsolidated);
  const unconsolidatedList = archived.filter((a) => a.unconsolidated);
  lines.push(`Archived: ${archived.length} (consolidated: ${consolidatedList.length} · unconsolidated: ${unconsolidatedList.length})`);

  if (consolidatedList.length > 0) {
    const byCap = new Map();
    for (const a of consolidatedList) {
      for (const cap of a.consolidated) {
        if (!byCap.has(cap)) byCap.set(cap, []);
        byCap.get(cap).push(a);
      }
    }
    lines.push('');
    lines.push('## Archived by capability');
    for (const cap of [...byCap.keys()].sort()) {
      lines.push('');
      lines.push(`**${cap}**`);
      for (const a of [...byCap.get(cap)].sort((x, y) => x.name.localeCompare(y.name))) {
        lines.push(`- ${a.name} (issue #${a.iid})`);
      }
    }
  }

  if (unconsolidatedList.length > 0) {
    lines.push('');
    lines.push('## Unconsolidated (no `capability:` declared)');
    lines.push('');
    for (const a of [...unconsolidatedList].sort((x, y) => x.name.localeCompare(y.name))) {
      lines.push(`- ${a.name} (issue #${a.iid})`);
    }
  }

  if (blocked.length > 0) {
    lines.push('');
    lines.push('## Blocked — human decision required');
    lines.push('');
    lines.push('| Folder | Issue | Outcome | Reason |');
    lines.push('|---|---|---|---|');
    for (const f of [...blocked].sort((x, y) => x.name.localeCompare(y.name))) {
      lines.push(`| ${f.name} | ${f.iid ? `#${f.iid}` : '—'} | ${f.outcome} | ${f.detail ?? ''} |`);
    }
  }

  lines.push('');
  lines.push('Part of #557.');
  return lines.join('\n') + '\n';
}

/**
 * Runs the sweep: selects via `selectSweep`, archives every `archivable`
 * folder, and renders the report. Every dependency is injected — no real
 * filesystem, no real VCS, no subprocess spawn — mirroring `archive.mjs`'s
 * `runBackfill` (issue #557 D4).
 *
 * FAIL-CLOSED (design D3): when `selection.complete === false`, the archive
 * loop does not run at all — see `runBackfill`'s identical doc comment for
 * the full rationale. No report is rendered on this path either: the
 * workflow's bash files its own alarm from the exit code alone.
 *
 * An `archiveChange` failure mid-loop is also reported via a non-zero exit
 * (3): a partially-archived-but-unreported run is exactly the "quieter lie"
 * D3 forbids for the read-failure case, so a write failure gets the same
 * fail-loud treatment rather than a silently smaller success.
 *
 * @returns {Promise<{ exitCode: 0|3, selection: object, archivedCount: number,
 *   consolidatedCount: number, unconsolidatedCount: number, blockedCount: number,
 *   report: string|null, archiveErrors: Array<{name: string, message: string}> }>}
 */
export async function runSweep({
  fs,
  entries,
  readIssueState,
  dateStr = new Date().toISOString().slice(0, 10),
  log = console.log,
  logError = console.error,
}) {
  const selection = await selectSweep({ entries, exists: fs.exists, readIssueState });

  if (!selection.complete) {
    logError(
      `SWEEP: ${selection.readFailures.length} issue(s) could not be read: ${selection.readFailures.join(', ')} — fail-closed, nothing archived.`,
    );
    return {
      exitCode: 3,
      selection,
      archivedCount: 0,
      consolidatedCount: 0,
      unconsolidatedCount: 0,
      blockedCount: 0,
      report: null,
      archiveErrors: [],
    };
  }

  const folderByName = new Map(selection.folders.map((f) => [f.name, f]));
  const archived = [];
  const archiveErrors = [];
  let consolidatedCount = 0;
  let unconsolidatedCount = 0;

  for (const name of selection.archivable) {
    const folder = folderByName.get(name);
    try {
      const result = await archiveChange({ changeId: name, fs, dateStr });
      if (result.unconsolidated) unconsolidatedCount += 1;
      else consolidatedCount += 1;
      archived.push({ name, iid: folder.iid, consolidated: result.consolidated, unconsolidated: result.unconsolidated });
    } catch (err) { /* surfaced: pushed to archiveErrors: the sweep exits 3 and the workflow files the archive-sweep-failed alarm */
      archiveErrors.push({ name, message: err.message });
      logError(`SWEEP: failed to archive ${name}: ${err.message}`);
    }
  }

  const blocked = selection.folders.filter((f) => BLOCKED_REPORT_OUTCOMES.has(f.outcome));
  const archivedCount = archived.length;

  if (archiveErrors.length > 0) {
    return {
      exitCode: 3,
      selection,
      archivedCount,
      consolidatedCount,
      unconsolidatedCount,
      blockedCount: blocked.length,
      report: null,
      archiveErrors,
    };
  }

  const report = renderReport({ dateStr, archived, blocked });
  log(`SWEEP archived=${archivedCount} blocked=${blocked.length} unconsolidated=${unconsolidatedCount}`);

  return {
    exitCode: 0,
    selection,
    archivedCount,
    consolidatedCount,
    unconsolidatedCount,
    blockedCount: blocked.length,
    report,
    archiveErrors: [],
  };
}

/**
 * openArchivePr — opens the sweep's PR/MR through the VCS port, or reports why
 * it did not (issue #1106). The ONLY policy here is "no token → no call": a
 * missing/empty `token` is a legitimate, reportable state (the App is not
 * configured, or its mint failed), never an error this function itself
 * raises. `mrCreate` is injected — same discipline as `runSweep`'s `fs` /
 * `readIssueState` — so this is testable with a fake port and no network.
 *
 * `token` is threaded BOTH ways on purpose: bound at the port via
 * `getVcs({ identity: token })` (the CLI wiring below) so a GitHub call
 * authenticates correctly — `github.mrCreate` has no `token` parameter of its
 * own, it reads the bound identity — AND passed again as `mrCreate`'s own
 * `token` field, which is what GitLab's implementation actually reads
 * (`glToken(token) = token ?? currentIdentity() ?? vcsToken(...)`, thirteen
 * call sites, vcs-contract.md). Passing it here is a no-op on GitHub and the
 * live credential on GitLab — never a silent auth gap on either provider.
 *
 * Never throws: an `mrCreate` failure is a `{ outcome: 'failed' }` result,
 * matching `mrCreate`'s own never-throws contract (`{ url: null, error }`).
 *
 * @param {{
 *   mrCreate: (args: { project: string, title: string, body: string, head: string, base: string, token?: string }) => Promise<{ url: string } | { url: null, error?: string }>,
 *   token: string|null|undefined,
 *   project: string,
 *   title: string,
 *   body: string,
 *   head: string,
 *   base: string,
 * }} args
 * @returns {Promise<{ outcome: 'opened', url: string } | { outcome: 'skipped', reason: 'no-token' } | { outcome: 'failed', error: string }>}
 */
export async function openArchivePr({ mrCreate, token, project, title, body, head, base }) {
  if (!token) {
    return { outcome: 'skipped', reason: 'no-token' };
  }
  const result = await mrCreate({ project, title, body, head, base, token });
  if (result && result.url) {
    return { outcome: 'opened', url: result.url };
  }
  return { outcome: 'failed', error: (result && result.error) || 'mrCreate returned no url' };
}

/**
 * Lists change-folder names directly under `changesRootAbsPath`. A missing
 * root (`ENOENT`) means a fresh consumer with no `openspec/changes/` yet —
 * that is zero eligible changes, not a failure, and is reported as an empty
 * list rather than thrown (#1113: the bare `readdirSync` this replaces threw
 * an uncaught exception on every clean merge in a consumer with no changes
 * folder, crashing the sweep and filing a false `governance:archive-sweep-failed`
 * alarm whose "Sweep output" block was empty because the process never
 * reached its own error handling). Any OTHER read failure (permissions, the
 * path exists but is a file, etc.) still throws — only "the root itself does
 * not exist" is the harmless, expected case.
 *
 * @param {string} changesRootAbsPath
 * @returns {string[]}
 */
export function listChangeFolders(changesRootAbsPath) {
  let dirEntries;
  try {
    dirEntries = readdirSync(changesRootAbsPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return dirEntries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : null;
  };

  if (args.includes('--open-pr')) {
    const head = flag('--head');
    const base = flag('--base');
    const archived = flag('--archived');
    const reportPath = flag('--report');
    if (!head || !base || !archived || !reportPath) {
      console.error('Usage: node sweep.mjs --open-pr --head <branch> --base <branch> --archived <n> --report <file>');
      process.exit(2);
    }

    const body = readFileSync(reportPath, 'utf8');
    const title = `chore(openspec): archive ${archived} closed changes`;
    const token = process.env.BRAIN_SWEEP_TOKEN || null;
    const { project } = originIdentity();
    const config = loadBrainConfig();
    const vcs = token ? await getVcs({ config, identity: token }) : null;

    const result = await openArchivePr({
      mrCreate: vcs ? vcs.mrCreate : async () => ({ url: null, error: 'no VCS port bound (no token)' }),
      token,
      project,
      title,
      body,
      head,
      base,
    });

    if (result.outcome === 'opened') {
      console.log(`SWEEP-PR url=${result.url}`);
      process.exit(0);
    }
    if (result.outcome === 'skipped') {
      console.log(`SWEEP-PR skipped=${result.reason}`);
      process.exit(2);
    }
    console.log(`SWEEP-PR failed=${result.error}`);
    process.exit(1);
  }

  const reportPath = flag('--report');

  if (!reportPath) {
    console.error('Usage: node sweep.mjs --apply --report <file>');
    process.exit(2);
  }

  const changesRoot = 'openspec/changes';
  const entries = listChangeFolders(join(process.cwd(), changesRoot));
  const fs = makeFs();
  const { project } = originIdentity();
  const readIssueState = makeReadIssueState({ project, config: loadBrainConfig() });

  const { exitCode, report } = await runSweep({ fs, entries, readIssueState });
  if (report !== null) {
    writeFileSync(reportPath, report, 'utf8');
  }
  process.exit(exitCode);
}
