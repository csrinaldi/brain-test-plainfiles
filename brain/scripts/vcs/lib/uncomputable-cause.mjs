// uncomputable-cause.mjs — issue #606: `prStatusRollup` reports WHY it could
// not read a rollup, instead of collapsing every failure into a bare `null`.
// Zero imports. Pure. This is the single place the `{uncomputable, reason,
// detail}` shape is constructed — neither provider (`github.mjs`,
// `gitlab.mjs`) may build this object by hand or write a `reason` literal;
// both import ONLY `uncomputable()` / `isUncomputable()` from here (enforced
// by a source guard in this file's own test — no provider source may contain
// the literal `uncomputable: true`).
//
// Copies `review/identity.mjs`'s `evaluateNegativeControl` pattern point by
// point (design.md §0): module-level `const` regexes, one per cause, each
// commented with WHY it exists and why it sits where it sits in the order;
// a pure classifier from a string to a small closed vocabulary; a terminal
// default arm that REFUSES (`unclassified`) rather than reading as clean;
// the original message surviving every branch, including the default.
//
// `vcs/lib/` is the correct floor: `normalize.mjs` is already a shared
// module both providers IMPORT and neither RE-EXPORTS — this module follows
// that precedent verbatim (`verb-contract-drift-guard.test.mjs` would
// otherwise treat a re-exported helper as an undeclared contract verb).
//
// issue #1086 adds `isNotFound` alongside `uncomputable()`/`isUncomputable()`
// as the module's third approved export: both providers import ONLY these
// three from here to decide `prView`'s additive `absent` field (D2) — never
// a provider-local regex or stderr literal.

/** The closed vocabulary `reason` draws from. Declared once, frozen, so a
 * rename is one edit and a test can assert the classifier's codomain is a
 * subset of it. `MALFORMED_RESPONSE` is never produced by text matching — it
 * is a structural fact known at the call site (the fetch succeeded and the
 * rollup field was not an array), so a provider passes it explicitly. Every
 * value here is a FAILURE word; none reads as "clean" (design §2.4). */
export const UNCOMPUTABLE_REASONS = Object.freeze({
  RATE_LIMITED: 'rate-limited',
  UNAUTHENTICATED: 'unauthenticated',
  NOT_FOUND: 'not-found',
  NETWORK: 'network',
  BINARY_MISSING: 'binary-missing',
  MALFORMED_RESPONSE: 'malformed-response',
  UNCLASSIFIED: 'unclassified',
});

/** The one path with genuinely no words (an unresolvable head sha with no
 * thrown error) — never `''`, never `undefined`. A FALLBACK, never a
 * replacement: no adoption site can actually reach it (both providers pass a
 * non-empty sentence), and a mutation that swaps real provider text for this
 * constant goes red at three layers (design §7, M3). */
export const NO_TEXT_REPORTED = '(the provider reported no error text)';

// ── The HTTP-status hazard (design §2.1) ─────────────────────────────────────
//
// `runJson` (vcs/lib/exec.mjs) builds its failure message as
// `${cmd} ${args.join(' ')} failed (status ${r.status}): ${r.stderr}` — so
// the message for a failing fetch of PR **429** is literally
// `gh pr view 429 --json statusCheckRollup failed (status 1): <stderr>`. A
// bare `\b429\b` rule reads that PR NUMBER as a rate-limit status code, and
// wrongly so — the number in the message belongs to the PR, not to any HTTP
// response. Same hazard for a PR numbered 404, 401, or 500.
//
// So every numeric rule below is gated behind a MARKER that only a real
// status code carries: `gh`'s `(HTTP 403)` suffix, `runJson`'s own
// `failed (status N)` wrapper, or `glab`'s `GitLab API failed: 429 (path)`
// (gitlab-api.mjs:65). A bare digit in free text never counts.
const HTTP_STATUS_RE = /(?:\bHTTP\b|\bstatus\b|API failed:)\s*\(?(\d{3})\)?/i;
function httpStatusOf(text) {
  const m = text.match(HTTP_STATUS_RE);
  return m ? Number(m[1]) : null;
}

// The regexes, each pinned by the corpus in uncomputable-cause.test.mjs.
const BINARY_MISSING_RE = /\bENOENT\b|command not found|no such file or directory/i;
const RATE_LIMITED_RE = /rate limit|maximum number of login attempts|abuse detection|too many requests|retry-after/i;
const UNAUTHENTICATED_RE = /bad credentials|unauthorized|requires authentication|authentication (?:required|failed)|must be logged in|auth login|insufficient_scope|invalid[_ ]token/i;
const NOT_FOUND_RE = /\bnot found\b|could not resolve to a|no such (?:pull request|merge request|repository|project)/i;
// `error connecting to` is `gh`'s OWN real wrapper text for a DNS/connect
// failure (verified in this session against a real `gh` 2.46.0 binary
// talking to an unreachable host — `gh` does not surface a raw Go
// `dial tcp`/`ENOTFOUND` error, it wraps it) — added alongside the raw
// transport-error spellings `fetch failed` (Node's global `fetch`, what
// `gitlabApiFetch` throws verbatim on a DNS failure) and the OS-level
// `ENOTFOUND`/`ECONNREFUSED`/etc. codes a raw Node error can carry.
const NETWORK_RE = /\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|fetch failed|error connecting to|socket hang up|network is unreachable|dial tcp|tls handshake/i;

