// session-start-config.test.mjs — config wiring tests for brain:session:start
// (issue #138, PR3; prefixed in #154). Validates the two static config artifacts
// task 3.5/3.7 require: package.json's canonical `brain:session:start` script
// (plus the `session:start` deprecated alias), and `.claude/settings.json`'s
// merged `SessionStart` hook beside the pre-existing `PreToolUse` hook
// (design §1.6). Strict TDD, node:test, zero deps — no dynamic execution of
// `npm run brain:session:start` here (that's the manual smoke test, task 3.6);
// this file only asserts the static JSON shape is correct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The bare `session:start` alias is NOT in MANAGED_SCRIPT_KEYS, so it is not
// injected into a consumer's package.json (only the canonical `brain:session:start`
// is). Guard that one assertion to the brain source repo (via the .brain-source
// marker); the canonical-script and .claude/settings.json tests below stay active
// in consumers because those artifacts ARE vendored.
const aliasSkip = existsSync(join(ROOT, '.brain-source'))
  ? false
  : 'deprecated session:start alias is not injected into consumers';

// ---------------------------------------------------------------------------
// package.json — "brain:session:start" canonical script + "session:start" alias
// (REQ-1, task 3.5; canonical verb prefixed in #154)
// ---------------------------------------------------------------------------

test('package.json: has a brain:session:start script invoking session-start.mjs', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts?.['brain:session:start'], 'node ./brain/scripts/session-start.mjs');
});

test('package.json: session:start deprecated alias still points to session-start.mjs (dual-alias, shipped in v0.8.0)', { skip: aliasSkip }, () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts?.['session:start'], 'node ./brain/scripts/session-start.mjs');
});

// ---------------------------------------------------------------------------
// .claude/settings.json — merged SessionStart hook (design §1.6, task 3.7/3.8)
// ---------------------------------------------------------------------------

test('.claude/settings.json: is valid JSON', () => {
  const raw = readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
});

// NOTE: this test deliberately does NOT assert the PreToolUse command's exact
// flag content as a source literal — doing so would trip check-refs.mjs's
// `no-verify-bypass` governance rule (the same string the hook itself guards
// against), which would otherwise force an exemption edit to
// brain/project/check-refs-rules.mjs (a brain/-owned file — out of bounds for
// an agent per agent-authorities Tier 2). The guard's actual *behavior* is
// already covered by check-refs.test.mjs and installer.test.mjs; this test
// only proves the SessionStart merge left PreToolUse structurally intact
// (still present, still a non-empty command hook) — config-shape coverage,
// not a re-test of the governance rule itself.
test('.claude/settings.json: PreToolUse hook survives the SessionStart merge (structural, no governance-rule literal)', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const preToolUse = settings.hooks?.PreToolUse;
  assert.ok(Array.isArray(preToolUse) && preToolUse.length > 0, 'PreToolUse hook array must be present');
  const matcher = preToolUse[0];
  assert.equal(matcher.matcher, 'Bash');
  assert.equal(matcher.hooks?.[0]?.type, 'command');
  assert.equal(typeof matcher.hooks[0].command, 'string');
  assert.ok(matcher.hooks[0].command.length > 0, 'PreToolUse command must be a non-empty string');
});

test('.claude/settings.json: SessionStart hook is present, merged beside PreToolUse', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const sessionStart = settings.hooks?.SessionStart;
  assert.ok(Array.isArray(sessionStart) && sessionStart.length > 0, 'SessionStart hook array must be present');
  assert.deepEqual(sessionStart, [
    {
      hooks: [
        { type: 'command', command: 'npm run brain:session:start' },
      ],
    },
  ]);
});

test('.claude/settings.json: SessionStart hook command is exactly "npm run brain:session:start" — zero logic in the JSON (ADR-0002)', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
  const command = settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command;
  assert.equal(command, 'npm run brain:session:start');
});
