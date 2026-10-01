// default-branch-records.mjs — reads `.memory/records/*.jsonl` from
// `origin/<default>` through git plumbing, with NO checkout (issue #1024,
// design.md D1/D2/D4).
//
// WHY: since ADR-0034, a memory record reaches `main` on its own lane PR,
// usually AFTER the feature PR opens. `run-check.mjs`'s `defaultReadRecords`
// reads only the PR's checked-out tree, so a scoped record that already
// landed on the default branch (but never rode the feature branch) counted
// as MISSING — forcing a rebase that ADR-0034 exists to remove. This module
// closes that gap by reading the default branch directly, without
// checking it out.
//
// D1 — targeted fetch, CONDITIONAL on the checkout already being shallow
// (incident fix, batch 2): `git fetch --no-tags --depth=1 origin
// +refs/heads/<b>:refs/remotes/origin/<b>` moves ONE commit, works
// identically on GitHub's depth-1 checkout and GitLab's shallow clone, and —
// because it is a LIVE fetch, not a frozen `pull_request` checkout ref — lets
// a manual re-run actually pick up a record that just landed. THIS FETCH
// MUST NEVER RUN ON A FULL (non-shallow) CLONE: `--depth=1` against a full
// history writes `.git/shallow` and GRAFTS the fetched commit as parentless,
// cutting history for every worktree of that repository — measured in
// production (a full `brain-issue-1024` checkout was shallowed by an
// unguarded test reaching this reader with the real cwd, orphaning history
// until manually repaired). The reader therefore checks `git rev-parse
// --is-shallow-repository` FIRST: only `true` (a CI shallow checkout, or a
// consumer's shallow local clone) runs the targeted fetch; `false` (a full
// clone — every developer machine, and this repo's own worktrees) never
// fetches at all, and reads whatever `refs/remotes/origin/<b>` ALREADY holds
// — which a full `git clone` already populates for every branch, not only
// the checked-out one, so no fetch is needed there in the first place. If
// that ref does not exist (never fetched, or a bare/partial clone), the
// `ls-tree` step fails and surfaces the existing "git ls-tree failed" cause —
// no new cause string is needed for this branch.
//
// D2 — plumbing without a checkout: `git ls-tree -r -z --name-only <ref> --
// .memory/records/` lists the files; ONE `git cat-file --batch` reads them
// all (stdin lines `<ref>:<path>`), never one process per file (this repo
// holds hundreds of per-record files, issue #677). The batch output is
// parsed by BYTE SIZE (the header's `<size>` field), never by splitting on
// newlines — a record's JSON content can itself contain embedded newlines,
// and line-splitting would silently truncate it.
//
// D4 — dedupe by `id`, first wins, PR tree first (`unionRecordsById`) and
// the JSONL-parsing/dedupe rule within one source (`dedupeJsonlRecords`) is
// a PINNED COPY of `store.mjs#readRecords`'s own rule
// (`../memory/lib/store.mjs:339-343`, `:374-383`) — never a refactor of
// `store.mjs` itself, which is the memory core and stays untouched. A parity
// test (`default-branch-records.test.mjs`) pins the copy against
// `readRecords` on an identical fixture.
//
// Never throws: every git-plumbing failure is caught and returned as
// `{ records: [], error: '<cause>' }` — the caller (`run-check.mjs`)
// decides the fail-closed/fail-open shape from that cause (D5). An absent
// `.memory/records/` on the default branch is a genuinely EMPTY listing,
// never a failure (`error: null`).

import { execFileSync } from 'node:child_process';

const RECORDS_PATH = '.memory/records/';

// Batch 4 (#1024 live-CI bug, PR #1048): `execFileSync`'s default `maxBuffer`
// is 1 MiB. `git ls-tree`'s listing and `git cat-file --batch`'s blob stream
// (D2's ONE-call design) both need to hold the WHOLE default branch's
// `.memory/records/` in memory at once — this repo's own real `origin/main`
// already measures 8,967,273 bytes, well past 1 MiB, and a production
// consumer's history only grows. 512 MiB is a generous, cheap FIXED cap —
// comfortably ahead of years of this project's own growth — chosen over a
// computed size (a second `git ls-tree -r -l` round trip to sum blob sizes
// plus per-object header overhead) because the cost difference is
// negligible at this scale and a fixed cap needs no extra git call to fail
// closed if it is ever wrong.
const MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Default git runner: real `execFileSync('git', args, opts)`, returning a
 * raw `Buffer` (no `encoding` option) so byte-size-based batch parsing stays
 * correct regardless of multi-byte content. Injectable in tests — no
 * production caller passes its own `git` dep. `maxBuffer` defaults to
 * `MAX_BUFFER` (Batch 4) — a caller-supplied `opts.maxBuffer` still wins,
 * since it is spread after the default.
 *
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, maxBuffer?: number}} [opts]
 * @returns {Buffer}
 */
