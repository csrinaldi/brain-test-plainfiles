import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkCodexReadiness, resolveCodexRoute } from './codex-readiness.mjs';

const codexRoute = { sdd: { map: { 'cold-review': { engine: 'codex', model: 'gpt-5.5' } } } };

test('identifies the supported Codex cold-review route for diagnostics', () => {
  assert.deepEqual(resolveCodexRoute(codexRoute), {
    required: true,
    stage: 'cold-review',
    engine: 'codex',
    model: 'gpt-5.5',
    identity: 'cold-review:codex/gpt-5.5',
  });
});

test('rejects an unsupported Codex model before readiness or inference', () => {
  for (const route of [
    { engine: 'codex', model: 'gpt-5.4' },
    { engine: 'codex' },
  ]) {
    assert.throws(
      () => resolveCodexRoute({ sdd: { map: { 'cold-review': route } } }),
      /requires model gpt-5\.5/,
    );
  }
  assert.throws(
    () => resolveCodexRoute({ sdd: { map: { 'cold-review': { model: 'gpt-5.5' } } } }),
    /engine/,
  );
});

test('does not require or invoke Codex for an effective Claude route', () => {
  let invoked = false;
  const route = resolveCodexRoute({ sdd: { map: { 'cold-review': { engine: 'claude', model: 'sonnet' } } } });
  assert.deepEqual(route, { required: false, stage: 'cold-review', engine: 'claude', model: 'sonnet' });
  assert.deepEqual(checkCodexReadiness(route, {
    commandExists: () => { invoked = true; return false; },
  }), { ready: true, required: false, diagnostic: 'cold-review is routed to claude; Codex is not required' });
  assert.equal(invoked, false);
});

test('reports bounded actionable diagnostics for absent, old, and unauthenticated routed Codex', () => {
  const route = resolveCodexRoute(codexRoute);
  assert.match(checkCodexReadiness(route, { commandExists: () => false }).diagnostic, /npm install -g @openai\/codex/);
  assert.match(checkCodexReadiness(route, {
    commandExists: () => true,
    run: () => ({ status: 0, stdout: 'codex-cli 0.153.0' }),
  }).diagnostic, /0\.154\.0 or newer/);
  assert.match(checkCodexReadiness(route, {
    commandExists: () => true,
    run: (bin, args) => args[0] === '--version'
      ? { status: 0, stdout: 'codex-cli 0.154.0' }
      : { status: 1, stderr: 'not logged in' },
  }).diagnostic, /codex login/);
});

test('accepts a supported authenticated CLI and names remaining runtime checks without exposing credentials', () => {
  const result = checkCodexReadiness(resolveCodexRoute(codexRoute), {
    commandExists: () => true,
    run: (bin, args) => args[0] === '--version'
      ? { status: 0, stdout: 'codex-cli 0.154.0' }
      : { status: 0, stdout: 'Logged in' },
  });
  assert.deepEqual(result, {
    ready: true,
    required: true,
    diagnostic: 'Codex 0.154.0 is authenticated for cold-review:codex/gpt-5.5; the review run verifies model access, network, writable isolated state, and the read-only sandbox.',
  });
});
