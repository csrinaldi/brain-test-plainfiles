// change-route.mjs — GET /api/change/{issue}: the drawer's IO (#881, PR 3 /
// B1, D8/D11-D14). Composes the six pure `ui/lib/**` shapers this slice
// already shipped; THIS module is the one place in the pair that touches the
// filesystem and spawns `git` — every read goes through an injected
// `_read`/`_run`, so a test never needs a real working tree.
//
// R881-8's four tabs, each `{ok, value|reason}`, every leaf inside `value`
// carrying `source: {path[, line]} | {url}}` (D11, A3):
//
//   spec           spec.md -> requirement/scenario cards           (spec-cards.mjs)
//   tasks          tasks.md -> checklist, `git blame HEAD` attached (tasks-list.mjs + blame.mjs)
//   workingMemory  the object store's committed resume.md, ruling 3 (resume-view.mjs)
//   reviews        the snapshot's review rows, sourced to the PR    (D14)
//
// Committed tier only (R881-3, R881-8, R881-10, #1198): every artifact is read
// from the object store, never from a working tree. `readDocuments` resolves
// HEAD once, lists the six stage artifacts with one `ls-tree`, and reads each
// present blob with `cat-file`; `resume.md` is read at the change branch's
// tip. `spec.md` and `tasks.md` are read ONCE, and the spec cards and the
// tasks checklist are derived from that same string (AC7). Everything runs
// `git` on the served root's OWN git dir via a plain `execFileSync`/injected
// `_run` — never `git -C <worktree>`. `HEAD` is mandatory in the blame argv
// for the same reason: the committed version, never the index or the copy.

import { execFileSync } from 'node:child_process';

import { parseSpecCards } from './lib/spec-cards.mjs';
import { parseTasksList } from './lib/tasks-list.mjs';
import { parseBlame } from './lib/blame.mjs';
import { shapeResumeView } from './lib/resume-view.mjs';
import { parseFrontmatter } from '../memory/lib/resume-frontmatter.mjs';
import { LIFECYCLE_STAGES, ARTEFACT_FILE } from '../lib/sdd-layout.mjs';
import { prUrl } from './lib/forge-url.mjs';
import { documentWording } from './lib/drawer-model.mjs';

/** D14's caveat, verbatim in the UI, until #880 lands `type: review` records. */
export const REVIEWS_SOURCE_NOTE = 'forge comments until #880 lands';

/** The path a "no change dir" reason names — a glob, not a file, since none exists to point at. */
function expectedChangeDirGlob(issue) {
  return `openspec/changes/issue-${issue}-*`;
}

/** `snapshot.changes`'s row for this issue, or `null` — never guesses a dir that was not in the read model. */
function findChangeDir(snapshot, issue) {
  if (!snapshot?.changes?.ok) return null;
  return snapshot.changes.value.find((c) => c.issue === issue)?.dir ?? null;
}

function noChangeDirTab(issue) {
  const path = expectedChangeDirGlob(issue);
  return { ok: false, reason: `no change dir at ${path}`, source: { path } };
}

/** The tab's own said reason for a document that is not a readable text, or `null` when it is. */
function documentFailure(doc, head) {
  if (!doc) return null;
  if (doc.state === 'missing') return `${doc.path} is not committed at HEAD (${String(head ?? '').slice(0, 12)})`;
  if (doc.state === 'unreadable') return `${doc.path} could not be read at HEAD: ${doc.reason}`;
  return null;
}

/** A truncated document still feeds its tab; the tab says the cards or items cover only the read part. */
function truncationNote(doc, what) {
  return doc.state === 'truncated' ? `truncated at ${DOCUMENT_CAP} bytes; ${what} cover the read part` : null;
}

function buildSpecTab({ documents, head, dir, issue }) {
  if (!dir) return noChangeDirTab(issue);
  const doc = documents.spec;
  const failure = documentFailure(doc, head);
  if (failure) return { ok: false, reason: failure, source: { path: doc.path } };
  const parsed = parseSpecCards({ text: doc.text, path: doc.path });
  const note = truncationNote(doc, 'cards');
  return parsed.ok && note ? { ...parsed, note } : parsed;
}

/**
 * `tasks-list.mjs` already never drops a line for missing attribution (it
 * renders `actor: 'unknown'`) — this wraps EVERY item with its own
 * `attribution` leaf so a blame failure is SAID per row (source-guard's
 * "never empty-on-failure"), not silently folded into "unknown", while the
 * checklist itself still renders in full either way.
 */
