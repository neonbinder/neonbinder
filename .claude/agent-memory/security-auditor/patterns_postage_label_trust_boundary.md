---
name: patterns-postage-label-trust-boundary
description: EasyPost postage/label surface — where the ownership derivation is real, where a public mutation lets a caller author the "derived" id, and the unescaped print-document interpolation
metadata:
  type: project
---

# Postage / label reprint trust boundary (convex/postage.ts, convex/shipping.ts, services/browser easypost)

Two structural facts to re-check any time this surface changes.

## 1. "Derived server-side" is only as strong as the writer of the row

`postage.refreshLabelUrl` correctly takes a `v.id("labelPurchases")` and reads
`easypostShipmentId` off a row proved to be the caller's by the
`internalQuery` `shipping.getLabelPurchaseForUser`. That is the right shape.

**But** `shipping.recordLabelPurchase` is a *public* `mutation` — any signed-in
user can insert a `labelPurchases` row for themselves with any
`easypostShipmentId`, `labelUrl`, `costCents`, `toAddress` they like. So the id
the action forwards is caller-authored, not EasyPost-authored, and the code
comment claiming a caller "cannot aim this at a shipment they do not own" is
stronger than what the code guarantees.

Containment today is EasyPost's own per-API-key account scoping (the key used is
always `credKey("easypost", callerUserId)`), not Convex. Impact is low as long as
one EasyPost account == one seller; it stops being low the moment a shared/child
EasyPost key exists, or the history table is used for money reporting.

**Why:** the record write must never be able to fail an already-paid purchase,
which is why it was split out of the action — but "separate function" did not
have to mean "public".
**How to apply:** the fix is `internalMutation` + explicit `userId` arg from the
action. Flag any *new* consumer that treats a `labelPurchases` field as
trustworthy provenance (cost totals, an id forwarded to another API).

## 2. `printHtmlDocument` does NOT escape `bodyHtml`

`lib/print/print-html.ts` has an `escapeHtml()` but applies it only to `title`.
`bodyHtml` is dropped verbatim into an **unsandboxed same-origin `srcdoc`
iframe**. Both postage call sites build it as
`` `<img src="${labelUrl}" ...>` `` with no escaping
(`app/print/shipping/page.tsx`, `app/print/labels/page.tsx`) — a `"` in the URL
breaks the attribute and an injected `onerror=` runs in the app's origin.

Only reachable via a hostile EasyPost/browser-service response today (self-XSS at
worst), so it is defense-in-depth, not a live hole. **How to apply:** any new
`bodyHtml` built from a value that is not a literal must go through
`escapeHtml`, and a URL should additionally be scheme-checked (`https:` only)
before it reaches an attribute.

Related: [[patterns-convex-auth-boundary]], [[patterns-checklist-commit-trust-boundary]].
