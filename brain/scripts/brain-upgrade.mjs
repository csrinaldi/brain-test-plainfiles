#!/usr/bin/env node
// brain-upgrade.mjs — Install/update the brain core in a consumer repo.
// Usage: npm run brain:upgrade -- <tag> [--dry-run] [--no-install] [--force]
//
// What it does (ADR-0006):
//   1. Installs the requested tag:  npm i -D git+https://github.com/csrinaldi/brain.git#<tag>
//      (skip with --no-install if node_modules/brain is already the right tag).
//   2. Copies ONLY the managed paths (brain/core/**, brain/scripts/**, .gitattributes)
//      from node_modules/brain/ into this repo, overwriting them.
//   3. Migrates brain.config.json additively — new keys are added, existing
//      values are never overwritten.
//
// What it NEVER does: touch brain/project/**, brain.config.json values, .env,
// openspec/changes/**, or .memory/**. core is read-only in the consumer
// (ADR-0003). The upgrade is NOT auto-applied anywhere — you run it on purpose
// (anti-pattern: instaladores-autoactualizantes-no-inocuos).

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { copyManaged, readOutgoing, strategyFor, mergeClaudeSettings, mergePackageJson, migrateConfig, compareSemver, recoverFromJournal, acquireLock, inspectRestorePoint, preflightMergeTargets, semverOrNull, keysAheadOfTarget, installedPackageRoot, describeInstalledPackageSearch, installSpecDetail } from './lib/installer.mjs';
import { detectPM } from './lib/pm.mjs';
import { managedStrategy, STRATEGY } from '../core/managed-paths.mjs';
import { detectAgentsClobber } from './lib/agents-clobber.mjs';

const ROOT = process.cwd();
const PM = detectPM(ROOT).name;

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', red: '\x1b[31m',
};
const ok = (m) => console.log(`  ${C.green}✓${C.reset} ${m}`);
const warn = (m) => console.warn(`  ${C.yellow}⚠${C.reset} ${m}`);
const info = (m) => console.log(`  ${C.cyan}ℹ${C.reset}  ${m}`);
const die = (m) => { console.error(`  ${C.red}✗${C.reset} ${m}`); process.exit(1); };

// ── Parse args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
// A --skip-merge VALUE is positional too, so it would otherwise be picked up as the
// tag when it precedes one — silently upgrading to ".claude/settings.json".
// Same for --force-managed (#397): every repeatable flag that takes a value has to
// be excluded here by hand, or its value is installed as if it were a git ref.
const VALUE_FLAGS = ['--skip-merge', '--force-managed'];
const tag = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));
const dryRun = flags.has('--dry-run');
const noInstall = flags.has('--no-install');
const force = flags.has('--force');
const abortOnCollision = flags.has('--abort-on-collision');
const recover = flags.has('--recover');
// Repeatable: `--skip-merge <path> --skip-merge <other>`. Each value is the argument
// that FOLLOWS the flag, so they are read positionally rather than from the flag set.
const allowDowngrade = flags.has('--allow-downgrade');
const skipMerge = args.reduce((acc, a, i) => (a === '--skip-merge' && args[i + 1] ? [...acc, args[i + 1]] : acc), []);
// Repeatable and PER PATH by design (#397, signed decision 3): more typing, and
// much harder to do by accident than a single flag that forces everything pending.
const forceManaged = args.reduce((acc, a, i) => (a === '--force-managed' && args[i + 1] ? [...acc, args[i + 1]] : acc), []);

// ── The restore point, read ONCE ───────────────────────────────────────────────
// Read before any branch — including --dry-run, which previously skipped the whole
// gate because it lived inside copyManaged's `if (!dryRun)`. "Dry-run first" is the
// habit we document, so it must be the path that TELLS you an upgrade was interrupted,
// not the one that hides it.
const rp = inspectRestorePoint(ROOT);