function attachAttribution(items, blame) {
  return items.map((item) => ({
    ...item,
    attribution: blame.ok
      ? { ok: true, value: { actor: item.actor, ts: item.ts } }
      : { ok: false, reason: blame.reason },
  }));
}

function buildTasksTab({ documents, head, run, dir, issue }) {
  if (!dir) return noChangeDirTab(issue);
  const doc = documents.tasks;
  const failure = documentFailure(doc, head);
  if (failure) return { ok: false, reason: failure, source: { path: doc.path } };
  const path = doc.path;

  let blame;
  try {
    // Committed version only — `HEAD` is mandatory (R881-3): never the
    // working tree, never the index.
    const blameText = run('git', ['blame', '--porcelain', 'HEAD', '--', path]);
    blame = parseBlame({ text: blameText });
  } catch (err) {
    blame = { ok: false, reason: err?.message ?? String(err) };
  }

  const attribution = blame.ok
    ? Object.entries(blame.value).map(([line, a]) => ({ line: Number(line), actor: a.author ?? 'unknown', ts: a.authorTime ?? null }))
    : [];

  const parsed = parseTasksList({ text: doc.text, path, attribution });
  if (!parsed.ok) return parsed;
  const note = truncationNote(doc, 'items');
  return { ok: true, value: attachAttribution(parsed.value, blame), ...(note ? { note } : {}) };
}

/**
 * D12's branch resolution, in order: the issue's open PR headBranch, else the
 * single `feat/issue-<N>-*` branch in this clone — never picking among more
 * than one.
 */
function resolveBranch({ run, snapshot, issue }) {
  const prMatch = snapshot?.prs?.ok ? snapshot.prs.value.find((p) => p.issue === issue) : null;
  if (prMatch?.headBranch) return { ok: true, branch: prMatch.headBranch };

  let listed;
  try {
    listed = run('git', ['branch', '--list', `feat/issue-${issue}-*`]);
  } catch (err) {
    return { ok: false, reason: `git branch --list failed: ${err?.message ?? err}` };
  }
  const names = listed.split(/\r?\n/).map((l) => l.replace(/^\*?\s+/, '').trim()).filter(Boolean);
  if (names.length === 0) return { ok: false, reason: `no open PR and no feat/issue-${issue}-* branch in this clone` };
  if (names.length > 1) return { ok: false, reason: `more than one feat/issue-${issue}-* branch in this clone: ${names.join(', ')}` };
  return { ok: true, branch: names[0] };
}

function buildWorkingMemoryTab({ resolved, resume }) {
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { branch } = resolved;
  // Derived from the one resume document so this tab and the SDD row cannot disagree.
  if (resume.state === 'unreadable') return { ok: false, reason: documentWording(resume) };
  if (resume.state !== 'present' && resume.state !== 'truncated') {
    return { ok: false, reason: `no committed resume.md on ${branch}; the local overlay arrives in slice 5 (#883)` };
  }
  const { frontmatter } = parseFrontmatter(resume.text);
  return { ok: true, value: shapeResumeView({ frontmatter, branch }) };
}

// Delegates to `lib/forge-url.mjs`'s `prUrl` (#882 cold review of PR 1,
// blocker fix): ONE definition of this shape, not a second copy that can
// drift from the one `roadmap-model.mjs` (and every later governance view)
// now shares.
function buildPrUrl(project, pr) {
  return prUrl(project, pr);
}

