import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSnapshot } from './snapshot.mjs';
import { parseArgs, main } from './snapshot-cli.mjs';
import { makeSnapshotFixture as makeFixture } from '../__fixtures__/snapshot-tree.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'snapshot-cli.mjs');
const NOW = '2026-09-13T00:00:00Z';

// ── R879-1: module and verb are ONE shape ───────────────────────────────────

test('#879: the spawned verb prints exactly what the in-process module returns', async () => {
  const root = makeFixture();
  const r = spawnSync(process.execPath, [CLI, '--json', '--now', NOW, '--root', root], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', 'no git chatter beside the JSON');
  const fromVerb = JSON.parse(r.stdout);
  const fromModule = await buildSnapshot({ root, now: NOW });
  assert.deepEqual(fromVerb, JSON.parse(JSON.stringify(fromModule)));
  // Byte-identical across two runs on one tree: the clock is pinned, and the
  // rest is computed from the same files in the same order.
  const again = spawnSync(process.execPath, [CLI, '--json', '--now', NOW, '--root', root], { encoding: 'utf8' });
  assert.equal(again.stdout, r.stdout);
});

test('#879: text mode prints every section with its count or its reason, and exits 0 offline', async () => {
  const root = makeFixture();
  const lines = [];
  const code = await main(['--now', NOW, '--root', root], { say: (s) => lines.push(s) });
  assert.equal(code, 0, 'a report, not a gate');
  const out = lines.join('\n');
  for (const name of ['graph', 'changes', 'prs', 'reviews', 'records', 'adrs', 'anti-patterns', 'actors', 'release debt']) {
    assert.match(out, new RegExp(`^${name}\\s`, 'm'), name);
  }
  assert.match(out, /graph\s+not computed — no VCS port/);
  assert.match(out, /records\s+3 record\(s\)/);
  assert.match(out, /adr drift — 1 disagreement/);
});

test('#879: arguments — --json, --now needs an ISO date, unknown flags are refused with exit 2', async () => {
  assert.deepEqual(parseArgs(['--json']), { ok: true, json: true, now: undefined, root: undefined });
  assert.equal(parseArgs(['--now', 'yesterday']).ok, false);
  assert.equal(parseArgs(['--bogus']).ok, false);
  assert.equal(await main(['--bogus'], { say: () => {} }), 2);
});
