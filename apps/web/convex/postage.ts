"use node";

/**
 * NEO-120 — buying USPS letter postage for a PWE.
 *
 * ## Why every call here is a proxy
 * The seller's EasyPost API key **spends their money**, so it lives in GCP
 * Secret Manager and only the browser service ever reads it (NEO-20's boundary:
 * no route hands a stored password back). Convex therefore cannot call EasyPost
 * itself — it asks the browser service to, exactly as it already does for BSC
 * and SportLots logins. The EasyPost logic lives in
 * `services/browser/src/services/easypost.ts`.
 *
 * This module is separate from `credentials.ts` on purpose: EasyPost is not a
 * marketplace, and adding it to `SUPPORTED_SITES` would leak it into
 * `listUserSites`, `/credentials/check`, the Credentials tab and the login/test
 * flows, all of which assume a marketplace login.
 */

import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { getCurrentUserId } from "./auth";
import { browserAuthHeaders, browserFetch, credKey } from "./credentials";
import { postalAddressValidator } from "./schema";
import type { Doc } from "./_generated/dataModel";
import type { TrackerSnapshot } from "./shipmentTracking";

const EASYPOST_SITE = "easypost";

/** EasyPost keys are ~50 chars; this is a sanity bound, not a format check. */
const MAX_KEY_LENGTH = 256;

/** Letters top out at 13oz, and the rate tiers we care about are 1–3oz. */
const MAX_WEIGHT_OZ = 13;

/**
 * NEO-121 — how long a purchase row's tracker stays "just checked".
 *
 * A letter gets four scans over three days; nothing is lost by refusing to ask
 * EasyPost twice in a minute, and a click loop that DID ask would burn the
 * seller's per-key rate budget — the same 60/min bucket the buy path uses.
 */
const REFRESH_COOLDOWN_MS = 60_000;

const rateQuoteValidator = v.object({
  shipmentId: v.string(),
  rateId: v.string(),
  service: v.string(),
  carrier: v.string(),
  amountCents: v.number(),
  verifiedTo: postalAddressValidator,
});

/** Mirrors {@link rateQuoteValidator} — the browser service's response shape. */
interface RateQuoteResponse {
  shipmentId: string;
  rateId: string;
  service: string;
  carrier: string;
  amountCents: number;
  verifiedTo: {
    name: string;
    company?: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  };
}

/**
 * Turn a browser-service failure into something the seller can act on.
 *
 * ConvexError, not Error: production Convex REDACTS thrown Error messages to
 * "Server Error" (dev and preview deployments pass them through, which is why
 * every actionable message looked fine in testing and then flattened on prod —
 * found live on the first real purchase attempt: EasyPost's "Insufficient
 * funds… check your billing settings" reached the seller as "Server Error").
 * A ConvexError's data survives to the client in every deployment type.
 */
async function failureFrom(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const body = (await response.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // non-JSON body; keep the fallback
  }
  throw new ConvexError(message);
}

/**
 * Is this 404 the easypost router saying "no key on file", or Express saying
 * "no such route"?
 *
 * They are the same status code and opposite diagnoses. The router answers with
 * JSON — `{error: "No EasyPost key saved for this user"}` (routes/easypost.ts's
 * `handleEasyPostFailure`) — while an unrouted path falls through to Express's
 * default handler and an HTML `Cannot GET /...` body. Telling a seller to add
 * an API key they already added, because a Cloud Run revision predates the
 * route, sends them to fix the one thing that is not broken. Anything else
 * (including a JSON 404 the label route may raise for a shipment EasyPost no
 * longer has) falls through to {@link failureFrom}, which forwards the service's
 * own message.
 *
 * Reads a `clone()` so the body is still unread for `failureFrom`.
 */
async function isMissingKey404(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as { error?: string };
    return typeof body?.error === "string" && /no easypost key/i.test(body.error);
  } catch {
    // Non-JSON body — Express's "Cannot GET", or nothing at all.
    return false;
  }
}

/**
 * NEO-121 — the browser service's machine-readable failure kind, when it sends
 * one (`{error, kind}`).
 *
 * `error` is the seller-readable sentence and `kind` is what code may branch
 * on; branching on the sentence would break the day someone improves the
 * wording. Reads a `clone()`, so {@link failureFrom} can still forward the
 * message.
 */
