// hydration-guard.processes.integration.test.mjs — the guard against REAL OS
// processes (#820; rev-1 cold review of PR #872 reproduced the mkdir+write
// window with a standalone script — this pins the fix the same way).
//
// N child processes hammer one lock path: each loops K times, tries to acquire,
// and when held records [enterNs, leaveNs] around a short hold before
// releasing. The assertion is the lock's whole contract: no two hold intervals
// from different processes overlap, and everyone who was refused was refused
// while someone else held it (the counts add up).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { testTmp } from '../../lib/test-tmp.mjs';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'hydration-guard.mjs');

const WORKER = `
  import { acquireHydrationGuard } from ${JSON.stringify(GUARD)};
  import { writeFileSync } from 'node:fs';
  const [lockPath, out, rounds] = process.argv.slice(1); // under -e, argv[1] is the first user arg
  const holds = []; let refused = 0;
  const spin = (ns) => { const t = process.hrtime.bigint(); while (process.hrtime.bigint() - t < ns) {} };
  for (let i = 0; i < Number(rounds); i++) {
    const g = acquireHydrationGuard({ lockPath });
    if (!g.held) { refused++; spin(50_000n); continue; }
    const enter = process.hrtime.bigint(); spin(1_000_000n); const leave = process.hrtime.bigint();
    g.release();
    holds.push([enter.toString(), leave.toString()]);
  }
  writeFileSync(out, JSON.stringify({ pid: process.pid, holds, refused }));
`;

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stderr }));
  });
}

test('N real processes on one lock path, CONCURRENTLY: hold intervals never overlap, and contention actually happened', async () => {
  const dir = testTmp('guard-procs-');
  const lockPath = join(dir, 'brain-memory-hydration.lock');
  const N = 6, ROUNDS = 25;
  const procs = await Promise.all(Array.from({ length: N }, (_, i) =>
    run(['--input-type=module', '-e', WORKER, '--', lockPath, join(dir, `w${i}.json`), String(ROUNDS)])));
  for (const p of procs) assert.equal(p.status, 0, p.stderr);

  const all = [];
  let refused = 0;
  for (let i = 0; i < N; i++) {
    const r = JSON.parse(readFileSync(join(dir, `w${i}.json`), 'utf8'));
    refused += r.refused;
    for (const [a, b] of r.holds) all.push({ pid: r.pid, a: BigInt(a), b: BigInt(b) });
  }
  assert.equal(all.length + refused, N * ROUNDS, 'every attempt was either held or refused');
  assert.ok(all.length >= N, 'every process held at least once');
  // Sequential runs would pass the overlap check vacuously — the earlier draft of
  // this test used spawnSync and did exactly that. Contention must be observed.
  assert.ok(refused > 0, 'no attempt was ever refused — the processes did not actually contend');
  if (process.env.BRAIN_GUARD_TEST_VERBOSE) console.error(`guard-procs: ${N} procs × ${ROUNDS} rounds → held ${all.length}, refused ${refused}`);
  all.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i].a >= all[i - 1].b, `overlap: pid ${all[i - 1].pid} [${all[i - 1].a},${all[i - 1].b}] vs pid ${all[i].pid} [${all[i].a},${all[i].b}]`);
  }
});
