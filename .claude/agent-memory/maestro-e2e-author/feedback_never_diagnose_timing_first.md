---
name: feedback-never-diagnose-timing-first
description: HARD RULE — never diagnose a red step as timing or flake, and never raise a timeout to make it pass; get the failure screenshot and hierarchy dump first. Only scroll TRAVEL may get >7s, by asking Jason with measured swipes + pixels (2026-10-10), never auto-granted
metadata:
  type: feedback
---
Jason, 2026-09-09 (NEO-260), verbatim: *"we should never assum[e] timing first.
Timeout is the thing that the agents keep changing and wasting time on and
sometimes it bandaids things but if something looks like timing or a flake there
is almost always something underlying that is wrong."*

He is describing **this agent role specifically**. Raising a timeout is the
cheapest-looking edit available and the most expensive mistake: it converts a
real defect into a passing test, so the fault survives and stops producing
evidence.

**Why the instinct is so hard to resist:** the signatures are genuinely
convincing. NEO-260's seed failure presented as `No visible element found`, on a
step that used to complete in 0.54s, whose timeout had just been lowered. Three
independent signals all pointing at timing. It was not timing. The element was
rendered for the entire 60-second wait, 204px above the viewport top, where a
`direction: DOWN` scroll can never reach it — and the failure SCREENSHOT showed
that in seconds. It was misdiagnosed as timing twice, and "fixed" once by
restoring a 60000 ceiling, before anyone opened the artifact.

Two more from the same ticket: `centerElement` "failing to settle" was actually
Maestro checking the timeout at the BOTTOM of a six-iteration centring loop
(arithmetic, not flake); and a batch of steps parked at a middle-ground 10000
were the same instinct in slow motion — a number chosen because it passed.

**How to apply — in this order, before forming any theory:**
1. **Open the artifact.** `debug/<flow>/screenshots/step-N-*.png` and
   `screen-hierarchy/step-N-*.json` are written on every FAILED step. The
   hierarchy lists what was actually on screen with bounds; the screenshot shows
   where the page was scrolled to. Maestro writes them only on failure, so a
   green run has nothing to diff against — use the green run's `maestro.log`
   `Element bounds` lines for that instead.
2. **Ask what CHANGED, not what is slow.** Diff the product code since the last
   green run before touching a flow. A layout or padding change three commits
   back is a likelier cause than the step in front of you.
3. **Never raise a timeout to make a step pass.** The bar is R5's 7s and a
   longer value needs Jason's sign-off recorded at the site. A slow step is a
   product finding to file.
3a. **Scroll TRAVEL is the one thing you may ASK about — never grant it.**
   Jason, 2026-10-10 (NEO-330): *"we can give 10s here for budget, but going
   forward I want to continue to make every decision intentionally around
   extra time … extra budget can be asked for but not automatically
   granted."* A `scrollUntilVisible` pays ~1.2s first look + ~2s per 312px
   swipe + ~1.4s finding pass in driver overhead
   ([[scroll-pass-cost-is-driver-overhead]]), so ~900px is the most 7s can
   travel. Order: shorten the distance in the product first; else put a
   request in your REPORT with the `Swiping` count (before the first
   `Scrolling try count: 0`) and the pixels; apply nothing above 7000 until
   the coordinator relays Jason's yes; then record date + approval +
   arithmetic at the site. A same-shaped step elsewhere is a new request,
   not a precedent. Waits, asserts, taps, server writes and centring
   give-up stay at 7000 with no ask path. README R5 "Why scroll travel is
   slow" is the written rule; the `Cards for <name>` scrolls on
   /admin/players (10000) are the first approvals.
4. **"Flaky" is a claim that needs evidence.** Re-running until green is not a
   diagnosis. If you cannot name the mechanism, say so in the report rather than
   picking a number that makes it go away.
