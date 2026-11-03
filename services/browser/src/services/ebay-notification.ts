import { createPublicKey, createVerify, KeyObject } from "node:crypto";
import {
  EBAY_HOSTS,
  EBAY_REQUEST_TIMEOUT_MS,
  EbayOAuthConfig,
  EbayOAuthDeps,
  EbayOAuthError,
  fetchApplicationToken,
} from "./ebay-oauth";

/**
 * NEO-415 — verify an eBay Notification API push (the Marketplace Account
 * Deletion topic) is really from eBay.
 *
 * The steps follow eBay's own event-notification SDK
 * (github.com/eBay/event-notification-nodejs-sdk, lib/validator.js,
 * lib/client.js and lib/constants.js):
 *
 *   1. The `X-EBAY-SIGNATURE` header is base64 of a JSON object
 *      `{alg, kid, signature, digest}`.
 *   2. The public key for `kid` comes from the Notification API,
 *      `GET /commerce/notification/v1/public_key/{kid}` on the api host, with
 *      an APPLICATION token (client-credentials grant). The response is
 *      `{algorithm, digest, key}`, `key` being a PEM whose BEGIN/END markers
 *      sit on the same line as the body; the SDK re-breaks them (formatKey).
 *   3. Verify with `crypto.createVerify("ssl3-sha1")` (OpenSSL's alias for
 *      SHA-1, so ECDSA over SHA-1) and the header's `signature` as base64
 *      DER. The SDK caches keys by kid (LRU of 100, no TTL).
 *
 * One deliberate difference: the SDK verifies `JSON.stringify(parsedBody)`
 * because Express has already parsed the body by then. We verify the RAW body
 * bytes Convex received, and only if that fails try the SDK's re-serialised
 * form, so a body eBay sends compact (its normal form) verifies either way and
 * one it ever sends with whitespace still verifies the way the SDK would.
 * Either way the signature must verify under eBay's key.
 */

/** eBay kids are UUID-like. Anchored; it goes into a URL path. */
export const NOTIFICATION_KID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** A real header is ~300 chars. Anything far beyond is not eBay's. */
const MAX_SIGNATURE_HEADER_LENGTH = 4096;
/** A DER ECDSA P-256 signature is ~96 base64 chars. */
const MAX_SIGNATURE_LENGTH = 1024;
/** Account-deletion bodies are well under 1 KB. */
export const MAX_NOTIFICATION_BODY_LENGTH = 8192;

const PUBLIC_KEY_PATH = "/commerce/notification/v1/public_key/";
/** Re-read a key at most hourly; eBay rotates by issuing a new kid. */
const KEY_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED_KEYS = 100;

/**
 * Re-audit condition 1. The kid comes from an unauthenticated push, so
 * without these two limits anyone who can reach Convex's webhook could make
 * this service call eBay once per request with a made-up kid.
 *
 *   - A kid eBay answers 400/404 for is remembered as unknown for 10 minutes
 *     and answered `valid:false` without another call.
 *   - At most UNCACHED_KEY_FETCHES_PER_MINUTE key fetches (cache misses) run
 *     per process per rolling minute. Over the cap the verifier reports an
 *     OUTAGE, never `valid:false`: Convex answers eBay 500 and eBay retries
 *     later, so a genuine push that lands during a flood is delayed, not
 *     dropped. Kids already cached (either way) do not count.
 */
const NEGATIVE_KID_TTL_MS = 10 * 60 * 1000;
const MAX_NEGATIVE_KIDS = 1000;
export const UNCACHED_KEY_FETCHES_PER_MINUTE = 5;
const KEY_FETCH_WINDOW_MS = 60 * 1000;
/** Renew the app token this long before eBay says it lapses. */
const APP_TOKEN_LEEWAY_MS = 60 * 1000;

const PEM_START = "-----BEGIN PUBLIC KEY-----";
const PEM_END = "-----END PUBLIC KEY-----";

export interface ParsedSignatureHeader {
  kid: string;
  /** Base64 DER. */
  signature: string;
}

