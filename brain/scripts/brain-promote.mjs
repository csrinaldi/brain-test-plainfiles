#!/usr/bin/env node
// brain-promote.mjs — read-confirm-stage promotion of a Tier 2 draft
// (issue #378 slice 1, issue #509 slice 2).
//
// Usage: npm run brain:promote -- <path/to/brain-drafts/adr-NNNN-slug.md>     (new ADR)
//        npm run brain:promote -- <path/to/brain-drafts/anything.draft.md>    (amendment)
//
//   1. Renders the draft in full, so the human reads what they are signing.
//   2. Shows the exact plan: every act, before and after, plus the cascade.
//   3. Requires a TYPED confirmation — the literal word, never a single letter.
//   4. On accept: writes the files, stages them, and STOPS.
//   5. Prints the git commit command. Running it is the human's signature.
//
// TWO DRAFT SHAPES, ONE FLOW. A draft named `adr-NNNN-slug.md` creates a new
// signed ADR (slice 1). A draft named `*.draft.md` carrying a
// `brain-amendment/1` block amends an ALREADY-SIGNED brain/** file in place —
// consolidation-protocol.md §1c's three acts, plus §1b's index marker for the
// ADR shape. Both run through the SAME locks, the same confirmation and the
// same §1d cascade below: the two hand-rolled promoters this replaces
// (promote-529.sh, promote-516.sh) each re-derived that cascade from the
// doctrine text, and the first one lost the AGENTS.md step on the human's
// signing commit. A second implementation of a written rule is the #340 defect.
//
// ─────────────────────────────────────────────────────────────────────────────
// This verb automates precisely the action two anti-patterns forbid
// (brain/core/anti-patterns/ia-escribe-brain-sin-gate.md and
// ia-promueve-sus-propios-artefactos.md). It is NOT a convenience feature, and
// it adds NO enforcement. The real enforcement is unchanged and lives at the PR
// level: brain-writes-reviewed (L6) and CODEOWNERS. See the ADR draft in
// openspec/changes/issue-378-brain-promote/brain-drafts/ for the honest limits.
//
// Four structural locks, drift-guarded by brain-promote.locks.test.mjs:
//   1. Refuses on a non-TTY, before anything is read or written.
//   2. No auto-accept option and no environment read exists — there is no branch
//      to reach. Every option-shaped token is a hard abort, not a silent no-op.
//      Adding one is a doctrine change and needs an ADR.
//   3. Stages. Never commits, never pushes: the single git helper below enforces
//      an allowlist that does not contain those subcommands.
//   4. The confirmation is one exact literal word.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { insertAdrLink } from './lib/home-index.mjs';
import { SOURCE_DOCS, AGENTS_EMIT_PATH, compileAgentsMd } from './axes/platform/adapters/antigravity.mjs';
import {
  AMENDMENT_DRAFT_SUFFIX,
  CONTRACT_TAG,
  amendmentCommitSubject,
  formatStampDate,
  parseAmendmentDraft,
  planAmendment,
} from './lib/amendment-draft.mjs';
import {
  MIGRATION_DRAFT_BASENAME_RE,
  parseMigrationDraft,
  proposeVersion,
  spliceMigrationEntry,
} from './lib/migration-draft.mjs';
import { migrateConfig } from './lib/installer.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { checkShippedContent } from './lib/promote-guards.mjs';

// ── Frozen contract ──────────────────────────────────────────────────────────

/** The literal word the human must type. Lock 4. */
export const CONFIRMATION_WORD = 'PROMOTE';

/**
 * The ONLY git subcommands this verb may run. Lock 3, expressed as data rather
 * than as a source scan: the verb PRINTS a commit command, so the string
 * "git commit" is in this file by design and a text scan for it can never work.
 *
 * `status` joined `add` and `config` with the write preconditions (#509): it is
 * read-only, and it is what makes `add` safe — on an unmerged path `git add`
 * marks the conflict resolved, so the allowlist alone never made lock 3 true.
 * The property this list protects is unchanged: no subcommand here can produce
 * a commit or a push.
 */
export const ALLOWED_GIT_SUBCOMMANDS = Object.freeze(['add', 'config', 'status']);

/** Draft basename shape. Anchored so the destination satisfies adrPresence's regex. */
export const DRAFT_BASENAME_RE = /^adr-(\d{4})-([a-z0-9][a-z0-9-]*)\.md$/;

/** ADR H1 shape, accepting an em dash, an en dash or a hyphen as the separator. */
const H1_RE = /^#\s+ADR-(\d{4})\s*[—–-]\s*(.+?)\s*$/;

const DECISIONS_DIR = 'brain/project/decisions';
const HOME_PATH = 'brain/HOME.md';

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Removes `//` line comments and block comments. Used by the lock drift-guard
 * so a comment that DESCRIBES a forbidden construct is not mistaken for one.
 * Proven by its own tests before anything is asserted over its output.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  return src
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Parses the verb's arguments. Exactly one positional; EVERY option-shaped
 * token is a hard abort. Lock 2 lives here: an auto-accept option is not
 * ignored, it stops the run.
 *
 * @param {string[]} argv
 * @returns {{ok:true, draftPath:string}|{ok:false, error:string}}
 */
