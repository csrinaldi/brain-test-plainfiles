// upstream-records.mjs — the ONE predicate issue #701 is about: which record
// `id`s are already durable at the upstream base. design.md Decisions 1-4.
//
// A candidate record is declined when its `id` is already present in
// `.memory/records/` at the upstream base — content-addressed, no
// authorship semantics. `store.mjs#recordFilename` is the ONE place a record
// maps to a path (`<yyyy-mm>-<id>.jsonl`), so the id IS the filename for
// every in-tree producer; reading basenames at a ref costs one `git ls-tree`
// spawn and zero blob reads (design.md Decision 1).
//
// Three functions, two of them pure:
//   resolveUpstreamRef()   — I/O: which ref answers "what is already durable"
//   upstreamRecordEntries() — I/O: the discriminated `{ok, ...}` result
//   parseLsTree()          — PURE: `-z` ls-tree text → {byId, byPath, unnamed}

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The filename grammar `store.mjs#recordFilename` writes (issue #677). */
const RECORD_NAME_RE = /^\d{4}-\d{2}-(rec-[0-9a-f]{16})\.jsonl$/;

/**
 * refResolves() — `git rev-parse --verify --quiet <ref>^{tree}`, true only on
 * a clean zero exit. No git binary, a non-git directory, and an unresolvable
 * ref all collapse to `false` here — the caller does not need to tell them
 * apart, only to know "this ref does not answer".
 *
 * @param {string} ref
 * @param {string} root
 * @param {typeof spawnSync} _spawn
 * @returns {boolean}
 */
/**
 * loadBrainConfigAt() — reads `brain.config.json` relative to a given root.
 *
 * `lib/brain-config.mjs`'s `loadBrainConfig()` resolves its path from the
 * MODULE's own location and takes no argument, so it cannot answer "the config
 * of this root" — which is what a seam-injectable, root-parameterised lookup
 * needs, and what the tests drive against a tmpdir.
 *
 * ABSENT and UNPARSEABLE are not the same answer (cold review of #708). An
 * absent file means "no stated ref" and the derived candidates correctly take
 * over — that is `{}`. A file that is present but cannot be read or parsed
 * means "could not look", and collapsing that to `{}` is exactly the
 * `evidence-reader-empty-on-failure` failure this module cites below: an
 * operator who states `memory.upstreamRef` and then breaks the JSON would
 * SILENTLY get `origin/HEAD` with `stated: false`. So it THROWS, mirroring
 * `lib/brain-config.mjs#loadBrainConfig`'s own parse refusal, and
 * `resolveUpstreamRef` turns that throw into a NAMED `configError` carried on
 * the result — loud, never silent, and never a stop (see `resolveUpstreamRef`).
 *
 * The parse wrapper says "could not be parsed", not "is not valid JSON": the
 * `JSON.parse` message it wraps already ENDS in "is not valid JSON", and the
 * operator read the phrase twice in one line (cold review round 2 of #701).
 *
 * @param {string} root
 * @returns {object}
 * @throws {Error} when `brain.config.json` exists but cannot be read or parsed
 */
function loadBrainConfigAt(root) {
  const path = join(root, 'brain.config.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // ENOENT is the ONE "there is nothing to read" case. Every other read
    // failure (a directory, a permission error) is "could not look".
    if (err?.code === 'ENOENT') return {};
    throw new Error(`brain.config.json at ${root} could not be read: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`brain.config.json at ${root} could not be parsed: ${err.message}`);
  }
}

function refResolves(ref, root, _spawn) {
  try {
    const r = _spawn('git', ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`], { cwd: root, encoding: 'utf8' });
    if (r?.error) return false;
    return r?.status === 0;
  } catch { /* swallow-ok: a failed ref probe reads as "ref not present", the answer the probe exists to give */
    return false;
  }
}

