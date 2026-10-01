import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveGeminiRoute, checkGeminiReadiness, loadConfig } from './gemini-readiness.mjs';

const FAKE_KEY = ['gemini', 'fixture', 'key'].join('-');

test('resolveGeminiRoute: unrouted or non-gemini returns required: false', () => {
  assert.deepEqual(resolveGeminiRoute({}), {
    required: false,
    stage: 'cold-review',
    engine: null,
    model: null,
  });
  assert.deepEqual(resolveGeminiRoute({ sdd: { map: { 'cold-review': { engine: 'claude', model: 'sonnet' } } } }), {
    required: false,
    stage: 'cold-review',
    engine: 'claude',
    model: 'sonnet',
  });
});

test('resolveGeminiRoute: gemini engine returns required: true with model', () => {
  const route = resolveGeminiRoute({ sdd: { map: { 'cold-review': { engine: 'gemini', model: 'gemini-3.1-pro-high' } } } });
  assert.equal(route.required, true);
  assert.equal(route.engine, 'gemini');
  assert.equal(route.model, 'gemini-3.1-pro-high');
  assert.equal(route.identity, 'cold-review:gemini/gemini-3.1-pro-high');
});

test('checkGeminiReadiness: not required returns ready: true', () => {
  const result = checkGeminiReadiness({ required: false, engine: 'claude' });
  assert.equal(result.ready, true);
  assert.match(result.diagnostic, /Gemini is not required/i);
});

test('checkGeminiReadiness: missing binary returns ready: false with install hint', () => {
  const route = { required: true, engine: 'gemini', identity: 'cold-review:gemini/gemini-3.1-pro-high' };
  const result = checkGeminiReadiness(route, { commandExists: () => false });
  assert.equal(result.ready, false);
  assert.match(result.diagnostic, /neither agy.*nor gemini/i);
});

test('checkGeminiReadiness: missing auth when only gemini CLI is installed returns ready: false with hint', () => {
  const route = { required: true, engine: 'gemini', identity: 'cold-review:gemini/gemini-3.1-pro-high' };
  const result = checkGeminiReadiness(route, {
    commandExists: (bin) => bin === 'gemini',
    env: {},
  });
  assert.equal(result.ready, false);
  assert.match(result.diagnostic, /set GEMINI_API_KEY/i);
});

test('checkGeminiReadiness: agy binary present returns ready: true for Google AI Pro subscription', () => {
  const route = { required: true, engine: 'gemini', identity: 'cold-review:gemini/gemini-3.1-pro-high' };
  const result = checkGeminiReadiness(route, {
    commandExists: (bin) => bin === 'agy',
    env: {},
    agyAuthCheck: () => true,
  });
  assert.equal(result.ready, true);
  assert.match(result.diagnostic, /agy \(Google AI Pro subscription\)/i);
});

test('checkGeminiReadiness: gemini CLI and API key present returns ready: true', () => {
  const route = { required: true, engine: 'gemini', identity: 'cold-review:gemini/gemini-2.5-pro' };
  const result = checkGeminiReadiness(route, {
    commandExists: (bin) => bin === 'gemini',
    env: { GEMINI_API_KEY: FAKE_KEY },
  });
  assert.equal(result.ready, true);
  assert.match(result.diagnostic, /gemini \(API key\)/i);
});

test('checkGeminiReadiness: gemini CLI and GOOGLE_APPLICATION_CREDENTIALS present returns ready: true with ADC diagnostic', () => {
  const route = { required: true, engine: 'gemini', identity: 'cold-review:gemini/gemini-2.5-pro' };
  const result = checkGeminiReadiness(route, {
    commandExists: (bin) => bin === 'gemini',
    env: { GOOGLE_APPLICATION_CREDENTIALS: '/path/to/creds.json' },
  });
  assert.equal(result.ready, true);
  assert.match(result.diagnostic, /gemini \(ADC\)/i);
});

test('loadConfig: returns empty object if brain.config.json is absent', () => {
  const result = loadConfig('/tmp/nonexistent-dir-for-gemini-test-12345');
  assert.deepEqual(result, {});
});
