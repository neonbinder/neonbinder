/**
 * NEO-277 — adversarial pass on the set-level team feature.
 *
 * Targets the four seams the happy-path suite
 * (`selectorOptions.setSelectorOptionTeams.test.ts`) does not reach:
 *
 *  - the hand-rolled `_creationTime` cursor in `cascadeSelectorOptionTeams`,
 *    at the exact page boundary;
 *  - two cascades scheduled back to back over the same subtree, and a card
 *    edited by `updateCard` mid-cascade;
 *  - `storeReconciledOptions` copy-down never touching an EXISTING row's
 *    `teamIds`, even one an operator has cleared;
 *  - the NEO-203 reviewed-content patch path on an EXISTING card never
 *    applying the set-level default, whether or not `teamOnCardIds` is among
 *    the accepted fields.
 *
 * Fixture style matches the file above: raw inserts for the tree,
 * `teamRowFields` for teams, fake timers plus a benign fetch stub.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { teamRowFields } from "./lib/teamRow";
import { MAX_CARD_TEAMS } from "./features/cardAttention";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    (async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ADMIN_IDENTITY = {
  subject: "admin_set_team_adv_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_set_team_adv_001",
  name: "Admin User",
  role: "admin",
};

type T = ReturnType<typeof convexTest>;

/** sport → setName → variantType, mirroring the happy-path file's seedTree. */
async function seedTree(
  t: T,
  teams: { setName?: Array<Id<"teams">>; variantType?: Array<Id<"teams">> } = {},
  sportId?: Id<"selectorOptions">,
) {
  return t.run(async (ctx) => {
    const sport =
      sportId ??
      (await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        sportConfig: { skuCode: "BB", league: "MLB" },
        platformData: {},
        children: [],
        lastUpdated: Date.now(),
      }));
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "2024 Topps",
      platformData: {},
      features: { season: "2024", manufacturer: "Topps" },
      parentId: sport,
      children: [],
      ...(teams.setName ? { teamIds: teams.setName } : {}),
      lastUpdated: Date.now(),
    });
    const sportRow = await ctx.db.get(sport);
    await ctx.db.patch(sport, {
      children: [...(sportRow?.children ?? []), setNameId],
    });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      features: { season: "2024", manufacturer: "Topps" },
      parentId: setNameId,
      children: [],
      ...(teams.variantType ? { teamIds: teams.variantType } : {}),
      lastUpdated: Date.now(),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId] });
    return { sportId: sport, setNameId, variantTypeId };
  });
}

async function seedTeam(
  t: T,
  sportId: Id<"selectorOptions">,
  parts: { name: string; location?: string },
): Promise<Id<"teams">> {
  return t.run(async (ctx) =>
    ctx.db.insert("teams", {
      ...teamRowFields(parts),
      sportId,
      lastUpdated: Date.now(),
    }),
  );
}

async function seedCard(
  t: T,
  selectorOptionId: Id<"selectorOptions">,
  cardNumber: string,
  extra: { teamOnCardIds?: Array<Id<"teams">> } = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber,
      cardName: `Card ${cardNumber}`,
      platformData: {},
      sortOrder: Number(cardNumber),
      lastUpdated: 1_700_000_000_000,
      ...extra,
    }),
  );
}

const getCard = (t: T, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => ctx.db.get(id));
const getNode = (t: T, id: Id<"selectorOptions">) =>
  t.run(async (ctx) => ctx.db.get(id));

// ===========================================================================
// The hand-rolled `_creationTime` cursor at the page boundary
// ===========================================================================