function defaultGit(args, opts = {}) {
  return execFileSync('git', args, { maxBuffer: MAX_BUFFER, ...opts });
}

/**
 * Extracts the first non-empty line of a thrown git error's stderr (or its
 * message, if stderr is unavailable) — the exact cause text the Output
 * contract table names verbatim ("git fetch origin <b> failed: <first
 * stderr line>").
 *
 * Batch 4 (#1024 live-CI bug): `stderr` can be a REAL, present Buffer that is
 * simply EMPTY — measured on `execFileSync`'s own ENOBUFS (the child is
 * killed before any stderr is captured) — which used to fall through to a
 * bare, silent "failed: " with nothing after the colon. When no non-empty
 * stderr line exists, this now falls back to the thrown error's own
 * `code`/`message` (e.g. `code: 'ENOBUFS'`, `message: 'spawnSync git
 * ENOBUFS'`), so the cause is never silently empty.
 *
 * @param {unknown} err
 * @returns {string}
 */
function firstStderrLine(err) {
  const stderr = err && typeof err === 'object' ? /** @type {any} */ (err).stderr : undefined;
  const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : typeof stderr === 'string' ? stderr : '';
  const line = stderrText.split('\n').find((l) => l.trim() !== '');
  if (line) return line;

  const code = err && typeof err === 'object' ? /** @type {any} */ (err).code : undefined;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
  if (message) return code && !message.includes(String(code)) ? `${code}: ${message}` : message;
  if (code) return String(code);
  return 'unknown error (no stderr, no code, no message)';
}

/**
 * Parses `git cat-file --batch`'s output for `count` requested objects, in
 * request order. Byte-size-based (D2): each entry is either
 * `null` (the object was `missing`) or the blob's content as a utf8 string,
 * read by the header's declared `<size>` byte count — safe against embedded
 * newlines inside the content itself.
 *
 * @param {Buffer} buf
 * @param {number} count
 * @returns {Array<string|null>}
 */
function parseCatFileBatch(buf, count) {
  const results = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl === -1) throw new Error('truncated batch output — no header newline found');
    const header = buf.slice(offset, nl).toString('utf8');
    offset = nl + 1;
    if (/ missing$/.test(header)) {
      results.push(null);
      continue;
    }
    const m = header.match(/^[0-9a-f]{40,64} \S+ (\d+)$/);
    if (!m) throw new Error(`unparseable batch header "${header}"`);
    const size = Number(m[1]);
    const content = buf.slice(offset, offset + size).toString('utf8');
    offset += size + 1; // skip the single trailing newline git appends after content
    results.push(content);
  }
  return results;
}

/**
 * Parses one JSONL blob's physical lines into record objects. A corrupt
 * (non-JSON) line is skipped — never fails closed here (this is a gate
 * READER, mirroring `store.mjs#readRecords`'s own best-effort contract).
 *
 * @param {string} content
 * @returns {object[]}
 */
function parseJsonlBlob(content) {
  const records = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue; // corrupt line skipped
    }
  }
  return records;
}

/**
 * dedupeJsonlRecords() — the PINNED COPY of `store.mjs#readRecords`'s
 * parse/dedupe rule (D4): given a LIST of `{ filename, content }` blobs
 * already in sorted-filename order, dedupe by `id` FIRST WINS (earliest
 * file, earliest line), and pass id-less records through unchanged. A
 * parity test asserts this produces the identical record list `store.mjs`'s
 * `readRecordObservations` produces for the same fixture written to a real
 * directory.
 *
 * @param {Array<{filename: string, content: string}>} blobs sorted by filename
 * @returns {object[]}
 */
