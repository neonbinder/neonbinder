/**
 * NEO-239 renamed what this file is about. The branch under test is no longer
 * "is any ancestor user-created?" but "does this path carry the marketplace
 * ids either side needs?" — see `convex/marketplaceResolvability.ts`. The
 * fixture is unchanged in substance: a sport row with an empty `platformData`
 * is unresolvable on BOTH sides, which is exactly the state the `isCustom`
 * flag used to stand in for, and the skip lands in the same place in the
 * action.
 *
 * NEO-92 follow-up: `fetchCardChecklist`'s skip branch used to
 * short-circuit to `{cards: [], unknownPlayers: [], unknownTeams: []}`
 * unconditionally — a real, previously-unclosed gap. A custom-only set's
 * cards can still carry `pendingPlayerNames`/`pendingTeamNames` (from
 * `addCustomCard`), but since `fetchCardChecklist` was the ONLY place
 * unknowns were ever computed, those names could never be resolved via the
 * review wizard at all. This file covers the fix: the custom-subtree branch
 * now runs the same `resolveUnknownsAndStartBatch` pass the marketplace path
 * uses (BSC/SL fetching itself is still fully skipped — only the
 * pending-name resolution runs), and the batch it opens is scoped to the
 * calling user via `createdByUserId` (see `entityReviewQueue.test.ts` for
 * the scoping mechanism itself).
 *
 * No BSC/SL adapter mocking needed here (unlike
 * `fetchCardChecklistTeamLookup.test.ts`) — the whole point of the
 * custom-subtree branch is that it never calls either adapter.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { NO_MARKETPLACE_IDS_MESSAGE } from "./marketplaceResolvability";

/**
 * Credentials are not under test — hand the BSC adapter a token so the NEO-252
 * case below can reach the wire. The three original tests never call an
 * adapter at all, so this changes nothing for them.
 */
vi.mock("./credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./credentials")>();
  const { internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    getSiteToken: internalAction({
      args: { site: v.string() },
      returns: v.any(),
      handler: async () => ({ token: "test-bsc-token" }),
    }),
    authenticateBsc: internalAction({
      args: {},
      returns: v.any(),
      handler: async () => ({ success: true }),
    }),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// convex-test v0.0.53 with Vitest uses import.meta.glob to discover modules.
const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN_A = {
  subject: "admin_custom_subtree_a",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_custom_subtree_a",
  role: "admin",
};

const ADMIN_B = {
  subject: "admin_custom_subtree_b",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|admin_custom_subtree_b",
  role: "admin",
};

async function seedCustomSport(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value: "Baseball",
      sportConfig: {
        skuCode: "BB",
        league: "MLB",
        espn: { path: "baseball/mlb", leagueName: "Major League Baseball" },
        wikidata: { sportQid: "Q5369", hallOfFameQid: "Q1194380" },
      },
      // No ids on either side — nothing to ask BSC or SportLots.
      platformData: {},
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function seedCustomCardWithPendingPlayer(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  playerName: string,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber: "1",
      cardName: "Hand Added Card",
      pendingPlayerNames: [playerName],
      platformData: {},
      sortOrder: 0,
      lastUpdated: Date.now(),
    }),
  );
}