export function parseArgs(argv) {
  const options = argv.filter((a) => a.startsWith('-'));
  if (options.length > 0) {
    return {
      ok: false,
      error:
        `brain:promote takes no options — got ${options.join(', ')}.\n` +
        '  There is deliberately no way to skip the confirmation. The typed word IS the gate;\n' +
        '  an option that bypasses it would be a doctrine change requiring an ADR.',
    };
  }
  const positionals = argv.filter((a) => !a.startsWith('-'));
  if (positionals.length !== 1) {
    return {
      ok: false,
      error:
        'Usage: npm run brain:promote -- <path/to/brain-drafts/adr-NNNN-slug.md>\n' +
        `  Expected exactly one draft path, got ${positionals.length}.`,
    };
  }
  return { ok: true, draftPath: positionals[0] };
}

/**
 * Derives the promotion destination from a draft path.
 * @param {string} draftPath
 * @returns {string|null} repo-relative destination, or null when the basename does not qualify.
 */
export function destinationFor(draftPath) {
  const name = basename(draftPath);
  if (!DRAFT_BASENAME_RE.test(name)) return null;
  return `${DECISIONS_DIR}/${name}`;
}

/** Reads the issue number out of a draft path's `issue-<N>` segment. */
export function issueNumberFor(draftPath) {
  const m = draftPath.match(/(?:^|[/\\])issue-(\d+)/);
  return m ? m[1] : null;
}

/**
 * Wraps a value in single quotes for a shell command, escaping embedded
 * apostrophes. Single quotes, not double: ADR titles contain backticks
 * (ADR-0027), and a double-quoted paste command-substitutes them.
 *
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Builds the commit command the human runs. Conventional Commits plus a `#N`
 * reference — both required by the commit-msg hook and by pre-receive on push.
 * English, because the artefacts it touches ship to consumers.
 *
 * @param {{number:string, title:string, issue:string|null}} args
 * @returns {string}
 */
export function buildCommitCommand({ number, title, issue }) {
  const ref = issue ? `#${issue}` : '#<issue-number>';
  return `git commit -m ${shellQuote(`docs(brain): promote ADR-${number} — ${title} (${ref})`)}`;
}

/**
 * Rewrites a draft into the house ADR shape. Pure.
 *
 * The blockquote strip is BOUNDED to the preamble (between the H1 and the first
 * `## ` heading), which is where the drafts' `> **status:**` line and
 * `> **Tier 2 draft.**` banner live. A whole-file strip would eat body content.
 *
 * @param {string} draftText
 * @param {{gitUserName:string, today:string}} ctx
 * @returns {{ok:true, text:string, number:string, title:string, removed:string}|{ok:false, error:string}}
 */
export function transformDraft(draftText, { gitUserName, today }) {
  const eol = draftText.includes('\r\n') ? '\r\n' : '\n';
  const lines = draftText.split(/\r?\n/);

  let h1Idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    h1Idx = i;
    break;
  }
  if (h1Idx === -1) return { ok: false, error: 'draft is empty' };

  const h1 = lines[h1Idx].match(H1_RE);
  if (!h1) {
    return {
      ok: false,
      error:
        `the draft's first content line must be an ADR H1 (\`# ADR-NNNN — Title\`), got:\n  ${lines[h1Idx]}`,
    };
  }
  const [, number, title] = h1;

  let preambleEnd = lines.length;
  for (let i = h1Idx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      preambleEnd = i;
      break;
    }
  }

  const preamble = lines.slice(h1Idx + 1, preambleEnd);
  const removed = preamble.filter((l) => l.trimStart().startsWith('>'));
  const kept = [];
  for (const line of preamble) {
    if (line.trimStart().startsWith('>')) continue;
    if (line.trim() === '' && (kept.length === 0 || kept[kept.length - 1].trim() === '')) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

  const header = [
    lines[h1Idx],
    '',
    '**Status**: Accepted',
    `**Date**: ${today} — ${gitUserName}`,
    '',
  ];
  const body = [...kept, ...(kept.length > 0 ? [''] : []), ...lines.slice(preambleEnd)];
  let text = [...header, ...body].join(eol);
  if (!text.endsWith(eol)) text += eol;

  return { ok: true, text, number, title, removed: removed.join(eol) };
}

/**
 * Renders the plan the human reads before typing the word. Pure — the plan
 * shown and the plan applied are one value, not two code paths.
 *
 * @param {object} plan
 * @returns {string}
 */
export function renderPlan(plan) {
  const lines = [
    '',
    '─── PLAN ── new ADR ────────────────────────────────────────────────────────',
    '',
    `  draft        ${plan.draftPath}`,
    `  destination  ${plan.destination}`,
    '',
    '  header — BEFORE (removed):',
    ...(plan.headerBefore ? plan.headerBefore.split('\n').map((l) => `    ${l}`) : ['    (none)']),
    '',
    '  header — AFTER (inserted):',
    ...plan.headerAfter.split('\n').map((l) => `    ${l}`),
    '',
    `  ${HOME_PATH} — insert:`,
    `    ${plan.homeLine}`,
    `  immediately after:`,
    `    ${plan.homeAfterLine ?? '(the section heading)'}`,
    '',
    `  ${plan.agentsPath} — regenerated from the ${SOURCE_DOCS.length} SOURCE_DOCS`,
    `                 (${HOME_PATH} is one of them, so the entry above cascades here)`,
    '',
    '  This verb STAGES the three files. It does not commit and does not push.',
    '',
  ];
  return lines.join('\n');
}