// ── --recover ──────────────────────────────────────────────────────────────────
// Replays the restore point a KILLED run left behind. Explicit and terminal: between
// that crash and now the consumer may have repaired things by hand, so this never
// runs by itself and never chains into an upgrade.
if (recover) {
  if (rp.state === 'live-run') {
    console.error(`  ${C.red}✗${C.reset} ${rp.reason} — recovery would revert a tree it is still writing.`);
    // A pid can be recycled, and a SIGKILLed run never releases its lock, so "wait for
    // it to finish" is an instruction that may never come true. Always name the escape.
    die(`Wait for it to finish. If you are certain no upgrade is running, delete ${rp.lock.path} and re-run.`);
  }
  if (rp.state === 'corrupt') die(rp.reason + '. Inspect it by hand; nothing was changed.');
  if (!rp.journal) {
    info('Nothing to recover — no interrupted upgrade was recorded here.');
    process.exit(0);
  }
  const covered = [...rp.journal.saved, ...rp.journal.created];
  if (dryRun) {
    if (rp.journal.saved.length > 0) {
      info(`--dry-run: would restore ${rp.journal.saved.length} managed path(s) to their pre-upgrade bytes:`);
      for (const f of rp.journal.saved) console.log(`      ${C.dim}${f}${C.reset}`);
    }
    if (rp.journal.created.length > 0) {
      info(`--dry-run: would REMOVE ${rp.journal.created.length} managed path(s) that did not exist before that run:`);
      for (const f of rp.journal.created) console.log(`      ${C.dim}${f}${C.reset}`);
      warn('Anything written at those paths since the interruption — including repairs made by hand — would be removed with them.');
    }
    info('Re-run without --dry-run to actually recover.');
    process.exit(0);
  }
  const result = recoverFromJournal({ destRoot: ROOT });
  // Reported as two lists, because they are opposite actions on the operator's disk.
  // Collapsing them into one "restored" count told people their files had been put
  // back when most had been REMOVED — and on a first adoption almost every covered
  // path is a removal.
  if (result.restored.length > 0) {
    ok(`Restored ${result.restored.length} managed path(s) to their pre-upgrade bytes.`);
    for (const f of result.restored) console.log(`      ${C.dim}${f}${C.reset}`);
  }
  if (result.removed.length > 0) {
    ok(`Removed ${result.removed.length} managed path(s) that did not exist before that run.`);
    for (const f of result.removed) console.log(`      ${C.dim}${f}${C.reset}`);
    warn('Anything written at those paths since the interruption — including repairs made by hand — was removed with them.');
  }
  if (result.failed.length > 0) {
    warn(`Could NOT restore ${result.failed.length} path(s):`);
    for (const f of result.failed) console.log(`      ${C.dim}${f}${C.reset}`);
    info(`Their pre-upgrade bytes were KEPT at ${result.snapshotDir} — restore from there, then delete it.`);
    die('Recovery is INCOMPLETE. Inspect the paths above.');
  }
  // The interrupted run was SIGKILLed, so its exit handler never ran and its lock is
  // still on disk. Recovery is the cleanup for exactly that death; leaving the lock
  // would strand the next upgrade behind a refusal about a process that no longer exists.
  if (rp.lock.present && !rp.lock.alive) {
    rmSync(rp.lock.path, { recursive: true, force: true });
    info('Cleared the lock left behind by the interrupted run.');
  }
  console.log(`\n${C.green}Recovered.${C.reset} Re-run the upgrade when ready.\n`);
  process.exit(0);
}

// ── Refuse early, on the same verdict ──────────────────────────────────────────
// Before the lock, before the install, and regardless of --dry-run.
if (rp.state === 'interrupted') {
  console.error(`  ${C.red}✗${C.reset} ${rp.reason}.`);
  die(`Run '${PM} run brain:upgrade -- --recover' to put those paths back, or delete that directory to discard the record.`);
}
if (rp.state === 'corrupt') {
  console.error(`  ${C.red}✗${C.reset} ${rp.reason}.`);
  warn('This is not auto-cleared: deleting it would destroy the only copy of the previous state.');
  die(`Inspect ${join(ROOT, '.brain-upgrade-backup')} by hand. Once you have salvaged what you need — or decided you do not need it — delete that directory to unblock upgrades.`);
}
if (rp.state === 'live-run') {
  console.error(`  ${C.red}✗${C.reset} ${rp.reason}.`);
  die(`If you are certain no upgrade is running, delete ${rp.lock.path} and re-run.`);
}

// ── Lock ───────────────────────────────────────────────────────────────────────
// Taken here and nowhere else: after --recover (which must work precisely when a
// dead run's lock is still lying around) and after the verdict-derived refusals.
//
// This call site was once deleted by a careless refactor, and the whole suite
// stayed green because every lock test called acquireLock directly or staged a lock
// file by hand — so `live-run` quietly became unreachable in production while three
// documents claimed concurrency was handled. REQ-J-9 now drives the real CLI and
// asserts the lock is HELD while it works; deleting these lines fails it.
//
// A dry run writes nothing, so it takes no lock — and a SIGKILL during one would
// otherwise strand a lock with no journal to explain it.
let lock;
if (!dryRun) {
  try {
    lock = acquireLock(ROOT);
  } catch (err) {
    die(`${err.message} If no upgrade is running, that lock is stale — delete it and re-run.`);
  }
  process.on('exit', () => lock.release());
}

if (!tag && !noInstall) {
  die(`missing <tag>. Usage: ${PM} run brain:upgrade -- v0.1.0 [--dry-run] [--no-install] [--force] [--recover] [--skip-merge <path>]`);
}

// ── Self-host guard ──────────────────────────────────────────────────────────
// Running this inside the brain repo itself would copy node_modules/brain over
// the working tree — almost never what you want. The brain SOURCE repo carries
// a `.brain-source` marker file at its root (never a managed path — see
// brain/core/managed-paths.mjs, it matches no managed glob) that reliably
// identifies it. Refuse unless --force.
//
// This marker replaces the old `package.json name === "brain"` check, which
// used to die HARD here. That check false-positives on any consumer whose
// package.json was clobbered by a pre-v0.8.0 vendored upgrader (which
// plain-copied package.json instead of merging it) — permanently locking the
// clobbered consumer out of the very upgrade that would fix it (issue #180).
const sourceMarkerPath = join(ROOT, '.brain-source');
if (existsSync(sourceMarkerPath) && !force) {
  die(
    'this is the brain SOURCE repo (.brain-source marker found at repo root).\n' +
    '    brain:upgrade is for CONSUMER repos, not the brain source repo. Use --force only if you really mean it.',
  );
}

