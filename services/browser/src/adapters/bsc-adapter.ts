import { Page } from "puppeteer";
import crypto from "node:crypto";
import { BaseAdapter, AdapterResponse } from "./base-adapter";
import { SecretsManagerService } from "../services/secrets-manager";
import {
  buildLoginDiagnostic,
  LoginDiagnostic,
  DiagnosticSecrets,
} from "../services/login-diagnostic";

interface BscSellerProfile {
  // Confirmed live from /marketplace/user/profile: `sellerId` is the
  // canonical field. Other identifiers in the response (userId, sellerEmailId,
  // sellerStoreName) serve different purposes and are NOT what
  // /search/seller/results expects in its `sellerId` body field.
  sellerId?: string;
  sellerStoreName?: string;
}

interface BscProfileResponse {
  sellerProfile?: BscSellerProfile;
}

// --- Azure AD B2C custom-policy sign-in configuration -----------------------
//
// BSC authenticates through an Azure AD B2C tenant
// (identity.buysportscards.com) using a CUSTOM policy (B2C_1A_signin). The SPA
// runs MSAL.js, which performs an OAuth2 auth-code-+-PKCE flow against the B2C
// authorize/token endpoints and writes the resulting Bearer access token into
// www.buysportscards.com localStorage.
//
// Because the BSC sign-in custom policy presents NO CAPTCHA/JS challenge (the
// old Puppeteer login just filled #signInName/#password and clicked Next), the
// entire flow is reproducible over plain fetch — no Chromium required. These
// constants are extracted from the BSC SPA bundle (main.*.js) and the B2C
// OIDC metadata document; they are PUBLIC client configuration, not secrets.
const BSC_B2C = {
  clientId: "9b4d7d82-6b2b-4c9e-9542-d94ee43bcac1",
  authority:
    "https://identity.buysportscards.com/identity.buysportscards.com/b2c_1a_signin",
  policy: "B2C_1A_signin",
  redirectUri: "https://www.buysportscards.com/",
  // openid+profile get the id_token; the api/read scope is the resource the
  // Bearer access token is minted for (the one used against api-prod). The SPA
  // does not request offline_access for the marketplace token, so we don't
  // either — we re-login on expiry rather than refresh.
  scope: "openid profile https://buysportscards.onmicrosoft.com/api/read",
} as const;

const BSC_AUTHORIZE_URL = `${BSC_B2C.authority}/oauth2/v2.0/authorize`;
const BSC_TOKEN_URL = `${BSC_B2C.authority}/oauth2/v2.0/token`;
const BSC_SELF_ASSERTED_URL = `${BSC_B2C.authority}/SelfAsserted`;

// A desktop UA so B2C serves the standard self-asserted HTML page.
const BSC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// BSC marketplace tokens are 1h-lived (token_endpoint expires_in=3600). Cache
// with a small safety margin so we re-login before the token is actually dead.
const TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Minimal in-flight cookie jar for the B2C sign-in exchange.
 *
 * B2C threads its anti-forgery state through `x-ms-cpim-*` cookies that are
 * set on the /authorize response and must be echoed back on the /SelfAsserted
 * POST and /confirmed GET. node's fetch does not persist cookies across calls,
 * so we collect Set-Cookie ourselves. Host/path/expiry are intentionally
 * ignored: the jar lives only for the duration of one login() and only ever
 * talks to the single B2C host.
 *
 * SECURITY: cookie VALUES are anti-forgery tokens. They are never logged; only
 * cookie NAMES may be logged for debugging.
 */
class B2CCookieJar {
  private cookies = new Map<string, string>();

