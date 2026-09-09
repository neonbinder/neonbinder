---
name: wizard-decided-list-and-batch-resume
description: "Two entity-review wizard traps proved by CI run 34072730449: the `Decided (N)` list falls out of Maestro's hierarchy on a tall step (assert the header count instead), and a review batch outlives its flow so a red flow cascades onto every sibling sharing the set."
metadata:
  type: reference
---

# `Decided (N)` is not a reliable Maestro target

The decided-names list is the LAST thing in the wizard's dialog body. On a tall
step it is **absent from the reported hierarchy entirely** — not off-screen-but-
present, absent.

Measured (CI run 34072730449, 1996 Score STEP 6a): the header read
`1 of 209 reviewed` and the Cancel prompt had just said `Discard 1 decision?`,
so the decision had certainly landed. The presented step was
`New Team: Southern Illinois Salukis baseball` — a college side with **five
possible matches** (a ~156px block) above an **expanded league grid** with no
league prefill to collapse it. Whole tree: 169 nodes, no `Decided` node.

On a SHORT step the same list is reported even when its bounds run far past the
viewport (a player row showed `Decided (28)` with the list extending to y=1183).
So this is not a simple fold rule — it depends on how tall the body above it is.

**Assert the header instead: `"<n> of [0-9]+ reviewed.*"`.** It is the wizard's
own progress numerator, sits at the top of the dialog, is always rendered, and
carries the exact count — so it is not a weaker claim than `Decided (n)`.

## The teams-first walk breaks every hard-coded decision COUNT

`util-wizard-walk-to-player-row` answers each team step to reach a player, and
each answer is a decision the wizard counts. Same run: confirm read
`Discard 28 decisions?`, header `28 of 116 reviewed` — 27 drained skips plus the
flow's one create. Any literal `Discard 1 decision` / `Decided (1)` in a flow
that walks to a player row is now wrong.

Prove the flow's OWN decision by NAME, not by count: the skip-variant util
leaves every drained row reading `Skipped`, so `Added as new` is unique; the
create-variant leaves them `Added as new`, so `Skipped` is unique.

# A review batch outlives its flow — one red flow cascades

`commitCardChecklist`'s batch is per (selectorOption, user) and persists. A flow
that ends any way except Cancel → Discard (failed assert, timeout, killed run)
leaves its decisions on the set, and the next fetch **resumes** that batch — the
wizard opens at `N of M reviewed`, not `0 of M`.

All four read-only wizard flows share Baseball / 2024 / Topps / Topps Big League
/ Base, so ONE red flow fails its three siblings on their `0 of N reviewed`
precondition and the report shows four broken flows for one broken feature.
Reproduced locally: two killed runs left the set reading
`887 checklist reviews are in progress here — finish or cancel them first`.

Fix in the suite: `util-discard-resumed-review-batch.yaml` — a
`when: notVisible: "0 of [0-9]+ reviewed.*"` guard that cancels, discards and
refetches, run right before each caller's own HARD `0 of N reviewed` assert
(so a resume it fails to clear still fails the flow). Costs a full 7s poll on
the clean path; that is the price and it is worth it.

**Recovering a wedged fixture by hand:** a throwaway flow of
`util-fetch-real-set-checklist-to-wizard` → `Cancel (Esc)` → `Discard` clears it
in ~2 min. Do this before you leave a shared preview.
