// drawer-model.mjs — `GET /api/change/{issue}` turned into the six tabs the
// inspector renders (#881 PR 4 / B2, R881-8, A3; grown to six by #998
// R998-6's `sdd` and `records`). Pure, imported by the browser AND by
// node:test (D9).
//
// `change-route.mjs` already did the IO and the parsing; what is left is the
// last mile the DOM needs, and it is exactly the part that is easy to get
// quietly wrong:
//
//   * every entry carries a SOURCE STRING, never an object and never an
//     empty one — A3 asks for the path or the URL beside every value, so a
//     value whose source was lost says that instead of rendering a blank;
//   * a tab that failed keeps its reason AND its expected path (the "no
//     change dir" case names the glob an operator can paste into a shell);
//   * a review thread that could not be read is an ENTRY, not a skip —
//     skipping it reads as "no rounds were ever posted"
//     (`evidence-reader-empty-on-failure.md`, R881-9).
//
// One entry shape for all six tabs — `{title, detail, source, pending,
// done?, children?}` — so `app.js` renders every tab with one loop and has
// no per-tab branch to get wrong.

// #998 R998-6, design.md's "ship six (spec, sdd, tasks, memory, reviews,
// records)" ruling: the id stays `workingMemory` (unchanged since #881), the
// design's prose shorthand "memory" refers to that same tab.
export const TAB_IDS = ['spec', 'sdd', 'tasks', 'workingMemory', 'reviews', 'records'];
const TAB_LABELS = { spec: 'Spec', sdd: 'SDD', tasks: 'Tasks', workingMemory: 'Working memory', reviews: 'Reviews', records: 'Records' };

// A3: `sourceLabel` lives in provenance.mjs since #998; re-exported so every
// importer of this module keeps working. `sourceStamp` is additive (#998
// R998-2): `source` stays the same plain string every existing reader
// already gets, `sourceStamp` is the design's bracketed form the door's
// entries render from PR 2 on, with the href a forge/link chip may carry.
import { sourceLabel, sourceStamp } from './provenance.mjs';
import { KNOWN_VERDICTS } from './review-timeline.mjs';
export { sourceLabel };

function entry({ title, detail, source, pending = false, ...rest }) {
  return { title, detail, source: sourceLabel(source), sourceStamp: sourceStamp(source), pending, ...rest };
}

/** A failed tab: the reason stays, and so does whatever path the failure knew about. */
function failedTab(id, tabView, entries = []) {
  return { id, label: TAB_LABELS[id], ok: false, reason: tabView.reason, source: tabView.source ? sourceLabel(tabView.source) : null, entries, note: tabView.sourceNote ?? null };
}

/**
 * The lines `spec-cards.mjs` could not attach to a scenario (#1067 cold
 * review, finding cold-1). The parser collected them so a `WHEN` would stop
 * being dropped silently; collecting a fact and never showing it is not a fix,
 * it is the same silence one module further along. Each one carries the line
 * as written and the heading it was missing, sourced to its own line number so
 * the author can go straight to it.
 */
function orphanEntries(orphans) {
  return (orphans ?? []).map((orphan) => entry({
    title: orphan.text,
    detail: orphan.reason,
    source: orphan.source,
    pending: true,
  }));
}

function specEntries(cards) {
  return cards.map((card) => entry({
    title: `${card.id} — ${card.title}`,
    source: card.source,
    children: (card.scenarios ?? []).map((scenario) => entry({
      title: scenario.name,
      detail: `WHEN ${scenario.when ?? '(nothing stated)'} / THEN ${scenario.then ?? '(nothing stated)'}`,
      source: scenario.source,
      pending: scenario.complete !== true,
    })),
  }));
}

function taskEntries(items) {
  return items.map((item) => entry({
    title: item.text,
    // `change-route.mjs` attaches `{ok:false, reason}` per row when the blame
    // failed: the row still renders in full, and the missing attribution is
    // said here rather than folded into a silent "unknown".
    detail: item.attribution?.ok
      ? `${item.attribution.value.actor ?? 'unknown'}${item.attribution.value.ts ? ` at ${item.attribution.value.ts}` : ''}`
      : `attribution unavailable: ${item.attribution?.reason ?? 'no attribution was attached'}`,
    source: item.source,
    done: item.done === true,
    pending: item.done !== true,
  }));
}

function workingMemoryEntries(fields) {
  return Object.entries(fields).map(([name, field]) => entry({
    title: name,
    detail: field.ok ? String(field.value) : field.reason,
    source: field.source,
    pending: !field.ok,
  }));
}

