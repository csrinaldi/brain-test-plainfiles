#!/usr/bin/env node
// staged-records-check.mjs — the `pre-commit` half of issue #701 (design.md
// Decision 6, proposal.md Decision 4). Refuses a staged `.memory/records/`
// path whose blob is BYTE-IDENTICAL to that path's blob at the upstream base
// — the SAME predicate `dualWriteRecords()` used (`upstream-records.mjs`) until #977 retired it, at
// a second call site, never a separate authorship rule.
//
// Shape follows `vcs/actor-check.mjs`: a PURE evaluator (`evaluateStagedRecords`)
// taking plain data, a thin I/O wrapper (`stagedRecordDiff`), and a CLI
// (`main`/entrypoint). Every case is tested against the evaluator; no test
// spawns git.
//
// `pre-commit`, not `pre-push` (design.md Decision 6). Since #890 `pre-push`
// does not touch `.memory/` at all: it checkpoints feature working memory and
// runs the repository checks, and durable records reach `main` on the memory
// lane (ADR-0034), never on a feature push. The gate was placed here for a
// historical reason that no longer applies but explains the shape: `pre-push`'s
// `.memory/` check was WARN-only by a recorded decision (ADR-0014 §9) because
// its own `share` step churned the manifest, so a hard block there would have
// self-blocked the push it ran on. After the exporter fix (#701 PR 2) `share`
// no longer produced byte-identical records, so the pre-push case was closed by
// the exporter, not by a second gate here.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { upstreamRecordEntries, parseLsTree } from './lib/upstream-records.mjs';
import { t } from '../i18n/t.mjs';

const ZERO_OID = '0'.repeat(40);

/**
 * evaluateStagedRecords() — PURE. `staged` is `parseStagedDiff()`'s shape
 * (`{path, dstOid, status}[]`); `upstream` is `upstreamRecordEntries()`'s
 * discriminated result — the SAME object the exporter reads, never a second
 * lookup for the same fact.
 *
 * Rule (design.md Decision 6):
 *   - `upstream.ok !== true`  → PASS + a note. The gate never blocks on a
 *     question it could not ask — the same degradation direction the
 *     exporter takes on an unavailable upstream.
 *   - `dstOid === ZERO_OID`   → ALLOW. A staged deletion is a different
 *     concern than a byte-identical re-commit.
 *   - `merge.byPath.get(path)` contains `dstOid` → ALLOW (issue #821). THIS MERGE is
 *     carrying that exact blob in at that exact path, so the staged entry is
 *     the merge itself, not a re-commit of it. Refusing here was destructive,
 *     not merely noisy: the printed remedy unstages the path, the merge result
 *     then OMITS the record, and that omission propagates as a DELETION when
 *     the branch merges back — measured in a throwaway repo, the record was
 *     gone from the trunk afterwards.
 *
 *     This does NOT narrow the gate to "not mid-merge". A record re-exported
 *     locally during a merge is absent from `MERGE_HEAD` at that path, so it
 *     still refuses — which is the case `staged-records-check.test.mjs:227`
 *     means when it calls mid-merge the moment this gate earns its keep. The
 *     question is not WHEN, it is WHETHER THIS MERGE INTRODUCED THIS BLOB.
 *   - `dstOid === upstream.byPath.get(path)` → REFUSE. Byte-identity compared
 *     as OID equality — zero blob reads, same content-addressed argument
 *     Decision 1 makes for the exporter.
 *   - anything else (new path, divergent bytes at a known path) → ALLOW.
 *
 * `configError` is a SEPARATE channel from `note`, on purpose. `note` means "the
 * gate could not ask the question, so nothing was judged"; `configError` means
 * "`brain.config.json` could not be read, so a ref stated THERE was not honored".
 * Folding the second into the first would print "nothing was refused" over a
 * genuine refusal.
 *
 * `ref` is forwarded beside `configError` and is `null` when no ref answered —
 * `resolveUpstreamRef` returns no name for a run in which no name was used, so
 * `main()` reads `ref == null` directly and never has to be told separately
 * whether the thing it is about to print is real
 * (`upstream-records.mjs#resolveUpstreamRef`'s `@returns`).
 *
 * @param {object} args
 * @param {Array<{path: string, dstOid: string, status: string}>} args.staged
 * @param {{ok:true, byPath:Map<string,Set<string>>}|{ok:false, absent?:boolean, reason:string}}
 *        [args.merge]  What THIS merge is carrying, per `mergeIntroducedRecords`.
 * @param {{ok:true, byPath:Map<string,string>, ref:string, configError?:string}
 *        |{ok:false, ref:string|null, reason:string, configError?:string}} args.upstream
 * @returns {{level: 'pass'|'fail', offending: string[], note?: string, configError?: string,
 *           ref?: string|null}}
 */
