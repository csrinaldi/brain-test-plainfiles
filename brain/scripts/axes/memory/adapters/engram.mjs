#!/usr/bin/env node
// brain/scripts/axes/memory/adapters/engram.mjs — engram backend for the MEMORY_BACKEND dispatcher.
//
// Encapsulates all engram-specific operations. Exported functions are called by
// brain/scripts/memory/cli.mjs; no caller should invoke the `engram` binary directly.
//
// Operations:
//   share()              — export live memory to .memory/ (engram sync)
//   pull()               — import .memory/records/ into engram (records-only, D2/C4)
//   index()              — project brain/ docs into engram (delegates to brain-to-engram.mjs)
//   setup()              — ensure .engram → .memory symlink
//   featureCheckpoint()  — dehydrate: stamp + validate + write resume.md (REQ-S2-1, REQ-E-1)
//   featureResume()      — hydrate: project openspec/changes/<feature>/*.md into LOCAL engram
//                          under a DISTINCT project namespace so brain:memory:share never exports
//                          these observations (CONFIRMED: engram sync --export is project-
//                          scoped; feature obs under brain-feature-<X> stay out of .memory/)

// #247/#863 D3 — the chunk read-back is a boundary now (guard:
// brain/scripts/memory/chunk-boundary.test.mjs). The seven-row ledger of what
// 3.2 (#874) deletes is restated in
// openspec/changes/archive/2026-09-10-issue-247-chunk-boundary/{tasks,design}.md.
// Rows 1, 2, 4 and 5 are gone — `share()` (#874 split B) no longer calls
// `engram sync --export`, has no observation reader and no chunk-scrub
// subsystem left, and `engram.share.test.mjs`'s old shape retired with
// them. Row 3 (the records dual-write exporter's own `_readObservations`
// seam) is retired too now — #955 (epic task 2.4) deleted the function
// that owned it instead of giving it the future caller the O1 disposition
// held it open for. Row 6 (symlink confinement) closed with #955 (Slice A,
// PR #965). Row 7 (legacy gz path): #955 Slice B deleted `scrubChunkFile`
// and `.memory/legacy/`; `collectChunkObservations` is KEPT (R3) — forward
// `migrate-v1` still calls it. All seven rows are closed.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveFeature } from "../../../memory/lib/feature-resolution.mjs";
import { planDuplicateHeal, parseEngramVersion, isTestedVersion } from "../../../memory/lib/engram-heal.mjs";
import { changeDir, OPERATIONAL_ARTIFACTS } from "../../../lib/sdd-layout.mjs";
import { parseFrontmatter, serializeFrontmatter } from "../../../memory/lib/resume-frontmatter.mjs";
import { validateResume } from "../../../memory/lib/resume-schema.mjs";
import { currentBranch } from "../../../lib/git-branch.mjs";
import { resolveSecretConfig, compilePatterns, scanTextForSecrets } from "../../../memory/lib/secret-scrub.mjs";
import { importRecord } from "../../../memory/lib/engram-import.mjs";
import { appendRecord, rebuildIndex, readRecordIds, readRecords } from "../../../memory/lib/store.mjs";
import { upstreamRecordEntries } from "../../../memory/lib/upstream-records.mjs";
import { defaultGitPull } from "../../../memory/lib/reconcile-pull.mjs";
import { normalizeDuplicates } from "../../../memory/lib/duplicates.mjs";
import { buildRecord, serializeRecord, nowUtcSeconds, RECORD_TYPES } from "../../../memory/lib/format.mjs";
import { unsupportedOp } from "../../../memory/lib/unsupported-op.mjs";
import { acquireHydrationGuard } from "../../../memory/lib/hydration-guard.mjs";
import { ENGRAM_BIN, probeBinary } from "../../../memory/lib/backend-selection.mjs";
import { gitConfigGet } from "../../../lib/git-config.mjs";
import { resolveActor, resolveActorKind, deriveIssue, composeSource } from "../../../memory/lib/capture-provenance.mjs";
import { classifySupersedes } from "../../../memory/lib/supersedes.mjs";
import { loadBrainConfigOrThrow } from "../../../lib/brain-config.mjs";
import { t } from "../../../i18n/t.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/**
 * ensureMemorySymlink(root) — idempotent: guarantees .engram → .memory symlink.
 *
 * Scenarios (ADR-0002 / REQ-S0-1):
 *   1. .memory/ exists, .engram absent          → create symlink.
 *   2. .memory/ exists, .engram is a symlink    → already correct, no-op.
 *   3. .memory/ exists, .engram is a real dir   → warn and skip (do not clobber).
 *      This protects machines that have not yet pulled the git mv migration.
 *   4. .memory/ absent                          → warn and skip (fresh clone pre-import).
 *
 * @param {string} [root=repoRoot]  Repo root; defaults to this package's root.
 *                                  Override in tests to use temp directories.
 */
export function ensureMemorySymlink(root = repoRoot) {
  const symlinkPath = join(root, ".engram");
  const targetPath = join(root, ".memory");

  // Does the target (.memory/) exist at all?
  let targetExists = false;
  try {
    lstatSync(targetPath);
    targetExists = true;
  } catch { /* swallow-ok: an lstat probe; absence is answered by the warning and skip that follow (the symlink is the engram adapter's private artifact) */
    /* not found */
  }

  if (!targetExists) {
    console.warn("  ⚠ .memory/ does not exist yet — skipping symlink creation");
    return;
  }

  // What is .engram right now?
  let engramStat = null;
  try {
    engramStat = lstatSync(symlinkPath);
  } catch { /* swallow-ok: an lstat probe: an absent .engram is the normal fresh-clone state and the branch below creates it */
    /* .engram does not exist — normal post-migration state on a fresh clone */
  }

  if (engramStat === null) {
    // Normal case: create the symlink.
    symlinkSync(".memory", symlinkPath);
    console.log("  ✓ .engram → .memory symlink created");
  } else if (engramStat.isSymbolicLink()) {
    // Already a symlink — idempotent, nothing to do.
    console.log("  ✓ .engram → .memory symlink already in place");
  } else {
    // .engram is a real file or directory — do not clobber; warn instead.
    // Most likely cause: this machine has not yet pulled the git mv migration.
    console.warn(
      "  ⚠ .engram is a real directory — pull the migration before re-running setup",
    );
  }
}

/**
 * Resolve the `engram` binary. Throws if not found.
 *
 * Resolution runs through `probeBinary` (issue #641) rather than a local
 * `spawnSync("which", …)`, so the dispatcher's fallback decision and this
 * refusal read the SAME expression. Two copies is the #340 shape: the dispatcher
 * could conclude "absent, substitute" while this one concluded "present, run" on
 * a rule that had drifted, and the mismatch would surface as a backend nobody
 * chose.
 *
 * The absent-message is unchanged, byte for byte. What is NEW is the third
 * branch: `which` failing to RUN used to land in `status !== 0` and be reported
 * as "engram binary not found" — a probe outage wearing the costume of a
 * confident answer, which is `evidence-reader-empty-on-failure` exactly. "I
 * could not check" now says so and names why.
 */
function requireEngram() {
  const probe = probeBinary(ENGRAM_BIN);
  if (probe.available === true) return ENGRAM_BIN;
  if (probe.available === false) {
    throw new Error("engram binary not found. Install via: gentle-ai install");
  }
  throw new Error(`engram binary could not be resolved — ${probe.reason}`);
}

/**
 * share() — the `plainfiles.share()` mirror (R11, D6, #874 split B row —
 * ledger row list below). The exporter is retired: `share` is no longer a
 * producer (spec: "share commits what is already true"). It runs a bare
 * `rebuildIndex()` self-check exactly like `plainfiles.share()` — records
 * already ARE the store, so there is no data movement left to orchestrate.
 *
 * Symlink confinement (#955, R7): `share()` no longer touches `.engram` —
 * ensuring it is `setup()`'s job alone. `share`/`pull` MUST NOT create or
 * repair the symlink on the way.
 *
 * Completes with the engram binary ABSENT (rule 3, R11): there is no
 * `_requireEngram()` call here any more — nothing downstream of this
 * function touches the binary.
 *
 * @param {object} [opts]  Injectable seams for testing.
 * @param {string} [opts.root]  Repo root.
 * @param {typeof rebuildIndex} [opts._rebuildIndex]
 * @returns {Promise<{indexCount: number, duplicates: object}>}
 */
export async function share({
  root = repoRoot,
  _rebuildIndex = rebuildIndex,
} = {}) {
  const { count, duplicates } = _rebuildIndex({
    recordsDir: join(root, ".memory", "records"),
    indexPath: join(root, ".memory", "index.jsonl"),
  });
  return { indexCount: count, duplicates: normalizeDuplicates(duplicates) };
}

