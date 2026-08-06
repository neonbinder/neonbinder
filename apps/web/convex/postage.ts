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
import { api } from "./_generated/api";
import { v } from "convex/values";
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

/** Turn a browser-service failure into something the seller can act on. */
async function failureFrom(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const body = (await response.json()) as { error?: string };
    if (body?.error) message = body.error;
  } catch {
    // non-JSON body; keep the fallback
  }
  throw new Error(message);
}

/**
 * Save (or replace) the seller's EasyPost API key.
 *
 * Stored at `easypost-credentials-<clerkUserId>` — one secret per seller, never
 * a shared one. The key goes in the `password` field of the existing
 * `{username, password}` credential shape, with the Clerk user id as
 * `username`.
 *
 * **An API key is not a password.** Reusing the field means no new
 * secret-handling code and no change to the browser service's storage routes,
 * which is worth more than the naming purity — but it is a compromise, and the
 * user id in `username` is there so the stored record is at least
 * self-describing about who it belongs to.
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

    const response = await browserFetch(`/credentials/${credKey(EASYPOST_SITE, userId)}`, {
      method: "PUT",
      headers: { ...(await browserAuthHeaders()), "Content-Type": "application/json" },
      body: JSON.stringify({ username: userId, password: apiKey }),
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
      throw new Error("Enter how much the envelope weighs.");
    }
    if (args.weightOz > MAX_WEIGHT_OZ) {
      throw new Error(
        `First-Class letters top out at ${MAX_WEIGHT_OZ}oz. Heavier than that ships as a package.`,
      );
    }

    const saved = await ctx.runQuery(api.shipping.getMyReturnAddress, {});
    if (!saved) {
      throw new Error("Add your return address on your profile first.");
    }
    const from = { ...saved.address, name: saved.resolvedName };
    if (!from.name.trim()) {
      throw new Error(
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
      throw new Error("Add your EasyPost API key on your profile first.");
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
      throw new Error("Add your EasyPost API key on your profile first.");
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
    try {
      await ctx.runMutation(api.shipping.recordLabelPurchase, {
        easypostShipmentId: bought.shipmentId,
        trackingCode: bought.trackingCode,
        costCents: bought.amountCents,
        weightOz: args.weightOz,
        toAddress: args.to,
        labelUrl: bought.labelUrl,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: "label_purchase_record_failed",
          shipmentId: bought.shipmentId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    return bought;
  },
});
