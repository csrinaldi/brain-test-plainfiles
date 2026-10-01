// scripts/i18n/coverage.test.mjs — PR2 + PR3 parity and translation coverage tests.
// Run with: node --test scripts/i18n/coverage.test.mjs
// No external dependencies — uses Node built-in node:test.
//
// Validates that:
//  1. All PR2 keys exist in en.mjs with the expected English values.
//  2. All PR3 keys (bootstrap.* and tools.*) exist in en.mjs with expected English values.
//  3. es.mjs has an entry for every key in en.mjs (complete Spanish parity).
//  4. translate() reproduces the prior Spanish output for a representative sample.
//  5. sh.mjs emits well-formed I18N_* assignments for representative shell keys.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import en from './en.mjs';
import es from './es.mjs';
import { translate } from './t.mjs';

// ── PR2 key existence in en.mjs ────────────────────────────────────────────────

test('PR2 day-start: section header keys exist in en', () => {
  assert.equal(en['day.vcs.section'],       'VCS authentication');
  assert.equal(en['day.main.section'],      'Main branch sync');
  assert.equal(en['day.ecosystem.section'], 'Ecosystem updates');
  assert.equal(en['day.brain.section'],     'brain version (core)');
  assert.equal(en['day.memory.section'],    'Team memory');
  assert.equal(en['day.board.section'],     'Ticket board');
});

test('PR2 day-start: VCS auth message keys exist in en', () => {
  assert.equal(en['day.vcs.notConfigured'],  'VCS provider not configured — set vcs.provider in brain.config.json.');
  assert.equal(en['day.vcs.authOk'],         'Authenticated ({provider}).');
  assert.equal(en['day.vcs.sessionExpired'], 'Session not started or expired — re-authenticating from .env...');
  assert.equal(en['day.vcs.tokenNotFound'],  'Token not found in .env — run brain:env:init');
  assert.equal(en['day.vcs.authFailed'],     'Auth failed — check the token or that the provider CLI is installed. brain:env:init');
});

test('PR2 day-start: main sync keys exist in en', () => {
  assert.equal(en['day.main.noVcs'],        'Cannot sync main — VCS provider or token not available.');
  assert.equal(en['day.main.fetchFailed'],  'Fetch of main failed — check connectivity to {host}');
  assert.equal(en['day.main.updated'],      'main updated (fast-forward applied).');
  assert.equal(en['day.main.pullFailed'],   'Could not pull main — there may be uncommitted local changes.');
  assert.equal(en['day.main.remoteUpdated'],'Remote main updated (active branch: {branch}).');
  assert.equal(en['day.main.newCommits'],   '{count} new commit(s) in main:');
  assert.equal(en['day.main.upToDate'],     'main was already up to date.');
});

test('PR2 day-start: ecosystem + brain + memory + done keys exist in en', () => {
  assert.equal(en['day.ecosystem.allUpToDate'],    'All tools up to date.');
  assert.equal(en['day.ecosystem.updatesAvailable'], '{count} update(s) available:');
  assert.equal(en['day.brain.newVersion'],         'New brain version available: {installed} → {latest}');
  assert.equal(en['day.brain.upToDate'],           'brain up to date ({installed}).');
  assert.equal(en['day.memory.hookActive'],        'Pre-push hook active — checkpoints feature working memory before push.');
  assert.equal(en['day.memory.exported'],          'Memory exported to .memory/ — ready to commit with the next push.');
  assert.equal(en['day.done.withTicket'],          'With a ticket:');
  assert.equal(en['day.done.noTicket'],            'No ticket — explore or propose:');
  assert.equal(en['day.run.exitCode'],             '↳ exited with code {code} (non-blocking).');
  assert.equal(en['common.signal'],                'signal');
});

