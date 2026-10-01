// stranded.mjs — issue #323 S5, the #713 surface: "a chain that stopped
// halfway must produce a signal that differs from a chain that finished."
//
// An unterminated chain is the ABSENCE of a PR — no PR-triggered check can
// fire on it, which is why this is a SURFACE (reported where people already
// look) and not a seventh check of the shape that cannot see it. The
// maintainer's rulings (02/09): only `feature/*` trackers count (a WIP task
// branch is not a chain), and the surface REPORTS — refusing would fail
// closed on every chain legitimately in flight.
//
// PURE: lists in, verdict out. The CLI half feeds it from plain git
// (commits ahead of the default) and the VCS adapter's PR list (ADR-0008 —
// never a bare `gh` call; #602/#603 are what bare calls cost).

/**
 * @param {{branches?: Array<{name: string, aheadOfDefault: number}>, openPrHeads?: string[]}} args
 * @returns {Array<{name: string, aheadOfDefault: number}>}
 */
export function strandedTrackers({ branches, openPrHeads } = {}) {
  const list = Array.isArray(branches) ? branches : [];
  const carried = new Set(Array.isArray(openPrHeads) ? openPrHeads : []);
  return list.filter((b) =>
    typeof b?.name === 'string' &&
    b.name.startsWith('feature/') &&
    Number(b.aheadOfDefault) > 0 &&
    !carried.has(b.name)
  );
}

/**
 * The I/O half: branches ahead of the default from plain git; open-PR heads
 * from the VCS adapter (never a bare forge call). Degrades IN BAND — one
 * unreachable server must not take the section with it, runStatus's own rule.
 *
 * @param {{vcs?: object, project?: string|null, root?: string, tracker?: string,
 *          _run?: Function}} deps
 * @returns {Promise<{stranded: Array<{name: string, aheadOfDefault: number}>, reason: string|null}>}
 */
export async function gatherStranded({ vcs, project, root = process.cwd(), tracker = 'origin/main', _run } = {}) {
  // Review round 1 of #841, reproduced with /tmp/PWNED: the first cut built
  // `git rev-list --count ${tracker}..${name}` through execSync's sh -c, and
  // git accepts `$( )` inside a ref component — a hostile branch NAME executed
  // as shell. The house convention (review/, brain-writes-reviewed, checkpoint)
  // is execFileSync with an args ARRAY precisely so ref data can never be
  // code; this function's own header invoked that principle for the forge half
  // while its git half violated it. File + args, no shell, ever.
  const run = _run ?? (await import('node:child_process')).execFileSync;
  let branches = [];
  try {
    const names = String(run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/feature'], { cwd: root, encoding: 'utf8' }))
      .split('\n').map((l) => l.trim()).filter(Boolean);
    branches = names.map((name) => ({
      name,
      aheadOfDefault: Number(String(run('git', ['rev-list', '--count', `${tracker}..${name}`], { cwd: root, encoding: 'utf8' })).trim()) || 0,
    }));
  } catch (err) {
    return { stranded: [], reason: `git could not answer — ${err?.message ?? err}` };
  }
  let openPrHeads = [];
  if (vcs && project) {
    try {
      const prs = await vcs.mrList({ project, state: 'open' });
      // Round 2 of #841: the port's BOTH producers (github.mjs, gitlab.mjs)
      // normalize this field to `headBranch` — and the first cut read two
      // invented names while its mocks invented the same two, so tests and
      // code agreed with each other and disagreed with reality: every tracker
      // reported stranded even with its PR open. One contract, the real name.
      openPrHeads = (Array.isArray(prs) ? prs : []).map((p) => p?.headBranch).filter(Boolean);
    } catch (err) {
      return { stranded: [], reason: `the adapter could not list open PRs — ${err?.message ?? err}` };
    }
  } else {
    return { stranded: [], reason: 'no VCS port was supplied — stranded needs the open-PR list to tell a chain in flight from one that stopped' };
  }
  return { stranded: strandedTrackers({ branches, openPrHeads }), reason: null };
}
