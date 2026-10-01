// install-provenance.test.mjs — the consumer's install source, and the spec it
// implies (the #646 × #655 interaction).
//
// The `resolved` values below are not invented: each was measured by really
// installing a scoped package that way and reading the hidden lockfile npm
// wrote. That matters most for the two rewrites — git+https recorded as
// git+ssh, and the requested tag replaced by a commit SHA — which are the whole
// reason this reader classifies rather than reuses the string.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyResolved,
  classifyDependencySpec,
  evaluateDeclaredProvenance,
  evaluateProvenance,
  readInstallProvenance,
  HIDDEN_LOCKFILE,
} from './install-provenance.mjs';
import { resolveInstallSpec, installedPackageSearchPaths, BRAIN_REPO_HTTPS } from './installer.mjs';

const PATHS = installedPackageSearchPaths();
const CANON = PATHS[0];

const lock = (entry, dir = CANON) => ({ packages: { '': { name: 'consumer' }, [dir]: entry } });

// ── classification ───────────────────────────────────────────────────────────

test('#655: the three measured shapes classify apart', () => {
  // Registry: `npm i -D @sindresorhus/is@7.0.1`
  assert.equal(classifyResolved('https://registry.npmjs.org/@sindresorhus/is/-/is-7.0.1.tgz'), 'registry');
  // Git: asked for git+https://…#v7.0.1 — npm recorded ssh AND a SHA.
  assert.equal(classifyResolved('git+ssh://git@github.com/sindresorhus/is.git#e0976457e04ba5df'), 'git');
  // Git over a local remote — the M4 danger-paths harness's exact case.
  assert.equal(classifyResolved('git+file:///srv/brain-remote.git#1a33dc219023c859'), 'git');
  // Local tarball.
  assert.equal(classifyResolved('file:../../logikas-brain-1.1.0.tgz'), 'file');
});

test('#655: an unreadable `resolved` is null, never a guess', () => {
  for (const v of [undefined, null, '', '   ', 42, {}, 'nonsense']) {
    assert.equal(classifyResolved(v), null, `${JSON.stringify(v)} must not classify`);
  }
});

// ── the reader ───────────────────────────────────────────────────────────────

test('#655: provenance is read for the SAME location the upgrade will use', () => {
  const p = evaluateProvenance({ doc: lock({ resolved: 'git+file:///srv/brain-remote.git#1a33dc2' }), searchPaths: PATHS });
  assert.equal(p.source, 'git');
  assert.match(p.why, /was installed from git/);
});

