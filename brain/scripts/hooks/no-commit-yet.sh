# no-commit-yet.sh — sourced by pre-commit and commit-msg (POSIX sh). Not a hook.
#
# One predicate, one place (issue #1161; the condition itself is #1112's).
# `brain_repo_has_no_commit` succeeds when NO ref reaches any commit — the state
# of a brand-new repository before its adoption commit.
#
# It is deliberately NOT "the current HEAD is unborn": `git checkout --orphan x`
# makes HEAD unborn in a repository that already has history on other refs, and
# `rev-list --all` still reaches that history. See pre-commit's check 0 for the
# full rationale and the cold-review finding behind it.
#
# Fail-closed: outside a git repository, or if git errors, the answer is "no"
# (the exemption does not apply) — an exemption must never be granted by a
# failure to measure. `-n 1` stops at the first hit; no output is the signal.
brain_repo_has_no_commit() {
  git rev-parse --git-dir >/dev/null 2>&1 || return 1
  # Only "rev-list exited 0 AND printed nothing" means no commit yet. An erroring
  # rev-list also prints nothing, so its exit status must be read (fail-closed).
  _brain_out=$(git rev-list -n 1 --all 2>/dev/null) || return 1
  [ -z "$_brain_out" ]
}
