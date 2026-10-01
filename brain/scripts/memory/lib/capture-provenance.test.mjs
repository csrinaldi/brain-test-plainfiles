// capture-provenance.test.mjs — unit tests for the pure capture-time
// provenance resolvers (#738, design A1/A2; spec "a record carries its
// provenance").
//
// Pure: no fs, no child_process. Every git/env fact is injected by the
// caller (plainfiles.mjs, via lib/git-config.mjs + process.env).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_ENV_DEFAULT,
  AGENT_ENV_DEFAULTS,
  RESERVED_ACTORS,
  resolveActor,
  resolveActorKind,
  deriveIssue,
  composeSource,
} from './capture-provenance.mjs';
import { issueFromFuente } from './provenance.mjs';

// ---------------------------------------------------------------------------
// resolveActor
// ---------------------------------------------------------------------------

test('resolveActor: a configured handle resolves ok', () => {
  const r = resolveActor({ configured: '@csrinaldi' });
  assert.equal(r.ok, true);
  assert.equal(r.actor, '@csrinaldi');
});

for (const configured of [undefined, null, '', '   ']) {
  test(`resolveActor: unset/empty/whitespace (${JSON.stringify(configured)}) ⇒ reason 'unset'`, () => {
    const r = resolveActor({ configured });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unset');
  });
}

for (const configured of ['Cristian Rinaldi', 'csrinaldi', 'feat/x', 'csrinaldi@gmail.com']) {
  test(`resolveActor: non-handle-shaped (${configured}) ⇒ reason 'malformed'`, () => {
    const r = resolveActor({ configured });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'malformed');
  });
}

