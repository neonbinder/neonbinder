import { Request, Response, Router } from "express";
import { SecretsManagerService } from "../services/secrets-manager";
import {
  createEasyPostClient,
  redactWebhookToken,
  type PostalAddressLike,
} from "../services/easypost";

/**
 * Re-exported so the webhook-token scrubber is reachable from the same module
 * as the handler that applies it. Defined in services/easypost.ts, where it
 * also runs on every message EasyPost hands back.
 */
export { redactWebhookToken };

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

/** NEO-121. `hook_` + alphanumerics is every webhook id EasyPost mints. */
const WEBHOOK_ID_PATTERN = /^hook_[A-Za-z0-9]+$/;

/** Same sanity bound as MAX_SHIPMENT_ID_LENGTH, for the same reason. */
const MAX_WEBHOOK_ID_LENGTH = 100;

/**
 * NEO-121 — THE control that stops this router being an arbitrary-URL webhook
 * registration primitive.
 *
 * Without it, anything that can reach `POST /easypost/:key/webhooks` can point
 * a seller's EasyPost account at any endpoint on the internet, and that
 * registration OUTLIVES NeonBinder: it keeps delivering that seller's shipment
 * data to a third party long after the key is cleared here. The only URLs this
 * feature ever needs are Convex HTTP-action sites, which are always
 * `<deployment>.convex.site` — dev, prod and every preview alike.
 *
 * Checked against the PARSED hostname, never the raw string, so
 * `https://x.convex.site.evil.com/…` (suffix in the middle) and
 * `https://evil.com/?x=.convex.site` are both refused. The leading dot matters:
 * it is what makes `notconvex.site` fail.
 */
const WEBHOOK_HOST_SUFFIX = ".convex.site";

/**
 * The webhook secret is the HMAC key Convex verifies event bodies with. The
 * floor is the real control — 32 chars is the base64url rendering of far less
 * entropy than the 32 random bytes Convex mints, so anything shorter is a
 * caller bug, not a short-but-fine secret. The ceiling is a sanity bound.
 */
const MIN_WEBHOOK_SECRET_LENGTH = 32;
const MAX_WEBHOOK_SECRET_LENGTH = 256;

/** A Convex site URL plus a 43-char token is ~120 chars. 512 is generous. */
const MAX_WEBHOOK_URL_LENGTH = 512;

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
  /**
   * NEO-121. Added so the EasyPost key delete can move OFF the credentials
   * router, whose `DELETE /credentials/:key` carries no prefix guard at all —
   * it will happily delete a marketplace secret for a caller that meant to
   * clear a postage key. Every EasyPost key operation is now scoped by
   * EASYPOST_KEY_PATTERN, with no exceptions.
   */
  deleteCredentials(key: string): Promise<void>;
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
    // NEO-121. 400, not 422: `invalid_input` means the client refused to call
    // EasyPost at all, so nothing about the request was ever "well-formed but
    // unprocessable upstream" — the caller sent something wrong.
    case "invalid_input":
      return 400;
    // NEO-121. 409, deliberately NOT 422. 422 in this router already means
    // "your input is wrong, fix it and retry" (a bad address, an unrateable
    // weight). `no_tracker` is the opposite: the input is perfect and the
    // shipment simply is not yet in a state that HAS a tracker. Conflict
    // carries "correct request, wrong state, try later", which is what the
    // seller-facing "no scans yet" needs to mean.
    case "no_tracker":
      return 409;
    default:
      return 502;
  }
}

function handleEasyPostFailure(err: unknown, res: Response, context: string) {
  // NEO-121: scrubbed before it can reach a response body OR a log line.
  // EasyPost quotes the URL it rejected in its own error text, and that URL
  // carries the seller's webhook bearer token. services/easypost.ts already
  // redacts on the way out of the client; this is the second gate, so a
  // message reaching here from anywhere else is still safe.
  const message = redactWebhookToken(
    err instanceof Error ? err.message : "Unknown error",
  );
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
  // The redacted message only — never `err`, whose stack and `cause` can carry
  // the full URL (token and all) that the message above no longer does.
  console.error(`${context} failed:`, message);
  res.status(502).json({ error: "EasyPost request failed" });
}

