#!/usr/bin/env node
// postmerge/cursor.mjs — remote-authoritative, tri-state cursor + atomic CAS
// advance (design §2). `actions/checkout` never fetches `refs/governance/*`,
// so a never-fetched ref and a genuinely absent ref are indistinguishable to
// a plain local `rev-parse` (the F2 bug). The REMOTE is the sole authority:
// state is read directly from the sha `ls-remote --exit-code` returns, and an
// advance is gated solely by the remote `push --force-with-lease`. No local
// governance ref is ever read or written — a plain checkout has none.

import { fileURLToPath } from 'node:url';
import { gitTry, gitOrThrow } from './git-seam.mjs';

export const CURSOR_REF = 'refs/governance/audit-cursor';
const REMOTE = 'origin';
const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Tri-state cursor read. The REMOTE is the authority: `ls-remote
 * --exit-code` status 2 is git's own documented proof of absence; any other
 * non-zero status (network/auth/unreachable) is 'unknown', never 'absent'.
 * On status 0 the ref exists on origin and `ls-remote` already returned its
 * sha ("<sha>\t<ref>") — the sha is read from that answer directly, so a
 * never-fetched local ref is irrelevant.
 */
export function readCursor({ git }) {
  const lsRemote = git.try(['ls-remote', '--exit-code', REMOTE, CURSOR_REF]);
  if (lsRemote.status === 2) return { state: 'absent' };
  if (lsRemote.status !== 0) return { state: 'unknown' };

  // status 0: origin has the ref. Parse the 40-hex sha from ls-remote's own
  // stdout ("<sha>\t<ref>"). Malformed/missing sha is an inconsistency —
  // 'unknown', never silently downgraded to 'absent'.
  const sha = lsRemote.stdout.trim().split(/\s+/)[0];
  if (!HEX40.test(sha)) return { state: 'unknown' };

  return { state: 'present', sha };
}

/**
 * The window is ALWAYS cursor..HEAD — no eventName/before branching. The
 * audited interval and the advanced interval are the same interval by
 * construction (design §2.2 — the skip-over fix).
 */
export function resolveWindow({ git, head }) {
  const cursor = readCursor({ git });
  if (cursor.state !== 'present') return { state: cursor.state };

  const ancestor = git.try(['merge-base', '--is-ancestor', cursor.sha, head]);
  if (ancestor.status !== 0) {
    return { state: 'unknown', reason: 'cursor is not an ancestor of HEAD' };
  }
  return {
    state: 'present', base: cursor.sha, range: `${cursor.sha}..${head}`, head,
  };
}

/**
 * Atomic compare-and-swap advance. `from` is REQUIRED and 40-hex, so this
 * function structurally cannot create the ref (an absent ref's null OID can
 * never equal a 40-hex `from`) — "never auto-create" is git's own CAS, not a
 * caller-side check (design §2.3). The SOLE authority is the remote
 * `push --force-with-lease`: the server verifies the lease's old value before
 * accepting. No local governance ref is touched — a plain checkout has none,
 * and a local CAS here would only mask the remote lease and break the human
 * accept path on such a checkout.
 */
export function advanceCursor({ git, from, to }) {
  if (typeof from !== 'string' || !HEX40.test(from)) {
    throw new Error('advanceCursor: from must be a 40-hex sha');
  }
  // `to` is the human's asserted target (design §2.4): it MUST be a pinned
  // 40-hex OID, never a symbolic/moving ref (e.g. 'main') resolved at runtime.
  // Same doctrine as the explicit `from` — validated BEFORE the ancestor check
  // so a well-formed-but-non-commit sha still fails closed at merge-base.
  if (typeof to !== 'string' || !HEX40.test(to)) {
    throw new Error('advanceCursor: to must be a 40-hex sha');
  }
  const ancestor = git.try(['merge-base', '--is-ancestor', from, to]);
  if (ancestor.status !== 0) {
    throw new Error(`advanceCursor: from (${from}) is not an ancestor of to (${to})`);
  }
  // Remote CAS — the ONLY authority. The server verifies the lease's old
  // value (`from`) before accepting; a stale `from` is rejected here.
  git.orThrow(['push', `--force-with-lease=${CURSOR_REF}:${from}`, REMOTE, `${to}:${CURSOR_REF}`]);
  return { from, to };
}

