---
name: maestro-web-presskey-and-popovers
description: On Maestro web `pressKey` supports Enter ONLY (no ESCAPE/TAB), re-finds the target by an XPath that falls back to tag[@class] so identically-classed siblings need a unique DOM id, sends a synthetic event with no default action, and `id:` selectors are regex finds; dismiss a picker popover by tapping a neutral element outside its root
metadata:
  type: reference
---

**`pressKey: Escape` fails the command outright on Maestro web:**
`CommandFailed: Keycode ESCAPE is not supported on web` (CI run 33823406555).
`pressKey: Tab` is unsupported too. **Enter is the only keycode this suite
uses, and the only one verified to work** — it fires the FOCUSED element's own
handler (39 uses across the flows; grep confirms nothing else).

Do not be fooled by the word "Escape" appearing in flow files: every occurrence
outside those two failed lines is in a COMMENT explaining that Escape cannot be
driven from a flow (see `checklist-keyboard-only-dialog.yaml`'s "MAESTRO
KEYBOARD CONSTRAINTS" block, which says the Escape-cancels path is exercised by
hand, not by the suite). When auditing, match `^[[:space:]]*-[[:space:]]*pressKey:`
rather than the bare word, or you will read prose as precedent — that mistake
cost two CI cycles.

## `pressKey` does NOT send to `document.activeElement` — it re-finds by XPath

maestro-web runs `createXPathFromElement(document.activeElement)`, then re-finds
the element by that XPath and dispatches there. The generator uses `id("…")` when
the element has a DOM id and otherwise falls back to `tag[@class="…"]` per
ancestor — so **two identically-classed siblings collapse into one XPath**,
Selenium returns the FIRST, and the key lands on the wrong control while the
app's own focus is perfectly correct.

NEO-220 hit exactly this: the wizard's `Confirm & Save` and its `Cancel (Esc)`
sibling are both `NeonButton`s with the IDENTICAL class string (the neon colour
is a `data-accent-color` attribute and an inline style, not a class), so Enter
aimed at Confirm pressed Cancel — the failure screenshot showed
"Discard 1 decision?". NEO-220's original fix was a unique DOM id
(`entity-review-confirm-save`); **NEO-260 replaced that mechanism.**

**Rule: never a DOM id — give the element a unique, USER-VISIBLE handle.**
Jason, 2026-09-09, verbatim: "NEVER USE AN ID VALUE, USE ONLY THINGS VISIBLE TO
USER. I do consider an aria label visible to the user." A DOM id is invisible to
sighted and screen-reader users alike, so targeting one lets a flow pass while
the real experience stays broken. Note most `id:` selectors in the suite are
already matching an **aria-label** — the driver resolves
`resource-id = node.id || node.ariaLabel` — which is correct and stays; adding a
real DOM id to such an element REPLACES the handle flows target by.

When identically-classed siblings collapse into one XPath, fix it in product
code, two changes together:
1. **A per-button `useFieldTestClass()` marker class** (`mb-field-<useId>-btn-…`)
   so `createXPathFromElement` names exactly one node. This is the house pattern
   — see `components/SetSelector/EntityColumn.tsx` and the converted
   `EntityReviewWizard.tsx` footer.
2. **Distinct accessible names** so a screen-reader user can tell the buttons
   apart, plus real Enter handling (`lib/dom/activate-on-enter.ts`). Keyboard
   operability is a product requirement: CLAUDE.md says every flow must be fully
   operable from the keyboard.

The collision is the test reporting an accessibility gap. Close the gap rather
than routing around it.

Corollary — **a synthetic KeyboardEvent has no default action.** `dispatchEvent`
runs the listeners and stops, so a focused `<button>` is NOT activated the way a
real keypress activates it; the button must handle Enter in its own `onKeyDown`.
Every other Enter in this suite aims at an `<input>` whose own handler does the
work, which is why this only bites on buttons.

Corollary — **`id:` selectors are regex FINDS, not exact matches.** `id: "Remove
Topps"` also matches `Remove Topps Chrome`. Where a screen can hold two instances
of a control, give them labels sharing no substring, or anchor the matcher.

Written up in `.maestro/README.md` too (NEO-248).

## Closing a TeamPicker / PlayerPicker popover

Selecting a match deliberately leaves the popover OPEN (`addChip`: "Stay open so
the user can pick a second team"). The popover is
`absolute left-0 top-full mt-1 z-10 w-64` — 256px hanging BELOW the trigger,
over whatever follows it. Where the surrounding row is `flex flex-wrap` and too
narrow to fit on one line (e.g. PlayerManagement's stint row: picker + two
`w-28` year boxes + button in a ~440px panel), the next fields wrap UNDERNEATH
and are covered. A tap at their coordinates lands on the popover, and since the
popover is inside the picker's own root the outside-`pointerdown` handler does
not even fire — the typing silently goes nowhere.

**The dismissal is a tap on a neutral element OUTSIDE the picker root**, which
is what that handler listens for:

```yaml
- tapOn: "Career history"   # the section <h3>, ABOVE the picker
```

Choosing the target:
* **Above the picker, never below** — the popover is `top-full`, so anything
  above it can never be covered.
* **No handler and not focusable** — a heading or a static label. Avoid a `<ul>`
  or any container whose bounding-box centre could land on a child button
  (a stint list's "Remove stint" would delete data).
* An aria-label twin is not a hazard for a `text:` matcher: Maestro exposes
  aria-label as **`id`**, not as text (cf. `id: "Staged career teams"` against a
  `<ul aria-label>` in `checklist-fetch-wizard-add-career-team.yaml`).

Related: [[e2e-pick-selector-modes]].
