// package-scripts.test.mjs — pins each `brain:memory:*` canonical script key
// against its bare `memory:*` alias (issue #961, R4). Between the Tier-1 PR
// (this change) and the maintainer's promotion PR, doctrine still says
// `npm run memory:save` and records/history cite the bare names, so the
// alias MUST keep running the exact same command — a literal string
// comparison, not `scripts[a] === scripts[b]` (design D2): if both entries
// drifted the same wrong way, an equality-only check would still pass.
//
// The eleven verbs cover the seven that #954 (#922) is about to manage
// (`save`, `index`, `share`, `pull`, `resolve-index`, `audit`, `ship`) plus
// the four repo-only scripts renamed under R3 (`reindex`, `split-records`,
// `collect`, `migrate-v1`) — R3 pairs all eleven in doctrine
// (`memory-format.md:256,260`), so this pin does too. None of the eleven is
// ever added to `MANAGED_SCRIPT_KEYS`: only `brain:memory:session-end`
// (a distinct, unrelated hook script) is managed today.
//
// Guarded on `.brain-source` like `session-start-config.test.mjs:23-25`: the
// bare aliases are repo-only (R4) and never travel to a consumer via
// `mergePackageJsonScripts`, which only ever ADDS keys — so a consumer's
// package.json has no bare `memory:*` key to assert against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MANAGED_SCRIPT_KEYS } from '../../core/managed-paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const VERBS = [
  'save',
  'index',
  'share',
  'pull',
  'resolve-index',
  'audit',
  'ship',
  'reindex',
  'split-records',
  'collect',
  'migrate-v1',
];

const skip = existsSync(join(ROOT, '.brain-source'))
  ? false
  : 'memory scripts are not managed until #922';

for (const v of VERBS) {
  test(`brain:memory:${v} and its alias run cli.mjs ${v} (#961 R4)`, { skip }, () => {
    // #1012: `ship` alone declares its invoker at the script level — every
    // caller of `cli.mjs ship` must pass a marker, including this one.
    const want = v === 'ship'
      ? `node ./brain/scripts/memory/cli.mjs ${v} --invoker manual`
      : `node ./brain/scripts/memory/cli.mjs ${v}`;
    assert.equal(pkg.scripts?.[`brain:memory:${v}`], want);
    assert.equal(pkg.scripts?.[`memory:${v}`], want);
    assert.ok(!MANAGED_SCRIPT_KEYS.includes(`memory:${v}`), 'a bare alias is never managed');
  });
}
