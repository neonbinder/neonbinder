import { httpRouter } from "convex/server";
import { exchangeMachineToken } from "./machineAuth";
import { servicePausedPlatforms } from "./marketplacePause";
import { handleEasypostWebhook } from "./shipmentTracking";

const http = httpRouter();

// ─── Machine auth (NEO-172) ──────────────────────────────────────────────────
// A headless client presents its Clerk API key and gets back a genuine Clerk
// session JWT minted from the `convex` template — so `ctx.auth` validation,
// `getCurrentUserId`, and every ownership check built on them are completely
// unchanged, and `identity.subject` is the real user.
//
// Imported as a plain ES module rather than reached through the generated `api`
// object, because `httpRouter` takes the action itself. Keeping the
// implementation out of this file matters: it is ~3 upstream calls with a
// careful error-shape contract, and this file is a route table.
http.route({
  path: "/machine/token",
  method: "POST",
  handler: exchangeMachineToken,
});

// ─── EasyPost tracker webhooks (NEO-121) ─────────────────────────────────────
// `POST /webhooks/easypost/<urlToken>` — USPS scan events for ONE seller.
//
// WHY THE TOKEN IS IN THE PATH AND THE SECRET IS PER SELLER: under NEO-120
// every seller has their own EasyPost account, so there is no single account
// whose events we could authenticate with one platform secret. Convex mints a
// random 32-byte URL token and a separate random 32-byte HMAC secret per
// seller; the token selects the row, and that row's secret verifies the body.
// So there is no shared secret to keep in sync across dev / preview / prod
// (NEO-178's recurring trap), and one seller's secret forges nothing for
// another. The token is a BEARER CREDENTIAL — it must never be logged, and it
// appears in no public validator (see convex/shipmentTracking.ts).
//
// `pathPrefix` rather than `path` because the token is part of the URL. Note
// that a prefix route also matches an EMPTY final segment, which is why the
// handler checks the token's charset and length BEFORE any database read.
//
// The handler is imported as a plain ES module (like `exchangeMachineToken`
// above) so this file stays a route table: the verification order in that
// handler is the security design and belongs next to the feature.
http.route({
  pathPrefix: "/webhooks/easypost/",
  method: "POST",
  handler: handleEasypostWebhook,
});

// ─── Marketplace pause, read by the browser service (NEO-355) ────────────────
// `GET /internal/marketplace-pause` → `{"paused": [...site keys]}` — the
// browser service asks before a scheduled login canary, so the one Convex
// switch (NEONBINDER_PAUSED_PLATFORMS) pauses the canary as well.
//
// WHY IDENTITY, NOT A SHARED SECRET: the caller presents a Google id token
// minted for its own runtime service account, and the handler checks issuer,
// audience (this deployment's site URL) and an allowlist of emails. That is
// the reverse of the Cloud Run IAM boundary Convex already relies on, and it
// leaves nothing to rotate or keep in step across deployments — NEO-20 removed
// the last shared key between the two sides and this must not bring one back.
//
// GET because it is a read with no side effects; every answer carries
// `cache-control: no-store` since the pause can flip at any moment. The
// handler lives beside the switch it reads (like the routes above), so this
// file stays a route table and `marketplacePause.ts` stays the only reader of
// the variable.
http.route({
  path: "/internal/marketplace-pause",
  method: "GET",
  handler: servicePausedPlatforms,
});

export default http;
