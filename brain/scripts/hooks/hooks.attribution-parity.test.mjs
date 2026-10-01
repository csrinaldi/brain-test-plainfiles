// hooks.attribution-parity.test.mjs — one rule, three implementations, pinned (#671).
//
// The AI-attribution prohibition (agent-authorities.md Tier 3) is enforced in
// three places that cannot see each other:
//
//   1. hooks/commit-msg   — client side, sh + grep -Ei
//   2. hooks/pre-receive  — server side, sh + grep -Ei, bypass-proof
//   3. review/evaluators/tranche.mjs — the reviewer, a JS RegExp
//
// Nothing pinned them together. `pre-receive`'s own header says "Checks
// mirrored from commit-msg" and the mirroring was a comment, not a test —
// exactly the shape #130, #340 and #555 each closed: one rule, two
// implementations, and the drift discovered later by someone reading both.
//
// This file is the pin, and it is written as a SHARED CORPUS rather than a
// string comparison of the three patterns. Comparing the regex sources would
// pass for two patterns that are textually equal and behaviourally wrong
// together, and would fail for two that are spelled differently and agree —
// neither is the property that matters. What matters is that the same message
// gets the same answer everywhere.
//
// The corpus is deliberately small and concrete: every entry is a form that has
// actually appeared, or a near-miss that must NOT be caught. It is not a claim
// of completeness — no list of AI-attribution spellings can be complete — and
// the ADR says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { removeTempTree } from '../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const COMMIT_MSG_HOOK = new URL('./commit-msg', import.meta.url).pathname;
const PRE_RECEIVE_HOOK = new URL('./pre-receive', import.meta.url).pathname;
import { AI_ATTRIBUTION_RE as TRANCHE_RE } from '../review/evaluators/tranche.mjs';

// Every entry carries a valid conventional-commit subject with a ticket ref, so
// the OTHER two commit-msg checks pass and a rejection can only be this one.
const MUST_REJECT = [
  ['the trailer this repo actually accumulated 28 times',
    'fix(x): thing (#1)\n\nCo-Authored-By: Claude Opus 5 <noreply@example.invalid>'],
  ['a session URL — a dead link in public history',
    'fix(x): thing (#1)\n\nClaude-Session: https://agent.invalid/session_01ABC'],
  ['the classic footer',
    'fix(x): thing (#1)\n\n🤖 Generated with [Claude Code](https://agent.invalid)'],
  ['case-insensitively, because git trailers are written every which way',
    'fix(x): thing (#1)\n\nco-authored-by: claude <x@example.invalid>'],
  ['with extra whitespace after the colon',
    'fix(x): thing (#1)\n\nCo-Authored-By:   Claude <x@example.invalid>'],
  // VENDOR NEUTRALITY. brain ships into other people's repositories; a hook
  // that only knew one agent would enforce the rule here and silently exempt
  // every consumer using another. The doctrine says "AI attribution", not one
  // vendor's.
  ['another vendor — Copilot',
    'fix(x): thing (#1)\n\nCo-Authored-By: Copilot <bot@example.invalid>'],
  ['another vendor — Cursor',
    'fix(x): thing (#1)\n\nCo-Authored-By: Cursor Agent <bot@example.invalid>'],
  ['another vendor — Gemini',
    'fix(x): thing (#1)\n\nCo-Authored-By: Gemini Code Assist <bot@example.invalid>'],
  ['another vendor — GPT',
    'fix(x): thing (#1)\n\nCo-Authored-By: GPT-5 <bot@example.invalid>'],
  ['another vendor, footer form',
    'fix(x): thing (#1)\n\nGenerated with [Devin](https://agent.invalid)'],
];

const MUST_ACCEPT = [
  ['a plain commit', 'fix(x): thing (#1)'],
  ['a HUMAN co-author — the trailer itself is legitimate',
    'fix(x): thing (#1)\n\nCo-Authored-By: Ada Lovelace <ada@example.com>'],
  ['prose that merely mentions the tool',
    'fix(x): thing (#1)\n\nFound while running the agent harness.'],
  // False positives the BROADER vendor list could invent. `cursor`, `codex` and
  // `gpt` are ordinary words in ordinary sentences, and a hook that blocked a
  // commit for saying "cursor pagination" would be worse than one that missed a
  // trailer: a gate that fires on innocent input teaches people to reach for the
  // bypass flag ADR-0014 §9 prohibits, and then it guards nothing at all.
  ['a database cursor, not the editor',
    'fix(x): thing (#1)\n\nGenerated with cursor pagination over the result set.'],
  ['a codex in prose',
    'fix(x): thing (#1)\n\nRefactored per the internal codex of naming rules.'],
  ['a co-author whose name merely contains an agent word',
    'fix(x): thing (#1)\n\nCo-Authored-By: Marie Copilotti <marie@example.com>'],
];

