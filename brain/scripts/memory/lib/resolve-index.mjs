// resolve-index.mjs — issue #330. The one-command resolution for a conflicted
// `.memory/index.jsonl`.
//
// Doctrine fixes the resolution and forbids the alternatives: the index is
// DERIVED and regenerable, so a merge conflict on it "is resolved by discarding
// both sides and running brain:memory:reindex — it is NEVER hand-merged and NEVER
// union-merged" (memory-format.md:145-153, adr-0017:121-129). The conflict
// ergonomics "MAY be a helper or a post-merge hook, but MUST NOT require a
// custom merge driver for index.jsonl" (adr-0017:143-147). This is that helper.
//
// It is deliberately safe for BOTH callers:
//   * the operator, after git reports the conflict — it regenerates AND stages,
//     completing the merge with no judgement call;
//   * the post-merge hook, after a clean merge — nothing is unmerged, so it
//     only normalizes and stages NOTHING. (A post-merge hook cannot resolve a
//     conflict: git does not fire it when the merge fails. Its job here is to
//     keep the index canonical, not to rescue a conflict.)

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { rebuildIndex } from './store.mjs';
import { normalizeDuplicates } from './duplicates.mjs';

export const INDEX_REPO_PATH = '.memory/index.jsonl';

/** A physical line opening with a conflict marker. Records are one complete
 * JSON object per line, so a line starting with `<<<<<<<`, `=======` or
 * `>>>>>>>` can only be a marker — never record content, which would carry
 * those bytes escaped INSIDE a string on a single line. */
const MARKER_RE = /^(?:<{7}|={7}|>{7})/;

/** Records files carrying conflict markers. The index is derived FROM these,
 * so regenerating over a conflicted log would bake the markers into the index
 * and report success. */
export function conflictedRecordFiles({ recordsDir, deps = {} }) {
  const exists = deps.existsSync ?? existsSync;
  const readdir = deps.readdirSync ?? readdirSync;
  const read = deps.readFileSync ?? readFileSync;

  if (!exists(recordsDir)) return [];
  return readdir(recordsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .filter((f) => read(join(recordsDir, f), 'utf8').split('\n').some((line) => MARKER_RE.test(line)));
}

/**
 * Regenerates `.memory/index.jsonl` from `.memory/records/`, discarding
 * whatever the merge left in the working tree, and stages it when — and only
 * when — git still considers the path unmerged.
 *
 * @param {{repoRoot: string, deps?: object}} args
 * @returns {{count: number, staged: boolean, duplicates: object}}
 *   `duplicates` (#574) is the union-merge residual the regenerated index just
 *   collapsed — passed straight through from `rebuildIndex` so cli.mjs prints
 *   it. This helper runs on exactly the event that mints those lines.
 */
export function resolveIndex({ repoRoot, deps = {} }) {
  const runGit = deps.runGit
    ?? ((args) => spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' }));
  const reindex = deps.rebuildIndex ?? rebuildIndex;

  const recordsDir = join(repoRoot, '.memory', 'records');
  const indexPath = join(repoRoot, '.memory', 'index.jsonl');

  // FAIL CLOSED (§10): never regenerate from a log that is itself conflicted.
  const conflicted = conflictedRecordFiles({ recordsDir, deps });
  if (conflicted.length > 0) {
    throw new Error(
      `conflict markers found in records/: ${conflicted.join(', ')}. `
      + 'Resolve records/ first — the index is derived from it and regenerating now would bake the markers in.',
    );
  }

  // Read the unmerged set BEFORE the rebuild: writing the file does not clear
  // git's unmerged state, but reading first keeps the decision independent of
  // any side effect of the write.
  const unmerged = runGit(['diff', '--name-only', '--diff-filter=U']);
  const wasUnmerged = String(unmerged.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .includes(INDEX_REPO_PATH);

  const { count, duplicates: rawDuplicates } = reindex({ recordsDir, indexPath });
  const duplicates = normalizeDuplicates(rawDuplicates);

  if (!wasUnmerged) return { count, staged: false, duplicates };

  const added = runGit(['add', '--', INDEX_REPO_PATH]);
  if (added.status !== 0) {
    throw new Error(`git add ${INDEX_REPO_PATH} failed: ${String(added.stderr ?? '').trim()}`);
  }
  return { count, staged: true, duplicates };
}
