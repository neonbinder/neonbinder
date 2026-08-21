import { Request, Response, Router } from "express";
import { Credentials, SecretsManagerService } from "../services/secrets-manager";

/**
 * The slice of SecretsManagerService the credential routes actually use.
 *
 * Exists so the routes can be mounted over an in-memory store in tests. Before
 * NEO-141 the test suite could not import these handlers at all — src/index.ts
 * calls app.listen() at module load — so tests/credentials-routes.test.mjs
 * re-implemented every handler in-process and therefore could not catch route
 * drift. That is how GET /credentials/:key/token shipped with no test at all.
 */
export interface CredentialsStore {
  getCredentials(key: string): Promise<Credentials>;
  updateCredentials(key: string, credentials: Credentials): Promise<void>;
  deleteCredentials(key: string): Promise<void>;
  credentialsExist(key: string): Promise<boolean>;
}

/**
 * Build the `/credentials/*` router.
 *
 * The store is constructed PER REQUEST (matching the previous inline handlers)
 * so a client that fails to initialize cannot poison the whole process.
 *
 * ## Response contract (NEO-141)
 *
 * Every handler returns status + business metadata only. `password`, `token`,
 * and `refreshToken` values never appear in a response body, and error bodies
 * carry fixed strings — never a raw error message.
 *
 * @param createStore Factory for the credential store. Defaults to the real
 *   Secret Manager client.
 */
export function createCredentialsRouter(
  createStore: () => CredentialsStore = () => new SecretsManagerService(),
): Router {
  const router = Router();

  // NOTE: there is deliberately no PUT /credentials/:key.
  //
  // It was the credential-seed write, and NEO-141 left it with zero production
  // callers — Convex's saveCredentials no longer issues one (a Convex test
  // asserts that), and the password it still accepted was silently discarded.
  // Its blast radius went UP as its usefulness went to zero: `updateCredentials`
  // replaces the whole payload and prunes to one version, so a PUT against a
  // live user key wiped that user's token AND their rotating refresh token —
  // and with no stored password there is no longer any server-side way to
  // repair that. Credentials are now created by the first successful
  // POST /login/<site> (updateCredentials creates the secret when absent).
  //
  // If a seed path is ever needed again, it must MERGE into the existing
  // payload rather than replace it.

  /**
   * Credential metadata — the only endpoint that reports on a secret's
   * contents, and it reports BOOLEANS and expiries, never values.
   */
  router.get(
    "/credentials/:key/metadata",
    async (req: Request<{ key: string }>, res: Response) => {
      try {
        const credentials = await createStore().getCredentials(req.params.key);
        res.json({
          username: credentials.username,
          hasToken: !!credentials.token,
          expiresAt: credentials.expiresAt,
          // NEO-141: booleans + expiry so the caller can tell "session lapsed,
          // prompt a sign-in" from "session renewable without the user".
          hasRefreshToken: !!credentials.refreshToken,
          refreshExpiresAt: credentials.refreshExpiresAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message.includes("Invalid credential key format")) {
          res.status(400).json({ error: "Invalid credential key format" });
        } else if (message.includes("not found") || message.includes("No active version")) {
          res.status(404).json({ error: "Credentials not found" });
        } else {
          console.error("Failed to retrieve credential metadata:", message);
          res.status(500).json({ error: "Failed to retrieve credential metadata" });
        }
      }
    },
  );

  /**
   * Return the cached token for internal adapter use.
   *
   * ## The 404 conflation this fixes (NEO-141)
   *
   * This route used to answer 404 to TWO unrelated conditions, distinguished
   * only by the body string:
   *
   *   - `{"error":"No token available"}`  — the secret exists, it just has no
   *     cached token yet. Completely NORMAL: it is the state of every freshly
   *     stored credential, and of every credential whose token has been pruned.
   *   - `{"error":"Credentials not found"}` — the secret genuinely does not
   *     exist or has no enabled version.
   *
   * Convex read only the STATUS CODE, so it treated the first as proof of
   * absence and DELETED the user's credential status — destroying working
   * credentials because they had not been used yet.
   *
   * The two now differ where it counts:
   *
   *   204 No Content — secret exists, no cached token. Empty body.
   *   404            — secret absent / no active version.
   *   400            — malformed key.
   *   200            — `{token, expiresAt}`.
   *
   * A password-less secret used to come back 500 here as collateral damage,
   * because getCredentials required a `password` field. That requirement is
   * gone, so a secret holding only `{username, token}` now reads normally.
   */
  router.get(
    "/credentials/:key/token",
    async (req: Request<{ key: string }>, res: Response) => {
      try {
        const credentials = await createStore().getCredentials(req.params.key);
        if (!credentials.token) {
          // 204, not 404. The secret is present and healthy; there is simply
          // nothing cached. An empty body is the point — any body here would
          // invite a caller to start string-matching it again.
          res.status(204).end();
          return;
        }
        res.json({
          token: credentials.token,
          expiresAt: credentials.expiresAt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message.includes("Invalid credential key format")) {
          res.status(400).json({ error: "Invalid credential key format" });
        } else if (message.includes("not found") || message.includes("No active version")) {
          res.status(404).json({ error: "Credentials not found" });
        } else {
          console.error("Failed to retrieve token:", message);
          res.status(500).json({ error: "Failed to retrieve token" });
        }
      }
    },
  );

  router.delete(
    "/credentials/:key",
    async (req: Request<{ key: string }>, res: Response) => {
      try {
        await createStore().deleteCredentials(req.params.key);
        res.json({ success: true, message: "Credentials deleted" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message.includes("Invalid credential key format")) {
          res.status(400).json({ error: "Invalid credential key format" });
        } else {
          console.error("Failed to delete credentials:", message);
          res.status(500).json({ error: "Failed to delete credentials" });
        }
      }
    },
  );

  router.post(
    "/credentials/check",
    async (req: Request<{}, {}, { keys?: unknown }>, res: Response) => {
      const keys = req.body?.keys;
      if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) {
        res
          .status(400)
          .json({ error: "Invalid request body: 'keys' must be an array of strings" });
        return;
      }
      try {
        const store = createStore();
        const results: Record<string, boolean> = {};
        await Promise.all(
          (keys as string[]).map(async (key) => {
            results[key] = await store.credentialsExist(key);
          }),
        );
        res.json({ results });
      } catch (err) {
        console.error(
          "Failed to check credentials:",
          err instanceof Error ? err.message : String(err),
        );
        res.status(500).json({ error: "Failed to check credentials" });
      }
    },
  );

  return router;
}
