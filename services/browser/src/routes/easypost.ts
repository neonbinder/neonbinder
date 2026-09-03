import { Request, Response, Router } from "express";
import { SecretsManagerService } from "../services/secrets-manager";
import {
  createEasyPostClient,
  type PostalAddressLike,
} from "../services/easypost";

/**
 * NEO-120 — EasyPost postage, proxied because Convex must never hold the key.
 *
 * The seller's EasyPost API key spends their money. Per NEO-20's boundary, only
 * this service ever reads a per-user secret in plaintext — no route hands a
 * password back — so Convex cannot call EasyPost itself and asks us instead,
 * exactly as it already does for BSC and SportLots logins.
 *
 * Like those, this launches no Chromium. It is plain HTTP.
 *
 * Lives in a mountable Router (not index.ts) for the same reason the credential
 * CRUD routes do (NEO-141): index.ts calls app.listen() at import time, so a
 * test can only exercise handlers that are importable without it. The tests
 * mount THIS router over an in-memory store.
 *
 * ## Why this router has a write route when PUT /credentials/:key was removed
 *
 * NEO-141 deleted the generic credential write: marketplace passwords became
 * transient (used for one login, never stored), and a PUT against a live user
 * key wiped that user's token and rotating refresh token with no way to repair
 * it. Neither hazard exists here — an EasyPost API key IS the long-lived
 * credential (there is no login that mints a token from it, so it must be
 * stored to be usable later), and an easypost secret only ever holds the key,
 * so replace semantics cannot wipe anything else. The guard that keeps those
 * facts true is the key-prefix check below: every route in this router refuses
 * to touch a secret that is not an easypost secret.
 */

/**
 * Every route in this router — including the write — is scoped to easypost
 * secrets. A marketplace key here is a caller bug, and answering it would let
 * the write path touch secrets that DO carry tokens (recreating the NEO-141
 * hazard) and the read paths treat a canary's password as an EasyPost key.
 */
const EASYPOST_KEY_PATTERN = /^easypost-credentials-[a-zA-Z0-9_-]+$/;

/** Mirrors the cap in convex/postage.ts — no real EasyPost key is near it. */
const MAX_KEY_LENGTH = 256;

/**
 * EasyPost shipment ids are short (`shp_` + ~24 chars). The cap exists so a
 * path segment of arbitrary length cannot be pushed through to an upstream
 * URL; it is a sanity bound, not a format check.
 */
const MAX_SHIPMENT_ID_LENGTH = 100;

/**
 * The format check the cap above deliberately is not: `shp_` + alphanumerics,
 * which is every id EasyPost mints.
 *
 * This id is not ours. It is stored via a client-reachable path, so by the time
 * it comes back as `:shipmentId` it is caller-authored and gets treated as
 * untrusted input, not as something the system minted. Traversal was already
 * contained by the double encoding: Express decodes the segment once, and
 * `retrieveLabel` re-encodes it with encodeURIComponent before interpolating,
 * so a `../` cannot climb out of `/shipments/` upstream. This closes the
 * residual — an id that EasyPost could never have issued is refused here,
 * before the seller's stored key is read, instead of being spent on a request.
 */
const SHIPMENT_ID_PATTERN = /^shp_[A-Za-z0-9]+$/;

/**
 * The slice of SecretsManagerService these routes use. Injectable so the tests
 * can mount the router over an in-memory store (see routes/credentials.ts).
 */
export interface EasypostKeyStore {
  getCredentials(key: string): Promise<{ password?: string }>;
  updateCredentials(
    key: string,
    credentials: { username: string; password?: string },
  ): Promise<void>;
}

type EasyPostClientish = ReturnType<typeof createEasyPostClient>;

/** Map an EasyPostError kind onto a status the UI can act on. */
function easypostStatus(kind: string | undefined): number {
  switch (kind) {
    case "auth":
      return 401;
    case "address":
    case "no_rate":
      return 422;
    case "payment":
      return 402;
    case "timeout":
      return 504;
    default:
      return 502;
  }
}

