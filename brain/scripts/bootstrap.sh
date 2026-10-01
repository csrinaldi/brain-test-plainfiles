#!/usr/bin/env bash
# bootstrap.sh — interactive development environment setup (verb: npm run brain:env:init | deprecated alias: env:init)
#
# Leaves a fresh clone operational: personal PAT in .env, HTTPS credential helper
# at repo level, VCS CLI authenticated, SDD harness chosen and initialized,
# team memory imported and indexed, and open tickets as a starting point.
# Idempotent: running again only completes what is missing.
set -euo pipefail

# The WORKTREE (or plain checkout) that invoked this script — where ITS OWN
# CODE lives: brain/scripts/**, package.json, node_modules (issue #1093).
# Captured HERE, before the REPO_ROOT `cd` below, while `pwd` is still the
# caller's tree: `npm run brain:env:init` always runs bootstrap.sh with the
# invoking tree as cwd, so this is exactly "the brain the caller invoked" —
# the worktree's checkout when adopting or upgrading on a branch, which is
# ordinarily a DIFFERENT tree than REPO_ROOT below.
#
# Everything that runs BRAIN'S OWN CODE (a `node brain/scripts/...` call, or a
# `$PM run brain:*` verb) resolves against THIS tree from here on — never
# against REPO_ROOT. Running old code from a stale main checkout is the bug:
# a real adoption in `csrinaldi/synergy` got `Cannot find module` from two
# scripts the main tree's old brain never had, and re-registered a merge
# driver the worktree's (current) brain had already retired.
WORKTREE_ROOT="$(pwd)"
BRAIN_SCRIPTS="$WORKTREE_ROOT/brain/scripts"

# Steps below that are non-fatal by design still report failure here instead
# of vanishing — see the two `|| { ...; MISSING_OPTIONAL+=(...); }` sites near
# the top of this file and §2's tool checks. Declared early (moved up from
# its old spot just above §2) so those two sites can add to it too.
MISSING_OPTIONAL=()

# A DIFFERENT class from MISSING_OPTIONAL (issue #1112, cold-review round 3,
# should-fix): a VCS token the operator actually typed in, that the
# fail-closed pat-write-gate below refused to persist, is not optional —
# it is the one thing this section exists to do. Appended only there; a
# non-empty REQUIRED_FAILURES turns the final summary into a non-zero exit
# (§9's required-failure-summary), so env:init cannot finish reading as a
# successful setup when it demonstrably was not one.
REQUIRED_FAILURES=()

# Hard requirement, checked first: without the invoking tree's own
# brain/scripts/, nothing below can run ITS code at all — only ever a
# cascade of `Cannot find module` errors that per-step warnings would hide
# behind `== Environment ready ==` (issue #1093, the exact defect reported).
# This is the one failure mode individual step warnings cannot meaningfully
# degrade past, so it exits non-zero instead of continuing.
if [ ! -d "$BRAIN_SCRIPTS" ]; then
  printf '  \xe2\x9c\x97 brain/scripts/ not found at %s — this checkout is incomplete (re-run the install/upgrade). env:init cannot continue.\n' "$WORKTREE_ROOT" >&2
  exit 1
fi

# The MAIN worktree, not whichever worktree invoked this (issue #657).
# `--show-toplevel` answers "the current worktree", which for env:init is the
# wrong tree: `.env` is gitignored (.gitignore:79), so it exists ONLY in the main
# checkout, and the credential helper in §4 sources it on every push. Bootstrapping
# from a worktree would write a second `.env` that helper never reads — and
# AGENTS.md:212 makes worktrees the normal way to work here, so that is the
# ordinary path, not an edge case.
#
# `--git-common-dir` is the one path every worktree shares; its parent is the main
# tree. `--path-format=absolute` is REQUIRED, not decoration: the bare form returns
# a relative `.git` from the main tree and an absolute path from a worktree, so
# `dirname` on it would yield `.` in the very case that already worked.
#
# NOTE (issue #1093): this governs WHERE DATA lives — .env, git config,
# brain.config.json — not which CODE runs. Code resolves via WORKTREE_ROOT /
# BRAIN_SCRIPTS above regardless of REPO_ROOT.
REPO_ROOT="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
cd "$REPO_ROOT"

# Bootstrap brain.config.json before resolving identity.
# On a fresh clone the file doesn't exist: ensureBrainConfig creates it with the
# full schema and derives vcs.provider / gitHost / slug from the git origin so
# the mapfile below reads the correct provider (not the *)‐default gitlab).
# Non-fatal: degrades gracefully if git is absent or node is not yet available.
# The failure is still REPORTED (not silently walked past, issue #1093): a
# bare `|| true` here gave zero signal, not even a warning line.
_config_existed=true
[ -f brain.config.json ] || _config_existed=false
node "$BRAIN_SCRIPTS/lib/brain-config.mjs" ensure || {
  printf '  \xe2\x9a\xa0 brain.config.json: ensure step failed (see error above)\n' >&2
  # By CAUSE: a config that cannot be parsed makes every later config read meaningless, so it is
  # REQUIRED; any other ensure failure (e.g. the tier notice) stays optional (#1127).
  if [ -f brain.config.json ] && ! node -e "JSON.parse(require('fs').readFileSync('brain.config.json','utf8'))" >/dev/null 2>&1; then
    REQUIRED_FAILURES+=("brain.config.json cannot be parsed (fix or remove it, then re-run)")
  else
    MISSING_OPTIONAL+=("brain.config.json ensure")
  fi
}

# Scaffold brain/HOME.md if absent (never overwrites an existing one — the file
# is consumer-owned once it exists). Non-fatal, idempotent: re-running env:init
# on a repo that already has HOME.md is a no-op. Reported on failure, same
# reasoning as brain.config.json above (issue #1093).
node "$BRAIN_SCRIPTS/lib/home-scaffold.mjs" ensure || { printf '  \xe2\x9a\xa0 brain/HOME.md: scaffold step failed (see error above)\n' >&2; MISSING_OPTIONAL+=("brain/HOME.md scaffold"); }

