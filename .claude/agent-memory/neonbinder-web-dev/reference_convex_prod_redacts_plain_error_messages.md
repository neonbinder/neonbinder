---
name: convex-prod-redacts-plain-error-messages
description: A plain `throw new Error(...)` reaches a prod client as "Server Error", so a client can never branch on its text; throw a coded ConvexError from a pure convex/lib module both sides import (NEO-529 BATCH_NOT_COLLECTING)
metadata:
  type: reference
---

Convex redacts the message of any non-`ConvexError` thrown from a function in a
production deployment; the client sees only "Server Error". Dev and preview show
the full text, so a client that string-matches a server refusal passes every
local check and silently loses the branch in prod.

**Pattern that shipped (NEO-529):** a pure `convex/lib/<domain>Refusals.ts`
exporting the code, a factory returning `new ConvexError({ code, ...,
message })`, and an `is<Code>(error)` that reads `error.data.code` (duck-typed,
not `instanceof`, so a second `convex` copy or a test double still matches).
Keep a `message` field in the data: `ConvexError`'s own message is the
stringified data, so existing `rejects.toThrow(/old text/)` tests stay green.
The data survives `ctx.runMutation` into the calling action and out to the
client; convex-test reproduces that, so pin it with one test through the
public action, not only the internal mutation.

**Why:** the first cut read the reactive job status from a ref after the
`await` instead. The coordinator rejected it as a leftover gap: an action's
failure can resolve before the query update lands (see
[[reference-convex-mutation-resolves-after-queries-reflect-it]]), so the cause
went unnamed exactly when it mattered.

**How to apply:** when a page must say WHY the server refused, change the
server to a coded ConvexError even if the brief only lists client files: ask
rather than working around it. Sibling component tests that mocked the refusal
with a plain Error then need the coded one; grep for them and report.
