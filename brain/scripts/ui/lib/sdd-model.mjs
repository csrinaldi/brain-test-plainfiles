// sdd-model.mjs — the SDD view's read model (#998 R998-4): seven stages per
// change, the task count, the slice plan as DECLARED SCOPE ONLY (ruling,
// proposal.md — "PR state is not read"), and phase-order violations named.
// Pure, imported by the browser and by node:test (D9): no node: builtin, no
// clock, no fetch — every fact comes from `changesSection`
// (`status/snapshot.mjs`'s `readChanges`, already read through the accessor
// and the `archive/<issue>` reader, R998-4), never re-read here.

/** The seven SDD lifecycle stages, in the order the matrix draws them. */
export const STAGE_IDS = Object.freeze(['proposal', 'spec', 'design', 'tasks', 'apply', 'verify', 'archive']);

/**
 * The slice plan's ruling (proposal.md), pinned as data rather than a page
 * literal (review of PR 4, fix 3): a slice's plan carries what it CLAIMS and
 * its terminal PR, never whether that PR is open, merged, or exists.
 */
export const SLICE_NOTE = 'PR state is not read';

/**
 * The small stage vocabulary — distinct from `state-vocab.mjs`'s nine NODE
 * states, which this is not: a stage cell says one of six words, never a
 * blank cell (never empty-on-failure). `unreadable` (review of PR 4, fix 5)
 * is distinct from `missing`: the artefact exists but could not be read or
 * parsed, which is a different fact than it never having been written.
 */
export const STAGE_VOCAB = Object.freeze({
  present: Object.freeze({ mark: '●', label: 'Present' }),
  missing: Object.freeze({ mark: '○', label: 'Missing' }),
  'in-progress': Object.freeze({ mark: '◐', label: 'In progress' }),
  done: Object.freeze({ mark: '✓', label: 'Done' }),
  'not-applicable': Object.freeze({ mark: '—', label: 'N/A' }),
  unreadable: Object.freeze({ mark: '⚠', label: 'Unreadable' }),
});

/** The file each stage id names, for the stage cell's `source.path` (mirrors `sdd-layout.mjs`'s `ARTEFACT_FILE`, plus the two stages that module does not declare). */
const STAGE_FILE = Object.freeze({
  proposal: 'proposal.md', spec: 'spec.md', design: 'design.md', tasks: 'tasks.md',
  apply: 'apply-progress.md', verify: 'verify-report.md', archive: 'archive-report.md',
});

// The four lifecycle stages, in canonical order — mirrors `sdd-layout.mjs`'s
// `LIFECYCLE_STAGES` (brain/scripts/lib/sdd-layout.mjs), duplicated as a bare
// literal rather than imported: that module reads `node:fs` at module scope
// (its own default `exists()`/`listDir()` helpers), which this file must not
// carry — `app.js` loads it directly as a browser ES module (D9), and an
// unresolvable `node:fs` specifier would break the page's whole module graph
// for every visitor, not just an SDD-tab one. Exported so `sdd-model.test.mjs`
// can pin the two arrays equal, and allowlisted in `sdd-layout.test.mjs`'s
// stage-array drift guard with this same reason.
export const LIFECYCLE_ORDER = Object.freeze(['proposal', 'spec', 'design', 'tasks']);

/**
 * evaluateStageOrder(present) -> {ok:true, violations}. Restates
 * `vcs/phase-order-check.mjs`'s Rule A INTENT — a later lifecycle artefact
 * existing while an earlier one is absent — without that check's git-diff
 * gating (Rule C's `touchedDirs`/`impl` inputs: whether IMPLEMENTATION code
 * changed in this diff, which this static read-model has no diff to answer).
 * `evaluatePhaseOrder` itself is not imported here for the same D9 reason
 * `LIFECYCLE_ORDER` above is a literal: it pulls in `node:child_process` and
 * `node:fs` at module scope. `sdd-model.test.mjs` imports it directly (test
 * code is never served to the browser) and proves the two agree on a shared
 * fixture.
 */
function evaluateStageOrder(present) {
  const violations = [];
  let firstMissing = null;
  for (const stage of LIFECYCLE_ORDER) {
    if (!present[stage]) {
      if (firstMissing === null) firstMissing = stage;
      continue;
    }
    if (firstMissing !== null) {
      violations.push({ stage, reason: `"${stage}" is present but "${firstMissing}" has not been written — phase order broken` });
    }
  }
  return { ok: true, violations };
}

function stageRow(id, state, path, reason) {
  const row = { id, state, source: { path } };
  if (reason) row.reason = reason;
  return row;
}

/**
 * `tasks`'s own stage state: `missing` (no tasks.md), `unreadable` (tasks.md
 * exists but could not be read or parsed — review of PR 4, fix 5, distinct
 * from `missing` because the artefact IS there), `done` (nothing open), or
 * `in-progress`.
 */