// Soft warning (non-fatal): a pre-v0.8.0 brain:upgrade plain-copied
// package.json and may have clobbered a consumer's "name" field to "brain"
// (also version/description/license). Recovery-awareness only — never
// blocks the upgrade. See brain/core/anti-patterns/ for the full writeup.
//
// THE LITERAL BELOW IS NOT `PACKAGE_NAME`, AND MUST NOT BECOME IT (#655).
// It is the fingerprint of a specific historical bug: the value a pre-v0.8.0
// clobber left on disk. Those clobbers already happened and their victims still
// carry `"name": "brain"`. Swapping this for the current package name would drop
// the warning for exactly the population it was written for, on a rename that
// has nothing to do with them.
const ownPkgPath = join(ROOT, 'package.json');
if (existsSync(ownPkgPath) && !existsSync(sourceMarkerPath)) {
  try {
    const ownPkg = JSON.parse(readFileSync(ownPkgPath, 'utf8'));
    if (ownPkg.name === 'brain') {
      warn(
        'package.json name is "brain" — a pre-v0.8.0 brain:upgrade may have clobbered your project name; consider restoring it.',
      );
    }
  } catch { /* swallow-ok: the check only warns about a pre-v0.8.0 name clobber; an unreadable package.json is reported by the install step */ /* unreadable package.json — let the install step report it */ }
}

console.log(`\n${C.bold}brain:upgrade${C.reset} ${tag ? `→ ${C.cyan}${tag}${C.reset}` : ''}${dryRun ? `  ${C.dim}(dry run)${C.reset}` : ''}\n`);

// ── Interrupt handling ─────────────────────────────────────────────────────────
// Measured on this repo (366 managed files): the managed-path write is a single
// synchronous batch that finishes in ~23ms, and Node delivers signals through the
// event loop — so a SIGINT arriving mid-batch is QUEUED, never delivered, and the
// batch always runs to completion before any handler executes.
//
// Registering these handlers is therefore NOT a way to abort a half-finished
// write. It is what changes the outcome of Ctrl-C: without a handler the default
// action kills the process instantly, which is the one thing that CAN leave a
// half-applied tree. With one, the 23ms batch finishes and the tree is whole.
//
// What these handlers do NOT cover — and an earlier revision of this comment got
// wrong: a signal during the package install above kills the CHILD, and spawnSync
// returns synchronously with `{ status: null, signal }`. That path never reaches
// the flag check below; it is handled at the install step itself, which reports
// the interrupt and exits 128+signal. The flag below covers only a signal
// delivered at an await AFTER the install returned normally.
let interrupted = null;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { interrupted ??= sig; });
}

// ── Pre-flight the merges ──────────────────────────────────────────────────────
// BEFORE step 1, and that placement is the whole point. A corrupt consumer
// `package.json` makes `npm install` itself die with EJSONPARSE, so a pre-flight
// placed after the install never runs for one of the two merge targets — the escape
// hatch would not exist for the more dangerous of the two. This depends only on ROOT
// and the merge map, so it costs nothing to run first.
// The OUTGOING package's migration list — deliberately, and this is not a compromise.
// A target tag's own list can never contain a migration ABOVE that target, so reading it
// would make the key report permanently empty. What strands a consumer is exactly what
// the package they are leaving knew and the one they are going to does not.
//
// Imported the way step 3 imports it rather than scraped: a regex over someone else's
// source is a guess, and this has to be right to name the keys correctly.
async function migrationsForGuard() {
  const file = installedPackageRoot(ROOT, 'brain', 'core', 'config-migrations.mjs');
  try {
    const mod = await import(file);
    return Array.isArray(mod?.migrations) ? mod.migrations : [];
  } catch (err) {
    // swallow-ok: ONLY the module itself being absent (not installed yet) reads as no migrations; a load failure or a missing import inside it dies below
    // Only the module ITSELF being absent is "not installed"; a missing import inside it is a broken module.
    if ((err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'ENOENT') && String(err.message).includes(file)) return [];
    // Loading it again at the migration step would crash AFTER the managed copy (#1127).
    die(`${file} cannot be loaded (${err?.message ?? err}). Nothing was written.`);
  }
}

// `.gemini/settings.json` reuses mergeClaudeSettings deliberately (#397, REQ-397-3).
// The name says "claude" for historical reasons — the function itself is generic
// over the shape BOTH files share: a `hooks` object of event → entries, merged
// additively with consumer keys preserved (#103). Two sibling agent-config files
// were treated differently only because one existed first, and a plain copy of the
// gemini one destroyed the consumer's hooks on every upgrade.
const ALL_MERGES = {
  '.claude/settings.json': mergeClaudeSettings,
  '.gemini/settings.json': mergeClaudeSettings,
  'package.json': mergePackageJson,
};
const mergeMap = Object.fromEntries(Object.entries(ALL_MERGES).filter(([rel]) => !skipMerge.includes(rel)));

// `--skip-merge` feeds `local`, which is a GLOB matcher — an unvalidated value there is
// really `--skip-anything`, and `--skip-merge '**'` would make the upgrade copy nothing
// and report success. Only a real merge target may be skipped.
const badSkip = skipMerge.filter((rel) => !Object.hasOwn(ALL_MERGES, rel));
if (badSkip.length > 0) {
  console.error(`  ${C.red}✗${C.reset} --skip-merge only accepts a merged path: ${Object.keys(ALL_MERGES).join(', ')}`);
  die(`Not skippable: ${badSkip.join(', ')}`);
}

// The REFUSE rows of the signed classification (#397). Read from the table rather
// than restated here — a second list would be a second place to forget.
const REFUSE_PATHS = Object.entries(managedStrategy)
  .filter(([, s]) => s === STRATEGY.REFUSE)
  .map(([rel]) => rel);

