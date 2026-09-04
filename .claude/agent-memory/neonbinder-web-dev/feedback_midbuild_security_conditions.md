---
name: midbuild-security-conditions
description: On this project a security-auditor pass lands mid-build as numbered conditions that OVERRIDE the launching prompt; fold them in immediately and report per-condition with the asserting test name
metadata:
  type: feedback
---

When the coordinator launches parallel build agents on a ticket, it also runs
`security-auditor` on the plan. Its verdict arrives as a mid-task message —
"APPROVED WITH CONDITIONS" plus numbered conditions and lettered contract
changes — and those **override the original launching prompt wherever they
conflict**. The same conditions are sent to the other agents, so the contract
between backend and frontend moves with them.

**Why:** the audit runs concurrently with the build rather than before it, so
its findings cannot be folded into the brief up front. The coordinator relays
them instead, and both build agents must land on the same revised contract or
the FE codes against a shape the BE never shipped.

**How to apply:** when such a message arrives, stop and re-derive the design
against it before writing more code — a condition can invert a decision already
implemented (NEO-211: "infer `coveredSides` from the items" became "absent
means unlink nothing"). Then, in the final report, list every condition number
with the `file:test name` that asserts it; the coordinator checks them off one
by one. Conditions can also contradict each other at the margins (NEO-211
conditions 3 and 8 disagreed about a second claimant) — pick the
non-destructive reading, implement it, and say so explicitly rather than
silently choosing.
