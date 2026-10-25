---
name: collection-binders-flake-mechanisms
description: NEO-359 /collection binders specs go intermittently red from two product mechanisms (optimistic id swap after Undo, tray focus-scroll eating a mouse click) and one stale locator; read these before calling them flakes
metadata:
  type: pattern
---

Three things seen on the binders specs, each with a named mechanism:

1. **Undo shows "Undone." before its write lands.** A split's new line carries a placeholder id until the server answers; the drawer's open Move panel is keyed on the line id, so the panel vanishes (desktop: form never visible; phone: Move button detached mid-click). Move/notice writes post their status AFTER the write, Undo posts it BEFORE, so the status is not a settle signal there. A product fix (post it after the write) is the right one; do not add a wait.
2. **The pinned pack tray scrolls the page on mouse focus.** `MyBindersTab` `onFocus` -> `keepClearOfTray` scrolls by tray height plus 16 px when the focused control sits under the tray, with no keyboard-only guard. Playwright's mousedown focuses a spine low on the page, the page jumps, mouseup lands elsewhere and no click fires: the Want List spine "click" opens nothing. Tell-tale: the trace's click box and the final screenshot differ by exactly the tray height plus 16. Dismissing the notice does not help (the hunt strip is the tray).
3. **Hunt hits include parallels.** Searching "<player> <number>" lists the base card and its parallels ("..., Orioles, Gold Wave Refractors"), so a `^Slot in ... #N Player` prefix regex is a strict-mode violation. Match the base card with `, [^,]+$` after the player.

Also: a card the collector has marked Have sits under "Everything else I own" (My Cards with binders on) as list "Off the board, N cards" and a status "N card(s)"; Have does not make a set a build.

**How to apply:** reproduce an intermittent red in a loop inside one scratch spec (delete it after) and read the trace's click box against the final screenshot before suspecting timing. A local seed needs the reference bundle (`e2e-seed-reset.sh` with `NB_REFERENCE_BUNDLE`) or `setup.spec` fails at the Years pause notice.