function tasksStageState(tasks, hasTasksArtefact) {
  if (!hasTasksArtefact) return { state: 'missing', reason: null };
  if (tasks?.checked?.ok !== true) {
    return { state: 'unreadable', reason: tasks?.checked?.reason ?? `${STAGE_FILE.tasks} could not be read` };
  }
  return { state: tasks.open?.value === 0 ? 'done' : 'in-progress', reason: null };
}

/** One change's seven-stage row. A grandfathered change claims none of them — "the past is recorded, not edited" (sdd-layout.mjs's own words for the same ruling). */
function buildStages(change) {
  if (change.grandfathered) return STAGE_IDS.map((id) => stageRow(id, 'not-applicable', change.dir));

  const present = change.artefacts ?? {};
  const stages = [];
  for (const id of ['proposal', 'spec', 'design']) {
    stages.push(stageRow(id, present[id] ? 'present' : 'missing', `${change.dir}/${STAGE_FILE[id]}`));
  }
  const tasksState = tasksStageState(change.tasks, present.tasks);
  stages.push(stageRow('tasks', tasksState.state, `${change.dir}/${STAGE_FILE.tasks}`, tasksState.reason));
  stages.push(stageRow('apply', present.apply ? 'present' : 'missing', `${change.dir}/${STAGE_FILE.apply}`));
  stages.push(stageRow('verify', present.verify ? 'present' : 'missing', `${change.dir}/${STAGE_FILE.verify}`));

  // `archived` is itself the archive stage's fact — an archived change needs
  // no separate archive-report.md to prove it moved; its `dir` already IS
  // the archive location (snapshot.mjs's `archivePath`).
  const archivePresent = change.archived === true || present.archive === true;
  stages.push(stageRow('archive', archivePresent ? 'present' : 'missing', change.archived ? change.dir : `${change.dir}/${STAGE_FILE.archive}`));

  return stages;
}

// `status/derive.mjs`'s `deriveTasks()` renders "zero open items" as the
// literal em dash, its own DISPLAY sentinel (other readers of that field
// print it verbatim, so `derive.mjs` itself is unchanged) — never a real
// "next" value. Cold review of #1008/PR6: `buildTasksSummary` used to
// forward it unchanged, so the SDD row rendered "next: —" for every done
// or task-less change.
const NO_NEXT_TASK_SENTINEL = '—';

function buildTasksSummary(change) {
  const t = change.tasks ?? {};
  const next = t.next?.ok === true ? t.next.value : null;
  return {
    checked: t.checked?.ok === true ? t.checked.value : 0,
    open: t.open?.ok === true ? t.open.value : 0,
    next: next === NO_NEXT_TASK_SENTINEL ? null : next,
    source: { path: `${change.dir}/${STAGE_FILE.tasks}` },
  };
}

/**
 * The slice plan, DECLARED SCOPE ONLY (proposal.md ruling: "PR state is not
 * read" — this model carries what a slice CLAIMS and its terminal PR, never
 * whether that PR is open, merged, or does not exist). `claims`, not
 * `files`: `sdd-layout.mjs`'s `parseSliceScopes` validates and keeps
 * `slice`/`claims`/`terminal_pr` from the `brain-slice-scope/1` block —
 * `claims` is what a reviewer judges a slice against, and is what survives
 * the parse.
 */
function buildSlices(change) {
  const scopes = change.sliceScopes;
  if (!scopes || scopes.ok !== true) return [];
  return scopes.value.map((s) => ({
    n: s.slice,
    claims: s.claims,
    terminalPr: s.terminal_pr,
    source: { path: `${change.dir}/${STAGE_FILE.tasks}` },
  }));
}

function buildChangeRow(change) {
  const present = change.artefacts ?? {};
  const phaseOrder = change.grandfathered
    ? { ok: true, violations: [] }
    : evaluateStageOrder({ proposal: Boolean(present.proposal), spec: Boolean(present.spec), design: Boolean(present.design), tasks: Boolean(present.tasks) });

  return {
    id: change.id,
    issue: change.issue,
    slug: change.slug,
    dir: change.dir,
    archived: change.archived === true,
    grandfathered: change.grandfathered === true,
    stages: buildStages(change),
    tasks: buildTasksSummary(change),
    slices: buildSlices(change),
    phaseOrder,
  };
}

/**
 * buildSddModel(changesSection, {tier}) -> {ok, value:{changes, totals}} |
 * {ok:false, reason}. `tier` is accepted for symmetry with
 * `readChanges({tier})`, unused today: the matrix always draws all seven
 * stages, tier or no tier (R998-4's acceptance — "seven stages per change").
 * A future stage tooltip ("required at this tier") is the only reason to
 * carry it at all, so the option is accepted now rather than added as a
 * breaking change later.
 *
 * Determinism: the same changes, in any order, produce a byte-identical
 * model — rows sort by issue number before anything else runs over them.
 */
