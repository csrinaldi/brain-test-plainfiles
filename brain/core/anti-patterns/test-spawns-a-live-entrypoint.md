# A test spawns a live entrypoint and trusts configuration to keep it harmless

- **Discovered in:** PR #1007 (the incident) / issue #1012 (the class) — `brain/scripts/memory/cli.mjs`, `ship` op
- **Applies to:** any test that spawns a real runtime entrypoint (`process.execPath`,
  `node`, `npm`, `bash`, `sh`, or `fork`) under `brain/scripts/**`, and any guard
  written to stop one

## Problem

`npm test` spawned a real `cli.mjs ship`, which pushed a real lane ref to the
repository's own remote, opened a real pull request, and armed auto-merge; the
platform merged it (PR #1007). Nothing on the call path distinguished "a test process
spawned this" from "a human ran this by hand". The only things standing between the
test and the real VCS port were the lane feature flag being off and no authenticated
`gh` session on the machine — both configuration, not code, and configuration on a
developer or CI machine is not something a test suite controls.

## Why

The test was safe by coincidence. Its own title said so: it asserted the flag-off
path, and #890 turned the flag on in the tracked config, on purpose. Without any
change to the test, it became a test that could reach a real network port and mutate
a real repository. The failure mode is not "a test broke"; it is "a test succeeded
at doing something no test should ever be able to do".

## Rule

1. **A test's safety must never depend on a configuration value.** A feature flag,
   an authenticated session, or an environment variable that merely happens to be
   unset today can stop holding without anyone touching the test.
2. **An entrypoint that can reach a real, mutating external port refuses unless its
   caller declares itself** through an explicit, checked marker (`cli.mjs ship`'s
   `--invoker hook|sweep|manual`), **and** it checks an independent test-runner signal
   (`NODE_TEST_CONTEXT`) separately, so a test that copies the marker is still refused.
3. **A test that must exercise the real behaviour does so through a seam that makes
   the real port structurally unreachable** (an injected fake port, a `--dry-run` that
   never binds a client), never through configuration alone.
4. **A seam-presence check must not stand in for the mechanism it names.** Asserting
   that a test sets `BRAIN_VCS_TEST_MODULE`, or that a variable is present, proves a
   token was written, not that the port is unreachable. A guard or a meta-test that
   accepts the token without the mechanism reproduces this anti-pattern one level up;
   #1012's own spawn inventory found seven tests that were safe for three different
   structural reasons and would all have been flagged, or "fixed" with inert seam
   variables, by a presence check.

## Solution / correct pattern

`ship-invoker.mjs` (#1012) is the worked example: a pure decision function,
`decideShipInvoker({ args, env })`, that `cli.mjs`'s `ship` op calls before it loads
any module, reads any credential or touches any VCS port. It refuses unless
`--invoker` is one of a closed set, and it refuses independently whenever
`NODE_TEST_CONTEXT` is set, unless the caller uses one of two structural bypasses:
`BRAIN_VCS_TEST_MODULE` (a committed fake port) or `--dry-run`. Every real caller
(`session-end-ship.mjs`, `day-start-sweep.mjs`, the `brain:memory:ship` npm script)
declares its own invoker at the call site, and the `--json` result echoes it, so an
end-to-end test can prove the marker survived rather than that the bypass let it through.

## Detection

`brain/scripts/test-spawn-hygiene.test.mjs` (#1012) scans every `*.test.mjs` under
`brain/scripts/**` and `test/**` for a spawn of a runtime entrypoint under
`brain/scripts/**` and fails unless that spawn is allowlisted with a reason from a
closed set (`no-vcs-capability`, `fixture-root-local-git`, `vcs-port-substituted`,
`refusal-asserted`). The reason names the mechanism that makes the spawn safe, per
rule 4; an unallowlisted spawn fails closed, so the next #1007 is caught before merge.
