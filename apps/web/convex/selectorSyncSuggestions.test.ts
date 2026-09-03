/**
 * NEO-211 C + F — rename suggestions, and the one guard that protects
 * `selectorOptions.value` on every path that writes it.
 *
 * The sync stores what the marketplace calls a set and never renames the row.
 * "BSC renamed this set" is therefore not a pipeline, it is a QUERY over data
 * we already hold — which is why it works identically at every level, with the
 * fire-and-forget `ensureSelectorOptions` design, and with two admins in the
 * tree at once.
 *
 * Apply is fail-closed in four independent ways, and each has a test here: the
 * label comes off the server's own row (the args carry no label field at all),
 * the target must be a sibling at the stated (level, parentId), `baseVersion`
 * is re-checked in-transaction, and the rename goes through the shared guard.
 */

import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = (
  import.meta as unknown as {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_neo211_sugg",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_neo211_sugg",
  name: "Admin User",
  role: "admin",
};

const USER_IDENTITY = {
  subject: "user_neo211_sugg",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_neo211_sugg",
  name: "Normal User",
  role: "user",
};

const SENTINEL = 1_000_000;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

async function parentRow(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "manufacturer",
      value: "Topps Inc",
      platformData: {},
      children: [],
      lastUpdated: SENTINEL,
    }),
  );
}

/** A synced setName row whose stored BSC label may differ from its NB name. */
async function setRow(
  t: ReturnType<typeof convexTest>,
  parentId: Id<"selectorOptions">,
  value: string,
  bscLabel: string | undefined,
  over: Record<string, unknown> = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "setName",
      value,
      platformData: { bsc: { b0: "slug-" + value.toLowerCase() } },
      ...(bscLabel ? { platformLabels: { bsc: { b0: bscLabel } } } : {}),
      primaryPlatformId: { bsc: "b0" },
      platformSlotSeq: { bsc: 1 },
      parentId,
      children: [],
      lastUpdated: SENTINEL,
      ...over,
    }),
  );
}

describe("getSelectorSyncSuggestions", () => {
  test("offers the marketplace label only where it differs from NB's name", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const renamed = await setRow(t, parentId, "TCG", "Topps");
    await setRow(t, parentId, "Bowman", "Bowman"); // agrees — no suggestion
    await setRow(t, parentId, "Chrome", undefined); // no label — nothing to say

    const out = await asAdmin.query(
      api.selectorOptions.getSelectorSyncSuggestions,
      { level: "setName", parentId },
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      existingId: renamed,
      currentValue: "TCG",
      baseVersion: SENTINEL,
    });
    expect(out[0].suggestions).toEqual([
      { side: "bsc", label: "Topps", foldEqual: false },
    ]);
  });

  test("flags a formatting-only difference rather than hiding it", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    await setRow(t, parentId, "Topps Chrome", "Topps-Chrome!");

    const out = await asAdmin.query(
      api.selectorOptions.getSelectorSyncSuggestions,
      { level: "setName", parentId },
    );

    // `nameKey` folds punctuation, so this is a reformat, not a rewrite. The
    // matcher's own fold stays lower/trim — collapsing punctuation THERE would
    // merge "Gold /50" and "Gold 50" into one row.
    expect(out[0].suggestions[0]).toEqual({
      side: "bsc",
      label: "Topps-Chrome!",
      foldEqual: true,
    });
  });

  test("a declined label stops nagging, and a NEW label starts again", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const id = await setRow(t, parentId, "TCG", "Topps", {
      declinedUpstreamLabels: { bsc: "topps" },
    });

    expect(
      await asAdmin.query(api.selectorOptions.getSelectorSyncSuggestions, {
        level: "setName",
        parentId,
      }),
    ).toHaveLength(0);

    // BSC renames the set again. The decline was about ONE label.
    await t.run(async (ctx) =>
      ctx.db.patch(id, { platformLabels: { bsc: { b0: "Topps Series One" } } }),
    );
    expect(
      await asAdmin.query(api.selectorOptions.getSelectorSyncSuggestions, {
        level: "setName",
        parentId,
      }),
    ).toHaveLength(1);
  });

  test("never offers a rename the server would refuse (non-custom variantType)", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: { b0: "base-slug" } },
        platformLabels: { bsc: { b0: "Base Set" } },
        primaryPlatformId: { bsc: "b0" },
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      });
    });

    expect(
      await asAdmin.query(api.selectorOptions.getSelectorSyncSuggestions, {
        level: "variantType",
        parentId,
      }),
    ).toHaveLength(0);
  });

  test("is admin-gated", async () => {
    const t = convexTest(schema, modules);
    const parentId = await parentRow(t);
    await expect(
      t
        .withIdentity(USER_IDENTITY)
        .query(api.selectorOptions.getSelectorSyncSuggestions, {
          level: "setName",
          parentId,
        }),
    ).rejects.toThrow();
  });
});

