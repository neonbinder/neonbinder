---
name: pull-sheet-dealer-checks
description: Dealer checks for any pull/pick/pack/ship surface built on sales: where the sold copy was, merged rows, check-off persistence, no buyer PII, colour collisions
metadata:
  type: feedback
---

Checks to run on any sale-driven pull, pack or ship screen (first raised in the 2026-11-11 Pull Sheet spec review).

- **Where was it?** A pull row is useless without the home (box + slot) of the copy the sale took. Applying a sale lowers a box copy; if the sale line does not record which copy/box/slot/serial it took at that moment, the screen cannot say where to pull from once the copy row is gone. Check the sale item carries it before approving "By the Box".
- **Merge before split.** Pull view sums the same card + condition + home across orders (pull 2 at once); the pack step splits by order.
- **Check-off is server state**, survives refresh and a phone; a sale that arrives mid-pull appends and is marked new, never reorders the list under the puller.
- **No buyer PII**: the sales row stores none by design; show the order number, never a buyer name, even if the old CLI did.
- **Colour collisions**: row tints for variant role must not reuse NB's button meanings (pink = cancel/destructive) and must not be the only signal (red/green sport pairs fail colour-blind readers); always a text label too.
- **Natural sort** card numbers ("BC-12", "12a", "US150") and season years ("2023-24" by start year).

**Why:** pulling the wrong copy (wrong serial, wrong grade) ships the wrong card; a lost check-off means a re-pull of hundreds of cards.
**How to apply:** lead the review with the "where was it" data question; it is the one that changes schema.
