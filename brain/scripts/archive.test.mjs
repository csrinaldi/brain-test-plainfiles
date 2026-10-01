// archive.test.mjs — Unit tests for E1 brain:change:archive (issue 260)
// Following strict TDD: these tests are written first and will fail (RED)
// until the logic in archive-logic.mjs is implemented.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Task 1.1 (RED): Imports from a non-existent logic module
import {
  parseYamlFrontmatter,
  mergeSpecs,
  archiveChange,
} from './lib/archive-logic.mjs';

// ── Test 1: parseYamlFrontmatter ──────────────────────────────────────────
test('1.1: parseYamlFrontmatter extracts frontmatter fields and body correctly', () => {
  const content = `---
status: approved
issue: 260
capability: memory
---

# Title
Body content here.
`;
  const result = parseYamlFrontmatter(content);
  assert.deepEqual(result.frontmatter, {
    status: 'approved',
    issue: '260',
    capability: 'memory',
  });
  assert.equal(result.body.trim(), '# Title\nBody content here.');
});

test('1.2: parseYamlFrontmatter handles content without frontmatter', () => {
  const content = '# Title without frontmatter\nJust body.';
  const result = parseYamlFrontmatter(content);
  assert.deepEqual(result.frontmatter, {});
  assert.equal(result.body.trim(), '# Title without frontmatter\nJust body.');
});

// ── Test 2: mergeSpecs ────────────────────────────────────────────────────
test('2.1: mergeSpecs appends delta body to empty central spec with provenance header', () => {
  const deltaContent = `---
status: approved
issue: 138
---
# Requirements
- REQ-1: Do something
`;
  const centralContent = '';
  const result = mergeSpecs(deltaContent, centralContent, 'issue-138-session-start', '2026-07-13');
  
  const expected = `
### [issue-138] session-start — 2026-07-13

# Requirements
- REQ-1: Do something
`;
  assert.equal(result.trim(), expected.trim());
});

test('2.2: mergeSpecs appends delta body to non-empty central spec with white space separator', () => {
  const deltaContent = `---
status: approved
issue: 138
---
# Requirements
- REQ-1: Do something
`;
  const centralContent = '# Existing Central Spec\n- REQ-0: Pre-existing';
  const result = mergeSpecs(deltaContent, centralContent, 'issue-138-session-start', '2026-07-13');
  
  const expected = `# Existing Central Spec
- REQ-0: Pre-existing

### [issue-138] session-start — 2026-07-13

# Requirements
- REQ-1: Do something
`;
  assert.equal(result.trim(), expected.trim());
});

