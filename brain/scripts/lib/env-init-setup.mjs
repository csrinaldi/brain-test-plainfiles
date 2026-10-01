// env-init-setup.mjs — what a fresh consumer needs before its first PR and its
// first memory save, done by env:init instead of left to the operator
// (issues #1163, #1164).
//
//   labels  — the labels the gates and verbs READ. Without `status:approved` no
//             issue can be approved, so the first PR fails `issue-link`.
//   actor   — `git config brain.actor`, which `brain:memory:save` refuses to run
//             without. Never guessed from `user.name`.
//
// Both go through the VCS port (`getVcs`), never a raw `gh`/`glab` call, and both
// DEGRADE: an unreachable or unauthenticated VCS is a pending step that names the
// exact command, not a crash and not a silent skip.
//
// Exit codes for the CLI (bootstrap.sh classifies by them): 0 done, 3 pending
// (optional, exit 0 for env:init), anything else is a defect of this script.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { resolveApprovedLabel } from '../governance/approved-label.mjs';
import { TYPE_LABELS } from '../vcs/contributor-scaffold.mjs';
import { HANDLE_RE } from '../memory/lib/format.mjs';
import { gitConfigGet } from './git-config.mjs';
import { gitlabApiConfig } from '../vcs/ci-context.mjs';
import { loadBrainConfigOrThrow } from './brain-config.mjs';

/**
 * The `governance:*` labels `.github/workflows/governance-postmerge.yml` files
 * alarm issues under (GitHub only: the GitLab fragment files none). A test reads
 * the workflow and fails when it files a label that is not listed here.
 */
export const ALARM_LABELS = Object.freeze([
  'governance:archive-sweep-failed',
  'governance:audit-uncomputable',
  'governance:audit-unrevertible',
  'governance:cursor-missing',
  'governance:cursor-unknown',
  'governance:postmerge-unreported',
  'governance:revert-blocked',
]);

const GITLAB_COM_API = 'https://gitlab.com/api/v4';

/**
 * The transport a GitLab port call needs to reach the consumer's OWN host: the adapters default
 * `apiBase` to gitlab.com, so a self-hosted consumer would query the wrong server and get a pending
 * step no re-run can close. An explicit pipeline value (`gitlabApiConfig`, the resolution every other
 * GitLab caller uses) wins; otherwise it is derived from `project.gitHost`. GitHub passes nothing.
 *
 * @param {{ config: object, provider: string, env?: object }} args
 * @returns {{ apiBase?: string, proxyUrl?: string }}
 */
export function vcsTransport({ config, provider, env = process.env }) {
  if (provider !== 'gitlab') return {};
  const { apiBase, proxyUrl } = gitlabApiConfig({ env });
  const host = config?.project?.gitHost;
  const base = apiBase !== GITLAB_COM_API ? apiBase : host && host !== 'gitlab.com' ? `https://${host}/api/v4` : undefined;
  return { ...(base ? { apiBase: base } : {}), ...(proxyUrl ? { proxyUrl } : {}) };
}

/** GitLab scoped form (`key::value`), the same mechanical mapping `resolveApprovedLabel` applies. */
const scoped = (name, provider) => (provider === 'gitlab' && !name.includes('::') ? name.replace(':', '::') : name);

/**
 * @param {{ config: object, provider: string }} args
 * @returns {{ name: string, color: string, description: string }[]}
 */
export function desiredLabels({ config, provider }) {
  const out = [{ name: resolveApprovedLabel(config, provider), color: '0E8A16', description: 'Issue approved by a human — the issue-link gate reads this' }];
  for (const { label, description } of TYPE_LABELS) out.push({ name: scoped(label, provider), color: 'ededed', description });
  out.push({ name: 'size:exception', color: 'FBCA04', description: 'Waives the diff-size budget where the tier honors it' });
  out.push({ name: 'skip:memory-gate', color: 'FBCA04', description: 'Waives the memory-gate where the tier honors it' });
  if (provider === 'github') {
    for (const name of ALARM_LABELS) out.push({ name, color: 'B60205', description: 'governance postmerge halt' });
  }
  return out;
}

const HAND_COMMAND = {
  github: (n) => `gh label create "${n}"`,
  gitlab: (n) => `glab label create --name "${n}"`,
};

/**
 * Creates the missing labels. Reads the remote's label set FIRST and only creates
 * what is absent, so a second run makes no write. Never throws.
 *
 * @param {{ config: object, provider: string, project: string, vcs: { labelList: Function, labelCreate: Function } }} args
 * @returns {Promise<{ created: string[], existing: string[], failed: {name:string,error:string}[], pending: null|{reason:string,next:string} }>}
 */
export async function ensureLabels({ config, provider, project, vcs, env }) {
  const transport = vcsTransport({ config, provider, env });
  const result = { created: [], existing: [], failed: [], pending: null };
    const handFor = (names) => names.map((n) => (HAND_COMMAND[provider] ?? HAND_COMMAND.github)(n)).join('; ');
  // `npm run brain:env:init` is the one command that creates them all; the hand commands cover what was refused.
  const allNames = desiredLabels({ config, provider }).map((l) => l.name);
  const pending = (reason, names = allNames) => ({ reason, next: `npm run brain:env:init once the VCS is reachable and authenticated, or by hand: ${handFor(names)}` });
  if (!project) {
    result.pending = pending('project.slug is empty in brain.config.json');
    return result;
  }
  let have;
  try {
    have = new Set(await vcs.labelList({ project, ...transport }));
  } catch (e) { // surfaced: the cause becomes result.pending.reason, which the CLI prints and env:init lists as a pending step
    result.pending = pending(`could not read the remote's labels — ${e.message}`);
    return result;
  }
  for (const label of desiredLabels({ config, provider })) {
    if (have.has(label.name)) { result.existing.push(label.name); continue; }
    const r = await vcs.labelCreate({ project, ...transport, ...label });
    if (!r.ok) result.failed.push({ name: label.name, error: r.error });
    else (r.created ? result.created : result.existing).push(label.name);
  }
  if (result.failed.length) {
    result.pending = pending(`the remote refused ${result.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`, result.failed.map((f) => f.name));
  }
  return result;
}

