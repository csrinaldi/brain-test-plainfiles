#!/usr/bin/env bash
# install-tools.sh — Installs the full development ecosystem on Ubuntu/Debian.
#
# Idempotent: skips already-installed tools.
# Run once per machine, before npm run env:init.
# Usage: bash brain/scripts/install-tools.sh
#        npm run tools:install
set -euo pipefail

# Steps that FAILED (#1127): a failed step ends the run incomplete, never as a clean summary.
FAILED_STEPS=()

say()    { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()     { printf '  ✓ %s\n' "$1"; }
warn()   { printf '  ⚠ %s\n' "$1"; }
# skip() uses $I18N_TOOLS_INSTALLED, defined by the i18n eval below (after VCS detection).
# Bash evaluates the function body at call time, so the variable is expanded correctly.
skip()   { printf '  → %s (%s)\n' "$1" "$I18N_TOOLS_INSTALLED"; }
die()    { printf '\n  ✗ %s\n' "$1" >&2; exit 1; }

# ── Verify distro ─────────────────────────────────────────────────────────────
# i18n not loaded yet (eval happens after VCS detection); use inline English default.
if ! command -v apt-get >/dev/null 2>&1; then
  die "${I18N_TOOLS_REQUIRE_NOAPT:-This script requires apt-get (Ubuntu/Debian). Install the tools manually following brain/project/methodology/developer-environment.md.}"
fi

# ── Resolve VCS provider from brain.config.json (gitlab only when there is NO config) ──
# An ABSENT config keeps the documented default. An UNREADABLE one is refused: guessing
# gitlab would hand a GitHub repo `glab` (#1127). node may not be installed yet, so the
# one field is read without it in that case.
if [ -f brain.config.json ]; then
  if command -v node >/dev/null 2>&1; then
    VCS_PROVIDER="$(node -p "(require('./brain.config.json').vcs||{}).provider||'gitlab'")" \
      || die "brain.config.json exists but cannot be read or parsed — fix it, then re-run. Refusing to guess the VCS provider."
  else
    # Without node only a plain `"vcs": { ... "provider": "<name>" ... }` object is understood;
    # anything else (including no provider, or an empty one) takes the same gitlab default the
    # node path uses. Corruption cannot be detected here — install node and re-run to validate.
    printf '  note: node is not installed yet — reading vcs.provider with a simple text match\n' >&2
    VCS_PROVIDER="$(tr -d '\n' < brain.config.json | sed -n 's/.*"vcs"[[:space:]]*:[[:space:]]*{[^}]*"provider"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
    VCS_PROVIDER="${VCS_PROVIDER:-gitlab}"
  fi
else
  VCS_PROVIDER="gitlab"
fi
case "$VCS_PROVIDER" in
  github) VCS_CLI="gh" ;;
  *)      VCS_CLI="glab" ;;
esac

# ── i18n: source active locale catalog (graceful degradation) ─────────────────
# Placed after VCS_CLI is known. English defaults are available via ${VAR:-…} if
# node is absent (unlikely at this point since the distro check passed).
if command -v node >/dev/null 2>&1; then
  _i18n_vars="$(node brain/scripts/i18n/sh.mjs 2>/dev/null)"
  [ -n "$_i18n_vars" ] && eval "$_i18n_vars"
  unset _i18n_vars
fi

# ── 1. apt packages ───────────────────────────────────────────────────────────
# The VCS CLI is handled separately (§1b): gh is not in the default Debian/Ubuntu
# apt repos, so a blanket `apt install gh` would abort under `set -e`.
say "$I18N_TOOLS_APT_SECTION"
APT_PKGS=(git curl wget python3 openjdk-17-jdk maven)
MISSING_APT=()
for pkg in "${APT_PKGS[@]}"; do
  if dpkg -s "$pkg" >/dev/null 2>&1; then
    skip "$pkg"
  else
    MISSING_APT+=("$pkg")
  fi
done
if [ "${#MISSING_APT[@]}" -gt 0 ]; then
  printf "  $I18N_TOOLS_APT_INSTALLING\n" "${MISSING_APT[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y "${MISSING_APT[@]}"
  ok "$(printf "$I18N_TOOLS_APT_OK" "${MISSING_APT[*]}")"
else
  ok "$I18N_TOOLS_APT_ALLPRESENT"
fi

# ── 1b. VCS CLI (gh / glab) ───────────────────────────────────────────────────
# Installed apart from the apt batch: gh may be absent from the default repos, so
# we try apt and fall back to printed install instructions (no abort under set -e).
say "$(printf "$I18N_TOOLS_VCS_SECTION" "$VCS_CLI")"
if command -v "$VCS_CLI" >/dev/null 2>&1; then
  skip "$VCS_CLI"
