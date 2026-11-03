/**
 * NEO-415 — whether this deployment is wired to eBay, and which eBay.
 *
 * Read from Convex env on every call (cheap; env can change without a
 * deploy). Convex holds no eBay client secret: the browser service holds it
 * and does every token exchange (`/oauth/ebay/connect`, `/oauth/ebay/refresh`).
 * Convex needs only what builds the consent URL and picks the API hosts:
 *
 *   EBAY_CLIENT_ID    the app's client id (public: it rides in the consent URL)
 *   EBAY_RU_NAME      the RuName eBay redirects consent to (public, ditto)
 *   EBAY_ENVIRONMENT  "sandbox" | "production"
 *
 * Any of the three unset (or an unknown environment) means eBay is NOT
 * configured: Connect is refused, and the drain and the order poll skip eBay
 * without error (`ebayConfig()` null). Safe to import from any runtime.
 */

export type EbayEnvironment = "sandbox" | "production";

export interface EbayConfig {
  clientId: string;
  ruName: string;
  environment: EbayEnvironment;
  /** REST API host, e.g. `https://api.ebay.com`. */
  apiBase: string;
  /** Media API host (`apim.`), `createImageFromFile` lives there. */
  mediaBase: string;
  /** Consent (authorize) page host. */
  authBase: string;
  /** Seller-facing web host, for links the web builds. */
  webBase: string;
}

/**
 * The scopes NB asks for at consent. Must equal the browser service's list
 * exactly (it refreshes with the scopes the consent granted).
 * https://developer.ebay.com/api-docs/static/oauth-scopes.html
 */
export const EBAY_SCOPES: readonly string[] = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
];

function envValue(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The deployment's eBay wiring, or null when it is not configured. */
export function ebayConfig(): EbayConfig | null {
  const clientId = envValue("EBAY_CLIENT_ID");
  const ruName = envValue("EBAY_RU_NAME");
  const environment = envValue("EBAY_ENVIRONMENT");
  if (!clientId || !ruName) return null;
  if (environment !== "sandbox" && environment !== "production") return null;
  const sandbox = environment === "sandbox";
  return {
    clientId,
    ruName,
    environment,
    apiBase: sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com",
    mediaBase: sandbox ? "https://apim.sandbox.ebay.com" : "https://apim.ebay.com",
    authBase: sandbox ? "https://auth.sandbox.ebay.com" : "https://auth.ebay.com",
    webBase: sandbox ? "https://www.sandbox.ebay.com" : "https://www.ebay.com",
  };
}

/**
 * eBay's sandbox has no picture upload. The Media API reference says it
 * under Input on both upload methods, createImageFromFile and
 * createImageFromUrl: "This method is not supported in Sandbox environment."
 * (https://developer.ebay.com/develop/api/sell/media_api). Every well-formed
 * upload there answers 500 / errorId 190000, so a drain that tried would
 * never list a card.
 *
 * On the sandbox the eBay drain therefore uploads nothing and sends each
 * item with NB's fixed sandbox test picture instead
 * (`EBAY_SANDBOX_TEST_PICTURE_URL`). NB's own rule does not move: a card
 * whose copy has no photo is still held back (`noPhoto`) on both
 * environments; only the hand-off of that photo to eBay is skipped.
 * Production always uploads. Read in one place, the drain's photos step
 * (`listingDrainEbay`).
 */
export function ebayHasPictureUpload(config: EbayConfig): boolean {
  return config.environment !== "sandbox";
}

/**
 * The one picture every item carries on eBay's SANDBOX, never production.
 * The sandbox has no picture upload (above), yet its Inventory API refuses
 * an item with no picture: `bulkCreateOrReplaceInventoryItem` answers
 * errorId 25717 "imageUrls cannot be null or empty." eBay's Inventory spec
 * lets `product.imageUrls` be self-hosted by the seller (HTTPS), so the
 * sandbox items point at this public NB-hosted image. It is a fictional
 * test card, never real NB data: nothing stores it as a card's picture
 * (the link's `images` stay empty) and it plays no part in the item's
 * content fingerprint. Production never reads it; it uploads the copy's
 * own photos. Read only where `ebayHasPictureUpload` is false.
 */
export const EBAY_SANDBOX_TEST_PICTURE_URL = "https://www.neonbinder.io/placeholder-fixtures/01-vorkle-front.jpg";

/** True when the deployment is wired to eBay. */
export function ebayConfigured(): boolean {
  return ebayConfig() !== null;
}

/**
 * eBay's consent URL for one Connect press. `state` is the server-minted
 * nonce `ebayConnect.completeConnect` checks. Shape per eBay's
 * authorization-code grant guide:
 * https://developer.ebay.com/api-docs/static/oauth-consent-request.html
 */
export function ebayAuthorizeUrl(config: EbayConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.ruName,
    response_type: "code",
    scope: EBAY_SCOPES.join(" "),
    state,
  });
  return `${config.authBase}/oauth2/authorize?${params.toString()}`;
}

/**
 * Seller conflicts (one NB owner per eBay account) are enforced everywhere
 * except a TESTING deployment on the eBay sandbox: the sandbox's identity
 * call can answer the same mock user for every sandbox seller, so there two
 * suite accounts would lock each other out for no real reason. Production
 * always enforces.
 */
export function ebaySellerConflictsEnforced(): boolean {
  const config = ebayConfig();
  if (config?.environment === "sandbox" && process.env.TESTING_RESET_SECRET) return false;
  return true;
}
