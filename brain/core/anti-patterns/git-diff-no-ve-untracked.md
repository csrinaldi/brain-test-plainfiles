# git diff does not see untracked files

- **Discovered in:** ISSUE-13 / macro `brain:change:verify` (formerly `change:verify`)
- **Applies to:** any automation that makes decisions based on the changeset (selective validation, MR generation, scope classification, CI)

## Symptom

A validation built on `git diff --name-only` (branch vs main + staged +
working tree) classifies the change as "docs only" when the change includes a
NEW script. The most important file in the changeset — the one being created — is
invisible to the validation. In the real case: `verify-change.mjs` did not detect
itself in its own validation plan.

## Cause

`git diff` (in all its variants: against base, `--cached`, working tree) only
compares content KNOWN to git. A file that has never been added to the index does not
participate in any diff: it is not a "modification" of anything. The intuition
"diff = everything that changed" is false for new untracked content.

## Solution / correct pattern

Every changeset collection must explicitly include untracked files:

```js
collect(`git diff --name-only ${base}...HEAD`);   // branch commits
collect('git diff --name-only --cached');          // staged
collect('git diff --name-only');                   // working tree
collect('git ls-files --others --exclude-standard'); // untracked: git diff does NOT list them
```

The correct smoke test is dogfooding: run the automation against the change that
introduces it — if it cannot see itself, it is blind.
