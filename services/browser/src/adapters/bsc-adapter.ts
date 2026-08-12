import { Page } from "puppeteer";
import crypto from "node:crypto";
import {
  BaseAdapter,
  AdapterResponse,
  LoginOptions,
  REAUTH_REQUIRED_ERROR,
  isCanaryKey,
} from "./base-adapter";
import { Credentials, SecretsManagerService } from "../services/secrets-manager";
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
  // Bearer access token is minted for (the one used against api-prod).
  //
  // NEO-140: `offline_access` is listed for legibility of intent, NOT because
  // it is required. Probed live against BSC's B2C tenant on 2026-08-11: the
  // token endpoint already returns a `refresh_token` under the base scope
  // alone, with `refresh_token_expires_in: 86400`. (The comment that used to
  // sit here claimed the SPA does not request offline_access "so we don't
  // either — we re-login on expiry rather than refresh". Both halves were
  // wrong: we were being handed a refresh token on every login and throwing
  // it away, which is precisely why a user's password had to be kept on disk.)
  scope:
    "openid profile https://buysportscards.onmicrosoft.com/api/read offline_access",
} as const;

const BSC_AUTHORIZE_URL = `${BSC_B2C.authority}/oauth2/v2.0/authorize`;
const BSC_TOKEN_URL = `${BSC_B2C.authority}/oauth2/v2.0/token`;
const BSC_SELF_ASSERTED_URL = `${BSC_B2C.authority}/SelfAsserted`;

// A desktop UA so B2C serves the standard self-asserted HTML page.
const BSC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Fallback access-token lifetime, used ONLY when the token endpoint omits
// `expires_in`. BSC currently returns expires_in=3600, and we prefer the real
// value — a hardcoded TTL that outlives the actual token produces a "valid"
// cache entry that 401s, costing a wasted round trip on every call.
const TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * The fields we read off the B2C token endpoint, for both the
 * authorization_code and refresh_token grants.
 *
 * All observed live on 2026-08-11: expires_in=3600 (access token),
 * refresh_token_expires_in=86400 (refresh token), and the refresh grant
 * returning a NEW refresh_token each time.
 */
interface BscTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

/**
 * A normalized token set with absolute expiries, ready to persist.
 *
 * SECURITY: every field except the expiries is credential material. Instances
 * of this type must never be logged or returned to a caller.
 */