# Resolve project identity from brain.config.json, falling back to git origin.
# VCS_PROVIDER: env var wins, then brain.config.json vcs.provider.
# VCS_HOST:     brain.config.json project.gitHost, then origin host.
# PROJECT_PATH: brain.config.json project.slug, then origin project path.
# Read via mapfile (one value per line) — never eval — so repo-identity values
# (which can contain shell metacharacters) can't inject commands.
mapfile -t _IDENT < <(node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

let c = {};
try { c = JSON.parse(readFileSync('brain.config.json', 'utf8')); } catch { /* swallow-ok: an unparseable config reads as empty here and identity falls back to the git origin; `brain-config.mjs ensure` above now reports it and exits 1 (#1127) */ }

let originHost = '', originProject = '';
try {
  const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
  const m = url.match(/(?:https?:\/\/(?:[^@\/]+@)?|git@)([^\/:]+)(?::\d+)?[\/:](.+?)(?:\.git)?$/);
  if (m) { originHost = m[1]; originProject = m[2]; }
} catch { /* swallow-ok: no git origin means no derived host or project; the prompts and the final summary name what is still unset */ }

console.log(process.env.VCS_PROVIDER || c.vcs?.provider || '');
console.log(c.project?.gitHost || originHost  || '');
console.log(c.project?.slug    || originProject || '');
NODE
)

# Defaults guard against node not being available yet (empty array).
VCS_PROVIDER="${_IDENT[0]:-}"
VCS_HOST="${_IDENT[1]:-}"
PROJECT_PATH="${_IDENT[2]:-}"
export VCS_HOST

# Interactive: on a TTY, after a fresh creation, show derived values and let the
# developer confirm or override the VCS provider. Non-TTY → use derived silently.
if [ -t 0 ] && [ "$_config_existed" = false ] && [ -n "$VCS_PROVIDER$VCS_HOST$PROJECT_PATH" ]; then
  printf '\n  Derived from git origin:\n'
  printf '    provider : %s\n' "${VCS_PROVIDER:-?}"
  printf '    gitHost  : %s\n' "${VCS_HOST:-?}"
  printf '    slug     : %s\n' "${PROJECT_PATH:-?}"
  # --- BEGIN vcs-provider-validate (issue #1112, finding 2) ---
  # Only "github"/"gitlab" are valid vcs.provider values (ADR-0008). Before
  # this fix, whatever was typed here was written verbatim into the TRACKED
  # brain.config.json — an operator who answered with a pasted PAT (instead
  # of a provider name) got the token committed to a tracked file. That same
  # file's governance.memorySecretPatterns already lists the PAT shape
  # (ghp_[A-Za-z0-9]{20,}), a few lines below, unchecked against. Restricting
  # to this fixed two-value enum is strictly stronger than scanning against
  # memorySecretPatterns for this one write path: no PAT-shaped string can
  # ever equal "github" or "gitlab".
  while :; do
    read -r -p "  VCS provider [${VCS_PROVIDER:-}]: " _override
    _override="${_override:-$VCS_PROVIDER}"
    case "$_override" in
      github|gitlab|'') break ;;
      *) printf '  ✗ Unknown provider "%s" — only "github" or "gitlab" are supported.\n' "$_override" >&2 ;;
    esac
  done
  if [ -n "$_override" ] && [ "$_override" != "$VCS_PROVIDER" ]; then
    VCS_PROVIDER="$_override"
    # Persist the override to brain.config.json — use env var to avoid injection.
    # A failed write is a REQUIRED failure (issue #1127): the operator typed this value,
    # and losing it silently means the next run derives the wrong provider.
    VCS_PROVIDER_OVERRIDE="$_override" node --input-type=module <<'NODE' || { printf '  \xe2\x9a\xa0 brain.config.json: could not persist the VCS provider override\n' >&2; REQUIRED_FAILURES+=("VCS provider override not persisted to brain.config.json"); }
import { readFileSync, writeFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync('brain.config.json', 'utf8'));
if (!cfg.vcs) cfg.vcs = {};
cfg.vcs.provider = process.env.VCS_PROVIDER_OVERRIDE;
writeFileSync('brain.config.json', JSON.stringify(cfg, null, 2) + '\n');
NODE
  fi
  # --- END vcs-provider-validate ---
fi

# Generic credential env var (ADR-0007 / issue #33): a single VCS_TOKEN is used
# regardless of provider so that .env stays portable across GitHub, GitLab, and any
# future host.
VCS_TOKEN_VAR="VCS_TOKEN"

# Per-provider constants: credential helper username, PAT scope, CLI binary.
case "$VCS_PROVIDER" in
  github)
    VCS_CRED_USER="x-access-token"
    PAT_SCOPES="repo"
    VCS_CLI="gh"
    ;;
  *)
    # Default: gitlab (covers empty provider or explicit "gitlab").
    VCS_CRED_USER="oauth2"
    PAT_SCOPES="api"
    VCS_CLI="glab"
    ;;
esac

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
warn() { printf '  ⚠ %s\n' "$1"; }