async function errorKindOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.clone().json()) as { kind?: unknown };
    return typeof body?.kind === "string" ? body.kind : undefined;
  } catch {
    return undefined;
  }
}

/**
 * NEO-121 — the four registration outcomes, as an NB-authored enum.
 *
 * NEVER EasyPost's own message: EasyPost echoes the URL it rejected, and that
 * URL contains the seller's webhook token — a bearer credential. Storing the
 * upstream text would write that token into a field a client can read (see the
 * `easypostWebhooks` table comment).
 */
const registrationErrorValidator = v.union(
  v.literal("rejected"),
  v.literal("unauthorized"),
  v.literal("unavailable"),
  v.literal("no_key"),
);

type RegistrationError = "rejected" | "unauthorized" | "unavailable" | "no_key";

/** EasyPost's webhook mode, narrowed — anything else is recorded as unknown. */
const webhookModeValidator = v.optional(
  v.union(v.literal("test"), v.literal("production")),
);

function narrowMode(value: unknown): "test" | "production" | undefined {
  return value === "test" || value === "production" ? value : undefined;
}

/**
 * Map a browser-service failure onto {@link registrationErrorValidator}.
 *
 * The Express-404 case is the one that matters operationally: `release.yml`
 * promotes the browser service before Convex, but a PREVIEW runs its own
 * revision, so a Convex build can meet a service that predates these routes.
 * That is `unavailable` (try again later), never `no_key` — telling a seller to
 * add a key they already added sends them to fix the one thing that works.
 */
async function registrationErrorFor(response: Response): Promise<RegistrationError> {
  if (response.status === 404) {
    return (await isMissingKey404(response)) ? "no_key" : "unavailable";
  }
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (response.status >= 500) return "unavailable";
  return "rejected";
}

/** EasyPost timestamps arrive as ISO strings; the row stores ms. */
function toMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * NEO-121 — store the key, WITHOUT registering a webhook.
 *
 * Split out of {@link saveEasypostKey} for one caller: `testing.ts`'s E2E seed
 * (decision 8). Each preview seeds the shared test key for 8 worker users, and
 * registering there would pile a webhook per preview per worker onto one test
 * account — which `preview-cleanup.yml` then orphans when the PR closes. The
 * seed stores; only a real seller's save registers.
 *
 * Internal, and takes `userId` explicitly: the public action derives it from
 * the verified Clerk subject and never accepts it as an argument.
 */
export const storeEasypostKeyForUser = internalAction({
  args: { userId: v.string(), apiKey: v.string() },
  returns: v.object({ success: v.boolean(), message: v.string() }),
  handler: async (_ctx, args) => {
    const response = await browserFetch(`/easypost/${credKey(EASYPOST_SITE, args.userId)}`, {
      method: "PUT",
      headers: { ...(await browserAuthHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: args.apiKey }),
    });

    if (!response.ok) {
      return { success: false, message: "Could not save the key. Try again." };
    }
    return { success: true, message: "EasyPost key saved." };
  },
});

/**
 * NEO-121 — the seller's registered EasyPost webhooks, for reconciliation.
 *
 * This and its two siblings below are TRANSPORT ONLY. The policy that decides
 * what to adopt, delete and create lives in `convex/shipmentTracking.ts`, which
 * cannot make these calls itself: it hosts an `httpAction` and is therefore a
 * default-runtime module, while the browser-service handshake is `"use node"`.
 *
 * None of the three throws on a service failure — they answer with the enum, so
 * registration can never fail the money path or a key save.
 */
