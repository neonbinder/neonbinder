/**
 * NEO-189 — the variation-name reconciliation surface.
 *
 * The behaviour that matters here is what happens to a label nobody has ruled
 * on. It must come back as `unresolved` — never silently mapped, never
 * defaulted to the marketplace's own wording — because both failure modes
 * corrupt data quietly: guessing merges two distinct variations, and falling
 * back to the raw label makes the same card's variation change name depending
 * on which marketplace synced last.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

// convex-test needs import.meta.glob to discover the function modules.
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = { subject: "user_admin", role: "admin" };

describe("resolveVariationLabels", () => {
  test("an unseen label is reported unresolved, not guessed at", async () => {
    const t = convexTest(schema, modules);
    const res = await t.query(api.variationTypes.resolveVariationLabels, {
      labels: [{ platform: "bsc", label: "City / Throwback" }],
    });
    expect(res.resolved).toEqual([]);
    expect(res.unresolved).toEqual([
      { platform: "bsc", labelRaw: "City / Throwback", labelKey: "city / throwback" },
    ]);
  });

  test("after the admin decides, the same label resolves", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);

    const created = await asAdmin.mutation(api.variationTypes.decideVariationLabel, {
      platform: "bsc",
      label: "Action",
      decision: { action: "create", name: "Action" },
    });
    expect(created.canonicalName).toBe("Action");

    const res = await t.query(api.variationTypes.resolveVariationLabels, {
      labels: [{ platform: "bsc", label: "Action" }],
    });
    expect(res.unresolved).toEqual([]);
    expect(res.resolved[0].canonicalName).toBe("Action");
  });

  test("BOTH marketplaces' spellings converge on the one name the admin chose", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);

    const { variationTypeId } = await asAdmin.mutation(
      api.variationTypes.decideVariationLabel,
      {
        platform: "bsc",
        label: "Team Color",
        decision: { action: "create", name: "Team Color Swap" },
      },
    );
    await asAdmin.mutation(api.variationTypes.decideVariationLabel, {
      platform: "sportlots",
      label: "Team Name Color Swap",
      decision: { action: "link", variationTypeId },
    });

    const res = await t.query(api.variationTypes.resolveVariationLabels, {
      labels: [
        { platform: "bsc", label: "Team Color" },
        { platform: "sportlots", label: "Team Name Color Swap" },
      ],
    });
    expect(res.unresolved).toEqual([]);
    expect(res.resolved.map((r) => r.canonicalName)).toEqual([
      "Team Color Swap",
      "Team Color Swap",
    ]);
    // Same canonical row, not two rows that happen to share a string.
    expect(new Set(res.resolved.map((r) => r.variationTypeId)).size).toBe(1);
  });

  test("a label is matched regardless of casing and internal spacing", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(ADMIN).mutation(api.variationTypes.decideVariationLabel, {
      platform: "sportlots",
      label: "Action Image",
      decision: { action: "create", name: "Action" },
    });
    const res = await t.query(api.variationTypes.resolveVariationLabels, {
      labels: [{ platform: "sportlots", label: "  action   IMAGE " }],
    });
    expect(res.resolved[0]?.canonicalName).toBe("Action");
  });

  test("the same platform label on the OTHER platform is still unresolved", async () => {
    // BSC deciding "Action" says nothing about what SportLots means by it.
    const t = convexTest(schema, modules);
    await t.withIdentity(ADMIN).mutation(api.variationTypes.decideVariationLabel, {
      platform: "bsc",
      label: "Alternate",
      decision: { action: "create", name: "Throwback Alternate" },
    });
    const res = await t.query(api.variationTypes.resolveVariationLabels, {
      labels: [{ platform: "sportlots", label: "Alternate" }],
    });
    expect(res.resolved).toEqual([]);
    expect(res.unresolved).toHaveLength(1);
  });

  test("a repeated label costs one lookup, not one per card", async () => {
    const t = convexTest(schema, modules);
    const res = await t.query(api.variationTypes.resolveVariationLabels, {
      labels: Array.from({ length: 50 }, () => ({
        platform: "bsc" as const,
        label: "Nickname",
      })),
    });
    expect(res.unresolved).toHaveLength(1);
  });
});

describe("decideVariationLabel", () => {
  test("requires an admin", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.variationTypes.decideVariationLabel, {
        platform: "bsc",
        label: "Action",
        decision: { action: "create", name: "Action" },
      }),
    ).rejects.toThrow();
  });

  test("re-deciding a label overwrites rather than duplicating", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    await asAdmin.mutation(api.variationTypes.decideVariationLabel, {
      platform: "bsc",
      label: "Action",
      decision: { action: "create", name: "Wrong Name" },
    });
    await asAdmin.mutation(api.variationTypes.decideVariationLabel, {
      platform: "bsc",
      label: "Action",
      decision: { action: "create", name: "Action" },
    });
    const res = await t.query(api.variationTypes.resolveVariationLabels, {
      labels: [{ platform: "bsc", label: "Action" }],
    });
    expect(res.resolved).toHaveLength(1);
    expect(res.resolved[0].canonicalName).toBe("Action");
  });

  test("two admins reaching for the same name converge on one row", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN);
    const a = await asAdmin.mutation(api.variationTypes.decideVariationLabel, {
      platform: "bsc",
      label: "Nickname",
      decision: { action: "create", name: "Nickname" },
    });
    const b = await asAdmin.mutation(api.variationTypes.decideVariationLabel, {
      platform: "sportlots",
      label: "Nickname",
      decision: { action: "create", name: "nickname" },
    });
    expect(b.variationTypeId).toBe(a.variationTypeId);
    const all = await t.query(api.variationTypes.listVariationTypes, {});
    expect(all).toHaveLength(1);
  });
});

describe("seedVariationTypes", () => {
  test("seeds the measured pairs and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const first = await t.mutation(internal.variationTypes.seedVariationTypes, {});
    expect(first.typesCreated).toBe(6);
    expect(first.aliasesCreated).toBe(12);

    const second = await t.mutation(internal.variationTypes.seedVariationTypes, {});
    expect(second).toEqual({ typesCreated: 0, aliasesCreated: 0 });

    const res = await t.query(api.variationTypes.resolveVariationLabels, {
      labels: [
        { platform: "bsc", label: "Action" },
        { platform: "sportlots", label: "Action Image" },
      ],
    });
    expect(res.resolved.map((r) => r.canonicalName)).toEqual(["Action", "Action"]);
  });

  test("NEVER clobbers a decision the admin has already made", async () => {
    const t = convexTest(schema, modules);
    await t.withIdentity(ADMIN).mutation(api.variationTypes.decideVariationLabel, {
      platform: "sportlots",
      label: "Action Image",
      decision: { action: "create", name: "Photo Variation" },
    });
    await t.mutation(internal.variationTypes.seedVariationTypes, {});

    const res = await t.query(api.variationTypes.resolveVariationLabels, {
      labels: [{ platform: "sportlots", label: "Action Image" }],
    });
    expect(res.resolved[0].canonicalName).toBe("Photo Variation");
  });
});
