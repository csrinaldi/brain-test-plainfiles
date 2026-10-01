// stage-config.test.mjs — issue #312, Unit 1 (D3). `resolveStageConfigs`
// resolves `sdd.configs` against the SAME resolved stage set `resolveStageSet`
// produces — never a fixed list of its own — and enforces the three refusals
// D3 names: an entry for a stage outside the resolved set, an unknown field
// inside an entry, and `enabled` written as anything but a strict boolean.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveStageConfigs } from './stage-config.mjs';

const withCustomStage = {
  sdd: {
    stages: {
      proposal: {}, spec: {}, design: {}, tasks: {},
      'cold-review': { artefact: 'cold-review.md' },
    },
  },
};

// ── Zero-config identity ─────────────────────────────────────────────────────

test('#312 D3: absent sdd.configs, {}, and an absent sdd key all resolve identically', () => {
  const noKey = resolveStageConfigs(undefined);
  const emptySdd = resolveStageConfigs({ sdd: {} });
  const emptyConfigs = resolveStageConfigs({ sdd: { configs: {} } });

  assert.deepEqual(noKey, emptySdd);
  assert.deepEqual(emptySdd, emptyConfigs);
  // Every one of the four lifecycle stages is present, enabled by default,
  // and carries no configured agent — "absent" is identity, not a fourth shape.
  for (const stage of ['proposal', 'spec', 'design', 'tasks']) {
    assert.equal(noKey[stage].enabled, true, `${stage} must default to enabled`);
    assert.equal(noKey[stage].agent, undefined, `${stage} must default to no configured agent`);
  }
});

test('#312 D3: a custom resolved stage (sdd.stages) is covered the same way as a lifecycle stage', () => {
  const resolved = resolveStageConfigs(withCustomStage);
  assert.ok(Object.hasOwn(resolved, 'cold-review'), 'a custom resolved stage must appear in the output');
  assert.equal(resolved['cold-review'].enabled, true);
});

// ── Refusal 1: an entry for a stage NOT in the resolved set ─────────────────

test('#312 D3: an sdd.configs entry for an unresolved stage is refused, naming the stage and the resolved set', () => {
  assert.throws(
    () => resolveStageConfigs({ sdd: { configs: { bogus: { enabled: false } } } }),
    (err) => {
      assert.match(err.message, /"bogus"/, 'the offending stage name must be named');
      assert.match(err.message, /proposal.*spec.*design.*tasks/s, 'the resolved set must be listed');
      return true;
    },
  );
});

// ── Refusal 2: an unknown field inside an entry ─────────────────────────────

test('#312 D3: an unknown field inside a resolved stage entry is refused, naming the field', () => {
  assert.throws(
    () => resolveStageConfigs({ sdd: { configs: { proposal: { model: 'sonnet' } } } }),
    (err) => {
      assert.match(err.message, /"model"/, 'the unknown field must be named');
      assert.match(err.message, /agent.*enabled|enabled.*agent/, 'the known field set must be listed');
      return true;
    },
  );
});

// ── Refusal 3: `enabled` not a strict boolean ───────────────────────────────

test('#312 D3: `enabled` written as the string "false" is refused, not silently truthy', () => {
  // The whole reason this is strict: "false" is truthy in JS, and an operator
  // who typed it meaning "off" must not get a stage that keeps running.
  assert.throws(
    () => resolveStageConfigs({ sdd: { configs: { proposal: { enabled: 'false' } } } }),
    (err) => {
      assert.match(err.message, /enabled/);
      assert.match(err.message, /string/);
      return true;
    },
  );
});

test('#312 D3: `enabled` written as a number or null is refused', () => {
  for (const bad of [0, 1, null]) {
    assert.throws(
      () => resolveStageConfigs({ sdd: { configs: { proposal: { enabled: bad } } } }),
      /enabled/,
      `enabled: ${JSON.stringify(bad)} must be refused`,
    );
  }
});

// ── Explicit disable via sdd.configs ────────────────────────────────────────

test('#312 D3 / spec "Explicit disable via sdd.configs": enabled:false resolves to declared-disabled', () => {
  const resolved = resolveStageConfigs({ sdd: { configs: { proposal: { enabled: false } } } });
  assert.equal(resolved.proposal.enabled, false);
});

test('#312 D3: a declared agent rides through unchanged; an undeclared one is absent, never invented', () => {
  const resolved = resolveStageConfigs({ sdd: { configs: { proposal: { agent: 'cold-reviewer' } } } });
  assert.equal(resolved.proposal.agent, 'cold-reviewer');
  assert.equal(resolved.spec.agent, undefined, 'a stage with no sdd.configs entry declares no agent');
});
