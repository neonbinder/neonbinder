---
name: reference_neo216_card_drawer_autosave
description: "NEO-216/217 — CardDetailPanel has NO Save/Cancel: every field autosaves per field. The handles that replaced them, which keystroke commits which field, the one shared toast region, and the flow patterns that follow from it."
metadata:
  type: reference
---

# The card detail drawer autosaves (NEO-216) — flow-facing contract

Branch `neo-216-217-card-detail-save-and-clearable-fields`. `CardDetailPanel`
dropped its draft state, `dirty`, `handleSave`, the Save button and the
discard bar. Every editable control writes ONE field through `updateCard`.

## Gone — never write these again
`Save card edit`, `Cancel card edit`, `Keep editing`, `Discard changes`, the
text `Discard unsaved changes?`. There is no dirty guard, so backdrop / x /
Escape / Done all just close.

## New handles
| handle | what it is |
| -- | -- |
| `id: "Done editing card"` (visible `Done`) | the ONLY close control in the footer |
| `Changes save as you leave each field.` | footer text stating the rule |
| `Saving…` | per-field busy note (words, not a spinner) |
| `id: "Card attributes"` | the chip `role="group"` |

Unchanged: `Card name`, `Card title`, `Card description`, `Print run`,
`Card variation`, `Toggle RC|AU|RELIC|SP|SSP|NUM`, `Close card detail`,
`Previous card`, `Next card`, `Regenerate card title`,
`Value for Autographed: Auto \(On Card\)`, `Card number this one is a
variation of`, `Clear variation parent`.

## Which gesture commits which field
* **single-line inputs** (Card name, Card title, Print run, Card variation) —
  `pressKey: Enter` commits IN PLACE; the drawer stays open. Blur commits too.
* **Card description is a `<textarea>`** — Enter types a NEWLINE
  (`enterCommit: "modEnter"`). Commit it by tapping another element. The safe
  parking spot is `id: "Card name"` at the top of the body: focusing a field
  commits nothing, and it is always above the fold.
* **chips and pickers write on the TAP itself** — no key, no blur. TeamPicker /
  PlayerPicker send only their own array.
* `Regenerate card title` puts the rebuilt title in the field and commits it
  through the same per-field path, so it saves itself.

## One toast region for the WHOLE drawer
`role="status"`, `fixed top-20`, 6s. Messages: `Saved Card name`,
`Saved Card title`, `Saved Card description`, `Saved Attributes`,
`Saved Print run`, `Cleared Print run`, `Saved Variation`, `Saved Teams`,
`Saved Players`. **Each write REPLACES the previous message**, so assert a
field's toast BEFORE making the next edit.

## Consequences for flow shape
* A flow that ended "tap Save, the drawer disappears" now needs an explicit
  `tapOn: { id: "Done editing card" }`. The footer is outside the scroll
  container, so `scrollUntilVisible` can never centre it — assert + tap (R8
  exception).
* "Cancel reverts the edit" is not a testable behaviour any more. Replace it
  with close-and-reopen, which proves the autosave instead.
* A REFUSAL (over-cap title) now happens at COMMIT, not on a disabled button.
  The over-cap alert is NOT proof of refusal — it renders from the field's
  LENGTH and is there either way. The proof is the ABSENCE of the field's
  `Saved …` toast right after the commit keystroke, followed by positives.
* `useReactiveField.runCommit` no-ops when `trimmed === baseline`, so a flow
  that types the value already stored gets NO toast and no mutation.
* Mirroring of the stored value back into an input is skipped while the field
  is focused or saving — and Enter does NOT blur. To assert "the stored value
  is now X" from the input, move focus off it first.

## NEO-217 clears
* **Print run**: blank commits `printRun: null` → `Cleared Print run`, and the
  row's sub-line drops `/99`. Erase, then assert the input reads its
  placeholder (`e.g. 99`) BEFORE the Enter — an input with no value reports its
  placeholder, so that IS the empty state, and it catches a stray character
  the erase left behind before it becomes a confusing toast miss.
* **Set/card attributes**: an empty commit REMOVES the key —
  `Cleared {label}` (`Saved {label}` unchanged). `SetFeatureRow`'s placeholder
  is `—`, so `{id: "Value for X", text: "—"}` is the cleared assertion. The
  select's empty option changed `— Select —` → `—` and is now selectable.
* Row sub-line reads `features.autographed` only: "On Card auto" /
  "Sticker/Label auto"; the legacy `autographType` "Unknown auto" is gone.
  No flow asserted it, so nothing had to change for that.
