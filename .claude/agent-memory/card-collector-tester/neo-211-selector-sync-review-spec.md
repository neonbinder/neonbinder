---
name: neo-211-selector-sync-review-spec
description: Buildable UX spec for NEO-211's two admin surfaces (selector-sync suggestions modal + upstream-unlink notice) in the set builder, plus the VariantForm/ParallelForm partial-failure alert. Design consult, 2026-09-03.
metadata:
  type: project
---

Design-consult deliverable for NEO-211 (`worktrees/neo-211`, branch
`neo-211-additive-selector-sync`). Plan of record:
`todos/neo-211-plan.md`, sections C and D. No code touched — this is the spec
a frontend agent builds from. Precedent: `[[neo-203-content-diff-review-spec]]`
— read that memory first; this spec follows its Escape rule and reuses
`components/SetSelector/sync-review-modal.tsx`'s chrome (portal + `Theme`,
focus trap, `role="dialog"`/`role="alertdialog"`, live-region footer).

Code read to ground this: `components/SetSelector/sync-review-modal.tsx`,
`EntityColumn.tsx`, `VariantForm.tsx`, `ParallelForm.tsx`,
`RenameEntityControl.tsx`, `SetAttributesPanel.tsx`, `CardAttentionBadge.tsx`,
`ChecklistSourceFilter.tsx`, `convex/schema.ts` (`selectorOptionFields`,
`selectorSyncStatus`), `convex/selectorOptions.ts` (`renameSelectorOption`,
the NEO-203 `baseVersion`/`applyFields` commit pattern),
`convex/setReconciliation.ts` (`fetchRawOptions` error shape), and the Maestro
flows `custom-entry-survives-resync.yaml`, `admin-missing-bsc-shows-warning.yaml`.

## 0. One correction to the plan's own example wording

The plan's D example ("No longer listed on BSC: 2 sets…") and the E2E
acceptance text ("assert 'BSC: Topps'") both abbreviate BuySportsCards as
"BSC" while spelling SportLots in full — that's already this codebase's
convention (`sync-review-modal.tsx`'s `SOURCE_LABEL`, `ChecklistSourceFilter`'s
row titles). Keep it for both new surfaces: **"BSC" / "SportLots"** in every
suggestion badge, unlink notice, and the affordance's own copy. The ONE place
that should say the platforms' full names is the new partial-failure alert
(§3) — that alert is closer in spirit to `MissingCredentialsBanner`'s
"BuySportsCards" / "SportLots" than to a compact diff badge, because it's
telling the operator to go check a real outage, not just labeling a data
source inline.

## 1. Suggestions modal

### 1.1 Column affordance — placement and copy

Lives in `EntityColumn.tsx`'s `idleButtons(onSync)` — the ONE row shared by
all seven levels regardless of `useEnsureSync` (levels 1-5 reach it through
`newPathContent()`; levels 6-7 reach the *same* `idleButtons` call when
`mode === "idle"`). This is the right integration point precisely because it
is already level-generic: no per-level column needs its own copy of the
affordance.

- New `useQuery(api.selectorOptions.getSelectorSyncSuggestions, level ? { level, parentId } : "skip")` added in `EntityColumn`, alongside the existing `items`/`syncStatus` queries.
- Render nothing while the query is `undefined` (no ghost "0 suggestions" flash — same rule `EntitySelector` already applies to its own loading gate) and nothing when the array is empty. The affordance **only exists when there is something to look at**, matching `needsSyncReview`'s "don't show a dialog with nothing to do" precedent.
- When non-empty, render a small pill-button immediately **after** the Sync button and **before** `+ Custom` (so `extraActions`, e.g. "Group Parallels", still sits last):

  ```
  {suggestions && suggestions.length > 0 && (
    <button type="button" onClick={() => setShowSuggestions(true)}
      aria-label={`${suggestions.length} naming suggestion${suggestions.length === 1 ? "" : "s"} from marketplaces — review`}
      className="text-xs px-2.5 py-1 rounded-full border border-amber-700 dark:border-amber-400/70 bg-amber-400/15 text-amber-800 dark:text-amber-300">
      {suggestions.length} suggestion{suggestions.length === 1 ? "" : "s"}
    </button>
  )}
  ```

  Deliberately a **pill, not a `NeonButton`** — a full-size green/blue button
  next to Sync would read as a second primary action and compete for the
  thumb on the mobile card-show workflow this column already has to survive
  (see NEO-63/NEO-85 scroll-safety comments in `EntityColumn.tsx`). Amber
  reuses `CardAttentionBadge`'s already-contrast-checked palette
  (amber-700/amber-300 text on amber-400/15, verified 4.5:1+ in that file's
  own comment) for the same reason it's used there: this is "an unanswered
  question," not a destructive or confirmed state — green (primary action)
  and pink (destructive) are both already spoken-for in this app's palette.
  Visible text is the literal count so Maestro can `assertVisible: "1
  suggestion"` / `tapOn: "1 suggestion"` with no id lookup needed.

