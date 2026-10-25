/**
 * NEO-359 — `collection.copiesOfMany`, the card hunt's batch read: the
 * 50-card limit, input-order alignment, bad ids, caller isolation, and the
 * per-card line cap.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import {
  COLLECTION_ERRORS,
  MAX_COPIES_OF_MANY,
  MAX_COPIES_OF_MANY_LINES_PER_CARD,
} from "./collection";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { insertTestCard } from "../lib/testing/card-row";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME), them: t.withIdentity(THEM) };
}
type S = Awaited<ReturnType<typeof setup>>;

const add = (who: S["me"], cardId: Id<"cardChecklist">, notes?: string) =>
  who.mutation(api.collection.addLineItem, {
    cardId,
    details: { quantity: 1, ...(notes ? { notes } : {}) } as never,
  });

describe("copiesOfMany", () => {
  test("refuses a signed-out caller", async () => {
    const { t, fx } = await setup();
    await expect(
      t.query(api.collection.copiesOfMany, { cardIds: [fx.gooden1] }),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("takes exactly the limit and refuses one more with the limit copy", async () => {
    const { me, fx } = await setup();
    const ids = Array.from({ length: MAX_COPIES_OF_MANY }, () => fx.gooden1 as string);
    const ok = await me.query(api.collection.copiesOfMany, { cardIds: ids });
    expect(ok).toHaveLength(50);

    const err = await me
      .query(api.collection.copiesOfMany, { cardIds: [...ids, fx.gooden1] })
      .then(() => null, (e: unknown) => e as { data?: unknown; message: string });
    expect(err).not.toBeNull();
    expect(JSON.stringify(err!.data ?? err!.message)).toContain(COLLECTION_ERRORS.limit);
    expect(JSON.stringify(err!.data ?? err!.message)).toContain("more than 50 cards at once");
  });

  test("an empty list reads as an empty list", async () => {
    const { me } = await setup();
    expect(await me.query(api.collection.copiesOfMany, { cardIds: [] })).toEqual([]);
  });

  test("the output follows the order of cardIds, repeats included", async () => {
    const s = await setup();
    await add(s.me, s.fx.gooden1, "g");
    await add(s.me, s.fx.strawberry2, "s");
    const out = await s.me.query(api.collection.copiesOfMany, {
      cardIds: [s.fx.strawberry2, s.fx.futureStar, s.fx.gooden1, s.fx.strawberry2],
    });
    expect(out.map((r) => r.cardId)).toEqual([
      s.fx.strawberry2, s.fx.futureStar, s.fx.gooden1, s.fx.strawberry2,
    ]);
    expect(out.map((r) => r.copies.map((c) => c.notes))).toEqual([["s"], [], ["g"], ["s"]]);
  });

  test("a malformed or nonexistent id reads as no copies and does not throw", async () => {
    const s = await setup();
    await add(s.me, s.fx.gooden1);
    // A well-formed id from another table normalizes to null for cardChecklist.
    const foreign = await s.t.run(async (ctx) => (await ctx.db.query("players").first())!._id);
    // A real card id whose row has been deleted.
    const deleted = await s.t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db.get(s.fx.futureStar))!;
      void _id; void _creationTime;
      const id = await insertTestCard(ctx, row);
      await ctx.db.delete(id);
      return id;
    });
    const raw = ["not-an-id", foreign as string, deleted as string, s.fx.gooden1 as string];
    const out = await s.me.query(api.collection.copiesOfMany, { cardIds: raw });
    expect(out.map((r) => r.cardId)).toEqual(raw);
    expect(out.map((r) => r.copies.length)).toEqual([0, 0, 0, 1]);
  });

  test("another collector's copies never appear", async () => {
    const s = await setup();
    await add(s.them, s.fx.gooden1, "theirs");
    await add(s.me, s.fx.strawberry2, "mine");
    const mine = await s.me.query(api.collection.copiesOfMany, {
      cardIds: [s.fx.gooden1, s.fx.strawberry2],
    });
    expect(mine.map((r) => r.copies.map((c) => c.notes))).toEqual([[], ["mine"]]);
    const theirs = await s.them.query(api.collection.copiesOfMany, {
      cardIds: [s.fx.gooden1, s.fx.strawberry2],
    });
    expect(theirs.map((r) => r.copies.map((c) => c.notes))).toEqual([["theirs"], []]);
  });

  test("a card with more lines than the cap reads the oldest ones, and only those", async () => {
    const s = await setup();
    const extra = 3;
    for (let i = 0; i < MAX_COPIES_OF_MANY_LINES_PER_CARD + extra; i++) {
      await add(s.me, s.fx.gooden1, `line ${i}`);
    }
    await add(s.me, s.fx.strawberry2, "other");
    const [capped, other] = await s.me.query(api.collection.copiesOfMany, {
      cardIds: [s.fx.gooden1, s.fx.strawberry2],
    });
    expect(capped.copies).toHaveLength(MAX_COPIES_OF_MANY_LINES_PER_CARD);
    expect(capped.copies.map((c) => c.notes)).toEqual(
      Array.from({ length: MAX_COPIES_OF_MANY_LINES_PER_CARD }, (_, i) => `line ${i}`),
    );
    // The cap is per card: the neighbour still reads its own line.
    expect(other.copies.map((c) => c.notes)).toEqual(["other"]);
    // The full list is `copiesOf`'s job.
    const all = await s.me.query(api.collection.copiesOf, { cardId: s.fx.gooden1 });
    expect(all.length).toBe(MAX_COPIES_OF_MANY_LINES_PER_CARD + extra);
  });
});
