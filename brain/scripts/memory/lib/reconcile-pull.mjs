// reconcile-pull.mjs — issue #1118: `git pull` refuses to fast-forward over an
// untracked `.memory/records/*.jsonl` that the pull itself would create, even
// when the file is byte-identical to the incoming copy. That is exactly the
// state of the checkout that captured a record after its own lane PR merges.
//
// The rule: a byte-identical untracked record whose blob is reachable from
// `@{u}` is already durable in git's object store, so it can be deleted before
// the pull and rewritten from that blob if the pull does not verifiably
// recreate it. The oid is the backup — no copy lives anywhere else.
//
// Shared by `plainfiles.mjs#pull` and `engram.mjs#pullMemory`.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { upstreamRecordEntries } from './upstream-records.mjs';

function run(root, args, { encoding = 'utf8' } = {}) {
  return spawnSync('git', args, { cwd: root, encoding, maxBuffer: 1e9 });
}

const ok = (r) => !r.error && r.status === 0;

/**
 * `git hash-object --no-filters` of the file on disk (its raw bytes, so a CRLF
 * copy under core.autocrlf never hashes equal to an LF blob), or null.
 */
function hashOnDisk(root, path) {
  const r = run(root, ['hash-object', '--no-filters', '--', path]);
  return ok(r) ? r.stdout.trim() : null;
}

const isTrackedAtHead = (root, path) => ok(run(root, ['cat-file', '-e', `HEAD:${path}`]));

/** The blob oid git tracks at `path`: HEAD's, else the index's (a merge in progress), else null. */
function trackedOid(root, path) {
  const head = run(root, ['rev-parse', '--verify', '--quiet', `HEAD:${path}`]);
  if (ok(head)) return { oid: head.stdout.trim(), where: 'HEAD' };
  const idx = run(root, ['ls-files', '--stage', '--', path]);
  const m = ok(idx) ? /^\d+ ([0-9a-f]+) 0\t/m.exec(idx.stdout) : null;
  return m ? { oid: m[1], where: 'the index' } : null;
}

/** Only regular-file entries are reconcilable: never a symlink or a submodule. */
function isRegularFileEntry(root, target, path) {
  const r = run(root, ['ls-tree', target, '--', path]);
  return ok(r) && /^100(644|755) blob /.test(r.stdout);
}

