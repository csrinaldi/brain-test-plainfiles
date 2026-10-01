// installer.test.mjs — Unit tests for the brain versioned installer mechanics.
// Run with: npm test   (node --test, no dependencies)
//
// Covers the two acceptance criteria that demand proof:
//   - local paths survive an upgrade untouched
//   - config migration adds new keys without overwriting existing values

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, lstatSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  globToRegExp,
  matchesAny,
  copyManaged,
  readOutgoing,
  createRestorePoint,
  RESTORE_POINT_DIR,
  mergeDefaults,
  mergeClaudeSettings,
  mergeSettings,
  mergePackageJsonScripts,
  mergePackageJson,
  migrateConfig,
  compareSemver,
  parseSemver,
  highestTag,
  readInstalledVersion,
  resolveInstallUrl,
  installSpec,
  BRAIN_REPO_HTTPS,
} from './installer.mjs';

import { migrations } from '../../core/config-migrations.mjs';
import { managed as realManagedGlobs } from '../../core/managed-paths.mjs';

// ── Glob matching ────────────────────────────────────────────────────────────
test('globToRegExp: ** matches across separators, * does not', () => {
  assert.ok(globToRegExp('brain/core/**').test('brain/core/a/b.md'));
  assert.ok(globToRegExp('brain/core/**').test('brain/core/x.md'));
  assert.ok(!globToRegExp('brain/core/**').test('brain/project/x.md'));
  // Adversarial: a sibling dir sharing the prefix must NOT match (literal slash required).
  assert.ok(!globToRegExp('brain/core/**').test('brain/core-extra/x.md'));
  assert.ok(globToRegExp('scripts/*').test('scripts/a.mjs'));
  assert.ok(!globToRegExp('scripts/*').test('scripts/sub/a.mjs'));
  assert.ok(globToRegExp('.gitattributes').test('.gitattributes'));
});

test('matchesAny: any glob in the set matches', () => {
  const globs = ['brain/core/**', '.gitattributes'];
  assert.ok(matchesAny('brain/core/x.md', globs));
  assert.ok(matchesAny('.gitattributes', globs));
  assert.ok(!matchesAny('brain.config.json', globs));
});