/**
 * NEO-121 — is this a URL we are willing to register on a seller's account?
 *
 * Returns the URL to send, or undefined to refuse. Exported so the allowlist
 * can be pinned directly, without a route, a store, or a client.
 *
 * Every rejection returns the SAME undefined and the caller answers with a
 * fixed string: the URL under test contains the seller's bearer token, so it
 * is never quoted back in an error, and no response distinguishes "bad scheme"
 * from "bad host" (nothing here is worth building an oracle out of, and there
 * is nothing for the caller to do differently either way).
 */
export function validateWebhookUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_WEBHOOK_URL_LENGTH) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  // https only — the URL carries a bearer token in its path, so plaintext is
  // not a downgrade we accept anywhere, including on a preview.
  if (parsed.protocol !== "https:") return undefined;

  // `https://evil.com@x.convex.site/…` parses with hostname x.convex.site and
  // would pass a naive host check while handing EasyPost userinfo we never
  // meant it to send. There is no legitimate userinfo on a Convex site URL.
  if (parsed.username || parsed.password) return undefined;

  // Parsed hostname, not the raw string: `https://x.convex.site.evil.com/…`
  // and `https://evil.com/?to=.convex.site` both fail here, and both would
  // pass a substring test on the whole URL.
  if (!parsed.hostname.toLowerCase().endsWith(WEBHOOK_HOST_SUFFIX)) {
    return undefined;
  }

  return trimmed;
}

/**
 * NEO-121 — the HMAC secret Convex will verify event bodies with.
 *
 * Deliberately NOT trimmed and NOT normalised: every byte is part of the key,
 * and silently altering it here would produce a webhook whose signatures never
 * verify — a failure that shows up only when a real scan event arrives.
 */
