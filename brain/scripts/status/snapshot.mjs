// snapshot.mjs — the Brain UI read model: one object, computed on every call
// from the tree and the forge (#879, slice 2 of #878).
//
// RULE ZERO (#878): every fact the UI shows is reconstructible from the
// repository plus the tickets. So every row here names its source — a `path`,
// a `file`, a PR number, an issue number — and nothing here is ever written:
// no cache, no store, no file. A snapshot that persisted would be the second
// source of truth the epic forbids.
//
// SINGLE ACCESSOR RULE (RFC §2.1): this module IMPORTS brain's pure functions —
// `buildGraph`, the `sdd-layout` accessors, `deriveTasks`, `parseVerdict`,
// `readRecords`, `releaseDebt` — and the two readers this slice adds. It parses
// no CLI stdout and invents no path.
//
// EVERY SECTION SAYS WHETHER IT COULD BE READ. `{ok: true, value}` or
// `{ok: false, reason}`, built with `report.mjs`'s `field`/`uncomputable`, the
// vocabulary `brain:status` prints. A section never collapses "could not read"
// into `[]`: a missing records dir is a reason, not an empty list
// (`brain/core/anti-patterns/evidence-reader-empty-on-failure.md`).
//
// PURE CORE, INJECTED EDGES. `buildSnapshot` reads through seams; the
// derivations below it take facts. The verb (`snapshot-cli.mjs`) prints what
// this returns and adds nothing.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { field, uncomputable } from './report.mjs';
import { deriveTasks } from './derive.mjs';
import { buildGraph } from './epic-graph.mjs';
import { gatherReleaseFacts, releaseDebt } from './release-debt.mjs';
import { gatherHistoryFacts } from './history.mjs';
import { readAdrIndex, homeAdrList, adrDrift } from './adr-index.mjs';
import { readAntiPatterns } from './anti-patterns.mjs';
import { CHANGES_ROOT, changeDir, archivePath, ARTEFACT_FILE, parseChangeId, isGrandfathered, missingRequiredArtifacts, parseSliceScopes, hasSpec } from '../lib/sdd-layout.mjs';
import { requiredArtifactsFor, resolveTier } from '../vcs/governance-tiers.mjs';
import { parseVerdict } from '../review/lib/parse-verdict.mjs';
import { readRecords, recordFilename } from '../memory/lib/store.mjs';
import { parseCanonicalIssueBranch } from '../lib/branch-grammar.mjs';

export const SNAPSHOT_TIER = 'committed';
export const RECORDS_DIR = '.memory/records';
export const HOME_PATH = 'brain/HOME.md';

export const PLANNED = 'planned';
export const IN_FLIGHT = 'in-flight';
export const DONE = 'done';
/** A node whose body the forge did not hand over: not `unclassified` (nobody declared a block), UNKNOWN. */
export const UNREADABLE = 'unreadable';

// ── derivations: facts in, rows out ─────────────────────────────────────────

/** The issue a PR head branch names under the one grammar `brain:ticket:start` writes, or `null`. */
export function issueOfBranch(headBranch) {
  const m = typeof headBranch === 'string' ? parseCanonicalIssueBranch(headBranch) : null;
  return m ? Number(m.issueNumber) : null;
}

/**
 * roadmapState() — `planned | in-flight | done` for one graph node (R879-5).
 *
 * `done` is the ticket's state and needs no PR. `in-flight` needs an open PR
 * naming the issue. `planned` is the ABSENCE of such a PR, which is only a
 * fact when the list was read: with `prs` unreadable an open node is
 * uncomputable, never "planned".
 *
 * @param {{number:number,state:string}} node
 * @param {{ok:boolean,value?:Array<{number:number,headBranch:string}>,reason?:string}} prs
 * @param {{ok:boolean,value?:Array<{pr:number,ok:boolean,latest?:object|null}>}} reviews
 */