/**
 * Renders the amendment plan — every act, before and after, in the order they
 * are applied. Pure, for the same reason renderPlan is: the plan shown and the
 * plan applied are one value.
 *
 * @param {object} plan
 * @returns {string}
 */
export function renderAmendmentPlan(plan) {
  const { contract, acts, date } = plan;
  const block = (label, text) =>
    text === null
      ? []
      : [`    ${label}`, ...String(text).split('\n').map((l) => `      ${l}`)];

  const lines = [
    '',
    '─── PLAN ── in-place amendment (consolidation-protocol.md §1c) ─────────────',
    '',
    `  draft        ${plan.draftPath}`,
    `  target       ${contract.target}`,
    `  shape        ${contract.isAdr ? `ADR — Amendment ${contract.amendment}, stamped ${date}` : 'doctrine document'}`,
    '',
  ];
  if (plan.cascadeComplete) {
    lines.push(
      '  Every §1c act is already applied to the target and to brain/HOME.md.',
      '  What is missing is §1d act 3 — the AGENTS.md regeneration — so that is all',
      '  this run writes.',
      '',
    );
  }
  for (const a of acts) {
    lines.push(`  act ${a.act} — ${a.what}${a.state === 'done' ? ' — ALREADY APPLIED' : ''}:`);
    if (a.state !== 'done') {
      lines.push(...block('BEFORE:', a.before));
      // Act 3 appends into a signed artefact, so the WHOLE section is shown. The
      // heading alone let `body-end:` swallow the tail of the draft with the
      // confirmation surface showing one line of it.
      lines.push(...block(a.before === null ? 'APPEND:' : 'AFTER:', a.before === null ? plan.body : a.after));
    }
    lines.push('');
  }
  lines.push(
    plan.agentsChanged
      ? `  ${plan.agentsPath} — regenerated from the ${SOURCE_DOCS.length} SOURCE_DOCS`
      : `  ${plan.agentsPath} — recompiled, byte-identical (the target is not one of the ${SOURCE_DOCS.length} SOURCE_DOCS)`,
    '                 (§1d act 3 — the step a hand-rolled promoter forgot, #529)',
    '',
    `  This verb STAGES ${plan.writeCount} file(s). It does not commit and does not push.`,
    '',
  );
  return lines.join('\n');
}

// ── The single git seam ──────────────────────────────────────────────────────

/**
 * Runs one allow-listed git subcommand. The ONLY place this module spawns
 * anything. Lock 3: a subcommand outside ALLOWED_GIT_SUBCOMMANDS throws before
 * the spawn is reached.
 *
 * @param {string} subcommand
 * @param {string[]} args
 * @param {{cwd:string, spawnFn?:Function}} opts
 * @returns {{ok:boolean, stdout:string, stderr:string}}
 */
