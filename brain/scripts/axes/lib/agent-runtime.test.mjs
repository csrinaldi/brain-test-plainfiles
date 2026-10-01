// brain/scripts/axes/lib/agent-runtime.test.mjs — unit tests for the
// generic agent-runtime probe (issue #123).
//
// The probe is harness-agnostic by construction (ADR-0005): it knows only the
// descriptor shape, never a specific AI CLI. These tests exercise it with
// synthetic descriptors, so a backend rename can never make them pass by luck.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUNTIME_STATES,
  probeAgentRuntime,
  formatRuntimeNotice,
  agentRuntimeReport,
  platformEnvVars,
  platformConfig,
} from './agent-runtime.mjs';
import { resolvePlatform } from '../../harness/cli.mjs';

// A synthetic descriptor — deliberately not any real backend's.
const DESC = Object.freeze({
  name: 'fake-agent',
  bin: 'fakeagent',
  versionArgs: ['--version'],
  latest: { cmd: 'npm', args: ['view', '@fake/agent', 'version'] },
  updateHint: 'npm install -g @fake/agent@latest',
});

/** Builds a recording `_run` seam from a per-command reply table. */
function runner(replies) {
  const calls = [];
  const _run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const key = [cmd, ...args].join(' ');
    return replies[key] ?? { status: 127, stdout: '', stderr: `no such command: ${key}` };
  };
  return { _run, calls };
}

const VERSION_CALL = 'fakeagent --version';
const LATEST_CALL = 'npm view @fake/agent version';

// ── state machine ────────────────────────────────────────────────────────────

test('probeAgentRuntime: no descriptor → not-declared, and nothing is executed', () => {
  const { _run, calls } = runner({});
  for (const empty of [null, undefined]) {
    const status = probeAgentRuntime(empty, { _run });
    assert.equal(status.state, 'not-declared');
    assert.equal(status.installed, null);
    assert.equal(status.latest, null);
  }
  assert.deepEqual(calls, []);
});

