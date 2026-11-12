---
name: publisher-checklist-claim-is-per-card-omit-the-card-under-test
description: To cut live BSC lookups with a publisher checklist while one card still proves a pre-fill, omit that card's row; a blank team cell keeps the lookup, and a named team is a claim no skip releases
metadata:
  type: feedback
---

A publisher checklist row that names a team sets `teamLookup: "checklist"` on
its card, and `teams-on-cards.ts` treats that as an invariant-8 claim: nothing
pre-fills over it, and skipping the New Team step does not release it (a live
BSC listed name IS released by the skip). The claim is per card: it joins the
card's own line key, and only the shared no-players line pools it.

A row with a BLANK team makes no claim but also keeps that card's BSC lookup,
so blanking teams saves nothing. The way to keep one card's inference live is
to leave its row OUT of the file (unmatched = live lookup) and make the spec
target that card's player by name instead of "whichever the wizard shows
first". NNO sets cannot use the capture tool's `--omit-number`.

Also: the checklist's "Teams from your checklist: N of M cards" tail rides on
every run line through the save, so a spec anchoring `^Saved N cards\.$`
breaks once that sync uses a checklist.

**Why:** NEO-489 planning; the NEO-478 attempt uploaded the full file and the
claim on the tested card killed the career pre-fill.
**How to apply:** any plan moving a live-lookup spec onto an uploaded
checklist: list which cards must stay live, omit exactly those rows, re-check
exact result-line anchors. See [[e2e-fixtures-come-from-the-ui-not-seeds]].
