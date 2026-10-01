// agents-clobber.test.mjs — REQ-397-6, the already-clobbered detector.
//
// Signed decision 2: repos that took brain's AGENTS.md in an earlier upgrade are
// carrying a silent loss right now, and protecting only from here on would leave
// that damage permanently invisible. Those repos are exactly the adopters M4
// exists for.
//
// The constraint that shapes every test below is REQ-397-6 Scenario 2, not
// Scenario 1: a detector that fired for every consumer would be noise, and noise
// is how a real warning gets ignored. So the negative controls outnumber the
// positive one on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectAgentsClobber } from './agents-clobber.mjs';

const BRAIN_HOME = '# brain HOME\n';
const THEIR_HOME = '# MY OWN HOME\n';
const BRAIN_AGENTS = '<!-- generated -->\n\n# brain HOME\n';

// ── REQ-397-6 Scenario 1 — the positive case ─────────────────────────────────

test('detects the clobber: they customised HOME, and AGENTS.md is byte-identical to brain\'s', () => {
  const r = detectAgentsClobber({
    onDisk: BRAIN_AGENTS,
    consumerHome: THEIR_HOME,
    brainHome: BRAIN_HOME,
    brainAgents: BRAIN_AGENTS,
  });

  assert.equal(r.clobbered, true);
  assert.equal(r.reason, 'identical-to-brain');
});

// ── REQ-397-6 Scenario 2 — the negative controls ─────────────────────────────

// The literal wording of Scenario 2. A consumer whose AGENTS.md has only ever
// been brain's has nothing of their own to lose, so there is nothing to report —
// even though their AGENTS.md IS byte-identical to brain's, which is the whole
// trap. Byte-identity alone is not evidence of loss.
test('negative control: a consumer who never customised HOME.md is NOT nagged', () => {
  const r = detectAgentsClobber({
    onDisk: BRAIN_AGENTS,
    consumerHome: BRAIN_HOME,   // identical to brain's — nothing of their own
    brainHome: BRAIN_HOME,
    brainAgents: BRAIN_AGENTS,
  });

  assert.equal(r.clobbered, false);
  assert.equal(r.reason, 'not-customised');
});

// A healthy customised consumer: their AGENTS.md is their own. This is the
// common steady state after #397 lands, and it must stay silent forever.
test('negative control: a customised consumer whose AGENTS.md is their own is NOT nagged', () => {
  const r = detectAgentsClobber({
    onDisk: '<!-- generated -->\n\n# MY OWN HOME\n',
    consumerHome: THEIR_HOME,
    brainHome: BRAIN_HOME,
    brainAgents: BRAIN_AGENTS,
  });

  assert.equal(r.clobbered, false);
  assert.equal(r.reason, 'differs-from-brain');
});

// Stale is NOT clobbered. They edited HOME.md and never regenerated, so their
// AGENTS.md matches neither their current inputs nor brain's. Reporting a
// clobber here would be a false accusation, and the upgrade regenerates it
// anyway.
test('negative control: a merely STALE AGENTS.md is not reported as clobbered', () => {
  const r = detectAgentsClobber({
    onDisk: '<!-- generated -->\n\n# my OLDER home\n',
    consumerHome: THEIR_HOME,
    brainHome: BRAIN_HOME,
    brainAgents: BRAIN_AGENTS,
  });

  assert.equal(r.clobbered, false);
  assert.equal(r.reason, 'differs-from-brain');
});

test('negative control: no AGENTS.md on disk is not a clobber', () => {
  const r = detectAgentsClobber({
    onDisk: null,
    consumerHome: THEIR_HOME,
    brainHome: BRAIN_HOME,
    brainAgents: BRAIN_AGENTS,
  });

  assert.equal(r.clobbered, false);
  assert.equal(r.reason, 'absent');
});

// ── Unknowables must not become accusations ──────────────────────────────────

// Every input here is read from a tree that may be missing, partial, or from a
// much older brain. When the comparison cannot be made, the answer is "no
// report", never "clobbered" — a detector that guesses under uncertainty is the
// noise Scenario 2 forbids.
test('an unreadable brain HOME.md yields no report rather than a guess', () => {
  const r = detectAgentsClobber({
    onDisk: BRAIN_AGENTS,
    consumerHome: THEIR_HOME,
    brainHome: null,
    brainAgents: BRAIN_AGENTS,
  });

  assert.equal(r.clobbered, false);
  assert.equal(r.reason, 'unknown');
});

test('an unreadable brain AGENTS.md yields no report rather than a guess', () => {
  const r = detectAgentsClobber({
    onDisk: BRAIN_AGENTS,
    consumerHome: THEIR_HOME,
    brainHome: BRAIN_HOME,
    brainAgents: null,
  });

  assert.equal(r.clobbered, false);
  assert.equal(r.reason, 'unknown');
});

test('an unreadable consumer HOME.md yields no report rather than a guess', () => {
  const r = detectAgentsClobber({
    onDisk: BRAIN_AGENTS,
    consumerHome: null,
    brainHome: BRAIN_HOME,
    brainAgents: BRAIN_AGENTS,
  });

  assert.equal(r.clobbered, false);
  assert.equal(r.reason, 'unknown');
});

test('never throws, whatever it is handed', () => {
  assert.doesNotThrow(() => detectAgentsClobber({}));
  assert.doesNotThrow(() => detectAgentsClobber());
});

// ── The documented limit ─────────────────────────────────────────────────────

// The detector compares against the INCOMING package's AGENTS.md. A consumer
// clobbered by an OLDER release carries that older artifact, which matches
// nothing we can reconstruct — so they are missed. This is a real gap, recorded
// in KNOWN-LIMITATIONS rather than left for someone to discover; closing it
// needs a manifest of historically shipped hashes, which is a new Tier-2
// artifact and its own decision.
test('KNOWN GAP: a consumer clobbered by an OLDER release is not detected', () => {
  const r = detectAgentsClobber({
    onDisk: '<!-- generated -->\n\n# brain HOME, two releases ago\n',
    consumerHome: THEIR_HOME,
    brainHome: BRAIN_HOME,
    brainAgents: BRAIN_AGENTS,
  });

  // Documented, not desired. If this ever starts returning true, the mechanism
  // changed and KNOWN-LIMITATIONS must change with it.
  assert.equal(r.clobbered, false);
});
