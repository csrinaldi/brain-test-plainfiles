// plainfiles.save.test.mjs — unit tests for axes/memory/adapters/plainfiles.mjs#save (C3,
// issue #246, REQ-C3-2; provenance rewired at #738). Every seam is injected
// (root, getBranch, getTimestamp, getHostname, getGitConfig, getEnv) so no
// real git/clock/hostname/env dependency runs in `npm test`.
//
// #738: `actor` is now the configured `brain.actor` handle (never the
// branch); `actorKind` is measured from the agent-marker env (never a
// door-typed constant); `issue` is declared or derived from the branch. Every
// call site below injects `getGitConfig`/`getEnv` explicitly — leaving either
// to its real default would read this MACHINE's ambient git config / process
// env (this very session has `AI_AGENT` set), making the suite's verdict
// depend on where it runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { save } from './plainfiles.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'plainfiles-save-'));
}

// A deterministic identity: `brain.actor` resolves, no agent marker set.
// Spread into a seam bag and override individual keys per test as needed.
const identitySeams = {
  getGitConfig: (key) => (key === 'brain.actor' ? '@test' : null),
  getEnv: () => ({}),
};

// ── 2.1 — a secret hit aborts BEFORE appendRecord: no write, no index change ──

test('save: a secret hit aborts before any write (fail-closed, no index change)', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(() =>
      save(
        'leaked token',
        'ghp_abcdefghijklmnopqrstuvwx',
        { type: 'discovery', project: 'brain' },
        {
          root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'host1',
          ...identitySeams,
        },
      ),
    );
    assert.equal(existsSync(join(root, '.memory', 'records')), false, 'no records/ dir should be created on a secret hit');
    assert.equal(existsSync(join(root, '.memory', 'index.jsonl')), false, 'no index should be written on a secret hit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2.2 — a successful save records MEASURED provenance, not caller input ────

test('save: argument shape has no actor/actorKind/ts field; actor is the configured handle, never the branch', async () => {
  const root = tmpRoot();
  try {
    const opts = { type: 'discovery', project: 'brain' };
    // The options bag itself must never carry these fields — asserting this
    // documents the spoof-resistance contract at the call site.
    assert.equal('actor' in opts, false);
    assert.equal('actorKind' in opts, false);
    assert.equal('ts' in opts, false);

    const result = await save('a title', 'the body', opts, {
      root,
      getBranch: () => 'feat/some-branch',
      getTimestamp: () => '2026-07-12T09:41:07Z',
      getHostname: () => 'my-host',
      ...identitySeams,
    });

    assert.equal(result.written, true);
    assert.ok(result.id.startsWith('rec-'));
    assert.ok(existsSync(result.file), 'the returned file path must exist');

    const raw = readFileSync(result.file, 'utf8').trim();
    const record = JSON.parse(raw);
    assert.equal(record.actor, '@test', 'actor must come from the configured brain.actor handle, never the branch');
    assert.notEqual(record.actor, 'feat/some-branch', 'the branch must never reach actor');
    assert.equal(record.actorKind, 'human', 'actorKind is measured — no agent marker means human');
    assert.equal(record.ts, '2026-07-12T09:41:07Z', 'ts must come from the injected getTimestamp seam');
    assert.equal(record.id, result.id);

    // rebuildIndex() must have run after the append.
    const indexPath = join(root, '.memory', 'index.jsonl');
    assert.ok(existsSync(indexPath), 'index.jsonl must be rebuilt after a successful save');
    const indexRaw = readFileSync(indexPath, 'utf8');
    assert.ok(indexRaw.includes(record.id), 'the rebuilt index must include the new record id');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('save: actorKind follows the injected agent-marker env', async () => {
  const root = tmpRoot();
  try {
    const result = await save('t', 'c', { type: 'discovery', project: 'brain' }, {
      root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'h',
      getGitConfig: (key) => (key === 'brain.actor' ? '@test' : null),
      getEnv: () => ({ AI_AGENT: 'claude-code' }),
    });
    const record = JSON.parse(readFileSync(result.file, 'utf8').trim());
    assert.equal(record.actorKind, 'agent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'save: a configured brain.agentEnv name is wired through to resolveActorKind, not just the default AI_AGENT ' +
    '(MINOR-3c, fresh-context review)',
  async () => {
    const root = tmpRoot();
    try {
      const result = await save('t', 'c', { type: 'discovery', project: 'brain' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'h',
        getGitConfig: (key) => {
          if (key === 'brain.actor') return '@test';
          if (key === 'brain.agentEnv') return 'MY_AGENT';
          return null;
        },
        getEnv: () => ({ MY_AGENT: 'x' }),
      });
      const record = JSON.parse(readFileSync(result.file, 'utf8').trim());
      assert.equal(record.actorKind, 'agent', 'a non-default agentEnv name must still be measured as agent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('save: source names the host and both instruments (actor + actorKind)', async () => {
  const root = tmpRoot();
  try {
    const result = await save('t', 'c', { type: 'discovery', project: 'brain' }, {
      root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'my-host',
      getGitConfig: (key) => (key === 'brain.actor' ? '@test' : null),
      getEnv: () => ({ AI_AGENT: 'claude-code' }),
    });
    const record = JSON.parse(readFileSync(result.file, 'utf8').trim());
    assert.match(record.source, /my-host/);
    assert.match(record.source, /brain\.actor/);
    assert.match(record.source, /AI_AGENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── fresh-context review MINOR 2 — scope/topic are ignored LOUDLY, never silently ──

function captureWarn(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  return fn().finally(() => { console.warn = orig; }).then((result) => ({ result, warnings }));
}

test('save: warns when --scope/--topic are passed (ignored — no home in the record format), naming them', async () => {
  const root = tmpRoot();
  try {
    const { result, warnings } = await captureWarn(() =>
      save('t', 'c', { type: 'discovery', project: 'brain', scope: 'project', topic: 'sdd/x/y' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'h',
        ...identitySeams,
      }),
    );
    assert.equal(result.written, true, 'the record must still be written normally');
    assert.equal(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(warnings[0].includes('scope'), `warning must name 'scope': ${warnings[0]}`);
    assert.ok(warnings[0].includes('topic'), `warning must name 'topic': ${warnings[0]}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('save: does NOT warn when scope/topic are absent', async () => {
  const root = tmpRoot();
  try {
    const { result, warnings } = await captureWarn(() =>
      save('t', 'c', { type: 'discovery', project: 'brain' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'h',
        ...identitySeams,
      }),
    );
    assert.equal(result.written, true);
    assert.deepEqual(warnings, [], 'no warning should fire when scope/topic are not passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2.4 — seam defaults: getBranch/getTimestamp/getHostname default to the real impls ──
// (getGitConfig/getEnv are still injected — this test is about the OTHER seams'
// real defaults, not about the ambient git identity of the machine running it.)

test('save: getBranch/getTimestamp/getHostname default to real implementations when not injected', async () => {
  const root = tmpRoot(); // NOT a git repo — real getBranch must fall back to 'unknown'
  try {
    const result = await save('another title', 'another body', { type: 'discovery', project: 'brain' }, {
      root, ...identitySeams,
    });
    assert.equal(result.written, true);

    const raw = readFileSync(result.file, 'utf8').trim();
    const record = JSON.parse(raw);
    assert.equal(record.actor, '@test', 'actor comes from the injected getGitConfig seam, never getBranch');
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'default getTimestamp must be C2a canonical UTC-seconds');
    assert.ok(record.source.startsWith('plainfiles save on '), 'source must fold in the (real or injected) hostname');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #738 — issue derivation from the branch ─────────────────────────────────

test('#738: --issue absent + a matching branch ⇒ issue derived + a stdout notice', async () => {
  const root = tmpRoot();
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const result = await save('t', 'c', { type: 'discovery', project: 'brain' }, {
      root, getBranch: () => 'feat/issue-738-x', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'h',
      ...identitySeams,
    });
    const record = JSON.parse(readFileSync(result.file, 'utf8').trim());
    assert.equal(record.issue, 738);
    // The notice's exact wording (naming '738' and the branch) is asserted
    // once the i18n catalog carries it — unit 5. Here: a notice fires at all.
    assert.equal(logs.length, 1, `expected exactly one stdout notice, got: ${JSON.stringify(logs)}`);
  } finally {
    console.log = origLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test('#738: --issue absent + a non-matching branch ⇒ issue stays absent', async () => {
  const root = tmpRoot();
  try {
    const result = await save('t', 'c', { type: 'discovery', project: 'brain' }, {
      root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'h',
      ...identitySeams,
    });
    const record = JSON.parse(readFileSync(result.file, 'utf8').trim());
    assert.ok(!('issue' in record), 'issue must stay absent, never fabricated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #738 — capture refuses without a configured handle ──────────────────────

test('#738: brain.actor unset ⇒ throws, nothing appended (records dir stays empty)', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(() =>
      save('t', 'c', { type: 'discovery', project: 'brain' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'h',
        getGitConfig: () => null, getEnv: () => ({}),
      }),
    );
    assert.equal(existsSync(join(root, '.memory', 'records')), false, 'nothing may be appended when the actor is unset');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #738 unit 7 — brain's own capture path can never emit @legacy ───────────
// `@legacy` is the export fallback's sentinel (engram-export.mjs). Without
// `resolveActor`'s reserved-value refusal, `git config brain.actor @legacy`
// would mint that sentinel through THIS door too, making "brain's own capture
// path never emits @legacy" true only by convention. Kills the mutant "a
// fallback in buildRecord defaults to @legacy" — no new production code here,
// true once units 2 (resolveActor) and 4 (plainfiles wiring) land.

test('#738 pin: brain.actor=@legacy is refused (reserved), never reaches a written record', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(() =>
      save('t', 'c', { type: 'discovery', project: 'brain' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'h',
        getGitConfig: (key) => (key === 'brain.actor' ? '@legacy' : null), getEnv: () => ({}),
      }),
    );
    assert.equal(existsSync(join(root, '.memory', 'records')), false, '@legacy must never be appended through the capture door');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#738 pin: a normal-handle capture never produces a record with actor === @legacy', async () => {
  const root = tmpRoot();
  try {
    const result = await save('t', 'c', { type: 'discovery', project: 'brain' }, {
      root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'h',
      ...identitySeams,
    });
    const record = JSON.parse(readFileSync(result.file, 'utf8').trim());
    assert.notEqual(record.actor, '@legacy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#738: brain.actor malformed (not handle-shaped) ⇒ throws, nothing appended', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(() =>
      save('t', 'c', { type: 'discovery', project: 'brain' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-07-12T09:00:00Z', getHostname: () => 'h',
        getGitConfig: (key) => (key === 'brain.actor' ? 'csrinaldi' : null), getEnv: () => ({}),
      }),
    );
    assert.equal(existsSync(join(root, '.memory', 'records')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// #530 — THE MOST OBVIOUS INVOCATION OF THE CAPTURE PATH USED TO CRASH.
//
// Every test above passes BOTH `type` and `project`, so the omission path had
// zero coverage and `memory save "t" "c"` reached `computeRecordId` →
// `canonicalJson` and threw `unsupported value type 'undefined'` — a message
// naming neither the field nor the flag.
//
// The two are not symmetric, and that asymmetry is the fix: `project` is a FACT
// about this repository and the config already carries it, so deriving it is not
// a default but a read. `type` is a CHOICE among seven, and defaulting it would
// stamp a fabricated meaning onto a durable record.
// ═══════════════════════════════════════════════════════════════════════════

test('#530: save without a type REFUSES by name, listing the choices — never a crash, never a default', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(
      () => save('t', 'c', { project: 'brain' },
        { root, getBranch: () => 'main', getTimestamp: () => '2026-08-11T09:00:00Z', getHostname: () => 'h', ...identitySeams }),
      (err) => {
        assert.match(err.message, /--type/, 'the refusal must name the flag the caller has to supply');
        assert.match(err.message, /session_summary/, 'and list the valid values, or it is a riddle');
        assert.doesNotMatch(err.message, /canonicalJson|undefined/,
          'the old message named an internal serializer and neither the field nor the flag');
        return true;
      },
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#530: save without a project DERIVES it from the config slug — a fact, not a choice', async () => {
  const root = tmpRoot();
  try {
    const r = await save('t', 'c', { type: 'discovery' }, {
      root,
      getBranch: () => 'main',
      getTimestamp: () => '2026-08-11T09:00:00Z',
      getHostname: () => 'h',
      _loadConfig: () => ({ project: { slug: 'csrinaldi/brain' } }),
      ...identitySeams,
    });
    const line = readFileSync(r.file, 'utf8').trim().split('\n').pop();
    assert.equal(JSON.parse(line).project, 'brain',
      'records in this repo carry the bare name, not the owner/repo slug');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#530: the derivation falls back slug → name → directory, and never lands undefined', async () => {
  for (const [config, expected, why] of [
    [{ project: { slug: 'o/repo-a' } }, 'repo-a', 'slug wins'],
    [{ project: { slug: '', name: 'repo-b' } }, 'repo-b', 'an empty slug is not a value'],
    [{}, null, 'no config at all still yields a name, never undefined'],
  ]) {
    const root = tmpRoot();
    try {
      const r = await save('t', 'c', { type: 'discovery' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-08-11T09:00:00Z',
        getHostname: () => 'h', _loadConfig: () => config, ...identitySeams,
      });
      const rec = JSON.parse(readFileSync(r.file, 'utf8').trim().split('\n').pop());
      assert.equal(typeof rec.project, 'string', why);
      assert.notEqual(rec.project, '', why);
      if (expected) assert.equal(rec.project, expected, why);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('#530: an explicit project still wins over the derivation', async () => {
  const root = tmpRoot();
  try {
    const r = await save('t', 'c', { type: 'discovery', project: 'explicit' }, {
      root, getBranch: () => 'main', getTimestamp: () => '2026-08-11T09:00:00Z',
      getHostname: () => 'h', _loadConfig: () => ({ project: { slug: 'o/derived' } }), ...identitySeams,
    });
    assert.equal(JSON.parse(readFileSync(r.file, 'utf8').trim().split('\n').pop()).project, 'explicit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#530: --issue lands as an INTEGER, so a record can be tied to its ticket', async () => {
  const root = tmpRoot();
  try {
    const r = await save('t', 'c', { type: 'discovery', project: 'brain', issue: 530 }, {
      root, getBranch: () => 'main', getTimestamp: () => '2026-08-11T09:00:00Z', getHostname: () => 'h', ...identitySeams,
    });
    const rec = JSON.parse(readFileSync(r.file, 'utf8').trim().split('\n').pop());
    assert.equal(rec.issue, 530);
    assert.equal(typeof rec.issue, 'number', 'a string here is what #368 measured across 2157 records');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#530: a non-integer --issue is refused BY NAME, not by an internal serializer', async () => {
  // `validateWritableRecord`'s W2 already says "issue must be an integer" and is
  // UNREACHABLE for a non-numeric one: `computeRecordId` hashes the field and
  // `canonicalJson` throws on NaN first. So the rule read as enforced while the path
  // never arrived, and `--issue abc` failed with "non-finite numbers are not
  // supported" — right direction, useless message.
  const root = tmpRoot();
  try {
    await assert.rejects(
      () => save('t', 'c', { type: 'discovery', project: 'brain', issue: Number('abc') }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-08-11T09:00:00Z', getHostname: () => 'h', ...identitySeams,
      }),
      (err) => {
        assert.match(err.message, /--issue/, 'name the flag the caller typed');
        assert.doesNotMatch(err.message, /canonicalJson|non-finite/, 'not the serializer that happened to notice');
        return true;
      },
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#530: an absent --issue is still allowed — tagging is encouraged, not compulsory', async () => {
  const root = tmpRoot();
  try {
    const r = await save('t', 'c', { type: 'discovery', project: 'brain' }, {
      root, getBranch: () => 'main', getTimestamp: () => '2026-08-11T09:00:00Z', getHostname: () => 'h', ...identitySeams,
    });
    const rec = JSON.parse(readFileSync(r.file, 'utf8').trim().split('\n').pop());
    assert.ok(!('issue' in rec), 'the field is optional and must stay absent rather than land null');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// #805 — the supersedes gate: two injectable seams (_readRecordIds,
// _upstreamRecordEntries), placed between the `issue` refusal and
// `buildRecord`, short-circuiting entirely when `supersedes` is absent.
// ═══════════════════════════════════════════════════════════════════════════

const defaultSaveSeams = (root, extra = {}) => ({
  root,
  getBranch: () => 'main',
  getTimestamp: () => '2026-09-10T09:00:00Z',
  getHostname: () => 'h',
  // MERGE NOTE (#738 × #805): `identitySeams` is not optional garnish here.
  // These tests are about the supersedes gate, and the actor gate now runs
  // BEFORE it — without a configured handle every case below would reject for
  // the actor reason and the supersedes assertions would never be reached.
  ...identitySeams,
  ...extra,
});

test('#805: a supersedes value reaches buildRecord — the written record carries the field', async () => {
  const root = tmpRoot();
  try {
    const target = 'rec-0123456789abcdef';
    const r = await save('t', 'c', { type: 'discovery', project: 'brain', supersedes: target }, defaultSaveSeams(root, {
      _readRecordIds: () => new Set([target]),
      _upstreamRecordEntries: () => { throw new Error('must not be called on a local hit'); },
    }));
    const rec = JSON.parse(readFileSync(r.file, 'utf8').trim().split('\n').pop());
    assert.equal(rec.supersedes, target);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#805: supersedes absent — neither new seam is called, the gate is a no-op', async () => {
  const root = tmpRoot();
  let readRecordIdsCalls = 0;
  let upstreamCalls = 0;
  try {
    await save('t', 'c', { type: 'discovery', project: 'brain' }, defaultSaveSeams(root, {
      _readRecordIds: () => { readRecordIdsCalls += 1; return new Set(); },
      _upstreamRecordEntries: () => { upstreamCalls += 1; return { ok: true, byId: new Map() }; },
    }));
    assert.equal(readRecordIdsCalls, 0, 'no supersedes flag means no local read at all');
    assert.equal(upstreamCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#805: a local hit never calls the upstream seam (thunk discipline, A1)', async () => {
  const root = tmpRoot();
  let upstreamCalls = 0;
  try {
    const target = 'rec-0123456789abcdef';
    await save('t', 'c', { type: 'discovery', project: 'brain', supersedes: target }, defaultSaveSeams(root, {
      _readRecordIds: () => new Set([target]),
      _upstreamRecordEntries: () => { upstreamCalls += 1; return { ok: true, byId: new Map() }; },
    }));
    assert.equal(upstreamCalls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// fresh-context review MINOR-2 — the `verdict.configError` warn branch
// (plainfiles.mjs:140-142) had no direct test: it fires when the upstream
// check still succeeds (ok:true, the id IS in the store) but
// `brain.config.json` itself could not be read while resolving the ref.
test('#805: a configError on an otherwise-ok upstream verdict warns but still writes the record', async () => {
  const root = tmpRoot();
  try {
    const target = 'rec-0123456789abcdef';
    const { result, warnings } = await captureWarn(() =>
      save('t', 'c', { type: 'discovery', project: 'brain', supersedes: target }, defaultSaveSeams(root, {
        _readRecordIds: () => new Set(),
        _upstreamRecordEntries: () => ({
          ok: true,
          ref: 'origin/main',
          byId: new Map([[target, 'b']]),
          configError: 'bad json',
        }),
      })),
    );
    assert.equal(result.written, true, 'a configError must not block the write once the id is verified');
    assert.equal(warnings.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(warnings[0].includes('bad json'), `warning must carry the configError detail: ${warnings[0]}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// cold-review blocker — a malformed id must be refused by grammar alone,
// with ZERO IO: no local store read, no upstream check. Before this fix,
// `_readRecordIds` ran unconditionally one statement before the shape check,
// so a malformed id still read the store from disk before being rejected.
test('#805: a malformed supersedes id is refused before the store is read — no IO at all', async () => {
  const root = tmpRoot();
  let readRecordIdsCalls = 0;
  let upstreamCalls = 0;
  try {
    await assert.rejects(
      () => save('t', 'c', { type: 'discovery', project: 'brain', supersedes: 'not-a-valid-id' }, defaultSaveSeams(root, {
        _readRecordIds: () => { readRecordIdsCalls += 1; return new Set(); },
        _upstreamRecordEntries: () => { upstreamCalls += 1; return { ok: true, byId: new Map() }; },
      })),
    );
    assert.equal(readRecordIdsCalls, 0, 'a malformed id is refused by grammar alone — the store must never be read');
    assert.equal(upstreamCalls, 0, 'a malformed id must never reach the upstream check either');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [label, opts] of [
  ['malformed', { supersedes: 'not-a-valid-id', _readRecordIds: () => new Set(), _upstreamRecordEntries: () => { throw new Error('must not be called'); } }],
  ['not-in-store', { supersedes: 'rec-0123456789abcdef', _readRecordIds: () => new Set(), _upstreamRecordEntries: () => ({ ok: true, ref: 'origin/main', byId: new Map() }) }],
  ['could-not-verify', { supersedes: 'rec-0123456789abcdef', _readRecordIds: () => new Set(), _upstreamRecordEntries: () => ({ ok: false, ref: null, reason: 'no upstream ref resolved (tried origin/HEAD, origin/main)' }) }],
]) {
  test(`#805: a ${label} supersedes refusal rejects with no write, no index change, no indexFailed`, async () => {
    const root = tmpRoot();
    const { supersedes, _readRecordIds, _upstreamRecordEntries } = opts;
    try {
      await assert.rejects(
        () => save('t', 'c', { type: 'discovery', project: 'brain', supersedes }, defaultSaveSeams(root, {
          _readRecordIds, _upstreamRecordEntries,
        })),
        (err) => {
          assert.equal(err.indexFailed, undefined, 'a refusal must never carry indexFailed — nothing was written');
          return true;
        },
      );
      assert.equal(existsSync(join(root, '.memory', 'records')), false, `no records/ dir should be created on a ${label} refusal`);
      assert.equal(existsSync(join(root, '.memory', 'index.jsonl')), false, `no index should be written on a ${label} refusal`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

// ── #712 — a secret policy that cannot be read is not the default secret
// policy. `_loadConfig` is NOT injected in either test below — it is the
// unit. `_readRecordIds`/`_upstreamRecordEntries` are injected as no-ops
// only for shape parity with engram.save.test.mjs's T-E1/T-E2 (this file's
// `save()` never reaches them without `--supersedes`); `identitySeams` (via
// `defaultSaveSeams`) neutralizes the actor gate, which otherwise throws
// its own refusal a few lines after the config read.

test('T-P1 — an unreadable brain.config.json makes save() reject, and _appendRecord is never called (#712, REQ-SCAN-1/4/5)', async () => {
  const root = tmpRoot();
  try {
    // present but unparseable, at `root` — the exact path `_defaultLoadBrainConfig` reads.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'brain.config.json'), '{ not valid json', 'utf8');

    let appendCalled = false;
    await assert.rejects(
      () => save('t', 'c', { type: 'discovery', project: 'brain' }, defaultSaveSeams(root, {
        _appendRecord: () => { appendCalled = true; return { file: 'x' }; },
        _readRecordIds: () => new Set(),
        _upstreamRecordEntries: () => ({ ok: true, ids: new Set() }),
      })),
      (err) => {
        assert.match(err.message, /brain\.config\.json/, 'the message must name the file');
        assert.match(err.message, /could not be parsed/, 'the message must name the failure kind');
        return true;
      },
    );
    assert.equal(appendCalled, false, '_appendRecord must never run when the config read refuses');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-P2 — no brain.config.json at all leaves save() on the default pattern set, record written (#712, REQ-SCAN-3)', async () => {
  const root = tmpRoot();
  try {
    // no brain.config.json written — tmpRoot() never creates one.
    const result = await save('t', 'c', { type: 'discovery', project: 'brain' }, defaultSaveSeams(root));
    assert.equal(result.written, true, 'the absent-config case must not refuse — the default pattern set applies');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