// ── Test 3: archiveChange (DI Injected FS Orchestrator) ──────────────────
test('3.1: archiveChange performs legacy format specs merge and folder rename', async () => {
  const files = {
    'openspec/changes/issue-138-session-start': true,
    'openspec/changes/issue-138-session-start/proposal.md': 'proposal text',
    'openspec/changes/issue-138-session-start/design.md': 'design text',
    'openspec/changes/issue-138-session-start/tasks.md': 'tasks text',
    'openspec/changes/issue-138-session-start/specs': ['session'],
    'openspec/changes/issue-138-session-start/specs/session/spec.md': `---
status: approved
issue: 138
---
# Requirements
- REQ-1: Do something
`,
    'openspec/specs/session/spec.md': '# Existing Session Spec\n',
  };

  const renames = [];
  const writes = {};
  const mkdirs = [];

  const fakeFs = {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    listDir: (p) => {
      const entry = files[p];
      if (!Array.isArray(entry)) throw new Error(`not a dir: ${p}`);
      return entry;
    },
    readFile: (p) => {
      if (!files[p]) throw new Error(`file not found: ${p}`);
      return files[p];
    },
    writeFile: (p, content) => {
      writes[p] = content;
    },
    mkdir: (p) => {
      mkdirs.push(p);
    },
    rename: (src, dest) => {
      renames.push({ src, dest });
    },
  };

  const result = await archiveChange({
    changeId: 'issue-138-session-start',
    fs: fakeFs,
    dateStr: '2026-07-13',
  });

  // Verify rename happened from changes to archive/138
  assert.equal(renames.length, 1);
  assert.deepEqual(renames[0], {
    src: 'openspec/changes/issue-138-session-start',
    dest: 'openspec/changes/archive/138',
  });

  // Verify spec was merged correctly
  assert.ok(Object.prototype.hasOwnProperty.call(writes, 'openspec/specs/session/spec.md'));
  assert.match(writes['openspec/specs/session/spec.md'], /### \[issue-138\] session-start — 2026-07-13/);
  assert.match(writes['openspec/specs/session/spec.md'], /- REQ-1: Do something/);

  // issue #557 D4: additive return value — nested convention consolidates.
  assert.deepEqual(result, { moved: true, consolidated: ['session'], unconsolidated: false });
});

// ── Test 3.1b: archiveChange return value — flat spec.md, no capability ──
test('3.1b: archiveChange reports unconsolidated:true for a flat spec.md with no capability declared (issue #557 D7-b)', async () => {
  const files = {
    'openspec/changes/issue-466-no-cap': true,
    'openspec/changes/issue-466-no-cap/proposal.md': 'proposal text',
    'openspec/changes/issue-466-no-cap/design.md': 'design text',
    'openspec/changes/issue-466-no-cap/tasks.md': 'tasks text',
    'openspec/changes/issue-466-no-cap/spec.md': '# No frontmatter at all\n- REQ-1: Something\n',
  };
  const renames = [];
  const fakeFs = {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    listDir: () => { throw new Error('should not list a dir — flat spec.md has no specs/ subdir'); },
    readFile: (p) => files[p],
    writeFile: () => { throw new Error('should not write any central spec — nothing to consolidate'); },
    mkdir: () => {},
    rename: (src, dest) => { renames.push({ src, dest }); },
  };

  const result = await archiveChange({
    changeId: 'issue-466-no-cap',
    fs: fakeFs,
    dateStr: '2026-07-13',
  });

  assert.equal(renames.length, 1, 'the folder must still archive even when its spec delta cannot be consolidated');
  assert.deepEqual(result, { moved: true, consolidated: [], unconsolidated: true });
});

// ── Test 3.1c: archiveChange return value — nested convention, multiple capabilities ──
test('3.1c: archiveChange reports consolidated:[<cap>, ...] for the nested specs/*/spec.md convention', async () => {
  const files = {
    'openspec/changes/issue-700-multi-cap': true,
    'openspec/changes/issue-700-multi-cap/proposal.md': 'p',
    'openspec/changes/issue-700-multi-cap/design.md': 'd',
    'openspec/changes/issue-700-multi-cap/tasks.md': 't',
    'openspec/changes/issue-700-multi-cap/specs': ['alpha', 'beta'],
    'openspec/changes/issue-700-multi-cap/specs/alpha/spec.md': '---\nstatus: approved\n---\n# Alpha\n- REQ-A: a\n',
    'openspec/changes/issue-700-multi-cap/specs/beta/spec.md': '---\nstatus: approved\n---\n# Beta\n- REQ-B: b\n',
  };
  const writes = {};
  const fakeFs = {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    listDir: (p) => files[p],
    readFile: (p) => files[p],
    writeFile: (p, content) => { writes[p] = content; },
    mkdir: () => {},
    rename: () => {},
  };

  const result = await archiveChange({
    changeId: 'issue-700-multi-cap',
    fs: fakeFs,
    dateStr: '2026-07-13',
  });

  assert.deepEqual(result, { moved: true, consolidated: ['alpha', 'beta'], unconsolidated: false });
  assert.ok(writes['openspec/specs/alpha/spec.md']);
  assert.ok(writes['openspec/specs/beta/spec.md']);
});

test('3.2: archiveChange fails when target archive directory already exists — still throws (backstop, issue #557 D4)', async () => {
  const files = {
    'openspec/changes/issue-138-session-start': true,
    'openspec/changes/issue-138-session-start/proposal.md': 'proposal text',
    'openspec/changes/archive/138': true, // already exists
  };

  const fakeFs = {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFile: (p) => files[p],
  };

  await assert.rejects(
    async () => {
      await archiveChange({
        changeId: 'issue-138-session-start',
        fs: fakeFs,
      });
    },
    /Destination directory openspec\/changes\/archive\/138 already exists/
  );
});

// ── Test 4: Integration E2E ──────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { testTmp } from './lib/test-tmp.mjs';

test('4.1: Integration: E2E CLI run over sandbox layout', () => {
  // Snapshot the real repo root's entry list BEFORE running — an absence
  // claim on a single name would miss any other stray write, so this is a
  // before/after comparison of the whole root (#1020), never a claim that
  // one specific path does not exist.
  const rootEntriesBefore = readdirSync(process.cwd()).sort();

  // Sandbox lives under the shared test-tmp root (#842 hygiene), never under
  // the real repo's cwd: a per-run root outside the tree, cleaned up by the
  // process-exit hook even on a killed run.
  const sandbox = testTmp('archive-e2e-');

  const changeId = 'issue-999-integration-test';
  const changeDirRel = `openspec/changes/${changeId}`;
  mkdirSync(join(sandbox, changeDirRel, 'specs/my-cap'), { recursive: true });
  mkdirSync(join(sandbox, 'openspec/specs'), { recursive: true });

  writeFileSync(join(sandbox, changeDirRel, 'proposal.md'), 'prop text');
  writeFileSync(join(sandbox, changeDirRel, 'design.md'), 'design text');
  writeFileSync(join(sandbox, changeDirRel, 'tasks.md'), 'tasks text');
  writeFileSync(join(sandbox, changeDirRel, 'specs/my-cap/spec.md'), `---
status: approved
issue: 999
---
# Cap Requirements
- REQ-CAP-1: Integrate
`);

  // Resolved from this module's own URL, not the test's cwd: the sandbox now
  // runs with `cwd: sandbox`, and archive.mjs lives beside this test file
  // regardless of where the suite is invoked from.
  const scriptPath = fileURLToPath(new URL('./archive.mjs', import.meta.url));
  execFileSync('node', [scriptPath, changeId], {
    cwd: sandbox,
    env: { ...process.env, MEMORY_BACKEND: 'plainfiles' },
  });

  assert.ok(existsSync(join(sandbox, `openspec/changes/archive/999`)));
  assert.ok(existsSync(join(sandbox, `openspec/changes/archive/999/proposal.md`)));
  assert.equal(existsSync(join(sandbox, changeDirRel)), false);

  const centralSpec = join(sandbox, 'openspec/specs/my-cap/spec.md');
  assert.ok(existsSync(centralSpec));
  const content = readFileSync(centralSpec, 'utf8');
  assert.match(content, /### \[issue-999\] integration-test/);
  assert.match(content, /- REQ-CAP-1: Integrate/);

  // No manual rmSync: the sandbox lives under the shared test-tmp root and
  // is swept by its process-exit hook, so this run's own cleanup is never
  // the thing standing between "green" and a leftover directory.
  const rootEntriesAfter = readdirSync(process.cwd()).sort();
  assert.deepEqual(
    rootEntriesAfter,
    rootEntriesBefore,
    'this test must never change the real repo root\'s entry list (#1020)',
  );
});

// ── Test 5: --backfill routed through the closed-issue selector (issue #557) ──

import { runBackfill, runSingle, BLOCKED_OUTCOMES } from './archive.mjs';
import { OUTCOME } from './lib/archive-sweep.mjs';

test('5.1: no literal \'260\' string remains in archive.mjs — the hardcode is deleted, not merely unused (issue #557 D4)', () => {
  const srcPath = fileURLToPath(new URL('./archive.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.doesNotMatch(src, /['"]260['"]/, "no quoted literal '260' may remain in archive.mjs — protection for an in-flight change now falls out of the selector's row 8 (its issue is open), not a hardcoded exclusion");
});

/** Builds a minimal fake fs sufficient for archiveChange over grandfathered-shaped
 * flat dirs (no specs to merge) — matches the shape runBackfill's callers use. */
function fakeBackfillFs(dirNames) {
  const files = {};
  for (const name of dirNames) {
    files[`openspec/changes/${name}`] = true;
    files[`openspec/changes/${name}/proposal.md`] = 'p';
    files[`openspec/changes/${name}/design.md`] = 'd';
    files[`openspec/changes/${name}/tasks.md`] = 't';
    // No spec.md/specs/ — archiveChange treats a missing spec as nothing to merge.
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

test('5.2: iid 260 receives standard row-8/10 treatment via --backfill — open leaves it in place, closed archives it like any other iid', async () => {
  // Open: left in place, same as iid 261.
  const openFixture = fakeBackfillFs(['issue-260-in-flight', 'issue-261-also-in-flight']);
  const openResult = await runBackfill({
    fs: openFixture.fs,
    entries: ['issue-260-in-flight', 'issue-261-also-in-flight'],
    readIssueState: async () => ({ state: 'open', stateReason: null }),
    log: () => {},
    logError: () => {},
  });
  assert.equal(openResult.archivedCount, 0);
  assert.equal(openFixture.renames.length, 0);
  const outcomes260 = openResult.selection.folders.find(f => f.name === 'issue-260-in-flight').outcome;
  const outcomes261 = openResult.selection.folders.find(f => f.name === 'issue-261-also-in-flight').outcome;
  assert.equal(outcomes260, OUTCOME.OPEN);
  assert.equal(outcomes260, outcomes261, '260 must be classified identically to any other open iid');
  assert.equal(openResult.exitCode, 0, 'open folders left in place is expected steady-state, not a failure');

  // Closed: archived like any other closed iid — no special-case skip.
  const closedFixture = fakeBackfillFs(['issue-260-in-flight']);
  const closedResult = await runBackfill({
    fs: closedFixture.fs,
    entries: ['issue-260-in-flight'],
    readIssueState: async () => ({ state: 'closed', stateReason: 'completed' }),
    log: () => {},
    logError: () => {},
  });
  assert.equal(closedResult.archivedCount, 1);
  assert.equal(closedFixture.renames.length, 1);
  assert.deepEqual(closedFixture.renames[0], { src: 'openspec/changes/issue-260-in-flight', dest: 'openspec/changes/archive/260' });
  assert.equal(closedResult.exitCode, 0);
});

test('5.3: --backfill exits 1 when a collision is present, even though every read answered (complete:true)', async () => {
  const fixture = fakeBackfillFs(['issue-518-a', 'issue-518-b']);
  const result = await runBackfill({
    fs: fixture.fs,
    entries: ['issue-518-a', 'issue-518-b'],
    readIssueState: async () => ({ state: 'closed', stateReason: 'completed' }),
    log: () => {},
    logError: () => {},
  });
  assert.equal(result.selection.complete, true, 'every distinct iid answered — this is not a read failure');
  assert.equal(result.archivedCount, 0, 'a colliding folder must never be archived');
  assert.equal(fixture.renames.length, 0);
  assert.equal(result.exitCode, 1, 'a collision must fail the run — it is a BLOCKED_OUTCOMES member requiring a human decision');
  assert.ok(BLOCKED_OUTCOMES.has(OUTCOME.COLLISION));
});

test('5.4: --backfill exits 1 when complete:false (an issue state could not be read) — nothing archived for the unreadable folder', async () => {
  const fixture = fakeBackfillFs(['issue-900-unreadable']);
  const result = await runBackfill({
    fs: fixture.fs,
    entries: ['issue-900-unreadable'],
    readIssueState: async () => null,
    log: () => {},
    logError: () => {},
  });
  assert.equal(result.selection.complete, false);
  assert.deepEqual(result.selection.readFailures, ['900']);
  assert.equal(result.archivedCount, 0);
  assert.equal(result.exitCode, 1);
});

test('5.4b: mixed batch — one archivable folder alongside one unreadable folder — fail-closed archives NOTHING, not just the unreadable one (issue #557 CRITICAL-1)', async () => {
  // Regression for the fail-closed bug: the archive loop used to run
  // unconditionally over `selection.archivable`, so a readable+closed folder
  // was renamed/archived BEFORE the loop (implicitly) reported
  // `complete: false` — a partial archive on a partial read, exactly what
  // design D3 and the archive-closed-issue-selection spec's "Selector Reads
  // Are Fail-Closed" requirement forbid. Unlike 5.4 (a single, unreadable
  // folder — which passes trivially even with the loop unguarded, since
  // `selection.archivable` is empty either way), this batch keeps a genuinely
  // READABLE, ARCHIVABLE folder in play so the loop has something to
  // wrongly archive if the gate regresses.
  const fixture = fakeBackfillFs(['issue-901-readable-closed', 'issue-902-unreadable']);
  const result = await runBackfill({
    fs: fixture.fs,
    entries: ['issue-901-readable-closed', 'issue-902-unreadable'],
    readIssueState: async (iid) => (iid === '901' ? { state: 'closed', stateReason: 'completed' } : null),
    log: () => {},
    logError: () => {},
  });

  assert.equal(result.selection.complete, false);
  assert.deepEqual(result.selection.readFailures, ['902']);
  // The selector itself still correctly classifies 901 as archivable —
  // fail-closed is the CALLER's responsibility, not the selector's.
  assert.equal(
    result.selection.folders.find(f => f.name === 'issue-901-readable-closed').outcome,
    OUTCOME.ARCHIVABLE,
    "the selector must still report 901 as archivable — fail-closed is enforced by the caller's loop gate, not by miscategorizing 901",
  );

  assert.equal(result.archivedCount, 0, 'NOTHING may archive when the batch is incomplete, including the readable folder');
  assert.equal(result.consolidatedCount, 0);
  assert.equal(result.unconsolidatedCount, 0);
  assert.equal(fixture.renames.length, 0, 'no rename call may occur for ANY folder in an incomplete batch');
  assert.equal(
    fixture.fs.exists('openspec/changes/issue-901-readable-closed'),
    true,
    'the readable, archivable folder must still be present in openspec/changes/ — not moved',
  );
  assert.equal(result.exitCode, 1);
});

test('5.5: --backfill on a clean run (archivable + open + not-planned + grandfathered, no blocked outcomes) exits 0', async () => {
  const fixture = fakeBackfillFs(['issue-100-ship', 'issue-200-inflight', 'issue-300-abandoned']);
  const result = await runBackfill({
    fs: fixture.fs,
    entries: ['issue-100-ship', 'issue-200-inflight', 'issue-300-abandoned'],
    readIssueState: async (iid) => {
      if (iid === '100') return { state: 'closed', stateReason: 'completed' };
      if (iid === '200') return { state: 'open', stateReason: null };
      return { state: 'closed', stateReason: 'not_planned' };
    },
    log: () => {},
    logError: () => {},
  });
  assert.equal(result.archivedCount, 1);
  assert.equal(result.exitCode, 0);
  const byName = Object.fromEntries(result.selection.folders.map(f => [f.name, f.outcome]));
  assert.equal(byName['issue-100-ship'], OUTCOME.ARCHIVABLE);
  assert.equal(byName['issue-200-inflight'], OUTCOME.OPEN);
  assert.equal(byName['issue-300-abandoned'], OUTCOME.NOT_PLANNED);
});

test('5.6: --backfill reports unconsolidated vs consolidated counts distinctly', async () => {
  const files = {
    'openspec/changes/issue-466-flat': true,
    'openspec/changes/issue-466-flat/proposal.md': 'p',
    'openspec/changes/issue-466-flat/design.md': 'd',
    'openspec/changes/issue-466-flat/tasks.md': 't',
    'openspec/changes/issue-466-flat/spec.md': '# No frontmatter\n- REQ-1: x\n',
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
  const result = await runBackfill({
    fs,
    entries: ['issue-466-flat', 'issue-700-nested'],
    readIssueState: async () => ({ state: 'closed', stateReason: 'completed' }),
    dateStr: '2026-08-11',
    log: () => {},
    logError: () => {},
  });
  assert.equal(result.archivedCount, 2);
  assert.equal(result.consolidatedCount, 1);
  assert.equal(result.unconsolidatedCount, 1);
  assert.ok(writes['openspec/specs/alpha/spec.md']);
});

test("5.7: --all prints a deprecation notice; --backfill does not — both otherwise identical", async () => {
  const fixture = fakeBackfillFs(['issue-100-x']);
  const logsAll = [];
  await runBackfill({
    fs: fixture.fs,
    entries: ['issue-100-x'],
    readIssueState: async () => ({ state: 'open', stateReason: null }),
    log: (msg) => logsAll.push(msg),
    logError: () => {},
    deprecated: true,
  });
  assert.ok(logsAll.some(l => l.includes('--all is deprecated')));

  const fixture2 = fakeBackfillFs(['issue-100-x']);
  const logsBackfill = [];
  await runBackfill({
    fs: fixture2.fs,
    entries: ['issue-100-x'],
    readIssueState: async () => ({ state: 'open', stateReason: null }),
    log: (msg) => logsBackfill.push(msg),
    logError: () => {},
    deprecated: false,
  });
  assert.ok(!logsBackfill.some(l => l.includes('deprecated')));
});

test('5.8: runSingle never touches the VCS — it accepts no readIssueState parameter at all', () => {
  // Structural guard: the human-override path's signature has no readIssueState
  // slot, so a caller cannot accidentally wire the VCS into it (design D4).
  assert.equal(runSingle.length, 1, 'runSingle takes exactly one destructured options argument');
  const src = readFileSync(fileURLToPath(new URL('./archive.mjs', import.meta.url)), 'utf8');
  const runSingleBody = src.slice(src.indexOf('export async function runSingle'), src.indexOf('// ── CLI entrypoint'));
  assert.doesNotMatch(runSingleBody, /readIssueState/, 'runSingle must never reference readIssueState — a human naming one folder has already made the decision the selector exists to make');
});


// ── #810 (#456 slice B): the custom artefact rides the whole-dir move ───────
test('#810: a declared custom stage artefact lands in the archive with the dir — the move is whole', async () => {
  const files = {
    'openspec/changes/issue-810-x': true,
    'openspec/changes/issue-810-x/proposal.md': 'p',
    'openspec/changes/issue-810-x/design.md': 'd',
    'openspec/changes/issue-810-x/tasks.md': 't',
    'openspec/changes/issue-810-x/spec.md': '# flat\n',
    'openspec/changes/issue-810-x/research.md': '# the custom artefact\n',
  };
  const renames = [];
  const fs = {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p),
    listDir: (p) => files[p],
    readFile: (p) => files[p],
    writeFile: () => {},
    mkdir: () => {},
    rename: (src, dest) => { renames.push({ src, dest }); },
  };
  await archiveChange({ changeId: 'issue-810-x', fs, dateStr: '2026-09-03' });
  assert.deepEqual(renames, [{ src: 'openspec/changes/issue-810-x', dest: 'openspec/changes/archive/810' }],
    'the DIR moves whole — research.md rides it; no per-file copy that could drop a custom artefact');
});

// ── #1127: --backfill in a repo with no openspec/changes/ is zero entries ────
// The same crash #1113 fixed in the sweep: an unguarded readdirSync threw an
// uncaught ENOENT stack for a consumer that has no changes folder yet.
import { spawnSync } from 'node:child_process';

test('#1127: --backfill in a repo with no openspec/changes/ exits 0 without an uncaught ENOENT', () => {
  const sandbox = testTmp('archive-backfill-nochanges-');
  mkdirSync(join(sandbox, '.git'), { recursive: true });
  const scriptPath = fileURLToPath(new URL('./archive.mjs', import.meta.url));
  const res = spawnSync('node', [scriptPath, '--backfill'], {
    cwd: sandbox,
    encoding: 'utf8',
    env: { ...process.env, HOME: sandbox, DBUS_SESSION_BUS_ADDRESS: '', XDG_RUNTIME_DIR: sandbox },
  });
  assert.doesNotMatch(res.stderr, /ENOENT|scandir/, 'no uncaught readdir failure');
  assert.equal(res.status, 0, res.stderr);
});