/**
 * Decode and check `X-EBAY-SIGNATURE`. Returns null for anything that is not
 * a well-formed eBay header, including an `alg` other than ECDSA or a
 * `digest` other than SHA1 (the only pair eBay's SDK verifies); both fields
 * are optional because the SDK ignores them.
 */
export function parseSignatureHeader(raw: string): ParsedSignatureHeader | null {
  if (raw.length === 0 || raw.length > MAX_SIGNATURE_HEADER_LENGTH) return null;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw.trim())) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw.trim(), "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
  const { alg, kid, signature, digest } = decoded as Record<string, unknown>;
  if (alg !== undefined && (typeof alg !== "string" || alg.toLowerCase() !== "ecdsa")) return null;
  if (digest !== undefined && (typeof digest !== "string" || digest.toUpperCase() !== "SHA1")) {
    return null;
  }
  if (typeof kid !== "string" || !NOTIFICATION_KID_PATTERN.test(kid)) return null;
  if (
    typeof signature !== "string" ||
    signature.length === 0 ||
    signature.length > MAX_SIGNATURE_LENGTH ||
    !/^[A-Za-z0-9+/=]+$/.test(signature)
  ) {
    return null;
  }
  return { kid, signature };
}

/** eBay's PEM with its markers on their own lines (the SDK's formatKey). */
export function formatEbayPublicKey(key: string): string {
  return key.replace(PEM_START, `${PEM_START}\n`).replace(PEM_END, `\n${PEM_END}`);
}

function verifyBytes(key: KeyObject, data: string, signature: string): boolean {
  try {
    return createVerify("sha1").update(Buffer.from(data, "utf8")).verify(key, signature, "base64");
  } catch {
    // A signature that is not valid DER throws rather than returning false.
    return false;
  }
}

/**
 * One verifier per router: it owns the app-token and public-key caches, so
 * tests get fresh state and production keeps one per process.
 */
export class EbayNotificationVerifier {
  private appTokens = new Map<string, { token: string; expiresAt: number }>();
  private appTokenInFlight = new Map<string, Promise<string>>();
  private keys = new Map<string, { key: KeyObject; fetchedAt: number }>();
  /** environment:kid → epoch ms until which eBay's "no such key" stands. */
  private unknownKids = new Map<string, number>();
  /** Start times of recent uncached key fetches, for the per-minute cap. */
  private recentKeyFetches: number[] = [];

  constructor(private readonly deps: EbayOAuthDeps = {}) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Cache key: an app token belongs to one app in one environment. */
  private appTokenSlot(config: EbayOAuthConfig): string {
    return `${config.environment}:${config.clientId}`;
  }

  private async appToken(config: EbayOAuthConfig): Promise<string> {
    const slot = this.appTokenSlot(config);
    const cached = this.appTokens.get(slot);
    if (cached && cached.expiresAt - APP_TOKEN_LEEWAY_MS > this.now()) return cached.token;
    const pending = this.appTokenInFlight.get(slot);
    if (pending) return pending;
    const minting = (async () => {
      try {
        const result = await fetchApplicationToken(config, this.deps);
        this.appTokens.set(slot, { token: result.accessToken, expiresAt: result.expiresAt });
        return result.accessToken;
      } catch (err) {
        // Any refusal of OUR app credentials is an outage to the caller, not
        // a verdict on the notification.
        if (err instanceof EbayOAuthError) {
          throw new EbayOAuthError("unavailable", {
            upstreamStatus: err.upstreamStatus,
            oauthError: err.oauthError,
          });
        }
        throw err;
      } finally {
        this.appTokenInFlight.delete(slot);
      }
    })();
    this.appTokenInFlight.set(slot, minting);
    return minting;
  }

