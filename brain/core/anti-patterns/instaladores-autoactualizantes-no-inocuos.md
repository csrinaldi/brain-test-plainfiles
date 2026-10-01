# Self-updating installers are not innocuous

- **Discovered in:** ISSUE-6 / environment bootstrap (`brain:env:init`, formerly `env:init`)
- **Applies to:** any ecosystem tooling with an `install`/`upgrade` subcommand (gentle-ai, and any CLI that manages itself)

## Symptom

`gentle-ai install --help` is run expecting to see the subcommand help. Instead,
the command triggers the REAL installation flow: creates a backup, self-updates
via brew (1.33.2 → 1.37.2), restarts itself, and only then fails with
`Error: flag: help requested`. The system was modified by a command that was
assumed to be read-only.

## Cause

Self-managed CLIs typically intercept the subcommand BEFORE parsing flags:
the auto-update runs as a prologue to `install` regardless of what flags follow.
The convention "`--help` never has side effects" is just that — a convention, not
a guarantee.

## Solution / correct pattern

- To inspect capabilities: use the read-only diagnostic command
  (`gentle-ai doctor`, `gentle-ai config`, `<tool> version`) or GLOBAL help
  (`gentle-ai --help`), never `<mutating-subcommand> --help`.
- In bootstrap scripts: invoke `install` only deliberately, behind an idempotency
  guard based on a read-only diagnostic. Real example in
  `scripts/bootstrap.sh`:

  ```bash
  if gentle-ai doctor 2>/dev/null | grep -q 'state file OK'; then
    ok "ecosystem already initialized"
  else
    gentle-ai install   # interactive and self-updating: inherited TTY, intentional
  fi
  ```

- Watch out for the exit code of doctor commands: `gentle-ai doctor` reports "unhealthy"
  due to ambient noise (duplicates in PATH, engram endpoint down). Grep for the specific
  line that matters; do not rely on the global exit code.
