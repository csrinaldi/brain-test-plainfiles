// post-merge: an undeclared memory backend must not vanish behind `|| true` (issue #1165, S2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTmp } from '../lib/test-tmp.mjs';

const HOOK = fileURLToPath(new URL('./post-merge', import.meta.url));

function run(code) {
  const bin = testTmp('pm-1165-bin-');
  const root = testTmp('pm-1165-root-');
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env sh\nexit ${code}\n`);
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env sh\nprintf '%s\\n' "${root}"\n`);
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'git'), 0o755);
  return spawnSync('sh', [HOOK], { env: { PATH: `${bin}:/bin`, HOME: root }, encoding: 'utf8', timeout: 5000 });
}

test('#1165 post-merge: import and resolve-index skipped for an undeclared backend say so, and never block the merge', () => {
  const r = run(3);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /post-merge: memory import skipped — memory backend not declared/);
  assert.match(r.stderr, /brain:config -- set memory\.backend/);
});

test('#1165 post-merge: other failures add nothing', () => {
  const r = run(1);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /not declared/);
});