export function roadmapState(node, prs, reviews) {
  if (node.state !== 'open') return field({ state: DONE, evidence: { issueState: node.state } });
  if (!prs.ok) return uncomputable(`the PR list could not be read (${prs.reason}), so "planned" cannot be asserted`);
  const mine = prs.value.filter((p) => issueOfBranch(p.headBranch) === node.number);
  if (mine.length === 0) return field({ state: PLANNED, evidence: { prs: [] } });
  const latest = reviews.ok
    ? reviews.value.filter((r) => r.ok && mine.some((p) => p.number === r.pr)).map((r) => r.latest).filter(Boolean).at(-1) ?? null
    : null;
  return field({
    state: IN_FLIGHT,
    evidence: { prs: mine.map((p) => p.number), verdict: latest ? { pr: latest.pr, rev: latest.rev, verdict: latest.verdict } : null },
  });
}

/**
 * aggregateActors() — one row per `actor` over records, humans and agents in
 * one shape (R879-6). Sorted by actor; `byType` keys sorted too, so two runs
 * on one store are byte-identical.
 */
export function aggregateActors(records = []) {
  const rows = new Map();
  for (const r of records) {
    const actor = typeof r.actor === 'string' ? r.actor : '(no actor)';
    const row = rows.get(actor) ?? { actor, actorKind: r.actorKind ?? null, records: 0, byType: {}, first: null, last: null };
    row.records += 1;
    const type = typeof r.type === 'string' ? r.type : '(no type)';
    row.byType[type] = (row.byType[type] ?? 0) + 1;
    if (typeof r.ts === 'string') {
      if (row.first === null || r.ts < row.first) row.first = r.ts;
      if (row.last === null || r.ts > row.last) row.last = r.ts;
    }
    rows.set(actor, row);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, byType: Object.fromEntries(Object.entries(row.byType).sort(([a], [b]) => a.localeCompare(b))) }))
    .sort((a, b) => a.actor.localeCompare(b.actor));
}

/**
 * projectRecord() — a record's index metadata plus the file it lives in (D3).
 * `content` stays in the file; `file` is the pointer. A record whose id or ts
 * cannot name a file is kept with `file: null` rather than dropped.
 */
export function projectRecord(r) {
  let file;
  try { file = `${RECORDS_DIR}/${recordFilename(r)}`; } catch { file = null; }
  const row = { id: r.id ?? null, ts: r.ts ?? null, actor: r.actor ?? null, actorKind: r.actorKind ?? null, type: r.type ?? null };
  if (r.issue !== undefined) row.issue = r.issue;
  if (r.supersedes !== undefined) row.supersedes = r.supersedes;
  if (typeof r.title === 'string') row.title = r.title;
  row.file = file;
  return row;
}

const EVIDENCE_EXCERPT_LEN = 240;

/**
 * A finding's `line` scalar, as `parseVerdict` hands it back (always a
 * string — `unyamlScalar` never coerces). Only a positive integer (>= 1)
 * parses; anything else (absent, `'abc'`, `0`, a negative) is `null` — never
 * a fabricated `0`, and never the raw string leaking through as a
 * number-shaped surprise.
 *
 * `>= 1`, not `>= 0` (#1009 cold review finding 3): the emitter's own
 * invariant is `hasUsableAnchor` (verdict.mjs), which never posts a finding
 * with `line: 0` — only `line >= 1`. Accepting `0` here would let a line of
 * `0` through as a real anchor, and `provenance.mjs`'s `sourceLabel`/
 * `sourceStamp` use a falsy check (`source.line ? ... : ...`), so a `0`
 * would silently render as `[repo: path]` with the line dropped rather than
 * `[repo: path:0]` — a quiet loss, not a stated one.
 */
