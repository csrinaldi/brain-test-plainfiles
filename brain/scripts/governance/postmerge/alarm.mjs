// alarm.mjs — the ONE tested alarm filer for rung 3 (REQ-TS-4/-5, issues #466/#474).
//
// THE INVARIANT THIS EXISTS TO SERVE:
//   No terminal state of the post-merge audit may be both RED and SILENT.
//
// #466 was that invariant failing. `brain-audit` exited 1 with zero [FAIL-SHA]
// lines — a documented, legitimate state (§15.5: a violation in a
// non-auto-revertible class, or a tree-keyed failure whose revert would
// resurrect a payload). The `revert` step called that "incoherent" and exited 2,
// but the alarm step is gated on the AUDIT step's output (`== '2'`), which was
// `1`. Job red, nothing reverted, no issue filed, cursor frozen — observed live
// on 2026-08-06 in run 31094912872 over c724942.
//
// The lesson is not "add a branch for that state". It is that the alarm was
// gated on an ENUMERATION of exit codes, and an enumeration missed a state.
// So the alarm path is a tested function callable from any step, and the
// workflow's `always()` terminal step calls it as a BACKSTOP whenever the job
// is red and nothing else recorded an alarm — which holds for states nobody has
// enumerated yet.
//
// Idempotent by label (mirrors the bash the window/uncomputable steps already
// use): an open issue carrying the label is COMMENTED on rather than duplicated,
// so a halt that persists across the daily cron is one issue with N comments.
//
// Usage:
//   node alarm.mjs <label> <title> <body-file>
// Prints the label on success (the caller records it in $GITHUB_OUTPUT).
// Exits non-zero if the alarm could NOT be filed — never silently.
//
//   node alarm.mjs resolve <run-url> (audit|sweep|<label>)...
// The other direction (#1188): close the open alarm for each label, with a
// comment linking the passing run. Filing without resolving meant an alarm
// survived the recovery it reported (the demo's #4 stayed open after the audit
// went green), so a human had to notice a green run and close the issue by hand.
// Reading goes through `findOpenAlarm` — the same reader `fileAlarm` uses — and
// writing through the VCS port (`issueComment`, `issueClose`). Never fails the
// job: a close that could not happen is a printed warning, not a red run.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/**
 * The number of the OPEN alarm issue carrying `label`, or null. The one reader
 * both directions share: `fileAlarm` comments instead of duplicating, and
 * `resolveAlarms` closes what this finds.
 *
 * @param {string} label
 * @param {(args: string[]) => {ok: boolean, stdout: string, stderr: string}} [run]
 * @returns {string|null}
 */
export function findOpenAlarm(label, run = gh) {
  const existing = run(['issue', 'list', '--label', label, '--state', 'open', '--json', 'number', '--jq', '.[0].number // empty']);
  return existing.ok && existing.stdout ? existing.stdout : null;
}

/** Alarms a CLEAN AUDIT (exit 0, cursor advanced) resolves: every halt the audit or its window can file. */
export const AUDIT_ALARM_LABELS = Object.freeze([
  'governance:cursor-missing',
  'governance:cursor-unknown',
  'governance:audit-unrevertible',
  'governance:revert-blocked',
  'governance:audit-uncomputable',
  'governance:postmerge-unreported',
]);

/** Alarms a CLEAN SWEEP resolves: the archive sweep's own failure class. */
export const SWEEP_ALARM_LABELS = Object.freeze(['governance:archive-sweep-failed']);

/**
 * Close the open alarm for each label once the condition that filed it has
 * cleared (#1188): a comment linking the passing run, then the close. Both go
 * through the VCS port.
 *
 * `passing: false` is a no-op by construction — not even a read — so a
 * still-failing run can never close anything. A comment that fails does not stop
 * the close (the resolution is the point) and is reported; a close that fails is
 * reported and the alarm is not counted as closed. Never throws.
 *
 * GitLab: the governance fragment files no post-merge alarms (there is no
 * post-merge workflow on that provider), so this has no GitLab caller; the port
 * verbs exist on both providers regardless.
 *
 * @param {{ labels: string[], runUrl: string, passing: boolean, vcs: object, project: string,
 *   run?: Function }} input
 * @returns {Promise<{ closed: {label: string, number: number}[], warnings: string[] }>}
 */
