// ticket-new.test.mjs — issue #528.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, nextStepMessage, main } from './ticket-new.mjs';

const ORIGIN = { project: 'acme/x' };
const CONFIG = { vcs: { provider: 'github' } };

function capture() {
  const lines = [];
  return { lines, say: (s) => lines.push(String(s)) };
}

test('#528: parseArgs requires a title and collects repeated labels', () => {
  assert.deepEqual(parseArgs(['--title', 'T', '--label', 'a', '--label', 'b']),
    { ok: true, title: 'T', bodyFile: null, labels: ['a', 'b'] });
  assert.equal(parseArgs([]).ok, false);
  assert.equal(parseArgs(['--title', '   ']).ok, false, 'a blank title is not a title');
  assert.match(parseArgs(['--bogus']).error, /unknown argument/);
});

test('#528: the happy path creates through the port and returns 0', async () => {
  const { lines, say } = capture();
  const calls = [];
  const code = await main(['--title', 'fix(x): algo', '--label', 'type:bug'], {
    say, config: CONFIG, origin: ORIGIN,
    vcs: { issueCreate: async (a) => { calls.push(a); return { number: 531, url: 'https://h/531' }; } },
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].labels, ['type:bug']);
  assert.equal(calls[0].project, 'acme/x');
  assert.match(lines.join('\n'), /#531/);
});

// The instruction is asserted from the SAME function the CLI prints, not a copy of
// its text — an instruction verified against a duplicate is an instruction nobody
// proved, which is the defect #518 records one layer up.
test('#528: the next step names the human approval, and names it by its RESOLVED label', () => {
  const msg = nextStepMessage({ number: 531, url: 'https://h/531' }, 'status::approved');
  assert.match(msg, /a HUMAN applies "status::approved"/);
  assert.match(msg, /brain cannot/);
  assert.match(msg, /brain:ticket:start -- 531/);
});

test('#528: a policy refusal from the port surfaces as itself, not as a transport error', async () => {
  const { lines, say } = capture();
  const code = await main(['--title', 'T', '--label', 'status:approved'], {
    say, config: CONFIG, origin: ORIGIN,
    vcs: { issueCreate: async () => { throw new Error('vcs: refusing … HUMAN signature (#124)'); } },
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /HUMAN signature/);
  assert.ok(!lines.join('\n').includes('could not create the issue'),
    'a refusal is not an outage — telling the caller to retry would be wrong');
});

test('#528: a transport failure is reported as one, and does not print a next step', async () => {
  const { lines, say } = capture();
  const code = await main(['--title', 'T'], {
    say, config: CONFIG, origin: ORIGIN,
    vcs: { issueCreate: async () => ({ number: null, url: null, error: 'HTTP 500' }) },
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /HTTP 500/);
  assert.ok(!lines.join('\n').includes('Next'), 'there is no next step when nothing was created');
});

test('#528: an unresolvable project refuses before any write is attempted', async () => {
  const { lines, say } = capture();
  let called = false;
  const code = await main(['--title', 'T'], {
    say, config: CONFIG, origin: { project: null },
    vcs: { issueCreate: async () => { called = true; return {}; } },
  });
  assert.equal(code, 2);
  assert.equal(called, false);
  assert.match(lines.join('\n'), /git remote/);
});