### 1.2 Component contract — pure, testable, one component for all 7 levels

Matches the plan's test note ("`SelectorSyncReviewModal` props-in/result-out
like `sync-review-modal.test.tsx`") and `sync-review-modal.tsx`'s own shape:
the modal takes data and hands back a decision; it does not own the query or
the mutation call. `EntityColumn` (or a thin wrapper, if the FE agent prefers
to keep `EntityColumn` from growing another responsibility) owns the
`useQuery`/`useMutation` and passes props down.

```ts
// components/SetSelector/selector-sync-review-modal.tsx
export type SuggestionSide = "bsc" | "sportlots";

export type SelectorSuggestion = {
  existingId: Id<"selectorOptions">;
  currentValue: string;
  baseVersion: number; // == lastUpdated at query time
  suggestions: Array<{ side: SuggestionSide; label: string; foldEqual: boolean }>;
};

export type SelectorSuggestionDecision = {
  existingId: Id<"selectorOptions">;
  side: SuggestionSide;
  choice: "accept" | "decline";
  baseVersion: number; // re-read from the live row at submit, not cached from seed — see 1.6
};

export default function SelectorSyncReviewModal({
  isOpen, suggestions, levelLabel, breadcrumb, saving, restoreFocusRef, onClose, onApply,
}: {
  isOpen: boolean;
  suggestions: SelectorSuggestion[];
  /** "Sports" | "Years" | … | "Sub-Variants" — same noun as the column's addButtonText, singular-derived. See 1.8. */
  levelLabel: string;
  /** Ancestor chain joined like SetAttributesPanel's, e.g. "Hockey › 1972-73 › Topps". Omit at sport level (nothing above it). */
  breadcrumb?: string;
  saving?: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onApply: (decisions: SelectorSuggestionDecision[]) => void;
})
```

`foldEqual` on each suggestion is server-computed exactly the way
`sync-review-modal.tsx`'s `SyncDiffField.foldEqual` already is (same `nameKey`
fold noted in the plan's §C) — it drives the one default exception in §1.4.

I added `foldEqual` to the wire shape the plan sketched
(`{ existingId, currentValue, suggestions: [{ side, label }], baseVersion }`)
because the default-state decision below depends on it and it's already
computed server-side to decide row inclusion (`nameKey(...) !== nameKey(value)`
already requires folding both strings) — cheap to also report which
comparisons were fold-equal vs. genuinely different.

### 1.3 Per-row layout, and the per-side badge for BSC/SL disagreement

