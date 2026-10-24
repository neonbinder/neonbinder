/**
 * NEO-330 — a team name the operator skipped as "not a team" for a set never
 * comes back to that set's cards through the post-commit BSC team check.
 *
 * "Skip <name> — not a team" in the checklist wizard writes an
 * `entityReviewSkips` row, and the commit lands the card with no team and
 * nothing pending. The same card can still be queued for the BSC check (the
 * commit queues every teamless BSC card; `enqueueBscTeamBackfill` scans for
 * the same shape), and BSC answers with the string the operator threw out.
 * `cardChecklist.applyBscTeamResolution` must neither link it nor keep it as
 * the `bscTeamName` hint, and must stamp `teamCheckDoneAt` so nothing asks
 * again.
 *
 * Covered:
 *  - a skipped name: no team, no hint, stamped; a held team of that name is
 *    still not linked; a stale hint is cleared; the backfill does not re-queue
 *  - the skip landing while the lookup is in flight (through the real
 *    `resolveBscCardTeam` action, the ruling written from inside its fetch)
 *  - a name NOT skipped still links / still hints, and another set's skip of
 *    the same name does not count
 *  - the NEO-333 comma split: the raw value skipped, one part skipped, every
 *    part skipped, and a part skipped while the whole string names a held team
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { teamRowFields } from "./lib/teamRow";
import { normalizeEntityName } from "../lib/entities/normalize-name";
import { insertTestCard } from "../lib/testing/card-row";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

type T = ReturnType<typeof convexTest>;

let harnesses: T[] = [];
function harness(): T {
  const t = convexTest(schema, modules);
  harnesses.push(t);
  return t;
}

beforeEach(() => {
  harnesses = [];
  // No test here may reach the network unless it installs its own stub.
  vi.stubGlobal("fetch", (async (url: string | URL) => {
    throw new Error(`NEO-330: test must not reach the network: ${String(url)}`);
  }) as unknown as typeof fetch);
});

afterEach(async () => {
  for (const t of harnesses) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending" || job.state.kind === "inProgress") {
          await ctx.scheduler.cancel(job._id);
        }
      }
    });
  }
  harnesses = [];
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedSet(
  t: T,
): Promise<{ sportId: Id<"selectorOptions">; leafId: Id<"selectorOptions"> }> {
  return t.run(async (ctx) => {
    const sportId = await ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      platformData: {},
      children: [],
      lastUpdated: 1,
    });
    const yearId = await ctx.db.insert("selectorOptions", {
      level: "year",
      value: "2024",
      platformData: {},
      parentId: sportId,
      children: [],
      lastUpdated: 1,
    });
    const setNameId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value: "Topps",
      platformData: {},
      parentId: yearId,
      children: [],
      lastUpdated: 1,
    });
    const leafId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Insert",
      platformData: {},
      parentId: setNameId,
      children: [],
      lastUpdated: 1,
    });
    return { sportId, leafId };
  });
}

/** A second leaf in the same sport and year: another set's skips. */
async function seedSiblingLeaf(
  t: T,
  leafId: Id<"selectorOptions">,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) => {
    const leaf = await ctx.db.get(leafId);
    return ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: {},
      parentId: leaf!.parentId!,
      children: [],
      lastUpdated: 1,
    });
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
      lastUpdated: 1,
    }),
  );
}

async function seedCard(
  t: T,
  leafId: Id<"selectorOptions">,
  extra: { bscTeamName?: string } = {},
): Promise<Id<"cardChecklist">> {
  return t.run(async (ctx) =>
    insertTestCard(ctx, {
      selectorOptionId: leafId,
      cardNumber: "1",
      cardName: "Card 1",
      platformData: { bsc: { ref: "bsc-1", src: "b0" } },
      sortOrder: 1,
      lastUpdated: 1,
      ...extra,
    }),
  );
}

/** The row the commit prelude writes for "Skip <name> — not a team". */
async function seedTeamSkip(
  t: T,
  selectorOptionId: Id<"selectorOptions">,
  name: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("entityReviewSkips", {
      selectorOptionId,
      kind: "team",
      nameNormalized: normalizeEntityName(name),
      name,
      skippedAt: 1,
      skippedByUserId: "user-skipper",
    });
  });
}

