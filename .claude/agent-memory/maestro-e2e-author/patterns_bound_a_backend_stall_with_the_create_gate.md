---
name: bound-a-backend-stall-with-the-create-gate
description: How to prove a cluster of unrelated write-shaped reds (Creating…, disabled Create at 0.45 opacity, Confirm? still showing, finalize "too many system operations") is ONE backend contention window — time the ubiquitous create-gate step across every downloaded flow log
metadata:
  type: reference
---

When several flows on different runners go red within a few minutes and
every failing step is a WRITE waiting to return, do not diagnose them one
by one. Bound the window first.

**The ruler:** `util-drill-to-custom`'s create gate — the log pair
`onCommandStart: Assert that "Add Custom Entry" is not visible RUNNING` →
`onCommandFinished … COMPLETED|FAILED` — runs dozens of times per CI run
(every hand-made ancestor of every set-selector flow) and measures exactly
one thing: how long `addCustomSelectorOption` took to return. Healthy is
**0.98–1.09 s** (79/80 samples, run 35658444013). Script it across
`runner-*/debug/*/*/logs/maestro.log`, sort by wall-clock, and the window
falls out: on that run 1.65 s at 22:21:29, 11.1 s (FAILED) at 22:23:52,
9.99 s at 22:23:58, back to 0.99 s at 22:24:31.

**Then read each red against the window** with its own in-flight proof:
- `EntityColumn` confirm `Create` fill `rgb(140,236,179)` = neon green at
  the disabled 0.45 over white → `creating === true`
  (add-custom-entry-not-visible-means-a-stalled-write).
- `PlayerPicker` row `Create player <x>` reading `Creating…`; `NewTeamDialog`
  button `Creating team <full>` / `Creating…` (portalled — see
  [[hierarchy-dump-portals-come-last]]).
- `CardChecklistItem`: `Confirm?` still rendered after the confirm tap —
  `handleDelete` only flips it back after `await deleteCard`.
- `commitCardChecklist: finalize failed — Your request timed out performing
  too many system operations.` in the wizard's error card: Convex's
  per-mutation system-operation TIME budget, tripped by the (unchanged)
  finalize phase under load; the code comment above `commitCardChecklist`
  in `convex/selectorOptions.ts` records the same message from NEO-189.
- `RenameEntityControl`: the input carries `aria-disabled:opacity-50`
  while saving — a full-opacity `bg-slate-900` box means saving is FALSE
  (the keypress never reached `commit()`), which is a different class.

**What starts it:** look for the heaviest write that began right before the
first slow sample. On 35658444013 it was the 1996 Score inserts commit
(`Confirm & Save` at 22:21:25 — 213 names created in the prelude, 220
cards in chunks, 213 creation-time enrichments scheduled), four seconds
before the first slow gate. Every other red was a bystander.

**Verdict shape:** the flows are correct; a rerun (or the next push) is the
honest answer, and the product findings are the finalize budget and the
banner that says "Nothing was saved" while 220 chunk-written rows sit
behind it. Never harden a bystander flow against a window.