/**
 * resolveUpstreamRef() — design.md Decision 2's table: env >
 * `brain.config.json` `memory.upstreamRef` > `origin/HEAD` > `origin/main`.
 *
 * STATED (levels 1-2) vs DERIVED (levels 3-4), the same split
 * `backend-selection.mjs` already uses for `MEMORY_BACKEND` (#641): a stated
 * ref is an operator's explicit escape hatch and is NEVER silently overridden
 * by falling through to a different ref they did not ask for — if it does not
 * resolve, resolution stops there and reports `resolved: false` against THAT
 * ref. A derived ref may fall through to the next derived candidate.
 *
 * `config` DEFAULTS TO READING `brain.config.json` from `root`, and that
 * default is the fix for a real defect (cold review of #705/#706): level 2 was
 * documented here, named in this module's own refusal text, and **dead in
 * production** — neither call site passed a `config`, so `memory.upstreamRef`
 * resolved to `undefined` and fell through to `origin/HEAD`, silently
 * overriding a stated ref, which is exactly what the paragraph above promises
 * never happens.
 *
 * It is read HERE rather than threaded from each caller on purpose: this module
 * owns the key, so one definition serves every call site and a future one
 * cannot forget to pass it. Tests still inject `config` explicitly, and passing
 * `{}` still means "no stated ref" — only `undefined`/omitted triggers the read.
 * Every wrapper in this module's call chain therefore leaves `config`
 * UNDEFAULTED: an intervening `config = {}` is not nullish, so it would defeat
 * the `??` and leave level 2 dead exactly as it was before the default existed.
 *
 * An UNREADABLE `brain.config.json` (present, but unparseable, or a directory)
 * is REPORTED — a `configError` string travels on every result derived past it,
 * all the way to the operator — and resolution then CONTINUES to levels 3-4.
 * It does not stop.
 *
 * That is a deliberate correction of the first attempt (cold review round 2 of
 * #701), which stopped at level 2 with `stated: true, resolved: false` against a
 * pseudo-ref. The config is ONE of four levels, and levels 3-4 stay perfectly
 * answerable when it is broken. Stopping meant a repo whose config is corrupt
 * and **never stated `memory.upstreamRef` at all** — the common case, since the
 * key is an optional escape hatch — lost upstream scoping entirely: the #701
 * pre-commit gate stopped refusing byte-identical restages, and the exporter
 * re-wrote every candidate. Measured end to end against real git: a conflict-
 * markered `brain.config.json` with no `memory` key at all turned the gate's
 * `exit=1` into `exit=0`. The window that lands in is the worst one — conflict
 * markers mean you are mid-merge, which is exactly when the dedup gate earns
 * its keep.
 *
 * The `evidence-reader-empty-on-failure` guarantee the first attempt was reaching
 * for is kept by the REPORT, not by the stop: "could not look at the config" is
 * never collapsed to "the config stated nothing". A stated ref that IS readable
 * and does NOT resolve still stops at `stated: true, resolved: false` — that is
 * a different fact (the operator's own ref was honored and failed) and is
 * unchanged.
 *
 * The env level is read FIRST, BEFORE the config, and that order is load-bearing
 * on its own: a broken config must not disable `BRAIN_MEMORY_UPSTREAM_REF`, the
 * escape hatch an operator would reach for to work around it.
 *
 * @param {object} args
 * @param {string} args.root
 * @param {object} [args.env]     Defaults to `process.env`; a plain object in tests.
 * @param {object} [args.config]  Parsed `brain.config.json`. Omitted → read from `root`.
 * @param {typeof spawnSync} [args._spawn]
 * @param {(root: string) => object} [args._loadConfig]  Omitted → `loadBrainConfigAt`.
 * @returns {{ref: string|null, stated: boolean, resolved: boolean, configError?: string}}
 *   `ref` is the ref that was USED, and it is `null` when none was — the last
 *   line returns no name rather than inventing one. It USED to return the string
 *   `'origin/main'` there, and that fabrication is what let the operator be told
 *   "the upstream base was derived as origin/main instead" on a run where
 *   nothing had been derived (cold review round 2 of #701) and then needed a
 *   second field to disambiguate (round 4). `ref == null` IS the discriminator.
 *
 *   A STATED ref that does not resolve is still reported BY NAME with
 *   `resolved: false` — it was honored and it failed, which is a different fact
 *   from "nothing answered", and the operator needs to see which ref they asked
 *   for. So `resolved` is not derivable from `ref` and both are returned.
 *
 *   `configError` is present ONLY when `brain.config.json` could not be read.
 *   It only ever co-occurs with `stated: false` (a throw leaves `cfg` undefined,
 *   so there is no stated ref), which is why `ref == null` reads as "no derived
 *   candidate answered" on every result that carries one.
 */