/** `@{u}` as a short ref, or null when the branch has no upstream. */
function resolveUpstream(root) {
  const r = run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  return ok(r) && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Deletes every untracked, byte-identical record that `@{u}` also carries and
 * returns `[{path, oid}]` to verify after the pull. A record whose bytes differ
 * from the incoming copy is never touched: the whole call refuses instead.
 */
export function reconcileUntrackedRecords({ root, _unlink = unlinkSync }) {
  const target = resolveUpstream(root);
  if (!target) return [];
  const upstream = upstreamRecordEntries({ root, ref: target });
  if (!upstream.ok) return [];

  const candidates = [];
  const divergent = [];
  for (const [path, upstreamOid] of upstream.byPath) {
    if (!existsSync(join(root, path)) || isTrackedAtHead(root, path)) continue;
    if (!isRegularFileEntry(root, target, path)) continue;
    const localOid = hashOnDisk(root, path);
    if (localOid === upstreamOid) candidates.push({ path, oid: upstreamOid });
    else divergent.push(`  ${path} (local ${localOid ?? 'unreadable'} vs incoming ${upstreamOid})`);
  }
  if (divergent.length > 0) {
    throw new Error(
      `brain:memory:pull refused: ${divergent.length} untracked .memory/records/ file(s) differ from the version ` +
      `about to arrive from ${target} and were left untouched — inspect, then remove or keep each deliberately ` +
      `before pulling again:\n${divergent.join('\n')}`,
    );
  }

  const deleted = [];
  for (const c of candidates) {
    try {
      _unlink(join(root, c.path));
    } catch (err) {
      const done = deleted.map((d) => `  ${d.path} (blob ${d.oid} in ${target})`).join('\n');
      throw new Error(
        `brain:memory:pull: could not delete ${c.path}: ${err.message}` +
        (deleted.length ? `\nalready deleted, their bytes are in ${target} (@{u}) as these blobs:\n${done}` : ''),
      );
    }
    deleted.push(c);
  }
  return candidates;
}

/**
 * Checks each reconciled path after the pull. A path that is present, tracked
 * at HEAD and hashes to its oid is verified; anything else is rewritten from
 * git's own object store. A path that exists with different bytes is never
 * overwritten. Returns `{restored, problems}`: paths rewritten from the blob
 * (the pull did not recreate them) and paths that could not be brought back.
 */
export function verifyOrRestore({ root, reconciled, _log = console.log }) {
  const restored = [];
  const problems = [];
  for (const { path, oid } of reconciled) {
    const abs = join(root, path);
    if (existsSync(abs)) {
      const entry = trackedOid(root, path);
      if (entry?.oid === oid) {
        _log(`brain:memory:pull: verified ${path} — present, tracked in ${entry.where} as blob ${oid}`);
        continue;
      }
      if (entry) {
        problems.push(`${path} — tracked in ${entry.where} as a different blob (${entry.oid}, expected ${oid}); not overwritten`);
        continue;
      }
      const now = hashOnDisk(root, path);
      problems.push(now === oid
        ? `${path} — present with the original bytes but tracked neither in HEAD nor in the index`
        : `${path} — exists with different content (blob ${now ?? 'unreadable'}, expected ${oid}); not overwritten`);
      continue;
    }
    const blob = run(root, ['cat-file', 'blob', oid], { encoding: 'buffer' });
    if (!ok(blob)) {
      problems.push(`${path} — could not be restored: blob ${oid} is no longer readable (${String(blob.stderr ?? '').trim()})`);
      continue;
    }
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, blob.stdout);
    } catch (err) { /* surfaced: pushed to `problems`, which defaultGitPull throws with the pull result */
      problems.push(`${path} — could not be restored from blob ${oid}: ${err.message}`);
      continue;
    }
    if (hashOnDisk(root, path) !== oid) {
      problems.push(`${path} — rewritten from blob ${oid} but the bytes read back differ`);
      continue;
    }
    _log(`brain:memory:pull: restored ${path} from blob ${oid} (the pull did not recreate it; it is untracked again)`);
    restored.push(path);
  }
  return { restored, problems };
}

/**
 * The shared `_gitPull` default: fetch, reconcile, the literal `git pull`
 * (user's pull config intact), then verify what was reconciled.
 * `_afterReconcile` is a test-only seam for the fetch-to-pull race window.
 */
export function defaultGitPull(root, { _log = console.log, _afterReconcile } = {}) {
  execFileSync('git', ['fetch'], { stdio: 'inherit', cwd: root });
  const reconciled = reconcileUntrackedRecords({ root, _log });
  if (typeof _afterReconcile === 'function') _afterReconcile();

  let pullError = null;
  try {
    execFileSync('git', ['pull'], { stdio: 'inherit', cwd: root });
  } catch (err) { /* surfaced: kept as `pullError` and re-thrown below after verifyOrRestore, with any unrestored records appended */
    pullError = err;
  }

  const { restored, problems } = verifyOrRestore({ root, reconciled, _log });
  if (pullError) {
    if (problems.length > 0) pullError.message += `\n\nreconciled record(s) that could not be put back:\n  ${problems.join('\n  ')}`;
    throw pullError;
  }
  const unrecreated = [...restored.map((p) => `${p} — restored from its blob`), ...problems];
  if (unrecreated.length > 0) {
    throw new Error(
      `brain:memory:pull: git pull exited 0 but ${unrecreated.length} reconciled record(s) were not recreated by it:\n  ${unrecreated.join('\n  ')}`,
    );
  }
}