export const easypostListWebhooks = internalAction({
  args: { userId: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      hooks: v.array(
        v.object({
          webhookId: v.string(),
          url: v.string(),
          mode: webhookModeValidator,
          disabledAt: v.optional(v.number()),
        }),
      ),
    }),
    v.object({ ok: v.literal(false), error: registrationErrorValidator }),
  ),
  handler: async (_ctx, args) => {
    let response: Response;
    try {
      response = await browserFetch(
        `/easypost/${credKey(EASYPOST_SITE, args.userId)}/webhooks`,
        { method: "GET", headers: await browserAuthHeaders() },
      );
    } catch {
      return { ok: false as const, error: "unavailable" as const };
    }
    if (!response.ok) {
      return { ok: false as const, error: await registrationErrorFor(response) };
    }

    // `GET /easypost/:key/webhooks` answers `{ webhooks: [...] }` — the
    // envelope, not a bare array. Reading only the bare array made `hooks`
    // ALWAYS empty, which silently turned reconcile-before-create off: nothing
    // was ever adopted, no stale hook under our prefix was ever reaped, and a
    // lost create response would have produced a second hook on the next
    // attempt, delivering every event twice forever. The bare-array branch
    // stays as a tolerance for an older browser revision, since `release.yml`
    // promotes the browser service before Convex.
    const body = (await response.json()) as unknown;
    const envelope = (body ?? {}) as { webhooks?: unknown };
    const rows = Array.isArray(body)
      ? body
      : Array.isArray(envelope.webhooks)
        ? envelope.webhooks
        : [];
    const hooks = rows.flatMap((entry) => {
      const hook = (entry ?? {}) as Record<string, unknown>;
      const webhookId = typeof hook.webhookId === "string" ? hook.webhookId : "";
      const url = typeof hook.url === "string" ? hook.url : "";
      if (!webhookId || !url) return [];
      return [
        {
          webhookId,
          url,
          mode: narrowMode(hook.mode),
          disabledAt: toMs(hook.disabledAt),
        },
      ];
    });
    return { ok: true as const, hooks };
  },
});

/**
 * Register `url` (always a `*.convex.site` HTTPS URL — the browser route
 * enforces that server-side, so this cannot become an arbitrary-URL
 * registration primitive) with `secret` as the HMAC key.
 *
 * `secret` crosses this function boundary because the transport lives here and
 * the policy lives elsewhere; it is never logged, never returned, and never
 * reaches a client.
 */
export const easypostCreateWebhook = internalAction({
  args: { userId: v.string(), url: v.string(), secret: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      webhookId: v.string(),
      mode: webhookModeValidator,
    }),
    v.object({ ok: v.literal(false), error: registrationErrorValidator }),
  ),
  handler: async (_ctx, args) => {
    let response: Response;
    try {
      response = await browserFetch(
        `/easypost/${credKey(EASYPOST_SITE, args.userId)}/webhooks`,
        {
          method: "POST",
          headers: { ...(await browserAuthHeaders()), "Content-Type": "application/json" },
          body: JSON.stringify({ url: args.url, secret: args.secret }),
        },
      );
    } catch {
      return { ok: false as const, error: "unavailable" as const };
    }
    if (!response.ok) {
      return { ok: false as const, error: await registrationErrorFor(response) };
    }

    const body = (await response.json()) as { webhookId?: unknown; mode?: unknown };
    const webhookId = typeof body.webhookId === "string" ? body.webhookId : "";
    if (!webhookId) return { ok: false as const, error: "rejected" as const };
    return { ok: true as const, webhookId, mode: narrowMode(body.mode) };
  },
});

/**
 * Delete one webhook. `confirmed` is the ONLY signal the caller may act on:
 * `removeWebhook` keeps its row whenever this is false, so an unconfirmed
 * delete leaves something to retry rather than a hook nobody remembers.
 *
 * EasyPost's own 404 already counts as success inside the browser client (the
 * hook is gone, which is the desired end state); the router's JSON "no key
 * saved" 404 does not, and is not confused with it.
 */
export const easypostDeleteWebhook = internalAction({
  args: { userId: v.string(), webhookId: v.string() },
  returns: v.object({ confirmed: v.boolean() }),
  handler: async (_ctx, args) => {
    try {
      const response = await browserFetch(
        `/easypost/${credKey(EASYPOST_SITE, args.userId)}/webhooks/${encodeURIComponent(
          args.webhookId,
        )}`,
        { method: "DELETE", headers: await browserAuthHeaders() },
      );
      return { confirmed: response.ok };
    } catch {
      return { confirmed: false };
    }
  },
});

/**
 * Save (or replace) the seller's EasyPost API key.
 *
 * Stored at `easypost-credentials-<clerkUserId>` — one secret per seller, never
 * a shared one — via `PUT /easypost/:key`, the easypost-scoped write route.
 * NEO-141 removed the generic `PUT /credentials/:key` (marketplace passwords
 * are transient now), but an EasyPost key IS the long-lived credential — there
 * is no login that mints a token from it — so it keeps a storage path, guarded
 * server-side to easypost keys only. See services/browser/src/routes/easypost.ts.
 */
