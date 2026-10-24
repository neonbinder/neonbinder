/**
 * NEO-358 — the armed `backfillCardSearchFields` (convex/backfillCardSearchFields.ts).
 *
 * The coverage audit's list, one case each:
 *  - a dry run reports and writes nothing;
 *  - an armed invocation on an unarmed deployment is refused (reported by the
 *    action, thrown by the page mutation) and writes nothing;
 *  - an armed run fills ONLY an absent or blank `listingTitle` (with
 *    `listingTitleTruncated` when the core was cut) and an absent `sportId`,
 *    never touches a title that is there, and never bumps `lastUpdated`;
 *  - the counts are reported, a second run is a no-op;
 *  - it pages: a table bigger than one page is walked whole, a page resumes
 *    from its cursor, and a call that runs out of time returns the cursor.
 *
 * The expected titles are `titleForStoredCard`'s, the helper Regenerate
 * (`previewListingTitle`) reads; `storedCardTitle.parity.test.ts` pins the two
 * together.
 */

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import { titleForStoredCard } from "./storedCardTitle";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const NOW = 1_700_000_000_000;
const ENV_FLAG = "ALLOW_CARD_SEARCH_FIELDS_BACKFILL";
type T = ReturnType<typeof convexTest>;
type Card = Doc<"cardChecklist">;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const LONG = "Bartholomew Maximilian Fitzgerald-Worthington";