export function evaluateStagedRecords({ staged = [], upstream, merge } = {}) {
  // Carried on BOTH arms: an unreadable config no longer stops the lookup
  // (`upstream-records.mjs`), so it can co-occur with a perfectly good verdict.
  const carry = upstream?.configError === undefined
    ? {}
    : { configError: upstream.configError, ref: upstream.ref ?? null };

  // #821, cold review round 3: a merge lookup that FAILED must be said out
  // loud — the verdict below falls back to the pre-#821 one, and that fallback
  // is a REFUSE carrying a remedy this module's header calls destructive when
  // the blob really is merge-carried. `absent` is the ordinary "no merge in
  // progress" answer and is deliberately silent: it is true on nearly every
  // commit, so reporting it would be noise on all of them. A lookup that could
  // not even find out — `git rev-parse --git-path` failing — is silent too: the
  // message below states a merge IS underway, and saying that without having
  // seen MERGE_HEAD would be one more claim the code does not back.
  const mergeCarry = merge?.ok !== true && merge?.inMerge === true
    ? { mergeError: merge.reason }
    : {};


  if (!upstream || upstream.ok !== true) {
    return {
      level: 'pass',
      offending: [],
      note: upstream?.reason ?? 'upstream lookup unavailable — nothing was checked',
      ...carry,
      ...mergeCarry,
    };
  }

  const offending = [];
  for (const entry of staged) {
    if (!entry?.path || !entry.dstOid) continue;
    if (entry.dstOid === ZERO_OID) continue; // a deletion — allow
    // #821: the merge is carrying this exact blob in — the staged entry IS the merge.
    if (merge?.ok === true && merge.byPath.get(entry.path)?.has(entry.dstOid)) continue;
    if (upstream.byPath.get(entry.path) === entry.dstOid) offending.push(entry.path);
  }
  return { level: offending.length > 0 ? 'fail' : 'pass', offending, ...carry, ...mergeCarry };
}