One row per `existingId`. A row can carry **one or two** entries in
`suggestions[]` (BSC only, SportLots only, or both — and when both, their
`label`s may differ from each other, not just from NB's `currentValue`).
Because `applySelectorSyncSuggestions`'s `decisions` are `{ existingId,
accept?: { side }, decline?: { side } }` — i.e. **keyed per side**, not per
row — the UI has to let the operator decide each side independently. A row
with two suggestions is NOT a three-way radiogroup (unlike the sync-review
modal's BSC/SL/new conflict picker, which really is mutually exclusive): here
accepting BSC's label and declining SportLots's in the same row is a normal,
expected outcome (e.g. BSC caught up to NB's spelling, SportLots didn't).

```
┌────────────────────────────────────────────────────────┐
│ TCG                                          (currentValue, bold) │
│   BSC: Topps                    [Accept] [Decline]      │
│   SportLots: Topps Chewing Gum  [Accept] [Decline]      │
└────────────────────────────────────────────────────────┘
```

Each side gets its own pair of small toggle buttons (`aria-pressed`, not
checkboxes — this is "which of two mutually exclusive-per-side actions," the
same shape as a 2-option segmented control): clicking Accept presses Accept
and un-presses Decline for THAT side only; clicking the pressed button again
returns to "no decision" (both unpressed) — the resting/default state. Label
text on the badge itself is exactly `"BSC: {label}"` / `"SportLots: {label}"`
— this is the literal string the plan's own E2E acceptance asserts
(`"BSC: Topps"`), so don't wrap it in extra punctuation or a colon-less
format.

```html
<button type="button" aria-pressed={choice === "accept"}
  aria-label={`Rename "${row.currentValue}" to "${s.label}" (from ${sideName})`}>
  Accept
</button>
<button type="button" aria-pressed={choice === "decline"}
  aria-label={`Keep "${row.currentValue}"; stop suggesting ${sideName}'s "${s.label}"`}>
  Decline
</button>
```

Visible text stays the plain, short "Accept" / "Decline" the ticket itself
uses — the aria-label carries the specifics for screen-reader users and for
Maestro's `id:`-based targeting when more than one row is on screen (the
`aria-label`'s exact row/side text keeps two rows' Accept buttons
distinguishable the same way `CardDiffRow`'s per-checkbox `aria-label`
disambiguates nine "Card name" checkboxes today).

### 1.4 Default state — confirming the plan, with one precedent-driven exception

**Confirmed: nothing pre-selected is correct as the *general* default.**
Renaming `value` is a heavier action here than a NEO-203 content-field
checkbox — it's read by `deriveOwnLevelFeatures`, seeds a sport's
`sportConfig`/SKU code at first creation, and is what every downstream form,
listing draft and search filter displays. An operator who closes this modal
without reading it must end up with **zero** renames applied, full stop.

**One exception, mirrored from NEO-203's tier-3 rule (`seedCheckedFields`):**
when a suggestion's `foldEqual` is true — the marketplace's label is the same
word under case/whitespace/accent-folding as NB's current value (e.g. NB has
trailing whitespace, or a marketplace fixed an accent) — pre-select **Accept**
for that side. This is not a new principle for this feature; it's the exact
same "a fold-equal change is a reformatting, not a rewrite, so it's safe to
default-accept" rule already shipped and tested in
`seedCheckedFields`/`CardDiffRow`. Everything else — every case where the
words actually differ (Topps vs. TCG) — starts unselected, per plan.

This same rule is what makes "Accept all" answerable — see §1.5.

### 1.5 Bulk actions — "Decline all" yes, blanket "Accept all" no

**Decline all: yes, exactly as planned**, with one scoping rule: it sets
**every currently-undecided side** to Decline and leaves any side the
operator has *already explicitly set to Accept* untouched. (Mirrors
`toggleAllFormatting`'s own scoping — that button only ever touches the
formatting-only group's keys, never the content-changes section's.) Declining
is inert by design (`declinedUpstreamLabels[side] = label`, "stops nagging,"
nothing else) so bulk-declining the noise an operator doesn't care about is
safe regardless of how many rows it touches. Button reads `Decline all
({undecidedCount})`, toggles to `Clear declines` once every undecided side is
declined (same toggle-label pattern as the orphan section's `Select
all`/`Clear all` in `sync-review-modal.tsx`).

**Blanket "Accept all" — no, don't build it.** A rename is not inert the way
a decline is: it changes `value`, which `renameSelectorOption` already proves
can collide with a sibling, and a batch of unreviewed substantive renames
(the "TCG" → "Topps" case is *substantive*, not cosmetic — it's the ticket's
own worked example) is exactly the "an operator who closes this without
reading applies nothing" property being asked to fail for the one action that
is hardest to notice went wrong (nothing visually screams "your set names
just changed" the way a missing/wrong card does). Offer instead **"Accept all
formatting-only suggestions ({N})"**, scoped to `foldEqual` sides only —
identical shape to `sync-review-modal.tsx`'s existing "Accept all formatting
changes" bulk action, applied to the one bucket (§1.4) that's actually safe to
bulk-accept. Zero-`foldEqual`-suggestions columns simply don't show this
button (same `formattingFieldKeys.length > 0` gate).

### 1.6 Stale `baseVersion` — narrower problem than NEO-203's, because the query is live

NEO-203's `SyncReviewModal` is fed a **one-shot fetched diff**; this modal's
`suggestions` prop comes from a **live reactive query**. That's a meaningful
difference worth calling out for whoever builds this, because it changes what
"stale" even means here:

- If another admin (or a background force-sync) changes the row while this
  modal is open, the reactive query re-renders `suggestions` with the fresh
  `currentValue`/`baseVersion`/labels immediately — there is no held-open,
  now-wrong diff sitting in front of the operator the way a one-shot fetch
  would produce. A row that gets resolved by someone else simply disappears
  from the list live (see §1.7 for the "list shrinks to zero while open"
  case).
- Per-side decision state should be keyed `${existingId}#${side}` (mirrors
  `sync-review-modal.tsx`'s own `fieldKey`) and should **read `baseVersion`
  off the live `suggestions` prop at submit time**, not off a value captured
  when the row was first seeded into local state. That makes the client
  self-healing against everything except the genuine last-instant race
  between clicking Apply and the mutation executing.
