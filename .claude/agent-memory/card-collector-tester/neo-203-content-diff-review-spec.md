---
name: neo-203-content-diff-review-spec
description: Collector-perspective UX spec delivered for NEO-203's "changed" / "removed-upstream" re-sync review step (2026-09-01 design consult).
metadata:
  type: project
---

Delivered a design-consult (no code) for NEO-203 section C — the review
surface for re-sync's "changed" and "removed-upstream" card buckets, on
`worktrees/neo-203`, branch `neo-203-nb-owned-resync`.

**Key recommendations made:**
- New separate modal (not folded into `CardPairingModal`) runs AFTER pairing
  is confirmed, before `EntityReviewWizard`. Pairing is an identity question
  (which marketplace row = which NB row); content-diff review is an editorial
  question (is this new value right) — different mental tasks, kept visually
  distinct but reusing the same chrome (collapsible sections, streaming
  banner, Confirm/Cancel footer, focus-management helpers) as
  `CardPairingModal`/`CardChecklist.tsx` already establish.
- Per-card accept/reject as the commit primitive (matches the plan's own
  `applyContent` decision), but with per-FIELD checkboxes inside each
  changed-card row so a card with one disputed field (e.g. operator
  deliberately renamed a card, marketplace "fixed" it back) doesn't force an
  all-or-nothing loss of its other, legitimate corrections. Proposed widening
  `applyContent: boolean` to `applyContent: string[] | false` — a natural
  extension of the plan's already-stated "checklistCandidates grows the diff
  fields" note, not scope creep.
- Field risk tiers drive default checkbox state: Tier 1 (players, team,
  isRookie, isRelic, autographType, printRun, cardVariation) defaults
  UNCHECKED — must be explicitly reviewed. Tier 3 (pure
  case/whitespace/diacritic-fold-equal changes on any field) defaults
  CHECKED — safe to bulk-accept. cardName is Tier 2: checked only when the
  diff folds equal (cosmetic), unchecked when it's a substantive rewrite.
- Bulk workflow for "200 cards re-capitalized" scenario: split the changed
  list into two collapsible groups — "Formatting only (N)" (every changed
  field on the card folds equal) collapsed by default with a one-click
  "Accept all formatting changes" header action, and "Content changes (N)"
  expanded by default for individual review. Mirrors the existing
  `matchedCollapsed` / `KEEP_ALL` bulk pattern already in
  `CardPairingModal.tsx`.
- Removed-upstream rows: default is NEVER auto-selected for deletion: reused
  the `isCrossListed` distinction already in `CardChecklist.tsx` — only cards
  orphaned on EVERY previously-linked side belong in the deletion-consideration
  list; a card still live on one marketplace but delisted from the other
  should just get a lighter inline badge in the normal checklist (e.g. via
  `ChecklistSourceFilter`'s `Chip`), not routed through a delete flow.
  Bulk-delete gated behind one non-destructive-by-default confirm dialog
  (focus starts on Cancel), not a type-to-confirm — that's disproportionate
  for card-level (vs. whole-set) deletion.
- Escape on this new modal should NOT abort the whole sync the way it does on
  `CardPairingModal` (which aborts because nothing has committed yet there).
  By this later step, defaults are already safe (unreviewed = not applied,
  orphaned = not deleted), so Escape here should mean "skip reviewing changes,
  continue the pipeline with nothing extra applied" — a non-destructive
  forward-skip, not a cancel. Flagged this explicitly since blindly copying
  the earlier modal's Escape semantics would be wrong here.
- Noted an edge case worth a small radiogroup (reusing the existing
  `nameConflict` BSC/SL/custom interaction pattern from `CardPairingModal`):
  a merged pair whose BSC side and SL side each ref-match a DIFFERENT existing
  NB row. Should surface, not silently pick one (same "surfacing beats
  narrowing" principle the plan already cites from PR #205).

See also [[marketplace-data-trust-characteristics]] for the BSC-vs-SL data
trust reasoning behind the field risk tiers and per-source badging
recommendation.