export function resolveUpstreamRef({
  root,
  env = process.env,
  config,
  _spawn = spawnSync,
  _loadConfig = loadBrainConfigAt,
}) {
  const envRef = env?.BRAIN_MEMORY_UPSTREAM_REF;
  if (envRef) {
    return { ref: envRef, stated: true, resolved: refResolves(envRef, root, _spawn) };
  }

  let cfg;
  let configError;
  try {
    cfg = config ?? _loadConfig(root);
  } catch (err) { /* surfaced: carried as `configError` into the result */
    // `cfg` stays undefined, so `statedRef` below is undefined and the derived
    // candidates take over — carrying the named failure with them.
    configError = err.message;
  }

  const statedRef = cfg?.memory?.upstreamRef;
  if (statedRef) {
    return { ref: statedRef, stated: true, resolved: refResolves(statedRef, root, _spawn) };
  }
  const carry = configError === undefined ? {} : { configError };
  for (const ref of ['origin/HEAD', 'origin/main']) {
    if (refResolves(ref, root, _spawn)) return { ref, stated: false, resolved: true, ...carry };
  }
  // No ref answered, so there is no ref to name. See this function's `@returns`.
  return { ref: null, stated: false, resolved: false, ...carry };
}

/**
 * parseLsTree() — PURE. Parses `git ls-tree -r -z --full-tree <ref> --
 * .memory/records` output: `<mode> SP <type> SP <oid> TAB <path>` entries
 * separated by `\0`.
 *
 * A path whose basename matches `RECORD_NAME_RE` (every in-tree producer's
 * shape, issue #677) contributes its id to `byId` and its full path to
 * `byPath` (the gate, design.md Decision 6, needs the oid keyed by path — the
 * SAME ls-tree result, never a second git call). A path that does not match —
 * a pre-#677 month file, or any unknown shape — is invisible to the id set by
 * construction and is counted into `unnamed` instead (design.md Decision 3's
 * "partial scope" state), never silently dropped.
 *
 * Malformed entries (no tab, no three-token mode/type/oid header) are
 * skipped: `-z`-terminated ls-tree output is a well-formed grammar this
 * function trusts, and a fuzzed/garbage string must not throw.
 *
 * @param {string} text
 * @returns {{byId: Map<string,string>, byPath: Map<string,string>, unnamed: string[]}}
 */
export function parseLsTree(text) {
  const byId = new Map();
  const byPath = new Map();
  const unnamed = [];
  if (typeof text !== 'string' || text.length === 0) return { byId, byPath, unnamed };

  for (const entry of text.split('\0')) {
    if (entry.length === 0) continue;
    const tab = entry.indexOf('\t');
    if (tab === -1) continue; // malformed — not a `<meta>\t<path>` entry
    const meta = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (meta.length !== 3 || !path) continue; // malformed — not `<mode> <type> <oid>`
    const oid = meta[2];
    const basename = path.slice(path.lastIndexOf('/') + 1);
    const m = RECORD_NAME_RE.exec(basename);
    if (m) {
      byId.set(m[1], oid);
      byPath.set(path, oid);
    } else {
      unnamed.push(path);
    }
  }
  return { byId, byPath, unnamed };
}

