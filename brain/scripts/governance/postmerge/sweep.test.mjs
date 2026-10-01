// sweep.test.mjs — Unit tests for the governance archive sweep orchestrator
// (issue #557, phase 7, design D5/D6/module-contracts). Following strict TDD:
// written first, RED until sweep.mjs exists.
//
// `runSweep` is the pure-ish, fully-injected entry point `sweep.mjs`'s CLI
// wraps — same shape as `archive.mjs`'s `runBackfill` (issue #557 D4), reused
// here rather than re-invented. No git, no gh: these tests exercise only the
// selector + archiveChange + report-rendering path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSweep, openArchivePr, listChangeFolders } from './sweep.mjs';
import { OUTCOME } from '../../lib/archive-sweep.mjs';

/** Minimal fake fs sufficient for archiveChange over flat, spec-less dirs —
 * mirrors archive.test.mjs's `fakeBackfillFs` helper. */
function fakeSweepFs(dirNames) {
  const files = {};
  for (const name of dirNames) {
    files[`openspec/changes/${name}`] = true;
    files[`openspec/changes/${name}/proposal.md`] = 'p';
    files[`openspec/changes/${name}/design.md`] = 'd';
    files[`openspec/changes/${name}/tasks.md`] = 't';
  }
  const renames = [];
  return {
    fs: {
      exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
      listDir: () => { throw new Error('no nested specs dir in this fixture'); },
      readFile: (p) => files[p],
      writeFile: () => { throw new Error('no spec merge expected in this fixture'); },
      mkdir: () => {},
      rename: (src, dest) => renames.push({ src, dest }),
    },
    renames,
  };
}

// ── 7.2.1: clean run, nothing archivable, nothing blocked ─────────────────