env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }  # swallow-ok: grep exits 1 when the key is absent, which is the answer env_get exists to give
env_set() {
  touch .env
  if grep -qE "^$1=" .env; then
    # key exists (maybe empty): replace the line instead of appending a duplicate
    local tmp; tmp="$(mktemp)"
    grep -vE "^$1=" .env > "$tmp" || true  # swallow-ok: grep -v exits 1 when .env held only that key; the empty remainder is the correct result
    printf '%s=%s\n' "$1" "$2" >> "$tmp"
    mv "$tmp" .env
  else
    # guard: a final line without newline would swallow the appended key
    if [ -s .env ] && [ "$(tail -c1 .env | wc -l)" -eq 0 ]; then printf '\n' >> .env; fi
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

# --- i18n: source active locale catalog (graceful degradation) ────────────────
# Defines I18N_* vars for every key in the catalog using the active locale
# (brain.config.json docs.language) with English fallback applied per-key.
# Guard: only eval when node is available AND sh.mjs produces non-empty output.
# If node is absent or sh.mjs fails, the script falls through to inline English
# defaults (${I18N_VAR:-"…"}) used only in the pre-node section (§1 below).
if command -v node >/dev/null 2>&1; then
  _i18n_vars="$(node "$BRAIN_SCRIPTS/i18n/sh.mjs" 2>/dev/null)"
  [ -n "$_i18n_vars" ] && eval "$_i18n_vars"
  unset _i18n_vars
fi

# --- 1. Base dependencies (blocking) -----------------------------------------
say "${I18N_BOOTSTRAP_DEPS_SECTION:-Base dependencies}"
for tool in git python3; do
  command -v "$tool" >/dev/null 2>&1 || { printf "  ✗ ${I18N_BOOTSTRAP_DEPS_MISSING:-Missing '%s' (required). Install it and re-run env:init.}\n" "$tool" >&2; exit 1; }
done
# Require at least one supported package manager (npm/pnpm/yarn/bun).
_PM_FOUND=false
for _pm_bin in npm pnpm yarn bun; do
  if command -v "$_pm_bin" >/dev/null 2>&1; then _PM_FOUND=true; break; fi
done
if [ "$_PM_FOUND" = false ]; then
  printf "  ✗ ${I18N_BOOTSTRAP_DEPS_MISSING:-Missing '%s' (required). Install it and re-run env:init.}\n" "npm/pnpm/yarn/bun" >&2
  exit 1
fi
unset _PM_FOUND _pm_bin
# Detect the consumer's package manager for use in §7 memory steps.
# Detected against WORKTREE_ROOT, not cwd (REPO_ROOT): $PM later runs
# `brain:memory:pull`/`brain:memory:index` IN the worktree (issue #1093), so
# it must be the package manager that tree actually uses.
PM="$(cd "$WORKTREE_ROOT" && node "$BRAIN_SCRIPTS/lib/pm.mjs" name 2>/dev/null || echo npm)"  # swallow-ok: npm is the documented default package manager when detection is unavailable
ok "$(printf "${I18N_BOOTSTRAP_DEPS_OK:-git, python3 present; package manager: %s}" "$PM")"

# --- 2. Ecosystem tools (degrade gracefully) ----------------------------------
say "$I18N_BOOTSTRAP_ECOSYSTEM_SECTION"

# Install hints per tool (Ubuntu/Debian)
declare -A INSTALL_HINT
INSTALL_HINT[$VCS_CLI]="npm run tools:install"
INSTALL_HINT[gentle-ai]="curl -fsSL https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/scripts/install.sh | bash"
INSTALL_HINT[engram]="gentle-ai install  (requires gentle-ai)"
INSTALL_HINT[gga]="gentle-ai install  (requires gentle-ai)"
INSTALL_HINT[claude]="npm install -g @anthropic-ai/claude-code"

# MISSING_OPTIONAL is declared near the top of this file now (issue #1093),
# so the two `brain-config.mjs`/`home-scaffold.mjs` failure reports above can
# add to it too — redeclaring it here would silently drop those entries.
for tool in "$VCS_CLI" engram gentle-ai gga claude; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool"
  else
    warn "$(printf "$I18N_BOOTSTRAP_ECOSYSTEM_NOTFOUND" "$tool" "${INSTALL_HINT[$tool]:-npm run tools:install}")"
    MISSING_OPTIONAL+=("$tool")
  fi
done

# Codex is not a general bootstrap dependency. Consult the effective route
# before probing it so consumers that keep the Claude route never need a Codex
# executable, state directory, authentication, or Linux sandbox support.
say "Codex cold-review"
if CODEX_READINESS="$(node "$BRAIN_SCRIPTS/harness/codex-readiness.mjs" --check 2>&1)"; then
  ok "$CODEX_READINESS"
else
  warn "$CODEX_READINESS"
  MISSING_OPTIONAL+=("Codex cold-review readiness")
fi

# --- 3. Personal PAT in .env --------------------------------------------------
say "$I18N_BOOTSTRAP_PAT_SECTION"

# --- BEGIN ensure-env-gitignored (issue #1112, finding 1) ---
# `.env` (and node_modules/) are untracked but NOT ignored in a fresh
# consumer repo — `brain init` never created or amended a `.gitignore`.
# The next `git add -A` after this section writes the operator's PAT below
# would commit it. `git check-ignore` (not a plain grep) is used so an
# existing broader pattern (`.env*`, one written in a parent directory's
# .gitignore, core.excludesFile, …) is honored instead of duplicated.
ensure_env_gitignored() {
  git check-ignore -q .env 2>/dev/null && return 0
  [ -f .gitignore ] || : > .gitignore  # swallow-ok: create-if-absent: `: > file` IS the creation, not a swallowed failure (the guard reads `|| :` as a swallow); a failed write surfaces through the final `git check-ignore` and GITIGNORE_FAILED
  if [ -s .gitignore ] && [ "$(tail -c1 .gitignore | wc -l)" -eq 0 ]; then printf '\n' >> .gitignore; fi
  printf '.env\n' >> .gitignore
  git check-ignore -q .env 2>/dev/null
}
if ensure_env_gitignored; then
  ok "$I18N_BOOTSTRAP_GITIGNORE_OK"
else
  warn "$I18N_BOOTSTRAP_GITIGNORE_FAILED"
fi
# --- END ensure-env-gitignored ---

# --- BEGIN env-secret-safe-gate (issue #1112, cold-review finding) ---
# `ensure_env_gitignored` above only WARNS when it cannot confirm `.env` is
# ignored — a warning does not stop the write that follows. FAIL CLOSED
# instead: compute ONE gate, read by the one place below that writes a new
# secret into `.env`.
#
# Checked ONCE here, before any of the prompts below ever run — never
# re-checked per-write, so the whole PAT section reads one consistent answer.
#
# FILE TYPE is checked FIRST, independently of tracking/ignore status
# (cold-review round 3): a `.env` that is a SYMLINK to a file outside the
# repo (`.env -> /outside/secrets.env`) passes both the tracked check (the
# symlink itself is untracked) and the ignore check (`git check-ignore`
# matches the symlink's OWN path, same as for a regular file) — so the gate
# used to say "safe", and `env_set`'s `>> .env` then followed the symlink and
# appended the PAT to a file OUTSIDE the repo entirely (reproduced). `[ -L
# .env ]` is true for a symlink regardless of what it points at, or whether
# the target even exists, so it must be checked BEFORE `-f` (which follows
# symlinks and would call a symlink-to-a-regular-file "safe"). Anything else
# that exists but is not a regular file (a directory, a FIFO, …) is refused
# for the same reason: `>> .env` on any of those is not "write a token into a
# file this repo owns".
#
# TRACKED STATUS is checked next. `git check-ignore` NEVER reports a path as
# ignored once it is TRACKED, no matter which pattern in `.gitignore`
# matches it — a previous run (this same bug, before this fix, or a manual
# `git add -A`) may already have committed `.env`. A `.gitignore` fix cannot
# protect a secret about to be written into a file git's index already has,
# so tracked status is checked separately from, and before, the ignore
# check — it changes which remedy is correct.
#
# The IGNORE CHECK itself (`git check-ignore -q .env`) honors every
# applicable source — a pattern in THIS repo's `.gitignore` at any level, a
# rule in `.git/info/exclude`, or a global `core.excludesFile` — any of which
# make `.env` ignored for THIS CLONE ONLY; none of them travels with the repo
# to a fresh clone, which is exactly why `ensure_env_gitignored` above writes
# a repo-tracked `.gitignore` pattern rather than relying on a clone-local
# exclude file to do the whole job.
ENV_SECRET_SAFE=true
ENV_SECRET_UNSAFE_REASON=""
ENV_SYMLINK_TARGET=""
if [ -L .env ]; then
  ENV_SECRET_SAFE=false
  ENV_SECRET_UNSAFE_REASON=symlink
  ENV_SYMLINK_TARGET="$(readlink .env 2>/dev/null || true)"  # swallow-ok: the target is only quoted in the refusal message; the refusal (ENV_SECRET_SAFE=false) is already decided
elif [ -e .env ] && [ ! -f .env ]; then
  ENV_SECRET_SAFE=false
  ENV_SECRET_UNSAFE_REASON=notRegularFile
elif [ -f .env ] && _env_links="$(stat -c %h .env 2>/dev/null || stat -f %l .env 2>/dev/null || echo 1)" && [ "$_env_links" -gt 1 ] 2>/dev/null; then  # swallow-ok: GNU-then-BSD portability fallback; if BOTH stat forms fail the count reads as 1, so the hardlink check is SKIPPED; the symlink, file-type, tracked and ignore checks around it still gate the write
  # A HARDLINK to a file outside the repo passes `-L` (false) and `-f` (true),
  # and `>> .env` would append the PAT through it. Link count > 1 is the only
  # signal; `stat -c %h` is GNU, `stat -f %l` is BSD/macOS.
  ENV_SECRET_SAFE=false
  ENV_SECRET_UNSAFE_REASON=hardlinked
elif git ls-files --error-unmatch .env >/dev/null 2>&1; then
  ENV_SECRET_SAFE=false
  ENV_SECRET_UNSAFE_REASON=tracked
elif ! git check-ignore -q .env 2>/dev/null; then
  ENV_SECRET_SAFE=false
  ENV_SECRET_UNSAFE_REASON=ignoreFailed
fi
# --- END env-secret-safe-gate ---

VCS_TOKEN="$(env_get "$VCS_TOKEN_VAR")"
if [ -n "$VCS_TOKEN" ]; then
  ok "$(printf "$I18N_BOOTSTRAP_PAT_ALREADYSET" "$VCS_TOKEN_VAR")"
elif [ ! -t 0 ]; then
  warn "$(printf "$I18N_BOOTSTRAP_PAT_NOTTY" "$VCS_TOKEN_VAR")"
else
  cat <<'EOT'
  You need a Personal Access Token from your Git hosting provider.
  It must be PERSONAL — not a project bot token — so your pushes, issues and
  MRs/PRs appear under your name.
EOT
  PAT_URL="$(node "$BRAIN_SCRIPTS/vcs/cli.mjs" pat-setup-url "{\"host\":\"$VCS_HOST\",\"name\":\"brain-dev\",\"scopes\":[\"$PAT_SCOPES\"]}" 2>/dev/null || true)"  # swallow-ok: the URL only pre-fills a browser tab; the token prompt that follows works without it
  read -r -p "  $I18N_BOOTSTRAP_PAT_OPENPROMPT" OPEN_BROWSER
  case "${OPEN_BROWSER:-S}" in
    n|N)
      printf "  $I18N_BOOTSTRAP_PAT_MANUALURL\n" "$PAT_URL"
      ;;
    *)
      if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$PAT_URL" >/dev/null 2>&1 || true  # swallow-ok: opening a browser is a convenience; the URL is printed right after
      elif command -v open >/dev/null 2>&1; then
        open "$PAT_URL" >/dev/null 2>&1 || true  # swallow-ok: opening a browser is a convenience; the URL is printed right after
      fi
      printf "  $I18N_BOOTSTRAP_PAT_BROWSERFALLBACK\n" "$PAT_URL"
      ;;
  esac
  read -r -s -p "  $I18N_BOOTSTRAP_PAT_ENTERPROMPT" VCS_TOKEN
  echo
  # --- BEGIN pat-write-gate (issue #1112, cold-review finding) ---
  if [ -z "$VCS_TOKEN" ]; then
    warn "$I18N_BOOTSTRAP_PAT_SKIPPED"
  elif [ "$ENV_SECRET_SAFE" != true ]; then
    # A REQUIRED failure (cold-review round 3, should-fix), not an optional
    # one: the operator typed a token in and it could not be saved. Recorded
    # once here, regardless of which reason refused it — §9's
    # required-failure-summary is what turns this into the final summary
    # line and the non-zero exit.
    REQUIRED_FAILURES+=("$VCS_TOKEN_VAR not saved to .env ($ENV_SECRET_UNSAFE_REASON)")
    case "$ENV_SECRET_UNSAFE_REASON" in
      symlink)
        warn "$(printf "$I18N_BOOTSTRAP_PAT_SYMLINKREFUSED" "$VCS_TOKEN_VAR" "$ENV_SYMLINK_TARGET")"
        ;;
      notRegularFile)
        warn "$(printf "$I18N_BOOTSTRAP_PAT_NOTREGULARFILEREFUSED" "$VCS_TOKEN_VAR")"
        ;;
      hardlinked)
        warn "$(printf "$I18N_BOOTSTRAP_PAT_HARDLINKEDREFUSED" "$VCS_TOKEN_VAR")"
        ;;
      tracked)
        warn "$(printf "$I18N_BOOTSTRAP_PAT_TRACKEDREFUSED" "$VCS_TOKEN_VAR")"
        ;;
      *)
        warn "$(printf "$I18N_BOOTSTRAP_PAT_GITIGNOREREFUSED" "$VCS_TOKEN_VAR")"
        ;;
    esac
    # The gate protects the SECRET only: the non-secret settings are still
    # written to .env, and the operator is told so rather than left to guess.
    warn "$I18N_BOOTSTRAP_PAT_SETTINGSNOTE"
  else
    env_set "$VCS_TOKEN_VAR" "$VCS_TOKEN"
    ok "$(printf "$I18N_BOOTSTRAP_PAT_SAVED" "$VCS_TOKEN_VAR")"
  fi
  # --- END pat-write-gate ---