const getCard = (t: T, id: Id<"cardChecklist">) =>
  t.run(async (ctx) => ctx.db.get(id));

function apply(
  t: T,
  cardChecklistId: Id<"cardChecklist">,
  rawTeamName: string,
  teamNames: string[],
) {
  return t.mutation(internal.cardChecklist.applyBscTeamResolution, {
    cardChecklistId,
    rawTeamName,
    teamNames,
  });
}

/** The card the skip leaves: stamped, teamless, no hint. */
async function expectRuledOut(t: T, cardId: Id<"cardChecklist">) {
  const card = await getCard(t, cardId);
  expect(card!.teamOnCardIds ?? []).toEqual([]);
  expect(card!.bscTeamName).toBeUndefined();
  expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  expect(card!.pendingTeamNames ?? []).toEqual([]);
}

// ===========================================================================
// A skipped name
// ===========================================================================

describe("applyBscTeamResolution: a name skipped as not a team (NEO-330)", () => {
  test("no team and no hint, and the check is stamped done", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "CHECKLIST");

    await expect(apply(t, cardId, "CHECKLIST", ["CHECKLIST"])).resolves.toEqual({
      applied: false,
      unmatched: false,
    });
    await expectRuledOut(t, cardId);
  });

  test("matches the skip by normalized name, not by exact spelling", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "CHECKLIST");

    await apply(t, cardId, "Checklist.", ["Checklist."]);
    await expectRuledOut(t, cardId);
  });

  test("a held team of that name is still not linked: the ruling is the set's", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    // Created after the skip, or held all along: either way the operator said
    // this string is not a team ON THIS SET's cards.
    await seedTeam(t, sportId, { name: "Leaders" });
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "Leaders");

    await apply(t, cardId, "Leaders", ["Leaders"]);
    await expectRuledOut(t, cardId);
  });

  test("a stale hint naming the skipped string is cleared", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId, { bscTeamName: "CHECKLIST" });
    await seedTeamSkip(t, leafId, "CHECKLIST");

    await apply(t, cardId, "CHECKLIST", ["CHECKLIST"]);
    await expectRuledOut(t, cardId);
  });

  test("the backfill never re-queues the settled card", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "CHECKLIST");

    // Before the check the card is exactly what the backfill looks for.
    const before = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {});
    expect(before.enqueued).toBe(1);
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });

    await apply(t, cardId, "CHECKLIST", ["CHECKLIST"]);
    const after = await t.mutation(internal.cardChecklist.enqueueBscTeamBackfill, {});
    expect(after.enqueued).toBe(0);
  });
});

// ===========================================================================
// The skip landing while the lookup is in flight
// ===========================================================================

describe("resolveBscCardTeam: the skip lands mid-flight (NEO-330)", () => {
  test("a ruling written while BSC is answering still keeps the name off the card", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);

    // The card needs a check when the action starts (no skip yet); the
    // operator's re-fetch records the skip while the BSC request is out. The
    // writing mutation must read the ruling fresh, not trust the start state.
    let fetched = 0;
    vi.stubGlobal("fetch", (async () => {
      fetched += 1;
      await seedTeamSkip(t, leafId, "CHECKLIST");
      return new Response(JSON.stringify({ teamName: "CHECKLIST" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch);

    await expect(
      t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
        cardChecklistId: cardId,
      }),
    ).resolves.toBe("answered");
    expect(fetched).toBe(1);
    await expectRuledOut(t, cardId);
  });

  test("control: with no ruling, the same answer leaves BSC's string as the hint", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify({ teamName: "CHECKLIST" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch);

    await t.action(internal.adapters.buysportscards.resolveBscCardTeam, {
      cardChecklistId: cardId,
    });
    const card = await getCard(t, cardId);
    expect(card!.bscTeamName).toBe("CHECKLIST");
    expect(card!.teamCheckDoneAt).toBeTypeOf("number");
  });
});

// ===========================================================================
// A name that was not skipped
// ===========================================================================

describe("applyBscTeamResolution: names that were not skipped (NEO-330)", () => {
  test("a held team still links", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const cubs = await seedTeam(t, sportId, { location: "Chicago", name: "Cubs" });
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "CHECKLIST");

    await expect(
      apply(t, cardId, "Chicago Cubs", ["Chicago Cubs"]),
    ).resolves.toEqual({ applied: true, unmatched: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toEqual([cubs]);
    expect(card!.bscTeamName).toBeUndefined();
  });

  test("an unknown name still lands unmatched with BSC's string as the hint", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "CHECKLIST");

    await expect(
      apply(t, cardId, "Toledo Mud Hens", ["Toledo Mud Hens"]),
    ).resolves.toEqual({ applied: false, unmatched: true });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds ?? []).toEqual([]);
    expect(card!.bscTeamName).toBe("Toledo Mud Hens");
  });

  test("another set's skip of the same name does not count here", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const otherLeaf = await seedSiblingLeaf(t, leafId);
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, otherLeaf, "CHECKLIST");

    await expect(apply(t, cardId, "CHECKLIST", ["CHECKLIST"])).resolves.toEqual({
      applied: false,
      unmatched: true,
    });
    expect((await getCard(t, cardId))!.bscTeamName).toBe("CHECKLIST");
  });
});