// ── copyManaged: local paths stay intact ───────────────────────────────────────
test('copyManaged overwrites managed paths and never touches local ones', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-test-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');

    // Source (the new brain package): managed files only.
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'methodology.md'), 'NEW core');
    mkdirSync(join(src, 'scripts'), { recursive: true });
    writeFileSync(join(src, 'scripts', 'day-start.mjs'), 'NEW script');
    writeFileSync(join(src, '.gitattributes'), 'NEW attrs');
    // A file that lives in the package but is the consumer's to own. It is NOT
    // a managed path, so it must never be copied into the consumer.
    mkdirSync(join(src, 'brain', 'project'), { recursive: true });
    writeFileSync(join(src, 'brain', 'project', 'README.md'), 'UPSTREAM project readme');
    // A genuine overlap: matches a managed glob AND a local glob → must be skipped.
    writeFileSync(join(src, 'scripts', 'keep.local.mjs'), 'UPSTREAM overlap');

    // Dest (the consumer repo): pre-existing local + managed content.
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'methodology.md'), 'OLD core');
    mkdirSync(join(dest, 'brain', 'project', 'decisions'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'project', 'decisions', 'adr-0001.md'), 'MY adr');
    writeFileSync(join(dest, 'brain.config.json'), '{"project":{"name":"mine"}}');

    const managed = ['brain/core/**', 'scripts/**', '.gitattributes'];
    const local = ['brain/project/**', 'brain.config.json', '.env', '.memory/**', 'scripts/*.local.mjs'];

    const { copied, skipped } = copyManaged({ srcRoot: src, destRoot: dest, managed, local });

    // Managed files were overwritten / created.
    assert.equal(readFileSync(join(dest, 'brain', 'core', 'methodology.md'), 'utf8'), 'NEW core');
    assert.equal(readFileSync(join(dest, 'scripts', 'day-start.mjs'), 'utf8'), 'NEW script');
    assert.equal(readFileSync(join(dest, '.gitattributes'), 'utf8'), 'NEW attrs');

    // Local files are untouched.
    assert.equal(readFileSync(join(dest, 'brain', 'project', 'decisions', 'adr-0001.md'), 'utf8'), 'MY adr');
    assert.equal(readFileSync(join(dest, 'brain.config.json'), 'utf8'), '{"project":{"name":"mine"}}');

    // The upstream project/README.md is not a managed path → never copied.
    assert.ok(!existsSync(join(dest, 'brain', 'project', 'README.md')));
    assert.ok(!copied.includes('brain/project/README.md'));

    // The overlap (managed AND local) was skipped, not copied — local wins.
    assert.ok(skipped.includes('scripts/keep.local.mjs'));
    assert.ok(!existsSync(join(dest, 'scripts', 'keep.local.mjs')));

    assert.ok(copied.includes('brain/core/methodology.md'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── mergeDefaults / migrateConfig: never overwrite existing values ──────────────
test('mergeDefaults fills missing keys and preserves existing values', () => {
  const existing = { project: { name: 'mine', slug: 'org/repo' } };
  const defaults = { project: { name: 'DEFAULT', owner: 'DEFAULT' }, newSection: { flag: true } };
  const merged = mergeDefaults(existing, defaults);

  assert.equal(merged.project.name, 'mine');     // existing wins
  assert.equal(merged.project.slug, 'org/repo'); // existing preserved
  assert.equal(merged.project.owner, 'DEFAULT'); // missing key added
  assert.deepEqual(merged.newSection, { flag: true }); // new section added
});

test('migrateConfig applies a new additive migration without clobbering', () => {
  const config = {
    schemaVersion: '0.1.0',
    project: { name: 'mine', slug: 'org/repo', gitHost: 'github.com' },
  };
  const migrations = [
    { version: '0.1.0', description: 'initial', defaults: { project: { name: '', owner: '' } } },
    { version: '0.2.0', description: 'add ci section', defaults: { ci: { provider: 'github-actions' } } },
  ];
  const { config: migrated, applied } = migrateConfig(config, migrations, '0.2.0');

  assert.deepEqual(applied, ['0.2.0']);            // only the pending one ran
  assert.equal(migrated.project.name, 'mine');     // existing untouched
  assert.equal(migrated.ci.provider, 'github-actions'); // new section added
  assert.equal(migrated.schemaVersion, '0.2.0');   // version advanced
});

test('migrateConfig is idempotent — re-running applies nothing', () => {
  const config = { schemaVersion: '0.2.0', project: { name: 'mine' }, ci: { provider: 'x' } };
  const migrations = [{ version: '0.2.0', defaults: { ci: { provider: 'default' } } }];
  const { applied } = migrateConfig(config, migrations, '0.2.0');
  assert.deepEqual(applied, []);
});

// ── Semver helpers ─────────────────────────────────────────────────────────────
test('parseSemver and compareSemver', () => {
  assert.deepEqual(parseSemver('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseSemver('0.1.0-rc.1'), [0, 1, 0]);
  assert.equal(compareSemver('1.0.0', '1.0.1'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('v1.0.0', '1.0.0'), 0);
});

test('readInstalledVersion: consumer node_modules/brain wins, falls back to own pkg', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-ver-'));
  try {
    // Consumer layout: node_modules/brain/package.json is the installed brain.
    mkdirSync(join(tmp, 'node_modules', 'brain'), { recursive: true });
    writeFileSync(join(tmp, 'node_modules', 'brain', 'package.json'), JSON.stringify({ name: 'brain', version: '0.3.0' }));
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'my-consumer', version: '9.9.9' }));
    assert.equal(readInstalledVersion(tmp), '0.3.0');

    // Self-host layout: no node_modules/brain, own package.json is named brain.
    const selfHost = mkdtempSync(join(tmpdir(), 'brain-self-'));
    try {
      writeFileSync(join(selfHost, 'package.json'), JSON.stringify({ name: 'brain', version: '0.1.0' }));
      assert.equal(readInstalledVersion(selfHost), '0.1.0');
    } finally {
      rmSync(selfHost, { recursive: true, force: true });
    }

    // Neither present → null.
    const empty = mkdtempSync(join(tmpdir(), 'brain-empty-'));
    try {
      assert.equal(readInstalledVersion(empty), null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('highestTag picks the newest semver tag and ignores peeled refs', () => {
  const stdout = [
    'abc123\trefs/tags/v0.1.0',
    'def456\trefs/tags/v0.2.0',
    'def456\trefs/tags/v0.2.0^{}',
    'ghi789\trefs/tags/not-a-version',
  ].join('\n');
  assert.equal(highestTag(stdout), 'v0.2.0');
  assert.equal(highestTag('no tags here'), null);
});

// ── resolveInstallUrl ─────────────────────────────────────────────────────────

test('resolveInstallUrl: git+https URL is returned as-is', () => {
  assert.equal(
    resolveInstallUrl('git+https://github.com/csrinaldi/brain.git'),
    'git+https://github.com/csrinaldi/brain.git',
  );
});

test('resolveInstallUrl: plain https URL gets git+ prefix', () => {
  assert.equal(
    resolveInstallUrl('https://github.com/csrinaldi/brain.git'),
    'git+https://github.com/csrinaldi/brain.git',
  );
});

test('resolveInstallUrl: git+ssh URL is converted to git+https', () => {
  assert.equal(
    resolveInstallUrl('git+ssh://git@github.com/csrinaldi/brain.git'),
    'git+https://github.com/csrinaldi/brain.git',
  );
});

test('resolveInstallUrl: SCP-style git@ URL is converted to git+https', () => {
  assert.equal(
    resolveInstallUrl('git@github.com:csrinaldi/brain.git'),
    'git+https://github.com/csrinaldi/brain.git',
  );
});

test('resolveInstallUrl: github: shorthand is converted to git+https', () => {
  assert.equal(
    resolveInstallUrl('github:csrinaldi/brain'),
    'git+https://github.com/csrinaldi/brain.git',
  );
});

test('resolveInstallUrl: null/undefined falls back to BRAIN_REPO_HTTPS constant', () => {
  assert.equal(resolveInstallUrl(null), BRAIN_REPO_HTTPS);
  assert.equal(resolveInstallUrl(undefined), BRAIN_REPO_HTTPS);
  assert.equal(resolveInstallUrl(''), BRAIN_REPO_HTTPS);
});

// ── installSpec ───────────────────────────────────────────────────────────────

test('installSpec: derives git+https spec from installed brain package.json (git+https url)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-spec-'));
  try {
    mkdirSync(join(tmp, 'node_modules', 'brain'), { recursive: true });
    writeFileSync(
      join(tmp, 'node_modules', 'brain', 'package.json'),
      JSON.stringify({ name: 'brain', version: '0.4.0', repository: { type: 'git', url: 'git+https://github.com/csrinaldi/brain.git' } }),
    );
    assert.equal(installSpec(tmp, 'v0.4.0'), 'git+https://github.com/csrinaldi/brain.git#v0.4.0');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installSpec: normalizes https repository.url and appends tag', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-spec-'));
  try {
    mkdirSync(join(tmp, 'node_modules', 'brain'), { recursive: true });
    writeFileSync(
      join(tmp, 'node_modules', 'brain', 'package.json'),
      JSON.stringify({ name: 'brain', version: '0.4.0', repository: { type: 'git', url: 'https://github.com/csrinaldi/brain.git' } }),
    );
    assert.equal(installSpec(tmp, 'v0.4.0'), 'git+https://github.com/csrinaldi/brain.git#v0.4.0');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installSpec: falls back to constant when node_modules/brain/package.json is absent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-spec-'));
  try {
    assert.equal(installSpec(tmp, 'v0.4.0'), `${BRAIN_REPO_HTTPS}#v0.4.0`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('installSpec: falls back to constant when repository.url field is absent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-spec-'));
  try {
    mkdirSync(join(tmp, 'node_modules', 'brain'), { recursive: true });
    writeFileSync(
      join(tmp, 'node_modules', 'brain', 'package.json'),
      JSON.stringify({ name: 'brain', version: '0.4.0' }),
    );
    assert.equal(installSpec(tmp, 'v0.4.0'), `${BRAIN_REPO_HTTPS}#v0.4.0`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── governance.ignoreList migration (0.4.0) ────────────────────────────────────

test('0.4.0 migration adds governance.ignoreList when missing', () => {
  const config = {
    schemaVersion: '0.3.0',
    project: { name: 'mine', slug: 'org/repo', gitHost: 'github.com', gitProjectId: '1', owner: 'me' },
    docs: { language: 'en' },
    vcs: { provider: 'github' },
  };
  const { config: migrated, applied } = migrateConfig(config, migrations, '0.4.0');

  assert.deepEqual(applied, ['0.4.0']);
  assert.equal(migrated.schemaVersion, '0.4.0');
  assert.ok(Array.isArray(migrated.governance?.ignoreList), 'governance.ignoreList must be an array');
  assert.ok(migrated.governance.ignoreList.includes('.memory/**'), 'must include .memory/**');
  assert.ok(migrated.governance.ignoreList.includes('openspec/changes/**'), 'must include openspec/changes/**');
  assert.ok(migrated.governance.ignoreList.includes('package-lock.json'), 'must include package-lock.json');
  assert.ok(migrated.governance.ignoreList.includes('pnpm-lock.yaml'), 'must include pnpm-lock.yaml');
  assert.ok(migrated.governance.ignoreList.includes('yarn.lock'), 'must include yarn.lock');
});

test('0.4.0 migration is idempotent — re-running on an already-migrated config is a no-op', () => {
  const config = {
    schemaVersion: '0.4.0',
    project: { name: 'mine', slug: 'org/repo', gitHost: 'github.com', gitProjectId: '1', owner: 'me' },
    docs: { language: 'en' },
    vcs: { provider: 'github' },
    governance: { ignoreList: ['.memory/**', 'openspec/changes/**', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] },
  };
  const { applied } = migrateConfig(config, migrations, '0.4.0');
  assert.deepEqual(applied, []);
});

test('0.4.0 migration preserves a consumer-set governance.ignoreList', () => {
  const config = {
    schemaVersion: '0.3.0',
    project: { name: 'mine', slug: 'org/repo', gitHost: 'github.com', gitProjectId: '1', owner: 'me' },
    docs: { language: 'en' },
    vcs: { provider: 'github' },
    governance: { ignoreList: ['dist/**', 'coverage/**'] },
  };
  const { config: migrated } = migrateConfig(config, migrations, '0.4.0');

  // Consumer-set list must be preserved (mergeDefaults never overwrites existing values).
  assert.deepEqual(migrated.governance.ignoreList, ['dist/**', 'coverage/**']);
});

// ── memory secret-scrub config migration (0.5.0, issue #214) ───────────────────

test('0.5.0 migration adds governance.memorySecretPatterns + memorySecretAllowPatterns when missing', () => {
  const config = {
    schemaVersion: '0.4.0',
    project: { name: 'mine', slug: 'org/repo', gitHost: 'github.com', gitProjectId: '1', owner: 'me' },
    docs: { language: 'en' },
    vcs: { provider: 'github' },
    governance: { ignoreList: ['.memory/**'] },
  };
  const { config: migrated, applied } = migrateConfig(config, migrations, '0.5.0');

  assert.deepEqual(applied, ['0.5.0']);
  assert.equal(migrated.schemaVersion, '0.5.0');
  assert.ok(Array.isArray(migrated.governance?.memorySecretPatterns), 'memorySecretPatterns must be an array');
  assert.ok(migrated.governance.memorySecretPatterns.includes('AKIA[0-9A-Z]{16}'), 'must include the AWS key pattern');
  assert.ok(Array.isArray(migrated.governance?.memorySecretAllowPatterns), 'memorySecretAllowPatterns must be an array');
  assert.deepEqual(migrated.governance.memorySecretAllowPatterns, [], 'no allowlist entries ship by default');
  // Additive: the pre-existing ignoreList from 0.4.0 must survive untouched.
  assert.deepEqual(migrated.governance.ignoreList, ['.memory/**']);
});

test('0.5.0 migration is idempotent — re-running on an already-migrated config is a no-op', () => {
  const config = {
    schemaVersion: '0.5.0',
    project: { name: 'mine', slug: 'org/repo', gitHost: 'github.com', gitProjectId: '1', owner: 'me' },
    docs: { language: 'en' },
    vcs: { provider: 'github' },
    governance: {
      memorySecretPatterns: ['ghp_[A-Za-z0-9]{20,}', 'github_pat_[A-Za-z0-9_]{20,}', 'glpat-[A-Za-z0-9_-]{20,}', 'AKIA[0-9A-Z]{16}', '-----BEGIN [A-Z ]*PRIVATE KEY-----'],
      memorySecretAllowPatterns: [],
    },
  };
  const { applied } = migrateConfig(config, migrations, '0.5.0');
  assert.deepEqual(applied, []);
});

test('0.5.0 migration preserves a consumer-set memorySecretAllowPatterns', () => {
  const config = {
    schemaVersion: '0.4.0',
    project: { name: 'mine', slug: 'org/repo', gitHost: 'github.com', gitProjectId: '1', owner: 'me' },
    docs: { language: 'en' },
    vcs: { provider: 'github' },
    governance: { memorySecretAllowPatterns: ['glpat-TUTORIAL-EXAMPLE'] },
  };
  const { config: migrated } = migrateConfig(config, migrations, '0.5.0');

  // Consumer-set allowlist must be preserved (mergeDefaults never overwrites existing values).
  assert.deepEqual(migrated.governance.memorySecretAllowPatterns, ['glpat-TUTORIAL-EXAMPLE']);
});

// Drift guard: config-migrations.mjs's 0.5.0 default pattern list and
// secret-scrub.mjs's runtime DEFAULT_SECRET_PATTERNS describe the same
// conceptual default — they must never diverge silently.
test('0.5.0 migration default patterns match secret-scrub.mjs#DEFAULT_SECRET_PATTERNS (drift guard)', async () => {
  const { DEFAULT_SECRET_PATTERNS } = await import('../memory/lib/secret-scrub.mjs');
  const migration = migrations.find((m) => m.version === '0.5.0');
  assert.deepEqual(migration.defaults.governance.memorySecretPatterns, DEFAULT_SECRET_PATTERNS);
});

// ── S1: mergeClaudeSettings ───────────────────────────────────────────────────
//
// Fixtures shared across S1 tests.

/** Brain's canonical .claude/settings.json block (PreToolUse hook). */
const BRAIN_HOOK_ENTRY = {
  matcher: 'Bash',
  hooks: [
    {
      type: 'command',
      command: 'node -e "const cmd = JSON.parse(require(\'fs\').readFileSync(\'/dev/stdin\',\'utf8\')).tool_input?.command ?? \'\'; if (/--no-verify/.test(cmd)) { process.exit(2); }"',
    },
  ],
};

const BRAIN_SETTINGS = {
  hooks: {
    PreToolUse: [BRAIN_HOOK_ENTRY],
  },
};

/**
 * Writes a temporary brain settings file and returns its path.
 * Caller must clean up the parent tmp directory.
 */
function writeBrainSettings(dir) {
  const p = join(dir, 'brain-settings.json');
  writeFileSync(p, JSON.stringify(BRAIN_SETTINGS, null, 2) + '\n');
  return p;
}

// REQ-S1-1: Fresh consumer — brain block written as-is.
test('mergeClaudeSettings: fresh consumer writes brain settings as-is (REQ-S1-1)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s1-1-'));
  try {
    const brainPath = writeBrainSettings(tmp);
    const destPath = join(tmp, 'settings.json');
    // destPath does not exist — mergeClaudeSettings must create it.
    mergeClaudeSettings(destPath, brainPath);
    const result = JSON.parse(readFileSync(destPath, 'utf8'));
    assert.deepEqual(result, BRAIN_SETTINGS, 'fresh consumer: output must equal brain settings block');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S1-2a: 63-entry permissions.allow preserved after merge.
test('mergeClaudeSettings: 63-entry permissions.allow preserved, brain hooks present (REQ-S1-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s1-2a-'));
  try {
    const brainPath = writeBrainSettings(tmp);
    const allowList = Array.from({ length: 63 }, (_, i) => `Bash(allowed_tool_${i}:*)`);
    const consumerSettings = {
      permissions: { allow: allowList },
      hooks: { PreToolUse: [] },
    };
    const destPath = join(tmp, 'settings.json');
    writeFileSync(destPath, JSON.stringify(consumerSettings, null, 2) + '\n');

    mergeClaudeSettings(destPath, brainPath);

    const result = JSON.parse(readFileSync(destPath, 'utf8'));

    // All 63 original permissions.allow entries must survive.
    assert.equal(result.permissions?.allow?.length, 63,
      'all 63 permissions.allow entries must be preserved');
    for (const entry of allowList) {
      assert.ok(result.permissions.allow.includes(entry),
        `permissions.allow must retain: ${entry}`);
    }

    // Brain hook must be present.
    const preToolUse = result.hooks?.PreToolUse ?? [];
    const brainHookPresent = preToolUse.some(
      (e) => JSON.stringify(e) === JSON.stringify(BRAIN_HOOK_ENTRY),
    );
    assert.ok(brainHookPresent, 'brain PreToolUse hook must be present after merge');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S1-2b: Custom consumer hook not owned by brain is preserved.
test('mergeClaudeSettings: custom consumer hook is preserved alongside brain hooks (REQ-S1-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s1-2b-'));
  try {
    const brainPath = writeBrainSettings(tmp);
    const customEntry = { matcher: 'Read', hooks: [{ type: 'command', command: 'my-custom-hook' }] };
    const consumerSettings = { hooks: { PreToolUse: [customEntry] } };
    const destPath = join(tmp, 'settings.json');
    writeFileSync(destPath, JSON.stringify(consumerSettings, null, 2) + '\n');

    mergeClaudeSettings(destPath, brainPath);

    const result = JSON.parse(readFileSync(destPath, 'utf8'));
    const preToolUse = result.hooks?.PreToolUse ?? [];

    const customPresent = preToolUse.some(
      (e) => JSON.stringify(e) === JSON.stringify(customEntry),
    );
    assert.ok(customPresent, 'consumer custom hook must be preserved after merge');

    const brainPresent = preToolUse.some(
      (e) => JSON.stringify(e) === JSON.stringify(BRAIN_HOOK_ENTRY),
    );
    assert.ok(brainPresent, 'brain hook must also be present after merge');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S1-3: Idempotent — second run produces no duplication.
test('mergeClaudeSettings: idempotent — second upgrade does not duplicate brain hooks (REQ-S1-3)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s1-3-'));
  try {
    const brainPath = writeBrainSettings(tmp);
    const consumerSettings = { hooks: { PreToolUse: [] } };
    const destPath = join(tmp, 'settings.json');
    writeFileSync(destPath, JSON.stringify(consumerSettings, null, 2) + '\n');

    // First run.
    mergeClaudeSettings(destPath, brainPath);
    const afterFirst = JSON.parse(readFileSync(destPath, 'utf8'));
    const countAfterFirst = afterFirst.hooks?.PreToolUse?.length ?? 0;

    // Second run.
    mergeClaudeSettings(destPath, brainPath);
    const afterSecond = JSON.parse(readFileSync(destPath, 'utf8'));
    const countAfterSecond = afterSecond.hooks?.PreToolUse?.length ?? 0;

    assert.equal(countAfterSecond, countAfterFirst,
      'second upgrade must not add duplicate brain hook entries');
    assert.deepEqual(afterSecond, afterFirst,
      'settings.json must be identical after first and second upgrade');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S1-2c: brain hook events OTHER than PreToolUse are also merged (regression
// guard — the merge must loop over every event brain defines, not just PreToolUse).
test('mergeClaudeSettings: brain hooks under non-PreToolUse events are merged (REQ-S1-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s1-2c-'));
  try {
    const postEntry = { matcher: 'Write', hooks: [{ type: 'command', command: 'brain-post' }] };
    const brainPath = join(tmp, 'brain-settings.json');
    writeFileSync(brainPath, JSON.stringify({ hooks: { PostToolUse: [postEntry] } }, null, 2));

    const consumerEntry = { matcher: 'Read', hooks: [{ type: 'command', command: 'consumer-pre' }] };
    const destPath = join(tmp, 'settings.json');
    writeFileSync(destPath, JSON.stringify({ hooks: { PreToolUse: [consumerEntry] } }, null, 2) + '\n');

    mergeClaudeSettings(destPath, brainPath);

    const result = JSON.parse(readFileSync(destPath, 'utf8'));
    const postPresent = (result.hooks?.PostToolUse ?? []).some(
      (e) => JSON.stringify(e) === JSON.stringify(postEntry),
    );
    assert.ok(postPresent, 'brain PostToolUse hook must be merged, not dropped');
    // The consumer's unrelated PreToolUse event must survive untouched.
    assert.deepEqual(result.hooks?.PreToolUse, [consumerEntry],
      'consumer-only hook events must be preserved');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── issue #1139: mergeSettings — the shared pure core ────────────────────────
//
// mergeClaudeSettings (above) is a thin file-IO wrapper. These tests pin the
// pure, fs-free core directly — the same function claude.mjs/antigravity.mjs
// import and call (REQ-1139-6).

test('mergeSettings(null, brainSettings): no existing settings — returns brain settings as-is (REQ-1139-3)', () => {
  const result = mergeSettings(null, BRAIN_SETTINGS);
  assert.deepEqual(result, BRAIN_SETTINGS);
});

test('mergeSettings: consumer permissions.allow and custom hook survive, brain hook present (REQ-1139-1)', () => {
  const customEntry = { matcher: 'Read', hooks: [{ type: 'command', command: 'my-custom-hook' }] };
  const existing = {
    permissions: { allow: ['Bash(a:*)', 'Bash(b:*)'] },
    hooks: { PreToolUse: [customEntry] },
  };
  const result = mergeSettings(existing, BRAIN_SETTINGS);

  assert.deepEqual(result.permissions.allow, ['Bash(a:*)', 'Bash(b:*)']);
  const preToolUse = result.hooks.PreToolUse;
  assert.ok(preToolUse.some((e) => JSON.stringify(e) === JSON.stringify(customEntry)));
  assert.ok(preToolUse.some((e) => JSON.stringify(e) === JSON.stringify(BRAIN_HOOK_ENTRY)));
});

test('mergeSettings: applying twice in sequence does not duplicate brain hooks (REQ-1139-2)', () => {
  const existing = { hooks: { PreToolUse: [] } };
  const once = mergeSettings(existing, BRAIN_SETTINGS);
  const twice = mergeSettings(once, BRAIN_SETTINGS);
  assert.deepEqual(twice, once);
  assert.equal(twice.hooks.PreToolUse.length, 1);
});

test('mergeSettings is pure — mutates neither argument', () => {
  const existing = { permissions: { allow: ['x'] }, hooks: { PreToolUse: [] } };
  const existingSnapshot = JSON.parse(JSON.stringify(existing));
  const brainSnapshot = JSON.parse(JSON.stringify(BRAIN_SETTINGS));
  mergeSettings(existing, BRAIN_SETTINGS);
  assert.deepEqual(existing, existingSnapshot);
  assert.deepEqual(BRAIN_SETTINGS, brainSnapshot);
});

// REQ-S1-4: settings.local.json is absent from the managed-paths export.
test('settings.local.json is absent from the managed-paths.mjs managed export (REQ-S1-4)', async () => {
  const { managed: managedGlobs } = await import('../../core/managed-paths.mjs');
  // Use real glob expansion (not a substring scan) so the assertion still holds
  // if managed ever switches to a wildcard like `.claude/**`.
  assert.ok(
    !matchesAny('.claude/settings.local.json', managedGlobs),
    'settings.local.json must not match any managed glob',
  );
});

// ── S2: Collision Guard ───────────────────────────────────────────────────────
//
// All S2 tests exercise copyManaged() directly. The pre-flight guarantee
// (detection before first write) is proved via abortOnCollision: when the
// abort gate fires the write loop is never entered — so a clean file that
// would have been written is still absent from disk after the call.

// REQ-S2-1: Differing dest produces a collision record.
test('copyManaged: collision recorded when dest exists and bytes differ from src (REQ-S2-1)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s2-1-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'a.md'), 'SRC CONTENT');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'a.md'), 'DIFFERENT CONTENT');

    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
    });

    assert.ok(Array.isArray(result.collisions),
      'result must have a collisions array');
    assert.ok(result.collisions.includes('brain/core/a.md'),
      'collision must include the differing path');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S2-1: Pre-flight runs before any write. Proved by aborting: a clean
// sibling file is absent from disk after the call because the write loop
// was never entered — i.e., collision detection completed before writes.
test('copyManaged: collision detection is a pre-flight pass before any write begins (REQ-S2-1)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s2-pf-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    // File a.md: will collide (dest differs).
    writeFileSync(join(src, 'brain', 'core', 'a.md'), 'SRC A');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'a.md'), 'OLD A');
    // File b.md: clean (no dest), would be copied in a normal run.
    writeFileSync(join(src, 'brain', 'core', 'b.md'), 'SRC B');

    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
      abortOnCollision: true,
    });

    // Collision detected in pre-flight.
    assert.ok(result.collisions.includes('brain/core/a.md'),
      'collision must be detected');
    // Zero writes — the write loop was never entered.
    assert.equal(result.copied.length, 0,
      'zero copies when aborting on collision');
    assert.ok(!existsSync(join(dest, 'brain', 'core', 'b.md')),
      'clean sibling file must not be written when pre-flight caused abort');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S2-2: abort path — zero writes when collisions exist.
test('copyManaged: abortOnCollision=true causes zero writes when collisions exist (REQ-S2-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s2-2-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'managed.md'), 'NEW CONTENT');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'managed.md'), 'OLD CONTENT');

    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
      abortOnCollision: true,
    });

    assert.equal(result.copied.length, 0,
      'no files must be copied when aborting on collision');
    assert.equal(
      readFileSync(join(dest, 'brain', 'core', 'managed.md'), 'utf8'),
      'OLD CONTENT',
      'destination file must remain unchanged',
    );
    assert.ok(result.collisions.includes('brain/core/managed.md'),
      'collision must be present in result');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S2-2: default (no abort) — a collision is recorded but the colliding file
// IS still overwritten (the documented "warn and proceed" behavior, verified on disk).
test('copyManaged: without abortOnCollision a collision is recorded but the file is still overwritten (REQ-S2-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s2-proceed-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'managed.md'), 'NEW CONTENT');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'managed.md'), 'OLD CONTENT');

    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
      // abortOnCollision omitted → defaults to false
    });

    assert.ok(result.collisions.includes('brain/core/managed.md'),
      'collision must still be recorded in the proceed path');
    assert.ok(result.copied.includes('brain/core/managed.md'),
      'colliding file must be reported as copied');
    assert.equal(
      readFileSync(join(dest, 'brain', 'core', 'managed.md'), 'utf8'),
      'NEW CONTENT',
      'colliding file must be overwritten when not aborting',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S2-2: dry-run + abort — the abort gate must NOT blank the plan. The colliding
// file is reported in the plan, collisions are recorded, and nothing is written.
test('copyManaged: dryRun + abortOnCollision returns the full plan and writes nothing (REQ-S2-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s2-dryabort-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'managed.md'), 'NEW CONTENT');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'managed.md'), 'OLD CONTENT');

    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
      dryRun: true,
      abortOnCollision: true,
    });

    // Plan is preserved (not blanked by the abort gate) under dry-run.
    assert.ok(result.copied.includes('brain/core/managed.md'),
      'dry-run plan must list the colliding file under copied');
    assert.ok(result.collisions.includes('brain/core/managed.md'),
      'collision must be recorded under dry-run');
    // Nothing was written.
    assert.equal(
      readFileSync(join(dest, 'brain', 'core', 'managed.md'), 'utf8'),
      'OLD CONTENT',
      'dry-run must not write the colliding file',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S2-2: no-op when clean — abortOnCollision=true allows writes to proceed.
test('copyManaged: abortOnCollision=true is a no-op when there are no collisions (REQ-S2-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s2-clean-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'a.md'), 'SAME CONTENT');
    // Dest is identical — not a collision.
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'a.md'), 'SAME CONTENT');

    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
      abortOnCollision: true,
    });

    assert.equal(result.collisions.length, 0,
      'no collisions when content is identical');
    assert.ok(result.copied.includes('brain/core/a.md'),
      'file must be copied normally when no collision exists');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S2-3: Absent dest is NOT a collision.
test('copyManaged: absent dest is not a collision (REQ-S2-3)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s2-3a-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'new.md'), 'CONTENT');
    mkdirSync(dest, { recursive: true });
    // dest/brain/core/new.md does NOT exist.

    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
    });

    assert.equal(result.collisions.length, 0,
      'absent dest must not be a collision');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S2-3: Identical dest (same bytes) is NOT a collision.