test('probeAgentRuntime: binary absent → absent, with the failure detail preserved', () => {
  const { _run, calls } = runner({
    [VERSION_CALL]: { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn fakeagent ENOENT'), { code: 'ENOENT' }) },
  });
  const status = probeAgentRuntime(DESC, { _run });

  assert.equal(status.state, 'absent');
  assert.equal(status.installed, null);
  // The reason must survive — "absent" without a detail is an unreadable verdict.
  assert.match(status.detail, /ENOENT/);
  // A binary that is not there is never interrogated for a latest version.
  assert.deepEqual(calls, [VERSION_CALL]);
});

test('probeAgentRuntime: binary present but version illegible → unreadable, NOT absent', () => {
  const { _run } = runner({
    [VERSION_CALL]: { status: 0, stdout: 'fakeagent (development build)\n', stderr: '' },
  });
  const status = probeAgentRuntime(DESC, { _run });

  // The distinction this whole state machine exists for: "the CLI is not here"
  // and "the CLI is here but would not say which version" are different facts.
  assert.equal(status.state, 'unreadable');
  assert.notEqual(status.state, 'absent');
  assert.equal(status.installed, null);
  assert.match(status.detail, /development build/);
});

test('probeAgentRuntime: latest lookup fails → unknown-latest, never up-to-date', () => {
  const { _run } = runner({
    [VERSION_CALL]: { status: 0, stdout: '1.2.3\n', stderr: '' },
    [LATEST_CALL]: { status: 1, stdout: '', stderr: 'npm ERR! network unreachable' },
  });
  const status = probeAgentRuntime(DESC, { _run });

  assert.equal(status.state, 'unknown-latest');
  assert.equal(status.installed, '1.2.3');
  assert.equal(status.latest, null);
  assert.match(status.detail, /network unreachable/);
});

test('probeAgentRuntime: descriptor declares no latest probe → unknown-latest, installed still reported', () => {
  const { _run, calls } = runner({
    [VERSION_CALL]: { status: 0, stdout: '1.2.3\n', stderr: '' },
  });
  const status = probeAgentRuntime({ ...DESC, latest: null }, { _run });

  assert.equal(status.state, 'unknown-latest');
  assert.equal(status.installed, '1.2.3');
  assert.deepEqual(calls, [VERSION_CALL]);
});

test('probeAgentRuntime: latest > installed → update-available with both versions', () => {
  const { _run, calls } = runner({
    [VERSION_CALL]: { status: 0, stdout: '1.2.3 (Fake Agent)\n', stderr: '' },
    [LATEST_CALL]: { status: 0, stdout: '1.3.0\n', stderr: '' },
  });
  const status = probeAgentRuntime(DESC, { _run });

  assert.equal(status.state, 'update-available');
  assert.equal(status.installed, '1.2.3');
  assert.equal(status.latest, '1.3.0');
  assert.equal(status.updateHint, DESC.updateHint);
  assert.deepEqual(calls, [VERSION_CALL, LATEST_CALL]);
});

test('probeAgentRuntime: latest === installed → up-to-date', () => {
  const { _run } = runner({
    [VERSION_CALL]: { status: 0, stdout: '1.3.0\n', stderr: '' },
    [LATEST_CALL]: { status: 0, stdout: '1.3.0\n', stderr: '' },
  });
  assert.equal(probeAgentRuntime(DESC, { _run }).state, 'up-to-date');
});

test('probeAgentRuntime: installed ahead of latest → up-to-date (never a downgrade notice)', () => {
  const { _run } = runner({
    [VERSION_CALL]: { status: 0, stdout: '2.0.0\n', stderr: '' },
    [LATEST_CALL]: { status: 0, stdout: '1.3.0\n', stderr: '' },
  });
  assert.equal(probeAgentRuntime(DESC, { _run }).state, 'up-to-date');
});

// ── notify, never auto-update (the load-bearing constraint of #123) ──────────

test('probeAgentRuntime: NEVER executes the update command, even when one is available', () => {
  const { _run, calls } = runner({
    [VERSION_CALL]: { status: 0, stdout: '1.2.3\n', stderr: '' },
    [LATEST_CALL]: { status: 0, stdout: '9.9.9\n', stderr: '' },
  });
  probeAgentRuntime(DESC, { _run });

  assert.deepEqual(calls, [VERSION_CALL, LATEST_CALL]);
  for (const call of calls) {
    assert.doesNotMatch(call, /install|update|upgrade/);
  }
});

test('formatRuntimeNotice: update-available warns, names both versions, and says it was not applied', () => {
  const notice = formatRuntimeNotice({
    state: 'update-available',
    name: 'fake-agent',
    installed: '1.2.3',
    latest: '1.3.0',
    updateHint: 'npm install -g @fake/agent@latest',
    detail: null,
  });

  assert.equal(notice.level, 'warn');
  assert.match(notice.message, /fake-agent/);
  assert.match(notice.message, /1\.2\.3/);
  assert.match(notice.message, /1\.3\.0/);
  assert.match(notice.hint, /npm install -g @fake\/agent@latest/);
  // Mirrors the brain-tag stance: the notice must state that nothing was applied.
  assert.match(notice.hint, /not applied automatically/i);
});

test('formatRuntimeNotice: unreadable and absent produce DIFFERENT operator text', () => {
  const base = { name: 'fake-agent', installed: null, latest: null, updateHint: 'x', bin: 'fakeagent' };
  const absent = formatRuntimeNotice({ ...base, state: 'absent', detail: 'ENOENT' });
  const unreadable = formatRuntimeNotice({ ...base, state: 'unreadable', detail: 'development build' });

  assert.notEqual(absent.message, unreadable.message);
  assert.match(unreadable.message, /version/i);
});

test('formatRuntimeNotice: unknown-latest is not reported as up to date', () => {
  const notice = formatRuntimeNotice({
    state: 'unknown-latest',
    name: 'fake-agent',
    installed: '1.2.3',
    latest: null,
    updateHint: 'x',
    detail: 'offline',
  });
  assert.doesNotMatch(notice.message, /up to date/i);
  assert.match(notice.message, /1\.2\.3/);
});

// ── report: resolve the CONFIGURED platform, never a hardcoded one ───────────

test('agentRuntimeReport: probes the descriptor of the CONFIGURED platform', async () => {
  const loaded = [];
  const _loadBackend = async (platform) => {
    loaded.push(platform);
    return { AGENT_RUNTIME: { ...DESC, name: `runtime-of-${platform}` } };
  };
  const { _run } = runner({
    [VERSION_CALL]: { status: 0, stdout: '1.2.3\n', stderr: '' },
    [LATEST_CALL]: { status: 0, stdout: '1.2.3\n', stderr: '' },
  });

  const report = await agentRuntimeReport({
    env: { AGENT_PLATFORM: 'some-other-harness' },
    _loadBackend,
    _run,
  });

  assert.deepEqual(loaded, ['some-other-harness']);
  assert.equal(report.platform, 'some-other-harness');
  assert.equal(report.status.name, 'runtime-of-some-other-harness');
  assert.equal(report.status.state, 'up-to-date');
});

test('agentRuntimeReport: a backend declaring no runtime → not-declared, no execution', async () => {
  const { _run, calls } = runner({});
  const report = await agentRuntimeReport({
    env: { AGENT_PLATFORM: 'plain' },
    _loadBackend: async () => ({ AGENT_RUNTIME: null }),
    _run,
  });

  assert.equal(report.status.state, 'not-declared');
  assert.match(report.notice.message, /plain/);
  assert.deepEqual(calls, []);
});

test('agentRuntimeReport: a backend that fails to load is unresolved, NOT silently not-declared', async () => {
  const report = await agentRuntimeReport({
    env: { AGENT_PLATFORM: 'nonexistent' },
    _loadBackend: async () => { throw new Error('backend not found at ./backends/nonexistent.mjs'); },
    _run: () => { throw new Error('must not run'); },
  });

  // "Could not read the backend" must never be reported as "this backend has
  // no runtime" — that is the evidence-reader-empty-on-failure class.
  assert.equal(report.status.state, 'unresolved');
  assert.notEqual(report.status.state, 'not-declared');
  assert.match(report.status.detail, /backend not found/);
  assert.equal(report.notice.level, 'warn');
});

// ── review follow-ups (PR #594) ──────────────────────────────────────────────

test('probeAgentRuntime: binary PRESENT but exiting non-zero is unreadable, not absent', () => {
  // spawnSync reports a MISSING binary through `error` (ENOENT). A binary that
  // is installed and merely fails has no `error` — those are different facts,
  // and "not installed. Install it with: …" is wrong advice for the second.
  const { _run } = runner({
    [VERSION_CALL]: { status: 1, stdout: '', stderr: 'panic: config corrupt' },
  });
  const status = probeAgentRuntime(DESC, { _run });

  assert.equal(status.state, 'unreadable');
  assert.notEqual(status.state, 'absent');
  assert.match(status.detail, /config corrupt/);
});

test('probeAgentRuntime: ONLY ENOENT means absent — a real spawn error carries a code', () => {
  // spawnSync sets `error.code`. ENOENT is the one code that means "the binary
  // is not there"; every other code describes a binary that IS there and did
  // not answer. Reading the message instead of the code makes them one fact.
  const spawnError = (code) => ({
    [VERSION_CALL]: { status: null, stdout: '', stderr: '', error: Object.assign(new Error(`spawn fakeagent ${code}`), { code }) },
  });

  assert.equal(probeAgentRuntime(DESC, { _run: runner(spawnError('ENOENT'))._run }).state, 'absent');

  // A hung binary: the probe's own timeout fired. It is installed.
  const timedOut = probeAgentRuntime(DESC, { _run: runner(spawnError('ETIMEDOUT'))._run });
  assert.equal(timedOut.state, 'timeout');
  assert.notEqual(timedOut.state, 'absent');

  // Installed, but not executable by this user.
  const denied = probeAgentRuntime(DESC, { _run: runner(spawnError('EACCES'))._run });
  assert.equal(denied.state, 'unreadable');
  assert.notEqual(denied.state, 'absent');

  // A descriptor so malformed that the runner itself throws is not evidence
  // that the binary is missing either.
  const thrown = probeAgentRuntime(DESC, { _run: () => { throw new TypeError('The "file" argument must be of type string'); } });
  assert.notEqual(thrown.state, 'absent');
});

test('formatRuntimeNotice: a timed-out or unexecutable binary is NEVER told to install itself', () => {
  for (const state of ['timeout', 'unreadable']) {
    const notice = formatRuntimeNotice({
      state, name: 'fake-agent', bin: 'fakeagent', installed: null, latest: null,
      updateHint: 'npm install -g @fake/agent@latest', detail: 'spawn fakeagent ETIMEDOUT',
    });
    assert.doesNotMatch(notice.message, /not installed/i, `${state} must not claim the binary is missing`);
    assert.doesNotMatch(notice.hint ?? '', /^Install it with/, `${state} must not advise installing it`);
    // …and it must actually SAY something about this state, not fall through to
    // the catch-all — which would satisfy the two assertions above vacuously.
    assert.doesNotMatch(notice.message, /unrecognized runtime state/, `${state} has no case of its own`);
  }
  const timedOut = formatRuntimeNotice({ state: 'timeout', name: 'fake-agent', bin: 'fakeagent', installed: null, latest: null, updateHint: 'x', detail: 'spawn fakeagent ETIMEDOUT' });
  assert.match(timedOut.message, /did not answer|timed out/i);
});

test('RUNTIME_STATES: every listed state has its own notice — none falls through to default', () => {
  // The list and the switch used to be two unbound copies: adding a state here
  // without a `case` there degraded silently into the catch-all.
  for (const state of RUNTIME_STATES) {
    const notice = formatRuntimeNotice({ state, name: 'x', bin: 'x', installed: '1.0.0', latest: '1.0.0', updateHint: 'y', detail: null }, 'some-harness');
    assert.doesNotMatch(notice.message, /unrecognized runtime state/, `${state} is listed but has no case`);
  }
});

test('agentRuntimeReport: a backend MISSING the export is not the same as one declaring null', async () => {
  const missing = await agentRuntimeReport({
    env: { AGENT_PLATFORM: 'forgetful' },
    _loadBackend: async () => ({ init: () => {} }),          // no AGENT_RUNTIME at all
    _run: () => { throw new Error('must not run'); },
  });
  const declared = await agentRuntimeReport({
    env: { AGENT_PLATFORM: 'deliberate' },
    _loadBackend: async () => ({ init: () => {}, AGENT_RUNTIME: null }),
    _run: () => { throw new Error('must not run'); },
  });

  assert.equal(declared.status.state, 'not-declared');
  assert.equal(missing.status.state, 'seam-missing');
  assert.notEqual(missing.status.state, declared.status.state);
  assert.notEqual(missing.notice.message, declared.notice.message);
  assert.equal(missing.notice.level, 'warn');
});

test('registry: EVERY backend implementing init() declares the runtime seam', async () => {
  // Replaces four hand-written per-backend assertions: a fifth backend added
  // tomorrow is covered by this one without anybody remembering to add a test.
  // The old `backends/` directory, split by axis in #1141.
  const { HARNESS_ADAPTER_AXES, harnessAdapterDir } = await import('./harness-adapter-url.mjs');
  const backends = [];
  for (const axis of HARNESS_ADAPTER_AXES) {
    const dir = harnessAdapterDir(axis);
    const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
    for (const f of files) {
      const mod = await import(new URL(f, dir));
      if (typeof mod.init === 'function') backends.push([`${axis}/${f}`, mod]);
    }
  }

  assert.ok(backends.length >= 4, `expected the known backends, found ${backends.length}`);
  for (const [f, mod] of backends) {
    assert.ok(Object.hasOwn(mod, 'AGENT_RUNTIME'), `${f} implements init() but declares no AGENT_RUNTIME`);
  }
});

test('probeAgentRuntime: two versions it cannot order are unknown-latest, never up-to-date', () => {
  // compareSemver ignores prerelease suffixes, so 2.0.0-alpha.3 vs 2.0.0 ranks
  // equal. Reporting "up to date" there states an ordering that was not measured.
  const { _run } = runner({
    [VERSION_CALL]: { status: 0, stdout: '2.0.0-alpha.3\n', stderr: '' },
    [LATEST_CALL]: { status: 0, stdout: '2.0.0\n', stderr: '' },
  });
  const status = probeAgentRuntime(DESC, { _run });

  assert.equal(status.state, 'unknown-latest');
  assert.equal(status.installed, '2.0.0-alpha.3');
  assert.match(status.detail, /2\.0\.0/);
});

test('defaultRun: a hung command is cut off, it does not block day:start forever', async () => {
  const { defaultRun, RUN_TIMEOUT_MS } = await import('./agent-runtime.mjs');
  assert.ok(RUN_TIMEOUT_MS > 0 && RUN_TIMEOUT_MS <= 30_000, `implausible timeout: ${RUN_TIMEOUT_MS}`);

  const started = Date.now();
  const r = defaultRun(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 300 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5_000, `defaultRun waited ${elapsed}ms — no timeout is being passed to spawnSync`);
  assert.ok(r.error || r.signal, 'a timed-out spawn must surface as error/signal, not as a clean exit');
});

// ── cwd: #682's cold review, judgment:cold-4 ─────────────────────────────────
//
// THE ORACLE HAS TO BE THE REAL RUNNER. `runStage` has always passed
// `{ cwd, timeoutMs }` and `defaultRun` destructured only `timeoutMs`, so the
// engine ran wherever the parent happened to stand. Every caller-side test
// hands in a spy, and a spy records the `cwd` it was GIVEN however the real
// runner treats it — which is exactly why the drop survived: `run-stage.test.mjs`
// asserts `opts.timeoutMs` reaches the runner and asserts nothing about the
// directory the child actually got. So this spawns a real child and asks IT.

test('#682 cold-4: defaultRun runs the child in the cwd it was given', async () => {
  const { defaultRun } = await import('./agent-runtime.mjs');
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // realpath, because macOS resolves /tmp through a symlink and the child
  // reports the resolved path — a mismatch there would be the test's bug.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'brain-cwd-')));

  const r = defaultRun(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir });
  assert.equal(
    realpathSync(r.stdout.trim()), dir,
    'the child ran somewhere else — a cwd threaded through four layers and dropped at the last one ' +
    'makes the engine review an unrelated tree while the verdict binds itself to the PR head'
  );

  // And an absent cwd still means inherit: the probe callers pass none, and
  // defaulting it to anything but the parent would move every version probe.
  const inherited = defaultRun(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {});
  assert.equal(
    realpathSync(inherited.stdout.trim()), realpathSync(process.cwd()),
    'no cwd must keep meaning "inherit" — probeAgentRuntime depends on it'
  );
});

