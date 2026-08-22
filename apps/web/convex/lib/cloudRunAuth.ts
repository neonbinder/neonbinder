"use node";

/**
 * Shared OIDC auth for Convex → Cloud Run calls (NEO-170).
 *
 * Extracted verbatim from convex/credentials.ts, which had been the sole
 * caller: NEO-20 wired the browser service, and the preprocess service
 * (NEO-170) needs exactly the same handshake against a different audience.
 * Copying it would have duplicated a security control — including the
 * fail-closed guard below and the google-auth-library v10 gotcha — into a
 * second file where only one of the two copies would get fixed.
 *
 * `"use node"` because google-auth-library and `Buffer` are Node-only. Convex
 * bundles every module under `convex/` for a runtime, so a helper carrying
 * Node-only imports has to declare the directive itself even though it exports
 * no Convex functions (same as convex/adapters/base.ts and adapters/gcs.ts).
 *
 * Convex calls Cloud Run as the neonbinder-convex service account (credentials
 * decoded from GOOGLE_APPLICATION_CREDENTIALS_B64) and mints a Google OIDC ID
 * token whose audience is the target Cloud Run service URL.
 */

import { GoogleAuth, IdTokenClient } from "google-auth-library";

/**
 * One client per audience, for the life of the module.
 *
 * google-auth-library caches and auto-refreshes the underlying token, so the
 * only thing worth keeping is the client itself. This was a SINGLE slot when
 * only the browser service used it; with a second service in play, a single
 * slot would thrash — every alternation between the browser audience and the
 * preprocess audience would evict the other and re-mint from scratch. A Map
 * keyed by audience makes concurrent use of both free.
 *
 * Unbounded growth is not a concern: audiences come from environment
 * variables, so the key space is the number of Cloud Run services this
 * deployment talks to (currently two).
 */
const idTokenClients = new Map<string, IdTokenClient>();

/**
 * Loopback hosts allowed to bypass OIDC (local-dev services). Anything else
 * over plain http:// is treated as misconfiguration and throws — we do NOT
 * want to silently fall back to unauthenticated requests against a
 * real-but-misconfigured endpoint.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Resolve (and cache) the ID-token client for `audience`, or `null` when the
 * audience is a loopback dev server and OIDC should be skipped entirely.
 *
 * `envVarName` names the environment variable the audience came from, purely
 * so a misconfiguration error points at the right variable. It is not optional
 * on purpose: a default would silently blame NEONBINDER_BROWSER_URL for a
 * preprocess misconfiguration and send whoever is debugging to the wrong file.
 *
 * @throws if the audience is not a valid URL, or is non-https and non-loopback
 *         (fail closed — see LOOPBACK_HOSTS), or if GCP credentials are absent.
 */
export async function getIdTokenClient(
  audience: string,
  envVarName: string,
): Promise<IdTokenClient | null> {
  if (!audience.startsWith("https://")) {
    let host = "";
    try {
      host = new URL(audience).hostname;
    } catch {
      throw new Error(`${envVarName} is not a valid URL: ${audience}`);
    }
    if (LOOPBACK_HOSTS.has(host)) {
      // Local dev — the service runs on the developer machine without Cloud
      // Run IAM. Skip OIDC entirely.
      return null;
    }
    throw new Error(
      `${envVarName} must use https:// for non-loopback hosts; got ${audience}. Refusing to send unauthenticated requests to a remote service.`,
    );
  }

  const cached = idTokenClients.get(audience);
  if (cached) return cached;

  const b64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;
  if (!b64) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS_B64 not set — required to authenticate to Cloud Run services",
    );
  }
  const credentials = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  const auth = new GoogleAuth({ credentials });
  const client = await auth.getIdTokenClient(audience);
  idTokenClients.set(audience, client);
  return client;
}

/**
 * Build the outbound headers for a Cloud Run call: `Content-Type` plus the
 * OIDC `Authorization` bearer, or just `Content-Type` in loopback dev.
 *
 * `audience` is the value Cloud Run IAM will validate the token against, which
 * is NOT always the host the request is sent to — a tagged preview revision
 * (`https://pr-N---service-hash-uc.a.run.app`) must be *reached* at the tagged
 * host but *authorized* against the base service URL. Callers that can be
 * pointed at a tagged host are responsible for normalizing first (see
 * `oidcAudienceFor` in convex/browserAudience.ts); this function takes the
 * already-resolved audience so it stays service-agnostic.
 */
export async function buildAuthHeaders(
  audience: string,
  envVarName: string,
): Promise<Record<string, string>> {
  const client = await getIdTokenClient(audience, envVarName);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!client) return headers;
  const authHeaders = await client.getRequestHeaders();
  // google-auth-library v10 returns a web-standard Headers object (v9 returned a
  // plain object); iterate its entries (keys lowercased, values strings) to copy
  // Authorization (and sometimes x-goog-user-project) across. Object.entries()
  // would yield [] on a Headers instance and silently drop the auth header.
  authHeaders.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/**
 * Drop every cached ID-token client. Exported for tests only — mirrors
 * `__resetContractCache` in credentials.ts. Module-scope caches otherwise leak
 * across test cases in the same file.
 */
export function __resetIdTokenClientCache(): void {
  idTokenClients.clear();
}
