#!/usr/bin/env node
// brain/scripts/archive.mjs — CLI interface for E1 brain:change:archive (issue 260)
//
// `--backfill` (issue #557 D1/D4) routes folder selection through the
// closed-issue selector (lib/archive-sweep.mjs): eligibility is now keyed on
// the linked issue's CLOSED state via the VCS port, replacing the old
// "archive every directory except the one hardcoded active-change iid"
// behavior. `--all` is now a DEPRECATED ALIAS of `--backfill` (identical
// behavior, loud notice) rather
// than the old unfiltered "archive everything" — a loaded gun (it would
// archive any still-open change) this rewrite removes; protection for an
// in-flight change now falls out of row 8 of the selector's decision table
// (its issue is open), not a hardcoded exclusion.
//
// The single-changeId path is UNCHANGED: a human naming one folder has
// already made the decision the selector exists to make, and this path
// NEVER consults the VCS (no readIssueState call, no network).

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveChange } from './lib/archive-logic.mjs';
import { OUTCOME, selectSweep } from './lib/archive-sweep.mjs';
import { getVcs } from './vcs/cli.mjs';
import { originIdentity } from './vcs/lib/repo.mjs';
import { loadBrainConfig } from './lib/brain-config.mjs';
import { listChangeFolders } from './governance/postmerge/sweep.mjs';

/** Real fs, rooted at `cwd` — every mode's default unless a test injects a fake. */
export function makeFs(cwd = process.cwd()) {
  return {
    exists: (p) => existsSync(join(cwd, p)),
    listDir: (p) => readdirSync(join(cwd, p)),
    readFile: (p) => readFileSync(join(cwd, p), 'utf8'),
    writeFile: (p, content) => writeFileSync(join(cwd, p), content, 'utf8'),
    mkdir: (p) => mkdirSync(join(cwd, p), { recursive: true }),
    rename: (src, dest) => renameSync(join(cwd, src), join(cwd, dest)),
  };
}

/**
 * Real `readIssueState` — VCS-backed, NEVER throws (issue #557 D3): the
 * selector's contract is `Promise<{state, stateReason}|null>`, but
 * `issueView` itself REJECTS on a fetch failure (pinned by
 * vcs.contract.test.mjs's "issueView must REJECT" case) — caught here and
 * normalized to `null`, the selector's own "no answer at all" signal, which
 * fails the whole run closed rather than silently treating an unreadable
 * folder as ineligible.
 *
 * A missing `project` (no git remote, no provider configured) also
 * normalizes every read to `null` rather than throwing during CLI startup —
 * `selectSweep` then reports `complete: false` and names every unreadable
 * iid, a more actionable failure for a human running the backfill than a
 * crash before any classification happened.
 *
 * @param {{ project: string|null, config?: object }} opts
 * @returns {(iid: string) => Promise<{state: string, stateReason: string|null}|null>}
 */
export function makeReadIssueState({ project, config }) {
  let vcsPromise;
  return async (iid) => {
    if (!project) return null;
    try {
      vcsPromise ??= getVcs({ config });
      const vcs = await vcsPromise;
      const issue = await vcs.issueView({ project, number: Number(iid) });
      return { state: issue.state, stateReason: issue.stateReason ?? null };
    } catch { /* surfaced: a null issue state is read by selectSweep as "could not read" and the run exits 1 (archive.test 5.4) */
      return null;
    }
  };
}

/**
 * Outcomes that make `--backfill` exit 1 even when every issue-state read
 * answered — a human decision is required, and the run must not report
 * itself as clean (spec `archive-closed-issue-selection`: "the caller MUST
 * report the collision distinctly from both a success and a benign skip").
 * `open` / `not-planned` / `no-issue-key` / `not-a-change` are all EXPECTED
 * steady-state outcomes, never failures on their own.
 */
export const BLOCKED_OUTCOMES = new Set([OUTCOME.COLLISION, OUTCOME.DESTINATION_EXISTS]);

