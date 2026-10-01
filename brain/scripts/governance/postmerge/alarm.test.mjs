// alarm.test.mjs — the ONE tested alarm filer (REQ-TS-4/-5, issues #466/#474).
//
// The alarm path is the thing #466 proved nobody was watching: the job went red
// and no issue was ever filed. So the filer is a tested function with an
// injected `gh` runner, not three copies of bash nobody exercises.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fileAlarm } from './alarm.mjs';

/** A recording gh stub. `responses` maps 'verb sub' → {ok, stdout}. */
function recorder(responses = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    return { ok: true, stdout: '', stderr: '', ...(responses[key] ?? {}) };
  };
  run.calls = calls;
  return run;
}

test('fileAlarm: with no open issue for the label, CREATES one', () => {
  const run = recorder({ 'issue list': { ok: true, stdout: '' } });
  const res = fileAlarm('governance:audit-unrevertible', 'a title', '/tmp/body.md', run);

  assert.equal(res.filed, true);
  assert.equal(res.action, 'created');
  const created = run.calls.find((c) => c[0] === 'issue' && c[1] === 'create');
  assert.ok(created, `expected a gh issue create call, got:\n${JSON.stringify(run.calls)}`);
  assert.ok(created.includes('governance:audit-unrevertible'), 'the alarm must carry its label');
});

test('fileAlarm: with an OPEN issue for the label, COMMENTS instead of duplicating', () => {
  // A halt that persists across the daily cron must be one issue with N
  // comments, not N issues — otherwise the loud path becomes its own noise
  // problem and gets muted, which is how #462 stayed invisible for 12 days.
  const run = recorder({ 'issue list': { ok: true, stdout: '462' } });
  const res = fileAlarm('governance:audit-unrevertible', 'a title', '/tmp/body.md', run);

  assert.equal(res.action, 'commented');
  assert.ok(run.calls.some((c) => c[0] === 'issue' && c[1] === 'comment' && c.includes('462')),
    `expected a comment on #462, got:\n${JSON.stringify(run.calls)}`);
  assert.ok(!run.calls.some((c) => c[0] === 'issue' && c[1] === 'create'),
    'must NOT open a second issue for the same open alarm');
});

test('fileAlarm: a FAILED create is reported as not-filed (never a false success)', () => {
  // If this returned {filed:true} on failure, the backstop would believe the
  // alarm exists and the job would be red and silent again — the whole bug.
  const run = recorder({
    'issue list': { ok: true, stdout: '' },
    'issue create': { ok: false, stderr: 'HTTP 403: Resource not accessible by integration' },
  });
  const res = fileAlarm('governance:postmerge-unreported', 't', '/tmp/body.md', run);

  assert.equal(res.filed, false, 'a failed gh call must never report the alarm as filed');
  assert.match(res.reason, /403/, 'the real reason must survive for the operator');
});

test('fileAlarm: a FAILED comment is reported as not-filed', () => {
  const run = recorder({
    'issue list': { ok: true, stdout: '77' },
    'issue comment': { ok: false, stderr: 'network unreachable' },
  });
  const res = fileAlarm('governance:audit-unrevertible', 't', '/tmp/body.md', run);

  assert.equal(res.filed, false);
  assert.match(res.reason, /network unreachable/);
});

test('fileAlarm: a failing `label create` does NOT prevent the alarm', () => {
  // Refusing to file the alarm because the label could not be restyled would
  // trade a loud failure for a silent one.
  const run = recorder({
    'label create': { ok: false, stderr: 'label already exists' },
    'issue list': { ok: true, stdout: '' },
  });
  const res = fileAlarm('governance:audit-unrevertible', 't', '/tmp/body.md', run);

  assert.equal(res.filed, true, 'the alarm must still be filed when only the label styling failed');
});

test('fileAlarm: an unreadable issue list falls through to CREATE (never silently skips)', () => {
  // `gh issue list` failing must not be read as "an issue already exists".
  const run = recorder({ 'issue list': { ok: false, stdout: '', stderr: 'boom' } });
  const res = fileAlarm('governance:audit-unrevertible', 't', '/tmp/body.md', run);

  assert.equal(res.action, 'created',
    'a failed lookup must fall through to filing, never be mistaken for a deduped alarm');
});

// ── resolveAlarms (#1188): an alarm the workflow filed closes itself ──────────
//
// The demo's alarm issue (#4 in both consumer repos) stayed open after the audit
// recovered: fileAlarm only ever opened or commented, so a human had to notice a
// green run and close the issue by hand. The closer reuses fileAlarm's own reader
// (`findOpenAlarm`) for "is there an open alarm for this label", and writes
// through the VCS port.