test('copyManaged: identical dest is not a collision (REQ-S2-3)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s2-3b-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'same.md'), 'IDENTICAL CONTENT');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'same.md'), 'IDENTICAL CONTENT');

    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
    });

    assert.equal(result.collisions.length, 0,
      'identical dest must not be a collision');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Three-way modification detection (issue #397, REQ-397-1) ─────────────────
//
// The collision check above answers "do these bytes differ", which conflates
// two different facts: the consumer edited it, and brain changed it between
// releases. The third point that separates them is the OUTGOING package — what
// brain shipped LAST time — read before the install overwrites it.

// Builds a src/dest pair plus an `outgoing` map, so each scenario below reads
// as the three-way table in design.md §2 rather than as filesystem plumbing.
function threeWayFixture(prefix, { outgoingBytes, destBytes, incomingBytes }) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const src = join(tmp, 'src');
  const dest = join(tmp, 'dest');
  mkdirSync(join(src, '.github'), { recursive: true });
  mkdirSync(join(dest, '.github'), { recursive: true });
  writeFileSync(join(src, '.github', 'CODEOWNERS'), incomingBytes);
  if (destBytes !== null) writeFileSync(join(dest, '.github', 'CODEOWNERS'), destBytes);
  const outgoing = outgoingBytes === null
    ? null
    : new Map([['.github/CODEOWNERS', Buffer.from(outgoingBytes)]]);
  return { tmp, src, dest, outgoing };
}

