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

import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import { getCurrentUserId } from "./auth";
import { browserAuthHeaders, browserFetch, credKey } from "./credentials";
import { postalAddressValidator } from "./schema";

const EASYPOST_SITE = "easypost";

/** EasyPost keys are ~50 chars; this is a sanity bound, not a format check. */
const MAX_KEY_LENGTH = 256;

/** Letters top out at 13oz, and the rate tiers we care about are 1–3oz. */
const MAX_WEIGHT_OZ = 13;

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
  handler: async (ctx, args) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const apiKey = args.apiKey.trim();
    if (!apiKey) {
      return { success: false, message: "Enter your EasyPost API key." };
    }
    if (apiKey.length > MAX_KEY_LENGTH) {
      return { success: false, message: "That key is longer than any EasyPost key." };
    }

    const response = await browserFetch(`/easypost/${credKey(EASYPOST_SITE, userId)}`, {
      method: "PUT",
      headers: { ...(await browserAuthHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });

    if (!response.ok) {
      return { success: false, message: "Could not save the key. Try again." };
    }
    return { success: true, message: "EasyPost key saved." };
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

export const clearEasypostKey = action({
  args: {},
  returns: v.object({ success: v.boolean(), message: v.string() }),
  handler: async (ctx) => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const response = await browserFetch(`/credentials/${credKey(EASYPOST_SITE, userId)}`, {
      method: "DELETE",
      headers: await browserAuthHeaders(),
    });
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

    return { ...bought, historySaved };
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