/**
 * Default seam: reads `brain.config.json` for the `governance.memorySecret*`
 * keys, via `loadBrainConfigOrThrow` (#942). ENOENT still returns `{}`
 * (absence stays green, R12/REQ-SCAN-3); every OTHER read/parse failure
 * PROPAGATES (#712, REQ-SCAN-1) — a read carrying both a DENY-direction key
 * (`memorySecretPatterns`) and an ALLOW-direction key
 * (`memorySecretAllowPatterns`) cannot be half-propagated (R1/REQ-SCAN-2).
 *
 * D4 (design.md): `save()` is this function's only wiring point.
 * The records dual-write exporter this doc once ALSO named as a wiring
 * point (kept callerless since #874 split B "for a future caller per O1")
 * is gone now — #955 R5 (epic task 2.4) deleted it outright rather than
 * giving it that caller, so there is only ever one implementation of this
 * rule to keep hardened.
 *
 * @param {string} root
 * @returns {object}
 */
function _defaultLoadBrainConfig(root) {
  return loadBrainConfigOrThrow(root);
}

/**
 * Default seam: resolve a path through symlinks, or `null` when it does not
 * exist (issue #469, REQ-469-3). Was separated so `share()`'s former
 * export-destination check (`assertExportDestinationIsRead`, retired #874
 * split B row 4) was testable without building a real symlink. No current
 * caller — left for the maintainer/2.4 to retire alongside the rest of the
 * chunk estate rather than expanding this PR's ledger past what tasks.md
 * names.
 *
 * @param {string} p
 * @returns {string|null}
 */
export function _defaultResolveDir(p) {
  try {
    return realpathSync(p);
  } catch { /* swallow-ok: an unresolvable directory reads as null, this seam's documented "not resolvable" answer */
    return null;
  }
}

// ---------------------------------------------------------------------------
// pullMemory — churn-resilient memory pull (issue #59)
// ---------------------------------------------------------------------------

// The default `_gitPull` seam is `defaultGitPull()`
// (`../../../memory/lib/reconcile-pull.mjs`), shared with plainfiles.mjs#pull:
// fetch, reconcile byte-identical untracked records (#1118), literal `git pull`.

/**
 * Default seam: read every record currently in `.memory/records/`, ONE per
 * `id`, WITH the duplicate accounting. Deduped at the reader since #574 —
 * `engram import` INSERTS, so a union-merged duplicate physical line that
 * reaches the payload twice becomes two observations in the live layer,
 * permanently (importMemory's own measured note below). The dedup that used to
 * happen only at index time now also happens on the hydration path.
 *
 * Returns the `{records, duplicates}` pair rather than a bare array so the
 * `import` verb can REPORT what it collapsed. That matters more here than
 * anywhere else: `import` is what the post-merge hook runs, i.e. the moment
 * right after the merge that mints the duplicate, and it is the one automated
 * call site that keeps stderr.
 *
 * @param {string} root
 * @returns {{records: object[], duplicates: object}}
 */
export function _defaultReadRecordObservations(root) {
  return readRecords({ recordsDir: join(root, ".memory", "records") });
}

/**
 * importMemory() — hydrate local engram from `.memory/records/*.jsonl`
 * (records-only, design.md Decision 2 / D2, C4 #229). Replaces the former
 * thin `engram sync --import` chunk wrapper — the chunks path is retired,
 * `records/` is the sole read+write truth (REQ-C4-2).
 *
 * Read `.memory/records/*.jsonl` via readRecords → transform each
 * record via importRecord() → write per-record via `engram save` (the exact
 * per-observation verb already used by _defaultEngramSave()). No bulk verb
 * exists, so per-record with progress reporting is the honest primitive for
 * the ~275 records in the real store.
 *
 * IDEMPOTENT (MANDATORY, REQ-C4-2 scenario 2): `topic: record.id` is passed
 * on every save — the record's own content-addressed id becomes the engram
 * `topic_key`. engram's real topic_key match (same project+scope) UPSERTS
 * the existing observation instead of inserting a new one, and — unlike its
 * separate content-hash dedup path — this match is NOT time-windowed, so it
 * holds across arbitrarily-spaced re-runs. Re-running pull over an
 * already-populated engram therefore revises the same 275 observations, it
 * never duplicates them.
 *
 * Called by:
 *   - pullMemory() as its default _import seam
 *   - cli.mjs "import" verb (import-only, no manifest restore, no git pull)
 *   - post-merge hook (via cli.mjs import)
 *   - day-start step 5 (via cli.mjs import, after step 2 already pulled)
 *
 * @param {object} [opts]
 * @param {string} [opts.root]  Repo root (defaults to this package's root).
 * @param {() => string} [opts._requireEngram]
 *   Resolves the engram binary; throws a friendly error if absent.
 * @param {(root: string) => {records: object[], duplicates?: object}} [opts._readRecords]
 *   Returns every record observation under `.memory/records/` (one per `id`),
 *   plus the duplicate accounting it collapsed getting there (#574).
 * @param {(record: object) => object} [opts._importRecord]
 *   Transforms one record into an engram-observation shape.
 * @param {(title: string, content: string, opts: object) => void} [opts._engramSave]
 *   Writes one observation to engram. Called once per record.
 * @param {(line: string) => void} [opts._log]
 *   Progress/summary sink — defaults to console.log.
 * @returns {Promise<{written: number}>}
 */
export function buildImportPayload({
  records,
  existingTopicKeys,
  startedAt,
  root = repoRoot,
  _importRecord = importRecord,
}) {
  // The delta. A record already in engram is SKIPPED rather than re-sent,
  // because `engram import` INSERTS — it does not upsert by topic_key, measured
  // directly: importing one file twice turned 2 observations into 4. All
  // deduplication therefore has to happen here, before the payload is built.
  //
  // Equivalent to the upsert this replaces ONLY because brain records are
  // immutable: an id is content-derived, so an edit yields a NEW record instead
  // of mutating one already imported. `engram.batch-import.test.mjs` pins that
  // premise separately — it is the test that fails first if it ever breaks.
  //
  // The `seenInBatch` half is #574's rule applied where it bites hardest. The
  // reader now hands over one record per id (`readRecords`), so this is the
  // belt to that suspenders — but it is not decoration: `engram import`
  // INSERTS, the duplicate it creates is permanent (nothing self-heals it, per
  // the note in importMemory), and the input is a log a `git merge` is allowed
  // to append repeats to. A dedup this cheap belongs on both sides of the seam.
  const seenInBatch = new Set();
  const fresh = records.filter((r) => {
    if (existingTopicKeys.has(r.id) || seenInBatch.has(r.id)) return false;
    seenInBatch.add(r.id);
    return true;
  });
  const skipped = records.length - fresh.length;

  // Nothing new: return no payload at all rather than an empty one. An empty
  // payload would still cost a process spawn, on the steady-state path that
  // every `git pull` runs.
  if (fresh.length === 0) return { payload: null, written: 0, skipped };

  // One synthetic session per project. Measured against the real binary: an
  // observation whose session row is missing fails with `FOREIGN KEY constraint
  // failed`, and `session_id: null` fails identically — the session row is what
  // establishes the project. Per project, not one global row, so a records file
  // spanning several projects cannot hang observations off the wrong one.
  //
  // `directory: root` (#1116, parent #864, found by #1081 F6): engram 2.x's
  // `import` REJECTS a session with no `directory` — "pulled session
  // directory is invalid: directory is required" — so a FRESH engram 2.x
  // store could never be hydrated from `.memory/records/` at all; the whole
  // batch fails closed (all-or-nothing, see `_defaultEngramImport`'s own
  // note above). Measured against the real binary both ways (issue #1081
  // evidence 45): engram 2.0.0 refuses the payload without it and accepts it
  // with it; engram 1.20.0 accepts the same field as harmless extra
  // metadata, so this is safe across both tested majors. `root` is already
  // the repo root every other `root`-accepting export in this file defaults
  // to (`repoRoot`), so no new concept is introduced — it is simply threaded
  // one level deeper, into the payload engram actually sees.
  const sessions = [];
  const sessionFor = new Map();
  for (const r of fresh) {
    const project = _importRecord(r).project;
    if (sessionFor.has(project)) continue;
    const id = `brain-batch-import-${project}`;
    sessionFor.set(project, id);
    sessions.push({ id, project, directory: root, started_at: startedAt, ended_at: null, summary: null });
  }

  const observations = fresh.map((r) => {
    const o = _importRecord(r);
    return {
      title: o.title,
      content: o.content,
      type: o.type,
      project: o.project,
      scope: o.scope,
      // The record id IS the topic key: the anchor the NEXT run reads back to
      // recognise this record as already present. Without it the delta has
      // nothing to match on and every run re-imports everything.
      topic_key: r.id,
      session_id: sessionFor.get(o.project),
      created_at: o.created_at,
      updated_at: o.created_at,
      last_seen_at: o.created_at,
      duplicate_count: 0,
      revision_count: 0,
    };
  });

  return {
    payload: { version: "0.1.0", exported_at: startedAt, sessions, prompts: [], observations },
    written: fresh.length,
    skipped,
  };
}

