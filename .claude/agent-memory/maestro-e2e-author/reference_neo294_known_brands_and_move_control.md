---
name: neo294-known-brands-and-move-control
description: NEO-294 — the set attributes panel's HEADER is always visible (rename, delete, move all live there, no `Edit attributes` needed); the `Move to another brand` handles; Unknown sorts FIRST in the move list; and the known-brand counts have NO UI surface, so a flow asserts the breadcrumb/back-fill card instead
metadata:
  type: reference
---

# The set attributes panel header does NOT need opening

`SetAttributesPanel`'s breadcrumb header — the `h3` `Attributes for <row>
(<Level>)`, `RenameEntityControl`, `DeleteSelectorRowControl`
(`Delete <value>`, and `holdings.protected` is **always false** since NEO-239,
so the button always renders — it only goes `aria-disabled` with a reason when
something hangs below the row), `MoveSetToBrandControl` (set rows only) and the
`Edit attributes` / `Hide attributes` toggle — is rendered OUTSIDE the
`{expanded && …}` branch. A flow that only needs one of those controls scrolls
straight to it: no `Edit attributes` tap, no `Hide attributes` assert. Only the
feature GRID (`Value for Brand`, the feature rows, the team row) needs the
disclosure.

The whole header line sits where `Edit attributes` sits, so it inherits that
target's R8 story verbatim: DOWN, `centerElement`, `visibilityPercentage: 10`,
`waitToSettleTimeoutMs: 1000`, `timeout: 7000`, and it **depends on the NEO-260
208px spacer** in `src/layouts/binder-layout.tsx` for headroom.

# The breadcrumb is a LIVE re-parent proof

`breadcrumb` = `useQuery(getAncestorChain, {id})` joined with ` › `, and it
includes the row itself: `Hockey › 1996 › Unknown › Leaf Limited`. It is a
reactive query on the row's id, so after a re-parent (move, prefix re-home) the
panel re-reads the NEW chain while staying mounted. That makes
`text: ".*<year> › <newBrand> › .*"` a structural assertion that needs no
knowledge of the set's name — useful when the name is a marketplace label the
flow may not spell.

# `Move to another brand` — the handles

- trigger: visible text **is** the accessible name, `Move to another brand`.
  It is a DISCLOSURE (`aria-expanded`), deliberately: the house `ConfirmDialog`
  always renders a button named exactly `Cancel`, so the list must not add a
  second one.
- list: prompt `Move to which brand?` (escape the `?` — `text:`/`visible:` are
  FULL-match regexes), group `aria-label="Brands in <year>"`, one button per
  option with `aria-label="Move to <brand>"` and the bare brand as its text.
- the set's CURRENT brand is filtered out — `assertNotVisible: id: "Move to
  <currentBrand>"` is a real claim, pair it with the positive on the target.
- **`Unknown` sorts FIRST** (`compareBrandChoices` leads on `isBrandUnknown`),
  which matters because the list is a `max-h-48 overflow-y-auto` inner scroller
  maestro-web cannot drive: on a real year with twenty brands only the top ~8
  rows are reachable, and Unknown is always one of them.
- confirm: title `Move "<set>" to <brand>?`, fixed description "The set keeps
  its cards, its variants and its marketplace links — only the brand above it
  changes. Sync Sets will leave it where you put it.", confirm `Yes, move it`.
  Refusals (including the clash) render INSIDE the dialog, not in the toast.
- success: `Moved to <brand>` in the panel's single `role="status"`, which is
  `fixed top-20` so it is never under the fold, and it echoes the SERVER's
  `movedTo`. It self-clears after 6s.
- while the ConfirmDialog is up the list stays MOUNTED but goes `inert`, so
  Cancel returns to the same open list on the same brands — `Move to which
  brand?` is a valid post-Cancel positive. `inert` is an attribute, not
  `display:none`, so those rows stay in the driver's hierarchy throughout.

# The moved row does NOT vanish — assert the re-pointed card

`SetSelector`'s columns are scoped to the selected PARENT id, so a re-parent
would drop the row out of the open Sets column while the panel and everything
below it carried on describing it. `handleSetMoved` (NEO-294) re-points the
Manufacturers selection at the destination instead, leaving the set selected —
so right after a successful move the collapsed cards read
`Manufacturers: <destination> — change` **and** `Sets: <set> — change`, with no
re-drill. That is the evidence the toast cannot supply, and a regression that
stopped re-pointing is silent everywhere else. The cards sit UP in the columns
row from the panel, so it is a `direction: UP` scroll, uncentred.

Do not write "the set leaves the open column" in a flow comment any more — it
was true only between the first NEO-294 commit and 856f3cb.

# The known-brand counts have NO UI surface

`syncSetsAcrossManufacturers` pushes `N brands added from the known list` /
`N sets filed under a known brand` into its `summary`, which only reaches
`res.message` — and `ensureSelectorOptions` composes the column's done row from
`pausedSides`, `slCreated`, `failedPlatforms`, notifiable `skippedSides` and
`unlinkedTotal`, dropping `res.message` on success. Same trap as
[[sync-summary-is-not-a-ui-surface]]. So a flow proves the FILING structurally
instead — the view's back-fill card `Manufacturers: <brand> — change` plus the
breadcrumb — which is the stronger claim anyway.

# Why the stamp needs a FORCED sync to be observable

`metadata.brandSetByOperator` is invisible. The sync's step 3 re-homes
**existing** `Unknown` holders into the brand the list names for them
(`plan.moves`), and the row index carries `setByOperator` so `routeBscSets`
skips stamped rows — so the only way to see the stamp work is: move a set INTO
`Unknown`, force `Sync Sets` on the year, and read the placement back. Without
the stamp that sync silently undoes the operator. Detect the forced sync's end
with the positive pair `visible: "Syncing Sets"` (7000, the panel replaces the
action row in the slot the tap just centred) then `visible: "Sync Sets"`
(marketplace ceiling) — never a bare `notVisible`, which passes the moment the
panel scrolls out of view.

Also: the year's `Unknown` row **cannot be renamed** (NEO-294, 856f3cb). The
pencil still renders with accessible name `Rename Unknown`, `aria-disabled`,
and the reason `Unknown is where sets with no known brand wait — it can't be
renamed.` is in the DOM as its `aria-describedby` target at all times. Four
doors refuse it (mutation, shared planner, accepted sync suggestion,
reconciliation tier-0), with an internal escape hatch for the backfill.

Related: [[neo237-all-brands-view-and-unknown]],
[[inner-scroller-clip-is-invisible-to-maestro]].