export async function resolveAlarms({ labels, runUrl, passing, vcs, project, run = gh }) {
  const closed = [];
  const warnings = [];
  if (!passing) return { closed, warnings };
  for (const label of labels) {
    const found = findOpenAlarm(label, run);
    if (!found) continue;
    const number = Number(found);
    try {
      const c = await vcs.issueComment({
        project, number,
        body: `The condition behind \`${label}\` has cleared — a later run passed: ${runUrl}\n\nClosing this alarm automatically.`,
      });
      if (!c?.url) warnings.push(`could not comment on #${number} (${c?.error ?? 'no url'}); closing anyway`);
      const r = await vcs.issueClose({ project, number });
      if (r?.ok) closed.push({ label, number });
      else warnings.push(`could not close #${number} (${label}): ${r?.error ?? 'unknown'}`);
    } catch (err) { /* surfaced: a throwing port is reported as a warning — a close that could not happen must not turn a green run red */
      warnings.push(`could not close #${number} (${label}): ${err.message}`);
    }
  }
  return { closed, warnings };
}

/**
 * File (or update) the alarm issue for `label`.
 *
 * @param {string} label     e.g. 'governance:audit-unrevertible'
 * @param {string} title     issue title used only when creating
 * @param {string} bodyFile  path to the rendered markdown body
 * @param {(args: string[]) => {ok: boolean, stdout: string, stderr: string}} [run]
 *   injected `gh` runner — the seam the tests drive.
 * @returns {{ filed: boolean, action: 'created'|'commented'|null, reason: string|null }}
 */
export function fileAlarm(label, title, bodyFile, run = gh) {
  // --force so a pre-existing label is not an error. A failure here is NOT
  // fatal: the label may already exist with a different colour, and refusing to
  // file the alarm because we could not restyle its label would trade a loud
  // failure for a silent one — the exact bug this module exists to remove.
  run(['label', 'create', label, '--color', 'B60205', '--description', 'governance postmerge halt', '--force']);

  const existing = findOpenAlarm(label, run);
  if (existing) {
    const r = run(['issue', 'comment', existing, '--body-file', bodyFile]);
    return r.ok
      ? { filed: true, action: 'commented', reason: null }
      : { filed: false, action: null, reason: `gh issue comment failed: ${r.stderr}` };
  }

  const r = run(['issue', 'create', '--title', title, '--label', label, '--body-file', bodyFile]);
  return r.ok
    ? { filed: true, action: 'created', reason: null }
    : { filed: false, action: null, reason: `gh issue create failed: ${r.stderr}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'resolve') {
  const [runUrl, ...wanted] = process.argv.slice(3);
  // A group keyword expands to its constant, so the workflow never restates a label
  // list a new alarm could drift out of.
  const groups = { audit: AUDIT_ALARM_LABELS, sweep: SWEEP_ALARM_LABELS };
  const labels = wanted.flatMap((w) => groups[w] ?? [w]);
  if (!runUrl || labels.length === 0) {
    console.log('[FAIL] alarm.mjs resolve: usage: alarm.mjs resolve <run-url> (audit|sweep|<label>)...');
    process.exit(2);
  }
  try {
    const { getVcs } = await import('../../vcs/cli.mjs');
    const vcs = await getVcs();
    const res = await resolveAlarms({
      labels, runUrl, passing: true, vcs, project: process.env.GITHUB_REPOSITORY,
    });
    for (const c of res.closed) console.log(`closed #${c.number} (${c.label})`);
    for (const w of res.warnings) console.log(`[WARN] alarm.mjs resolve: ${w}`);
  } catch (err) { /* surfaced: printed, exit 0 — an unreachable port must not turn a clean audit red */
    console.log(`[WARN] alarm.mjs resolve: could not resolve alarms — ${err.message}`);
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [label, title, bodyFile] = process.argv.slice(2);
  if (!label || !title || !bodyFile) {
    console.log('[FAIL] alarm.mjs: usage: alarm.mjs <label> <title> <body-file>');
    process.exit(2);
  }
  try {
    readFileSync(bodyFile, 'utf8'); // fail loudly on an unreadable body rather than filing an empty alarm
  } catch (err) {
    console.log(`[FAIL] alarm.mjs: cannot read body file ${bodyFile}: ${err.message}`);
    process.exit(2);
  }
  const res = fileAlarm(label, title, bodyFile);
  if (!res.filed) {
    // The alarm itself failed. This is the irreducible residual — the issues API
    // is the only channel there is. Make it as loud as possible: the job fails
    // AND the reason is on stdout, so it is never a silent halt.
    console.log(`[FAIL] alarm.mjs: could NOT file the '${label}' alarm — ${res.reason}. `
      + 'The governance halt is UNREPORTED; a human must look at this job.');
    process.exit(2);
  }
  console.log(`${label} (${res.action})`);
}
