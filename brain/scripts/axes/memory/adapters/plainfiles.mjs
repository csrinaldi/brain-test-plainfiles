#!/usr/bin/env node
// brain/scripts/axes/memory/adapters/plainfiles.mjs — the `plainfiles` backend for
// the MEMORY_BACKEND dispatcher (C3, issue #246). `.memory/records/*.jsonl`
// IS the store — git is the only writer, zero non-Node binaries required.
// Mirrors engram.mjs's conventions: every op is async, every external
// dependency is an injectable seam. Full rationale: openspec/changes/
// issue-246-c3/design.md. Q1 asymmetry (obs #578): save/search/share/pull/
// setup are real here; index/featureCheckpoint/featureResume defer loudly.

import { mkdirSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { _getGitBranch } from "./engram.mjs";
import { buildRecord, serializeRecord, nowUtcSeconds, RECORD_TYPES } from "../../../memory/lib/format.mjs";
import { appendRecord, rebuildIndex, readRecords, readRecordIds } from "../../../memory/lib/store.mjs";
import { normalizeDuplicates } from "../../../memory/lib/duplicates.mjs";
import { gitConfigGet } from "../../../lib/git-config.mjs";
import { resolveActor, resolveActorKind, deriveIssue, composeSource } from "../../../memory/lib/capture-provenance.mjs";
import { upstreamRecordEntries } from "../../../memory/lib/upstream-records.mjs";
import { defaultGitPull } from "../../../memory/lib/reconcile-pull.mjs";
import { classifySupersedes } from "../../../memory/lib/supersedes.mjs";
import { loadBrainConfigOrThrow } from "../../../lib/brain-config.mjs";

/** The repository this record belongs to, from config, falling back to the checkout
 *  directory name. Records in this repo carry the bare name ("brain"), not the slug. */
function deriveProject(config, root) {
  const slug = config?.project?.slug;
  if (typeof slug === "string" && slug.trim() !== "") return slug.split("/").pop();
  const name = config?.project?.name;
  if (typeof name === "string" && name.trim() !== "") return name;
  return String(root).replace(/\/+$/, "").split("/").pop();
}
import { resolveSecretConfig, compilePatterns, scanTextForSecrets } from "../../../memory/lib/secret-scrub.mjs";
import { unsupportedOp } from "../../../memory/lib/unsupported-op.mjs";
import { t } from "../../../i18n/t.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");

/**
 * Reads brain.config.json for governance.memorySecret* keys, via
 * `loadBrainConfigOrThrow` (#942). ENOENT still returns `{}` (absence stays
 * green, R12/REQ-SCAN-3); every OTHER read/parse failure PROPAGATES (#712,
 * REQ-SCAN-1) — the same read also feeds `deriveProject` above (R5), so a
 * refusal here now also protects that fallback from writing a wrong,
 * durable `project` label.
 */
function _defaultLoadBrainConfig(root) {
  return loadBrainConfigOrThrow(root);
}

/**
 * save() — scan-then-write: appends one validated record to
 * `.memory/records/<yyyy-mm>.jsonl` with MEASURED, never-flagged provenance
 * (REQ-C3-2; rewired at #738). Mirrors `_defaultEngramSave`'s arg shape;
 * `scope`/`topic` are accepted for shape parity but not persisted (no home
 * in the record format, C0/C1). No `actor`/`actorKind`/`ts` field accepted
 * anywhere:
 *
 *   - `actor`     ← `resolveActor(getGitConfig('brain.actor'))` — the
 *                   configured handle. Refused (throws), by name, when
 *                   unset, not handle-shaped, or the reserved `@legacy`
 *                   sentinel (#738; never the branch — #542's "not a
 *                   defect" is overturned, the branch answers WHERE, not
 *                   WHO).
 *   - `actorKind` ← `resolveActorKind(getEnv(), getGitConfig('brain.agentEnv'))`
 *                   — MEASURED from the agent-marker env, never a
 *                   door-typed constant.
 *   - `issue`     ← the caller's `--issue` when given, else DERIVED from
 *                   `getBranch(root)` via `deriveIssue` (a stdout notice
 *                   fires when derived), else absent — never fabricated.
 *   - `ts`        ← getTimestamp seam (C2a canonical, never `new Date()`
 *                   directly).
 *
 * Order mirrors the retired dualWriteRecords (#977): scan for secrets BEFORE any write. `type`
 * and `--issue` shape refusals stay FIRST — both are caller mistakes fixable
 * in the same second; the actor refusal is a machine-setup question.
 *
 * @param {string} title
 * @param {string} content
 * @param {{type: string, project: string, issue?: number, supersedes?: string, scope?: string, topic?: string}} [opts]
 * @param {object} [seams]  root, getBranch, getTimestamp, getHostname, getGitConfig, getEnv, _appendRecord, _rebuildIndex, _loadConfig, _readRecordIds, _upstreamRecordEntries
 * @returns {Promise<{id: string, file: string, written: boolean}>}
 */
