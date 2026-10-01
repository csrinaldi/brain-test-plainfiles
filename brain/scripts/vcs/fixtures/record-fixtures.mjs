#!/usr/bin/env node
// record-fixtures.mjs — committed, re-runnable script that hits the real VCS
// APIs to refresh the fixture JSON files consumed by
// `axes/vcs/contract.test.mjs` (issue #239 A3 Phase 3, REQ-A3-6).
//
// NOT run by `npm test` — the contract suite reads the already-written JSON
// files, never the network (A2/A3's no-live-network discipline). Run this
// manually to REFRESH a recorded fixture without touching the suite:
//
//   node brain/scripts/vcs/fixtures/record-fixtures.mjs github labelEvents <project> <issueNumber>
//   node brain/scripts/vcs/fixtures/record-fixtures.mjs github prView <project> <prNumber>
//   node brain/scripts/vcs/fixtures/record-fixtures.mjs github issueView <project> <issueNumber>
//   node brain/scripts/vcs/fixtures/record-fixtures.mjs github mrList <project>
//   node brain/scripts/vcs/fixtures/record-fixtures.mjs github issueList <project>
//   node brain/scripts/vcs/fixtures/record-fixtures.mjs github prReviews <project> <prNumber>
//   node brain/scripts/vcs/fixtures/record-fixtures.mjs github commitPrs <project> <sha>
//
// Endpoints hit (documented per REQ-A3-6 — "documents which real endpoints it
// hits"):
//   - github labelEvents → `gh api --paginate repos/<project>/issues/<n>/events`
//   - github prView      → `gh pr view <n> --json number,labels,body,author`
//   - github issueView   → `gh api repos/<project>/issues/<n>` (issue #334, M10 Gap-A)
//   - github mrList      → `gh api repos/<project>/pulls?state=open&per_page=100` (issue #355, M10 Phase 2 rank-3)
//   - github issueList   → `gh api repos/<project>/issues?state=open&per_page=100` (issue #362, M10 Phase 2 rank-4)
//   - github prReviews   → `gh api --paginate repos/<project>/pulls/<n>/reviews` (issue #317)
//   - github commitPrs   → `gh api --paginate repos/<project>/commits/<sha>/pulls` (issue #1086, D3)
//
// Deliberately NOT auto-recorded by this script, ever:
//   - github mrCreate  → `gh pr create` is a MUTATING write (creates a real PR
//     in the target repo). Recording a "happy path" response would require
//     actually opening a live pull request as a side effect of fixture
//     maintenance — refused by design. `github-mrCreate-happy.json` is
//     authored (DERIVED) from `gh pr create`'s documented stdout contract
//     (a bare URL string) instead.
//   - every `gitlab-*` fixture → this script has no live GitLab mirror to
//     reach from a CI/sandboxed environment (no `glab`/GitLab session here).
//     GitLab fixtures are authored (DERIVED) from the documented GitLab REST
//     API v4 response shapes (resource_label_events, merge_requests show,
//     merge_requests create). CP-A3b (live GitLab round-trip) is deferred to
//     the self-hosted phase — see tasks.md Open Questions. When a live mirror is
//     available, extend this script with a `gitlab` case here rather than
//     hand-authoring a new "recorded" gitlab-*.json.
//
// Every fixture this script writes is stamped `_provenance: { endpoint, date,
// recorded: true }`. Fixtures this script does NOT (and by design, for
// mrCreate/gitlab, never will) produce are hand-authored elsewhere with
// `_provenance.derived: true` — recorded-vs-derived is always visible
// (lesson #12); this script only ever writes `recorded: true` fixtures.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run, runJson } from '../lib/exec.mjs';

const FIXTURES_DIR = fileURLToPath(new URL('.', import.meta.url));