// REQ-397-1 Scenario 1 — the NEGATIVE CONTROL (tasks.md 3.2). brain changed the
// file, the consumer never touched it. This must stay silent: a detector that
// fires here fires for every consumer on every release, and a warning that
// always fires is one nobody reads.
test('copyManaged: brain-changed but consumer-untouched is NOT consumer-modified (REQ-397-1 S1)', () => {
  const { tmp, src, dest, outgoing } = threeWayFixture('brain-397-s1-', {
    outgoingBytes: '* @brain-team\n',
    destBytes: '* @brain-team\n',   // byte-identical to what brain shipped last time
    incomingBytes: '* @brain-team\n# new line brain added\n',
  });
  try {
    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['.github/CODEOWNERS'],
      local: [],
      outgoing,
    });

    assert.deepEqual(result.consumerModified, [],
      'the consumer never edited this file — it must not be reported as modified');
    assert.deepEqual(result.brainChanged, ['.github/CODEOWNERS'],
      'brain changed it between releases, which is the other half of the answer');
    assert.equal(readFileSync(join(dest, '.github', 'CODEOWNERS'), 'utf8'),
      '* @brain-team\n# new line brain added\n',
      'an unmodified path must be written without prompting');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-397-1 Scenario 2 — the consumer edited it. Same dest-vs-incoming
// difference as Scenario 1; only the third point tells them apart.
test('copyManaged: dest differing from the OUTGOING package is consumer-modified (REQ-397-1 S2)', () => {
  const { tmp, src, dest, outgoing } = threeWayFixture('brain-397-s2-', {
    outgoingBytes: '* @brain-team\n',
    destBytes: '* @my-team\n',      // the consumer's own edit
    incomingBytes: '* @brain-team\n# new line brain added\n',
  });
  try {
    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['.github/CODEOWNERS'],
      local: [],
      outgoing,
    });

    assert.deepEqual(result.consumerModified, ['.github/CODEOWNERS']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Both facts are true at once, and they are reported separately rather than
// collapsed. #397 exists because one comparison was made to answer two questions.
test('copyManaged: consumer-modified and brain-changed are reported independently (REQ-397-1)', () => {
  const { tmp, src, dest, outgoing } = threeWayFixture('brain-397-both-', {
    outgoingBytes: '* @brain-team\n',
    destBytes: '* @my-team\n',
    incomingBytes: '* @brain-team\n# new line brain added\n',
  });
  try {
    const result = copyManaged({
      srcRoot: src, destRoot: dest, managed: ['.github/CODEOWNERS'], local: [], outgoing,
    });

    assert.deepEqual(result.consumerModified, ['.github/CODEOWNERS']);
    assert.deepEqual(result.brainChanged, ['.github/CODEOWNERS']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// A path brain ships for the first time has no outgoing copy. Absent from the
// outgoing map is not evidence of a consumer edit — and a dest that does not
// exist cannot have been edited either.
test('copyManaged: a path absent from the outgoing package is not consumer-modified (REQ-397-1)', () => {
  const { tmp, src, dest } = threeWayFixture('brain-397-new-', {
    outgoingBytes: null,
    destBytes: null,
    incomingBytes: '* @brain-team\n',
  });
  try {
    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['.github/CODEOWNERS'],
      local: [],
      outgoing: new Map(),   // brain did not ship this path last time
    });

    assert.deepEqual(result.consumerModified, []);
    assert.deepEqual(result.brainChanged, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-397-1 Scenario 3 — degraded mode. Under --no-install the outgoing and the
// incoming tree are the same directory, so consumer modification CANNOT be
// established. The result must say the check degraded rather than return an
// empty list that reads exactly like "nothing was modified".
test('copyManaged: no outgoing package degrades detection, and says so (REQ-397-1 S3)', () => {
  const { tmp, src, dest } = threeWayFixture('brain-397-s3-', {
    outgoingBytes: null,
    destBytes: '* @my-team\n',
    incomingBytes: '* @brain-team\n',
  });
  try {
    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['.github/CODEOWNERS'],
      local: [],
      outgoing: null,
    });

    assert.equal(result.modificationDetection, 'degraded',
      'with no outgoing package the run must report that it could not tell the two cases apart');
    assert.deepEqual(result.consumerModified, [],
      'a degraded check must not invent a verdict it could not reach');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: an outgoing package makes detection three-way (REQ-397-1)', () => {
  const { tmp, src, dest, outgoing } = threeWayFixture('brain-397-mode-', {
    outgoingBytes: '* @brain-team\n',
    destBytes: '* @brain-team\n',
    incomingBytes: '* @brain-team\n',
  });
  try {
    const result = copyManaged({
      srcRoot: src, destRoot: dest, managed: ['.github/CODEOWNERS'], local: [], outgoing,
    });
    assert.equal(result.modificationDetection, 'three-way');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── REFUSE + --force-managed (issue #397, REQ-397-2) ─────────────────────────
//
// A REFUSE-classified path has no meaningful merge — ownership lines and CI
// workflows are policies a team rewrites wholesale, not sets to union. So when
// the CONSUMER modified one, the only honest options are abort or a deliberate,
// per-path overwrite. #399's lesson runs through all of this INVERTED: there,
// dropping a path from the merge map silently sent it to the plain-copy set, so
// "skip" nearly became "clobber". Here the danger is the mirror image — a
// refused path must never quietly end up written.

// Two REFUSE-classified paths, each independently settable to "the consumer
// edited it" or not, so a test can say exactly which one it is talking about.
function refuseFixture(prefix, { ownersEdited, templateEdited }) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  const src = join(tmp, 'src');
  const dest = join(tmp, 'dest');
  mkdirSync(join(src, '.github'), { recursive: true });
  mkdirSync(join(dest, '.github'), { recursive: true });

  const SHIPPED_OWNERS = '* @brain-team\n';
  const SHIPPED_TEMPLATE = 'brain PR template\n';

  writeFileSync(join(src, '.github', 'CODEOWNERS'), '* @brain-team\n# brain added a line\n');
  writeFileSync(join(src, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'brain PR template v2\n');
  writeFileSync(join(dest, '.github', 'CODEOWNERS'), ownersEdited ? '* @my-team\n' : SHIPPED_OWNERS);
  writeFileSync(join(dest, '.github', 'PULL_REQUEST_TEMPLATE.md'), templateEdited ? 'my PR template\n' : SHIPPED_TEMPLATE);

  const outgoing = new Map([
    ['.github/CODEOWNERS', Buffer.from(SHIPPED_OWNERS)],
    ['.github/PULL_REQUEST_TEMPLATE.md', Buffer.from(SHIPPED_TEMPLATE)],
  ]);
  const call = (extra = {}) => copyManaged({
    srcRoot: src,
    destRoot: dest,
    managed: ['.github/CODEOWNERS', '.github/PULL_REQUEST_TEMPLATE.md'],
    local: [],
    outgoing,
    refusePaths: ['.github/CODEOWNERS', '.github/PULL_REQUEST_TEMPLATE.md'],
    ...extra,
  });
  const owners = () => readFileSync(join(dest, '.github', 'CODEOWNERS'), 'utf8');
  const template = () => readFileSync(join(dest, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8');
  return { tmp, owners, template, call };
}

// tasks.md 3.1 — the headline requirement.
test('copyManaged: a consumer-modified REFUSE path aborts and writes NOTHING (REQ-397-2)', () => {
  const { tmp, owners, template, call } = refuseFixture('brain-397-refuse-', { ownersEdited: true, templateEdited: false });
  try {
    const result = call();

    assert.deepEqual(result.refused, ['.github/CODEOWNERS'],
      'the modified REFUSE path must be named');
    assert.deepEqual(result.copied, [],
      'an abort must write nothing at all — not "everything except the refused path"');
    assert.equal(owners(), '* @my-team\n',
      'the consumer edit that caused the refusal must survive it');
    assert.equal(template(), 'brain PR template\n',
      'the OTHER path must be untouched too: the run aborted, it did not partially apply');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// tasks.md 3.4 — #399's lesson, inverted. The failure this guards against is not
// "the refusal did not fire" but "the refusal fired AND the file was written
// anyway", which is exactly the shape --skip-merge had before it was corrected.
test('copyManaged: a refused path is LEFT ALONE, never quietly written (REQ-397-2)', () => {
  const { tmp, owners, call } = refuseFixture('brain-397-leftalone-', { ownersEdited: true, templateEdited: true });
  try {
    const before = owners();
    const result = call();

    assert.equal(result.refused.length, 2);
    assert.equal(owners(), before,
      'a refused path must be byte-identical after the call — "refused" and "overwritten" must never swap');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// tasks.md 3.3 — forcing is per path. A flag that forced everything pending
// would recreate the clobber this issue is about, one keystroke away (signed
// decision 3).
test('copyManaged: forcing one path does NOT force another modified REFUSE path (REQ-397-2)', () => {
  const { tmp, owners, template, call } = refuseFixture('brain-397-force1-', { ownersEdited: true, templateEdited: true });
  try {
    const result = call({ forceManaged: ['.github/CODEOWNERS'] });

    assert.deepEqual(result.refused, ['.github/PULL_REQUEST_TEMPLATE.md'],
      'the unforced path must still refuse');
    assert.equal(owners(), '* @my-team\n',
      'the run aborted on the other path, so even the FORCED one must not be written');
    assert.equal(template(), 'my PR template\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: forcing every modified REFUSE path lets the run proceed and overwrites them (REQ-397-2)', () => {
  const { tmp, owners, template, call } = refuseFixture('brain-397-forceall-', { ownersEdited: true, templateEdited: true });
  try {
    const result = call({ forceManaged: ['.github/CODEOWNERS', '.github/PULL_REQUEST_TEMPLATE.md'] });

    assert.deepEqual(result.refused, []);
    assert.deepEqual(result.forced.sort(), ['.github/CODEOWNERS', '.github/PULL_REQUEST_TEMPLATE.md']);
    assert.equal(owners(), '* @brain-team\n# brain added a line\n',
      'a FORCED path is OVERWRITTEN — that is the whole point of asking for it by name');
    assert.equal(template(), 'brain PR template v2\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The negative control that keeps the gate from becoming noise. A REFUSE
// classification is not "always ask" — it is "ask when the CONSUMER has
// something to lose". Untouched, it copies like anything else.
test('copyManaged: an UNMODIFIED REFUSE path is copied without refusing (REQ-397-2)', () => {
  const { tmp, owners, call } = refuseFixture('brain-397-refuse-clean-', { ownersEdited: false, templateEdited: false });
  try {
    const result = call();

    assert.deepEqual(result.refused, []);
    assert.equal(owners(), '* @brain-team\n# brain added a line\n',
      'brain changed it and the consumer never touched it — this is what an upgrade is FOR');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// A dry run writes nothing anyway, so blanking the plan would make "preview
// first" — the habit this file's own comments recommend — the one path that
// hides what would happen. Same shape as the abortOnCollision dry-run rule.
test('copyManaged: dryRun reports the refusal AND still returns the full plan (REQ-397-2)', () => {
  const { tmp, call } = refuseFixture('brain-397-refuse-dry-', { ownersEdited: true, templateEdited: false });
  try {
    const result = call({ dryRun: true });

    assert.deepEqual(result.refused, ['.github/CODEOWNERS']);
    assert.ok(result.copied.length > 0,
      'a dry run must still show what a live run would copy');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// Degraded detection cannot establish consumer modification, so it cannot
// establish a refusal either. It must not invent one — and equally must not
// silently pass a modified file through as if it had checked.
test('copyManaged: with no outgoing package the REFUSE gate cannot fire (REQ-397-1 S3 + REQ-397-2)', () => {
  const { tmp, call } = refuseFixture('brain-397-refuse-degraded-', { ownersEdited: true, templateEdited: true });
  try {
    const result = call({ outgoing: null });

    assert.equal(result.modificationDetection, 'degraded');
    assert.deepEqual(result.refused, [],
      'a degraded check must not manufacture a verdict it could not reach');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── readOutgoing (issue #397, REQ-397-1) ─────────────────────────────────────

test('readOutgoing: returns the bytes brain shipped last time, keyed by rel path', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-397-ro-'));
  try {
    mkdirSync(join(tmp, '.github'), { recursive: true });
    writeFileSync(join(tmp, '.github', 'CODEOWNERS'), '* @brain-team\n');

    const out = readOutgoing({ pkgRoot: tmp, relPaths: ['.github/CODEOWNERS'] });

    assert.ok(out instanceof Map);
    assert.equal(out.get('.github/CODEOWNERS').toString(), '* @brain-team\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readOutgoing: a path the outgoing package does not ship is simply absent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-397-ro-abs-'));
  try {
    const out = readOutgoing({ pkgRoot: tmp, relPaths: ['.github/CODEOWNERS'] });
    assert.equal(out.has('.github/CODEOWNERS'), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// This runs BEFORE the install, on a tree that may be missing, partial, or from
// a much older brain. A throw here would abort an upgrade over a check that only
// ever makes the report better — so it never throws.
test('readOutgoing: an absent package root yields an empty map, never a throw', () => {
  const out = readOutgoing({ pkgRoot: join(tmpdir(), 'brain-397-does-not-exist-at-all'), relPaths: ['x'] });
  assert.equal(out.size, 0);
});

// specialMerge paths are EXCLUDED from the collision guard.
test('copyManaged: specialMerge paths are excluded from the collision guard', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s2-sm-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, '.claude'), { recursive: true });
    writeFileSync(join(src, '.claude', 'settings.json'), '{"hooks":{}}');
    mkdirSync(join(dest, '.claude'), { recursive: true });
    // Dest differs from src — would be a collision if not in specialMerge.
    writeFileSync(join(dest, '.claude', 'settings.json'), '{"different":true}');

    let mergeFnCalled = false;
    const fakeMergeFn = (_destPath, _srcPath) => { mergeFnCalled = true; };

    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['.claude/settings.json'],
      local: [],
      specialMerge: { '.claude/settings.json': fakeMergeFn },
    });

    assert.equal(result.collisions.length, 0,
      'specialMerge paths must not appear in collisions');
    assert.ok(mergeFnCalled,
      'specialMerge function must still be called');
    assert.ok(result.merged.includes('.claude/settings.json'),
      'path must appear in merged, not in collisions');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// REQ-S1-5: copyManaged routes .claude/settings.json through specialMerge, not copyFileSync.
test('copyManaged routes .claude/settings.json through specialMerge, not copied (REQ-S1-5)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s1-5-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, '.claude'), { recursive: true });
    writeFileSync(join(src, '.claude', 'settings.json'), JSON.stringify(BRAIN_SETTINGS));
    mkdirSync(join(dest, '.claude'), { recursive: true });
    writeFileSync(join(dest, '.claude', 'settings.json'), '{"existing":true}');

    let mergeFnCalled = false;
    const fakeMergeFn = (_destPath, _srcPath) => { mergeFnCalled = true; };

    const result = copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['.claude/settings.json'],
      local: [],
      specialMerge: { '.claude/settings.json': fakeMergeFn },
    });

    assert.ok(mergeFnCalled,
      'specialMerge function must be called for .claude/settings.json');
    assert.ok(!(result.copied ?? []).includes('.claude/settings.json'),
      '.claude/settings.json must not appear in copied');
    assert.ok((result.merged ?? []).includes('.claude/settings.json'),
      '.claude/settings.json must appear in merged');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── S5: mergePackageJsonScripts ───────────────────────────────────────────────
//
// Tests the PURE function directly. Fixtures use a small managed map so tests
// don't need to know about the full MANAGED_SCRIPT_KEYS list.

/** Small managed-scripts map used across S5 unit tests. */
const S5_MANAGED = {
  'brain:env:init': 'bash ./brain/scripts/bootstrap.sh',
  'brain:repo:check': 'node ./brain/scripts/check-refs.mjs',
  'brain:day:start': 'node ./brain/scripts/day-start.mjs',
};

// S5-a: fresh consumer with none of the managed keys → all injected.
test('mergePackageJsonScripts: injects all managed keys into a consumer that has none (S5-a)', () => {
  const consumer = { name: 'my-app', version: '1.0.0', scripts: { build: 'tsc', test: 'jest' } };
  const result = JSON.parse(mergePackageJsonScripts(consumer, S5_MANAGED));

  assert.equal(result.scripts['brain:env:init'], 'bash ./brain/scripts/bootstrap.sh',
    'brain:env:init must be injected');
  assert.equal(result.scripts['brain:repo:check'], 'node ./brain/scripts/check-refs.mjs',
    'brain:repo:check must be injected');
  assert.equal(result.scripts['brain:day:start'], 'node ./brain/scripts/day-start.mjs',
    'brain:day:start must be injected');
  // Pre-existing consumer scripts must be untouched.
  assert.equal(result.scripts.build, 'tsc', 'pre-existing build key must survive');
  assert.equal(result.scripts.test, 'jest', 'pre-existing test key must survive');
});

// S5-b: consumer owns brain:repo:check with a custom value → never overwritten.
test('mergePackageJsonScripts: consumer value wins unconditionally — never-overwrite (S5-b)', () => {
  const consumer = { scripts: { 'brain:repo:check': 'my-custom-check' } };
  const result = JSON.parse(mergePackageJsonScripts(consumer, S5_MANAGED));

  assert.equal(result.scripts['brain:repo:check'], 'my-custom-check',
    'consumer brain:repo:check must NOT be overwritten');
  // Other missing managed keys are still injected.
  assert.equal(result.scripts['brain:env:init'], 'bash ./brain/scripts/bootstrap.sh',
    'absent managed keys must still be injected');
  assert.equal(result.scripts['brain:day:start'], 'node ./brain/scripts/day-start.mjs',
    'absent managed keys must still be injected');
});

// S5-c: idempotent — second merge produces byte-equal output.
test('mergePackageJsonScripts: idempotent — second run is byte-equal to first (S5-c)', () => {
  const consumer = { scripts: { build: 'tsc' } };
  const first = mergePackageJsonScripts(consumer, S5_MANAGED);
  // Feed the first output back in as the consumer (simulates a re-upgrade).
  const second = mergePackageJsonScripts(JSON.parse(first), S5_MANAGED);
  assert.equal(second, first, 'second merge must produce identical bytes to first');
});

// S5-d: absent consumer file — treated as empty {} → managed scripts become the sole content.
test('mergePackageJsonScripts: empty consumer ({}) writes managed scripts as the sole content (S5-d)', () => {
  const result = JSON.parse(mergePackageJsonScripts({}, S5_MANAGED));

  // Only a scripts field should be present (empty consumer had nothing else).
  assert.deepEqual(Object.keys(result), ['scripts'],
    'output must contain only a scripts field when consumer is empty');
  for (const [k, v] of Object.entries(S5_MANAGED)) {
    assert.equal(result.scripts[k], v, `managed key "${k}" must be present`);
  }
});

// S5-e: non-scripts fields (name, version, dependencies) are preserved verbatim.
test('mergePackageJsonScripts: non-scripts fields are preserved verbatim (S5-e)', () => {
  const consumer = {
    name: 'my-app',
    version: '3.1.4',
    description: 'a consumer repo',
    dependencies: { lodash: '^4.0.0' },
    devDependencies: { typescript: '^5.0.0' },
    scripts: { build: 'tsc' },
  };
  const result = JSON.parse(mergePackageJsonScripts(consumer, S5_MANAGED));

  assert.equal(result.name, 'my-app', 'name must be preserved');
  assert.equal(result.version, '3.1.4', 'version must be preserved');
  assert.equal(result.description, 'a consumer repo', 'description must be preserved');
  assert.deepEqual(result.dependencies, { lodash: '^4.0.0' }, 'dependencies must be preserved');
  assert.deepEqual(result.devDependencies, { typescript: '^5.0.0' }, 'devDependencies must be preserved');
});

// Issue #180 lock-in guard: a pre-v0.8.0 vendored upgrader plain-copied
// package.json and clobbered the consumer's identity (name/version), which
// then tripped brain-upgrade.mjs's own self-guard and locked the consumer
// out of all future upgrades. Since v0.9.x package.json goes through this
// specialMerge function instead of a plain copy — this test locks in that
// consumer identity always survives a merge, regardless of what brain's own
// package.json fields are.
test('mergePackageJsonScripts: consumer identity survives a merge — clobber regression guard (issue #180)', () => {
  const consumer = { name: '@x/y', version: '1.2.3', scripts: {} };
  const result = JSON.parse(mergePackageJsonScripts(consumer, S5_MANAGED));

  assert.equal(result.name, '@x/y', 'consumer name must never be clobbered by a merge (issue #180)');
  assert.equal(result.version, '1.2.3', 'consumer version must never be clobbered by a merge (issue #180)');
  for (const [k, v] of Object.entries(S5_MANAGED)) {
    assert.equal(result.scripts[k], v, `managed key "${k}" must still be injected`);
  }
});

// S5-io: mergePackageJson IO wrapper — write-if-changed idempotency.
test('mergePackageJson: write-if-changed — second call is a mtime no-op (S5-io)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s5-io-'));
  try {
    // Build a minimal brain package.json with the managed scripts.
    const brainPkg = {
      name: 'brain',
      version: '0.8.0',
      scripts: {
        'brain:env:init': 'bash ./brain/scripts/bootstrap.sh',
        'brain:day:start': 'node ./brain/scripts/day-start.mjs',
        'brain:ticket:start': 'node ./brain/scripts/ticket-start.mjs',
        'brain:project:feature': 'node ./brain/scripts/new-change.mjs',
        'brain:project:status': 'node ./brain/scripts/project-status.mjs',
        'brain:tracker:board': 'node ./brain/scripts/tracker-board.mjs',
        'brain:repo:check': 'node ./brain/scripts/check-refs.mjs',
        'brain:change:verify': 'node ./brain/scripts/verify-change.mjs',
        // Non-managed script (must NOT be injected). Intentionally differs from
        // the consumer's own 'build' value ('tsc') so that any filter regression
        // that leaks this into the consumer would be caught by the assertion below.
        'build': 'webpack',
      },
    };
    const srcPath = join(tmp, 'brain-package.json');
    writeFileSync(srcPath, JSON.stringify(brainPkg, null, 2) + '\n');

    const destPath = join(tmp, 'consumer-package.json');
    writeFileSync(destPath, JSON.stringify({ name: 'consumer', scripts: { build: 'tsc' } }, null, 2) + '\n');

    // First call: merges and writes.
    mergePackageJson(destPath, srcPath);
    const afterFirst = readFileSync(destPath, 'utf8');
    const parsed = JSON.parse(afterFirst);
    assert.ok('brain:repo:check' in parsed.scripts, 'brain:repo:check must be injected');
    // Consumer's own build ('tsc') must be preserved; brain's build ('webpack') must NOT leak.
    assert.strictEqual(parsed.scripts.build, 'tsc',
      'consumer build must stay "tsc"; brain build ("webpack") must not leak');

    // Second call: content is identical — no write should happen. Verify by
    // capturing mtime before and after the no-op call.
    const { mtimeMs: mBefore } = statSync(destPath);
    mergePackageJson(destPath, srcPath);
    const { mtimeMs: mAfter } = statSync(destPath);
    assert.equal(mAfter, mBefore, 'mtime must not change on a no-op re-merge');

    // Non-managed brain script must NOT appear in consumer.
    const final = JSON.parse(readFileSync(destPath, 'utf8'));
    // Consumer's build ('tsc') must be intact; brain's differing build ('webpack') must not appear.
    assert.strictEqual(final.scripts.build, 'tsc',
      'non-managed "build" script from brain ("webpack") must not be injected into consumer');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── copyManaged: restore point / rollback (#396 — REQ-S6-*) ───────────────────
// The write loop is a sequence of independent writes, not an atomic commit, so a
// throw partway through used to leave the tree half old and half new. These pin
// the contract that any throw leaves it byte-identical to its pre-call state.
//
// Failures are injected two ways, both deterministic and neither depending on
// listFiles' directory order or on file permissions (CI may run as root):
//   - a specialMerge fn that writes and THEN throws — the real "merge failed
//     halfway" shape, and the exact mechanism behind #399's corrupt consumer JSON
//   - a dest path whose parent already exists as a FILE, so the copy phase's
//     mkdirSync throws EEXIST
// Cross-phase ordering (all merges, then all copies) is guaranteed by copyManaged
// itself, so a merge-phase write is always on disk before a copy-phase throw.

/** Builds a src/dest pair where the copy phase is guaranteed to throw. */
function seedFailingCopy(tmp) {
  const src = join(tmp, 'src');
  const dest = join(tmp, 'dest');
  mkdirSync(join(src, 'brain', 'core', 'sub'), { recursive: true });
  writeFileSync(join(src, 'brain', 'core', 'sub', 'copied.md'), 'NEW');
  mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
  // `sub` exists as a FILE, so mkdirSync(dirname(dest)) throws in the copy phase.
  writeFileSync(join(dest, 'brain', 'core', 'sub'), 'NOT A DIRECTORY');
  return { src, dest };
}

test('copyManaged: a copy-phase throw rolls back a write already made in the merge phase (REQ-S6-1)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-1-'));
  try {
    const { src, dest } = seedFailingCopy(tmp);
    writeFileSync(join(src, 'brain', 'core', 'merged.json'), '{"from":"src"}');
    writeFileSync(join(dest, 'brain', 'core', 'merged.json'), '{"from":"consumer"}');

    assert.throws(() => copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
      specialMerge: {
        'brain/core/merged.json': (destPath) => writeFileSync(destPath, '{"from":"MERGED"}'),
      },
    }));

    assert.equal(
      readFileSync(join(dest, 'brain', 'core', 'merged.json'), 'utf8'),
      '{"from":"consumer"}',
      'the merge-phase write must be rolled back when a later copy throws',
    );
    assert.ok(!existsSync(join(dest, RESTORE_POINT_DIR)),
      'the snapshot must be discarded even on the failure path');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: rollback DELETES files that did not exist before the call (REQ-S6-2)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-2-'));
  try {
    const { src, dest } = seedFailingCopy(tmp);
    writeFileSync(join(src, 'brain', 'core', 'fresh.json'), '{"from":"src"}');
    // dest deliberately has no fresh.json — rolling back must restore "absent".

    assert.throws(() => copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
      specialMerge: {
        'brain/core/fresh.json': (destPath) => writeFileSync(destPath, '{"from":"MERGED"}'),
      },
    }));

    assert.ok(!existsSync(join(dest, 'brain', 'core', 'fresh.json')),
      'a file the call created must be deleted on rollback, not left behind empty');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: a merge that writes and then throws has its own partial write rolled back (REQ-S6-3)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-3-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'half.json'), '{"from":"src"}');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'half.json'), 'ORIGINAL');

    assert.throws(() => copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
      specialMerge: {
        'brain/core/half.json': (destPath) => {
          writeFileSync(destPath, 'PARTIAL');       // a real, observable write…
          throw new Error('merge failed after writing');  // …then failure
        },
      },
    }));

    assert.equal(readFileSync(join(dest, 'brain', 'core', 'half.json'), 'utf8'), 'ORIGINAL',
      'a merge that half-wrote its target must be rolled back to the consumer bytes');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: the original error is re-thrown unchanged after rollback (REQ-S6-4)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-4-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'x.json'), '{}');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'x.json'), 'OLD');

    const boom = new Error('ENOSPC: no space left on device');
    let caught;
    try {
      copyManaged({
        srcRoot: src,
        destRoot: dest,
        managed: ['brain/core/**'],
        local: [],
        specialMerge: { 'brain/core/x.json': () => { throw boom; } },
      });
    } catch (err) { caught = err; }

    assert.equal(caught, boom,
      'rollback must not swallow, wrap or replace the failure that caused it');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: the restore point is discarded on the success path (REQ-S6-5)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-5-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'a.md'), 'NEW');

    const result = copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [] });

    assert.ok(result.copied.includes('brain/core/a.md'), 'the happy path must still copy');
    assert.ok(!existsSync(join(dest, RESTORE_POINT_DIR)),
      'a successful upgrade must leave no snapshot directory behind');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: the restore-point dir matches no real managed glob (REQ-S6-6)', () => {
  // Drift-guard: if a future managed glob ever swallowed the snapshot directory,
  // an upgrade would copy its own backup into the consumer tree.
  for (const candidate of [
    RESTORE_POINT_DIR,
    `${RESTORE_POINT_DIR}.lock`,
    `${RESTORE_POINT_DIR}.preserved-1`,
    `${RESTORE_POINT_DIR}.preserved-1/package.json`,
    `${RESTORE_POINT_DIR}/journal.json`,
    `${RESTORE_POINT_DIR}/package.json`,
    `${RESTORE_POINT_DIR}/brain/core/managed-paths.mjs`,
    `${RESTORE_POINT_DIR}/.github/workflows/governance.yml`,
  ]) {
    assert.ok(!matchesAny(candidate, realManagedGlobs),
      `${candidate} must not match any managed glob`);
  }
});

test('copyManaged: rollback prunes directories the write had to create (REQ-S6-7)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-7-'));
  try {
    const { src, dest } = seedFailingCopy(tmp);
    mkdirSync(join(src, 'brain', 'core', 'newdir'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'newdir', 'a.json'), '{"from":"src"}');
    // dest has no `newdir` — the merge phase must create it, rollback must remove it.

    assert.throws(() => copyManaged({
      srcRoot: src,
      destRoot: dest,
      managed: ['brain/core/**'],
      local: [],
      specialMerge: {
        'brain/core/newdir/a.json': (destPath) => writeFileSync(destPath, '{"from":"MERGED"}'),
      },
    }));

    assert.ok(!existsSync(join(dest, 'brain', 'core', 'newdir')),
      'rollback must leave no empty scaffolding from directories it created');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// The dominant shape: 364 of the 366 real managed files are plain copies, only 2
// are merges. Write order is sorted (see copyManaged), so `a-first` is copied
// before `z-sub/boom` deterministically — without that sort this test would
// depend on readdirSync's order and could pass vacuously.
test('copyManaged: a copy-phase throw rolls back an EARLIER copy in the same phase (REQ-S6-10)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-10-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core', 'z-sub'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'a-first.md'), 'NEW');
    writeFileSync(join(src, 'brain', 'core', 'z-sub', 'boom.md'), 'NEW');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'a-first.md'), 'OLD');
    writeFileSync(join(dest, 'brain', 'core', 'z-sub'), 'NOT A DIRECTORY');

    assert.throws(() => copyManaged({
      srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [],
    }));

    assert.equal(readFileSync(join(dest, 'brain', 'core', 'a-first.md'), 'utf8'), 'OLD',
      'a plain copy that already succeeded must be rolled back when a later copy throws');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: an incomplete rollback KEEPS the snapshot (REQ-S6-11)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-11-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'x.md'), 'NEW');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'x.md'), 'PRECIOUS');

    let caught;
    try {
      copyManaged({
        srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [],
        specialMerge: {
          'brain/core/x.md': (destPath) => {
            // Make the path unrestorable: a directory now stands where the file was,
            // so restore()'s copyFileSync will throw EISDIR.
            rmSync(destPath);
            mkdirSync(destPath);
            throw new Error('merge exploded');
          },
        },
      });
    } catch (err) { caught = err; }

    assert.ok(caught?.rollbackIncomplete?.includes('brain/core/x.md'),
      'the unrestorable path must be reported on the error');
    assert.ok(caught.rollbackSnapshotDir,
      'the caller must be told where the surviving snapshot is');
    assert.equal(
      readFileSync(join(caught.rollbackSnapshotDir, 'brain', 'core', 'x.md'), 'utf8'),
      'PRECIOUS',
      'the snapshot is the only surviving copy of those bytes — it must NOT be discarded',
    );

    // The trap this closes: the operator is told to restore from that directory, and
    // their most natural next action is to re-run the upgrade. Slice 1 protected the
    // snapshot by MOVING it out of the path a retry cleared. Slice 2 protects it
    // better — the journal makes that retry REFUSE instead of clearing — so the
    // snapshot now stays put and the refusal gate stays armed over the dirty tree.
    rmSync(join(dest, 'brain', 'core', 'x.md'), { recursive: true, force: true });
    writeFileSync(join(dest, 'brain', 'core', 'x.md'), 'whatever');

    assert.throws(
      () => copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [] }),
      (err) => err.interruptedRun === true,
      'a retry must REFUSE over a dirty tree, not write through it',
    );
    assert.equal(
      readFileSync(join(caught.rollbackSnapshotDir, 'brain', 'core', 'x.md'), 'utf8'),
      'PRECIOUS',
      'and the retry must not have destroyed the snapshot it just refused over',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: a non-Error throw still carries the rollback state (REQ-S6-12)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-12-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'x.md'), 'NEW');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'x.md'), 'PRECIOUS');

    let caught;
    try {
      copyManaged({
        srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [],
        specialMerge: {
          'brain/core/x.md': (destPath) => {
            rmSync(destPath);
            mkdirSync(destPath);
            throw 'a bare string, not an Error';  // modules are strict mode
          },
        },
      });
    } catch (err) { caught = err; }

    // The naive `err.rollbackIncomplete = failed` threw a TypeError here, which
    // replaced the real failure AND dropped the dirty-tree signal — so the CLI
    // reported a clean rollback over a dirty tree.
    assert.ok(caught?.rollbackIncomplete?.length,
      'the dirty-tree signal must survive a non-object throw');
    assert.equal(caught.cause, 'a bare string, not an Error',
      'the original thrown value must be preserved as the cause');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: a symlinked managed path is refused before any write (REQ-S6-13)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-13-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'linked.md'), 'NEW');
    writeFileSync(join(src, 'brain', 'core', 'plain.md'), 'NEW');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'plain.md'), 'OLD');
    // Dangling on purpose: existsSync() reports it absent, which is exactly how a
    // rollback came to DELETE a path that existed before the call.
    symlinkSync(join(tmp, 'target-outside-the-repo.md'), join(dest, 'brain', 'core', 'linked.md'));

    assert.throws(
      () => copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [] }),
      /symlink/i,
      'a symlinked managed path must be refused, naming the path',
    );

    assert.ok(lstatSync(join(dest, 'brain', 'core', 'linked.md')).isSymbolicLink(),
      'the symlink itself must survive the refusal');
    assert.ok(!existsSync(join(tmp, 'target-outside-the-repo.md')),
      'no write may escape destRoot through the link');
    assert.equal(readFileSync(join(dest, 'brain', 'core', 'plain.md'), 'utf8'), 'OLD',
      'the refusal must happen before ANY managed path is written');
    assert.ok(!existsSync(join(dest, RESTORE_POINT_DIR)),
      'a refusal must leave no partial snapshot behind');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// A symlink is not the boundary — escaping destRoot is. Measured: a link resolving