export const saveEasypostKey = action({
  args: { apiKey: v.string() },
  returns: v.object({ success: v.boolean(), message: v.string() }),
  handler: async (ctx, args): Promise<{ success: boolean; message: string }> => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const apiKey = args.apiKey.trim();
    if (!apiKey) {
      return { success: false, message: "Enter your EasyPost API key." };
    }
    if (apiKey.length > MAX_KEY_LENGTH) {
      return { success: false, message: "That key is longer than any EasyPost key." };
    }

    // Annotated because postage.ts and shipmentTracking.ts call each other
    // through the generated `internal` object; see the type block in
    // shipmentTracking.ts for why an un-annotated value in that cycle degrades
    // to `any` across both modules.
    const stored: { success: boolean; message: string } = await ctx.runAction(
      internal.postage.storeEasypostKeyForUser, {
      userId,
      apiKey,
    });
    if (!stored.success) return stored;

    // NEO-121 — register this seller's scan webhook, best-effort and SCHEDULED,
    // never awaited: the key is saved either way, and registration failing must
    // not turn a successful save into an error the seller cannot act on. This
    // is also the self-healing path for sellers who saved a key before scan
    // visibility existed — re-saving registers them.
    await ctx.scheduler.runAfter(0, internal.shipmentTracking.ensureWebhook, {
      userId,
    });
    return stored;
  },
});

/** Whether a key is on file — never the key itself. */
export const hasEasypostKey = action({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) return false;

    const response = await browserFetch("/credentials/check", {
      method: "POST",
      headers: { ...(await browserAuthHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ keys: [credKey(EASYPOST_SITE, userId)] }),
    });
    if (!response.ok) return false;

    const body = (await response.json()) as { results?: Record<string, boolean> };
    return body.results?.[credKey(EASYPOST_SITE, userId)] === true;
  },
});

/**
 * Remove the seller's EasyPost key — and, first, the webhook that key is the
 * only credential for.
 *
 * ## Ordering is load-bearing (NEO-121)
 * `removeWebhook` is AWAITED, not scheduled. Scheduled, it would run after the
 * key is gone and could never authenticate to EasyPost, leaving a hook on the
 * seller's account that we can no longer remove and they did not ask to keep.
 * It cannot throw and cannot block the delete: a seller who asked to remove
 * their key gets their key removed even if EasyPost is unreachable, and the
 * webhook row survives for a later attempt.
 *
 * ## Why the delete moved off the credentials router
 * It used to go through `DELETE /credentials/:key`, which has NO
 * `EASYPOST_KEY_PATTERN` guard — every other EasyPost operation is prefix-
 * scoped and that one was not. This branch moves it to the guarded
 * `DELETE /easypost/:key`, with a fallback to the old path for exactly one
 * case: an Express (HTML) 404, which means the deployed browser revision
 * predates the new route. The router's own JSON "no key saved" 404 is NOT that
 * case — it means the desired end state already holds.
 */
export const clearEasypostKey = action({
  args: {},
  returns: v.object({ success: v.boolean(), message: v.string() }),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    try {
      await ctx.runAction(internal.shipmentTracking.removeWebhook, { userId });
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: "easypost_webhook_remove_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    const key = credKey(EASYPOST_SITE, userId);
    let response = await browserFetch(`/easypost/${key}`, {
      method: "DELETE",
      headers: await browserAuthHeaders(),
    });

    // Only an Express 404 (no such route on this revision) falls back. Without
    // this, a deploy window in which Convex leads the browser service would
    // strand the delete and the seller would be told their key is still there.
    //
    // Note the route answers 200 even when nothing was stored (Secret Manager's
    // NOT_FOUND is swallowed), so success here means "no key on file now" and
    // never "a key existed and was removed". Nothing depends on the difference.
    if (response.status === 404 && !(await isMissingKey404(response))) {
      response = await browserFetch(`/credentials/${key}`, {
        method: "DELETE",
        headers: await browserAuthHeaders(),
      });
    }

    // 404 means there was nothing to remove — the desired end state either way.
    if (!response.ok && response.status !== 404) {
      return { success: false, message: "Could not remove the key. Try again." };
    }
    return { success: true, message: "EasyPost key removed." };
  },
});