test('platformEnvVars: BOTH axis keys reach resolvePlatform, not just AGENT_PLATFORM', () => {
  // ADR-0024 keeps SDD_HARNESS as the legacy fallback; a repo declaring only
  // SDD_HARNESS=antigravity must not silently resolve to the claude default.
  // (#1125: this read `claude` while `antigravity` was the default; with the
  // default flipped, `claude` would pass even if SDD_HARNESS were never read, so
  // the stated value moved to the one that differs from the default.)
  const seen = [];
  const read = (key) => { seen.push(key); return key === 'SDD_HARNESS' ? 'antigravity' : null; };
  const envVars = platformEnvVars(read);

  assert.ok(seen.includes('AGENT_PLATFORM'), 'AGENT_PLATFORM must be read');
  assert.ok(seen.includes('SDD_HARNESS'), 'SDD_HARNESS must be read');
  assert.equal(resolvePlatform({ env: {}, envVars }), 'antigravity');
});

test('platformConfig: a harness section of the WRONG shape degrades to {}, never to a crash', () => {
  // resolvePlatform reads config.platform / config.harness; a consumer writing
  // "harness": "claude" passes a STRING where an object is expected.
  assert.deepEqual(platformConfig({ harness: 'claude' }), { harness: 'claude' });
  assert.deepEqual(platformConfig({ harness: { platform: 'claude' } }), { platform: 'claude' });
  assert.deepEqual(platformConfig({}), {});
  assert.deepEqual(platformConfig(null), {});
  // #1125: `antigravity`, not `claude` — the default must not satisfy this.
  assert.equal(resolvePlatform({ env: {}, envVars: {}, config: platformConfig({ harness: 'antigravity' }) }), 'antigravity');
});