/**
 * parseStagedDiff() — PURE. Parses `git diff --cached --raw -z --no-abbrev`
 * output: `:<srcmode> <dstmode> <srcoid> <dstoid> <status>` NUL, `<path>` NUL
 * per entry.
 *
 * A rename/copy carries TWO path tokens, and git emits them SOURCE FIRST,
 * DESTINATION SECOND:
 *
 *   :100644 100644 5ce1eb9 5ce1eb9 R100
 *   d/a.txt      <- source
 *   d/b.txt      <- destination, and the only one `dstOid` describes
 *
 * The earlier version took the FIRST token and discarded the second, calling
 * the second "the old path". That is backwards, and it broke the gate in BOTH
 * directions (cold review of #707):
 *
 *   - A byte-identical restage was ALLOWED whenever git paired it as a rename
 *     with a record deletion in the same commit. `byPath` was consulted at the
 *     SOURCE path, which is not the path being written, so no upstream blob
 *     matched and the record sailed through.
 *   - A legitimate `git mv` of a record was REFUSED, and the printed remedy
 *     named the file being DELETED.
 *
 * Rename detection IS on by default in this command form — a `git mv` of a
 * record reports `R100` with no `-M` flag.
 *
 * An earlier version of this comment justified the first case with "two records
 * from one session are highly similar, so the pairing is not exotic". That does
 * not reproduce (measured on real git, cold review of #708): two REAL records
 * from one session are single-line JSON blobs of a few KB sharing almost no
 * content, and git leaves them as `A` + `D` at every threshold tried — default,
 * `-M`, `-M50%`, `-M10%`, `-C`, `diff.renames=copies`.
 *
 * What pairs is BYTE similarity, not record kinship. An exact-blob move (a
 * `git mv`, or the same bytes staged at a second path) reports `R100`. A
 * near-duplicate — the same record re-serialized under a new id — pairs too,
 * but at NO fixed index: measured on this repo's own 2091 records (git 2.51.0,
 * the command form above), 40 size-stratified samples spanned `R090`–`R099`.
 *
 * That range is ONE stratified draw's, and it is stated as such. An earlier version
 * of this paragraph added "and a 60-record uniform random sample spanned
 * `R095`–`R098`". That span DOES NOT REPRODUCE, and it is gone rather than
 * re-measured: five seeded 60-record uniform redraws each reached `R099` and none
 * stopped at `R098`. Their PER-SEED spans are deliberately not stated. Naming a
 * generator and its seeds does not replay a draw without the mapping from draw to
 * record index, and a re-implementation from the version that did name them got
 * different spans for four of the five (cold review round 4 of #701).
 *
 * The conclusion needs no seed, which is why it is the half kept: it follows from
 * the size distribution alone. 231 of this repo's 2091 records are ≥6400 B
 * (11.0%), and every record above ~6.5 KB pairs at `R099`, so a 60-draw missing
 * `R099` entirely is a ~1-in-1100 event ((1 − 231/2091)^60 ≈ 8.9e-4). Write the
 * expression that produces the figure, not one that rounds near it: `0.89^60` is
 * 9.2e-4, a different number, and it stood here for a round under a paragraph whose
 * own closing rule forbids exactly that. The deleted span was a
 * property of one draw written as a property of the population — the same error
 * as the "`R095` even by default" sentence just below, one sample size up. Do not
 * put a number here without naming the draw that produced it, and do not state a
 * per-draw result without the mapping that replays it.
 *
 * The index RISES MONOTONICALLY WITH RECORD SIZE, and that is the whole
 * mechanism: an id swap edits 16 hex characters, so the smaller the blob the
 * larger the share of it that changed. `R090` was the 671-byte minimum; `R099`
 * every record above ~6.5 KB. Do not restate this as one number — an earlier
 * version of this comment said "`R095` even by default", and `R095` turned up in
 * 2 of 40 samples, in a 1.3–1.5 KB band below the 25th percentile of 2121 B.
 *
 * The point survives the spread intact, because it never depended on the value:
 * every one of those indices is a PAIR, and a pair is what makes the token order
 * load-bearing. Those are exactly the identical/near-identical writes this gate
 * exists to judge, which is why reading the DESTINATION is what makes the
 * verdict independent of how git chose to frame them.
 *
 * @param {string} text
 * @returns {Array<{path: string, dstOid: string, status: string}>}
 */
export function parseStagedDiff(text) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;

  const tokens = text.split('\0').filter((tk) => tk.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const header = tokens[i++];
    if (!header.startsWith(':')) continue; // malformed — not a diff-raw header
    const parts = header.slice(1).split(' ');
    if (parts.length < 5) continue;
    const dstOid = parts[3];
    const status = parts[4];
    const first = tokens[i++];
    if (first === undefined) break;
    // R/C: `first` is the SOURCE. The destination is the next token, and it is
    // the one `dstOid` describes.
    const path = /^[RC]/.test(status) ? tokens[i++] : first;
    if (path === undefined) break;
    out.push({ path, dstOid, status });
  }
  return out;
}

