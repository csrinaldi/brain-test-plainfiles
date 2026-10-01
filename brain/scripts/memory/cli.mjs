#!/usr/bin/env node
// brain/scripts/memory/cli.mjs — MEMORY_BACKEND dispatcher.
//
// Usage: node brain/scripts/memory/cli.mjs <op>
//   op: share | pull | import | index | reindex | setup | feature-checkpoint | feature-resume | heal-duplicates
//
//   pull    — churn-resilient full pull: manifest restore + git pull + engram import.
//             Use for cross-machine sync (npm run brain:memory:pull).
//   import  — import-only: records-only engram hydrate (D2/C4), no git pull.
//             Use after git already pulled (post-merge hook, day-start step 5).
//   reindex — regenerate .memory/index.jsonl from .memory/records/ alone
//             (REQ-MF-4, issue #205). Backend-agnostic: dispatched directly
//             here, not through axes/memory/adapters/<backend>.mjs — the record format is
//             brain-owned and independent of the live memory backend.
//
// Reads MEMORY_BACKEND from the environment, .env, or brain.config.json
// `memory.backend` (no default — undeclared is refused, #1165).
// Imports the corresponding backend from axes/memory/adapters/<backend>.mjs and
// dispatches the requested operation.
//
// Pattern mirrors SDD_HARNESS dispatch in brain/scripts/bootstrap.sh §6.

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, relative, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hostname } from "node:os";

import { t } from "../i18n/t.mjs";
import { formatDuplicateReport } from "./lib/duplicates.mjs";
import { resolveMemoryBackend, MEMORY_BACKENDS, EXIT_UNDECLARED, EXIT_INVALID } from "./lib/backend-resolve.mjs";
import {
  DEFAULT_BACKEND,
  ENGRAM_BIN,
  FALLBACK_BACKEND,
  REASON,
  probeBinary,
  selectBackend,
} from "./lib/backend-selection.mjs";
import { decideShipInvoker } from "./lib/ship-invoker.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

// B1 (#888 cold review, PR 2): the ONLY directory `BRAIN_VCS_TEST_MODULE`
// (the ship op's test-only vcs-port seam, below) is ever allowed to import
// from. A test-only seam that imports an ARBITRARY absolute path is CODE
// executed inside the same process that reads `BRAIN_MEMORY_TOKEN` — unlike
// `BRAIN_MEMORY_TEST_ROOT`/`BRAIN_MEMORY_ENV_FILE`, which only ever point at
// DATA (a directory to read records from, an env file to parse), never at a
// module this process then `import()`s and executes. Constraining the path
// to a COMMITTED fixture directory means the only code that can ever run
// through this seam is code that was reviewed and merged — never an
// arbitrary path a misconfigured or malicious env could point at. See
// `vcs/cli.mjs`'s own `getVcs()` for the same discipline applied to its
// provider-name seam (a regex allowlist there; a path-containment check
// here, because this seam takes a path rather than a bare identifier).
const FIXTURE_ROOT = join(repoRoot, "brain/scripts/memory/__fixtures__");

// ---------------------------------------------------------------------------
// Resolve MEMORY_BACKEND (issue #1165): env var > .env > brain.config.json
// `memory.backend` > UNDECLARED (a refusal, never a default).
// ---------------------------------------------------------------------------
// The resolution lives in lib/backend-resolve.mjs — the ONE resolver, shared with
// bootstrap.sh. What used to be here (env ?? .env ?? "engram") was the defect: a
// second checkout has no `.env`, so it silently ran a backend the team did not
// choose. The team's choice is tracked config now; see that module.
//
// BRAIN_MEMORY_ENV_FILE / BRAIN_MEMORY_CONFIG_FILE (test-only seams, mirroring
// BRAIN_MEMORY_TEST_ROOT and BRAIN_MIGRATE_V1_TEST_ROOT below): when set, `.env`
// / `brain.config.json` are read from those paths instead of `<repoRoot>/…`.
// NEVER set these outside tests. They exist because both files are ambient
// state — `.env` is gitignored, so whether a maintainer's machine carries
// `MEMORY_BACKEND=engram` would otherwise decide the outcome of the very branch
// under test (the ambient-state trap #657's suite hit with `$VCS_TOKEN`).
const RESOLVED = resolveMemoryBackend({
  root: repoRoot,
  envFile: process.env.BRAIN_MEMORY_ENV_FILE ?? null,
  configFile: process.env.BRAIN_MEMORY_CONFIG_FILE ?? null,
});

/** The source as an operator reads it — never the resolver's raw `shell`/`file`/`config` tokens. */
const sourceLabel = (src) => (src === "shell" ? "the process env" : src === "file" ? ".env" : "brain.config.json");

let shadowReported = false;
/** A losing declaration is reported, not dropped (#1165 S3) — on stderr, and BEFORE any refusal, so an invalid winner still shows what it overrode. Idempotent. */
async function reportShadowed() {
  if (shadowReported) return;
  shadowReported = true;
  for (const sh of RESOLVED.shadowed) {
    console.error(
      `memory/cli: ${await t("memory.backend.shadowed", {
        winner: sourceLabel(RESOLVED.source),
        backend: RESOLVED.backend ?? RESOLVED.invalidValue ?? "",
        loser: sourceLabel(sh.source),
        other: sh.value,
      })}`,
    );
  }
}

/**
 * The refusal for an op that needs a backend when none is (validly) declared.
 * Named fix, exit 1 — never a guess. Ops that never consult a backend
 * (reindex, audit, resolve-index, split-records, collect, ship, migrate-v1)
 * are dispatched BEFORE this is called and stay unaffected. `save` is the
 * exception that DOES reach the selection below but does not refuse: it is
 * record-first and degrades to plainfiles with a deferred-hydration notice.
 */
async function requireDeclaredBackend() {
  await reportShadowed();
  if (RESOLVED.status === "declared") return RESOLVED.backend;
  const key = RESOLVED.status === "invalid" ? "memory.backend.invalid" : "memory.backend.undeclared";
  console.error(
    `memory/cli: ${await t(key, {
      op,
      value: RESOLVED.invalidValue ?? "",
      source: sourceLabel(RESOLVED.source),
      allowed: MEMORY_BACKENDS.join(" | "),
    })}`,
  );
  if (RESOLVED.configError) console.error(`memory/cli: brain.config.json unreadable — ${RESOLVED.configError}`);
  // Distinct exit codes (3 undeclared, 4 invalid), never a bare 1: the automated callers
  // (hooks, session-start) tell "nothing was tried" from a real failure by code, not text.
  process.exit(RESOLVED.status === "invalid" ? EXIT_INVALID : EXIT_UNDECLARED);
}

