---
name: patterns-neo305-set-parallel-conversion
description: NEO-305 set<->parallel doors (setParallelConversion.ts) — two-mode destination guards drift (attach mode skipped the sibling link-holder check new mode had), slot-key string args, and what a "delete the emptied row" door silently discards
metadata:
  type: project
---

`convertSetToParallel` / `promoteParallelToSet` move SportLots links + cards
between rows and end emptied rows through `deleteEmptySelectorOptionRow`
(the trash icon's extracted helper, byte-identical to NEO-219's body).

Durable review rules from the audit (2026-09-24):

- **Two destination modes = two guard sets.** "new row" mode ran a sibling
  scan (`newParallelCheck` → any sibling `holdsAnyLink`); "attach to existing"
  mode checked only the chosen row. The dialog disabled only the HOLDER row,
  so picking a different sibling put one SL id on two parallels. When a
  mutation takes an optional `attachToId`, grep that every sibling/scope
  check in the create branch also runs in the attach branch.
- **Slot keys arrive as `v.string()`.** `idForSlot` indexes a plain DB
  object, so `"__proto__"`/`"constructor"` return non-undefined values.
  It fails closed today (label `.trim` / schema validation throws), but the
  cheap fix is `isSlotKeyForSide(side, key)` at the door.
- **A door that deletes the emptied row also deletes operator NB fields**
  on it (cardNumberPrefix, features, teamIds, declinedUpstreamLabels). The
  holdings check counts rows/cards/listings/review only — it is not an
  "operator data" check. Ask what the door carries, refuses on, or logs.
- Link-drop (rule 5) holds when: every SL slot on the source rows is in the
  move list, BSC on the source is refused up front, and the source row is
  only deleted after the holdings re-read.

Related: [[patterns-neo219-sanctioned-delete]], [[patterns-neo300-held-elsewhere]],
[[patterns-neo137-platform-slots]].
