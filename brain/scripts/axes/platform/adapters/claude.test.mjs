// scripts/axes/platform/adapters/claude.test.mjs — unit tests for claude platform backend (issue #305).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CLAUDE_SETTINGS_EMIT_PATH, init, runStage } from './claude.mjs';
import { compileSettingsHooksJson } from '../lib/settings-hooks.mjs';
import { mergeClaudeSettings } from '../../../lib/installer.mjs';

test('CLAUDE_SETTINGS_EMIT_PATH === ".claude/settings.json"', () => {
  assert.equal(CLAUDE_SETTINGS_EMIT_PATH, '.claude/settings.json');
});

test('compileSettingsHooksJson() emits valid JSON with SessionStart and PreToolUse hooks', () => {
  const jsonStr = compileSettingsHooksJson();
  const parsed = JSON.parse(jsonStr);

  assert.ok(parsed.hooks);
  assert.ok(Array.isArray(parsed.hooks.PreToolUse));
  assert.ok(Array.isArray(parsed.hooks.SessionStart));

  const sessionStartHook = parsed.hooks.SessionStart[0].hooks[0].command;
  assert.equal(sessionStartHook, 'npm run brain:session:start');

  const preToolUseHook = parsed.hooks.PreToolUse[0].hooks[0].command;
  assert.match(preToolUseHook, /--no-verify/);
});

test('init() calls _writeClaudeSettings with CLAUDE_SETTINGS_EMIT_PATH and valid JSON', async () => {
  const writeCalls = [];
  const _writeClaudeSettings = (relPath, content) => writeCalls.push({ relPath, content });

  await init({ _writeClaudeSettings, _repoRoot: '/fake/repo' });

  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].relPath, CLAUDE_SETTINGS_EMIT_PATH);
  assert.equal(writeCalls[0].content, compileSettingsHooksJson());
});

// ── issue #1139: init() must merge, not overwrite ────────────────────────────

test('init(): an existing settings.json with permissions.allow and a custom hook survives, brain hooks are current (REQ-1139-1)', async () => {
  const customEntry = { matcher: 'Read', hooks: [{ type: 'command', command: 'my-custom-hook' }] };
  const existing = {
    permissions: { allow: ['Bash(a:*)', 'Bash(b:*)'] },
    hooks: { PreToolUse: [customEntry] },
  };
  const _readClaudeSettings = () => JSON.stringify(existing);
  const writeCalls = [];
  const _writeClaudeSettings = (relPath, content) => writeCalls.push({ relPath, content });

  await init({ _readClaudeSettings, _writeClaudeSettings, _repoRoot: '/fake/repo' });

  assert.equal(writeCalls.length, 1);
  const written = JSON.parse(writeCalls[0].content);
  assert.deepEqual(written.permissions.allow, ['Bash(a:*)', 'Bash(b:*)']);
  const preToolUse = written.hooks.PreToolUse;
  assert.ok(preToolUse.some((e) => JSON.stringify(e) === JSON.stringify(customEntry)),
    'consumer custom hook must survive');
  const brainPreToolUse = JSON.parse(compileSettingsHooksJson()).hooks.PreToolUse;
  for (const brainEntry of brainPreToolUse) {
    assert.ok(preToolUse.some((e) => JSON.stringify(e) === JSON.stringify(brainEntry)),
      'brain hook entry must be present and current');
  }
});

test('init(): running twice against the same existing content is idempotent — byte-identical output, no duplicate hooks (REQ-1139-2)', async () => {
  const existing = { permissions: { allow: ['x'] }, hooks: { PreToolUse: [] } };

  const firstWrites = [];
  await init({
    _readClaudeSettings: () => JSON.stringify(existing),
    _writeClaudeSettings: (relPath, content) => firstWrites.push({ relPath, content }),
    _repoRoot: '/fake/repo',
  });
  const firstContent = firstWrites[0].content;

  const secondWrites = [];
  await init({
    _readClaudeSettings: () => firstContent,
    _writeClaudeSettings: (relPath, content) => secondWrites.push({ relPath, content }),
    _repoRoot: '/fake/repo',
  });

  assert.equal(secondWrites[0].content, firstContent, 'second init() must produce byte-identical output');
});