/**
 * sddForIssue(changesSection, issue) -> {ok:true, value:<the change row>} |
 * {ok:false, reason}
 *
 * One change, found by the issue that owns it (#1059 region 03). A node card
 * carries the stage its change reached; the SDD view builds every row, and a
 * card needs exactly one, so the search belongs here rather than in the page.
 * An issue with no change directory is not an error and not an empty strip —
 * it is a stated absence, like every other missing thing on this page.
 */
/**
 * buildSlicePlan(changesSection) -> {ok:true, value:{changes, unreadable, note}}
 * | {ok:false, reason}
 *
 * The project's declared chained-PR plan (#1059 phase 10) — the design's fourth
 * mode. Only changes that DECLARE a plan are rows: a plan view listing changes
 * with no plan would be a list of absences pretending to be a schedule. A plan
 * that could not be parsed is said BESIDE the ones that could, never dropped,
 * and the note repeats what the rest of the page already says — the plan is
 * declared, and what each PR did with its slice is not read.
 */
export function buildSlicePlan(changesSection) {
  if (!changesSection || typeof changesSection !== 'object') return { ok: false, reason: 'no changes section was given' };
  if (changesSection.ok !== true) return { ok: false, reason: changesSection.reason };

  const changes = [];
  const unreadable = [];
  for (const row of changesSection.value ?? []) {
    const scopes = row.sliceScopes;
    if (!scopes || typeof scopes !== 'object') continue;
    if (scopes.ok !== true) { unreadable.push({ issue: row.issue, reason: scopes.reason }); continue; }
    const slices = scopes.value ?? [];
    if (slices.length === 0) continue;
    changes.push({
      issue: row.issue,
      dir: row.dir,
      archived: Boolean(row.archived),
      source: { path: row.dir },
      slices: slices.map((slice) => ({
        slice: slice.slice,
        claims: [...(slice.claims ?? [])],
        terminalPr: slice.terminal_pr ?? null,
      })),
    });
  }
  // The changes section also carries the archive directories it SKIPPED (#1008
  // fix 1). The stage matrix used to say them; this view reads the same
  // section, so it keeps saying them rather than letting the fact fall out of
  // the page with the view that used to carry it — the exact shape of defect
  // three rounds of #882's own review kept finding.
  const skipped = changesSection.archiveSkipped ?? [];
  return {
    ok: true,
    value: {
      changes,
      unreadable,
      note: SLICE_NOTE,
      archiveSkipped: { count: skipped.length, names: skipped.map((s) => s.name) },
    },
  };
}

export function sddForIssue(changesSection, issue) {
  if (!changesSection || typeof changesSection !== 'object') return { ok: false, reason: 'no changes section was given' };
  if (changesSection.ok !== true) return { ok: false, reason: changesSection.reason };
  const found = (changesSection.value ?? []).find((c) => c.issue === issue);
  if (!found) return { ok: false, reason: `no change directory names issue #${issue}` };
  // A ROW, not the raw snapshot entry. `readChanges()` emits `artefacts`
  // booleans and `{ok,value}` task envelopes; a caller wants the seven stages
  // and two numbers, which is exactly what every row in `buildSddModel` gets.
  // Returning the raw entry here made the card strip read a `stages` that has
  // never existed on it, and one card throwing takes the whole render with it.
  return { ok: true, value: buildChangeRow(found) };
}

export function buildSddModel(changesSection, { tier } = {}) {
  void tier;
  if (!changesSection || typeof changesSection !== 'object') {
    return { ok: false, reason: 'no changes section was given to the SDD model' };
  }
  if (changesSection.ok !== true) return { ok: false, reason: changesSection.reason };

  const changes = changesSection.value
    .map(buildChangeRow)
    .sort((a, b) => a.issue - b.issue || Number(a.archived) - Number(b.archived));

  // `archiveSkipped` rides in on the section snapshot.mjs's readChanges()
  // returns (review of PR 4, fix 1) — an archive/ dir that is not a bare
  // issue number, named rather than silently dropped from the rows above.
  const skipped = Array.isArray(changesSection.archiveSkipped) ? changesSection.archiveSkipped : [];
  const totals = {
    active: changes.filter((c) => !c.archived).length,
    archived: changes.filter((c) => c.archived).length,
    withViolations: changes.filter((c) => c.phaseOrder.violations.length > 0).length,
    archiveSkipped: { count: skipped.length, names: skipped.map((s) => s.name) },
  };

  return { ok: true, value: { changes, totals, sliceNote: SLICE_NOTE } };
}
