/**
 * NEO-203 phase E — the pre-merge data audit.
 *
 * The audit's job is to size the blast radius of the keying change BEFORE it
 * ships, so the thing worth pinning is that it counts the right rows: custom
 * cards excluded from the ref-less tally (they are expected to carry no ref),
 * duplicate numbers counted per variant, and a multi-slot node recognised
 * through the same `slotIds` helper the write path uses.
 *
 * Deletable alongside the function it covers, once NEO-203 is verified on prod.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

async function seedVariant(
  t: ReturnType<typeof convexTest>,
  platformData: Record<string, Record<string, string>> = {},
): Promise<Id<"selectorOptions">> {
  return t.run(async (ctx) =>
    ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData,
      children: [],
      lastUpdated: Date.now(),
    }),
  );
}

async function seedCard(
  t: ReturnType<typeof convexTest>,
  selectorOptionId: Id<"selectorOptions">,
  opts: {
    cardNumber: string;
    bscRef?: string;
    slRef?: string;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("cardChecklist", {
      selectorOptionId,
      cardNumber: opts.cardNumber,
      cardName: `Card ${opts.cardNumber}`,
      platformData: {
        ...(opts.bscRef ? { bsc: { ref: opts.bscRef } } : {}),
        ...(opts.slRef ? { sportlots: { ref: opts.slRef } } : {}),
      },
      sortOrder: 0,
      lastUpdated: Date.now(),
    });
  });
}

const runAudit = (t: ReturnType<typeof convexTest>) =>
  t.query(internal.selectorOptions.auditChecklistDataForResync, {});

describe("auditChecklistDataForResync", () => {
  test("a healthy catalog reports nothing and says the scan was complete", async () => {
    const t = convexTest(schema, modules);
    const variantId = await seedVariant(t, { bsc: { b0: "bsc-set-1" } });
    await seedCard(t, variantId, { cardNumber: "1", bscRef: "bsc-1" });
    await seedCard(t, variantId, { cardNumber: "2", bscRef: "bsc-2" });

    const report = await runAudit(t);
    expect(report.reflessCards.count).toBe(0);
    expect(report.duplicateCardNumbers.variantCount).toBe(0);
    expect(report.multiSlotVariants.count).toBe(0);
    expect(report.scanned).toMatchObject({
      cardChecklistRows: 2,
      selectorOptionRows: 1,
      truncated: false,
    });
  });

  test("counts EVERY ref-less row and samples them", async () => {
    // NEO-239 — this used to exclude `isCustom` rows on the grounds that they
    // are "expected" to carry no ref. But the question the audit asks is "how
    // many cards can the id-keyed matcher not key?", and a hand-added card is
    // exactly as unkeyable as a marketplace one that lost its ref. Excluding a
    // whole population understated the answer, and the two are not
    // distinguishable by anything a matcher can see — which is the point of
    // retiring the flag.
    const t = convexTest(schema, modules);
    const variantId = await seedVariant(t);
    await seedCard(t, variantId, { cardNumber: "1", bscRef: "bsc-1" });
    // Legacy / pre-NEO-137 shape: no ref on either side.
    await seedCard(t, variantId, { cardNumber: "50" });
    await seedCard(t, variantId, { cardNumber: "51", slRef: "sl-51" });
    // Hand-added, and equally ref-less.
    await seedCard(t, variantId, { cardNumber: "9001" });

    const report = await runAudit(t);
    expect(report.reflessCards.count).toBe(2);
    expect(report.reflessCards.samples).toEqual([
      { selectorOptionId: variantId, cardNumber: "50" },
      { selectorOptionId: variantId, cardNumber: "9001" },
    ]);
  });

  test("counts variants holding duplicate card numbers, with the per-variant duplicate count", async () => {
    const t = convexTest(schema, modules);
    const dirty = await seedVariant(t);
    const clean = await seedVariant(t);
    // Two distinct numbers repeated, so the variant reports 2 — not 4.
    await seedCard(t, dirty, { cardNumber: "1", bscRef: "s1-1" });
    await seedCard(t, dirty, { cardNumber: "1", bscRef: "s2-1" });
    await seedCard(t, dirty, { cardNumber: "7", bscRef: "s1-7" });
    await seedCard(t, dirty, { cardNumber: "7", bscRef: "s2-7" });
    await seedCard(t, clean, { cardNumber: "1", bscRef: "c-1" });

    const report = await runAudit(t);
    expect(report.duplicateCardNumbers.variantCount).toBe(1);
    expect(report.duplicateCardNumbers.samples).toEqual([
      { selectorOptionId: dirty, duplicateNumberCount: 2 },
    ]);
  });

  test("flags a node with more than one attached set on a side", async () => {
    const t = convexTest(schema, modules);
    const single = await seedVariant(t, {
      bsc: { b0: "bsc-set-1" },
      sportlots: { s0: "sl-set-1" },
    });
    const fannedOut = await seedVariant(t, {
      bsc: { b0: "bsc-set-1" },
      sportlots: { s0: "sl-base", s1: "sl-series-2" },
    });

    const report = await runAudit(t);
    expect(report.multiSlotVariants.count).toBe(1);
    expect(report.multiSlotVariants.samples).toEqual([
      { selectorOptionId: fannedOut, bscSlots: 1, sportlotsSlots: 2 },
    ]);
    expect(
      report.multiSlotVariants.samples.some(
        (s) => s.selectorOptionId === single,
      ),
    ).toBe(false);
  });
});