fi
if [ -n "$VCS_TOKEN" ]; then export "$VCS_TOKEN_VAR=$VCS_TOKEN"; fi

# Export NO_PROXY from .env so Go binaries (VCS CLI) can bypass the internal proxy.
_NO_PROXY="$(env_get NO_PROXY)"
if [ -n "$_NO_PROXY" ]; then
  export NO_PROXY="$_NO_PROXY"
  export no_proxy="$_NO_PROXY"
fi

# --- 4. HTTPS credential helper (repo-local) ----------------------------------
# SSH is blocked at the infra level: only HTTPS works, with username=$VCS_CRED_USER
# and the PAT as password. The helper reads the token from .env on every use —
# nothing is hardcoded in the git config.
#
# The .env path resolves through `--git-common-dir` for the reason given at the top
# of this file (issue #657): git config --local is shared by every worktree, so this
# ONE helper string runs from all of them, while `.env` exists in the main tree
# alone. With `--show-toplevel` a push from any worktree sourced a file that was not
# there, got an empty token, and failed the push with no useful signal.
say "$I18N_BOOTSTRAP_CRED_SECTION"
HELPER='!f() { . "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.env" 2>/dev/null; [ -n "${'"$VCS_TOKEN_VAR"':-}" ] || { echo "env:init: '"$VCS_TOKEN_VAR"' vacío en .env" >&2; exit 1; }; echo username='"$VCS_CRED_USER"'; printf "password=%s\n" "${'"$VCS_TOKEN_VAR"'}"; }; f'
git config --local "credential.https://${VCS_HOST}.helper" "$HELPER"
ok "$I18N_BOOTSTRAP_CRED_OK"

