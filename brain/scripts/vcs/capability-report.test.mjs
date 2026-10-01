import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyProbe, unappliedNote, CAPABILITY_STATES } from './capability-report.mjs';

// ── R348-1: probed, never priced ────────────────────────────────────────────

test('#348: a successful probe is available', () => {
  assert.deepEqual(classifyProbe({ ok: true }), { state: 'available' });
});

test('#348: a 404 is available ONLY where the feature says so', () => {
  const rules = { notFoundIsAvailable: true, remedies: [] };
  assert.equal(classifyProbe({ ok: false, stderr: 'HTTP 404: Not Found' }, rules).state, 'available',
    'nothing configured yet — the API answered, which is what available claims');
  assert.equal(classifyProbe({ ok: false, stderr: 'HTTP 404: Not Found' }, { remedies: [] }).state, 'unknown',
    'and NOT where a plan withholds the endpoint entirely — that opt-in is per axis');
});

test('#348: a matched refusal is unavailable WITH the remedy that would change it', () => {
  const r = classifyProbe(
    { ok: false, stderr: 'HTTP 403: upgrade to GitHub Pro' },
    { remedies: [{ match: /403|upgrade/i, remedy: 'GitHub Pro for private repos, or make the repo public' }] },
  );
  assert.equal(r.state, 'unavailable');
  assert.match(r.remedy, /Pro|public/, 'an operator is told what to do, not just that it failed');
});

test('#348: an unreadable probe is UNKNOWN, never unavailable', () => {
  const r = classifyProbe({ ok: false, stderr: 'dial tcp: lookup gitlab.com: no such host' }, { remedies: [] });
  assert.equal(r.state, 'unknown', 'a probe we could not read is not a probe that said no');
  assert.match(r.detail, /no such host/, 'and it carries what it saw');
  assert.equal(r.remedy, undefined, 'reporting a remedy here would send someone to fix a plan over a DNS failure');
});

test('#348: the two axes speak one vocabulary', () => {
  assert.deepEqual([...CAPABILITY_STATES], ['available', 'unavailable', 'unknown']);
});

// ── R348-2: the verb states its own partiality ──────────────────────────────

test('#348: nothing is reported unapplied when nothing was asked', () => {
  assert.equal(unappliedNote({ requiredReviews: 0, approvalCount: 'unavailable' }), null,
    'at lite requiredReviews is 0 — announcing an unapplied count nobody wanted is noise');
  assert.equal(unappliedNote({ approvalCount: 'unavailable' }), null);
});

test('#348: an asked-for count that could not be applied is NAMED in the result', () => {
  const note = unappliedNote({ requiredReviews: 1, approvalCount: 'unavailable', remedy: 'GitLab Premium approval rules' });
  assert.match(note, /protected/, 'what DID happen');
  assert.match(note, /NOT applied/, 'and what did not');
  assert.match(note, /Premium/, 'with the remedy');
});

test('#348: an unknown capability is reported as unknown, not as refused', () => {
  const note = unappliedNote({ requiredReviews: 1, approvalCount: 'unknown' });
  assert.match(note, /UNKNOWN/, 'we could not tell, and saying "not applied" would be a claim we cannot make');
});

test('#348: an available count reports nothing — the work was done', () => {
  assert.equal(unappliedNote({ requiredReviews: 1, approvalCount: 'available' }), null);
});
