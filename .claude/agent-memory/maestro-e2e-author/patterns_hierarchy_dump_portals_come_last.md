---
name: hierarchy-dump-portals-come-last
description: A failure hierarchy dump lists PORTALLED nodes (dialogs, popovers, toasts, `clerk-components`) at the END of the tree, after the nav rail — truncating a dump with `head` hides the very modal that explains the red
metadata:
  type: reference
---

**Read a `screen-hierarchy/step-N-*.json` to the END before deciding what
was on screen.** React portals (`NewTeamDialog`, `PickerPopover`, the
entity-review wizard, the Match Cards dialog, toasts) are appended to
`document.body`, so maestro-web serialises them AFTER the page's own tree —
after the `Dashboard … Profile` nav rail and the `clerk-components` /
`:r3:` sentinels. The page part looks complete on its own.

**Why:** diagnosing PR #272's first run (2026-09-21) I printed a dump with
`head -60`, saw a set-attributes panel with no chip, no toast and no
dialog, and reasoned for twenty minutes about which onChange path could
have finished silently. The tail of the same file held the New Team
dialog, still open, its Create button reading `Creating…` — the plain
stalled-write signature. Same shape on the inserts flow: the page part
showed 220 rows; the tail held the wizard with the actual Convex error.

**How to apply:** print the whole dump, or grep it for the surfaces you
expect (`Creating…`, `Saving`, `role=status`, dialog headings) before
theorising. When a page-level component's state looks impossible ("pending
cleared but nothing stored"), the explanation is usually a portal further
down. The summariser in this store's `tools/` idiom: walk every node,
never slice the output.
