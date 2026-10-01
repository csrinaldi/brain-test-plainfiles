# Pre-v0.8.0 upgrader clobbers consumer identity and locks out future upgrades

- **Discovered in:** ISSUE-180 / `brain:upgrade` self-host guard, real upgrade test on a consumer repo
- **Applies to:** any consumer repo that installed brain before v0.8.0 and has not upgraded since

## Symptom

A consumer repo runs `brain:upgrade` and, after the upgrade, its own
`package.json` `name` (also `version`, `description`, `license`) has silently
become `"brain"` — the vendored brain package's own identity, not the
consumer's. Every subsequent `brain:upgrade` run then immediately dies with
`this looks like the brain repo itself (package.json name === "brain")` and
refuses to proceed. The consumer is now locked out of the one command that
could fix the problem.

## Cause

Before v0.8.0, the installer copied `package.json` the same way it copied
every other managed path: a plain overwrite from `node_modules/brain/`'s
`package.json` onto the consumer's own file. Since `package.json` was already
a managed path (needed to inject the `brain:*` verb scripts), this meant
brain's own `name`/`version`/`description`/`license` replaced the consumer's
on every upgrade.

The self-host guard in `brain-upgrade.mjs` used
`ownPkg.name === 'brain'` as its signal for "this is the brain repo itself,
refuse to run". That check cannot distinguish "this really is the brain
source repo" from "this is a consumer whose identity got clobbered by the
bug above" — both have `package.json` `name: "brain"`. The guard fires
either way, and a clobbered consumer can never get past it to reach the fix.

## Solution / correct pattern

**Already fixed in v0.9.x, structurally:**

- `package.json` is routed through `specialMerge` → `mergePackageJson`
  (`brain/scripts/lib/installer.mjs`), which spreads the consumer's own
  fields first and only *adds* missing `brain:*` script keys. Consumer
  `name`/`version`/`description`/`license`/dependencies are never touched.
  Locked in by a regression test in `brain/scripts/brain-upgrade.test.mjs`
  (specialMerge registration) and `brain/scripts/lib/installer.test.mjs`
  (`mergePackageJsonScripts` identity-preservation test).
- The self-host guard no longer trusts `package.json` at all. It checks for
  a `.brain-source` marker file at the brain SOURCE repo root instead — a
  file that is never a managed path, so it is never distributed to
  consumers and never clobbered. A `package.json` `name === "brain"` with no
  `.brain-source` marker now prints a non-fatal recovery-awareness warning
  and the upgrade proceeds normally.

**Recovering a consumer that was clobbered before this fix landed:**

1. Restore the consumer's real `name` (and `version`/`description`/`license`
   if relevant) in `package.json` by hand, or from git history.
2. Run the upgrade directly against the already-installed brain package,
   bypassing the reinstall step:
   `node node_modules/brain/brain/scripts/brain-upgrade.mjs -- <tag>`
3. If step 1 isn't possible yet (identity unknown/unrecoverable), a one-time
   `--force` on `brain:upgrade` also gets past the old guard — use only when
   you are certain the repo is a consumer, not the brain source repo.