describe("NEO-277 adversarial: cascade cursor at the page boundary", () => {
  /**
   * `cascadeSelectorOptionTeams` resumes a node with
   * `.gt("_creationTime", cursor)`. The comment on the mutation asserts
   * `_creationTime` is unique within a table, so `.gt` cannot skip a row —
   * this test is the check on that assertion.
   *
   * convex-test's own `insert()` (node_modules/convex-test/dist/index.js)
   * enforces exactly that: `_creationTime = now <= lastCreationTime ?
   * lastCreationTime + 0.001 : now`, so two inserts in the same tick are
   * bumped 0.001ms apart rather than tied — even under `vi.useFakeTimers()`,
   * where `Date.now()` is frozen and every insert would otherwise get the
   * identical wall-clock value. There is no public API to force a genuine
   * tie (patch/replace both refuse a `_creationTime` that disagrees with the
   * stored one), so this test exercises the closest thing convex-test can
   * produce: 202 cards under one node, all 0.001ms apart, with the page
   * boundary (200/201) landing exactly on two of the closest-together rows.
   * If the cursor's `.gt` ever regressed to something that could drop a
   * boundary row (an off-by-one, or a comparison that treats near-equal
   * floats as equal), this is what would catch it.
   */
  test("every card survives a page split, including the two straddling the boundary", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const c = await seedTeam(t, sportId, { location: "Toledo", name: "Mud Hens" });
    const tree = await seedTree(t, {}, sportId);

    const CARD_COUNT = 202; // TEAM_CASCADE_CARD_PAGE (200) + 2
    await t.run(async (ctx) => {
      for (let i = 0; i < CARD_COUNT; i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: tree.variantTypeId,
          cardNumber: String(i + 1),
          cardName: `Card ${i + 1}`,
          platformData: {},
          sortOrder: i,
          lastUpdated: 1_700_000_000_000,
        });
      }
    });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [c],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const all = await t.run(async (ctx) =>
      ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", tree.variantTypeId),
        )
        .collect(),
    );
    expect(all).toHaveLength(CARD_COUNT);
    // In particular the 200th and 201st in creation order — the pair the
    // reschedule's cursor hands off between — both took the team.
    const byCreation = [...all].sort((a, b) => a._creationTime - b._creationTime);
    expect(byCreation[199].teamOnCardIds).toEqual([c]);
    expect(byCreation[200].teamOnCardIds).toEqual([c]);
    expect(all.every((card) => card.teamOnCardIds?.length === 1 && card.teamOnCardIds[0] === c)).toBe(true);
  });
});

// ===========================================================================
// Concurrency: two cascades back to back, and an edit landing mid-cascade
// ===========================================================================

describe("NEO-277 adversarial: concurrent cascades", () => {
  test("set A then set B in quick succession leaves every card on B, never on A", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const a = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const b = await seedTeam(t, sportId, { location: "Toledo", name: "Mud Hens" });
    const tree = await seedTree(t, {}, sportId);
    const empty = await seedCard(t, tree.variantTypeId, "1");
    const override = await seedCard(t, tree.variantTypeId, "2", {
      teamOnCardIds: [
        await seedTeam(t, sportId, { location: "Nashville", name: "Sounds" }),
      ],
    });
    const overrideBefore = await getCard(t, override);

    // Two edits, scheduled before either's cascade has run at all.
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [a],
    });
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [b],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The node itself: B's mutation ran synchronously after A's, so it is
    // never in question — the interesting claim is about the SCHEDULED work.
    expect((await getNode(t, tree.setNameId))!.teamIds).toEqual([b]);
    expect((await getNode(t, tree.variantTypeId))!.teamIds).toEqual([b]);

    // The empty card was inheriting; it must land on B, not get stranded on
    // A by whichever cascade happens to visit it first.
    expect((await getCard(t, empty))!.teamOnCardIds).toEqual([b]);
    // The card that already carried its own override before either edit is
    // untouched by both.
    const overrideAfter = await getCard(t, override);
    expect(overrideAfter!.teamOnCardIds).toEqual(overrideBefore!.teamOnCardIds);
    expect(overrideAfter!.lastUpdated).toBe(overrideBefore!.lastUpdated);
  });

  test("a card edited by updateCard between cascade chunks keeps the operator's value", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const c = await seedTeam(t, sportId, { location: "Toledo", name: "Mud Hens" });
    const override = await seedTeam(t, sportId, {
      location: "Nashville",
      name: "Sounds",
    });
    const tree = await seedTree(t, {}, sportId);

    // 250 empty cards under one node: the first cascade invocation processes
    // exactly the first TEAM_CASCADE_CARD_PAGE (200) and reschedules for the
    // remaining 50.
    const ids: Array<Id<"cardChecklist">> = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < 250; i++) {
        ids.push(
          await ctx.db.insert("cardChecklist", {
            selectorOptionId: tree.variantTypeId,
            cardNumber: String(i + 1),
            cardName: `Card ${i + 1}`,
            platformData: {},
            sortOrder: i,
            lastUpdated: 1_700_000_000_000,
          }),
        );
      }
    });

    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: tree.setNameId,
      teamIds: [c],
    });

    // Run exactly the FIRST cascade invocation (currently scheduled), then
    // stop before its self-reschedule is drained: `runOnlyPendingTimersAsync`
    // fires only what is pending right now, and `finishInProgressScheduledFunctions`
    // waits for that one invocation to actually finish (including its own
    // `ctx.scheduler.runAfter` call, which merely enqueues the NEXT round
    // rather than running it).
    await vi.runOnlyPendingTimersAsync();
    await t.finishInProgressScheduledFunctions();

    // Card #225 lives in the still-unprocessed second page. An operator
    // edits it here, between the two invocations, to an explicit override.
    const midCascadeCard = ids[224];
    await asAdmin.mutation(api.selectorOptions.updateCard, {
      id: midCascadeCard,
      teamOnCardIds: [override],
    });

    // Now let the rest of the cascade finish.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const edited = await getCard(t, midCascadeCard);
    expect(edited!.teamOnCardIds).toEqual([override]);

    // A neighbour in the same (second) page that was NOT touched still
    // followed normally, proving the cascade did reach that page at all.
    const neighbour = await getCard(t, ids[225]);
    expect(neighbour!.teamOnCardIds).toEqual([c]);
  });
});

