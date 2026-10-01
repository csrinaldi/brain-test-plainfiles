// forge-cache.mjs — the cache-only port `buildSnapshot` composes as `vcs`
// (D1, #881). It never calls the forge: the poller (#881 PR 2) is the only
// writer, through the setters below. A cache miss THROWS rather than
// fetching, so `buildSnapshot` provably makes zero network calls on any
// path, ever — the invariant D1 is built on.
//
// `port` exposes EXACTLY the four read verbs `readForge`
// (`status/snapshot.mjs:184-255`) calls — pinned by `forge-cache.test.mjs` —
// so a stray fifth verb can never slip in as "the vcs port" and go untested
// by A5's read-only-port proof. The setters live outside `port` on purpose:
// they are the poller's write surface into this cache, never a verb
// `buildSnapshot` itself could reach.
//
// A miss has TWO causes and `snapshot.mjs` renders whichever reason this
// module throws verbatim as the node's `unreadable` text, so the two must not
// share one sentence (tracker PR #970 cold review). Before the first tick,
// nothing is cached and "the first forge poll has not completed" is the whole
// truth. After a tick, the poller's bounded body lane and round-robin review
// lane mean a number can simply not have been reached yet — saying the first
// poll has not completed there reads as a dead server when the server is
// working and that one item is queued.

const FIRST_POLL_REASON = 'the first forge poll has not completed';
const QUEUED_BODY_REASON = "this issue's body has not been fetched yet (queued)";
const QUEUED_REVIEWS_REASON = "this PR's reviews have not been fetched yet (queued)";

/**
 * @returns {{
 *   port: {issueList: Function, mrList: Function, issueView: Function, prReviews: Function},
 *   setIssueList: (value: unknown) => void,
 *   setMrList: (value: unknown) => void,
 *   setIssueView: (number: number, value: unknown) => void,
 *   setPrReviews: (number: number, value: unknown) => void,
 * }}
 */
export function createForgeCache() {
  const store = { issueList: undefined, mrList: undefined, issueView: new Map(), prReviews: new Map() };

  // "Has this cache ever been written to" stands in for "has a poll
  // completed": a successful tick always sets both lists before it touches
  // anything per-number, and nothing else writes here (D1).
  const holdsAnyAnswer = () => store.issueList !== undefined
    || store.mrList !== undefined
    || store.issueView.size > 0
    || store.prReviews.size > 0;

  function miss(queuedReason) {
    throw new Error(holdsAnyAnswer() ? queuedReason : FIRST_POLL_REASON);
  }

  const port = {
    // A list is never "queued": the fast lane fetches both on every tick, so
    // a missing list can only mean no tick has completed.
    issueList: async () => (store.issueList !== undefined ? store.issueList : miss(FIRST_POLL_REASON)),
    mrList: async () => (store.mrList !== undefined ? store.mrList : miss(FIRST_POLL_REASON)),
    issueView: async ({ number } = {}) => (store.issueView.has(number) ? store.issueView.get(number) : miss(QUEUED_BODY_REASON)),
    prReviews: async ({ number } = {}) => (store.prReviews.has(number) ? store.prReviews.get(number) : miss(QUEUED_REVIEWS_REASON)),
  };

  return {
    port,
    setIssueList: (value) => { store.issueList = value; },
    setMrList: (value) => { store.mrList = value; },
    setIssueView: (number, value) => { store.issueView.set(number, value); },
    setPrReviews: (number, value) => { store.prReviews.set(number, value); },
  };
}