test('init(): no existing settings.json writes brain settings exactly as before (REQ-1139-3)', async () => {
  const writeCalls = [];
  const _readClaudeSettings = () => null;
  const _writeClaudeSettings = (relPath, content) => writeCalls.push({ relPath, content });

  await init({ _readClaudeSettings, _writeClaudeSettings, _repoRoot: '/fake/repo' });

  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].content, compileSettingsHooksJson());
});

test('init(): a malformed existing settings.json is never overwritten and the failure is reported (REQ-1139-4)', async () => {
  const _readClaudeSettings = () => '{ not valid json';
  const writeCalls = [];
  const _writeClaudeSettings = (relPath, content) => writeCalls.push({ relPath, content });

  const result = await init({ _readClaudeSettings, _writeClaudeSettings, _repoRoot: '/fake/repo' });

  assert.equal(writeCalls.length, 0, 'the write seam must never be invoked on a malformed file');
  assert.equal(result.ok, false);
  assert.match(result.reason, /\.claude\/settings\.json/, 'must name the offending file');
});

test('upgrade -> init -> upgrade: the file is stable and the consumer key survives throughout (REQ-1139-8)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-1139-compose-'));
  try {
    const brainPath = join(tmp, 'brain-settings.json');
    writeFileSync(brainPath, compileSettingsHooksJson());

    const consumerPath = join(tmp, 'settings.json');
    writeFileSync(consumerPath, JSON.stringify({ permissions: { allow: ['MyCustomTool(*)'] } }, null, 2) + '\n');

    // Step 1: brain:upgrade's own merge.
    mergeClaudeSettings(consumerPath, brainPath);
    const afterUpgrade1 = JSON.parse(readFileSync(consumerPath, 'utf8'));
    assert.deepEqual(afterUpgrade1.permissions.allow, ['MyCustomTool(*)']);

    // Step 2: brain:env:init's merge, through the injected seams pointed at
    // the same file.
    await init({
      _readClaudeSettings: () => readFileSync(consumerPath, 'utf8'),
      _writeClaudeSettings: (relPath, content) => writeFileSync(consumerPath, content),
      _repoRoot: tmp,
    });
    const afterInit = JSON.parse(readFileSync(consumerPath, 'utf8'));
    assert.deepEqual(afterInit.permissions.allow, ['MyCustomTool(*)'], 'consumer key must survive init()');

    // Step 3: brain:upgrade again — must be a stable no-op on the hook set.
    mergeClaudeSettings(consumerPath, brainPath);
    const afterUpgrade2 = JSON.parse(readFileSync(consumerPath, 'utf8'));
    assert.deepEqual(afterUpgrade2.permissions.allow, ['MyCustomTool(*)'], 'consumer key must survive the second upgrade');
    assert.deepEqual(afterUpgrade2.hooks, afterInit.hooks, 'the hook set must be stable after the second upgrade');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── agent runtime descriptor (issue #123) ────────────────────────────────────

test('AGENT_RUNTIME declares a probeable claude runtime with an update hint', async () => {
  const { AGENT_RUNTIME } = await import('./claude.mjs');

  assert.equal(AGENT_RUNTIME.bin, 'claude');
  assert.ok(Array.isArray(AGENT_RUNTIME.versionArgs));
  assert.ok(AGENT_RUNTIME.versionArgs.length > 0);
  assert.equal(AGENT_RUNTIME.latest.cmd, 'npm');
  assert.ok(AGENT_RUNTIME.latest.args.includes('@anthropic-ai/claude-code'));
  assert.match(AGENT_RUNTIME.updateHint, /@anthropic-ai\/claude-code/);
});

test('AGENT_RUNTIME probes cleanly through the generic prober', async () => {
  const { AGENT_RUNTIME } = await import('./claude.mjs');
  const { probeAgentRuntime } = await import('../../lib/agent-runtime.mjs');

  const calls = [];
  const _run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return { status: 0, stdout: '1.0.0\n', stderr: '' };
  };

  assert.equal(probeAgentRuntime(AGENT_RUNTIME, { _run }).state, 'up-to-date');
  // The descriptor's own update hint is never executed by the probe.
  assert.ok(!calls.some(c => c === AGENT_RUNTIME.updateHint || /install|update/.test(c.split(' ').slice(0, 2).join(' '))));
});


// ── #775 — the forge config shadow rides through, and only after the scrub ──

test('runStage: forgeConfigDir points every forge CLI at the per-run directory', async () => {
  let seen = null;
  await runStage({
    stage: 'cold-review', prompt: 'p', cwd: '/tmp',
    forgeConfigDir: '/tmp/run-1',
    _env: { PATH: '/usr/bin' },
    _run: (_bin, _args, opts) => { seen = opts.env; return { status: 0, stdout: '' }; },
  });
  assert.equal(seen.GH_CONFIG_DIR, '/tmp/run-1');
  assert.equal(seen.GLAB_CONFIG_DIR, '/tmp/run-1');
  assert.equal(seen.PATH, '/usr/bin');
});

test('runStage: the shadow does NOT re-admit a scrubbed credential', async () => {
  // The shadow is applied to the ALREADY-SCRUBBED env. If it were applied to
  // `_env` and then merged, a credential the scrub removed would come back —
  // which is the one thing this parameter must never be able to do. That is
  // also why it takes a PATH and not an env bag.
  let seen = null;
  await runStage({
    stage: 'cold-review', prompt: 'p', cwd: '/tmp',
    forgeConfigDir: '/tmp/run-1',
    _env: { PATH: '/usr/bin', GH_TOKEN: 'SECRET', BRAIN_REVIEWER_TOKEN: 'SECRET' },
    _run: (_bin, _args, opts) => { seen = opts.env; return { status: 0, stdout: '' }; },
  });
  assert.equal(seen.GH_TOKEN, undefined);
  assert.equal(seen.BRAIN_REVIEWER_TOKEN, undefined);
  assert.equal(seen.GH_CONFIG_DIR, '/tmp/run-1');
});

test('runStage: without forgeConfigDir the env is exactly the scrubbed one', async () => {
  // No default. A backend that invented a directory would shadow the operator's
  // forge CLI on every stage brain ever routes, which is not this ticket's to
  // decide for stages that do not spawn a cold-review producer.
  let seen = null;
  await runStage({
    stage: 'cold-review', prompt: 'p', cwd: '/tmp',
    _env: { PATH: '/usr/bin', GH_CONFIG_DIR: '/home/x/.config/gh' },
    _run: (_bin, _args, opts) => { seen = opts.env; return { status: 0, stdout: '' }; },
  });
  assert.equal(seen.GH_CONFIG_DIR, '/home/x/.config/gh');
});

// ── #1010 — the producer must never mutate what it is asked to review ───────

test('runStage: every run carries --settings {disableAllHooks: true} — this repo\'s committed .claude/settings.json SessionStart hook must never run for the engine reviewing its own candidate (#1010)', async () => {
  let seenArgs = null;
  await runStage({
    stage: 'cold-review', prompt: 'p', cwd: '/tmp',
    _env: { PATH: '/usr/bin' },
    _run: (_bin, args) => { seenArgs = args; return { status: 0, stdout: '' }; },
  });

  const flagIndex = seenArgs.indexOf('--settings');
  assert.notEqual(flagIndex, -1, 'the spawned claude CLI must be given --settings');
  assert.deepEqual(
    JSON.parse(seenArgs[flagIndex + 1]),
    { disableAllHooks: true },
    'the settings payload must disable every hook, including SessionStart',
  );
});