/** Runs the hook with the developer's own git configuration NEUTRALISED.
 *
 * The hook reads `git config --get brain.aiAgents`, and outside a repository
 * that resolves against GLOBAL and SYSTEM config. Without this the corpus would
 * measure whoever is running it — green on one machine, red on another, and
 * asserting the default on neither. Same hazard #657 closed for an ambient
 * token: a test must measure the thing, not the shell it was launched from. */
function runCommitMsg(message, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'attr-parity-'));
  try {
    const file = join(dir, 'COMMIT_EDITMSG');
    writeFileSync(file, message);
    return spawnSync('sh', [COMMIT_MSG_HOOK, file], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ...env,
      },
    });
  } finally {
    removeTempTree(dir);
  }
}

/** The two pattern literals each sh hook uses, with the agent list expanded in
 * exactly the way the shell expands it — so this measures what the hook runs,
 * not a JS approximation of it. */
function shPattern(path) {
  const text = readFileSync(path, 'utf8');
  const agents = text.match(/AI_AGENTS='([^']+)'/);   // the baked fallback
  const pattern = text.match(/AI_ATTRIBUTION_RE="([^"]+)"/);
  assert.ok(agents, `${path} does not define AI_AGENTS`);
  assert.ok(pattern, `${path} does not define AI_ATTRIBUTION_RE`);
  return { agents: agents[1], expanded: pattern[1].replaceAll('$AI_AGENTS', agents[1]) };
}

/** Runs a message through `grep -qiE` with a hook's own extracted pattern —
 * the same shell primitive the hook uses, so this measures the pattern rather
 * than re-implementing the matching in JS. */
function grepMatches(pattern, message) {
  // The message is read from a file, not the `input` option: a piped stdin never sees EOF in the
  // cold reviewer's sandbox (#1221).
  const dir = mkdtempSync(join(tmpdir(), 'brain-1221-grep-'));
  try {
    const file = join(dir, 'message');
    writeFileSync(file, message);
    return spawnSync('grep', ['-qiE', pattern, file], { encoding: 'utf8' }).status === 0;
  } finally {
    removeTempTree(dir);
  }
}

/** The reviewer's real exported pattern — imported, never scraped from source.
 * A guard that parses the file it guards fails open the moment the declaration
 * is reformatted, which is the apparent protection this repo keeps refusing. */
function trancheMatches(message) {
  // `lastIndex` is irrelevant without /g, but re-test defensively on a fresh
  // call so an accidental /g on the export cannot make results order-dependent.
  return new RegExp(TRANCHE_RE.source, TRANCHE_RE.flags.replace('g', '')).test(message);
}

// ── The client hook actually blocks ─────────────────────────────────────────

test('commit-msg BLOCKS every attributed message in the corpus (#671)', () => {
  for (const [label, message] of MUST_REJECT) {
    const r = runCommitMsg(message);
    assert.equal(r.status, 1, `must reject: ${label}`);
    assert.match(r.stdout, /AI attribution is prohibited/, label);
  }
});

test('commit-msg ACCEPTS legitimate messages, including a human co-author (#671)', () => {
  for (const [label, message] of MUST_ACCEPT) {
    const r = runCommitMsg(message);
    assert.equal(r.status, 0, `must accept: ${label} — output: ${r.stdout}`);
  }
});