// `--force-managed` gets the SAME validation as --skip-merge, for a worse reason.
// --skip-merge feeds a glob matcher, so an unvalidated value was really
// `--skip-anything`. This flag has the opposite polarity: its failure mode is not
// "nothing was copied" but "everything was overwritten", which is the clobber
// this issue exists to remove, spelled as a flag. Only a REFUSE-classified path
// may be forced — a MERGE path has nothing to force (merging already preserves
// consumer content) and a COPY path is brain-owned by contract.
const badForce = forceManaged.filter((rel) => !REFUSE_PATHS.includes(rel));
if (badForce.length > 0) {
  console.error(`  ${C.red}✗${C.reset} --force-managed only accepts a REFUSE-classified path, one at a time:`);
  for (const rel of REFUSE_PATHS) console.log(`      ${C.dim}${rel}${C.reset}`);
  die(`Not forceable: ${badForce.join(', ')}`);
}

// ── Downgrade guard ────────────────────────────────────────────────────────────
// Also before step 1. `migrateConfig` only ever moves schemaVersion UP, so installing
// an older tag leaves OLD code beside a NEW config schema — a combination no tag ever
// shipped, reached silently and reported as "Done." Refusing AFTER the install would
// be worse than useless: the old package would already be in node_modules.
// `brain.config.json`'s schemaVersion has TWO writers that mean DIFFERENT things:
// `ensureBrainConfig` (env:init) writes the newest MIGRATION version, while
// `migrateConfig` (this command) writes the installed PACKAGE version. Migrations top
// out below the current package, so a freshly-adopted consumer sits at the migration
// number while running newer code — and comparing against that field alone left every
// tag above the newest migration unguarded. That was the six most recent releases: the
// exact population this gate exists for.
//
// So compare against the highest thing that is actually true about this repo.
const currentSchema = (() => {
  const configFile = join(ROOT, 'brain.config.json');
  try { return semverOrNull(JSON.parse(readFileSync(configFile, 'utf8')).schemaVersion); }
  catch (err) {
    // swallow-ok: ONLY ENOENT (no config yet, the first run) reads as no recorded schema version; every other error dies below
    if (err?.code === 'ENOENT') return null;
    // A corrupt config read as "absent" would disarm the downgrade guard and then
    // throw at the migration step, AFTER the managed copy (#1127).
    die(`${configFile} cannot be read or parsed (${err?.message ?? err}). Nothing was written. Fix or remove it and re-run.`);
  }
})();
const installedSemver = (() => {
  try { return semverOrNull(JSON.parse(readFileSync(installedPackageRoot(ROOT, 'package.json'), 'utf8')).version); }
  catch (err) {
    // surfaced: ENOENT (not installed yet) is silent; any other error warns that the installed version is not a floor
    if (err?.code !== 'ENOENT') {
      warn(`Could not read the installed package's version (${err?.message ?? err}) — the downgrade guard has no installed-version floor for this run.`);
    }
    return null;
  }
})();
const taggedSemver = semverOrNull(tag);
// With no tag (`--no-install`), the installed package IS what gets applied.
const targetSemver = taggedSemver ?? installedSemver;
// …and in that case it cannot also count as the floor, or nothing is ever a downgrade.
const floorCandidates = (taggedSemver ? [currentSchema, installedSemver] : [currentSchema]).filter(Boolean);
const floor = floorCandidates.sort(compareSemver).at(-1) ?? null;

if (targetSemver && floor && compareSemver(targetSemver, floor) < 0) {
  const ahead = keysAheadOfTarget(await migrationsForGuard(), targetSemver);
  if (!allowDowngrade) {
    console.error(`  ${C.red}✗${C.reset} ${tag ?? targetSemver} is OLDER than what this repo is on (${floor}).`);
    warn('Config migrations only run forward, so this would leave you with older code and a newer config schema — a combination no release ever shipped.');
    if (ahead.length > 0) {
      info(`These config keys would be left ahead of ${targetSemver}:`);
      for (const k of ahead) console.log(`      ${C.dim}${k}${C.reset}`);
    }
    die(`Nothing was written. Re-run with --allow-downgrade if you mean it.`);
  }
  warn(`Downgrading to ${targetSemver} from ${floor}; brain.config.json's schemaVersion does not move back — migrations only run forward.`);
  if (ahead.length > 0) {
    warn(`These config keys are ahead of ${targetSemver} and this code has never heard of them:`);
    for (const k of ahead) console.log(`      ${C.dim}${k}${C.reset}`);
  }
}

const { unparseable } = preflightMergeTargets({ destRoot: ROOT, mergePaths: Object.keys(mergeMap) });
if (unparseable.length > 0) {
  const label = dryRun ? 'would block this upgrade' : 'cannot be parsed';
  console.error(`  ${C.red}✗${C.reset} ${unparseable.length} file(s) this upgrade must merge ${label}:`);
  for (const { rel, reason } of unparseable) console.log(`      ${C.dim}${rel} — ${reason}${C.reset}`);

  // A dry run writes nothing, so there is no lockout to prevent — but staying SILENT
  // would make "dry-run first", the habit this file's own comments recommend, the one
  // path that hides the problem. Report and stop; do not pretend the plan is clean.
  if (dryRun) {
    warn('--dry-run: reported, not written. Repair them before the real run.');
    process.exit(1);
  }

  // package.json is different: npm cannot run a script without it, so `--skip-merge`
  // cannot be reached through `npm run`. Repair is the only honest advice.
  const skippable = unparseable.filter((u) => u.rel !== 'package.json');
  warn('Nothing was written.');
  if (unparseable.some((u) => u.rel === 'package.json')) {
    die('Repair package.json — npm cannot run any script while it is unparseable, so no flag can get past it.');
  }
  die(`Repair them, or skip them and upgrade everything else:\n      ${PM} run brain:upgrade -- ${tag ?? '<tag>'} ${skippable.map((u) => `--skip-merge ${u.rel}`).join(' ')}`);
}