/**
 * Price a letter to this recipient. **Charges nothing.**
 *
 * Address verification happens inside this call, so an undeliverable address
 * fails here — before any money moves. That is why validation is mandatory for
 * this feature rather than the nice-to-have it was for a stamped label.
 */
export const quoteLetterRate = action({
  args: {
    to: postalAddressValidator,
    weightOz: v.number(),
  },
  returns: rateQuoteValidator,
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    if (!Number.isFinite(args.weightOz) || args.weightOz <= 0) {
      throw new ConvexError("Enter how much the envelope weighs.");
    }
    if (args.weightOz > MAX_WEIGHT_OZ) {
      throw new ConvexError(
        `First-Class letters top out at ${MAX_WEIGHT_OZ}oz. Heavier than that ships as a package.`,
      );
    }

    const saved = await ctx.runQuery(api.shipping.getMyReturnAddress, {});
    if (!saved) {
      throw new ConvexError("Add your return address on your profile first.");
    }
    const from = { ...saved.address, name: saved.resolvedName };
    if (!from.name.trim()) {
      throw new ConvexError(
        "Add a name to your return address, or set a display name on your public profile.",
      );
    }

    const response = await browserFetch(
      `/easypost/${credKey(EASYPOST_SITE, userId)}/rate`,
      {
        method: "POST",
        headers: { ...(await browserAuthHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({ to: args.to, from, weightOz: args.weightOz }),
      },
    );

    if (response.status === 404) {
      throw new ConvexError("Add your EasyPost API key on your profile first.");
    }
    if (!response.ok) {
      await failureFrom(response, "Could not get a postage rate.");
    }
    return (await response.json()) as RateQuoteResponse;
  },
});

/**
 * Buy a quoted rate. **This spends the seller's money** — the only irreversible
 * call in the module, and the reason the UI shows a price and requires a second,
 * explicitly-labelled action rather than folding this into "Print".
 *
 * The purchase is recorded even though `labelPurchases` is minimal: a seller who
 * paid for a label must be able to find it again. `easypostShipmentId` is stored
 * because EasyPost's label URLs expire and the id is how a reprint re-fetches.
 *
 * NEO-213: `historySaved` reports whether that record write actually landed. The
 * write still cannot fail the purchase (see the catch below), but silently
 * dropping it is worse than it looks — a label missing from history is a label
 * the seller cannot reprint, and they find that out days later with no idea why.
 * So the outcome is returned rather than only logged, and the UI warns on the
 * spot ("save this label now — it didn't make it into your history") while the
 * URL it just got back is still good.
 */
export const buyLetterLabel = action({
  args: {
    shipmentId: v.string(),
    rateId: v.string(),
    weightOz: v.number(),
    to: postalAddressValidator,
  },
  returns: v.object({
    shipmentId: v.string(),
    trackingCode: v.string(),
    labelUrl: v.string(),
    amountCents: v.number(),
    historySaved: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const response = await browserFetch(
      `/easypost/${credKey(EASYPOST_SITE, userId)}/buy`,
      {
        method: "POST",
        headers: { ...(await browserAuthHeaders()), "Content-Type": "application/json" },
        body: JSON.stringify({ shipmentId: args.shipmentId, rateId: args.rateId }),
      },
    );

    if (response.status === 404) {
      throw new ConvexError("Add your EasyPost API key on your profile first.");
    }
    if (!response.ok) {
      await failureFrom(response, "Could not buy the label.");
    }

    const bought = (await response.json()) as {
      shipmentId: string;
      trackingCode: string;
      labelUrl: string;
      amountCents: number;
      // NEO-121: a bought shipment carries its tracker inline, so the row can
      // show "Label printed — no scans yet" from the moment it exists rather
      // than waiting for the first webhook. Optional: an older browser revision
      // does not send it, and that must not fail the purchase.
      tracker?: TrackerSnapshot;
    };

    // Record after the purchase succeeds. If this write were to fail the money
    // is already spent, so it must never be able to reject the label — hence a
    // separate mutation whose failure is logged, not thrown.
    let historySaved = false;
    try {
      await ctx.runMutation(internal.shipping.recordLabelPurchase, {
        // Internal, so the row's owner is passed rather than re-derived: the
        // subject this action already verified. A public write here would let a
        // seller file a purchase row naming someone else's shipment id, which
        // `refreshLabelUrl` below would then accept as proof of ownership.
        userId,
        easypostShipmentId: bought.shipmentId,
        trackingCode: bought.trackingCode,
        costCents: bought.amountCents,
        weightOz: args.weightOz,
        toAddress: args.to,
        labelUrl: bought.labelUrl,
        tracker: bought.tracker,
      });
      historySaved = true;
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: "label_purchase_record_failed",
          shipmentId: bought.shipmentId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // NEO-121 — a purchase is the second self-healing trigger for registration
    // (decision 5), and the one that reaches sellers who saved their key before
    // scan visibility shipped and have no reason to re-save it. Scheduled, and
    // wrapped: the money is already spent, so nothing here may throw.
    try {
      const registered = await ctx.runQuery(
        internal.shipmentTracking.isWebhookRegistered,
        { userId },
      );
      if (!registered) {
        await ctx.scheduler.runAfter(0, internal.shipmentTracking.ensureWebhook, {
          userId,
        });
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: "easypost_webhook_schedule_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // Field by field, not a spread: `bought` now carries a `tracker` the
    // returns validator does not declare, and a spread would fail validation.
    return {
      shipmentId: bought.shipmentId,
      trackingCode: bought.trackingCode,
      labelUrl: bought.labelUrl,
      amountCents: bought.amountCents,
      historySaved,
    };
  },
});

/**
 * NEO-213 — get a fresh, working URL for a label the seller already bought.
 *
 * A reprint is not a re-purchase: this charges nothing and mints no new
 * postage. It re-fetches the shipment from EasyPost and hands back the current
 * `postage_label` URL, because **the URL stored at purchase time expires** while
 * the shipment id does not — which is exactly why `labelPurchases` keeps the id
 * (see the table comment in schema.ts).
 *
 * Takes a `labelPurchases` row id, never a shipment id. The shipment id is read
 * off the row *after* `getLabelPurchaseForUser` proves the row is the caller's,
 * so a caller cannot aim this at a shipment they do not own — the browser
 * service checks only that the credential key is theirs, not the shipment.
 * Missing and not-yours produce the same message on purpose: a distinct
 * "not yours" would confirm the id exists.
 *
 * The row is trustworthy because only `internal.shipping.recordLabelPurchase`
 * can write one, from the purchase above. If that write ever becomes reachable
 * from a client, this ownership check stops meaning anything: a seller would
 * simply file a row of their own carrying someone else's shipment id.
 *
 * **The 180-day wall.** EasyPost deletes label images 180 days after purchase.
 * Past that the shipment still resolves but has no retrievable label, and there
 * is nothing this action or a reprint can do about it — the postage was real,
 * the image is gone. The browser route turns that into a seller-readable
 * message and this action forwards it verbatim via {@link failureFrom}, rather
 * than flattening it into "could not fetch", so the seller learns the label is
 * expired rather than that something is broken.
 */
export const refreshLabelUrl = action({
  args: { purchaseId: v.id("labelPurchases") },
  returns: v.object({ labelUrl: v.string() }),
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const row = await ctx.runQuery(internal.shipping.getLabelPurchaseForUser, {
      purchaseId: args.purchaseId,
      userId,
    });
    if (!row) {
      throw new ConvexError("That label purchase wasn't found.");
    }

    const response = await browserFetch(
      `/easypost/${credKey(EASYPOST_SITE, userId)}/label/${encodeURIComponent(
        row.easypostShipmentId,
      )}`,
      {
        method: "GET",
        headers: await browserAuthHeaders(),
      },
    );

    // Only the router's own "no key saved" 404 means what the key prompt says.
    // An Express "Cannot GET" 404 means this route is not on the deployed
    // revision yet, and must not masquerade as a missing key.
    if (response.status === 404 && (await isMissingKey404(response))) {
      throw new ConvexError("Add your EasyPost API key on your profile first.");
    }
    if (!response.ok) {
      await failureFrom(response, "Could not fetch the label for reprinting.");
    }

    const fetched = (await response.json()) as {
      shipmentId: string;
      trackingCode: string;
      labelUrl: string;
    };
    return { labelUrl: fetched.labelUrl };
  },
});

/**
 * NEO-121 — pull this purchase's tracker from EasyPost now, on the seller's
 * ask.
 *
 * The webhook is the live path; this is the backstop. It covers rows bought
 * before webhooks existed, the window while registration is still failing, and
 * the day a hook silently stops delivering — and it is the only tracking path
 * an E2E flow can drive, since nothing in CI can make USPS scan an envelope.
 *
 * Ownership is derived exactly the way `refreshLabelUrl` derives it (and for
 * the same reason — see that function): a row id, proved to be the caller's by
 * an internal query, and the shipment id read off the proved row. The snapshot
 * write re-asserts ownership a second time.
 *
 * ## The cooldown is server-side on purpose
 * A refresh within {@link REFRESH_COOLDOWN_MS} of this row's last one is
 * answered FROM THE ROW without calling out. The seller's EasyPost key is
 * rate-limited per seller (one bucket shared with `buy`), so a click loop on
 * this button could 429 the money path. Client-side disabling is a courtesy;
 * this is the control.
 */
export const refreshTracking = action({
  args: { purchaseId: v.id("labelPurchases") },
  returns: v.object({
    applied: v.boolean(),
    newScans: v.number(),
    status: v.optional(v.string()),
    cooldown: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    applied: boolean;
    newScans: number;
    status?: string;
    cooldown: boolean;
  }> => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const row: Doc<"labelPurchases"> | null = await ctx.runQuery(
      internal.shipping.getLabelPurchaseForUser,
      { purchaseId: args.purchaseId, userId },
    );
    // Missing and not-yours are one message, deliberately: a distinct "that
    // isn't yours" would confirm the id exists.
    if (!row) {
      throw new ConvexError("That label purchase wasn't found.");
    }

    const now = Date.now();
    if (row.lastRefreshAt !== undefined && now - row.lastRefreshAt < REFRESH_COOLDOWN_MS) {
      return {
        applied: false,
        newScans: 0,
        status: row.trackingStatus,
        cooldown: true,
      };
    }

    // Stamped BEFORE the call, not only on the success path below. The
    // ordinary state of a just-bought letter is `no_tracker` (409), which
    // throws past the snapshot write — so stamping only there left the loop
    // this cooldown exists to stop wide open on the one status a seller is
    // most likely to be clicking at. Every attempt costs the same 60 s.
    await ctx.runMutation(internal.shipmentTracking.stampRefreshAttempt, {
      purchaseId: args.purchaseId,
      userId,
      at: now,
    });

    const response = await browserFetch(
      `/easypost/${credKey(EASYPOST_SITE, userId)}/tracker/${encodeURIComponent(
        row.easypostShipmentId,
      )}`,
      { method: "GET", headers: await browserAuthHeaders() },
    );

    if (response.status === 404 && (await isMissingKey404(response))) {
      throw new ConvexError("Add your EasyPost API key on your profile first.");
    }
    if (!response.ok) {
      // `no_tracker` (the browser route answers 409) is not a failure, it is
      // the normal state of a letter USPS has not touched yet — and the seller
      // needs to hear that, not "could not fetch". Branch on `kind`, never on
      // the status or the sentence. Every other failure keeps EasyPost's own
      // seller-readable text, which `failureFrom` carries through production's
      // error redaction.
      if ((await errorKindOf(response)) === "no_tracker") {
        throw new ConvexError(
          "USPS hasn't scanned this letter yet — there's nothing to show until the first scan.",
        );
      }
      await failureFrom(response, "Could not check for new scans.");
    }

    const snapshot = (await response.json()) as TrackerSnapshot;
    const result: { applied: boolean; newScans: number } = await ctx.runMutation(
      internal.shipmentTracking.applyTrackerSnapshot,
      {
        purchaseId: args.purchaseId,
        userId,
        snapshot,
        // Stamped even when the snapshot is a no-op: EasyPost was called, which
        // is what the cooldown rate-limits.
        refreshedAt: now,
      },
    );

    return {
      applied: result.applied,
      newScans: result.newScans,
      status: snapshot.status,
      cooldown: false,
    };
  },
});