- That one genuine race is still real (network latency, concurrent admin) and
  is exactly what the server-side `baseVersion` check in
  `applySelectorSyncSuggestions` exists for — fail-closed, same as
  `commitCardChecklistChunk`'s `staleDecisionIds`. Recommend the mutation
  return `{ applied, skippedStale, skippedClash }` (the last one for a rename
  that collided with a sibling — same failure `renameSelectorOption` already
  throws on, but here it must degrade one decision, not abort the batch).
  Surface any non-empty `skippedStale`/`skippedClash` as a small post-apply
  `role="status"` line rather than blocking the close: **"1 change didn't
  apply — that row changed just now. Reopen if it's still nagging you."**
  Nothing to acknowledge; the operator can just look again since the row is
  still live-queried.

### 1.7 Empty / loading states

- **Column loading** (`suggestions === undefined`): affordance not rendered
  (§1.1). No separate "checking for suggestions…" state anywhere — this is a
  cheap derived query, not a marketplace round-trip, so there's nothing worth
  narrating.
- **Modal opens, list live-shrinks to zero** (every row resolved, e.g. by
  bulk-declining, or another admin beat you to it): don't auto-close — that's
  jarring and would fire mid-keystroke on a slow bulk decline. Show a small
  in-body "All caught up — nothing left to review." with only the Close
  button live in the footer (Apply is disabled with nothing to submit
  anyway).
- **Modal can never open with zero rows** — the affordance that opens it
  doesn't render at zero (§1.1), so there's no "why did this open empty"
  state to design for.

### 1.8 Keyboard flow, footer, and Escape

