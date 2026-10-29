import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

/**
 * The shape stored in one Secret Manager secret.
 *
 * NEO-140/NEO-141: this used to be "the user's marketplace username and
 * password, plus a cached token". It is now "the user's username, plus the
 * material needed to keep a session alive" — the password is gone from every
 * user-owned secret.
 *
 * SECURITY: every optional field here is credential material. None of it may
 * appear in an HTTP response body, a log line, or an error message. The only
 * fields any endpoint may echo are `username` and the BOOLEAN/expiry metadata
 * derived from the rest (see GET /credentials/:key/metadata).
 */
export interface Credentials {
  username: string;
  /**
   * Marketplace password.
   *
   * NEO-141: retained ONLY for the two NEO-43 canary secrets
   * (`bsc-credentials-canary`, `sportlots-credentials-canary`), whose entire
   * purpose is to perform a REAL password login every 30 minutes so the login
   * alerting has something to alert on. It is NEVER written for a user key —
   * a user's password is transient, used for one sign-in and then discarded.
   *
   * Legacy user secrets written before NEO-141 may still carry one; the
   * adapters will happily use it, but they never write it back, so those
   * secrets shed the password on their next successful login.
   */
  password?: string;
  /**
   * The cached marketplace session credential: a BSC Bearer access token
   * (bare, no "Bearer " prefix) or a SportLots session-cookie string.
   */
  token?: string;
  /** Epoch ms at which `token` stops being usable. */
  expiresAt?: number;
  /**
   * BSC only. Azure AD B2C refresh token, 24h-lived and ROTATED on every use —
   * each refresh grant returns a new one and invalidates the one presented.
   * Persisting the rotated value is therefore mandatory, not best-effort:
   * dropping it breaks the chain and forces the user to sign in again.
   */
  refreshToken?: string;
  /**
   * BSC only. Epoch ms at which `refreshToken` stops being usable.
   *
   * NEO-278: this window is ABSOLUTE from the password sign-in, not sliding.
   * Rotation hands back a new refresh token but never extends the window, so
   * a user who only ever refreshes is signed out 24h after they typed their
   * password. The SSO cookies below are what get past that.
   */
  refreshExpiresAt?: number;
  /**
   * BSC only. NEO-278. The Azure AD B2C "Keep me signed in" SSO cookies
   * (cookie name → value) captured from the sign-in exchange once we send
   * `rememberMe=true`. Presenting them on a fresh /authorize yields a new auth
   * code with no password and no sign-in form, which is how a session outlives
   * the absolute 24h refresh window.
   *
   * SECURITY: every VALUE here is a bearer credential for the user's BSC
   * session. Values are never logged (names only) and never leave the process.
   * Old secrets simply lack this field; the adapter treats that as "no SSO
   * session" and falls through to the existing paths.
   */
  ssoCookies?: Record<string, string>;
  /**
   * BSC only. NEO-278. Epoch ms at which the earliest-expiring cookie in
   * `ssoCookies` lapses (B2C issues ~62 days and slides it on every silent
   * re-authorize). Absent when B2C set no expiry attribute; the adapter then
   * tries the cookie and lets B2C answer.
   */
  ssoExpiresAt?: number;
}

/**
 * Narrow an untrusted parsed-JSON value to a flat `{name: value}` string map.
 *
 * NEO-278: the stored blob is untrusted input (see getCredentials). Anything
 * that is not a plain object, or any entry whose key or value is not a
 * non-empty string, is dropped rather than propagated — the same posture as
 * the field-by-field copy of the top-level fields. Returns undefined when
 * nothing survives, so an empty map never reads back as "has SSO cookies".
 */
// A cookie name or value carrying a control character can never be a real
// cookie (RFC 6265 forbids them) and would make fetch() throw a header
// validation error whose message quotes the whole header — i.e. the session.
// Reject at the narrowing boundary so such a value never reaches a request.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function parseCookieMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  let count = 0;
  for (const [name, cookieValue] of Object.entries(value as Record<string, unknown>)) {
    if (name.length === 0 || typeof cookieValue !== "string" || cookieValue.length === 0) {
      continue;
    }
    if (CONTROL_CHARS.test(name) || CONTROL_CHARS.test(cookieValue)) {
      continue;
    }
    result[name] = cookieValue;
    count++;
  }
  return count > 0 ? result : undefined;
}

const KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/;

/**
 * Retry budget for a Secret Manager call refused with RESOURCE_EXHAUSTED.
 *
 * NEO-385. Secret Manager meters calls per project per minute, and a refused
 * call was surfacing as a 500 from GET /credentials/:key/token, which left the
 * Convex BSC checklist fetch waiting until the E2E spec timed out. A refused
 * call is not executed, so trying it again is safe even for a write. Two
 * retries add at most 2.4 s of backoff (400 ms and 1200 ms, each jittered to
 * 0.5x-1.5x). A read can also spend up to three 5 s ACCESS_CALL_OPTIONS
 * timeouts, so the true worst case is about 17 s; that needs timeouts and
 * quota refusals to stack, and is still far short of the client's own
 * 10-minute default retry it replaces.
 */
const QUOTA_RETRY_DELAYS_MS = [400, 1200];

/**
 * Call options for AccessSecretVersion. The client's own config retries that
 * call on RESOURCE_EXHAUSTED and UNAVAILABLE for up to 10 minutes, which
 * would hold a token request open far past any caller's timeout. Turning that
 * off leaves `withQuotaRetry` as the single, bounded retry layer. Every other
 * method the service calls has no client-side retry.
 */
export const ACCESS_CALL_OPTIONS = { retry: null, timeout: 5_000 } as const;

/**
 * Extract the monotonically-increasing version ordinal from a Secret Manager
 * version resource name (`projects/<p>/secrets/<s>/versions/<N>`).
 *
 * Secret Manager assigns N in strictly increasing order per secret, so the
 * ordinal is a total order on "which write happened first" that needs no extra
 * API call. destroyPreviousVersion uses it to address the one version a write
 * superseded, without listing the secret.
 *
 * @returns the ordinal, or undefined if the name does not end in `/versions/N`.
 */
