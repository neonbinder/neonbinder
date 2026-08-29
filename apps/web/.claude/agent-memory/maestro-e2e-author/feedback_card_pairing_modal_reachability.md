---
name: card-pairing-modal-reachability
description: CardPairingModal is reachable only from a real marketplace fetch, only one flow may fetch a given real set, and how to manufacture a deterministic manual mis-pair (unlink two, cross-link their halves) without depending on live marketplace names
metadata:
  type: feedback
---

**`CardPairingModal` can be reached by exactly one flow per real set, and that
flow may only ever Cancel. To cover something new in the dialog, EXTEND that
flow — never add a second one.**

**Why:** the dialog is opened only by `CardChecklist.handleSync` from
`fetchCardChecklist`'s return value. A custom subtree short-circuits BSC/SL
(`isCustomSubtree`, NEO-22) and returns three empty buckets, and `handleSync`
deliberately skips the dialog when all buckets are empty — so a per-worker
custom set can never reach it. Seeding `checklistCandidates` does not help
either: `streamedPairing` is gated on `fetchInFlight`, which only a live fetch
sets. That leaves a real, shared set, and:

- `startCandidateBatch` deletes **every** `checklistCandidates` row for a
  `selectorOptionId`, globally;
- `getReadyCandidates` is **not** user-scoped.

So two runners streaming the same set concurrently can empty each other's live
candidates, which unmounts the other one's dialog mid-review (`streamedPairing`
goes null while `pendingPairing` is still unset). Confirm is also off the table:
it writes to a set eight runners read (`SET-REGISTRY.md`, R7a).

**How to apply:**

- Today the one such flow is
  `.maestro/flows/set-selector/checklist-pairing-dialog-cancel.yaml` on
  2024 Topps Chrome → Insert → Future Stars. Add dialog coverage there.
- **Wait for the fetch to finish before counting anything.** The dialog opens on
  the first streamed candidates. While streaming, Confirm reads `Loading…`; it
  becomes `Confirm` when the action resolves. `extendedWaitUntil: visible:
  {text: "^Confirm$"}, timeout: 90000` is the sync point (the one R5 exception).
- **Manufacture the case; do not go looking for it in live data.** Two
  auto-matched rows unlinked and then CROSS-linked (BSC's #A to SportLots' #B)
  gives a guaranteed mis-pair. Key every selector on the printed CARD NUMBER,
  never a player name, and read names off the screen at runtime
  (`copyTextFrom` — see [[maestro-web-driver-limits]]).
- **Maestro cannot scroll the dialog's inner overflow.** Pick rows that sort to
  the TOP, and collapse the Matched section (`id: "Collapse matched cards"`)
  before working in the BSC/SportLots columns — which doubles as the only way to
  observe the "a conflicting link re-opens the collapsed Matched section"
  behaviour.
- `compareCardNumbers` falls back to `localeCompare` for non-numeric card
  numbers, so a set numbered `FS-1…FS-20` sorts **FS-1, FS-10, FS-11 … FS-19,
  FS-2, FS-20, FS-3 …**. Choose the top two by that ordering (FS-1 and FS-10),
  not the two that look adjacent.
