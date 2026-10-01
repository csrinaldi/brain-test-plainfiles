import { test } from 'node:test';
import assert from 'node:assert/strict';

import { releaseDebt, classifyCommits } from './release-debt.mjs';

const joined = (r) => r.lines.join('\n');

// ── R860-1: a dormant migration is the strongest signal ─────────────────────

test('#860: migrations above the published version are named as unreachable', () => {
  const r = releaseDebt({
    packageVersion: '1.1.0',
    migrationVersions: ['0.10.0', '1.2.0', '1.3.0', '1.4.0'],
    commits: [], tag: 'v1.1.0',
  });
  assert.equal(r.severity, 'migration', 'the strongest of the three');
  const out = joined(r);
  assert.match(out, /1\.2\.0.*1\.3\.0.*1\.4\.0/s, 'every dormant version is named');
  assert.match(out, /unreachable|dead/i, 'and what that means for a consumer');
  assert.doesNotMatch(out, /0\.10\.0/, 'a migration at or below the package version is not debt');
});

test('#860: published up to the tail reports no migration debt', () => {
  const r = releaseDebt({
    packageVersion: '1.4.0', migrationVersions: ['1.2.0', '1.3.0', '1.4.0'],
    commits: [], tag: 'v1.4.0',
  });
  assert.notEqual(r.severity, 'migration');
});

// ── R860-2: ordinary drift, reported as drift ───────────────────────────────

test('#860: feats and fixes since the tag are owed, not urgent', () => {
  const commits = [
    'feat(348): capability honesty', 'feat(124): human signature', 'feat(336): port audit',
    'fix(603): tier exit code', 'fix(853): tag ancestry', 'fix(850): npm audit', 'fix(812): dogfood boundary',
  ];
  const r = releaseDebt({ packageVersion: '1.4.0', migrationVersions: ['1.4.0'], commits, tag: 'v1.4.0' });
  assert.equal(r.severity, 'drift');
  const out = joined(r);
  assert.match(out, /7 commit/, 'the count');
  assert.match(out, /3 feat/, 'and its shape');
  assert.match(out, /4 fix/);
  assert.match(out, /owed but not urgent/i, 'stated as what it is — a repo mid-cycle is healthy');
});

test('#860: nothing since the tag is up to date', () => {
  const r = releaseDebt({ packageVersion: '1.4.0', migrationVersions: ['1.4.0'], commits: [], tag: 'v1.4.0' });
  assert.equal(r.severity, 'none');
  assert.match(joined(r), /up to date/);
});

test('#860: internal-only work reports NOTHING — a line that fires for everything is unread', () => {
  const commits = ['chore(memory): sync', 'test(x): add a case', 'docs(y): reword', 'ci(z): bump'];
  const r = releaseDebt({ packageVersion: '1.4.0', migrationVersions: ['1.4.0'], commits, tag: 'v1.4.0' });
  assert.equal(r.severity, 'none', 'hygiene accumulates; it does not owe a release');
  assert.doesNotMatch(joined(r), /owed/i);
});

test('#860: commit classification reads the conventional prefix and nothing else', () => {
  assert.deepEqual(classifyCommits(['feat(a): x', 'fix: y', 'chore: z', 'no prefix at all']),
    { feat: 1, fix: 2, internal: 1 },
    'an unprefixed subject counts as a FIX — the safe direction: it may be consumer-visible, '
    + 'and under-reporting debt is the failure this ticket exists to end');
});

// ── R860-3: absent evidence is reported as absent ───────────────────────────

test('#860: no tag is NOT "up to date" — it is not comparable', () => {
  const r = releaseDebt({ packageVersion: '1.4.0', migrationVersions: ['1.4.0'], commits: [], tag: null });
  assert.equal(r.severity, 'uncomparable');
  assert.match(joined(r), /could not be compared|no release tag/i);
  assert.doesNotMatch(joined(r), /up to date/, 'the strongest claim from the weakest evidence');
});

test('#860: an unreadable migration list reports its half and keeps the other', () => {
  const r = releaseDebt({
    packageVersion: '1.4.0', migrationVersions: null,
    commits: ['feat(a): x'], tag: 'v1.4.0',
  });
  const out = joined(r);
  assert.match(out, /migration list could not be read/i, 'the half that failed says so, in the message the module actually prints');
  assert.match(out, /1 commit/, 'and the half that worked still reports');
});

