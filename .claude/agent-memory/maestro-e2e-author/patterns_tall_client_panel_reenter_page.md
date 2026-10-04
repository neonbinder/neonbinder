---
name: tall-client-panel-reenter-page
description: When a client-side run panel (a ledger that grows with its lines) sits between the columns row and the checklist, re-enter the set builder (drill util) to drop it instead of paying swipe travel past it; plus what a measured count may and may not pin mid-queue
metadata:
  type: feedback
---

A panel whose state lives only in the browser (the NEO-312/321 parallel-build
ledger, `useHostedParallelBuildRun`) can make the page ~1,000px taller between
two anchors a flow needs (columns row → `Attributes for …` → checklist). Travel
past it does not fit R5: `scrollUntilVisible` moves `innerHeight/2` = 312px
per ~2.0 s cycle after a ~1.25 s first lookup, so 7000 covers about three
swipes (~940px beyond the viewport). Splitting the travel into two steps only
hides it.

**How to apply:** once the run has ENDED (no `beforeunload` armed), re-run the
drill util (`openLink` reload) — the client run dies with the page and the
section redraws short. Costs ~32 s on the warm Topps Chrome drill, and it also
removes any scroll whose distance the panel's focus park made variable. Read
the value you need off the panel (`copyTextFrom` → `output.*`) BEFORE the
reload; `output` survives `runFlow`.

**Counts:** the seed may pin a build's card count (it runs alone). A queue flow
building from a shared source may NOT: a concurrent sole writer on that source
(e.g. `signed-by-autofills-from-players` on Topps Chrome Base #300) turns a
correct build into "N-1 … 1 skipped — Base changed them mid-build". Read
SET-REGISTRY's "Concurrent … writers" note before pinning. A plan size (the
number of parallels) is safe to pin; hedge it per `output.SL_PAUSED` when the
paused-mode count was never measured.

**Why:** NEO-321 follow-up, 2026-10-04 — the ledger lost its 192px inner
scroller (Jason: the page should scroll, not a box) and the base-parallels flow's
DOWN scroll to `Attributes for …` grew from 2 swipes to ~5.

Related: [[maestro-web-driver-primitives]], [[measure-a-fixture-from-ci-artifacts]].