/**
 * The ONLY non-tree resolution path (design §2.4). `from` is the CALLER's
 * (the human's) explicit assertion of the cursor value they reviewed — it is
 * NOT read from the live cursor here. That is what gives the CAS its
 * function on this path: if the live cursor has moved between the human's
 * review and this call (e.g. an automatic advance ran in between), the CAS
 * inside `advanceCursor` fails loud instead of silently advancing from
 * wherever the cursor now is.
 */
export function acceptManually({
  git, from, to, reason,
}) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('acceptManually: --reason is required and must be non-empty');
  }
  if (typeof from !== 'string' || !HEX40.test(from)) {
    throw new Error('acceptManually: from must be a 40-hex sha');
  }
  process.stdout.write(`accept: ${reason}\n`);
  return advanceCursor({ git, from, to });
}

/**
 * #1162 — initialize the cursor of a NEW repository. A missing cursor is only
 * a bootstrap state when the repository has never completed an audited run:
 * `priorAudit()` reports 'none' | 'some' | 'unknown' from evidence outside the
 * ref (a successful prior run of this very workflow on the default branch —
 * that run advanced the cursor, so its existence proves the cursor once
 * existed and was deleted).
 *
 *   • 'some'    → refused: the cursor is GONE, not new. The caller alarms.
 *   • 'unknown' → unknown: the evidence could not be read. Never a bootstrap.
 *
 * The base is the ADOPTION COMMIT itself — the first commit on the first-parent
 * line that ADDED the postmerge workflow — in every shape (root or not). The
 * first window (base..HEAD) audits everything AFTER it. A gate cannot be
 * authoritative over the commit that installs it (it may be over budget, have
 * no issue link, and would be nominated for auto-revert: reverting your own
 * adoption), and nothing after the adoption escapes the audit. No adoption
 * commit found → unknown, never a guessed base.
 *
 * Creation is a CAS: `--force-with-lease=<ref>:` (empty expectation) makes the
 * remote refuse if the ref appeared in the meantime; a lost race re-reads the
 * ref and proceeds when it now exists (`present`).
 */
export async function bootstrapCursor({ git, workflowPath, priorAudit }) {
  const current = readCursor({ git });
  if (current.state === 'present') return { state: 'present', sha: current.sha };
  if (current.state !== 'absent') return { state: 'unknown', reason: 'cursor state could not be read' };

  const raw = await priorAudit();
  // A reader may say WHY it could not read: `{ evidence: 'unknown', why }`, where
  // `why` is the port's own state ('unsupported' vs 'unknown'), so the alarm names it.
  const evidence = typeof raw === 'object' && raw !== null ? raw.evidence : raw;
  const why = typeof raw === 'object' && raw !== null ? raw.why : 'unknown';
  if (evidence === 'some') {
    return { state: 'refused', reason: 'a prior successful audited run exists, so the cursor was deleted, not never created' };
  }
  if (evidence !== 'none') return { state: 'unknown', reason: `prior audited-run evidence could not be read (${why ?? 'unknown'})` };

  const log = git.try(['log', '--first-parent', '--diff-filter=A', '--format=%H', '--reverse', '--', workflowPath]);
  const adoption = log.status === 0 ? log.stdout.trim().split('\n')[0] : '';
  if (!HEX40.test(adoption)) return { state: 'unknown', reason: `no adoption commit found for ${workflowPath}` };

  const push = git.try(['push', `--force-with-lease=${CURSOR_REF}:`, REMOTE, `${adoption}:${CURSOR_REF}`]);
  if (push.status !== 0) {
    const again = readCursor({ git });
    if (again.state === 'present') return { state: 'present', sha: again.sha };
    return { state: 'unknown', reason: 'cursor creation was refused by the remote (no permission, or lost a race and the ref is unreadable)' };
  }
  return { state: 'bootstrapped', base: adoption, adoption };
}

/**
 * The remote's default branch from its own HEAD symref (`ls-remote --symref`):
 * remote-authoritative and independent of the workflow trigger's payload.
 * Returns undefined when unreadable (the port then answers unknown: an alarm).
 */
