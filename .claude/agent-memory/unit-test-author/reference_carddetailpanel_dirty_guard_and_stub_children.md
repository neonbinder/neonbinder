---
name: reference-carddetailpanel-dirty-guard-and-stub-children
description: CardDetailPanel's footer Cancel button bypasses the dirty-guard (only the header × / prev-next arrows route through requestExit); mock sibling picker components as stubs when their own behavior has separate test coverage.
metadata:
  type: reference
---

## CardDetailPanel: "Cancel" ≠ dirty-guarded close

In `components/SetSelector/CardDetailPanel.tsx`, the footer **Cancel**
button's `onClick={onClose}` calls the parent's `onClose` prop directly —
it does NOT go through `requestExit("close")`, so it bypasses the
dirty-guard/discard-confirm entirely, unconditionally, even with unsaved
changes. Only the header **×** button (`aria-label="Close card detail"`)
and the ↑/↓ prev/next buttons route through `requestExit`, which checks
`dirty` and shows the "Discard unsaved changes?" bar.

**Consequence for tests**: any test asserting dirty-tracking behavior (e.g.
"changing X does/doesn't mark the panel dirty") must trigger exit via the
**header "×" button** (`screen.getByLabelText("Close card detail")`), not
the footer "Cancel" button (`aria-label="Cancel card edit"`) — Cancel will
always close immediately regardless of dirty state, silently making a
dirty-guard test pass/fail for the wrong reason. Learned the hard way while
writing `CardDetailPanel.test.tsx` (NEO-71-74): two tests asserting
`"Discard unsaved changes?"` appeared after adding/removing a player failed
because they used the Cancel button.

This divergence (two different "leave" affordances, only one dirty-guarded)
is plausibly intentional — Escape also explicitly bypasses the guard per an
inline comment ("Escape is an explicit dismiss — discard and close
immediately") — but it was flagged to the user as a discrepancy worth a
second look rather than silently fixed, per the instruction not to modify
non-test app code without approval.

## Mocking sibling picker components as stubs

When testing a parent component (`CardDetailPanel`) that embeds a
typeahead/chip picker (`TeamPicker`, `PlayerPicker`) which ALREADY has (or
is being written in the same batch of work to have) its own dedicated test
file, don't identity-route `useQuery`/`useMutation` for all of that child's
convex calls too — that's 4+ extra query/mutation refs
(`teams.getManyByIds`/`teams.list`/`teams.findOrCreate` +
`players.getManyByIds`/`players.list`/`players.findOrCreate`) just to
satisfy a component whose own internals aren't the parent test's concern.

Instead `vi.mock("./TeamPicker", ...)` / `vi.mock("./PlayerPicker", ...)`
to a trivial stub rendering `value.join(",")` plus one "add" and one
"remove" button that call `onChange` with a mutated array. This lets the
parent test assert exactly what it owns — dirty-tracking wiring and the
Save payload shape — without re-exercising the child's popover/typeahead
logic (already covered in `PlayerPicker.test.tsx`/`TeamPicker.test.tsx`).
`CardFeaturesEditor` did NOT need this treatment in the same file — it
doesn't call `useQuery` at all, and its `useMutation(setCardFeature/
updateCard)` calls resolve via the SAME identity-routed mock the parent's
own `CardFeatureRow` usage already needs, so leaving it real added no
extra mocking surface.

See also [[reference-reactive-field-editing-in-tests]] for the
identity-routing pattern this builds on.
