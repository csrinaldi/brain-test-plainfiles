// forge-url.mjs — the one place an issue or PR number becomes a forge URL
// (#882 cold review of PR 1, blocker). Pure, imported by the browser and by
// node:test (D9): no `node:` builtin, no clock, no random, no fetch.
//
// The `https://github.com/<project>/…` literal is INHERITED from
// `change-route.mjs`'s own pre-existing `buildPrUrl` (#881 D14) — not
// introduced here. Brain's own doctrine is platform-agnostic; hard-coding
// github.com is that module's unfinished business, not this one's. Making
// the forge host come from the port (so a GitLab project degrades to its
// own domain instead of a github.com URL) is a follow-up ticket's job.
// `change-route.mjs`'s `buildPrUrl` now delegates to `prUrl` below so there
// is ONE definition, not two copies that can drift.
//
// Editorial (cold review of PR #1037): `issueUrl` widens this same debt from
// PRs to issues — every roadmap row now stamps a github.com link too. Not
// fixed here (out of this ticket's scope); #1035 owns making the forge host
// come from the port for both builders at once.

/** {project, number} -> the issue's URL, or a relative reference when no project is known — never a bare number, never a crash. */
export function issueUrl(project, number) {
  return project ? `https://github.com/${project}/issues/${number}` : `issues/${number}`;
}

/** {project, number} -> the PR's URL, or a relative reference when no project is known. Same shape `change-route.mjs`'s `buildPrUrl` already had. */
export function prUrl(project, number) {
  return project ? `https://github.com/${project}/pull/${number}` : `pull/${number}`;
}
