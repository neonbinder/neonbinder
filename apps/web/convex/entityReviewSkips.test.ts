/**
 * NEO-212 security review — `convex/entityReviewSkips.ts`, the read-back and
 * undo for entity-review skips.
 *
 * ## What these cases are actually defending
 *
 * `entityReviewSkips` was write-only: rows went in from
 * `commitCardChecklistPrelude` and were consulted by
 * `resolveUnknownsAndStartBatch`, and nothing could list one or delete one. A
 * skip was therefore a permanent, invisible suppression of a name for a set —
 * a mis-click on a real player took them out of the wizard forever, with no
 * surface that could even show it had happened.
 *
 * So the properties under test are: the list is SET-SCOPED (a suppression list
 * that bleeds across sets would let one operator's judgement hide a real
 * player elsewhere), it does NOT carry `skippedByUserId` (admin-gating is not
 * a licence to ship an audit field — same rule as `players.createdByUserId`),
 * the delete actually deletes and is idempotent, and both refuse a non-admin.
 *
 * Fixtures are raw `ctx.db.insert` rows, per the minimal-fixture convention in
 * `convex/entityReviewQueue.test.ts` — the write path through
 * `commitCardChecklist` has its own coverage in
 * `convex/commitCardChecklist.entityReview.test.ts` and is not what this file
 * is about.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ADMIN = {
  subject: "user_admin_skips",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_admin_skips",
  role: "admin",
};

/** Signed in, but not an admin — the gate both functions must reject. */
const MEMBER = {
  subject: "user_member_skips",
  issuer: "https://clerk.example.com",
  tokenIdentifier: "clerk|user_member_skips",
  role: "user",
};

async function seedSelectorOption(
  t: ReturnType<typeof convexTest>,
  value: string,
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "sport",
      value,
      platformData: {},
      children: [],
      lastUpdated: 1_700_000_000_000,
    }),
  );
}

async function insertSkip(
  t: ReturnType<typeof convexTest>,
  opts: {
    selectorOptionId: Id<"selectorOptions">;
    kind: "player" | "team";
    name: string;
    nameNormalized?: string;
    skippedAt?: number;
    skippedByUserId?: string;
    batchId?: string;
  },
): Promise<Id<"entityReviewSkips">> {
  return t.run(async (ctx) =>
    ctx.db.insert("entityReviewSkips", {
      selectorOptionId: opts.selectorOptionId,
      kind: opts.kind,
      name: opts.name,
      nameNormalized: opts.nameNormalized ?? opts.name.toLowerCase(),
      skippedAt: opts.skippedAt ?? 1_700_000_000_000,
      skippedByUserId: opts.skippedByUserId ?? ADMIN.subject,
      ...(opts.batchId !== undefined ? { batchId: opts.batchId } : {}),
    }),
  );
}

// ===========================================================================
// listForSet
// ===========================================================================

describe("entityReviewSkips.listForSet", () => {
  test("returns the set's skips, sorted by display name", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");

    await insertSkip(t, { selectorOptionId: setId, kind: "player", name: "CHECKLIST" });
    await insertSkip(t, {
      selectorOptionId: setId,
      kind: "team",
      // Normalizes to "acme by sponsored", so index order and name order
      // disagree — which is the point of sorting on the display name.
      name: "SPONSORED BY ACME",
      nameNormalized: "acme by sponsored",
    });
    await insertSkip(t, { selectorOptionId: setId, kind: "player", name: "ALBUM" });

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.entityReviewSkips.listForSet, { selectorOptionId: setId });

    expect(rows.map((r) => r.name)).toEqual([
      "ALBUM",
      "CHECKLIST",
      "SPONSORED BY ACME",
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["player", "player", "team"]);
  });

  test("is scoped to ONE set — a skip on another set is never listed", async () => {
    // The whole reason the table is keyed per set: a name that is junk on one
    // checklist is routinely a real player on the next. A list that leaked
    // across sets would present one set's judgement as global.
    const t = convexTest(schema, modules);
    const setA = await seedSelectorOption(t, "Baseball");
    const setB = await seedSelectorOption(t, "Football");

    await insertSkip(t, { selectorOptionId: setA, kind: "player", name: "Chase" });
    await insertSkip(t, { selectorOptionId: setB, kind: "player", name: "Chase" });

    const rowsA = await t
      .withIdentity(ADMIN)
      .query(api.entityReviewSkips.listForSet, { selectorOptionId: setA });
    expect(rowsA).toHaveLength(1);

    const rowsB = await t
      .withIdentity(ADMIN)
      .query(api.entityReviewSkips.listForSet, { selectorOptionId: setB });
    expect(rowsB).toHaveLength(1);
    // Different rows, not the same one seen twice.
    expect(rowsA[0]._id).not.toBe(rowsB[0]._id);
  });

  test("never returns skippedByUserId, and does return batchId", async () => {
    // `skippedByUserId` is an audit field. The returns validator is what keeps
    // it off the wire, and the validator is part of the public API — same rule
    // `toPublicPlayer` applies to `players.createdByUserId`. `batchId` takes
    // its place: it gives a log search a handle without naming a person.
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");
    await insertSkip(t, {
      selectorOptionId: setId,
      kind: "player",
      name: "CHECKLIST",
      skippedByUserId: "user_someone_else",
      batchId: "batch-77",
    });

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.entityReviewSkips.listForSet, { selectorOptionId: setId });

    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("skippedByUserId");
    expect(rows[0].batchId).toBe("batch-77");
    expect(rows[0].skippedAt).toBe(1_700_000_000_000);
  });

  test("omits batchId entirely for a row written before the field existed", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");
    await insertSkip(t, { selectorOptionId: setId, kind: "player", name: "CHECKLIST" });

    const rows = await t
      .withIdentity(ADMIN)
      .query(api.entityReviewSkips.listForSet, { selectorOptionId: setId });

    expect(rows[0].batchId).toBeUndefined();
  });

  test("returns an empty list for a set with no skips", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");

    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.entityReviewSkips.listForSet, { selectorOptionId: setId }),
    ).toEqual([]);
  });

  test("rejects an anonymous caller", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");

    await expect(
      t.query(api.entityReviewSkips.listForSet, { selectorOptionId: setId }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("rejects a signed-in caller who is not an admin", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");

    await expect(
      t
        .withIdentity(MEMBER)
        .query(api.entityReviewSkips.listForSet, { selectorOptionId: setId }),
    ).rejects.toThrow(/admin access required/i);
  });
});