test("resolveActor: '@legacy' ⇒ reason 'reserved' (mints the export sentinel through the capture door)", () => {
  const r = resolveActor({ configured: '@legacy' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'reserved');
  assert.ok(RESERVED_ACTORS.has('@legacy'));
});

// ---------------------------------------------------------------------------
// resolveActorKind
// ---------------------------------------------------------------------------

test('resolveActorKind: marker present ⇒ agent', () => {
  const r = resolveActorKind({ env: { [AGENT_ENV_DEFAULT]: 'claude-code' } });
  assert.equal(r.actorKind, 'agent');
  assert.equal(r.marker, AGENT_ENV_DEFAULT);
});

test('resolveActorKind: marker absent ⇒ human', () => {
  const r = resolveActorKind({ env: {} });
  assert.equal(r.actorKind, 'human');
  assert.equal(r.marker, null);
});

test('resolveActorKind: set-but-EMPTY marker ⇒ human, evidence names "set but empty"', () => {
  const r = resolveActorKind({ env: { [AGENT_ENV_DEFAULT]: '' } });
  assert.equal(r.actorKind, 'human');
  assert.match(r.evidence, /set but empty/);
});

test('resolveActorKind: a 3-name brain.agentEnv list, second name set ⇒ agent, that name in evidence', () => {
  const r = resolveActorKind({ env: { VAR2: 'gemini-cli' }, agentEnvConfig: 'VAR1,VAR2,VAR3' });
  assert.equal(r.actorKind, 'agent');
  assert.equal(r.marker, 'VAR2');
  assert.match(r.evidence, /VAR2/);
});

// ---------------------------------------------------------------------------
// resolveActorKind — widened default marker list (#939, audit finding M4:
// a Codex session exporting only CODEX_THREAD_ID, no AI_AGENT, was recorded
// human). Every case here uses an INJECTED env object, never process.env —
// this repo's own checkout exports both AI_AGENT and CLAUDECODE, so a test
// reading the real env would pass for the wrong reason (task brief).
// ---------------------------------------------------------------------------

test('AGENT_ENV_DEFAULTS: widens beyond AI_AGENT and still includes it', () => {
  assert.ok(Array.isArray(AGENT_ENV_DEFAULTS));
  assert.ok(AGENT_ENV_DEFAULTS.includes(AGENT_ENV_DEFAULT));
  assert.ok(AGENT_ENV_DEFAULTS.length > 1, 'must widen beyond the single legacy default');
});

test('resolveActorKind: a session exporting ONLY CODEX_THREAD_ID (no AI_AGENT) ⇒ agent (audit finding M4)', () => {
  const r = resolveActorKind({ env: { CODEX_THREAD_ID: 'thread-abc123' } });
  assert.equal(r.actorKind, 'agent');
  assert.equal(r.marker, 'CODEX_THREAD_ID');
  assert.match(r.evidence, /CODEX_THREAD_ID/);
});

test('resolveActorKind: a session exporting ONLY CLAUDECODE (no AI_AGENT) ⇒ agent', () => {
  const r = resolveActorKind({ env: { CLAUDECODE: '1' } });
  assert.equal(r.actorKind, 'agent');
  assert.equal(r.marker, 'CLAUDECODE');
  assert.match(r.evidence, /CLAUDECODE/);
});

test('resolveActorKind: no default marker present, none configured ⇒ human, evidence lists the checked names', () => {
  const r = resolveActorKind({ env: { UNRELATED_VAR: 'x' } });
  assert.equal(r.actorKind, 'human');
  assert.equal(r.marker, null);
  for (const name of AGENT_ENV_DEFAULTS) {
    assert.ok(r.evidence.includes(name), `evidence must mention ${name}: ${r.evidence}`);
  }
});

test(
  'resolveActorKind: a blank sibling marker (AI_AGENT) is dropped from the evidence once a LATER marker ' +
    '(CODEX_THREAD_ID) decisively wins ⇒ agent, evidence names only the winner (F6, fresh-context review — ' +
    'pinned so a future edit does not silently start mentioning blank siblings on the agent path)',
  () => {
    const r = resolveActorKind({ env: { [AGENT_ENV_DEFAULT]: '', CODEX_THREAD_ID: 't' } });
    assert.equal(r.actorKind, 'agent');
    assert.equal(r.marker, 'CODEX_THREAD_ID');
    assert.equal(r.evidence, 'actorKind agent from env CODEX_THREAD_ID');
    assert.equal(r.evidence.includes(AGENT_ENV_DEFAULT), false, `blank sibling must not appear: ${r.evidence}`);
  },
);

test('resolveActorKind: CODEX_THREAD_ID set but EMPTY ⇒ human, evidence names it "set but empty" (#888 discipline)', () => {
  const r = resolveActorKind({ env: { CODEX_THREAD_ID: '' } });
  assert.equal(r.actorKind, 'human');
  assert.match(r.evidence, /CODEX_THREAD_ID/);
  assert.match(r.evidence, /set but empty/);
});

test('resolveActorKind: explicit brain.agentEnv still wins over the widened defaults', () => {
  const r = resolveActorKind({ env: { CODEX_THREAD_ID: 'thread-abc123', ONLY_THIS: 'yes' }, agentEnvConfig: 'ONLY_THIS' });
  assert.equal(r.actorKind, 'agent');
  assert.equal(r.marker, 'ONLY_THIS');
});

// A mutation from REPLACE to APPEND semantics kills zero tests above: the
// prior override test puts the configured name (`ONLY_THIS`) first in the
// env object, so it is checked first whether the defaults are replaced OR
// merely appended to. This case puts a DEFAULT marker in the env while the
// CONFIGURED name is absent — REPLACE (correct) never consults the default,
// so this must stay 'human'; an APPEND mutant would find the default and
// wrongly return 'agent' (fresh-context review, F2).
test('resolveActorKind: brain.agentEnv REPLACES the defaults — a default marker present while the configured name is absent still yields human', () => {
  const r = resolveActorKind({ env: { [AGENT_ENV_DEFAULT]: 'claude-code' }, agentEnvConfig: 'ONLY_THIS' });
  assert.equal(r.actorKind, 'human', `defaults must not leak in when an override is configured: ${JSON.stringify(r)}`);
  assert.equal(r.marker, null);
});

// ---------------------------------------------------------------------------
// deriveIssue
// ---------------------------------------------------------------------------

test('deriveIssue: declared wins over a matching branch', () => {
  const r = deriveIssue({ declared: '738', branch: 'feat/issue-999-other' });
  assert.equal(r.issue, 738);
  assert.equal(r.derived, false);
});

test("deriveIssue: 'feat/issue-738-x' branch ⇒ 738, derived", () => {
  const r = deriveIssue({ declared: undefined, branch: 'feat/issue-738-x' });
  assert.equal(r.issue, 738);
  assert.equal(r.derived, true);
  
});

// Digit-bearing branches that are NOT the `issue-<N>` shape (MINOR-3b,
// fresh-context review): a loose digit-matching mutant of ISSUE_BRANCH_RE
// would only be caught by a branch that HAS digits but is not the pinned
// shape.
for (const branch of ['main', 'unknown', 'feat/issue-abc', 'chore/bump-node-22', 'release/v2-rc1', 'fix/2026-cleanup', 'feat/issue-738x']) {
  test(`deriveIssue: '${branch}' does not match ⇒ issue absent, never fabricated`, () => {
    const r = deriveIssue({ declared: undefined, branch });
    assert.equal(r.issue, undefined);
    assert.equal(r.derived, false);
  });
}

// ---------------------------------------------------------------------------
// composeSource
// ---------------------------------------------------------------------------

test('composeSource: one trimmed, single-physical-line string (W1-safe)', () => {
  const actor = resolveActor({ configured: '@csrinaldi' });
  const kind = resolveActorKind({ env: {} });
  const issue = deriveIssue({ declared: undefined, branch: 'main' });
  const line = composeSource({ host: 'devbox', backend: 'plainfiles', actor, kind, issue });
  assert.equal(typeof line, 'string');
  assert.equal(line, line.trim());
  assert.ok(!/[\n\r]/.test(line));
});

test('composeSource: a 300-char env value is whitespace-collapsed and sliced to 64', () => {
  const actor = resolveActor({ configured: '@csrinaldi' });
  const raw = ('claude   code  ' + 'x'.repeat(280)).repeat(1).slice(0, 300);
  const kind = resolveActorKind({ env: { [AGENT_ENV_DEFAULT]: raw } });
  const issue = deriveIssue({ declared: undefined, branch: 'main' });
  const line = composeSource({ host: 'devbox', backend: 'plainfiles', actor, kind, issue });
  const match = /AI_AGENT=(\S+)/.exec(line);
  assert.ok(match, `expected an AI_AGENT= value in: ${line}`);
  assert.ok(match[1].length <= 64, `expected <= 64 chars, got ${match[1].length}`);
  assert.ok(!/\s{2,}/.test(match[1]), 'expected whitespace collapsed to single spaces (no run of 2+)');
});

test(
  'composeSource: a whitespace-free 100-char env value is sliced to EXACTLY 64 chars (MINOR-3a, fresh-context review — ' +
    'the sibling test above is whitespace-bearing, so its \\S+ capture only ever sees the first word)',
  () => {
    const actor = resolveActor({ configured: '@csrinaldi' });
    const raw = 'y'.repeat(100);
    const kind = resolveActorKind({ env: { [AGENT_ENV_DEFAULT]: raw } });
    const issue = deriveIssue({ declared: undefined, branch: 'main' });
    const line = composeSource({ host: 'devbox', backend: 'plainfiles', actor, kind, issue });
    const tail = line.slice(line.indexOf('AI_AGENT=') + 'AI_AGENT='.length);
    assert.equal(tail.length, 64, `expected the truncated tail to be exactly 64 chars, got ${tail.length}: ${tail}`);
    assert.equal(tail, 'y'.repeat(64));
  },
);

test(
  'composeSource: an agent-marker value carrying "#N" is stripped, so it cannot forge an ' +
    "issue citation on re-import (MINOR-2, #461 class)",
  () => {
    const actor = resolveActor({ configured: '@csrinaldi' });
    const kind = resolveActorKind({ env: { [AGENT_ENV_DEFAULT]: 'issue #999 runner' } });
    const issue = deriveIssue({ declared: undefined, branch: 'main' });
    const line = composeSource({ host: 'devbox', backend: 'plainfiles', actor, kind, issue });
    assert.ok(!/#/.test(line), `source must not carry a literal '#' from instrument text: ${line}`);
    assert.equal(issue.issue, undefined, 'precondition: no issue was declared or derived here');
    assert.equal(
      issueFromFuente(line),
      undefined,
      'the Fuente parser must not fabricate an issue from agent-controlled instrument text',
    );
  },
);

test(
  'composeSource: backend names the caller — "engram save on <host>" vs "plainfiles save on <host>" ' +
    '(cold review C1, #924)',
  () => {
    const actor = resolveActor({ configured: '@csrinaldi' });
    const kind = resolveActorKind({ env: {} });
    const issue = deriveIssue({ declared: undefined, branch: 'main' });

    const engramLine = composeSource({ host: 'devbox', backend: 'engram', actor, kind, issue });
    assert.ok(engramLine.startsWith('engram save on devbox'), `got: ${engramLine}`);

    const plainfilesLine = composeSource({ host: 'devbox', backend: 'plainfiles', actor, kind, issue });
    assert.ok(plainfilesLine.startsWith('plainfiles save on devbox'), `got: ${plainfilesLine}`);
  },
);

test('composeSource: declared vs derived issue are spelled in words', () => {
  const actor = resolveActor({ configured: '@csrinaldi' });
  const kind = resolveActorKind({ env: {} });

  const declared = composeSource({ host: 'devbox', backend: 'plainfiles', actor, kind, issue: deriveIssue({ declared: 738, branch: undefined }) });
  assert.match(declared, /declared via --issue/);

  const derived = composeSource({ host: 'devbox', backend: 'plainfiles', actor, kind, issue: deriveIssue({ declared: undefined, branch: 'feat/issue-738-x' }) });
  assert.match(derived, /derived from branch/);
});
