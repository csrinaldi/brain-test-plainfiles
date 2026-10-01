// format.mjs — the normative durable memory record format (brain/scripts/memory/lib).
//
// Implements the C0 contract fixed in
// openspec/changes/issue-201-memory-format/spec.md (REQ-MF-1..6) and
// openspec/changes/issue-201-memory-format/brain-drafts/memory-format.md.
//
// Pure functions only: no filesystem access, no engram dependency, no child
// processes. The thin I/O layer (append to records/, rebuild index.jsonl) lives
// in ./store.mjs, which calls into this module.
//
// Three code-pins from the C0 contract, enforced here:
//   R1 — index.jsonl: one entry per physical line, sorted by id, deterministic (serializeIndex).
//   R2 — a non-empty `title` is folded into `content` as a bold prefix BEFORE hashing (buildRecord).
//   R3 — absent optional fields (`issue`, `supersedes`, `source`) are OMITTED — never `null` (buildRecord, validateRecord).
//
// READ rules vs WRITE rules — a distinction this module keeps deliberate:
//   validateRecord()          is the READ gate. parseRecordLine() THROWS on it, and
//                             rebuildIndex() reads every physical line, so ONE rejected
//                             line makes a whole store unreadable. `.memory/**` is
//                             consumer-owned (managed-paths.mjs's `local` array), never
//                             touched by a brain upgrade — so brain cannot migrate what a
//                             new read rule would break. New rules do NOT go here.
//   validateWritableRecord()  is the WRITE gate (store.mjs#appendRecord). Refusing a
//                             record brain is about to CREATE breaks nothing that already
//                             exists. New shape rules go here:
//   W1 — `source` MUST be a single, already-trimmed physical line (issue #404): it shares
//        one `**Fuente:**` line with `issue`, so a newline in it spills into the BODY,
//        displacing the issue citation and prepending bytes to the hashed `content`.
//   W2 — `issue`, when present, MUST be a finite integer `number` — the type the schema
//        declares. `issue: "404"` re-imports as the number `404`, a different `id`.
//   W3 — `actor` MUST NOT be branch-shaped (#738): no `/`, and not a bare default branch
//        (`main`/`master`/`develop`/`trunk`). A branch answers WHERE a record was captured
//        from, not WHO captured it — that question belongs in `issue`, not `actor`.
//   W4 — `source`, when it cites `issue #N` (issue #461 "Case 4"), MUST agree with the
//        record's own `issue`: `issue` MUST be present and equal to N. `issue` and `source`
//        share ONE `**Fuente:**` line (provenance.mjs's renderFuente), so a record with no
//        `issue` whose `source` cites one is byte-identical on the wire to a record that DOES
//        declare it — no renderer/parser change can tell them apart, only refusing the write
//        can. #460 ruled the READ-path version of this rule OUT (same reasoning as W1-W3
//        above); this is the WRITE-time variant #460 itself said was "available and safe".

import { createHash } from 'node:crypto';

/** The seven-member `type` enum (REQ-MF-1). */
export const RECORD_TYPES = [
  'decision', 'architecture', 'pattern', 'bugfix', 'config', 'discovery', 'session_summary',
];

const REQUIRED_FIELDS = ['id', 'ts', 'actor', 'actorKind', 'type', 'project', 'content'];
const OPTIONAL_FIELDS = ['issue', 'supersedes', 'source'];