function parseFindingLine(raw) {
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * A `parseVerdict` finding entry, shaped for the UI (#998 R998-5). `id`,
 * `severity`, `evidence`, `cites` per the protocol prose; `file`/`line` ARE
 * real emitted fields too — `verdict.mjs`'s `renderVerdict` posts them per
 * finding when `hasUsableAnchor` holds (issue #405, REQ-405-2; measured on
 * PR #1006's posted verdict, head e1c4aab3). An earlier revision of this
 * function read the protocol prose as the schema and dropped them; the
 * EMITTER is the schema, and `parseEntryList` (parse-verdict.mjs) is
 * field-name-agnostic — it already captured whatever `renderVerdict` wrote,
 * this function was just throwing the two fields away.
 */
function shapeFinding(f) {
  return {
    id: f?.id ?? null,
    severity: f?.severity ?? null,
    cites: f?.cites ?? null,
    file: f?.file ?? null,
    line: parseFindingLine(f?.line),
    evidenceExcerpt: typeof f?.evidence === 'string' ? f.evidence.slice(0, EVIDENCE_EXCERPT_LEN) : '',
  };
}

/** The verdicts a PR thread carries, oldest first, plus the latest one. */
export function reviewRows(prNumber, reviews) {
  const verdicts = [];
  for (const rv of reviews) {
    const v = parseVerdict({ body: rv?.body, author: rv?.author ?? null });
    if (!v) continue;
    const findingsArray = Array.isArray(v.findings) ? v.findings : [];
    verdicts.push({
      pr: prNumber, head_sha: v.head_sha, rev: v.rev, verdict: v.verdict, author: v.author,
      // The array, not the count (#998 R998-5) — `findingCount` is `null` when
      // uncomputable (absent from the block, or `malformed` names it), and the
      // genuine count when the block declared a readable list, `[]` included.
      findings: findingsArray.map(shapeFinding),
      findingCount: Array.isArray(v.findings) ? v.findings.length : null,
      malformed: v.malformed ?? [],
    });
  }
  return { pr: prNumber, ok: true, verdicts, latest: verdicts.at(-1) ?? null };
}

// ── readers: the edges, each degrading on its own ───────────────────────────

const APPLY_PROGRESS_FILE = 'apply-progress.md';
const ARCHIVE_REPORT_FILE = 'archive-report.md';
/** Canonical archive dir naming (archive-sweep.mjs, `archivePath(iid)`): the bare issue number, no `issue-` prefix and no slug — unlike the pre-convention dated-slug dirs this repo still carries, which are not eligible rows here (R998-4). */
const ARCHIVE_ID_RE = /^\d+$/;

/**
 * The seven SDD stage artefacts' raw presence for one change dir (R998-4),
 * independent of which subset the gate REQUIRES at this tier: the SDD view
 * always draws all seven (spec.md's acceptance: "seven stages per change"),
 * so presence is asked directly rather than filtered through
 * `missingRequiredArtifacts`'s tier-scoped list.
 *
 * The spec slot delegates to `sdd-layout.mjs`'s own `hasSpec(changeId, ...)`
 * rather than restating its flat/nested tolerance here a second time
 * (editorial, cold review of #1008/PR6: an earlier revision of this comment
 * claimed `hasSpec`'s own `changeDir(changeId)` path-building "does not go
 * through" the `archive/<issue>` location — measured false, `changeDir(
 * 'archive/<n>')` and `archivePath(<n>)` template the identical string from
 * the same `CHANGES_ROOT` constant). `missingId` is exactly the identifier
 * that relationship needs: `id` for an active row, the synthetic
 * `archive/<name>` for an archived one — the same identifier
 * `missingRequiredArtifacts` below already resolves a path from.
 */
function readArtefactPresence(dir, missingId, { exists, list }) {
  return {
    proposal: exists(`${dir}/proposal.md`),
    spec: hasSpec(missingId, { exists, listDir: list }),
    design: exists(`${dir}/design.md`),
    tasks: exists(`${dir}/tasks.md`),
    apply: exists(`${dir}/${APPLY_PROGRESS_FILE}`),
    verify: exists(`${dir}/${ARTEFACT_FILE.verification}`),
    archive: exists(`${dir}/${ARCHIVE_REPORT_FILE}`),
  };
}

/** One change dir's row, active or archived (R998-4) — same shape either way. `missingId` is the identifier `missingRequiredArtifacts`/`isGrandfathered` resolve a path from; for an archived row it is a synthetic `archive/<name>`, which `changeDir()` templates into the exact `openspec/changes/archive/<name>` location (no second path-building rule needed). */
function readOneChange({ id, missingId, dir, issue, slug, archived, artefacts, read, list, exists }) {
  let tasksText = null;
  try { tasksText = read(`${dir}/tasks.md`); } catch { tasksText = null; }
  const tasks = deriveTasks({ tasksText, reason: `${dir}/tasks.md could not be read` });
  const scopes = parseSliceScopes(tasksText ?? '');
  return {
    id, issue, slug, dir, archived,
    grandfathered: archived ? false : isGrandfathered(id),
    missing: Array.isArray(artefacts)
      ? field(missingRequiredArtifacts(missingId, { artefacts, exists, listDir: list }))
      : uncomputable(`the required artefact set could not be resolved: ${artefacts.reason}`),
    artefacts: readArtefactPresence(dir, missingId, { exists, list }),
    tasks: Object.fromEntries(tasks.fields),
    sliceScopes: scopes.refusal ? uncomputable(scopes.refusal) : field(scopes.scopes),
  };
}

/**
 * Every change dir, active AND archived, read through the layout accessor
 * (R879-8, extended R998-4): `openspec/changes/<issue-N-slug>` rows plus
 * `openspec/changes/archive/<issue>` rows (`archived: true`), same shape.
 * A missing `archive/` dir is "no archived changes" (a fact, checked via
 * `exists` before ever listing it); any OTHER failure to list an existing
 * `archive/` dir is this whole section's reason, same as a failure to list
 * `CHANGES_ROOT` itself. A dir under `archive/` that is not a bare issue
 * number (a pre-convention dated-slug dir, a named one) is never silently
 * dropped: it is excluded from `value`'s rows AND named on the returned
 * section's own `archiveSkipped` array (review of PR 4, fix 1).
 */
export function readChanges({ root, tier, _read, _list, _exists } = {}) {
  const read = _read ?? ((p) => readFileSync(join(root, p), 'utf8'));
  const list = _list ?? ((p) => readdirSync(join(root, p)));
  const exists = _exists ?? ((p) => existsSync(join(root, p)));
  let names;
  try {
    names = list(CHANGES_ROOT).filter((n) => parseChangeId(n) !== null).sort();
  } catch (err) {
    return uncomputable(`${CHANGES_ROOT} could not be listed: ${err?.message ?? err}`);
  }
  let artefacts = null;
  try { artefacts = requiredArtifactsFor(tier); } catch (err) { artefacts = { reason: err.message }; }

  const activeRows = names.map((id) => {
    const { iid, slug } = parseChangeId(id);
    return readOneChange({ id, missingId: id, dir: changeDir(id), issue: Number(iid), slug, archived: false, artefacts, read, list, exists });
  });

  const archiveDirRel = `${CHANGES_ROOT}/archive`;
  let archivedRows = [];
  const archiveSkipped = [];
  if (exists(archiveDirRel)) {
    let allNames;
    try {
      allNames = list(archiveDirRel).sort();
    } catch (err) {
      return uncomputable(`${archiveDirRel} could not be listed: ${err?.message ?? err}`);
    }
    const archiveNames = [];
    for (const n of allNames) {
      if (ARCHIVE_ID_RE.test(n)) archiveNames.push(n);
      else archiveSkipped.push({ name: n, reason: 'not an issue-numbered archive dir' });
    }
    archiveNames.sort((a, b) => Number(a) - Number(b));
    archivedRows = archiveNames.map((name) =>
      readOneChange({ id: name, missingId: `archive/${name}`, dir: archivePath(name), issue: Number(name), slug: null, archived: true, artefacts, read, list, exists })
    );
  }

  return { ...field([...activeRows, ...archivedRows]), archiveSkipped };
}

/** Records, projected (D3), with the duplicate accounting the store reports. */
export function readRecordRows({ root, _exists } = {}) {
  const exists = _exists ?? ((p) => existsSync(join(root, p)));
  if (!exists(RECORDS_DIR)) return uncomputable(`${RECORDS_DIR} is absent`);
  const { records, duplicates } = readRecords({ recordsDir: join(root, RECORDS_DIR) });
  return field({ records: records.map(projectRecord), duplicates });
}

async function readForge({ vcs, project }) {
  const noPort = !vcs ? 'no VCS port was supplied' : !project ? 'no project could be resolved for the forge read' : null;
  if (noPort) return { graph: uncomputable(noPort), prs: uncomputable(noPort), reviews: uncomputable(noPort) };

  let graph;
  try {
    const listed = await vcs.issueList({ project, state: 'open' });
    const issues = [];
    const unreadable = new Map();
    for (const i of listed) {
      let full;
      try {
        full = await vcs.issueView({ project, number: i.number });
      } catch (err) {
        // The body is UNKNOWN, not empty. Substituting '' here placed the node as
        // "declared nothing" — byte-identical to a real undeclared issue, the
        // pattern `evidence-reader-empty-on-failure.md` names verbatim (cold
        // review of #953, rev 1). The issue still enters the graph with what the
        // LIST did say — number, title, labels, open state — so an edge another
        // issue declares INTO it still blocks; what the body would have said
        // (its own edges, track, files) is unknown, and the node says so below.
        unreadable.set(i.number, err?.message ?? String(err));
        full = null;
      }
      issues.push({ number: i.number, title: i.title, labels: i.labels ?? [], state: 'open', body: full?.body ?? '', assignees: i.assignees ?? full?.assignees ?? null });
    }
    const g = buildGraph(issues);
    // The reset enumerates EVERY field a body would have contributed, so an
    // unreadable node can never carry one. #967 adds `kind`, `tracker`, `parent` and
    // `parentSource` to that list: a node whose body nobody could read must not
    // report a tracker or a parent it never declared.
    //
    // `declarationDivergences` needs no line here — it is graph-level, `graph` is
    // built with `...g` below, and an unreadable body enters `buildGraph` as `body:
    // ''`, so it contributes none.
    const nodes = g.nodes.map((n) => (unreadable.has(n.number)
      ? { ...n, ok: false, reason: `the issue body could not be read: ${unreadable.get(n.number)}`, status: UNREADABLE, declared: null, track: null, kind: null, tracker: null, parent: null, parentSource: null, files: [], sources: [] }
      : { ...n, ok: true }));
    // `tracks` is a Map, which JSON drops to `{}`; the verb and the module must
    // print one shape, so it is a sorted object of member numbers here. An
    // unreadable node has no known track and is listed in `issuesUnreadable`
    // instead of under `?`, which is the track of issues that DECLARED none.
    const tracks = Object.fromEntries(
      [...g.tracks].sort(([a], [b]) => a.localeCompare(b))
        .map(([k, ms]) => [k, ms.map((n) => n.number).filter((num) => !unreadable.has(num))])
        .filter(([, members]) => members.length > 0),
    );
    graph = field({
      ...g, nodes, tracks,
      issuesUnreadable: [...unreadable].map(([number, reason]) => ({ number, reason })),
    });
  } catch (err) {
    graph = uncomputable(`the issue list could not be read: ${err?.message ?? err}`);
  }

  let prs;
  try {
    const listed = await vcs.mrList({ project, state: 'open' });
    prs = field(listed.map((p) => ({ number: p.number, title: p.title, headBranch: p.headBranch ?? null, issue: issueOfBranch(p.headBranch) })));
  } catch (err) {
    prs = uncomputable(`the PR list could not be read: ${err?.message ?? err}`);
  }

  let reviews;
  if (!prs.ok) {
    reviews = uncomputable(`no PR list to read threads for (${prs.reason})`);
  } else {
    const rows = [];
    for (const p of prs.value) {
      try {
        const list = await vcs.prReviews({ project, number: p.number });
        rows.push(Array.isArray(list) ? reviewRows(p.number, list) : { pr: p.number, ok: false, reason: 'the forge returned no reviews list' });
      } catch (err) {
        rows.push({ pr: p.number, ok: false, reason: err?.message ?? String(err) });
      }
    }
    reviews = field(rows);
  }
  return { graph, prs, reviews };
}

// ── the composition ─────────────────────────────────────────────────────────

/**
 * buildSnapshot() — the one shape every consumer reads (R879-1).
 *
 * @param {{root?: string, now?: string|Date, vcs?: object|null, project?: string|null,
 *   _read?: Function, _list?: Function, _exists?: Function, _run?: Function}} opts
 */
export async function buildSnapshot({ root = process.cwd(), now, vcs = null, project = null, _read, _list, _exists, _run } = {}) {
  const read = _read ?? ((p) => readFileSync(join(root, p), 'utf8'));
  const list = _list ?? ((p) => readdirSync(join(root, p)));
  const exists = _exists ?? ((p) => existsSync(join(root, p)));
  // stderr is swallowed on purpose: `git describe` on an untagged clone prints
  // "fatal: No names found" and the fact is already carried in band as
  // `tag: null`. A JSON verb must not interleave git chatter with its output.
  const run = _run ?? ((file, args) => execFileSync(file, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const generatedAt = (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

  let tier;
  try { tier = resolveTier(JSON.parse(read('brain.config.json'))); } catch (err) { tier = { reason: `brain.config.json: ${err?.message ?? err}` }; }

  const adrs = readAdrIndex({ root, _read: read, _list: list });
  let home = null;
  let homeReason = null;
  try { home = homeAdrList(read(HOME_PATH)); } catch (err) { homeReason = `${HOME_PATH} could not be read: ${err?.message ?? err}`; }
  const drift = !adrs.ok ? uncomputable(adrs.reason) : homeReason ? uncomputable(homeReason) : field(adrDrift(adrs.value, home));

  const records = readRecordRows({ root, _exists: exists });
  const actors = records.ok ? field(aggregateActors(records.value.records)) : uncomputable(records.reason);

  const forge = await readForge({ vcs, project });
  const graph = forge.graph.ok
    ? field({ ...forge.graph.value, nodes: forge.graph.value.nodes.map((n) => ({ ...n, roadmap: roadmapState(n, forge.prs, forge.reviews) })) })
    : forge.graph;

  return {
    generatedAt,
    tier: SNAPSHOT_TIER,
    governanceTier: typeof tier === 'string' ? field(tier) : uncomputable(tier.reason),
    graph,
    changes: readChanges({ root, tier: typeof tier === 'string' ? tier : null, _read: read, _list: list, _exists: exists }),
    prs: forge.prs,
    reviews: forge.reviews,
    records,
    adrs,
    antiPatterns: readAntiPatterns({ root, _read: read, _list: list }),
    actors,
    releaseDebt: field(releaseDebt(gatherReleaseFacts({ root, _run: run, _read: read }))),
    drift,
    history: gatherHistoryFacts({ root, _run: run }),
  };
}

// ── text mode: the same object, for a terminal ──────────────────────────────

/** @returns {string} one screen over the snapshot; every section prints its count or its reason. */
export function renderSnapshotText(s) {
  const line = (name, sec, count) => (sec.ok ? `${name.padEnd(14)} ${count(sec.value)}` : `${name.padEnd(14)} not computed — ${sec.reason}`);
  const out = [
    `brain snapshot · ${s.generatedAt} · tier ${s.tier}`,
    line('graph', s.graph, (g) => `${g.nodes.length} node(s), ${g.edges.length} edge(s)${g.issuesUnreadable.length ? `, ${g.issuesUnreadable.length} issue body(ies) unreadable` : ''}`),
    line('changes', s.changes, (c) => `${c.length} change dir(s)`),
    line('prs', s.prs, (p) => `${p.length} open`),
    line('reviews', s.reviews, (r) => `${r.filter((x) => x.ok).length} thread(s) read, ${r.filter((x) => !x.ok).length} unreadable`),
    line('records', s.records, (r) => `${r.records.length} record(s), ${r.duplicates.ids} duplicated id(s)`),
    line('adrs', s.adrs, (a) => `${a.filter((x) => x.ok).length} parsed, ${a.filter((x) => !x.ok).length} unreadable`),
    line('anti-patterns', s.antiPatterns, (a) => `${a.entries.length} entr${a.entries.length === 1 ? 'y' : 'ies'}${a.unlistable.length ? `, ${a.unlistable.length} dir(s) unlistable` : ''}`),
    line('actors', s.actors, (a) => `${a.length} actor(s)`),
    line('release debt', s.releaseDebt, (d) => d.severity),
    line('history', s.history, (h) => `${h.commits.length} commit(s), ${h.tags.length} tag(s)`),
  ];
  if (s.drift.ok) {
    const d = s.drift.value;
    const n = d.homeOnly.length + d.filesOnly.length + d.unreadable.length;
    if (n === 0) out.push('adr drift      none — HOME.md and the parser agree');
    else {
      out.push(`⚠ adr drift — ${n} disagreement(s) between brain/HOME.md and the parser (reported, never a gate):`);
      for (const h of d.homeOnly) out.push(`    listed in HOME.md, not readable: ADR-${String(h.number).padStart(4, '0')} ${h.path ?? ''}`.trimEnd());
      for (const f of d.filesOnly) out.push(`    on disk, not listed in HOME.md: ADR-${String(f.number).padStart(4, '0')} ${f.path}`);
      for (const u of d.unreadable) out.push(`    unreadable: ${u.path} — ${u.reason}`);
    }
  } else {
    out.push(`adr drift      not computed — ${s.drift.reason}`);
  }
  return out.join('\n');
}