// ---------------------------------------------------------------------------
// Duplicate reporting (issue #574) — the ONE printer, used by every op.
//
// The rule itself lives in lib/duplicates.mjs and is enforced in
// lib/store.mjs#rebuildIndex; this is the half that makes it audible. Before
// #574 the store's second failure mode reached a human through no path at all:
// `rebuildIndex` collapsed repeated ids into its Map and returned only a count,
// `plainfiles.share` returned an `indexCount` nobody printed, and
// `engram.share` returned undefined outright — which also meant the #541
// `unprovenanced` line below could never fire on the engram backend, since
// there was never a `result` to read it from.
//
// Printed for ANY op whose result carries the accounting, rather than
// per-verb: a rule that only speaks on the verbs someone remembered to wire up
// is the silence this ticket is about.
//
// To STDERR, not stdout, for the reason importMemory already states about its
// own skip notice: the automated callers discard stdout. `brain/scripts/hooks/
// post-merge` runs `cli.mjs import >/dev/null || true` — deliberately keeping
// stderr — and post-merge is the exact moment a union merge mints a duplicate.
// A report on stdout would be written to /dev/null on every pull, which is the
// same outage in a different pipe. (`pre-push`'s `share` and post-merge's
// `resolve-index` still use `2>&1 >/dev/null` and swallow both; those hook
// files are outside this ticket's file claim — flagged, not silently worked
// around.)
// ---------------------------------------------------------------------------
async function reportDuplicates(duplicates, { indexCount, surface, brief } = {}) {
  for (const line of await formatDuplicateReport(duplicates, { indexCount, surface, brief })) console.error(line);
}

// ---------------------------------------------------------------------------
// Validate op
// ---------------------------------------------------------------------------
const VALID_OPS = [
  "share",
  "pull",
  "import",
  "index",
  "reindex",
  "audit",
  "resolve-index",
  "split-records",
  "heal-duplicates",
  "collect",
  "ship",
  "migrate-v1",
  "setup",
  "feature-checkpoint",
  "feature-resume",
  "save",
  "search",
];
const op = process.argv[2];

if (!op) {
  console.error(`memory/cli: missing <op>. Valid ops: ${VALID_OPS.join(", ")}`);
  process.exit(1);
}