// ISO-8601 UTC only — the `Z` is required (naive/local timestamps are rejected).
const UTC_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// Partial PII heuristic (REQ-MF-5): flags an email-shaped actor. Does not catch
// a bare legal name — full enforcement is the C1b secret-scrubbing hook, not this validator.
const EMAIL_ACTOR_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The actor-shape predicate (#738, design A4) — rehomed here from `audit.mjs`
// so the schema owner holds the rule; `audit.mjs` imports these instead of
// redefining them. `HANDLE_RE` is also the positive requirement
// `capture-provenance.mjs#resolveActor` enforces at the point a handle is
// minted (imported from here, so the two can never drift).
// `.` and `_` are allowed AFTER the first character: GitLab usernames carry them (`jane.doe`),
// and a rule that refuses them leaves those users with no handle they can type (#1163). The class
// stays closed over letters, digits and `._-`: no whitespace, quote, `$`, backtick, `;` or `/`,
// so the value is safe as a `git config` argument and never reads as a branch.
export const HANDLE_RE = /^@[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A bare default-branch name is a branch too: records captured from the main
// checkout carry `actor: "main"` (measured: 2 of them) — no `/` to catch.
// Not exported (MINOR-1, fresh-context review): no consumer outside this
// module reads the set itself, only `classifyActor`'s verdict.
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);

// The same "does this text cite an issue" grammar provenance.mjs's
// `ISSUE_IN_FUENTE_RE`/`issueFromFuente` use for the composed `**Fuente:**`
// line — kept as a local, deliberately NOT imported: format.mjs stays a
// zero-dependency pure schema module (this file's header), and W4 below
// checks the raw `source` field a caller is about to write, not composed §4
// prose. Same pattern, independent module boundary.
const ISSUE_CITED_IN_SOURCE_RE = /issue #(\d+)/;

/**
 * The four actor shapes (#738). `@legacy` is the export fallback; a `/` or a
 * bare default-branch name is a git branch; `@name` is a handle; anything
 * else is "other" and worth a look.
 * @param {unknown} actor
 * @returns {'legacy'|'branch'|'handle'|'other'}
 */
export function classifyActor(actor) {
  if (typeof actor !== 'string' || actor === '') return 'other';
  if (actor === '@legacy') return 'legacy';
  if (actor.includes('/') || DEFAULT_BRANCHES.has(actor)) return 'branch';
  if (HANDLE_RE.test(actor)) return 'handle';
  return 'other';
}

/**
 * canonicalJson() — RFC 8785 (JCS) canonical serialization for this schema's
 * value shapes: strings, finite integers, booleans, null, and plain objects
 * (no floats/NaN/Infinity/Dates are ever fed to this — hashInput is a flat
 * record of those primitive types). Keys are sorted by default JS string
 * comparison, which orders by UTF-16 code unit — the JCS key-order rule.
 * Number serialization delegates to `String(n)`, matching the ECMAScript
 * Number-to-String algorithm JCS mandates. String escaping delegates to
 * `JSON.stringify`, which already implements RFC 8259 control-character/quote/
 * backslash escaping and leaves non-ASCII as raw UTF-8 — consistent with JCS.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonicalJson: non-finite numbers are not supported');
    }
    return String(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported value type '${t}'`);
}

/**
 * computeRecordId() — REQ-MF-2: `id = "rec-" + sha256(canonicalJson(hashInput))[:16]`.
 * `hashInput` is `{ type, actor, actorKind, ts, project, issue?, supersedes?, content }`.
 * `source` is EXCLUDED from the hash (incidental provenance). Absent `issue`/
 * `supersedes` are omitted from `hashInput`, never `null` (R3) — nulling them
 * would canonicalize to different bytes and silently break dedup.
 *
 * @param {{type:string, actor:string, actorKind:string, ts:string, project:string,
 *          content:string, issue?:number, supersedes?:string}} fields
 * @returns {string}
 */
export function computeRecordId({ type, actor, actorKind, ts, project, content, issue, supersedes }) {
  const hashInput = { type, actor, actorKind, ts, project, content };
  if (issue !== undefined && issue !== null) hashInput.issue = issue;
  if (supersedes !== undefined && supersedes !== null) hashInput.supersedes = supersedes;
  const digest = createHash('sha256').update(canonicalJson(hashInput), 'utf8').digest('hex');
  return `rec-${digest.slice(0, 16)}`;
}

/**
 * buildRecord() — construct a normative durable record from source fields.
 *
 * R2: a non-empty `title` is folded into `content` as a bold Markdown prefix
 * (`"**" + title + "**\n\n" + content`) BEFORE the id is hashed, so the folded
 * bytes feed `computeRecordId` identically across machines. An empty/absent
 * `title` leaves `content` unchanged.
 *
 * R3: absent `issue`/`supersedes`/`source` are OMITTED from the returned
 * record — never serialized as `null`.
 *
 * @param {{ts:string, actor:string, actorKind:string, type:string, project:string,
 *          content:string, issue?:number, supersedes?:string, source?:string, title?:string}} fields
 * @returns {object} the record, without validation (call validateRecord() separately)
 */
export function buildRecord({ ts, actor, actorKind, type, project, content, issue, supersedes, source, title }) {
  const foldedContent = title ? `**${title}**\n\n${content}` : content;
  const id = computeRecordId({ type, actor, actorKind, ts, project, content: foldedContent, issue, supersedes });
  const record = { id, ts, actor, actorKind, type, project, content: foldedContent };
  if (issue !== undefined && issue !== null) record.issue = issue;
  if (supersedes !== undefined && supersedes !== null) record.supersedes = supersedes;
  if (source !== undefined && source !== null) record.source = source;
  return record;
}

/**
 * validateRecord() — schema-shape validator (REQ-MF-1, REQ-MF-2 R3, REQ-MF-5 partial).
 * Never throws — returns `{ valid, errors }` so callers choose fail-open vs
 * fail-closed (store.mjs's rebuildIndex() fails closed on this result).
 *
 * @param {unknown} record
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateRecord(record) {
  if (record === null || typeof record !== 'object') {
    return { valid: false, errors: ['record must be an object'] };
  }
  const errors = [];
  for (const f of REQUIRED_FIELDS) {
    if (record[f] === undefined || record[f] === null) errors.push(`missing required field: '${f}'`);
  }
  for (const f of OPTIONAL_FIELDS) {
    if (record[f] === null) errors.push(`optional field '${f}' must be omitted, not null (R3)`);
  }
  if (record.actorKind !== undefined && !['human', 'agent'].includes(record.actorKind)) {
    errors.push(`invalid actorKind: '${record.actorKind}' (must be 'human' or 'agent')`);
  }
  if (record.type !== undefined && !RECORD_TYPES.includes(record.type)) {
    errors.push(`invalid type: '${record.type}' (must be one of ${RECORD_TYPES.join(', ')})`);
  }
  if (typeof record.ts === 'string' && !UTC_TS_RE.test(record.ts)) {
    errors.push(`ts must be ISO-8601 UTC with 'Z': '${record.ts}'`);
  }
  if (typeof record.actor === 'string' && EMAIL_ACTOR_RE.test(record.actor)) {
    errors.push(`actor looks like an email address, not a stable handle: '${record.actor}'`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * validateWritableRecord() — the WRITE gate (see the read/write note in this
 * module's header). Everything validateRecord() checks, PLUS the shape rules
 * that are safe to enforce only on records brain is about to create:
 *
 *   W1 — `source` MUST be one already-trimmed physical line (issue #404).
 *        `issue` and `source` share the single `**Fuente:**` line, so a
 *        newline in `source` pushes its tail into the BODY: the issue citation
 *        falls off the Fuente line and the hashed `content` gains bytes.
 *        `renderFuente()` narrows such a `source` on the read side so an
 *        already-stored record still round-trips; this stops brain writing a
 *        new one.
 *   W2 — `issue`, when present, MUST be a finite integer `number`. The schema
 *        declares `number`; `issue: "404"` is admitted by validateRecord() but
 *        re-imports as the number `404`, which is a different `id`.
 *   W4 — `source`, when it cites `issue #N` (issue #461), MUST agree with the
 *        record's own `issue` (present AND equal to N). Otherwise the two
 *        fields disagree about a fact that shares one rendered line, and the
 *        record fabricates `issue: N` for any reader that recovers it from
 *        `source` alone.
 *
 * These are NOT in validateRecord() on purpose: that runs on the read path via
 * parseRecordLine(), where a rejection turns one bad line into a store-wide
 * failure of `brain:memory:share`, `brain:memory:pull`, `plainfiles.save` and `setup` —
 * in a directory brain does not manage and therefore cannot migrate.
 *
 * Measured vacuous over this repo's store at the time of writing (0/2157
 * multi-line or untrimmed `source`, 0/2157 non-number `issue`) and over every
 * in-tree producer. That is a statement about today, not a guarantee: a
 * consumer store is not covered, which is exactly why these live at write time.
 *
 * @param {unknown} record
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateWritableRecord(record) {
  const { errors } = validateRecord(record);
  const writeErrors = [...errors];
  if (record !== null && typeof record === 'object') {
    if (typeof record.source === 'string' && (/[\n\r]/.test(record.source) || record.source !== record.source.trim())) {
      writeErrors.push(
        `source must be a single, trimmed line — it shares the '**Fuente:**' line with issue (W1): ${JSON.stringify(record.source)}`,
      );
    }
    if (record.issue !== undefined && record.issue !== null && !Number.isInteger(record.issue)) {
      writeErrors.push(`issue must be an integer number, not ${typeof record.issue} ${JSON.stringify(record.issue)} (W2)`);
    }
    // W3 — `actor` must not be branch-shaped: no `/`, and not a bare default
    // branch (`main`/`master`/`develop`/`trunk`). Refuses the SHAPE only,
    // never "not a handle" — a recovered non-handle actor (`other`, e.g.
    // §4-recovered bare names) must still pass this gate; only `resolveActor`
    // (capture-provenance.mjs) enforces the positive handle requirement,
    // at the point a value is minted rather than recovered (#738 [rev #870]).
    if (classifyActor(record.actor) === 'branch') {
      writeErrors.push(
        `actor is branch-shaped: '${record.actor}' — a branch answers WHERE, not WHO (W3, #738); ` +
          `the branch belongs in 'issue'`,
      );
    }
    if (typeof record.source === 'string') {
      const cited = ISSUE_CITED_IN_SOURCE_RE.exec(record.source);
      if (cited) {
        const citedIssue = Number(cited[1]);
        if (record.issue !== citedIssue) {
          const declared = record.issue === undefined || record.issue === null ? 'absent' : JSON.stringify(record.issue);
          writeErrors.push(
            `source cites 'issue #${citedIssue}' but the record's own issue is ${declared} — issue and source ` +
              `share one '**Fuente:**' line, so this fabricates 'issue: ${citedIssue}' for any reader that ` +
              `recovers it from source alone (W4, #461): ${JSON.stringify(record.source)}`,
          );
        }
      }
    }
  }
  return { valid: writeErrors.length === 0, errors: writeErrors };
}

/**
 * serializeRecord() — serialize a record as exactly ONE physical JSONL line.
 * `JSON.stringify` already escapes embedded newlines (`\n`) inside `content`,
 * so this is the one-physical-line invariant (REQ-MF-1) by construction.
 *
 * @param {object} record
 * @returns {string}
 */
export function serializeRecord(record) {
  const line = JSON.stringify(record);
  /* c8 ignore start -- defensive: JSON.stringify always escapes control chars */
  if (/[\n\r]/.test(line)) {
    throw new Error('serializeRecord: result occupies more than one physical line');
  }
  /* c8 ignore stop */
  return line;
}

/**
 * parseRecordLine() — parse + validate one physical JSONL line.
 * Fails closed: THROWS (never silently skips) on invalid JSON or a schema
 * violation, so callers (store.mjs's rebuildIndex) can attach file/line-number
 * context and never treat a corrupt line as an empty result.
 *
 * @param {string} line
 * @returns {object} the parsed, validated record
 * @throws {Error}
 */
export function parseRecordLine(line) {
  let record;
  try {
    record = JSON.parse(line);
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
  const { valid, errors } = validateRecord(record);
  if (!valid) throw new Error(`invalid record: ${errors.join('; ')}`);
  return record;
}

/**
 * buildIndexEntry() — the derived `index.jsonl` projection of one record
 * (REQ-MF-4): `{ id, ts, actor, type, project, issue?, supersedes?, file }`.
 *
 * @param {object} record
 * @param {string} file  the `records/<yyyy-mm>.jsonl` filename the record lives in
 * @returns {object}
 */
export function buildIndexEntry(record, file) {
  const entry = { id: record.id, ts: record.ts, actor: record.actor, type: record.type, project: record.project };
  if (record.issue !== undefined) entry.issue = record.issue;
  if (record.supersedes !== undefined) entry.supersedes = record.supersedes;
  entry.file = file;
  return entry;
}

/**
 * serializeIndex() — R1 (index.jsonl): one entry per physical line, sorted by `id`,
 * deterministic formatting (`JSON.stringify`, stable key insertion order from
 * buildIndexEntry). An empty map serializes to the empty string.
 *
 * @param {Map<string, object>} entriesById
 * @returns {string}
 */
export function serializeIndex(entriesById) {
  const ids = [...entriesById.keys()].sort();
  const lines = ids.map((id) => JSON.stringify(entriesById.get(id)));
  return lines.length ? lines.join('\n') + '\n' : '';
}

/**
 * canonicalOrNull() — canonicalJson() over a value neither caller has fully
 * vetted, so a value canonicalJson cannot express yields `null` instead of
 * throwing. Used by store.mjs's rebuildIndex() and readRecords() (dedup
 * divergence, issue #574) and by the lane planner's C2 tiebreak (issue #887,
 * A6/A7): the comparison is an equality proof, and failing to prove equality
 * must never escalate into refusing the store or the lane.
 *
 * The reachable cases are non-finite numbers (`JSON.parse('1e999')` is
 * `Infinity`, and `validateRecord` does not police fields outside the schema)
 * and nesting deep enough to overflow the recursion. NOT an array value —
 * `canonicalJson` handles arrays; an earlier docblock here said otherwise and
 * was wrong.
 *
 * A null compares as divergent, which is the safe direction: it over-reports a
 * pair it cannot vouch for, instead of claiming two lines/copies agree when
 * nobody checked.
 *
 * Moved here from store.mjs (A7, issue #887): this module has no `fs` import,
 * so it is the correct floor for a rule both a pure planner and an I/O module
 * must share. Kept as the ONE definition — copying it would let the reader and
 * the lane collector disagree about which pairs are divergent, silently.
 *
 * @param {unknown} record
 * @returns {string | null}
 */
export function canonicalOrNull(record) {
  try {
    return canonicalJson(record);
  } catch { /* swallow-ok: canonicalOrNull's contract: a non-canonicalisable record reads as null and the caller routes it to invalid */
    return null;
  }
}

/**
 * nowUtcSeconds() — a seam-injected clock producing the C2a canonical
 * UTC-seconds `ts` (`YYYY-MM-DDTHH:MM:SSZ`) that `UTC_TS_RE` (above) accepts.
 * Strips millisecond precision the same way `engram-export.mjs#toUtcSeconds`
 * does — the ONE canonical rule (REQ-MF-2), never a second stripping regex.
 * Never `new Date().toISOString()` directly: that emits `.mmmZ`, which
 * `validateRecord()` rejects.
 *
 * @param {() => Date} [getNow]  Injectable clock seam — defaults to `new Date()`.
 * @returns {string}
 */
export function nowUtcSeconds(getNow = () => new Date()) {
  return getNow().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
