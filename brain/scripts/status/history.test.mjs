// history.test.mjs — gatherHistoryFacts's own facts, read through the same
// injected `_run` seam release-debt.mjs uses (#882 R882-5).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gatherHistoryFacts, parseCommitLog, parseTagList, normalizeGitDate } from './history.mjs';

// ── the pure parsers ─────────────────────────────────────────────────────

test('#882 R882-5: parseCommitLog reads sha|date|subject lines, citedRef parsed from a trailing (#N), date normalized from git\'s %ai shape to ISO (#1043 correction 1)', () => {
  const text = 'aaa1111|2026-09-10 10:00:00 +0000|feat(ui): the History view (#123)\n'
    + 'bbb2222|2026-09-09 09:00:00 +0000|chore: tidy\n';
  assert.deepEqual(parseCommitLog(text), [
    { sha: 'aaa1111', date: '2026-09-10T10:00:00+00:00', subject: 'feat(ui): the History view (#123)', citedRef: 123, malformed: null },
    { sha: 'bbb2222', date: '2026-09-09T09:00:00+00:00', subject: 'chore: tidy', citedRef: null, malformed: null },
  ]);
});

test('#882 R882-5: a (#N) in the middle of the subject is never read as the PR number — only a trailing one is (the trailing anchor)', () => {
  const text = 'ccc3333|2026-09-08 08:00:00 +0000|feat: mid-subject (#42) mention, not a PR suffix\n';
  assert.equal(parseCommitLog(text)[0].citedRef, null);
});

test('#882 R882-5: parseCommitLog on empty/blank input is an empty list, never null', () => {
  assert.deepEqual(parseCommitLog(''), []);
  assert.deepEqual(parseCommitLog('\n\n'), []);
});

test('#882 fresh-context review of PR 4, blocker: a commit fact never carries a prNumber key or the word "PR" — a trailing (#N) is a citation, this repo\'s own log mixes squash suffixes and hand-written issue citations with no way to tell them apart (measured: 200 commits, 147 with a trailing (#N), 17 of those resolving to #882 itself)', () => {
  const [commit] = parseCommitLog('aaa1111|2026-09-10 10:00:00 +0000|feat(ui): the History view (#882)\n');
  assert.equal(commit.citedRef, 882);
  assert.ok(!('prNumber' in commit), 'no prNumber key — the field is citedRef');
  assert.ok(!JSON.stringify(commit).includes('PR'), 'no commit fact claims "PR" anywhere in its own text');
});

// ── #1043 cold review correction 1: git's %ai is not ISO 8601 ──────────────

test('#1043 correction 1: normalizeGitDate turns the real %ai shape (YYYY-MM-DD HH:MM:SS +ZZZZ) into the ISO instant it names', () => {
  assert.equal(normalizeGitDate('2026-09-10 10:00:00 +0200'), '2026-09-10T10:00:00+02:00');
  assert.equal(Date.parse(normalizeGitDate('2026-09-10 10:00:00 +0200')), Date.parse('2026-09-10T08:00:00Z'), 'the normalized string parses to the correct UTC instant %ai named');
});

test('#1043 correction 1: normalizeGitDate passes through a string that does not match %ai\'s exact shape, unchanged — never mangling something that is not %ai', () => {
  assert.equal(normalizeGitDate('x'), 'x');
  assert.equal(normalizeGitDate('2026-09-10T00:00:00Z'), '2026-09-10T00:00:00Z');
  assert.equal(normalizeGitDate(null), null);
});

test('#1043 correction 1: parseCommitLog normalizes each commit\'s %ai date to ISO, so the model never depends on a browser tolerating git\'s own non-ISO shape', () => {
  const text = 'aaa1111|2026-09-10 10:00:00 +0200|feat(ui): x\n';
  const [commit] = parseCommitLog(text);
  assert.equal(commit.date, '2026-09-10T10:00:00+02:00');
  assert.ok(!Number.isNaN(Date.parse(commit.date)), 'the normalized date must be parseable');
});

test('#882 R882-5: parseTagList reads name|date lines, newest-sorted order preserved as given', () => {
  const text = 'v1.4.0|2026-09-01T00:00:00+00:00\nv1.3.0|2026-08-01T00:00:00+00:00\n';
  assert.deepEqual(parseTagList(text), [
    { name: 'v1.4.0', date: '2026-09-01T00:00:00+00:00', malformed: null },
    { name: 'v1.3.0', date: '2026-08-01T00:00:00+00:00', malformed: null },
  ]);
});

// ── the edge: gatherHistoryFacts ─────────────────────────────────────────

