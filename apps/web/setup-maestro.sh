#!/bin/bash
set -e

# setup-maestro.sh — Install Java 21 and Maestro CLI for E2E testing
# Works on macOS (brew) and Linux (apt / SDKMAN fallback, no sudo required)
#
# Versions are pinned via:
#   - .maestro/version    Maestro CLI version (single source of truth)
#   - .java-version       Java major version (jenv-compatible)
# CI reads the same files. Bumping either is a single PR.

MAESTRO_BIN="$HOME/.maestro/bin"
MAESTRO_CLI="$MAESTRO_BIN/maestro"

# Resolve repo root so we can read pin files regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAESTRO_VERSION_FILE="$SCRIPT_DIR/.maestro/version"
JAVA_VERSION_FILE="$SCRIPT_DIR/.java-version"

if [ ! -f "$MAESTRO_VERSION_FILE" ]; then
  echo "❌ Missing $MAESTRO_VERSION_FILE — cannot determine pinned Maestro version." >&2
  exit 1
fi
PINNED_MAESTRO_VERSION="$(tr -d '[:space:]' < "$MAESTRO_VERSION_FILE")"

if [ -f "$JAVA_VERSION_FILE" ]; then
  PINNED_JAVA_VERSION="$(tr -d '[:space:]' < "$JAVA_VERSION_FILE")"
else
  PINNED_JAVA_VERSION="21"
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
info()    { echo "ℹ️  $*"; }
success() { echo "✅ $*"; }
warn()    { echo "⚠️  $*"; }
die()     { echo "❌ $*"; exit 1; }

# ── Java (pinned via .java-version) ───────────────────────────────────────────
java_major_version() {
  java -version 2>&1 | head -1 | awk -F '"' '{print $2}' | cut -d. -f1
}

has_pinned_java() {
  command -v java &>/dev/null || return 1
  local ver
  ver=$(java_major_version 2>/dev/null)
  [[ "$ver" == "$PINNED_JAVA_VERSION" ]] 2>/dev/null
}

# Older versions of this script accepted Java 17+. We now require an exact
# major-version match because Maestro 2.6.x + OpenJDK 23 on macOS hits a JVM
# SIGSEGV in the symbol-table code (hs_err_pid*.log) — known-bad combo.
# Pin to .java-version (default: 21, the current LTS) until that's fixed upstream.

install_java_apt() {
  if command -v sudo &>/dev/null; then
    info "Installing OpenJDK ${PINNED_JAVA_VERSION} via apt..."
    sudo apt-get update -qq && sudo apt-get install -y "openjdk-${PINNED_JAVA_VERSION}-jdk"
  else
    warn "apt available but no sudo — falling back to SDKMAN"
    return 1
  fi
}

install_java_brew() {
  info "Installing OpenJDK ${PINNED_JAVA_VERSION} via Homebrew..."
  brew install "openjdk@${PINNED_JAVA_VERSION}"
  # Brew-installed JDK isn't on PATH by default
  local brew_jdk
  brew_jdk="$(brew --prefix "openjdk@${PINNED_JAVA_VERSION}")/libexec/openjdk.jdk/Contents/Home"
  if [ -d "$brew_jdk" ]; then
    export JAVA_HOME="$brew_jdk"
    export PATH="$JAVA_HOME/bin:$PATH"
  fi
}

install_java_sdkman() {
  info "Installing Java ${PINNED_JAVA_VERSION}-tem via SDKMAN (no sudo required)..."
  if [ ! -f "$HOME/.sdkman/bin/sdkman-init.sh" ]; then
    curl -s "https://get.sdkman.io" | bash
  fi
  # shellcheck disable=SC1090
  source "$HOME/.sdkman/bin/sdkman-init.sh"
  sdk install java "${PINNED_JAVA_VERSION}-tem" < /dev/null   # non-interactive
  sdk use java "${PINNED_JAVA_VERSION}-tem"
}