/**
 * stagedRecordDiff() — I/O wrapper: `git diff --cached --raw -z --no-abbrev
 * -- .memory/records`, parsed by `parseStagedDiff`. `--no-abbrev` is
 * load-bearing: git's default abbreviated raw-diff oids do not compare equal
 * to `upstream-records.mjs`'s full 40-hex `ls-tree` oids, and a false
 * "divergent" from a truncated oid would be the over-refusal axis M6 guards.
 *
 * @param {object} args
 * @param {string} args.root
 * @param {typeof spawnSync} [args._spawn]
 * @returns {{ok:true, staged: Array<{path:string,dstOid:string,status:string}>}|{ok:false, reason:string}}
 */
export function stagedRecordDiff({ root, _spawn = spawnSync }) {
  let result;
  try {
    result = _spawn('git', ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--', '.memory/records'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1e9,
    });
  } catch (err) { /* surfaced: returned as `{ ok: false, reason }`, which the pre-commit check refuses on */
    return { ok: false, reason: `git diff threw — ${err.message}` };
  }
  if (result?.error) return { ok: false, reason: `git diff could not run — ${result.error.message}` };
  if (typeof result?.status !== 'number' || result.status !== 0) {
    const detail = result?.stderr ? ` — ${String(result.stderr).trim()}` : '';
    return { ok: false, reason: `git diff exited ${result?.status ?? 'with no status'}${detail}` };
  }
  return { ok: true, staged: parseStagedDiff(result.stdout ?? '') };
}

/**
 * mergeIntroducedRecords() — I/O: the records `MERGE_HEAD` holds, so the
 * evaluator can tell a blob THIS MERGE is carrying from a blob re-staged
 * beside it (issue #821).
 *
 * Reuses `parseLsTree` and the exporter's exact command form at a second call
 * site rather than growing a second parser — the same argument the header
 * makes for sharing `upstreamRecordEntries`'s predicate.
 *
 * `MERGE_HEAD` resolves inside a LINKED WORKTREE, which is the normal shape
 * here: worktree-per-issue is the default since #782. Measured in
 * `brain-issue-312` mid-merge before this was written.
 *
 * EVERY parent is read, and the value is a SET of oids per path. An octopus
 * `MERGE_HEAD` holds one sha PER LINE, and an earlier version of this function
 * resolved it with `git rev-parse --verify --quiet MERGE_HEAD` while claiming
 * `--verify` refuses a multi-parent one. That claim was FALSE — measured on git
 * 2.53.0, `--verify --quiet` exits 0 and prints only the FIRST line — so the
 * `ls-tree` saw one parent's tree and a record arriving through any later
 * parent was refused: the very data-loss path this ticket exists to close,
 * reached through a door the first fix did not look at (cold review round 1).
 * There is no plumbing command that prints every line, so the file named by
 * `--git-path MERGE_HEAD` is read directly — the same thing git's own scripts
 * do, and `--git-path` is what makes it correct inside a linked worktree.
 *
 * Every failure — no merge in progress, an unreadable tree — returns
 * `ok:false`, and the evaluator then behaves EXACTLY as it did before #821.
 * That degradation
 * direction is deliberate and is the opposite of the upstream lookup's: an
 * unanswerable question here must not ALLOW a restage, it must leave the
 * previous verdict standing.
 *
 * @param {object} args
 * @param {string} args.root
 * @param {typeof spawnSync} [args._spawn]
 * @param {typeof readFileSync} [args._readFile]
 * @returns {{ok:true, byPath: Map<string,Set<string>>}|{ok:false, reason:string}}
 */