test('#860: brain:status prints the debt through the injected facts seam', async () => {
  const { runStatus } = await import('./cli.mjs');
  const lines = [];
  await runStatus({
    log: (s) => lines.push(s),
    deps: {
      releaseFacts: {
        packageVersion: '1.1.0',
        migrationVersions: ['1.2.0', '1.3.0', '1.4.0'],
        commits: [], tag: 'v1.1.0',
      },
    },
  }).catch(() => {});
  const out = lines.join('\n');
  assert.match(out, /DEBT — 3 migration/, 'the dormant case reaches the surface');
  assert.match(out, /UNREACHABLE/, 'saying what it costs a consumer');
});

test('#860 (round 1): an unreadable package version degrades — it never INVENTS debt', () => {
  // Reproduced before the fix: compareSemver(v, null) parses to 0.0.0, so every
  // migration compared greater and the report announced "3 migration(s)
  // promoted above the published null". Three inputs, three degradations — the
  // first cut guarded two. A module about honest reporting may not manufacture
  // an alarm from an input it could not read.
  const r = releaseDebt({
    packageVersion: null,
    migrationVersions: ['1.2.0', '1.3.0', '1.4.0'],
    commits: [], tag: 'v1.1.0',
  });
  assert.notEqual(r.severity, 'migration', 'absent evidence is not evidence of debt');
  const out = r.lines.join('\n');
  assert.match(out, /package version could not be read/, 'it says which half failed');
  assert.doesNotMatch(out, /published null/, 'and never renders the unread value as a fact');
});

test('#860 (round 1): the other half still reports when the version is unreadable', () => {
  const r = releaseDebt({
    packageVersion: null, migrationVersions: ['1.4.0'],
    commits: ['feat(a): x', 'fix(b): y'], tag: 'v1.4.0',
  });
  const out = r.lines.join('\n');
  assert.match(out, /could not be read/, 'the failed half says so');
  assert.match(out, /2 commit\(s\).*1 feat, 1 fix/, 'and the half that worked keeps reporting');
});

test('#860 (round 2): an unreadable commit log is UNKNOWN drift, never "up to date"', () => {
  // The fourth input, and round 1 had just fixed the third. `commits` is null
  // exactly when the git log read threw; folding it to [] claimed health from
  // evidence never read.
  const r = releaseDebt({ packageVersion: '1.4.0', migrationVersions: ['1.4.0'], commits: null, tag: 'v1.4.0' });
  assert.notEqual(r.severity, 'none');
  const out = r.lines.join('\n');
  assert.match(out, /commit log.*could not be read/i);
  assert.doesNotMatch(out, /up to date/, 'the claim R860-3 exists to forbid');
});

test('#860 (round 2): a dormant migration still reports when the log is unreadable', () => {
  const r = releaseDebt({ packageVersion: '1.1.0', migrationVersions: ['1.2.0'], commits: null, tag: 'v1.1.0' });
  assert.equal(r.severity, 'migration', 'the half that COULD be read keeps its severity');
  assert.match(r.lines.join('\n'), /1\.2\.0/);
});

// ── round 2, cold-3: the gatherer is tested through its own seam ─────────────
// design D1 claims this mirrors `stranded.mjs`, whose test drives its gatherer
// through the injected seam. Half a shape was mirrored.

test('#860: gatherReleaseFacts reads all four facts through its injected seams', async () => {
  const { gatherReleaseFacts } = await import('./release-debt.mjs');
  const calls = [];
  const facts = gatherReleaseFacts({
    root: '/nowhere',
    _read: (p) => {
      if (p.endsWith('package.json')) return '{"version":"9.9.9"}';
      if (p.includes('config-migrations')) return "  { version: '1.0.0' },\n  { version: \"2.0.0\" },";
      throw new Error(`unexpected read: ${p}`);
    },
    _run: (file, args) => {
      calls.push(args.join(' '));
      return args.includes('describe') ? 'v9.0.0\n' : 'feat(a): x\nfix(b): y\n';
    },
  });
  assert.equal(facts.packageVersion, '9.9.9');
  assert.deepEqual(facts.migrationVersions, ['1.0.0', '2.0.0'], 'both quote styles are scraped');
  assert.equal(facts.tag, 'v9.0.0');
  assert.deepEqual(facts.commits, ['feat(a): x', 'fix(b): y']);
  assert.ok(calls.some((c) => c.includes('--no-merges')), 'the log read excludes merges');
});

