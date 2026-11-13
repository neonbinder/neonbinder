/**
 * NEO-481 — the outbox's `refreshPhotos` flag, from the upsert to the drain's
 * settle. A photo change (`copyPhotos.queueIfHomeLists`) queues the card with
 * the flag so the BSC drain uploads NB's photo even over a seller photo BSC
 * already shows. The flag only goes on: a later upsert without it keeps it.
 * It goes away with its row, which `finishVariant` deletes only at the `seq`
 * the drain pushed; a change landing mid-push bumps `seq`, so the row stays
 * flagged, and a re-point (the card moved variant) keeps it.
 *
 * The drain's own use of the flag is in `listingDrain.test.ts` ("NEO-481").
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { enqueueListingCards } from "./listingOutbox";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const OWNER = "collector_refresh_001";
const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  vi.stubEnv("NEONBINDER_PAUSED_PLATFORMS", "");
});
afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const card = fx.gooden1 as Id<"cardChecklist">;
  // A BSC-linked card, and an owner who lists on BSC.
  const variantId = await t.run(async (ctx) => {
    const row = await ctx.db.get(card);
    if (!row) throw new Error("no card");
    await ctx.db.patch(card, { platformData: { ...row.platformData, bsc: { ref: "bsc-1", src: "b0" } } } as never);
    await ctx.db.insert("marketplaceListingStates", {
      ownerId: OWNER,
      platform: "bsc",
      listingStartedAt: NOW,
      lastUpdated: NOW,
    });
    return row.selectorOptionId;
  });
  return { t, card, variantId };
}
type S = Awaited<ReturnType<typeof setup>>;

const enqueue = (s: S, refreshPhotos?: boolean) =>
  s.t.run(async (ctx) =>
    enqueueListingCards(ctx as never, {
      ownerId: OWNER,
      cardIds: [s.card],
      ...(refreshPhotos !== undefined ? { refreshPhotos } : {}),
    }),
  );
const rows = (s: S) => s.t.run(async (ctx) => await ctx.db.query("listingOutbox").collect());

const settle = (
  s: S,
  args: {
    clear?: Array<{ rowId: Id<"listingOutbox">; seq: number }>;
    repoint?: Array<{ rowId: Id<"listingOutbox">; seq: number; variantId: Id<"selectorOptions"> }>;
  },
) =>
  s.t.mutation(internal.listingDrain.finishVariant, {
    ownerId: OWNER,
    platform: "bsc",
    variantId: s.variantId,
    leaseToken: "no-record",
    outcome: { kind: "error", error: "test" },
    clear: args.clear ?? [],
    repoint: args.repoint ?? [],
  });

describe("NEO-481: the outbox's refreshPhotos flag", () => {
  test("a photo change's enqueue sets the flag; a plain enqueue never does", async () => {
    const s = await setup();
    expect(await enqueue(s)).toBe(1);
    expect((await rows(s))[0]).not.toHaveProperty("refreshPhotos");
    expect(await enqueue(s, false)).toBe(1);
    expect((await rows(s))[0]).not.toHaveProperty("refreshPhotos");

    await enqueue(s, true);

    expect(await rows(s)).toEqual([expect.objectContaining({ cardId: s.card, seq: 3, refreshPhotos: true })]);
  });

  test("a later upsert without the flag bumps seq and keeps it", async () => {
    const s = await setup();
    await enqueue(s, true);
    await enqueue(s);
    await enqueue(s, false);
    expect(await rows(s)).toEqual([expect.objectContaining({ seq: 3, refreshPhotos: true })]);
  });

  test("the drain's snapshot carries the flag (and only on a flagged row)", async () => {
    const s = await setup();
    await enqueue(s, true);
    const snap = await s.t.query(internal.listingDrain.outboxSnapshot, {
      ownerId: OWNER,
      platform: "bsc",
      variantId: s.variantId,
    });
    expect(snap).toEqual([expect.objectContaining({ cardId: s.card, seq: 1, refreshPhotos: true })]);
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.query("listingOutbox").collect())[0];
      await ctx.db.patch(row._id, { refreshPhotos: undefined });
    });
    const plain = await s.t.query(internal.listingDrain.outboxSnapshot, {
      ownerId: OWNER,
      platform: "bsc",
      variantId: s.variantId,
    });
    expect(plain[0]).not.toHaveProperty("refreshPhotos");
  });

  test("the settle deletes the row, flag and all, at the seq the drain pushed", async () => {
    const s = await setup();
    await enqueue(s, true);
    const [row] = await rows(s);
    expect(await settle(s, { clear: [{ rowId: row._id, seq: row.seq }] })).toMatchObject({ cleared: 1 });
    expect(await rows(s)).toEqual([]);
  });

  test("a change that landed mid-push (seq moved) keeps the row, still flagged, whatever the change was", async () => {
    const s = await setup();
    await enqueue(s, true);
    const [pushed] = await rows(s);
    await enqueue(s); // a count change while the push was in flight
    expect(await settle(s, { clear: [{ rowId: pushed._id, seq: pushed.seq }] })).toMatchObject({ cleared: 0 });
    expect(await rows(s)).toEqual([expect.objectContaining({ seq: pushed.seq + 1, refreshPhotos: true })]);
  });

  test("a re-point (the card moved variant) keeps the flag for the new variant's run", async () => {
    const s = await setup();
    await enqueue(s, true);
    const [row] = await rows(s);
    const other = await s.t.run(async (ctx) =>
      ctx.db.insert("selectorOptions", {
        level: "variantType",
        value: "Other",
        platformData: {},
        isCustom: false,
        children: [],
        lastUpdated: NOW,
      } as never),
    );
    expect(await settle(s, { repoint: [{ rowId: row._id, seq: row.seq, variantId: other }] })).toMatchObject({
      repointed: 1,
    });
    expect(await rows(s)).toEqual([expect.objectContaining({ variantId: other, seq: row.seq, refreshPhotos: true })]);
  });
});