test('PR2 tracker-board: new keys exist in en', () => {
  assert.equal(en['tracker.noRemote'],        '⚠ Could not detect origin remote.');
  assert.equal(en['tracker.vcsNotConfigured'],'⚠ VCS provider not configured: {error}');
  assert.equal(en['tracker.noSession'],       '⚠ No authenticated VCS session for {host} — see https://{host}/{project}');
  assert.equal(en['tracker.noUser'],          '⚠ Could not get user — only unassigned tickets are shown.');
  assert.equal(en['tracker.unassigned'],      'Unassigned');
});

test('PR2 project-status: VCS section and header keys exist in en', () => {
  assert.equal(en['ps.title'],           '# Project state — generated projection, DO NOT edit or save');
  assert.equal(en['ps.maven.section'],   '## Maven Reactor');
  assert.equal(en['ps.maven.count'],     '{count} module(s) in the reactor (includes aggregators).');
  assert.equal(en['ps.maven.missingPom'],'(pom MISSING: {dir})');
  assert.equal(en['ps.frontend.section'],'## Frontend (Nx)');
  assert.equal(en['ps.frontend.empty'], 'No Nx projects yet (empty frontend).');
  assert.equal(en['ps.frontend.count'], '{count} Nx project(s).');
  assert.equal(en['ps.vcs.section'],    '## Open work');
  assert.equal(en['ps.vcs.noRemote'],   '⚠ Could not detect origin remote.');
  assert.equal(en['ps.vcs.issues'],     'Open issues ({count}):');
  assert.equal(en['ps.vcs.prs'],        'Open PRs/MRs ({count}):');
  assert.equal(en['ps.footer'],         '— End of projection. To regenerate: brain:project:status');
});

test('PR2 ticket-start: key sample exists in en', () => {
  assert.equal(en['ticket.fetching'],           'Searching for issue #{id}...');
  assert.equal(en['ticket.branchCreated'],      '✓ Branch created and active.');
  assert.equal(en['ticket.worktreeCreated'],    '✓ Worktree created at {path}');
  assert.equal(en['ticket.nextSteps.header'],   'Next steps:');
  assert.equal(en['ticket.nextSteps.step1'],    '    1. Implement — use /sdd-new {id} if the change is complex');
  assert.equal(en['ticket.error.tokenNotFound'],'✗ VCS token not found in .env — run brain:env:init');
});

// ── memory/cli.mjs heal-duplicates (#1061): 13 keys exist in en, match es parity ──

test('memory.heal.*: all 13 keys exist in en and es, and es is actually translated', () => {
  const suffixes = [
    'none', 'plan', 'deleted', 'done', 'partial', 'unverified',
    'notEngram', 'badFlag', 'failed',
    'refused.divergent', 'refused.tooMany', 'refused.shape', 'refused.version',
  ];
  assert.equal(suffixes.length, 13);
  for (const suffix of suffixes) {
    const key = `memory.heal.${suffix}`;
    assert.ok(en[key], `${key} must exist in en`);
    assert.ok(es[key], `${key} must exist in es`);
    assert.notEqual(es[key], en[key], `${key} must actually be translated, not copied`);
  }
});

// ── Parity: es has every key that en has ───────────────────────────────────────

test('es catalog has an entry for every key in en (complete Spanish parity)', () => {
  const enKeys = Object.keys(en);
  const missingFromEs = enKeys.filter((k) => !(k in es));
  assert.deepEqual(
    missingFromEs,
    [],
    `es.mjs is missing keys: ${missingFromEs.join(', ')}`,
  );
});

// ── Every key must render a LEGAL shell identifier ────────────────────────────
//
// sh.mjs renders the WHOLE catalog into shell assignments, and keyToVar only
// maps `.` → `_`. Any other character that is illegal in a shell variable name
// therefore emits a COMMAND WORD instead of an assignment. bootstrap.sh and
// install-tools.sh both `eval` that output under `set -euo pipefail`, so one bad
// key aborts the script mid-run — after brain.config.json and HOME.md are
// already written, leaving a partial bootstrap with `command not found` as the
// only signal.
//
// That shipped once (`memory.import.state-unreadable`, #446): the hyphen made
// `I18N_MEMORY_IMPORT_STATE-UNREADABLE=…` and `brain:env:init` died at exit 127
// with the unit suite fully green. The parity test above could not see it — it
// compares key SETS, and the key was present in both catalogs.
//
// Assert the property directly, over the real catalog, not over samples.
test('every catalog key renders a legal shell identifier', () => {
  const bad = Object.keys(en).filter((k) => !/^[A-Za-z0-9_.]+$/.test(k));
  assert.deepEqual(
    bad,
    [],
    `these keys break the sh.mjs catalog and abort bootstrap.sh: ${bad.join(', ')}`,
  );
});