// ===========================================================================
// storeReconciledOptions copy-down never touches an EXISTING row
// ===========================================================================

describe("NEO-277 adversarial: reconciliation copy-down", () => {
  test("a fresh insert through storeReconciledOptions inherits the parent's teamIds", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const bulls = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const { setNameId } = await seedTree(t, { setName: [bulls] }, sportId);

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId: setNameId,
      reconciledItems: [
        { value: "Chrome", platformData: { bsc: "bsc-variant-1" }, metadata: {} },
      ],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "variantType").eq("parentId", setNameId),
        )
        .collect(),
    );
    // seedTree already made one "Base" variantType; this reconciliation adds
    // a second, sibling row.
    const chrome = rows.find((r) => r.value === "Chrome");
    expect(chrome).toBeDefined();
    expect(chrome!.teamIds).toEqual([bulls]);
  });

  test("a parent with no set-level team never writes an empty teamIds array on the child", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { setNameId } = await seedTree(t);

    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId: setNameId,
      reconciledItems: [
        { value: "Chrome", platformData: { bsc: "bsc-variant-2" }, metadata: {} },
      ],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "variantType").eq("parentId", setNameId),
        )
        .collect(),
    );
    const chrome = rows.find((r) => r.value === "Chrome");
    expect(chrome).toBeDefined();
    expect("teamIds" in chrome!).toBe(false);
  });

  test("reconciling an EXISTING row never overwrites an operator-cleared teamIds", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId } = await seedTree(t);
    const bulls = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const { setNameId } = await seedTree(t, { setName: [bulls] }, sportId);

    // Insert once — inherits the parent's team.
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId: setNameId,
      reconciledItems: [
        { value: "Chrome", platformData: { bsc: "bsc-variant-3" }, metadata: {} },
      ],
    });
    const childRows = await t.run(async (ctx) =>
      ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "variantType").eq("parentId", setNameId),
        )
        .collect(),
    );
    const child = childRows.find((r) => r.value === "Chrome");
    expect(child).toBeDefined();
    expect(child!.teamIds).toEqual([bulls]);

    // Operator clears the child's team explicitly.
    await asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
      selectorOptionId: child!._id,
      teamIds: [],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect("teamIds" in (await getNode(t, child!._id))!).toBe(false);

    // Re-sync the SAME row (matched via existingId, tier 0) — a routine
    // re-fetch that finds nothing new to say about the row.
    await asAdmin.mutation(api.setReconciliation.storeReconciledOptions, {
      level: "variantType",
      parentId: setNameId,
      reconciledItems: [
        {
          value: "Chrome",
          platformData: { bsc: "bsc-variant-3" },
          metadata: {},
          existingId: child!._id,
        },
      ],
    });

    const after = await getNode(t, child!._id);
    expect("teamIds" in after!).toBe(false);
  });
});

// ===========================================================================
// The NEO-203 reviewed-content patch path never defaults an existing card
// ===========================================================================

