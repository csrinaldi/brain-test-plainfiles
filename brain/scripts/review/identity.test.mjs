// identity.test.mjs — Unit tests for the REQ-H1-1 fail-closed identity gate
// (design.md §3). No test spawns a real gh/glab process — the failure path
// injects a fake `getPatUrl`, the #413 verification path a fake `whoami`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  evaluateIdentity, evaluateVerifiedIdentity, evaluateNegativeControl,
  gatherIdentity, main, DEFAULT_TOKEN_ENV, NEGATIVE_CONTROL_SENTINEL,
} from './identity.mjs';

// A `whoami` double for an environment that HONOURS credentials: known tokens
// resolve, everything else is rejected the way the provider rejects a bad one.
//
// Before #604 the doubles here returned a fixed login whatever token they were
// handed — which is precisely the credential-injecting environment the negative
// control exists to detect, so the control (correctly) refused all of them. A
// double that ignores its token cannot model a healthy environment.
const honestWhoami = (logins) => async ({ token }) => {
  if (Object.hasOwn(logins, token)) return { username: logins[token] };
  throw new Error('gh: Bad credentials (HTTP 401)');
};

// ── Pure core — evaluateIdentity ────────────────────────────────────────────

test('evaluateIdentity: absent token → fail-closed with missing var + patSetupUrl + setup doc', () => {
  const result = evaluateIdentity({
    reviewerConfig: { handle: 'brain-reviewer', tokenEnv: 'BRAIN_REVIEWER_TOKEN' },
    env: {},
    patSetupUrl: 'https://github.com/settings/tokens/new?description=brain-reviewer',
    setupDocPath: 'docs/reviewer-setup.md',
  });
  assert.equal(result.ok, false);
  assert.equal(result.missingVar, 'BRAIN_REVIEWER_TOKEN');
  assert.match(result.patSetupUrl, /github\.com/);
  assert.equal(result.setupDocPath, 'docs/reviewer-setup.md');
});

test('evaluateIdentity: defaults tokenEnv to BRAIN_REVIEWER_TOKEN when config omits it', () => {
  const result = evaluateIdentity({ reviewerConfig: {}, env: {} });
  assert.equal(result.missingVar, DEFAULT_TOKEN_ENV);
});

test('evaluateIdentity: present token → ok with handle + token, never invents a value', () => {
  const result = evaluateIdentity({
    reviewerConfig: { handle: 'brain-reviewer', tokenEnv: 'BRAIN_REVIEWER_TOKEN' },
    env: { BRAIN_REVIEWER_TOKEN: 'shh' },
  });
  assert.deepEqual(result, { ok: true, handle: 'brain-reviewer', token: 'shh' });
});

// ── Pure core — evaluateVerifiedIdentity (#413) ─────────────────────────────

test('evaluateVerifiedIdentity: exact match verifies', () => {
  assert.deepEqual(
    evaluateVerifiedIdentity({ claimed: 'brain-reviewer', actual: 'brain-reviewer' }),
    { verified: true, actual: 'brain-reviewer' },
  );
});

test('evaluateVerifiedIdentity: case-different login is the SAME account — verifies (#413)', () => {
  // Logins are case-insensitive on both providers; refusing on case would be
  // a false positive that blocks a correctly-configured reviewer.
  assert.equal(evaluateVerifiedIdentity({ claimed: 'CsRinaldiBot', actual: 'csrinaldibot' }).verified, true);
});

test('evaluateVerifiedIdentity: different login refuses, reporting both identities', () => {
  const result = evaluateVerifiedIdentity({ claimed: 'csrinaldibot', actual: 'csrinaldi' });
  assert.deepEqual(result, { verified: false, claimed: 'csrinaldibot', actual: 'csrinaldi' });
});

test('evaluateVerifiedIdentity: an empty/absent actual never verifies', () => {
  assert.equal(evaluateVerifiedIdentity({ claimed: 'x', actual: '' }).verified, false);
  assert.equal(evaluateVerifiedIdentity({ claimed: 'x', actual: undefined }).verified, false);
});