describe("applySelectorSyncSuggestions", () => {
  test("accept renames the row to the label the SERVER read, not one sent in", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const id = await setRow(t, parentId, "TCG", "Topps");

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "setName",
        parentId,
        decisions: [
          { existingId: id, baseVersion: SENTINEL, side: "bsc", action: "accept" },
        ],
      },
    );

    expect(res).toEqual({
      applied: 1,
      declined: 0,
      stale: 0,
      clashed: 0,
      skipped: 0,
    });
    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.value).toBe("Topps");
  });

  test("decline records the label normalised and writes nothing else", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const id = await setRow(t, parentId, "TCG", "Topps");

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "setName",
        parentId,
        decisions: [
          {
            existingId: id,
            baseVersion: SENTINEL,
            side: "bsc",
            action: "decline",
          },
        ],
      },
    );

    expect(res.declined).toBe(1);
    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.value).toBe("TCG");
    // Normalised, so a re-cased "TOPPS" does not re-open a settled decision.
    expect(after?.declinedUpstreamLabels?.bsc).toBe("topps");
  });

  test("a decision taken against an older row is counted, not written", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const id = await setRow(t, parentId, "TCG", "Topps");
    // Deterministic "the row moved since the modal read it" — two real
    // Date.now() calls can land in the same millisecond.
    await t.run(async (ctx) =>
      ctx.db.patch(id, { lastUpdated: SENTINEL + 1000 }),
    );

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "setName",
        parentId,
        decisions: [
          { existingId: id, baseVersion: SENTINEL, side: "bsc", action: "accept" },
        ],
      },
    );

    expect(res).toMatchObject({ applied: 0, stale: 1 });
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.value).toBe("TCG");
  });

  test("a row under a different parent is skipped, never written", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const otherParent = await parentRow(t);
    const foreign = await setRow(t, otherParent, "TCG", "Topps");

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "setName",
        parentId,
        decisions: [
          {
            existingId: foreign,
            baseVersion: SENTINEL,
            side: "bsc",
            action: "accept",
          },
        ],
      },
    );

    expect(res).toMatchObject({ applied: 0, skipped: 1 });
    const after = await t.run(async (ctx) => ctx.db.get(foreign));
    expect(after?.value).toBe("TCG");
    expect(after?.lastUpdated).toBe(SENTINEL);
  });

  test("two accepts folding to the same name: the first applies, the second clashes", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const a = await setRow(t, parentId, "TCG One", "Topps");
    const b = await setRow(t, parentId, "TCG Two", "TOPPS");

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "setName",
        parentId,
        decisions: [
          { existingId: a, baseVersion: SENTINEL, side: "bsc", action: "accept" },
          { existingId: b, baseVersion: SENTINEL, side: "bsc", action: "accept" },
        ],
      },
    );

    // The clash check reads the IN-TRANSACTION working set; against the
    // original snapshot the second rename would have looked legal and left two
    // siblings the pickers cannot tell apart.
    expect(res).toMatchObject({ applied: 1, clashed: 1 });
    expect((await t.run(async (ctx) => ctx.db.get(a)))?.value).toBe("Topps");
    expect((await t.run(async (ctx) => ctx.db.get(b)))?.value).toBe("TCG Two");
  });

  test("accept one side and decline the other side of the SAME row in one call", async () => {
    // `SelectorSyncReviewModal`'s own doc comment and its
    // "accepting one side and declining the other is a normal outcome" test
    // both treat this as the ordinary case: a row can disagree with BOTH
    // marketplaces, and the operator resolves each side independently in one
    // Apply click. Both decisions carry the SAME `baseVersion` (the row's
    // `lastUpdated` at query time), because the UI builds them from one
    // reactive suggestion row.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "TCG",
        platformData: { bsc: { b0: "topps-slug" }, sportlots: { s0: "sl-slug" } },
        platformLabels: {
          bsc: { b0: "Topps" },
          sportlots: { s0: "Topps Chewing Gum" },
        },
        primaryPlatformId: { bsc: "b0", sportlots: "s0" },
        platformSlotSeq: { bsc: 1, sportlots: 1 },
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "setName",
        parentId,
        decisions: [
          { existingId: id, baseVersion: SENTINEL, side: "bsc", action: "accept" },
          {
            existingId: id,
            baseVersion: SENTINEL,
            side: "sportlots",
            action: "decline",
          },
        ],
      },
    );

    // Both land. `baseVersion` is checked against the version the row had when
    // this CALL started, not against a version the loop keeps bumping —
    // staleness means "someone else moved this row since the modal read it",
    // and our own first write is not somebody else. Comparing against the
    // moving value reported the second decision as "stale", indistinguishable
    // in the response from a real concurrent edit, for the exact per-side pair
    // the review modal invites in one Apply click.
    expect(res.applied).toBe(1);
    expect(res.declined).toBe(1);
    expect(res.stale).toBe(0);
    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.value).toBe("Topps");
    // And the decline is recorded, so SportLots' name is not offered again.
    expect(after?.declinedUpstreamLabels?.sportlots).toBe("topps chewing gum");
  });

  test("a stored label that would not pass validation is refused, not written", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    // Written by an older build, or by a path that predates the label check.
    const tooLong = await setRow(t, parentId, "Long", "x".repeat(300));
    const control = await setRow(t, parentId, "Break", "Top\nps");

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "setName",
        parentId,
        decisions: [
          {
            existingId: tooLong,
            baseVersion: SENTINEL,
            side: "bsc",
            action: "accept",
          },
          {
            existingId: control,
            baseVersion: SENTINEL,
            side: "bsc",
            action: "accept",
          },
        ],
      },
    );

    expect(res).toMatchObject({ applied: 0, skipped: 2 });
    expect((await t.run(async (ctx) => ctx.db.get(tooLong)))?.value).toBe("Long");
    expect((await t.run(async (ctx) => ctx.db.get(control)))?.value).toBe("Break");
  });

  test("accepts exactly 200 decisions in one call — the size limit itself, not the per-row logic", async () => {
    // 200 decisions across 200 DIFFERENT rows: nothing here should collide on
    // `existingId`, so this isolates "is the boundary count itself allowed"
    // from the same-row `baseVersion` behaviour covered separately below.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const ids = await Promise.all(
      Array.from({ length: 200 }, (_, i) => setRow(t, parentId, `Set ${i}`, "Topps")),
    );
    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "setName",
        parentId,
        decisions: ids.map((existingId) => ({
          existingId,
          baseVersion: SENTINEL,
          side: "bsc" as const,
          action: "decline" as const,
        })),
      },
    );
    expect(res.stale).toBe(0);
    expect(res.declined).toBe(200);
  });

  test("a redundant repeat of a decision is idempotent, not stale", async () => {
    // The other half of the accept+decline fix: because `baseVersion` is
    // measured against the call's opening snapshot, an exact repeat is simply
    // counted again and short-circuits on the decline branch's own "already
    // declined" check — no second write, no `lastUpdated` churn, and no
    // spurious "stale" that a caller would have to distinguish from a real
    // concurrent edit. Batching several decisions per row is safe.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const id = await setRow(t, parentId, "TCG", "Topps");
    const decision = {
      existingId: id,
      baseVersion: SENTINEL,
      side: "bsc" as const,
      action: "decline" as const,
    };

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      { level: "setName", parentId, decisions: [decision, decision] },
    );

    expect(res.declined).toBe(2);
    expect(res.stale).toBe(0);
    const after = await t.run(async (ctx) => ctx.db.get(id));
    expect(after?.declinedUpstreamLabels?.bsc).toBe("topps");
  });

  test("a decision whose row has no primary slot on that side is skipped, not written", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    // A row synced only through BSC — there is nothing to accept or decline
    // on the SportLots side, but a stale client (or a row that changed
    // between the query and the click) could still submit one.
    const id = await setRow(t, parentId, "TCG", "Topps");

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "setName",
        parentId,
        decisions: [
          {
            existingId: id,
            baseVersion: SENTINEL,
            side: "sportlots",
            action: "accept",
          },
        ],
      },
    );

    expect(res).toEqual({
      applied: 0,
      declined: 0,
      stale: 0,
      clashed: 0,
      skipped: 1,
    });
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.value).toBe("TCG");
  });

  test("accept refuses a clash against an UNTOUCHED sibling, not just another decision in the batch", async () => {
    // The earlier "two accepts folding to the same name" test proves the
    // clash check sees decisions landing in THIS call. This proves the other
    // half: a single decision clashes against a sibling that was never part
    // of the batch at all.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    // A plain, untouched sibling already named "Topps" — no suggestion of
    // its own, not mentioned anywhere in `decisions`.
    await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "setName",
        value: "Topps",
        platformData: {},
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const renamed = await setRow(t, parentId, "TCG", "Topps");

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "setName",
        parentId,
        decisions: [
          {
            existingId: renamed,
            baseVersion: SENTINEL,
            side: "bsc",
            action: "accept",
          },
        ],
      },
    );

    expect(res).toMatchObject({ applied: 0, clashed: 1 });
    expect((await t.run(async (ctx) => ctx.db.get(renamed)))?.value).toBe("TCG");
  });

  test("a decline survives a CASE-ONLY re-case of the same label — does not nag again", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const id = await setRow(t, parentId, "TCG", "Topps");
    await asAdmin.mutation(api.selectorOptions.applySelectorSyncSuggestions, {
      level: "setName",
      parentId,
      decisions: [
        { existingId: id, baseVersion: SENTINEL, side: "bsc", action: "decline" },
      ],
    });

    // BSC starts sending "TOPPS" (all caps) instead of "Topps" — the same
    // word, re-cased. Simulates a re-sync writing the new label directly
    // (bypassing the mutation's own `lastUpdated` bump so the suggestion
    // query is exercised against a version-mismatched baseVersion too).
    await t.run(async (ctx) =>
      ctx.db.patch(id, { platformLabels: { bsc: { b0: "TOPPS" } } }),
    );

    const suggestions = await asAdmin.query(
      api.selectorOptions.getSelectorSyncSuggestions,
      { level: "setName", parentId },
    );
    expect(suggestions).toHaveLength(0);
  });

  test("refuses more than 200 decisions in one call", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const parentId = await parentRow(t);
    const id = await setRow(t, parentId, "TCG", "Topps");
    await expect(
      asAdmin.mutation(api.selectorOptions.applySelectorSyncSuggestions, {
        level: "setName",
        parentId,
        decisions: Array.from({ length: 201 }, () => ({
          existingId: id,
          baseVersion: SENTINEL,
          side: "bsc" as const,
          action: "decline" as const,
        })),
      }),
    ).rejects.toThrow(/exceeds the 200/);
  });

  test("is admin-gated", async () => {
    const t = convexTest(schema, modules);
    const parentId = await parentRow(t);
    const id = await setRow(t, parentId, "TCG", "Topps");
    await expect(
      t
        .withIdentity(USER_IDENTITY)
        .mutation(api.selectorOptions.applySelectorSyncSuggestions, {
          level: "setName",
          parentId,
          decisions: [
            {
              existingId: id,
              baseVersion: SENTINEL,
              side: "bsc",
              action: "decline",
            },
          ],
        }),
    ).rejects.toThrow();
  });
});