test('#860: gatherReleaseFacts never throws — each half degrades on its own', async () => {
  const { gatherReleaseFacts } = await import('./release-debt.mjs');
  const facts = gatherReleaseFacts({
    root: '/nowhere',
    _read: () => { throw new Error('no such file'); },
    _run: () => { throw new Error('not a git repo'); },
  });
  assert.deepEqual(facts, { packageVersion: null, migrationVersions: null, commits: null, tag: null },
    'four unreadable facts, four nulls, and no exception escaping into brain:status');
});

// ── round 3: severity is a report too ───────────────────────────────────────
// The lines degraded for all four facts; the returned severity did not. A
// caller keying off severity would have read unread evidence as health.

test('#860 (round 3): an unread migration list is never severity "none"', () => {
  const r = releaseDebt({ packageVersion: '1.4.0', migrationVersions: null, commits: [], tag: 'v1.4.0' });
  assert.match(r.lines.join('\n'), /migration list could not be read/);
  assert.notEqual(r.severity, 'none', 'the value a genuinely clean tree returns');
  assert.equal(r.severity, 'uncomparable');
});

test('#860 (round 3): an unread package version is never severity "none"', () => {
  const r = releaseDebt({ packageVersion: null, migrationVersions: ['1.0.0'], commits: [], tag: 'v1.0.0' });
  assert.equal(r.severity, 'uncomparable');
});

test('#860 (round 3): known debt still outranks an unread fact', () => {
  const r = releaseDebt({ packageVersion: '1.1.0', migrationVersions: ['1.2.0'], commits: null, tag: 'v1.1.0' });
  assert.equal(r.severity, 'migration', 'what WAS read keeps its severity');
});

test('#860 (round 3): a genuinely clean tree still reports "none"', () => {
  const r = releaseDebt({ packageVersion: '1.4.0', migrationVersions: ['1.4.0'], commits: [], tag: 'v1.4.0' });
  assert.equal(r.severity, 'none', 'degrading everything would make the signal useless');
  assert.match(r.lines.join('\n'), /up to date/);
});

// ── round 4: the invariant, over the WHOLE input space ──────────────────────
// Four rounds of review found the same bug family four times, each in a
// combination no hand-picked test happened to cover. A fifth case would have
// been a fifth guess. This enumerates every combination of the four facts and
// asserts the rule itself, so there is no combination left to guess at.

test('#860: no unread fact is EVER filed as drift or health, across all inputs', () => {
  const AXES = {
    packageVersion: [['read', '1.4.0'], ['unread', null]],
    migrationVersions: [['read', ['1.4.0']], ['read-dormant', ['1.9.0']], ['unread', null]],
    commits: [['read-empty', []], ['read-shipping', ['feat(a): x']], ['read-internal', ['chore(a): x']], ['unread', null]],
    tag: [['read', 'v1.4.0'], ['unread', null]],
  };
  let checked = 0;
  for (const [pvK, pv] of AXES.packageVersion)
    for (const [mvK, mv] of AXES.migrationVersions)
      for (const [cK, c] of AXES.commits)
        for (const [tK, t] of AXES.tag) {
          const where = `packageVersion=${pvK} migrationVersions=${mvK} commits=${cK} tag=${tK}`;
          const r = releaseDebt({ packageVersion: pv, migrationVersions: mv, commits: c, tag: t });
          checked += 1;

          assert.ok(r.lines.length > 0, `${where}: reported nothing at all`);

          // `commits` is only read once a tag exists, so it can only go unread
          // where one does — anything else is not a fact this run needed.
          const unread = pvK === 'unread' || mvK === 'unread' || tK === 'unread'
            || (cK === 'unread' && tK === 'read');

          if (unread) {
            assert.ok(['migration', 'uncomparable'].includes(r.severity),
              `${where}: unread evidence filed as '${r.severity}' — the R860-3 claim`);
          } else {
            assert.ok(['migration', 'drift', 'none'].includes(r.severity),
              `${where}: four readable facts yielded '${r.severity}'`);
          }

          // R860-1: known debt is the strongest signal and outranks everything.
          if (mvK === 'read-dormant' && pvK === 'read') {
            assert.equal(r.severity, 'migration', `${where}: real debt demoted`);
          }
        }
  assert.equal(checked, 48, 'the whole space, not a sample');
});