export async function save(
  title,
  content,
  // scope/topic accepted for _defaultEngramSave arg-shape parity — the record
  // format has no home for them (out of scope for C3), so they are ignored
  // LOUDLY (a console.warn naming them, never a silent drop) rather than
  // erroring (an error would break the arg-shape parity the mirror exists for).
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
  } = {},
) {
  const ignoredOpts = [scope && "scope", topic && "topic"].filter(Boolean);
  if (ignoredOpts.length > 0) {
    console.warn(await t("memory.save.plainfilesIgnoredOpts", { opts: ignoredOpts.join(", ") }));
  }

  const ts = getTimestamp();
  // `getBranch` SURVIVES (#738) — it now feeds `issue`, never `actor`.
  const branch = getBranch(root);
  const config = _loadConfig(root);

  // DERIVE WHAT IS DERIVABLE, REFUSE WHAT IS A CHOICE (issue #530).
  //
  // Both fields are required by `buildRecord`, and omitting either used to reach
  // `computeRecordId` → `canonicalJson`, which threw
  // `unsupported value type 'undefined'` — a message naming neither the field nor
  // the flag. `memory save "t" "c"`, the most obvious invocation of the capture
  // path, failed that way.
  //
  // `project` is derivable: it is this repository, and the config already says
  // which. Refusing it would be asking the caller to retype something the tool
  // knows. `type` is a CHOICE among seven, and defaulting it would put a
  // fabricated meaning on a durable record — so it is refused, by name, with the
  // list. The asymmetry is the point: derive facts, never opinions.
  const resolvedProject = project ?? deriveProject(config, root);
  if (!type) {
    throw new Error(await t("memory.plainfiles.save.typeRequired", { types: RECORD_TYPES.join(", ") }));
  }
  // `validateWritableRecord`'s W2 already says "issue must be an integer" — and it is
  // UNREACHABLE for a non-numeric one, because `computeRecordId` hashes the field and
  // `canonicalJson` throws on NaN first. So `--issue abc` failed closed with
  // "non-finite numbers are not supported": correct direction, useless message, and a
  // rule that reads as enforced while the path never arrives. Refused here, by name.
  if (issue !== undefined && issue !== null && !Number.isInteger(issue)) {
    throw new Error(await t("memory.plainfiles.save.issueInvalid", { value: String(issue) }));
  }

  // TWO GATES, BOTH BEFORE `buildRecord` (merge of #738 and #805).
  //
  // ORDER: provenance (#738) FIRST, then `--supersedes` (#805), then the build.
  // Either order is contract-conformant on its own — both refuse before
  // anything is hashed, scanned, appended or indexed — but only this one keeps
  // BOTH of the orders' own promises at once:
  //   - #805 promises a MALFORMED `--supersedes` id touches no IO. Kept: the
  //     grammar check inside `classifySupersedes` runs before either thunk, so
  //     the gate's position is irrelevant to that promise.
  //   - #738 promises the store is not read before the actor refusal fires. A
  //     WELL-SHAPED but absent id makes `classifySupersedes` read
  //     `.memory/records/` (and possibly spawn git for `origin/main`); running
  //     that first would mean an unconfigured machine scanned the store before
  //     being told it may not write to it. So the actor gate goes first.
  // The two caller-mistake refusals above (`type`, `--issue` shape) still come
  // first of all: they are fixable in the same second.

  // #738 — the actor refusal is a machine-setup question, kept AFTER the two
  // caller-mistake refusals above so no existing "first failure" message changes.
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

  const source = composeSource({ host: getHostname(), backend: "plainfiles", actor: actorResult, kind: kindResult, issue: issueResult });

  const recordsDir = join(root, ".memory", "records");

  // `--supersedes` (#805) — local store first, `origin/main` only on a local
  // miss (design.md A1); the whole gate is a no-op when the flag is absent,
  // so an ordinary save reads no directory and spawns no git.
  if (supersedes !== undefined) {
    // `localIds` is a thunk (cold-review blocker, #805): `classifySupersedes`
    // checks the id's grammar FIRST, with no IO, and only calls this when the
    // shape is valid. Reading the store eagerly here — before the shape check
    // — would mean a malformed id still touched disk before being rejected.
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

  // THE APPEND IS ALREADY DONE (issue #637), and it cannot be ordered otherwise:
  // `rebuildIndex` reads the WHOLE store, so it can only run after the line it
  // has to see. Every other write in this codebase scans before it writes —
  // the retired `dualWriteRecords` (#977) aborted "before the append-only log is ever touched",
  // `share()` runs the chunk backstop first for the same reason — and `save` is
  // the one verb that cannot follow the rule.
  //
  // So this failure is NOT "the save was refused". The record is durable. It is
  // "the save landed, and this store cannot be indexed — almost certainly for a
  // reason that predates this run". Those are two different situations and the
  // old bare `plainfiles.save() failed — …` reported them identically, which
  // sent the operator to the one action that makes it worse: running `save`
  // again.
  //
  // The original error is ANNOTATED AND RETHROWN rather than wrapped: every
  // caller keeps the fail-closed throw it already had, `err.message` still
  // carries `rebuildIndex`'s precise `file:line` diagnosis, and the stack still
  // points at the real origin. Only cli.mjs reads the annotations.
  let reindex;
  try {
    reindex = _rebuildIndex({ recordsDir, indexPath });
  } catch (err) {
    // Annotating a NON-OBJECT throw is itself a way to destroy the diagnosis:
    // `throw 'boom'` is legal JS, module code is always strict, and assigning a
    // property to a primitive there raises `TypeError: Cannot create property
    // 'indexFailed' on string 'boom'` — replacing the real failure with an
    // internal one and losing the record's id and file with it. Measured, not
    // imagined. So a primitive is wrapped instead, keeping its text as the
    // message. `rebuildIndex` throws Errors today; this is about not making a
    // future seam's mistake unreadable.
    const annotated = (err !== null && (typeof err === 'object' || typeof err === 'function'))
      ? err
      : new Error(String(err));
    annotated.indexFailed = true;
    annotated.recordId = candidate.id;
    annotated.recordFile = file;
    throw annotated;
  }

  // #574: every op that reindexes carries the duplicate accounting out to the
  // CLI, which prints it. `save` included — it is the verb most likely to be
  // the first thing run after a `git pull` that union-merged a duplicate in.
  // `indexCount` travels too, so the report can state the store/index gap
  // rather than making the reader compute it.
  return {
    id: candidate.id,
    file,
    written: true,
    indexCount: reindex?.count,
    duplicates: normalizeDuplicates(reindex?.duplicates),
  };
}

/** Default seam: `which rg` — never throws. */
function _defaultWhich(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0;
}

/** Default seam: best-effort `rg` accelerant — output never determines the result (see search()). */
function _defaultRg(query, { root, mode }) {
  try {
    const recordsDir = join(root, ".memory", "records");
    const args = mode === "regex" ? ["-i", query, recordsDir] : ["-i", "-F", query, recordsDir];
    spawnSync("rg", args, { encoding: "utf8" });
  } catch { /* swallow-ok: rg is an accelerant whose output never determines the search result (see search()) */
    /* best-effort accelerant — never fatal */
  }
}

/** Case-insensitive substring (default) or regex (`mode: 'regex'`) predicate over content/type. */
function _buildPredicate(query, mode) {
  if (mode === "regex") {
    const re = new RegExp(query, "i");
    return (record) => re.test(record.content ?? "") || re.test(record.type ?? "");
  }
  const q = String(query).toLowerCase();
  return (record) =>
    (record.content ?? "").toLowerCase().includes(q) || (record.type ?? "").toLowerCase().includes(q);
}

/**
 * search() — zero-binary Node scan over `.memory/records/` (REQ-C3-3).
 * `rg` is an OPTIONAL accelerant gated on `which rg`; the final match set is
 * ALWAYS produced by the same Node predicate over the same observation set —
 * rg's presence changes speed, never output.
 *
 * Reads through `readRecords` (#574): a duplicated physical line used to come
 * back as two identical hits, and the count printed by cli.mjs was the store's
 * line count, not its record count. The repeats are collapsed AND reported —
 * search is not exempt from the rule just because it writes nothing.
 *
 * @param {string} query
 * @param {{root?: string, mode?: 'substring'|'regex'}} [opts]
 * @param {object} [seams]  _which, _rg, _readRecords
 * @returns {Promise<{matches: object[], duplicates: object}>}
 */
export async function search(
  query,
  { root = repoRoot, mode = "substring" } = {},
  { _which = _defaultWhich, _rg = _defaultRg, _readRecords = readRecords } = {},
) {
  const recordsDir = join(root, ".memory", "records");
  // Same tolerance as importMemory's reader: a seam returning a bare array is
  // "records, no accounting", never a TypeError (#574 changed this shape).
  const read = _readRecords({ recordsDir });
  const observations = Array.isArray(read) ? read : (read?.records ?? []);
  const duplicates = Array.isArray(read) ? undefined : read?.duplicates;

  if (_which("rg")) {
    try {
      _rg(query, { root, mode });
    } catch { /* swallow-ok: rg is an accelerant whose output never determines the search result (see search()) */
      /* best-effort accelerant — never fatal, never changes the result below */
    }
  }

  const predicate = _buildPredicate(query, mode);
  return { matches: observations.filter(predicate), duplicates: normalizeDuplicates(duplicates) };
}

/**
 * share() — a self-check `rebuildIndex()` ONLY (REQ-C3-4). Records already
 * ARE the store, so no data movement whatsoever.
 *
 * The self-check now has something to say (#574): `duplicates` travels out to
 * cli.mjs, which prints it. A `share` that silently indexes 139 fewer lines
 * than the store holds is not a self-check.
 *
 * SIDE EFFECT ON A REPO WITH NO RECORD STORE (issue #634). Measured:
 *
 *   before: <repo>/                       (nothing)
 *   after:  <repo>/.memory/index.jsonl    (empty)
 *
 * `rebuildIndex` creates `.memory/` and writes an empty index rather than doing
 * nothing, so this verb — a no-op on such a repo before #598's zero-candidate
 * self-check — now creates state. DOCUMENTED rather than gated, deliberately:
 *
 *   - #598's intent is that a share which READ the store leaves a canonical
 *     index behind, and an empty store is still a store that was read.
 *   - the ambiguity this could create — "zero records" vs "no store at all" —
 *     is already answered where it could mislead: `computeMemoryCoverage`
 *     resolves it from `existsSync(records/)`, never from the index, and
 *     reports `available: false` for the second case.
 *   - gating on `records/` existing would change this verb's contract to fix a
 *     misreading that nothing currently makes.
 *
 * If a consumer ever starts inferring "this repo has no memory" from an ABSENT
 * index rather than an absent `records/`, that inference is the defect — but
 * this note is here so it cannot be a surprise.
 */
export async function share({ root = repoRoot } = {}, { _rebuildIndex = rebuildIndex } = {}) {
  const recordsDir = join(root, ".memory", "records");
  const indexPath = join(root, ".memory", "index.jsonl");
  const { count, duplicates } = _rebuildIndex({ recordsDir, indexPath });
  return { indexCount: count, duplicates: normalizeDuplicates(duplicates) };
}

/**
 * pull() — `git pull` then `rebuildIndex()`, records-only (REQ-C3-4). NO
 * manifest-dirty-discard, NO importMemory step: plainfiles never
 * materializes anything, git is the only writer, so a dirty tree is real
 * work and MUST NOT be auto-discarded — `_gitPull`'s error propagates
 * unmodified through this rejection into cli.mjs's existing catch-and-exit-1.
 *
 * This is the path #574's rule matters most on: the `git pull` immediately
 * above is where `merge=union` MINTS the duplicate, so the reindex right after
 * it is the first reader that can see it. It REPORTS the duplicate instead of
 * absorbing it — including a disagreeing pair, which is counted as divergent
 * and resolved first-wins, never refused.
 */
export async function pull({ root = repoRoot } = {}, { _gitPull = defaultGitPull, _rebuildIndex = rebuildIndex } = {}) {
  _gitPull(root); // throws unmodified on a dirty/conflicting tree — never auto-discarded
  const recordsDir = join(root, ".memory", "records");
  const indexPath = join(root, ".memory", "index.jsonl");
  const { count, duplicates } = _rebuildIndex({ recordsDir, indexPath });
  return { indexCount: count, duplicates: normalizeDuplicates(duplicates) };
}

/**
 * setup() — deliberately MINIMAL (design Decision 1): ensures
 * `.memory/records/` exists + `rebuildIndex()` self-check. NO `.engram`
 * symlink (ADR-0002 is engram-only), NO merge-driver registration (backend-
 * agnostic, owned by the record format).
 */
export async function setup({ root = repoRoot } = {}, { _rebuildIndex = rebuildIndex } = {}) {
  const recordsDir = join(root, ".memory", "records");
  const indexPath = join(root, ".memory", "index.jsonl");
  mkdirSync(recordsDir, { recursive: true });
  const reindex = _rebuildIndex({ recordsDir, indexPath });
  return { duplicates: normalizeDuplicates(reindex?.duplicates) };
}

// ---------------------------------------------------------------------------
// Deferred ops (REQ-C3-5) — no plainfiles-native projection target. Each
// defers loudly via the shared unsupportedOp helper — never a silent no-op.
// ---------------------------------------------------------------------------

export async function index() {
  await unsupportedOp("index", "plainfiles");
}

export async function featureCheckpoint() {
  await unsupportedOp("featureCheckpoint", "plainfiles");
}

export async function featureResume() {
  await unsupportedOp("featureResume", "plainfiles");
}