Reuses `sync-review-modal.tsx`'s dialog chrome verbatim: `role="dialog"`,
`aria-modal="true"`, portal to `document.body`, `Theme` wrapper, the same
Tab-trap `onKeyDown` handler, `restoreFocusRef` prop for the same reason
documented there (this modal is also opened from a button whose own
post-mount focus target might not be `document.activeElement` if anything
async intervenes — though here the open path is a direct click, so the
default capture-on-mount is likely sufficient; keep the prop for parity and
because `EntityColumn`'s trigger button can pass its own ref cheaply).

Footer:

```
[status: "N changes ready to apply" · role="status"]      [Close]  [Apply]
```

- **Close** (secondary): always enabled. Nothing has been written yet, so
  this is a pure dismiss — no confirm dialog needed (unlike the delete-orphan
  confirm in `sync-review-modal.tsx`; there's nothing irreversible pending
  here to protect against).
- **Apply** (primary): **disabled when zero decisions are pending** — this
  modal has no pipeline to "continue" the way `SyncReviewModal`'s "Apply &
  Continue" does, so there's no reason to make Apply a no-op click target.
  Label is plain `Apply` (not `Apply & Continue`).
- **Escape**: closes exactly like Close. This is a **simpler case of the same
  rule** `[[neo-203-content-diff-review-spec]]` established, not an exception
  to it — that modal's Escape had to be a *forward skip* because it sits
  midway through a commit pipeline that must still advance (linkage refreshes
  regardless). This modal sits on its own, opened from an idle column with no
  pipeline behind it, so Escape's job collapses to the trivial case: nothing
  was decided, so there is nothing to lose by leaving. Do not build a
  confirm-before-Escape-with-pending-decisions guard — an unsubmitted Accept
  press is exactly as safe to discard as never having opened the modal, by
  the same "unreviewed = not applied" property that makes the whole feature
  safe.

### 1.9 Level-specific copy the shared component needs to handle

One component, seven callers (`EntityColumn` passes `levelLabel` per its own
`addButtonText`, singularized — see the map below). Things that differ by
level and need to not be hardcoded to "set":

- **Noun in `levelLabel`**: derive from the SAME public label the column
  buttons already use (`Sports/Years/Manufacturers/Sets/Variant
  Types/Inserts/Sub-Variants`), singularized — **not** the internal
  `LEVEL_LABEL` map in `SetAttributesPanel.tsx`, which uses different words
  ("Insert"/"Parallel"/"Variant") for an unrelated admin panel. Recommend
  extracting one shared `{ sport: "Sport", year: "Year", manufacturer:
  "Manufacturer", setName: "Set", variantType: "Variant Type", insert:
  "Insert", parallel: "Sub-Variant" }` map used by both this modal and §2's
  unlink notice, rather than two more copies of a level→noun table
  accumulating (there are already at least two: `LEVEL_LABEL` here, and
  whatever `addButtonText`/`syncingLabel` hardcode per call site in
  `SetSelector.tsx`).
- **Breadcrumb availability**: absent at `sport` (nothing above it); a single
  ancestor at `year`; multi-level at `setName`/`variantType`/`insert`/
  `parallel`. Component already treats it as optional — just don't force a
  caller to synthesize an empty string.
- **`parallel` (Sub-Variants) is the one level with no `useEnsureSync` column
  wiring today** (`ParallelForm` uses the legacy `renderForm` path, per
  `SetSelector.tsx`) — the suggestions query/affordance still slots into
  `idleButtons` the same way, since that's shared regardless of path. No
  special case needed there; just confirm the FE agent doesn't assume
  `useEnsureSync` is a precondition for wiring the query.
- **Sports have no parent to disagree about** structurally, but a sport row
  can still get BSC/SL-disagreeing suggestions the same as any other level —
  nothing sport-specific to special-case in the modal itself.
- **`variantType` rows are excluded** from ever reaching this modal as a
  *rename* target once §F of the plan ships (`renameSelectorOption` refuses
  non-custom `variantType` renames) — but they can still legitimately show up
  in `getSelectorSyncSuggestions`'s read (a marketplace CAN relabel a Base/
  Insert/Parallel/Promo type). Recommend the query excludes `level ===
  "variantType"` rows outright rather than showing a suggestion whose Accept
  button would then hit F's guard and error — a suggestion the UI can't
  actually apply is worse than no suggestion. Flagging this as a
  backend-query decision, not a modal-rendering one: don't have the FE special
  -case "variantType" inside the modal to catch a refusal that the query
  should simply not produce.

## 2. Unlink notice

### 2.1 Levels 1-5 — the `selectorSyncStatus` row + a toast

