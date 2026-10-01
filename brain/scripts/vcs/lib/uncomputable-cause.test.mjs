// uncomputable-cause.test.mjs — issue #606. Imports ONLY the module under
// test: no `gh`, no `setSpawn`, no fixtures (design.md §2, opening
// paragraph — the classifier is a pure string-to-string function).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  UNCOMPUTABLE_REASONS,
  NO_TEXT_REPORTED,
  classifyUncomputableCause,
  uncomputable,
  isUncomputable,
  isNotFound,
} from './uncomputable-cause.mjs';

const UNCOMPUTABLE_REASON_VALUES = Object.values(UNCOMPUTABLE_REASONS);

// ── 1. The pinned corpus (identity.test.mjs:296-304's pattern) ─────────────
//
// Every row is sourced from real `gh`/`glab` output ACTUALLY OBSERVED in
// this session (real `gh` 2.46.0 binary, real `octocat/Hello-World` public
// repo, real ENOENT from a genuinely-absent binary), or from an existing
// pinned message already in this repo — never invented from memory of what
// a CLI "usually says" (design §10, risk 3; the hard constraint this task
// enforces).
//
// Sources:
//   - `review/identity.test.mjs:296-304` (three rate-limited rows, unchanged
//     verbatim — the fourth candidate row, an invented "secondary rate
//     limit" message, was DROPPED rather than pinned unverified).
//   - `vcs/gitlab-api.mjs:65` — `GitLab API failed: ${status} (${path})` is
//     the ONLY template GitLab ever emits; every GitLab row here matches it
//     (the specific status number is a standard HTTP code, not a claim
//     about a specific observed response body).
//   - Live `gh api`/`gh pr view` calls run in THIS session against a real
//     `gh` binary (verified `gh version 2.46.0`), captured through the
//     real `runJson` wrapper (`vcs/lib/exec.mjs`) so the pinned text is
//     exactly what `detail` would hold in production — not a hand-typed
//     approximation. Unauthenticated: an invalid `GH_TOKEN` override (never
//     touches the real gh session) and an empty `GH_CONFIG_DIR`. Not-found:
//     a PR number (999999999) that cannot exist. Binary-missing: `gh` run
//     with an empty `PATH`, and `glab`, which is genuinely absent on this
//     machine — both via the real `runJson`/`spawnSync` path, producing
//     `spawnSync <cmd> ENOENT` (NOT the `spawn <cmd> ENOENT` this module's
//     comments once assumed by analogy to `exec.mjs`'s prose — spawnSync's
//     own error text carries "Sync"; corrected here against the real
//     output, not `exec.mjs`'s comment).
//   - `TypeError`'s real `.message` for a rejected global `fetch()` against
//     an unresolvable host is the bare string `fetch failed` (verified
//     directly) — never `TypeError: fetch failed`; `gitlab.mjs`'s catch
//     passes `err.message` alone, so the `TypeError:` prefix a naive
//     transcription would add is never actually in `detail`.
//   - `gh`'s own real network-failure wrapper text, `error connecting to
//     <host>` (verified against an unreachable `GH_HOST`), is NOT a raw Go
//     `dial tcp`/`ENOTFOUND` error — `gh` wraps it. `NETWORK_RE` gained this
//     pattern specifically because the row exists.
//   - `vcs.contract.test.mjs`'s `failSpawn` fixture text, run through the
//     real `runJson` wrapper shape.
const CORPUS = [
  ['gh: API rate limit exceeded (HTTP 403)', UNCOMPUTABLE_REASONS.RATE_LIMITED],
  ['gh: Maximum number of login attempts exceeded. Please try again later. (HTTP 403)', UNCOMPUTABLE_REASONS.RATE_LIMITED],
  ['GitLab API failed: 429 (/user) rate limit', UNCOMPUTABLE_REASONS.RATE_LIMITED],
  [
    'gh pr view 1 --repo octocat/Hello-World --json statusCheckRollup failed (status 1): HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login\n',
    UNCOMPUTABLE_REASONS.UNAUTHENTICATED,
  ],
  [
    'gh pr view 1 --repo octocat/Hello-World --json statusCheckRollup failed (status 4): To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
    UNCOMPUTABLE_REASONS.UNAUTHENTICATED,
  ],
  ['GitLab API failed: 401 (projects/x%2Fy/merge_requests/1)', UNCOMPUTABLE_REASONS.UNAUTHENTICATED],
  [
    'gh pr view 999999999 --repo octocat/Hello-World --json statusCheckRollup failed (status 1): GraphQL: Could not resolve to a PullRequest with the number of 999999999. (repository.pullRequest)\n',
    UNCOMPUTABLE_REASONS.NOT_FOUND,
  ],
  ['GitLab API failed: 404 (projects/x%2Fy/repository/commits/abc/statuses)', UNCOMPUTABLE_REASONS.NOT_FOUND],
  ['gh pr view 1 --json statusCheckRollup failed (status null): gh: spawnSync gh ENOENT', UNCOMPUTABLE_REASONS.BINARY_MISSING],
  ['glab api /user failed (status null): glab: spawnSync glab ENOENT', UNCOMPUTABLE_REASONS.BINARY_MISSING],
  ['fetch failed', UNCOMPUTABLE_REASONS.NETWORK],
  [
    // Trimmed of `gh`'s own trailing "check your internet connection or
    // [GitHub's status-page URL]" line — real, verified, but that second
    // sentence is not load-bearing for classification and shipping a live
    // third-party hostname in test fixtures trips this repo's own
    // shipped-hostnames guard (#648) for no benefit to this test.
    'gh api /user failed (status 1): error connecting to this-host-does-not-exist-verification.invalid',
    UNCOMPUTABLE_REASONS.NETWORK,
  ],
  ['GitLab API failed: 503 (projects/x%2Fy/merge_requests/1)', UNCOMPUTABLE_REASONS.NETWORK],
  ['gh pr view 1 --json statusCheckRollup failed (status 1): fixture: simulated failure', UNCOMPUTABLE_REASONS.UNCLASSIFIED],
  ['gh: the flurb subsystem declined to enumerate the rollup (HTTP 418)', UNCOMPUTABLE_REASONS.UNCLASSIFIED],
];

