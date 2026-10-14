---
name: bound-a-backend-stall-with-the-create-gate
description: How to prove a cluster of unrelated write-shaped reds (Creating…, disabled Create, Confirm? still showing, finalize "too many system operations") is ONE backend contention window — time the ubiquitous create step across every downloaded run's step timings
metadata:
  type: reference
---

When several specs on different shards go red within a few minutes and every
failing step is a WRITE waiting to return, do not diagnose them one by one. Bound
the window first.

**The ruler:** the hand-made "create" step (add a custom entry and wait for the
form to close) runs dozens of times per CI run (every hand-made ancestor of every
set-selector spec) and measures one thing: how long `addCustomSelectorOption` took
to return. Healthy was about 1 s on the previous suite (79/80 samples in one
run); re-measure on Playwright step timings. Pull the step durations from each
shard's report, sort by wall-clock, and the window falls out: a handful of 10 s
outliers between runs of 1 s samples.

**Then read each red against the window** with its own in-flight proof, from
the failure screenshot and `error-context.md`:
- the confirm `Create` button disabled while `creating`;
- `PlayerPicker` row `Create player <x>` reading `Creating…`; `NewTeamDialog`
  button `Creating team <full>` / `Creating…` (a portalled dialog);
- `CardChecklistItem`: `Confirm?` still rendered after the confirm click
  (`handleDelete` only flips it back after `await deleteCard`);
- `commitCardChecklist: finalize failed — Your request timed out performing too
  many system operations.` in the wizard's error card: Convex's per-mutation
  system-operation time budget tripped by the finalize phase under load;
- `RenameEntityControl`: the input is `aria-disabled` while saving; an enabled one
  means saving is FALSE (the keypress never reached `commit()`), a different class.

**What starts it:** look for the heaviest write that began right before the first
slow sample (a large inserts commit: hundreds of names created, hundreds of cards
written in chunks, creation-time enrichments scheduled). Every other red was a
bystander.

**Verdict shape:** the specs are correct; a rerun (or the next push) is the honest
answer, and the product findings are the finalize budget and the banner that says
"Nothing was saved" while chunk-written rows sit behind it. Never harden a
bystander spec against a window.
