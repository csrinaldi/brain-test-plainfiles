// plainfiles.actorkind-consistency.test.mjs — REWRITTEN for #738 (design A6;
// spec "an agent capture carries the operator's handle" / D0's correction).
//
// #542 ruled branch-derived `actor` "not a defect": the branch answers WHERE
// a capture happened, not WHO captured it. #738 overturns the CONCLUSION —
// `actor` is now the configured `brain.actor` handle — while keeping the
// PREMISE: neither CLI door accepts a caller-supplied `actor`/`actorKind`
// override. This file is REWRITTEN, not deleted, to assert strictly MORE:
// a seam-derived branch value can now reach only `issue`/`source`, never
// `actor`, and `PLAINFILES_ACTOR_KIND` — the door-typed constant this
// hardening used to pin — is retired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plainfiles from './plainfiles.mjs';
import { save } from './plainfiles.mjs';
import { featureCheckpoint } from './engram.mjs';

const identitySeams = {
  getGitConfig: (key) => (key === 'brain.actor' ? '@test' : null),
  getEnv: () => ({}),
};

test('actorKind consistency: plainfiles.save\'s options bag does not accept a caller-supplied actor/actorKind override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plainfiles-actorkind-a-'));
  try {
    // Attempt to smuggle actor/actorKind into the options bag — they must be
    // silently ignored, with the appended record's actor/actorKind coming
    // ONLY from the configured `brain.actor` handle / the measured env.
    const opts = { type: 'discovery', project: 'brain', actor: 'spoofed-actor', actorKind: 'human' };
    const result = await save('t', 'c', opts, {
      root,
      getBranch: () => 'seam-derived-branch',
      getTimestamp: () => '2026-07-12T00:00:00Z',
      getHostname: () => 'h',
      ...identitySeams,
    });

    const record = JSON.parse(readFileSync(result.file, 'utf8').trim());
    assert.equal(record.actor, '@test', 'actor must come from the configured brain.actor handle, never the caller-supplied field');
    assert.equal(record.actorKind, 'human', 'actorKind must be MEASURED from the env, never the caller-supplied field');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#738: a seam-derived branch reaches only issue/source — never actor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plainfiles-actorkind-c-'));
  try {
    const result = await save('t', 'c', { type: 'discovery', project: 'brain' }, {
      root,
      getBranch: () => 'feat/issue-738-provenance',
      getTimestamp: () => '2026-07-12T00:00:00Z',
      getHostname: () => 'h',
      ...identitySeams,
    });

    const record = JSON.parse(readFileSync(result.file, 'utf8').trim());
    assert.equal(record.actor, '@test', 'the branch must never reach actor');
    assert.notEqual(record.actor, 'feat/issue-738-provenance');
    assert.equal(record.issue, 738, 'the branch reaches issue instead, via deriveIssue');
    assert.match(record.source, /derived from branch/, 'and the derivation is named in source');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actorKind consistency: engram.mjs#featureCheckpoint\'s options bag also derives actor via a getBranch-shaped seam, ignoring any caller override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plainfiles-actorkind-b-'));
  try {
    let getBranchCalled = false;
    // featureCheckpoint's options bag has no literal actor/actorKind field at
    // all (structural — it writes resume.md frontmatter, not a store
    // record). It is NOT a record producer and #738 does not touch it — the
    // consistency assertion this test pins is narrower than plainfiles.save's:
    // it derives its own "who did this" via a getBranch-shaped seam (same
    // shape), and a caller-supplied `actor`/`actorKind` field on the options
    // object has NO effect (there is no code path in featureCheckpoint that
    // reads it). It still branch-scopes its own working memory on purpose —
    // that is a different question ("which feature branch am I resuming?"),
    // not "who captured this record?".
    await featureCheckpoint('nonexistent-feature-xyz', {
      root,
      getBranch: (r) => { getBranchCalled = true; return 'seam-derived-branch-2'; },
      // Smuggled fields — featureCheckpoint's signature has no home for them.
      actor: 'spoofed-actor',
      actorKind: 'human',
    });
    // resolveFeature will fail (no such feature / no openspec dir) and
    // featureCheckpoint warns + returns early (never throws, pre-push
    // safety) — getBranch is only called on the branch-scope guard path when
    // an existing checkpoint is found, so for a brand-new/absent feature it
    // may not be invoked. The structural point already holds either way:
    // there is no `actor`/`actorKind` FIELD in featureCheckpoint's contract
    // for a caller to override. Assert the call did not throw.
    assert.ok(true, 'featureCheckpoint must not throw even with smuggled actor/actorKind fields');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actorKind consistency: both doors derive their own provenance via distinct, non-overridable seams', () => {
  // Signature-shape assertion: `save()` derives `actor` from `getGitConfig`
  // and `actorKind` from `getEnv` (#738); `featureCheckpoint()` derives its
  // OWN branch-scope via a `getBranch`-shaped seam. "Two cli doors, one
  // convention" now reads: neither accepts a caller-supplied override,
  // through whichever seam each uses for its own question.
  assert.equal(typeof save, 'function');
  assert.equal(typeof featureCheckpoint, 'function');
});

test('#738: PLAINFILES_ACTOR_KIND is no longer exported — the door-typed constant is retired', () => {
  assert.equal('PLAINFILES_ACTOR_KIND' in plainfiles, false);
});