function versionOrdinal(versionName: string): number | undefined {
  const match = /\/versions\/(\d+)$/.exec(versionName);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * A log-safe name for a secret version: the BARE secret id plus the version
 * ordinal, e.g. `buysportscards-credentials-user_abc/versions/7`.
 *
 * NEO-294. The full resource name is `projects/<project>/secrets/<id>/versions/<N>`
 * and carries the GCP project identifier — the identifier this ticket exists
 * to keep out of the error path, and the one a raw gRPC message leaked onto an
 * HTTP response body. The project is a property of the deployment the log line
 * already came from, so naming it again buys nothing and spends a secret.
 *
 * The ordinal is deliberately KEPT: telling one version from another is the
 * entire reason these prune log lines exist, and a line that says only which
 * secret failed to prune cannot be acted on.
 *
 * @returns `<secretId>/versions/<N>`, or `<secretId>/versions/<unparseable>`
 *   when the name does not end in `/versions/N` (never the full name).
 */
function shortVersion(secretId: string, versionName: string): string {
  const ordinal = versionOrdinal(versionName);
  return `${secretId}/versions/${ordinal ?? "<unparseable>"}`;
}

/**
 * gRPC status codes the Secret Manager client reports on `err.code`.
 *
 * Both of these are ORDINARY outcomes of two writers reaching the same key, not
 * faults — see `addVersionCreatingIfAbsent` for why each one is a fall-through
 * rather than an error.
 */
const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;
/** The project's per-minute quota for this kind of call is spent (NEO-385). */
const GRPC_RESOURCE_EXHAUSTED = 8;
/**
 * The addressed version exists but is DESTROYED or DISABLED. On a read of
 * `versions/latest` that means the secret holds no usable credential.
 */
const GRPC_FAILED_PRECONDITION = 9;

function isResourceExhaustedError(err: any): boolean {
  return err?.code === GRPC_RESOURCE_EXHAUSTED;
}

function isFailedPreconditionError(err: any): boolean {
  return err?.code === GRPC_FAILED_PRECONDITION;
}

/**
 * Run a Secret Manager call, retrying it on RESOURCE_EXHAUSTED only.
 *
 * Every other error propagates at once: they are answers (NOT_FOUND,
 * FAILED_PRECONDITION) or faults a retry will not fix. Exported for the
 * SportLots automated-access reader, which talks to the client directly.
 */
export async function withQuotaRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err: any) {
      const base = QUOTA_RETRY_DELAYS_MS[attempt];
      if (!isResourceExhaustedError(err) || base === undefined) throw err;
      // Jitter, so a herd of refused callers does not retry in lockstep.
      const delay = Math.round(base * (0.5 + Math.random()));
      console.warn(
        JSON.stringify({ msg: "secret_manager_quota_retry", attempt: attempt + 1, delayMs: delay }),
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * True when a Secret Manager error means "that resource does not exist".
 *
 * The message fallback is kept from the original inline checks: the client can
 * surface a transport-level failure whose `code` is absent while the message
 * still carries the status. Matching on the message is deliberately narrow and
 * only ever used to pick a FALL-THROUGH path — never to decide what to log or
 * return, so a false positive cannot leak anything.
 */
function isNotFoundError(err: any): boolean {
  return (
    err?.code === GRPC_NOT_FOUND ||
    (typeof err?.message === "string" && err.message.includes("not found"))
  );
}

/**
 * True when a Secret Manager error means "that resource already exists".
 *
 * NEO-294: this is the second half of the check-then-create race. Secret
 * Manager has no create-if-absent, so a write against a missing secret is
 * unavoidably `addSecretVersion` → NOT_FOUND → `createSecret`, and the winner
 * of that race makes the loser's `createSecret` fail with ALREADY_EXISTS.
 */
function isAlreadyExistsError(err: any): boolean {
  return (
    err?.code === GRPC_ALREADY_EXISTS ||
    (typeof err?.message === "string" && /already exists/i.test(err.message))
  );
}

function validateKeyFormat(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error("Invalid credential key format");
  }
}

export class SecretsManagerService {
  private client: SecretManagerServiceClient;
  private projectId: string;

  constructor() {
    this.client = new SecretManagerServiceClient();
    this.projectId = process.env.GOOGLE_CLOUD_PROJECT || 'neonbinder';
  }
  /**
   * NEO-385: every read goes straight to `versions/latest`. The service keeps
   * one live version per secret and destroys only versions OLDER than the one
   * a write just added, so the newest version is the live one. Reading it
   * directly costs one AccessSecretVersion, metered at 90,000/min. The old
   * list-then-access read also spent a ListSecretVersions, metered at
   * 600/min per project and returning every destroyed version as well, and
   * parallel E2E bootstraps ran that quota out.
   */
  private async accessLatest(secretName: string) {
    const [version] = await withQuotaRetry(() =>
      this.client.accessSecretVersion(
        { name: `${secretName}/versions/latest` },
        ACCESS_CALL_OPTIONS,
      ),
    );
    return version;
  }

  async getCredentials(key: string): Promise<Credentials> {
    validateKeyFormat(key);
    try {
      const secretName = `projects/${this.projectId}/secrets/${key}`;

      let version;
      try {
        version = await this.accessLatest(secretName);
      } catch (err: any) {
        // The newest version is DESTROYED or DISABLED: nothing usable is
        // stored, which the routes report as a 404 like a missing secret.
        if (isFailedPreconditionError(err)) {
          throw new Error(`No active version found for secret`);
        }
        throw err;
      }

      if (!version.payload?.data) {
        throw new Error(`No data found in secret`);
      }

      const secretData = version.payload.data.toString();
      // NEVER log or re-throw the parse error itself. Node >= 20 embeds a
      // window of the offending INPUT in SyntaxError.message ("... is not
      // valid JSON"), which for this payload is credential material.
      let credentials: Record<string, unknown>;
      try {
        credentials = JSON.parse(secretData) as Record<string, unknown>;
      } catch {
        throw new Error(`Invalid credentials format in secret`);
      }

      // NEO-141: `username` is the ONLY required field. Requiring `password`
      // here is what used to make a password-less secret — now the normal
      // steady state for every user — unreadable, surfacing as a 500 out of
      // GET /credentials/:key/token.
      if (typeof credentials.username !== "string" || credentials.username.length === 0) {
        throw new Error(`Invalid credentials format in secret`);
      }

      // Deliberately field-by-field rather than a spread: the stored JSON is
      // untrusted input and must not be able to inject arbitrary keys into a
      // Credentials object that is later handed to updateCredentials.
      //
      // The trap this list carries: a field MISSING from it is silently
      // dropped on read. Before NEO-141 the list stopped at expiresAt, so a
      // stored refreshToken would have round-tripped straight into oblivion —
      // written, then discarded on the very next read. Any new field added to
      // the Credentials interface MUST be added here too.
      const result: Credentials = { username: credentials.username };
      if (typeof credentials.password === "string") result.password = credentials.password;
      if (typeof credentials.token === "string") result.token = credentials.token;
      if (typeof credentials.expiresAt === "number") result.expiresAt = credentials.expiresAt;
      if (typeof credentials.refreshToken === "string") result.refreshToken = credentials.refreshToken;
      if (typeof credentials.refreshExpiresAt === "number") {
        result.refreshExpiresAt = credentials.refreshExpiresAt;
      }
      // NEO-278: the SSO cookie map is the one nested field. It goes through
      // the same untrusted-input narrowing as the flat ones, one level down.
      const ssoCookies = parseCookieMap(credentials.ssoCookies);
      if (ssoCookies) result.ssoCookies = ssoCookies;
      if (typeof credentials.ssoExpiresAt === "number") {
        result.ssoExpiresAt = credentials.ssoExpiresAt;
      }
      return result;
    } catch (error: any) {
      // Message only — an arbitrary error object graph from the GCP client
      // could carry the request payload, and this key's payload is secret.
      console.error(
        "Failed to retrieve credentials for key '%s': %s",
        key,
        error instanceof Error ? error.message : String(error),
      );
      // NEO-294: these two used to interpolate `key` — i.e. the per-user
      // clerk id — into a message that the SportLots adapter's catch then
      // put in an HTTP response body and Convex forwarded to PostHog. Every
      // other throw in this file is a fixed string; these are now too. The
      // routes match on substrings ("not found" / "No active version"), not
      // on the key, so the 404 mapping in routes/credentials.ts and
      // routes/easypost.ts is unaffected. The key is still in the structured
      // console.error above, which is where triage should read it.
      if (isNotFoundError(error)) {
        throw new Error(`Credentials not found`);
      }
      if (error.message && error.message.includes('No active version')) {
        throw new Error(`No active version found`);
      }
      throw new Error(`Failed to retrieve credentials`);
    }
  }

  /**
   * Deletes the secret for the given key outright, versions and all.
   *
   * (This docstring used to describe `updateCredentials` — it had drifted onto
   * the wrong method.) Idempotent: an already-absent secret is success.
   */
  async deleteCredentials(key: string): Promise<void> {
    validateKeyFormat(key);
    const secretName = `projects/${this.projectId}/secrets/${key}`;
    try {
      await this.client.deleteSecret({ name: secretName });
    } catch (err: any) {
      // If the secret doesn't exist, treat as success.
      //
      // NEO-294: this is the mirror of the create race and it is ALREADY
      // idempotent — two concurrent clears, or a clear racing a clear that
      // already landed, both converge on "the secret is gone", which is what
      // the caller asked for. Deleting a secret removes its versions with it,
      // so there is no delete-then-orphaned-version state to reconcile, and
      // Secret Manager leaves no tombstone, so the id is immediately reusable
      // by `updateCredentials`' create path.
      //
      // The one interleaving that is deliberately NOT swallowed lives on the
      // write side: a clear landing between another request's createSecret and
      // its addSecretVersion fails that write rather than re-creating the
      // secret. See addVersionCreatingIfAbsent.
      if (isNotFoundError(err)) {
        return;
      }
      console.error(
        "Failed to delete credentials for key '%s': %s",
        key,
        err instanceof Error ? err.message : String(err),
      );
      throw new Error(`Failed to delete credentials`);
    }
  }

  async credentialsExist(key: string): Promise<boolean> {
    validateKeyFormat(key);
    const secretName = `projects/${this.projectId}/secrets/${key}`;
    try {
      // NEO-385: the latest version, not a list. See accessLatest.
      await this.accessLatest(secretName);
      return true;
    } catch (err: any) {
      if (isNotFoundError(err) || isFailedPreconditionError(err)) {
        return false;
      }
      console.error(
        "Failed to check credentials existence for key '%s': %s",
        key,
        err instanceof Error ? err.message : String(err),
      );
      throw new Error('Failed to check credentials existence');
    }
  }

  async updateCredentials(key: string, credentials: Credentials): Promise<void> {
    validateKeyFormat(key);
    const secretId = key;
    const parent = `projects/${this.projectId}`;
    const secretName = `${parent}/secrets/${secretId}`;
    const payload = JSON.stringify(credentials);
    // Name of the version this call created. Prune uses it as the exclusion
    // key, so it must be captured on BOTH the normal and create-then-add
    // paths, and prune must be skipped entirely if we never learned it.
    let createdVersionName: string | null | undefined;
    try {
      createdVersionName = await this.addVersionCreatingIfAbsent(
        parent,
        secretId,
        secretName,
        payload,
      );
    } catch (err: any) {
      // Message only, and this is the sharpest case in the file: the failed
      // call is addSecretVersion, whose REQUEST carries the credential payload
      // itself. A GCP client error object can hold the request it failed on, so
      // logging the object would write the credential to Cloud Logging on any
      // transient write failure.
      //
      // NEO-294: this catch is now the ONLY exit from the write. Before, the
      // create-then-add branch ran INSIDE the catch, so a throw from
      // `createSecret` bypassed this sanitiser entirely and the raw GCP message
      // — which names the project number and the secret id — propagated out
      // through the adapter and into the login response body.
      console.error(
        "Failed to update credentials for key '%s': %s",
        key,
        err instanceof Error ? err.message : String(err),
      );
      throw new Error(`Failed to update credentials`);
    }

    // NEO-115: keep exactly one version. This is deliberately AFTER the write
    // succeeded and is best-effort — see destroyPreviousVersion.
    await this.destroyPreviousVersion(secretName, secretId, createdVersionName);
  }

  /**
   * Store `payload` as a new version of `secretName`, creating the secret first
   * if it does not exist yet. Returns the created version's resource name.
   *
   * ## Why this is not a plain "check, then create" (NEO-294)
   *
   * Secret Manager has no create-if-absent and no upsert: a write against a key
   * that may not exist is unavoidably two calls, and the gap between them is a
   * race. Both orderings are reachable in production and BOTH are now
   * fall-throughs rather than failures, so the operation is idempotent and
   * losing the race costs nothing:
   *
   *   - `addSecretVersion` → NOT_FOUND  ⇒ create the secret, then add.
   *   - `createSecret` → ALREADY_EXISTS ⇒ someone created it while we were
   *     deciding to. That is precisely the state we were trying to reach, so
   *     fall through and add the version to the secret that now exists.
   *
   * The observed failure: a BSC login read the secret (NOT_FOUND), performed a
   * REAL, SUCCESSFUL B2C sign-in, and then lost the create race ~1.9s later.
   * `createSecret` threw, the adapter reported the login as failed, and the
   * caller saw a 502 — for a marketplace login that had actually worked. On
   * SportLots the same shape burned the adapter's whole 5-attempt retry budget,
   * because every attempt re-ran the identical losing race.
   *
   * ## Why idempotence and not a lock
   *
   * A lock is the wrong instrument here. The writers are not merely two
   * requests in one process — they can be two Cloud Run instances, or two
   * Convex deployments (a preview has its own `userProfiles` table and
   * therefore its own operation lock) sharing one GCP project and one key. An
   * in-process mutex cannot see the other writer, and a distributed lock would
   * add a failure mode (a held lock outliving its holder) strictly worse than
   * the one it removes. Idempotence needs no coordination at all: whoever wins
   * the create, both writers end up adding a version to the same secret, which
   * is what each of them wanted.
   *
   * ## Why this cannot ping-pong
   *
   * The second `addSecretVersion` is a fall-through, not a retry: it runs at
   * most once, and there is no loop. If it ALSO reports NOT_FOUND, the secret
   * was deleted between our create and our add — a concurrent `clear`, i.e. an
   * operator deliberately removing this credential. That propagates as a
   * (sanitised) failure on purpose. Re-creating the secret there would
   * resurrect a credential the user had just asked us to destroy.
   */
  private async addVersionCreatingIfAbsent(
    parent: string,
    secretId: string,
    secretName: string,
    payload: string,
  ): Promise<string | null | undefined> {
    const addVersion = async (): Promise<string | null | undefined> => {
      const [created] = await withQuotaRetry(() =>
        this.client.addSecretVersion({
          parent: secretName,
          payload: { data: Buffer.from(payload, 'utf8') },
        }),
      );
      return created?.name;
    };

    try {
      return await addVersion();
    } catch (err: any) {
      if (!isNotFoundError(err)) throw err;
    }

    try {
      await this.client.createSecret({
        parent,
        secretId,
        secret: {
          replication: { automatic: {} },
        },
      });
    } catch (err: any) {
      if (!isAlreadyExistsError(err)) throw err;
      // NEO-294: the BARE secret id, never the fully-qualified resource name.
      // `secretName` is `projects/<project>/secrets/<id>`, so logging it would
      // write the GCP project identifier into Cloud Logging on every create
      // race — the exact identifier this ticket exists to keep out of the
      // error path. The id alone is enough to find the secret, and the project
      // is a property of the deployment the log line already came from.
      // Counts and ids only — never the payload, and never the raw error
      // object (which can carry the request that failed).
      console.log(
        "Secret '%s' was created concurrently; adding a version to the existing secret",
        secretId,
      );
    }

    return await addVersion();
  }

  /**
   * Destroys the one version a write superseded, so the secret keeps exactly
   * one live version.
   *
   * ## Why this exists
   *
   * Secret Manager never reclaims versions on its own and bills every version
   * that is not DESTROYED. The adapters write back a cached marketplace token
   * on every TTL expiry (BSC: hourly), so an untended per-user credential
   * secret accumulates versions forever (NEO-115). Nothing ever rolls back to
   * an older credential: a credential that stops working is re-saved by its
   * user. So the only version worth keeping is the newest.
   *
   * ## Why it does not list (NEO-385)
   *
   * This used to list every version and destroy the stale ones. A list is a
   * ListSecretVersions call, metered at 600/min per project, and it returns
   * every DESTROYED version too (600 to 700 of them on the CI test accounts'
   * secrets). Parallel E2E runs re-sign-in all eight test accounts at once,
   * which ran that quota out and turned token reads into 500s. Version
   * ordinals are strictly increasing per secret, so the version this write
   * superseded is addressable as `versions/<N-1>` with no list at all.
   *
   * ## Safety properties (all load-bearing)
   *
   * - **Best effort.** Every failure is swallowed with a log line. A user
   *   saving their marketplace credentials must never see an error because
   *   cleanup hiccuped; the write has already succeeded by the time we get
   *   here. NOT_FOUND and FAILED_PRECONDITION (already destroyed, e.g. by a
   *   concurrent writer) are the normal outcome of a race and are silent.
   * - **Never destroys the version we just wrote, nor a newer one.** Only
   *   `N-1` is ever addressed. With two overlapping writers, A adding v10 and
   *   B adding v11, A destroys v9 and B destroys v10, and v11, the newest,
   *   survives both. That is the interleaving that once zeroed a secret, when
   *   prune destroyed "everything but mine" (see git history).
   * - **Skipped when the created version is unknown.** Without the created
   *   name's ordinal there is no safe target, so nothing is destroyed.
   * - **No secret material and no infrastructure identifier is logged.** Only
   *   the BARE secret id and the version ordinal (NEO-294; `shortVersion`),
   *   never the fully-qualified `projects/<project>/...` name and never a
   *   raw error object.
   *
   * A secret that already carries several live versions from before NEO-115
   * keeps the older ones; the one-time cleanup for those is a script, not a
   * per-write cost.
   *
   * @param secretName Fully-qualified `projects/<p>/secrets/<id>` resource
   *   name. Addresses the API call; it is NEVER logged.
   * @param secretId The bare `<site>-credentials-<clerkUserId>` id, the
   *   log-safe form.
   * @param createdVersionName Resource name of the version this write added.
   */
  private async destroyPreviousVersion(
    secretName: string,
    secretId: string,
    createdVersionName: string | null | undefined,
  ): Promise<void> {
    const createdOrdinal = createdVersionName ? versionOrdinal(createdVersionName) : undefined;
    if (createdOrdinal === undefined) {
      console.error(
        "Skipping version prune for secret '%s': created version name unavailable or unparseable",
        secretId,
      );
      return;
    }
    if (createdOrdinal <= 1) return;

    const previous = `${secretName}/versions/${createdOrdinal - 1}`;
    try {
      await withQuotaRetry(() => this.client.destroySecretVersion({ name: previous }));
    } catch (err: any) {
      if (isNotFoundError(err) || isFailedPreconditionError(err)) return;
      console.error(
        "Failed to destroy secret version '%s': %s",
        shortVersion(secretId, previous),
        err instanceof Error ? err.message : String(err),
      );
    }
  }
} 