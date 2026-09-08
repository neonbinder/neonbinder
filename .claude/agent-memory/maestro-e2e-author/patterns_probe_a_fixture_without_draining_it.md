---
name: probe-a-fixture-without-draining-it
description: Drive the app over raw CDP with the PINNED Chrome to measure a fixture; a checklist fetch cancelled at the wizard leaves the set pristine, so the probe costs no commit
metadata:
  type: reference
---

**Use the PINNED Chrome** (`apps/web/.maestro/chrome-version`, e.g.
`mac_arm-151.0.7922.77`) for a CDP probe. The newer 152 build in the puppeteer
cache renders the app with a **hung renderer**: `/json/list` shows the page, but
`Runtime.evaluate`, `Page.navigate` and `Page.captureScreenshot` never return.
Cost: ~15 minutes of "is my script wrong" before checking the version.

Launch, then drive by evaluating JS in the page (sign in through
`/testing/sign-in?redirect=…&worker=0` exactly as a flow does):

```
--headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/... \
--no-first-run --window-size=1024,700
```

`Emulation.setDeviceMetricsOverride {width:1024,height:629}` gives CI's real
viewport (a plain `--window-size` loses ~140px to browser chrome).

**A checklist fetch can be probed WITHOUT draining the fixture.** The solo
(one-marketplace) and the paired paths both stop at the entity-review wizard;
nothing is written until `Confirm & Save`. `Cancel (Esc)` there leaves
`Fetch cancelled — no cards saved.` + `No cards in this checklist yet.` — the
set is pristine and a committing flow can still be run against it. So: probe
card counts, unknown-name counts and timings by fetching and cancelling, and
save the one committing attempt per set per deployment for the real Maestro run.

**Two things this probe harness CANNOT see**, both harness artifacts rather than
product bugs — confirm them in a Maestro run instead:
* the checklist's **Virtuoso list renders no rows** (verified against 2024 Topps
  Chrome's 335 cards too), so card-row badges are invisible to it;
* smooth scrolling never advances, because the drilled page ticks ~0 rAF here.

To time a UI window precisely, install an in-page 250ms recorder that pushes a
snapshot whenever the interesting lines change, then read the array back — that
is how NEO-255's inline progress line was measured at ~0.25s.