interface BscTokenSet {
  token: string;
  expiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
}

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
   * Returns a normalized {@link BscTokenSet} — the bare access token (no
   * "Bearer " prefix, matching the storage convention the rest of the system
   * relies on) plus the rotating refresh token — or a structured failure with
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
  ): Promise<
    | { tokens: BscTokenSet }
    | { error: string; diagnostic?: LoginDiagnostic; credentialRejected?: boolean }
  > {
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
      // NEO-98: this is the ONE branch in the whole B2C exchange where BSC
      // demonstrably evaluated the credentials and said no — it parsed as
      // B2C's own {"status":"<non-200>"} envelope. Every other failure below
      // (and above) is an integration fault and must stay pageable.
      //
      // Two carve-outs, both deliberate:
      //   - selfAssertedStatus === undefined means the body did NOT parse as
      //     the envelope at all. That is B2C returning something unexpected,
      //     not a rejection, so it does NOT count.
      //   - a challenge page means we were bot-blocked before the password
      //     was ever judged. Our problem, not the seller's.
      const credentialRejected =
        selfAssertedStatus !== undefined && diagnostic.challengeDetected !== true;
      return { error: `Authentication failed`, diagnostic, credentialRejected };
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

    const tokens = this.toTokenSet((await tokenResponse.json()) as BscTokenResponse);
    if (!tokens) {
      console.warn(`[BSC Adapter] B2C token response had no access_token.`);
      return { error: `Authentication failed` };
    }

    // Metadata only: a boolean and a duration. Never the token values.
    console.log(
      `[BSC Adapter] B2C sign-in complete; access token acquired ` +
        `(refresh_token_present=${!!tokens.refreshToken}).`,
    );
    return { tokens };
  }

  /**
   * Normalize a token-endpoint response into absolute expiries.
   *
   * Returns undefined when there is no access token — the caller treats that
   * as a failed exchange. A response with an access token but NO refresh token
   * is still valid: it just means the next expiry costs a full sign-in.
   *
   * SECURITY: reads values, logs none of them.
   */
  private toTokenSet(json: BscTokenResponse): BscTokenSet | undefined {
    if (typeof json.access_token !== "string" || json.access_token.length === 0) {
      return undefined;
    }
    const now = Date.now();
    const tokens: BscTokenSet = {
      token: json.access_token,
      // Prefer the lifetime B2C actually issued; TOKEN_TTL_MS is only a floor
      // for a response that omits it.
      expiresAt:
        typeof json.expires_in === "number" && json.expires_in > 0
          ? now + json.expires_in * 1000
          : now + TOKEN_TTL_MS,
    };
    if (typeof json.refresh_token === "string" && json.refresh_token.length > 0) {
      tokens.refreshToken = json.refresh_token;
      if (
        typeof json.refresh_token_expires_in === "number" &&
        json.refresh_token_expires_in > 0
      ) {
        tokens.refreshExpiresAt = now + json.refresh_token_expires_in * 1000;
      }
    }
    return tokens;
  }

  /**
   * Exchange a stored refresh token for a fresh access token — the NEO-141
   * replacement for "keep the user's password and re-login".
   *
   * The grant body is exactly what BSC's public B2C client accepts: client_id,
   * grant_type, refresh_token, scope. No client secret (public client), no
   * PKCE verifier (that belongs to the auth-code grant only).
   *
   * THE RESPONSE ROTATES THE REFRESH TOKEN. B2C returns a new refresh_token
   * and invalidates the one presented, so the caller MUST durably persist the
   * new one before relying on the new access token — see login().
   *
   * @returns the new token set, or a failure that says whether it is the
   *   user's problem (`reauthRequired`: the grant was refused, so the chain is
   *   broken and only a fresh sign-in can fix it) or ours (an unreachable or
   *   misbehaving token endpoint, which must stay pageable).
   *
   * SECURITY: neither the presented nor the returned refresh token is ever
   * logged; only the HTTP status and B2C's short `error` code.
   */
  private async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ tokens: BscTokenSet } | { error: string; reauthRequired: boolean }> {
    console.log(`[BSC Adapter] B2C refresh grant: POST /token`);
    const response = await fetch(BSC_TOKEN_URL, {
      method: "POST",
      headers: {
        "User-Agent": BSC_UA,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: BSC_B2C.clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: BSC_B2C.scope,
      }).toString(),
    });

    if (!response.ok) {
      let errorCode = "(unparseable)";
      try {
        errorCode = ((await response.json()) as { error?: string }).error ?? "(none)";
      } catch {
        /* ignore — never surface the raw body */
      }
      // A 4xx here is B2C saying the grant itself is no good: expired,
      // revoked, already-rotated, or issued to a different client. Nothing we
      // can retry our way out of — the user must sign in again.
      //
      // A 5xx / anything else is BSC being unwell. That must NOT be reported
      // as reauth_required, or a BSC outage would present to every user as
      // "your session expired, sign in again" and never page anyone.
      const reauthRequired = response.status >= 400 && response.status < 500;
      console.warn(
        `[BSC Adapter] B2C refresh grant failed (status=${response.status}, ` +
          `error=${errorCode}, reauth_required=${reauthRequired}).`,
      );
      return {
        error: reauthRequired ? REAUTH_REQUIRED_ERROR : `Authentication failed`,
        reauthRequired,
      };
    }

    const tokens = this.toTokenSet((await response.json()) as BscTokenResponse);
    if (!tokens) {
      console.warn(`[BSC Adapter] B2C refresh grant returned no access_token.`);
      return { error: `Authentication failed`, reauthRequired: false };
    }
    console.log(
      `[BSC Adapter] B2C refresh grant succeeded ` +
        `(rotated_refresh_token=${!!tokens.refreshToken}).`,
    );
    return { tokens };
  }

  /**
   * Write a token set to Secret Manager as the COMPLETE user payload.
   *
   * NEO-141: the field list is explicit and deliberately omits `password`.
   * This used to be `{...credentials, token, expiresAt}`, and that spread is
   * what silently re-persisted the user's password on every hourly token
   * refresh — the secret could never shed it, no matter what the intake path
   * did. An explicit list means adding a field is a decision, not an accident.
   *
   * `username` is the only durable field; everything else is session state.
   *
   * NEO-141 hardening: the canary-KEY guard lives here rather than at the two
   * call sites so that "a canary secret is never written back" is a property of
   * the write itself. A canary-keyed request that omitted `canary: true` would
   * otherwise reach this method from either the password path or the refresh
   * path, persist a payload with no password in it, and — via keep-1 pruning —
   * destroy the canary's password unrecoverably. See isCanaryKey for why that
   * failure is worse than it sounds (silently dead login alerting).
   */
  private async persistTokens(
    secretsManager: SecretsManagerService,
    key: string,
    username: string,
    tokens: BscTokenSet,
  ): Promise<void> {
    if (isCanaryKey(key)) {
      console.log(
        `[BSC Adapter] canary key — refusing token write-back to protect the stored password`,
      );
      return;
    }
    const payload: Credentials = {
      username,
      token: tokens.token,
      expiresAt: tokens.expiresAt,
    };
    if (tokens.refreshToken) payload.refreshToken = tokens.refreshToken;
    if (tokens.refreshExpiresAt) payload.refreshExpiresAt = tokens.refreshExpiresAt;
    await secretsManager.updateCredentials(key, payload);
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

  /**
   * Authenticate against BSC, in descending order of cost.
   *
   *   0. transient credentials in the request body → fresh sign-in (bootstrap
   *      or explicit re-auth). Never consults the stored secret.
   *   1. cached access token that still validates → free.
   *   2. live refresh token → one POST /token. NEO-141: this is what replaced
   *      keeping the user's password on disk.
   *   3. a stored password → full B2C sign-in. Reachable only by the NEO-43
   *      canary secrets and by legacy user secrets not yet migrated.
   *   4. nothing left → `reauthRequired`, the signal Convex turns into "sign
   *      in again".
   *
   * The canary skips 1 and 2 outright and lands on 3 every time — that is the
   * entire point of the probe, and both Cloud Scheduler jobs depend on it.
   */
  async login(key: string, opts?: LoginOptions): Promise<AdapterResponse> {
    const secretsManager = new SecretsManagerService();
    const canary = opts?.canary === true;
    const transient = opts?.transientCredentials;

    // --- Step 0: transient credentials --------------------------------------
    //
    // Deliberately does NOT read the secret first: this is also the path that
    // bootstraps a key that does not exist yet. The password is used here and
    // nowhere else, and persistTokens never writes it.
    if (transient) {
      console.log(`[BSC Adapter] request supplied credentials; fresh sign-in for ${this.siteName}`);
      return this.passwordLogin(
        secretsManager,
        key,
        transient.username,
        transient.password,
        canary,
      );
    }

    const credentials = await secretsManager.getCredentials(key);

    // --- Cache-hit path: validate the stored token, never touch a browser --
    //
    // BSC stores the bare token (no "Bearer " prefix); fetchSellerProfile
    // prepends "Bearer " on the validation request. A still-valid cached token
    // short-circuits the whole B2C exchange.
    //
    // NEO-43: the canary skips this entirely. A cache hit costs ~1.1s and
    // proves only that a previously-issued token is still accepted — it does
    // NOT exercise the B2C authorize/SelfAsserted/confirmed/token exchange,
    // which is the part that actually breaks. A canary that short-circuits
    // here would report green straight through a real outage.
    if (
      !canary &&
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
      // Stale/revoked token. Fall through to a fresh login.
      //
      // NEO-115: we deliberately do NOT write a token-cleared version here.
      // That write burned a whole Secret Manager version (billed forever, at
      // TOKEN_TTL_MS = 1h cadence) purely to blank a field that the
      // fresh-login write-back below overwrites seconds later — it doubled
      // BSC's version rate for no durable benefit. The dead token simply
      // stays in the secret until the fresh login replaces it; it can never
      // cause a false success, because the cache-hit branch above only
      // returns success when fetchSellerProfile actually validates it.
      console.log(`[BSC Adapter] Cached token is invalid, re-authenticating...`);
    }

    // --- Refresh-grant path: NEO-141's replacement for a stored password ---
    //
    // The canary skips this for the same reason it skips the cache: a refresh
    // grant does not exercise the authorize/SelfAsserted/confirmed exchange,
    // which is the part that actually breaks. (It also never has a refresh
    // token to use, since it never writes back.)
    if (!canary && this.refreshTokenIsLive(credentials)) {
      const refreshed = await this.refreshAccessToken(credentials.refreshToken as string);

      if ("tokens" in refreshed) {
        // ATOMIC, NOT BEST-EFFORT. B2C has already invalidated the refresh
        // token we just presented, so the rotated one in `refreshed` is now
        // the ONLY way back in. Returning success without durably storing it
        // would strand the user on a token that expires in an hour with no
        // way to renew — the exact failure NEO-141 exists to remove. A write
        // failure therefore fails the login (502, pages) instead of being
        // swallowed.
        try {
          await this.persistTokens(secretsManager, key, credentials.username, refreshed.tokens);
        } catch (error) {
          console.error(
            `[BSC Adapter] Refresh succeeded but persisting the rotated token FAILED — ` +
              `the refresh chain is broken for this key:`,
            error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          );
          return { success: false, error: `Authentication failed` };
        }

        const profile = await this.fetchSellerProfile(refreshed.tokens.token);
        this.logProfile("Refreshed token", profile);
        return {
          success: true,
          message: `Refreshed token for ${this.siteName}`,
          expiresAt: refreshed.tokens.expiresAt,
          storeName: profile?.storeName,
          sellerId: profile?.sellerId,
        };
      }

      // Refresh failed. If the secret still carries a password (canary, or a
      // not-yet-migrated legacy user secret) we can fall through and sign in
      // properly. Otherwise this is the end of the line.
      if (!credentials.password) {
        return {
          success: false,
          error: refreshed.error,
          // Only a REFUSED grant means "sign in again". An unreachable token
          // endpoint leaves reauthRequired false, so it stays a pageable 502.
          reauthRequired: refreshed.reauthRequired,
        };
      }
      console.log(`[BSC Adapter] refresh grant failed; falling back to a password sign-in`);
    }

    // --- Password sign-in: the canary path, and legacy un-migrated secrets --
    if (!credentials.password) {
      // NEO-141: no cached token, no usable refresh token, and no password to
      // sign in with — which is the CORRECT steady state for a user secret
      // whose session has fully lapsed, not a corrupt one. Say so precisely so
      // Convex can prompt a re-login instead of guessing from a status code.
      console.log(
        `[BSC Adapter] no cached token, no live refresh token, no password — re-auth required`,
      );
      return { success: false, error: REAUTH_REQUIRED_ERROR, reauthRequired: true };
    }

    return this.passwordLogin(
      secretsManager,
      key,
      credentials.username,
      credentials.password,
      canary,
    );
  }

  /** True when the secret holds a refresh token that has not visibly expired. */
  private refreshTokenIsLive(credentials: Credentials): boolean {
    if (!credentials.refreshToken) return false;
    // An absent refreshExpiresAt is treated as live rather than dead: BSC does
    // return refresh_token_expires_in today, but if it ever stops, the right
    // move is to TRY the grant and let B2C answer — a refused grant is one
    // cheap round trip, whereas assuming "dead" would silently downgrade every
    // user to a password login they no longer have a password for.
    return (
      credentials.refreshExpiresAt === undefined || credentials.refreshExpiresAt > Date.now()
    );
  }

  /**
   * Full browser-free B2C sign-in with a username+password, followed by the
   * token write-back.
   *
   * `password` is transient in every caller: it comes either from the request
   * body (a user signing in) or from one of the two canary secrets. It is
   * passed to httpLogin, which hands it to buildLoginDiagnostic for exact-value
   * redaction, and is never persisted — persistTokens writes an explicit field
   * list with no `password` in it.
   */
  private async passwordLogin(
    secretsManager: SecretsManagerService,
    key: string,
    username: string,
    password: string,
    canary: boolean,
  ): Promise<AdapterResponse> {
    console.log(`[BSC Adapter] Starting browser-free login for ${this.siteName}`);
    if (!username || !password) {
      console.error(
        `[BSC Adapter] Missing credentials: email=${!!username}, password=${!!password}`,
      );
      return {
        success: false,
        error: `Missing credentials for ${this.siteName}`,
        // NEO-98: BSC never gets asked. Not a marketplace verdict, but
        // unambiguously a caller-data problem rather than a service fault —
        // 422, and it must not page.
        credentialRejected: true,
      };
    }

    try {
      const result = await this.httpLogin(username, password);
      if ("error" in result) {
        return {
          success: false,
          error: result.error,
          diagnostic: result.diagnostic,
          credentialRejected: result.credentialRejected,
        };
      }

      const tokens = result.tokens;

      // NEO-43: the canary must NOT write back. Every write adds a new,
      // permanently-enabled Secret Manager version ($0.06/version/month) —
      // at canary cadence that is thousands of versions a month, costing more
      // than the rest of this infrastructure combined. Skipping it also means
      // no token is ever cached on the canary key, so the cache-skip above is
      // structurally guaranteed rather than merely flag-dependent.
      if (canary) {
        console.log(`[BSC Adapter] canary run — skipping token write-back for ${this.siteName}`);
      } else {
        await this.persistTokens(secretsManager, key, username, tokens);
        console.log(`[BSC Adapter] Stored token in Secret Manager for ${this.siteName}`);
      }

      // Capture sellerId/storeName in the same response shape as the cached
      // path. Profile failure here is non-fatal — we already have a valid
      // token; the caller just won't get a sellerId this round.
      const profile = await this.fetchSellerProfile(tokens.token);
      this.logProfile("Fresh login", profile);

      return {
        success: true,
        message: `Successfully logged into ${this.siteName}`,
        expiresAt: tokens.expiresAt,
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

  /**
   * Log the outcome of a profile fetch.
   *
   * sellerId is truncated to a 4-char prefix: it is a per-user BSC identifier,
   * and full values in Cloud Logging would let a log reader correlate Clerk
   * users to BSC seller accounts.
   */
  private logProfile(
    context: string,
    profile: { storeName?: string; sellerId?: string } | null,
  ): void {
    if (!profile) {
      console.warn(
        `[BSC Adapter] ${context}: /marketplace/user/profile returned non-OK; storeName + sellerId omitted.`,
      );
      return;
    }
    const sellerIdPrefix = profile.sellerId ? `${profile.sellerId.slice(0, 4)}…` : "(unknown)";
    console.log(
      `[BSC Adapter] ${context} profile. Store: ${profile.storeName} sellerId: ${sellerIdPrefix}`,
    );
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
