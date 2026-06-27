---
name: Set-selector flow conversion rules (independent model)
description: How to convert set-selector flows to the independent model — the harness, drill, footer-steal, and fresh-mount rules learned the hard way (NEO-46)
type: feedback
---

Converting a set-selector flow that DRILLS (Sport→Year→Manufacturer→Set→variant)
to the independent model. Four rules, each cost real debugging:

## 1. Drilling flows need a WARM marketplace token — test WITH bootstrap
Opening an EntityColumn triggers a marketplace check/sync; with NO warm token it
HANGS and the column's search input never appears (symptom: "No visible element
found: .*Search years.*" right after selecting the sport). So:
- Run these flows WITH Phase-0 bootstrap (`worker-bootstrap` seeds creds + warms
  worker 0). Do NOT use `MAESTRO_SKIP_BOOTSTRAP` for drilling flows — that's only
  safe for non-drilling flows (auth / dashboard / home / profile).
- Symptom of the wrong harness: the drill dies at the first child column.

## 2. centerElement for the footer-click-steal (fixed in util-drill)
On /set-selector the AdminTools panel pushes the Sports column down to ~y=460,
so its rows land at y≈556 — inside the 1024×629 headless footer-steal zone (the
tap is found in the DOM but the footer absorbs the click; the column never
drills). util-drill now centers the Sports search input AND result row. Any new
column interaction must `scrollUntilVisible … centerElement: true` before tapping.

## 3. Fresh CROSS-page mount before util-drill (the /profile detour)
util-drill starts with `openLink /set-selector`. If the flow is ALREADY on
/set-selector, that's a same-URL nav that does NOT remount — the column renders
but is non-interactive (selection never drills). The flow must be on ANOTHER page
first. Working pattern: land on /set-selector, then detour via /profile (the warm
step does this for free), then util-drill openLinks /set-selector fresh.
- A `/dashboard` detour did NOT work (its openLink /set-selector re-bootstraps to
  a stuck "Loading…"). Use /profile.
- Also wait for auth after launchApp before any openLink, or the openLink fires
  mid-sign-in and /set-selector loads unauthenticated.

## 4. Selection by relationship, not index (see search-input memory)
After typing in a search box, tap the result via `below: {id: "Search <entity>"}`,
never `index:` — order flips between cold-sync and re-drill.

## Conversion template (drilling flow)
```yaml
url: ${APP_URL}/testing/sign-in?redirect=/set-selector&worker=${WORKER_INDEX || "0"}
tags: [set-selector, regression]          # drop cascade / requires: / provides:
---
- launchApp
- assertVisible: "Set Selector"           # wait for auth/page load
- runFlow: { file: ../util/util-login-to-bsc.yaml }       # warm + /profile detour
- runFlow: { file: ../util/util-login-to-sportlots.yaml }
- runFlow: { file: util-drill-to-2024-topps-chrome.yaml } # + env SET/YEAR/etc overrides
- # …scenario-specific asserts, default 7s waits (see feedback_ui_response_7s)
```
For a flow that reads only CACHED data and needs no live marketplace call, the
two util-login warms can be a bare `openLink /profile` + `assertVisible "Profile
Settings"` detour — BUT it still needs warm tokens from Phase-0 bootstrap (rule 1).
