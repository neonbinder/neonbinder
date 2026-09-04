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

## 3. A control can be present in shape and dead in fact — check the wire shape

NEO-121 added `ensureWebhook`'s **reconcile-before-create** (list the seller's
EasyPost hooks, adopt ours, reap stale ones under our prefix, only then create).
The policy was written correctly and was **entirely dead**: the browser route
answers `{ webhooks: [...] }` while `postage.easypostListWebhooks` parsed only a
bare array, so `hooks` was always `[]`. Nothing adopted, nothing reaped, and a
lost create response would have produced a duplicate hook on the next attempt.

The unit tests did not catch it because they stubbed the *Convex-side* expected
shape rather than the shape the route actually returns — a stub is a claim about
a contract, and a wrong stub makes a dead control look tested.

**How to apply:** on any Convex ↔ browser-service boundary, read the route's
`res.json(...)` and the Convex parse **side by side**, and check the test stub
matches the route, not the parser. When a control's failure mode is silent
(a reconcile that finds nothing looks exactly like a clean account), require a
test that would fail if the parse regressed.

## 4. A rate-limit cooldown must be stamped on the ATTEMPT, not the success

`postage.refreshTracking`'s 60 s cooldown was stamped only through
`applyTrackerSnapshot`'s `refreshedAt` — i.e. only when EasyPost returned a
tracker. The ordinary state of a freshly-bought letter is `no_tracker` (the
browser route answers 409), which throws before any write, so the loop the
cooldown exists to stop was uncapped on the exact status a seller is most likely
to be clicking at. All `/easypost/*` calls share one 60/min bucket per seller
with `buy`, so the loop could 429 the seller's own money path.

**How to apply:** whenever a cooldown/quota is implemented by writing a
timestamp, check every early-return and throw between "decide to call out" and
the write. The stamp belongs immediately before the outbound call.

## 5. Things verified good on the NEO-121 surface (do not re-litigate)

- Webhook HMAC gate ordering: token charset regex → row lookup → size cap →
  HMAC → only then any write (`touchWebhookEvent` included). Constant-time
  compare, Web Crypto only (the httpAction is default-runtime, `node:crypto` is
  unreachable), integer-`weight` float rewrite anchored with a lookahead.
- `urlToken` and `secret` appear in **no** public validator; `lastError` is an
  NB-authored enum precisely because EasyPost echoes the rejected URL (which
  carries the token) — `redactWebhookToken` scrubs it in `describeError` *and*
  again in the router. Note nothing scrubs the HMAC *secret* from an upstream
  message; EasyPost does not echo it today.
- `REGISTERABLE_DEPLOYMENTS` fails closed and the dev slug `focused-fox-53` was
  **already** public in `.github/workflows/preview-cleanup.yml`; committing it
  in `convex/shipmentTracking.ts` discloses nothing new. What a dev slug reaches
  is the `/e2e/*` surface — see [[patterns-testing-endpoint-gate]].
- `getWebhookByToken` uses `.unique()` while `findPurchaseForWebhook`
  deliberately uses `.first()` (a throw inside the handler reads to EasyPost as
  a failed delivery and eventually disables the hook). With 256-bit tokens a
  duplicate can only be a bug, so `.unique()` is defensible — but if that table
  ever gains another writer, revisit.
