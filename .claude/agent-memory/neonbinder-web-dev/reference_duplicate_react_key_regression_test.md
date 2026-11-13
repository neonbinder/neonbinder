---
name: duplicate-react-key-regression-test
description: How to pin a React duplicate-key fix in a happy-dom component test — spy console.error and assert no call mentions "same key"; verified to go red when the key loses its distinguishing part
metadata:
  type: reference
---

React reports colliding sibling keys only through `console.error`
("Encountered two children with the same key"); the DOM still renders both
rows, so a text assertion alone passes with the bug in place.

Pin the fix with:

```ts
const errors = vi.spyOn(console, "error").mockImplementation(() => {});
// render the list that used to collide
expect(errors.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
errors.mockRestore();
```

Verified on NEO-496 (skipped lines keyed by line+page collided across a
workbook's sheets): dropping `sheet` from the key turned the test red.

**How to apply:** whenever a list key gains a part to stop a collision (sheet,
page, source), add this spy beside the visible-text assertion and confirm it
goes red with the old key. Restore the spy in the test so a later test's real
console output is not swallowed. Related: [[sibling-keyed-on-the-same-row-id]].
