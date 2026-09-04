---
name: patterns-card-drawer-autosave
description: NEO-216/217 — CardDetailPanel is per-field autosave on the live row; the null-clear wire pattern for numbers, the userFacingMessage error contract, and why feature-key removal grants no new privilege
metadata:
  type: project
---

## The drawer no longer sends a full payload (NEO-216)

`components/SetSelector/CardDetailPanel.tsx` has **no Save button, no draft
state, no `handleSave`**. Every editable control commits ONLY its own field
through one helper, `commitField(patch, doneMessage)` (~`:407`), which calls
`updateCard({ id, ...patch })`. Text rows are `useReactiveField`
(`components/forms/useReactiveField.ts`) committing on blur / Enter
(`enterCommit: "modEnter"` for the textarea); the attribute chips send
`{ attributes, isRookie: next.includes("RC"), isRelic: next.includes("RELIC") }`
behind a busy guard; the team/player pickers send only their own array.

**Why this matters for audits:** the old hazard — "an unrelated drawer save
silently retires a review flag because the client sends every field every
time" — is gone *by construction* for this dialog. `listingTitleTruncated`,
`teamNoneConfirmedAt` and `pendingTeamNames` now only retire on a genuine
edit of their own field, because `useReactiveField.runCommit` no-ops when
`trimmed === baseline`. See [[patterns-attention-flag-suppression]] for the
rule; this is the fix, not an exception to it.

**How to apply:** any NEW control added to this drawer must go through
`commitField` with a single-field patch. A control that assembles a
multi-field payload reintroduces the suppression class.

## Clearing a NUMBER on the Convex wire

`updateCard` (`convex/selectorOptions.ts`) takes
`printRun: v.optional(v.union(v.number(), v.null()))`. The handler's
`filtered` loop keeps anything `!== undefined`, then maps `null` →
`undefined` **inside `filtered`** so the key survives to the
`ctx.db.patch(id, { ...filtered })` spread — `undefined` in a Convex patch is
how a field is deleted, and a stored `null` would fail the schema's
`v.optional(v.number())` on the next read. Non-null must satisfy
`Number.isInteger(x) && x >= 1`, else `ConvexError`.

Copy this shape for any future "clear a number" arg. Additive by design: an
old SPA never sends `null`.

## Error text rendered in the drawer

`lib/errors/user-facing-message.ts` `userFacingMessage(err, fallback)` returns
a `ConvexError`'s `.data` only when it is a string, else the fallback —
`.message` is NEVER shown (prod redacts plain Errors to "Server Error", and
the client wrapper prefixes `[CONVEX M(...)] [Request ID: ...]`).

`commitField` re-throws `new Error(userFacingMessage(err, "Could not save
that change"))`, and `useReactiveField` renders `error.message` verbatim. So
every string the drawer shows is either a fixed client constant or a
ConvexError `.data` we authored. **Audit rule:** a new drawer path that calls
a mutation directly and renders `e.message` breaks that contract.
`SetAttributesPanel.handleSaveFeature`'s catch is the one place still doing
`Failed: ${e.message}` (pre-existing).

## Feature-key removal is not a privilege

`validateFeatureValue` (`convex/features/deriveCardFeatures.ts`) validates
**values only**, for exactly two keys (`era` enum, `totalCardCount` digits).
It never restricted which keys may be written. So `applyFeatureEdit`'s
`value === ""` → `delete cleared[key]` (skipping validation) grants an admin
nothing they did not already have — `updateCard`'s full-replacement
`features` arg could already drop any key. Absence is an explicitly valid
state for every key (`convex/features/expectedFeatures.ts` header: "blank is
a perfectly acceptable, complete answer"), and no reader treats presence as
an invariant; SKUs are not built from `features`.

The one propagation engine that could re-fill a cleared card key,
`materializeSelectorOptionFeature` (overwrites when
`cardValue === undefined || cardValue === oldValue`), is reachable only from
`convex/backfillCardFeatures.ts` (internal, set-level keys only).
`setSelectorOptionFeature` is a single-row patch and does not propagate.