function reportGroup(log, label, folders) {
  if (folders.length === 0) return;
  log(`\n  ${label} (${folders.length}):`);
  for (const f of folders) {
    log(`    - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
}

/**
 * Runs the `--backfill`/`--all` mode: selects via `selectSweep`, archives
 * every `archivable` folder, and prints a grouped report of every
 * non-archived folder with its outcome. Every dependency is injected so this
 * is directly `node --test`-able — no real filesystem, no real VCS, no
 * subprocess spawn.
 *
 * Exit discipline (design D4): `1` if `complete === false` (some issue state
 * could not be read) OR any `BLOCKED_OUTCOMES` folder exists OR an archive
 * write itself failed; `0` only on a clean, fully-classified run — including
 * when open/not-planned/grandfathered/not-a-change folders were left in
 * place, which is expected steady-state, not a failure.
 *
 * FAIL-CLOSED (design D3, spec `archive-closed-issue-selection` — "Selector
 * Reads Are Fail-Closed"): when `selection.complete === false`, the archive
 * loop below MUST NOT RUN AT ALL — not even for folders the selector already
 * classified `archivable` before the unreadable one was hit. A partial batch
 * (some folders archived, some left because one issue read failed) is a
 * quieter version of the exact lie the spec forbids: "the selector MUST
 * abort sweep-set computation rather than proceeding as if zero folders were
 * eligible; the caller MUST surface the failure." Archiving the readable
 * subset would report success for a run that could not fully classify the
 * tree.
 *
 * @returns {Promise<{ exitCode: 0|1, selection: object, archivedCount: number,
 *   consolidatedCount: number, unconsolidatedCount: number,
 *   archiveErrors: Array<{name: string, message: string}> }>}
 */
export async function runBackfill({
  fs,
  entries,
  readIssueState,
  dateStr = new Date().toISOString().slice(0, 10),
  log = console.log,
  logError = console.error,
  deprecated = false,
}) {
  if (deprecated) {
    log('\n  ⚠ --all is deprecated — use --backfill (identical behavior, routed through the closed-issue selector).');
  }
  log('\n  Starting backfill of closed changes...');

  const selection = await selectSweep({ entries, exists: fs.exists, readIssueState });

  let archivedCount = 0;
  let consolidatedCount = 0;
  let unconsolidatedCount = 0;
  const archiveErrors = [];

  // Fail-closed (design D3): an incomplete selection archives NOTHING, even
  // when some folders already resolved to `archivable` — see the doc comment
  // above. The report below still runs, so the unreadable iid(s) are named.
  if (selection.complete) {
    for (const name of selection.archivable) {
      try {
        const result = await archiveChange({ changeId: name, fs, dateStr });
        archivedCount += 1;
        if (result.unconsolidated) {
          unconsolidatedCount += 1;
          log(`  ✓ Archived: ${name} (unconsolidated — no capability: declared)`);
        } else {
          consolidatedCount += 1;
          log(`  ✓ Archived: ${name} (consolidated: ${result.consolidated.join(', ')})`);
        }
      } catch (err) { /* surfaced: pushed to archiveErrors, printed, and the backfill exits 1 when any exist */
        archiveErrors.push({ name, message: err.message });
        logError(`  ✗ Failed to archive ${name}: ${err.message}`);
      }
    }
  }

  const nonArchived = selection.folders.filter((f) => f.outcome !== OUTCOME.ARCHIVABLE);
  reportGroup(log, 'Open (left in place)', nonArchived.filter((f) => f.outcome === OUTCOME.OPEN));
  reportGroup(log, 'Closed, not archivable', nonArchived.filter((f) => f.outcome === OUTCOME.NOT_PLANNED));
  reportGroup(log, 'Collision — blocked, human decision required', nonArchived.filter((f) => f.outcome === OUTCOME.COLLISION));
  reportGroup(log, 'Destination already exists — blocked', nonArchived.filter((f) => f.outcome === OUTCOME.DESTINATION_EXISTS));
  reportGroup(log, 'Grandfathered (no issue key)', nonArchived.filter((f) => f.outcome === OUTCOME.NO_ISSUE_KEY));
  reportGroup(log, 'Not a change directory', nonArchived.filter((f) => f.outcome === OUTCOME.NOT_A_CHANGE));
  reportGroup(log, 'Unreadable — issue state could not be read', nonArchived.filter((f) => f.outcome === OUTCOME.UNREADABLE));

  log(
    `\n  ✓ Backfill complete. archived: ${archivedCount} (consolidated: ${consolidatedCount} · carried unconsolidated: ${unconsolidatedCount})`,
  );
  if (!selection.complete) {
    logError(
      `  ✗ ${selection.readFailures.length} issue(s) could not be read: ${selection.readFailures.join(', ')} — nothing archived for ${
        selection.readFailures.length === 1 ? 'it' : 'them'
      }.`,
    );
  }
  const blocked = nonArchived.filter((f) => BLOCKED_OUTCOMES.has(f.outcome));
  if (blocked.length > 0) {
    logError(`  ⚠ ${blocked.length} folder(s) blocked (collision or destination-exists) — human decision required.\n`);
  }

  const exitCode = !selection.complete || blocked.length > 0 || archiveErrors.length > 0 ? 1 : 0;
  return { exitCode, selection, archivedCount, consolidatedCount, unconsolidatedCount, archiveErrors };
}

/**
 * Archives a single, explicitly-named change — the human override (design
 * D4). NEVER consults the VCS: a human naming one folder has already made
 * the decision the selector exists to make.
 *
 * @returns {Promise<0|1>}
 */
export async function runSingle({ changeId, fs, dateStr = new Date().toISOString().slice(0, 10), log = console.log, logError = console.error }) {
  try {
    await archiveChange({ changeId, fs, dateStr });
    log(`\n  ✓ Cambio "${changeId}" archivado con éxito.`);
    log('    Cuerpo de specs delta fusionado en openspec/specs/ y directorio movido a archive/.\n');
    return 0;
  } catch (err) { /* surfaced: the error is printed and the function returns exit code 1 */
    logError(`\n  ✗ Error al archivar cambio: ${err.message}\n`);
    return 1;
  }
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];

  if (!arg) {
    console.error('\n  ✗ Error: Falta especificar el ID del cambio a archivar o --backfill.');
    console.error('  Uso: npm run brain:change:archive -- <changeId>');
    console.error('       npm run brain:change:archive -- --backfill\n');
    process.exit(1);
  }

  const fs = makeFs();

  if (arg === '--all' || arg === '--backfill') {
    const changesRoot = 'openspec/changes';
    // Same reader the post-merge sweep uses (#1113/#1127): a missing changes
    // root is zero entries, any other read failure still throws.
    const entries = listChangeFolders(join(process.cwd(), changesRoot));
    const { project } = originIdentity();
    const readIssueState = makeReadIssueState({ project, config: loadBrainConfig() });

    const { exitCode } = await runBackfill({ fs, entries, readIssueState, deprecated: arg === '--all' });
    process.exit(exitCode);
  } else {
    const exitCode = await runSingle({ changeId: arg, fs });
    process.exit(exitCode);
  }
}
