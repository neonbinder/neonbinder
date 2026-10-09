---
name: heading-only-via-above-field-label
description: To assert a detail HEADING whose text is also an input's value (same name in the panel's name box, the add form's box), anchor `above:` the field's visible LABEL text — a top-edge test only the heading passes; leftOf/rightOf are left-edge tests and do not separate stacked nodes
metadata:
  type: reference
---

On an admin master–detail screen the record's name is on screen several ways:
the `<h3>`, the panel's name `<input>` (maestro reads an input by its value),
and, during a create, the add form's name box. A bare `assertVisible: "<name>"`
can pass on the wrong one, including the busy form BEFORE the panel exists.

Selector that matches the heading alone (NEO-319, green locally on three flows):

```yaml
- extendedWaitUntil:
    visible:
      text: "<name>"
      above:
        text: "Player name"   # the panel field's label <span>, full match
    timeout: 7000
```

Why it works: `Filters.above` is `it.bounds.y < other.bounds.y`, top edges only.
The heading sits above the label, the input below it, and the add form's label
reads "New player name" (a full match refuses it), so the anchor does not exist
until the panel mounts. No master row interferes while the filter holds a
nonsense string.

Do not reach for `leftOf:`/`rightOf:` to separate a heading from the box under
it: javap of `maestro/Filters` shows `leftOf` is `it.x < other.x`, left edges
only, so a box starting at the same column left edge passes too. (Extends
[[maestro-web-driver-primitives]] §5. `primitives/Input` has no resource-id, so
the label TEXT is the only usable anchor; see [[input-primitive-has-no-resource-id]].)

Also worth knowing: since NEO-319 a Create or Open on /admin/players reveals the
panel heading at ~y=160 with no flow scroll needed. Older flows still carry an
UP scroll to `Filter players` after Create; it still passes (one swipe to
scroll 0) but is no longer needed for positioning.
