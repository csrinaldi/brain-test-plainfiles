// config-verb.test.mjs — issue #823 (Compuerta 4's verb, first slice).
// `planConfigWrite` is PURE: config, migrations and target version are
// RECEIVED, never read — `role-port.mjs`'s discipline. Every test hands in a
// synthetic migration list so the oracle is the rule, not whatever
// brain/core/config-migrations.mjs happens to ship this week.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveKnownPaths, parseValue, planConfigWrite, resolvePath } from './config-verb.mjs';

const MIGRATIONS = [
  { version: '0.1.0', description: 't', defaults: { project: { name: '', slug: '' } } },
  { version: '0.2.0', description: 't', defaults: { docs: { language: 'en' } } },
  { version: '0.3.0', description: 't', defaults: { sdd: { map: {} } } },
];

test('#823: KNOWN_PATHS is DERIVED from migration defaults — leaves exact, empty objects open families', () => {
  const known = deriveKnownPaths(MIGRATIONS);
  assert.ok(known.leaves.has('docs.language'));
  assert.ok(known.leaves.has('project.name'));
  assert.ok(known.families.has('sdd.map'), 'a defaults node of {} is an OPEN family — sdd.map.<stage> is writable');
});

test('#823: an unknown path fails CLOSED, naming the nearest known family', () => {
  const { refusal, next } = planConfigWrite({ config: {}, path: 'sdd.mpa.tasks', value: 'x', migrations: MIGRATIONS, targetVersion: '0.3.0' });
  assert.equal(next, null, 'nothing may be written on a refusal');
  assert.match(refusal, /sdd\.mpa\.tasks/);
  assert.match(refusal, /sdd\.map/, 'the refusal must point at the family the typo missed');
});

test('#823: a known leaf writes, and the write is the ONLY change beside migrations', () => {
  const { next, refusal } = planConfigWrite({ config: { docs: { language: 'en' }, schemaVersion: '0.3.0' }, path: 'docs.language', value: 'es', migrations: MIGRATIONS, targetVersion: '0.3.0' });
  assert.equal(refusal, null);
  assert.equal(next.docs.language, 'es');
});

test('#823: an open-family subpath writes — sdd.map.<stage> is the ruled spelling', () => {
  const { next } = planConfigWrite({ config: { schemaVersion: '0.3.0' }, path: 'sdd.map.cold-review', value: '{"engine":"plain"}', migrations: MIGRATIONS, targetVersion: '0.3.0' });
  assert.deepEqual(next.sdd.map['cold-review'], { engine: 'plain' });
});

test('#823: pending migrations run FIRST, in the verb — the caller never migrates', () => {
  const { next, migrationsApplied } = planConfigWrite({ config: { schemaVersion: '0.1.0' }, path: 'docs.language', value: 'es', migrations: MIGRATIONS, targetVersion: '0.3.0' });
  assert.deepEqual(migrationsApplied, ['0.2.0', '0.3.0']);
  assert.equal(next.schemaVersion, '0.3.0');
  assert.deepEqual(next.sdd.map, {}, "0.3.0's default landed before the write");
});

test('#823: values parse JSON-first, bare string on failure', () => {
  assert.deepEqual(parseValue('{"engine":"plain"}'), { engine: 'plain' });
  assert.equal(parseValue('true'), true);
  assert.equal(parseValue('es'), 'es', 'a bare word is a string, not a parse error');
});

test('#823: resolvePath answers get — a missing path is undefined, never a throw', () => {
  assert.equal(resolvePath({ docs: { language: 'es' } }, 'docs.language'), 'es');
  assert.equal(resolvePath({}, 'docs.language'), undefined);
});

test('#823: migrations NEVER overwrite an existing value on the way through (ADR-0006)', () => {
  const { next } = planConfigWrite({ config: { schemaVersion: '0.1.0', docs: { language: 'fr' } }, path: 'sdd.map.x', value: '{"engine":"plain"}', migrations: MIGRATIONS, targetVersion: '0.3.0' });
  assert.equal(next.docs.language, 'fr', 'the 0.2.0 default must not clobber the consumer value');
});

