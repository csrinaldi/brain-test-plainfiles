// brain-upgrade.test.mjs — Unit tests for the brain:upgrade self-host guard.
//
// Issue #180: a pre-v0.8.0 vendored upgrader plain-copied the consumer's
// package.json, clobbering `name` to "brain" (also version/description/
// license). That used to trip a hard guard here
// (`ownPkg.name === 'brain'`) and permanently lock the consumer out of all
// future upgrades — the exact repo that most needs to upgrade (to get the
// v0.8.0+ specialMerge fix) could never run brain:upgrade again.
//
// The fix: a `.brain-source` marker file at the brain SOURCE repo root is
// the authoritative self-host signal (reliable regardless of what
// package.json says). The old name-based check becomes a non-fatal
// recovery-awareness warning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describeInstalledPackageSearch } from './lib/installer.mjs';

// Derived, never spelled out (#625, #655). This message names every path the
// resolver probed, so it CHANGES with the package name — and a test that pins
// the old literal fails on the rename for a reason that has nothing to do with
// what it is testing.
const NOT_FOUND = new RegExp(`${describeInstalledPackageSearch().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} not found`);

const BRAIN_UPGRADE_SCRIPT = new URL('./brain-upgrade.mjs', import.meta.url).pathname;
const BRAIN_UPGRADE_SOURCE = fileURLToPath(new URL('./brain-upgrade.mjs', import.meta.url));