// ── 0. Snapshot the OUTGOING package (issue #397, REQ-397-1) ───────────────────
// MUST run before step 1. Until the install lands, node_modules/brain still holds
// what brain shipped LAST time — the third point that tells "the consumer edited
// this" apart from "brain changed this". After step 1 that copy is gone, and with
// it the only evidence of consumer intent.
//
// Scope: the LITERAL rows of the classification. The two globs (brain/core/**,
// brain/scripts/**) are brain-owned by contract (ADR-0003) — editing them is out
// of contract and the existing collision warning is already the right response —
// so walking thousands of files to answer a question nobody acts on is cost
// without a reader.
//
// Which classification? The one THIS script shipped with, read from its own
// sibling. It describes the tree currently on disk, which is exactly the tree
// being measured. Reading the incoming table would describe a tree that does not
// exist yet.
const outgoingSnapshotPaths = Object.keys(managedStrategy).filter((rel) => !rel.includes('*'));
// Under --no-install there is only ONE tree: node_modules/brain is both the
// outgoing and the incoming package, so every file compares equal to itself and
// "no consumer modification" would be a fact about the method, not the repo.
// Pass null so the degradation is carried in the result rather than disguised as
// a clean bill of health.
const outgoing = noInstall
  ? null
  : readOutgoing({ pkgRoot: installedPackageRoot(ROOT), relPaths: outgoingSnapshotPaths });

// ── 1. Install the tag ─────────────────────────────────────────────────────────
// Derive the install specifier from the currently installed brain's package.json
// repository.url (always normalized to git+https://…) so HTTPS-only consumers
// (CI, containers without an SSH key) can install the private repo reliably.
// Falls back to the canonical constant when the file/field is absent — and SAYS
// so (#644): "the manifest declared this" and "I guessed" used to produce the
// same line, which is the only difference that matters when an install resolves
// to something the operator did not expect.
const specDetail = installSpecDetail(ROOT, tag);
if (specDetail.spec === null) die(specDetail.why);
if (specDetail.source === 'fallback') info(`Install spec: ${specDetail.why}`);
const spec = specDetail.spec;
const pm = detectPM(ROOT);
if (!noInstall) {
  if (dryRun) {
    info(`would run: ${[...pm.installArgs, spec].join(' ')}`);
  } else {
    info(`Installing ${spec} ...`);
    const r = spawnSync(pm.installArgs[0], [...pm.installArgs.slice(1), spec], { stdio: 'inherit', cwd: ROOT });
    // Signal BEFORE status, and this order is load-bearing. A child killed by a
    // signal reports `status: null`, so testing status first reports a plain
    // Ctrl-C as "install failed — check repo access", and collapses the
    // conventional 128+signal exit code into a bare 1. Nothing has been copied at
    // this point on either path.
    if (r.signal) {
      console.error(`\n  ${C.red}✗${C.reset} Install interrupted by ${r.signal} — no managed path was written.`);
      process.exit(r.signal === 'SIGTERM' ? 143 : 130);
    }
    // The git fallback (#655 × #644). A registry spec is only ever a BEST GUESS
    // when the consumer's install source could not be read — pnpm/yarn/bun write
    // no npm hidden lockfile, and a hoisted or workspace install may put it out
    // of reach. Rather than make that guess terminal, try the route ADR-0030
    // Amendment 1 names as the fallback for anyone who cannot reach the registry.
    //
    // Only ONE retry, and only to a DIFFERENT route: a second failure is a real
    // failure, and repeating the first spec would just be slower.
    if (r.status !== 0 && specDetail.fallbackSpec) {
      info(`${pm.name} could not install ${spec} — retrying with ${specDetail.fallbackSpec}`);
      info(`  (the install source was ${specDetail.provenance}: ${specDetail.provenanceWhy ?? 'no reason recorded'})`);
      const rf = spawnSync(pm.installArgs[0], [...pm.installArgs.slice(1), specDetail.fallbackSpec], { stdio: 'inherit', cwd: ROOT });
      if (rf.signal) {
        console.error(`\n  ${C.red}✗${C.reset} Install interrupted by ${rf.signal} — no managed path was written.`);
        process.exit(rf.signal === 'SIGTERM' ? 143 : 130);
      }
      if (rf.status !== 0) {
        die(`${pm.name} install failed for BOTH ${spec} and ${specDetail.fallbackSpec} — check registry/repo access and that the version exists.`);
      }
      ok(`Package installed from the git fallback (${specDetail.fallbackSpec}).`);
    } else {
      if (r.status !== 0) die(`${pm.name} install failed — check repo access and that the tag exists.`);
      ok('Package installed.');
    }
  }
}

// ── 2. Copy managed paths ───────────────────────────────────────────────────────
const pkgRoot = installedPackageRoot(ROOT);
if (!existsSync(pkgRoot)) {
  // Names every place `installedPackageRoot` actually probed — see #625.
  die(`${describeInstalledPackageSearch()} not found — install brain first (drop --no-install).`);
}

const { managed, local } = await import(join(pkgRoot, 'brain', 'core', 'managed-paths.mjs'));

// Files the INCOMING package no longer ships (#1141). Read from the package, not
// from this script's sibling: only the release that stopped shipping a file knows
// it did, and this script may be the consumer's older copy. A package from before
// the list existed has no module to read, and retires nothing.
const retiredModule = join(pkgRoot, 'brain', 'scripts', 'lib', 'retired-paths.mjs');
const { RETIRED_PATHS: retired = [] } = existsSync(retiredModule) ? await import(retiredModule) : {};