if has_pinned_java; then
  success "Java $(java_major_version) detected (matches pin: ${PINNED_JAVA_VERSION})"
else
  current_java_ver="$(java_major_version 2>/dev/null || echo none)"
  if [ "$current_java_ver" != "none" ]; then
    warn "Java ${current_java_ver} found but pin requires ${PINNED_JAVA_VERSION}. Installing ${PINNED_JAVA_VERSION}..."
    warn "Tip: install jenv (https://www.jenv.be/) or sdkman (https://sdkman.io/) to switch JDKs automatically based on .java-version / .sdkmanrc."
  else
    info "Java ${PINNED_JAVA_VERSION} not found — installing..."
  fi
  if [[ "$OSTYPE" == "darwin"* ]]; then
    if command -v brew &>/dev/null; then
      install_java_brew
    else
      install_java_sdkman
    fi
  elif command -v apt-get &>/dev/null; then
    install_java_apt || install_java_sdkman
  else
    install_java_sdkman
  fi

  # Source SDKMAN if it was just installed
  if [ -f "$HOME/.sdkman/bin/sdkman-init.sh" ]; then
    # shellcheck disable=SC1090
    source "$HOME/.sdkman/bin/sdkman-init.sh"
  fi

  has_pinned_java || die "Java ${PINNED_JAVA_VERSION} installation failed. Install manually and re-run."
  success "Java $(java_major_version) installed"
fi

# ── Maestro CLI ───────────────────────────────────────────────────────────────
# Suppress the first-run analytics opt-in banner so `maestro --version` returns
# just the version. Without this, the version-match check below sees multi-line
# output on a fresh install. Also exported so subsequent shells inherit it.
export MAESTRO_CLI_NO_ANALYTICS=1

# Extract just the semver line from `maestro --version` output — defensive
# against any leftover banner text if MAESTRO_CLI_NO_ANALYTICS isn't honored.
maestro_version_of() {
  "$1" --version 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+$' | tail -1
}

install_pinned_maestro() {
  info "Installing Maestro ${PINNED_MAESTRO_VERSION}..."
  # The Maestro installer honors MAESTRO_VERSION to grab a specific tag instead
  # of latest. Without this, local boxes drift from CI as upstream releases land.
  MAESTRO_VERSION="$PINNED_MAESTRO_VERSION" curl -Ls "https://get.maestro.mobile.dev" | bash
}

if [ -f "$MAESTRO_CLI" ]; then
  CURRENT_VERSION="$(maestro_version_of "$MAESTRO_CLI")"
  CURRENT_VERSION="${CURRENT_VERSION:-unknown}"
  if [ "$CURRENT_VERSION" = "$PINNED_MAESTRO_VERSION" ]; then
    success "Maestro ${CURRENT_VERSION} already installed (matches pin)"
  else
    warn "Maestro ${CURRENT_VERSION} installed but pin requires ${PINNED_MAESTRO_VERSION}. Reinstalling..."
    install_pinned_maestro
  fi
else
  install_pinned_maestro
fi

export PATH="$MAESTRO_BIN:$PATH"

# Verify the version matches what we asked for. If the installer ignored
# MAESTRO_VERSION (e.g. older installer script), bail loudly rather than
# silently shipping a different version.
"$MAESTRO_CLI" --version &>/dev/null || die "Maestro install verification failed"
installed_version="$(maestro_version_of "$MAESTRO_CLI")"
if [ "$installed_version" != "$PINNED_MAESTRO_VERSION" ]; then
  die "Maestro install reported '${installed_version}' but pin requires '${PINNED_MAESTRO_VERSION}'. Check $MAESTRO_VERSION_FILE."
fi
success "Maestro ${installed_version} ready (pinned)"

# ── PATH reminder ─────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Setup complete. To use maestro in your shell, add:"
echo ""
echo "    export PATH=\"\$HOME/.maestro/bin:\$PATH\""
echo ""
echo "  to your ~/.zshrc or ~/.bashrc, then restart your shell."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
