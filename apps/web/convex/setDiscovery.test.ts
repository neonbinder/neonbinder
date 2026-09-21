/**
 * NEO-237 (D11–D13) — `setDiscovery.ts`: the "new on SportLots" reads and the
 * three decisions an operator can make about a pending root — Create set,
 * Skip, and Unskip (the way back).
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { candidateDefaultName } from "./setDiscovery";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_neo237_setdiscovery",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo237_setdiscovery",
  name: "Admin User",
  role: "admin",
};

const NON_ADMIN_IDENTITY = {
  subject: "user_neo237_setdiscovery",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_neo237_setdiscovery",
  name: "Regular User",
};

const SENTINEL = 1_000_000;

function admin(t: ReturnType<typeof convexTest>) {
  return t.withIdentity(ADMIN_IDENTITY);
}

async function seedTree(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "1995",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: SENTINEL,
    });
    const brandId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps",
      platformData: {},
      metadata: { setNamePrefix: "Topps" },
      parentId: yearId,
      children: [],
      lastUpdated: SENTINEL,
    });
    return { sportId, yearId, brandId };
  });
}

async function seedCandidate(
  t: ReturnType<typeof convexTest>,
  manufacturerId: Id<"selectorOptions">,
  opts: {
    marketplaceId?: string;
    label?: string;
    status?: "pending" | "skipped";
    side?: "bsc" | "sportlots";
    members?: Array<{ id: string; label: string }>;
  } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("setCandidates", {
      manufacturerId,
      side: opts.side ?? "sportlots",
      marketplaceId: opts.marketplaceId ?? "sl-1",
      label: opts.label ?? "Finest",
      members: opts.members ?? [],
      status: opts.status ?? "pending",
    }),
  );
}

describe("candidateDefaultName", () => {
  test("prepends the brand's prefix when the label does not already lead with it", () => {
    expect(candidateDefaultName("Heritage", "Topps")).toEqual({
      defaultName: "Topps Heritage",
      brandPrefix: "Topps",
    });
  });

  test("leaves the label alone when it already leads with the prefix", () => {
    expect(candidateDefaultName("Topps Chrome", "Topps")).toEqual({
      defaultName: "Topps Chrome",
    });
  });

  test("leaves the label alone when the brand has no prefix (e.g. Unknown)", () => {
    expect(candidateDefaultName("Carddass", undefined)).toEqual({
      defaultName: "Carddass",
    });
    expect(candidateDefaultName("Carddass", "   ")).toEqual({
      defaultName: "Carddass",
    });
  });

  test("brandPrefix is present iff it was actually prepended", () => {
    const prepended = candidateDefaultName("Heritage", "Topps");
    const notPrepended = candidateDefaultName("Topps Heritage", "Topps");
    expect(prepended.brandPrefix).toBeDefined();
    expect(prepended.defaultName).not.toBe("Heritage");
    expect(notPrepended.brandPrefix).toBeUndefined();
    expect(notPrepended.defaultName).toBe("Topps Heritage");
  });
});

describe("getSetCandidates", () => {
  test("defaults to pending status, and never returns a skipped root", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const pending = await seedCandidate(t, brandId, { label: "Finest" });
    await seedCandidate(t, brandId, {
      marketplaceId: "sl-2",
      label: "Chrome",
      status: "skipped",
    });

    const rows = await admin(t).query(api.setDiscovery.getSetCandidates, {
      manufacturerId: brandId,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(pending);
    expect(rows[0].label).toBe("Finest");
    expect(rows[0].defaultName).toBe("Topps Finest");
  });

  test("status: 'skipped' reads the way-back list instead", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    await seedCandidate(t, brandId, { label: "Finest" });
    const skipped = await seedCandidate(t, brandId, {
      marketplaceId: "sl-2",
      label: "Chrome",
      status: "skipped",
    });

    const rows = await admin(t).query(api.setDiscovery.getSetCandidates, {
      manufacturerId: brandId,
      status: "skipped",
    });
    expect(rows.map((r) => r._id)).toEqual([skipped]);
  });

  test("members carry only labels — no marketplace id reaches the client (security review S5)", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    await seedCandidate(t, brandId, {
      members: [{ id: "sl-99", label: "Finest Refractor" }],
    });

    const rows = await admin(t).query(api.setDiscovery.getSetCandidates, {
      manufacturerId: brandId,
    });
    expect(rows[0].members).toEqual([{ label: "Finest Refractor" }]);
    expect(rows[0].members[0]).not.toHaveProperty("id");
  });

  test("never returns skippedByUserId, skippedAt or the root's own marketplaceId", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    await seedCandidate(t, brandId);

    const rows = await admin(t).query(api.setDiscovery.getSetCandidates, {
      manufacturerId: brandId,
    });
    expect(rows[0]).not.toHaveProperty("skippedByUserId");
    expect(rows[0]).not.toHaveProperty("skippedAt");
    expect(rows[0]).not.toHaveProperty("marketplaceId");
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .query(api.setDiscovery.getSetCandidates, { manufacturerId: brandId }),
    ).rejects.toThrow(/Admin access required/);
  });
});

describe("getSetCandidatesForYear", () => {
  test("stamps each row with its brand, in brand display order", async () => {
    const t = convexTest(schema, modules);
    const { yearId, brandId } = await seedTree(t);
    const bowmanId = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Bowman",
        platformData: {},
        parentId: yearId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    await seedCandidate(t, brandId, { label: "Finest" }); // Topps
    await seedCandidate(t, bowmanId, { marketplaceId: "sl-2", label: "Chrome" }); // Bowman

    const rows = await admin(t).query(api.setDiscovery.getSetCandidatesForYear, {
      yearId,
    });

    expect(rows.map((r) => r.brand)).toEqual(["Bowman", "Topps"]);
  });

  test("returns [] for an id that is not a year", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    await seedCandidate(t, brandId);

    const rows = await admin(t).query(api.setDiscovery.getSetCandidatesForYear, {
      yearId: brandId,
    });
    expect(rows).toEqual([]);
  });

  test("status: 'skipped' filters the year-wide list the same way", async () => {
    const t = convexTest(schema, modules);
    const { yearId, brandId } = await seedTree(t);
    await seedCandidate(t, brandId, { label: "Finest" });
    await seedCandidate(t, brandId, {
      marketplaceId: "sl-2",
      label: "Chrome",
      status: "skipped",
    });

    const rows = await admin(t).query(api.setDiscovery.getSetCandidatesForYear, {
      yearId,
      status: "skipped",
    });
    expect(rows.map((r) => r.label)).toEqual(["Chrome"]);
  });
});

describe("createSetFromCandidate", () => {
  test("D13 shape: a setName row with platformData: {} and a Base carrying the SL slot, in one transaction", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId, {
      marketplaceId: "sl-9",
      label: "Finest",
    });

    const result = await admin(t).mutation(
      api.setDiscovery.createSetFromCandidate,
      { candidateId, name: "Topps Finest" },
    );

    const [setRow, baseRow, brandRow, candidateGone] = await t.run(
      async (ctx) => [
        await ctx.db.get(result.setId),
        await ctx.db.get(result.baseId),
        await ctx.db.get(brandId),
        await ctx.db.get(candidateId),
      ],
    );

    expect(setRow?.level).toBe("setName");
    expect(setRow?.value).toBe("Topps Finest");
    expect(setRow?.platformData).toEqual({});
    expect(setRow?.children).toEqual([result.baseId]);

    expect(baseRow?.level).toBe("variantType");
    expect(baseRow?.value).toBe("Base");
    expect(baseRow?.metadata?.isBase).toBe(true);
    expect(baseRow?.platformData.sportlots).toEqual({ s0: "sl-9" });
    expect(baseRow?.platformLabels?.sportlots).toEqual({ s0: "Finest" });
    // No BSC facet, no primaryPlatformId (one slot; lowest-numbered wins by
    // default) — the D13 shape the schema specialist settled.
    expect(baseRow?.platformData.bsc).toBeUndefined();
    expect(baseRow?.primaryPlatformId).toBeUndefined();

    expect(brandRow?.children).toContain(result.setId);
    expect(candidateGone).toBeNull();
  });

  test("security review S1 — refuses a non-sportlots candidate rather than filing it under the wrong marketplace", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId, { side: "bsc" });

    let thrown: unknown;
    try {
      await admin(t).mutation(api.setDiscovery.createSetFromCandidate, {
        candidateId,
        name: "Topps Finest",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // The candidate survives — this is a refusal, not a silent drop.
    const stillThere = await t.run((ctx) => ctx.db.get(candidateId));
    expect(stillThere).not.toBeNull();
  });

  test("a sibling name clash under the target brand refuses with SET_NAME_CLASH_AT_TARGET, report only", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const existing = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Finest",
        platformData: {},
        parentId: brandId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const candidateId = await seedCandidate(t, brandId, { label: "Finest" });

    let thrown: unknown;
    try {
      await admin(t).mutation(api.setDiscovery.createSetFromCandidate, {
        candidateId,
        name: "Finest",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConvexError);
    expect(
      (thrown as ConvexError<{ code: string; existingId: string }>).data,
    ).toMatchObject({ code: "SET_NAME_CLASH_AT_TARGET", existingId: existing });

    // Nothing was created and the candidate survives for the operator to
    // rename or skip.
    const stillThere = await t.run((ctx) => ctx.db.get(candidateId));
    expect(stillThere).not.toBeNull();
  });

  test("the same name under a DIFFERENT manufacturer of the same year refuses with CUSTOM_EXISTS_ELSEWHERE", async () => {
    const t = convexTest(schema, modules);
    const { yearId, brandId } = await seedTree(t);
    const otherBrand = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "manufacturer",
        value: "Bowman",
        platformData: {},
        parentId: yearId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Finest",
        platformData: {},
        parentId: otherBrand,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const candidateId = await seedCandidate(t, brandId, { label: "Finest" });

    let thrown: unknown;
    try {
      await admin(t).mutation(api.setDiscovery.createSetFromCandidate, {
        candidateId,
        name: "Finest",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConvexError);
    expect(
      (thrown as ConvexError<{ code: string }>).data?.code,
    ).toBe("CUSTOM_EXISTS_ELSEWHERE");
  });

  test("refuses an invalid name with CUSTOM_VALUE_INVALID", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId);

    let thrown: unknown;
    try {
      await admin(t).mutation(api.setDiscovery.createSetFromCandidate, {
        candidateId,
        name: "",
      });
    } catch (error) {
      thrown = error;
    }
    expect(
      (thrown as ConvexError<{ code: string }>).data?.code,
    ).toBe("CUSTOM_VALUE_INVALID");
  });

  test("a gone candidate refuses cleanly", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId);
    await t.run((ctx) => ctx.db.delete(candidateId));

    await expect(
      admin(t).mutation(api.setDiscovery.createSetFromCandidate, {
        candidateId,
        name: "Topps Finest",
      }),
    ).rejects.toThrow(/already been filed/);
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId);

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .mutation(api.setDiscovery.createSetFromCandidate, {
          candidateId,
          name: "Topps Finest",
        }),
    ).rejects.toThrow(/Admin access required/);
  });
});

describe("skipSetCandidate", () => {
  test("marks the candidate skipped and stamps who/when", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId);

    await admin(t).mutation(api.setDiscovery.skipSetCandidate, {
      candidateId,
    });

    const row = await t.run((ctx) => ctx.db.get(candidateId));
    expect(row?.status).toBe("skipped");
    expect(row?.skippedByUserId).toBe(ADMIN_IDENTITY.subject);
    expect(row?.skippedAt).toBeTypeOf("number");
  });

  test("is idempotent — skipping an already-skipped row re-stamps who and when", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId, { status: "skipped" });

    await admin(t).mutation(api.setDiscovery.skipSetCandidate, {
      candidateId,
    });

    const row = await t.run((ctx) => ctx.db.get(candidateId));
    expect(row?.status).toBe("skipped");
  });

  test("a gone candidate refuses cleanly", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId);
    await t.run((ctx) => ctx.db.delete(candidateId));

    await expect(
      admin(t).mutation(api.setDiscovery.skipSetCandidate, { candidateId }),
    ).rejects.toThrow(/already been filed/);
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId);

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .mutation(api.setDiscovery.skipSetCandidate, { candidateId }),
    ).rejects.toThrow(/Admin access required/);
  });
});

describe("unskipSetCandidate", () => {
  test("brings a skipped root back to pending and clears the audit stamps", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId, { status: "skipped" });
    await t.run((ctx) =>
      ctx.db.patch(candidateId, {
        skippedAt: SENTINEL,
        skippedByUserId: "someone",
      }),
    );

    await admin(t).mutation(api.setDiscovery.unskipSetCandidate, {
      candidateId,
    });

    const row = await t.run((ctx) => ctx.db.get(candidateId));
    expect(row?.status).toBe("pending");
    expect(row?.skippedAt).toBeUndefined();
    expect(row?.skippedByUserId).toBeUndefined();
  });

  test("is idempotent — un-skipping an already-pending row touches nothing", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId, { status: "pending" });

    await admin(t).mutation(api.setDiscovery.unskipSetCandidate, {
      candidateId,
    });

    const row = await t.run((ctx) => ctx.db.get(candidateId));
    expect(row?.status).toBe("pending");
  });

  test("a gone candidate refuses cleanly — a root upstream dropped stays gone", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId, { status: "skipped" });
    await t.run((ctx) => ctx.db.delete(candidateId));

    await expect(
      admin(t).mutation(api.setDiscovery.unskipSetCandidate, { candidateId }),
    ).rejects.toThrow(/already been filed/);
  });

  test("rejects a non-admin caller", async () => {
    const t = convexTest(schema, modules);
    const { brandId } = await seedTree(t);
    const candidateId = await seedCandidate(t, brandId, { status: "skipped" });

    await expect(
      t
        .withIdentity(NON_ADMIN_IDENTITY)
        .mutation(api.setDiscovery.unskipSetCandidate, { candidateId }),
    ).rejects.toThrow(/Admin access required/);
  });
});
