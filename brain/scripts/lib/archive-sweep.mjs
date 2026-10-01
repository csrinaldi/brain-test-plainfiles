// archive-sweep.mjs — the closed-issue selector for the openspec archive
// sweep (issue #557, design D1). Pure: zero ambient I/O, every dependency
// injected (`exists`, `readIssueState`). `archive.mjs --backfill` and the
// post-merge sweep step both consume this so eligibility is defined once.
//
// Classification is a TOTAL, ordered decision table — first match wins, every
// input class maps to exactly one OUTCOME row, nothing falls through
// unmapped (the same totality discipline as phase-order-check.mjs's Rule
// evaluators). Local (filesystem) rows precede network (issue-state) rows,
// so a collision or a taken destination is decidable without a token and
// costs no API call. `unreadable` precedes `open` — an unanswered read can
// never be reported as "still open" (evidence-reader-empty-on-failure).

import { parseChangeId, isGrandfathered, archivePath } from './sdd-layout.mjs';

export const OUTCOME = Object.freeze({
  ARCHIVABLE: 'archivable',
  OPEN: 'open', // issue still open — left in place
  NOT_PLANNED: 'not-planned', // closed, not archivable
  COLLISION: 'collision', // >1 live folder shares this iid
  DESTINATION_EXISTS: 'destination-exists', // archive/<iid> already taken
  NO_ISSUE_KEY: 'no-issue-key', // grandfathered dir — no issue to read
  UNREADABLE: 'unreadable', // issue state could not be read
  NOT_A_CHANGE: 'not-a-change', // does not parse, not grandfathered
  CONTAINER: 'container', // the archive/ dir itself
});

/**
 * @param {{ entries: string[],
 *           exists: (relPath: string) => boolean,
 *           readIssueState: (iid: string) => Promise<{state: string, stateReason: string|null}|null> }} deps
 * @returns {Promise<{ complete: boolean,
 *                     folders: Array<{ name: string, iid: string|null, outcome: string, detail: string|null }>,
 *                     archivable: string[],
 *                     readFailures: string[] }>}
 */
export async function selectSweep({ entries, exists, readIssueState }) {
  const outcomeOf = new Map(); // name -> { iid, outcome, detail }

  // ── Rows 1-3: local, no iid resolution needed ──────────────────────────
  const withIid = []; // { name, iid }
  for (const name of entries) {
    if (name === 'archive') {
      outcomeOf.set(name, { iid: null, outcome: OUTCOME.CONTAINER, detail: null });
      continue;
    }
    const parsed = parseChangeId(name);
    if (!parsed && !isGrandfathered(name)) {
      outcomeOf.set(name, { iid: null, outcome: OUTCOME.NOT_A_CHANGE, detail: 'does not parse as issue-<N>-<slug> and is not grandfathered' });
      continue;
    }
    if (!parsed) {
      // isGrandfathered(name) === true here (row 2's negative already ruled out the alternative).
      outcomeOf.set(name, { iid: null, outcome: OUTCOME.NO_ISSUE_KEY, detail: 'grandfathered legacy dir — no issue key to read' });
      continue;
    }
    withIid.push({ name, iid: parsed.iid });
  }

  // ── Row 4: collisions — grouped, order-independent, blocks ALL members ──
  const byIid = new Map(); // iid -> name[]
  for (const entry of withIid) {
    if (!byIid.has(entry.iid)) byIid.set(entry.iid, []);
    byIid.get(entry.iid).push(entry.name);
  }
  const afterCollisions = [];
  for (const entry of withIid) {
    const siblings = byIid.get(entry.iid);
    if (siblings.length > 1) {
      outcomeOf.set(entry.name, {
        iid: entry.iid,
        outcome: OUTCOME.COLLISION,
        detail: `issue #${entry.iid} is shared by ${siblings.length} live folders: ${[...siblings].sort().join(', ')}`,
      });
      continue;
    }
    afterCollisions.push(entry);
  }

  // ── Row 5: destination-exists — local, no network ───────────────────────
  const needsRead = [];
  for (const entry of afterCollisions) {
    const dest = archivePath(entry.iid);
    if (exists(dest)) {
      outcomeOf.set(entry.name, { iid: entry.iid, outcome: OUTCOME.DESTINATION_EXISTS, detail: `${dest} already exists` });
      continue;
    }
    needsRead.push(entry);
  }

  // ── Rows 6-10: network, memoized per distinct iid ───────────────────────
  // Every non-colliding folder already carries a unique iid at this point
  // (row 4 removed every shared iid), so this is naturally at most one read
  // per distinct iid — the Set below makes that property explicit and
  // guards it even if a future caller feeds a differently-shaped `entries`.
  const distinctIids = [...new Set(needsRead.map(e => e.iid))];
  const stateByIid = new Map();
  await Promise.all(
    distinctIids.map(async (iid) => {
      stateByIid.set(iid, await readIssueState(iid));
    })
  );

  const readFailures = [];
  for (const entry of needsRead) {
    const state = stateByIid.get(entry.iid);

    if (state === null || state === undefined) {
      outcomeOf.set(entry.name, { iid: entry.iid, outcome: OUTCOME.UNREADABLE, detail: 'issue state could not be read' });
      if (!readFailures.includes(entry.iid)) readFailures.push(entry.iid);
      continue;
    }
    if (state.state !== 'open' && state.state !== 'closed') {
      outcomeOf.set(entry.name, {
        iid: entry.iid,
        outcome: OUTCOME.UNREADABLE,
        detail: `unrecognized issue state: ${JSON.stringify(state.state)}`,
      });
      if (!readFailures.includes(entry.iid)) readFailures.push(entry.iid);
      continue;
    }
    if (state.state === 'open') {
      outcomeOf.set(entry.name, { iid: entry.iid, outcome: OUTCOME.OPEN, detail: 'issue is open — left in place' });
      continue;
    }
    if (state.stateReason === 'not_planned') {
      outcomeOf.set(entry.name, { iid: entry.iid, outcome: OUTCOME.NOT_PLANNED, detail: "closed, not archivable — issue closed as 'not planned'" });
      continue;
    }
    outcomeOf.set(entry.name, { iid: entry.iid, outcome: OUTCOME.ARCHIVABLE, detail: null });
  }

  const folders = entries.map((name) => {
    const r = outcomeOf.get(name);
    return { name, iid: r.iid, outcome: r.outcome, detail: r.detail };
  });

  const archivable = folders.filter(f => f.outcome === OUTCOME.ARCHIVABLE).map(f => f.name);
  const complete = readFailures.length === 0;

  return { complete, folders, archivable, readFailures };
}
