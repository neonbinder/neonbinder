---
name: prove-focus-by-what-enter-does
description: maestro-web reports NO focus state (no `focused` attribute in maestro-web.js), so focus is proved by pressing Enter and asserting its effect — only after positive preconditions prove the Enter cannot land on a writing control
metadata:
  type: reference
---

`maestro-client.jar!maestro-web.js` builds each node's attributes from text,
`resource-id`, bounds, `selected`, `is-loading` — nothing about focus. A
`focused: true` selector therefore cannot work on web. The only observable
evidence of where the app put focus is what a `pressKey: Enter` does there.

**Why:** an Enter sent to the wrong focused control can WRITE. NEO-224's D3
lands focus on "Fetch from Marketplaces" (empty checklist — Enter starts a
fetch) or the attributes toggle (has cards — Enter expands a panel), and a
dialog that auto-opens (unmapped Base picker) makes the rule stand down and
owns the Enter itself.

**How to apply (keyboard-only-drill's D3 block is the worked example):**
1. Before the Enter, prove by SIGHT every condition that fixes the target:
   the state that picks it (e.g. `{id: "Sync card checklist", text: "Refresh"}`
   = checklist has cards; same aria-label reads "Fetch from Marketplaces" when
   empty), no dialog that could own focus (`Re-map Base` visible = mapped Base,
   no picker), and the target's PRE state (`Edit attributes`) so the post state
   is a change the Enter made.
2. Do not tap anything after the step that set focus (a pointer press can
   reset keyboard-only paths and moves focus); scrolls are safe.
3. Assert the post state (`Hide attributes`); branch on `output.SL_PAUSED` if
   the pause changes which dialog is up, and send NO Enter in that branch.
4. The target must handle Enter in its own `onKeyDown` (`activateOnEnter`) and
   be XPath-unique by class (see [[maestro-web-presskey-and-popovers]]).