// The module step 3 will import is the INCOMING package's. Load it now, on every path,
// so a broken one refuses before `copyManaged` instead of crashing after it (#1127).
const incomingMigrations = join(pkgRoot, 'brain', 'core', 'config-migrations.mjs');
try {
  await import(incomingMigrations);
} catch (err) {
  die(`${incomingMigrations} cannot be loaded (${err?.message ?? err}). No managed path was written.`);
}

// A signal raised during the install above is delivered here, at the first await
// after it — before any managed path has been written.
if (interrupted) {
  // Same signal, same exit code as the install step and the final summary — `die()`
  // would exit 1 here and make one interrupt look like three different outcomes
  // depending on when it landed. Note it says "no managed path", not "nothing":
  // step 1 already rewrote package.json, the lockfile and node_modules.
  console.error(`  ${C.red}✗${C.reset} ${interrupted} received before the copy began — no managed path was written.`);
  process.exit(interrupted === 'SIGTERM' ? 143 : 130);
}

let copied, skipped, merged, collisions, consumerModified, brainChanged, modificationDetection, refused, forced, removed;
try {
  ({ copied, skipped, merged, collisions, consumerModified, brainChanged, modificationDetection, refused, forced, removed } = copyManaged({
    srcRoot: pkgRoot,
    destRoot: ROOT,
    managed,
    // A skipped merge joins `local`, not merely `specialMerge`'s complement. Dropping
    // it from the merge map alone would send it to the PLAIN COPY set — so "skip the
    // merge" would silently mean "clobber it instead", which is worse than the lockout
    // it was meant to escape. `local` is this repo's existing "the consumer owns this,
    // never touch it" channel, and it reports the path under `skipped` for free.
    local: [...local, ...skipMerge],
    dryRun,
    specialMerge: mergeMap,
    abortOnCollision,
    outgoing,
    refusePaths: REFUSE_PATHS,
    forceManaged,
    retired,
  }));
} catch (err) {
  // copyManaged snapshots every path it may write BEFORE its first write and
  // restores those bytes before re-throwing (#396), so there is normally nothing
  // half-applied to repair by hand. Say which of the two it was — a rollback that
  // only partly worked must never be reported as a clean one.
  // An interrupted previous run is not this run's failure — it is a decision the
  // operator has to make, so it gets its own wording and its own remedy.
  if (err?.interruptedRun) {
    console.error(`  ${C.red}✗${C.reset} ${err.message}`);
    die(`Run '${PM} run brain:upgrade -- --recover' to put those paths back.`);
  }

  // A refusal happens before the first write, so the write-phase wording would be
  // false in both halves — say what actually happened instead.
  if (err?.beforeAnyWrite) {
    console.error(`  ${C.red}✗${C.reset} Upgrade refused before any managed path was written: ${err?.message ?? err}`);
    die('Nothing was changed. Resolve the paths named above and re-run.');
  }

  console.error(`  ${C.red}✗${C.reset} Upgrade failed while writing managed paths: ${err?.message ?? err}`);
  // The root cause lives in `cause` whenever the rollback state had to be carried on
  // a wrapper (a frozen or non-object throw), and it is the only line that says WHY.
  if (err?.cause !== undefined) {
    console.error(`      ${C.dim}caused by: ${err.cause?.message ?? err.cause}${C.reset}`);
  }
  if (err?.rollbackIncomplete?.length) {
    warn(`Rollback could NOT restore ${err.rollbackIncomplete.length} path(s) — still modified:`);
    for (const f of err.rollbackIncomplete) console.log(`      ${C.dim}${f}${C.reset}`);
    if (err.rollbackSnapshotDir) {
      info(`Their pre-copy bytes were KEPT at ${err.rollbackSnapshotDir}`);
      info('That directory is never cleared automatically — restore from it, then delete it yourself.');
    }
    die('The tree is NOT fully restored. Inspect the paths above before retrying.');
  }
  // Scoped deliberately. Step 1 already ran the package install, which rewrote
  // package.json, the lockfile and node_modules BEFORE any snapshot was taken —
  // so "the tree is unchanged" would be a false statement to print here.
  die('Every managed path was rolled back to the bytes it had before the copy. The dependency install was NOT reverted.');
}

// ── Modification report (issue #397, REQ-397-1) ─────────────────────────────────
// Separate from the collision report below, and deliberately so: a collision says
// "these bytes differ", which was never the question. This says which files the
// CONSUMER changed — the only ones where an overwrite costs anybody anything.
//
// `brainChanged` is computed and NOT printed. A path brain updated and the
// consumer never touched is the overwhelmingly common case, it is what an upgrade
// is FOR, and listing it every release is how the one line that matters gets
// scrolled past.
if (modificationDetection === 'degraded') {
  // Said out loud rather than left to be discovered. A check that silently
  // weakens is worse than one that is absent: the run looks identical to a clean
  // three-way pass, so the operator draws a conclusion the run never reached.
  warn('--no-install: the outgoing and incoming package are the same tree, so this run CANNOT tell "you edited it" from "brain changed it".');
  info('The REFUSE guard therefore cannot fire — a file you edited may be overwritten below.');
  info('Re-run without --no-install to get the real check.');
} else if (consumerModified.length > 0) {
  warn(`${consumerModified.length} managed file(s) differ from what brain shipped last time — YOU changed these:`);
  for (const f of consumerModified) {
    console.log(`      ${C.dim}${f} ${C.reset}${C.dim}(${strategyFor(f, managedStrategy)})${C.reset}`);
  }
}