/**
 * upstreamRecordEntries() — the discriminated result (design.md Decision 3).
 * `ok: false` covers EVERY way the lookup can fail to happen — no git binary,
 * not a git directory, no remote, an unfetched fresh clone, `ls-tree`
 * non-zero — and callers MUST treat it as "could not look", never as "found
 * nothing" (`evidence-reader-empty-on-failure`). The caller's degradation
 * (write everything) is the SAME on `ok:false` and on `ok:true` with an empty
 * `byId` — the distinction exists for the REPORT, not the behaviour.
 *
 * @param {object} args
 * @param {string} args.root
 * @param {object} [args.env]
 * @param {object} [args.config]  Parsed `brain.config.json`. **Deliberately undefaulted**:
 *   omitted → `resolveUpstreamRef` reads it from `root`, and a `= {}` here would be
 *   non-nullish, defeating that read and leaving `memory.upstreamRef` dead in production.
 * @param {string} [args.ref]  #1118: an EXPLICIT ref to read instead of
 *   resolving one via `resolveUpstreamRef()` (env → `memory.upstreamRef` →
 *   `origin/HEAD` → `origin/main`). A caller that already knows the exact
 *   ref it needs — `pull`'s reconciliation needs the SAME ref `git pull`
 *   itself will merge from (`@{u}`), which has nothing to do with
 *   `memory.upstreamRef`'s "what counts as durable" question — passes it
 *   here rather than going through the save()/supersedes resolution this
 *   module otherwise performs. `stated`/`configError` do not apply to an
 *   explicit ref (there is no config read to report on); `reason`, on the
 *   `ok:false` arm, names the ref plainly instead of citing the env/config
 *   escape hatches that had no part in choosing it.
 * @param {typeof spawnSync} [args._spawn]
 * @param {(root: string) => object} [args._loadConfig]  Forwarded to `resolveUpstreamRef`
 *   so the config read is injectable at the layer production actually calls.
 * @returns {{ok:true, ref:string, stated:boolean, byId:Map<string,string>, byPath:Map<string,string>, unnamed:string[], configError?:string}
 *          |{ok:false, ref:string|null, stated:boolean, reason:string, configError?:string}}
 *   `ref` is non-null on the `ok:true` arm by construction (the `ls-tree` below
 *   only runs against a ref that resolved). On `ok:false` it is `null` exactly
 *   when no ref answered — `resolveUpstreamRef`'s discriminator, forwarded, and
 *   the reason no extra "did a ref resolve" field is needed here.
 *
 *   `configError` rides on BOTH arms: an unreadable `brain.config.json` no longer
 *   stops resolution (see `resolveUpstreamRef`), so the lookup can succeed against
 *   a derived ref while the operator still has to be told the config was skipped.
 *   Callers MUST surface it — a fall-through that is not reported is the silent
 *   override the STATED split exists to prevent.
 *
 *   `reason` NAMES THE REF whenever one is involved, because the consumers'
 *   catalog wrappers no longer interpolate it: on a run where nothing resolved
 *   there is no ref to interpolate, and a wrapper that names one anyway is the
 *   round-3 falsehood. It does NOT restate `configError` — it used to prefix it,
 *   which printed the identical sentence to the operator twice, once from the
 *   dedicated `configError` line every consumer already emits and once inside
 *   this one (cold review round 2 of #701).
 */
export function upstreamRecordEntries({
  root,
  env = process.env,
  config,
  ref: explicitRef,
  _spawn = spawnSync,
  _loadConfig = loadBrainConfigAt,
} = {}) {
  let ref, stated, resolved, configError;
  const explicit = explicitRef !== undefined && explicitRef !== null;
  if (explicit) {
    ref = explicitRef;
    stated = true;
    resolved = refResolves(ref, root, _spawn);
  } else {
    ({ ref, stated, resolved, configError } = resolveUpstreamRef({ root, env, config, _spawn, _loadConfig }));
  }
  const carry = configError === undefined ? {} : { configError };
  if (!resolved) {
    // No "— writing every candidate this run (pre-#701 behaviour)" tail. That
    // clause described the EXPORTER's degradation, and `reason` is read by two
    // consumers: `brain:memory:share`, whose own catalog wrapper already says "This
    // run wrote every candidate (the pre-#701 behaviour); nothing was scoped."
    // immediately after — the identical sentence twice, consecutively, in one
    // printed line — and the pre-commit gate, which WRITES NOTHING, so the
    // clause was outright false there and its wrapper contradicted it one clause
    // later: "Nothing was refused; this run could not ask the question."
    // Each consumer states its own degradation; `reason` states the fact.
    const reason = explicit
      ? `the given ref '${ref}' does not resolve`
      : stated
        ? `the stated upstream ref '${ref}' does not resolve (BRAIN_MEMORY_UPSTREAM_REF / memory.upstreamRef)`
        : `no upstream ref resolved (tried origin/HEAD, origin/main)`;
    return { ok: false, ref, stated, reason, ...carry };
  }

  let result;
  try {
    result = _spawn('git', ['ls-tree', '-r', '-z', '--full-tree', ref, '--', '.memory/records'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1e9,
    });
  } catch (err) { /* surfaced: returned as `{ ok: false, reason }` with the ref and the cause */
    return { ok: false, ref, stated, reason: `git ls-tree against '${ref}' threw — ${err.message}`, ...carry };
  }
  if (result?.error) {
    return { ok: false, ref, stated, reason: `git ls-tree against '${ref}' could not run — ${result.error.message}`, ...carry };
  }
  if (typeof result?.status !== 'number' || result.status !== 0) {
    const detail = result?.stderr ? ` — ${String(result.stderr).trim()}` : '';
    return { ok: false, ref, stated, reason: `git ls-tree against '${ref}' exited ${result?.status ?? 'with no status'}${detail}`, ...carry };
  }

  const { byId, byPath, unnamed } = parseLsTree(result.stdout ?? '');
  return { ok: true, ref, stated, byId, byPath, unnamed, ...carry };
}
