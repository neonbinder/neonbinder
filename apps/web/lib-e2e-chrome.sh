#!/bin/bash
# lib-e2e-chrome.sh — Chrome resolution + orphan cleanup for local Maestro runs.
#
# Source this; don't execute it:
#     source ./lib-e2e-chrome.sh
#     require_chrome_for_testing      # exports SE_BROWSER_PATH or exits 1
#     kill_orphan_e2e_chrome          # sweeps browsers a previous run left behind
#
# ── Why this exists (NEO-138) ────────────────────────────────────────────────
# Maestro's web driver picks the page it drives from Chrome's CDP target list
# (`/json/list`). Its CdpTarget model deserializes only id/title/url/wsUrl —
# there is no `type` field — so it cannot filter to real pages and takes the
# first entry. Branded Google Chrome stable 151 lists two browser_ui targets
# BEFORE the real tab:
#
#     browser_ui | chrome://omnibox-popup.top-chrome/
#     browser_ui | chrome://omnibox-popup.top-chrome/omnibox_popup_aim.html
#     page       | data:,
#
# so Maestro navigates the omnibox popup WIDGET to the app URL instead of the
# tab. That widget isn't in the tab strip (Browser.getWindowForTarget returns
# "Browser window not found") and its layout viewport is 1x1, which surfaces as:
#
#     DeviceInfo(platform=WEB, widthPixels=830, heightPixels=1)   # headless
#     DeviceInfo(platform=WEB, widthPixels=1006, heightPixels=1)  # headed
#
# with 1x1 failure screenshots. Assertions on content at the very top of the
# page still pass, so it reads exactly like a product bug and cost several
# sessions of misdiagnosis before being traced.
#
# Chrome for Testing exposes no omnibox-popup targets, which is also why CI has
# stayed green: CI installs Chrome via browser-actions/setup-chrome, not the
# branded stable build. Pointing Selenium Manager at a Chrome for Testing binary
# (SE_BROWSER_PATH) restores a real 1024x625 viewport.
#
# `--disable-features=WebUIOmniboxPopup` is NOT a fix — it removes only the
# first of the two popup targets; the omnibox_popup_aim one survives.

# ── Pin ───────────────────────────────────────────────────────────────────────
# .maestro/chrome-version is the single source of truth, alongside
# .maestro/version (Maestro) and .java-version (JDK).
_e2e_chrome_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_e2e_chrome_pin_file="$_e2e_chrome_dir/.maestro/chrome-version"

e2e_chrome_pin() {
  [ -f "$_e2e_chrome_pin_file" ] || return 1
  tr -d '[:space:]' < "$_e2e_chrome_pin_file"
}

# Platform directory used by @puppeteer/browsers inside its cache.
e2e_chrome_platform() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64)  echo "mac_arm" ;;
    Darwin/x86_64) echo "mac" ;;
    Linux/*)       echo "linux" ;;
    *)             echo "linux" ;;
  esac
}

# Absolute path to the pinned Chrome for Testing executable (may not exist yet).
e2e_chrome_expected_path() {
  local pin platform cache
  pin="$(e2e_chrome_pin)" || return 1
  platform="$(e2e_chrome_platform)"
  cache="${PUPPETEER_CACHE_DIR:-$HOME/.cache/puppeteer}"
  case "$platform" in
    mac_arm) echo "$cache/chrome/mac_arm-$pin/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" ;;
    mac)     echo "$cache/chrome/mac-$pin/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" ;;
    *)       echo "$cache/chrome/linux-$pin/chrome-linux64/chrome" ;;
  esac
}

e2e_chrome_install_hint() {
  local pin; pin="$(e2e_chrome_pin || echo '<pin>')"
  echo "    → Install the pinned build:"
  echo "        npx @puppeteer/browsers install chrome@${pin} --path \"\${PUPPETEER_CACHE_DIR:-\$HOME/.cache/puppeteer}\""
  echo "      or run ./setup-maestro.sh, which does it for you."
}

# ── Guard: reject the branded stable build ────────────────────────────────────
# Catches someone exporting SE_BROWSER_PATH by hand at the thing that is
# precisely the problem.
e2e_chrome_is_branded() {
  case "$1" in
    *"Google Chrome.app"*|*"Google Chrome Canary.app"*|*"Google Chrome Beta.app"*|*"Google Chrome Dev.app"*)
      return 0 ;;
    */google-chrome|*/google-chrome-stable) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Keychain shim ─────────────────────────────────────────────────────────────
# Chrome encrypts profile secrets (cookies, tokens) with a key kept in the macOS
# login keychain under "Chromium Safe Storage". A FRESH --user-data-dir — which
# is what chromedriver hands every Maestro run — has no key yet, so Chrome asks
# the OS for one and macOS raises a MODAL password dialog:
#
#     "Google Chrome for Testing wants to use your confidential information
#      stored in Chromium Safe Storage in your keychain."
#
# Chrome does not finish starting until that dialog is answered, so the run
# looks exactly like a hung page load: `GET /session/<id>/url` times out, the
# failure screenshot is blank at the CORRECT 1024x625 (this is NOT NEO-138), and
# the dev server records no request at all. It is intermittent by nature —
# whoever dismisses the dialog un-wedges that single run.
#
# `--use-mock-keychain` swaps in an in-memory stub, so Chrome never touches the
# keychain and never prompts. E2E needs no real encrypted storage: marketplace
# credentials live server-side in Secret Manager, never in the browser profile.
#
# Maestro owns the ChromeOptions it builds and exposes no extra-args hook we can
# reach, but Selenium DOES exec whatever SE_BROWSER_PATH points at — so point it
# at a shim that appends the flag. `exec` replaces the shim with the real binary,
# so `ps` still shows the true Chrome path and the orphan sweep below keeps
# matching it.
#
# Falls back to the real path on any failure: a missing shim must never be worse
# than no shim. CI never hits this (no login keychain) and is left alone.
_e2e_chrome_wrap_keychain() {
  local real="$1"
  local dir="${TMPDIR:-/tmp}/neonbinder-e2e-chrome-shim"
  local shim="$dir/chrome"
  mkdir -p "$dir" 2>/dev/null || { echo "$real"; return 0; }
  cat >"$shim" 2>/dev/null <<EOF || { echo "$real"; return 0; }
#!/bin/bash
# Generated by lib-e2e-chrome.sh — do not edit. See _e2e_chrome_wrap_keychain.
exec "$real" --use-mock-keychain "\$@"
EOF
  chmod +x "$shim" 2>/dev/null || { echo "$real"; return 0; }
  echo "$shim"
}