# --- 5. VCS CLI authentication -----------------------------------------------
# Token is read from .env by the provider (Part A of the VCS adapter) —
# NOT passed in argv to avoid leaking it via /proc/*/cmdline.
say "$I18N_BOOTSTRAP_AUTH_SECTION"
if node "$BRAIN_SCRIPTS/vcs/cli.mjs" auth-check "{\"host\":\"$VCS_HOST\"}" >/dev/null 2>&1; then
  ok "$(printf "$I18N_BOOTSTRAP_AUTH_ALREADYOK" "$VCS_HOST")"
elif [ -n "$VCS_TOKEN" ]; then
  node "$BRAIN_SCRIPTS/vcs/cli.mjs" auth-login "{\"host\":\"$VCS_HOST\"}" \
    && ok "$(printf "$I18N_BOOTSTRAP_AUTH_OK" "$VCS_HOST")" \
    || { warn "$I18N_BOOTSTRAP_AUTH_FAILED"; REQUIRED_FAILURES+=("VCS CLI login failed for $VCS_HOST"); }
else
  warn "$I18N_BOOTSTRAP_AUTH_NOTOKEN"
fi

# --- 5b. Governance labels and brain.actor (issues #1163, #1164) --------------
# A fresh consumer has no `status:approved` label (its first PR fails `issue-link`)
# and no `brain.actor` (its first `brain:memory:save` refuses). Both steps go through
# the VCS port and are classified by CAUSE, like MISSING_OPTIONAL / REQUIRED_FAILURES
# elsewhere in this file: exit 3 is "pending" (VCS unreachable or unauthenticated, a
# refused create, no identity) and lands in MISSING_OPTIONAL with its exact command;
# any other non-zero exit is a defect of the step itself and is REQUIRED.
_setup_step() {
  local step="$1" out rc=0 _next
  out="$(node "$BRAIN_SCRIPTS/lib/env-init-setup.mjs" "$step" 2>&1)" || rc=$?  # rc is captured and classified below — 3 is pending, anything else is a required failure
  printf '%s\n' "$out" | sed '/^NEXT: /d'  # the NEXT: line is machine output; the final Pending summary prints it
  case "$rc" in
    0) ;;
    3) _next="$(printf '%s\n' "$out" | sed -n 's/^NEXT: //p' | head -1)"
       # pending is keyed on the NEXT: line: exit 3 without one would be an empty pending entry
       if [ -n "$_next" ]; then MISSING_OPTIONAL+=("$_next"); else REQUIRED_FAILURES+=("env-init-setup $step reported pending without a next step"); fi ;;
    *) REQUIRED_FAILURES+=("env-init-setup $step failed (exit $rc)") ;;
  esac
}
say "Governance labels and actor"
_setup_step labels
_setup_step actor

# --- 6. SDD implementation (replaceable harness, ADR-0012) --------------------
# Harness-specific init is now delegated to brain/scripts/harness/cli.mjs, which
# dispatches to brain/scripts/axes/<axis>/adapters/<SDD_HARNESS>.mjs. Adding a new
# harness requires only a new backend module — no edits to this file.
# Mirrors the memory (ADR-0004) and VCS (ADR-0008) adapter patterns.
# Runs BEFORE the memory sync so the ecosystem (skills, engram, gga) is
# ready when memory is imported.
say "$I18N_BOOTSTRAP_SDD_SECTION"
# AGENT_PLATFORM — the same precedence and default as harness/platform.mjs's
# resolvePlatform (issue #1125): process env > .env > legacy SDD_HARNESS (only
# when it names a platform) > `claude`. This is a SECOND resolver, held to the
# first by bootstrap.default-platform.test.mjs's parity table until #1114
# leaves exactly one.
#
# Two answers, on purpose. `.env` records what the REPO states: an existing
# value is never rewritten, and a repo that states nothing gets the default
# written explicitly. A process-env AGENT_PLATFORM is per-invocation, as it is
# for resolvePlatform: `AGENT_PLATFORM=antigravity npm run brain:env:init` (the
# hint brain:upgrade prints) runs antigravity for that run and does not move
# the repo off the platform it states, or off the default.
_DOTENV_PLATFORM="$(env_get AGENT_PLATFORM)"
_REPO_PLATFORM="$_DOTENV_PLATFORM"
if [ -z "$_REPO_PLATFORM" ]; then
  _LEGACY_PLATFORM="${SDD_HARNESS:-$(env_get SDD_HARNESS)}"
  case "$_LEGACY_PLATFORM" in
    claude|antigravity|plain) _REPO_PLATFORM="$_LEGACY_PLATFORM" ;;
    *) _REPO_PLATFORM="claude" ;;
  esac
