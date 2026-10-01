// brain-config.test.mjs — Unit tests for brain-config.mjs.
// Run with: npm test  (node --test, no dependencies)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ensureProjectIdentity, providerFromHost, ensureBrainConfig, loadBrainConfigOrThrow } from './brain-config.mjs';
import { testTmp } from './test-tmp.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a temp dir containing brain.config.json with given project overrides.
 * Returns the dir path.
 */
function makeTmpConfig(projectFields = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-cfg-'));
  const cfg = {
    project: {
      name: 'brain',
      slug: '',
      gitHost: '',
      gitProjectId: '',
      owner: '',
      ...projectFields,
    },
    docs: { language: 'en' },
    vcs: { provider: 'github' },
    schemaVersion: '0.3.0',
  };
  writeFileSync(join(dir, 'brain.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  return dir;
}

function readCfg(dir) {
  return JSON.parse(readFileSync(join(dir, 'brain.config.json'), 'utf8'));
}

const IDENTITY = { host: 'github.com', project: 'csrinaldi/brain' };

// ── tests ─────────────────────────────────────────────────────────────────────

test('ensureProjectIdentity: fills empty gitHost and slug', () => {
  const dir = makeTmpConfig();
  try {
    const result = ensureProjectIdentity(dir, { identity: IDENTITY });
    assert.deepEqual(result.filled.sort(), ['gitHost', 'slug']);
    const cfg = readCfg(dir);
    assert.equal(cfg.project.gitHost, 'github.com');
    assert.equal(cfg.project.slug, 'csrinaldi/brain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureProjectIdentity: does NOT overwrite non-empty gitHost', () => {
  const dir = makeTmpConfig({ gitHost: 'gitlab.com' });
  try {
    const result = ensureProjectIdentity(dir, { identity: IDENTITY });
    assert.ok(!result.filled.includes('gitHost'), 'gitHost must not be in filled[]');
    const cfg = readCfg(dir);
    assert.equal(cfg.project.gitHost, 'gitlab.com');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureProjectIdentity: does NOT overwrite non-empty slug', () => {
  const dir = makeTmpConfig({ slug: 'myorg/myrepo' });
  try {
    const result = ensureProjectIdentity(dir, { identity: IDENTITY });
    assert.ok(!result.filled.includes('slug'), 'slug must not be in filled[]');
    const cfg = readCfg(dir);
    assert.equal(cfg.project.slug, 'myorg/myrepo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureProjectIdentity: idempotent — second call returns filled=[]', () => {
  const dir = makeTmpConfig();
  try {
    const first = ensureProjectIdentity(dir, { identity: IDENTITY });
    assert.ok(first.filled.length > 0, 'first call should fill at least one field');
    const second = ensureProjectIdentity(dir, { identity: IDENTITY });
    assert.deepEqual(second.filled, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureProjectIdentity: empty origin ({host: null}) → no-op, config unchanged', () => {
  const dir = makeTmpConfig();
  try {
    const result = ensureProjectIdentity(dir, { identity: { host: null, project: null } });
    assert.deepEqual(result.filled, []);
    const cfg = readCfg(dir);
    assert.equal(cfg.project.gitHost, '', 'gitHost must remain empty');
    assert.equal(cfg.project.slug, '',   'slug must remain empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureProjectIdentity: preserves other config keys and trailing newline', () => {
  const dir = makeTmpConfig({ gitProjectId: '999', owner: 'csr' });
  try {
    ensureProjectIdentity(dir, { identity: IDENTITY });
    const raw = readFileSync(join(dir, 'brain.config.json'), 'utf8');
    assert.ok(raw.endsWith('\n'), 'written file must end with a newline');
    const cfg = JSON.parse(raw);
    // Filled fields
    assert.equal(cfg.project.gitHost, 'github.com');
    assert.equal(cfg.project.slug, 'csrinaldi/brain');
    // Untouched fields preserved
    assert.equal(cfg.project.name,        'brain');
    assert.equal(cfg.project.gitProjectId, '999');
    assert.equal(cfg.project.owner,        'csr');
    assert.deepEqual(cfg.docs,        { language: 'en' });
    assert.deepEqual(cfg.vcs,         { provider: 'github' });
    assert.equal(cfg.schemaVersion, '0.3.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── providerFromHost ───────────────────────────────────────────────────────────

test('providerFromHost: github.com → "github"', () => {
  assert.equal(providerFromHost('github.com'), 'github');
});

test('providerFromHost: gitlab.com → "gitlab"', () => {
  assert.equal(providerFromHost('gitlab.com'), 'gitlab');
});

test('providerFromHost: self-hosted gitlab subdomain → "gitlab"', () => {
  assert.equal(providerFromHost('gitlab.example.com'), 'gitlab');
});

test('providerFromHost: unknown host → ""', () => {
  assert.equal(providerFromHost('bitbucket.org'), '');
});

// ── ensureBrainConfig ─────────────────────────────────────────────────────────

test('ensureBrainConfig: creates config when missing with github identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-ensure-'));
  try {
    const result = ensureBrainConfig(dir, { identity: { host: 'github.com', project: 'owner/repo' } });
    assert.equal(result.created, true);
    assert.equal(result.provider, 'github');

    const raw = readFileSync(join(dir, 'brain.config.json'), 'utf8');
    assert.ok(raw.endsWith('\n'), 'written file must end with a newline');
    const cfg = JSON.parse(raw);
    assert.equal(cfg.vcs.provider, 'github');
    assert.equal(cfg.project.gitHost, 'github.com');
    assert.equal(cfg.project.slug, 'owner/repo');
    assert.equal(cfg.schemaVersion, '1.9.1', 'memory.backend (1.9.1, issue #1165) is now the latest — the 0.6.0 memory.dualWrite gap (D3/C4, issue #229) stays a deliberate, never-reused retirement mark');
    assert.equal(cfg.memory.backend, '', 'memory.backend ships EMPTY (undeclared): a default would choose a backend for a team that never chose one (#1165) — env:init asks and writes it');
    assert.deepEqual(cfg.sdd.map, {}, 'sdd.map ships EMPTY: a routed cold-review would spawn an engine no consumer asked for');
    assert.deepEqual(cfg.sdd.stages, {}, 'sdd.stages ships EMPTY: the four lifecycle stages live in sdd-layout.mjs LIFECYCLE_STAGES, never duplicated into JSON (#456)');
    assert.deepEqual(cfg.sdd.configs, {}, "sdd.configs ships EMPTY: a stage absent from it takes the inhabitant's declared defaults, never an invented override (#312)");
    assert.deepEqual(cfg.sdd.engines, {}, 'sdd.engines ships EMPTY: an engine nobody recorded is honestly absent (#824)');
    assert.equal(cfg.memory.lane.enabled, false, 'memory.lane.enabled (#906 A6) must default false — never true on any tier, ever');
    assert.equal(cfg.governance.approvedLabel, 'status:approved', 'governance.approvedLabel must default to the plain base form');
    assert.equal(cfg.governance.tier, 'lite', 'governance.tier: a NEW consumer defaults to "lite" (issue #1124, ADR-0026 Amendment 8) — existing consumers keep theirs through the migrations');
    assert.equal(cfg.reviewer.tokenEnv, 'BRAIN_REVIEWER_TOKEN', 'reviewer.tokenEnv must default to the documented env var name');
    // Full schema must exist
    assert.ok('project' in cfg, 'project key must exist');
    assert.ok('docs' in cfg, 'docs key must exist');
    assert.ok('vcs' in cfg, 'vcs key must exist');
    assert.ok('governance' in cfg, 'governance key must exist');
    assert.ok(Array.isArray(cfg.governance.ignoreList), 'governance.ignoreList must be an array');
    assert.ok('gitHost' in cfg.project, 'project.gitHost must exist');
    assert.ok('name' in cfg.project, 'project.name must exist');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureBrainConfig: creates config when missing with gitlab identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-ensure-'));
  try {
    const result = ensureBrainConfig(dir, { identity: { host: 'gitlab.com', project: 'group/repo' } });
    assert.equal(result.created, true);
    assert.equal(result.provider, 'gitlab');

    const cfg = JSON.parse(readFileSync(join(dir, 'brain.config.json'), 'utf8'));
    assert.equal(cfg.vcs.provider, 'gitlab');
    assert.equal(cfg.project.gitHost, 'gitlab.com');
    assert.equal(cfg.project.slug, 'group/repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureBrainConfig: existing config → fills empty gitHost/slug, does NOT overwrite provider', () => {
  const dir = makeTmpConfig(); // provider='github', gitHost='', slug=''
  try {
    const result = ensureBrainConfig(dir, { identity: { host: 'github.com', project: 'owner/repo' } });
    assert.equal(result.created, false);
    assert.ok(result.filled.includes('gitHost'), 'should fill gitHost');
    assert.ok(result.filled.includes('slug'), 'should fill slug');

    const cfg = readCfg(dir);
    assert.equal(cfg.project.gitHost, 'github.com');
    assert.equal(cfg.project.slug, 'owner/repo');
    assert.equal(cfg.vcs.provider, 'github'); // NOT overwritten
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureBrainConfig: existing config with set values → nothing overwritten', () => {
  const dir = makeTmpConfig({ gitHost: 'gitlab.com', slug: 'org/proj' });
  try {
    const result = ensureBrainConfig(dir, { identity: { host: 'github.com', project: 'other/repo' } });
    assert.equal(result.created, false);
    assert.deepEqual(result.filled, []); // nothing was empty to fill

    const cfg = readCfg(dir);
    assert.equal(cfg.project.gitHost, 'gitlab.com');
    assert.equal(cfg.project.slug, 'org/proj');
    assert.equal(cfg.vcs.provider, 'github'); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureBrainConfig: idempotent — second call does not recreate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-ensure-'));
  const identity = { host: 'github.com', project: 'owner/repo' };
  try {
    const first = ensureBrainConfig(dir, { identity });
    assert.equal(first.created, true);

    const second = ensureBrainConfig(dir, { identity });
    assert.equal(second.created, false);
    assert.deepEqual(second.filled, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #1124: the lite default is for a config env:init CREATES. An existing file is
// never re-tiered by ensureBrainConfig — neither a declared tier nor a missing key.
test('#1124 ensureBrainConfig: an existing config keeps its declared tier, and a missing key stays missing', () => {
  for (const governance of [{ tier: 'standard' }, { tier: 'regulated' }, {}]) {
    const dir = mkdtempSync(join(tmpdir(), 'brain-ensure-tier-'));
    try {
      writeFileSync(join(dir, 'brain.config.json'), JSON.stringify({ project: { gitHost: '', slug: '' }, vcs: { provider: 'github' }, governance }, null, 2) + '\n');
      const result = ensureBrainConfig(dir, { identity: { host: 'github.com', project: 'owner/repo' } });
      assert.equal(result.created, false);
      assert.deepEqual(readCfg(dir).governance, governance, 'ensureBrainConfig must not touch governance on an existing config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ── loadBrainConfigOrThrow (issue #942, R3 — REQ-DENY-1) ────────────────────
//
// Distinguishes ABSENT (`{}`, no throw) from UNREADABLE/UNPARSEABLE (throw,
// naming the path and the failure kind) — the one shared primitive every
// hardened deny reader calls. Mirrors `memory/lib/upstream-records.mjs`'s
// `loadBrainConfigAt` byte-for-byte in behaviour (the house model).

test('T1: loadBrainConfigOrThrow — no file at all → returns {} (absence is not unreadability)', () => {
  const dir = testTmp('brain-config-throw-');
  assert.deepEqual(loadBrainConfigOrThrow(dir), {});
});

test('T2: loadBrainConfigOrThrow — malformed JSON → throws, message names the path and "could not be parsed"', () => {
  const dir = testTmp('brain-config-throw-');
  writeFileSync(join(dir, 'brain.config.json'), '{oops');
  assert.throws(
    () => loadBrainConfigOrThrow(dir),
    (err) => {
      assert.match(err.message, /brain\.config\.json/, 'names the file');
      assert.match(err.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'names the path');
      assert.match(err.message, /could not be parsed/, 'names the failure kind');
      return true;
    },
  );
});

test('T3: loadBrainConfigOrThrow — config path is a directory → throws "could not be read" (ENOENT is the ONLY exemption)', () => {
  const dir = testTmp('brain-config-throw-');
  mkdirSync(join(dir, 'brain.config.json'));
  assert.throws(
    () => loadBrainConfigOrThrow(dir),
    (err) => {
      assert.match(err.message, /could not be read/, 'a directory in the file\'s place is "could not look", not absence');
      return true;
    },
  );
});

// ── loadBrainConfigOrThrow shape check (issue #975) ──────────────────────────
//
// The parse can succeed on JSON that is not a plain object; every caller
// reads through optional chaining, so a non-object value used to degrade
// exactly like `{}` — the #942 class reached through a shape gap instead of
// a parse error. `null`, `[]`, `42`, `"x"` must all throw, naming the path
// and the JSON type found; absence and a valid object are unchanged.

test('T4: loadBrainConfigOrThrow — brain.config.json is `null` → throws, names the path and "got null"', () => {
  const dir = testTmp('brain-config-shape-');
  writeFileSync(join(dir, 'brain.config.json'), 'null');
  assert.throws(
    () => loadBrainConfigOrThrow(dir),
    (err) => {
      assert.match(err.message, /brain\.config\.json/, 'names the file');
      assert.match(err.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'names the path');
      assert.match(err.message, /must contain a JSON object/, 'names the failure kind');
      assert.match(err.message, /got null/, 'names the type found');
      return true;
    },
  );
});

test('T5: loadBrainConfigOrThrow — brain.config.json is `[]` → throws "got array"', () => {
  const dir = testTmp('brain-config-shape-');
  writeFileSync(join(dir, 'brain.config.json'), '[]');
  assert.throws(
    () => loadBrainConfigOrThrow(dir),
    (err) => {
      assert.match(err.message, /must contain a JSON object/);
      assert.match(err.message, /got array/);
      return true;
    },
  );
});

test('T6: loadBrainConfigOrThrow — brain.config.json is `42` → throws "got number"', () => {
  const dir = testTmp('brain-config-shape-');
  writeFileSync(join(dir, 'brain.config.json'), '42');
  assert.throws(
    () => loadBrainConfigOrThrow(dir),
    (err) => {
      assert.match(err.message, /must contain a JSON object/);
      assert.match(err.message, /got number/);
      return true;
    },
  );
});

test('T7: loadBrainConfigOrThrow — brain.config.json is `"x"` → throws "got string"', () => {
  const dir = testTmp('brain-config-shape-');
  writeFileSync(join(dir, 'brain.config.json'), '"x"');
  assert.throws(
    () => loadBrainConfigOrThrow(dir),
    (err) => {
      assert.match(err.message, /must contain a JSON object/);
      assert.match(err.message, /got string/);
      return true;
    },
  );
});

test('T8: loadBrainConfigOrThrow — no file at all → still returns {} (unchanged by the shape check, R11)', () => {
  const dir = testTmp('brain-config-shape-');
  assert.deepEqual(loadBrainConfigOrThrow(dir), {});
});

test('T9: loadBrainConfigOrThrow — a valid object → still returns the parsed object unchanged', () => {
  const dir = testTmp('brain-config-shape-');
  writeFileSync(join(dir, 'brain.config.json'), JSON.stringify({ governance: { reviewActors: ['bot'] } }));
  assert.deepEqual(loadBrainConfigOrThrow(dir), { governance: { reviewActors: ['bot'] } });
});

test('ensureBrainConfig: no origin (null host) → creates file but empty provider/host/slug', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-ensure-'));
  try {
    const result = ensureBrainConfig(dir, { identity: { host: null, project: null } });
    assert.equal(result.created, true);
    assert.equal(result.provider, '');

    const cfg = JSON.parse(readFileSync(join(dir, 'brain.config.json'), 'utf8'));
    assert.equal(cfg.project.gitHost, '');
    assert.equal(cfg.project.slug, '');
    assert.equal(cfg.vcs.provider, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #1127 (class C): `env:init` ran `ensure` over a brain.config.json that could not be
// parsed and exited 0 in silence; every later step then read an empty config.
test('ensureBrainConfig (#1127): an existing brain.config.json that cannot be parsed is reported, not silently skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-ensure-corrupt-'));
  try {
    writeFileSync(join(dir, 'brain.config.json'), '{ not json');
    const result = ensureBrainConfig(dir, { identity: { host: 'github.com', project: 'owner/repo' } });
    assert.equal(result.created, false);
    assert.match(result.error ?? '', /parse|JSON/i);
    assert.equal(readFileSync(join(dir, 'brain.config.json'), 'utf8'), '{ not json', 'the file is left untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
