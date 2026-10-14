---
name: pairing-conflict-pills-are-bare-values
description: NEO-344 — Match Cards conflict pills show only the value (`<value> — use this name|these players for <scope>`), so a flow tells the sides apart by reading each half's value off the unmatched COLUMNS before it links; where the dialog is reachable on a big set
metadata:
  type: reference
---

Since NEO-344 (2026-10-13) `CardPairingModal`'s name and players conflict pills
never name a marketplace: visible text is the bare value, accessible name
`<value> — use this name for <scope>` / `<players> — use these players for
<scope>`, the typed option is bare too (no `Custom: `), the warnings read
`Potential names for this card — …` / `Potential players for this card — …`.
BSC stays preselected (Jason). Option order is fixed (BSC, SportLots, typed),
but select by VALUE, not index.

**How a flow knows which value is whose:** read it BEFORE the link, from the
unmatched columns, which still say which side a card is on. `Select BSC card
<label>` and `Link selected BSC card to <label>` buttons are one text node,
`label()` = `#<number> <name>[ · <variation>]`; strip the number (and any
` · …` tail) to get the pill's value, escape it
([[runtime-names-need-regex-escaping]]), then target the pill by `id:` AND
`text:` on one node. Read the BSC row before tapping it: selecting renames it
`<label>, selected. Press to deselect.`. Prove "BSC is the default" by the
row's `Unlink #<n> <bsc value>` (it carries the chosen name), never by
styling: `aria-checked` is not in maestro-web's hierarchy.

**Reach on a big set (hundreds of matched rows):** the body opens at the TOP
of the matched list (natural number order), so only the first ~6–8 rows are
assertable; a link that creates a conflict focuses that row's checked pill,
which should scroll the body to it wherever it sits (code reading, not yet
measured — confirm in a run's hierarchy). The committed checklist opens at its
LAST row ([[committed-checklist-opens-mid-list]]), so a saved-name read-back
wants the conflict on the highest card number. Worked examples:
`checklist-pairing-dialog-cancel` (read-only, #FS-1/#FS-2) and
`checklist-team-leader-cards-pair-and-picked-name-saves` (commits #442).