test('the corpus measures the DEFAULT, not the machine running it (#671)', () => {
  // The positive control for the isolation above. If a developer had
  // `brain.aiAgents` set globally, the corpus would silently exercise their
  // list instead of the shipped default and prove nothing about what ships.
  const r = runCommitMsg(
    'fix(x): thing (#1)\n\nCo-Authored-By: Claude <x@example.invalid>',
    { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  );
  assert.equal(r.status, 1, 'the shipped default must catch this with no configuration at all');
});

test('commit-msg checks attribution BEFORE the ticket-ref exemptions (#671)', () => {
  // `chore(release)` and `chore(memory)` are exempt from the ticket rule. If the
  // attribution check sat after that exemption, those two commit types would
  // silently carry trailers — an exemption from one rule becoming an exemption
  // from another is how the Tier-3 list gets holes.
  for (const subject of ['chore(release): v1.2.3', 'chore(memory): sync']) {
    const r = runCommitMsg(`${subject}\n\nCo-Authored-By: Claude Opus 5 <x@y.z>`);
    assert.equal(r.status, 1, `${subject} must not be exempt from the attribution rule`);
  }
});

// ── The two shell hooks agree, entry by entry ───────────────────────────────

test('commit-msg and pre-receive carry the SAME agent list and pattern (#671)', () => {
  const client = shPattern(COMMIT_MSG_HOOK);
  const server = shPattern(PRE_RECEIVE_HOOK);
  assert.equal(client.agents, server.agents, 'the agent lists must not drift');
  assert.equal(client.expanded, server.expanded,
    'the client and server hooks must not drift — pre-receive is the bypass-proof half');
});

test('both shell patterns give the same answer on every corpus entry (#671)', () => {
  const client = shPattern(COMMIT_MSG_HOOK).expanded;
  const server = shPattern(PRE_RECEIVE_HOOK).expanded;
  for (const [label, message] of MUST_REJECT) {
    assert.equal(grepMatches(client, message), true, `client must match: ${label}`);
    assert.equal(grepMatches(server, message), true, `server must match: ${label}`);
  }
  for (const [label, message] of MUST_ACCEPT) {
    assert.equal(grepMatches(client, message), false, `client must not match: ${label}`);
    assert.equal(grepMatches(server, message), false, `server must not match: ${label}`);
  }
});

// ── The list is configurable, so the rule outlives today's tooling ──────────
//
// A baked list always lags. brain ships into other people's repositories, and a
// consumer whose agent is not in the default must be able to enforce their own
// rule without waiting for a brain release. `git config brain.aiAgents` is the
// channel because git is the only dependency `pre-receive` has — it is installed
// into a bare repo as one self-contained file, so no sibling data file and no
// brain.config.json is reachable from there.

test('commit-msg honours git config brain.aiAgents — tomorrow\'s agent needs no release (#671)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'attr-cfg-'));
  try {
    spawnSync('git', ['init', '-q', repo]);
    // An agent that does NOT exist in the baked default.
    spawnSync('git', ['-C', repo, 'config', 'brain.aiAgents', 'opencode|antigravity']);

    const file = join(repo, 'COMMIT_EDITMSG');
    const attributed = 'fix(x): thing (#1)\n\nCo-Authored-By: OpenCode <bot@example.invalid>';
    writeFileSync(file, attributed);
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const blocked = spawnSync('sh', [COMMIT_MSG_HOOK, file], { cwd: repo, encoding: 'utf8', env: gitEnv });
    assert.equal(blocked.status, 1, 'a configured agent must be enforced');
    assert.match(blocked.stdout, /AI attribution is prohibited/);

    // And the override REPLACES the default rather than extending it — an
    // operator who sets the key owns the list. Stated as a test because the
    // opposite (a floor) is the other plausible reading.
    writeFileSync(file, 'fix(x): thing (#1)\n\nCo-Authored-By: Claude <x@example.invalid>');
    const allowed = spawnSync('sh', [COMMIT_MSG_HOOK, file], { cwd: repo, encoding: 'utf8', env: gitEnv });
    assert.equal(allowed.status, 0,
      'the configured list replaces the default — the key is the whole vocabulary, not an addition to it');
  } finally {
    removeTempTree(repo);
  }
});

test('both hooks read the SAME config key, with the same fallback (#671)', () => {
  const client = readFileSync(COMMIT_MSG_HOOK, 'utf8');
  const server = readFileSync(PRE_RECEIVE_HOOK, 'utf8');
  for (const [name, text] of [['commit-msg', client], ['pre-receive', server]]) {
    assert.match(text, /git config --get brain\.aiAgents/,
      `${name} must read the override, or a consumer's configuration silently applies to only half the gate`);
  }
  assert.equal(shPattern(COMMIT_MSG_HOOK).agents, shPattern(PRE_RECEIVE_HOOK).agents,
    'and the baked fallbacks must not drift either');
});

// ── The reviewer's regex agrees with the hooks ──────────────────────────────

test('tranche.mjs agrees with the hooks on every corpus entry (#671)', () => {
  // The third implementation. It reads a different SURFACE (the PR body, not the
  // commits — see the ticket), but the question it asks is the same one, and a
  // reviewer that disagreed with the hook about what attribution looks like
  // would report clean on something the hook rejects.
  for (const [label, message] of MUST_REJECT) {
    assert.equal(trancheMatches(message), true, `tranche must match: ${label}`);
  }
  for (const [label, message] of MUST_ACCEPT) {
    assert.equal(trancheMatches(message), false, `tranche must not match: ${label}`);
  }
});
