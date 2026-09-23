---
name: reference-copy-that-names-a-button-goes-stale
description: A prose message naming a control by its label drifts silently when the label changes — verify any quoted button text against the render, including labels quoted by an audit or spec
metadata:
  type: reference
---

A user-facing sentence that quotes a control's words (`Press "X" again…`,
`use "X" again`) is a second copy of that label with nothing keeping it in
step. In `EntityReviewWizard.tsx` two such sentences, a doc comment block and
several `.maestro` comments all still said **"Add All Remaining as New"** /
**"Skip Remaining"** long after the footer began rendering **"Add remaining
players as new (N)"** / **"Skip remaining names (N)"** — so an operator was
told to press a button that is not on the screen.

**Why it bites here:** these two labels are also E2E surface. They carry no
`aria-label`, so the visible text IS the accessible name, and flows match
`text: ".*Add remaining players as new.*"`. Nothing in the gates compares a
sentence's quoted label against the button's.

**How to apply:**
- Before writing or reviewing copy that quotes a label, `grep` for the label
  in the component's JSX and read what it actually renders. A label quoted in
  a ticket, an audit finding or a doc comment is evidence of what it used to
  be, not what it is.
- When a message must name a control, hoist the visible text to a `const`
  beside the other `*_LABEL` constants in the file and have both the button
  and the sentence read it — that is the only thing that keeps them in step.
- Watch for the same trap in a *remedy* sentence naming a surface rather than
  a control: NEO-294's audit proposed "Rename this set in Set Details", and no
  screen called "Set Details" exists — the rename is a pencil in the
  `Set attributes panel` header, beside the set's name.

Related: [[reference_component_tests_hand_build_the_api_mock]],
[[maestro-presskey-needs-unique-id-on-target]].