describe("fetchCardChecklist — a path with no marketplace ids", () => {
  test("surfaces a custom card's pendingPlayerNames as an unknown and opens a review batch", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_A);
    const selectorOptionId = await seedCustomSport(t);
    await seedCustomCardWithPendingPlayer(t, selectorOptionId, "Custom Subtree Player");

    const result = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId,
    });

    expect(result.success).toBe(true);
    // NEO-137: fetch no longer resolves entities — nothing is an NB card
    // until the operator pairs, so a custom subtree publishes no candidates at
    // all and the pending name surfaces from resolveChecklistEntities instead.
    //
    // `candidateCount` is the whole signal now that the cards travel on the
    // streamed `checklistCandidates` wire: it is what tells CardChecklist to
    // skip the pairing dialog rather than open an empty one. Asserted against
    // the table too, so a count of 0 cannot be a count that simply forgot to
    // include rows that were in fact written.
    expect(result.candidateCount).toBe(0);
    const live = await asAdmin.query(
      api.checklistCandidates.getReadyCandidates,
      { selectorOptionId },
    );
    expect(live.cards).toEqual([]);

    // `sportId` no longer rides back on the fetch — the client reads it off
    // the ancestor chain it already subscribes to. Here the custom subtree IS
    // the sport row.
    const resolved = await asAdmin.action(
      api.selectorOptions.resolveChecklistEntities,
      { selectorOptionId, sportId: selectorOptionId, cards: [] },
    );
    expect(resolved.unknownPlayers).toEqual(["Custom Subtree Player"]);
    expect(resolved.batchId).toBeTruthy();

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: resolved.batchId!,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Custom Subtree Player");
    expect(rows[0].kind).toBe("player");
  });

  test("a path with no marketplace ids commits with the fixed skip message, no batch opened", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_A);
    const selectorOptionId = await seedCustomSport(t);

    const result = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId,
    });

    expect(result.success).toBe(true);
    expect(result.message).toBe(NO_MARKETPLACE_IDS_MESSAGE);
    expect(result.candidateCount).toBe(0);

    const resolved = await asAdmin.action(
      api.selectorOptions.resolveChecklistEntities,
      { selectorOptionId, sportId: selectorOptionId, cards: [] },
    );
    expect(resolved.unknownPlayers).toEqual([]);
    expect(resolved.unknownTeams).toEqual([]);
    expect(resolved.batchId).toBeUndefined();
  });

  test("two different users fetching the SAME custom subtree get separate, non-colliding batches", async () => {
    // Direct regression coverage for the exact bug class this session fixed
    // in production: a shared review batch used to leak one caller's
    // pending names into another caller's wizard. Confirms the fix holds
    // for the custom-subtree path too, not just the marketplace path
    // (already covered in entityReviewQueue.test.ts).
    const t = convexTest(schema, modules);
    const asAdminA = t.withIdentity(ADMIN_A);
    const asAdminB = t.withIdentity(ADMIN_B);
    const selectorOptionId = await seedCustomSport(t);
    await seedCustomCardWithPendingPlayer(t, selectorOptionId, "Shared Set Player");

    await asAdminA.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId,
    });
    const resultA = await asAdminA.action(
      api.selectorOptions.resolveChecklistEntities,
      { selectorOptionId, sportId: selectorOptionId, cards: [] },
    );
    const resultB = await asAdminB.action(
      api.selectorOptions.resolveChecklistEntities,
      { selectorOptionId, sportId: selectorOptionId, cards: [] },
    );

    expect(resultA.batchId).toBeTruthy();
    expect(resultB.batchId).toBeTruthy();
    expect(resultB.batchId).not.toBe(resultA.batchId);
  });
});


// ===========================================================================
// NEO-252 — the attach-shaped chain the gate used to refuse
// ===========================================================================

/**
 * The reported bug, end to end.
 *
 * An operator builds a set in NeonBinder first — which is the supported order,
 * and the one "build 2027 Topps now, link it when the marketplaces catch up"
 * depends on. The setName row is therefore NB's own and carries no ids. Later
 * the BSC set turns up, and the operator attaches it where the attach dialog
 * lives: the variant row, tagged `setName` (NEO-189).
 *
 * The chain now carries everything a BSC checklist request needs, and
 * `resolveBscFacetFilters` builds exactly that request. The GATE, walking NB
 * levels, looked for an id on the setName ancestor, found none, and skipped
 * BSC — so the operator attached a set and the checklist stayed empty, with no
 * error anywhere to explain it.
 *
 * Asserted against the OUTGOING BODY rather than a call count on a stubbed
 * action, because the second half of the claim is that nothing NB-typed rides
 * along: the set and the variant here have deliberately unmistakable names.
 */
