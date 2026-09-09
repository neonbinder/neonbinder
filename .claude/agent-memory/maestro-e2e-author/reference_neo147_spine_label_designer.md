---
name: neo147-spine-label-designer
description: /print/spine-label selectors + the two traps that cost a run — reusing an HTTPS Vite hangs Maestro 180s, and scrollUntilVisible must be direction UP to reach the right column after tapping the bottom-left button.
metadata:
  type: reference
---

# NEO-147 `/print/spine-label`

Not admin-only — it sits under the ordinary Print Shop layout. Holds everything
in page state, writes nothing to Convex, so a flow needs no seeded data and
collides with no worker.

**Do not depend on a player existing.** The "Player" box searches the `players`
table, whose contents vary per deployment. The free-text field labelled
**"Name on the label"** is the deterministic path (target by visible label text
— the `Input` primitive has no id/aria-label).

**Selectors that work:**

| What | Selector | Note |
|---|---|---|
| Contrast readout | `.*Contrast .*:1.*` | The `:1` anchor is needed — the amber fallback ends "…to see contrast." |
| Typeface | `Graduate` (11 buttons, each its own name) | Side-effect proof: the note `<p>` becomes "Collegiate slab. Varsity." |
| Ring size preset | `'3"'` — ASCII double quote | The prose below uses U+2033 PRIME (`3″`), so the two never collide |
| Ring size took effect | `.*2 labels per sheet at 3. wide.*` | Composed from widthIn; `.` dodges the prime glyph |
| Queued row's Remove | `id: "Remove <name>, <widthIn> inch spine in <font>, from the sheet"` | Composed from all three design choices — one assertion proves them all |
| Sheet count | `.*Sheet \\(1 label, 1 page\\).*` | Escape the parens |
| Designer cleared | `Pick a player, or type a name, to see the label.` | Only renders when the sheet is empty AND the name field is blank — so after removing the label it is the honest proof that Add cleared the form |

**Never tap "Print"** — `window.print()` wedges the run.

## Two traps that each cost a full run

1. **Reusing a Vite that is serving HTTPS hangs Maestro for exactly 180s** with
   a blank-but-correctly-sized screenshot and
   `Timeout when executing request (GET …/session/…/url)`. "Reuse the running
   Vite" is only right if it is on **http**. Check the scheme first
   (`curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/`), and if it
   is HTTPS restart it with `VITE_DEV_DISABLE_HTTPS=1 npm run dev` — the harness
   defaults `APP_URL=http://localhost:3000`.
2. **`scrollUntilVisible` needs `direction: UP` here.** "Add to sheet" is the
   last control in the LEFT column, so pressing it leaves you at the page
   BOTTOM — while the sheet you just added to is the top of the RIGHT column,
   i.e. *above* you. The default DOWN walks away forever, and an off-screen node
   is pruned from the hierarchy before any selector runs, so it reports
   "No visible element found" and reads like a dropped tap rather than a scroll
   direction bug. (Same class as [[scroll-authority-disagreement]].)
   Diagnostic tell: the failure screenshot showed the tapped button still
   enabled at its correct bounds — the tap was fine all along.

Flow: `.maestro/flows/spine-label/design-and-queue-a-spine-label.yaml` (green
~41s). See [[neo155-admin-section-and-setbuilder-anchor]].
