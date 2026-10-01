// release-debt.mjs — what is published, and what is not (#860).
//
// WHY THIS IS A MECHANISM AND NOT A DOCUMENT. There is no release-cadence rule
// in this repository — measured: zero milestones, no doctrine file — and each
// cut has been an ad-hoc decision. That cost something concrete: migrations
// 1.2.0, 1.3.0 and 1.4.0 sat promoted, signed and DEAD for weeks, because
// `migrateConfig` applies entries only up to the installed package version. A
// promoted-but-unpublished migration is code no consumer can reach, and nothing
// said so.
//
// A cadence policy in a `.md` is a hand-maintained fact whose failure mode is
// silence — which is the failure mode that produced the dormant migrations. So
// the debt is a LINE, in the shape #713's stranded-tracker report established:
// report, never refuse.
//
// Pure: facts in, lines out. The reading lives in the gatherer below.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareSemver } from '../lib/installer.mjs';

/** Prefixes that owe nothing: hygiene accumulates, it does not ship. */
const INTERNAL = /^(chore|test|docs|ci|build|style|refactor)\b/;

/**
 * Pure: the conventional-commit shape of a range.
 *
 * An UNPREFIXED subject counts as a fix, deliberately. It may be
 * consumer-visible, and under-reporting debt is the failure this module exists
 * to end — between over-reporting and a missing row, this counts the row.
 */
export function classifyCommits(subjects = []) {
  const out = { feat: 0, fix: 0, internal: 0 };
  for (const s of subjects) {
    const subject = String(s ?? '');
    if (/^feat\b/.test(subject)) out.feat += 1;
    else if (INTERNAL.test(subject)) out.internal += 1;
    else out.fix += 1;
  }
  return out;
}

/**
 * Pure: the release debt a set of facts declares.
 *
 * @param {{packageVersion: string, migrationVersions: string[]|null, commits: string[]|null, tag: string|null}} facts
 * @returns {{severity: 'migration'|'drift'|'none'|'uncomparable', lines: string[]}}
 */
export function releaseDebt({ packageVersion, migrationVersions, commits, tag } = {}) {
  const lines = [];

  // ── The strongest signal: code a consumer cannot reach ────────────────────
  let dormant = [];
  // FOUR inputs, four degradations, on BOTH channels. The first cut guarded the
  // migration list
  // and the tag and forgot this one — and the cost was not silence but a false
  // ALARM: `compareSemver(v, null)` parses to 0.0.0, so every migration read as
  // dormant and the report announced "promoted above the published null". A
  // module whose whole subject is honest reporting must not invent debt from an
  // input it could not read (review round 1) — nor call itself healthy on one
  // (rounds 2 and 3, once per channel).
  let unread = false;   // any fact this run could not read — see `severity` below
  if (!packageVersion) {
    unread = true;
    lines.push('release     package version could not be read — dormant migrations UNKNOWN');
  } else if (migrationVersions === null || migrationVersions === undefined) {
    unread = true;
    lines.push('release     migration list could not be read — dormant migrations UNKNOWN');
  } else {
    dormant = migrationVersions.filter((v) => compareSemver(v, packageVersion) > 0);
    if (dormant.length > 0) {
      lines.push(`release     DEBT — ${dormant.length} migration(s) promoted above the published ${packageVersion}`);
      lines.push(`            → ${dormant.join(', ')} are declared and UNREACHABLE until a release cut`);
    }
  }

  // ── Ordinary drift: owed, not urgent ──────────────────────────────────────
  if (!tag) {
    // Not "up to date": the strongest claim from the weakest evidence. Same
    // discipline as `uncomputable` in the gates and `undeclared` in the audit.
    lines.push('release     no release tag found — published state could not be compared');
    return { severity: dormant.length > 0 ? 'migration' : 'uncomparable', lines };
  }

  if (commits === null || commits === undefined) {
    // The FOURTH input, and round 1 had just fixed the third. `commits` is null
    // exactly when the `git log` read threw, and folding it to `[]` reported
    // "up to date" — health claimed from evidence never read, which is the one
    // thing R860-3 forbids. Guarding three of four inputs is not a degradation
    // policy; it is three accidents and a gap.
    lines.push(`release     commit log since ${tag} could not be read — drift UNKNOWN`);
    return { severity: dormant.length > 0 ? 'migration' : 'uncomparable', lines };
  }

  const shape = classifyCommits(commits);
  const shipping = shape.feat + shape.fix;
  if (shipping > 0) {
    const total = (commits ?? []).length;
    lines.push(
      `release     ${total} commit(s) since ${tag} — ${shape.feat} feat, ${shape.fix} fix`
      + `${shape.internal ? `, ${shape.internal} internal` : ''}: a release is owed but not urgent`,
    );
  }

  if (lines.length === 0) lines.push(`release     up to date (${packageVersion}, ${tag})`);

  // The rungs, ranked ONCE, strongest first. Round 3 taught severity to degrade
  // at all but ranked `unread` BELOW drift, so it was reachable only when
  // shipping === 0: with any shipping commit, "I could not check for a promoted
  // migration" was reported as "owed but not urgent" (round 4). That inverts
  // R860-1 — the fact left unread IS the strongest signal, and drift is by its
  // own wording the weakest. An unknown must never be filed under a claim
  // weaker than the one it prevented us from making.
  //
  // The invariant, held by the exhaustive matrix in the test file rather than
  // by one more hand-picked case: if ANY fact went unread, severity is
  // 'migration' or 'uncomparable' — never 'drift', never 'none'.
  const severity = dormant.length > 0 ? 'migration'
    : unread ? 'uncomparable'
    : shipping > 0 ? 'drift'
    : 'none';
  return { severity, lines };
}

// ── The edge: reading. Everything above is pure. ────────────────────────────

/**
 * Reads the three facts `releaseDebt` needs. Never throws: each half degrades
 * to its own "could not read" answer, so one unreadable input does not take the
 * other half's report with it.
 */
export function gatherReleaseFacts({ root, _run, _read } = {}) {
  const run = _run ?? ((file, args) => execFileSync(file, args, { cwd: root, encoding: 'utf8' }));
  const read = _read ?? ((p) => readFileSync(join(root, p), 'utf8'));

  let packageVersion = null;
  try { packageVersion = JSON.parse(read('package.json')).version; } catch { packageVersion = null; }

  let migrationVersions = null;
  try {
    const src = read('brain/core/config-migrations.mjs');
    migrationVersions = [...src.matchAll(/version:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  } catch { migrationVersions = null; }

  let tag = null;
  try { tag = String(run('git', ['describe', '--tags', '--abbrev=0'])).trim() || null; } catch { tag = null; }

  let commits = null;
  if (tag) {
    try {
      // `--no-merges`, following day-start.mjs's identical read. A merge subject
      // has no conventional-commit shape at all, so it landed in the `fix`
      // bucket and inflated both counts — and this repository still produces
      // non-squash merges (review round 2).
      commits = String(run('git', ['log', '--no-merges', '--format=%s', `${tag}..HEAD`])).split('\n').filter(Boolean);
    } catch { commits = null; }
  }

  return { packageVersion, migrationVersions, commits, tag };
}
