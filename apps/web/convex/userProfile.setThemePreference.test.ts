// NEO-356 — userProfile.setThemePreference({ theme }).
//
// The Profile → Settings theme write. It exists because `updateUserProfile`
// replaces the whole `preferences` object, so saving a theme through it would
// drop `defaultYear`. These cases pin the three properties that matter:
//   1. it patches `theme` ONLY and carries every other preference across;
//   2. it refuses a signed-out caller without writing anything;
//   3. the validator rejects anything that is not light | dark | system.

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// convex-test v0.0.53 requires import.meta.glob to discover all modules.
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const USER = "user_theme_aaaa1111";
const OTHER = "user_theme_bbbb2222";

async function rawProfile(t: TestConvex<typeof schema>, userId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("userProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique(),
  );
}

describe("userProfile.setThemePreference", () => {
  test("patches only the theme and keeps defaultYear and the rest of the row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER,
        preferences: { defaultYear: 1996, theme: "dark" },
        marketplaceAccountIds: { bscSellerId: "seller_1" },
        siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
      });
    });

    await t
      .withIdentity({ subject: USER })
      .mutation(api.userProfile.setThemePreference, { theme: "light" });

    const row = await rawProfile(t, USER);
    expect(row!.preferences).toEqual({ defaultYear: 1996, theme: "light" });
    expect(row!.marketplaceAccountIds).toEqual({ bscSellerId: "seller_1" });
    expect(row!.siteCredentials).toEqual([
      { site: "buysportscards", hasCredentials: true },
    ]);
  });

  test("adds a theme to a row that has preferences but none yet", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER,
        preferences: { defaultYear: 2024 },
      });
    });

    await t
      .withIdentity({ subject: USER })
      .mutation(api.userProfile.setThemePreference, { theme: "system" });

    expect((await rawProfile(t, USER))!.preferences).toEqual({
      defaultYear: 2024,
      theme: "system",
    });
  });

  test("creates the profile row when the collector has none", async () => {
    const t = convexTest(schema, modules);

    await t
      .withIdentity({ subject: USER })
      .mutation(api.userProfile.setThemePreference, { theme: "dark" });

    const row = await rawProfile(t, USER);
    expect(row!.preferences).toEqual({ theme: "dark" });
  });

  test("getUserProfile returns the saved theme, including system", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: USER });

    await asUser.mutation(api.userProfile.setThemePreference, { theme: "system" });
    const profile = await asUser.query(api.userProfile.getUserProfile, {});
    expect(profile!.preferences).toEqual({ theme: "system" });
  });

  test("writes only the caller's own row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: OTHER,
        preferences: { theme: "dark" },
      });
    });

    await t
      .withIdentity({ subject: USER })
      .mutation(api.userProfile.setThemePreference, { theme: "light" });

    expect((await rawProfile(t, OTHER))!.preferences).toEqual({ theme: "dark" });
    expect((await rawProfile(t, USER))!.preferences).toEqual({ theme: "light" });
  });

  test("refuses a signed-out caller and writes nothing", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.mutation(api.userProfile.setThemePreference, { theme: "light" }),
    ).rejects.toThrow(/Not authenticated/);

    const rows = await t.run(async (ctx) => ctx.db.query("userProfiles").collect());
    expect(rows).toEqual([]);
  });

  test.each(["sepia", "Light", "", "auto"])(
    "the validator rejects %j and leaves the row alone",
    async (bad) => {
      const t = convexTest(schema, modules);
      await t.run(async (ctx) => {
        await ctx.db.insert("userProfiles", {
          userId: USER,
          preferences: { defaultYear: 1996, theme: "dark" },
        });
      });

      await expect(
        t.withIdentity({ subject: USER }).mutation(
          api.userProfile.setThemePreference,
          // Deliberately outside the union: this is what a hand-rolled client
          // could send, and the validator is the only thing stopping it.
          { theme: bad } as unknown as { theme: "light" },
        ),
      ).rejects.toThrow();

      expect((await rawProfile(t, USER))!.preferences).toEqual({
        defaultYear: 1996,
        theme: "dark",
      });
    },
  );
});