export async function importMemory({
  root = repoRoot,
  _requireEngram = requireEngram,
  _readRecords = _defaultReadRecordObservations,
  _importRecord = importRecord,
  _engramExistingTopicKeys = _defaultExistingTopicKeys,
  _engramImport = _defaultEngramImport,
  _log = console.log,
  _warn = console.error,
  _now = () => new Date().toISOString().replace("T", " ").slice(0, 19),
  _guard = acquireHydrationGuard,
} = {}) {
  _requireEngram();

  // Tolerant of a seam that still returns a bare array (#574 changed this
  // shape). The module already wrote `normalizeDuplicates` so an older
  // `_rebuildIndex` seam degrades to "measured nothing"; giving the reader seam
  // no such tolerance while changing its shape in the same PR was the
  // asymmetry. An array means "records, no accounting", not a TypeError.
  const read = _readRecords(root);
  const records = Array.isArray(read) ? read : (read?.records ?? []);
  const duplicates = Array.isArray(read) ? undefined : read?.duplicates;
  const total = records.length;

  if (total === 0) {
    _log(await t("memory.import.empty"));
    return { written: 0, duplicates: normalizeDuplicates(duplicates) };
  }

  // Reading what engram already holds is the delta's only input, and it runs
  // before anything is written. The store may be empty, locked, or written by a
  // different engram version.
  //
  // This FAILS CLOSED, and the reason is measured rather than assumed. Degrading
  // to "import everything" is not "correct, merely slower" — `engram import`
  // INSERTS, so re-sending known records DUPLICATES them:
  //
  //   import p1 (rec-a, rec-b) → obs=2
  //   import p2 (rec-c)        → obs=3
  //   import p1 again          → obs=5   keys=[rec-a, rec-a, rec-b, rec-b, rec-c]
  //
  // And it is permanent: the next run reads those keys back and skips them, so
  // nothing self-heals. One transient lock on the `git pull` path — where this
  // runs with output suppressed — would silently double the store.
  //
  // A hydration that did not happen is recoverable by running again. Duplicates
  // are not. So: skip the import, SAY why, let the next run retry.
  //
  // ── The TWIN hazard (#820) ──────────────────────────────────────────────
  // The guard above covers "my read failed". It does not cover "my read
  // succeeded, and so did someone else's, at the same time": two importers
  // through one snapshot both see the same delta and both INSERT it. Fired
  // three times on 2026-09-01 — one instance the record about #820 itself —
  // on a path that runs at every session start and every post-merge, with
  // sixty worktrees sharing ONE store. The read→write window below is
  // therefore held under a machine-scoped, NON-BLOCKING guard
  // (lib/hydration-guard.mjs): a second importer skips, says so on stderr,
  // and returns `contended`. It never waits — post-merge is `|| true` on
  // purpose. This is MITIGATION; the fix is #863's backend contract
  // (hydration idempotent by record id), under which no guard is needed.
  // Under MEMORY_BACKEND=plainfiles `import` is rebuildIndex, idempotent by
  // construction, and this guard is never wired in.
  //
  // The distinction the reader must preserve is "the store is genuinely empty"
  // (an empty Set — import everything, correctly) versus "the store could not be
  // read" (a throw, or anything that is not a Set). Conflating those two is the
  // `evidence-reader-empty-on-failure` class; this is the consumer end of it,
  // where the policy on empty is the destructive one.
  const guard = _guard();
  if (!guard.held) {
    const age = Math.round((guard.owner?.ageMs ?? 0) / 1000);
    _warn(await t("memory.import.contended", { pid: guard.owner?.pid ?? "?", age }));
    return { written: 0, skipped: 0, deferred: true, contended: true, duplicates: normalizeDuplicates(duplicates) };
  }

  // Everything between acquire and release is SYNCHRONOUS — no await. That is
  // NOT the cross-process safety property (rev-1 cold review of PR #872,
  // cold-2): two OS processes interleave at the syscall level regardless of
  // what this event loop awaits. Cross-process safety is the guard's atomic
  // rename (lib/hydration-guard.mjs). Synchronicity buys two smaller things:
  // no second importer in THIS process can enter the window, and the
  // #820-shape test can express the race with the existing sync seams.
  let existingTopicKeys = null;
  let unreadable = null;
  let outcome = null;
  try {
    try {
      existingTopicKeys = _engramExistingTopicKeys();
    } catch (err) { /* surfaced: engram's stderr is surfaced in the thrown error — that is the point of this block (#433) */
      // execFileSync captures engram's stderr on `pipe`; surfacing it is the whole
      // point — #433 survived as long as it did because this path runs quiet.
      unreadable = explainEngramFailure(err);
    }
    if (!unreadable && !(existingTopicKeys instanceof Set)) {
      unreadable = "the reader returned no key set";
    }
    if (!unreadable) {
      outcome = buildImportPayload({ records, existingTopicKeys, startedAt: _now(), root, _importRecord });
      if (outcome.payload) _engramImport(outcome.payload);
    }
  } finally {
    guard.release();
  }

  if (unreadable) {
    // To STDERR, not stdout. The post-merge hook redirects stdout to /dev/null,
    // so a skipped hydration on the `git pull` path would otherwise be as silent
    // as the duplication it replaced — better, but still invisible. `|| true` in
    // the hook keeps this from ever blocking a merge.
    _warn(await t("memory.import.stateUnreadable", { reason: unreadable }));
    return { written: 0, skipped: 0, deferred: true, duplicates: normalizeDuplicates(duplicates) };
  }

  const { written, skipped } = outcome;

  _log(await t("memory.import.done", { written, total }));
  // `total` is unique RECORDS, not physical lines — it always was the length of
  // what this function imports, and since #574 the reader collapses repeats, so
  // the two stopped being the same number. The gap is what `duplicates` states.
  return { written, skipped, duplicates: normalizeDuplicates(duplicates) };
}

/**
 * pullMemory() — churn-resilient memory pull (issue #59).
 *
 * The manifest-churn-discard step this function once ran first is retired
 * (#955, R6): the tracked derived-index file it discarded churn from has had
 * no writer since #874 split B, so there is nothing left to discard before a
 * pull. This function now:
 *   1. Runs `git pull` (the `merge=union` driver handles any record conflicts).
 *   2. Rebuilds `.memory/index.jsonl` from the merged `records/` (#574).
 *   3. Calls importMemory() to hydrate local engram from the merged .memory/.
 *
 * Step 2 is where #574's rule reaches the engram side of `pull()`. The `git
 * pull` in step 1 is the exact event that MINTS a duplicate physical line
 * (`merge=union`, ADR-0017 REQ-MF-3), and this path used to walk straight
 * from there into hydrating the live layer — never rebuilding the derived
 * index, never reading the log, reporting nothing. `plainfiles.pull()` has
 * always been `git pull` + reindex; both backends now say the same thing
 * about the same store. Ordering matters as much as presence: the reindex is
 * the fail-closed gate, so a store that cannot be indexed — a TAMPERED line,
 * which is the only refusal left — refuses BEFORE engram is hydrated from it,
 * rather than after. (Two lines claiming one id with different bytes is NOT
 * that case: it is reported as divergent and resolved first-wins.)
 *
 * Use pullMemory() for cross-machine syncs (npm run brain:memory:pull).
 * Use importMemory() when git pull already ran (post-merge hook, day-start step 5).
 *
 * Injectable seams make the function fully unit-testable without real git/engram:
 *
 * @param {object} [opts]
 * @param {string}  [opts.root]              Repo root (defaults to this package's root).
 * @param {(root: string) => void}     [opts._gitPull]
 *   Runs `git pull`; MUST throw on non-zero exit so import is not called on failure.
 * @param {() => void | Promise<void>} [opts._import]
 *   Runs the import step — defaults to importMemory().
 */
export async function pullMemory({
  root = repoRoot,
  _gitPull = defaultGitPull,
  _rebuildIndex = rebuildIndex,
  _import = importMemory,
} = {}) {
  // Step 1: pull latest commits (throws on failure — import must not run).
  _gitPull(root);

  // Step 2: rebuild the derived index from the just-merged records/ (#574).
  // Throws on a store the merge left unindexable — hydration must not run on
  // one, so this deliberately sits BEFORE the import.
  const { count, duplicates } = _rebuildIndex({
    recordsDir: join(root, ".memory", "records"),
    indexPath: join(root, ".memory", "index.jsonl"),
  });

  // Step 3: hydrate local engram from the newly merged .memory/.
  await _import({ root });

  return { indexCount: count, duplicates: normalizeDuplicates(duplicates) };
}

/**
 * pull() — import .memory/records/ into engram using the churn-resilient safe
 * pull. Replaces the former thin `engram sync --import` chunk wrapper — the
 * chunks path is retired (records-only, D2/C4).
 * Called by brain/scripts/memory/cli.mjs when op = "pull".
 */
export async function pull() {
  return pullMemory();
}

// ---------------------------------------------------------------------------
// save — the record-first producer path (#874, split A). `search` keeps the
// Q1 asymmetry's engram-side refusal below; `save` no longer shares it
// (D7) — engram already has a native `mem_search`, but `save`'s route is now
// THIS one, mirrored from `plainfiles.save()` (R1) rather than deferred to
// `mem_save`, which writes past `.memory/records/` entirely.
// ---------------------------------------------------------------------------

