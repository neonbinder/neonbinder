---
name: maestro-web-presskey-and-popovers
description: On Maestro web `pressKey` supports Enter ONLY — ESCAPE and TAB are not web keycodes; dismiss a picker popover by tapping a neutral element outside its root
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
