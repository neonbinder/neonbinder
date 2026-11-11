---
name: pasted-checklist-format-traps
description: Real-world checklist paste/CSV shapes a line or header parser gets wrong (Beckett/CC/TCDB/publisher sheets); run these against any checklist-import parser
metadata:
  type: feedback
---

When reviewing any feature that reads a pasted or uploaded checklist, run the parser on these shapes (they broke PR 451's first cut):

- Comma separator "1 Shohei Ohtani, Los Angeles Dodgers" -> team swallowed into the player.
- Headerless TSV (copying a TCDB/spreadsheet table) -> tabs collapse, "Mike Trout Los Angeles Angels" as one player.
- Headerless CSV -> every line skipped.
- Letter-only suffix numbers "RA-MT", "CPA-JH" (autos/relics) and "NNO" -> skipped as "no card number".
- Trailing markers outside brackets: "SP", "SSP", "VAR", "HOF", "/99", "#/99", "- SP" -> end up in the player or become the team.
- Count lines "350 cards." -> a junk row on the set's last number (also kills the real #350's exactly-one match).
- Team / checklist cards without the exact label: "34 Kansas City Royals", "Royals Team", "TC", "Checklist 1-132".
- Multi-player with "&", "and", commas; leader cards with last names only vs full names on the marketplace.
- Publisher sheets with a "Card Set"/subset column: whole-product paste means duplicate numbers across inserts.
- Unspaced em dash "Trout—Angels"; Topps "®" on team names.

**Why:** a dealer pastes whatever page they found; a wrong split becomes a false conflict flood or, worse, a silent fill (players fill where the card has none) or a "no team" claim that suppresses the team lookup.
**How to apply:** also check what a matched row with NO team does downstream: absence of a team in a paste is not a data claim of "no team". See [[team-prefill-set-year-traps]].
