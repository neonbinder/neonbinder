---
name: public-refusals-are-returns-or-convex-error
description: A user-facing refusal from a public Convex function must be an {ok:false, error} return or a ConvexError; a plain Error is redacted to "Server Error" in production, so the sentence never reaches the page
metadata:
  type: reference
---

`throw new Error("Disconnect eBay first…")` reads fine in dev and in
convex-test, and arrives in production as `[CONVEX M(...)] Server Error`.
Prefer widening `returns` to `v.union(okShape, v.object({ ok: v.literal(false),
error: v.string() }))`; the web page handles both that and a ConvexError.
Internal functions may still throw plain Errors (no user reads them).
