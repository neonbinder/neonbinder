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
    try {
      // Try to add a new version to the secret
      await this.client.addSecretVersion({
        parent: secretName,
        payload: { data: Buffer.from(payload, 'utf8') },
      });
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
        await this.client.addSecretVersion({
          parent: secretName,
          payload: { data: Buffer.from(payload, 'utf8') },
        });
      } else {
        console.error("Failed to update credentials for key '%s':", key, err);
        throw new Error(`Failed to update credentials`);
      }
    }
  }
} 