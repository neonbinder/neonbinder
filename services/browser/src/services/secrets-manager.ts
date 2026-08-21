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
  /** BSC only. Epoch ms at which `refreshToken` stops being usable. */
  refreshExpiresAt?: number;
}

const KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/;

/**
 * Hard cap on how many stale versions a single credential write may destroy.
 *
 * NEO-115 follow-up. The first cut of the prune destroyed *every* stale version
 * inline and sequentially. On a secret that had accumulated a backlog
 * (`buysportscards-credentials-user_3DPlQ…` was at 203 enabled versions) that
 * meant ~202 serialised `destroySecretVersion` round trips inside the
 * user-facing write, and the BSC login write-back went from 0.6s to **42s** —
 * enough to fail the E2E `setup.yaml` BSC-auth step on PR #126. This project
 * treats any response over 7s as a real bug, so the prune must be bounded, not
 * merely "eventually fast".
 *
 * A backlogged secret converges over successive writes instead of paying the
 * whole cost at once: 10 per write, and BSC writes hourly. In steady state
 * (i.e. after the one-time bulk cleanup) there is exactly ONE stale version per
 * write — the one this write superseded — so the cap is never reached and the
 * prune costs a single destroy.
 */
const MAX_DESTROYS_PER_WRITE = 10;

/**
 * Extract the monotonically-increasing version ordinal from a Secret Manager
 * version resource name (`projects/<p>/secrets/<s>/versions/<N>`).
 *
 * Secret Manager assigns N in strictly increasing order per secret, so the
 * ordinal is a total order on "which write happened first" that needs no extra
 * API call. pruneToNewestVersion uses it to refuse to destroy anything NEWER
 * than the version it is keeping — see there for the interleaving that made
 * this necessary.
 *
 * @returns the ordinal, or undefined if the name does not end in `/versions/N`.
 */