for (const [message, expectedReason] of CORPUS) {
  test(`classifyUncomputableCause: ${JSON.stringify(message)} -> ${expectedReason} (#606)`, () => {
    assert.equal(classifyUncomputableCause(message), expectedReason);
  });

  test(`uncomputable({detail}): ${JSON.stringify(message)} carries reason AND the verbatim message (#606)`, () => {
    const u = uncomputable({ detail: message });
    assert.equal(u.reason, expectedReason);
    assert.equal(u.detail, message, "the provider's own words must survive to the operator");
  });
}

// ── 1b. `isNotFound` — D2's shared not-found predicate (#1086) ─────────────
//
// `isNotFound(text)` MUST be `true` exactly when `classifyUncomputableCause`
// would answer `NOT_FOUND`, and `false` for every other reason in the
// CORPUS above — it is a thin, total function of the same classifier, never
// a second regex.

for (const [message, expectedReason] of CORPUS) {
  test(`isNotFound: ${JSON.stringify(message)} -> ${expectedReason === UNCOMPUTABLE_REASONS.NOT_FOUND} (#1086)`, () => {
    assert.equal(isNotFound(message), expectedReason === UNCOMPUTABLE_REASONS.NOT_FOUND);
  });
}

test('isNotFound: auth-worded 404 text (masked private repo) stays false — auth beats 404 per the existing ordering (#1086)', () => {
  // Constructed precedence probe (same discipline as the ordering block
  // below): a 404 status marker AND an auth word in the same message. The
  // classifier's rule 3 (auth beats 404) must win, so this must NOT read as
  // not-found.
  const message = 'gh pr view 1 --json statusCheckRollup failed (status 404): Bad credentials (masked private repo)';
  assert.equal(classifyUncomputableCause(message), UNCOMPUTABLE_REASONS.UNAUTHENTICATED);
  assert.equal(isNotFound(message), false);
});