/** D14: every round, oldest first (already the order `reviewRows` builds), sourced to the PR — no per-round anchor exists in this repo's provider today (github.mjs:564 drops it). */
function buildReviewsTab({ snapshot, project, issue }) {
  if (!snapshot?.prs?.ok) return { ok: false, reason: 'the PR list could not be read', sourceNote: REVIEWS_SOURCE_NOTE };
  if (!snapshot?.reviews?.ok) return { ok: false, reason: 'the reviews list could not be read', sourceNote: REVIEWS_SOURCE_NOTE };

  const prNumbers = new Set(snapshot.prs.value.filter((p) => p.issue === issue).map((p) => p.number));
  const rounds = [];
  // A per-PR row can be `{pr, ok:false, reason}` (reviewRows fails per PR while
  // the list resolves). It is SAID here, never skipped: skipping read as "no
  // rounds ever posted" (evidence-reader-empty-on-failure.md, R881-9).
  const unreadable = [];
  for (const row of snapshot.reviews.value) {
    if (!prNumbers.has(row.pr)) continue;
    if (!row.ok) { unreadable.push({ pr: row.pr, ok: false, reason: row.reason, source: { url: buildPrUrl(project, row.pr) } }); continue; }
    for (const verdict of row.verdicts) {
      rounds.push({ ...verdict, source: { url: verdict.commentUrl ?? buildPrUrl(project, row.pr) } });
    }
  }
  if (rounds.length === 0 && unreadable.length > 0) {
    return { ok: false, reason: `every review thread of this issue is unreadable: ${unreadable.map((u) => `#${u.pr} (${u.reason})`).join(', ')}`, unreadable, sourceNote: REVIEWS_SOURCE_NOTE };
  }
  return { ok: true, value: rounds, unreadable, sourceNote: REVIEWS_SOURCE_NOTE };
}

// The seven raw artefact-presence keys `status/snapshot.mjs`'s
// `readArtefactPresence` always computes (R998-4) — `LIFECYCLE_STAGES` is
// sdd-layout.mjs's own canonical four (issue #456); this file is server-side
// only (no D9 constraint), so it imports that instead of declaring a rival
// literal, then names the three stages the door's own artefact map adds.
const SDD_STAGES = [...LIFECYCLE_STAGES, 'apply', 'verify', 'archive'];

/**
 * The file each stage IS. The four canonical names come from `sdd-layout.mjs`
 * rather than being retyped — that module refuses a change that declares a
 * different file for a lifecycle stage, so a second literal here could
 * silently disagree with the rule the repository actually enforces. The three
 * the door adds are named here because `sdd-layout.mjs` does not own them.
 *
 * #1059: the tab used to stamp all seven rows with the change DIRECTORY, so it
 * reported a stage present without ever naming the file that made it present
 * and every row's provenance pointed at the same place. A stage is a file.
 */
const STAGE_FILE = Object.freeze({
  ...Object.fromEntries(LIFECYCLE_STAGES.map((stage) => [stage, ARTEFACT_FILE[stage]])),
  apply: 'apply-progress.md',
  verify: 'verify-report.md',
  archive: 'archive-report.md',
});

// ── #1198: the seven documents, read from the object store ─────────────────

/** A document is cut here; the note says so and there is no "load full" (R3). */
export const DOCUMENT_CAP = 262144;
/** Above this a blob is not read at all: it is said unreadable with its size. */
export const DOCUMENT_READ_LIMIT = 8 * 1024 * 1024;
/** Headroom over a blob's size so `execFileSync`'s 1 MiB default never turns a 2 MB document into ENOBUFS. */
const READ_HEADROOM = 4096;

/** The six documents read at HEAD, keyed by their stage name. `archive` is a stage, not a document. */
const HEAD_DOCUMENT_KEYS = SDD_STAGES.filter((stage) => stage !== 'archive');

const errReason = (err) => String(err?.message ?? err).trim();

function documentEntry(path, ref, fields) {
  return { path, ref, commit: null, state: 'missing', text: null, bytes: null, truncated: false, truncatedAt: null, reason: null, note: null, ...fields };
}

/** `ls-tree -l -z` output to `{path: {mode, type, sha, size}}`. A tree's size is `-`. */
function parseTreeListing(out) {
  const entries = new Map();
  for (const record of String(out ?? '').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, sha, size] = record.slice(0, tab).trim().split(/\s+/);
    entries.set(record.slice(tab + 1), { mode, type, sha, size: size === '-' ? null : Number(size) });
  }
  return entries;
}

/** Cut at the cap on a UTF-8 boundary: back up while the first dropped byte is a continuation byte. */
function capText(text) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= DOCUMENT_CAP) return { text, truncated: false, truncatedAt: null };
  let end = DOCUMENT_CAP;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true, truncatedAt: end };
}

/**
 * One document from its tree entry: missing (no entry), unreadable (not a
 * regular blob, over the read limit, or the read failed), present, or
 * truncated. `read(maxBuffer)` performs the content read for this entry.
 */
function documentFromEntry({ path, ref, commit, entry, read }) {
  if (!entry) return documentEntry(path, ref, { state: 'missing' });
  const refuse = (reason) => documentEntry(path, ref, { state: 'unreadable', reason, bytes: entry.size });
  if (entry.type !== 'blob') return refuse(`${path} is a ${entry.type}, not a file`);
  if (entry.mode === '120000') return refuse(`${path} is a symlink`);
  if (entry.size > DOCUMENT_READ_LIMIT) return refuse(`${entry.size} bytes exceeds the read limit of ${DOCUMENT_READ_LIMIT}`);
  let text;
  try {
    text = String(read(entry.size + READ_HEADROOM) ?? '');
  } catch (err) {
    return refuse(errReason(err));
  }
  const cut = capText(text);
  return documentEntry(path, ref, {
    commit, state: cut.truncated ? 'truncated' : 'present', text: cut.text, bytes: entry.size, truncated: cut.truncated, truncatedAt: cut.truncatedAt,
    note: cut.truncated ? `truncated at ${DOCUMENT_CAP} bytes` : null,
  });
}

