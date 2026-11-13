---
name: reference-no-nb-account-deletion-sweep
description: apps/web has NO NeonBinder account-deletion sweep or Clerk user.deleted webhook; the only "account deletion" code is eBay's marketplace notice — a per-user scrub is an internal mutation the operator runs
metadata:
  type: reference
---

As of NEO-496 (2026-11-12) there is no NB account-deletion path: no Clerk `user.deleted`
webhook, no "delete everything for userId" sweep. The privacy page says account deletion
is by email request, so it is manual. Grepping "account deletion" only finds
`ebayConnect.processAccountDeletion` (eBay's MARKETPLACE_ACCOUNT_DELETION notice), which
removes eBay data, not the NB account.

**How to apply:** when asked to "hook into the account-deletion sweep", say it doesn't
exist and build a bounded, self-chaining `internalMutation({ userId })` the operator runs
with `npx convex run` (pattern: `publishedChecklists.forgetUploader` — index on the user
field, `.take(N)` per table, patch to a sentinel such as `"deleted-user"` so the required
field and validators stay valid, reschedule when a page is full). Pin it as internal in
`publicFunctionAuth.test.ts`. If a real sweep is ever built, it should call these.