// INSIDE the repo round-trips cleanly, because copyFileSync follows it on the
// snapshot, on the write and on the restore. Refusing those would soft-lock any
// consumer using `AGENTS.md -> CLAUDE.md`, the canonical agent-interop symlink, and
// AGENTS.md is a managed path.
test('copyManaged: a VALID symlink resolving inside the repo is allowed and rolls back (REQ-S6-15)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-15-'));
  try {
    const { src, dest } = seedFailingCopy(tmp);
    writeFileSync(join(src, 'brain', 'core', 'linked.md'), 'NEW');
    const target = join(dest, 'REAL-TARGET.md');
    writeFileSync(target, 'CONSUMER ORIGINAL');
    symlinkSync(target, join(dest, 'brain', 'core', 'linked.md'));

    assert.throws(() => copyManaged({
      srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [],
    }), (err) => !/cannot protect this upgrade/.test(err.message),
    'a link inside the repo must NOT be refused — it must be protected like any other path');

    assert.equal(readFileSync(target, 'utf8'), 'CONSUMER ORIGINAL',
      'the link target must be rolled back to its original bytes');
    assert.ok(lstatSync(join(dest, 'brain', 'core', 'linked.md')).isSymbolicLink(),
      'the link itself must never be replaced by a regular file');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: a symlinked ANCESTOR directory that escapes the repo is refused (REQ-S6-16)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-16-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    const outside = join(tmp, 'OUTSIDE');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'y.md'), 'NEW');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'y.md'), 'OUTSIDE ORIGINAL');
    mkdirSync(join(dest, 'brain'), { recursive: true });
    // The ANCESTOR is the link — lstat on the leaf would never see this.
    symlinkSync(outside, join(dest, 'brain', 'core'));

    assert.throws(
      () => copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [] }),
      /resolve outside the repository/,
      'a write reaching outside destRoot cannot be rolled back and must be refused',
    );
    assert.equal(readFileSync(join(outside, 'y.md'), 'utf8'), 'OUTSIDE ORIGINAL',
      'nothing may be written through the escaping link');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: a failure to clean up the snapshot never reports a good upgrade as failed (REQ-S6-17)', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root ignores mode bits, so cleanup cannot be made to fail here');
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-17-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'x.md'), 'NEW');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'x.md'), 'OLD');

    const result = copyManaged({
      srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [],
      specialMerge: {
        'brain/core/x.md': (destPath, srcPath) => {
          copyFileSync(srcPath, destPath);                       // the write SUCCEEDS
          chmodSync(join(dest, RESTORE_POINT_DIR, 'brain'), 0o500); // now block cleanup
        },
      },
    });

    assert.ok(result.merged.includes('brain/core/x.md'), 'the upgrade itself must be reported as done');
    assert.equal(readFileSync(join(dest, 'brain', 'core', 'x.md'), 'utf8'), 'NEW',
      'the write really did land — a cleanup error must not be dressed up as a failed upgrade');
    chmodSync(join(dest, RESTORE_POINT_DIR, 'brain'), 0o700);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: dryRun and abortOnCollision take no snapshot at all (REQ-S6-14)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-14-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'x.md'), 'NEW');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'x.md'), 'OLD');

    copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [], dryRun: true });
    assert.ok(!existsSync(join(dest, RESTORE_POINT_DIR)), 'a dry run must not snapshot');

    copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [], abortOnCollision: true });
    assert.ok(!existsSync(join(dest, RESTORE_POINT_DIR)), 'an aborted run writes nothing, so it must not snapshot');
    assert.equal(readFileSync(join(dest, 'brain', 'core', 'x.md'), 'utf8'), 'OLD');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── beforeAnyWrite: the flag the CLI's rollback claim rests on (#447) ────────