test('isNotFound: a fully unclassified message is false, not a fallback true', () => {
  assert.equal(isNotFound('gh: the flurb subsystem declined to enumerate the rollup (HTTP 418)'), false);
});

// ── 2. Ordering (identity.test.mjs:316-321's pattern) ──────────────────────
//
// Ordering tests construct a COMBINED-SIGNAL input to prove rule
// PRECEDENCE — `identity.test.mjs`'s own ordering test does the same
// ('HTTP 401 — and then: Maximum number of login attempts exceeded' is not
// claimed as one single message any real provider emitted verbatim; it
// combines two real fragments to prove `lockout` beats `rejected`). This is
// a DIFFERENT discipline from §1's corpus table, which pins only fully
// real-observed messages — a constructed precedence probe is not a claim
// that any provider emits it as-is.

test('classifyUncomputableCause: rate-limit language + an HTTP 403 marker classifies rate-limited, NOT unauthenticated (#606, the three-token-rotation incident identity.mjs:52-70 records)', () => {
  assert.equal(
    classifyUncomputableCause('gh: API rate limit exceeded (HTTP 403)'),
    UNCOMPUTABLE_REASONS.RATE_LIMITED,
  );
});

test('classifyUncomputableCause: binary-missing language + "not found" language classifies binary-missing, NOT not-found (#606)', () => {
  // Constructed precedence probe (see block comment above) — this exact
  // machine's real `gh`/`glab` ENOENT text never contains "not found"
  // (verified in this session: it is `spawnSync <cmd> ENOENT`), so no fully
  // real-observed message from THIS codebase's actual execution path
  // exercises the collision rule 1 is ordered to prevent. `BINARY_MISSING_RE`
  // also matches `command not found` for portability (a shelled-out
  // invocation on another OS/shell can produce it) — this probe proves that,
  // WERE such a message ever seen, it would not be misread as `not-found`.
  assert.equal(
    classifyUncomputableCause('gh: command not found'),
    UNCOMPUTABLE_REASONS.BINARY_MISSING,
  );
});

// ── 3. The HTTP-number negative (design §2.1, the verified bare-429 trap) ──

test('classifyUncomputableCause: a PR literally numbered 429 must NOT classify as rate-limited (#606, M9)', () => {
  // `runJson` builds this EXACT shape for a failing fetch of PR 429:
  // `${cmd} ${args.join(' ')} failed (status ${r.status}): ${r.stderr}`.
  // The digits "429" here are the PR NUMBER, not an HTTP status code.
  const message = 'gh pr view 429 --json statusCheckRollup failed (status 1): fixture: simulated failure';
  assert.equal(classifyUncomputableCause(message), UNCOMPUTABLE_REASONS.UNCLASSIFIED);
});

test('classifyUncomputableCause: a PR literally numbered 404 must NOT classify as not-found (#606, M9 mirror)', () => {
  const message = 'gh pr view 404 --json statusCheckRollup failed (status 1): fixture: simulated failure';
  assert.equal(classifyUncomputableCause(message), UNCOMPUTABLE_REASONS.UNCLASSIFIED);
});

// ── 4. Shape invariants (design §6.4) ───────────────────────────────────────

test('uncomputable(): the returned object is frozen', () => {
  assert.ok(Object.isFrozen(uncomputable({ detail: 'x' })));
});

test('uncomputable(): exactly three keys — uncomputable, reason, detail', () => {
  const u = uncomputable({ detail: 'x' });
  assert.deepEqual(Object.keys(u).sort(), ['detail', 'reason', 'uncomputable']);
});