/**
 * One child row per finding (#998 R998-5) — severity and id in the title,
 * the excerpt and cites in the detail. D14 originally read "no per-finding
 * anchor exists in this provider" — wrong, measured against PR #1006's
 * posted verdict (verdict.mjs's `hasUsableAnchor`, REQ-405-2): a finding
 * carrying `file`/`line` gets its OWN `{path, line}` source, rendered
 * through the same `sourceStamp`/`sourceLabel` helper as every other value
 * on this page; only a finding without one falls back to the round's own
 * source (the PR comment URL).
 */
function findingEntries(round) {
  return (round.findings ?? []).map((f) => entry({
    title: `${f.severity ?? 'unknown'} — ${f.id ?? '?'}`,
    detail: `${f.evidenceExcerpt ?? ''}${f.cites ? ` (cites ${f.cites})` : ''}`,
    source: f.file ? { path: f.file, line: f.line } : round.source,
  }));
}

/**
 * One document, ready for the DOM (#1198): its state, the `path @ commit`
 * stamp, the wording a reader sees when it cannot be shown, the truncation
 * note and the text. A document that is missing or unreadable carries NO text
 * and NO invented commit, and its two wordings differ — an empty body would
 * read as "the file has nothing in it" (R1198-2).
 */
export function documentWording(doc) {
  const file = String(doc.path ?? '').split('/').pop();
  const ref = doc.ref ?? 'the change branch';
  if (doc.state === 'missing') return `${file} is not committed at ${ref}`;
  if (doc.state === 'unreadable') return `${file} could not be read at ${ref}: ${doc.reason ?? 'no reason was given'}`;
  return null;
}

function documentView(key, doc) {
  const readable = doc.state === 'present' || doc.state === 'truncated';
  const wording = documentWording(doc);
  return {
    key,
    state: doc.state,
    stamp: readable && doc.commit ? `${doc.path} @ ${doc.commit.slice(0, 12)}` : doc.path,
    wording,
    note: readable ? doc.note ?? null : null,
    text: readable ? doc.text ?? '' : null,
  };
}

/** The sdd tab's entries (#998 R998-6): the change's own seven-stage raw presence, `change-route.mjs`'s `buildSddTab`, each stage that IS a document carrying it (#1198). */
function sddEntries(items, documents) {
  // #1059 region 08: the design numbers the stages and marks each one, so a
  // gap in the middle of the lifecycle is visible at a glance rather than
  // inferred by counting names. The position is the stage's place in the
  // order the reader was given, not an index into whatever was returned.
  const rows = items.map((item, i) => entry({
    position: i + 1,
    mark: item.present ? '\u2713' : '\u2014',
    title: item.stage,
    // #1059: the file the stage IS, beside its name. The tab used to say
    // "design — missing" and leave the reader to know that design means
    // `design.md`; a missing stage is only actionable when the file it would
    // be is on screen.
    file: item.file ?? null,
    detail: item.present ? 'present' : 'missing',
    source: item.source,
    done: item.present,
    pending: !item.present,
    // `archive` is a lifecycle stage, never a document (R1198-1).
    document: documents?.[item.stage] ? documentView(item.stage, documents[item.stage]) : null,
  }));
  // Reachable from the SDD tab as an unnumbered row after the seven stages
  // (D10). Present only when the route answered with it, so a view that
  // predates documents keeps its seven rows.
  const resume = documents?.resume;
  if (resume) {
    const view = documentView('resume', resume);
    rows.push(entry({
      title: 'working memory \u2014 resume.md',
      file: 'resume.md',
      detail: view.state === 'present' || view.state === 'truncated' ? 'present' : view.state,
      source: { path: resume.ref ? `${resume.ref}:resume.md` : 'resume.md' },
      pending: view.text === null,
      document: view,
    }));
  }
  return rows;
}

/**
 * The declared slice plan that rides the sdd tab (#1059 region 08). A change
 * with no plan carries the reason rather than an empty list, and the note the
 * route wrote — "what each PR did with its slice is not read" — travels with
 * it, because a drawn slice must never read as a merged one.
 */
function sliceEntries(slices) {
  if (!slices || typeof slices !== 'object') return { ok: false, reason: 'this change carries no slice plan' };
  if (slices.ok !== true) return { ok: false, reason: slices.reason };
  return {
    ok: true,
    note: slices.note ?? null,
    entries: (slices.value ?? []).map((slice) => entry({
      title: `slice ${slice.slice}`,
      detail: [slice.claims.join(', '), slice.terminalPr].filter(Boolean).join(' · '),
      source: slice.source,
    })),
  };
}