// ===========================================================================
// NEO-211 F — one guard, every door
// ===========================================================================

describe("non-custom variantType values are protected on every write path", () => {
  async function seedVariantTypes(t: ReturnType<typeof convexTest>) {
    const parentId = await parentRow(t);
    const synced = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Base",
        platformData: { bsc: { b0: "base-slug" } },
        platformLabels: { bsc: { b0: "Base Set" } },
        primaryPlatformId: { bsc: "b0" },
        platformSlotSeq: { bsc: 1 },
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    const custom = await t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "My Variant",
        platformData: {},
        isCustom: true,
        parentId,
        children: [],
        lastUpdated: SENTINEL,
      }),
    );
    return { parentId, synced, custom };
  }

  test("renameSelectorOption throws a coded ConvexError", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { synced } = await seedVariantTypes(t);

    // The value drives Base detection, `getBaseVariantBySet`, and the BSC
    // checklist fetch's `variant` facet — so every variantType value is
    // load-bearing, not only "Base".
    await expect(
      asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
        id: synced,
        value: "Base Cards",
      }),
    ).rejects.toThrow(/VARIANT_TYPE_RENAME_REFUSED|cannot be renamed/);
    expect((await t.run(async (ctx) => ctx.db.get(synced)))?.value).toBe("Base");
  });

  test("a CUSTOM variantType row is still renameable", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { custom } = await seedVariantTypes(t);

    // `.maestro/rename-selector-option.yaml` renames a custom row; the refusal
    // must not reach it.
    await asAdmin.mutation(api.selectorOptions.renameSelectorOption, {
      id: custom,
      value: "My Renamed Variant",
    });
    expect((await t.run(async (ctx) => ctx.db.get(custom)))?.value).toBe(
      "My Renamed Variant",
    );
  });

  test("the reconciliation modal's tier-0 rename is refused too", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { parentId, synced } = await seedVariantTypes(t);

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId,
      coveredSides: ["bsc"],
      reconciledItems: [
        {
          value: "Base Cards",
          platformData: { bsc: "base-slug" },
          existingId: synced,
          metadata: undefined,
        },
      ],
    });

    const after = await t.run(async (ctx) => ctx.db.get(synced));
    // The name is refused; the LINKAGE the operator just confirmed still lands.
    expect(after?.value).toBe("Base");
    expect(after?.platformData.bsc).toEqual({ b0: "base-slug" });
  });

  test("a tier-0 item whose value is UNCHANGED never attempts the rename, so a protected row is not refused", async () => {
    // `storeReconciledOptions` only calls into the guarded rename path when
    // the incoming value differs (folded) from the row's own. Re-confirming
    // linkage on an unchanged variantType row must be a normal, silent
    // no-op — not an error surfaced to an operator who did nothing wrong.
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { parentId, synced } = await seedVariantTypes(t);

    await expect(
      asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
        level: "variantType",
        parentId,
        coveredSides: ["bsc"],
        reconciledItems: [
          {
            value: "Base", // identical to the stored value
            platformData: { bsc: "base-slug" },
            existingId: synced,
            metadata: undefined,
          },
        ],
      }),
    ).resolves.toMatchObject({ success: true });

    const after = await t.run(async (ctx) => ctx.db.get(synced));
    expect(after?.value).toBe("Base");
  });

  test("applySelectorSyncSuggestions accept is refused too", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { parentId, synced } = await seedVariantTypes(t);

    const res = await asAdmin.mutation(
      api.selectorOptions.applySelectorSyncSuggestions,
      {
        level: "variantType",
        parentId,
        decisions: [
          {
            existingId: synced,
            baseVersion: SENTINEL,
            side: "bsc",
            action: "accept",
          },
        ],
      },
    );

    expect(res).toMatchObject({ applied: 0, skipped: 1 });
    expect((await t.run(async (ctx) => ctx.db.get(synced)))?.value).toBe("Base");
  });
});