  ingest(response: Response): void {
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const sc of setCookies) {
      const nameValue = sc.split(";")[0];
      const eq = nameValue.indexOf("=");
      if (eq > 0) {
        this.cookies.set(
          nameValue.slice(0, eq).trim(),
          nameValue.slice(eq + 1).trim(),
        );
      }
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** base64url-encode a Buffer (no padding) for PKCE/state/nonce values. */
function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The subset of the B2C self-asserted page's embedded `SETTINGS` blob we use:
 * the anti-forgery `csrf` token, the transaction id `transId`, and the policy
 * api name (`api`, e.g. "SelfAsserted") that forms the /confirmed path.
 */
interface B2CSettings {
  csrf?: string;
  transId?: string;
  api?: string;
}

export class BSCAdapter extends BaseAdapter {
  constructor(page?: Page) {
    super(page, "BuySportsCards (BSC)");
  }

  getHomeUrl(): string {
    return "https://www.buysportscards.com";
  }

  /**
   * Fetch the authenticated BSC user's marketplace profile. Used both to
   * validate cached tokens and to capture the user's sellerId at login.
   * Returns null on any non-OK response so callers can choose between
   * re-authentication and graceful degradation.
   */
  private async fetchSellerProfile(token: string): Promise<{ storeName?: string; sellerId?: string } | null> {
    const response = await fetch("https://api-prod.buysportscards.com/marketplace/user/profile", {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const profile = (await response.json()) as BscProfileResponse;
    const sellerProfile = profile?.sellerProfile;
    if (!sellerProfile) {
      console.warn(`[BSC Adapter] /marketplace/user/profile returned no sellerProfile. Top-level keys:`, Object.keys(profile ?? {}));
      return {};
    }
    return {
      storeName: sellerProfile.sellerStoreName,
      sellerId: sellerProfile.sellerId,
    };
  }

  /**
   * Browser-free Azure AD B2C sign-in over fetch.
   *
   * Replays the same OAuth2 auth-code-+-PKCE exchange the BSC SPA's MSAL.js
   * performs, but with no Chromium:
   *   1. GET  /authorize        → self-asserted HTML + SETTINGS{csrf,transId,api}
   *                               + x-ms-cpim-* anti-forgery cookies
   *   2. POST /SelfAsserted      → submit signInName/password; B2C replies
   *                               {"status":"200"} on accept, {"status":"400"}
   *                               on rejection (still HTTP 200)
   *   3. GET  /api/<api>/confirmed → 302 to redirectUri#code=...
   *   4. POST /token             → exchange code (+ PKCE verifier) for the
   *                               Bearer access_token
   *
   * Returns the bare access token (no "Bearer " prefix) to match the storage
   * convention the rest of the system relies on, or a structured failure with
   * a sanitized diagnostic. NEVER calls launchPage(), so this.browser stays
   * undefined and cleanup() remains a no-op — no Chromium process to leak.
   *
   * SECURITY: the email, password, anti-forgery cookies, csrf token, auth
   * code, and access token are NEVER logged or placed in returned error
   * strings. On failure we build a sanitized diagnostic via
   * buildLoginDiagnostic, which redacts the typed credentials and any
   * token/cookie-shaped material from the captured B2C response text.
   */
  private async httpLogin(
    email: string,
    password: string,
  ): Promise<{ token: string } | { error: string; diagnostic?: LoginDiagnostic }> {
    const secrets: DiagnosticSecrets = { email, password };
    const jar = new B2CCookieJar();

    // PKCE + anti-replay parameters. The verifier never leaves this process;
    // only its S256 challenge is sent on /authorize.
    const codeVerifier = base64Url(crypto.randomBytes(32));
    const codeChallenge = base64Url(
      crypto.createHash("sha256").update(codeVerifier).digest(),
    );
    const state = base64Url(crypto.randomBytes(16));
    const nonce = base64Url(crypto.randomBytes(16));

    // --- Step 1: GET /authorize -------------------------------------------
    const authorizeUrl = new URL(BSC_AUTHORIZE_URL);
    authorizeUrl.search = new URLSearchParams({
      client_id: BSC_B2C.clientId,
      redirect_uri: BSC_B2C.redirectUri,
      response_type: "code",
      scope: BSC_B2C.scope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
      response_mode: "fragment",
      prompt: "select_account",
    }).toString();

    console.log(`[BSC Adapter] B2C step 1: GET /authorize`);
    const authorizeResponse = await fetch(authorizeUrl, {
      headers: { "User-Agent": BSC_UA },
      redirect: "manual",
    });
    jar.ingest(authorizeResponse);
    const authorizeHtml = await authorizeResponse.text();

    const settings = this.parseB2CSettings(authorizeHtml);
    if (!settings?.csrf || !settings.transId || !settings.api) {
      // No self-asserted form — B2C served a redirect, an error, or an
      // unexpected (possibly JS-gated) page. Capture sanitized context.
      console.warn(
        `[BSC Adapter] B2C /authorize did not yield a sign-in form (status=${authorizeResponse.status}).`,
      );
      const diagnostic = buildLoginDiagnostic(
        { url: BSC_AUTHORIZE_URL, rawText: this.stripTags(authorizeHtml) },
        secrets,
      );
      return { error: `Authentication failed`, diagnostic };
    }

    // --- Step 2: POST /SelfAsserted ---------------------------------------
    const selfAssertedUrl = new URL(BSC_SELF_ASSERTED_URL);
    selfAssertedUrl.search = new URLSearchParams({
      tx: settings.transId,
      p: BSC_B2C.policy,
    }).toString();

    console.log(`[BSC Adapter] B2C step 2: POST /SelfAsserted`);
    const selfAssertedResponse = await fetch(selfAssertedUrl, {
      method: "POST",
      headers: {
        "User-Agent": BSC_UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRF-TOKEN": settings.csrf,
        "X-Requested-With": "XMLHttpRequest",
        "Cookie": jar.header(),
        "Referer": authorizeUrl.toString(),
      },
      body: new URLSearchParams({
        request_type: "RESPONSE",
        signInName: email,
        password,
      }).toString(),
      redirect: "manual",
    });
    jar.ingest(selfAssertedResponse);
    const selfAssertedBody = await selfAssertedResponse.text();

    // B2C answers SelfAsserted with a small JSON {"status":"200"} on success
    // or {"status":"400","message":"<reason>"} on rejection — both as HTTP
    // 200. The `message` can echo the typed identifier, so it is NEVER
    // returned raw; it only feeds the sanitized diagnostic.
    let selfAssertedStatus: string | undefined;
    try {
      selfAssertedStatus = (JSON.parse(selfAssertedBody) as { status?: string }).status;
    } catch {
      selfAssertedStatus = undefined;
    }
    if (selfAssertedStatus !== "200") {
      console.warn(
        `[BSC Adapter] B2C SelfAsserted rejected credentials (status field=${selfAssertedStatus ?? "(unparseable)"}).`,
      );
      const diagnostic = buildLoginDiagnostic(
        { url: BSC_SELF_ASSERTED_URL, rawText: selfAssertedBody },
        secrets,
      );
      return { error: `Authentication failed`, diagnostic };
    }

    // --- Step 3: GET /api/<api>/confirmed → 302 with #code= ----------------
    const confirmedUrl = new URL(`${BSC_B2C.authority}/api/${settings.api}/confirmed`);
    confirmedUrl.search = new URLSearchParams({
      rememberMe: "false",
      csrf_token: settings.csrf,
      tx: settings.transId,
      p: BSC_B2C.policy,
    }).toString();

    console.log(`[BSC Adapter] B2C step 3: GET /api/${settings.api}/confirmed`);
    const confirmedResponse = await fetch(confirmedUrl, {
      headers: {
        "User-Agent": BSC_UA,
        "Cookie": jar.header(),
        "Referer": authorizeUrl.toString(),
      },
      redirect: "manual",
    });
    jar.ingest(confirmedResponse);

    const code = this.extractAuthCode(confirmedResponse.headers.get("location"));
    if (!code) {
      console.warn(
        `[BSC Adapter] B2C /confirmed did not return an auth code (status=${confirmedResponse.status}).`,
      );
      // No page body to mine here; emit a body-less diagnostic so the caller
      // still gets challengeDetected=false + the endpoint url.
      const diagnostic = buildLoginDiagnostic({ url: confirmedUrl.origin + confirmedUrl.pathname }, secrets);
      return { error: `Authentication failed`, diagnostic };
    }

    // --- Step 4: POST /token (code + PKCE verifier) ------------------------
    console.log(`[BSC Adapter] B2C step 4: POST /token`);
    const tokenResponse = await fetch(BSC_TOKEN_URL, {
      method: "POST",
      headers: {
        "User-Agent": BSC_UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: BSC_B2C.clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: BSC_B2C.redirectUri,
        code_verifier: codeVerifier,
        scope: BSC_B2C.scope,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      // The token endpoint returns JSON {error, error_description} on failure.
      // error_description can contain trace ids but not the user's secret;
      // still, never return it raw — log the error code only.
      let tokenError = "(unparseable)";
      try {
        tokenError = ((await tokenResponse.json()) as { error?: string }).error ?? "(none)";
      } catch {
        /* ignore */
      }
      console.warn(
        `[BSC Adapter] B2C token exchange failed (status=${tokenResponse.status}, error=${tokenError}).`,
      );
      return { error: `Authentication failed` };
    }

    const tokenJson = (await tokenResponse.json()) as { access_token?: string };
    const token = tokenJson.access_token;
    if (!token) {
      console.warn(`[BSC Adapter] B2C token response had no access_token.`);
      return { error: `Authentication failed` };
    }

    console.log(`[BSC Adapter] B2C sign-in complete; access token acquired.`);
    return { token };
  }

  /**
   * Parse the `SETTINGS` JSON blob the B2C self-asserted page embeds inline.
   * Returns undefined if the blob is absent (e.g. B2C served a redirect or an
   * unexpected page). Only the csrf/transId/api fields are read; the raw HTML
   * is never logged.
   */
  private parseB2CSettings(html: string): B2CSettings | undefined {
    const match =
      html.match(/var SETTINGS\s*=\s*(\{.*?\});/s) ||
      html.match(/SETTINGS\s*=\s*(\{.*?\});/s);
    if (!match) return undefined;
    try {
      const parsed = JSON.parse(match[1]) as {
        csrf?: string;
        transId?: string;
        api?: string;
      };
      return { csrf: parsed.csrf, transId: parsed.transId, api: parsed.api };
    } catch {
      return undefined;
    }
  }

  /**
   * Extract the OAuth authorization `code` from the /confirmed redirect
   * Location, which carries it in the URL fragment (response_mode=fragment)
   * or query. Returns undefined if absent or if an `error` is present.
   */
  private extractAuthCode(location: string | null): string | undefined {
    if (!location) return undefined;
    const hashIndex = location.indexOf("#");
    const queryIndex = location.indexOf("?");
    const splitIndex = hashIndex >= 0 ? hashIndex : queryIndex;
    if (splitIndex < 0) return undefined;
    const params = new URLSearchParams(location.slice(splitIndex + 1));
    if (params.get("error")) return undefined;
    return params.get("code") ?? undefined;
  }

  /**
   * Strip HTML tags to approximate visible text for the failure diagnostic.
   * buildLoginDiagnostic expects innerText-style input (not raw HTML) so that
   * inline <script> token material never reaches the snippet; this gives a
   * close-enough approximation for a fetch'd page where we have no DOM.
   *
   * Security note (CodeQL js/bad-tag-filter): the <script>/<style> block
   * removal must tolerate every well-known end-tag spelling, or inline token
   * material slips past the filter and into the diagnostic snippet. The end-tag
   * sub-pattern `<\/script[^>]*>` matches any chars up to the first '>', so it
   * accepts trailing whitespace/newlines and bogus attributes before the close
   * (`</script >`, `</script\n>`, `</script foo="bar">`) — the exact bypasses
   * js/bad-tag-filter flags. The `(?:<\/script[^>]*>|$)` alternation also drops
   * an unterminated block running to EOF (a truncated/maintenance page) rather
   * than leaving its body in the output. The trailing `<[^>]*>` sweep then
   * removes any remaining ordinary tags.
   */
  private stripTags(html: string): string {
    return html
      .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script[^>]*>|$)/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style[^>]*>|$)/gi, " ")
      .replace(/<[^>]*>/g, " ");
  }

  async login(key: string): Promise<AdapterResponse> {
    const secretsManager = new SecretsManagerService();
    const credentials = await secretsManager.getCredentials(key);

    // --- Cache-hit path: validate the stored token, never touch a browser --
    //
    // BSC stores the bare token (no "Bearer " prefix); fetchSellerProfile
    // prepends "Bearer " on the validation request. A still-valid cached token
    // short-circuits the whole B2C exchange.
    if (
      credentials.token &&
      credentials.expiresAt &&
      credentials.expiresAt > Date.now()
    ) {
      console.log(`[BSC Adapter] Validating cached token for ${this.siteName}...`);
      const profile = await this.fetchSellerProfile(credentials.token);
      if (profile) {
        // Log a 4-char prefix only — sellerId is a per-user BSC identifier
        // and full values in Cloud Logging would let log-readers correlate
        // Clerk users to BSC seller accounts.
        const sellerIdPrefix = profile.sellerId ? `${profile.sellerId.slice(0, 4)}…` : "(unknown)";
        console.log(`[BSC Adapter] Cached token valid. Store: ${profile.storeName} sellerId: ${sellerIdPrefix}`);
        return {
          success: true,
          message: `Used cached token for ${this.siteName}`,
          storeName: profile.storeName,
          sellerId: profile.sellerId,
          expiresAt: credentials.expiresAt,
        };
      }
      // Stale/revoked token. Clear it (username/password preserved) before
      // falling through to a fresh login so we don't re-validate a dead token
      // on the next call.
      console.log(`[BSC Adapter] Cached token is invalid, clearing and re-authenticating...`);
      await secretsManager.updateCredentials(key, {
        username: credentials.username,
        password: credentials.password,
        token: undefined,
        expiresAt: undefined,
      });
    }

    // --- Fresh-login path: browser-free Azure AD B2C exchange --------------
    console.log(`[BSC Adapter] Starting browser-free login for ${this.siteName}`);
    const { username: email, password } = credentials;
    if (!email || !password) {
      console.error(`[BSC Adapter] Missing credentials: email=${!!email}, password=${!!password}`);
      return {
        success: false,
        error: `Missing credentials for ${this.siteName}`,
      };
    }

    try {
      const result = await this.httpLogin(email, password);
      if ("error" in result) {
        return { success: false, error: result.error, diagnostic: result.diagnostic };
      }

      const token = result.token;
      const expiresAt = Date.now() + TOKEN_TTL_MS;

      // Persist the bare token + expiry exactly as before so the cache-hit
      // path and the Convex BSC API adapter (which prepends "Bearer ") work
      // unchanged.
      await secretsManager.updateCredentials(key, {
        ...credentials,
        token,
        expiresAt,
      });
      console.log(`[BSC Adapter] Stored token in Secret Manager for ${this.siteName}`);

      // Capture sellerId/storeName in the same response shape as the cached
      // path. Profile failure here is non-fatal — we already have a valid
      // token; the caller just won't get a sellerId this round.
      const profile = await this.fetchSellerProfile(token);
      if (profile) {
        const sellerIdPrefix = profile.sellerId ? `${profile.sellerId.slice(0, 4)}…` : "(unknown)";
        console.log(`[BSC Adapter] Fresh login profile. Store: ${profile.storeName} sellerId: ${sellerIdPrefix}`);
      } else {
        console.warn(`[BSC Adapter] Fresh login: /marketplace/user/profile returned non-OK; storeName + sellerId omitted.`);
      }

      return {
        success: true,
        message: `Successfully logged into ${this.siteName}`,
        expiresAt,
        storeName: profile?.storeName,
        sellerId: profile?.sellerId,
      };
    } catch (error) {
      // Network error or unexpected throw during the B2C exchange. The error
      // object can carry a request URL with B2C params but not the user's
      // secret; we still never return it raw — log name+message server-side,
      // return a generic message to the caller.
      console.error(
        `[BSC Adapter] Error during login process:`,
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      return {
        success: false,
        error: `Authentication failed`,
      };
    }
  }

  async getAvailableSetParameters(partialParams: {
    sport?: string;
    year?: number;
    manufacturer?: string;
    setName?: string;
    variantType?: "base" | "insert" | "parallel" | "parallel_of_insert";
    insertName?: string;
    parallelName?: string;
  }): Promise<{
    availableOptions: {
      sports?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
      years?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
      manufacturers?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
      setNames?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
      variantNames?: Array<{ site: string; values: Array<{ label: string; value: string }> }>;
    };
    currentParams: typeof partialParams;
  }> {
    try {
      console.log(`[BSC Adapter] Getting available set parameters with filters:`, partialParams);

      if (!this.page) {
        throw new Error('No Puppeteer page available for BSC scraping');
      }

      // Navigate to the BSC search page
      const searchUrl = "https://www.buysportscards.com/seller/bulk-upload/results";
      await this.page.goto(searchUrl, { waitUntil: "networkidle2" });

      // Wait for the page to load
      await this.page.waitForSelector('body', { timeout: 10000 });

      // Extract available options based on current filters
      const availableOptions: any = {};

      // For now, return mock data since the actual scraping logic would be complex
      // In a real implementation, you would:
      // 1. Check what filters are already applied
      // 2. Look for dropdown options or form fields
      // 3. Extract the available values
      // 4. Return them in the expected format

      if (!partialParams.sport) {
        // If no sport is selected, return available sports
        availableOptions.sports = [{
          site: "BSC",
          values: [
            { label: "Football", value: "football" },
            { label: "Baseball", value: "baseball" },
            { label: "Basketball", value: "basketball" },
            { label: "Hockey", value: "hockey" },
          ]
        }];
      } else if (!partialParams.year) {
        // If sport is selected but no year, return available years
        availableOptions.years = [{
          site: "BSC",
          values: [
            { label: "2024", value: "2024" },
            { label: "2023", value: "2023" },
            { label: "2022", value: "2022" },
            { label: "2021", value: "2021" },
          ]
        }];
      } else if (!partialParams.manufacturer) {
        // If sport and year are selected but no manufacturer, return available manufacturers
        availableOptions.manufacturers = [{
          site: "BSC",
          values: [
            { label: "Panini", value: "panini" },
            { label: "Topps", value: "topps" },
            { label: "Upper Deck", value: "upper-deck" },
            { label: "Donruss", value: "donruss" },
          ]
        }];
      } else if (!partialParams.setName) {
        // If sport, year, and manufacturer are selected but no set name, return available set names
        availableOptions.setNames = [{
          site: "BSC",
          values: [
            { label: "Donruss Elite", value: "donruss-elite" },
            { label: "Panini Prizm", value: "panini-prizm" },
            { label: "Topps Chrome", value: "topps-chrome" },
            { label: "Upper Deck Series 1", value: "upper-deck-series-1" },
          ]
        }];
      } else if (!partialParams.variantType) {
        // If all previous filters are selected but no variant type, return available variant types
        availableOptions.variantNames = [{
          site: "BSC",
          values: [
            { label: "Base", value: "base" },
            { label: "Insert", value: "insert" },
            { label: "Parallel", value: "parallel" },
          ]
        }];
      }

      return {
        availableOptions,
        currentParams: partialParams,
      };
    } catch (error) {
      console.error(`[BSC Adapter] Error getting available set parameters:`, error);
      throw error;
    }
  }
}
