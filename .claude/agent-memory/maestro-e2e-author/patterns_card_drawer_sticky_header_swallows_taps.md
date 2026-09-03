---
name: card-drawer-sticky-header-swallows-taps
description: In CardDetailPanel, assertVisible passes on a field sitting under the drawer's OWN sticky header and the tap is swallowed — pin to max scroll, then correct back down
metadata:
  type: reference
---

`CardDetailPanel` has a sticky header of its own (the "Card #<n> CUSTOM" bar,
**y 0–50**, inside the drawer — not the app's page header). A field scrolled
underneath it still reports real layout bounds, so **`assertVisible` passes and
the tap is swallowed by the header**: nothing is typed, the input keeps its
placeholder, and the flow dies several steps later on whatever the typing was
supposed to produce. Measured 2026-09-02, CI run 33700877240 runner 2: at max
scroll `id: "Card variation"` sits at `[546,8][978,42]`, tap centre y≈25.

`scrollUntilVisible` cannot help — the drawer is right-anchored (x≥544 at 1024)
so its viewport-centre swipe drives the BACKDROP (see
`variation-link-group-and-unlink.yaml`). Swipes at **x=80%** are inside it.

**The pattern that works — pin, then correct:**

```yaml
- swipe: { start: "80%, 80%", end: "80%, 20%" }   # x3: pin to MAX scroll
- swipe: { start: "80%, 30%", end: "80%, 55%", duration: 400 }   # back down ~157px
- extendedWaitUntil: { visible: { id: "Card variation" }, timeout: 7000 }
```

**Why it is deterministic:** at max scroll a field's y is fixed by the content
**below** it (Variation of / Players / Inherited from set / image placeholder —
constant height), never by the content above it, which grows when e.g.
Regenerate adds its source chips. So "pin to the end" is a stable anchor and one
measured correction lands the field in a safe band. Re-assert AFTER the
correction, not before.

Modal dialogs in this directory (`CardAttentionWalker`) do NOT have this trap —
their heading is a sibling above the scroll area, not over it. Their equivalent
risk is a body taller than `max-h-[70vh]`; guard it by asserting a control that
renders BELOW your target inside the same body.
