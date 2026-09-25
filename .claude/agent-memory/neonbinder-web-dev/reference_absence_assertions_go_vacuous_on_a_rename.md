---
name: absence-assertions-go-vacuous-on-a-rename
description: After renaming a label or changing a copy helper, `queryByRole(..., {name}).toBeNull()` and `/^Old/` absence checks still pass while testing nothing — grep them, and change the helper's SIGNATURE so root tsc flags every stale call
metadata:
  type: reference
---

An absence assertion keyed on a name (`queryByRole("button", { name: X })
).toBeNull()`, `name: /^Fill\b/`) passes forever once X is no longer a name
anything renders. On NEO-306 two kinds went vacuous in one pass:

- a label change ("Fill 3 missing teams" → "3 cards need a team") left
  `/^Fill\b/` absence pins green while asserting nothing;
- an aria-label builder that gained a parameter (`setPicker(name)` →
  `setPicker(text, name)`, for SC 2.5.3) left two `queryByRole(...,
  { name: setPicker("Gold") }).toBeNull()` calls building a name no element
  could have. vitest stayed green; only root `tsc -p .` ("Expected 2
  arguments") caught them.

**How to apply:** when a visible label or an aria-label builder changes,
grep the test files for every absence check on the old form and rewrite it
against the new one. Prefer changing a builder's signature over keeping it
compatible, so the stale calls become type errors — then grep the root tsc
run for your `.tsx` test files (convex tsconfig never sees them; see
[[reference_apps_web_root_tsc_is_red_at_baseline]]). For names that start
with changing visible text, look controls up by the stable suffix with a
regex (`/: set Gold belongs to$/`).