// ── env: #682's SECOND cold review, judgment:cold-2 ──────────────────────────
//
// Same shape as cold-4 above and the same reason for the same oracle. The
// finding was that `defaultRun` called `spawnSync` with no `env` key at all, so
// the producer inherited `process.env` WHOLE — `BRAIN_REVIEWER_TOKEN` included,
// measured — while `runStage`'s docstring said in capitals that it holds no
// credential. A spy would have recorded whatever `env` it was handed however
// the real runner treated it, so the oracle spawns a child and asks IT.

test('#682 cold-2: defaultRun gives the child the env it was given, and nothing else', async () => {
  const { defaultRun } = await import('./agent-runtime.mjs');

  const READ = ['-e', 'process.stdout.write(JSON.stringify({t: process.env.BRAIN_REVIEWER_TOKEN ?? null, k: process.env.BRAIN_TEST_KEEP ?? null}))'];

  // SET IT FIRST. A parent that never held the credential proves nothing about
  // whether the child would have inherited it — the assertion has to be that a
  // var PRESENT in `process.env` and absent from the passed `env` does not
  // arrive, which is the exact condition the finding measured.
  // Named rather than spelt inline: `check-refs.mjs`'s `hardcoded-secret` rule
  // matches `TOKEN = "…"` and its rule file carries no exemptions on purpose
  // (#616 — a dead exemption blinds the rule for that path).
  const MARKER = 'fixture-marker';
  process.env.BRAIN_REVIEWER_TOKEN = MARKER;
  let r;
  try {
    const { BRAIN_REVIEWER_TOKEN: _drop, ...rest } = process.env;
    r = defaultRun(process.execPath, READ, { env: { ...rest, BRAIN_TEST_KEEP: 'kept' } });
  } finally {
    delete process.env.BRAIN_REVIEWER_TOKEN;
  }
  const seen = JSON.parse(r.stdout);
  assert.equal(
    seen.t, null,
    'the child read a credential the caller removed — an env dropped at the last layer ' +
    'hands the producer the token ADR-0033 says it does not hold'
  );
  assert.equal(seen.k, 'kept', 'the rest of the environment must survive — the engine needs PATH to run at all');
});

test('#682 cold-2: an absent env still means INHERIT — every probe caller depends on it', async () => {
  const { defaultRun } = await import('./agent-runtime.mjs');

  const marker = 'brain-inherit-probe';
  process.env.BRAIN_TEST_INHERIT = marker;
  try {
    const r = defaultRun(
      process.execPath,
      ['-e', 'process.stdout.write(String(process.env.BRAIN_TEST_INHERIT ?? ""))'],
      {},
    );
    assert.equal(
      r.stdout.trim(), marker,
      'no env must keep meaning "inherit": probeAgentRuntime reads versions through PATH, ' +
      'the proxy vars and the npm registry config, and an empty environment reports every ' +
      'runtime absent'
    );
  } finally {
    delete process.env.BRAIN_TEST_INHERIT;
  }
});
