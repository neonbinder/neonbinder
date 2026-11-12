---
name: name-fallback-match-cards-solo-and-modal-cancel-confirm
description: NEO-490 spec patterns - name-fallback arithmetic, Cancel opens a discard confirm, two-phase fresh-only spec (solo mode retired by NEO-496)
metadata:
  type: reference
---

- A published checklist whose numbers match no card: equal row/card counts pair by unique player name on the server; different counts apply nothing and pre-link the name pairs as suggestions. Since NEO-496 a checklist is a Match Cards source, so the dialog opens either way with Keep controls (no solo mode): see [[checklist-is-a-match-cards-source]]. Derive expected counts from the CSV through `nameFallbackFacts` in `support/published-checklist.ts`, never hard-code.
- Match Cards "Cancel" opens a "Discard N pairing?" confirm (audit round); a spec that cancels must click the "Discard N pairing" button too, or the dialog stays and `toBeHidden` goes red. Not seen by specs that Confirm instead.
- Card item and checklist-row item both contain "#SIG-XX": filter listitems by `^#SIG-XX` regex (card side) to avoid strict-mode violations.
- Combobox option names carry league and era ("Oakland Athletics MLB · 1968–2024"): match by `^Name .*1968.2024`.
- The card list is virtualized: never assert all N cards render; assert one visible plus absence of the bad shape.
- A two-phase fresh-only spec (phase A discards before committing, phase B commits) passes once per seed; a red between phases parks a review batch that must be cancelled or the deployment re-seeded.
- Copy and accessible names in a new modal move during the audit round: pin them with minimal regexes and re-run after the audit commit.
- Equal counts with ONE misspelled name: since NEO-496 the server pairs it too, by a near name (a "Checklist #n" chip plus an "NN%" chip in the collapsed Matched list). Linking a pair whose spellings differ makes the wizard open on "Checklist says otherwise" FIRST (`expectChecklistDisagreementFirst`, then `pickDisagreementSide`, then Next).
- A full local run on ONE test account: workers=1 (every local worker maps to the one account, so parallel workers race on its data), and a placeholder/photo-upload burst can hit the per-account batch limit ("12 batches in the last 60 minutes", it is a screenshot-only message); those specs pass alone, so classify by an isolated re-run on a fresh seed. A spec that needs a deployment env var (a BSC stall id list) fails by name on a per-worktree deployment that lacks it.
- A fresh-seed re-run is the only way to retry a committing spec: keep a byte-exact backup of the file before a planted break, and plant the break BEFORE the first commit point so no review batch is parked.
- A past-era club with a player whose stints name it is now linked by the wizard ("Linked to <club> · <player> played there"), so a spec that answered its New Team step must read the Decided line instead (NEO-490 rule 2b).