function runBrainUpgrade(dir, args = []) {
  return spawnSync('node', [BRAIN_UPGRADE_SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
}

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── .brain-source marker guard ─────────────────────────────────────────────

test('brain:upgrade: refuses to run when .brain-source marker is present (source repo)', (t) => {
  const dir = makeTmpDir('brain-upgrade-marker-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, '.brain-source'), '# marker\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-consumer', version: '1.0.0' }));

  const r = runBrainUpgrade(dir, ['--no-install']);

  assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /SOURCE repo/i, `expected the die message to mention the source repo:\n${r.stderr}`);
  assert.match(r.stderr, /\.brain-source/, `expected the die message to reference the .brain-source marker:\n${r.stderr}`);
});

test('brain:upgrade: --force overrides the .brain-source marker guard', (t) => {
  const dir = makeTmpDir('brain-upgrade-marker-force-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, '.brain-source'), '# marker\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-consumer', version: '1.0.0' }));

  const r = runBrainUpgrade(dir, ['--no-install', '--force']);

  // --force must get past the marker guard entirely — that die message must
  // never appear. It is expected to fail LATER for an unrelated reason
  // (no node_modules/brain fixture in this minimal test dir).
  assert.doesNotMatch(r.stderr, /SOURCE repo/i,
    `--force must bypass the .brain-source guard; the source-repo die message must be absent:\n${r.stderr}`);
  assert.match(r.stderr, NOT_FOUND,
    `expected the script to get past the guard and fail at the installed-root check:\n${r.stderr}`);
});

// ── Soft warning: package.json name === 'brain' without a .brain-source marker ──

test('brain:upgrade: package.json name === "brain" without a marker is a soft warning, not a die', (t) => {
  const dir = makeTmpDir('brain-upgrade-soft-warn-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // No .brain-source marker — simulates a consumer whose package.json name
  // was clobbered to "brain" by a pre-v0.8.0 upgrade (issue #180).
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'brain', version: '0.1.0' }));

  const r = runBrainUpgrade(dir, ['--no-install']);

  // The OLD hard-guard die message must never appear — this is the
  // regression this test protects against (the lockout bug).
  assert.doesNotMatch(r.stderr, /this looks like the brain repo itself/,
    `the old hard self-host guard must be removed:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /SOURCE repo/i,
    `no .brain-source marker exists — the marker guard must not fire:\n${r.stderr}`);

  // The soft recovery-awareness warning must be printed instead.
  assert.match(r.stderr, /may have clobbered your project name/,
    `expected the soft warning about a possibly-clobbered project name:\n${r.stderr}`);

  // It must have proceeded PAST the guard — failing later (no node_modules/brain
  // fixture in this minimal test dir) is fine and proves it got past the guard.
  assert.match(r.stderr, NOT_FOUND,
    `expected the script to proceed past the guard and fail at the installed-root check:\n${r.stderr}`);
});

test('brain:upgrade: no warning printed when package.json name is not "brain"', (t) => {
  const dir = makeTmpDir('brain-upgrade-no-warn-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-consumer', version: '1.0.0' }));

  const r = runBrainUpgrade(dir, ['--no-install']);

  assert.doesNotMatch(r.stderr, /may have clobbered your project name/,
    `no warning expected for a normal consumer package.json name:\n${r.stderr}`);
});

// ── specialMerge lock-in guard (issue #180, Part 2) ─────────────────────────
//
// The root cause of the clobber was package.json being plain-copied instead
// of merged. Since v0.9.x it IS routed through specialMerge (mergePackageJson),
// but nothing asserted it STAYS that way. This is a regression guard: if a
// future edit ever drops 'package.json' from the specialMerge map passed to
// copyManaged, this test must fail.
// ── Three-way detection wiring (issue #397, REQ-397-1) ───────────────────────

// Builds the smallest consumer repo brain:upgrade will walk all the way to the
// copy step with --no-install: its own package.json, and a node_modules/brain
// holding the two core modules the script imports from the package.
function makeConsumerRepo(prefix, { pkgVersion = '1.0.0' } = {}) {
  const dir = makeTmpDir(prefix);
  const pkg = join(dir, 'node_modules', 'brain');
  mkdirSync(join(pkg, 'brain', 'core'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-consumer', version: '1.0.0' }));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'brain', version: pkgVersion }));
  writeFileSync(join(pkg, 'brain', 'core', 'managed-paths.mjs'),
    'export const managed = [];\nexport const local = [];\n');
  writeFileSync(join(pkg, 'brain', 'core', 'config-migrations.mjs'), 'export const migrations = [];\n');
  return dir;
}

// REQ-397-1 Scenario 3, and tasks.md 2.2. Under --no-install the outgoing and
// incoming package are one tree, so the check cannot run. The requirement is not
// that it degrade — it is that it SAY SO. A run that degrades silently is
// indistinguishable from a clean three-way pass, and the operator reads the
// stronger of the two.
test('brain:upgrade: --no-install states that modification detection degraded (REQ-397-1 S3)', (t) => {
  const dir = makeConsumerRepo('brain-397-degraded-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = runBrainUpgrade(dir, ['--no-install']);
  const out = `${r.stdout}${r.stderr}`;

  assert.match(out, /--no-install/,
    `the degraded-mode notice must name the flag that caused it:\n${out}`);
  assert.match(out, /same tree|CANNOT tell|cannot tell/i,
    `the run must say it could not distinguish a consumer edit from a brain change:\n${out}`);
});

// ── .gemini merge + AGENTS.md regeneration, driven through the REAL CLI ───────
//
// The #396 lesson (tasks.md 3.7): a suite that never runs the command a consumer
// runs carries no information about it. Both of these ARE reachable end-to-end,
// unlike the REFUSE gate — they do not depend on outgoing !== incoming.

// Extends the minimal consumer with a real managed manifest and a package that
// actually ships the files under test.
// `homeMd` is optional (task 2.1): omitting it simulates a consumer whose
// brain/HOME.md does not exist, so init()'s _readDoc throws for that one
// SOURCE_DOCS path and the upgrade's regen message must name it.
// `missingMethodologyDocs` (added for the "a different source doc is
// missing" spec scenario): a list of methodology doc slugs (e.g.
// 'sdd-layout') to leave unwritten, so init()'s _readDoc throws for that ONE
// non-brain/HOME.md SOURCE_DOCS path — a distinct code path from omitting
// homeMd, which only ever exercises the brain/HOME.md-specific branch.
function makeUpgradableConsumer(prefix, { geminiSettings, homeMd, missingMethodologyDocs = [] }) {
  const dir = makeTmpDir(prefix);
  const pkg = join(dir, 'node_modules', 'brain');
  mkdirSync(join(pkg, 'brain', 'core'), { recursive: true });
  mkdirSync(join(pkg, '.gemini'), { recursive: true });
  mkdirSync(join(dir, 'brain', 'core', 'methodology'), { recursive: true });
  mkdirSync(join(dir, '.gemini'), { recursive: true });

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'my-consumer', version: '1.0.0' }));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'brain', version: '1.0.0' }));
  writeFileSync(join(pkg, 'brain', 'core', 'managed-paths.mjs'),
    "export const managed = ['.gemini/settings.json'];\nexport const local = [];\n");
  writeFileSync(join(pkg, 'brain', 'core', 'config-migrations.mjs'), 'export const migrations = [];\n');

  // What brain ships…
  writeFileSync(join(pkg, '.gemini', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'npm run brain:session:start' }] }] },
  }, null, 2) + '\n');
  // …and what the consumer already has.
  writeFileSync(join(dir, '.gemini', 'settings.json'), JSON.stringify(geminiSettings, null, 2) + '\n');

  // The consumer's OWN HOME.md — the input that makes AGENTS.md theirs.
  // Omitted entirely when `homeMd` is undefined/null (task 2.1 fixture).
  if (homeMd != null) writeFileSync(join(dir, 'brain', 'HOME.md'), homeMd);
  for (const d of ['agent-authorities', 'harness-contract', 'sdd-layout', 'workflow-governance']) {
    if (missingMethodologyDocs.includes(d)) continue;
    writeFileSync(join(dir, 'brain', 'core', 'methodology', `${d}.md`), `# ${d}\n`);
  }
  return dir;
}

// REQ-397-3 / tasks.md 3.5 — the consumer's own hooks must survive the upgrade.
test('brain:upgrade: .gemini/settings.json merge preserves the consumer\'s keys (REQ-397-3)', (t) => {
  const dir = makeUpgradableConsumer('brain-397-gemini-', {
    geminiSettings: { myOwnKey: 'keep me', hooks: { PreToolUse: [{ matcher: 'MyTool', hooks: [] }] } },
    homeMd: '# consumer home\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = runBrainUpgrade(dir, ['--no-install']);
  const after = JSON.parse(readFileSync(join(dir, '.gemini', 'settings.json'), 'utf8'));

  assert.equal(after.myOwnKey, 'keep me',
    `a consumer top-level key must survive:\n${r.stdout}${r.stderr}`);
  assert.ok(after.hooks.PreToolUse?.some((e) => e.matcher === 'MyTool'),
    'the consumer\'s own hook entry must survive');
  assert.ok(after.hooks.SessionStart?.length > 0,
    'brain\'s block must be applied underneath, not instead');
});

// REQ-397-4 Scenario 1 / tasks.md 3.6 — the headline of this slice. Before #397
// the consumer's AGENTS.md was replaced by brain's, compiled from BRAIN's HOME.md.
test('brain:upgrade: AGENTS.md after the upgrade reflects the CONSUMER\'s brain/HOME.md (REQ-397-4)', (t) => {
  const dir = makeUpgradableConsumer('brain-397-agents-', {
    geminiSettings: { hooks: {} },
    homeMd: '# MY OWN HOME\n\nThis text belongs to the consumer, not to brain.\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = runBrainUpgrade(dir, ['--no-install']);
  const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
  const out = `${r.stdout}${r.stderr}`;

  assert.match(agents, /MY OWN HOME/,
    `AGENTS.md must be compiled from the CONSUMER's HOME.md:\n${out}`);
  assert.match(out, /AGENTS\.md/,
    'the run must SAY it regenerated the file — REQ-397-4 requires reporting it, ' +
    'because a silent regeneration is indistinguishable from the copy it replaced');

  // Byte-identical happy-path wording (task 2.2): all 5 SOURCE_DOCS readable
  // and the write succeeded, so the exact, unchanged success line must print —
  // a regression in the new branching must be caught even when the file exists.
  assert.ok(out.includes('Regenerated AGENTS.md from YOUR brain/HOME.md (it is compiled, not shipped — see #397).'),
    `expected the byte-identical success line:\n${out}`);
});

// Task 2.1 — a consumer with NO brain/HOME.md at all (the exact scenario
// #1089 was filed about): init()'s _readDoc throws for that one SOURCE_DOCS
// path, and the upgrade's message must name it instead of falsely claiming
// success.
test('brain:upgrade: brain/HOME.md missing — the regen message names it and points at the recovery command, not the byte-identical success line', (t) => {
  const dir = makeUpgradableConsumer('brain-397-nohome-', {
    geminiSettings: { hooks: {} },
    // homeMd deliberately omitted — brain/HOME.md does not exist on disk.
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = runBrainUpgrade(dir, ['--no-install']);
  const out = `${r.stdout}${r.stderr}`;

  assert.match(out, /brain\/HOME\.md/,
    `the message must name brain/HOME.md as the absent source doc:\n${out}`);
  assert.match(out, /AGENT_PLATFORM=antigravity npm run brain:env:init/,
    `the message must name the command that creates brain/HOME.md and regenerates AGENTS.md:\n${out}`);
  assert.ok(!out.includes('Regenerated AGENTS.md from YOUR brain/HOME.md (it is compiled, not shipped — see #397).'),
    `the byte-identical success line must NOT print when brain/HOME.md is missing:\n${out}`);
});

// Remediation (verify FAIL, spec scenario "A different source doc is
// missing"): brain/HOME.md IS present, but a methodology doc is not. This is
// a distinct code path from the brain/HOME.md-missing test above — it must
// hit the generic "compiled without N missing source doc(s)" branch, not the
// brain/HOME.md-specific one, and must still suppress the byte-identical
// success line.
test('brain:upgrade: a different source doc is missing — names it as compiled-without, not the HOME.md message, not the byte-identical success line', (t) => {
  const dir = makeUpgradableConsumer('brain-397-otherdoc-', {
    geminiSettings: { hooks: {} },
    homeMd: '# consumer home\n',
    missingMethodologyDocs: ['sdd-layout'],
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = runBrainUpgrade(dir, ['--no-install']);
  const out = `${r.stdout}${r.stderr}`;

  assert.match(out, /AGENTS\.md was compiled without 1 missing source doc\(s\): brain\/core\/methodology\/sdd-layout\.md/,
    `the message must name the missing methodology doc and say it was compiled without it:\n${out}`);
  assert.ok(!out.includes('Regenerated AGENTS.md from YOUR brain/HOME.md (it is compiled, not shipped — see #397).'),
    `the byte-identical success line must NOT print when a source doc is missing:\n${out}`);
  assert.ok(!out.includes('brain/HOME.md is missing'),
    `must not print the brain/HOME.md-specific message when brain/HOME.md itself is present:\n${out}`);
});

// REQ: the write itself failed. A directory where AGENTS.md belongs makes the
// write fail for real (EISDIR) instead of faking the report, so the claim is
// tested against the filesystem that produces it.
test('brain:upgrade: the AGENTS.md write fails — says so, never claims a regeneration', (t) => {
  const dir = makeUpgradableConsumer('brain-397-writefail-', {
    geminiSettings: { hooks: {} },
    homeMd: '# consumer home\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'AGENTS.md'), { recursive: true });

  const r = runBrainUpgrade(dir, ['--no-install']);
  const out = `${r.stdout}${r.stderr}`;

  assert.match(out, /Could not write AGENTS\.md — the regeneration did not complete\./,
    `an unwritable AGENTS.md must be reported, not claimed as regenerated:\n${out}`);
  assert.ok(!out.includes('Regenerated AGENTS.md from YOUR brain/HOME.md (it is compiled, not shipped — see #397).'),
    `the success line must NOT print when the write failed:\n${out}`);
  assert.ok(!out.includes('AGENTS.md was compiled without'),
    `a write failure outranks the missing-docs wording:\n${out}`);
});

// The trap, proven by behaviour rather than by reading the source: init() writes
// .gemini/settings.json too, so a plain call would undo the merge in the SAME run.
test('brain:upgrade: regenerating AGENTS.md does not undo the .gemini merge (REQ-397-3 + REQ-397-4)', (t) => {
  const dir = makeUpgradableConsumer('brain-397-noclobber-', {
    geminiSettings: { myOwnKey: 'keep me', hooks: {} },
    homeMd: '# consumer home\n',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  runBrainUpgrade(dir, ['--no-install']);
  const after = JSON.parse(readFileSync(join(dir, '.gemini', 'settings.json'), 'utf8'));

  assert.equal(after.myOwnKey, 'keep me',
    'the AGENTS.md regeneration must not rewrite .gemini/settings.json — that would clobber ' +
    'the merge performed moments earlier, in the same run');
});

// ── Already-clobbered detection (issue #397, REQ-397-6) ──────────────────────
//
// Signed decision 2. Repos that took brain's AGENTS.md in an earlier upgrade are
// carrying a silent loss right now; the first run after this ships must say so.
// Driven through the REAL CLI, because the report is the deliverable.

function makeClobberConsumer(prefix, { consumerHome, agentsOnDisk }) {
  const dir = makeUpgradableConsumer(prefix, { geminiSettings: { hooks: {} }, homeMd: consumerHome });
  const pkg = join(dir, 'node_modules', 'brain');
  // What brain's own tree carries: its HOME.md and its compiled AGENTS.md.
  mkdirSync(join(pkg, 'brain'), { recursive: true });
  writeFileSync(join(pkg, 'brain', 'HOME.md'), '# brain HOME\n');
  writeFileSync(join(pkg, 'AGENTS.md'), 'BRAIN AGENTS ARTIFACT\n');
  writeFileSync(join(dir, 'AGENTS.md'), agentsOnDisk);
  return dir;
}

// REQ-397-6 Scenario 1.
test('brain:upgrade: a previously clobbered AGENTS.md is detected and named (REQ-397-6)', (t) => {
  const dir = makeClobberConsumer('brain-397-clobbered-', {
    consumerHome: '# MY OWN HOME\n',        // they customised…
    agentsOnDisk: 'BRAIN AGENTS ARTIFACT\n', // …yet their AGENTS.md is brain's
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = (({ stdout, stderr }) => `${stdout}${stderr}`)(runBrainUpgrade(dir, ['--no-install']));

  assert.match(out, /EARLIER upgrade replaced it/i,
    `the run must report that a previous upgrade overwrote it:\n${out}`);
  assert.match(out, /git log --follow -- AGENTS\.md/,
    `REQ-397-6 requires naming how to recover it from their own history:\n${out}`);
});

// REQ-397-6 Scenario 2 — the constraint that actually shapes the mechanism.
// Note the trap: this consumer's AGENTS.md IS byte-identical to brain's. Only
// the fact that they never customised HOME.md separates them from the case
// above, and byte-identity alone must never be treated as evidence of loss.
test('brain:upgrade: a consumer who never customised HOME.md is NOT nagged (REQ-397-6 S2)', (t) => {
  const dir = makeClobberConsumer('brain-397-notclobbered-', {
    consumerHome: '# brain HOME\n',          // identical to brain's
    agentsOnDisk: 'BRAIN AGENTS ARTIFACT\n', // identical to brain's, and fine
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const out = (({ stdout, stderr }) => `${stdout}${stderr}`)(runBrainUpgrade(dir, ['--no-install']));

  assert.doesNotMatch(out, /EARLIER upgrade replaced it/i,
    `nothing of their own was ever lost — a detector that fires here fires for everyone:\n${out}`);
});

// The detection must read BEFORE the regeneration, or it inspects the file it
// just rebuilt and can never fire. An ordering bug here is invisible: the suite
// stays green and the warning simply never appears for anyone.
test('brain:upgrade: clobber detection reads AGENTS.md BEFORE regenerating it (REQ-397-6)', () => {
  const source = readFileSync(BRAIN_UPGRADE_SOURCE, 'utf8');

  const detectAt = source.indexOf('detectAgentsClobber({');
  const regenAt = source.indexOf('antigravityInit({');
  assert.ok(detectAt > 0 && regenAt > 0);
  assert.ok(detectAt < regenAt,
    'the detector must read the on-disk AGENTS.md before regeneration overwrites it — ' +
    'the file about to be rebuilt is the only evidence that an earlier upgrade replaced it');
});

// ── .gemini merge + AGENTS.md regeneration (issue #397, REQ-397-3 / REQ-397-4) ─

// REQ-397-3. `.gemini/settings.json` is the same shape as `.claude/settings.json`
// — a `hooks` object of event → entries — and #103 already built a deterministic
// merge for exactly that shape. Two sibling agent-config files being treated
// differently was an accident of which one existed first, not a decision.
test('brain:upgrade: .gemini/settings.json is a MERGE target, like its .claude sibling (REQ-397-3)', () => {
  const source = readFileSync(BRAIN_UPGRADE_SOURCE, 'utf8');

  assert.match(source, /ALL_MERGES\s*=\s*\{[\s\S]*?'\.gemini\/settings\.json':\s*merge/,
    '.gemini/settings.json must be registered in ALL_MERGES — a plain copy destroys the ' +
    'consumer\'s own hooks, which is #397 as filed');
});

// tasks.md 2.7 — #399's merge pre-flight parses every merge target up front so a
// corrupt one is reported before anything is written, rather than throwing
// mid-copy. A new merge target that skipped the pre-flight would reintroduce the
// lockout #399 exists to prevent.
test('brain:upgrade: the merge pre-flight covers every merge target, including .gemini (2.7)', () => {
  const source = readFileSync(BRAIN_UPGRADE_SOURCE, 'utf8');

  assert.match(source, /preflightMergeTargets\(\{[^}]*mergePaths:\s*Object\.keys\(mergeMap\)/,
    'the pre-flight must be derived from the merge map itself — a hand-written second list ' +
    'is a second place to forget');
});

// REQ-397-4. The regeneration must run from the CONSUMER's tree, and it must not
// take brain's own AGENTS.md with it.
test('brain:upgrade: AGENTS.md is regenerated after the copy, not copied (REQ-397-4)', () => {
  const source = readFileSync(BRAIN_UPGRADE_SOURCE, 'utf8');

  assert.match(source, /antigravity/i,
    'the upgrade must invoke the AGENTS.md generator rather than shipping the artifact');
  const copyAt = source.indexOf('copyManaged({');
  const regenAt = source.search(/regenerateAgentsMd|antigravityInit|harness\/backends\/antigravity/);
  assert.ok(regenAt > copyAt,
    'regeneration must run AFTER the managed copy — it reads the methodology docs the copy ' +
    'just updated, so running it first would compile the previous release');
});

// The trap this whole slice walks past. `antigravity.mjs#init()` writes BOTH
// AGENTS.md AND .gemini/settings.json. Calling it plainly to satisfy REQ-397-4
// would overwrite the .gemini merge REQ-397-3 just performed, in the same run —
// a wired, correct, and quietly destructive path, which is the exact defect class
// #397 exists to remove.
test('brain:upgrade: regenerating AGENTS.md must NOT rewrite the merged .gemini/settings.json (REQ-397-3 + REQ-397-4)', () => {
  const source = readFileSync(BRAIN_UPGRADE_SOURCE, 'utf8');

  assert.match(source, /_writeGeminiSettings/,
    'init() emits .gemini/settings.json too — the regeneration MUST neutralise that seam, or ' +
    'it undoes the merge performed moments earlier in the same run');
});

// ── --force-managed validation (issue #397, REQ-397-2) ───────────────────────
//
// design.md §4: both escape hatches must be validated against the REAL
// classification, not accepted as free-form globs. `--skip-merge` learned this
// the hard way — it feeds `local`, which is a glob matcher, so an unvalidated
// value was really `--skip-anything` and `--skip-merge '**'` made the upgrade
// copy nothing and report success. `--force-managed` has the opposite polarity
// and therefore the worse failure: a wildcard that forced every pending path
// would be the clobber this whole issue is about, spelled as a flag.

test('brain:upgrade: --force-managed refuses a wildcard (REQ-397-2)', (t) => {
  const dir = makeConsumerRepo('brain-397-force-glob-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = runBrainUpgrade(dir, ['--no-install', '--force-managed', '**']);
  const out = `${r.stdout}${r.stderr}`;

  assert.notEqual(r.status, 0, `a wildcard force must not be accepted:\n${out}`);
  assert.match(out, /--force-managed/, `the error must name the flag:\n${out}`);
});

// A MERGE path is not forceable: there is nothing to force, because merging
// already preserves the consumer's content. Accepting it would imply the flag
// does something it does not.
test('brain:upgrade: --force-managed refuses a path that is not REFUSE-classified (REQ-397-2)', (t) => {
  const dir = makeConsumerRepo('brain-397-force-merge-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = runBrainUpgrade(dir, ['--no-install', '--force-managed', '.claude/settings.json']);
  const out = `${r.stdout}${r.stderr}`;

  assert.notEqual(r.status, 0, `only a REFUSE-classified path may be forced:\n${out}`);
  assert.match(out, /\.claude\/settings\.json/, `the error must name the rejected path:\n${out}`);
});

// The tag is parsed as "the first argument that is not a flag". Every repeatable
// flag that takes a VALUE therefore has to be excluded by hand, or the value
// becomes the tag and the upgrade installs a ref named ".github/CODEOWNERS".
// --skip-merge already carries this exclusion; --force-managed needs its own.
test('brain:upgrade: a --force-managed VALUE is not mistaken for the tag (REQ-397-2)', (t) => {
  const dir = makeConsumerRepo('brain-397-force-tag-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // No tag given. If the flag's value leaked into the positional parse, the run
  // would proceed with tag === '.github/CODEOWNERS' and try to install a git ref
  // by that name. The missing-tag guard firing is the proof it did not.
  const r = runBrainUpgrade(dir, ['--force-managed', '.github/CODEOWNERS']);
  const out = `${r.stdout}${r.stderr}`;

  assert.notEqual(r.status, 0);
  assert.match(out, /missing <tag>/,
    `the forced PATH must not be consumed as the tag — it would be installed as a git ref:\n${out}`);
});

// The whole mechanism rests on WHEN the snapshot is taken. node_modules/brain
// holds the previous release only until the install overwrites it, so a snapshot
// moved below step 1 would read the incoming package, compare it to itself, and
// report "nothing was modified" for every consumer — green suite, dead check.
// Pinned in source because the failure is an ordering one that no unit test on
// copyManaged can see.
test('brain:upgrade: the outgoing snapshot is read BEFORE the install (REQ-397-1)', () => {
  const source = readFileSync(BRAIN_UPGRADE_SOURCE, 'utf8');

  const snapshotAt = source.indexOf('readOutgoing({');
  const installAt = source.indexOf('── 1. Install the tag');
  const copyAt = source.indexOf('copyManaged({');

  assert.ok(snapshotAt > 0, 'brain-upgrade.mjs must call readOutgoing to get the outgoing package');
  assert.ok(installAt > 0, 'the install step marker must still be findable');
  assert.ok(snapshotAt < installAt,
    'readOutgoing must run BEFORE step 1 — after the install, node_modules/brain is the ' +
    'INCOMING package and the comparison silently becomes a file against itself');
  assert.ok(copyAt > snapshotAt, 'the snapshot must precede the copy that consumes it');

  assert.match(source, /outgoing,/,
    'the snapshot must be PASSED to copyManaged — a snapshot nothing consumes protects nothing');
});

test('brain:upgrade: registers package.json under specialMerge → mergePackageJson (lock-in guard, issue #180)', () => {
  const source = readFileSync(BRAIN_UPGRADE_SOURCE, 'utf8');

  // The merge map moved out of the copyManaged call into a named ALL_MERGES constant
  // when --skip-merge landed (#399), so this asserts the binding rather than its old
  // inline position — the invariant is that package.json is MERGED, not where it is
  // declared.
  // The CALL SITE, not just the declaration. #399 moved this assertion to the
  // ALL_MERGES literal alone, and that is not the invariant — the wiring is. With only
  // the declaration pinned, `specialMerge: mergeMap` -> `specialMerge: {}` reproduced
  // issue #180 verbatim while the whole suite stayed green.
  assert.match(source, /specialMerge:\s*mergeMap\b/,
    'brain-upgrade.mjs must pass the merge map to copyManaged — a declaration nothing ' +
    'passes protects nothing (issue #180)');

  assert.match(source, /ALL_MERGES\s*=\s*\{[^}]*'package\.json':\s*mergePackageJson/,
    'brain-upgrade.mjs must register \'package.json\': mergePackageJson as a merge target — ' +
    'a plain copy would clobber the consumer\'s package.json identity again (issue #180)');

  // …and #399 opened a way to REMOVE a path from that map at runtime. Skipping a merge
  // must send the path to `local` (untouched), never to the plain-copy set, or the
  // escape hatch reintroduces exactly the clobber this guard exists to prevent.
  assert.match(source, /local:\s*\[\.\.\.local,\s*\.\.\.skipMerge\]/,
    'a --skip-merge path must join `local` so it is left alone, never plain-copied (issue #180 + #399)');
});

// ── Retired paths, driven through the REAL CLI (issue #1141) ─────────────────
// The unit tests in lib/installer.retired.test.mjs prove copyManaged removes a
// retired path. This proves the script hands it the list — read from the
// INCOMING package, because only the release that stopped shipping a file knows
// it did — and that it works under --no-install, where the outgoing package is
// already gone.
test('brain:upgrade: a file the incoming package retired leaves the consumer, a consumer file beside it stays (#1141)', (t) => {
  const dir = makeConsumerRepo('brain-1141-retired-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, 'node_modules', 'brain');
  const old = 'brain/scripts/harness/backends/claude.mjs';
  const mine = 'brain/scripts/harness/backends/my-own-backend.mjs';

  writeFileSync(join(pkg, 'brain', 'core', 'managed-paths.mjs'),
    "export const managed = ['brain/scripts/**'];\nexport const local = [];\n");
  mkdirSync(join(pkg, 'brain', 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'brain', 'scripts', 'lib', 'retired-paths.mjs'),
    `export const RETIRED_PATHS = Object.freeze([${JSON.stringify(old)}]);\n`);
  mkdirSync(join(dir, 'brain', 'scripts', 'harness', 'backends'), { recursive: true });
  writeFileSync(join(dir, old), 'export const stale = true;\n');
  writeFileSync(join(dir, mine), 'export const mine = true;\n');

  const r = runBrainUpgrade(dir, ['--no-install']);
  const out = `${r.stdout}${r.stderr}`;

  assert.equal(r.status, 0, `the upgrade must succeed:\n${out}`);
  assert.equal(existsSync(join(dir, old)), false, `the retired file must be gone:\n${out}`);
  assert.equal(readFileSync(join(dir, mine), 'utf8'), 'export const mine = true;\n', 'the consumer\'s own file must survive');
  assert.match(out, /harness\/backends\/claude\.mjs/, 'and the run must name what it removed');
});

// ── #1127 (class C): the downgrade guard must not read a corrupt input as "absent" ──

test('brain:upgrade (#1127): a corrupt brain.config.json refuses BEFORE any write, naming the file', (t) => {
  const dir = makeConsumerRepo('brain-1127-corrupt-config-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'brain.config.json'), '{ this is not json');

  const r = runBrainUpgrade(dir, ['--no-install']);
  const out = `${r.stdout}${r.stderr}`;

  assert.notEqual(r.status, 0, out);
  assert.match(out, /brain\.config\.json/, `the refusal must name the file:\n${out}`);
  assert.match(out, /Nothing was written/, `the refusal must say nothing was written:\n${out}`);
  assert.doesNotMatch(out, /Copying|Copied|managed path/i, 'no copy step may have run');
});

test('brain:upgrade (#1127): an absent brain.config.json is still the first-run case, not a refusal', (t) => {
  const dir = makeConsumerRepo('brain-1127-absent-config-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = runBrainUpgrade(dir, ['--no-install']);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /Nothing was written/);
});

test('brain:upgrade (#1127): an unreadable installed package.json is reported as a degraded downgrade guard', (t) => {
  const dir = makeConsumerRepo('brain-1127-corrupt-installed-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'node_modules', 'brain', 'package.json'), '{ nope');

  const r = runBrainUpgrade(dir, ['--no-install']);
  const out = `${r.stdout}${r.stderr}`;
  assert.match(out, /downgrade guard/i, `the degraded guard must be stated:\n${out}`);
});

test('brain:upgrade (#1127): on the downgrade path a BROKEN installed migrations module refuses before any write', (t) => {
  const dir = makeConsumerRepo('brain-1127-broken-migrations-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'brain.config.json'), JSON.stringify({ schemaVersion: '9.0.0' }));
  writeFileSync(join(dir, 'node_modules', 'brain', 'brain', 'core', 'config-migrations.mjs'), 'export const = ;\n');

  const r = runBrainUpgrade(dir, ['--no-install', '--allow-downgrade']);
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, out);
  assert.match(out, /config-migrations/, out);
  assert.match(out, /Nothing was written/, `must refuse before the copy, not crash at the migration step:\n${out}`);
});

test('brain:upgrade (#1127): an ORDINARY upgrade with a broken incoming migrations module refuses before the copy, not at the step-3 import', (t) => {
  const dir = makeConsumerRepo('brain-1127-broken-migrations-ordinary-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'node_modules', 'brain', 'brain', 'core', 'config-migrations.mjs'), 'export const = ;\n');

  const r = runBrainUpgrade(dir, ['--no-install']);
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, out);
  assert.match(out, /config-migrations/, out);
  assert.match(out, /no managed path was written/i, `must refuse before the copy:\n${out}`);
});

test('brain:upgrade (#1127): a migrations module whose own IMPORT is missing is broken, not "not installed"', (t) => {
  const dir = makeConsumerRepo('brain-1127-migrations-missing-import-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'brain.config.json'), JSON.stringify({ schemaVersion: '9.0.0' }));
  writeFileSync(join(dir, 'node_modules', 'brain', 'brain', 'core', 'config-migrations.mjs'),
    "import './does-not-exist.mjs';\nexport const migrations = [];\n");

  const r = runBrainUpgrade(dir, ['--no-install', '--allow-downgrade']);
  const out = `${r.stdout}${r.stderr}`;
  assert.notEqual(r.status, 0, out);
  assert.match(out, /Nothing was written|no managed path was written/i, out);
});
