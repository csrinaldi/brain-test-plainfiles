// history.mjs — the merge/tag facts a History view timeline is built from
// (#882 R882-5). Pure parse, plus the edge: gatherHistoryFacts, reading
// through the same injected `_run` seam `release-debt.mjs` already uses —
// one more `git` call, not a new IO primitive.
//
// Either `git log` or `git tag` failing is this section's OWN {ok:false,
// reason} — never a partial commit list rendered as if it were the whole
// history (release-debt.mjs's own "an unknown must never be filed under a
// claim weaker than the one it prevented us from making" discipline,
// applied here to a whole section rather than one severity rung).

import { execFileSync } from 'node:child_process';

/** A trailing `(#N)` on a commit subject is a CITATION, not proof of a
 * squash-merged PR (fresh-context review of PR 4, blocker): measured
 * against this repository's own log, of 200 commits 147 carry a trailing
 * `(#N)`, and 17 of those resolve to `#882` — the issue itself, because
 * this ticket's own unsquashed commits cite the driving issue that way.
 * There is no textual signal separating a squash suffix from a
 * hand-written citation, so nothing downstream may assert "PR" from this
 * alone. A `(#N)` mid-subject is a citation to something else entirely,
 * not this commit's own reference, so the anchor is load-bearing. */
const CITED_REF = /\(#(\d+)\)\s*$/;

/** git's `%ai` format (`YYYY-MM-DD HH:MM:SS +ZZZZ`) is NOT ISO 8601 — no
 * spec requires a browser to parse it, and this module's output ships to
 * the browser (D9). `%ai` is only ever produced here (`parseCommitLog`),
 * so the normalization happens at the source, once, rather than asking
 * every downstream reader (`lib/history-model.mjs`'s sort, included) to
 * tolerate git's own shape. An input that doesn't match `%ai`'s exact
 * shape passes through UNCHANGED — never mangled into something that
 * merely looks fixed; a genuinely unparseable date is still that
 * caller's own problem to state, not this function's to hide.
 * (#1043 cold review correction 1) */
const GIT_AI_DATE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/;

export function normalizeGitDate(date) {
  if (typeof date !== 'string') return date;
  const m = GIT_AI_DATE.exec(date);
  if (!m) return date;
  const [, ymd, hms, offHour, offMin] = m;
  return `${ymd}T${hms}${offHour}:${offMin}`;
}

/** `git log --format='%H|%ai|%s'` output -> `{sha, date, subject, citedRef}`.
 * Splits on the first two `|` only — a subject itself may carry one.
 * `date` is normalized from git's `%ai` shape to a real ISO instant
 * (`normalizeGitDate`) before it ever leaves this module. `citedRef` is
 * the bare number a trailing `(#N)` names — an issue XOR a PR, whichever
 * the number actually resolves to on the forge; never asserted as one or
 * the other here. */
export function parseCommitLog(text) {
  return String(text ?? '').split('\n').filter(Boolean).map((line) => {
    const i1 = line.indexOf('|');
    const i2 = line.indexOf('|', i1 + 1);
    // Same rule as the tag parser above: a line this format did not produce is
    // kept and said, never sliced on a separator that is not there.
    if (i1 === -1 || i2 === -1) {
      return { sha: line, date: null, subject: '', citedRef: null, malformed: 'fewer than two "|" separators in the commit line' };
    }
    const sha = line.slice(0, i1);
    const date = normalizeGitDate(line.slice(i1 + 1, i2));
    const subject = line.slice(i2 + 1);
    const m = subject.match(CITED_REF);
    return { sha, date, subject, citedRef: m ? Number(m[1]) : null, malformed: null };
  });
}

/** `git tag --format='%(refname:short)|%(creatordate:iso-strict)'` output ->
 * `{name, date}`, in the order git already sorted them (`--sort=-creatordate`). */
export function parseTagList(text) {
  return String(text ?? '').split('\n').filter(Boolean).map((line) => {
    // `indexOf` answers -1 for a line with no separator, and slicing on that
    // silently drops the name's last character and leaks the rest into the
    // date — a release under a wrong title with a nonsense date, said by
    // nothing. A malformed line is KEPT (rule zero) and names its own
    // problem instead (#1043 round 4).
    const i = line.indexOf('|');
    if (i === -1) return { name: line, date: null, malformed: 'no "|" separator in the tag line' };
    return { name: line.slice(0, i), date: line.slice(i + 1), malformed: null };
  });
}

/** `git log -n 200` caps the merge history it reads — tags and ADR
 * amendments are read uncapped, so a capped, unlabeled commit list can
 * make an older release look like it landed with no merges around it,
 * and nothing says why (#1043 cold review correction 2). `requested` is
 * the cap this module asked git for; `reached` is whether the read
 * actually came back at that cap (the only cheap signal available from
 * the capped read alone — a repo with exactly `requested` commits reads
 * as "reached" too, which is the honest over-approximation, never the
 * under-approximation of silently claiming "not capped"); `total` is one
 * more cheap git call through the SAME injected `_run` seam, best-effort
 * only — a failing or unreadable count degrades to `null` (this section's
 * own read still succeeds; the caller says "the newest 200 of N" when
 * `total` is known, or the weaker-but-still-honest "the newest 200;
 * older merges are not listed" when it is not, never a claimed total
 * this code did not actually read). */
const COMMIT_LOG_CAP = 200;

function readTotalCommitCount(run) {
  try {
    // On a shallow clone this counts the fetched depth, not the branch's
    // history, so the count alone would understate it with no sign. The
    // shallow flag travels WITH the number rather than correcting it: what
    // the number counts is the honest thing to say (#1043 round 3).
    const raw = run('git', ['rev-list', '--count', 'HEAD']);
    const n = Number.parseInt(String(raw ?? '').trim(), 10);
    if (!Number.isFinite(n)) return { total: null, shallow: false };
    let shallow = false;
    try {
      shallow = String(run('git', ['rev-parse', '--is-shallow-repository']) ?? '').trim() === 'true';
    } catch {
      shallow = false;
    }
    return { total: n, shallow };
  } catch {
    return { total: null, shallow: false };
  }
}

/**
 * gatherHistoryFacts({root, _run}) -> {ok:true, value:{commits, tags, cap}} |
 * {ok:false, reason}. Never a thrown exception, and never a half-read
 * result folded into a "healthy" answer — either the `git log` or the
 * `git tag` read failing fails the whole section, said why. The cap's own
 * `total` sub-field is the one exception: a best-effort extra (see above),
 * never load-bearing for the section's own {ok:true}.
 */
export function gatherHistoryFacts({ root, _run } = {}) {
  const run = _run ?? ((file, args) => execFileSync(file, args, { cwd: root, encoding: 'utf8' }));

  let commits;
  try {
    commits = parseCommitLog(run('git', ['log', '--format=%H|%ai|%s', '-n', String(COMMIT_LOG_CAP)]));
  } catch (err) {
    return { ok: false, reason: `git log could not be read: ${err?.message ?? err}` };
  }

  let tags;
  try {
    tags = parseTagList(run('git', ['tag', '--sort=-creatordate', '--format=%(refname:short)|%(creatordate:iso-strict)']));
  } catch (err) {
    return { ok: false, reason: `git tag could not be read: ${err?.message ?? err}` };
  }

  const cap = { requested: COMMIT_LOG_CAP, reached: commits.length >= COMMIT_LOG_CAP, ...readTotalCommitCount(run) };

  return { ok: true, value: { commits, tags, cap } };
}