fi
[ -n "$_DOTENV_PLATFORM" ] || env_set AGENT_PLATFORM "$_REPO_PLATFORM"
AGENT_PLATFORM="${AGENT_PLATFORM:-$_REPO_PLATFORM}"

SDD_ENGINE="$(env_get SDD_ENGINE)"
if [ -z "$SDD_ENGINE" ]; then
  _LEGACY_HARNESS="$(env_get SDD_HARNESS)"
  SDD_ENGINE="${_LEGACY_HARNESS:-gentle-ai}"
  env_set SDD_ENGINE "$SDD_ENGINE"
fi
ok "$(printf "$I18N_BOOTSTRAP_SDD_OK" "$SDD_ENGINE ($AGENT_PLATFORM)")"
# Exported, not just written to .env (issue #1093): harness/cli.mjs resolves
# its own repoRoot from ITS OWN module location, which is now WORKTREE_ROOT —
# a tree that never gets this .env write. Its precedence is already
# `process.env.X ?? envVars.X ?? config.X`, so exporting here is enough
# regardless of which .env (if any) that resolution finds.
export AGENT_PLATFORM SDD_ENGINE
node "$BRAIN_SCRIPTS/harness/cli.mjs" init \
  || { warn "$I18N_BOOTSTRAP_SDD_INITFAILED"; REQUIRED_FAILURES+=("SDD harness init failed"); }

# --- 7. Team memory (replaceable backend, ADR-0003) --------------------------
# MEMORY_BACKEND (issue #1165): the team's backend is a TEAM decision, so it lives in
# tracked config (brain.config.json `memory.backend`), not only in the untracked .env —
# a second checkout has no .env and used to silently run engram. Resolution is NOT done
# here: memory/lib/backend-resolve.mjs is the ONE resolver (process env > .env >
# brain.config.json > undeclared), shared with memory/cli.mjs, and this block only asks
# it. Undeclared is never guessed: on a TTY the prompt below is where the declaration is
# CREATED (written to brain.config.json, NOT to .env — see the note at the write);
# without a TTY nothing is guessed and memory setup is skipped with the fix named.
say "$I18N_BOOTSTRAP_MEMORY_SECTION"
MEMORY_BACKEND=""
_mb_rc=0
_mb_err="$(mktemp)"
_mb_res="$(node "$BRAIN_SCRIPTS/memory/lib/backend-resolve.mjs" --root "$PWD" 2>"$_mb_err")" || _mb_rc=$?
_mb_source=""
case "$_mb_rc" in
  0)
    MEMORY_BACKEND="${_mb_res%% *}"
    _mb_source="${_mb_res#* }"
    ;;
  4)
    _mb_bad="${_mb_res#! }"
    warn "$(printf "$I18N_BOOTSTRAP_MEMORY_INVALID" "${_mb_bad%% *}" "${_mb_bad#* }")"
    MISSING_OPTIONAL+=("memory backend invalid (next: npm run brain:config -- set memory.backend engram|plainfiles)")
    ;;
  5)
    # brain.config.json exists but could not be read and nothing else declares a backend:
    # "could not look" is NOT "declared nothing" — do not prompt, do not write over it.
    warn "$(printf "$I18N_BOOTSTRAP_MEMORY_UNREADABLE" "$(head -c 300 "$_mb_err")")"
    MISSING_OPTIONAL+=("memory backend not resolved: brain.config.json unreadable (fix or restore it, then re-run env:init)")
    ;;
  3)
    if [ -t 0 ]; then
      # --- BEGIN memory-backend-validate (issue #1112, cold-review should-fix 3) ---
      # Same validation shape as vcs-provider-validate (finding 2) — reused
      # rather than a second style for the same class of prompt: read into a
      # scratch variable, `case` it against the closed set, re-prompt on
      # anything else. Only the two real backends
      # (axes/memory/adapters/engram.mjs, axes/memory/adapters/plainfiles.mjs)
      # are accepted; anything else would land in config and be refused later,
      # far from where the operator typed it. Reads into
      # `_membackend_answer`, not `$MEMORY_BACKEND` directly, so this loop's
      # own `case` is textually distinct from the real backend-dispatch `case
      # "$MEMORY_BACKEND" in` a few lines below — two different literal lines
      # for two different jobs, never one string a test's own extraction could
      # match by accident.
      # NO default (issue #1205, ADR-0004 Amendment 3): the backend is a team decision, so
      # Enter re-prompts instead of declaring one, and a closed stdin (read fails) leaves
      # it empty — the caller then takes the existing undeclared path.
      _membackend_answer=""
      while :; do
        # At EOF `read` returns non-zero even when it filled the variable (a final line with no
        # trailing newline, or Ctrl-D after typing). Keep what was read when it is a valid
        # backend; only an empty or invalid answer at EOF is undeclared (issue #1214).
        if ! read -r -p "  $I18N_BOOTSTRAP_MEMORY_PROMPT" _membackend_answer; then
          case "$_membackend_answer" in engram|plainfiles) ;; *) _membackend_answer="" ;; esac
          break
        fi
        case "$_membackend_answer" in
          engram|plainfiles) break ;;
          '') ;;
          *) printf '  ✗ Unknown backend "%s" — only "engram" or "plainfiles" are supported.\n' "$_membackend_answer" >&2 ;;
        esac
      done
      MEMORY_BACKEND="$_membackend_answer"
      # --- END memory-backend-validate ---
      # --- BEGIN memory-backend-declare (issue #1214) ---
      if [ -z "$MEMORY_BACKEND" ]; then
        # Closed stdin: nothing was answered and nothing is guessed.
        warn "$I18N_BOOTSTRAP_MEMORY_UNDECLARED"
        MISSING_OPTIONAL+=("memory backend undeclared (next: npm run brain:config -- set memory.backend engram|plainfiles, then re-run env:init)")
      else
        # The declaration goes to TRACKED config and NOT to .env: writing .env too would
        # recreate the drift this exists to stop (a stale per-machine line silently beating
        # the team's value). .env stays what it always was: a per-machine override.
        if node "$BRAIN_SCRIPTS/config/cli.mjs" set memory.backend "$MEMORY_BACKEND" >/dev/null 2>&1; then
          warn "$I18N_BOOTSTRAP_MEMORY_DECLARED"
          _mb_source="config"
        else
          warn "$(printf "$I18N_BOOTSTRAP_MEMORY_DECLAREFAILED" "$MEMORY_BACKEND")"
          MISSING_OPTIONAL+=("memory backend not saved to brain.config.json (next: npm run brain:config -- set memory.backend $MEMORY_BACKEND)")
          _mb_source="prompt"
        fi
      fi
      # --- END memory-backend-declare ---
    else
      warn "$I18N_BOOTSTRAP_MEMORY_UNDECLARED"
      MISSING_OPTIONAL+=("memory backend undeclared (next: npm run brain:config -- set memory.backend engram|plainfiles, then re-run env:init)")
    fi
    ;;
  *)
    # Any other exit (node crashed, resolver missing) is a FAILURE of the check, not an answer.
    warn "$(printf "$I18N_BOOTSTRAP_MEMORY_RESOLVERFAILED" "$_mb_rc")"
    MISSING_OPTIONAL+=("memory backend not resolved: the resolver exited $_mb_rc (next: node brain/scripts/memory/lib/backend-resolve.mjs)")
    ;;