function versionOrdinal(versionName: string): number | undefined {
  const match = /\/versions\/(\d+)$/.exec(versionName);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
  async getCredentials(key: string): Promise<Credentials> {
    validateKeyFormat(key);
    try {
      const secretName = `projects/${this.projectId}/secrets/${key}`;
      
      const [versions] = await this.client.listSecretVersions({
        parent: secretName,
      });

      const activeVersion = versions.find(v => v.state === 'ENABLED');
      if (!activeVersion?.name) {
        throw new Error(`No active version found for secret: ${key}`);
      }

      const [version] = await this.client.accessSecretVersion({
        name: activeVersion.name,
      });

      if (!version.payload?.data) {
        throw new Error(`No data found in secret: ${key}`);
      }

      const secretData = version.payload.data.toString();
      // NEVER log or re-throw the parse error itself. Node >= 20 embeds a
      // window of the offending INPUT in SyntaxError.message ("... is not
      // valid JSON"), which for this payload is credential material.
      let credentials: Record<string, unknown>;
      try {
        credentials = JSON.parse(secretData) as Record<string, unknown>;
      } catch {
        throw new Error(`Invalid credentials format in secret: ${key}`);
      }

      // NEO-141: `username` is the ONLY required field. Requiring `password`
      // here is what used to make a password-less secret — now the normal
      // steady state for every user — unreadable, surfacing as a 500 out of
      // GET /credentials/:key/token.
      if (typeof credentials.username !== "string" || credentials.username.length === 0) {
        throw new Error(`Invalid credentials format in secret: ${key}`);
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
      return result;
    } catch (error: any) {
      // Message only — an arbitrary error object graph from the GCP client
      // could carry the request payload, and this key's payload is secret.
      console.error(
        "Failed to retrieve credentials for key '%s': %s",
        key,
        error instanceof Error ? error.message : String(error),
      );
      if (error.code === 5 || (error.message && error.message.includes('not found'))) {
        throw new Error(`Credentials not found for key: ${key}`);
      }
      if (error.message && error.message.includes('No active version')) {
        throw new Error(`No active version found for key: ${key}`);
      }
      throw new Error(`Failed to retrieve credentials`);
    }
  }

  async listSecrets(): Promise<string[]> {
    try {
      const [secrets] = await this.client.listSecrets({
        parent: `projects/${this.projectId}`,
      });

      return secrets.map(secret => {
        const name = secret.name || '';
        return name.split('/').pop() || '';
      });
    } catch (error) {
      // Message only — same rule as getCredentials' catch below.
      console.error(
        'Failed to list secrets: %s',
        error instanceof Error ? error.message : String(error),
      );
      return [];
    }
  }

  /**
   * Updates (adds a new version to) the secret with the given key, storing the provided credentials object as JSON.
   * If the secret does not exist, it will be created.
   */
  async deleteCredentials(key: string): Promise<void> {
    validateKeyFormat(key);
    const secretName = `projects/${this.projectId}/secrets/${key}`;
    try {
      await this.client.deleteSecret({ name: secretName });
    } catch (err: any) {
      // If the secret doesn't exist, treat as success
      if (err.code === 5 || (err.message && err.message.includes('not found'))) {
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
      const [versions] = await this.client.listSecretVersions({ parent: secretName });
      return versions.some(v => v.state === 'ENABLED');
    } catch (err: any) {
      if (err.code === 5 || (err.message && err.message.includes('not found'))) {
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
      // Try to add a new version to the secret
      const [created] = await this.client.addSecretVersion({
        parent: secretName,
        payload: { data: Buffer.from(payload, 'utf8') },
      });
      createdVersionName = created?.name;
    } catch (err: any) {
      // If the secret does not exist, create it and then add the version
      if (err.code === 5 || (err.message && err.message.includes('not found'))) {
        // Create the secret
        await this.client.createSecret({
          parent,
          secretId,
          secret: {
            replication: { automatic: {} },
          },
        });
        // Add the version
        const [created] = await this.client.addSecretVersion({
          parent: secretName,
          payload: { data: Buffer.from(payload, 'utf8') },
        });
        createdVersionName = created?.name;
      } else {
        // Message only, and this one is the sharpest case in the file: the
        // failed call is addSecretVersion, whose REQUEST carries the credential
        // payload itself. A GCP client error object can hold the request it
        // failed on, so logging the object would write the credential to Cloud
        // Logging on any transient write failure.
        console.error(
          "Failed to update credentials for key '%s': %s",
          key,
          err instanceof Error ? err.message : String(err),
        );
        throw new Error(`Failed to update credentials`);
      }
    }

    // NEO-115: keep exactly one version. This is deliberately AFTER the write
    // succeeded and is best-effort — see pruneToNewestVersion.
    await this.pruneToNewestVersion(secretName, createdVersionName);
  }

  /**
   * Destroys up to `MAX_DESTROYS_PER_WRITE` versions of `secretName` other
   * than `keepVersionName`, converging the secret on exactly one live version.
   *
   * ## Why this exists
   *
   * Secret Manager never reclaims versions on its own and bills every version
   * that is not DESTROYED. The adapters write back a cached marketplace token
   * on every TTL expiry (BSC: hourly), so an untended per-user credential
   * secret accumulates versions forever — the state that put neonbinder-dev at
   * 1,326 live versions across 33 secrets.
   *
   * ## Security / safety properties (all load-bearing)
   *
   * - **Best effort.** Every failure path is swallowed with a console.error.
   *   A user saving their marketplace password must never see an error because
   *   version cleanup hiccuped; the credential write has already succeeded by
   *   the time we get here.
   * - **Never destroys the version we just wrote.** Exclusion is by explicit
   *   resource name returned from addSecretVersion, never by "newest in list
   *   order" — list order is a race against a concurrent write from another
   *   Cloud Run instance. If the created name is unknown we prune nothing at
   *   all rather than guess.
   * - **Never destroys a version NEWER than the one we kept.** Excluding only
   *   our own version is not enough once two writers overlap, and they can:
   *   the Convex per-(user,site) lock serialises writers within ONE deployment,
   *   but a preview deployment has its own `userProfiles` table (its own lock)
   *   while sharing the dev browser service, the dev GCP project and the same
   *   per-worker Clerk test users — so a dev-branch E2E run overlapping a
   *   preview E2E run on the same worker index is two unsynchronised writers on
   *   one key. The interleaving that used to zero the secret:
   *
   *     A adds v10, B adds v11
   *     A prunes: keeps v10, destroys v11   ← B's write, gone
   *     B prunes: keeps v11 (already dead), destroys v10
   *     → ZERO enabled versions
   *
   *   getCredentials then throws "No active version", the route answers
   *   404 `{"error":"Credentials not found"}`, Convex string-matches that into
   *   `not_found` and calls removeSiteCredentialStatus — credential and status
   *   flag both destroyed, from two ordinary concurrent logins.
   *
   *   The guard: version resource names end in `/versions/N` with N strictly
   *   increasing per secret, so refusing to destroy any ordinal above the kept
   *   one is enough, and costs no extra API call. Under the interleaving above
   *   A now skips v11, B still keeps v11, and v11 survives both prunes. A
   *   version whose ordinal cannot be parsed is skipped rather than destroyed:
   *   an unrecognisable name is not evidence that it is stale.
   * - **Keep-1 means no history.** There is no prior version to roll back to;
   *   the write that just landed is the only copy.
   *
   *   NEO-141 changed what that costs, and the change is worth stating
   *   because the old rationale is now wrong. This comment used to justify
   *   keep-1 by "the payload carries the durable username/password", i.e. the
   *   secret was mostly re-derivable-from-nothing durable state. It is not any
   *   more: a user payload is `{username, token, expiresAt, refreshToken?,
   *   refreshExpiresAt?}` and every field except the username is a session
   *   credential with a lifetime. Losing it does NOT send the user back to
   *   Profile to re-type a password (there is no stored password to lose) — it
   *   costs one re-authentication: a refresh grant, or a fresh sign-in if the
   *   refresh chain was what got interrupted.
   *
   *   That is a cheaper failure than the one this used to describe, so the
   *   trade still holds. It is also a LOUDER one: the rotated refresh token is
   *   single-use, so a half-completed write is not recoverable by retrying the
   *   read. Hence the ordering below — prune only ever runs AFTER the new
   *   version is durably written and its name is known.
   * - **No secret material is logged.** Only version RESOURCE NAMES, counts
   *   and error messages reach the log; payloads are never read here
   *   (listSecretVersions returns metadata only, never `payload`), and errors
   *   are reduced to their message so no arbitrary object graph is spilled
   *   into Cloud Logging.
   * - **Bounded and concurrent.** At most MAX_DESTROYS_PER_WRITE destroys are
   *   issued, and they run together rather than one-at-a-time, so the prune
   *   can never dominate the latency of the credential write it follows. See
   *   the constant for the 42s incident that forced this.
   *
   * @param secretName Fully-qualified `projects/<p>/secrets/<id>` resource name.
   * @param keepVersionName Resource name of the version to preserve. When
   *   null/undefined the prune is skipped — destroying "everything else" with
   *   no known survivor would destroy the credential we just stored.
   */
  private async pruneToNewestVersion(
    secretName: string,
    keepVersionName: string | null | undefined,
  ): Promise<void> {
    if (!keepVersionName) {
      // addSecretVersion succeeded but returned no name. Pruning now could
      // destroy the version we just wrote, so do nothing.
      console.error(
        "Skipping version prune for secret '%s': created version name unavailable",
        secretName,
      );
      return;
    }

    const keptOrdinal = versionOrdinal(keepVersionName);
    if (keptOrdinal === undefined) {
      // Same posture as an unknown created name: without an ordinal for the
      // survivor we cannot tell a stale version from a concurrent writer's
      // newer one, and guessing wrong destroys a live credential.
      console.error(
        "Skipping version prune for secret '%s': created version name has no parseable ordinal",
        secretName,
      );
      return;
    }

    try {
      const [versions] = await this.client.listSecretVersions({ parent: secretName });

      // Select at most MAX_DESTROYS_PER_WRITE stale versions, then stop
      // walking. The cap is what keeps a backlogged secret from turning a
      // credential write into a 42-second request; see the constant.
      const stale: string[] = [];
      for (const version of versions) {
        if (stale.length >= MAX_DESTROYS_PER_WRITE) {
          break;
        }
        if (!version.name || version.name === keepVersionName) {
          continue;
        }
        // ENABLED and DISABLED both bill and both accept destroy. DESTROYED
        // (and STATE_UNSPECIFIED) must be skipped: destroying an already
        // destroyed version is a FAILED_PRECONDITION error.
        if (version.state !== 'ENABLED' && version.state !== 'DISABLED') {
          continue;
        }
        // Concurrency guard: anything numbered above the version we kept was
        // written AFTER it, by someone else, and destroying it is how two
        // overlapping writers leave a secret with no enabled version at all.
        // An unparseable ordinal is skipped for the same reason.
        const ordinal = versionOrdinal(version.name);
        if (ordinal === undefined || ordinal > keptOrdinal) {
          continue;
        }
        stale.push(version.name);
      }

      if (stale.length === 0) {
        return;
      }

      // Concurrent, not serialised: the old `for … await` loop paid one full
      // round trip per version. allSettled also means a single rejection can
      // neither abort its siblings nor escape as an unhandled rejection.
      //
      // This is deliberately AWAITED rather than fired and forgotten: Cloud Run
      // may freeze or reclaim the container once the response is written, so
      // detached work is not reliably completed and its failures would be
      // unobservable.
      const results = await Promise.allSettled(
        stale.map((name) => this.client.destroySecretVersion({ name })),
      );
      results.forEach((result, i) => {
        if (result.status === 'rejected') {
          const err = result.reason;
          console.error(
            "Failed to destroy secret version '%s': %s",
            stale[i],
            err instanceof Error ? err.message : String(err),
          );
        }
      });

      if (stale.length === MAX_DESTROYS_PER_WRITE) {
        // Backlog remains; the next write takes another batch. Counts and
        // resource names only — never payloads.
        console.log(
          "Pruned %d version(s) of secret '%s' (per-write cap reached; more remain)",
          stale.length,
          secretName,
        );
      }
    } catch (err: any) {
      console.error(
        "Failed to prune old versions for secret '%s': %s",
        secretName,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
} 