---
name: teams-on-cards-radio-lines-neo335
description: NEO-335 wizard "K cards have no team yet" section and header "N need you" pill - what was right (roving radios, activateOnEnter, livery contrast gate) and the recurring gaps (unused loading flag, live region unmounted at 0, Confirm autofocus hides the questions)
metadata:
  type: project
---

Pattern findings from auditing TeamsOnCardsSection (per-line APG radiogroups of team chips) and the CardChecklist header pill.

Right, reuse as precedent: roving tabindex radios with arrow/Home/End wrap, `activateOnEnter` on each radio (stops Enter reaching Confirm), radio name = visible words + " - owner" (starts with visible text, 2.5.3 ok), livery text colour gated by `contrastRatio >= 4.5` with fallback to default chip text, checked state carries a glyph (1.4.1), chips py-1 text-xs clear 24px.

Recurring gaps to grep for next time:
- A builder computes a `loading` flag per group and the component never renders it. Pre-fill that flips from "Leave for later" to a team after async evidence is a silent change of checked radio. Give the radiogroup `aria-busy` or announce.
- A `role="status"` count nested inside a `count > 0 &&` conditional never announces the move to 0 and its first appearance is unreliable. Keep the status element mounted outside the conditional.
- Dialog opens with autofocus on the primary button while the dialog's whole purpose is questions above it (teamsOnly mode). Fix without moving focus: `aria-describedby` on the button pointing at the section heading id.
- Retiring a control (filter chip, "Fix them one at a time") without touching `.maestro` flows that assert its text/aria-label: hand to maestro-e2e-author.
- Owner names `truncate` with only a `title` (mouse-only) - full name reachable only via the radiogroup name.