/** A chain to a sport, one orphan chain (no sport), and one card per case. */
async function seed(t: T) {
  return t.run(async (ctx) => {
    const row = (
      level: Doc<"selectorOptions">["level"],
      value: string,
      parentId?: Id<"selectorOptions">,
    ) =>
      ctx.db.insert("selectorOptions", {
        level,
        value,
        ...(parentId ? { parentId } : {}),
        platformData: {},
        children: [],
        lastUpdated: NOW,
      });
    const sport = await row("sport", "Baseball");
    const year = await row("year", "2024", sport);
    const brand = await row("manufacturer", "Topps", year);
    const set = await row("setName", "Chrome", brand);
    const base = await row("variantType", "Base", set);
    const orphanBase = await row("variantType", "Base"); // no parent: no sport

    const card = (
      selectorOptionId: Id<"selectorOptions">,
      cardNumber: string,
      extra: Partial<Card> = {},
    ) =>
      ctx.db.insert("cardChecklist", {
        selectorOptionId,
        cardNumber,
        cardName: `Card ${cardNumber}`,
        platformData: {},
        sortOrder: 0,
        lastUpdated: NOW,
        ...extra,
      });
    return {
      sport,
      base,
      orphanBase,
      cards: {
        // Title absent, sport absent: both filled.
        bare: await card(base, "1", { pendingPlayerNames: ["Dwight Gooden"] }),
        // Blank and empty titles are filled; the sport is already there.
        blank: await card(base, "2", { listingTitle: "   ", sportId: sport }),
        empty: await card(base, "3", { listingTitle: "", sportId: sport }),
        // A title that is there is never touched; only the sport is filled.
        kept: await card(base, "4", { listingTitle: "Operator's own words" }),
        // Nothing to do at all.
        done: await card(base, "5", { listingTitle: "Fine", sportId: sport }),
        // The generator has to cut the core: the truncated flag rides along.
        long: await card(base, "6", { pendingPlayerNames: [LONG, LONG] }),
        // A chain that reaches no sport: counted, never guessed.
        orphan: await card(orphanBase, "7", { listingTitle: "Orphan" }),
      },
    };
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

const allCards = (t: T) =>
  t.run(async (ctx) => {
    const rows = await ctx.db.query("cardChecklist").collect();
    return Object.fromEntries(rows.map((r) => [r._id as string, r]));
  });

const runAction = (t: T, args: { confirm?: string; cursor?: string } = {}) =>
  t.action(internal.backfillCardSearchFields.backfillCardSearchFields, args);

describe("backfillCardSearchFields", () => {
  test("a dry run reports what it would write and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const before = await allCards(t);

    const dry = await runAction(t);
    expect(dry).toEqual({
      armed: false,
      message: expect.stringMatching(/^Dry run/),
      complete: true,
      scanned: 7,
      titlesFilled: 4, // bare, blank, empty, long
      sportFilled: 3, // bare, kept, long
      noSport: 1, // orphan
    });
    expect(await allCards(t)).toEqual(before);
  });

  test("an armed run on an unarmed deployment is refused and writes nothing", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    const before = await allCards(t);

    const refused = await runAction(t, { confirm: "BACKFILL" });
    expect(refused.armed).toBe(false);
    expect(refused.message).toMatch(/not armed/);
    // The dry-run numbers still come back.
    expect(refused).toMatchObject({ titlesFilled: 4, sportFilled: 3, noSport: 1 });
    expect(await allCards(t)).toEqual(before);

    // A flag value other than "1"/"true" is not an arm.
    vi.stubEnv(ENV_FLAG, "yes");
    expect((await runAction(t, { confirm: "BACKFILL" })).armed).toBe(false);
    // The page re-asserts the arm itself, for a caller that skips the action.
    await expect(
      t.mutation(internal.backfillCardSearchFields.backfillCardSearchFieldsPage, {
        cursor: null,
        apply: true,
      }),
    ).rejects.toThrow(/not armed/);
    expect(await allCards(t)).toEqual(before);

    // Armed but without the confirm token: still a dry run.
    vi.stubEnv(ENV_FLAG, "1");
    expect((await runAction(t, { confirm: "backfill" })).armed).toBe(false);
    expect(await allCards(t)).toEqual(before);
  });

  test("an armed run fills only an absent or blank title (with the truncated flag) and an absent sport", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const before = await allCards(t);
    // The titles Regenerate would offer, computed from the rows as they stand.
    const expected = await t.run(async (ctx) => {
      const out: Record<string, { title: string; coreFits: boolean }> = {};
      for (const key of ["bare", "blank", "empty", "long"] as const) {
        const id = s.cards[key];
        const r = await titleForStoredCard(ctx, (await ctx.db.get(id))!);
        out[key] = { title: r.title, coreFits: r.coreFits };
      }
      return out;
    });
    expect(expected.long.coreFits).toBe(false);
    expect(expected.bare.coreFits).toBe(true);

    vi.stubEnv(ENV_FLAG, "true");
    const armed = await runAction(t, { confirm: "BACKFILL" });
    expect(armed).toEqual({
      armed: true,
      message: expect.stringMatching(/^Applied/),
      complete: true,
      scanned: 7,
      titlesFilled: 4,
      sportFilled: 3,
      noSport: 1,
    });

    const after = await allCards(t);
    const row = (key: keyof Seeded["cards"]) => after[s.cards[key] as string];
    const was = (key: keyof Seeded["cards"]) => before[s.cards[key] as string];

    expect(row("bare")).toEqual({ ...was("bare"), listingTitle: expected.bare.title, sportId: s.sport });
    expect(row("blank")).toEqual({ ...was("blank"), listingTitle: expected.blank.title });
    expect(row("empty")).toEqual({ ...was("empty"), listingTitle: expected.empty.title });
    expect(row("kept")).toEqual({ ...was("kept"), sportId: s.sport });
    expect(row("done")).toEqual(was("done"));
    expect(row("long")).toEqual({
      ...was("long"),
      listingTitle: expected.long.title,
      listingTitleTruncated: true,
      sportId: s.sport,
    });
    expect(row("orphan")).toEqual(was("orphan"));
    // Only a cut core earns the flag; nothing an operator wrote changed, so no
    // row's lastUpdated moved.
    for (const card of Object.values(after)) {
      expect(card.lastUpdated).toBe(NOW);
      if (card._id !== s.cards.long) expect(card.listingTitleTruncated).toBeUndefined();
    }

    // Idempotent: a second run fills nothing (the orphan is counted again).
    const again = await runAction(t, { confirm: "BACKFILL" });
    expect(again).toMatchObject({ titlesFilled: 0, sportFilled: 0, noSport: 1, complete: true });
    expect(await allCards(t)).toEqual(after);
  });

  test("it pages: the whole table is walked, a page resumes from its cursor, and a timed-out call returns one", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const extra = 230; // more than two pages of 100
    await t.run(async (ctx) => {
      for (let i = 0; i < extra; i++) {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId: s.base,
          cardNumber: String(100 + i),
          cardName: `Card ${100 + i}`,
          platformData: {},
          sortOrder: 100 + i,
          lastUpdated: NOW,
        });
      }
    });
    const total = 7 + extra;

    // One action call walks every page.
    const dry = await runAction(t);
    expect(dry).toMatchObject({ complete: true, scanned: total, titlesFilled: 4 + extra });
    expect(dry.cursor).toBeUndefined();

    // The page mutation alone: small pages, chained by cursor, see every card once.
    let cursor: string | null = null;
    let scanned = 0;
    let pages = 0;
    for (;;) {
      const page: { scanned: number; isDone: boolean; continueCursor: string } = await t.mutation(
        internal.backfillCardSearchFields.backfillCardSearchFieldsPage,
        { cursor, apply: false, numItems: 50 },
      );
      scanned += page.scanned;
      pages += 1;
      cursor = page.continueCursor;
      if (page.isDone) break;
    }
    expect(scanned).toBe(total);
    expect(pages).toBeGreaterThanOrEqual(Math.ceil(total / 50));
    // A requested page larger than the cap is clamped to it.
    const clamped = await t.mutation(internal.backfillCardSearchFields.backfillCardSearchFieldsPage, {
      cursor: null,
      apply: false,
      numItems: 10_000,
    });
    expect(clamped.scanned).toBe(100);

    // Out of time after the first page: the call stops, says so, and hands
    // back the cursor; resuming from it finishes the walk, armed.
    vi.stubEnv(ENV_FLAG, "1");
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 100_000));
    const partial = await runAction(t, { confirm: "BACKFILL" });
    expect(partial.complete).toBe(false);
    expect(partial.cursor).toEqual(expect.any(String));
    expect(partial.scanned).toBeLessThan(total);
    vi.restoreAllMocks();

    const rest = await runAction(t, { confirm: "BACKFILL", cursor: partial.cursor });
    expect(rest.complete).toBe(true);
    expect(partial.scanned + rest.scanned).toBe(total);
    expect(partial.titlesFilled + rest.titlesFilled).toBe(4 + extra);
    const untitled = await t.run(async (ctx) =>
      (await ctx.db.query("cardChecklist").collect()).filter(
        (c) => (c.listingTitle ?? "").trim() === "",
      ),
    );
    expect(untitled).toEqual([]);
  });
});
