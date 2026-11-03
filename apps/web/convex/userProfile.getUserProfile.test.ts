// NEO-415 — userProfile.getUserProfile returns every marketplace account id.
//
// Connecting eBay writes `marketplaceAccountIds.ebayUserId`. The query's
// return validator once listed only `bscSellerId`, so the first real eBay
// connect failed return validation and took the whole app down with it.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// convex-test v0.0.53 requires import.meta.glob to discover all modules.
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER = "user_profile_cccc3333";

describe("userProfile.getUserProfile", () => {
  test("returns a profile carrying both BSC and eBay account ids", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER,
        marketplaceAccountIds: { bscSellerId: "seller_1", ebayUserId: "ebay_user_1" },
        siteCredentials: [{ site: "ebay", hasCredentials: true }],
      });
    });

    const profile = await t
      .withIdentity({ subject: USER })
      .query(api.userProfile.getUserProfile, {});

    expect(profile?.marketplaceAccountIds).toEqual({
      bscSellerId: "seller_1",
      ebayUserId: "ebay_user_1",
    });
  });
});
