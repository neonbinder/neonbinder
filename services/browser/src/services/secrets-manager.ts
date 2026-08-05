import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

export interface Credentials {
  username: string;
  password: string;
  token?: string;
  expiresAt?: number;
}

const KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/;

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
      const credentials = JSON.parse(secretData);

      if (!credentials.username || !credentials.password) {
        throw new Error(`Invalid credentials format in secret: ${key}`);
      }

      return {
        username: credentials.username,
        password: credentials.password,
        token: credentials.token,
        expiresAt: credentials.expiresAt
      };
    } catch (error: any) {
      console.error("Failed to retrieve credentials for key '%s':", key, error);
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
      console.error('Failed to list secrets:', error);
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
      console.error("Failed to delete credentials for key '%s':", key, err);
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
      console.error("Failed to check credentials existence for key '%s':", key, err);
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
        console.error("Failed to update credentials for key '%s':", key, err);
        throw new Error(`Failed to update credentials`);
      }
    }

    // NEO-115: keep exactly one version. This is deliberately AFTER the write
    // succeeded and is best-effort — see pruneToNewestVersion.
    await this.pruneToNewestVersion(secretName, createdVersionName);
  }

  /**
   * Destroys every version of `secretName` except `keepVersionName`, leaving
   * the secret with exactly one live version.
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
   * - **Keep-1 means no history.** A `Credentials` payload carries the durable
   *   username/password, not just the ephemeral token, so there is no version
   *   to roll back to. An interrupted write leaves the user re-entering their
   *   credentials in Profile. This trade was made deliberately.
   * - **No secret material is logged.** Only version RESOURCE NAMES and error
   *   messages reach the log; payloads are never read here (listSecretVersions
   *   returns metadata only, never `payload`), and errors are reduced to their
   *   message so no arbitrary object graph is spilled into Cloud Logging.
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

    try {
      const [versions] = await this.client.listSecretVersions({ parent: secretName });
      for (const version of versions) {
        if (!version.name || version.name === keepVersionName) {
          continue;
        }
        // ENABLED and DISABLED both bill and both accept destroy. DESTROYED
        // (and STATE_UNSPECIFIED) must be skipped: destroying an already
        // destroyed version is a FAILED_PRECONDITION error.
        if (version.state !== 'ENABLED' && version.state !== 'DISABLED') {
          continue;
        }
        try {
          await this.client.destroySecretVersion({ name: version.name });
        } catch (err: any) {
          // One version failing must not stop the rest of the sweep.
          console.error(
            "Failed to destroy secret version '%s': %s",
            version.name,
            err instanceof Error ? err.message : String(err),
          );
        }
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