/**
 * Labels a failure's text with a `reason` from `UNCOMPUTABLE_REASONS`
 * (excluding `MALFORMED_RESPONSE`, which no text implies), evaluated in a
 * fixed, documented order. Falls through to `UNCLASSIFIED` when no rule
 * matches — NEVER a value that reads as "clean" (design §2.4).
 *
 * Order matters and is load-bearing, not incidental:
 *
 * 1. Could not RUN. `exec.mjs:30` turns spawn's `status: null` into these
 *    words (#604's ENOENT fix). FIRST because "gh: command not found" also
 *    contains "not found", and rule 4 would otherwise report a missing
 *    binary as a missing PR — two different remedies, one of them wasted.
 * 2. Throttled. BEFORE rule 3, and this ordering is the load-bearing one:
 *    GitHub answers a rate limit with HTTP **403** ("API rate limit
 *    exceeded (HTTP 403)"), so an auth rule that ran first would label
 *    every GitHub rate limit "unauthenticated" and send the operator to
 *    rotate a token that was never the problem — the exact mis-diagnosis
 *    `identity.mjs:52-70` records as having cost three token rotations.
 *    Same repo, same defect, one rule earlier.
 * 3. Refused the credential. Auth WORDS beat a 404: GitHub masks a repo the
 *    token cannot see as 404, so a message that says both is an auth
 *    problem.
 * 4. The thing is not there (and no auth language said otherwise).
 * 5. Could not reach it, or it answered with its own failure. Deliberately
 *    coarse (design §1.2): the remedy is the same either way, and `detail`
 *    carries the precision.
 *
 * @param {string} text
 * @returns {string} one of `UNCOMPUTABLE_REASONS`'s values
 */
export function classifyUncomputableCause(text) {
  const s = String(text ?? '');
  const code = httpStatusOf(s);

  if (BINARY_MISSING_RE.test(s)) return UNCOMPUTABLE_REASONS.BINARY_MISSING;
  if (RATE_LIMITED_RE.test(s) || code === 429) return UNCOMPUTABLE_REASONS.RATE_LIMITED;
  if (UNAUTHENTICATED_RE.test(s) || code === 401 || code === 403) return UNCOMPUTABLE_REASONS.UNAUTHENTICATED;
  if (NOT_FOUND_RE.test(s) || code === 404) return UNCOMPUTABLE_REASONS.NOT_FOUND;
  if (NETWORK_RE.test(s) || (code !== null && code >= 500)) return UNCOMPUTABLE_REASONS.NETWORK;

  return UNCOMPUTABLE_REASONS.UNCLASSIFIED;
}

/**
 * The ONLY constructor of the `{uncomputable, reason, detail}` shape
 * (design §1.3). `detail` is computed FIRST and INDEPENDENTLY of `reason` —
 * `reason` is derived FROM `detail`, `detail` is never derived from
 * `reason`, and there is no expression here in which the classifier's
 * answer can influence `detail`. That is the structural half of "the
 * provider's verbatim words always reach `detail`"; the test suite (three
 * layers, design §3.2) supplies the behavioural half.
 *
 * @param {{ detail?: string|null, reason?: string|null }} [args]
 * @returns {Readonly<{ uncomputable: true, reason: string, detail: string }>}
 */
export function uncomputable({ detail, reason = null } = {}) {
  const text = (detail ?? '') === '' ? NO_TEXT_REPORTED : String(detail);
  return Object.freeze({
    uncomputable: true,
    reason: reason ?? classifyUncomputableCause(text),
    detail: text,
  });
}

/**
 * `isUncomputable(null) === false` is load-bearing: `null` is a THIRD
 * state — "a reader that discarded its cause and did not adopt this shape"
 * — and the 13 filed cause-discarding sibling sites still return it.
 * Collapsing it into "uncomputable with no cause" would let a consumer
 * believe every reader had been migrated (design §1.4).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUncomputable(value) {
  return Boolean(value) && typeof value === 'object' && value.uncomputable === true;
}

/**
 * The shared not-found predicate (issue #1086, D2). `true` only when
 * `classifyUncomputableCause` would answer `NOT_FOUND` for the same text —
 * never a second regex, so the auth-beats-404 ordering above (rule 3 before
 * rule 4) protects this predicate for free: a masked-private-repo 404 that
 * also carries auth words classifies `UNAUTHENTICATED`, so `isNotFound`
 * answers `false` for it, not a false "absent".
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isNotFound(text) {
  return classifyUncomputableCause(text) === UNCOMPUTABLE_REASONS.NOT_FOUND;
}
