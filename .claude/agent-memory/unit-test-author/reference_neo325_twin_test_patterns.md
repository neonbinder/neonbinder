---
name: neo325-twin-test-patterns
description: NEO-325 name-twin test layout and traps - break-check script approach, two-layer defence hiding sync-level filters, status-region and copy churn, BSD sed
metadata:
  type: reference
---

Twin tests live in new files beside their family: `fetchAggregatedOptions.nameTwins`, `syncSetsAcrossManufacturers.nameTwins`, `fetchRawOptions.nameTwins`, `storeReconciledOptions.nameTwins`, `ensureBrandRowForName`, `ReconciliationModal.titleClashes`, `SlSetReviewModal.names`, `EntitySelector.twins`, `SyncDoneNotice`, `ready-title-clashes` (all components ones `.test.tsx`).

- Break-check loop: a tiny script that reads the file, replaces one snippet, runs vitest on named tests, and restores from the in-memory original bytes. Scripts live in the scratchpad, never /tmp. A concurrent builder editing the same source makes a break run report "no tests" or mass failures - rerun, do not trust it.
- Defence in depth hides filters: planSelectorSync now withholds name twins itself, so removing the Sync Sets pre-filter does not change set rows. The filter is observable only through minted Unknown/brand rows and the held twin's label refresh (seed `platformLabels` stale, assert refreshed).
- returnedIds break checks need a non-empty returned list (add a unique pair), or the unlink pass skips and the mutation looks harmless.
- Year level is the cheapest level where both marketplaces answer for fetchAggregatedOptions; BSC stub key is `aggregations.year`, SL is a `<select name="yr">`. Insert-level fetchRawOptions needs the SET linked on either side (BSC id on setName) or SL is skipped.
- Assert copy through the owning helper (`titleClashMessage`, `refusedReasonText`, `twinLeftIdsText`) and a11y wiring through `aria-describedby` ids, never literal sentences: web builders reword and re-quote copy mid-pass.
- BSD sed: `sed -i -E` consumes -E as the backup suffix and leaves `*-E` files; use perl -pi.

Second pass (post a11y/security rounds):
- Always-mounted `role="status"` regions: use a helper that waits for the first region with text (`getAllByRole("status").find(el => el.textContent)`); `findByRole("status")` is ambiguous. A bare region is also testable as "same DOM node before and after the answer".
- Swap one internal query in convex-test by wrapping the module registry: `{...modules, "./selectorOptions.ts": async () => ({...real, heldIdsForTwinNotice: internalQuery({...})})}` - records args or throws, the real action calls it through ctx.runQuery.
- Equivalent mutants in the hoisted computeMatches: splices on an index-aligned array iterated downward, and dropKey on a count already 1, are unobservable; a frozen copy of the old algorithm in the test (hoistParity file) catches the rest.
- `[A, A]` repeat-drop in storeReconciledOptions extras is unobservable (initialSlots dedupes, the planner withholds a held primary first): pin the outcome, not the filter.
- "here" is a substring of "There's"; assert the full phrase. Decision payload key is `variantTypeId`, not `typeId`.
- Zsh does not word-split a variable holding a command: use a shell function for the break-check script.
