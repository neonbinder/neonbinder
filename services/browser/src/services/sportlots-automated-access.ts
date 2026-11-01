import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

/**
 * NEO-288: the SportLots "Automated Access" credential.
 *
 * On 2026-09-17 SportLots put a Cloudflare Turnstile challenge in front of
 * signin.tpl. The SportLots owner issued NeonBinder a keyId/secret pair and a
 * script path around it: POST the pair to /u/node/automated-access, receive a
 * short-lived single-use `authId`, and carry that on the ordinary signin POST
 * as `turnstile_auth_id`. The pair is OUR credential with SportLots — one per
 * deployment, not per user — so it lives in its own Secret Manager secret and
 * is read here, not through SecretsManagerService (whose key pattern and
 * `username` requirement describe per-user marketplace secrets, not this).
 *
 * SECURITY:
 *   - `secret` is transmitted ONLY in the HTTPS POST body to SportLots. Never
 *     a query string, never a header, never a log line, never an error
 *     message, never committed.
 *   - The stored payload is untrusted input. It is narrowed field by field;
 *     the JSON parse error is NEVER logged or re-thrown, because Node >= 20
 *     embeds a window of the offending input in SyntaxError.message.
 *   - Every failure surfaces as the ONE fixed error below. A login must fail
 *     loudly (error_class `automated_access`, 502, pages) when this credential
 *     is missing or unreadable — never silently skip the handshake, because
 *     SportLots would then refuse the sign-in with a body that could be
 *     mistaken for a credential rejection.
 *
 * The client is constructed lazily so importing this module never touches
 * GCP; unit tests stub `@google-cloud/secret-manager` in the require cache
 * before the first read.
 */

/** Secret Manager secret id, per project (`neonbinder` / `neonbinder-dev`). */
export const SPORTLOTS_AUTOMATED_ACCESS_SECRET = "sportlots-automated-access";

/** The one caller-facing error. Contains "automated access" on purpose — see classifyBrowserError. */
export const AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR =
  "SportLots automated access credential is not configured";

/** How long a successful read is reused before Secret Manager is asked again. */
export const AUTOMATED_ACCESS_CACHE_TTL_MS = 10 * 60 * 1000;

export interface AutomatedAccessCredential {
  keyId: string;
  secret: string;
}

let cached: { value: AutomatedAccessCredential; expiresAt: number } | undefined;
let client: SecretManagerServiceClient | undefined;

// Bumped only by invalidate(). A read captures the generation live when it
// STARTS; when it resolves it only writes the cache if the generation is
// still the one it captured. Without this, a slow read already in flight
// when invalidate() runs can resolve afterwards and silently write back the
// very value invalidate() was called to discard — undoing the invalidation
// for every subsequent caller until the next one happens to fire.
//
// Two reads that start concurrently with no invalidate() between them share
// the same generation, so whichever resolves last still wins — that is the
// "acceptable double read" case (both are equally fresh; there is no
// correct tiebreak), left as before.
let generation = 0;

function getClient(): SecretManagerServiceClient {
  // Constructed on first use, not at import: building the client resolves
  // ADC, which must not happen just because the adapter module was loaded.
  if (!client) client = new SecretManagerServiceClient();
  return client;
}

function secretName(): string {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT || "neonbinder";
  return `projects/${projectId}/secrets/${SPORTLOTS_AUTOMATED_ACCESS_SECRET}`;
}

/**
 * Narrow an untrusted parsed-JSON value to the credential shape. Both fields
 * must be non-empty strings; anything else is "not configured". No other key
 * is copied, so the stored blob cannot smuggle fields into the request body.
 */
function narrow(value: unknown): AutomatedAccessCredential | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { keyId, secret } = value as Record<string, unknown>;
  if (typeof keyId !== "string" || keyId.length === 0) return undefined;
  if (typeof secret !== "string" || secret.length === 0) return undefined;
  return { keyId, secret };
}

async function readFromSecretManager(): Promise<AutomatedAccessCredential | undefined> {
  const sm = getClient();
  // Same steps as SecretsManagerService.getCredentials: list → first ENABLED →
  // access. Each secret carries one live version (NEO-115 keep-one), so the
  // first ENABLED version is the live one.
  const [versions] = await sm.listSecretVersions({ parent: secretName() });
  const active = versions.find((v) => v.state === "ENABLED");
  if (!active?.name) return undefined;
  const [version] = await sm.accessSecretVersion({ name: active.name });
  const data = version.payload?.data;
  if (!data) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString());
  } catch {
    // Deliberately swallowed: the SyntaxError message quotes the payload.
    return undefined;
  }
  return narrow(parsed);
}

/**
 * Read the automated-access credential, from the in-process cache when it is
 * fresh. Throws the fixed AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR on ANY failure
 * — missing secret, no enabled version, empty payload, unparsable JSON, a
 * field missing or empty, or a Secret Manager client error. The underlying
 * reason is logged as a name only (never a message, which can quote the
 * request or the payload).
 */
export async function getAutomatedAccessCredential(): Promise<AutomatedAccessCredential> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const startedAtGeneration = generation;
  let value: AutomatedAccessCredential | undefined;
  try {
    value = await readFromSecretManager();
  } catch (error) {
    console.error(
      `[SportLots automated access] credential read failed: ${
        error instanceof Error ? error.name : "Error"
      }`,
    );
    value = undefined;
  }
  if (!value) {
    throw new Error(AUTOMATED_ACCESS_NOT_CONFIGURED_ERROR);
  }
  // Only write the cache if nothing invalidated it while this read was in
  // flight. A concurrent, equally-fresh read is fine either way (the "double
  // read" case above); what must never happen is a stale read that was
  // already in flight BEFORE an invalidate() silently undoing it by writing
  // the very value invalidate() was called to discard.
  if (generation === startedAtGeneration) {
    cached = { value, expiresAt: Date.now() + AUTOMATED_ACCESS_CACHE_TTL_MS };
  }
  return value;
}

/**
 * Drop the cached credential so the next read goes back to Secret Manager.
 * Called by the adapter when SportLots REFUSES the handshake (401/403, a
 * `success:false` body): the most likely cause is a rotated key, and the
 * rotated value should be picked up on the next attempt without a restart.
 */
export function invalidateAutomatedAccessCredential(): void {
  cached = undefined;
  // Bump so any read already in flight (started before this call) discards
  // its result instead of writing it back — see `generation` above.
  generation++;
}