esac
rm -f "$_mb_err"
if [ -n "$MEMORY_BACKEND" ]; then
  case "$_mb_source" in
    shell) _mb_where="env" ;;
    file) _mb_where=".env" ;;
    config) _mb_where="brain.config.json" ;;
    *) _mb_where="prompt" ;;
  esac
  ok "$(printf "$I18N_BOOTSTRAP_MEMORY_BACKEND" "$MEMORY_BACKEND" "$_mb_where")"
  if [ "$_mb_source" = "file" ]; then
    # A backend that exists only in this machine's .env is invisible to every other
    # checkout. Existing consumers keep working unchanged; they are TOLD, and never
    # migrated silently — moving it is a tracked-file edit the operator commits.
    _mb_cfg="$(node "$BRAIN_SCRIPTS/config/cli.mjs" get memory.backend 2>/dev/null | tr -d '"' || true)"  # swallow-ok: an unset key is the answer being asked for
    if [ -z "$_mb_cfg" ]; then
      warn "$(printf "$I18N_BOOTSTRAP_MEMORY_ENVONLY" "$MEMORY_BACKEND" "$MEMORY_BACKEND")"
    elif [ "$_mb_cfg" != "$MEMORY_BACKEND" ]; then
      warn "$(printf "$I18N_BOOTSTRAP_MEMORY_ENVSHADOWS" ".env" "$MEMORY_BACKEND" "$_mb_cfg")"
    fi
  fi
  # Same reasoning as AGENT_PLATFORM/SDD_ENGINE above (issue #1093):
  # memory/cli.mjs also resolves its selector from its OWN module location.
  export MEMORY_BACKEND
fi

git config core.hooksPath brain/scripts/hooks \
  && ok "$I18N_BOOTSTRAP_MEMORY_HOOKOK" \
  || { warn "$I18N_BOOTSTRAP_MEMORY_HOOKFAILED"; REQUIRED_FAILURES+=("git hooks path (core.hooksPath) not configured"); }

# --- BEGIN memory-step-helpers (issue #1127) ---
# A memory step fails by CAUSE, not by step. A fresh repo with no commits, a branch with no
# upstream, no remote, an unreachable network and a missing engram binary are all USABLE
# environments: the step is skipped, the next command is printed, and the run still exits 0
# (records-only capture needs no backend — memory-backend-contract.md). A step that was
# attempted and failed for a real reason (a merge refusal, a reconcile refusal, a corrupt
# store) is REQUIRED: it joins REQUIRED_FAILURES and the run exits 1.

# Preflight, never git's wording: prints why a pull cannot even be attempted and returns 0;
# returns 1 when it can be.
memory_pull_unavailable() {
  local tree="$1"
  if ! git -C "$tree" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    printf '%s' "$I18N_BOOTSTRAP_MEMORY_PULL_NOCOMMITS"; return 0
  fi
  if ! git -C "$tree" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    printf '%s' "$I18N_BOOTSTRAP_MEMORY_PULL_NOUPSTREAM"; return 0
  fi
  return 1
}

# The ONE place that reads git's words: was a failed pull a connectivity problem (the network
# or the remote host is unreachable) rather than a real refusal? Takes the captured stderr.
memory_pull_offline() {
  printf '%s' "$1" | grep -qiE 'could not resolve host|unable to access|network is unreachable|connection (timed out|refused)|failed to connect|temporary failure in name resolution|could not read from remote repository'
}

# Runs `brain:memory:pull` in the invoking tree and classifies the outcome.
run_memory_pull() {
  local reason errf
  if reason="$(memory_pull_unavailable "$WORKTREE_ROOT")"; then
    warn "$(printf "$I18N_BOOTSTRAP_MEMORY_PULL_SKIPPED" "$reason")"
    MISSING_OPTIONAL+=("memory pull (next: npm run brain:memory:pull)")
    return 0
  fi
  errf="$(mktemp)"
  if (cd "$WORKTREE_ROOT" && $PM run --silent brain:memory:pull) 2>"$errf"; then
    cat "$errf" >&2; rm -f "$errf"
    ok "$I18N_BOOTSTRAP_MEMORY_PULL_OK"
  else
    cat "$errf" >&2
    if memory_pull_offline "$(cat "$errf")"; then
      warn "$(printf "$I18N_BOOTSTRAP_MEMORY_PULL_SKIPPED" "$I18N_BOOTSTRAP_MEMORY_PULL_OFFLINE")"
      MISSING_OPTIONAL+=("memory pull (next: npm run brain:memory:pull, once the remote is reachable)")
    else
      warn "$I18N_BOOTSTRAP_MEMORY_PULL_FAILED"
      REQUIRED_FAILURES+=("memory pull failed")
    fi
    rm -f "$errf"
  fi
}

