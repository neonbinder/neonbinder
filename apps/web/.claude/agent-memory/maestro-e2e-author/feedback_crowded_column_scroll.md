---
name: crowded-column-scroll-search-conditional
description: Technique for tapping a row in an EntitySelector column that may be crowded (>8 items + internal overflow scroll) — use a conditional search/scroll pattern via runFlow+when
metadata:
  type: feedback
---

## Rule
When a flow needs to tap a specific row in an EntitySelector column that may be crowded:
- Use `runFlow: when: visible: id: "Search <entity>" commands: [tapOn id, inputText, tapOn row below id]` for the crowded path (>8 items → search input appears)
- Use `runFlow: when: notVisible: id: "Search <entity>" commands: [scrollUntilVisible + tapOn]` for the clean CI path (≤8 items → no search, column fits in viewport)

The `id:` value is the aria-label of the search input: `Search ${title.toLowerCase()}` → e.g. `"Search inserts"` for the Insert column, `"Search sports"` for Sports.

**Why:** EntitySelector columns have `overflow-y-auto` internal scroll. Maestro CDP page-level `scrollUntilVisible` sends swipes to the ROOT scroll axis, which does NOT move items inside an inner overflow container. With accumulated test data (>8 entries), the target row clips below the column's internal fold and `scrollUntilVisible` is a silent no-op. The search input filters the list to show only matching entries near the top, making them tappable without any scroll.

**Key detail:** The EntitySelector only shows the search input when `sortedItems.length > 8` (strictly greater than 8). With ≤8 items, the column is short enough to fit in the container height, so internal scroll never triggers and CDP page-level scroll works fine.

**How to apply:** Any post-save or post-action assertion that needs to SELECT a row in an Inserts/Parallels/Sets column that accumulates data across runs. See `move-parallels-of-inserts-custom.yaml` post-save section for the reference implementation.

## Column reset via /dashboard → pre-warm → util-drill

When an EntitySelector column has STALE INTERNAL SCROLL after in-session interactions (Group Parallels modal, add-entries steps, etc.), a full component unmount is the only way to reset scroll to 0.

Pattern (confirmed working in move-parallels-of-inserts-custom.yaml):
1. `openLink: /dashboard` → full React unmount of SetSelector (column DOM + scroll state drops)
2. `openLink: /set-selector` + `extendedWaitUntil: visible: "Baseball" timeout: 60000` → SPA remounts SetSelector; auto-sync fires and completes BEFORE the util-drill runs; "Baseball" is the signal that Sports items.length > 0 (so auto-sync won't fire again on the util-drill's sport tap)
3. `runFlow: util-drill-to-custom-set.yaml` → drill proceeds with fresh scroll=0 and no auto-sync interference

**Why the pre-warm step is essential:** Without it (just /dashboard → util-drill), the util-drill's own `openLink: /set-selector` triggers a fresh mount; auto-sync fires for the empty Sports column; the sport is briefly selected → Years appears → auto-sync clears the Sports list → Years disappears; the util-drill's `extendedWaitUntil: visible: "Years" timeout: 60000` expires (sport was deselected by auto-sync, not re-selected).

**When to use this pattern:** Only when the internal column scroll must be reset (post-modal interactions with stale scroll). Normal drill flows don't need it.

## Conditional when: syntax reminder

`when:` is ONLY valid inside a `runFlow:` block. A standalone `- when: ...` is NOT a valid Maestro command. Always use:
```yaml
- runFlow:
    when:
      visible:
        id: "Search inserts"
    commands:
      - tapOn:
          id: "Search inserts"
      ...
```

## Modal internal scroll cannot be controlled

ParallelGroupingModal (and similar modals) have their own `overflow-y-auto` scroll container. With accumulated prior-run groups, new run entries clip BOTH above the fold (parent in "Top-level inserts" section) AND below the fold (Gold/Red in "Parallels of..." section at the bottom). Do NOT assert specific entry text in the modal body. Assert only modal-level signals that stay in the footer (always visible):
- `".*Accept all suggestions.*"` — proves auto-detection fired
- `".*[0-9]+ promotion.*"` — proves Gold/Red pre-placed
- `".*Save [0-9]+ change.*"` — proves changes pending