// ── Refusal (issue #397, REQ-397-2) ─────────────────────────────────────────────
// Placed BEFORE the copy summary below, which would otherwise report "Copied 0
// managed file(s)" as though the upgrade had simply found nothing to do.
if (refused?.length > 0) {
  const effect = dryRun ? 'a live upgrade would write zero files' : 'nothing was written';
  console.error(`  ${C.red}✗${C.reset} Refusing to overwrite ${refused.length} file(s) YOU changed (${effect}):`);
  for (const f of refused) console.log(`      ${C.dim}${f}${C.reset}`);
  warn('These have no meaningful merge — they are policy and prose a team rewrites wholesale, so brain will not guess.');
  info('Revert them to pick up brain\'s version, or overwrite them deliberately, one at a time:');
  console.log(`      ${C.cyan}${PM} run brain:upgrade -- ${tag ?? '<tag>'} ${refused.map((f) => `--force-managed ${f}`).join(' ')}${C.reset}`);
  if (forced?.length > 0) {
    // Named but NOT written. Saying so matters: the operator asked for an
    // overwrite and did not get one, and silence here would leave them believing
    // a forced path had been applied while its sibling blocked the run.
    warn(`${forced.length} path(s) you DID force were left untouched too — the run aborts as a whole:`);
    for (const f of forced) console.log(`      ${C.dim}${f}${C.reset}`);
  }
  if (!dryRun) process.exit(1);
}

// ── Collision report ────────────────────────────────────────────────────────────
// Emitted before the summary so the operator sees it immediately. The non-zero
// exit (under --abort-on-collision) is deferred until AFTER the plan/summary is
// printed (see below), so a `--dry-run --abort-on-collision` preview still shows
// the full "would copy/merge" plan instead of blanking it.
if (collisions.length > 0) {
  if (abortOnCollision) {
    const effect = dryRun ? 'a live upgrade would write zero files' : 'zero files were written';
    warn(`Aborting: ${collisions.length} collision(s) detected — destination differs from brain source (${effect}).`);
  } else {
    warn(`${collisions.length} collision(s) detected (destination differs from brain source). Proceeding — review the diff:`);
  }
  for (const f of collisions) console.log(`      ${C.dim}${f}${C.reset}`);
}

if (dryRun) {
  info(`would copy ${copied.length} managed file(s):`);
  for (const f of copied) console.log(`      ${C.dim}${f}${C.reset}`);
  if (merged.length) {
    info(`would merge ${merged.length} settings file(s) (consumer content preserved):`);
    for (const f of merged) console.log(`      ${C.dim}${f}${C.reset}`);
  }
  if (removed.length) {
    info(`would remove ${removed.length} file(s) brain no longer ships:`);
    for (const f of removed) console.log(`      ${C.dim}${f}${C.reset}`);
  }
} else {
  ok(`Copied ${copied.length} managed file(s) (brain/core, scripts, .gitattributes).`);
  if (merged.length) {
    ok(`Merged ${merged.length} settings file(s) additively (consumer content preserved):`);
    for (const f of merged) console.log(`      ${C.dim}${f}${C.reset}`);
  }
  if (removed.length) {
    ok(`Removed ${removed.length} file(s) brain no longer ships:`);
    for (const f of removed) console.log(`      ${C.dim}${f}${C.reset}`);
  }
}
if (skipMerge.length) {
  warn(`Skipped ${skipMerge.length} merge(s) at your request — these files were NOT updated and NOT overwritten:`);
  for (const f of skipMerge) console.log(`      ${C.dim}${f}${C.reset}`);
  info('Repair them and re-run without --skip-merge to pick up brain\'s changes to those files.');
}
if (skipped.length) {
  warn(`Skipped ${skipped.length} path(s) that overlap local ownership (local wins):`);
  for (const f of skipped) console.log(`      ${C.dim}${f}${C.reset}`);
}

// Deferred non-zero exit: the plan/summary has now been printed, so stop here —
// before config migration — when the caller asked to abort on collisions.
if (abortOnCollision && collisions.length > 0) process.exit(1);

// ── 3. Migrate brain.config.json (additive) ─────────────────────────────────────
const configPath = join(ROOT, 'brain.config.json');
const { migrations } = await import(join(pkgRoot, 'brain', 'core', 'config-migrations.mjs'));
const installedVersion = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version;

if (!existsSync(configPath)) {
  warn(`brain.config.json not found — skipping migration. Create it and re-run, or run env:init.`);
} else {
  const current = JSON.parse(readFileSync(configPath, 'utf8'));
  const { config: migrated, applied } = migrateConfig(current, migrations, installedVersion);
  if (dryRun) {
    info(applied.length
      ? `would apply config migration(s): ${applied.join(', ')}`
      : 'config already up to date — no migrations pending.');
  } else if (applied.length) {
    writeFileSync(configPath, JSON.stringify(migrated, null, 2) + '\n');
    ok(`Applied config migration(s): ${applied.join(', ')} (schemaVersion → ${migrated.schemaVersion}).`);
  } else {
    // Still persist schemaVersion bump if it advanced without key changes.
    if (migrated.schemaVersion !== current.schemaVersion) {
      writeFileSync(configPath, JSON.stringify(migrated, null, 2) + '\n');
    }
    ok('Config already up to date — no migrations pending.');
  }
  // #1165: the 1.9.1 migration adds `memory.backend: ""` (undeclared) and changes nothing else.
  // Imported from THIS script's own tree, never the target package's: an older target has no such module.
  // A consumer with no `.env` value should hear once what to do, not at its first refused pull.
  if (!dryRun) {
    const { undeclaredUpgradeNotice } = await import('./memory/lib/backend-resolve.mjs');
    const notice = undeclaredUpgradeNotice({ root: ROOT });
    if (notice) warn(notice);
  }
}

