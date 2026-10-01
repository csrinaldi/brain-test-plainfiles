# config.yaml mixes sequence and mapping (invalid YAML tolerated by the harness)

- **Discovered in:** issue #94 / `openspec/config.yaml`
- **Applies to:** `openspec/config.yaml` and any consumer that parses it with a strict YAML parser

## Symptom

`python3 -c "import yaml; yaml.safe_load(open('openspec/config.yaml'))"` fails with
`expected <block end>, but found '?'`. A YAML linter, a pre-commit hook, or a migration to
another parsing tool would break the SDD harness config — even though `gentle-ai` reads it
without issue today.

## Cause

Under `rules.apply:` and `rules.verify:` the file mixes sequence items (`- Follow ...`)
with mapping keys (`tdd:`, `test_command:`) at the same indentation level. By spec,
a YAML node cannot be both a sequence and a mapping. The `gentle-ai` parser is lenient
and accepts it; PyYAML and most linters do not.

## Solution / correct pattern

Do not "fix" the structure blindly: a mechanical correction can break harness parsing.
If it needs to be hardened, separate the lists from the keys — move the bullets to a
dedicated key (e.g. `guidelines: [...]`) and leave `tdd`/`test_command` as sibling
mappings. ALWAYS validate with `gentle-ai sdd-status --json` (to confirm the harness
still parses) before merging any change to `openspec/config.yaml`.
