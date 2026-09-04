---
name: bare-maestro-needs-chrome-for-testing
description: Running `maestro test` directly (for a scratchpad probe flow) gives a 1x1 viewport unless SE_BROWSER_PATH is exported — run-e2e-smoke.sh normally does that for you
metadata:
  type: project
---

# A scratchpad probe flow must export SE_BROWSER_PATH itself

`npm run test:e2e:pick` only runs flows inside `.maestro/flows/`. To run a
throwaway probe from the scratchpad you have to invoke `maestro test` directly —
and then you lose everything `run-e2e-smoke.sh` sets up. The one that bites:

```bash
export SE_BROWSER_PATH="$HOME/.cache/puppeteer/chrome/mac_arm-<ver>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
PATH=$HOME/.maestro/bin:$PATH maestro test --platform web --config .maestro/config.yaml \
  -e APP_URL=http://localhost:<port> -e WORKER_INDEX=0 --headless \
  --debug-output <dir> --flatten-debug-output <flow>.yaml
```

**Without it** you get branded Google Chrome, whose `chrome://omnibox-popup` CDP
target Maestro drives instead of the real tab (NEO-138). Every hierarchy dump
comes back with `bounds "[0,0][1,3090]"` — a 1-pixel-wide viewport — so nothing
is ever "visible" and the failure reads like a selector bug. `lib-e2e-chrome.sh`
is the canonical resolver but sourcing it from another worktree can fail on a
missing `.maestro/chrome-version`; the literal path is fine for a probe.

Two more things a direct invocation needs:
* `runFlow: file:` resolves relative to the CALLING flow's directory — copy any
  util the probe uses into the scratchpad next to it.
* `gtimeout --kill-after=20 <sec>` around it, or a hung driver blocks forever.

**Chrome tab crashes** (`CommandFailed: Error communicating with the remote
browser`, or `NullPointerException … CdpWebDriver.deviceInfo`) mean the tab
died, not that your flow is wrong. `npm run e2e:clean-chrome` between attempts
and a 2-3 attempt retry loop is the reliable way through; they get much more
frequent with several Vite dev servers up (memory pressure).

Still take the run lock — see [[speaking-conch-run-serialization]].