if (!VALID_OPS.includes(op)) {
  console.error(`memory/cli: unknown op '${op}'. Valid ops: ${VALID_OPS.join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// "reindex" is backend-agnostic: the durable record format (.memory/records/,
// .memory/index.jsonl) is brain-owned (ADR-0017), not a MEMORY_BACKEND concern.
// Dispatched directly here instead of through axes/memory/adapters/<backend>.mjs.
// ---------------------------------------------------------------------------
//
// BRAIN_MEMORY_TEST_ROOT (test-only seam, see the note further down where
// save/search read it): reindex honours it too, so cli.reindex-duplicates.test.mjs
// can drive this op end-to-end against a fixture and assert what it PRINTS —
// the only way to test the reporting half of #574 without touching the real
// `.memory/`.
if (op === "reindex") {
  const { rebuildIndex } = await import("./lib/store.mjs");
  const memoryRoot = process.env.BRAIN_MEMORY_TEST_ROOT ?? repoRoot;
  try {
    const { count, duplicates } = rebuildIndex({
      recordsDir: join(memoryRoot, ".memory", "records"),
      indexPath: join(memoryRoot, ".memory", "index.jsonl"),
    });
    console.log(`memory/cli: ${await t("memory.reindex.done", { count })}`);
    await reportDuplicates(duplicates, { indexCount: count });
    process.exit(0);
  } catch (err) {
    console.error(`memory/cli: ${await t("memory.reindex.failed", { message: err.message })}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// "audit" — the epic's five numbers as one command (#870, memory 2.0 task 0.2).
// Backend-agnostic like "reindex": records + git log; the backend row goes
// through the active backend's export and DEGRADES to a stated reason.
//   --since <ISO>   window start (default: now − 30 d)
//   --json          the report object instead of text
// ---------------------------------------------------------------------------
if (op === "audit") {
  const { runAudit } = await import("./lib/audit-io.mjs");
  const { renderReport } = await import("./lib/audit.mjs");
  const memoryRoot = process.env.BRAIN_MEMORY_TEST_ROOT ?? repoRoot;
  const rest = process.argv.slice(3);
  // A trailing `--since` or one swallowed by the next flag is an ERROR, not the
  // default window: a silent fallback would print numbers for a window the
  // operator did not ask for (rev-1 cold review of PR #871, cold-3).
  const hasSince = rest.includes("--since");
  const sinceArg = hasSince ? rest[rest.indexOf("--since") + 1] : undefined;
  const sinceMs = hasSince ? (sinceArg && !sinceArg.startsWith("--") ? Date.parse(sinceArg) : NaN) : Date.now() - 30 * 86400000;
  if (!Number.isFinite(sinceMs)) {
    console.error(`memory/cli: ${await t("memory.audit.badSince", { value: sinceArg === undefined ? "(missing)" : String(sinceArg) })}`);
    process.exit(1);
  }
  try {
    const report = runAudit({ root: memoryRoot, backend: RESOLVED.backend ?? undefined, sinceMs });
    if (rest.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else for (const line of renderReport(report)) console.log(line);
    process.exit(0);
  } catch (err) {
    console.error(`memory/cli: ${await t("memory.audit.failed", { message: err.message })}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// "resolve-index" — the doctrine-fixed resolution for a conflicted
// .memory/index.jsonl: discard both sides, regenerate from records/, and stage
// it only if git still considers the path unmerged (adr-0017:121-129, 143-147).
// Backend-agnostic for the same reason as "reindex" above.
// ---------------------------------------------------------------------------
if (op === "resolve-index") {
  const { resolveIndex } = await import("./lib/resolve-index.mjs");
  try {
    const { count, staged, duplicates } = resolveIndex({ repoRoot });
    const key = staged ? "memory.resolveIndex.staged" : "memory.resolveIndex.done";
    console.log(`memory/cli: ${await t(key, { count })}`);
    // The op that exists BECAUSE two branches merged is the last one that
    // should stay quiet about what the merge duplicated (#574).
    await reportDuplicates(duplicates, { indexCount: count });
    process.exit(0);
  } catch (err) {
    console.error(`memory/cli: ${await t("memory.resolveIndex.failed", { message: err.message })}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// "split-records" — move an existing store from the `<yyyy-mm>.jsonl` month log
// to one file per record (issue #677). Backend-agnostic for the same reason as
// "reindex" above: the durable layout is brain-owned, not a MEMORY_BACKEND
// concern.
//
// REPORT-ONLY BY DEFAULT. `--apply` is required to write anything, and the
// month files are deleted only after every record has been read back out of the
// new layout. The inverse of migrate-v1's default, deliberately: this one
// rewrites the durable log of a store brain does not own, so the default must
// be the harmless half.
//
// BRAIN_MEMORY_TEST_ROOT — honoured, like "reindex" and unlike "resolve-index"
// (whose missing seam #633/T11 recorded). A verb that deletes month files must
// be drivable end-to-end against a fixture, or its destructive branch is only
// ever exercised on somebody's real store.
// ---------------------------------------------------------------------------
if (op === "split-records") {
  const { runSplit } = await import("./lib/split-records.mjs");
  const apply = process.argv.includes("--apply");
  const memoryRoot = process.env.BRAIN_MEMORY_TEST_ROOT ?? repoRoot;
  const recordsDir = join(memoryRoot, ".memory", "records");
  try {
    const r = runSplit({ recordsDir, apply });
    if (r.monthFiles.length === 0) {
      console.log(`memory/cli: ${await t("memory.splitRecords.nothing", { alreadySplit: r.alreadySplit })}`);
      process.exit(0);
    }
    // The repeats are reported on BOTH paths — a dry run that stayed quiet
    // about what it was going to collapse would hide exactly the fact the
    // operator needs before typing --apply (#574).
    if (r.duplicates.length > 0) {
      console.error(
        `memory/cli: ${await t("memory.splitRecords.repeats", {
          count: r.duplicates.length,
          divergent: r.duplicates.filter((d) => d.divergent).length,
        })}`,
      );
      for (const d of r.duplicates) {
        console.error(`  ${d.id} — ${d.at} collapsed into ${d.firstAt}${d.divergent ? " (divergent)" : ""}`);
      }
    }
    if (!apply) {
      console.log(
        `memory/cli: ${await t("memory.splitRecords.plan", {
          lines: r.lines,
          months: r.monthFiles.length,
          writes: r.lines - r.duplicates.length,
        })}`,
      );
      process.exit(0);
    }
    console.log(
      `memory/cli: ${await t("memory.splitRecords.done", {
        written: r.written,
        alreadyPresent: r.alreadyPresent,
        months: r.monthFiles.length,
      })}`,
    );
    const { rebuildIndex } = await import("./lib/store.mjs");
    const { count, duplicates } = rebuildIndex({
      recordsDir,
      indexPath: join(memoryRoot, ".memory", "index.jsonl"),
    });
    console.log(`memory/cli: ${await t("memory.reindex.done", { count })}`);
    await reportDuplicates(duplicates, { indexCount: count });
    process.exit(0);
  } catch (err) {
    console.error(`memory/cli: ${await t("memory.splitRecords.failed", { message: err.message })}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// "collect" — the lane collector (issue #887, ADR-0034 L4/C2). Backend-
// agnostic like "reindex": it materializes ONE local commit from every
// worktree's uncommitted `.memory/records/` candidates onto
// `refs/heads/memory/<host>-<date>`. No backend is ever consulted — this
// block always exits before backend selection runs — and neither this op
// nor `lane/collect.mjs` ever pushes a ref, opens a PR, or is called from a
// hook (D7; the scope boundary is asserted behaviourally in
// `lane/collect.integration.test.mjs`).
//
// BRAIN_MEMORY_TEST_ROOT — honoured, like "reindex"/"audit"/"split-records"
// above (design.md A9): without it, `cli.collect.test.mjs` would enumerate
// every worktree of the maintainer's real clone.
//
// `--json` prints the result object on stdout ONLY; the duplicate/skip
// evidence always goes to stderr via `reportDuplicates`, so `--json` stdout
// stays parseable regardless of what the run found.
// ---------------------------------------------------------------------------
if (op === "collect") {
  const { collectLane } = await import("./lane/collect.mjs");
  const memoryRoot = process.env.BRAIN_MEMORY_TEST_ROOT ?? repoRoot;
  // E4: scoped to argv AFTER `node cli.mjs collect`, like `audit` above —
  // `process.argv.includes("--json")` would also match a `--json` that
  // happened to appear earlier in argv (the node binary path, the script
  // path), which is never the intent for this op's own flag.
  const rest = process.argv.slice(3);
  const asJson = rest.includes("--json");
  try {
    const result = collectLane({ root: memoryRoot });
    if (asJson) {
      console.log(JSON.stringify(result));
    } else if (result.commit === null) {
      console.log(`memory/cli: ${await t("memory.collect.nothing", { ref: result.ref })}`);
    } else {
      console.log(
        `memory/cli: ${await t("memory.collect.done", {
          collected: result.collected,
          ref: result.ref,
          commit: result.commit,
        })}`,
      );
    }
    if (!result.baseFetched) {
      console.error(`memory/cli: ${await t("memory.collect.offline")}`);
    }
    // D4's audibility half: a secret hit is surfaced by COUNT — never the
    // matched line, never even the file — because the run itself already
    // refused to let the line text travel any further than `pattern` +
    // `lineNumber` (A1 in design.md).
    const secretCount = result.skipped.filter((s) => s.reason === "secret").length;
    if (secretCount > 0) {
      console.error(`memory/cli: ${await t("memory.collect.secretSkipped", { count: secretCount })}`);
    }
    const modifiedCount = result.skipped.filter((s) => s.reason === "modified-tracked").length;
    if (modifiedCount > 0) {
      console.error(`memory/cli: ${await t("memory.collect.modifiedTrackedSkipped", { count: modifiedCount })}`);
    }
    // #921: an unreadable worktree is a distinct fact from "nothing pending
    // here" — always reported on stderr (never gated by --json) whenever the
    // list is non-empty, mirroring the secret/modified-tracked lines above.
    // F3 (cold review): `?? []` guards this consumer the same way ship.mjs's
    // own destructuring already defaults the field — collectLane() always
    // populates it today (no live bug), but this consumer had no defence of
    // its own if that producer contract ever changed.
    // F4 (cold review): the text surface now names WHY, not just which —
    // the operator reading stderr sees the same reason `--json` already
    // carries, instead of having to cross-reference the two.
    const skippedWorktreesHere = result.skippedWorktrees ?? [];
    if (skippedWorktreesHere.length > 0) {
      console.error(`memory/cli: ${await t("memory.collect.worktreeSkipped", {
        count: skippedWorktreesHere.length,
        paths: skippedWorktreesHere.map((w) => `${w.path} (${w.reason})`).join(", "),
      })}`);
    }
    await reportDuplicates(result.duplicates, { surface: "the lane commit" });
    process.exit(0);
  } catch (err) {
    // `raced` and `badHost` are named failures `lane/collect.mjs` tags on the
    // thrown error (A9, A5) — everything else falls through to
    // `memory.collect.failed` below, which is no longer only "a genuine git
    // failure": since #712, an unreadable `brain.config.json` propagates
    // from the same reader and lands here too (REQ-SCAN-4). The string
    // itself (`en.mjs`) is already neutral and needs no change (R10).
    if (err?.raced) {
      console.error(`memory/cli: ${await t("memory.collect.raced", { message: err.message })}`);
    } else if (err?.badHost) {
      console.error(`memory/cli: ${await t("memory.collect.badHost", { message: err.message })}`);
    } else {
      console.error(`memory/cli: ${await t("memory.collect.failed", { message: err.message })}`);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// "ship" — the lane ship: one push, one PR, one credential this op reads and
// this op alone (issue #888, ADR-0034 L1/L2/L5, design.md A1-A7). Dispatched
// BEFORE backend selection, like "collect" above — no backend is ever
// consulted, and this is the only user-invocable surface this slice adds
// (the trigger wiring — a SessionEnd hook, a day:start sweep — is deferred to
// #889; D4).
//
// BRAIN_MEMORY_TEST_ROOT — honoured, like "collect" above.
//
// The credential: `MEMORY_TOKEN_ENV` (`BRAIN_MEMORY_TOKEN`) is read from
// `process.env` in EXACTLY ONE place, right here. It is handed to
// `getVcs({identity})`, which binds it and returns the PORT — `shipLane`
// receives that bound port plus `identityBound: boolean`, never the token
// itself (A5's structural leak-regression guarantee: the string is never in
// `shipLane`'s scope at all).
//
// `--json` prints the result object on stdout ONLY; every other line this op
// prints goes to stderr, so `--json` stdout stays parseable regardless of
// what the run found (mirrors "collect"'s own contract).
//
// BRAIN_VCS_TEST_MODULE (test-only seam, mirrors BRAIN_MEMORY_TEST_ROOT):
// when set, its value is a path to a fake port module (the same shape
// `getVcs()` itself returns — `mrList`/`mrCreate`/`mrAutoMerge`), and that
// module is imported DIRECTLY instead of ever calling `getVcs()`. This
// exists because `getVcs()` has no seam of its own reachable through a CLI
// subprocess (unlike `_import`, its in-process-only test hook): without it,
// EVERY non-dry-run CLI-level test of this op resolves the REAL provider
// from this repo's own `brain.config.json`, and any test fixture that fails
// to short-circuit before `shipLane`'s find/create step reaches the real,
// unfakeable GitHub port (see `cli.ship.test.mjs`'s own account of the near
// -miss this seam closes). NEVER set this outside tests.
//
// B1 (cold review, PR 2): the resolved path MUST fall inside `FIXTURE_ROOT`
// (`resolveVcsTestModulePath` below) — see that constant's own comment for
// why. The fixture module itself carries no test-case-specific behavior;
// its ANSWERS are read at call time from the JSON file named by the second,
// DATA-only env var `BRAIN_VCS_TEST_SCRIPT` (see
// `__fixtures__/fake-vcs-port.mjs`).
//
// M1 (re-review, PR 2): containment is checked on the REAL path, not the
// lexical one — a symlink placed inside `FIXTURE_ROOT` pointing outside it
// would resolve lexically inside the fixture dir while `import()` still
// follows the link to wherever it points. `realpathSync` is best-effort
// (wrapped in try/catch) because the target may legitimately not exist yet
// (the escape test below points at `/tmp/x.mjs`, which is never created) —
// in that case the lexical path is the closest honest answer and the
// containment check still runs against it.
// ---------------------------------------------------------------------------

/** Resolves `BRAIN_VCS_TEST_MODULE` against `FIXTURE_ROOT`, refusing (before
 * any `import()` is attempted) anything that would resolve outside it — a
 * path traversal (`../..`), an absolute path elsewhere on disk, or a
 * symlink planted inside `FIXTURE_ROOT` whose real target lands outside it
 * (M1, re-review). See B1's comment on `FIXTURE_ROOT` for the rationale. */
function resolveVcsTestModulePath(vcsTestModule) {
  const lexical = resolve(vcsTestModule);
  let abs;
  try { abs = realpathSync(lexical); } catch { /* swallow-ok: realpath only normalises the test-root guard's comparison; the lexical path is still compared */ abs = lexical; }
  let root;
  try { root = realpathSync(FIXTURE_ROOT); } catch { /* swallow-ok: realpath only normalises the test-root guard's comparison; the lexical path is still compared */ root = FIXTURE_ROOT; }
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`memory/cli: BRAIN_VCS_TEST_MODULE must resolve inside ${FIXTURE_ROOT}`);
  }
  return lexical;
}

if (op === "ship") {
  const rest = process.argv.slice(3);

  // #1012: the FIRST thing this op does. Refuse before any module load,
  // credential read or VCS call unless the caller declares itself,
  // independent of a test-runner process — see ship-invoker.mjs's own header
  // comment for the full check order and why it exists (#1007). Stdout stays
  // empty on refusal, even with --json — nothing below this block has run yet.
  const invokerDecision = decideShipInvoker({ args: rest, env: process.env });
  if (!invokerDecision.allowed) {
    console.error(`memory/cli: ${await t(`memory.ship.${invokerDecision.key}`, invokerDecision.params)}`);
    process.exit(1);
  }

  const { shipLane } = await import("./lane/ship.mjs");
  const { MEMORY_TOKEN_ENV } = await import("../lib/credential-env.mjs");
  const { loadBrainConfig } = await import("../lib/brain-config.mjs");
  const memoryRoot = process.env.BRAIN_MEMORY_TEST_ROOT ?? repoRoot;
  const vcsTestModule = process.env.BRAIN_VCS_TEST_MODULE;
  const dryRun = rest.includes("--dry-run");
  const asJson = rest.includes("--json");
  const invoker = invokerDecision.invoker;

  try {
    // L1 (re-review): a set-but-blank BRAIN_VCS_TEST_MODULE is falsy, so the
    // ternary below would silently treat it as unset and bind the REAL vcs
    // port — refused here, before that ternary is ever reached.
    if (vcsTestModule !== undefined && vcsTestModule.trim() === "") {
      throw new Error("memory/cli: BRAIN_VCS_TEST_MODULE is set but empty — unset it to use the real port");
    }
    const config = loadBrainConfig();
    const rawToken = process.env[MEMORY_TOKEN_ENV]; // ONE read, in ONE place (A5)
    // (cold review, PR 2): a set-but-blank BRAIN_MEMORY_TOKEN reads as '' —
    // not null/undefined, so `identity` below would have stayed truthy and
    // `identityBound` (below) would have reported `true`, while
    // `vcs/cli.mjs`'s own `bound = identity ?? _token(name)` treats '' as
    // falsy and silently falls through to the AMBIENT credential: the run
    // would authenticate ambiently while reporting a bound identity.
    // Refused here, loudly, before either consumer sees it — an unattended
    // host that exports an empty token is misconfigured, not merely
    // "unset" (ADR-0033's own failure mode).
    if (rawToken !== undefined && rawToken.trim() === "") {
      throw new Error(`memory/cli: ${MEMORY_TOKEN_ENV} is set but empty — unset it to use the ambient identity`);
    }
    const identity = rawToken ?? null;
    const vcs = dryRun
      ? null
      : vcsTestModule
        ? await import(pathToFileURL(resolveVcsTestModulePath(vcsTestModule)).href)
        : await (await import("../vcs/cli.mjs")).getVcs({ config, identity });
    const result = await shipLane({
      root: memoryRoot,
      project: config.project.slug,
      tier: config.governance.tier,
      host: hostname(),
      date: new Date().toISOString().slice(0, 10),
      dryRun,
      identityBound: identity !== null,
      vcs,
    });

    // D6 (#936): the cross-day sweep runs ONLY after today's shipLane call
    // above SUCCEEDED (this line is unreached if it threw — the `catch`
    // below owns that path) and ONLY when this is not `--dry-run` (a plan
    // must never mutate any ref, today's or a prior day's).
    //
    // #936 remediation (cold review WARNING): `sweepLanes()`'s per-branch
    // loop DOES catch every failure it can hit internally and maps it to
    // that branch's own row — but that guarantee starts only INSIDE the
    // loop. Its own pre-loop code (the shared `fetch`, `listLocalBranches`,
    // `listRemoteBranches`, `slugifyHost`) is NOT inside any try/catch of
    // its own. This call therefore has its OWN try/catch, isolated from
    // shipLane's outer try above: a sweep-side throw here can never turn
    // today's already-successful `result` into a reported ship failure —
    // it becomes this fail-closed marker instead, still surfaced (in
    // --json, and per-run on stderr below) rather than silently swallowed.
    let sweep = null;
    if (!dryRun) {
      try {
        // BRAIN_MEMORY_SWEEP_FORCE_THROW (test-only seam, mirrors
        // BRAIN_MEMORY_HEAL_FORCE_THROW): throws before sweepLanes() is
        // ever called, so a test can exercise this try/catch's isolation
        // directly — sweepLanes()'s own internals have no reachable throw
        // in its pre-loop code today, this seam proves the isolation still
        // holds if that ever changes. NEVER set this outside tests.
        if (process.env.BRAIN_MEMORY_SWEEP_FORCE_THROW) {
          throw new Error(`forced failure for test coverage (BRAIN_MEMORY_SWEEP_FORCE_THROW=${process.env.BRAIN_MEMORY_SWEEP_FORCE_THROW})`);
        }
        const { sweepLanes } = await import("./lane/sweep.mjs");
        const { defaultGit } = await import("./lane/collect.mjs");
        sweep = await sweepLanes({
          root: memoryRoot,
          project: config.project.slug,
          tier: config.governance.tier,
          host: hostname(),
          today: result.date,
          git: defaultGit,
          vcs,
        });
      } catch (err) { /* surfaced: carried as `sweep.failed` in the JSON and one stderr line; today's ship is deliberately not failed by it (#936) */
        sweep = { failed: true, reason: err?.message ?? String(err) };
      }
    }

    if (asJson) {
      console.log(JSON.stringify({ ...result, invoker, sweep }));
    } else {
      console.log(`memory/cli: ${await t(`memory.ship.${shipOutcomeKey(result)}`, {
        ref: result.ref,
        branch: result.branch,
        number: result.pr?.number ?? null,
        reason: result.autoMerge?.reason ?? "",
      })}`);
    }

    // Evidence, always on stderr — never gated by --json (mirrors "collect").
    // #921: skippedWorktrees is evidence from the `collect()` step shipLane()
    // runs internally, unconditionally — reported here regardless of
    // --dry-run, so the SessionEnd trigger's log (which redirects this op's
    // stdout+stderr verbatim, see session-end-ship.mjs) surfaces it instead
    // of a silent "nothing to ship".
    // F3/F4 (cold review): same `?? []` guard and reason-bearing text as the
    // "collect" op above — see that block's comment.
    const skippedWorktreesHere = result.skippedWorktrees ?? [];
    if (skippedWorktreesHere.length > 0) {
      console.error(`memory/cli: ${await t("memory.collect.worktreeSkipped", {
        count: skippedWorktreesHere.length,
        paths: skippedWorktreesHere.map((w) => `${w.path} (${w.reason})`).join(", "),
      })}`);
    }
    if (!result.dryRun) {
      if (result.pushed) console.error(`memory/cli: ${await t("memory.ship.pushed", { ref: result.ref })}`);
      if (result.pr && result.pr.url === null && result.pr.number !== null) {
        console.error(`memory/cli: ${await t("memory.ship.prExisting", { number: result.pr.number })}`);
      }
      if (result.autoMerge?.enabled === true) {
        console.error(`memory/cli: ${await t("memory.ship.armed", { number: result.pr?.number ?? null })}`);
      }
      if (!result.identityBound) {
        console.error(`memory/cli: ${await t("memory.ship.identityAmbient")}`);
      }
      // D-sweep step 5.8: one stderr line per cross-day sweep row, same
      // "always on stderr, never gated by --json" evidence discipline as
      // skippedWorktrees/pushed/prExisting/armed above.
      //
      // #936 remediation: `sweep?.failed` (the fail-closed marker from the
      // isolated try/catch above) has no `branches` to iterate — reported as
      // its own single line instead, same discipline.
      if (sweep?.failed) {
        console.error(`memory/cli: ${await t("memory.ship.sweepFailed", { reason: sweep.reason ?? "" })}`);
      } else {
        for (const row of sweep?.branches ?? []) {
          console.error(`memory/cli: ${await t(`memory.ship.sweep.${row.action}`, {
            branch: row.branch, date: row.date, number: row.pr?.number ?? null, reason: row.reason ?? "",
          })}`);
        }
      }
    }
    process.exit(0);
  } catch (err) {
    // E3 (cold review): `raced`/`badHost` are named failures `collect()`
    // (called internally by `shipLane`) tags on the thrown error (A9, A5 —
    // same two tags the "collect" op's own catch above passes through)
    // — everything else here is a genuine ship-specific failure.
    // #1119: `prLookupFailed` is thrown from two call sites with opposite
    // push states — `decidePr()`'s own lookup always runs BEFORE the push
    // (D4), so nothing was ever pushed; `createPr()`'s one-shot re-scan only
    // ever runs AFTER the push step, so a real push may already have landed.
    // `err.pushed` (set at both throw sites, ship.mjs) picks the honest key
    // for each — never a single message claiming one outcome for both.
    const key = err?.raced ? "raced"
      : err?.badHost ? "badHost"
      : err?.diverged ? "diverged"
      : err?.pushFailed ? "pushFailed"
      : err?.prLookupFailed ? (err.pushed ? "prLookupFailedAfterPush" : "prLookupFailed")
      : err?.prCreateFailed ? "prCreateFailed"
      : "failed";
    console.error(`memory/cli: ${await t(`memory.ship.${key}`, { message: err.message })}`);
    process.exit(1);
  }
}

/** shipOutcomeKey() — maps `shipLane`'s outcome shape to one of the
 * `memory.ship.*` primary message keys (design.md A6's exit table). Kept a
 * pure function of the result, never of the error path (that is the `catch`
 * block above's job, off the THROWN, fatal branches only). */
function shipOutcomeKey(result) {
  if (result.dryRun) return "dryRun";
  // R8 REVERSAL (#920 -> #936, D4): checked before `prNumberUnknown`/
  // `nothing` — a closedUnmerged row's `pr.number` is set (the human-closed
  // PR's own number), so without this check it would fall through and be
  // misreported as "done".
  if (result.closedUnmerged) return "closedUnmerged";
  if (result.pr && result.pr.number === null) return "prNumberUnknown";
  if (result.pushed === false && result.pr === null) return "nothing";
  if (result.autoMerge?.enabled === false) return "autoMergeRefused";
  // R11 (#920): a reconciliation without a push (find/create + arm ran, zero
  // new commits) is still work — checked after `autoMergeRefused` (a refused
  // arm keeps its own precedence) and before the final `done`, so a run that
  // also pushed still reports "done".
  if (result.pushed === false && result.reconciled === true) return "reconciled";
  return "done";
}

// ---------------------------------------------------------------------------
// "migrate-v1" is likewise backend-agnostic (chunks → records is a durable-
// format concern, ADR-0017 — not a MEMORY_BACKEND one).
//
// `--dry-run`  → the C2a report only, never mutates `.memory/`.
// no `--dry-run` → executes the real migration (un-refused, C2b — design.md
//   Decision 1): the CLI being runnable IS the runbook's intended step 1;
//   the control is the runbook order + the human keystroke, not a CLI switch
//   (the `--no-scrub` class C1b prohibited stays rejected). `memory.dualWrite`
//   itself is retired (D3/C4, issue #229) — records-only write is now
//   unconditional. The abort-if-populated guard in `runMigration()` still
//   protects re-runs.
// `--rollback` → RETIRED (#955 R1/R2/D1): it refuses and exits 1. The old
//   behaviour restored chunks from `legacy/` and then deleted `records/`
//   unconditionally — on this repo (and any consumer past cutover) that
//   destroys every record written since migration to restore a transport
//   nothing reads. The refusal branch below runs BEFORE the `--dry-run`
//   check. Without it, `--rollback` falls through into the real forward
//   `runMigration()` in the next branch (and `--rollback --dry-run` prints
//   a migration report and exits 0).
//
// BRAIN_MIGRATE_V1_TEST_ROOT (test-only seam): when set, this op resolves
// `.memory/` under `<value>/.memory` instead of the real repo root. NEVER
// set this outside tests — it exists solely so cli.migrate-v1.test.mjs can
// drive this op end-to-end against a fixture without ever touching the
// real `.memory/`.
// ---------------------------------------------------------------------------
if (op === "migrate-v1") {
  const testRoot = process.env.BRAIN_MIGRATE_V1_TEST_ROOT;
  const memoryRoot = testRoot ? join(testRoot, ".memory") : join(repoRoot, ".memory");
  const chunksDir = join(memoryRoot, "chunks");
  const recordsDir = join(memoryRoot, "records");
  const legacyDir = join(memoryRoot, "legacy");
  const indexPath = join(memoryRoot, "index.jsonl");

  // D1 refusal branch — do NOT delete this `if`. Without it, `--rollback`
  // falls through into the real forward `runMigration()` in the next
  // branch below (and `--rollback --dry-run` prints a migration report
  // and exits 0 instead of refusing).
  if (process.argv.includes("--rollback")) {
    console.error(`memory/cli: ${await t("memory.migrateV1.rollbackRetired")}`);
    process.exit(1);
  }

  if (!process.argv.includes("--dry-run")) {
    const { runMigration } = await import("./lib/migrate-v1.mjs");
    try {
      const summary = runMigration({ chunksDir, recordsDir, legacyDir, indexPath });
      console.log(
        await t("memory.migrateV1.realRunSummary", {
          written: summary.written,
          rejected: summary.rejected,
          skipped: summary.skipped,
          unparseable: summary.unparseableChunks,
          emptyObservations: summary.emptyObservationsChunks,
          indexCount: summary.indexCount,
        }),
      );
      process.exit(0);
    } catch (err) {
      console.error(`memory/cli: ${err.message}`);
      process.exit(1);
    }
  }

  const { collectChunkObservations, buildMigrationReport } = await import(
    "./lib/migrate-v1.mjs"
  );

  const { observations, unparseable, emptyObservations } = collectChunkObservations(chunksDir);
  const report = buildMigrationReport(observations, { unparseable, emptyObservations });

  console.log(await t("memory.migrateV1.dryRunHeader"));
  console.log(
    await t("memory.migrateV1.summary", {
      records: report.recordCount,
      skipped: report.skippedPersonal,
      rejected: report.rejected.length,
      unparseable: report.unparseableChunks.length,
      emptyObservations: report.emptyObservationsChunks.length,
    }),
  );
  console.log(await t("memory.migrateV1.typesHistogramHeader"));
  for (const [type, count] of Object.entries(report.typesHistogram).sort()) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(
    await t("memory.migrateV1.provenanceHistogramHeader", {
      recovered: report.provenanceHistogram.recovered,
      fallback: report.provenanceHistogram.fallback,
    }),
  );
  if (report.rejected.length > 0) {
    console.log(await t("memory.migrateV1.rejectedHeader"));
    for (const r of report.rejected) {
      console.log(`  - id=${r.id} type=${r.type} title="${r.title}" reason=${r.reason}`);
    }
  }
  if (report.emptyObservationsChunks.length > 0) {
    console.log(await t("memory.migrateV1.emptyObservationsHeader"));
    for (const f of report.emptyObservationsChunks) console.log(`  - ${f}`);
  }
  if (report.unparseableChunks.length > 0) {
    console.log(await t("memory.migrateV1.unparseableHeader"));
    for (const f of report.unparseableChunks) console.log(`  - ${f}`);
    console.log(`  ${report.unparseableNote}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// "heal-duplicates" — reconciles the engram store's pre-guard duplicate rows
// (#1061, #864 task 1.2a; memory-backend-contract.md's Deletion clause).
// Engram-only, so it is dispatched HERE — before backend selection — the
// same way "split-records" is: MEMORY_BACKEND !== "engram" is a designed
// refusal (`memory.heal.notEngram`), never a FALLBACK_OPS substitution,
// because `plainfiles` has no observation-id space to reconcile at all.
//
// REPORT-ONLY BY DEFAULT (REQ-MB-2). `--apply` is required to delete
// anything; any other argument refuses `memory.heal.badFlag` and deletes
// nothing — an unknown flag fails closed rather than being silently ignored
// (the `split-records`/`ship` precedent for this dispatcher). The call and
// its outcome handling are wrapped in try/catch, mirroring "split-records"
// (`:250-304`): an unexpected throw must exit 1 with `memory.heal.failed`,
// never an uncaught stack trace.
// ---------------------------------------------------------------------------
if (op === "heal-duplicates") {
  const healBackend = await requireDeclaredBackend();
  if (healBackend !== "engram") {
    console.error(`memory/cli: ${await t("memory.heal.notEngram", { backend: healBackend })}`);
    process.exit(1);
  }
  const rest = process.argv.slice(3);
  const badFlag = rest.find((a) => a !== "--apply");
  if (badFlag !== undefined) {
    console.error(`memory/cli: ${await t("memory.heal.badFlag", { flag: badFlag })}`);
    process.exit(1);
  }
  const apply = rest.includes("--apply");
  const { healDuplicates } = await import("../axes/memory/adapters/engram.mjs");
  // Cold-review MAJOR #1: unlike every other branch in this file (see
  // "split-records", `:250-305`), this call used to run with no try/catch —
  // an unexpected throw crashed with a raw Node stack trace instead of the
  // `memory.heal.failed` message, and that message was otherwise reachable
  // only from the impossible "unknown outcome" branch below. Wrapping the
  // call AND its outcome handling, exactly like "split-records", makes
  // `memory.heal.failed` a REAL failure path instead of dead code.
  try {
    // BRAIN_MEMORY_HEAL_FORCE_THROW (test-only seam): throws before calling
    // healDuplicates(), so a test can exercise this try/catch directly —
    // healDuplicates() itself is already fully defensive (every exec/read it
    // performs is wrapped internally), so no misbehaving `engram` binary can
    // make the call below throw. NEVER set this outside tests.
    if (process.env.BRAIN_MEMORY_HEAL_FORCE_THROW) {
      throw new Error(`forced failure for test coverage (BRAIN_MEMORY_HEAL_FORCE_THROW=${process.env.BRAIN_MEMORY_HEAL_FORCE_THROW})`);
    }
    const result = healDuplicates({ apply });

    if (result.outcome === "refused") {
      const key = `memory.heal.refused.${result.refusal}`;
      console.error(
        `memory/cli: ${await t(key, {
          key: result.key ?? "",
          fields: (result.fields ?? []).join(", "),
          count: result.count ?? 0,
          detail: result.detail ?? "",
        })}`,
      );
      process.exit(1);
    }
    if (result.outcome === "none") {
      console.log(`memory/cli: ${await t("memory.heal.none", { rows: result.rows ?? 0, distinct: result.distinct ?? 0 })}`);
      process.exit(0);
    }
    if (result.outcome === "planned") {
      console.log(`memory/cli: ${await t("memory.heal.plan", { count: result.groups.length })}`);
      for (const g of result.groups) {
        console.log(`  ${g.key} — keep #${g.keep}, delete #${g.delete.join(", ")}`);
      }
      process.exit(0);
    }
    if (result.outcome === "healed") {
      console.log(
        `memory/cli: ${await t("memory.heal.deleted", { count: result.deleted.length, ids: result.deleted.join(", ") })}`,
      );
      console.log(`memory/cli: ${await t("memory.heal.done", { rows: result.rows ?? 0, distinct: result.distinct ?? 0 })}`);
      process.exit(0);
    }
    if (result.outcome === "partial") {
      console.error(
        `memory/cli: ${await t("memory.heal.partial", {
          deleted: result.deleted.join(", "),
          notDeleted: result.notDeleted.join(", "),
          detail: result.detail ?? "",
        })}`,
      );
      process.exit(1);
    }
    if (result.outcome === "unverified") {
      console.error(`memory/cli: ${await t("memory.heal.unverified", { deleted: result.deleted.join(", ") })}`);
      process.exit(1);
    }
    console.error(`memory/cli: ${await t("memory.heal.failed", { message: `unknown outcome '${result.outcome}'` })}`);
    process.exit(1);
  } catch (err) {
    console.error(`memory/cli: ${await t("memory.heal.failed", { message: err.message })}`);
    process.exit(1);
  }
}

// Map verb strings that cannot be valid JS export names to their actual export name.
// "import" is a reserved keyword in JS — the backend export is named "importMemory".
const VERB_TO_EXPORT = { import: "importMemory" };

// Normalize hyphenated op to camelCase for export name lookup,
// then apply reserved-keyword overrides.
// e.g. "feature-checkpoint" → "featureCheckpoint", "import" → "importMemory"
const fn = VERB_TO_EXPORT[op] ?? op.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Which backend actually runs (issue #641).
//
// Placed HERE, below the backend-agnostic ops: `reindex`, `resolve-index` and
// `migrate-v1` have already exited, because the durable format is brain-owned
// (ADR-0017) and they never consult a backend at all. Only the ops that do get
// this far, so nothing above pays for a probe it does not need.
//
// The decision itself is in lib/backend-selection.mjs, with the reasoning. What
// belongs here is the half the ticket is actually about: SAYING SO. Every
// outcome other than "the default was available" or "you named a backend"
// prints, because the failure #641 reports is not that the fallback was
// missing — `MEMORY_BACKEND=plainfiles` worked all along — it is that no
// message ever said so, and four PRs' worth of capture was skipped on the
// strength of an error that read as "capture is impossible here".
//
// To STDERR, for the same reason the duplicate report above uses it: the
// automated callers (`brain/scripts/hooks/pre-push`, `post-merge`) discard
// stdout, and a substitution notice on stdout would be discarded exactly where
// the substitution is most likely to happen. (#633 covers those two hooks
// swallowing stderr as well — flagged there, not worked around here.)
// ---------------------------------------------------------------------------
// `save` is the record-first capture path (memory-backend-contract rule 2): the record is
// durable before any backend is involved, so an undeclared/invalid selector must NOT lose
// the capture. It writes through plainfiles (records only, nothing hydrated) and says the
// hydration is deferred; every other op that gets here consults a backend and refuses.
let MEMORY_BACKEND;
if (op === "save" && RESOLVED.status !== "declared") {
  MEMORY_BACKEND = FALLBACK_BACKEND;
  console.error(
    `memory/cli: ${await t(
      RESOLVED.status === "invalid" ? "memory.backend.saveDeferred.invalid" : "memory.backend.saveDeferred.undeclared",
      { value: RESOLVED.invalidValue ?? "" },
    )}`,
  );
} else {
  MEMORY_BACKEND = await requireDeclaredBackend();
}
await reportShadowed();
const selection = selectBackend({
  requested: MEMORY_BACKEND,
  // STATED = an operator named it for this run or machine (process env, .env): never overridden
  // (ADR-0004). A backend declared only in tracked config is the TEAM's, and a checkout without
  // its binary must still get the records: `pull` is record-first, so it runs records-only and
  // says hydration is deferred (#1165 cold-1) — consistent with `save`.
  stated: RESOLVED.source !== "config",
  op,
  probe: MEMORY_BACKEND === DEFAULT_BACKEND ? probeBinary(ENGRAM_BIN) : { available: true },
});

if (selection.reason === REASON.SUBSTITUTED) {
  console.error(
    `memory/cli: ${await t("memory.backend.substituted", {
      op,
      from: selection.from,
      fallback: selection.backend,
      source: sourceLabel(RESOLVED.source),
    })}`,
  );
} else if (selection.reason === REASON.STATED_BUT_ABSENT) {
  // Not a substitution and not fatal on its own — the dispatch below still
  // fails exactly as it does today. This adds the signpost that was missing:
  // the old message named only `gentle-ai install`, so the working alternative
  // was invisible to a reader who had no way to install anything.
  console.error(
    `memory/cli: ${await t("memory.backend.statedButAbsent", {
      op,
      source: sourceLabel(RESOLVED.source),
      backend: MEMORY_BACKEND,
      fallback: FALLBACK_BACKEND,
    })}`,
  );
} else if (selection.reason === REASON.PROBE_FAILED) {
  // "I could not check" is reported as itself, never as "engram is missing" —
  // the `evidence-reader-empty-on-failure` distinction. Nothing is switched on
  // an answer this weak, so the run continues on the default.
  console.error(
    `memory/cli: ${await t("memory.backend.probeFailed", {
      op,
      backend: MEMORY_BACKEND,
      fallback: FALLBACK_BACKEND,
      reason: selection.detail,
    })}`,
  );
}

// ---------------------------------------------------------------------------
// Load backend and dispatch
// ---------------------------------------------------------------------------
const BACKEND = selection.backend;
const backendPath = new URL(`../axes/memory/adapters/${BACKEND}.mjs`, import.meta.url);

let backend;
try {
  backend = await import(backendPath);
} catch (err) {
  console.error(`memory/cli: backend '${BACKEND}' not found at ${backendPath.pathname}`);
  console.error(`  Cause: ${err.message}`);
  process.exit(1);
}

if (typeof backend[fn] !== "function") {
  console.error(`memory/cli: backend '${BACKEND}' does not implement op '${op}'`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// "save" carries structured flags (--type/--project/--scope/--topic) the
// generic positional-forward below would mis-pass as extra positionals
// (design.md Decision 7). A minimal arg parser extracts the two positionals
// (title, content) and the four flags into {type, project, scope, topic},
// then calls backend.save(title, content, opts, seams). This keeps the
// parser backend-agnostic: engram's save receives the same shape and
// refuses it (Decision 5) via the shared unsupportedOp helper.
//
// NO --actor/--actor-kind/--ts flag is recognized ANYWHERE in this parser
// (Decision 2 — spoof resistance enforced at the parser, never a caller-
// supplied provenance field).
//
// BRAIN_MEMORY_TEST_ROOT (test-only seam, mirrors BRAIN_MIGRATE_V1_TEST_ROOT
// above): when set, save/search resolve `.memory/` under `<value>` instead
// of the real repo root. NEVER set this outside tests.
// ---------------------------------------------------------------------------
const memoryTestRoot = process.env.BRAIN_MEMORY_TEST_ROOT;

if (op === "save") {
  const rest = process.argv.slice(3);
  const positionals = [];
  const flags = {};
  // `--supersedes` (#805): the generic `flags[key] = rest[++i]` parser below is
  // uniformly last-wins and cannot tell "absent" from "present with no value" —
  // measured, design.md A5. Neither hole is safe for a field the backend cannot
  // see twice, so the count and the final value are tracked here, at the parser,
  // and refused before any backend is ever reached.
  let supersedesCount = 0;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      // fresh-context review MINOR-1: `--supersedes=<id>` is NOT the
      // space-separated form this parser recognizes for ANY flag — left
      // unhandled, `key` becomes the bogus flag name `"supersedes=<id>"`,
      // `flags.supersedes` stays undefined, and the NEXT argv token is
      // consumed as that bogus key's value. That silently wrote a record
      // missing the field the caller asked for (exit 0). Counted and
      // refused the same way a value-less `--supersedes` is refused below,
      // instead of accepted by splitting on `=` — every other flag in this
      // parser only understands the space-separated form, so accepting `=`
      // here alone would be an inconsistent one-off carve-out.
      if (key === "supersedes" || key.startsWith("supersedes=")) supersedesCount += 1;
      if (key.startsWith("supersedes=")) continue;
      flags[key] = rest[++i];
    } else {
      positionals.push(arg);
    }
  }
  if (supersedesCount > 1) {
    console.error(`memory/cli: ${await t("memory.save.supersedesRepeated")}`);
    process.exit(1);
  }
  if (supersedesCount === 1 && flags.supersedes === undefined) {
    console.error(`memory/cli: ${await t("memory.save.supersedesMissingValue")}`);
    process.exit(1);
  }
  const [title, content] = positionals;
  // `--issue` (#530): the record format has carried an `issue` field all along and
  // no verb ever populated it — #368 measured 2157 records with it empty. A record
  // that cannot be tied to a ticket is one the coverage metric already reports as
  // "adoption pending". Parsed here as a NUMBER: `validateWritableRecord`'s W2
  // refuses a non-integer, so a typo fails closed at the chokepoint rather than
  // landing a string in a durable field.
  const issue = flags.issue === undefined ? undefined : Number(flags.issue);
  // `--supersedes` is forwarded UNPARSED to every backend (design.md — the CLI
  // enforces arity, plainfiles.mjs owns the store check, engram.mjs's catalog
  // message just names the flag).
  const opts = { type: flags.type, project: flags.project, issue, supersedes: flags.supersedes, scope: flags.scope, topic: flags.topic };
  const seams = memoryTestRoot ? { root: memoryTestRoot } : {};
  try {
    // #874 — a deferred/contended hydration is already reported on stderr by
    // engram.mjs#hydrate() itself (mirrors importMemory()'s own `_warn`
    // convention); the record is ALREADY durable by the time save() returns
    // (appended + indexed before hydrate ever runs), so `save` still exits 0
    // exactly as it does when the engram backend was never selected at all —
    // a backend failure here must never read as a lost capture (R5).
    const result = await backend.save(title, content, opts, seams);
    console.log(`memory/cli: ${await t("memory.plainfiles.save.done", { id: result?.id, file: result?.file })}`);
    await reportDuplicates(result?.duplicates, { indexCount: result?.indexCount });
    process.exit(0);
  } catch (err) {
    // #637 — the index rebuild is the ONE gate that cannot run before the
    // append, so its failure must not be reported as "the save failed". The
    // record is on disk; a bare `save() failed` sends the operator to the one
    // action that makes it worse, which is to run `save` again.
    if (err?.indexFailed) {
      console.error(
        `memory/cli: ${await t("memory.plainfiles.save.indexFailed", {
          id: err.recordId,
          file: err.recordFile,
          message: err.message,
        })}`,
      );
    } else {
      // `BACKEND`, not `MEMORY_BACKEND` (#641, merged first): the message must
      // name the backend that actually RAN, which after the fallback is not
      // necessarily the one the selector resolved to.
      console.error(`memory/cli: ${BACKEND}.save() failed — ${err.message}`);
    }
    process.exit(1);
  }
}

if (op === "search") {
  const query = process.argv[3];
  const searchOpts = memoryTestRoot ? { root: memoryTestRoot } : {};
  try {
    const result = await backend.search(query, searchOpts);
    if (!result?.matches?.length) {
      console.log(`memory/cli: ${await t("memory.plainfiles.search.empty")}`);
    } else {
      console.log(`memory/cli: ${await t("memory.plainfiles.search.summary", { count: result.matches.length })}`);
      for (const m of result.matches) {
        console.log(`  - ${m.id} [${m.type}] ${m.content.slice(0, 120)}`);
      }
    }
    // A duplicated record used to come back as two identical hits and inflate
    // the count printed above (#574) — it is collapsed now, and said so.
    //
    // `the records read`, not `the result set`: the accounting is store-wide
    // (the reader collapses every repeat it passes, matched or not), so on a
    // query that matched nothing "collapsed into the result set" would name a
    // collapse that did not happen there. And `brief`, because a search is a
    // question about records, not a maintenance run on the store.
    await reportDuplicates(result?.duplicates, { surface: 'the records read', brief: true });
    process.exit(0);
  } catch (err) {
    console.error(`memory/cli: ${BACKEND}.search() failed — ${err.message}`);
    process.exit(1);
  }
}

// BRAIN_MEMORY_TEST_ROOT for the store-wide ops too (#574). Without it these
// ops resolve the REAL `.memory/` no matter what the seam says — which is how
// the end-to-end test for `share`'s duplicate report first ran against this
// repository's own store. Restricted to these four by name:
// `feature-checkpoint`/`feature-resume` take a positional [feature], and
// passing them an options object would silently become a feature named
// "[object Object]".
//
// HONEST BOUND, because the first version of this comment claimed a guarantee
// it does not have — and #1010 measured that the gap WAS a live defect, not
// merely an unreachable one: `cli.backend-fallback.test.mjs`'s own `setup`
// test forwards `BRAIN_MEMORY_TEST_ROOT`, `engram.setup()` silently discarded
// it, and every `npm test` run wrote `.engram` into whatever the real repo
// root happened to be — including a cold-review candidate worktree, which is
// how the symlink ended up inside a tree under review. `{root}` is now
// HONOURED by every plainfiles op and by `engram.share`/`engram.importMemory`/
// `engram.setup` (#1010). `engram.pull()` still takes NO parameters (see its
// definition), so it still discards `{root}` and acts on the real repo root —
// any test that needs a rooted `engram.pull` must give it a `{root}` first
// rather than trusting this set.
const ROOTED_OPS = new Set(["share", "pull", "import", "setup"]);

try {
  // Forward positional args (e.g., [feature]) to the backend function.
  const forwarded = memoryTestRoot && ROOTED_OPS.has(op)
    ? [{ root: memoryTestRoot }]
    : process.argv.slice(3);
  const result = await backend[fn](...forwarded);

  // #874 split B (row 1, R11): `share()` no longer calls the records
  // dual-write exporter, so its return value is now the bare
  // `{indexCount, duplicates}` mirror of `plainfiles.share()` —
  // `unprovenanced`, `upstreamScope` (issue #701), and `dedupedUpstream`
  // never reach `result` for `op === "share"` any more. The three print
  // blocks that used to surface them here retired with the exporter; the
  // exporter itself is gone too now (#955 R5, epic task 2.4) — it had no
  // production caller left after #874 split B, only its own tests.

  // #574 — the duplicate accounting, for every op that produced one (`share`,
  // `pull`, `setup`, `import`, and anything added later that reads the store).
  // Keyed on the result carrying it, not on a list of verbs: the failure this
  // ticket names is a store-wide rule that only some callers happened to voice.
  //
  // `import` gets its own surface: it hydrates engram from `records/` and never
  // writes the index (only `pullMemory` reindexes), so the default wording
  // would have it claim a collapse into an index it did not touch.
  await reportDuplicates(result?.duplicates, {
    indexCount: result?.indexCount,
    surface: op === "import" ? "the records read" : undefined,
  });
} catch (err) {
  console.error(`memory/cli: ${BACKEND}.${fn}() failed — ${err.message}`);
  process.exit(1);
}