/** The repository this record belongs to, from config, falling back to the checkout
 *  directory name. Duplicated from plainfiles.mjs verbatim (R1) — no shared-core
 *  extraction; the correctness-critical logic already lives in the shared libs
 *  this function calls into.
 *
 *  Exported (issue #1112, finding 3) so `brain-to-engram.mjs` — a THIRD
 *  reader, not a backend adapter — resolves the project the same way this
 *  adapter's own `save()` does, instead of reading `config.project.name`
 *  directly (empty after `env:init`, which only ever sets `project.slug`).
 *  This does not reopen R1: R1 is about the two BACKEND adapters
 *  (plainfiles/engram) staying independent, not about every other caller
 *  reinventing project resolution. */
export function deriveProject(config, root) {
  const slug = config?.project?.slug;
  if (typeof slug === "string" && slug.trim() !== "") return slug.split("/").pop();
  const name = config?.project?.name;
  if (typeof name === "string" && name.trim() !== "") return name;
  return String(root).replace(/\/+$/, "").split("/").pop();
}

/**
 * save() — the engram-side mirror of `plainfiles.save()` (R1): scan-then-write
 * to `.memory/records/<yyyy-mm>-<id>.jsonl`, rebuild the index, THEN hydrate
 * the active backend from that one record via `hydrate()` as the terminal
 * step. The record is durable BEFORE hydrate ever runs (spec: "a capture is
 * durable before the backend runs") — a hydrate failure never makes the
 * capture appear lost (R5), it is reported as `deferred`/`contended`.
 *
 * Gate order is IDENTICAL to `plainfiles.save()`, pinned by the cross-backend
 * parity test (save-parity.test.mjs, R2): caller-mistake refusals (`type`,
 * `--issue` shape) → actor/provenance (#738) → `classifySupersedes` (#805) →
 * `buildRecord` → `scanTextForSecrets` over the serialized candidate →
 * `appendRecord` → `rebuildIndex` → `hydrate`.
 *
 * @param {string} title
 * @param {string} content
 * @param {{type: string, project: string, issue?: number, supersedes?: string, scope?: string, topic?: string}} [opts]
 * @param {object} [seams]  root, getBranch, getTimestamp, getHostname, getGitConfig, getEnv,
 *   _appendRecord, _rebuildIndex, _loadConfig, _readRecordIds, _upstreamRecordEntries, _hydrate
 * @returns {Promise<{id: string, file: string, written: boolean, hydrated: boolean,
 *   deferred?: true, contended?: true, reason?: string, indexCount?: number, duplicates: object}>}
 */
export async function save(
  title,
  content,
  // scope/topic are accepted for _defaultEngramSave arg-shape parity — the record
  // format has no home for them (out of scope, same as plainfiles), so they are
  // ignored LOUDLY (a console.warn naming them) rather than erroring. `hydrate()`
  // NEVER reads the caller's `topic`: the topic_key it hydrates under is always
  // the record's own id (R6), never this field.
  { type, project, issue, supersedes, scope, topic } = {},
  {
    root = repoRoot,
    getBranch = _getGitBranch,
    getTimestamp = nowUtcSeconds,
    getHostname = () => osHostname(),
    getGitConfig = (key) => gitConfigGet(key, root),
    getEnv = () => process.env,
    _appendRecord = appendRecord,
    _rebuildIndex = rebuildIndex,
    _loadConfig = _defaultLoadBrainConfig,
    _readRecordIds = readRecordIds,
    _upstreamRecordEntries = upstreamRecordEntries,
    _hydrate = hydrate,
  } = {},
) {
  const ignoredOpts = [scope && "scope", topic && "topic"].filter(Boolean);
  if (ignoredOpts.length > 0) {
    console.warn(await t("memory.save.engramIgnoredOpts", { opts: ignoredOpts.join(", ") }));
  }

  const ts = getTimestamp();
  const branch = getBranch(root);
  const config = _loadConfig(root);

  const resolvedProject = project ?? deriveProject(config, root);
  if (!type) {
    throw new Error(await t("memory.plainfiles.save.typeRequired", { types: RECORD_TYPES.join(", ") }));
  }
  if (issue !== undefined && issue !== null && !Number.isInteger(issue)) {
    throw new Error(await t("memory.plainfiles.save.issueInvalid", { value: String(issue) }));
  }

  // #738 — the actor refusal, AFTER the two caller-mistake refusals above,
  // BEFORE the supersedes gate (which may read the store).
  const actorResult = resolveActor({ configured: getGitConfig("brain.actor") });
  if (!actorResult.ok) {
    const key = actorResult.reason === "reserved"
      ? "memory.plainfiles.save.actorReserved"
      : actorResult.reason === "malformed"
        ? "memory.plainfiles.save.actorMalformed"
        : "memory.plainfiles.save.actorUnset";
    throw new Error(await t(key, { value: String(actorResult.value ?? "") }));
  }
  const actor = actorResult.actor;

  const kindResult = resolveActorKind({ env: getEnv(), agentEnvConfig: getGitConfig("brain.agentEnv") });
  const actorKind = kindResult.actorKind;

  const issueResult = deriveIssue({ declared: issue, branch });
  if (issueResult.derived) {
    console.log(await t("memory.plainfiles.save.issueDerived", { issue: String(issueResult.issue), branch }));
  }

  const source = composeSource({ host: getHostname(), backend: "engram", actor: actorResult, kind: kindResult, issue: issueResult });

  const recordsDir = join(root, ".memory", "records");

  if (supersedes !== undefined) {
    const verdict = classifySupersedes({
      id: supersedes,
      localIds: () => _readRecordIds({ recordsDir }),
      upstream: () => _upstreamRecordEntries({ root }),
    });
    if (verdict.configError !== undefined) {
      console.warn(await t("memory.plainfiles.save.supersedesConfigError", { error: verdict.configError }));
    }
    if (!verdict.ok) {
      const key = {
        malformed: "memory.plainfiles.save.supersedesMalformed",
        "not-in-store": "memory.plainfiles.save.supersedesNotInStore",
        "could-not-verify": "memory.plainfiles.save.supersedesUnverifiable",
      }[verdict.reason];
      throw new Error(await t(key, verdict.detail));
    }
  }

  const candidate = buildRecord({
    ts, actor, actorKind, type, project: resolvedProject,
    issue: issueResult.issue, supersedes, content, title, source,
  });

  const { patternSources, allowPatternSources } = resolveSecretConfig(config);
  const patterns = compilePatterns(patternSources);
  const allowPatterns = compilePatterns(allowPatternSources);
  const hit = scanTextForSecrets(serializeRecord(candidate), patterns, allowPatterns);
  if (hit) {
    throw new Error(
      await t("memory.plainfiles.save.secretFound", { line: hit.lineNumber, pattern: hit.pattern }),
    );
  }

  const indexPath = join(root, ".memory", "index.jsonl");

  const { file } = _appendRecord(candidate, { recordsDir });

  // THE APPEND IS ALREADY DONE (#637, mirrored from plainfiles.save() verbatim):
  // `rebuildIndex` reads the WHOLE store, so it can only run after the line it
  // has to see. The original error is ANNOTATED AND RETHROWN rather than
  // wrapped — every caller keeps the fail-closed throw it already had.
  let reindex;
  try {
    reindex = _rebuildIndex({ recordsDir, indexPath });
  } catch (err) {
    const annotated = (err !== null && (typeof err === "object" || typeof err === "function"))
      ? err
      : new Error(String(err));
    annotated.indexFailed = true;
    annotated.recordId = candidate.id;
    annotated.recordFile = file;
    throw annotated;
  }

  // THE ONE STEP plainfiles.save() has no equivalent of: the record is durable
  // (appended + indexed) BEFORE this runs, so a backend failure here can never
  // make the capture appear lost (spec: "a capture is durable before the
  // backend runs"; R5).
  const hydrateResult = await _hydrate({ root, recordId: candidate.id, record: candidate });

  return {
    id: candidate.id,
    file,
    written: true,
    hydrated: hydrateResult?.written === 1,
    ...(hydrateResult?.deferred ? { deferred: true, reason: hydrateResult.reason } : {}),
    ...(hydrateResult?.contended ? { contended: true } : {}),
    indexCount: reindex?.count,
    duplicates: normalizeDuplicates(reindex?.duplicates),
  };
}

/** @returns {Promise<never>} */
export async function search() {
  await unsupportedOp("search", "engram", { key: "memory.search.engramUnsupported" });
}

