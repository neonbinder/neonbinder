---
name: entitycolumn-custom-form-replaces-list
description: "EntityColumn's Add-Custom-Entry form REPLACES the column list (not an overlay), and maestro-web reads the form input's text as its VALUE — so a `.*<value>.*` wait after Enter self-satisfies against the input and lets a flow tap the input instead of the new row. Always gate on notVisible: \"Add Custom Entry\"."
metadata:
  type: reference
---

`components/SetSelector/EntityColumn.tsx` renders the custom-entry form with
`if (mode === "custom") return customForm;` — it **replaces** the selector list
for that column. While the form is open, the row you just typed **does not
exist**; the only node carrying that text is the form's `<input>`, whose
maestro-web node text is its VALUE (see [[maestro-web-getnodetext]]).

Consequence for every Add-Custom drill step:

```yaml
- tapOn: { id: "Add custom <Level>" }
- extendedWaitUntil: { visible: "Add Custom Entry", timeout: 10000 }
- inputText: ${VALUE}
- pressKey: Enter
- extendedWaitUntil:                 # REQUIRED — the form is not an overlay
    notVisible: "Add Custom Entry"
    timeout: 10000
- extendedWaitUntil:                 # only NOW can this mean "the row exists"
    visible: { text: ".*${VALUE}.*" }
```

Omitting the `notVisible` gate does **not** fail loudly — the `.*${VALUE}.*`
wait passes instantly against the still-open input, and so do a following
`scrollUntilVisible`/`tapOn` on `text: ${VALUE}`. The flow then taps the input;
`addCustomOption` resolves, `setMode("idle")` unmounts the form and the reveal
effect's `scrollColumnIntoView` shifts the column, so the click dispatches into
dead space. Nothing is selected, the next column never mounts, and the failure
surfaces one step later as "the child column's header is not visible".

**Telling the two apart in maestro.log** — read the tapped element's BOUNDS, not
its text. The column is `min-w-[260px] max-w-[340px]` and the form has `p-6`, so
the custom-entry input is **292px wide** (340 − 48) and ~42px tall. A real list
row is ~210px (or a bare text node ~24px tall). A 292×42 tap on a column row is
always the input. (Found this way on PR #77 / run 30414180040, where level 5 of
`util-drill-to-custom.yaml` was the only one of nine Add-Custom blocks missing
the gate.)

Related: an assertion that "fails because the element is off-screen" is almost
never the real story — maestro-web's `visible` has no viewport test at all, see
[[maestro-web-driver-primitives]] §3a.
