#!/usr/bin/env bash
# Mac notification for the pr-queue turn: notify.sh <title> <message>
# Sent on every merge and every stop, so the person sees it at once even when
# the terminal is not in front. Arguments go to AppleScript as argv, never
# spliced into the script text. A no-op where osascript does not exist.
set -uo pipefail
title="${1:?title}"; msg="${2:?message}"
command -v osascript >/dev/null || { echo "notify: no osascript; $title: $msg" >&2; exit 0; }
osascript -e 'on run argv' \
  -e 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"' \
  -e 'end run' -- "$title" "$msg"