Recommend widening `selectorSyncStatus.status` with a third value carrying the
result, rather than inventing a second table (nothing here needs to
outlive one sync cycle, matching Jason's "no need to track it in the DB"):

```ts
selectorSyncStatus: defineTable({
  level: ..., parentId: ...,
  status: v.union(v.literal("syncing"), v.literal("error"), v.literal("done")),
  message: v.optional(v.string()),
  unlinked: v.optional(v.array(v.object({
    value: v.string(),
    side: v.union(v.literal("bsc"), v.literal("sportlots")),
  }))),
  requestId: v.optional(v.string()),
  updatedAt: v.number(),
}).index("by_level_and_parent", ["level", "parentId"]),
```

`status: "done"` is written (instead of the row simply being deleted, as the
happy path does today) **only when `unlinked` is non-empty** — a sync that
unlinked nothing keeps today's "delete the row" happy path exactly as is, so
every existing flow/test asserting the row disappears on success stays green.

**Column rendering** (`EntityColumn.tsx`'s `newPathContent`): add a branch
alongside the existing `status === "error"` block:

```
{syncStatus?.status === "done" && syncStatus.unlinked && !dismissed[syncStatus.updatedAt] && (
  <div role="status" className="p-3 mb-1 bg-amber-400/10 border border-amber-700/60 dark:border-amber-400/40 rounded-md text-amber-800 dark:text-amber-300 text-sm flex items-start justify-between gap-2">
    <span>{unlinkNoticeText(syncStatus.unlinked, levelLabel)}</span>
    <button type="button" aria-label="Dismiss notice" onClick={() => dismiss(syncStatus.updatedAt)}>×</button>
  </div>
)}
```

Amber again (not pink/red — nothing failed, nothing was deleted; this is
informational, same register as the suggestions pill), sitting in the exact
slot the `status === "error"` box already occupies, so the two states
naturally **never render at the same time** — a sync is in exactly one of
`syncing` / `error` / `done` / absent at once, and a *new* sync overwrites
whatever `done` notice was showing the moment it flips back to `syncing`.
That answers "coexists with the existing error state": it doesn't need to,
because they're mutually exclusive branches of the same status field, exactly
like `error` and idle-buttons already are.

**Copy template** (`unlinkNoticeText`), grouped by side, each side clause
independently truncated (a column is only 260-340px wide — see
`EntityColumn.tsx`'s own `min-w-[260px] max-w-[340px]` — so keep this tight):

```
No longer listed on BSC: 2 sets — Topps Heritage, Topps Chrome
```

```
No longer listed on BSC: 4 sets — Topps Heritage, Topps Chrome and 2 more · No longer listed on SportLots: 1 set — 1987 Donruss
```

Truncate each side's name list to **2 names**, then `"and N more"` — narrower
than the toast's budget (§2.2) precisely because this box lives in the
260-340px column, not a floating overlay. Noun is the same singular map as
§1.9 pluralized normally (`set`/`sets`, `insert`/`inserts`, …).

**Dismissal is local-only React state, never a mutation.** `selectorSyncStatus`
is a *shared* row (a single global document for aggregator levels with no
`parentId`, per the schema comment — "one admin... flips it to 'syncing' for
EVERYONE"). If dismiss wrote back to that row, one admin dismissing it would
erase the notice for every other admin who hasn't seen it yet — exactly the
kind of cross-session interference `EntityColumn`'s own `selfRequestedSync`/
`hasInteracted` machinery already goes out of its way to avoid for the syncing
state. Key the local dismissed-set by `updatedAt` (or `requestId`) so a
*later* sync's fresh "done" notice is never suppressed by an old dismissal of
a different notice at the same `(level, parentId)`.

**Toast on completion**: fire once, on the `"syncing" → "done"` transition
(watch `syncStatus?.status` the same way `SetAttributesPanel`'s toast effect
watches its own save trigger), using that file's exact fixed-position pattern
(`fixed top-20 left-1/2 -translate-x-1/2 z-50`, `role="status"`,
`aria-live="polite"`, self-dismiss `setTimeout(6000)`900 — reuse verbatim, do
not invent a second toast mechanism in this codebase). Toast text is the same
`unlinkNoticeText` string, allowed a slightly longer truncation budget (3
names, since the toast isn't boxed into the 260-340px column) — but don't
over-engineer two separate truncation functions for a 1-name difference;
sharing one function with a `maxNames` param is enough.

### 2.2 Levels 6-7 (Insert/Sub-Variant) — from the mutation result, in `VariantForm`/`ParallelForm`

These two never touch `selectorSyncStatus` — they call
`storeReconciledOptions` directly and render their own inline message. Once
`storeReconciledOptions` returns `{ unlinked: [...] }` (plan §D), thread it
into the SAME message box these forms already render (the one gated on
`isError` today), but as a THIRD visual register — not blue (info) or pink
(error), amber again, matching §2.1 and §1.1 for one consistent "something
you should know about, nothing broke" language across the whole feature:

```tsx
const [unlinkedNotice, setUnlinkedNotice] = useState<UnlinkedEntry[] | null>(null);
...
const result = await storeReconciledOptions({ ... });
if (result.unlinked?.length) setUnlinkedNotice(result.unlinked);
setShowReconciliation(false);
onDone?.();
```

Rendered where `message` renders today (same box position, amber styling),
persisting until the operator closes the column or triggers another sync —
these two forms don't have a persistent-row concept to key a "done" state on,
so local component state showing until unmount (column closes) is sufficient
and consistent with how `message` itself already behaves there. No separate
toast needed for these two levels — the inline box IS the acknowledgment,
and these columns don't share a status row across admins the way the
aggregator levels do, so there's no cross-session-interference concern to
solve with a floating toast here.

### 2.3 Interaction with the `Custom` badge / `custom-entry-survives-resync.yaml`

That flow asserts a **custom** row (`isCustom: true`) keeps its blue "Custom"
badge across a re-sync (`EntitySelector.tsx`'s `isCustom()` check). NEO-211's
unlink action only ever touches a **non-custom** row's `platformData` slot —
`storeSelectorOptions`/`storeReconciledOptions` never write to `isCustom`, and
a row that started `isCustom: true` never had a marketplace slot to detach in
the first place (plan: "custom rows have `platformData: {}}`"). So there is
no interaction to design here — a custom row cannot appear in an `unlinked`
report, and the existing flow needs no changes. Worth stating explicitly
(rather than silently assuming) because the plan itself flags the adjacent
fact that a row losing its *last* marketplace link "becomes indistinguishable
from custom-shaped rows except for `isCustom: false`" — confirm the FE agent
does NOT read `platformData` emptiness as a proxy for "Custom" anywhere new;
the badge must keep reading the real `isCustom` flag, never an inferred one.

## 3. Partial-failure refusal alert (`VariantForm`/`ParallelForm`)

No new prefix constant needed — reuse the existing `SYNC_FAILED_PREFIX`
check verbatim (`message.startsWith(SYNC_FAILED_PREFIX)` already drives the
`isError`/Retry-button branch in both files). The bug today is that a
one-side-errored result silently takes the single-platform *store* branch
instead of the *error* branch; once fixed (plan §B), the message for that new
branch just needs to say the reassuring thing the old message never had a
reason to say — that nothing was written:

```ts
const PLATFORM_DISPLAY_NAME: Record<string, string> = {
  bsc: "BuySportsCards",
  sportlots: "SportLots",
};

// inside doSync, new branch: exactly one side errored (the plan's B):
if (result.errors.length > 0) {
  const detail = result.errors
    .map((e) => `${PLATFORM_DISPLAY_NAME[e.platform] ?? e.platform} failed, nothing was changed. ${e.message}`)
    .join(" ");
  setMessage(`${SYNC_FAILED_PREFIX}. ${detail}`);
  onDone?.();
  return;
}
```

Example rendered string: `"Sync failed: could not load variants. SportLots
failed, nothing was changed. <adapter error message>"` — this reads slightly
redundant ("Sync failed… failed…") but that redundancy is deliberate: the
FIRST clause is what the existing `isError` substring check keys off (must
not change it or every existing assertion on this prefix breaks), and the
SECOND clause (verbatim from the ticket: "SportLots failed, nothing was
changed") is the new reassurance. Retry button and Cancel/Close footer are
unchanged — this new branch reuses the exact same `!loading &&
!showReconciliation` footer block both files already render for the
both-sides-failed case, so no new UI, only a new *reason* to reach it plus
richer copy. `PLATFORM_DISPLAY_NAME` falling back to the raw key covers the
`"internal"` platform value `fetchRawOptions` also produces (thrown
exception, precondition failure) without a third hardcoded string.

Per the plan, this path is **unit-tested only** (`VariantForm.test.tsx`/
`ParallelForm.test.tsx`, first component tests for either file, mock pattern
from `BaseMappingForm.test.tsx`) — no new Maestro flow. `admin-sl-only` from
`admin-missing-bsc-shows-warning.yaml` is the one real-credentials rig that
COULD exercise this for real (one platform's creds genuinely absent → a real
one-sided error) if a cheap E2E addition turns out worth it later; not
required for this ticket.

## 4. Handoff summary for the frontend agent

**Defaults**
- Suggestions modal: nothing pre-selected, EXCEPT `foldEqual` sides
  pre-Accepted (mirrors NEO-203 tier-3).
- No blanket "Accept all"; do add "Accept all formatting-only suggestions
  (N)" scoped to `foldEqual` rows, and "Decline all (N undecided)" scoped to
  undecided rows only.
- Apply disabled with zero pending decisions; Close/Escape always safe, no
  confirm step (nothing written until Apply).
- Unlink notice: amber, dismiss is local component state only (never
  persisted), keyed by `updatedAt`/`requestId` so a new notice isn't
  suppressed by an old dismissal.

**Exact strings to keep stable for the E2E author**
- Column affordance visible text: `"{n} suggestion"` / `"{n} suggestions"`
  (bare count + noun, no other decoration) — this is what
  `1972-73-topps-hockey-tcg-rename.yaml` (or whatever the maestro-e2e-author
  names it) will `scrollUntilVisible`/`tapOn`.
- Per-side suggestion badge text: exactly `"BSC: {label}"` / `"SportLots:
  {label}"` — the plan's own E2E acceptance asserts the literal string `"BSC:
  Topps"`.
- Per-row action buttons: visible text `"Accept"` / `"Decline"`, one pair per
  side-suggestion (not per row) — for the plan's flow, the set has exactly
  one BSC suggestion, so a bare `tapOn: "Accept"` resolves unambiguously; if a
  future flow needs a specific one among several, target via each button's
  `aria-label` (`Rename "…" to "…" (from BSC)`).
- Bulk buttons: `"Decline all ({n})"` ⇄ `"Clear declines"`; `"Accept all
  formatting-only suggestions ({n})"`.
- Footer: `"Close"` / `"Apply"` (not "Apply & Continue" — no pipeline here).
- Unlink notice sentence: `"No longer listed on BSC: {n} {noun} — {up to 2
  names}{", and N more" if truncated}"`, one clause per side, joined with
  `" · "` when both sides have unlinks in the same sync.
- Partial-failure alert keeps the existing `SYNC_FAILED_PREFIX` values
  (`"Sync failed: could not load variants"` / `"...could not load
  parallels"`) as the leading substring; the new reassurance clause is
  `"{PlatformFullName} failed, nothing was changed."` verbatim per the
  ticket.

**Data/shape decisions made here that the backend agent should confirm**
- `getSelectorSyncSuggestions` should exclude `level === "variantType"` rows
  outright (§1.9), rather than have the FE special-case an Accept that would
  hit F's rename refusal.
- Suggestion rows carry `foldEqual` per side (cheap — the fold comparison
  already runs to decide row inclusion).
- `applySelectorSyncSuggestions` returns `{ applied, skippedStale,
  skippedClash }` so one bad decision in a batch degrades gracefully instead
  of aborting the others (mirrors `commitCardChecklistChunk`'s
  `staleDecisionIds` pattern).
- `selectorSyncStatus.status` grows a `"done"` value carrying `unlinked`,
  written only when non-empty (so the happy path's existing "delete the row"
  behavior, and every test asserting it, is unchanged when there's nothing to
  report).
- One shared level→singular-noun map (`Sport/Year/Manufacturer/Set/Variant
  Type/Insert/Sub-Variant`) used by both new surfaces, distinct from
  `SetAttributesPanel.tsx`'s existing `LEVEL_LABEL` (which uses different
  words for a different, older UI) — worth a one-line note in the PR if the
  FE agent instead reuses/renames that existing map, so a reviewer doesn't
  read it as an unrelated rename.