function writeFixture(name, provenance, data) {
  const payload = { _provenance: provenance, data };
  writeFileSync(`${FIXTURES_DIR}${name}`, JSON.stringify(payload, null, 2) + '\n');
  console.log(`wrote ${name} (${provenance.endpoint})`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function recordGithubLabelEvents(project, number) {
  const endpoint = `GET repos/${project}/issues/${number}/events`;
  const events = runJson('gh', ['api', '--paginate', `repos/${project}/issues/${number}/events`]);
  writeFixture(
    'github-labelEvents-happy.json',
    {
      endpoint,
      date: today(),
      recorded: true,
      note:
        'Trimmed to the fields github.mjs#labelEvents actually consumes (event, actor.login, ' +
        'label.name, created_at) via a jq-equivalent projection of the real response — values ' +
        'are unmodified from the live API, only unused per-actor GitHub metadata is dropped ' +
        'to keep the fixture reviewable.',
    },
    events.map(e => ({
      event: e.event,
      actor: e.actor ? { login: e.actor.login } : null,
      label: e.label ? { name: e.label.name } : undefined,
      created_at: e.created_at,
    })),
  );
}

async function recordGithubPrView(project, number) {
  const endpoint = `gh pr view ${number} --json number,labels,body,author (repo: ${project})`;
  const r = run('gh', ['pr', 'view', String(number), '--repo', project, '--json', 'number,labels,body,author']);
  if (!r.ok) throw new Error(`gh pr view ${number} failed: ${r.stderr}`);
  writeFixture(
    'github-prView-happy.json',
    { endpoint, date: today(), recorded: true },
    JSON.parse(r.stdout),
  );
}

/**
 * Records `github-issueView-happy.json` from a real issue via
 * `gh api repos/<project>/issues/<n>` — the exact call `github.mjs#issueView`
 * makes. Trimmed to the fields `issueView` actually consumes (number, title,
 * labels[].name, body, user.login), same discipline as `recordGithubLabelEvents`.
 * The recorded issue MUST carry a `type:*` label (M10 Gap-A / issue #334's
 * `ship-pr-label-resolution` spec needs a happy fixture whose label round-trips
 * through `findTypeLabel`).
 */
async function recordGithubIssueView(project, number) {
  const endpoint = `GET repos/${project}/issues/${number}`;
  const r = runJson('gh', ['api', `repos/${project}/issues/${number}`]);
  writeFixture(
    'github-issueView-happy.json',
    {
      endpoint,
      date: today(),
      recorded: true,
      note:
        'Trimmed to the fields github.mjs#issueView actually consumes (number, title, ' +
        'labels[].name, body, user.login) via a jq-equivalent projection of the real ' +
        'response — values are unmodified from the live API, only unused issue metadata ' +
        'is dropped to keep the fixture reviewable.',
    },
    {
      number: r.number,
      title: r.title,
      labels: (r.labels ?? []).map(l => ({ name: l.name })),
      body: r.body,
      user: { login: r.user?.login ?? null },
    },
  );
}

/**
 * Records `github-mrList-happy.json` from the exact call `github.mjs#mrList`
 * makes — `gh api repos/<project>/pulls?state=open&per_page=100` — then
 * projects the response down to `{ number, title, head: { ref } }` per entry,
 * same jq-equivalent trimming as `recordGithubLabelEvents`/`recordGithubIssueView`.
 * An untrimmed `pulls` response carries tens of kilobytes per PR of metadata
 * the normalizer never reads.
 *
 * Arity 1 (project only) — unlike every other case here, `mrList` is a
 * per-project read with no PR/issue number. The dispatch line below still
 * passes a second argument (`Number(number)`, `NaN` when omitted); it is
 * simply unread by this function.
 */
async function recordGithubMrList(project) {
  const endpoint = `GET repos/${project}/pulls?state=open&per_page=100`;
  const arr = runJson('gh', ['api', `repos/${project}/pulls?state=open&per_page=100`]);
  writeFixture(
    'github-mrList-happy.json',
    {
      endpoint,
      date: today(),
      recorded: true,
      note:
        'Trimmed to the fields github.mjs#mrList actually consumes (number, title, head.ref) ' +
        'via a jq-equivalent projection of the real response — values are unmodified from the ' +
        'live API, only unused per-PR metadata is dropped to keep the fixture reviewable.',
    },
    arr.map(r => ({ number: r.number, title: r.title, head: { ref: r.head.ref } })),
  );
}

/**
 * Records `github-issueList-happy.json` from the exact call
 * `github.mjs#issueList` makes — `gh api repos/<project>/issues?state=open&per_page=100`
 * — then projects the response down before writing (issue #362, M10 Phase 2
 * rank-4). Arity 1 (project only), same precedent as `recordGithubMrList` —
 * `issueList` is a per-project read with no issue number.
 *
 * The projection keeps **fields the normalizer reads, not fields it maps**:
 * `pull_request` is never emitted by `issueList`'s result, but `github.mjs`
 * reads it to filter PR entries out of the issues list — trimming it away
 * here would produce a fixture in which every entry survives the filter,
 * silently destroying the coverage this fixture exists to provide. `labels`
 * is kept as `[{ name }]` objects, NOT pre-flattened to strings, or the
 * label-unwrap assertion in the contract suite goes vacuous.
 */
async function recordGithubIssueList(project) {
  const endpoint = `GET repos/${project}/issues?state=open&per_page=100`;
  const arr = runJson('gh', ['api', `repos/${project}/issues?state=open&per_page=100`]);
  writeFixture(
    'github-issueList-happy.json',
    {
      endpoint,
      date: today(),
      recorded: true,
      note:
        'Trimmed to the fields github.mjs#issueList actually consumes — kept per the ' +
        '"fields the normalizer reads, not fields it maps" rule: pull_request (read as ' +
        'filter input, never emitted by the result) is kept as { url }, and labels is kept ' +
        'as [{ name }] objects rather than pre-flattened to strings, so the contract ' +
        'suite\'s PR-filter and label-unwrap assertions exercise real behavior, not a ' +
        'pre-normalized fixture.',
    },
    arr.map(r => ({
      number: r.number,
      title: r.title,
      labels: (r.labels ?? []).map(l => ({ name: l.name })),
      ...(r.pull_request ? { pull_request: { url: r.pull_request.url } } : {}),
    })),
  );
}

/**
 * Records `github-prReviews-happy.json` from the exact call
 * `github.mjs#prReviews` makes — `gh api --paginate repos/<project>/pulls/<n>/reviews`
 * (issue #317).
 *
 * The recorded PR MUST have at least one review whose body carries a real
 * `brain-review/N` fenced block. That is the entire point of this fixture:
 * the contract suite runs the REAL normalizer output through `parseVerdict`
 * and asserts a verdict is recovered. Before #317 the normalizer dropped
 * `body`, so `cold-boot`'s `priorVerdicts` was always `[]` in production
 * while its tests stayed green on injected bodies no adapter ever emitted —
 * a fixture recorded from live traffic is what makes that masking
 * impossible to reintroduce.
 *
 * `body` is kept VERBATIM and untruncated, unlike the field-trimming the
 * other recorders apply: a truncated body would lose the closing fence and
 * `parseVerdict` would return `null`, turning the suite's central assertion
 * into a false negative.
 */
async function recordGithubPrReviews(project, number) {
  const endpoint = `GET repos/${project}/pulls/${number}/reviews`;
  const arr = runJson('gh', ['api', '--paginate', `repos/${project}/pulls/${number}/reviews`]);
  writeFixture(
    'github-prReviews-happy.json',
    {
      endpoint,
      date: today(),
      recorded: true,
      note:
        'Trimmed to the fields github.mjs#prReviews actually consumes (state, user.login, ' +
        'body) via a jq-equivalent projection of the real response — values are unmodified ' +
        'from the live API. body is kept VERBATIM and untruncated: it carries the real ' +
        'brain-review/1 fenced block the contract suite feeds through parseVerdict, and ' +
        'truncating it would drop the closing fence and silently defeat that assertion.',
    },
    arr.map(r => ({ state: r.state, user: { login: r.user?.login ?? null }, body: r.body })),
  );
}

/**
 * Records `github-commitPrs-happy.json` from the exact call
 * `github.mjs#commitPrs` makes — `gh api --paginate repos/<project>/commits/<sha>/pulls`
 * (issue #1086, D3). Unlike every other recorder above, the third CLI
 * argument is a commit SHA, not a numeric id — kept as a raw string, never
 * `Number(sha)` (a short sha like `d4cb7f8` is not numeric and `Number()`
 * would silently produce `NaN`). Trimmed to the one field `commitPrs`
 * actually consumes (`number`), same jq-equivalent discipline as every
 * other recorder here.
 */
async function recordGithubCommitPrs(project, sha) {
  const endpoint = `GET repos/${project}/commits/${sha}/pulls`;
  const arr = runJson('gh', ['api', '--paginate', `repos/${project}/commits/${sha}/pulls`]);
  writeFixture(
    'github-commitPrs-happy.json',
    {
      endpoint,
      date: today(),
      recorded: true,
      note:
        'Trimmed to the one field github.mjs#commitPrs actually consumes (number) via a ' +
        'jq-equivalent projection of the real response — values are unmodified from the ' +
        'live API.',
    },
    arr.map(r => ({ number: r.number })),
  );
}

const CASES = {
  labelEvents: recordGithubLabelEvents,
  prView: recordGithubPrView,
  issueView: recordGithubIssueView,
  mrList: recordGithubMrList,
  issueList: recordGithubIssueList,
  prReviews: recordGithubPrReviews,
  commitPrs: recordGithubCommitPrs,
};

// `commitPrs` takes a commit SHA as its trailing argument — a short sha
// like `d4cb7f8` is not numeric, so it MUST be passed through as a raw
// string, never `Number(arg)` (which would silently coerce it to `NaN`).
// Every other verb here takes a numeric id, unaffected by this branch.
const RAW_TRAILING_ARG_VERBS = new Set(['commitPrs']);

async function main() {
  const [provider, verb, project, trailingArg] = process.argv.slice(2);
  if (provider !== 'github' || !CASES[verb]) {
    console.error(
      'usage: node record-fixtures.mjs github <labelEvents|prView|issueView|prReviews> <project> <number>\n' +
      '       node record-fixtures.mjs github <mrList|issueList> <project>\n' +
      '       node record-fixtures.mjs github commitPrs <project> <sha>\n' +
      '  (mrCreate and every gitlab-* fixture are deliberately NOT recordable by this script — see header comment)',
    );
    process.exit(1);
  }
  const arg = RAW_TRAILING_ARG_VERBS.has(verb) ? trailingArg : Number(trailingArg);
  await CASES[verb](project, arg);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch(err => {
    console.error(`record-fixtures: ${err.message}`);
    process.exit(1);
  });
}
