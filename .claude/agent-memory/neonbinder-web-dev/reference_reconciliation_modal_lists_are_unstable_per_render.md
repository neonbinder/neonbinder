---
name: reconciliation-modal-lists-are-unstable-per-render
description: ReconciliationModal's pending lists get a new identity on EVERY render (default `[]` props feed its memos), so an effect keyed on them that sets state loops forever; key such effects on content
metadata:
  type: reference
---

`ReconciliationModal` destructures `usedSlPlatformValues = []`,
`usedBscPlatformValues = []`, `extraSlPrefixes = []`. A default `[]` is a fresh
array per render, so `usedSlSet` / `defaultSlPrefixes` and every memo built on
them (`scopedPendingSl`, `filteredPending*`, anything mapped from those) change
identity on every render, even when nothing changed.

Harmless for render-only derivations. Fatal for an effect keyed on one of those
lists that calls setState: render → new list → effect → setState → render, a
synchronous loop. Found in NEO-325 (the Base-match probe hook published on
every scope change); vitest showed it as a run that never finishes and never
prints a test line (no error, exit 144 when killed).

**How to apply:** an effect or hook fed from the modal's lists keys on CONTENT
(`ids.join("\u0000")` as the dep, read the list itself inside the effect), not
on identity. When a test of the modal hangs silently, check this first. See
[[convex-call-spread-hides-bad-args]] for the sibling "looks fine, isn't" trap.