//
// brain-upgrade.mjs branches on `err.beforeAnyWrite`: without it, it prints
// "Upgrade failed while writing managed paths" AND then "Every managed path was
// rolled back to the bytes it had before the copy."
//
// That second sentence is a statement of fact about the consumer's tree. It must
// never be printed for a failure that happened before a restore point existed —
// there was nothing to roll back, and an operator who reads it will not go look.
//
// The flag used to be set at exactly ONE site (the catch around
// createRestorePoint), while the whole read-only pre-flight pass of copyManaged
// sits outside it. Every throw from there fell through to the catch-all.

test('copyManaged: a throw from the READ-ONLY pre-flight is tagged beforeAnyWrite (#447)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-447-preflight-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'x.md'), 'NEW');

    // The consumer has a DIRECTORY where a managed file belongs. The collision
    // probe's unguarded `readFileSync(destFile)` throws EISDIR — a real, live
    // path, not a synthetic one.
    mkdirSync(join(dest, 'brain', 'core', 'x.md'), { recursive: true });

    assert.throws(
      () => copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [] }),
      (err) => {
        assert.equal(
          err.beforeAnyWrite,
          true,
          'a pre-flight throw must be tagged, or the CLI claims a rollback that never happened',
        );
        return true;
      },
    );

    // And the claim the tag protects: nothing was written, nothing to restore.
    assert.ok(!existsSync(join(dest, RESTORE_POINT_DIR)), 'the pre-flight must not have snapshotted');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copyManaged: a throw from the WRITE loop is NOT tagged beforeAnyWrite (#447)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-447-writeloop-'));
  try {
    const src = join(tmp, 'src');
    const dest = join(tmp, 'dest');
    mkdirSync(join(src, 'brain', 'core', 'sub'), { recursive: true });
    writeFileSync(join(src, 'brain', 'core', 'a.md'), 'NEW');
    writeFileSync(join(src, 'brain', 'core', 'sub', 'b.md'), 'NEW');
    mkdirSync(join(dest, 'brain', 'core'), { recursive: true });
    writeFileSync(join(dest, 'brain', 'core', 'a.md'), 'OLD');
    // A FILE where the write loop needs a directory: mkdirSync throws ENOTDIR
    // mid-loop, after `a.md` has already been written. The restore point exists,
    // so the rollback claim is meaningful here — and must stay untagged.
    writeFileSync(join(dest, 'brain', 'core', 'sub'), 'not a directory');

    assert.throws(
      () => copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/core/**'], local: [] }),
      (err) => {
        assert.notEqual(
          err.beforeAnyWrite,
          true,
          'a write-loop failure DID reach the restore point — tagging it would suppress a true rollback report',
        );
        return true;
      },
    );

    assert.equal(readFileSync(join(dest, 'brain', 'core', 'a.md'), 'utf8'), 'OLD', 'the rollback must have happened');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRestorePoint: an unrestorable path is reported, and does not strand the rest (REQ-S6-9)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-9-'));
  try {
    mkdirSync(join(tmp, 'brain', 'core'), { recursive: true });
    writeFileSync(join(tmp, 'brain', 'core', 'blocked.md'), 'ORIGINAL');
    writeFileSync(join(tmp, 'brain', 'core', 'ok.md'), 'ORIGINAL');

    const rp = createRestorePoint({
      destRoot: tmp,
      relPaths: ['brain/core/blocked.md', 'brain/core/ok.md'],
    });

    // Both get clobbered, then one becomes impossible to restore: a directory
    // now stands where the file was, so copyFileSync will throw EISDIR.
    writeFileSync(join(tmp, 'brain', 'core', 'ok.md'), 'CLOBBERED');
    rmSync(join(tmp, 'brain', 'core', 'blocked.md'));
    mkdirSync(join(tmp, 'brain', 'core', 'blocked.md'));

    const { failed } = rp.restore();

    assert.deepEqual(failed, ['brain/core/blocked.md'],
      'the unrestorable path must be reported, so a dirty tree is never called clean');
    assert.equal(readFileSync(join(tmp, 'brain', 'core', 'ok.md'), 'utf8'), 'ORIGINAL',
      'one unrestorable path must not abort the rollback of the others');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('createRestorePoint: a stale snapshot from an earlier crash is not reused (REQ-S6-8)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-s6-8-'));
  try {
    mkdirSync(join(tmp, 'brain', 'core'), { recursive: true });
    writeFileSync(join(tmp, 'brain', 'core', 'a.md'), 'CURRENT');
    // A snapshot left behind by a hard kill, carrying stale bytes.
    mkdirSync(join(tmp, RESTORE_POINT_DIR, 'brain', 'core'), { recursive: true });
    writeFileSync(join(tmp, RESTORE_POINT_DIR, 'brain', 'core', 'a.md'), 'STALE');

    const rp = createRestorePoint({ destRoot: tmp, relPaths: ['brain/core/a.md'] });
    writeFileSync(join(tmp, 'brain', 'core', 'a.md'), 'OVERWRITTEN');
    rp.restore();

    assert.equal(readFileSync(join(tmp, 'brain', 'core', 'a.md'), 'utf8'), 'CURRENT',
      'restore must use bytes captured this run, never a stale snapshot on disk');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