// ===========================================================================
// The NEO-333 comma split
// ===========================================================================

describe("applyBscTeamResolution: skips against a comma-joined value (NEO-330 x NEO-333)", () => {
  test("the WHOLE raw value skipped rules the card out, even when its parts would link", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    await seedTeam(t, sportId, { location: "Chicago", name: "Cubs" });
    await seedTeam(t, sportId, { location: "Texas", name: "Rangers" });
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "Chicago Cubs, Texas Rangers");

    await apply(t, cardId, "Chicago Cubs, Texas Rangers", [
      "Chicago Cubs",
      "Texas Rangers",
    ]);
    await expectRuledOut(t, cardId);
  });

  test("one part skipped: the other part links on its own", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    const cubs = await seedTeam(t, sportId, { location: "Chicago", name: "Cubs" });
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "Rookie Debut");

    await expect(
      apply(t, cardId, "Chicago Cubs, Rookie Debut", ["Chicago Cubs", "Rookie Debut"]),
    ).resolves.toEqual({ applied: true, unmatched: false });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds).toEqual([cubs]);
    expect(card!.bscTeamName).toBeUndefined();
  });

  test("one part skipped, the other unknown: the hint names only the unknown part", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "Rookie Debut");

    await expect(
      apply(t, cardId, "Toledo Mud Hens, Rookie Debut", [
        "Toledo Mud Hens",
        "Rookie Debut",
      ]),
    ).resolves.toEqual({ applied: false, unmatched: true });
    const card = await getCard(t, cardId);
    expect(card!.teamOnCardIds ?? []).toEqual([]);
    expect(card!.bscTeamName).toBe("Toledo Mud Hens");
    expect(card!.bscTeamName).not.toContain("Rookie Debut");
  });

  test("every part skipped is a ruling on the whole card", async () => {
    const t = harness();
    const { leafId } = await seedSet(t);
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "League Leaders");
    await seedTeamSkip(t, leafId, "Checklist");

    await apply(t, cardId, "League Leaders, Checklist", [
      "League Leaders",
      "Checklist",
    ]);
    await expectRuledOut(t, cardId);
  });

  test("a part skipped does not stop the whole string linking the one team it names", async () => {
    const t = harness();
    const { sportId, leafId } = await seedSet(t);
    // "Korea, South" is one held team. A skip of "South" (offered when the
    // whole string matched nothing at fetch time) says nothing about it.
    const korea = await seedTeam(t, sportId, { name: "Korea, South" });
    const cardId = await seedCard(t, leafId);
    await seedTeamSkip(t, leafId, "South");

    await expect(
      apply(t, cardId, "Korea, South", ["Korea", "South"]),
    ).resolves.toEqual({ applied: true, unmatched: false });
    expect((await getCard(t, cardId))!.teamOnCardIds).toEqual([korea]);
  });
});