/**
 * The six stage documents at HEAD: `rev-parse` once, one `ls-tree` for all six
 * paths (literal pathspecs, so a `*` in a directory name is never globbed),
 * then one `cat-file blob` per present document. A failure of the first two
 * says every document unreadable with that reason, never an empty list.
 * @returns {{head: string|null, documents: Record<string, object|null>}}
 */
function readHeadDocuments({ run, dir }) {
  if (!dir) return { head: null, documents: Object.fromEntries(HEAD_DOCUMENT_KEYS.map((k) => [k, null])) };
  const paths = HEAD_DOCUMENT_KEYS.map((k) => `${dir}/${STAGE_FILE[k]}`);
  let head;
  let tree;
  try {
    head = String(run('git', ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    tree = parseTreeListing(run('git', ['--literal-pathspecs', 'ls-tree', '-l', '-z', head, '--', ...paths]));
  } catch (err) {
    const reason = errReason(err);
    return { head: null, documents: Object.fromEntries(HEAD_DOCUMENT_KEYS.map((k, i) => [k, documentEntry(paths[i], 'HEAD', { state: 'unreadable', reason })])) };
  }
  const documents = {};
  HEAD_DOCUMENT_KEYS.forEach((key, i) => {
    const entry = tree.get(paths[i]);
    documents[key] = documentFromEntry({
      path: paths[i], ref: 'HEAD', commit: head, entry,
      read: (maxBuffer) => run('git', ['cat-file', 'blob', entry.sha], { maxBuffer }),
    });
  });
  return { head, documents };
}

/**
 * `resume.md` at the change branch's tip. The branch is resolved to a commit
 * ONCE; the tree is listed at that commit and the blob read by its sha, so the
 * stamp names the commit the text came from even if the branch advances
 * meanwhile. `ls-tree` tells "no such file" from "could not read" without
 * parsing stderr, which the `run` seam discards.
 */
function readResumeDocument({ run, resolved }) {
  const path = 'resume.md';
  if (!resolved.ok) return documentEntry(path, null, { state: 'unreadable', reason: resolved.reason });
  const { branch } = resolved;
  try {
    const commit = String(run('git', ['rev-parse', '--verify', `${branch}^{commit}`])).trim();
    const tree = parseTreeListing(run('git', ['--literal-pathspecs', 'ls-tree', '-l', '-z', commit, '--', path]));
    const entry = tree.get(path);
    return documentFromEntry({ path, ref: branch, commit, entry, read: (maxBuffer) => run('git', ['cat-file', 'blob', entry.sha], { maxBuffer }) });
  } catch (err) {
    return documentEntry(path, branch, { state: 'unreadable', reason: errReason(err) });
  }
}

/**
 * The door's own sdd tab (#998 R998-6, design.md's "TAB_IDS grows sdd and
 * records"): the seven stage artefacts' RAW presence for this issue's own
 * row (`snapshot.changes`'s `artefacts{}` map, R998-4) — sourced to the
 * change dir. This deliberately does not re-derive `lib/sdd-model.mjs`'s
 * `STAGE_VOCAB` word/mark: that derivation is the SDD MODE's own concern
 * (every change, at once); a single row's own tab draws the raw fact.
 */
/** The declared slice plan of one change, or its own said reason. */
function sliceTab(row, dir) {
  const scopes = row.sliceScopes;
  if (!scopes || typeof scopes !== 'object') return { ok: false, reason: 'no slice plan is declared in this change\'s tasks.md' };
  if (scopes.ok !== true) return { ok: false, reason: scopes.reason };
  const value = scopes.value ?? [];
  if (value.length === 0) return { ok: false, reason: 'no slice plan is declared in this change\'s tasks.md' };
  return {
    ok: true,
    note: 'declared in tasks.md — what each PR did with its slice is not read',
    value: value.map((slice) => ({
      slice: slice.slice,
      claims: [...(slice.claims ?? [])],
      terminalPr: slice.terminal_pr ?? null,
      source: { path: dir },
    })),
  };
}

function buildSddTab({ snapshot, issue, dir }) {
  // `dir` is `findChangeDir(snapshot, issue)` — the SAME `snapshot.changes
  // .value.find(c => c.issue === issue)` predicate this function would
  // otherwise re-run, over the same (already-checked-ok) `snapshot.changes`
  // section. `!dir` already covers "the changes section could not be read"
  // and "no row for this issue" — `readChanges` never yields a row without
  // a `dir`, so a second, differently-worded reason for the same cause
  // would only ever be a dead branch (found by cold review of #1008/PR6:
  // the row-lookup branch below was unreachable — `noChangeDirTab` always
  // fired first). One reason, said once, shared with the spec/tasks tabs.
  if (!dir) return noChangeDirTab(issue);
  const row = snapshot.changes.value.find((c) => c.issue === issue);
  const artefacts = row.artefacts ?? {};
  return {
    ok: true,
    // A MISSING stage still names its file: "design is missing" is only
    // actionable when the reader knows what to create.
    value: SDD_STAGES.map((stage) => ({
      stage,
      file: STAGE_FILE[stage],
      present: Boolean(artefacts[stage]),
      source: { path: `${dir}/${STAGE_FILE[stage]}` },
    })),
    // #1059 region 08: the design puts the slice plan under the stage strip,
    // in this same tab. The plan is DECLARED in `tasks.md` and read into
    // `sliceScopes`; what a pull request actually did with it is not read
    // anywhere on this page, so the note says that rather than letting a
    // reader assume a drawn slice is a merged one.
    slices: sliceTab(row, dir),
  };
}

/**
 * The door's records tab (#998 R998-6): this issue's own rows from
 * `snapshot.records` (no new IO — the section is already in the snapshot
 * the route holds, same as every other tab), newest first, each sourced to
 * its own record file.
 */
function buildRecordsTab({ snapshot, issue }) {
  if (!snapshot?.records?.ok) return { ok: false, reason: snapshot?.records?.reason ?? 'the records section could not be read' };
  const rows = snapshot.records.value.records
    .filter((r) => r.issue === issue)
    .slice()
    .sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  return {
    ok: true,
    value: rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, actorKind: r.actorKind, type: r.type, supersedes: r.supersedes ?? null, source: { path: r.file } })),
  };
}