export function runGit(subcommand, args, { cwd, spawnFn = spawnSync }) {
  if (!ALLOWED_GIT_SUBCOMMANDS.includes(subcommand)) {
    throw new Error(
      `brain:promote refuses to run "git ${subcommand}". ` +
        `Allowed: ${ALLOWED_GIT_SUBCOMMANDS.join(', ')}. ` +
        'Producing the commit IS the human signature; a tool that produces it has taken it.',
    );
  }
  const r = spawnFn('git', [subcommand, ...args], { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ── The verb ─────────────────────────────────────────────────────────────────

/**
 * Runs the read-confirm-stage flow.
 *
 * @param {object} ctx
 * @param {string[]} ctx.argv        Arguments after the script name.
 * @param {boolean} ctx.isTTY        Whether stdin is an interactive terminal.
 * @param {string}  ctx.root         Repo root (defaults to the process cwd at the entry point).
 * @param {Function} ctx.readLineFn  async () => string|null — reads the typed confirmation.
 * @param {Function} [ctx.gitUserNameFn]
 * @param {Function} [ctx.todayFn]
 * @param {Function} [ctx.stageFn]   (relPaths) => {ok, stderr}
 * @param {Function} [ctx.writeFileFn] (absPath, text) => void — the cascade's single
 *        write primitive. Injectable for the same reason stageFn is: the rollback
 *        path has to be provable without depending on a privilege the test
 *        environment may not have (a read-only mode bit does not bite as root).
 * @param {Function} [ctx.write]     (chunk) => void
 * @returns {Promise<{exitCode:number, output:string, wrote:string[], staged:string[]}>}
 */
export async function runPromote({
  argv,
  isTTY,
  root,
  readLineFn,
  gitUserNameFn,
  todayFn = () => new Date().toISOString().slice(0, 10),
  stageFn,
  writeFileFn = (abs, text) => writeFileSync(abs, text, 'utf8'),
  write = () => {},
}) {
  let output = '';
  const say = (chunk) => {
    output += `${chunk}\n`;
    write(`${chunk}\n`);
  };
  const done = (exitCode, wrote = [], staged = []) => ({ exitCode, output, wrote, staged });

  // ── LOCK 1 — before anything is read, before anything is written ───────────
  // Consulted exactly ONCE, here. A second copy of this predicate is how two
  // rules drift apart; the guarantee that this one cannot be dropped is
  // behavioural (a real non-TTY child process), not a duplicate check.
  if (!isTTY) {
    say('✗ brain:promote requires an interactive terminal (stdin is not a TTY).');
    say('');
    say('  Promotion into brain/ is a human signature. This verb exists to remove the');
    say('  mechanics from that act, never the act itself, so it will not run unattended.');
    say('');
    say('  This is a speed bump, not a wall: a pty defeats it. The enforcement that');
    say('  matters is brain-writes-reviewed (L6) at the PR level, and CODEOWNERS.');
    return done(2);
  }

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    say(`✗ ${parsed.error}`);
    return done(2);
  }
  const { draftPath } = parsed;

  const draftAbs = join(root, draftPath);
  if (!existsSync(draftAbs)) {
    say(`✗ draft not found: ${draftPath}`);
    return done(1);
  }
  const draftText = readFileSync(draftAbs, 'utf8');

  // ── Shape dispatch — ONE flow, two planners ───────────────────────────────
  // The SHAPE is decided before anything else about the environment is read:
  // an unpromotable draft name must report its own reason, not whichever
  // unrelated precondition happens to be checked first.
  // #809: a migration draft is detected FIRST, by basename — it is never a
  // destinationFor candidate and never an amendment.
  const isMigration = MIGRATION_DRAFT_BASENAME_RE.test(basename(draftPath));
  const isAmendment = !isMigration && destinationFor(draftPath) === null;
  const shapeRefusal = isAmendment ? amendmentShapeRefusal(draftPath, draftText) : null;
  if (shapeRefusal) {
    for (const line of shapeRefusal) say(line);
    return done(1);
  }

  const gitUserName = (
    gitUserNameFn
      ? gitUserNameFn()
      : runGit('config', ['user.name'], { cwd: root }).stdout
  ).trim();
  if (gitUserName === '') {
    say('✗ git config user.name is empty — refusing to stamp a nameless Date line.');
    say('  Set it first:  git config user.name "Your Name"');
    return done(1);
  }

  // Both planners return the same value: the files to write, the plan text to
  // show, and the commit command to print. Everything after this point — the
  // confirmation, the writes, the staging, the printed command — happens once.
  const ctx = { root, draftPath, draftText, gitUserName, today: todayFn() };
  const planned = isMigration
    ? await planMigrationPromotion(ctx)
    : isAmendment ? planAmendmentPromotion(ctx) : planNewAdrPromotion(ctx);

  if (!planned.ok) {
    for (const line of planned.lines) say(line);
    return done(planned.exitCode ?? 1);
  }
  if (planned.noop) {
    for (const line of planned.lines) say(line);
    return done(0);
  }

  // ── Write preconditions — read-only, and BEFORE the plan is shown ─────────
  // Everything here is a state the verb must not write into. Checked before the
  // human is asked to confirm, so the refusal costs them nothing.
  const guard = checkWritePreconditions({
    root,
    writes: planned.writes,
    gitStatus: (paths) => runGit('status', ['--porcelain', '--', ...paths], { cwd: root }),
  });
  if (!guard.ok) {
    for (const line of guard.lines) say(line);
    return done(1);
  }

  // ── Content guards — the same slot, one step further in (#675, #674) ───────
  // checkWritePreconditions asks whether the verb may write these paths. This
  // asks whether what it would write into them is well formed — a question the
  // verb did not ask at all, and answered wrong twice on one promotion:
  // a signed ADR with two `**Status**:` lines, and a shipped file naming a host
  // no consumer can resolve. Read-only, before the plan, before the typed word,
  // so a refusal costs the human nothing and leaves nothing staged.
  const content = checkShippedContent({ writes: planned.writes });
  if (!content.ok) {
    for (const line of content.lines) say(line);
    return done(1);
  }

  // ── Step 1: the human reads what they are signing ─────────────────────────
  say('');
  say(`─── DRAFT: ${draftPath} ─────────────────────────────────────────────`);
  say('');
  say(draftText.replace(/\n$/, ''));

  // ── Step 2: the exact plan ────────────────────────────────────────────────
  say(planned.planText.replace(/\n$/, ''));
  // Reported, never inferred from silence: which questions were asked about the
  // bytes, and — when the answer is none — that none were (#674 req 5).
  say(content.summary.replace(/\n$/, ''));
  if (guard.dirty.length > 0) {
    say('  ⚠ these files ALREADY differ from HEAD, and staging takes the whole file —');
    say('    the change below is not all that will be in the commit:');
    for (const d of guard.dirty) say(`      ${d}`);
    say('');
  }

  // ── Step 3: the typed confirmation ────────────────────────────────────────
  say(`Type ${CONFIRMATION_WORD} to apply this plan. Anything else aborts with no writes.`);
  const answer = await readLineFn();
  if (typeof answer !== 'string' || answer.trim() !== CONFIRMATION_WORD) {
    say('');
    say('✗ aborted — nothing was written.');
    return done(1);
  }

  // ── Step 4: apply, then STOP at the index ─────────────────────────────────
  // The cascade is written all-or-nothing. writeFileSync can fail on the second
  // of three files (a read-only file, a full disk, a permission change) and the
  // first version of this loop left the ADR amended, brain/HOME.md untouched and
  // nothing staged — a half-applied signed artefact the human then had to repair
  // by hand, which is the act this verb exists to remove.
  const applied = [];
  try {
    for (const file of planned.writes) {
      const abs = join(root, file.relPath);
      applied.push({ abs, previous: existsSync(abs) ? readFileSync(abs, 'utf8') : null });
      writeFileFn(abs, file.text);
    }
  } catch (error) {
    let restored = 0;
    let failedToRestore = null;
    for (const { abs, previous } of applied.reverse()) {
      try {
        if (previous !== null) writeFileFn(abs, previous);
        restored += 1;
      } catch (restoreError) {
        failedToRestore = `${abs}: ${restoreError.message}`;
      }
    }
    say('');
    say(`✗ writing the cascade failed: ${error.message}`);
    say(`  Rolled back ${restored} of ${applied.length} file(s) already written. Nothing was staged.`);
    if (failedToRestore) {
      say(`  ⚠ COULD NOT restore ${failedToRestore}`);
      say('    Check `git status` and `git checkout --` the paths above before re-running.');
    }
    return done(1);
  }
  const wrote = planned.writes.map((f) => f.relPath);

  const staged = stageFn
    ? (stageFn(wrote), wrote)
    : (runGit('add', ['--', ...wrote], { cwd: root }).ok ? wrote : []);

  say('');
  say(`✓ staged ${staged.length} file(s):`);
  for (const p of staged) say(`    ${p}`);

  // ── Step 5: print the command and stop. Running it is the signature. ──────
  say('');
  say('Review the staged diff, then commit AS YOURSELF:');
  say('');
  say(`  git diff --cached`);
  say(`  ${planned.commitCommand}`);
  if (!issueNumberFor(draftPath) && !planned.hasIssue) {
    say('');
    say('  ⚠ the issue number could not be read from the draft path — replace the');
    say('    placeholder above, or commit-msg will reject the message.');
  }
  say('');
  return done(0, wrote, staged);
}

// ── The migration arm (#809) ────────────────────────────────────────────────

const MIGRATIONS_REL = 'brain/core/config-migrations.mjs';

/**
 * planMigrationPromotion() — issue #809, proposal D1-D3. Parses the
 * `brain-migration/1` block, computes the number per #806 (shown, then signed
 * — never silently), splices, and PROVES the candidate by importing it and
 * running `migrateConfig` over the result BEFORE the plan is offered: a plan
 * whose proof already failed is never put in front of a human to sign.
 *
 * Async where its siblings are sync because the proof is a real `import()` —
 * the one honest way to ask "does this file still parse and migrate".
 */
async function planMigrationPromotion({ root, draftPath, draftText }) {
  const { entry, refusal } = parseMigrationDraft(draftText);
  if (refusal) return { ok: false, lines: [`✗ ${refusal}`] };

  const draftVersion = basename(draftPath).match(MIGRATION_DRAFT_BASENAME_RE)[1];

  let packageVersion;
  try {
    packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch (error) {
    return { ok: false, lines: [`✗ package.json unreadable at ${root} — ${error.message}`] };
  }

  const targetAbs = join(root, MIGRATIONS_REL);
  if (!existsSync(targetAbs)) return { ok: false, lines: [`✗ ${MIGRATIONS_REL} not found.`] };
  const fileText = readFileSync(targetAbs, 'utf8');

  let current;
  try {
    current = await import(`${pathToFileURL(targetAbs).href}?promote=${Date.now()}`);
  } catch (error) {
    return { ok: false, lines: [`✗ the CURRENT ${MIGRATIONS_REL} does not import (${error.message}) — fix the file before promoting into it.`] };
  }
  const tail = current.migrations?.[current.migrations.length - 1]?.version;
  if (typeof tail !== 'string') {
    return { ok: false, lines: [`✗ ${MIGRATIONS_REL} exports no readable migrations tail — refusing to number against a list this verb cannot see.`] };
  }

  const { version, renumbered } = proposeVersion({ draftVersion, packageVersion, tailVersion: tail });

  const spliced = spliceMigrationEntry(fileText, entry, version);
  if (spliced.refusal) return { ok: false, lines: [`✗ ${spliced.refusal}`] };

  // D3 — the proof, BEFORE the plan. The candidate must import and migrate.
  // The proof dir dies with the proof (#842): the module is already loaded
  // when the finally runs, so removal is safe on every path.
  let proofDir = null;
  try {
    proofDir = mkdtempSync(join(tmpdir(), 'brain-promote-proof-'));
    const proofPath = join(proofDir, 'candidate.mjs');
    writeFileSync(proofPath, spliced.next, 'utf8');
    const mod = await import(pathToFileURL(proofPath).href);
    const { applied } = migrateConfig({}, mod.migrations, version);
    if (!applied.includes(version)) {
      return { ok: false, lines: [`✗ the proof import succeeded but migrateConfig did not apply ${version} — the spliced entry is not reachable. Nothing was staged.`] };
    }
  } catch (error) {
    return { ok: false, lines: [
      `✗ the candidate could not prove itself — import/migrate failed: ${error.message}`,
      '  Nothing was written or staged. The current file is untouched.',
    ] };
  } finally {
    if (proofDir !== null) {
      try { rmSync(proofDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  const issue = issueNumberFor(draftPath);
  const numberLine = renumbered
    ? `draft says ${draftVersion} → promoting as ${version} (#806: next-minor above package ${packageVersion} / tail ${tail})`
    : `promoting as ${version} (the draft's own number — already the #806 answer)`;

  const planText = [
    '',
    '─── PLAN ── config migration (issue #809) ──────────────────────────────────',
    '',
    `  ${numberLine}`,
    `  append one declarative entry to ${MIGRATIONS_REL}:`,
    `    version:     ${version}`,
    `    description: ${entry.description}`,
    `    defaults:    ${JSON.stringify(entry.defaults)}`,
    '',
    '  proof already ran: the candidate imports, and migrateConfig applies the',
    '  new version over an empty config. What you sign is a verified result.',
    '',
  ].join('\n');

  return {
    ok: true,
    writes: [{ relPath: MIGRATIONS_REL, text: spliced.next }],
    planText,
    hasIssue: Boolean(issue),
    commitCommand: `git commit -m "chore(core): config migration ${version} — ${entry.description.replace(/"/g, "'").slice(0, 60)} (#${issue ?? 'NNN'})"`,
  };
}

// ── Write preconditions ──────────────────────────────────────────────────────

/**
 * Every state the verb must not write into, read BEFORE the confirmation.
 *
 * Three findings live here, each reproduced end-to-end:
 *
 *  1. **`git add` on an unmerged path RESOLVES the conflict.** Lock 3 treats
 *     `git add` as inert; on a `UU` path it is not. Run mid-rebase, the verb
 *     staged `<<<<<<<` markers into `brain/HOME.md` and into the `AGENTS.md`
 *     compiled from it, and left git believing the conflict was settled. The
 *     check is repo-wide, not per-path: `AGENTS.md` is compiled from five
 *     SOURCE_DOCS, so a conflict in any of them compiles markers into it.
 *  2. **A staged-but-uncommitted edit to a write path is destroyed.** The
 *     worktree write overwrites it and `git add` replaces the index entry;
 *     index-only content has no reflog and no recovery. Refused.
 *  3. **A symlinked target writes outside the repository.** The path check is
 *     lexical and `writeFileSync` follows symlinks, so an out-of-repo file was
 *     rewritten with `git status` showing nothing — outside the stage-only lock
 *     entirely. Every write path must resolve, via realpath, to a regular file
 *     inside the repo.
 *
 * Worktree-only modifications are NOT refused: they are recoverable with
 * `git checkout --`, and refusing them would block a human with an unrelated
 * edit in flight. They are DISCLOSED instead, because staging takes the whole
 * file and the commit will carry them.
 *
 * @param {{root:string, writes:{relPath:string}[], gitStatus:Function}} ctx
 * @returns {{ok:true, dirty:string[]}|{ok:false, lines:string[]}}
 */
export function checkWritePreconditions({ root, writes, gitStatus }) {
  const paths = writes.map((w) => w.relPath);

  // ── Containment: realpath, and a regular file ─────────────────────────────
  let repoReal;
  try {
    repoReal = realpathSync(root);
  } catch {
    return { ok: false, lines: [`✗ the repository root could not be resolved: ${root}`] };
  }
  for (const rel of paths) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue; // a new file inside the repo — nothing to resolve yet.
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      return {
        ok: false,
        lines: [
          `✗ ${rel} is a SYMLINK.`,
          '  Writing through it would land outside the staged tree — unstaged, invisible to',
          '  `git status`, and outside the only lock this verb has. Refusing.',
        ],
      };
    }
    if (!stat.isFile()) {
      return { ok: false, lines: [`✗ ${rel} is not a regular file. Refusing to write through it.`] };
    }
    const real = realpathSync(abs);
    if (real !== join(repoReal, rel) && !real.startsWith(`${repoReal}/`)) {
      return {
        ok: false,
        lines: [
          `✗ ${rel} resolves to ${real}, which is outside this repository.`,
          '  This verb stages what it writes; it cannot stage a path git does not track.',
        ],
      };
    }
  }

  // ── Repo-wide unmerged paths ──────────────────────────────────────────────
  const all = gitStatus([]);
  if (!all.ok) {
    return {
      ok: false,
      lines: [
        '✗ `git status` failed — refusing to write into a repository whose state cannot be read.',
        `  ${all.stderr.trim() || 'no stderr'}`,
      ],
    };
  }
  const unmerged = all.stdout
    .split('\n')
    .filter((l) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(l))
    .map((l) => l.slice(3));
  if (unmerged.length > 0) {
    return {
      ok: false,
      lines: [
        `✗ this repository has ${unmerged.length} unmerged path(s) — a merge or rebase is in progress:`,
        ...unmerged.map((p) => `    ${p}`),
        '',
        '  `git add` on an unmerged path marks the conflict RESOLVED, so this verb would',
        '  stage conflict markers into signed doctrine and into the AGENTS.md compiled from',
        '  it. Finish the merge first, then re-run.',
      ],
    };
  }

  // ── Staged-but-uncommitted content on a write path ────────────────────────
  const mine = gitStatus(paths);
  if (!mine.ok) {
    return { ok: false, lines: ['✗ `git status` failed for the paths this run would write.'] };
  }
  const staged = [];
  const dirty = [];
  for (const line of mine.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [x, y] = [line[0], line[1]];
    const path = line.slice(3);
    if (x !== ' ' && x !== '?') staged.push(`${path} (index: ${x})`);
    if (y !== ' ' && y !== '?') dirty.push(`${path} (worktree: ${y})`);
  }
  if (staged.length > 0) {
    return {
      ok: false,
      lines: [
        '✗ these files have STAGED changes this run would destroy:',
        ...staged.map((p) => `    ${p}`),
        '',
        '  The verb overwrites the working tree and re-stages the whole file, so an',
        '  index-only edit is gone with no reflog entry and no way back. Commit or unstage',
        '  it first (`git restore --staged <path>`), then re-run.',
      ],
    };
  }

  return { ok: true, dirty };
}

// ── The two planners ─────────────────────────────────────────────────────────

/**
 * Compiles AGENTS.md from the five SOURCE_DOCS, with the in-flight edits
 * substituted for the versions on disk.
 *
 * The map is built by ITERATING SOURCE_DOCS, so every key compileAgentsMd reads
 * is present by construction — an array, the shape a new caller reaches for
 * first, used to compile silently into empty sections (#509, design D6).
 *
 * @param {string} root
 * @param {{[relPath:string]: string}} overrides
 * @returns {string}
 */
function compileAgentsWith(root, overrides) {
  const docs = {};
  for (const rel of SOURCE_DOCS) {
    docs[rel] = Object.prototype.hasOwnProperty.call(overrides, rel)
      ? overrides[rel]
      : readFileSync(join(root, rel), 'utf8');
  }
  return compileAgentsMd(docs);
}

/**
 * Slice 1 (#378) — promote a draft into a NEW signed ADR file.
 *
 * @param {{root:string, draftPath:string, draftText:string, gitUserName:string, today:string}} ctx
 * @returns {{ok:true, writes:{relPath:string,text:string}[], planText:string, commitCommand:string}
 *          |{ok:false, lines:string[], exitCode?:number}}
 */
function planNewAdrPromotion({ root, draftPath, draftText, gitUserName, today }) {
  const destination = destinationFor(draftPath);
  const destAbs = join(root, destination);
  if (existsSync(destAbs)) {
    return {
      ok: false,
      lines: [
        `✗ ${destination} already exists — refusing to overwrite a signed artifact.`,
        '  Pick a free ADR number and rename the draft.',
        '',
        '  Amending an already-signed artefact is the OTHER shape: name the draft',
        `  \`*${AMENDMENT_DRAFT_SUFFIX}\` and give it a \`${CONTRACT_TAG}\` block (§1c).`,
      ],
    };
  }

  const transformed = transformDraft(draftText, { gitUserName, today });
  if (!transformed.ok) return { ok: false, lines: [`✗ ${transformed.error}`] };

  const filenameNumber = basename(draftPath).match(DRAFT_BASENAME_RE)[1];
  if (filenameNumber !== transformed.number) {
    return {
      ok: false,
      lines: [
        `✗ ADR number mismatch: the filename says ${filenameNumber}, the H1 says ${transformed.number}.`,
        '  adrPresence keys on the path and brain/HOME.md keys on the title — they must agree.',
      ],
    };
  }

  const homeText = readFileSync(join(root, HOME_PATH), 'utf8');
  const slug = basename(draftPath).replace(/\.md$/, '');
  const patched = insertAdrLink(homeText, {
    number: transformed.number,
    slug,
    description: transformed.title,
  });
  if (!patched.inserted) {
    const lines = [`✗ ${HOME_PATH} could not be patched — reason: ${patched.reason}.`];
    if (patched.reason === 'already-present') {
      lines.push(`  ADR-${transformed.number} is already indexed while its file does not exist.`);
      lines.push('  That inconsistency wants a human, not an automatic repair.');
    } else {
      lines.push("  Could not locate an unambiguous '### Architecture decisions' anchor.");
    }
    return { ok: false, lines };
  }

  const homeLines = patched.text.split(/\r?\n/);
  const homeLine = homeLines.find((l) => l.includes(`](project/decisions/${slug}.md)`));
  const homeAfterLine = homeLines[homeLines.indexOf(homeLine) - 1];

  return {
    ok: true,
    writes: [
      { relPath: destination, text: transformed.text },
      { relPath: HOME_PATH, text: patched.text },
      { relPath: AGENTS_EMIT_PATH, text: compileAgentsWith(root, { [HOME_PATH]: patched.text }) },
    ],
    planText: renderPlan({
      draftPath,
      destination,
      headerBefore: transformed.removed,
      headerAfter: `**Status**: Accepted\n**Date**: ${today} — ${gitUserName}`,
      homeLine,
      homeAfterLine,
      agentsPath: AGENTS_EMIT_PATH,
    }),
    commitCommand: buildCommitCommand({
      number: transformed.number,
      title: transformed.title,
      issue: issueNumberFor(draftPath),
    }),
  };
}

/**
 * Slice 2 (#509) — amend an ALREADY-SIGNED brain/** file in place: the three
 * §1c acts, the brain/HOME.md marker for the ADR shape, and §1d's AGENTS.md
 * regeneration, computed as one plan. It refuses rather than guesses — an
 * anchor found ≠ 1 times, an amendment number that does not follow the one the
 * target carries, or an ambiguous index line all stop the run with nothing
 * written.
 *
 * @param {{root:string, draftPath:string, draftText:string, gitUserName:string, today:string}} ctx
 * @returns {{ok:true, writes:{relPath:string,text:string}[], planText:string, commitCommand:string}
 *          |{ok:true, noop:true, lines:string[]}
 *          |{ok:false, lines:string[]}}
 */
export function amendmentShapeRefusal(draftPath, draftText) {
  if (!basename(draftPath).endsWith(AMENDMENT_DRAFT_SUFFIX)) {
    return [
      `✗ '${basename(draftPath)}' is not a promotable draft name.`,
      '',
      '  A NEW ADR draft is named adr-NNNN-<lowercase-slug>.md.',
      `  An AMENDMENT draft is named *${AMENDMENT_DRAFT_SUFFIX} and carries one`,
      `  \`${CONTRACT_TAG}\` block naming its target (consolidation-protocol.md §1c).`,
    ];
  }
  const parsed = parseAmendmentDraft(draftText);
  if (parsed.ok) return null;
  return parsed.absent
    ? [
        `✗ ${basename(draftPath)} carries no \`${CONTRACT_TAG}\` block.`,
        '',
        '  An amendment draft declares its target and its anchors in a machine-readable',
        '  contract — prose plus line references is what a human applies by hand, and',
        '  the two hand-rolled promoters that did so each dropped a cascade step.',
      ]
    : [`✗ ${parsed.error}`];
}

function planAmendmentPromotion({ root, draftPath, draftText, gitUserName, today }) {
  const targetRel = parseAmendmentDraft(draftText).contract.target;

  const targetAbs = join(root, targetRel);
  if (!existsSync(targetAbs)) {
    return {
      ok: false,
      lines: [
        `✗ target not found: ${targetRel}`,
        '  This verb amends an artefact that is already signed. To create a new one,',
        '  name the draft adr-NNNN-<lowercase-slug>.md.',
      ],
    };
  }

  const targetText = readFileSync(targetAbs, 'utf8');
  const homeAbs = join(root, HOME_PATH);
  const homeText = existsSync(homeAbs) ? readFileSync(homeAbs, 'utf8') : null;

  const result = planAmendment({
    draftText,
    targetText,
    homeText,
    gitUserName,
    today,
    issueFallback: issueNumberFor(draftPath),
  });
  if (!result.ok) {
    return { ok: false, lines: [`✗ ${result.error}`] };
  }

  // ── Every §1c act is applied — but §1d act 3 is part of the cascade too ───
  // "Already promoted" is a claim about the WHOLE cascade. A tree whose ADR and
  // brain/HOME.md are amended while AGENTS.md is stale is not promoted, it is
  // one act short, and that is the act a hand-rolled promoter loses (#529).
  if (result.cascadeComplete) {
    const agentsText = compileAgentsWith(root, {});
    const agentsAbs = join(root, AGENTS_EMIT_PATH);
    if (existsSync(agentsAbs) && readFileSync(agentsAbs, 'utf8') === agentsText) {
      return {
        ok: true,
        noop: true,
        lines: [
          `✓ already promoted — every act of ${result.contract.target}'s cascade is applied,`,
          '  AGENTS.md included. Nothing was written.',
        ],
      };
    }
    return {
      ok: true,
      hasIssue: Boolean(result.contract.issue),
      writes: [{ relPath: AGENTS_EMIT_PATH, text: agentsText }],
      planText: renderAmendmentPlan({
        contract: result.contract,
        date: formatStampDate(today),
        acts: result.acts,
        draftPath,
        agentsPath: AGENTS_EMIT_PATH,
        agentsChanged: true,
        cascadeComplete: true,
        writeCount: 1,
      }),
      commitCommand: `git commit -m ${shellQuote(
        amendmentCommitSubject({ contract: result.contract, bodyHeading: result.contract.bodyHeading }),
      )}`,
    };
  }

  const { plan } = result;
  const overrides = { [plan.contract.target]: plan.targetText };
  if (plan.homeText !== null) overrides[HOME_PATH] = plan.homeText;

  const writes = [{ relPath: plan.contract.target, text: plan.targetText }];
  if (plan.homeText !== null) writes.push({ relPath: HOME_PATH, text: plan.homeText });

  // §1d act 3 — ALWAYS computed, never skipped. Written only when it DIFFERS: a
  // target outside the five SOURCE_DOCS compiles to the same bytes, and staging
  // a no-op would make the verb report a file the human will not find in
  // `git diff --cached`.
  const agentsText = compileAgentsWith(root, overrides);
  const agentsAbs = join(root, AGENTS_EMIT_PATH);
  const agentsChanged = !existsSync(agentsAbs) || readFileSync(agentsAbs, 'utf8') !== agentsText;
  if (agentsChanged) writes.push({ relPath: AGENTS_EMIT_PATH, text: agentsText });

  return {
    ok: true,
    hasIssue: Boolean(plan.contract.issue),
    writes,
    planText: renderAmendmentPlan({
      ...plan,
      draftPath,
      agentsPath: AGENTS_EMIT_PATH,
      agentsChanged,
      writeCount: writes.length,
    }),
    commitCommand: `git commit -m ${shellQuote(plan.commitSubject)}`,
  };
}

// ── CLI entry point — the only I/O layer ─────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runPromote({
    argv: process.argv.slice(2),
    isTTY: Boolean(process.stdin.isTTY),
    root: process.cwd(),
    readLineFn: async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await new Promise((resolve) => rl.question('> ', resolve));
      } finally {
        rl.close();
      }
    },
    write: (chunk) => process.stdout.write(chunk),
  });
  process.exit(result.exitCode);
}
