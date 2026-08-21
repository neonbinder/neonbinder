#!/bin/bash
# check-e2e-env.sh — verify local Maestro CLI, Java and Chrome match the pins.
#
# Pin files (single source of truth, also read by CI):
#   .maestro/version         Maestro CLI version
#   .java-version            Java major version (jenv-compatible)
#   .maestro/chrome-version  Chrome for Testing version (local runs only)
#
# Exits 0 if all three match the pins, 1 otherwise with actionable next steps.
# Run as `npm run test:e2e:check` or directly.
#
# NEO-138: the Chrome check exists because passing this script used to say
# nothing about whether local E2E actually worked. Java 21 gets flows to
# *start*; the Chrome pin is what gets them to *pass*. Both must hold.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAESTRO_VERSION_FILE="$SCRIPT_DIR/.maestro/version"
JAVA_VERSION_FILE="$SCRIPT_DIR/.java-version"

# ── Color helpers (only when stdout is a TTY) ─────────────────────────────────
if [ -t 1 ]; then
  R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; N=$'\033[0m'
else
  R=""; G=""; Y=""; N=""
fi

ok()   { echo "${G}✓${N} $*"; }
fail() { echo "${R}✗${N} $*" >&2; }
warn() { echo "${Y}!${N} $*"; }

failures=0

# ── Maestro CLI ───────────────────────────────────────────────────────────────
if [ ! -f "$MAESTRO_VERSION_FILE" ]; then
  fail "Missing $MAESTRO_VERSION_FILE — cannot determine pinned Maestro version."
  exit 1
fi
pinned_maestro="$(tr -d '[:space:]' < "$MAESTRO_VERSION_FILE")"

# Suppress the first-run analytics opt-in banner so `--version` returns just
# the version string. Defensive: also extract via regex so a stale Maestro
# install that hasn't seen MAESTRO_CLI_NO_ANALYTICS yet still verifies cleanly.
export MAESTRO_CLI_NO_ANALYTICS=1

maestro_bin="${MAESTRO_BIN:-$HOME/.maestro/bin/maestro}"
if [ ! -x "$maestro_bin" ]; then
  fail "Maestro CLI not found at ${maestro_bin}"
  echo "    → Install: ./setup-maestro.sh"
  failures=$((failures + 1))
else
  installed_maestro="$("$maestro_bin" --version 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+$' | tail -1)"
  installed_maestro="${installed_maestro:-unknown}"
  if [ "$installed_maestro" = "$pinned_maestro" ]; then
    ok "Maestro ${installed_maestro} matches pin"
  else
    fail "Maestro ${installed_maestro} installed but pin requires ${pinned_maestro}"
    echo "    → Reinstall pinned version:"
    echo "        rm -f ${maestro_bin}"
    echo "        ./setup-maestro.sh"
    failures=$((failures + 1))
  fi
fi

# ── Java ──────────────────────────────────────────────────────────────────────
if [ -f "$JAVA_VERSION_FILE" ]; then
  pinned_java="$(tr -d '[:space:]' < "$JAVA_VERSION_FILE")"
else
  pinned_java="21"
fi

if ! command -v java &>/dev/null; then
  fail "java not on PATH"
  echo "    → Install: ./setup-maestro.sh (or use jenv / sdkman to pick up .java-version / .sdkmanrc)"
  failures=$((failures + 1))
else
  java_major="$(java -version 2>&1 | head -1 | awk -F '"' '{print $2}' | cut -d. -f1)"
  if [ "$java_major" = "$pinned_java" ]; then
    ok "Java ${java_major} matches pin"
  else
    fail "Java ${java_major} active but pin requires ${pinned_java}"
    echo "    Maestro ${pinned_maestro} + OpenJDK 23 on macOS hits a JVM SIGSEGV"
    echo "    (hs_err_pid*.log) — known-bad combo. Switch to Java ${pinned_java}."
    echo ""
    echo "    Options:"
    echo "        jenv:    jenv local ${pinned_java}"
    echo "        sdkman:  sdk env install   (reads .sdkmanrc)"
    echo "        manual:  install Temurin ${pinned_java} from https://adoptium.net/"
    failures=$((failures + 1))
  fi
fi

# ── Chrome for Testing ────────────────────────────────────────────────────────
# Branded Google Chrome exposes chrome://omnibox-popup CDP targets ahead of the
# real tab. Maestro's CdpTarget model carries no `type` field, so it can't skip
# them and ends up driving the popup widget — every flow then runs in a 1x1
# viewport (heightPixels=1) with 1x1 failure screenshots, which reads exactly
# like a product bug. Chrome for Testing exposes no such targets.
# shellcheck source=lib-e2e-chrome.sh
source "$SCRIPT_DIR/lib-e2e-chrome.sh"
chrome_log="$(mktemp)"
# Note: no command substitution here — require_chrome_for_testing must run in
# THIS shell so the SE_BROWSER_PATH it exports survives to be reported.
if [ -n "$CI" ]; then
  ok "Chrome check skipped (CI installs its own via setup-chrome)"
elif require_chrome_for_testing 2>"$chrome_log"; then
  ok "Chrome for Testing $(e2e_chrome_pin) present"
  echo "    $SE_BROWSER_PATH"
else
  fail "Chrome for Testing $(e2e_chrome_pin 2>/dev/null || echo '(unpinned)') not usable"
  sed -e 's/^✗ //' -e 's/^/    /' "$chrome_log"
  failures=$((failures + 1))
fi
rm -f "$chrome_log"

if [ "$failures" -gt 0 ]; then
  echo ""
  fail "${failures} check(s) failed"
  exit 1
fi
ok "All E2E environment checks passed"
