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
#
# NEO-258 adds a second job on macOS: the resolved path is a generated wrapper
# that launches the same binary with `--run-all-compositor-stages-before-draw`,
# without which headless Chrome's renderer can stop producing frames and every
# Maestro scroll silently becomes a no-op. See e2e_chrome_launcher_for.

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

  export SE_BROWSER_PATH="$(e2e_chrome_launcher_for "$path")"
  return 0
}

# ── Compositor flag wrapper (NEO-258) ────────────────────────────────────────
# On macOS, headless Chrome for Testing under maestro-web stops producing
# animation frames once the set-selector reveals a new column: measured
# `requestAnimationFrame` 0/s while `setInterval` ran normally, page visible,
# focused and scrollable. maestro-web's only scroll primitive is
# `window.scroll({behavior:'smooth'})`, which is frame-driven, so every scroll
# then moves 0px and still reports COMPLETED, `takeScreenshot` hangs, and
# `- swipe` hangs chromedriver for 180s. It is intermittent, and it reads
# exactly like a product bug. CI (Linux) has never shown it.
#
# `--run-all-compositor-stages-before-draw` clears it (9/9 screenshots and 8/8
# scrolls on two runs, versus 0-1 screenshots without; `--headless=old` and
# `--disable-new-content-rendering-timeout` do not). Maestro hard-codes its
# ChromeOptions with no hook for extra args, so the flag rides in through the
# one door the harness owns: SE_BROWSER_PATH points at a tiny wrapper that
# execs the real binary with the flag appended. `exec` means the process
# executable stays "Google Chrome for Testing", so kill_orphan_e2e_chrome and
# Selenium Manager's `--version` probe both see the real thing.
#
# The wrapper lives NEXT TO the pinned build inside the puppeteer cache (never
# in the repo), is regenerated whenever the pin moves, and applies on macOS
# only: CI's Chrome is untouched. E2E_CHROME_COMPOSITOR_FLAG=0 opts out (for
# a before/after timing comparison); =1 forces it on other platforms.
e2e_chrome_compositor_flag="--run-all-compositor-stages-before-draw"

e2e_chrome_launcher_for() {
  local real="$1" want wrapper
  case "${E2E_CHROME_COMPOSITOR_FLAG:-}" in
    0) echo "$real"; return 0 ;;
    1) want=1 ;;
    *) case "$(uname -s)" in Darwin) want=1 ;; *) want=0 ;; esac ;;
  esac
  if [ "$want" != 1 ]; then echo "$real"; return 0; fi

  # One level above the .app bundle (never inside it: adding a file to a signed
  # bundle is what makes Gatekeeper call it damaged), i.e. the platform dir
  # @puppeteer/browsers unpacked, next to the bundle itself.
  wrapper="$(dirname "$real")/../../../nb-chrome-launcher.sh"
  wrapper="$(cd "$(dirname "$wrapper")" 2>/dev/null && pwd)/$(basename "$wrapper")" || { echo "$real"; return 0; }
  local body
  body="$(printf '#!/bin/bash
# Generated by lib-e2e-chrome.sh (NEO-258). Do not edit; regenerated per run.
exec %q "$@" %s
' "$real" "$e2e_chrome_compositor_flag")"
  if [ ! -f "$wrapper" ] || [ "$(cat "$wrapper" 2>/dev/null)" != "$body" ]; then
    printf '%s
' "$body" > "$wrapper" 2>/dev/null && chmod +x "$wrapper" 2>/dev/null || { echo "$real"; return 0; }
  fi
  echo "$wrapper"
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