export function isValidWebhookSecret(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    raw.length >= MIN_WEBHOOK_SECRET_LENGTH &&
    raw.length <= MAX_WEBHOOK_SECRET_LENGTH
  );
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

  /**
   * NEO-121 — the current tracker for an already-bought shipment.
   *
   * Read-only and free. Same guards as the label route because it is the same
   * untrusted input: `:shipmentId` reaches us caller-authored, so an id
   * EasyPost could never have minted is refused BEFORE the seller's stored key
   * is read, rather than being spent on a request.
   *
   * A shipment with no tracker yet answers 409 `no_tracker`, not 404 — 404
   * from this router means "no EasyPost key saved" and nothing else.
   */
  router.get(
    "/easypost/:key/tracker/:shipmentId",
    async (req: Request<{ key: string; shipmentId: string }>, res: Response) => {
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
        res.json(await client.retrieveTracker({ shipmentId }));
      } catch (err) {
        handleEasyPostFailure(err, res, "EasyPost tracker retrieve");
      }
    },
  );

  /**
   * NEO-121 — list the webhooks on a seller's account, for reconciliation.
   *
   * Convex reads this before it registers anything so that a lost create
   * response cannot leave a second hook behind delivering duplicate events.
   *
   * The response carries webhook URLs, which contain path tokens. That is the
   * point — the caller is the only party that could already know them — but
   * nothing on this path logs a URL.
   */
  router.get(
    "/easypost/:key/webhooks",
    async (req: Request<{ key: string }>, res: Response) => {
      if (rejectNonEasypostKey(req.params.key, res)) return;
      try {
        const apiKey = await loadEasyPostKey(req.params.key);
        const client = createClient({ apiKey });
        res.json({ webhooks: await client.listWebhooks() });
      } catch (err) {
        handleEasyPostFailure(err, res, "EasyPost webhook list");
      }
    },
  );

  /**
   * NEO-121 — register a webhook on a seller's EasyPost account.
   *
   * The host allowlist below is the control that keeps this from being a
   * general-purpose "point this seller's account anywhere" primitive; see
   * validateWebhookUrl for why that matters more than it looks.
   *
   * Both validations run BEFORE the stored key is read, so a malformed
   * request never touches Secret Manager. Both answer with a fixed string:
   * the URL carries a bearer token and the secret is a secret, so neither is
   * ever echoed back, not even to say what was wrong with it.
   */
  router.post(
    "/easypost/:key/webhooks",
    async (
      req: Request<{ key: string }, {}, { url?: unknown; secret?: unknown }>,
      res: Response,
    ) => {
      if (rejectNonEasypostKey(req.params.key, res)) return;

      const url = validateWebhookUrl(req.body?.url);
      if (!url) {
        res.status(400).json({ error: "Invalid webhook url" });
        return;
      }
      const secret = req.body?.secret;
      if (!isValidWebhookSecret(secret)) {
        res.status(400).json({ error: "Invalid webhook secret" });
        return;
      }

      try {
        const apiKey = await loadEasyPostKey(req.params.key);
        const client = createClient({ apiKey });
        res.json(await client.createWebhook({ url, secret }));
      } catch (err) {
        handleEasyPostFailure(err, res, "EasyPost webhook create");
      }
    },
  );

  /**
   * NEO-121 — remove a webhook from a seller's EasyPost account.
   *
   * EasyPost's own 404 is turned into success inside the client, never here —
   * see deleteWebhook. A 404 out of THIS router still means, and only means,
   * "no EasyPost key saved for this user".
   */
  router.delete(
    "/easypost/:key/webhooks/:webhookId",
    async (req: Request<{ key: string; webhookId: string }>, res: Response) => {
      if (rejectNonEasypostKey(req.params.key, res)) return;

      const webhookId = (req.params.webhookId ?? "").trim();
      if (
        !webhookId ||
        webhookId.length > MAX_WEBHOOK_ID_LENGTH ||
        !WEBHOOK_ID_PATTERN.test(webhookId)
      ) {
        res.status(400).json({ error: "Invalid webhookId" });
        return;
      }

      try {
        const apiKey = await loadEasyPostKey(req.params.key);
        const client = createClient({ apiKey });
        await client.deleteWebhook({ webhookId });
        res.json({ success: true, message: "Webhook deleted" });
      } catch (err) {
        handleEasyPostFailure(err, res, "EasyPost webhook delete");
      }
    },
  );

  /**
   * NEO-121 — delete a seller's stored EasyPost key.
   *
   * This MOVED here from `DELETE /credentials/:key`, which has no prefix guard
   * at all: a caller meaning to clear a postage key could name any secret and
   * the credentials router would delete it. Every EasyPost key operation now
   * goes through EASYPOST_KEY_PATTERN, so the delete cannot address a
   * marketplace secret any more than the write can.
   *
   * Idempotent: the real Secret Manager store treats "already gone" as
   * success, so clearing twice is a 200 both times. A store that instead
   * reports the secret as missing gets the router's usual 404 — "no EasyPost
   * key saved for this user" — which is the truthful answer either way.
   *
   * Note this deliberately does NOT route through handleEasyPostFailure: no
   * EasyPost call happens here, so a store failure must not be reported as
   * a 502 "EasyPost request failed".
   */
  router.delete(
    "/easypost/:key",
    async (req: Request<{ key: string }>, res: Response) => {
      const { key } = req.params;
      if (rejectNonEasypostKey(key, res)) return;

      try {
        await createStore().deleteCredentials(key);
        res.json({ success: true, message: "EasyPost key deleted" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message.includes("Invalid credential key format")) {
          res.status(400).json({ error: "Invalid credential key format" });
          return;
        }
        if (
          message.includes("not found") ||
          message.includes("No active version")
        ) {
          res.status(404).json({ error: "No EasyPost key saved for this user" });
          return;
        }
        // Fixed string, and the message rather than the error object — the
        // store names the key it failed on, which is an identifier, but the
        // stack is not worth the risk.
        console.error("Failed to delete EasyPost key:", message);
        res.status(500).json({ error: "Failed to delete EasyPost key" });
      }
    },
  );

  return router;
}