describe("fetchCardChecklist — a BSC set attached at the LEAF (NEO-252)", () => {
  const HAND_TYPED_SET = "My Hand Typed Set";
  const HAND_TYPED_VARIANT = "My Hand Typed Variant";
  const BSC_SET_SLUG = "2024-topps";

  /** Records every bulk-upload body; answers everything else emptily. */
  function recordingBsc(recorded: Array<Record<string, string[]>>) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/search/bulk-upload/results")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        recorded.push((body.filters ?? {}) as Record<string, string[]>);
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  async function seedLeafAttachedTree(
    t: ReturnType<typeof convexTest>,
  ): Promise<Id<"selectorOptions">> {
    return t.run(async (ctx) => {
      const sportId = await ctx.db.insert("selectorOptions", {
        level: "sport",
        value: "Baseball",
        sportConfig: { skuCode: "BB", league: "MLB" },
        platformData: { bsc: { b0: "baseball" } },
        platformSlotSeq: { bsc: 1 },
        children: [],
        lastUpdated: Date.now(),
      });
      const yearId = await ctx.db.insert("selectorOptions", {
        level: "year",
        value: "2024",
        platformData: { bsc: { b0: "2024" } },
        platformSlotSeq: { bsc: 1 },
        parentId: sportId,
        children: [],
        lastUpdated: Date.now(),
      });
      // NB's own set: no marketplace ids anywhere on it. This is the row the
      // level walk was looking at.
      const setNameId = await ctx.db.insert("selectorOptions", {
        level: "setName",
        value: HAND_TYPED_SET,
        platformData: {},
        parentId: yearId,
        children: [],
        lastUpdated: Date.now(),
      });
      // …and the BSC set, attached where the operator could actually attach it.
      return ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: HAND_TYPED_VARIANT,
        platformData: { bsc: { b0: "base", b1: BSC_SET_SLUG } },
        platformFacets: { bsc: { b0: "variant", b1: "setName" } },
        primaryPlatformId: { bsc: "b0" },
        platformSlotSeq: { bsc: 2 },
        parentId: setNameId,
        children: [],
        lastUpdated: Date.now(),
      });
    });
  }

  test("BSC is asked ONCE, scoped by the leaf's own facets", async () => {
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingBsc(recorded));
    const t = convexTest(schema, modules);
    const rowId = await seedLeafAttachedTree(t);

    const result = await t
      .withIdentity(ADMIN_A)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(true);
    // Not skipped, and not fanned out: one fully-scoped request.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      sport: ["baseball"],
      year: ["2024"],
      setName: [BSC_SET_SLUG],
      variant: ["base"],
    });
  });

  test("and nothing in that body is an NB display value", async () => {
    // The other half of the invariant. Widening the gate must not widen what
    // travels: every value on the wire is a slot id, and the two NB-typed
    // names on this path appear nowhere in it — not raw, not lowercased.
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingBsc(recorded));
    const t = convexTest(schema, modules);
    const rowId = await seedLeafAttachedTree(t);

    await t
      .withIdentity(ADMIN_A)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(recorded).toHaveLength(1);
    const sent = Object.values(recorded[0]).flat().join(" ");
    for (const displayValue of [HAND_TYPED_SET, HAND_TYPED_VARIANT]) {
      expect(sent).not.toContain(displayValue);
      expect(sent).not.toContain(displayValue.toLowerCase());
    }
  });

  test("strip the `variant` tag and BSC is skipped again — no request at all", async () => {
    // `variant` stays mandatory (Jason, 2026-09-05): NEO-252 is a gate fix, not
    // a relaxation. Without a variant axis BSC answers with the base cards plus
    // every insert and parallel in the set, so the refusal is the correct
    // outcome — it just has to be reached for the right reason now.
    const recorded: Array<Record<string, string[]>> = [];
    vi.stubGlobal("fetch", recordingBsc(recorded));
    const t = convexTest(schema, modules);
    const rowId = await seedLeafAttachedTree(t);
    await t.run(async (ctx) =>
      ctx.db.patch(rowId, {
        platformData: { bsc: { b1: BSC_SET_SLUG } },
        platformFacets: { bsc: { b1: "setName" } },
      }),
    );

    const result = await t
      .withIdentity(ADMIN_A)
      .action(api.selectorOptions.fetchCardChecklist, {
        selectorOptionId: rowId,
      });

    expect(result.success).toBe(true);
    expect(recorded).toHaveLength(0);
  });
});