// ── #823, cold review round 1 — hostile path segments ───────────────────────
// Reproduced before fixing: `set sdd.map.__proto__.polluted true` returned
// refusal: null and left ({}).polluted === true — the write loop walked INTO
// Object.prototype because the family check was a bare startsWith. Every open
// family this verb will ever host (sdd.map today, sdd.engines tomorrow, every
// #824 --record and #323 route) goes through this one path, so the guard
// belongs HERE, in the planner, not at any call site.

const HOSTILE = ['__proto__', 'constructor', 'prototype'];

test('#823 security: a hostile segment inside an OPEN FAMILY is refused, and the prototype stays clean', () => {
  for (const seg of HOSTILE) {
    const { refusal, next } = planConfigWrite({
      config: { schemaVersion: '0.3.0' }, path: `sdd.map.${seg}.polluted`, value: 'true',
      migrations: MIGRATIONS, targetVersion: '0.3.0',
    });
    assert.equal(next, null, `${seg}: nothing may be written`);
    assert.match(refusal, new RegExp(seg.replace(/\$/g, '')), `${seg}: the refusal names the segment`);
  }
  assert.equal(({}).polluted, undefined, 'Object.prototype must be untouched');
});

test('#823 security: a hostile leaf segment is refused even when a known family prefixes it', () => {
  const { refusal } = planConfigWrite({
    config: {}, path: 'sdd.map.__proto__', value: '{}',
    migrations: MIGRATIONS, targetVersion: '0.3.0',
  });
  assert.ok(refusal, 'the family owner cannot name a member the language itself owns');
});

test('#823 security: resolvePath refuses to WALK a hostile segment — get and set share one safety rule', () => {
  assert.equal(resolvePath({ docs: { language: 'es' } }, 'docs.__proto__.constructor'), undefined,
    'a hostile segment resolves to undefined — never to the prototype chain');
});

test('#823: get stays readable OUTSIDE the declared schema — schemaVersion is the proof', () => {
  // cold review round 1, judgment:cold-2 asked why get and set enforce
  // different strictness. Stated here as a FACT, not a preference: the verb
  // itself writes `schemaVersion`, no migration's defaults declare it, so a
  // get validated against deriveKnownPaths would refuse to read a key the
  // verb wrote. Reads report what IS; writes gate what MAY BE. The SAFETY
  // rule (hostile segments) is the shared half — strictness is not.
  assert.equal(resolvePath({ schemaVersion: '1.1.0' }, 'schemaVersion'), '1.1.0');
});

test('#823 (round 2): an EMPTY segment is refused — a malformed path is an unknown path', () => {
  // Cold review round 2 — reproduced: 'sdd.map..polluted' wrote a '' key with
  // no refusal. Not pollution, but a junk key the fails-closed promise
  // explicitly covers. Same rule on get: resolvePath answers undefined.
  for (const path of ['sdd.map..polluted', '.sdd.map.x', 'sdd.map.x.', '.']) {
    const { refusal, next } = planConfigWrite({ config: {}, path, value: 'true', migrations: MIGRATIONS, targetVersion: '0.3.0' });
    assert.equal(next, null, `${JSON.stringify(path)}: nothing may be written`);
    assert.match(refusal, /empty segment/, `${JSON.stringify(path)}: the refusal names the malformation`);
  }
  assert.equal(resolvePath({ sdd: { map: { '': { x: 1 } } } }, 'sdd.map..x'), undefined);
});

// #1165 NIT: a typo must be refused at WRITE time, not at the next `pull`.
test('#1165 planConfigWrite: memory.backend is validated against the closed set at write time', async () => {
  const { migrations } = await import('../../core/config-migrations.mjs');
  const bad = planConfigWrite({ config: { schemaVersion: '1.9.0' }, path: 'memory.backend', value: 'plainfile', migrations, targetVersion: '1.9.0' });
  assert.equal(bad.next, null);
  assert.match(bad.refusal, /engram \| plainfiles/);
  const ok = planConfigWrite({ config: { schemaVersion: '1.9.0' }, path: 'memory.backend', value: 'engram', migrations, targetVersion: '1.9.0' });
  assert.equal(ok.refusal, null);
  const empty = planConfigWrite({ config: { schemaVersion: '1.9.0' }, path: 'memory.backend', value: '""', migrations, targetVersion: '1.9.0' });
  assert.equal(empty.refusal, null, 'clearing to undeclared is allowed');
});