import { resolveAlarms, findOpenAlarm, AUDIT_ALARM_LABELS, SWEEP_ALARM_LABELS } from './alarm.mjs';

function fakePort({ commentOk = true, closeOk = true } = {}) {
  const calls = [];
  return {
    calls,
    async issueComment(a) { calls.push(['comment', a]); return commentOk ? { url: 'https://x/c' } : { url: null, error: 'nope' }; },
    async issueClose(a) { calls.push(['close', a]); return closeOk ? { ok: true } : { ok: false, error: 'denied' }; },
  };
}
const RUN = 'https://github.com/o/r/actions/runs/99';

test('findOpenAlarm: the reader fileAlarm uses — open issue number for a label, else null', () => {
  assert.equal(findOpenAlarm('governance:x', recorder({ 'issue list': { ok: true, stdout: '4' } })), '4');
  assert.equal(findOpenAlarm('governance:x', recorder({ 'issue list': { ok: true, stdout: '' } })), null);
  assert.equal(findOpenAlarm('governance:x', recorder({ 'issue list': { ok: false, stdout: '' } })), null);
});

test('resolveAlarms: an open alarm + a passing run → comments the run link, then closes it', async () => {
  const port = fakePort();
  const run = recorder({ 'issue list': { ok: true, stdout: '4' } });
  const res = await resolveAlarms({
    labels: ['governance:audit-unrevertible'], runUrl: RUN, passing: true, vcs: port, project: 'o/r', run,
  });
  assert.deepEqual(res.closed, [{ label: 'governance:audit-unrevertible', number: 4 }]);
  assert.deepEqual(port.calls.map((c) => c[0]), ['comment', 'close']);
  assert.match(port.calls[0][1].body, /actions\/runs\/99/, 'the comment must link the passing run');
  assert.equal(port.calls[0][1].number, 4);
  assert.equal(port.calls[1][1].number, 4);
});

test('resolveAlarms: a still-failing run leaves the alarm open and touches nothing', async () => {
  const port = fakePort();
  const run = recorder({ 'issue list': { ok: true, stdout: '4' } });
  const res = await resolveAlarms({
    labels: ['governance:audit-unrevertible'], runUrl: RUN, passing: false, vcs: port, project: 'o/r', run,
  });
  assert.deepEqual(res.closed, []);
  assert.equal(port.calls.length, 0);
  assert.equal(run.calls.length, 0, 'not even a read: a failing run has nothing to resolve');
});

test('resolveAlarms: no open alarm for a label → nothing to do for it', async () => {
  const port = fakePort();
  const run = recorder({ 'issue list': { ok: true, stdout: '' } });
  const res = await resolveAlarms({ labels: ['governance:cursor-missing'], runUrl: RUN, passing: true, vcs: port, project: 'o/r', run });
  assert.deepEqual(res.closed, []);
  assert.equal(port.calls.length, 0);
});

test('resolveAlarms: a failed comment still closes (the resolution is the point), and says so', async () => {
  const port = fakePort({ commentOk: false });
  const run = recorder({ 'issue list': { ok: true, stdout: '4' } });
  const res = await resolveAlarms({ labels: ['governance:audit-uncomputable'], runUrl: RUN, passing: true, vcs: port, project: 'o/r', run });
  assert.equal(res.closed.length, 1);
  assert.match(res.warnings.join('\n'), /comment/);
});

test('resolveAlarms: a failed close is reported, never thrown, and the alarm stays counted open', async () => {
  const port = fakePort({ closeOk: false });
  const run = recorder({ 'issue list': { ok: true, stdout: '4' } });
  const res = await resolveAlarms({ labels: ['governance:audit-uncomputable'], runUrl: RUN, passing: true, vcs: port, project: 'o/r', run });
  assert.deepEqual(res.closed, []);
  assert.match(res.warnings.join('\n'), /could not close #4/);
});

test('every alarm label the workflow files is either auto-resolved by a clean audit or by a clean sweep (none is left to a human by omission)', async () => {
  const { readFileSync } = await import('node:fs');
  const yml = readFileSync(new URL('../../../../.github/workflows/governance-postmerge.yml', import.meta.url), 'utf8');
  const filed = new Set([...yml.matchAll(/label="(governance:[a-z-]+)"/g)].map((m) => m[1]));
  assert.ok(filed.size >= 6, `sanity: expected the workflow's alarm labels, got ${[...filed]}`);
  const covered = new Set([...AUDIT_ALARM_LABELS, ...SWEEP_ALARM_LABELS]);
  for (const l of filed) assert.ok(covered.has(l), `${l} is filed by the workflow but no clean run resolves it`);
});
