---
name: one-big-spec-many-screens-axe-gap
description: A single narrative E2E for a multi-view feature (shelf, containers, trade, wants, sale view) tends to open some views only to read a spine name and skip axe on the rest
metadata:
  type: feedback
---

When a PR adds several views behind one tab (shelf, binder, box, Want List, Up for Trade, a derived "for sale" view, label editor) and ships ONE spec, map each view to an `expectAccessible` call and a heading assert. Spine/button names asserted on the shelf prove the count, not that the view opens or is accessible.

**Why:** NEO-359 spec opened binder, box and delete-confirm with axe, but Want List was opened without axe and Up for Trade, the sale view and the label editor were never opened.

**How to apply:** list the views from the openView/route code, tick each against the spec, and also check that an open form/panel (not just its closed result) gets the axe call. Also check the public demo spec when the demo store is rewritten underneath it: demo tours are often shallow.
