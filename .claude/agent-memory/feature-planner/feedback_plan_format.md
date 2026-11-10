---
name: plan-format-coordinator-brief
description: How the coordinator wants feature plans shaped (word cap, verified paths, slices behind a seam)
metadata:
  type: feedback
---

Plans come back under ~800 words, naming only file paths and function names that were read, with a smallest-shippable first slice and the rest behind an explicit data seam.

**Why:** the coordinator reviews the plan with Jason before building; a long plan or an unverified path costs a follow-up round (NEO-464 dashboard real-data plan, 2026-11-09).

**How to apply:** when asked to plan wiring a prototype to real data, map each section to the real query or the gap, pick the slice that renders real rows end to end, and state the read cost of every subscribed query.
