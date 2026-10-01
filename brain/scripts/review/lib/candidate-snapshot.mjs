import { readdirSync, readFileSync, readlinkSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function entry(root, path) {
  const stat = lstatSync(path);
  const type = stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other';
  const item = { path: relative(root, path), type, mode: stat.mode & 0o7777 };
  if (type === 'file') item.sha256 = digest(readFileSync(path));
  // #1010 — a symlink's identity is its TARGET STRING, never what the target
  // resolves to. `readFileSync` FOLLOWS the link: a link to a directory threw
  // EISDIR (the crash the issue measured, on a candidate worktree carrying a
  // `.engram -> .memory` symlink written mid-review), and a link to a file
  // hashed the target's bytes instead of the link itself — so retargeting a
  // symlink to an unrelated but byte-identical file snapshotted as "no
  // change". `readlinkSync` reads the link, never through it.
  if (type === 'symlink') item.sha256 = digest(readlinkSync(path));
  return item;
}

export function snapshotCandidate(root) {
  const absoluteRoot = resolve(root ?? '');
  if (!lstatSync(absoluteRoot).isDirectory()) throw new Error('candidate snapshot root must be a directory');
  const entries = [];
  function visit(path) {
    const current = entry(absoluteRoot, path);
    entries.push(current);
    if (current.type === 'directory') for (const name of readdirSync(path).sort()) visit(resolve(path, name));
  }
  visit(absoluteRoot);
  return entries;
}

export function compareCandidateSnapshots(before, after) {
  const previous = new Map(before.map((entry) => [entry.path, entry]));
  const current = new Map(after.map((entry) => [entry.path, entry]));
  const added = [...current.keys()].filter((path) => !previous.has(path)).sort();
  const removed = [...previous.keys()].filter((path) => !current.has(path)).sort();
  const changed = [...current.keys()]
    .filter((path) => previous.has(path) && JSON.stringify(previous.get(path)) !== JSON.stringify(current.get(path)))
    .sort();
  const changes = { added, removed, changed };
  return { equal: added.length === 0 && removed.length === 0 && changed.length === 0, changes, before, after };
}
