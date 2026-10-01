// snapshot-tree.mjs — a minimal consumer-shaped tree for the #879 snapshot
// tests. Lives beside `tmp-tree.mjs` rather than inside a test file: importing
// a `*.test.mjs` for its helper re-runs every test it declares under the
// importer's name (measured — 23 results for 13 tests), so shared fixtures are
// modules, never tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { testTmp } from '../lib/test-tmp.mjs';

export function makeSnapshotFixture({ records = true } = {}) {
  const root = testTmp('snapshot-');
  const w = (p, text) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), text); };
  w('brain.config.json', JSON.stringify({ governance: { tier: 'lite' } }));
  w('brain/HOME.md', '### Architecture decisions\n\n- [ADR-0001](project/decisions/adr-0001-a.md) — a\n- [ADR-0002](project/decisions/adr-0002-b.md) — b\n');
  w('brain/project/decisions/adr-0001-a.md', '# ADR-0001 — A\n\n**Status**: Accepted\n**Date**: 2026-06-26\n\n## Amendment 1 — x (issue #7)\n');
  w('brain/core/anti-patterns/README.md', '# index\n');
  w('brain/core/anti-patterns/one.md', '# One\n\n- **Discovered in:** issue #3\n');
  w('openspec/changes/issue-1-a/proposal.md', 'p');
  w('openspec/changes/issue-1-a/spec.md', 's');
  w('openspec/changes/issue-1-a/design.md', 'd');
  w('openspec/changes/issue-1-a/tasks.md', '```brain-slice-scope/1\n{"slice":1,"claims":["R1-1"],"terminal_pr":"this PR -> main"}\n```\n- [x] done\n- [ ] next one\n');
  w('openspec/changes/issue-2-no-tasks/spec.md', 's');
  w('openspec/changes/archive/.gitkeep', '');
  // One archived change (R998-4), named the canonical way `archivePath(iid)`
  // (sdd-layout.mjs) templates it: the bare issue number, no `issue-` prefix,
  // no slug — every artefact present, every task checked.
  w('openspec/changes/archive/9/proposal.md', 'p');
  w('openspec/changes/archive/9/spec.md', 's');
  w('openspec/changes/archive/9/design.md', 'd');
  w('openspec/changes/archive/9/tasks.md', '- [x] done\n- [x] also done\n');
  w('openspec/changes/archive/9/archive-report.md', 'archived');
  if (records) {
    const rec = (id, ts, actor, type, extra = {}) => JSON.stringify({ id, ts, actor, actorKind: actor.startsWith('@bot') ? 'agent' : 'human', type, project: 'x', content: 'c', ...extra });
    w('.memory/records/2026-06-rec-0000000000000001.jsonl', rec('rec-0000000000000001', '2026-06-01T00:00:00Z', '@a', 'decision', { issue: 1 }) + '\n');
    w('.memory/records/2026-07-rec-0000000000000002.jsonl', rec('rec-0000000000000002', '2026-07-01T00:00:00Z', '@a', 'bugfix') + '\n');
    w('.memory/records/2026-07-rec-0000000000000003.jsonl', rec('rec-0000000000000003', '2026-07-02T00:00:00Z', '@bot', 'session_summary', { supersedes: 'rec-0000000000000001' }) + '\n');
  }
  return root;
}