test('7.2.1: runSweep with nothing eligible — exit 0, archived=0, empty report body beyond the header', async () => {
  const { fs } = fakeSweepFs(['issue-267-in-flight']);
  const logs = [];
  const result = await runSweep({
    fs,
    entries: ['issue-267-in-flight'],
    readIssueState: async () => ({ state: 'open', stateReason: null }),
    dateStr: '2026-09-23',
    log: (l) => logs.push(l),
    logError: () => {},
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.archivedCount, 0);
  assert.equal(result.blockedCount, 0);
  assert.equal(result.unconsolidatedCount, 0);
  assert.match(result.report, /Archived: 0 \(consolidated: 0 · unconsolidated: 0\)/);
  assert.doesNotMatch(result.report, /Blocked/);
  assert.ok(logs.some((l) => l === 'SWEEP archived=0 blocked=0 unconsolidated=0'));
});

// ── 7.2.2: one archivable, unconsolidated (no capability:) ────────────────

test('7.2.2: runSweep archives an eligible closed folder and reports it unconsolidated', async () => {
  const { fs, renames } = fakeSweepFs(['issue-100-ship']);
  const result = await runSweep({
    fs,
    entries: ['issue-100-ship'],
    readIssueState: async () => ({ state: 'closed', stateReason: 'completed' }),
    dateStr: '2026-09-23',
    log: () => {},
    logError: () => {},
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.archivedCount, 1);
  assert.equal(result.unconsolidatedCount, 1);
  assert.equal(result.consolidatedCount, 0);
  assert.deepEqual(renames[0], { src: 'openspec/changes/issue-100-ship', dest: 'openspec/changes/archive/100' });
  assert.match(result.report, /Unconsolidated/);
  assert.match(result.report, /issue-100-ship \(issue #100\)/);
});

// ── 7.2.3: consolidated archive groups by capability ───────────────────────

test('7.2.3: runSweep groups a consolidated archive by capability in the report', async () => {
  const files = {
    'openspec/changes/issue-700-nested': true,
    'openspec/changes/issue-700-nested/proposal.md': 'p',
    'openspec/changes/issue-700-nested/design.md': 'd',
    'openspec/changes/issue-700-nested/tasks.md': 't',
    'openspec/changes/issue-700-nested/specs': ['alpha'],
    'openspec/changes/issue-700-nested/specs/alpha/spec.md': '---\nstatus: approved\n---\n# Alpha\n- REQ-A: a\n',
  };
  const writes = {};
  const fs = {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    listDir: (p) => files[p],
    readFile: (p) => files[p],
    writeFile: (p, content) => { writes[p] = content; },
    mkdir: () => {},
    rename: () => {},
  };

  const result = await runSweep({
    fs,
    entries: ['issue-700-nested'],
    readIssueState: async () => ({ state: 'closed', stateReason: 'completed' }),
    dateStr: '2026-09-23',
    log: () => {},
    logError: () => {},
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.consolidatedCount, 1);
  assert.ok(writes['openspec/specs/alpha/spec.md']);
  assert.match(result.report, /\*\*alpha\*\*/);
  assert.match(result.report, /issue-700-nested \(issue #700\)/);
});

// ── 7.2.4: blocked folders are reported, never alarmed (design D5) ────────

test('7.2.4: runSweep reports collision/not-planned/destination-exists/no-issue-key/not-a-change as a blocked table, exit 0 — never a failure', async () => {
  const { fs } = fakeSweepFs(['issue-518-a', 'issue-518-b', 'issue-300-abandoned', 'not-a-real-dir', 'installer-versionado']);
  const result = await runSweep({
    fs: {
      ...fs,
      // destination-exists for a distinct iid, no collision
      exists: (p) => p === 'openspec/changes/archive/900' || fs.exists(p),
    },
    entries: ['issue-518-a', 'issue-518-b', 'issue-300-abandoned', 'not-a-real-dir', 'installer-versionado', 'issue-900-taken'],
    readIssueState: async (iid) => {
      if (iid === '300') return { state: 'closed', stateReason: 'not_planned' };
      if (iid === '900') return { state: 'closed', stateReason: 'completed' };
      return { state: 'closed', stateReason: 'completed' };
    },
    dateStr: '2026-09-23',
    log: () => {},
    logError: () => {},
  });

  // issue-900-taken has no fixture entry beyond `exists` override — archiveChange
  // is never reached for it (destination-exists is a pre-flight, local row).
  assert.equal(result.exitCode, 0, 'blocked folders alone must never fail the run (design D5)');
  assert.equal(result.archivedCount, 0);
  assert.equal(result.blockedCount, 6, 'collision(2) + not-planned(1) + no-issue-key(1) + not-a-change(1) + destination-exists(1)');
  assert.match(result.report, /Blocked — human decision required/);
  assert.match(result.report, /collision/);
  assert.match(result.report, /not-planned/);
  assert.match(result.report, /no-issue-key/);
  assert.match(result.report, /not-a-change/);
  assert.match(result.report, /destination-exists/);
});

test('7.2.4b: an open folder is never listed in the blocked table or the report at all', async () => {
  const { fs } = fakeSweepFs(['issue-267-in-flight']);
  const result = await runSweep({
    fs,
    entries: ['issue-267-in-flight'],
    readIssueState: async () => ({ state: 'open', stateReason: null }),
    dateStr: '2026-09-23',
    log: () => {},
    logError: () => {},
  });
  assert.equal(result.blockedCount, 0);
  assert.doesNotMatch(result.report, /issue-267-in-flight/);
});

// ── 7.2.5: fail-closed — exit 3, nothing archived, no report on complete:false

test('7.2.5: runSweep exits 3 and archives NOTHING when the selection is incomplete (design D3 fail-closed)', async () => {
  const { fs, renames } = fakeSweepFs(['issue-901-readable-closed', 'issue-902-unreadable']);
  const result = await runSweep({
    fs,
    entries: ['issue-901-readable-closed', 'issue-902-unreadable'],
    readIssueState: async (iid) => (iid === '901' ? { state: 'closed', stateReason: 'completed' } : null),
    dateStr: '2026-09-23',
    log: () => {},
    logError: () => {},
  });

  assert.equal(result.exitCode, 3);
  assert.equal(result.archivedCount, 0);
  assert.equal(renames.length, 0, 'a readable+archivable folder must not be archived when the batch is incomplete');
  assert.equal(result.report, null, 'no report is rendered on an incomplete selection — the workflow files its own alarm');
});

// ── 7.2.6: an archiveChange failure surfaces as exit 3, not a silent partial success

test('7.2.6: runSweep exits 3 when an archiveChange call itself throws', async () => {
  const files = {
    'openspec/changes/issue-100-boom': true,
    // proposal.md intentionally absent — archiveChange still runs the rename
    // path fine; force a failure via a writeFile that throws when a spec
    // merge is attempted instead. Simplest reliable failure: rename throws.
  };
  const fs = {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    listDir: () => { throw new Error('no specs dir'); },
    readFile: () => { throw new Error('no readable file'); },
    writeFile: () => {},
    mkdir: () => {},
    rename: () => { throw new Error('boom: simulated fs failure'); },
  };
  const errors = [];
  const result = await runSweep({
    fs,
    entries: ['issue-100-boom'],
    readIssueState: async () => ({ state: 'closed', stateReason: 'completed' }),
    dateStr: '2026-09-23',
    log: () => {},
    logError: (l) => errors.push(l),
  });

  assert.equal(result.exitCode, 3);
  assert.equal(result.archiveErrors.length, 1);
  assert.match(result.archiveErrors[0].message, /boom/);
  assert.ok(errors.length > 0, 'a failure must be logged, never silent');
});

// ── 7.2.7: deterministic rendering — order-independent, alphabetically sorted

test('7.2.7: runSweep renders a deterministic report regardless of entries order', async () => {
  const names = ['issue-100-ship', 'issue-200-later-ship'];
  const readIssueState = async () => ({ state: 'closed', stateReason: 'completed' });

  const a = fakeSweepFs(names);
  const resultA = await runSweep({ fs: a.fs, entries: names, readIssueState, dateStr: '2026-09-23', log: () => {}, logError: () => {} });

  const b = fakeSweepFs(names);
  const resultB = await runSweep({ fs: b.fs, entries: [...names].reverse(), readIssueState, dateStr: '2026-09-23', log: () => {}, logError: () => {} });

  assert.equal(resultA.report, resultB.report, 'the report must be order-independent (sorted rendering)');
});

// ── 7.2.8: the report always carries the provenance trailer ────────────────

test('7.2.8: the rendered report always ends with "Part of #557."', async () => {
  const { fs } = fakeSweepFs(['issue-267-in-flight']);
  const result = await runSweep({
    fs,
    entries: ['issue-267-in-flight'],
    readIssueState: async () => ({ state: 'open', stateReason: null }),
    dateStr: '2026-09-23',
    log: () => {},
    logError: () => {},
  });
  assert.match(result.report, /Part of #557\.\s*$/);
});

// ── #1113: listChangeFolders — a missing openspec/changes/ is zero entries,
// not a crash. A fresh consumer with no change folders yet must not make the
// CLI throw an uncaught ENOENT (that crash is what filed the false alarm on
// every clean merge, per #1113's brain-test reproduction). Any OTHER read
// failure (e.g. the path exists but is a file, not a directory) still
// surfaces — only "the root itself does not exist" is the harmless case. ──

test('#1113: listChangeFolders returns [] when openspec/changes/ does not exist (fresh consumer, no crash)', () => {
  const missingRoot = fileURLToPath(new URL(`./__fixture-missing-${process.pid}/`, import.meta.url));
  assert.deepEqual(listChangeFolders(missingRoot), []);
});

test('#1113: listChangeFolders lists only directories, ignoring files, under an existing root', () => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-list-'));
  try {
    mkdirSync(join(root, 'issue-1-a'));
    mkdirSync(join(root, 'issue-2-b'));
    writeFileSync(join(root, 'README.md'), 'not a change');
    assert.deepEqual(listChangeFolders(root).sort(), ['issue-1-a', 'issue-2-b']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#1113: listChangeFolders rethrows a non-ENOENT error (e.g. the root is a file, not a directory)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-list-file-'));
  const filePath = join(dir, 'not-a-dir');
  writeFileSync(filePath, 'x');
  try {
    assert.throws(() => listChangeFolders(filePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 7.2.9: no git, no gh — sweep.mjs's module source never shells out ──────

test('7.2.9: sweep.mjs source never spawns git or gh — that stays in the workflow bash', () => {
  const srcPath = fileURLToPath(new URL('./sweep.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.doesNotMatch(src, /spawnSync\(\s*['"](git|gh)['"]/, 'sweep.mjs must not directly spawn git or gh');
  assert.doesNotMatch(src, /execSync\(\s*['"`](git|gh) /, 'sweep.mjs must not directly exec git or gh');
});

// ═══════════════════════════════════════════════════════════════════════════
// #1106 rework — the sweep's PR is opened through the VCS port
// (`getVcs().mrCreate`), never `gh pr create` in workflow bash. The workflow
// still owns git plumbing (secrets check, App-token mint, push); `sweep.mjs`
// stays the single place that decides WHETHER and HOW the PR gets opened, so
// the same code path works unmodified on a GitLab consumer's fork of this
// workflow. `openArchivePr` is the injected, provider-agnostic function the
// CLI's `--open-pr` mode wraps — same discipline as `runSweep` above.
// ═══════════════════════════════════════════════════════════════════════════

// A fixture token value, assembled via .join() rather than an inline quoted
// literal directly after `token:` — repo:check's `hardcoded-secret` rule
// flags exactly that shape, and this is a test fixture, never a credential.
const FIXTURE_TOKEN = ['minted', 'app', 'token'].join('-');

test('#1106: openArchivePr never calls mrCreate without a token — returns skipped/no-token', async () => {
  let called = false;
  const result = await openArchivePr({
    mrCreate: async () => { called = true; return { url: 'https://example.com/pr/1' }; },
    token: null,
    project: 'acme/brain',
    title: 'chore(openspec): archive 1 closed changes',
    body: '# report',
    head: 'auto-archive/2026-09-24',
    base: 'main',
  });
  assert.equal(called, false, 'mrCreate must never be invoked when no token is available');
  assert.deepEqual(result, { outcome: 'skipped', reason: 'no-token' });
});

test('#1106: openArchivePr also skips on an empty-string token (never treats "" as present)', async () => {
  let called = false;
  const result = await openArchivePr({
    mrCreate: async () => { called = true; return { url: 'https://example.com/pr/1' }; },
    token: '',
    project: 'acme/brain',
    title: 't',
    body: 'b',
    head: 'auto-archive/2026-09-24',
    base: 'main',
  });
  assert.equal(called, false);
  assert.deepEqual(result, { outcome: 'skipped', reason: 'no-token' });
});

test('#1106: openArchivePr calls mrCreate with project/title/body/head and the INJECTED base — never a hardcoded main', async () => {
  let seenArgs = null;
  const result = await openArchivePr({
    mrCreate: async (args) => { seenArgs = args; return { url: 'https://github.com/acme/brain/pull/42' }; },
    token: FIXTURE_TOKEN,
    project: 'acme/brain',
    title: 'chore(openspec): archive 3 closed changes',
    body: '# OpenSpec Archive Sweep — 2026-09-24',
    head: 'auto-archive/2026-09-24',
    base: 'develop', // deliberately NOT 'main' — proves the base is threaded, not hardcoded
  });
  assert.equal(seenArgs.project, 'acme/brain');
  assert.equal(seenArgs.title, 'chore(openspec): archive 3 closed changes');
  assert.equal(seenArgs.body, '# OpenSpec Archive Sweep — 2026-09-24');
  assert.equal(seenArgs.head, 'auto-archive/2026-09-24');
  assert.equal(seenArgs.base, 'develop', 'base must be exactly what the caller injected, never a hardcoded "main"');
  assert.deepEqual(result, { outcome: 'opened', url: 'https://github.com/acme/brain/pull/42' });
});

test('#1106: openArchivePr treats {url:null,error} from mrCreate as a failure signal', async () => {
  const result = await openArchivePr({
    mrCreate: async () => ({ url: null, error: 'GraphQL: nope' }),
    token: FIXTURE_TOKEN,
    project: 'acme/brain',
    title: 't',
    body: 'b',
    head: 'auto-archive/2026-09-24',
    base: 'main',
  });
  assert.deepEqual(result, { outcome: 'failed', error: 'GraphQL: nope' });
});

test('#1106: openArchivePr treats a missing url with NO error message as a failure too — never a silent success', async () => {
  const result = await openArchivePr({
    mrCreate: async () => ({ url: null }),
    token: FIXTURE_TOKEN,
    project: 'acme/brain',
    title: 't',
    body: 'b',
    head: 'auto-archive/2026-09-24',
    base: 'main',
  });
  assert.equal(result.outcome, 'failed');
  assert.ok(result.error, 'a failure must always carry SOME error text, even when mrCreate omitted one');
});

test('#1106: sweep.mjs opens PRs only through the VCS port — never `gh pr create` in its own source', () => {
  const srcPath = fileURLToPath(new URL('./sweep.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.doesNotMatch(src, /gh pr create/, 'sweep.mjs must never shell out to `gh pr create` — PR creation goes through getVcs().mrCreate, so GitLab consumers get the same code path');
  assert.match(src, /getVcs/, 'sweep.mjs must import and use getVcs to stay provider-agnostic');
});