export function dedupeJsonlRecords(blobs) {
  const records = [];
  const seen = new Set();
  for (const { content } of blobs) {
    for (const record of parseJsonlBlob(content)) {
      const id = record && typeof record.id === 'string' ? record.id : undefined;
      if (id === undefined) {
        records.push(record);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      records.push(record);
    }
  }
  return records;
}

/**
 * unionRecordsById() — the scoped-evidence union (REQ-L3-4): the PR tree's
 * records first, then the default branch's, deduped by `id` with the PR
 * tree WINNING on a collision (D4 — "first wins, PR tree first"). Records
 * without an `id` pass through from BOTH sources unchanged/uncollapsed.
 *
 * @param {object[]} prRecords
 * @param {object[]} defaultBranchRecords
 * @returns {object[]}
 */
export function unionRecordsById(prRecords, defaultBranchRecords) {
  const result = [];
  const seen = new Set();
  for (const source of [prRecords, defaultBranchRecords]) {
    for (const record of Array.isArray(source) ? source : []) {
      const id = record && typeof record.id === 'string' ? record.id : undefined;
      if (id === undefined) {
        result.push(record);
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(record);
    }
  }
  return result;
}

/**
 * Determines whether `cwd` is a shallow checkout via `git rev-parse
 * --is-shallow-repository` (incident fix, batch 2). The targeted `--depth=1`
 * fetch is safe ONLY on an already-shallow checkout (CI); running it against
 * a full clone writes `.git/shallow` and grafts history. Defensive default:
 * an unreadable/throwing probe returns `false` (never fetch) — the SAFE
 * direction, since the cost of skipping a fetch is a possible "unreadable"
 * result, while the cost of a wrongful fetch is corrupted repository history.
 *
 * @param {(args: string[], opts?: object) => Buffer} git
 * @param {string} cwd
 * @returns {boolean}
 */
function isShallowRepository(git, cwd) {
  try {
    const out = git(['rev-parse', '--is-shallow-repository'], { cwd });
    const text = Buffer.isBuffer(out) ? out.toString('utf8') : String(out);
    return text.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * readDefaultBranchRecords() — the reader (D1/D2). CONDITIONALLY fetches
 * `origin/<b>` (targeted, depth 1) — ONLY when `cwd` is already a shallow
 * checkout (`isShallowRepository`); a full clone never fetches and reads
 * whatever `refs/remotes/origin/<b>` already holds (incident fix, batch 2 —
 * see the module header). Lists `.memory/records/*.jsonl` on that ref via
 * `ls-tree`, and reads every blob in ONE `cat-file --batch` call. Never
 * throws: every failure mode returns `{ records: [], error: '<cause>' }`
 * with the Output contract's verbatim cause text. An empty listing (no
 * `.memory/records/` on the default branch) is `{ records: [], error: null }`
 * — readable and empty, not a failure.
 *
 * @param {{defaultBranch?: string|null, cwd?: string, git?: (args: string[], opts?: object) => Buffer}} [opts]
 * @returns {{records: object[], error: string|null, fetched: boolean}}
 *   `fetched` (Batch 3, visibility): `true` when a live fetch actually ran
 *   (a shallow checkout); `false` when the read came from whatever
 *   `refs/remotes/origin/<b>` already held locally (a full clone, never
 *   fetched here) — so a caller/reader can tell "fresh" evidence from a
 *   possibly-STALE local ref rather than treating both identically.
 */
export function readDefaultBranchRecords({ defaultBranch, cwd = process.cwd(), git = defaultGit } = {}) {
  if (!defaultBranch) {
    return { records: [], error: 'DEFAULT_BRANCH not mapped', fetched: false };
  }

  const ref = `refs/remotes/origin/${defaultBranch}`;
  const shallow = isShallowRepository(git, cwd);

  if (shallow) {
    try {
      git(['fetch', '--no-tags', '--depth=1', 'origin', `+refs/heads/${defaultBranch}:${ref}`], { cwd });
    } catch (err) {
      return { records: [], error: `git fetch origin ${defaultBranch} failed: ${firstStderrLine(err)}`, fetched: false };
    }
  }
  // else: a full (non-shallow) clone — NEVER fetch here (incident fix). A
  // full `git clone` already populates every remote-tracking ref, including
  // ones never checked out, so `ref` already holds the right content; if it
  // does not exist at all, the `ls-tree` call below fails and surfaces the
  // existing "git ls-tree failed" cause — correct, and no new cause is needed.

  let listingBuf;
  try {
    listingBuf = git(['ls-tree', '-r', '-z', '--name-only', ref, '--', RECORDS_PATH], { cwd });
  } catch (err) {
    return { records: [], error: `git ls-tree failed: ${firstStderrLine(err)}`, fetched: shallow };
  }
  const paths = listingBuf
    .toString('utf8')
    .split('\0')
    .map((p) => p.trim())
    .filter(Boolean)
    .sort();

  if (paths.length === 0) return { records: [], error: null, fetched: shallow };

  const refs = paths.map((p) => `${ref}:${p}`);
  const input = refs.join('\n') + '\n';

  let batchBuf;
  try {
    batchBuf = git(['cat-file', '--batch'], { cwd, input });
  } catch (err) {
    return { records: [], error: `git cat-file failed: ${firstStderrLine(err)}`, fetched: shallow };
  }

  let contents;
  try {
    contents = parseCatFileBatch(batchBuf, refs.length);
  } catch (err) {
    return { records: [], error: `git cat-file failed: ${err.message}`, fetched: shallow };
  }

  const blobs = paths
    .map((filename, i) => ({ filename, content: contents[i] }))
    .filter((b) => b.content !== null);

  return { records: dedupeJsonlRecords(blobs), error: null, fetched: shallow };
}