function handleEasyPostFailure(err: unknown, res: Response, context: string) {
  const message = err instanceof Error ? err.message : "Unknown error";
  const kind = (err as { kind?: string })?.kind;

  // `kind` is checked FIRST, and that ordering is the contract, not a style
  // choice. Only EasyPostError carries a kind; the store throws plain Errors.
  // A 404 out of this router means exactly one thing to Convex — "no EasyPost
  // key saved for this user" — and that is what drives the "add your key"
  // prompt in the UI. EasyPost's own business messages routinely contain the
  // words "not found" (an unverifiable address, a shipment id that does not
  // resolve), so matching on the message before the kind would tell a seller
  // whose key is perfectly fine to go re-enter it.
  //
  // Forwarding EasyPost's message is deliberate too: these are
  // seller-actionable ("address not found", "insufficient funds"), and
  // swallowing them would leave the UI saying "something went wrong" for a
  // fixable typo. The key itself never appears in these messages.
  if (kind) {
    res.status(easypostStatus(kind)).json({ error: message, kind });
    return;
  }
  if (message.includes("Invalid credential key format")) {
    res.status(400).json({ error: "Invalid credential key format" });
    return;
  }
  if (message.includes("not found") || message.includes("No active version")) {
    res.status(404).json({ error: "No EasyPost key saved for this user" });
    return;
  }
  console.error(`${context} failed:`, err);
  res.status(502).json({ error: "EasyPost request failed" });
}

/**
 * Build the `/easypost/*` router.
 *
 * The store is constructed PER REQUEST (matching routes/credentials.ts) so a
 * client that fails to initialize cannot poison the whole process.
 *
 * Response contract matches NEO-141's: the stored key never appears in any
 * response body, and error bodies carry either a fixed string or an EasyPost
 * business message that cannot contain it.
 *
 * @param createStore Factory for the key store. Defaults to the real Secret
 *   Manager client.
 * @param createClient Factory for the EasyPost client, injectable for tests.
 */
