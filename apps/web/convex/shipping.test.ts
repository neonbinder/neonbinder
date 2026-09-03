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
import { api, internal } from "./_generated/api";
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

// ---------------------------------------------------------------------------
// NEO-120's label history, backfilled in NEO-213 — the reprint feature makes
// these load-bearing. Reprint reads a `labelPurchases` row and forwards the
// shipment id on it to EasyPost, so the ordering, the cap and the ownership
// boundary below are now the difference between "reprint my label" and
// "reprint someone else's".
// ---------------------------------------------------------------------------

const OTHER_USER = "user_ship_bbbb2222";

const TO_ADDRESS = {
  name: "Ricky Henderson",
  line1: "42 Leadoff Ln",
  city: "Oakland",
  state: "CA",
  postalCode: "94621",
  country: "US",
};

/** The arguments recordLabelPurchase takes, with per-call fields overridable. */
function purchaseArgs(overrides: Partial<{ trackingCode: string }> = {}) {
  return {
    easypostShipmentId: "shp_test_0001",
    trackingCode: "9400100000000000000001",
    costCents: 78,
    weightOz: 1,
    toAddress: TO_ADDRESS,
    labelUrl: "https://easypost-files.example/label-0001.png",
    ...overrides,
  };
}

/** Insert a purchase directly, bypassing auth — for seeding another user's. */
async function seedPurchase(
  t: ReturnType<typeof convexTest>,
  userId: string,
  trackingCode: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("labelPurchases", {
      ...purchaseArgs({ trackingCode }),
      userId,
      purchasedAt: 1,
    }),
  );
}

describe("recordLabelPurchase", () => {
  test("rejects an unauthenticated record", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.shipping.recordLabelPurchase, purchaseArgs()),
    ).rejects.toThrow("Not authenticated");
  });

  test("stores every field, and stamps purchasedAt server-side", async () => {
    const t = convexTest(schema, modules);
    const before = Date.now();
    await t
      .withIdentity({ subject: USER })
      .mutation(api.shipping.recordLabelPurchase, purchaseArgs());
    const after = Date.now();

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("labelPurchases")
        .withIndex("by_user", (q) => q.eq("userId", USER))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: USER,
      easypostShipmentId: "shp_test_0001",
      trackingCode: "9400100000000000000001",
      costCents: 78,
      weightOz: 1,
      labelUrl: "https://easypost-files.example/label-0001.png",
    });
    // A snapshot of what was printed, not a reference to anything editable.
    expect(rows[0].toAddress).toEqual(TO_ADDRESS);
    // The clock is the server's — the mutation takes no timestamp argument, so
    // a client cannot backdate a purchase into or out of the history window.
    expect(rows[0].purchasedAt).toBeGreaterThanOrEqual(before);
    expect(rows[0].purchasedAt).toBeLessThanOrEqual(after);
  });
});

describe("listMyLabelPurchases", () => {
  test("returns an empty list when unauthenticated", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.shipping.listMyLabelPurchases, {})).resolves.toEqual(
      [],
    );
  });

  test("returns newest first", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: USER });
    for (const code of ["first", "second", "third"]) {
      await asUser.mutation(
        api.shipping.recordLabelPurchase,
        purchaseArgs({ trackingCode: code }),
      );
    }

    const rows = await asUser.query(api.shipping.listMyLabelPurchases, {});
    expect(rows.map((r) => r.trackingCode)).toEqual(["third", "second", "first"]);
  });

  // The cap is what makes this a "recent purchases" view rather than an
  // unbounded scan. Seed one past it and pin which end gets dropped: the
  // OLDEST, because dropping the newest would hide the label a seller is most
  // likely to be reprinting.
  test("caps at 25, dropping the oldest", async () => {
    const t = convexTest(schema, modules);
    const asUser = t.withIdentity({ subject: USER });
    for (let i = 1; i <= 26; i++) {
      await asUser.mutation(
        api.shipping.recordLabelPurchase,
        purchaseArgs({ trackingCode: `label-${String(i).padStart(2, "0")}` }),
      );
    }

    const rows = await asUser.query(api.shipping.listMyLabelPurchases, {});
    expect(rows).toHaveLength(25);
    const codes = rows.map((r) => r.trackingCode);
    expect(codes[0]).toBe("label-26");
    expect(codes[24]).toBe("label-02");
    expect(codes).not.toContain("label-01");
  });

  test("shows each seller only their own purchases", async () => {
    const t = convexTest(schema, modules);
    await t
      .withIdentity({ subject: USER })
      .mutation(
        api.shipping.recordLabelPurchase,
        purchaseArgs({ trackingCode: "mine" }),
      );
    await t
      .withIdentity({ subject: OTHER_USER })
      .mutation(
        api.shipping.recordLabelPurchase,
        purchaseArgs({ trackingCode: "theirs" }),
      );

    const mine = await t
      .withIdentity({ subject: USER })
      .query(api.shipping.listMyLabelPurchases, {});
    const theirs = await t
      .withIdentity({ subject: OTHER_USER })
      .query(api.shipping.listMyLabelPurchases, {});

    expect(mine.map((r) => r.trackingCode)).toEqual(["mine"]);
    expect(theirs.map((r) => r.trackingCode)).toEqual(["theirs"]);
  });
});

// This query is the whole authorization boundary for NEO-213's reprint: the
// action has no ctx.db, so this is the only thing standing between a purchase
// id and someone else's EasyPost shipment.
describe("getLabelPurchaseForUser — reprint ownership", () => {
  test("returns the row to its owner", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t, USER, "mine");

    const row = await t.query(internal.shipping.getLabelPurchaseForUser, {
      purchaseId,
      userId: USER,
    });
    expect(row?.trackingCode).toBe("mine");
    expect(row?.easypostShipmentId).toBe("shp_test_0001");
  });

  test("returns null for another user's purchase", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t, OTHER_USER, "theirs");

    const row = await t.query(internal.shipping.getLabelPurchaseForUser, {
      purchaseId,
      userId: USER,
    });
    expect(row).toBeNull();
  });

  // Same answer as "not yours", deliberately — a different one would confirm
  // the id exists, and the caller renders one message for both.
  test("returns null for an id that no longer exists", async () => {
    const t = convexTest(schema, modules);
    const purchaseId = await seedPurchase(t, USER, "gone");
    await t.run(async (ctx) => ctx.db.delete(purchaseId));

    const row = await t.query(internal.shipping.getLabelPurchaseForUser, {
      purchaseId,
      userId: USER,
    });
    expect(row).toBeNull();
  });
});
