// fake-vcs-port.mjs — the ONLY module `memory/cli.mjs`'s `ship` op will ever
// import through the `BRAIN_VCS_TEST_MODULE` test seam (#888 cold review,
// B1). It is committed, reviewed CODE — but it carries no test-case-specific
// behavior of its own. Every answer it gives is read, at call time, from the
// JSON file named by a SECOND env var, `BRAIN_VCS_TEST_SCRIPT`.
//
// Why a code seam constrained to a fixture directory, driven by a data
// seam, rather than one seam that is itself data (e.g. a JSON port
// description with no code at all)? `mrList`/`mrCreate`/`mrAutoMerge` are
// async functions a real caller `await`s and destructures — the shape
// `getVcs()` returns IS code (function exports), so the fake must be code
// too. What must never be arbitrary is WHICH code: `BRAIN_VCS_TEST_MODULE`
// is constrained by `memory/cli.mjs` (`resolveVcsTestModulePath`) to resolve
// inside this committed `__fixtures__/` directory, so the only module that
// seam can ever import is this one, reviewed and merged — never a path an
// env var could point at an arbitrary `.mjs` file in the same process that
// holds `BRAIN_MEMORY_TOKEN`. `BRAIN_VCS_TEST_SCRIPT`, by contrast, is never
// constrained to a directory and never will be: it is DATA (JSON), never
// `import()`ed or executed — the same discipline `BRAIN_MEMORY_TEST_ROOT`
// (a directory to read records from) and `BRAIN_MEMORY_ENV_FILE` (a path to
// parse, not run) already follow elsewhere in this CLI.
//
// Script shape (see cli.ship.test.mjs for worked examples):
//   {
//     "mrList":      [ { "number": 1, "headBranch": "memory/host-2026-01-01", "title": "...", "state": "open", "merged": false }, ... ],
//                    // `state`/`merged` (#930) default to `null` when a script omits them.
//     "mrCreate":     { "url": "https://…/pull/999" } | { "url": null, "error": "..." },
//     "mrAutoMerge":  { "enabled": true, "url": null } | { "enabled": false, "reason": "..." }
//   }
// Any key the script omits (or the script being unset entirely) falls back
// to a safe, LOUD default below — a case that reaches this module without
// having declared what it needs fails with a clear, attributable error
// rather than silently fabricating a PR or a list.

import { readFileSync } from 'node:fs';

// L2 (re-review): read + parse are wrapped together and the thrown message
// names only the PATH, never the file's content — a raw JSON.parse failure
// echoes a prefix of the offending text (e.g. `Unexpected token 'h', "this
// is not"... is not valid JSON`), which would leak whatever the fixture
// script happens to contain into stderr.
function loadScript() {
  const path = process.env.BRAIN_VCS_TEST_SCRIPT;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`fake-vcs-port: BRAIN_VCS_TEST_SCRIPT at ${path} is not valid JSON`);
  }
}

// #930/#936 — the real port's `mrList` gained an additive `state`/`merged`
// pair on every item, plus an optional `headBranch` filter (D1/D2). This
// fake honors both: a script entry that already carries `state`/`merged`
// passes them through unchanged; one written before #930 (no such fields)
// defaults to `null` — an honest "the fixture never said" rather than a
// fabricated `false`. `headBranch`, when passed, filters the script's list
// the same way the real provider's server-side filter would — the fake
// never needs to fabricate a full-page-throws case, since the script
// controls its own list length.
export const mrList = async ({ headBranch } = {}) => {
  const script = loadScript();
  const items = script.mrList ?? [];
  const filtered = headBranch !== undefined ? items.filter((i) => i.headBranch === headBranch) : items;
  return filtered.map((i) => ({
    number: i.number,
    title: i.title,
    headBranch: i.headBranch,
    state: i.state ?? null,
    merged: i.merged ?? null,
  }));
};

export const mrCreate = async () => {
  const script = loadScript();
  if (script.mrCreate) return script.mrCreate;
  return {
    url: null,
    error: 'fake-vcs-port: no BRAIN_VCS_TEST_SCRIPT.mrCreate configured for this run',
  };
};

export const mrAutoMerge = async () => {
  const script = loadScript();
  if (script.mrAutoMerge) return script.mrAutoMerge;
  return {
    enabled: false,
    reason: 'fake-vcs-port: no BRAIN_VCS_TEST_SCRIPT.mrAutoMerge configured for this run',
  };
};