# Runs `brain:memory:index` (engram only). Attempted only when the engram binary exists.
run_memory_index() {
  if (cd "$WORKTREE_ROOT" && $PM run --silent brain:memory:index); then
    ok "$I18N_BOOTSTRAP_MEMORY_INDEX_OK"
  else
    warn "$I18N_BOOTSTRAP_MEMORY_INDEX_FAILED"
    REQUIRED_FAILURES+=("memory index failed")
  fi
}
# --- END memory-step-helpers ---

case "$MEMORY_BACKEND" in
  '')
    # Nothing declared (or invalid): already reported above, and no backend was guessed.
    ;;
  engram)
    # Delegate setup (symlink + merge driver) to the backend module — no duplication.
    if command -v node >/dev/null 2>&1; then
      node "$BRAIN_SCRIPTS/memory/cli.mjs" setup \
        && ok "$I18N_BOOTSTRAP_MEMORY_ENGRAM_OK" \
        || { warn "$I18N_BOOTSTRAP_MEMORY_ENGRAM_FAILED"; REQUIRED_FAILURES+=("engram memory setup failed"); }
    else
      warn "$I18N_BOOTSTRAP_MEMORY_NODEABSENT"
    fi
    # Hydration and indexing need the engram BINARY. Without it they are not attempted:
    # not a failure, and records-only capture still works (#1127).
    if command -v engram >/dev/null 2>&1; then
      # Run IN the worktree (issue #1093): `$PM run` resolves the script body from cwd's
      # package.json, and REPO_ROOT's (main tree's) can be a different, older version.
      run_memory_pull
      run_memory_index
    else
      warn "$I18N_BOOTSTRAP_MEMORY_ENGRAMABSENT"
      MISSING_OPTIONAL+=("engram hydration and index (next: install engram, then npm run brain:memory:pull && npm run brain:memory:index)")
    fi
    ;;
  plainfiles)
    # plainfiles is a real, supported backend (axes/memory/adapters/plainfiles.mjs),
    # not a fall-through — issue #1112 (folded finding). It supports `setup`
    # (.memory/records/ + index self-check, no symlink, no merge driver —
    # ADR-0002 is engram-only) and `pull` (git pull + rebuild index).
    # `index` (brain/ doc → memory projection) is deliberately unsupported for
    # plainfiles (design C3 Decision 5, unsupported-op.mjs): it always throws,
    # so it is never called here — calling it would report a real design
    # decision as a spurious "failed (non-blocking)".
    if command -v node >/dev/null 2>&1; then
      node "$BRAIN_SCRIPTS/memory/cli.mjs" setup \
        && ok "$I18N_BOOTSTRAP_MEMORY_PLAINFILES_OK" \
        || { warn "$I18N_BOOTSTRAP_MEMORY_PLAINFILES_FAILED"; REQUIRED_FAILURES+=("plainfiles memory setup failed"); }
    else
      warn "$I18N_BOOTSTRAP_MEMORY_NODEABSENT"
    fi
    run_memory_pull
    ok "$I18N_BOOTSTRAP_MEMORY_PLAINFILES_NOINDEX"
    ;;
  *)
    warn "$(printf "$I18N_BOOTSTRAP_MEMORY_UNKNOWNBACKEND" "$MEMORY_BACKEND")"
    ;;
esac

# --- 8. Open tickets: starting point -----------------------------------------
say "$(printf "$I18N_BOOTSTRAP_BOARD_SECTION" "$PROJECT_PATH")"
node "$BRAIN_SCRIPTS/tracker-board.mjs" \
  || warn "$(printf "$I18N_BOOTSTRAP_BOARD_FAILED" "$VCS_HOST" "$PROJECT_PATH")"  # swallow-ok: the open-ticket board is a read-only listing; a failure loses no state and the message names where to look

# --- 9. Next steps ------------------------------------------------------------
say "$I18N_BOOTSTRAP_DONE_SECTION"
cat <<'EOT'
  Next steps:
    1. Read brain/HOME.md — the entry point to all project knowledge.
    2. Every morning: brain:day:start
       (pulls memory, shows open tickets, checks for brain updates)
    3. Pick a ticket and create your branch: {type}/issue-{iid}-{slug}.
    4. Plan a feature with SDD: brain:project:feature -- --issue [ID]
    5. Before pushing: brain:repo:check; capture durable memory with brain:memory:save --issue <id> (the memory lane, if enabled, ships it; env:init states whether it is)
EOT
if [ "${#MISSING_OPTIONAL[@]}" -gt 0 ]; then
  printf "  $I18N_BOOTSTRAP_DONE_PENDING\n" "${MISSING_OPTIONAL[*]}"
  printf '  %s\n' "$I18N_BOOTSTRAP_DONE_INSTALL"
fi

# --- BEGIN required-failure-summary (issue #1112, cold-review round 3, should-fix) ---
# A refused credential write is not optional (see REQUIRED_FAILURES' own
# declaration near the top of this file) — it must not read as success.
# Named here, in the same final summary a human reads, AND turned into a
# non-zero exit, so anything checking `$?` (a script, a CI step, an agent)
# gets the same answer a human reading "Environment ready" plus this line
# would: env:init did not finish clean.
if [ "${#REQUIRED_FAILURES[@]}" -gt 0 ]; then
  printf "  $I18N_BOOTSTRAP_DONE_REQUIREDFAILED\n" "${REQUIRED_FAILURES[*]}"
  exit 1
fi
# --- END required-failure-summary ---

# --- ADMIN ONLY (one-time) -------------------------------------------------------
# Branch protection is a repo setting, not a per-developer concern.
# After S3 of the governance change merges to the tracker branch, a repo admin
# must run:
#
#   npm run brain:protect
#
# This activates protection on main (required status checks + ≥1 review + no
# force-push). It is idempotent and requires repo-admin permissions.
# See brain/core/methodology/workflow-governance.md for recovery steps.
# ---------------------------------------------------------------------------------
