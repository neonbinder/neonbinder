---
name: neo325-base-match-client-tests
description: NEO-325 Base match CLIENT tests (lib rules, useBaseMatchProbe hook, Reconcile dialog, VariantForm gate) - hand-resolved fake client, getFunctionName, break-check traps (index-vs-id mapping coincidence, infinite-loop breaks, equivalent catch guard)
metadata:
  type: reference
---

Files: `lib/cards/base-match.test.ts`, `components/SetSelector/base-match-probe.test.tsx`, `ReconciliationModal.baseMatch.test.tsx`, plus a describe at the end of `VariantForm.test.tsx`.

- Real `api` is `anyApi`: identify a fake client call with `getFunctionName(ref)` ("baseMatchProbe:probeBscSets"), never mock `_generated/api` in hook/dialog tests. VariantForm.test.tsx DOES mock api with strings, so its refs are plain strings.
- Probe fake client: record each action as a pending promise with resolve/reject exposed; `outstanding()` = unsettled calls gives the in-flight count. The dialog variant adds an `auto` mode that answers from a per-id verdict table, and `hold` for "still checking" states. Use perSide {0,0} in dialog tests so first card alone decides (counts are the hook test's job).
- Wrap the dialog in `<ConvexProvider client={fake as never}>`; spy `useConvex` by `vi.mock("convex/react", importOriginal)` wrapping the real one (hoisted spy via vi.hoisted).
- By-id result mapping break: results must come back OUT of request order, with only a non-adjacent id ok, or index-mapping coincides with id-mapping and survives.
- Breaking the scope/view content key to identity makes the hook loop: vitest worker dies (OOM, "Worker exited unexpectedly"), ~90s. Count that as red; wrap break runs in `perl -e 'alarm 60; exec @ARGV'` (no GNU timeout on this Mac) and SIGINT (not SIGTERM) a stuck driver so its finally restores the file.
- Equivalent mutant: dropping the generation check in the dispatch `.catch` is unobservable (old Entry objects are orphaned by cleanup and the `.then` check still guards the slot/pump); the `.then` check IS pinned by "an answer from before the close does not free a slot in the reopened sitting".
- happy-dom: removing a focused element drops activeElement to body, so the dialog's focus-to-toggle effect is testable by focusing a row's "Make its own set" button then settling a mismatch verdict.
- VariantForm: its twin-shape fetch result opens the dialog with no pair needed; the gate is observable as `useConvex` called / signature query called with {variantTypeId}.
