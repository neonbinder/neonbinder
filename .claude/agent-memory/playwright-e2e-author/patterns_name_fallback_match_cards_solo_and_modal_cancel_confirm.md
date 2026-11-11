---
name: name-fallback-match-cards-solo-and-modal-cancel-confirm
description: NEO-490 spec patterns - Match Cards solo mode, name-fallback arithmetic, Cancel opens a discard confirm, two-phase fresh-only spec
metadata:
  type: reference
---

- A published checklist whose numbers match no card: equal row/card counts pair by unique player name on the server (no dialog); different counts apply nothing and open Match Cards in solo mode with name pairs as pre-linked suggestions. Derive expected counts from the CSV through `nameFallbackFacts` in `support/published-checklist.ts`, never hard-code.
- Match Cards "Cancel" opens a "Discard N pairing?" confirm (audit round); a spec that cancels must click the "Discard N pairing" button too, or the dialog stays and `toBeHidden` goes red. Not seen by specs that Confirm instead.
- Card item and checklist-row item both contain "#SIG-XX": filter listitems by `^#SIG-XX` regex (card side) to avoid strict-mode violations.
- Combobox option names carry league and era ("Oakland Athletics MLB · 1968–2024"): match by `^Name .*1968.2024`.
- The card list is virtualized: never assert all N cards render; assert one visible plus absence of the bad shape.
- A two-phase fresh-only spec (phase A discards before committing, phase B commits) passes once per seed; a red between phases parks a review batch that must be cancelled or the deployment re-seeded.
- Copy and accessible names in a new modal move during the audit round: pin them with minimal regexes and re-run after the audit commit.