describe("NEO-277 adversarial: NEO-203 patch path never applies the default", () => {
  test("an existing card re-synced with no applyFields keeps its empty team, not the leaf's", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedTree(t);
    const bulls = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const { variantTypeId } = await seedTree(t, { variantType: [bulls] }, sportId);
    const existingId = await seedCard(t, variantTypeId, "1");

    await t.run(async (ctx) =>
      ctx.runMutation(internal.selectorOptions.commitCardChecklistChunk, {
        selectorOptionId: variantTypeId,
        sportValue: "Baseball",
        cards: [
          {
            cardNumber: "1",
            cardName: "Card 1",
            platformData: { bsc: { ref: "bsc-1" } },
            sortOrder: 1,
            playerNames: [],
            teamNames: [],
            existingId,
            // No applyFields at all — a linkage-only re-sync.
          },
        ],
      }),
    );

    const after = await getCard(t, existingId);
    expect(after!.teamOnCardIds ?? []).toEqual([]);
    expect(after!.platformData.bsc).toBeDefined();
  });

  test("an existing card re-synced with applyFields naming OTHER fields still keeps its empty team", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedTree(t);
    const bulls = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const { variantTypeId } = await seedTree(t, { variantType: [bulls] }, sportId);
    const existingId = await seedCard(t, variantTypeId, "1");
    const before = await getCard(t, existingId);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.selectorOptions.commitCardChecklistChunk, {
        selectorOptionId: variantTypeId,
        sportValue: "Baseball",
        cards: [
          {
            cardNumber: "1",
            cardName: "Renamed",
            platformData: { bsc: { ref: "bsc-1" } },
            sortOrder: 1,
            playerNames: [],
            teamNames: [],
            existingId,
            // Accepted content, but teamOnCardIds is deliberately NOT named.
            applyFields: ["cardName"],
            baseVersion: before!.lastUpdated,
          },
        ],
      }),
    );

    const after = await getCard(t, existingId);
    expect(after!.cardName).toBe("Renamed");
    // The set-level team never rode in on an unrelated accepted field.
    expect(after!.teamOnCardIds ?? []).toEqual([]);
  });

  test("an existing card re-synced with teamOnCardIds accepted writes exactly the incoming value, not the leaf default", async () => {
    const t = convexTest(schema, modules);
    const { sportId } = await seedTree(t);
    const bulls = await seedTeam(t, sportId, { location: "Durham", name: "Bulls" });
    const reds = await seedTeam(t, sportId, { location: "Cincinnati", name: "Reds" });
    const { variantTypeId } = await seedTree(t, { variantType: [bulls] }, sportId);
    const existingId = await seedCard(t, variantTypeId, "1");
    const before = await getCard(t, existingId);

    await t.run(async (ctx) =>
      ctx.runMutation(internal.selectorOptions.commitCardChecklistChunk, {
        selectorOptionId: variantTypeId,
        sportValue: "Baseball",
        cards: [
          {
            cardNumber: "1",
            cardName: "Card 1",
            platformData: { bsc: { ref: "bsc-1" } },
            sortOrder: 1,
            playerNames: [],
            teamNames: ["Cincinnati Reds"],
            teamOnCardIds: [reds],
            existingId,
            applyFields: ["teamOnCardIds"],
            baseVersion: before!.lastUpdated,
          },
        ],
      }),
    );

    const after = await getCard(t, existingId);
    // The marketplace's own answer, never the leaf's Bulls default — an
    // existing card's team is NB content a re-sync may only SUGGEST via this
    // reviewed path, and here the operator accepted the suggestion.
    expect(after!.teamOnCardIds).toEqual([reds]);
  });
});

// ===========================================================================
// Validation: the MAX_CARD_TEAMS bound on the set-level write
// ===========================================================================

describe("NEO-277 adversarial: MAX_CARD_TEAMS bound", () => {
  test("more than MAX_CARD_TEAMS distinct ids is refused and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_IDENTITY);
    const { sportId, setNameId } = await seedTree(t);
    const before = await getNode(t, setNameId);

    const teamIds: Array<Id<"teams">> = [];
    for (let i = 0; i <= MAX_CARD_TEAMS; i++) {
      teamIds.push(
        await seedTeam(t, sportId, { location: `City ${i}`, name: `Team ${i}` }),
      );
    }
    expect(teamIds.length).toBe(MAX_CARD_TEAMS + 1);

    await expect(
      asAdmin.mutation(api.selectorOptions.setSelectorOptionTeams, {
        selectorOptionId: setNameId,
        teamIds,
      }),
    ).rejects.toThrow(new RegExp(`at most ${MAX_CARD_TEAMS} teams`));
    expect(await getNode(t, setNameId)).toEqual(before);
  });
});