/**
 * buildChangeView() — the drawer's one composition. Server-side only (D11):
 * the six tabs' IO happens here, the pure shapers just attach `source`.
 *
 * `project` is not in D8's module-map signature verbatim but is required to
 * build a PR URL (D14) the same way `server.mjs`'s `buildMeta()` already
 * carries it — an accepted, disclosed addition, optional and defaulting to
 * `null` (degrades to a relative `pull/<n>` reference, still a non-empty
 * `source.url`, never a crash).
 *
 * @param {{root: string, issue: number, snapshot: object, project?: string|null,
 *   _read?: Function, _run?: Function, _exists?: Function}} opts
 * @returns {{ok:true, value:{issue:number, changeDir:string|null, spec:object, tasks:object, workingMemory:object, reviews:object}} | {ok:false, reason:string}}
 */
export function buildChangeView({ root, issue, snapshot, project = null, _read, _run, _exists } = {}) {
  if (!Number.isInteger(issue) || issue <= 0) return { ok: false, reason: 'issue must be a positive integer' };
  if (!snapshot || typeof snapshot !== 'object') return { ok: false, reason: 'no snapshot was supplied' };

  // `_exists` is accepted for signature parity with the rest of `snapshot.mjs`'s
  // readers (`readChanges`'s own `{_read, _list, _exists}` seam) but unused
  // today — `read()`'s own catch already covers "the file is not there".
  void _exists;

  // `_read` is accepted for signature parity and unused: no artifact is read from a working tree (#1198).
  void _read;
  const run = _run ?? ((file, args, opts) => execFileSync(file, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...(opts?.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}) }));

  const dir = findChangeDir(snapshot, issue);
  const { head, documents: headDocuments } = readHeadDocuments({ run, dir });
  const resolved = resolveBranch({ run, snapshot, issue });
  const resume = readResumeDocument({ run, resolved });
  const documents = { ...headDocuments, resume };

  return {
    ok: true,
    value: {
      issue,
      changeDir: dir,
      documents,
      spec: buildSpecTab({ documents, head, dir, issue }),
      sdd: buildSddTab({ snapshot, issue, dir }),
      tasks: buildTasksTab({ documents, head, run, dir, issue }),
      workingMemory: buildWorkingMemoryTab({ resolved, resume }),
      reviews: buildReviewsTab({ snapshot, project, issue }),
      records: buildRecordsTab({ snapshot, issue }),
    },
  };
}
