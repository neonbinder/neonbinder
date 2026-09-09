---
name: reference_field_marker_class_is_two_classes_and_mangles_camelcase
description: An apps/web Input carries TWO mb-field-* classes (the primitive's own plus the caller's fieldClass key), and useFieldTestClass mangles a camelCase key — "cardNumber" becomes "card-umber" — so a test or flow deriving the marker base from the wrong one silently finds nothing.
metadata:
  type: reference
---

Two surprises in `src/hooks/useFieldTestClass.ts` + `components/primitives/Input.tsx`,
both of which make a marker-class assertion fail with a bare `null`:

1. **A rendered `<Input>` has two `mb-field-*` classes.** The primitive calls
   the hook itself, so it always emits a bare `mb-field-<its own useId>`; the
   caller's `fieldClass("key")` is appended separately. So
   `className.split(/\s+/).find(c => c.startsWith("mb-field-"))` gets the
   PRIMITIVE's class, whose `useId` base differs from every keyed sibling's.
   Match on the shape you want instead: `/^mb-field-.+-<key>$/`.

2. **The key sanitizer eats the capital in a camelCase key.** It is
   `key.replace(/[^a-z0-9]+/g, "-")` — lowercase-only character class — so
   `fieldClass("cardNumber")` renders `mb-field-r0-card-umber`, not
   `-cardnumber`. `players` / `team` / `cardName` → `card-ame` are affected the
   same way. The classes are stable and Maestro works fine with them, so this
   is not worth "fixing" (it would change live selectors) — just do not predict
   the string.

**How to apply:** writing a component test or reading a `.maestro` flow that
targets one of these markers, derive the base from a single-lowercase-word key
(`players` is the safe one in the quick-add form) and regex-match the suffix.
Cost me one red test on NEO-208, where the quick-add Team field's marker moved
onto a `<div>` wrapper around `TeamPicker` and the assertion looked for
`-cardnumber`.
