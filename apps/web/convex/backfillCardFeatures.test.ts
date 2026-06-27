/**
 * NEO-38 (PR B-3): tests for the node+card materialized feature backfill.
 *
 * Proves, end-to-end through the admin-triggered + self-rescheduling
 * mutation chain:
 *   1. A pre-existing set subtree with BLANK features + some cards gets the
 *      `deriveSetLevelFeatures` heuristic materialized onto the right NODES
 *      AND the cards after backfill.
 *   2. An existing operator override on a node OR a card is PRESERVED (the
 *      fill-absent + materialize override rule never clobbers it).
 *   3. A second backfill run is a NO-OP (idempotent).
 *
 * The backfill schedules `backfillCardFeaturesBatch` via `ctx.scheduler`, which
 * self-reschedules with the next cursor; we drain the whole chain with
 * `finishAllScheduledFunctions(vi.runAllTimers)`.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_IDENTITY = {
  subject: "admin_user_001",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_user_001",
  name: "Admin User",
  role: "admin",
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Builder: a pre-pipeline set subtree — sport → year → manufacturer → setName
// → variantType ("Base") + insert ("Stars"), with cards under each variant
// node and NO `features` anywhere (mirrors data synced before PR B-1).
// ---------------------------------------------------------------------------

type SeedIds = {
  sportId: Id<"selectorOptions">;
  yearId: Id<"selectorOptions">;
  mfrId: Id<"selectorOptions">;
  setNameId: Id<"selectorOptions">;
  variantTypeId: Id<"selectorOptions">;
  insertId: Id<"selectorOptions">;
  baseCardIds: Array<Id<"cardChecklist">>;
  insertCardIds: Array<Id<"cardChecklist">>;
};

async function seedPrePipelineSet(
  t: ReturnType<typeof convexTest>,
  opts?: {
    sport?: string;
    year?: string;
    manufacturer?: string;
    nodeFeatures?: Partial<
      Record<
        "sport" | "year" | "manufacturer" | "setName" | "variantType" | "insert",
        Record<string, string>
      >
    >;
    baseCardFeaturesPerIndex?: Record<number, Record<string, string>>;
  },
): Promise<SeedIds> {
  const sport = opts?.sport ?? "Baseball";
  const year = opts?.year ?? "2024";
  const manufacturer = opts?.manufacturer ?? "Topps";
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport" as const,
      value: sport,
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
      ...(opts?.nodeFeatures?.sport ? { features: opts.nodeFeatures.sport } : {}),
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year" as const,
      value: year,
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: Date.now(),
      ...(opts?.nodeFeatures?.year ? { features: opts.nodeFeatures.year } : {}),
    });
    await ctx.db.patch(sportId, { children: [yearId] });
    const mfrId = await ctx.db.insert("selectorOptions", {
      level: "manufacturer" as const,
      value: manufacturer,
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: Date.now(),
      ...(opts?.nodeFeatures?.manufacturer
        ? { features: opts.nodeFeatures.manufacturer }
        : {}),
    });
    await ctx.db.patch(yearId, { children: [mfrId] });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName" as const,
      value: `${year} ${manufacturer}`,
      platformData: {},
      parentId: mfrId,
      children: [],
      lastUpdated: Date.now(),
      ...(opts?.nodeFeatures?.setName
        ? { features: opts.nodeFeatures.setName }
        : {}),
    });
    await ctx.db.patch(mfrId, { children: [setNameId] });
    const variantTypeId = await ctx.db.insert("selectorOptions", {
      level: "variantType" as const,
      value: "Base",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
      ...(opts?.nodeFeatures?.variantType
        ? { features: opts.nodeFeatures.variantType }
        : {}),
    });
    const insertId = await ctx.db.insert("selectorOptions", {
      level: "insert" as const,
      value: "Stars",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: Date.now(),
      ...(opts?.nodeFeatures?.insert ? { features: opts.nodeFeatures.insert } : {}),
    });
    await ctx.db.patch(setNameId, { children: [variantTypeId, insertId] });

    const baseCardIds: Array<Id<"cardChecklist">> = [];
    for (let i = 0; i < 3; i++) {
      const features = opts?.baseCardFeaturesPerIndex?.[i];
      const id = await ctx.db.insert("cardChecklist", {
        selectorOptionId: variantTypeId,
        cardNumber: String(i + 1),
        cardName: `Base ${i + 1}`,
        platformData: {},
        sortOrder: i,
        lastUpdated: Date.now(),
        ...(features ? { features } : {}),
      });
      baseCardIds.push(id);
    }
    const insertCardIds: Array<Id<"cardChecklist">> = [];
    for (let i = 0; i < 2; i++) {
      const id = await ctx.db.insert("cardChecklist", {
        selectorOptionId: insertId,
        cardNumber: `S${i + 1}`,
        cardName: `Star ${i + 1}`,
        platformData: {},
        sortOrder: i,
        lastUpdated: Date.now(),
      });
      insertCardIds.push(id);
    }

    return {
      sportId,
      yearId,
      mfrId,
      setNameId,
      variantTypeId,
      insertId,
      baseCardIds,
      insertCardIds,
    };
  });
}

async function runBackfill(
  t: ReturnType<typeof convexTest>,
  numItems?: number,
): Promise<void> {
  const asAdmin = t.withIdentity(ADMIN_IDENTITY);
  await asAdmin.mutation(api.backfillCardFeatures.runCardFeaturesBackfill, {
    ...(numItems !== undefined ? { numItems } : {}),
  });
  // Drain the self-rescheduling batch chain.
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

const getNode = (t: ReturnType<typeof convexTest>, id: Id<"selectorOptions">) =>
  t.run(async (ctx) => ctx.db.get(id));
const getCard = (t: ReturnType<typeof convexTest>, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => ctx.db.get(id));

// ===========================================================================

describe("runCardFeaturesBackfill (node+card materialized backfill)", () => {
  test("materializes the heuristic onto the right NODES and the cards", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedPrePipelineSet(t, {
      sport: "Baseball",
      year: "1975", // vintage era
      manufacturer: "Topps",
    });

    await runBackfill(t);

    // --- NODES: each heuristic key landed where the backfill anchors it. ---
    // league/era/vintage/manufacturer/isReprint are anchored at the SETNAME
    // node (set-scoped materialize); cardType at each variant node.
    const setNameNode = await getNode(t, ids.setNameId);
    expect(setNameNode!.features?.league).toBe("MLB");
    expect(setNameNode!.features?.era).toBe("Vintage (1970-79)");
    expect(setNameNode!.features?.vintage).toBe("true");
    expect(setNameNode!.features?.manufacturer).toBe("Topps");
    expect(setNameNode!.features?.isReprint).toBe("false");
    // setName isn't a variant node, so it carries no cardType of its own.
    expect(setNameNode!.features?.cardType).toBeUndefined();

    // variant nodes get cardType from their OWN level.
    const variantNode = await getNode(t, ids.variantTypeId);
    const insertNode = await getNode(t, ids.insertId);
    expect(variantNode!.features?.cardType).toBe("Base");
    expect(insertNode!.features?.cardType).toBe("Insert");
    // ...and inherit the setName-anchored keys via materialization.
    expect(variantNode!.features?.league).toBe("MLB");
    expect(variantNode!.features?.isReprint).toBe("false");
    expect(insertNode!.features?.era).toBe("Vintage (1970-79)");

    // --- CARDS: under each variant node, fully resolved. ---
    for (const id of ids.baseCardIds) {
      const card = await getCard(t, id);
      expect(card!.features?.league).toBe("MLB");
      expect(card!.features?.era).toBe("Vintage (1970-79)");
      expect(card!.features?.vintage).toBe("true");
      expect(card!.features?.manufacturer).toBe("Topps");
      expect(card!.features?.isReprint).toBe("false");
      expect(card!.features?.cardType).toBe("Base");
    }
    for (const id of ids.insertCardIds) {
      const card = await getCard(t, id);
      expect(card!.features?.league).toBe("MLB");
      expect(card!.features?.cardType).toBe("Insert"); // insert leaf, not Base
      expect(card!.features?.isReprint).toBe("false");
    }
  });

  test("league only for stick-and-ball sports; non-mapped sport gets none", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedPrePipelineSet(t, {
      sport: "Pokemon",
      year: "2023",
      manufacturer: "Pokemon Company",
    });

    await runBackfill(t);

    const setNameNode = await getNode(t, ids.setNameId);
    // No league for Pokemon, but era/vintage/manufacturer/isReprint still seed.
    expect(setNameNode!.features?.league).toBeUndefined();
    expect(setNameNode!.features?.era).toBe("Modern (1980-Now)");
    expect(setNameNode!.features?.vintage).toBe("false");
    expect(setNameNode!.features?.manufacturer).toBe("Pokemon Company");
    expect(setNameNode!.features?.isReprint).toBe("false");
  });

  test("preserves an operator override on a NODE (fill-absent, no clobber)", async () => {
    const t = convexTest(schema, modules);
    // Operator already corrected manufacturer at the setName node AND
    // pre-set isReprint="true" there. The backfill must not overwrite either.
    const ids = await seedPrePipelineSet(t, {
      manufacturer: "Topps",
      nodeFeatures: {
        setName: { manufacturer: "Topps (Operator)", isReprint: "true" },
      },
    });

    await runBackfill(t);

    const setNameNode = await getNode(t, ids.setNameId);
    expect(setNameNode!.features?.manufacturer).toBe("Topps (Operator)"); // preserved
    expect(setNameNode!.features?.isReprint).toBe("true"); // preserved
    // The keys the operator did NOT set still get the heuristic.
    expect(setNameNode!.features?.league).toBe("MLB");

    // The setName node already carried manufacturer=isReprint values, so the
    // fill-absent seed SKIPS those keys entirely — it does not (and must not)
    // re-cascade an already-set node value onto cards. Critically, the WRONG
    // heuristic value ("Topps") is never pushed down: the card's manufacturer
    // stays whatever it was (here: undefined), not the heuristic guess. The
    // keys the operator left blank (league) DO materialize down to the cards.
    for (const id of ids.baseCardIds) {
      const card = await getCard(t, id);
      expect(card!.features?.manufacturer).toBeUndefined();
      expect(card!.features?.isReprint).toBeUndefined();
      expect(card!.features?.league).toBe("MLB");
    }
  });

  test("preserves an operator override on a CARD", async () => {
    const t = convexTest(schema, modules);
    // One base card already has league=NPB (a per-card override). The
    // setName-anchored league=MLB materialize must skip it.
    const ids = await seedPrePipelineSet(t, {
      baseCardFeaturesPerIndex: { 1: { league: "NPB" } },
    });

    await runBackfill(t);

    const card0 = await getCard(t, ids.baseCardIds[0]);
    const card1 = await getCard(t, ids.baseCardIds[1]);
    const card2 = await getCard(t, ids.baseCardIds[2]);
    expect(card0!.features?.league).toBe("MLB");
    expect(card1!.features?.league).toBe("NPB"); // override preserved
    expect(card2!.features?.league).toBe("MLB");
    // The overridden card still gets the OTHER (non-conflicting) keys.
    expect(card1!.features?.cardType).toBe("Base");
    expect(card1!.features?.isReprint).toBe("false");
  });

  test("second run is a no-op (idempotent — nothing changes)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedPrePipelineSet(t, { year: "1975" });

    await runBackfill(t);

    // Snapshot every node + card after the first run.
    const snapshot = async () => {
      const nodes = await Promise.all(
        [
          ids.sportId,
          ids.yearId,
          ids.mfrId,
          ids.setNameId,
          ids.variantTypeId,
          ids.insertId,
        ].map((id) => getNode(t, id)),
      );
      const cards = await Promise.all(
        [...ids.baseCardIds, ...ids.insertCardIds].map((id) => getCard(t, id)),
      );
      return JSON.stringify({
        nodes: nodes.map((n) => n!.features ?? null),
        cards: cards.map((c) => c!.features ?? null),
      });
    };
    const afterFirst = await snapshot();

    // Second run.
    await runBackfill(t);
    const afterSecond = await snapshot();

    expect(afterSecond).toBe(afterFirst);
  });

  test("drains multiple sets across batches (small page forces reschedule)", async () => {
    const t = convexTest(schema, modules);
    // Three independent sets; page size 1 forces the chain to reschedule twice.
    const a = await seedPrePipelineSet(t, { year: "1975", manufacturer: "Topps" });
    const b = await seedPrePipelineSet(t, { year: "2024", manufacturer: "Panini" });
    const c = await seedPrePipelineSet(t, { year: "1968", manufacturer: "Fleer" });

    await runBackfill(t, 1);

    const setA = await getNode(t, a.setNameId);
    const setB = await getNode(t, b.setNameId);
    const setC = await getNode(t, c.setNameId);
    expect(setA!.features?.vintage).toBe("true"); // 1975
    expect(setB!.features?.vintage).toBe("false"); // 2024
    expect(setC!.features?.vintage).toBe("true"); // 1968
    expect(setA!.features?.manufacturer).toBe("Topps");
    expect(setB!.features?.manufacturer).toBe("Panini");
    expect(setC!.features?.manufacturer).toBe("Fleer");

    // A card in each set is fully resolved too.
    const aCard = await getCard(t, a.baseCardIds[0]);
    const bCard = await getCard(t, b.baseCardIds[0]);
    expect(aCard!.features?.cardType).toBe("Base");
    expect(bCard!.features?.league).toBe("MLB");
  });
});
