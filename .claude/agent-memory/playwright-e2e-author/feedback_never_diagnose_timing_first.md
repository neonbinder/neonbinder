---
name: feedback-never-diagnose-timing-first
description: HARD RULE — never diagnose a red spec as timing or flake, and never raise a timeout to make it pass; get the failure screenshot and error-context.md first, because "looks like timing" almost always means something underlying is broken
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
convincing. NEO-260's seed failure presented as "element not found" on a step
that used to complete in 0.54s, whose timeout had just been lowered. Three
independent signals all pointing at timing. It was not timing: the element was
rendered for the whole wait, off-screen above the viewport where the harness
could not reach it, and the failure SCREENSHOT showed that in seconds. A batch
of steps parked at a middle-ground 10000 were the same instinct in slow
motion: a number chosen because it passed.

**How to apply, in this order, before forming any theory:**
1. **Open the artifact.** The failure screenshot and `error-context.md` (an
   ARIA snapshot of the page at failure) show what was actually on screen and
   what the accessibility tree offered. Compare with a green run's artifacts if
   you need a baseline.
2. **Ask what CHANGED, not what is slow.** Diff the product code since the last
   green run before touching a spec. A layout or label change three commits
   back is a likelier cause than the step in front of you.
3. **Never raise a timeout to make a spec pass.** The bar is 7 s (GUIDE hard
   rule 3) and a longer value needs Jason's sign-off recorded at the site. A
   slow step is a product finding to report; if a spec seems to need more
   budget, ask the coordinator.
4. **"Flaky" is a claim that needs evidence.** Re-running until green is not a
   diagnosis. If you cannot name the mechanism, say so in the report rather than
   picking a number that makes it go away.