/**
 * isEngramArgvUnsafe() — fresh-review F2 (#924): `engram save --help` offers
 * no `--` escape (measured), so a value beginning with `-` would be parsed
 * as an option, not a positional. `hydrate()` checks its `title`/`content`
 * against this BEFORE spawning; never used to sanitize, only to refuse.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isEngramArgvUnsafe(value) {
  return typeof value === "string" && value.startsWith("-");
}

/**
 * hydrate() — project ONE durable record into the active engram store, keyed
 * by the record's own id as `topic_key` (#874, split A, R3/R4/D1/D2/D9).
 *
 * ONE `_engramSave` call, never the bulk `importMemory()` path (R3): the
 * primitive already exists and is already in production (`featureResume`),
 * and the bulk path pays a whole-store read back for a single record.
 *
 * Order: resolve the record (D2 — an already-materialized `record` is used as
 * given, at zero extra IO; absent, `_readRecords` finds it by id, and an
 * unknown id THROWS — D4, a caller mistake, never `deferred`) → probe the
 * binary (D3 — `probeBinary`, never `requireEngram()`, which throws) →
 * acquire the #820 guard, non-blocking (R4) → one `_engramSave` call built
 * via `importRecord()` (D1 — the SAME pure record→observation transform
 * `importMemory` uses) with `topic: recordId` (R6 — always the record's own
 * id, never the caller's `topic`).
 *
 * Never throws past this function except D4's unknown-id case: an absent
 * binary, a contended guard, or a throwing `_engramSave` all DEFER (R5) —
 * the record is already durable before this runs, so a backend failure here
 * must never read as a lost capture.
 *
 * @param {{root?: string, recordId: string, record?: object}} args
 * @param {object} [seams]
 * @param {(title: string, content: string, opts: object) => void} [seams._engramSave]
 * @param {() => {held: boolean, release?: () => void, owner?: object}} [seams._guard]  #820 guard, non-blocking.
 * @param {() => {available: boolean|null, reason?: string}} [seams._probe]
 * @param {(opts: {recordsDir: string}) => {records: object[], duplicates: object}} [seams._readRecords]
 * @param {(record: object) => object} [seams._importRecord]
 * @param {(msg: string) => void} [seams._warn]
 * @returns {Promise<{written: 0|1, skipped: number, deferred?: true, contended?: true, reason?: string}>}
 */
export async function hydrate(
  { root = repoRoot, recordId, record } = {},
  {
    _engramSave = _defaultEngramSave,
    _guard = acquireHydrationGuard,
    _probe = () => probeBinary(ENGRAM_BIN),
    _readRecords = readRecords,
    _importRecord = importRecord,
    _warn = console.error,
  } = {},
) {
  let resolved = record;
  if (resolved === undefined) {
    const { records } = _readRecords({ recordsDir: join(root, ".memory", "records") });
    resolved = records.find((r) => r?.id === recordId);
    if (resolved === undefined) {
      throw new Error(await t("memory.hydrate.recordNotFound", { recordId }));
    }
  }

  const probe = _probe();
  if (probe.available !== true) {
    const reason = probe.available === false
      ? "engram binary not found"
      : (probe.reason ?? "engram binary could not be resolved");
    _warn(await t("memory.save.hydrateDeferred", { recordId, reason }));
    return { written: 0, skipped: 0, deferred: true, reason };
  }

  // B1 (cold review #924): `acquireHydrationGuard()` is not exception-free —
  // its `mkdirSync(staging)` is unguarded (ENOSPC, EACCES, …), and a rename
  // error other than ENOTEMPTY/EEXIST/EPERM is rethrown. Acquiring the guard
  // is folded into the SAME failure envelope as `_engramSave` below: a throw
  // here is a backend failure like any other and must defer (R5), never
  // escape `save()` and make an already-durable record look like it failed.
  // The guard is never actually taken on this path, so there is nothing to
  // release.
  let guard;
  try {
    guard = _guard();
  } catch (err) { /* surfaced: warned as hydrateDeferred and returned as `{ deferred: true, reason }`; the record is already durable */
    const reason = `guard-failed: ${err?.code ?? err?.message ?? String(err)}`;
    _warn(await t("memory.save.hydrateDeferred", { recordId, reason }));
    return { written: 0, skipped: 0, deferred: true, reason };
  }
  if (!guard.held) {
    const age = Math.round((guard.owner?.ageMs ?? 0) / 1000);
    _warn(await t("memory.save.hydrateContended", { recordId, pid: guard.owner?.pid ?? "?", age }));
    return { written: 0, skipped: 0, deferred: true, contended: true };
  }

  try {
    const observation = _importRecord(resolved);
    // fresh-review F2 (#924), widened by cold-review E1 (#924): `engram save
    // --help` offers no `--` escape (measured) — any positional/option VALUE
    // starting with `-` would be parsed as an option, not the value, and
    // either misbehave or fail in a way that looks like an unrelated engram
    // error. Checked here: `title`/`content` (agent-controlled, F2) and
    // `project` (E1 — `save()`'s `deriveProject()` falls back to the checkout
    // directory's basename, `String(root).split('/').pop()`, which may itself
    // start with `-`). NOT checked: `type` is one of format.mjs's fixed
    // `RECORD_TYPES` enum, `scope` is always the constant `'project'` set by
    // `importRecord()`, and `topic` is always the record's own id — always
    // `rec-`-prefixed per format.mjs#computeRecordId — so none of those three
    // can start with `-`. Refused BEFORE the spawn, never thrown (R5 shape):
    // this is a data shape the caller cannot fix by retrying, so it is
    // reported the same way a deferred hydration is. The proper fix — an
    // escape in the engram CLI itself — is upstream; nothing to change here
    // beyond refusing to hand it an unsafe argv.
    if (
      isEngramArgvUnsafe(observation.title)
      || isEngramArgvUnsafe(observation.content)
      || isEngramArgvUnsafe(observation.project)
    ) {
      const reason = "engram-argv-unsafe";
      _warn(await t("memory.save.hydrateDeferred", { recordId, reason }));
      return { written: 0, skipped: 0, deferred: true, reason };
    }
    _engramSave(observation.title, observation.content, {
      type: observation.type,
      project: observation.project,
      scope: observation.scope,
      topic: recordId,
    });
    return { written: 1, skipped: 0 };
  } catch (err) { /* surfaced: warned as hydrateDeferred and returned as `{ deferred: true, reason }`; the record is already durable */
    const reason = explainEngramFailure(err);
    _warn(await t("memory.save.hydrateDeferred", { recordId, reason }));
    return { written: 0, skipped: 0, deferred: true, reason };
  } finally {
    guard.release();
  }
}

/**
 * index() — project brain/ documents into engram.
 * Delegates entirely to brain-to-engram.mjs — no logic duplication.
 */
