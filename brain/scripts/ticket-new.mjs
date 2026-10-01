#!/usr/bin/env node
// ticket-new.mjs — open a ticket through the port (issue #528).
//
// It sits next to `brain:ticket:start`, which has always assumed the ticket already
// exists. That assumption was the gap: `issue-link` refuses any PR to `main` without
// an APPROVED issue behind it, so the first step of brain's own workflow was the one
// step brain did not support, and every ticket in this repository was authored
// outside the adapter boundary.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It cannot approve. `assertNoApprovalLabel`
// refuses the label inside the port, so no caller — this one included — can attach
// it (#124, reviewer-protocol §9). This verb prints the next step instead, because
// the human applying that label IS the authorisation step, not a formality standing
// between the agent and its work.
//
// Usage:
//   npm run brain:ticket:new -- --title "fix(x): …" [--body-file PATH] [--label type:bug]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getVcs } from './vcs/cli.mjs';
import { originIdentity } from './vcs/lib/repo.mjs';
import { loadBrainConfig } from './lib/brain-config.mjs';
import { resolveApprovedLabel } from './governance/approved-label.mjs';

/**
 * Pure argument parsing — `--label` repeats, `--body-file` is read by the caller so
 * this stays free of I/O and testable.
 * @param {string[]} argv
 * @returns {{ ok: true, title: string, bodyFile: string|null, labels: string[] } | { ok: false, error: string }}
 */
export function parseArgs(argv = []) {
  let title = null;
  let bodyFile = null;
  const labels = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--title') title = argv[i + 1] ?? null, i += 1;
    else if (argv[i] === '--body-file') bodyFile = argv[i + 1] ?? null, i += 1;
    else if (argv[i] === '--label') { if (argv[i + 1]) labels.push(argv[i + 1]); i += 1; }
    else return { ok: false, error: `unknown argument: ${argv[i]}` };
  }
  if (!title || !title.trim()) return { ok: false, error: '--title is required' };
  return { ok: true, title: title.trim(), bodyFile, labels };
}

/**
 * The next-step text. Exported so a test reads the SAME string the CLI prints —
 * an instruction asserted from a copy is an instruction nobody proved.
 * @param {{ number: number|null, url: string|null }} created
 * @param {string} approvedLabel
 * @returns {string}
 */
export function nextStepMessage(created, approvedLabel) {
  const ref = created.number != null ? `#${created.number}` : created.url ?? 'the new issue';
  return [
    `✓ ${ref} created${created.url ? ` — ${created.url}` : ''}`,
    '',
    `  Next, a HUMAN applies "${approvedLabel}". brain cannot: that label is the`,
    '  authorisation this ticket is asking for, and no verb may apply it (#124, §9).',
    '',
    `  Then:  npm run brain:ticket:start -- ${created.number ?? '<id>'}`,
  ].join('\n');
}

/** @returns {Promise<number>} exit code */
export async function main(argv = [], deps = {}) {
  const say = deps.say ?? console.log;
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    say(`✗ ${parsed.error}`);
    say('  Usage: npm run brain:ticket:new -- --title "<title>" [--body-file PATH] [--label L]');
    return 2;
  }

  const config = deps.config ?? loadBrainConfig();
  const { project } = deps.origin ?? originIdentity();
  if (!project) {
    say('✗ could not resolve the project from the git remote.');
    return 2;
  }

  let body = '';
  if (parsed.bodyFile) {
    try {
      body = (deps.readFile ?? ((p) => readFileSync(p, 'utf8')))(parsed.bodyFile);
    } catch (err) {
      say(`✗ could not read --body-file ${parsed.bodyFile}: ${err.message}`);
      return 2;
    }
  }

  const vcs = deps.vcs ?? await getVcs({ config });

  let created;
  try {
    created = await vcs.issueCreate({ project, title: parsed.title, body, labels: parsed.labels, config });
  } catch (err) {
    // The approval refusal lands here. It is a POLICY refusal, not an outage, so it
    // is surfaced as itself rather than folded into the transport-error path below.
    say(`✗ ${err.message}`);
    return 1;
  }

  if (created?.error || (created?.number == null && created?.url == null)) {
    say(`✗ could not create the issue: ${created?.error ?? 'the provider returned nothing usable'}`);
    return 1;
  }

  say(nextStepMessage(created, resolveApprovedLabel(config, config?.vcs?.provider)));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
