// local-gate-context.mjs — what the LOCAL gates (`brain:check`, `brain:ship`) need to
// know about the repo before a pull request exists (#1186, #1187).
//
// Nothing here is a new rule. Each function answers a question the rest of the product
// already answers, in the same order, so a local verdict is computed from the same inputs
// as the CI verdict it anticipates:
//
//   · project slug    — `brain.config.json` `project.slug`, else the origin remote
//                       (the two sources `ensureProjectIdentity` fills the field from).
//   · default branch  — `DEFAULT_BRANCH` (what ci-context reads), else git's recorded
//                       `origin/HEAD`, else the remote's own HEAD symref via
//                       `postmerge/cursor.mjs#resolveDefaultBranch` (#1162).
//   · npm test        — applicable only where CI runs it (see `npmTestApplicability`).
//
// Every answer is `null`/"not applicable" when it cannot be computed. None of them guesses
// `main`: a guess is the confident false green #340 records.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { originIdentity } from '../vcs/lib/repo.mjs';
import { gitTry } from '../governance/postmerge/git-seam.mjs';
// The remote-authoritative reader #1162 added for the post-merge audit. Reused, not copied:
// one implementation of "ask the remote what its default branch is".
import { resolveDefaultBranch as remoteDefaultBranch } from '../governance/postmerge/cursor.mjs';

/**
 * The slug the VCS port's verbs take as `project`.
 *
 * `brain.config.json` first — `brain:ship`, `brain:protect`, `brain:governance-status` and
 * `brain:next` all read `project.slug` and nothing else — then the origin remote, which is
 * where `ensureProjectIdentity` copies the slug from on `env:init`. Returns `null`, never
 * a placeholder: `repos/undefined/issues/1` is what an unset field became (#1186).
 *
 * @param {{ config?: object, identity?: () => { project: string|null } }} [opts]
 * @returns {string|null}
 */
export function resolveProjectSlug({ config = {}, identity = originIdentity } = {}) {
  const configured = config?.project?.slug;
  if (typeof configured === 'string' && configured !== '') return configured;
  return identity()?.project ?? null;
}

/**
 * The remote's default branch, with no `git remote set-head` owed by the operator (#1186).
 *
 * Order: `DEFAULT_BRANCH` (the variable `ci-context.mjs` reads, one name across both
 * surfaces) → git's recorded `origin/HEAD` (local, no network) → `ls-remote --symref
 * origin HEAD` (remote-authoritative, the #1162 reader). The last step only READS: it does
 * not write `origin/HEAD`, so a verb that reports never mutates the operator's repo.
 * `null` when none answers — the caller treats that as UNVERIFIED, never as `main`.
 *
 * @param {{ cwd?: string, env?: object, git?: { try: (argv: string[]) => { status: number, stdout: string } } }} [opts]
 * @returns {string|null}
 */
export function resolveDefaultBranch({ cwd = process.cwd(), env = process.env, git } = {}) {
  if (env.DEFAULT_BRANCH) return env.DEFAULT_BRANCH;
  const seam = git ?? { try: (argv) => gitTry(argv, { cwd }) };
  const recorded = seam.try(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (recorded.status === 0 && recorded.stdout.trim() !== '') {
    return recorded.stdout.trim().replace(/^origin\//, '');
  }
  return remoteDefaultBranch(seam) ?? null;
}

/**
 * Whether the `npm test` gate applies here, and why not when it does not (#1187).
 *
 * CI's `local-checks` job runs `npm test` only `if: hashFiles('.brain-source') != ''` —
 * the brain SOURCE repo — because the suite exercises brain's own tooling and "running it
 * in a consumer is a portability treadmill" (governance.yml, issues #206/#211). A local
 * gate that runs it everywhere is stricter than the gate it front-runs: a fresh consumer's
 * `npm init` placeholder (`echo "Error: no test specified" && exit 1`) failed it on a PR
 * CI passed. So this follows CI's own condition, then adds the obvious one: no `test`
 * script, nothing to run.
 *
 * @param {{ cwd?: string }} [opts]
 * @returns {{ applicable: true } | { applicable: false, reason: string }}
 */
export function npmTestApplicability({ cwd = process.cwd() } = {}) {
  if (!existsSync(join(cwd, '.brain-source'))) {
    return {
      applicable: false,
      reason: 'CI runs `npm test` only in the brain source repo (.brain-source marker absent) — not applicable here',
    };
  }
  let scripts;
  try {
    scripts = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))?.scripts;
  } catch {
    return { applicable: false, reason: 'no readable package.json — no "test" script to run, not applicable' };
  }
  if (typeof scripts?.test !== 'string' || scripts.test.trim() === '') {
    return { applicable: false, reason: 'no "test" script in package.json — not applicable' };
  }
  return { applicable: true };
}
