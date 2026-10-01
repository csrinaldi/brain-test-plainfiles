import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAntiPattern, readAntiPatterns } from './anti-patterns.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// ── R879-4 ──────────────────────────────────────────────────────────────────

test('#879: an anti-pattern row carries id, title, scope, path and every ticket it cites', () => {
  const text = '# git diff does not see untracked files\n\n- **Discovered in:** ISSUE-13 / macro\n\nAlso #405 and PR #490, and #13 again.\n';
  const a = parseAntiPattern(text, { path: 'brain/core/anti-patterns/x.md', scope: 'core', id: 'x' });
  assert.deepEqual(a, {
    ok: true, id: 'x', title: 'git diff does not see untracked files', scope: 'core',
    path: 'brain/core/anti-patterns/x.md', issues: [13, 405, 490],
  });
});

test('#879: a file without a title is "could not read", in place', () => {
  const a = parseAntiPattern('no heading here\n', { path: 'p', scope: 'core', id: 'p' });
  assert.deepEqual(a, { ok: false, path: 'p', scope: 'core', reason: 'no `# Title` line' });
  assert.equal(parseAntiPattern(undefined, { path: 'q', scope: 'core' }).ok, false);
});

test('#879: both scopes feed one list, README excluded, an absent dir is reported not fabricated', () => {
  const files = {
    'brain/core/anti-patterns/b.md': '# B\n#2\n',
    'brain/core/anti-patterns/a.md': '# A\n',
  };
  const r = readAntiPatterns({
    _list: (p) => {
      if (p === 'brain/core/anti-patterns') return ['README.md', 'b.md', 'a.md', 'notes.txt'];
      throw new Error('ENOENT');
    },
    _read: (p) => files[p],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.entries.map((e) => [e.id, e.scope, e.issues]), [['a', 'core', []], ['b', 'core', [2]]]);
  assert.equal(r.value.unlistable.length, 1);
  assert.equal(r.value.unlistable[0].scope, 'project');
  assert.match(r.value.unlistable[0].reason, /ENOENT/);
});

test('#879: on this repository every core anti-pattern parses', () => {
  const r = readAntiPatterns({ root: ROOT });
  const core = r.value.entries.filter((e) => e.scope === 'core');
  assert.ok(core.length >= 8, `measured eight on 2026-09-13, found ${core.length}`);
  assert.deepEqual(core.filter((e) => !e.ok), []);
  assert.deepEqual(r.value.unlistable, [], 'both dirs exist here');
  const gitDiff = core.find((e) => e.id === 'git-diff-no-ve-untracked');
  assert.ok(gitDiff.issues.includes(13), 'ISSUE-13 is read as a ticket');
});