export function createEasypostRouter(
  createStore: () => EasypostKeyStore = () => new SecretsManagerService(),
  createClient: (opts: { apiKey: string }) => EasyPostClientish = createEasyPostClient,
): Router {
  const router = Router();

  /** Load a seller's EasyPost key, or 404 (via the catch) if none is saved. */
  async function loadEasyPostKey(key: string): Promise<string> {
    const credentials = await createStore().getCredentials(key);
    // Stored via PUT /easypost/:key as {username: clerkUserId, password: key}.
    // An API key is not a password, but reusing the Credentials shape means no
    // new secret-handling code — see the note in convex/shipping.ts.
    if (!credentials.password) {
      throw new Error("No active version");
    }
    return credentials.password;
  }

  /** 400 on any key that is not an easypost secret; see EASYPOST_KEY_PATTERN. */
  function rejectNonEasypostKey(key: string, res: Response): boolean {
    if (!EASYPOST_KEY_PATTERN.test(key)) {
      res.status(400).json({ error: "Invalid credential key format" });
      return true;
    }
    return false;
  }

  /**
   * Store (or replace) a seller's EasyPost API key.
   *
   * This is the ONLY credential write reachable over HTTP since NEO-141, and it
   * stays safe by scope, not by care at the call sites: the prefix guard means
   * it cannot address a marketplace secret, so its replace-the-payload
   * semantics cannot wipe a token or refresh token — an easypost secret never
   * holds either. If this route ever grows past easypost keys, it inherits
   * NEO-141's merge-don't-replace requirement (see routes/credentials.ts).
   */
  router.put(
    "/easypost/:key",
    async (
      req: Request<{ key: string }, {}, { apiKey?: unknown }>,
      res: Response,
    ) => {
      const { key } = req.params;
      if (rejectNonEasypostKey(key, res)) return;

      const apiKey = req.body?.apiKey;
      if (typeof apiKey !== "string" || apiKey.trim() === "") {
        res.status(400).json({ error: "Missing required field: apiKey" });
        return;
      }
      if (apiKey.length > MAX_KEY_LENGTH) {
        res.status(400).json({ error: "apiKey exceeds maximum length" });
        return;
      }

      try {
        await createStore().updateCredentials(key, {
          username: key.replace(/^easypost-credentials-/, ""),
          password: apiKey.trim(),
        });
        res.json({ success: true, message: "EasyPost key stored" });
      } catch (err) {
        console.error(
          "Failed to store EasyPost key:",
          err instanceof Error ? err.message : String(err),
        );
        res.status(500).json({ error: "Failed to store EasyPost key" });
      }
    },
  );

  // Price a First-Class letter. Charges nothing.
  router.post(
    "/easypost/:key/rate",
    async (
      req: Request<
        { key: string },
        {},
        { to?: unknown; from?: unknown; weightOz?: number }
      >,
      res: Response,
    ) => {
      if (rejectNonEasypostKey(req.params.key, res)) return;
      const { to, from, weightOz } = req.body || {};
      if (!to || !from || typeof weightOz !== "number" || weightOz <= 0) {
        res.status(400).json({ error: "Missing required fields: to, from, weightOz" });
        return;
      }
      try {
        const apiKey = await loadEasyPostKey(req.params.key);
        const client = createClient({ apiKey });
        res.json(
          await client.quoteLetterRate({
            to: to as PostalAddressLike,
            from: from as PostalAddressLike,
            weightOz,
          }),
        );
      } catch (err) {
        handleEasyPostFailure(err, res, "EasyPost rate");
      }
    },
  );

  // Buy a previously-quoted rate. THIS SPENDS THE SELLER'S MONEY.
  router.post(
    "/easypost/:key/buy",
    async (
      req: Request<{ key: string }, {}, { shipmentId?: string; rateId?: string }>,
      res: Response,
    ) => {
      if (rejectNonEasypostKey(req.params.key, res)) return;
      const { shipmentId, rateId } = req.body || {};
      if (!shipmentId || !rateId) {
        res.status(400).json({ error: "Missing required fields: shipmentId, rateId" });
        return;
      }
      try {
        const apiKey = await loadEasyPostKey(req.params.key);
        const client = createClient({ apiKey });
        res.json(await client.buyLabel({ shipmentId, rateId }));
      } catch (err) {
        handleEasyPostFailure(err, res, "EasyPost buy");
      }
    },
  );

  /**
   * Re-fetch the label for an already-bought shipment so it can be reprinted
   * (NEO-213). Read-only and free — it buys nothing.
   *
   * The URL is fetched rather than stored because EasyPost's `label_url` is a
   * time-limited link into a file it keeps for 180 days; a URL captured at
   * purchase time goes stale long before the label does.
   *
   * A shipment EasyPost cannot find is a 502 here, not a 404. 404 from this
   * router means "no EasyPost key saved for this user" and nothing else — see
   * handleEasyPostFailure.
   */
  router.get(
    "/easypost/:key/label/:shipmentId",
    async (
      req: Request<{ key: string; shipmentId: string }>,
      res: Response,
    ) => {
      if (rejectNonEasypostKey(req.params.key, res)) return;

      const shipmentId = (req.params.shipmentId ?? "").trim();
      if (
        !shipmentId ||
        shipmentId.length > MAX_SHIPMENT_ID_LENGTH ||
        !SHIPMENT_ID_PATTERN.test(shipmentId)
      ) {
        res.status(400).json({ error: "Invalid shipmentId" });
        return;
      }

      try {
        const apiKey = await loadEasyPostKey(req.params.key);
        const client = createClient({ apiKey });
        res.json(await client.retrieveLabel({ shipmentId }));
      } catch (err) {
        handleEasyPostFailure(err, res, "EasyPost label retrieve");
      }
    },
  );

  return router;
}