// ── gatherIdentity (DI seam) ─────────────────────────────────────────────────

test('gatherIdentity: absent env var refuses to run — no server call besides the PAT URL builder', async () => {
  let getPatUrlCalls = 0;
  let whoamiCalls = 0;
  const result = await gatherIdentity({
    deps: {
      readConfig: () => ({ handle: 'brain-reviewer', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
      readEnv: () => ({}),
      getPatUrl: async () => { getPatUrlCalls++; return 'https://example.test/pat'; },
      whoami: async () => { whoamiCalls++; return { username: 'brain-reviewer' }; },
      setupDocPath: 'docs/reviewer-setup.md',
      host: 'github.com',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.missingVar, 'BRAIN_REVIEWER_TOKEN');
  assert.equal(result.patSetupUrl, 'https://example.test/pat');
  assert.equal(getPatUrlCalls, 1);
  assert.equal(whoamiCalls, 0, 'no token → nothing to verify — whoami must not run');
});

test('gatherIdentity: token + matching handle verifies and resolves ok, never calls getPatUrl (#413)', async () => {
  let getPatUrlCalls = 0;
  let whoamiToken = null;
  const result = await gatherIdentity({
    deps: {
      readConfig: () => ({ handle: 'brain-reviewer', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
      readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'shh' }),
      getPatUrl: async () => { getPatUrlCalls++; return 'unused'; },
      whoami: async ({ token }) => {
        if (token === NEGATIVE_CONTROL_SENTINEL) throw new Error('gh: Bad credentials (HTTP 401)');
        whoamiToken = token;
        return { username: 'brain-reviewer' };
      },
    },
  });
  assert.deepEqual(result, { ok: true, handle: 'brain-reviewer', token: 'shh', verifiedAs: 'brain-reviewer' });
  assert.equal(whoamiToken, 'shh', 'whoami must be scoped to the REVIEWER token, not ambient auth');
  assert.equal(getPatUrlCalls, 0);
});

test('gatherIdentity: token whose real login disagrees with the handle refuses (#413)', async () => {
  const result = await gatherIdentity({
    deps: {
      readConfig: () => ({ handle: 'csrinaldibot', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
      readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'shh' }), // the author's own token
      whoami: honestWhoami({ shh: 'csrinaldi' }),
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.mismatch, { claimed: 'csrinaldibot', actual: 'csrinaldi' });
});

test('gatherIdentity: whoami rejection refuses with the underlying error (#413)', async () => {
  const result = await gatherIdentity({
    deps: {
      readConfig: () => ({ handle: 'brain-reviewer', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
      readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'shh' }),
      // The control must CLEAR (the invalid token is rejected) so this test
      // still exercises the #413 verify path rather than #604's control path.
      whoami: async ({ token }) => {
        if (token === NEGATIVE_CONTROL_SENTINEL) throw new Error('gh: Bad credentials (HTTP 401)');
        throw new Error('api unreachable');
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.verifyError, 'api unreachable');
});

test('gatherIdentity: unset handle skips verification — that case is cli.mjs\'s #382 refusal', async () => {
  let whoamiCalls = 0;
  const result = await gatherIdentity({
    deps: {
      readConfig: () => ({ tokenEnv: 'BRAIN_REVIEWER_TOKEN' }), // handle unset
      readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'shh' }),
      whoami: async () => { whoamiCalls++; return { username: 'whoever' }; },
    },
  });
  assert.deepEqual(result, { ok: true, handle: null, token: 'shh' });
  assert.equal(whoamiCalls, 0, 'nothing to compare against — verification must not run');
});

// ── main ─────────────────────────────────────────────────────────────────────

test('main: non-zero exit code with fail-closed message on missing token', async () => {
  const code = await main({
    readConfig: () => ({ tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
    readEnv: () => ({}),
    getPatUrl: async () => 'https://example.test/pat',
  });
  assert.equal(code, 1);
});

test('main: exit code 0 when the token is present and verifies (#413)', async () => {
  const code = await main({
    readConfig: () => ({ handle: 'brain-reviewer', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
    readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'shh' }),
    whoami: honestWhoami({ shh: 'brain-reviewer' }),
  });
  assert.equal(code, 0);
});

test('main: exit code 1 on an identity mismatch (#413)', async () => {
  const code = await main({
    readConfig: () => ({ handle: 'csrinaldibot', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
    readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'shh' }),
    whoami: honestWhoami({ shh: 'csrinaldi' }),
  });
  assert.equal(code, 1);
});

// ── The negative control (#604 half 1) ───────────────────────────────────────

test('evaluateNegativeControl: an invalid token that RESOLVES means credentials are injected', () => {
  assert.deepEqual(
    evaluateNegativeControl({ resolved: 'csrinaldi' }),
    { control: 'resolved', ambientAs: 'csrinaldi' },
  );
});

test('evaluateNegativeControl: a recognised auth rejection clears the control', () => {
  for (const msg of [
    'gh: Bad credentials (HTTP 401)',
    'HTTP 401: Bad credentials',
    'GraphQL: Requires authentication',
    '401 Unauthorized',
  ]) {
    assert.equal(evaluateNegativeControl({ error: msg }).control, 'rejected', msg);
  }
});

test('evaluateNegativeControl: an UNRECOGNISED failure is unusable, never rejected (#604)', () => {
  // The reader-empty-on-failure guard: a probe that could not run to a verdict
  // has established nothing. Scoring it `rejected` would rebuild the defect the
  // control exists to catch — measured, `gh` absent yields exactly this shape.
  const result = evaluateNegativeControl({ error: 'gh api /user failed (status null): gh: spawnSync gh ENOENT' });
  assert.equal(result.control, 'unusable');
  assert.match(result.reason, /ENOENT/, 'the reason must survive — "could not" is not "there is none"');
});

test('evaluateNegativeControl: neither an identity nor an error is unusable, not clean', () => {
  assert.equal(evaluateNegativeControl({}).control, 'unusable');
});

test('gatherIdentity: an environment that resolves the INVALID token refuses, naming the ambient identity (#604)', async () => {
  // Reproduces the measured cloud container: every token resolves to the same
  // login, so `reviewer.handle: csrinaldi` would otherwise VERIFY on a
  // credential that was never used.
  const result = await gatherIdentity({
    deps: {
      readConfig: () => ({ handle: 'csrinaldi', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
      readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'inert' }),
      whoami: async () => ({ username: 'csrinaldi' }), // ignores the token, like the proxy
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ambientIdentity, 'csrinaldi');
  assert.equal(result.mismatch, undefined, 'must NOT surface as a mismatch — that shape cost three token rotations');
});

test('gatherIdentity: the control runs BEFORE the real verification, and with the sentinel token (#604)', async () => {
  const ordered = [];
  const result = await gatherIdentity({
    deps: {
      readConfig: () => ({ handle: 'csrinaldibot', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
      readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'realpat' }),
      whoami: async ({ token }) => {
        ordered.push(token);
        if (token === NEGATIVE_CONTROL_SENTINEL) throw new Error('gh: Bad credentials (HTTP 401)');
        return { username: 'csrinaldibot' };
      },
    },
  });
  assert.deepEqual(ordered, [NEGATIVE_CONTROL_SENTINEL, 'realpat']);
  assert.equal(result.ok, true);
  assert.equal(result.verifiedAs, 'csrinaldibot');
});

test('gatherIdentity: an unusable control refuses distinctly from a mismatch (#604)', async () => {
  const result = await gatherIdentity({
    deps: {
      readConfig: () => ({ handle: 'csrinaldibot', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
      readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'realpat' }),
      whoami: async () => { throw new Error('gh: spawnSync gh ENOENT'); },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.controlError, /ENOENT/);
  assert.equal(result.verifyError, undefined);
  assert.equal(result.mismatch, undefined);
});

test('main: exit code 1 when the environment resolves an invalid token (#604)', async () => {
  const code = await main({
    readConfig: () => ({ handle: 'csrinaldi', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
    readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'inert' }),
    whoami: async () => ({ username: 'csrinaldi' }),
  });
  assert.equal(code, 1, 'a handle matching the ambient identity must NOT verify');
});

test('the sentinel token is not a credential and is never read from config or env', () => {
  assert.match(NEGATIVE_CONTROL_SENTINEL, /NotARealToken/);
  const src = readFileSync(new URL('./identity.mjs', import.meta.url), 'utf8');
  assert.equal(src.includes('process.env[NEGATIVE_CONTROL_SENTINEL]'), false);
});

// ── The control's own blast radius (#604 self-review F1) ─────────────────────

test('evaluateNegativeControl: a provider auth lockout is its OWN state, not unusable (#604 F1)', () => {
  // The control sends one invalid credential per run; a burst of those is what
  // providers throttle. Folded into `unusable` this read as "could not
  // establish whether this environment honours the token" — sending the
  // operator after a proxy that is not there, which is the mis-diagnosis that
  // cost three token rotations, caused by the fix for it.
  for (const msg of [
    'gh: Maximum number of login attempts exceeded. Please try again later. (HTTP 403)',
    'gh: API rate limit exceeded (HTTP 403)',
    'GitLab API failed: 429 (/user) rate limit',
  ]) {
    const result = evaluateNegativeControl({ error: msg });
    assert.equal(result.control, 'lockout', msg);
    assert.equal(result.reason, msg, 'the provider\'s own words must survive to the operator');
  }
});

test('evaluateNegativeControl: a lockout never CLEARS the control (#604 F1)', () => {
  // A lockout is suggestive that credentials are honoured — a proxy would never
  // produce one — but inferring a clearance from a failure is the exact
  // inversion this control removes. It must refuse.
  const result = evaluateNegativeControl({ error: 'Maximum number of login attempts exceeded' });
  assert.notEqual(result.control, 'rejected');
  assert.notEqual(result.control, 'resolved');
});

test('evaluateNegativeControl: lockout is tested BEFORE the auth-rejection match (#604 F1)', () => {
  // A message carrying BOTH a status code and throttling text must not be read
  // as a plain 401 — the remedy differs (wait, vs. the environment is fine).
  const both = 'HTTP 401 — and then: Maximum number of login attempts exceeded';
  assert.equal(evaluateNegativeControl({ error: both }).control, 'lockout');
});

test('gatherIdentity: a lockout refuses distinctly from unusable AND from a mismatch (#604 F1)', () => {
  return gatherIdentity({
    deps: {
      readConfig: () => ({ handle: 'csrinaldibot', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
      readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'realpat' }),
      whoami: async () => { throw new Error('gh: Maximum number of login attempts exceeded (HTTP 403)'); },
    },
  }).then((result) => {
    assert.equal(result.ok, false);
    assert.match(result.controlLockout, /Maximum number of login attempts/);
    assert.equal(result.controlError, undefined, 'a lockout is not an unusable probe');
    assert.equal(result.mismatch, undefined);
    assert.equal(result.ambientIdentity, undefined);
  });
});

test('main: a lockout tells the operator to WAIT, never to rotate the token (#604 F1)', async () => {
  const errors = [];
  const realError = console.error;
  console.error = (s) => errors.push(String(s));
  try {
    const code = await main({
      readConfig: () => ({ handle: 'csrinaldibot', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
      readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'realpat' }),
      whoami: async () => { throw new Error('gh: Maximum number of login attempts exceeded (HTTP 403)'); },
    });
    assert.equal(code, 1);
  } finally {
    console.error = realError;
  }
  const text = errors.join('\n');
  assert.match(text, /temporarily refusing authentication/i);
  assert.match(text, /may have caused this itself/i, 'the control must own its contribution');
  assert.match(text, /Do NOT rotate the token/i);
  assert.doesNotMatch(text, /could not establish whether this environment honours/i,
    'the unusable wording would send the operator after a proxy that is not there');
});
