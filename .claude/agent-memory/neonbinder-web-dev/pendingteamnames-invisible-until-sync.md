---
name: pendingteamnames-invisible-until-sync
description: A quick-added card's typed team used to land in pendingTeamNames, which no checklist UI rendered and NEO-102 also un-badged — fixed and merged in NEO-208 (PR #215); only the rule half below is still load-bearing.
metadata:
  type: project
---

**Status: fixed and merged (NEO-208, PR #215, 2026-09-03).** The "broken"
description below is history; only the *rule* half is still load-bearing.

## The bug, as it stood on main

The Set Builder quick-add form's "Team (optional)" field wrote
`pendingTeamNames`, never `teamOnCardIds`. **No checklist surface rendered
`pendingTeamNames`** — not the grid row's subtitle, not the card detail
drawer's Teams section. So a hand-added card with a typed team showed no team
anywhere until the fetch → entity-review → commit pipeline resolved the name.

That display gap predates NEO-102, but NEO-102 made it consequential: its
attention rule deliberately counts a non-empty `pendingTeamNames` as
"answered", so the row also got **no** amber badge and was **not** picked up by
the attention walker. Net effect: a typed team was silently invisible.

Confirmed on the NEO-102 preview (2026-09-02): added `#101` with team
"Diagnosis Yankees" — row rendered with no team text and no badge, drawer's
Teams section showed only "+ Add team". Control card `#102` with an empty team
field was badged and behaved normally.

## What NEO-208 did about it

Fixed at the SOURCE, not by widening the badge: the quick-add form now uses the
same `TeamPicker` the drawer and the attention walker use, so the card is born
with real `teamOnCardIds` and never enters the pending state at all.
`addCustomCard` gained a `teamOnCardIds` arg validated by the same helper
`updateCard` uses, `updateCard` clears `pendingTeamNames` whenever it writes a
non-empty `teamOnCardIds`, and the legacy names that still exist do render now
(`<name> (unconfirmed)` in the row sub-line, read-only above the drawer's
picker).

**The attention rule was deliberately left alone.** That is the durable part
of this memory: "counts as answered" and "visible to the operator" are two
different problems, and changing the rule re-introduces the
walker-asks-for-what-you-just-typed bug the clause exists to stop. Rows written
before NEO-208 are exactly as answered as they ever were.

**How to apply:** if you find yourself about to make pending names badge-worthy,
stop — the fix is upstream (make the writer produce ids) or downstream (render
them), never the rule. Related:
[[reference_field_marker_class_is_two_classes_and_mangles_camelcase]].