// ===========================================================================
// clearSkip
// ===========================================================================

describe("entityReviewSkips.clearSkip", () => {
  test("deletes the row, and leaves every other skip alone", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");
    const doomed = await insertSkip(t, {
      selectorOptionId: setId,
      kind: "player",
      name: "CHECKLIST",
    });
    await insertSkip(t, { selectorOptionId: setId, kind: "team", name: "ALBUM" });

    await t
      .withIdentity(ADMIN)
      .mutation(api.entityReviewSkips.clearSkip, { skipId: doomed });

    const remaining = await t.run(async (ctx) =>
      ctx.db.query("entityReviewSkips").collect(),
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("ALBUM");
  });

  test("clearing the last skip empties the set's list — the name can re-enter the wizard", async () => {
    // The undo is entirely deferred: nothing else is touched, and the effect
    // appears on the NEXT sync, when `resolveUnknownsAndStartBatch` no longer
    // finds a matching row. Asserting the table is empty is asserting exactly
    // that precondition.
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");
    const skipId = await insertSkip(t, {
      selectorOptionId: setId,
      kind: "player",
      name: "Ken Griffey Jr.",
    });

    await t
      .withIdentity(ADMIN)
      .mutation(api.entityReviewSkips.clearSkip, { skipId });

    expect(
      await t
        .withIdentity(ADMIN)
        .query(api.entityReviewSkips.listForSet, { selectorOptionId: setId }),
    ).toEqual([]);
  });

  test("is idempotent — clearing an already-cleared skip succeeds", async () => {
    // Two admins clearing the same stale entry from two tabs is an ordinary
    // race, not a failure. The caller's intent is satisfied either way.
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");
    const skipId = await insertSkip(t, {
      selectorOptionId: setId,
      kind: "player",
      name: "CHECKLIST",
    });

    const asAdmin = t.withIdentity(ADMIN);
    await asAdmin.mutation(api.entityReviewSkips.clearSkip, { skipId });
    await expect(
      asAdmin.mutation(api.entityReviewSkips.clearSkip, { skipId }),
    ).resolves.toBeNull();
  });

  test("rejects an anonymous caller, and deletes nothing", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");
    const skipId = await insertSkip(t, {
      selectorOptionId: setId,
      kind: "player",
      name: "CHECKLIST",
    });

    await expect(
      t.mutation(api.entityReviewSkips.clearSkip, { skipId }),
    ).rejects.toThrow(/not authenticated/i);

    // "Did not write" is the property that matters, and it holds independently
    // of how the refusal is reported.
    expect(
      await t.run(async (ctx) => ctx.db.query("entityReviewSkips").collect()),
    ).toHaveLength(1);
  });

  test("rejects a signed-in caller who is not an admin, and deletes nothing", async () => {
    const t = convexTest(schema, modules);
    const setId = await seedSelectorOption(t, "Baseball");
    const skipId = await insertSkip(t, {
      selectorOptionId: setId,
      kind: "player",
      name: "CHECKLIST",
    });

    await expect(
      t
        .withIdentity(MEMBER)
        .mutation(api.entityReviewSkips.clearSkip, { skipId }),
    ).rejects.toThrow(/admin access required/i);

    expect(
      await t.run(async (ctx) => ctx.db.query("entityReviewSkips").collect()),
    ).toHaveLength(1);
  });
});