export function mergeIntroducedRecords({ root, _spawn = spawnSync, _readFile = readFileSync }) {
  let pathResult;
  try {
    pathResult = _spawn('git', ['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd: root, encoding: 'utf8' });
  } catch (err) { /* surfaced: returned as `{ ok: false, reason }`, which the pre-commit check refuses on */
    return { ok: false, reason: `git rev-parse --git-path MERGE_HEAD threw — ${err.message}` };
  }
  if (pathResult?.error) return { ok: false, reason: `git rev-parse --git-path could not run — ${pathResult.error.message}` };
  if (typeof pathResult?.status !== 'number' || pathResult.status !== 0) {
    return { ok: false, reason: `git rev-parse --git-path exited ${pathResult?.status ?? 'with no status'}` };
  }

  const mergeHeadPath = String(pathResult.stdout ?? '').trim();
  if (!mergeHeadPath) return { ok: false, reason: 'git named no MERGE_HEAD path' };

  let text;
  try {
    text = _readFile(isAbsolute(mergeHeadPath) ? mergeHeadPath : join(root, mergeHeadPath), 'utf8');
  } catch (err) { /* surfaced: only ENOENT means "no merge"; every other read failure returns `{ ok: false, reason }` */
    // ENOENT is the ordinary answer and the only one that means "no merge".
    // Everything else — EACCES, EIO, a directory where the file should be — is
    // a broken checkout, and saying "no merge in progress" there tells the
    // operator the opposite of what happened. Both arms still fail safe: the
    // verdict is `ok:false` either way, so only the diagnosis differs.
    // ENOENT is the only code that means "no merge". Any other one means the
    // file IS there and could not be read, so a merge IS underway — that is
    // what makes `inMerge` a fact here rather than a guess.
    if (err?.code === 'ENOENT') return { ok: false, absent: true, reason: 'no merge in progress' };
    return { ok: false, inMerge: true, reason: `MERGE_HEAD could not be read — ${err?.code ?? ''} ${err?.message ?? err}`.trim() };
  }

  const parents = String(text).split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l));
  if (parents.length === 0) return { ok: false, inMerge: true, reason: 'MERGE_HEAD named no parent' };

  const byPath = new Map();
  for (const parent of parents) {
    let tree;
    try {
      tree = _spawn('git', ['ls-tree', '-r', '-z', '--full-tree', parent, '--', '.memory/records'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1e9,
      });
    } catch (err) { /* surfaced: returned as `{ ok: false, inMerge: true, reason }`, which the check refuses on */
      return { ok: false, inMerge: true, reason: `git ls-tree against ${parent} threw — ${err.message}` };
    }
    if (tree?.error) return { ok: false, inMerge: true, reason: `git ls-tree against ${parent} could not run — ${tree.error.message}` };
    if (typeof tree?.status !== 'number' || tree.status !== 0) {
      return { ok: false, inMerge: true, reason: `git ls-tree against ${parent} exited ${tree?.status ?? 'with no status'}` };
    }
    for (const [path, oid] of parseLsTree(tree.stdout ?? '').byPath) {
      const oids = byPath.get(path);
      if (oids) oids.add(oid);
      else byPath.set(path, new Set([oid]));
    }
  }

  return { ok: true, byPath };
}

/**
 * runStagedRecordsCheck() — wires the SAME `upstream-records.mjs` lookup the
 * exporter uses (no second `ls-tree` spawn's worth of policy, one shared
 * module) to the staged-side diff, and evaluates. Seam-injectable for tests;
 * production defaults call the real git binary.
 *
 * `config` and `_loadConfig` are pass-throughs, both **undefaulted on purpose**:
 * `upstream-records.mjs` owns the `memory.upstreamRef` key and reads it from
 * `root` when `config` is omitted, and a `config = {}` here is not nullish, so
 * it would defeat that read and leave the config level dead at this call site.
 *
 * @param {object} [opts]
 * @param {string} [opts.root]
 * @param {object} [opts.env]
 * @param {object} [opts.config]  Parsed `brain.config.json`. Omitted → read from `root`.
 * @param {(root: string) => object} [opts._loadConfig]  Forwarded to the upstream lookup.
 * @param {typeof spawnSync} [opts._spawn]
 * @param {typeof upstreamRecordEntries} [opts._upstreamRecordEntries]
 * @param {typeof stagedRecordDiff} [opts._stagedRecordDiff]
 * @param {typeof mergeIntroducedRecords} [opts._mergeIntroducedRecords]
 * @returns {{level:'pass'|'fail', offending:string[], note?:string, configError?:string,
 *           ref?:string|null}}  `evaluateStagedRecords`'s shape, verbatim, EXCEPT on the
 *   `!diff.ok` early return below, which reports only `note` — see its own comment.
 */
