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

**But** that chain is only as strong as the writer of the row.
`shipping.recordLabelPurchase` was originally a *public* `mutation` — any
signed-in user could insert a `labelPurchases` row for themselves with any
`easypostShipmentId`, `labelUrl`, `costCents`, `toAddress` they liked, making
the "server-derived" shipment id caller-authored. Fixed on the NEO-213 branch:
it is now an `internalMutation` taking an explicit `userId` from
`buyLetterLabel`'s verified subject, so the row really is EasyPost-authored.

Second containment layer either way: the key used is always
`credKey("easypost", callerUserId)`, so EasyPost's per-account scoping also
bounds a foreign shipment id — but that layer weakens the moment a shared/child
EasyPost key exists, or the history table is used for money reporting.

**Why:** the record write must never be able to fail an already-paid purchase,
which is why it was split out of the action — but "separate function" does not
have to mean "public".
**How to apply:** keep `recordLabelPurchase` internal; flag any *new* consumer
that treats a `labelPurchases` field as trustworthy provenance (cost totals, an
id forwarded to another API), and any new public writer to the table.

## 2. `printHtmlDocument` does NOT escape `bodyHtml`

`lib/print/print-html.ts` has an `escapeHtml()` but applies it only to `title`.
`bodyHtml` is dropped verbatim into an **unsandboxed same-origin `srcdoc`
iframe** — a `"` in an interpolated URL breaks the attribute and an injected
`onerror=` runs in the app's origin. The postage call sites
(`app/print/shipping/page.tsx`, `app/print/labels/page.tsx`) originally built
`` `<img src="${labelUrl}" ...>` `` by hand; fixed on the NEO-213 branch with
the exported `imageBodyHtml()` helper (https-only scheme check +
attribute-escape), which both now use.

Only reachable via a hostile EasyPost/browser-service response (self-XSS at
worst), so it was defense-in-depth, not a live hole. **How to apply:** any new
`bodyHtml` built from a value that is not a literal must go through
`escapeHtml` or `imageBodyHtml`; a URL additionally needs the `https:` scheme
check before it reaches an attribute.

Related: [[patterns-convex-auth-boundary]], [[patterns-checklist-commit-trust-boundary]].