  /**
   * The public key for `kid`, or null when eBay says there is no such key
   * (400/404, remembered for NEGATIVE_KID_TTL_MS) or hands back one that is
   * not an EC key. Throws `EbayOAuthError("unavailable")` when the key cannot
   * be fetched, including when the per-minute fetch budget is spent.
   */
  private async publicKey(config: EbayOAuthConfig, kid: string): Promise<KeyObject | null> {
    const slot = `${config.environment}:${kid}`;
    const now = this.now();
    const cached = this.keys.get(slot);
    if (cached && now - cached.fetchedAt < KEY_TTL_MS) return cached.key;
    const unknownUntil = this.unknownKids.get(slot);
    if (unknownUntil !== undefined) {
      if (unknownUntil > now) return null;
      this.unknownKids.delete(slot);
    }
    this.takeKeyFetchBudget(now);

    const url = `${EBAY_HOSTS[config.environment].api}${PUBLIC_KEY_PATH}${encodeURIComponent(kid)}`;
    let res: Response | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.appToken(config);
      try {
        res = await (this.deps.fetchImpl ?? fetch)(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(this.deps.timeoutMs ?? EBAY_REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new EbayOAuthError("unavailable");
      }
      // 401: our cached app token went stale early. Drop it, mint once more.
      if (res.status !== 401) break;
      this.appTokens.delete(this.appTokenSlot(config));
    }
    if (!res) throw new EbayOAuthError("unavailable");
    if (res.status === 400 || res.status === 404) {
      this.rememberUnknownKid(slot);
      return null;
    }
    if (!res.ok) throw new EbayOAuthError("unavailable", { upstreamStatus: res.status });

    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await res.json();
      if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      // handled below
    }
    const algorithm = body?.algorithm;
    if (typeof algorithm === "string" && algorithm.toUpperCase() !== "ECDSA") return null;
    if (typeof body?.key !== "string" || !body.key.includes(PEM_START)) {
      throw new EbayOAuthError("malformed", { upstreamStatus: res.status });
    }
    let key: KeyObject;
    try {
      key = createPublicKey(formatEbayPublicKey(body.key));
    } catch {
      throw new EbayOAuthError("malformed", { upstreamStatus: res.status });
    }
    if (key.asymmetricKeyType !== "ec") return null;

    if (this.keys.size >= MAX_CACHED_KEYS && !this.keys.has(slot)) {
      // Oldest first: Map iteration is insertion order.
      const oldest = this.keys.keys().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    this.keys.set(slot, { key, fetchedAt: this.now() });
    return key;
  }

  /**
   * Spend one uncached key fetch, or throw `unavailable` when the rolling
   * minute's budget is gone. Only timestamps within [now - window, now] count,
   * so a clock that moves backwards cannot wedge the budget shut.
   */
  private takeKeyFetchBudget(now: number): void {
    this.recentKeyFetches = this.recentKeyFetches.filter(
      (t) => t <= now && now - t < KEY_FETCH_WINDOW_MS,
    );
    if (this.recentKeyFetches.length >= UNCACHED_KEY_FETCHES_PER_MINUTE) {
      throw new EbayOAuthError("unavailable");
    }
    this.recentKeyFetches.push(now);
  }

  private rememberUnknownKid(slot: string): void {
    if (this.unknownKids.size >= MAX_NEGATIVE_KIDS && !this.unknownKids.has(slot)) {
      const oldest = this.unknownKids.keys().next().value;
      if (oldest !== undefined) this.unknownKids.delete(oldest);
    }
    this.unknownKids.set(slot, this.now() + NEGATIVE_KID_TTL_MS);
  }

  /**
   * True only when `signatureHeader` is a well-formed eBay signature whose
   * key eBay vouches for and which verifies over `body`. A malformed header
   * or an unknown kid is `false` with no error; only a failure to reach eBay
   * throws (`EbayOAuthError`, kind unavailable or malformed).
   */
  async verify(config: EbayOAuthConfig, signatureHeader: string, body: string): Promise<boolean> {
    if (body.length > MAX_NOTIFICATION_BODY_LENGTH) return false;
    const parsed = parseSignatureHeader(signatureHeader);
    if (!parsed) return false;
    const key = await this.publicKey(config, parsed.kid);
    if (!key) return false;
    if (verifyBytes(key, body, parsed.signature)) return true;
    // eBay's SDK form: the parsed body re-serialised.
    let canonical: string | undefined;
    try {
      canonical = JSON.stringify(JSON.parse(body));
    } catch {
      return false;
    }
    return canonical !== body && verifyBytes(key, canonical, parsed.signature);
  }
}