export async function index() {
  const scriptPath = join(repoRoot, "brain", "scripts", "brain-to-engram.mjs");
  const result = spawnSync(process.execPath, [scriptPath], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (result.status !== 0) {
    throw new Error(`brain-to-engram.mjs exited with status ${result.status}`);
  }
}

/**
 * setup() — idempotent setup for the engram backend: ensure the `.engram →
 * .memory` symlink (delegates to ensureMemorySymlink). This is the ONLY
 * place the symlink is created or repaired (#955, R7 — symlink confinement);
 * `share()`/`pull()` never touch it.
 *
 * The merge-driver registration this function used to also perform is
 * retired (#955, R7): the tracked derived-index file it registered a merge
 * driver for has had no writer since #874 split B, so there is nothing left
 * for a driver to merge.
 *
 * `{root}` (#1010): honours `BRAIN_MEMORY_TEST_ROOT` the same way
 * `share()`/`pull()`/`import()` already do (cli.mjs's `ROOTED_OPS`). Before
 * #1010 this took no parameters at all, so a caller that forwarded `{root}`
 * had it silently discarded and `ensureMemorySymlink()` fell through to the
 * real repo root regardless — measured as `npm test` writing `.engram` into
 * a cold-review candidate worktree via `cli.backend-fallback.test.mjs`'s own
 * real-subprocess `setup` test.
 *
 * Called by bootstrap.sh §7 via: node brain/scripts/memory/cli.mjs setup
 */
export async function setup({ root = repoRoot } = {}) {
  ensureMemorySymlink(root);
}

// ---------------------------------------------------------------------------
// Internal helpers for feature verbs
// ---------------------------------------------------------------------------

/**
 * Read the current git branch name.
 * Returns 'unknown' on any failure (git absent, detached HEAD, etc.).
 *
 * Thin wrapper over the shared `lib/git-branch.mjs#currentBranch` primitive
 * (issue #138, design §1.2) — preserves this module's existing 'unknown'
 * contract on top of the de-duplicated detection logic. Note the observable
 * behavior change on detached HEAD: the old inline implementation returned
 * the literal `'HEAD'` string; this wrapper normalizes it to `'unknown'`
 * like every other failure case, via `currentBranch`'s `null` sentinel.
 *
 * @param {string} root  Repo root to run git in.
 * @param {{ _spawn?: Function }} [opts]  Injectable spawn seam for tests
 *   (forwarded to `currentBranch`); existing single-arg call sites are
 *   unaffected since this parameter defaults to `{}`.
 * @returns {string}
 */
export function _getGitBranch(root, opts = {}) {
  return currentBranch(root, opts) ?? "unknown";
}

/**
 * Best-effort enrichment: if the engram binary is available, search for
 * sdd/<feature>/apply-progress in the 'brain' project and fold any useful
 * text into empty frontmatter fields.
 *
 * NEVER throws. NEVER calls engram save or engram sync.
 * Wrapped in try/catch by the caller; also wrapped here for safety.
 *
 * @param {string} feature
 * @param {Record<string,*>} frontmatter  Mutated in place — only fills EMPTY fields.
 */
function _engramEnrich(feature, frontmatter) {
  try {
    // Through the shared probe (issue #641) so no copy of the resolution rule is
    // left to drift. Behaviour is unchanged: only a confident `true` proceeds,
    // which is what `status !== 0 → return` already meant — and correctly so
    // here, since this path is best-effort enrichment that must never throw.
    if (probeBinary(ENGRAM_BIN).available !== true) return;

    const searchResult = spawnSync(
      "engram",
      [
        "search",
        `sdd/${feature}/apply-progress`,
        "--project",
        "brain",
        "--limit",
        "1",
      ],
      { encoding: "utf8", timeout: 5000 },
    );

    if (searchResult.status !== 0 || !searchResult.stdout?.trim()) return;

    // The search output is human-readable text (not JSON).
    // Only enrich fields that are still the skeleton defaults (empty / placeholder).
    // We intentionally keep this minimal: the agent is expected to keep resume.md
    // current; enrichment is a last-resort convenience, not a required data source.
    const text = searchResult.stdout;

    if (
      (!frontmatter.next_action ||
        frontmatter.next_action ===
          "Update this skeleton with the current state") &&
      text.includes("next_action")
    ) {
      // Leave as skeleton; the obs text is structured but too complex to parse
      // here without risking corruption. The agent should update manually.
    }
  } catch { /* swallow-ok: enrichment is best-effort by contract: never fatal, never required (feature-working-memory-contract.md) */
    // Enrichment is best-effort — never fatal.
  }
}

// ---------------------------------------------------------------------------
// featureCheckpoint — dehydrate the in-flight state to resume.md (REQ-S2-1)
// ---------------------------------------------------------------------------

/**
 * Stamp the current state into openspec/changes/<feature>/resume.md.
 *
 * REQ-E-1 contract (enforced here):
 *   The CORE WRITE (writeFileSync) is a pure filesystem operation.
 *   The only external calls permitted are:
 *     (a) git rev-parse for the branch name (getBranch injectable, guarded).
 *     (b) The _doEngramEnrich helper — a best-effort try/catch block that reads
 *         the engram DB; it NEVER calls engram save or engram sync.
 *   Both (a) and (b) are injectable so tests can replace them with no-ops,
 *   making it trivially verifiable that the core write has zero engram dependency.
 *
 * @param {string|undefined} feature       Explicit feature name (from argv) or undefined.
 * @param {object} [opts]                  Injectable seams for testing.
 * @param {string} [opts.root]             Repo root override.
 * @param {() => string} [opts.getTimestamp]  Returns current UTC ISO-8601 string.
 * @param {() => string} [opts.getHostname]   Returns hostname string.
 * @param {(root: string) => string} [opts.getBranch]  Returns current branch name.
 * @param {(feature: string, fm: object) => void} [opts._doEngramEnrich]
 *   Best-effort enrichment function — injected as no-op in tests.
 */
export async function featureCheckpoint(
  feature,
  {
    root = repoRoot,
    getTimestamp = () => new Date().toISOString(),
    getHostname = () => osHostname(),
    getBranch = _getGitBranch,
    _doEngramEnrich = _engramEnrich,
  } = {},
) {
  // 1. Resolve feature — never throws from featureCheckpoint (pre-push safety).
  let resolvedFeature;
  try {
    resolvedFeature = resolveFeature(root, feature);
  } catch (err) { /* swallow-ok: contract guarantee: an unresolvable feature is informational and exits 0 (feature-working-memory-contract.md) */
    console.warn(`  ℹ memory: ${err.message} — skipping checkpoint`);
    return; // exit 0: must never break the pre-push hook
  }
  if (!resolvedFeature) {
    console.warn("  ℹ memory: no active feature found — skipping checkpoint");
    return;
  }

  const targetDir = join(root, changeDir(resolvedFeature));
  const rp = join(targetDir, OPERATIONAL_ARTIFACTS[0]);

  // 2. Read existing resume.md or build a minimal skeleton.
  let frontmatter = {};
  let body = "";
  try {
    const existing = readFileSync(rp, "utf8");
    const parsed = parseFrontmatter(existing);
    if (parsed.frontmatter) {
      frontmatter = { ...parsed.frontmatter };
      body = parsed.body;
    } else {
      // File exists but has no parseable frontmatter — treat content as body only.
      body = existing;
    }
  } catch (err) {
    // swallow-ok: ONLY ENOENT (no resume.md yet) is the skeleton-creation case; any other read error is re-thrown below
    if (err?.code !== "ENOENT") throw err;
    // File absent — create skeleton with required fields.
    frontmatter = {
      feature: resolvedFeature,
      current_slice: "unknown",
      next_action: "Update this skeleton with the current state",
      blockers: [],
    };
  }

  // 3. Ensure required fields exist (guards against partially-written files).
  if (!frontmatter.feature) frontmatter.feature = resolvedFeature;
  if (frontmatter.current_slice == null) frontmatter.current_slice = "unknown";
  if (frontmatter.next_action == null)
    frontmatter.next_action = "Update this file with the current state";
  if (!Array.isArray(frontmatter.blockers)) frontmatter.blockers = [];

  // 3.5. Branch-scope guard (#102). On the AUTOMATIC path (no explicit feature —
  //      i.e. the pre-push hook fires on every push), do NOT churn the active
  //      feature's resume.md when the current branch is unrelated to it. The
  //      feature's branch is the one recorded in `checkpointed_from`
  //      (host/branch); a mismatch means this push belongs to other work, so we
  //      skip without writing. An explicit feature arg always proceeds — the
  //      caller asked to checkpoint THIS feature regardless of branch. A feature
  //      with no prior checkpointed_from (first checkpoint) also proceeds and
  //      establishes its branch.
  const explicit = feature !== undefined && feature !== null && feature !== "";
  if (!explicit && frontmatter.checkpointed_from) {
    const recordedBranch = String(frontmatter.checkpointed_from)
      .split("/")
      .slice(1)
      .join("/");
    const currentBranch = getBranch(root);
    if (recordedBranch && currentBranch && recordedBranch !== currentBranch) {
      console.warn(
        `  ℹ memory: branch '${currentBranch}' ≠ feature '${resolvedFeature}' branch '${recordedBranch}' — skipping checkpoint (unrelated push)`,
      );
      return;
    }
  }

  // 4. Re-stamp provenance fields.
  frontmatter.checkpointed_at = getTimestamp();
  frontmatter.checkpointed_from = `${getHostname()}/${getBranch(root)}`;

  // 5. Best-effort engram enrichment (NEVER fatal, NEVER a prerequisite).
  //    Wrapped in its own try/catch in addition to being injectable.
  try {
    _doEngramEnrich(resolvedFeature, frontmatter);
  } catch { /* swallow-ok: enrichment is best-effort by contract: never fatal, never required (feature-working-memory-contract.md) */
    // Enrichment failed — proceed to core write regardless.
  }

  // 6. Validate (NEVER fatal — warn only).
  try {
    validateResume(frontmatter);
  } catch (err) { /* surfaced: a warning line names the offending field; the write proceeds by contract so the file can be fixed by hand */
    console.warn(`  ⚠ resume.md validation warning: ${err.message}`);
  }

  // 7. CORE WRITE — pure filesystem; no engram save, no engram sync, no child
  //    process.  This is the REQ-E-1 invariant line.
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(rp, serializeFrontmatter(frontmatter, body));
  console.log(`  ✓ resume.md checkpointed for ${resolvedFeature}`);
}

// ---------------------------------------------------------------------------
// featureResume — hydrate openspec/changes/<feature>/*.md into local engram
// ---------------------------------------------------------------------------

/**
 * Project all .md files in openspec/changes/<feature>/ into the LOCAL engram
 * under the distinct project namespace 'brain-feature-<feature>'.
 *
 * This namespace separation ensures that a subsequent `brain:memory:share`
 * (= engram sync --export, which defaults to the 'brain' project) does NOT
 * pick up these observations and write them to .memory/ — keeping feature
 * obs out of the durable committed store.
 *
 * CONFIRMED (task 2.1): engram sync --export is project-scoped by default,
 * so observations saved under 'brain-feature-*' will not appear in .memory/.
 *
 * @param {string|undefined} feature  Explicit feature name or undefined.
 * @param {object} [opts]             Injectable seams for testing.
 * @param {string} [opts.root]        Repo root override.
 * @param {() => boolean} [opts._checkEngram]  Returns true if engram binary is available.
 * @param {(title, content, opts) => void} [opts._engramSave]
 *   Called once per .md file. Default: real execFileSync('engram', ['save', ...]).
 */
export async function featureResume(
  feature,
  {
    root = repoRoot,
    _checkEngram = _defaultCheckEngram,
    _engramSave = _defaultEngramSave,
  } = {},
) {
  // 1. Resolve feature — featureResume DOES propagate errors (ambiguous → cli exits 1).
  const resolvedFeature = resolveFeature(root, feature);
  if (!resolvedFeature) {
    console.log("  ℹ memory: no active feature found");
    return;
  }

  const targetDir = join(root, changeDir(resolvedFeature));
  const rp = join(targetDir, OPERATIONAL_ARTIFACTS[0]);

  // 2. If resume.md is absent → informational message, exit 0.
  if (!existsSync(rp)) {
    console.log(`  ℹ memory: no resume point for ${resolvedFeature}`);
    return;
  }

  // 3. Parse frontmatter for the summary print.
  const resumeContent = readFileSync(rp, "utf8");
  const { frontmatter } = parseFrontmatter(resumeContent);
  if (frontmatter) {
    console.log(`\n  Feature:      ${resolvedFeature}`);
    console.log(`  Slice:        ${frontmatter.current_slice ?? "unknown"}`);
    console.log(`  Next action:  ${frontmatter.next_action ?? "(not set)"}`);
    const blockers = frontmatter.blockers;
    if (Array.isArray(blockers) && blockers.length > 0) {
      console.log("  Blockers:");
      for (const b of blockers) {
        console.log(`    - ${b}`);
      }
    }
  }

  // 4. Check engram availability.
  const engramAvailable = _checkEngram();
  if (!engramAvailable) {
    // Degrade: print resume.md content directly; no engram save.
    console.log("\n--- resume.md ---\n");
    console.log(resumeContent);
    return;
  }

  // 5. Project each .md file into engram under 'brain-feature-<feature>'.
  //    Modeled on brain-to-engram.mjs — one save per file, topic as upsert key.
  //    The distinct project namespace keeps these obs out of brain:memory:share exports.
  const featureProject = `brain-feature-${resolvedFeature}`;
  let files;
  try {
    files = readdirSync(targetDir).filter((f) => f.endsWith(".md"));
  } catch (err) {
    // Nothing was projected: that is a failure, not a quiet return (#1127).
    throw new Error(`featureResume: could not read change dir ${targetDir} — ${err.message}`);
  }

  // Every file is still attempted; the verb rejects at the end naming each one
  // that did not land, so a partial hydration never reads as a complete one.
  const failures = [];
  for (const filename of files) {
    const filePath = join(targetDir, filename);
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (err) { /* surfaced: collected into `failures` and thrown after the loop (#1127) */
      console.warn(`  ⚠ could not read ${filename} — skipping`);
      failures.push(`${filename}: ${String(err.message).trim()}`);
      continue;
    }

    const stem = basename(filename, ".md");
    const topic = `sdd/${resolvedFeature}/${stem}`;
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : stem;

    try {
      _engramSave(title, content, {
        type: "reference",
        project: featureProject,
        topic,
      });
      console.log(
        `  ✓ ${filename} → engram [reference] topic=${topic} project=${featureProject}`,
      );
    } catch (err) { /* surfaced: collected into `failures` and thrown after the loop (#1127) */
      console.warn(`  ⚠ ${filename}: ${String(err.message).trim()}`);
      failures.push(`${filename}: ${String(err.message).trim()}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `featureResume: ${failures.length} of ${files.length} file(s) were not projected into engram — ${failures.join("; ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Default injectable implementations
// ---------------------------------------------------------------------------

function _defaultCheckEngram() {
  // Same shared probe as `requireEngram` (issue #641). Boolean by contract, so
  // an undetermined probe collapses to `false` here — acceptable because every
  // caller of this seam treats `false` as "skip the engram step", never as a
  // claim that engram is absent.
  return probeBinary(ENGRAM_BIN).available === true;
}

// NOTE (C4 review): `engram save` accepts --type/--project/--scope/--topic but
// has NO timestamp flag, so it cannot carry a record's original `ts` — every
// hydrated observation is re-stamped with engram's wall-clock insert time. The
// committed `records/` keeps the correct `ts` (source of truth); only engram's
// rebuildable local cache loses original recency ordering on pull. Preserving
// created_at would need an engram-side ingestion verb (tracked as a follow-up).
/**
 * Reads back the topic keys engram already holds, via ONE `engram export`.
 *
 * Measured at 0.67s for 2248 observations — cheap enough to run every time,
 * which is what makes the delta possible without brain keeping a watermark of
 * its own (a second source of truth that could drift from the store).
 *
 * ── Whose cost this is ──────────────────────────────────────────────────────
 *
 * `engram export` takes no project filter, so the read covers the WHOLE LOCAL
 * STORE. That is a mechanical fact and it is why the cost is what it is.
 *
 * What is NOT true — an earlier version of this comment said it — is that the
 * cost therefore belongs to somebody else. Re-measured against the live store:
 * 2698 observations across 7 projects, of which brain is **2450, or 90.8%**. So
 * this cost tracks brain's OWN record growth, near enough that treating it as
 * external would be self-deception. (The earlier note also quoted "1596 across
 * 6 projects" one paragraph below "2248 observations" — two figures that cannot
 * both describe the same store. Both are gone.)
 *
 * The key set IS a shared namespace, and that part stands: 547 of the 2577
 * distinct topic keys are semantic keys written by `mem_save` (`skill-registry`,
 * `sdd-init/…`), not record ids. Reading them is safe — brain ids are
 * `rec-<16 hex>` with the project inside the hash (format.mjs), so no foreign
 * key can collide with one — but the set being global is worth knowing.
 *
 * ── Why this validates instead of coercing ──────────────────────────────────
 *
 * `parsed?.observations ?? []` used to sit here, under a docstring promising the
 * reader never returns an empty Set on failure. It could not honour that: any
 * file that parses as JSON but carries no `observations` array yielded an empty
 * Set, which importMemory reads as "the store is genuinely empty" and answers
 * with a full re-import — the permanent duplication the fail-closed path exists
 * to prevent.
 *
 * And the two states cannot be told apart by shape, because a genuinely empty
 * store exports `"observations": null` (measured, engram v1.17.0):
 *
 *     { "version": "0.1.0", "sessions": null, "observations": null, … }
 *
 * So `null` is legitimately empty and must import everything. The dangerous case
 * is a schema this reader was not written against.
 *
 * The cross-check is engram's own count, printed on STDOUT (`Observations: N`)
 * and previously discarded by `stdio: [_, "ignore", _]`. Comparing it against
 * what was parsed catches a moved schema without a version allowlist — which
 * would go stale on the next engram release and fail closed for no reason.
 *
 * @returns {Set<string>}  The keys, or THROWS if the state could not be read.
 *   Never an empty Set on failure: importMemory must be able to tell "the store
 *   is empty" from "the store could not be read", because its policy on the
 *   first is to import everything.
 */
/**
 * Turns a failed `engram` invocation into ONE readable line.
 *
 * engram writes an update banner to stderr on every run —
 *
 *     Update available: 1.17.0 -> 1.20.0
 *     To update:
 *       brew update && brew upgrade engram
 *       …
 *     engram: pragma "PRAGMA journal_mode = WAL": unable to open database file
 *
 * — so the raw stderr is a five-line blob with the actual cause LAST, and it
 * gets interpolated mid-sentence into a one-line template. Prefer the binary's
 * own `engram:`-prefixed diagnostics; failing that, the last non-empty line;
 * failing that, whatever the Error carries.
 *
 * @param {unknown} err
 * @returns {string}
 */
function explainEngramFailure(err) {
  const lines = String(err?.stderr ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const diagnostics = lines.filter((l) => l.startsWith("engram:"));
  return (
    diagnostics.join(" ") ||
    lines[lines.length - 1] ||
    err?.message ||
    String(err)
  );
}

/**
 * The validation half of `_defaultExistingTopicKeys`, as a PURE function.
 *
 * Split out because the guard was unreachable from the suite: every test injects
 * `_engramExistingTopicKeys`, so the default reader — the only place the
 * cross-check lived — was never executed. Measured: neutralising the comparison
 * to `if (false && …)` left the whole suite at **2416/2416 green**. The
 * schema-drift proof existed, but as a MANUAL act, not a regression guard.
 *
 * That is the same defect this file's own history is about. #445 shipped a
 * docstring promising "never an empty Set on failure" that the code could not
 * keep; shipping the guard against that class with nothing pinning it would
 * repeat the shape one layer up. An absent assertion and a vacuous one fail
 * identically.
 *
 * @param {string} stdout        What `engram export` printed (carries `Observations: N`).
 * @param {string} fileContents  The exported JSON.
 * @returns {Set<string>}  Topic keys. THROWS if the export cannot be confirmed
 *   complete — never an empty Set on failure.
 */
export function topicKeysFromExport(stdout, fileContents) {
  const parsed = JSON.parse(fileContents);

  const observations = parsed?.observations;
  if (observations != null && !Array.isArray(observations)) {
    throw new Error(
      `engram export: 'observations' is ${typeof observations}, not an array — ` +
      `this reader was not written against export schema ${parsed?.version ?? "(no version)"}`,
    );
  }
  // `null` is the LEGITIMATELY EMPTY store — measured, engram v1.17.0 exports
  // `"observations": null` when it holds nothing. It must yield an empty Set so
  // first-ever hydration still imports everything.
  const rows = observations ?? [];

  // engram reports what it wrote. If that disagrees with what we parsed, the
  // file is not what the binary thinks it exported, and an empty `rows` here
  // would become "the store is empty" — the exact conflation being guarded.
  const reported = /^\s*Observations:\s*(\d+)\s*$/m.exec(stdout);
  if (!reported) {
    throw new Error(
      "engram export: no observation count on stdout — the export cannot be confirmed complete",
    );
  }
  if (Number(reported[1]) !== rows.length) {
    throw new Error(
      `engram export: reported ${reported[1]} observations but the file carries ${rows.length} — the read is incomplete`,
    );
  }

  const keys = new Set();
  for (const o of rows) {
    if (o?.topic_key) keys.add(o.topic_key);
  }
  return keys;
}

function _defaultExistingTopicKeys() {
  const dir = mkdtempSync(join(tmpdir(), "brain-engram-state-"));
  const file = join(dir, "state.json");
  try {
    const stdout = execFileSync("engram", ["export", file], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return topicKeysFromExport(stdout, readFileSync(file, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Writes every pending observation with ONE `engram import`.
 *
 * Replaces the per-record `engram save` loop that made #433: 1722 records ×
 * one execFileSync each measured at 1053 seconds, paid synchronously by
 * session:start AND by the post-merge hook on every `git pull`.
 *
 * ── An UNSTATED behaviour change, recorded because it is one ────────────────
 *
 * `engram import` is ALL-OR-NOTHING. Measured: a payload whose second
 * observation has an unresolvable `session_id` fails the whole call —
 *
 *   engram: import observation 0: constraint failed: FOREIGN KEY constraint failed
 *   exit=1        store unchanged — the VALID observation did not land either
 *
 * — while that same valid observation imports fine on its own.
 *
 * The old per-record loop imported records 1..k-1 and died at k, leaving a
 * partial hydration. This one imports zero. That is arguably the better
 * behaviour (no half-state to reason about, and the retry is a clean re-run),
 * but it is a change and it was not declared.
 *
 * Note also that engram reports the failing row as `observation 0` when the
 * offender was observation 1. That is engram's bug, not brain's; it is written
 * down here so whoever debugs a failed import does not trust the index.
 *
 * @param {object} payload  As built by buildImportPayload.
 */
function _defaultEngramImport(payload) {
  const dir = mkdtempSync(join(tmpdir(), "brain-engram-import-"));
  const file = join(dir, "payload.json");
  try {
    writeFileSync(file, JSON.stringify(payload));
    execFileSync("engram", ["import", file], { stdio: ["ignore", "ignore", "pipe"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function _defaultEngramSave(title, content, { type, project, scope, topic }) {
  execFileSync(
    "engram",
    [
      "save", title, content,
      "--type", type,
      "--project", project,
      ...(scope ? ["--scope", scope] : []),
      "--topic", topic,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

/**
 * Runs `engram version` and returns its STDOUT, or `null` if the probe could
 * not get an answer (absent binary, non-zero exit, spawn error). `null` is
 * "I do not know" the same way `probeBinary`'s three-valued result is —
 * `healDuplicates` treats it identically to an untested version: refuse,
 * never guess.
 *
 * @returns {string | null}
 */
function _defaultHealVersionProbe() {
  try {
    return execFileSync("engram", ["version"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch { /* swallow-ok: a failed version probe returns null, this seam's documented "version unknown" answer */
    return null;
  }
}

/**
 * HEAL_DELETE_ARGS(id) — the exact argv `healDuplicates` hard-deletes with.
 *
 * Measured (design.md "Measured by the orchestrator", engram 1.20.0): a soft
 * `engram delete <id>` leaves the row in `engram export` with `deleted_at`
 * set — `readBackendKeys`/`topicKeysFromExport` do not filter it, so the
 * audit would still count it as live. Only `--hard` actually removes the
 * row. `--hard` must come AFTER the id: `delete <id> --hard` is the only
 * argument order engram accepts (`delete --hard <id>` is rejected).
 *
 * @param {number} id  The numeric observation id — `engram delete obs-…`
 *   fails with `invalid observation id`; only the numeric id works.
 * @returns {string[]}
 */
export function HEAL_DELETE_ARGS(id) {
  return ["delete", String(id), "--hard"];
}

/**
 * healDuplicates() — reconciles the store's pre-guard duplicate rows (#1061,
 * #864 task 1.2a; memory-backend-contract.md's Deletion clause). Report-only
 * by default (REQ-MB-2); `apply: true` is required to delete anything
 * (REQ-MB-4), and a second apply run is a no-op (REQ-MB-4, REQ-MB-5).
 *
 * Never touches `.memory/records/` or `.memory/index.jsonl` — every read
 * this function performs is `_read` on a throwaway `engram export` file this
 * function itself creates and removes; `.memory/` is never in that path.
 *
 * Order of operations (design.md's Data Flow):
 *   1. `_probe()` → `engram version`. Out of the tested 1.20.x range, or
 *      absent, refuses `version` — in dry-run too. No export, no delete.
 *   2. `engram export` → `topicKeysFromExport` cross-check (#445, reused) →
 *      `planDuplicateHeal`. A refusal here (`divergent`/`tooMany`/`shape`)
 *      refuses the WHOLE run; nothing is deleted.
 *   3. No duplicate groups → `outcome: 'none'`.
 *   4. Dry-run → `outcome: 'planned'`, the groups, zero delete calls.
 *   5. Apply → delete every non-keeper id, ascending, ONE AT A TIME (see the
 *      loop's own comment for why). The first throw stops the run
 *      immediately (`outcome: 'partial'`; `notDeleted` includes the id that
 *      failed).
 *   6. Every delete succeeded → re-export, re-plan. Any duplicate still
 *      standing (or a shape refusal on the re-export) is `outcome:
 *      'unverified'` — REQ-MB-5's check that a soft delete the export
 *      ignores does not get reported as healed.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.apply]  Delete for real. Defaults to report-only.
 * @param {() => string | null} [opts._probe]  Returns `engram version`'s
 *   stdout, or `null` if the probe could not answer.
 * @param {(bin: string, args: string[], opts?: object) => string} [opts._exec]
 *   Runs `engram <args>`, returning stdout.
 * @param {(path: string, encoding?: string) => string} [opts._read]
 *   Reads the export file `_exec('export', …)` wrote.
 * @returns {{outcome: 'none'|'planned'|'healed'|'refused'|'partial'|'unverified',
 *            deleted?: number[], notDeleted?: number[], groups?: object[],
 *            rows?: number, distinct?: number, refusal?: string, key?: string,
 *            fields?: string[], count?: number, detail?: string}}
 */
export function healDuplicates({
  apply = false,
  _probe = _defaultHealVersionProbe,
  _exec = execFileSync,
  _read = readFileSync,
} = {}) {
  const versionStdout = _probe();
  const version = versionStdout == null ? null : parseEngramVersion(versionStdout);
  if (!isTestedVersion(version)) {
    return {
      outcome: "refused",
      refusal: "version",
      detail:
        versionStdout == null
          ? "engram version probe returned no answer"
          : `engram reports '${String(versionStdout).trim()}', outside the tested ${TESTED_ENGRAM_LABEL}`,
    };
  }

  const exportAndPlan = () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-engram-heal-"));
    const file = join(dir, "export.json");
    try {
      const stdout = _exec("engram", ["export", file], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      const fileContents = _read(file, "utf8");
      topicKeysFromExport(stdout, fileContents); // throws on shape/count mismatch (#445)
      return planDuplicateHeal(JSON.parse(fileContents));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  let plan;
  try {
    plan = exportAndPlan();
  } catch (err) { /* surfaced: returned as an outcome object with `detail`, which the caller reports */
    return { outcome: "refused", refusal: "shape", detail: explainEngramFailure(err) };
  }

  if (!plan.ok) {
    return { outcome: "refused", refusal: plan.refusal, key: plan.key, fields: plan.fields, count: plan.count, detail: plan.reason };
  }

  if (plan.groups.length === 0) {
    return { outcome: "none", rows: plan.rows, distinct: plan.distinct };
  }

  if (!apply) {
    return { outcome: "planned", groups: plan.groups, rows: plan.rows, distinct: plan.distinct };
  }

  // One id at a time, ascending, stopping at the FIRST failure — never a
  // batch and never continue-past-a-throw. You cannot reason about a
  // half-healed store unless the report is exact: `deleted` and
  // `notDeleted` must name precisely which ids landed before the maintainer
  // decides what to do next (design.md's own ruling on this loop).
  const ids = plan.groups.flatMap((g) => g.delete).sort((a, b) => a - b);
  const deleted = [];
  for (let i = 0; i < ids.length; i++) {
    try {
      _exec("engram", HEAL_DELETE_ARGS(ids[i]), { stdio: ["ignore", "ignore", "pipe"] });
      deleted.push(ids[i]);
    } catch (err) { /* surfaced: returned as an outcome object with `detail`, which the caller reports */
      return { outcome: "partial", deleted, notDeleted: ids.slice(i), detail: explainEngramFailure(err) };
    }
  }

  let verify;
  try {
    verify = exportAndPlan();
  } catch (err) { /* surfaced: returned as an outcome object with `detail`, which the caller reports */
    return { outcome: "unverified", deleted, notDeleted: [], detail: explainEngramFailure(err) };
  }
  if (!verify.ok || verify.groups.length > 0) {
    return { outcome: "unverified", deleted, notDeleted: [] };
  }

  return { outcome: "healed", deleted, notDeleted: [], rows: verify.rows, distinct: verify.distinct };
}

const TESTED_ENGRAM_LABEL = "1.20.x";