// ── 4. Regenerate AGENTS.md (issue #397, REQ-397-4) ─────────────────────────────
// AGENTS.md is NOT copied — it is a build output whose inputs straddle the
// ownership line. Four of its five sources are brain's managed methodology docs;
// the fifth, `brain/HOME.md`, belongs to the consumer. Copying the artifact
// substitutes brain's inputs for theirs.
//
// Runs AFTER the copy on purpose: the four methodology docs it reads were just
// updated by it, so regenerating earlier would compile the PREVIOUS release.
//
// The two roots are different, and the split is the whole point:
//   CODE  ← this script's own sibling (brain's generator, freshly updated)
//   DATA  ← ROOT (the consumer's HOME.md and their methodology docs)
if (!dryRun) {
  // REQ-397-6 — read BEFORE the regeneration overwrites the evidence. The file
  // about to be rebuilt is the only record that an earlier upgrade replaced it.
  const readOrNull = (p) => { try { return readFileSync(p, 'utf8'); } catch { /* swallow-ok: detectAgentsClobber treats null as "evidence absent" and warns only when evidence is present */ return null; } };
  const clobber = detectAgentsClobber({
    onDisk: readOrNull(join(ROOT, 'AGENTS.md')),
    consumerHome: readOrNull(join(ROOT, 'brain', 'HOME.md')),
    brainHome: readOrNull(join(pkgRoot, 'brain', 'HOME.md')),
    brainAgents: readOrNull(join(pkgRoot, 'AGENTS.md')),
  });
  if (clobber.clobbered) {
    warn('Your AGENTS.md is brain\'s, not yours — an EARLIER upgrade replaced it (issue #397).');
    info('You customised brain/HOME.md, but the AGENTS.md on disk was compiled from brain\'s.');
    info('Recover your previous version from your own history:');
    console.log(`      ${C.cyan}git log --follow -- AGENTS.md${C.reset}`);
    info('Regenerating it now from YOUR brain/HOME.md — this will not happen again.');
  }

  try {
    const { init: antigravityInit, REGENERATE_HINT } = await import(new URL('./axes/platform/adapters/antigravity.mjs', import.meta.url));
    // `init()` emits .gemini/settings.json TOO. Left alive, it would overwrite the
    // merge performed moments ago in this same run — a wired, correct, quietly
    // destructive path, which is the exact defect class this issue exists to
    // remove. The seam is neutralised rather than the call avoided, so AGENTS.md
    // still goes through the one generator brain's drift-guard checks against.
    const report = await antigravityInit({ _repoRoot: ROOT, _writeGeminiSettings: () => {} });

    // init() never throws (issue #256) — it reports what it could not read or
    // write instead. Word the claim from that report rather than printing an
    // unconditional success line (issue #1089): a write failure is reported
    // FIRST, regardless of missingDocs, because a claim of "regenerated" is
    // false the moment the file was not written at all.
    if (!report.agentsWritten) {
      warn('Could not write AGENTS.md — the regeneration did not complete.');
      info(`Run \`${REGENERATE_HINT}\` to rebuild it.`);
    } else if (report.missingDocs.length === 0) {
      ok('Regenerated AGENTS.md from YOUR brain/HOME.md (it is compiled, not shipped — see #397).');
    } else if (report.missingDocs.includes('brain/HOME.md')) {
      warn('brain/HOME.md is missing — AGENTS.md was compiled from the methodology docs only, not from anything of yours.');
      info(`Run \`${REGENERATE_HINT}\` to create brain/HOME.md and regenerate AGENTS.md from it.`);
    } else {
      warn(`AGENTS.md was compiled without ${report.missingDocs.length} missing source doc(s): ${report.missingDocs.join(', ')}`);
      info(`Run \`${REGENERATE_HINT}\` to rebuild it once they exist.`);
    }
  } catch (err) { /* follow-up: slice-B a failed AGENTS.md regeneration is a warning plus a hint, then the run still prints "Done." */
    // Never fatal. The upgrade itself succeeded; a stale AGENTS.md is a
    // regenerable inconvenience, and failing the run here would turn it into a
    // reason to distrust the upgrade.
    warn(`Could not regenerate AGENTS.md — ${err?.message ?? err}`);
    info('Run `AGENT_PLATFORM=antigravity npm run brain:env:init` to rebuild it.');
  }
}

console.log(`\n${C.green}Done.${C.reset} Review the diff and commit. ${C.dim}core is read-only — improvements go upstream.${C.reset}`);
console.log(`${C.dim}Tip:${C.reset} run ${C.cyan}npm run env:init${C.reset} to (re)configure git hooks (${C.dim}core.hooksPath${C.reset} is per-clone, not committed) and the environment. ${C.dim}day:start also self-heals it.${C.reset}\n`);

// A deferred interrupt. Exactly WHEN it landed is not knowable here — it may have
// arrived during the write, the config migration, or this summary — so the report
// states only what is certain, then honours the signal in the exit code.
if (interrupted) {
  if (dryRun) {
    warn(`${interrupted} received during a dry run — nothing was written.`);
  } else {
    warn(`${interrupted} was received and deferred. The managed-path write is a single synchronous batch that a signal cannot interrupt, so it ran to completion: the upgrade is applied, not half-applied. Nothing to clean up.`);
  }
  process.exit(interrupted === 'SIGTERM' ? 143 : 130);
}