export function runStagedRecordsCheck({
  root = process.cwd(),
  env = process.env,
  config,
  _spawn = spawnSync,
  _loadConfig,
  _upstreamRecordEntries = upstreamRecordEntries,
  _stagedRecordDiff = stagedRecordDiff,
  _mergeIntroducedRecords = mergeIntroducedRecords,
} = {}) {
  const upstream = _upstreamRecordEntries({ root, env, config, _spawn, _loadConfig });
  const diff = _stagedRecordDiff({ root, _spawn });
  if (!diff.ok) {
    // Symmetric with the upstream-unavailable branch: a question the gate
    // could not even ASK must never become a block either.
    return { level: 'pass', offending: [], note: `could not read staged .memory/records/ changes — ${diff.reason}` };
  }
  const merge = _mergeIntroducedRecords({ root, _spawn });
  return evaluateStagedRecords({ staged: diff.staged, upstream, merge });
}

/**
 * main() — runs the check, prints the verdict, returns the exit code. Kept
 * separate from `process.exit()` so it stays testable (mirrors
 * `actor-check.mjs#main`/`check-refs.mjs`'s own shape).
 *
 * The refusal message is the LOSSLESS remedy, verbatim (design.md Decision 6
 * "provably lossless" — task 3.4): `git restore --staged` unstages the path
 * (the byte-identical trunk copy is untouched); if that leaves the path
 * untracked (it was never committed here before), the working-tree file is
 * also safe to `rm` — the exact same bytes are already durable upstream.
 * Printed to STDOUT (this is `pre-commit`, run interactively, never piped
 * through a discarding redirect the way `pre-push`/`post-merge` are — no
 * stream-discipline rule applies here, design.md Decision 6's own note).
 *
 * @param {object} [deps]
 * @returns {Promise<0|1>}
 */
export async function main(deps = {}) {
  const result = runStagedRecordsCheck(deps);

  // Printed BEFORE the verdict and independently of it: the operator has to
  // learn the config was skipped whether the gate then passed or refused.
  //
  // TWO keys, chosen on whether there IS a ref: naming a ref the base "was
  // derived as" is only true when one actually resolved, and `result.ref` is
  // `null` when none did. It used to be the string `'origin/main'` even then,
  // so the operator was told a ref answered while the very next line said none
  // had (cold review round 2 of #701).
  if (result.configError) {
    const key = result.ref
      ? 'memory.stagedRecordsCheck.configUnreadable'
      : 'memory.stagedRecordsCheck.configUnreadableNoRef';
    console.log(`staged-records-check: ${await t(key, { error: result.configError, ref: result.ref })}`);
  }

  if (result.mergeError) {
    console.log(`staged-records-check: ${await t('memory.stagedRecordsCheck.mergeUnreadable', { error: result.mergeError })}`);
  }

  if (result.note) {
    console.log(`staged-records-check: ${await t('memory.stagedRecordsCheck.unavailable', { note: result.note })}`);
  }

  if (result.level === 'fail') {
    console.log(`staged-records-check: ${await t('memory.stagedRecordsCheck.refused', { count: result.offending.length })}`);
    for (const path of result.offending) {
      console.log(`  ${path}`);
    }
    console.log(await t('memory.stagedRecordsCheck.remedy', {
      paths: result.offending.join(' '),
    }));
    return 1;
  }

  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