elif sudo apt-get install -y "$VCS_CLI" 2>/dev/null; then
  ok "$(printf "$I18N_TOOLS_VCS_INSTALLED" "$VCS_CLI")"
else
  warn "$(printf "$I18N_TOOLS_VCS_NOTINAPT" "$VCS_CLI")"
  if [ "$VCS_CLI" = "gh" ]; then
    printf '    https://github.com/cli/cli/blob/trunk/docs/install_linux.md\n'
  else
    printf '    https://gitlab.com/gitlab-org/cli#installation\n'
  fi
fi

# ── 2. Node.js via nvm ────────────────────────────────────────────────────────
say "Node.js (nvm)"
if command -v node >/dev/null 2>&1; then
  skip "node $(node --version)"
else
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -d "$NVM_DIR" ]; then
    printf '  %s\n' "$I18N_TOOLS_NODE_INSTALLING"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    ok "$I18N_TOOLS_NODE_NVMOK"
  fi
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
  ok "$(printf "$I18N_TOOLS_NODE_NODEOK" "$(node --version)")"
  warn "$I18N_TOOLS_NODE_RELOADSHELL"
fi

# ── 3. Claude Code ────────────────────────────────────────────────────────────
say "$I18N_TOOLS_CLAUDE_SECTION"
if command -v claude >/dev/null 2>&1; then
  skip "claude $(claude --version 2>/dev/null | head -1)"
else
  npm install -g @anthropic-ai/claude-code
  ok "$I18N_TOOLS_CLAUDE_INSTALLED"
fi

# ── 4. Codex (only for an effective Codex cold-review route) ──────────────────
# The generic stage resolver keeps model identifiers opaque. This route-specific
# helper is intentionally the only setup reader that pins the Codex contract.
CODEX_REQUIRED="$(node brain/scripts/harness/codex-readiness.mjs --required)"
say "Codex cold-review"
if [ "$CODEX_REQUIRED" = "yes" ]; then
  if command -v codex >/dev/null 2>&1; then
    skip "codex $(codex --version 2>/dev/null | head -1)"
  else
    npm install -g @openai/codex
    ok "Codex CLI installed"
  fi
  if CODEX_READINESS="$(node brain/scripts/harness/codex-readiness.mjs --check 2>&1)"; then
    ok "$CODEX_READINESS"
  else
    warn "$CODEX_READINESS"
  fi
else
  skip "codex (cold-review route does not select Codex)"
fi

# ── 5. gentle-ai (manages engram + gga + skills) ──────────────────────────────
say "$I18N_TOOLS_GENTLEAI_SECTION"
if command -v gentle-ai >/dev/null 2>&1; then
  skip "gentle-ai $(gentle-ai --version 2>/dev/null | head -1)"
else
  printf '  %s\n' "$I18N_TOOLS_GENTLEAI_INSTALLING"
  curl -fsSL https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/scripts/install.sh | bash
  ok "$I18N_TOOLS_GENTLEAI_OK"
fi

# gentle-ai install configures engram, gga and the SDD harness skills.
# Idempotent: confirms if already configured.
if command -v gentle-ai >/dev/null 2>&1; then
  if gentle-ai doctor 2>/dev/null | grep -q 'state file OK'; then
    skip "$I18N_TOOLS_GENTLEAI_ALREADYCONFIGURED"
  else
    printf '  %s\n' "$I18N_TOOLS_GENTLEAI_CONFIGURING"
    gentle-ai install && ok "$I18N_TOOLS_GENTLEAI_CONFIGURED" || { warn "$I18N_TOOLS_GENTLEAI_CONFIGFAILED"; FAILED_STEPS+=("gentle-ai configuration"); }
  fi
fi

# ── 5. Summary ────────────────────────────────────────────────────────────────
if [ "${#FAILED_STEPS[@]}" -gt 0 ]; then
  printf "  $I18N_TOOLS_SUMMARY_INCOMPLETE\n" "${FAILED_STEPS[*]}" >&2
  exit 1
fi
say "$I18N_TOOLS_SUMMARY_SECTION"
printf '  %s\n' "$I18N_TOOLS_SUMMARY_NEXTSTEP"
printf '    npm install && npm run env:init\n\n'
printf '  %s\n' "$I18N_TOOLS_SUMMARY_CHECKVERSIONS"
for tool in git java maven node npm claude gentle-ai engram gga "$VCS_CLI"; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '    ✓ %-14s' "$tool"
    "$tool" --version 2>/dev/null | head -1 | sed 's/^//' || true  # swallow-ok: a version banner is cosmetic; the tool's presence was already established above
    echo
  else
    printf "    ✗ $I18N_TOOLS_SUMMARY_NOTFOUND\n" "$tool"
  fi
done
