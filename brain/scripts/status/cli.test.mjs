// cli.test.mjs — issue #280, slice 1. The read-only property is the one that
// cannot be argued: it is proved by a port that throws on every write verb.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runStatus } from './cli.mjs';

/** Every write verb the port declares, as a landmine. */
const WRITE_VERBS = [
  'issueCreate', 'issueUpdate', 'issueComment', 'labelAdd', 'labelRemove',
  'mrCreate', 'prReviewComment', 'branchProtect', 'authLogin',
];

function readOnlyVcs({ issue = null, throwOnRead = null } = {}) {
  const called = [];
  const vcs = {
    called,
    issueView: async (args) => {
      called.push('issueView');
      if (throwOnRead) throw new Error(throwOnRead);
      return issue;
    },
  };
  for (const verb of WRITE_VERBS) {
    vcs[verb] = async () => {
      throw new Error(`READ-ONLY VIOLATION: brain:status called the write verb "${verb}"`);
    };
  }
  return vcs;
}

const GIT = {
  branch: 'feat/issue-280', ahead: 2, behind: 0, dirtyFiles: 0, pushed: true,
};

test('runStatus: prints all sections with the ticket first', async () => {
  const out = [];
  const code = await runStatus({
    issueNumber: 682,
    log: (s) => out.push(s),
    deps: {
      vcs: readOnlyVcs({ issue: { number: 682, state: 'closed', stateReason: 'completed', labels: ['status:approved'], title: 't' } }),
      gitFacts: () => GIT,
      readTasks: () => '- [x] A.1\n- [ ] C.6 close the issue\n',
      project: 'o/r',
    },
  });
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.ok(text.indexOf('Ticket #682') < text.indexOf('Chain position'),
    'the authority is read before the local evidence');
  assert.match(text, /Divergence/);
});

test('runStatus: NO write verb is reachable — the port throws on all of them', async () => {
  // ACCEPTANCE ITEM 2 OF #280, and the reason it is a spy rather than a review:
  // "read-only" asserted in a docstring is the class of claim this repo keeps
  // finding unenforced. Here the port itself refuses.
  const out = [];
  const vcs = readOnlyVcs({ issue: { number: 1, state: 'open', labels: [], title: 't' } });
  const code = await runStatus({
    issueNumber: 1, log: (s) => out.push(s),
    deps: { vcs, gitFacts: () => GIT, readTasks: () => '', project: 'o/r' },
  });
  assert.equal(code, 0, 'a run that touched a write verb would have thrown');
  assert.deepEqual(vcs.called, ['issueView'], 'exactly one read, and nothing else');
});

test('runStatus: the measured divergence is REPORTED — closed ticket, open task', async () => {
  // issue-682's C.6: unchecked while the issue was closed/completed, and nothing
  // anywhere said the two disagreed.
  const out = [];
  await runStatus({
    issueNumber: 682, log: (s) => out.push(s),
    deps: {
      vcs: readOnlyVcs({ issue: { number: 682, state: 'closed', stateReason: 'completed', labels: [], title: 't' } }),
      gitFacts: () => GIT,
      readTasks: () => '- [x] A.1\n- [ ] C.6 close the issue\n',
      project: 'o/r',
    },
  });
  assert.match(out.join('\n'), /DIVERGE — ticket is closed and tasks\.md has 1 open/);
});

test('runStatus: OFFLINE — the disk sections survive intact', async () => {
  // #280 acceptance item 3. A dead network must leave what IS knowable readable:
  // an all-or-nothing report gives the operator nothing exactly when they have
  // least.
  const out = [];
  const code = await runStatus({
    issueNumber: 682, log: (s) => out.push(s),
    deps: {
      vcs: readOnlyVcs({ throwOnRead: 'gh api failed: network is unreachable' }),
      gitFacts: () => GIT,
      readTasks: () => '- [x] A.1\n- [ ] C.6\n',
      project: 'o/r',
    },
  });
  const text = out.join('\n');
  assert.equal(code, 0, 'an unreachable forge is a degraded report, not a failed run');
  assert.match(text, /uncomputable \(gh api failed: network is unreachable\)/);
  assert.match(text, /feat\/issue-280/, 'the git facts are intact');
  assert.match(text, /open\s+1/, 'the tasks facts are intact');
});

test('runStatus: it writes NOTHING to disk either — no artefact, no state', async () => {
  // "Zero memory: everything re-derived per invocation." Two runs on the same
  // facts render identically, and neither leaves anything behind for the other.
  const a = [], b = [];
  const deps = () => ({
    vcs: readOnlyVcs({ issue: { number: 1, state: 'open', labels: [], title: 't' } }),
    gitFacts: () => GIT, readTasks: () => '- [ ] x\n', project: 'o/r',
  });
  await runStatus({ issueNumber: 1, log: (s) => a.push(s), deps: deps() });
  await runStatus({ issueNumber: 1, log: (s) => b.push(s), deps: deps() });
  assert.deepEqual(a, b, 'a report that varies between two runs cannot be diffed after a crash');
});