test('#882 R882-5: gatherHistoryFacts reads git log and git tag through its injected _run seam, same as release-debt.mjs', () => {
  const calls = [];
  const facts = gatherHistoryFacts({
    root: '/nowhere',
    _run: (file, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'log') return 'aaa1111|2026-09-10 10:00:00 +0000|feat(ui): the History view (#123)\n';
      return 'v1.4.0|2026-09-01T00:00:00+00:00\n';
    },
  });
  assert.equal(facts.ok, true);
  assert.deepEqual(facts.value.commits, [
    { sha: 'aaa1111', date: '2026-09-10T10:00:00+00:00', subject: 'feat(ui): the History view (#123)', citedRef: 123, malformed: null },
  ]);
  assert.deepEqual(facts.value.tags, [{ name: 'v1.4.0', date: '2026-09-01T00:00:00+00:00', malformed: null }]);
  assert.ok(calls[0].startsWith('log '), 'git log runs first');
  assert.ok(calls[1].startsWith('tag '), 'then git tag');
});

// ── #1043 cold review correction 2: the 200-commit cap must be SAID ────────

test('#1043 correction 2: a fixture whose git log hits the 200-commit cap says so on facts.value.cap', () => {
  const facts = gatherHistoryFacts({
    root: '/nowhere',
    _run: (file, args) => {
      if (args[0] === 'log') {
        const lines = Array.from({ length: 200 }, (_, i) => `sha${i}|2026-09-${String((i % 28) + 1).padStart(2, '0')} 00:00:00 +0000|commit ${i}`);
        return `${lines.join('\n')}\n`;
      }
      if (args[0] === 'rev-list') return '512\n';
      return '';
    },
  });
  assert.equal(facts.ok, true);
  assert.deepEqual(facts.value.cap, { requested: 200, reached: true, total: 512, shallow: false }, 'the total travels with what it counts: a shallow checkout\'s count is the fetched depth, not the history (#1043 round 3)');
});

test('#1043 correction 2: a fixture under the cap does NOT say the list is partial', () => {
  const facts = gatherHistoryFacts({
    root: '/nowhere',
    _run: (file, args) => {
      if (args[0] === 'log') return 'aaa1111|2026-09-10 10:00:00 +0000|feat(ui): x\n';
      if (args[0] === 'rev-list') return '1\n';
      return '';
    },
  });
  assert.equal(facts.ok, true);
  assert.equal(facts.value.cap.reached, false, 'a fixture with only 1 commit, well under the 200 cap, must not say the list is partial');
});

test('#1043 correction 2: a failing (or unreadable) total-count call degrades that ONE field only — the section still succeeds, total is honestly null rather than failing the whole read', () => {
  const facts = gatherHistoryFacts({
    root: '/nowhere',
    _run: (file, args) => {
      if (args[0] === 'log') return 'aaa1111|2026-09-10 10:00:00 +0000|feat(ui): x\n';
      if (args[0] === 'rev-list') throw new Error('boom');
      return '';
    },
  });
  assert.equal(facts.ok, true, 'the total commit count is a best-effort extra, not load-bearing for the whole section');
  assert.equal(facts.value.cap.total, null);
});

test('#882 R882-5: either git log or git tag throwing is this section\'s own {ok:false, reason} — never a partial list', () => {
  const logFails = gatherHistoryFacts({
    root: '/nowhere',
    _run: (file, args) => { if (args[0] === 'log') throw new Error('not a git repository'); return ''; },
  });
  assert.equal(logFails.ok, false);
  assert.match(logFails.reason, /git log/);

  const tagFails = gatherHistoryFacts({
    root: '/nowhere',
    _run: (file, args) => { if (args[0] === 'tag') throw new Error('boom'); return ''; },
  });
  assert.equal(tagFails.ok, false);
  assert.match(tagFails.reason, /git tag/);
});

// ── #1043 round 4 ──────────────────────────────────────────────────────────
// A line with no separator is malformed input. Slicing at indexOf('|') === -1
// drops the last character of the name and leaks the rest into the date, so a
// release renders under a wrong title with a nonsense date and nothing says so.
test('#1043 round 4: a tag line with no separator is said as malformed, never silently mangled', () => {
  const rows = parseTagList('v1.0.0|2026-09-18T10:00:00+00:00\nv1\n');
  assert.equal(rows.length, 2, 'the malformed line is kept, not dropped — rule zero');
  assert.deepEqual(rows[0], { name: 'v1.0.0', date: '2026-09-18T10:00:00+00:00', malformed: null });
  assert.equal(rows[1].malformed, 'no "|" separator in the tag line', 'the reason is said on the row');
  assert.equal(rows[1].name, 'v1', 'the whole line is kept as the name rather than cut at a separator that is not there');
  assert.equal(rows[1].date, null, 'and no date is invented from the name');
});

test('#1043 round 4: a commit line with no separators is said as malformed too', () => {
  const rows = parseCommitLog('abc|2026-09-18 10:00:00 +0000|feat: a thing\ngarbage\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].malformed, null);
  assert.equal(rows[1].malformed, 'fewer than two "|" separators in the commit line');
  assert.equal(rows[1].date, null);
});
