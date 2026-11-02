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