export function resolveDefaultBranch(git) {
  const r = git.try(['ls-remote', '--symref', REMOTE, 'HEAD']);
  if (r.status !== 0) return undefined;
  const m = r.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  return m ? m[1] : undefined;
}

/**
 * Manifest read by `vcs/lib/workflow-auth.mjs` (issue #535): which subcommands
 * can reach the VCS port. Only `bootstrap` does (its prior-run evidence comes
 * from the port's `workflowRunSucceeded`); `window` and `accept` touch git only.
 */
export const SUBCOMMAND_PORT_REACH = {
  'window': false,
  'accept': false,
  'bootstrap': true,
};

// ── CLI ────────────────────────────────────────────────────────────────────

function makeRealGit(cwd) {
  return { try: (argv) => gitTry(argv, { cwd }), orThrow: (argv) => gitOrThrow(argv, { cwd }) };
}

function usage() {
  process.stderr.write('Usage: cursor.mjs window | cursor.mjs bootstrap [<workflow-path>] [--branch <default-branch>] | cursor.mjs accept <from> <to> --reason "<text>"\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const git = makeRealGit(process.cwd());
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'window') {
    const head = git.orThrow(['rev-parse', 'HEAD']).trim();
    const result = resolveWindow({ git, head });
    if (result.state === 'present') {
      console.log(`PRESENT ${result.base} ${result.head}`);
      process.exit(0);
    } else if (result.state === 'absent') {
      console.log('ABSENT');
      process.exit(2);
    } else {
      console.log(`UNKNOWN ${result.reason ?? ''}`.trimEnd());
      process.exit(2);
    }
  } else if (cmd === 'bootstrap') {
    // async body: the prior-run evidence comes through the VCS port.
    // Flags first, then the positional: `--branch <v>` (and its value) never
    // counts as the workflow path, wherever it sits.
    const bi = rest.indexOf('--branch');
    // `github.event.repository.default_branch` is EMPTY on `schedule` runs, so an
    // absent/empty --branch falls back to the remote's own HEAD — present on every trigger.
    const flagged = bi !== -1 ? rest[bi + 1] : undefined;
    const branch = flagged || resolveDefaultBranch(git);
    const positional = rest.filter((tok, i) => !tok.startsWith('--') && !(bi !== -1 && i === bi + 1));
    const workflowPath = positional[0] ?? '.github/workflows/governance-postmerge.yml';
    const priorAudit = async () => {
      try {
        const { getVcs } = await import('../../vcs/cli.mjs');
        const vcs = await getVcs();
        const r = await vcs.workflowRunSucceeded({
          project: process.env.GITHUB_REPOSITORY, workflow: workflowPath.split('/').pop(), branch,
        });
        if (r?.state === 'succeeded') return 'some';
        if (r?.state === 'none') return 'none';
        // 'unknown' and 'unsupported' alike: never a bootstrap, but named apart.
        return { evidence: 'unknown', why: r?.state === 'unsupported' ? 'unsupported' : 'unknown' };
      } catch { /* surfaced: an unreachable port is 'unknown', which the caller alarms — never a bootstrap */
        return 'unknown';
      }
    };
    const result = await bootstrapCursor({ git, workflowPath, priorAudit });
    if (result.state === 'bootstrapped') {
      console.log(`BOOTSTRAPPED ${result.base} ${result.adoption}`);
      process.exit(0);
    } else if (result.state === 'present') {
      console.log(`PRESENT ${result.sha}`);
      process.exit(0);
    } else if (result.state === 'refused') {
      console.log(`REFUSED ${result.reason}`);
      process.exit(2);
    } else {
      console.log(`UNKNOWN ${result.reason}`);
      process.exit(2);
    }
  } else if (cmd === 'accept') {
    const from = rest[0];
    const to = rest[1];
    const reasonIdx = rest.indexOf('--reason');
    const reason = reasonIdx !== -1 ? rest[reasonIdx + 1] : undefined;
    if (!from || !to || !reason) {
      usage();
      process.exit(1);
    } else {
      try {
        acceptManually({
          git, from, to, reason,
        });
        process.exit(0);
      } catch (err) {
        process.stderr.write(`cursor.mjs accept: ${err.message}\n`);
        process.exit(1);
      }
    }
  } else {
    usage();
    process.exit(1);
  }
}