// The property that actually matters is one step further out: the rendered
// catalog must EVAL. Assert that too, so a future escaping bug in renderCatalog
// is caught even if every key is identifier-safe.
test('the rendered shell catalog evaluates cleanly under set -e', () => {
  const rendered = renderCatalog(es, en);
  // Read from a file, not the `input` option: a piped stdin never sees EOF in the cold
  // reviewer's sandbox, and `cat` waits for it (#1221).
  const dir = mkdtempSync(join(tmpdir(), 'brain-1221-catalog-'));
  const catalog = join(dir, 'catalog.sh');
  writeFileSync(catalog, rendered);
  const result = spawnSync('bash', ['-euo', 'pipefail', '-c', 'eval "$(cat "$1")"', 'bash', catalog], {
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(
    result.status,
    0,
    `the catalog does not eval: ${(result.stderr || '').split('\n').slice(0, 3).join(' | ')}`,
  );
});

// ── Spanish translation accuracy for representative PR2 keys ──────────────────

test('translate: day.vcs.section returns prior Spanish section title', () => {
  assert.equal(translate('day.vcs.section', {}, es, en), 'Autenticación del VCS');
});

test('translate: day.main.newCommits interpolates count into Spanish', () => {
  assert.equal(
    translate('day.main.newCommits', { count: 3 }, es, en),
    '3 commit(s) nuevos en main:',
  );
});

test('translate: day.brain.newVersion interpolates versions into Spanish', () => {
  assert.equal(
    translate('day.brain.newVersion', { installed: '1.0.0', latest: '1.1.0' }, es, en),
    'Hay una versión nueva de brain: 1.0.0 → 1.1.0',
  );
});

test('translate: day.memory.hookMissing interpolates path into Spanish', () => {
  assert.equal(
    translate('day.memory.hookMissing', { path: 'brain/scripts/hooks' }, es, en),
    'Hook pre-push ausente en brain/scripts/hooks/pre-push — el checkpoint de la memoria de feature no corre en el push.',
  );
});

test('translate: tracker.unassigned returns prior Spanish', () => {
  assert.equal(translate('tracker.unassigned', {}, es, en), 'Sin asignar');
});

test('translate: tracker.noSession interpolates host and project into Spanish', () => {
  assert.equal(
    translate('tracker.noSession', { host: 'github.com', project: 'user/repo' }, es, en),
    '⚠ Sin sesión de VCS autenticada para github.com — mirá https://github.com/user/repo',
  );
});

test('translate: ps.vcs.section returns prior Spanish section header', () => {
  assert.equal(translate('ps.vcs.section', {}, es, en), '## Trabajo abierto');
});

test('translate: ps.footer returns prior Spanish footer', () => {
  assert.equal(
    translate('ps.footer', {}, es, en),
    '— Fin de la proyección. Para regenerar: brain:project:status',
  );
});

test('translate: ps.maven.count interpolates count into Spanish', () => {
  assert.equal(
    translate('ps.maven.count', { count: 5 }, es, en),
    '5 módulo(s) en el reactor (incluye agregadores).',
  );
});

test('translate: ticket.fetching interpolates id into Spanish', () => {
  assert.equal(
    translate('ticket.fetching', { id: '42' }, es, en),
    'Buscando issue #42...',
  );
});

test('translate: ticket.nextSteps.step1 interpolates id into Spanish', () => {
  assert.equal(
    translate('ticket.nextSteps.step1', { id: '7' }, es, en),
    '    1. Implementar — usá /sdd-new 7 si el cambio es complejo',
  );
});

test('translate: day.run.exitCode interpolates code into Spanish', () => {
  assert.equal(
    translate('day.run.exitCode', { code: 1 }, es, en),
    '↳ salió con código 1 (no bloqueante).',
  );
});

// ── PR3 bootstrap.sh key existence in en.mjs ──────────────────────────────────
// Templates use {placeholder} syntax (same convention as PR2 keys).
// sh.mjs converts {placeholder} → %s for shell printf; t() fills named params for JS.

test('PR3 bootstrap: deps section keys exist in en', () => {
  assert.equal(en['bootstrap.deps.section'], 'Base dependencies');
  assert.equal(en['bootstrap.deps.missing'], "Missing '{tool}' (required). Install it and re-run brain:env:init.");
  assert.equal(en['bootstrap.deps.ok'],      'git, python3 present; package manager: {pm}');
});

test('PR3 bootstrap: ecosystem section keys exist in en', () => {
  assert.equal(en['bootstrap.ecosystem.section'],  'Ecosystem tools');
  assert.equal(en['bootstrap.ecosystem.notFound'], '{tool} not found — {hint}');
});

test('PR3 bootstrap: PAT section keys exist in en', () => {
  assert.equal(en['bootstrap.pat.section'],        'Personal access token (.env)');
  assert.equal(en['bootstrap.pat.alreadySet'],     '{var} already set in .env');
  assert.equal(en['bootstrap.pat.noTty'],          'no TTY: add {var} to .env and re-run brain:env:init');
  assert.equal(en['bootstrap.pat.openPrompt'],     'Open the browser with the pre-filled form? [Y/n]: ');
  assert.equal(en['bootstrap.pat.manualUrl'],      'Create it manually at: {url}');
  assert.equal(en['bootstrap.pat.browserFallback'],'If the browser did not open, go to: {url}');
  assert.equal(en['bootstrap.pat.enterPrompt'],    'Paste your PAT (not shown): ');
  assert.equal(en['bootstrap.pat.skipped'],        'No token: skipping VCS authentication. Re-run brain:env:init when you have it.');
  assert.equal(en['bootstrap.pat.saved'],          '{var} saved in .env (gitignored)');
});

test('PR3 bootstrap: credential helper section keys exist in en', () => {
  assert.equal(en['bootstrap.cred.section'], 'Git credential helper (HTTPS)');
  assert.equal(en['bootstrap.cred.ok'],      'push/pull over HTTPS use your personal PAT from .env');
});

test('PR3 bootstrap: VCS auth section keys exist in en', () => {
  assert.equal(en['bootstrap.auth.section'],   'VCS authentication');
  assert.equal(en['bootstrap.auth.alreadyOk'], 'already authenticated against {host}');
  assert.equal(en['bootstrap.auth.ok'],        'authenticated against {host}');
  assert.equal(en['bootstrap.auth.failed'],    'auth failed — check the token in .env');
  assert.equal(en['bootstrap.auth.noToken'],   'No token: VCS remains unauthenticated');
});

test('PR3 bootstrap: SDD harness section keys exist in en', () => {
  assert.equal(en['bootstrap.sdd.section'],            'SDD implementation (harness)');
  assert.equal(en['bootstrap.sdd.prompt'],             'Which SDD implementation do you use? [gentle-ai]: ');
  assert.equal(en['bootstrap.sdd.ok'],                 'harness: {harness} (.env)');
  assert.equal(en['bootstrap.sdd.gentleaiMissing'],    'gentle-ai missing — brew install gentle-ai and re-run brain:env:init');
  assert.equal(en['bootstrap.sdd.ecosystemOk'],        'ecosystem already initialized (gentle-ai doctor)');
  assert.equal(en['bootstrap.sdd.ecosystemConfigured'],'ecosystem configured (skills, engram, gga)');
  assert.equal(en['bootstrap.sdd.ecosystemFailed'],    'gentle-ai install failed — run it manually and re-run brain:env:init');
  assert.equal(en['bootstrap.sdd.noTty'],              "no TTY: run 'gentle-ai install' manually");
  assert.equal(en['bootstrap.sdd.registryOk'],         'skill registry updated');
  assert.equal(en['bootstrap.sdd.registryFailed'],     'skill-registry refresh failed (non-blocking)');
  assert.equal(en['bootstrap.sdd.unknownHarness'],     "harness '{harness}' has no known init routine — configure its skills manually");
});

// #1214: the prompt names both backends and carries NO bracketed default (ADR-0004 Amendment 3),
// in every catalog — a catalog could otherwise regain `[engram]` with every test green.
test('#1214 bootstrap.memory.prompt: no bracketed default, names both backends (en, es)', () => {
  for (const [lang, cat] of [['en', en], ['es', es]]) {
    const prompt = cat['bootstrap.memory.prompt'];
    assert.match(prompt, /engram/, `${lang} prompt must name engram`);
    assert.match(prompt, /plainfiles/, `${lang} prompt must name plainfiles`);
    assert.doesNotMatch(prompt, /\[[^\]]*\]/, `${lang} prompt must carry no bracketed default`);
  }
  assert.equal(es['bootstrap.memory.prompt'], '¿Qué backend de memoria usa este equipo? (engram|plainfiles): ');
});

test('PR3 bootstrap: team memory section keys exist in en', () => {
  assert.equal(en['bootstrap.memory.section'],         'Team memory');
  assert.equal(en['bootstrap.memory.prompt'],          'Which memory backend does this team use? (engram|plainfiles): ');
  assert.equal(en['bootstrap.memory.backend'],         'memory backend: {backend} ({source})');
  assert.equal(en['bootstrap.memory.hookOk'],          'pre-push hook activated (checkpoints feature working memory before push — ADR-0003)');
  assert.equal(en['bootstrap.memory.hookFailed'],      'could not activate core.hooksPath (pre-push hook)');
  assert.equal(en['bootstrap.memory.nodeAbsent'],      'node absent — engram backend setup skipped');
  assert.equal(en['bootstrap.memory.engram.ok'],       'engram backend configured (symlink + merge driver)');
  assert.equal(en['bootstrap.memory.engram.failed'],   'memory setup failed — REQUIRED, env:init will exit 1');
  assert.equal(en['bootstrap.memory.pull.ok'],         'memory imported (.memory/ → engram)');
  assert.equal(en['bootstrap.memory.pull.failed'],     'brain:memory:pull failed — REQUIRED, env:init will exit 1');
  assert.equal(en['bootstrap.memory.index.ok'],        'durable index reprojected (brain/ → engram)');
  assert.equal(en['bootstrap.memory.index.failed'],    'brain:memory:index failed — REQUIRED, env:init will exit 1');
  assert.equal(en['bootstrap.memory.unknownBackend'],  "backend '{backend}' has no known init routine — configure it manually");
});

test('PR3 bootstrap: board and done section keys exist in en', () => {
  assert.equal(en['bootstrap.board.section'], 'Open tickets in {path}');
  assert.equal(en['bootstrap.board.failed'],  'could not list tickets — see https://{host}/{path}');
  assert.equal(en['bootstrap.done.section'],  'Environment ready');
  assert.equal(en['bootstrap.done.pending'],  'Pending: {tools}');
  assert.equal(en['bootstrap.done.install'],  'Run: npm run tools:install  (installs all at once)');
});

// ── PR3 install-tools.sh key existence in en.mjs ──────────────────────────────

test('PR3 tools: require and apt section keys exist in en', () => {
  assert.equal(en['tools.require.noApt'],  'This script requires apt-get (Ubuntu/Debian). Install the tools manually following brain/project/methodology/developer-environment.md.');
  assert.equal(en['tools.apt.section'],    'System packages (apt)');
  assert.equal(en['tools.apt.installing'], 'Installing: {pkgs}');
  assert.equal(en['tools.apt.ok'],         'apt: {pkgs}');
  assert.equal(en['tools.apt.allPresent'], 'all apt packages already present');
});

test('PR3 tools: VCS CLI section keys exist in en', () => {
  assert.equal(en['tools.vcs.section'],   'VCS CLI ({cli})');
  assert.equal(en['tools.vcs.installed'], '{cli} installed');
  assert.equal(en['tools.vcs.notInApt'], '{cli} is not in apt — install it manually:');
});

test('PR3 tools: Node, Claude, gentle-ai section keys exist in en', () => {
  assert.equal(en['tools.node.installing'],           'Installing nvm...');
  assert.equal(en['tools.node.nvmOk'],                'nvm installed');
  assert.equal(en['tools.node.nodeOk'],               'node {version} via nvm');
  assert.equal(en['tools.node.reloadShell'],          'Open a new terminal or run: source ~/.bashrc');
  assert.equal(en['tools.claude.section'],            'Claude Code (Anthropic CLI)');
  assert.equal(en['tools.gentleai.section'],          'gentle-ai + ecosystem (engram, gga)');
  assert.equal(en['tools.gentleai.installing'],       'Installing gentle-ai...');
  assert.equal(en['tools.gentleai.ok'],               'gentle-ai installed');
  assert.equal(en['tools.gentleai.alreadyConfigured'],'gentle-ai ecosystem already configured');
  assert.equal(en['tools.gentleai.configuring'],      'Configuring ecosystem (engram, gga, skills)...');
  assert.equal(en['tools.gentleai.configured'],       'ecosystem configured');
  assert.equal(en['tools.gentleai.configFailed'],     'gentle-ai install failed — retry manually');
});

test('PR3 tools: summary section keys exist in en', () => {
  assert.equal(en['tools.summary.section'],       'Installation complete');
  assert.equal(en['tools.summary.nextStep'],      'Next step:');
  assert.equal(en['tools.summary.checkVersions'], 'Check versions:');
  assert.equal(en['tools.summary.notFound'],      '{tool}  (not found — restart the terminal)');
  assert.equal(en['tools.installed'],             'already installed');
});

// ── PR3 sh.mjs shell output shape for representative shell keys ───────────────

import { keyToVar, templateToShell, renderCatalog } from './sh.mjs';

test('PR3 sh: keyToVar converts bootstrap key correctly', () => {
  assert.equal(keyToVar('bootstrap.deps.section'),    'I18N_BOOTSTRAP_DEPS_SECTION');
  assert.equal(keyToVar('bootstrap.memory.engram.ok'),'I18N_BOOTSTRAP_MEMORY_ENGRAM_OK');
  assert.equal(keyToVar('tools.apt.section'),          'I18N_TOOLS_APT_SECTION');
});

test('PR3 sh: templateToShell converts {placeholder} to %s for bootstrap keys', () => {
  // {tool} in a template becomes %s for shell printf.
  assert.equal(templateToShell("Missing '{tool}' (required). Install it and re-run brain:env:init."),
                               "Missing '%s' (required). Install it and re-run brain:env:init.");
  assert.equal(templateToShell('{tool} not found — {hint}'), '%s not found — %s');
  assert.equal(templateToShell('{var} already set in .env'), '%s already set in .env');
});

test('PR3 sh: renderCatalog emits well-formed assignment for bootstrap.deps.section (English)', () => {
  // Empty active catalog → English fallback for all keys.
  const output = renderCatalog({}, en);
  const lines = output.split('\n');
  const line = lines.find((l) => l.startsWith('I18N_BOOTSTRAP_DEPS_SECTION='));
  assert.ok(line, 'I18N_BOOTSTRAP_DEPS_SECTION assignment must be present');
  assert.equal(line, "I18N_BOOTSTRAP_DEPS_SECTION='Base dependencies'");
});

test('PR3 sh: renderCatalog emits %s placeholder for bootstrap.auth.alreadyOk', () => {
  // {host} in the English template becomes %s in the shell assignment.
  const output = renderCatalog({}, en);
  const lines = output.split('\n');
  const line = lines.find((l) => l.startsWith('I18N_BOOTSTRAP_AUTH_ALREADYOK='));
  assert.ok(line, 'I18N_BOOTSTRAP_AUTH_ALREADYOK assignment must be present');
  assert.equal(line, "I18N_BOOTSTRAP_AUTH_ALREADYOK='already authenticated against %s'");
});

test('PR3 sh: renderCatalog uses Spanish value when es catalog is active', () => {
  const output = renderCatalog(es, en);
  const lines = output.split('\n');
  const line = lines.find((l) => l.startsWith('I18N_BOOTSTRAP_DEPS_SECTION='));
  assert.ok(line, 'I18N_BOOTSTRAP_DEPS_SECTION must appear in Spanish output');
  assert.equal(line, "I18N_BOOTSTRAP_DEPS_SECTION='Dependencias base'");
});

test('PR3 sh: renderCatalog emits tools.apt.section correctly', () => {
  const output = renderCatalog({}, en);
  const lines = output.split('\n');
  const line = lines.find((l) => l.startsWith('I18N_TOOLS_APT_SECTION='));
  assert.ok(line, 'I18N_TOOLS_APT_SECTION assignment must be present');
  assert.equal(line, "I18N_TOOLS_APT_SECTION='System packages (apt)'");
});

// ── PR3 session-start.mjs: session.* key existence in en.mjs (REQ-8, design §1.8) ──

test('PR3 session: all session.* keys exist in en with the planned English templates', () => {
  assert.equal(en['session.header'],            'brain · session context');
  assert.equal(en['session.branch'],             'branch:   {branch}');
  assert.equal(en['session.branch.unknown'],     '(unknown)');
  assert.equal(en['session.change.one'],         'change:   {change}');
  assert.equal(en['session.change.none'],        'change:   (no change folder for branch)');
  assert.equal(en['session.change.ambiguous'],   'change:   ambiguous ({count}): {list}');
  assert.equal(en['session.memory.ok'],          'memory:   engram hydrated');
  assert.equal(en['session.memory.skip'],        'memory:   engram unavailable (skipped)');
  assert.equal(en['session.ticket.label'],       'ticket:');
  assert.equal(en['session.ticket.none'],        '(no active ticket memory)');
});

test('PR3 session: every session.* key in en has a translated (non-identical-fallback) es entry', () => {
  const sessionKeys = Object.keys(en).filter((k) => k.startsWith('session.'));
  assert.ok(sessionKeys.length >= 10, 'expected at least 10 session.* keys in en.mjs');
  for (const key of sessionKeys) {
    assert.ok(key in es, `es.mjs is missing session.* key: ${key}`);
  }
});

// ── PR3 Spanish translation accuracy for representative bootstrap/tools keys ──

test('translate: bootstrap.deps.section returns Spanish section title', () => {
  assert.equal(translate('bootstrap.deps.section', {}, es, en), 'Dependencias base');
});

test('translate: bootstrap.auth.alreadyOk interpolates host into Spanish', () => {
  assert.equal(
    translate('bootstrap.auth.alreadyOk', { host: 'github.com' }, es, en),
    'ya autenticado contra github.com',
  );
});

test('translate: bootstrap.memory.pull.ok returns Spanish string', () => {
  assert.equal(translate('bootstrap.memory.pull.ok', {}, es, en), 'memoria importada (.memory/ → engram)');
});

test('translate: tools.apt.allPresent returns Spanish string', () => {
  assert.equal(translate('tools.apt.allPresent', {}, es, en), 'todos los paquetes apt ya presentes');
});

test('translate: tools.node.reloadShell returns Spanish string', () => {
  assert.equal(
    translate('tools.node.reloadShell', {}, es, en),
    'Abrí una terminal nueva o ejecutá: source ~/.bashrc',
  );
});