const ACTOR_NEXT = 'git config --local brain.actor @<handle>';

/**
 * Resolves `brain.actor`. An existing valid value is KEPT (a human's choice is
 * never overwritten); otherwise the authenticated VCS identity is written to the
 * LOCAL git config; otherwise it is pending. Never derived from `user.name`.
 *
 * @param {{ vcs: { whoami: Function }, transport?: object, gitGet: () => string|null, gitSet: (v: string) => void }} args
 * @returns {Promise<{ status: 'kept'|'set'|'pending', actor?: string, reason?: string, next?: string }>}
 */
export async function resolveBrainActor({ vcs, gitGet, gitSet, transport = {} }) {
  const existing = gitGet();
  if (existing && HANDLE_RE.test(existing.trim()) && existing.trim() !== '@legacy') return { status: 'kept', actor: existing.trim() };
  let username;
  try {
    ({ username } = await vcs.whoami(transport));
  } catch (e) { // surfaced: the cause becomes the returned pending reason, which the CLI prints and env:init lists as a pending step
    return { status: 'pending', reason: `no authenticated VCS identity — ${e.message}`, next: ACTOR_NEXT };
  }
  const handle = `@${username}`;
  if (!username || !HANDLE_RE.test(handle)) {
    return { status: 'pending', reason: `the VCS identity "${username}" is not a handle`, next: ACTOR_NEXT };
  }
  gitSet(handle);
  return { status: 'set', actor: handle };
}

// ── CLI ────────────────────────────────────────────────────────────────────────

const say = (s) => console.log(s);

/**
 * An unparseable config is already reported, once and as itself, by bootstrap.sh's `ensure` step
 * (REQUIRED); repeating it here as a defect of this script would say the same cause three times.
 */
function readConfig(cwd) {
  try {
    return loadBrainConfigOrThrow(cwd);
  } catch (e) { // surfaced: bootstrap.sh's ensure step already reports the unparseable config as a REQUIRED failure; this step says it skipped and why
    say(`  ⚠ skipped: ${e.message}`);
    return null;
  }
}

// Config is DATA owned by the root bootstrap.sh `cd`s to (REPO_ROOT, the main tree), while this
// code may run from a linked worktree (#1102): read it from cwd, never from this module's location.
async function runLabels() {
  const config = readConfig(process.cwd());
  if (!config) return 0;
  const provider = process.env.VCS_PROVIDER || config?.vcs?.provider || '';
  let vcs;
  try {
    const { getVcs } = await import('../vcs/cli.mjs');
    vcs = await getVcs({ config });
  } catch (e) { // surfaced: the cause becomes the pending reason, which the CLI prints and env:init lists as a pending step
    return report({ pending: { reason: e.message, next: 'npm run brain:env:init once vcs.provider is configured' }, created: [], existing: [], failed: [] });
  }
  return report(await ensureLabels({ config, provider, project: config?.project?.slug ?? '', vcs }));
}

function report(r) {
  if (r.created.length) say(`  ✓ governance labels created: ${r.created.join(', ')}`);
  if (r.existing.length && !r.created.length && !r.pending) say(`  ✓ governance labels: all ${r.existing.length} already exist`);
  else if (r.existing.length && r.pending) say(`  ✓ governance labels already existing: ${r.existing.join(', ')}`);
  if (r.failed.length) say(`  ✗ governance labels refused: ${r.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`);
  if (r.pending) {
    say(`  ⚠ governance labels not fully created — ${r.pending.reason}`);
    say(`NEXT: governance labels (next: ${r.pending.next})`);
    return 3;
  }
  return 0;
}

async function runActor() {
  const cwd = process.cwd();
  const config = readConfig(cwd);
  if (!config) return 0;
  let vcs = { whoami: async () => { throw new Error('the VCS port could not be loaded'); } };
  try {
    const { getVcs } = await import('../vcs/cli.mjs');
    vcs = await getVcs({ config });
  } catch { /* surfaced: the double above throws on use, and resolveBrainActor turns that into the pending step naming the cause */ }
  const r = await resolveBrainActor({
    vcs,
    transport: vcsTransport({ config, provider: process.env.VCS_PROVIDER || config?.vcs?.provider || '' }),
    gitGet: () => gitConfigGet('brain.actor', cwd),
    gitSet: (v) => {
      const w = spawnSync('git', ['config', '--local', 'brain.actor', v], { cwd, encoding: 'utf8' });
      if (w.status !== 0) throw new Error(`git config --local brain.actor failed: ${w.stderr}`);
    },
  });
  if (r.status === 'kept') say(`  ✓ brain.actor: ${r.actor} (already configured; left unchanged)`);
  else if (r.status === 'set') say(`  ✓ brain.actor: ${r.actor} (from your authenticated VCS identity, written to the local git config)`);
  else {
    say(`  ⚠ brain.actor is not configured — ${r.reason}`);
    say(`NEXT: brain.actor (next: ${r.next})`);
    return 3;
  }
  return 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const sub = process.argv[2];
  const run = { labels: runLabels, actor: runActor }[sub];
  if (!run) {
    console.error(`env-init-setup: unknown step '${sub}'. One of: labels, actor`);
    process.exit(2);
  }
  process.exitCode = await run();
}