# ── Main entry point ──────────────────────────────────────────────────────────
# Exports SE_BROWSER_PATH (read by Selenium Manager, which Maestro's web driver
# uses to launch Chrome). Returns non-zero and explains itself if it can't.
#
# In CI this is a no-op unless SE_BROWSER_PATH is already set: the workflow's
# browser-actions/setup-chrome step already provides a non-branded Chrome, and
# that path is the one every green run has used.
require_chrome_for_testing() {
  if [ -n "$SE_BROWSER_PATH" ]; then
    if e2e_chrome_is_branded "$SE_BROWSER_PATH"; then
      echo "✗ SE_BROWSER_PATH points at branded Google Chrome:" >&2
      echo "    $SE_BROWSER_PATH" >&2
      echo "  Branded Chrome breaks Maestro's viewport (NEO-138) — every flow will" >&2
      echo "  fail with heightPixels=1. Unset it and let this script resolve the" >&2
      echo "  pinned Chrome for Testing build instead." >&2
      return 1
    fi
    if [ ! -x "$SE_BROWSER_PATH" ]; then
      echo "✗ SE_BROWSER_PATH is set but not executable: $SE_BROWSER_PATH" >&2
      return 1
    fi
    export SE_BROWSER_PATH
    return 0
  fi

  if [ -n "$CI" ]; then
    return 0
  fi

  local pin path
  if ! pin="$(e2e_chrome_pin)"; then
    echo "✗ Missing $_e2e_chrome_pin_file — cannot determine the pinned Chrome version." >&2
    return 1
  fi
  path="$(e2e_chrome_expected_path)"

  if [ ! -x "$path" ]; then
    echo "✗ Chrome for Testing ${pin} not installed." >&2
    echo "  Local Maestro MUST NOT use branded Google Chrome: its omnibox-popup CDP" >&2
    echo "  targets make Maestro drive a 1x1 widget instead of the tab, so every" >&2
    echo "  flow fails with heightPixels=1 (NEO-138)." >&2
    e2e_chrome_install_hint >&2
    return 1
  fi

  export SE_BROWSER_PATH="$(_e2e_chrome_wrap_keychain "$path")"
  return 0
}

# ── Orphan cleanup ────────────────────────────────────────────────────────────
# Maestro sets chromedriver's `detach` option, so a killed or timed-out run
# leaves its browser running forever. They accumulate at ~280MB each and contend
# with the next run.
#
# Selection matches on the EXECUTABLE (ps `comm`), never on the full command
# line. Matching the command line is actively dangerous here: any process whose
# arguments merely mention the Chrome path — including the E2E runner itself,
# which exports SE_BROWSER_PATH — gets swept up and killed. That is not
# hypothetical; it killed the calling shell the first time this was tested.
#
# What counts as automation:
#   */chromedriver                  only ever automation
#   */Google Chrome for Testing     only ever automation
#   */Google Chrome (branded)       ONLY when its args show a chromedriver temp
#                                   profile or webdriver test type — i.e. never
#                                   a real browsing session
#
# Helper/renderer subprocesses are deliberately not matched (their comm ends in
# "Google Chrome Helper"); killing each browser's main process takes them down.
# Safe to call when nothing is running — it's a no-op.
kill_orphan_e2e_chrome() {
  local quiet="${1:-}"
  local pids=""
  local self=$$

  while read -r pid comm; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$self" ] && continue
    case "$comm" in
      */chromedriver|*/chromedriver-mac-arm64|*/chromedriver-mac-x64)
        pids="$pids $pid" ;;
      *"/Google Chrome for Testing")
        pids="$pids $pid" ;;
      *"/Google Chrome"|*/google-chrome|*/google-chrome-stable|*/chrome)
        # Branded/system Chrome: only if it is a webdriver-launched instance.
        if ps -o command= -p "$pid" 2>/dev/null \
             | grep -qE "Chromium\.scoped_dir|--test-type=webdriver"; then
          pids="$pids $pid"
        fi ;;
    esac
  done < <(ps -Ao pid=,comm=)

  pids=$(echo "$pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u)
  if [ -z "$pids" ]; then
    [ "$quiet" = "quiet" ] || echo "✓ no orphaned E2E Chrome/chromedriver processes"
    return 0
  fi

  local count
  count=$(echo "$pids" | wc -l | tr -d ' ')
  [ "$quiet" = "quiet" ] || echo "⌫ killing ${count} orphaned E2E Chrome/chromedriver process(es)"
  for p in $pids; do kill -TERM "$p" 2>/dev/null; done
  sleep 2
  for p in $pids; do kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; done
  return 0
}

# Executed rather than sourced: run the sweeper. Handy as a one-liner
# (`./lib-e2e-chrome.sh`) and from the pr-close skill.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  kill_orphan_e2e_chrome
fi
