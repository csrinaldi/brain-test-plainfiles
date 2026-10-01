// review-timeline.mjs — the reviews mode's own model (#998 R998-5). Pure, no
// DOM, no IO, imported by the browser and by node:test (D9). `reviewRows`
// (status/snapshot.mjs) already parsed every verdict and shaped its findings
// (`{id, severity, evidenceExcerpt, cites, file, line}` — `file`/`line` ARE
// real emitted fields, `verdict.mjs`'s `hasUsableAnchor`/REQ-405-2); this
// module only groups what it already produced into a thread per PR, oldest
// round first, plus the verdict queue — no parsing happens here.

/** Whatever a verdict declared, grouped — never filtered against a closed vocabulary (R998-5: an unknown severity is said, never dropped). */
function bySeverity(findings) {
  const counts = {};
  for (const f of findings) {
    const key = f.severity ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * A finding's own anchor as a provenance object (D14, amended — a
 * per-finding anchor DOES exist when the verdict carried one): `{path,
 * line}` when `file` is present, `null` otherwise — never dropped, only
 * `sourceStamp`/`sourceLabel` (provenance.mjs) turn a `null` into the said
 * "no source was recorded" text at render time, same as every other value.
 */
function findingSource(f) {
  return f.file ? { path: f.file, line: f.line } : null;
}

/** The protocol's own verdict enum (reviewer-protocol.md:264). Anything else is
 * kept, never dropped, only flagged (#1009 round 2). Exported so the render
 * layer says "unrecognised" with the SAME vocabulary this module flags it by —
 * one definition, two readers (#1009 round 3). */
export const KNOWN_VERDICTS = new Set(['APPROVE', 'REVISE', 'STOP']);

function shapeRound(v) {
  const findings = v.findings.map((f) => ({ ...f, source: findingSource(f) }));
  return {
    rev: v.rev,
    verdict: v.verdict,
    // A verdict word outside the protocol enum is kept verbatim above and
    // said here, never dropped and never treated as an implicit APPROVE
    // (#1009 cold review round 2 finding): the render layer reads this flag
    // to call it out rather than silently rendering it like any other word.
    unknownVerdict: !KNOWN_VERDICTS.has(v.verdict),
    headSha7: typeof v.head_sha === 'string' ? v.head_sha.slice(0, 7) : null,
    author: v.author,
    findings,
    // Carried forward, never dropped (#1009 cold review finding 1): a
    // malformed findings block reaches here as {findings: [], findingCount:
    // null, malformed: [...]} (reviewRows) — losing either field makes this
    // round indistinguishable from a clean verdict with zero findings.
    findingCount: v.findingCount ?? null,
    malformed: v.malformed ?? [],
    bySeverity: bySeverity(findings),
  };
}

/** A thread's rounds + verdict state, from its `reviewRows` row (or its absence). */
function threadState(reviewRow) {
  if (!reviewRow) return { rounds: [], latest: null, noRound: true };
  if (reviewRow.ok === false) return { rounds: [], latest: null, noRound: false, unreadable: { reason: reviewRow.reason } };
  const rounds = reviewRow.verdicts.map(shapeRound);
  return { rounds, latest: rounds.at(-1) ?? null, noRound: rounds.length === 0 };
}

/**
 * The three "waiting on a verdict right now" cases (R998-5, plus STOP added
 * on #1009 cold review round 2) — never an unreadable or an APPROVE-latest
 * thread, and never an unknown-verdict-latest thread either (a word outside
 * the protocol enum is said via `unknownVerdict` on the round, not silently
 * treated as still-open). Returns `{waiting, head, group, escalate}`, never
 * a bare string or null (#1009 cold review finding 2): `head` is `null` both
 * when nothing is waiting AND when a REVISE thread's head_sha could not be
 * parsed, so `waiting` — not a `!== null` check on the old string return —
 * is what the queue filter must read; collapsing those two `null`s into one
 * sentinel silently dropped an unparseable-head REVISE thread from the
 * queue. `group` orders the queue: STOP (a human must look now, protocol §7)
 * comes before REVISE, which comes before "no round posted" — a STOP thread
 * is more urgent than an open REVISE round, never mixed in by PR number
 * alone.
 */
function waitingOn(thread) {
  if (thread.noRound) return { waiting: true, head: null, group: 'noRound', escalate: false };
  if (thread.latest?.verdict === 'STOP') return { waiting: true, head: thread.latest.headSha7, group: 'stop', escalate: true };
  if (thread.latest?.verdict === 'REVISE') return { waiting: true, head: thread.latest.headSha7, group: 'revise', escalate: false };
  return { waiting: false, head: null, group: null, escalate: false };
}

// STOP jumps the queue ahead of everything else; REVISE and "no round
// posted" keep their pre-existing relative order (plain PR-ascending,
// un-split between the two — that ordering predates STOP and no finding
// asked to change it), so both share one rank below STOP. The sort below is
// stable, so within this shared rank the original PR-ascending order from
// `threads` survives untouched.
const QUEUE_GROUP_ORDER = { stop: 0, revise: 1, noRound: 1 };

/** The wait reason string for one queue group — STOP's is `'human escalation'`, distinct from both the REVISE head and `'no round posted'` (#1009 cold review round 2). */
function waitText(t, w) {
  if (w.group === 'noRound') return 'no round posted';
  if (w.group === 'stop') return 'human escalation';
  return w.head ?? 'head not readable';
}

/**
 * buildReviewTimeline(reviewsSection, prsSection, {issue}) -> {ok:true,
 * value:{threads, queue, totals}} | {ok:false, reason} — the failed
 * section's own reason, whichever of `prs`/`reviews` failed first.
 *
 * @param {{ok:boolean, value?:Array, reason?:string}} reviewsSection snapshot.reviews
 * @param {{ok:boolean, value?:Array, reason?:string}} prsSection snapshot.prs
 * @param {{issue?: number}} [opts] restrict the timeline to one issue's PR threads
 */
export function buildReviewTimeline(reviewsSection, prsSection, { issue } = {}) {
  if (!prsSection?.ok) return { ok: false, reason: prsSection?.reason ?? 'no PR section was given to the timeline' };
  if (!reviewsSection?.ok) return { ok: false, reason: reviewsSection?.reason ?? 'no reviews section was given to the timeline' };

  const reviewsByPr = new Map(reviewsSection.value.map((row) => [row.pr, row]));
  const prs = issue === undefined ? prsSection.value : prsSection.value.filter((p) => p.issue === issue);

  const threads = prs
    .map((p) => ({ pr: p.number, issue: p.issue, title: p.title, headBranch: p.headBranch, ...threadState(reviewsByPr.get(p.number)) }))
    .sort((a, b) => a.pr - b.pr);

  const waiting = threads
    .map((t) => ({ t, w: waitingOn(t) }))
    .filter(({ w }) => w.waiting)
    // STOP first (a human must look now, protocol §7), then REVISE, then
    // "no round posted" — each group oldest-PR first, since `threads` above
    // is already sorted by PR ascending and this sort is stable.
    .sort((a, b) => QUEUE_GROUP_ORDER[a.w.group] - QUEUE_GROUP_ORDER[b.w.group]);

  const queue = waiting.map(({ t, w }) => ({
    pr: t.pr,
    issue: t.issue,
    title: t.title,
    // `noRound`, `REVISE with an unreadable head` and `STOP` are all "head
    // is null/irrelevant" but distinct reasons (#1009 cold review finding 2,
    // round 2) — never the same wait string.
    wait: waitText(t, w),
    escalate: w.escalate,
    // #1059 region 05: the design's queue is a table, and its remaining
    // columns are facts of the thread — the rounds posted, the latest verdict
    // word and the head that verdict judged. They travel with the entry so a
    // row never has to reach back into `threads` to be filled, and a thread
    // with no round fills them with nothing rather than with a blank passed
    // off as a value.
    rounds: t.rounds.length,
    verdict: t.latest ? t.latest.verdict : null,
    headSha7: t.latest ? t.latest.headSha7 : null,
  }));

  const totals = {
    threads: threads.length,
    queue: queue.length,
    unreadable: threads.filter((t) => t.unreadable).length,
    // Counted separately from the rest of the waiting queue (#1009 cold
    // review round 2) — a STOP thread is a human-escalation state, not just
    // another item waiting on a machine verdict.
    stops: waiting.filter(({ w }) => w.group === 'stop').length,
  };

  return { ok: true, value: { threads, queue, totals } };
}