test('#655: the legacy location is honoured too (#625 pairing)', () => {
  if (PATHS.length < 2) return; // only meaningful while canonical !== legacy
  const p = evaluateProvenance({
    doc: lock({ resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz' }, PATHS[1]),
    searchPaths: PATHS,
  });
  assert.equal(p.source, 'registry');
});

test('#655: every failure is a STATED unknown, never a silent default', () => {
  const cases = [
    [{ doc: {}, searchPaths: PATHS }, /no `packages` map/],
    [{ doc: lock({ resolved: 'nonsense' }), searchPaths: PATHS }, /no recognisable `resolved`/],
    [{ doc: lock({ link: true }), searchPaths: PATHS }, /is a link/],
    [{ doc: { packages: { '': {} } }, searchPaths: PATHS }, /none of .* appears/],
    [{ doc: lock({ resolved: 'https://x/y.tgz' }), searchPaths: [] }, /must pass its search paths/],
  ];
  for (const [input, re] of cases) {
    const p = evaluateProvenance(input);
    assert.equal(p.source, 'unknown');
    assert.match(p.why, re);
    assert.equal(p.resolved, null);
  }
});

test('#655: a missing lockfile is expected, not an error — pnpm/yarn/bun consumers', () => {
  const p = readInstallProvenance({ repoRoot: '/nope', searchPaths: PATHS, exists: () => false });
  assert.equal(p.source, 'unknown');
  assert.match(p.why, /absent/);
  assert.match(p.why, /pnpm, yarn or bun/);
});

test('#655: an unparseable lockfile says so instead of throwing', () => {
  const p = readInstallProvenance({
    repoRoot: '/x', searchPaths: PATHS, exists: () => true, readFile: () => '{ not json',
  });
  assert.equal(p.source, 'unknown');
  assert.match(p.why, /could not be parsed/);
});

test('#655: a read error is reported, not swallowed as "no lockfile"', () => {
  const p = readInstallProvenance({
    repoRoot: '/x', searchPaths: PATHS, exists: () => true,
    readFile: () => { throw new Error('EACCES'); },
  });
  assert.equal(p.source, 'unknown');
  assert.match(p.why, /EACCES/);
});

// ── the spec it implies ──────────────────────────────────────────────────────

const SCOPED = '@logikas/brain';
const REPO = 'git+file:///srv/brain-remote.git';

test('#655: git provenance beats the scoped name — the defect this closes', () => {
  // Without provenance this returned `@logikas/brain@9.0.1` and the consumer
  // had no route home. The M4 harness is exactly this consumer.
  const d = resolveInstallSpec({ name: SCOPED, version: 'v9.0.1', repoUrl: REPO, provenance: 'git' });
  assert.equal(d.kind, 'git');
  assert.equal(d.spec, `${REPO}#v9.0.1`);
  assert.match(d.why, /installed from git/);
});

test('#655: the git ref stays VERBATIM on the provenance path', () => {
  // A ref is a name, not a number: `#9.0.1` is a different ref, usually absent.
  const d = resolveInstallSpec({ name: SCOPED, version: 'v9.0.1', repoUrl: REPO, provenance: 'git' });
  assert.ok(d.spec.endsWith('#v9.0.1'), `expected the tag as written, got ${d.spec}`);
});

test('#655: a file: install upgrades by git too — a tarball is not a registry', () => {
  assert.equal(resolveInstallSpec({ name: SCOPED, version: 'v1.2.0', repoUrl: REPO, provenance: 'file' }).kind, 'git');
});

test('#655: registry provenance keeps the registry spec', () => {
  const d = resolveInstallSpec({ name: SCOPED, version: 'v1.2.0', repoUrl: REPO, provenance: 'registry' });
  assert.equal(d.spec, `${SCOPED}@1.2.0`);
  assert.match(d.why, /installed from the registry/);
});

test('#655: unknown provenance keeps the pre-existing behaviour AND carries the fallback', () => {
  for (const provenance of ['unknown', undefined]) {
    const d = resolveInstallSpec({ name: SCOPED, version: 'v1.2.0', repoUrl: REPO, provenance });
    assert.equal(d.spec, `${SCOPED}@1.2.0`, 'the guess must not change');
    assert.equal(d.fallbackSpec, `${REPO}#v1.2.0`, 'and it must be recoverable');
  }
});

test('#655: a registry spec always carries a fallback; a git spec has none to carry', () => {
  assert.equal(resolveInstallSpec({ name: SCOPED, version: 'v1.2.0', repoUrl: REPO, provenance: 'git' }).fallbackSpec, null);
  assert.equal(resolveInstallSpec({ name: 'brain', version: 'v1.2.0', repoUrl: REPO }).fallbackSpec, null);
  // With no declared repoUrl the fallback is still reachable — the constant.
  const d = resolveInstallSpec({ name: SCOPED, version: 'v1.2.0' });
  assert.equal(d.fallbackSpec, `${BRAIN_REPO_HTTPS}#v1.2.0`);
});

test('#655: provenance cannot rescue a non-version for a registry install', () => {
  const d = resolveInstallSpec({ name: SCOPED, version: 'main', repoUrl: REPO, provenance: 'registry' });
  assert.equal(d.kind, 'unresolved');
  assert.equal(d.spec, null);
});

test('#655: HIDDEN_LOCKFILE is the npm path, not a guess at one', () => {
  assert.match(HIDDEN_LOCKFILE, /node_modules[/\\]\.package-lock\.json$/);
});

// ── the durable source: the consumer's own package.json ─────────────────────
// Deleting `package-lock.json`, or `node_modules` wholesale, are ordinary
// events. The values below were measured by really installing each way.

test('#655: a declared spec classifies by route, keeping the TAG not a SHA', () => {
  assert.equal(classifyDependencySpec('^7.0.1'), 'registry');
  assert.equal(classifyDependencySpec('1.1.0'), 'registry');
  assert.equal(classifyDependencySpec('latest'), 'registry');
  assert.equal(classifyDependencySpec('npm:@scope/x@^1.0.0'), 'registry');
  assert.equal(classifyDependencySpec('github:sindresorhus/is#v7.0.1'), 'git');
  assert.equal(classifyDependencySpec('git+file:///srv/remote.git#v9.0.0'), 'git');
  assert.equal(classifyDependencySpec('git@github.com:o/r.git'), 'git');
  assert.equal(classifyDependencySpec('file:../../logikas-brain-1.1.0.tgz'), 'file');
  assert.equal(classifyDependencySpec('who-knows'), null);
});

test('#655: devDependencies is read first, dependencies still honoured', () => {
  const name = '@logikas/brain';
  const dev = evaluateDeclaredProvenance({ pkg: { devDependencies: { [name]: 'git+file:///srv/r.git#v9' } }, packageName: name });
  assert.equal(dev.source, 'git');
  const prod = evaluateDeclaredProvenance({ pkg: { dependencies: { [name]: '^1.1.0' } }, packageName: name });
  assert.equal(prod.source, 'registry');
});

test('#655: an undeclared package says so rather than guessing', () => {
  const p = evaluateDeclaredProvenance({ pkg: { devDependencies: {} }, packageName: '@logikas/brain' });
  assert.equal(p.source, 'unknown');
  assert.match(p.why, /not declared/);
});

test('#655: the declared spec survives a deleted node_modules — the air-gap case', () => {
  // No hidden lockfile AND no installed manifest: the package.json read is the
  // only thing standing between a mirror consumer and a redirect to a host they
  // cannot reach.
  const name = '@logikas/brain';
  const p = readInstallProvenance({
    repoRoot: '/consumer',
    searchPaths: PATHS,
    packageName: name,
    exists: (f) => f.endsWith('package.json') && !f.includes('node_modules'),
    readFile: () => JSON.stringify({ devDependencies: { [name]: 'git+file:///srv/remote.git#v9.0.0' } }),
  });
  assert.equal(p.source, 'git');
  assert.equal(p.resolved, 'git+file:///srv/remote.git#v9.0.0');
});

test('#655: with both sources unreadable, the reason names BOTH', () => {
  const p = readInstallProvenance({
    repoRoot: '/c', searchPaths: PATHS, packageName: '@logikas/brain', exists: () => false,
  });
  assert.equal(p.source, 'unknown');
  assert.match(p.why, /package.json is absent/);
  assert.match(p.why, /\.package-lock\.json is absent/);
});
