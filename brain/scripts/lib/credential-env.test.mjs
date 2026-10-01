// credential-env.test.mjs — the scrub set, and WHERE ITS NAMES COME FROM
// (#682 slice 3, judgment:cold-2).
//
// The interesting assertion here is not "the list contains GH_TOKEN". It is
// that the two names brain ITSELF authenticates with are DERIVED from the
// modules that read them, so a rename cannot leave the scrub behind pointing at
// a variable nobody uses while the live one rides into the producer. That is
// the ticket's recurring defect class, and a hand-written list of literals
// checked against another hand-written list of literals would be it again.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REVIEWER_TOKEN_ENV,
  FORGE_TOKEN_ENV,
  MEMORY_TOKEN_ENV,
  credentialEnvNames,
  withoutCredentials,
} from './credential-env.mjs';
import { tokenEnvVar } from '../vcs/lib/token.mjs';
import { DEFAULT_TOKEN_ENV } from '../review/identity.mjs';

test('#682 cold-2: the reviewer credential is ONE name, read by identity.mjs and stripped here', () => {
  assert.equal(
    DEFAULT_TOKEN_ENV, REVIEWER_TOKEN_ENV,
    'identity.mjs and the scrub disagree about which variable holds the reviewer token — ' +
    'one of them is now pointing at a name nobody sets, and the live one reaches the producer'
  );
  assert.ok(credentialEnvNames().includes(DEFAULT_TOKEN_ENV));
});

test('#682 cold-2: the VCS credential name comes from token.mjs, not from a copy', () => {
  assert.ok(
    credentialEnvNames().includes(tokenEnvVar()),
    'the var `vcsToken()` reads is not in the scrub set — the producer inherits the credential ' +
    'brain posts with'
  );
});

// ── issue #888 — MEMORY_TOKEN_ENV denylisted by default (D3/A5) ─────────────

test('#888: MEMORY_TOKEN_ENV is BRAIN_MEMORY_TOKEN, and is in the DEFAULT set with no `extra`', () => {
  assert.equal(MEMORY_TOKEN_ENV, 'BRAIN_MEMORY_TOKEN');
  assert.ok(
    credentialEnvNames().includes(MEMORY_TOKEN_ENV),
    'the ship op\'s credential name must be denylisted by default, with no `extra` argument required',
  );
});

test('#888: leak regression — withoutCredentials strips BRAIN_MEMORY_TOKEN by default, no `extra`', () => {
  const env = { PATH: '/usr/bin', BRAIN_MEMORY_TOKEN: 'secret' };
  const out = withoutCredentials(env, credentialEnvNames());
  assert.equal(out.BRAIN_MEMORY_TOKEN, undefined);
  assert.equal(out.PATH, '/usr/bin');
});

test('#682 cold-2: every forge credential is in the set', () => {
  const names = credentialEnvNames();
  for (const forge of FORGE_TOKEN_ENV) assert.ok(names.includes(forge), `${forge} escapes the scrub`);
});

test('#682 cold-2: `extra` WIDENS and cannot narrow — a configured tokenEnv is additive', () => {
  const widened = credentialEnvNames({ extra: ['REPO_SPECIFIC_TOKEN'] });
  assert.ok(widened.includes('REPO_SPECIFIC_TOKEN'));
  for (const base of credentialEnvNames()) {
    assert.ok(widened.includes(base), `${base} was lost when the caller passed extras`);
  }
});

test('#682 cold-2: junk in `extra` is dropped, and names are not duplicated', () => {
  // `config?.reviewer?.tokenEnv` is `undefined` on a repo with no reviewer
  // block, and an `undefined` in the drop set would be compared as the string
  // "undefined" — harmless, but it would also mean the caller can never tell a
  // real name from a missing one.
  const names = credentialEnvNames({ extra: [undefined, null, '', '   ', REVIEWER_TOKEN_ENV] });
  assert.deepEqual(names, [...new Set(names)], 'duplicate names in the scrub set');
  for (const n of names) assert.ok(typeof n === 'string' && n.trim() !== '', `junk name in the set: ${JSON.stringify(n)}`);
});

test('#682 cold-2: withoutCredentials removes the named vars and KEEPS the rest', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/x', BRAIN_REVIEWER_TOKEN: 'secret', GH_TOKEN: 'secret2' };
  const out = withoutCredentials(env, credentialEnvNames());

  assert.equal(out.BRAIN_REVIEWER_TOKEN, undefined);
  assert.equal(out.GH_TOKEN, undefined);
  assert.equal(out.PATH, '/usr/bin', 'stripping PATH would make every engine unspawnable');
  assert.equal(out.HOME, '/home/x');
  assert.notEqual(out, env, 'it must return a COPY — spawnSync hands the child the object it is given');
});

test('#682 cold-2: the match is case-insensitive, because Windows env names are', () => {
  const out = withoutCredentials({ Gh_Token: 'secret', Keep: 'yes' }, credentialEnvNames());
  assert.equal(out.Gh_Token, undefined, 'a differently-cased credential is the same credential to the child on Windows');
  assert.equal(out.Keep, 'yes');
});


// ── judgment:cold-5 (third cold review) — the count gets a reader ──────────

test('cold-5: the scrubbed set is pinned, so no prose can state a stale count', () => {
  // Three places described the forge-reach measurement as "all seven names";
  // the list holds eight. The number is derived from a frozen literal plus two
  // imports — checkable, and nothing checked it. A stale measurement reads
  // exactly like a current one, which is this ticket's own recurring shape in
  // the measurement that warrants ADR-0033's load-bearing property.
  //
  // Pinned as the NAMES rather than the length: a test asserting `=== 8` goes
  // green on a rename and tells nobody which name moved.
  assert.deepEqual(credentialEnvNames().sort(), [
    'BRAIN_MEMORY_TOKEN',
    'BRAIN_REVIEWER_TOKEN',
    'CI_JOB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GH_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
    'VCS_TOKEN',
  ]);
});
