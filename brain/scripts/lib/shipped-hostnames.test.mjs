// shipped-hostnames.test.mjs — brain must not ship a hostname belonging to
// somebody else's environment (issue #648).
//
// WHY THIS EXISTS. `brain/scripts/vcs/lib/repo.test.mjs` asserted against the
// real, resolvable git host of a provincial government — an organisation with no
// part in brain's development. Every sibling assertion in the same file used a
// reserved name; that one was the outlier, and `brain/**` is in the `files`
// allowlist, so it reached every consumer's disk.
//
// The host is described and not quoted, and this file is NOT excluded from its
// own scan. Quoting it would ship it from the guard written to keep it out —
// which is exactly the self-sustaining defect #647 D6 records about the
// pre-flight runbook, and the first draft of this file had it.
//
// It is filed as RELEVANCE, not as a leak. A generic harness carrying artifacts
// that describe one organisation's infrastructure is #397's shape: a file
// describing the wrong repository.
//
// WHAT IT DOES NOT GUARD, and why. The same cleanup rewrote fixture notes that
// named a phase after that organisation. There is deliberately no guard for
// those: a guard has to NAME the string it forbids, and this file ships too —
// so the guard would reintroduce the word into the tarball it exists to keep it
// out of. Hostnames are checkable by SHAPE, which is why that half is enforced
// and the other half is not.
//
// THE RULE MOVED, THE SCAN DID NOT (#674). The classifier now lives in
// `shipped-hostnames.mjs` so `brain:promote` can ask it about the file it is
// ABOUT to write — a draft is not under `brain/**`, so this walk could not see
// it until after a human had signed. What stayed here is the walk itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_REAL,
  TEXT,
  hostsIn,
  isReserved,
  isNotAHostname,
  foreignHostsIn,
} from './shipped-hostnames.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCAN_ROOT = join(REPO_ROOT, 'brain');

/** Walks brain/** and returns [{file, host}] for every host that is neither reserved nor allowed. */
function foreignHosts() {
  const found = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!TEXT.test(e.name)) continue;
      if (statSync(p).size > 2 * 1024 * 1024) continue;
      scanned++;
      const rel = relative(REPO_ROOT, p);
      for (const h of foreignHostsIn(readFileSync(p, 'utf8'))) found.push({ file: rel, host: h });
    }
  };
  walk(SCAN_ROOT);
  // Throws rather than returning []: "no foreign hosts" and "nothing was read"
  // must never share a verdict.
  if (scanned === 0) throw new Error(`${SCAN_ROOT}: no text files scanned — the walker is broken, not the tree`);
  return { found, scanned };
}

const { found, scanned } = foreignHosts();

test('#648: the scan read a real tree (a vacuous pass is a failure)', () => {
  assert.ok(scanned > 100, `only ${scanned} file(s) scanned under brain/ — the walker, not the tree, is what to look at`);
  assert.ok(Object.keys(ALLOWED_REAL).length >= 5, 'the allowlist was emptied — every host would then read as foreign');
});

test('#648: brain ships no hostname belonging to somebody else\'s environment', () => {
  const uniq = [...new Map(found.map((f) => [`${f.file}::${f.host}`, f])).values()];
  assert.deepEqual(
    uniq, [],
    'these name a host that is neither reserved (RFC 2606/6761) nor on the allowlist, in files that SHIP:\n'
      + uniq.map((f) => `  ${f.host}  @ ${f.file}`).join('\n')
      + '\n\n  Use a reserved name (example.com, *.test, *.invalid) unless brain genuinely integrates'
      + '\n  with the host — in which case add it to ALLOWED_REAL with the reason.',
  );
});

test('#648: userinfo is not mistaken for a host', () => {
  // The bug that made the first version of this guard useless.
  assert.deepEqual(hostsIn("x('https://oauth2:tok@gl.example.com/a.git')"), ['gl.example.com']);
  assert.deepEqual(hostsIn('https://x-access-token:tok@github.com/o/r'), ['github.com']);
  assert.deepEqual(hostsIn('https://gitlab.example.com:8080/group/repo.git'), ['gitlab.example.com']);
});

test('#648: a foreign host WOULD be caught — the classifier is not permissive', () => {
  // Pins the rule itself: without this, an over-broad `isReserved` or a
  // swallowed parse would make the guard above pass on any tree at all.
  // Assembled at runtime, never written as a literal URL: this file scans itself,
  // so a probe spelled out in full would make the guard flag its own test.
  const probe = `const r = "${'https://'}${'git.somewhere.'}${'gov.ar'}/team/repo.git";`;
  const [h] = hostsIn(probe);
  assert.equal(h, 'git.somewhere.gov.ar');
  assert.equal(isReserved(h), false, 'a real host must not classify as reserved');
  assert.equal(isNotAHostname(h), false);
  assert.equal(h in ALLOWED_REAL, false);

  // …and the composed classifier — the one brain:promote calls — reaches the
  // same verdict. Asserted separately: the parts agreeing proves nothing about
  // the whole if `foreignHostsIn` ever stops calling one of them.
  assert.deepEqual(foreignHostsIn(probe), ['git.somewhere.gov.ar']);
});

test('#674: foreignHostsIn does not deduplicate — the callers group, the classifier reports', () => {
  const twice = `${'https://'}a.${'gov.ar'}/x ${'https://'}a.${'gov.ar'}/y ${'https://'}github.com/z`;
  assert.deepEqual(foreignHostsIn(twice), ['a.gov.ar', 'a.gov.ar']);
});
