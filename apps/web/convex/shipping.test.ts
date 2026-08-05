// NEO-118 — the return address, and specifically how its FROM name is resolved.
//
// The seller's name is NOT stored on the return address by default. It falls
// back to their public profile so the two cannot drift apart: type your name
// once on /profile, and every label follows it. The precedence is
//
//     stored name  ->  publicProfiles.displayName  ->  publicProfiles.username
//
// which is exactly what these tests pin. This lives here rather than in a
// Maestro flow because the resolution is server-side branching over data
// combinations — cheap and exhaustive to test at this layer, slow and partial
// through the UI.
//
// Also covered: `name` is deliberately NOT required by the save mutation (a
// blank name is the meaningful "use my display name" state), while the street
// fields still are.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// convex-test requires import.meta.glob to discover all modules.
const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const USER = "user_ship_aaaa1111";

const STREET = {
  line1: "100 Binder Way",
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
};

async function seedPublicProfile(
  t: ReturnType<typeof convexTest>,
  fields: { username: string; displayName?: string },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("publicProfiles", {
      userId: USER,
      username: fields.username,
      displayName: fields.displayName,
      createdAt: 1,
      updatedAt: 1,
    });
  });
}

describe("getMyReturnAddress — FROM name resolution", () => {
  test("returns null when no return address is saved", async () => {
    const t = convexTest(schema, modules);
    const result = await t
      .withIdentity({ subject: USER })
      .query(api.shipping.getMyReturnAddress, {});
    expect(result).toBeNull();
  });

  test("prefers the explicitly stored name over the profile", async () => {
    const t = convexTest(schema, modules);
    await seedPublicProfile(t, {
      username: "neonseller",
      displayName: "Neon Card Co",
    });
    const asUser = t.withIdentity({ subject: USER });
    await asUser.mutation(api.shipping.saveMyReturnAddress, {
      address: { ...STREET, name: "Jason Burich" },
    });

    const result = await asUser.query(api.shipping.getMyReturnAddress, {});
    expect(result?.resolvedName).toBe("Jason Burich");
    // The stored address is returned raw — the editor depends on this to show
    // a blank field as blank rather than pre-filled with the fallback.
    expect(result?.address.name).toBe("Jason Burich");
  });

  test("falls back to displayName when the stored name is blank", async () => {
    const t = convexTest(schema, modules);
    await seedPublicProfile(t, {
      username: "neonseller",
      displayName: "Neon Card Co",
    });
    const asUser = t.withIdentity({ subject: USER });
    await asUser.mutation(api.shipping.saveMyReturnAddress, {
      address: { ...STREET, name: "" },
    });

    const result = await asUser.query(api.shipping.getMyReturnAddress, {});
    expect(result?.resolvedName).toBe("Neon Card Co");
    expect(result?.address.name).toBe("");
  });

  test("falls back to username when there is no displayName", async () => {
    const t = convexTest(schema, modules);
    await seedPublicProfile(t, { username: "neonseller" });
    const asUser = t.withIdentity({ subject: USER });
    await asUser.mutation(api.shipping.saveMyReturnAddress, {
      address: { ...STREET, name: "" },
    });

    const result = await asUser.query(api.shipping.getMyReturnAddress, {});
    expect(result?.resolvedName).toBe("neonseller");
  });

  test("treats a whitespace-only stored name as blank", async () => {
    const t = convexTest(schema, modules);
    await seedPublicProfile(t, {
      username: "neonseller",
      displayName: "Neon Card Co",
    });
    const asUser = t.withIdentity({ subject: USER });
    await asUser.mutation(api.shipping.saveMyReturnAddress, {
      address: { ...STREET, name: "   " },
    });

    const result = await asUser.query(api.shipping.getMyReturnAddress, {});
    expect(result?.resolvedName).toBe("Neon Card Co");
  });

  // The one case the UI has to handle: a saved street address with no name
  // available anywhere. /labels disables Print and says why.
  test("resolves to empty when there is no name and no public profile", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: USER });
    await asUser.mutation(api.shipping.saveMyReturnAddress, {
      address: { ...STREET, name: "" },
    });

    const result = await asUser.query(api.shipping.getMyReturnAddress, {});
    expect(result?.resolvedName).toBe("");
  });

  test("does not leak another user's return address", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity({ subject: USER }).mutation(
      api.shipping.saveMyReturnAddress,
      { address: { ...STREET, name: "Jason Burich" } },
    );

    const other = await t
      .withIdentity({ subject: "user_ship_bbbb2222" })
      .query(api.shipping.getMyReturnAddress, {});
    expect(other).toBeNull();
  });

  test("returns null when unauthenticated", async () => {
    const t = convexTest(schema, modules);
    const result = await t.query(api.shipping.getMyReturnAddress, {});
    expect(result).toBeNull();
  });
});

describe("saveMyReturnAddress — validation", () => {
  test("accepts a blank name (it means 'use my display name')", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.withIdentity({ subject: USER }).mutation(
        api.shipping.saveMyReturnAddress,
        { address: { ...STREET, name: "" } },
      ),
    ).resolves.toBeNull();
  });

  test.each(["line1", "city", "state", "postalCode"] as const)(
    "rejects a missing %s",
    async (field) => {
      const t = convexTest(schema, modules);
      await expect(
        t.withIdentity({ subject: USER }).mutation(
          api.shipping.saveMyReturnAddress,
          { address: { ...STREET, name: "", [field]: "" } },
        ),
      ).rejects.toThrow(field);
    },
  );

  test("rejects an unauthenticated save", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.shipping.saveMyReturnAddress, {
        address: { ...STREET, name: "Jason Burich" },
      }),
    ).rejects.toThrow("Not authenticated");
  });

  // Saving an address must not disturb the credential state living on the same
  // userProfiles row — the mutation patches rather than replaces.
  test("preserves siteCredentials on the same row", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId: USER,
        siteCredentials: [{ site: "buysportscards", hasCredentials: true }],
      });
    });

    await t.withIdentity({ subject: USER }).mutation(
      api.shipping.saveMyReturnAddress,
      { address: { ...STREET, name: "Jason Burich" } },
    );

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("userProfiles")
        .withIndex("by_user", (q) => q.eq("userId", USER))
        .unique(),
    );
    expect(row?.siteCredentials?.[0]).toMatchObject({
      site: "buysportscards",
      hasCredentials: true,
    });
    expect(row?.returnAddress?.line1).toBe("100 Binder Way");
  });
});