for (const missing of [undefined, null, '']) {
  test(`uncomputable({detail: ${JSON.stringify(missing)}}): falls back to NO_TEXT_REPORTED, never an empty string`, () => {
    const u = uncomputable({ detail: missing });
    assert.equal(u.detail, NO_TEXT_REPORTED);
    assert.notEqual(u.detail, '');
  });
}

test('isUncomputable(null) === false — null is a THIRD state, not "uncomputable with no cause" (#606, load-bearing)', () => {
  assert.equal(isUncomputable(null), false);
});

test('isUncomputable(undefined) === false', () => {
  assert.equal(isUncomputable(undefined), false);
});

test('isUncomputable: a GitLab success rollup entry (conclusion: null) never collides with the shape (design §1.5)', () => {
  const entry = { name: 'x', status: 'success', conclusion: null };
  assert.equal(isUncomputable(entry), false);
});

test('classifyUncomputableCause: codomain is a subset of UNCOMPUTABLE_REASONS', () => {
  for (const [, reason] of CORPUS) {
    assert.ok(UNCOMPUTABLE_REASON_VALUES.includes(reason));
  }
});

test('UNCOMPUTABLE_REASONS: no value reads as clean, over a 200-string fuzz set', () => {
  const CLEAN_RE = /ok|success|clean|none|empty/i;
  for (const value of UNCOMPUTABLE_REASON_VALUES) {
    assert.doesNotMatch(value, CLEAN_RE, `enum value "${value}" must not read as clean`);
  }
  // A fuzz set of arbitrary strings must never leave the enum, and the
  // enum itself never reads as clean — checked directly above, and
  // structurally guaranteed by classifyUncomputableCause's single-`return`
  // arms (no fall-through to `undefined`, no computed reason string).
  const fuzz = Array.from({ length: 200 }, (_, i) => `random-fuzz-input-${i}-${Math.random()}`);
  for (const input of fuzz) {
    const reason = classifyUncomputableCause(input);
    assert.ok(UNCOMPUTABLE_REASON_VALUES.includes(reason), `fuzz input produced an out-of-enum reason: ${reason}`);
    assert.doesNotMatch(reason, CLEAN_RE);
  }
});

// ── 5. Design question 3 — total rot degrades WITH the text (design §3.2a) ─

test("an invented message no rule matches degrades to unclassified WITH the words verbatim (#606 ruling 3)", () => {
  const invented = 'gh: the flurb subsystem declined to enumerate the rollup (HTTP 418)';
  const u = uncomputable({ detail: invented });
  assert.equal(u.reason, 'unclassified', 'an unrecognised message must never borrow another label');
  assert.equal(u.detail, invented, "the provider's own words must survive to the operator");
});

// ── 6. `reason` explicit-pass path (design §1.2 — MALFORMED_RESPONSE) ──────

test('uncomputable({detail, reason}): an explicitly-passed reason is never overridden by the classifier', () => {
  const u = uncomputable({ detail: 'the rollup field was not an array', reason: UNCOMPUTABLE_REASONS.MALFORMED_RESPONSE });
  assert.equal(u.reason, UNCOMPUTABLE_REASONS.MALFORMED_RESPONSE);
});

// ── 7. Source guard (design §6.6) — one constructor, enforced ──────────────

test('source guard: neither provider source contains the literal `uncomputable: true` (#606) — one constructor, uncomputable() in this module', () => {
  for (const providerFile of ['github.mjs', 'gitlab.mjs']) {
    const src = readFileSync(fileURLToPath(new URL(`../../axes/vcs/adapters/${providerFile}`, import.meta.url)), 'utf8');
    assert.equal(
      src.includes('uncomputable: true'),
      false,
      `${providerFile} must never hand-construct the uncomputable shape — call uncomputable() from vcs/lib/uncomputable-cause.mjs instead`,
    );
  }
});