/** The records tab's entries (#998 R998-6): this issue's own memory records, newest first (`change-route.mjs`'s `buildRecordsTab`). */
function recordsEntries(items) {
  return items.map((item) => entry({
    title: `${item.type ?? 'record'} — ${item.id ?? '?'}`,
    detail: `${item.actor ?? 'unknown'} (${item.actorKind ?? 'unknown'})${item.supersedes ? `, supersedes ${item.supersedes}` : ''}${item.ts ? `, ${item.ts}` : ''}`,
    source: item.source,
  }));
}

function reviewEntries(rounds, unreadable) {
  const read = rounds.map((round) => {
    const countPart = round.findingCount === null ? 'unknown finding count' : `${round.findingCount} finding(s)`;
    // A malformed findings block is named explicitly, not folded into the
    // generic "unknown finding count" phrase (#1009 cold review finding 1):
    // `round.malformed` names WHICH keys were unreadable, and dropping that
    // name here would leave this row indistinguishable from a round whose
    // finding count was merely uncomputable for some other reason.
    // A STOP round names the human escalation explicitly (#1009 cold review
    // round 2, reviewer-protocol.md §7's "a human must look now" state) —
    // the same word app.js's renderReviewRound puts beside the mark, so the
    // drawer never says less about a STOP round than the canvas does.
    // A word outside the protocol enum keeps its spelling in the title and is
    // NAMED here, from the same set review-timeline.mjs flags it by — a drawer
    // that rendered it like an ordinary REVISE would say less than the canvas
    // (#1009 cold review round 3).
    const tail = `${round.author ?? 'unknown author'}, ${countPart}${round.head_sha ? `, head ${round.head_sha}` : ''}`;
    const detail = round.malformed?.length
      ? `findings block unreadable: ${round.malformed.join(', ')} (${countPart})`
      : !KNOWN_VERDICTS.has(round.verdict)
        ? `unrecognised verdict word — ${tail}`
        : round.verdict === 'STOP'
          ? `human escalation — ${tail}`
          : tail;
    return entry({
      title: `#${round.pr} rev ${round.rev} — ${round.verdict}`,
      detail,
      source: round.source,
      children: findingEntries(round),
    });
  });
  // After the rounds that WERE read, never instead of them.
  const missed = unreadable.map((thread) => entry({
    title: `#${thread.pr} — unreadable`,
    detail: `this thread could not be read: ${thread.reason}`,
    source: thread.source,
    pending: true,
  }));
  return [...read, ...missed];
}

/**
 * buildDrawerModel(changeView) -> {ok:true, value:{issue, changeDir, tabs}} |
 * {ok:false, reason}
 *
 * @param {{ok:boolean, value?:object, reason?:string}} changeView the parsed `GET /api/change/{issue}` body
 */
export function buildDrawerModel(changeView) {
  if (!changeView || typeof changeView !== 'object') return { ok: false, reason: 'no change view was given to the drawer' };
  if (changeView.ok !== true) return { ok: false, reason: changeView.reason };
  const { issue, changeDir, spec, sdd, tasks, workingMemory, reviews, records, documents } = changeView.value;

  const tabs = [
    spec.ok ? { id: 'spec', label: TAB_LABELS.spec, ok: true, reason: null, source: null, note: spec.note ?? null, entries: specEntries(spec.value), orphans: orphanEntries(spec.orphans) } : failedTab('spec', spec),
    sdd.ok ? { id: 'sdd', label: TAB_LABELS.sdd, ok: true, reason: null, source: null, note: null, entries: sddEntries(sdd.value, documents), slices: sliceEntries(sdd.slices) } : failedTab('sdd', sdd),
    tasks.ok ? { id: 'tasks', label: TAB_LABELS.tasks, ok: true, reason: null, source: null, note: tasks.note ?? null, entries: taskEntries(tasks.value) } : failedTab('tasks', tasks),
    workingMemory.ok
      ? { id: 'workingMemory', label: TAB_LABELS.workingMemory, ok: true, reason: null, source: null, note: null, entries: workingMemoryEntries(workingMemory.value) }
      : failedTab('workingMemory', workingMemory),
    reviews.ok
      ? { id: 'reviews', label: TAB_LABELS.reviews, ok: true, reason: null, source: null, note: reviews.sourceNote ?? null, entries: reviewEntries(reviews.value ?? [], reviews.unreadable ?? []) }
      : failedTab('reviews', reviews, reviewEntries([], reviews.unreadable ?? [])),
    records.ok ? { id: 'records', label: TAB_LABELS.records, ok: true, reason: null, source: null, note: null, entries: recordsEntries(records.value) } : failedTab('records', records),
  ];

  return { ok: true, value: { issue, changeDir, tabs } };
}
