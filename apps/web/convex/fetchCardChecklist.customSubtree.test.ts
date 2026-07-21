/**
 * NEO-92 follow-up: `fetchCardChecklist`'s custom-subtree branch used to
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
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

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
      platformData: {},
      isCustom: true,
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
      cardName: "Custom Card",
      isCustom: true,
      pendingPlayerNames: [playerName],
      platformData: {},
      sortOrder: 0,
      lastUpdated: Date.now(),
    }),
  );
}

describe("fetchCardChecklist — custom subtree", () => {
  test("surfaces a custom card's pendingPlayerNames as an unknown and opens a review batch", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_A);
    const selectorOptionId = await seedCustomSport(t);
    await seedCustomCardWithPendingPlayer(t, selectorOptionId, "Custom Subtree Player");

    const result = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId,
    });

    expect(result.success).toBe(true);
    expect(result.cards).toEqual([]); // no marketplace cards — still correct
    expect(result.unknownPlayers).toEqual(["Custom Subtree Player"]);
    expect(result.batchId).toBeTruthy();

    const rows = await asAdmin.query(api.entityReviewQueue.getBatch, {
      selectorOptionId,
      batchId: result.batchId!,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Custom Subtree Player");
    expect(rows[0].kind).toBe("player");
  });

  test("a custom subtree with no pending names commits with the old unconditional message, no batch opened", async () => {
    const t = convexTest(schema, modules);
    const asAdmin = t.withIdentity(ADMIN_A);
    const selectorOptionId = await seedCustomSport(t);

    const result = await asAdmin.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId,
    });

    expect(result.success).toBe(true);
    expect(result.unknownPlayers).toEqual([]);
    expect(result.unknownTeams).toEqual([]);
    expect(result.batchId).toBeUndefined();
    expect(result.message).toContain("no marketplace data available");
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

    const resultA = await asAdminA.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId,
    });
    const resultB = await asAdminB.action(api.selectorOptions.fetchCardChecklist, {
      selectorOptionId,
    });

    expect(resultA.batchId).toBeTruthy();
    expect(resultB.batchId).toBeTruthy();
    expect(resultB.batchId).not.toBe(resultA.batchId);
  });
});
