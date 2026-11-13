import { describe, expect, it } from "vitest";
import { __test } from "./convexStore";
import { toSetProblems, toSyncStatus } from "./syncStatus";

// NEO-370 — the pure mappers between the listing queries' rows and the
// store's types. They carry the optional-field rules the Sync status tab and
// the Sales list lean on, so each absent/odd shape is pinned here.
const { toSale } = __test;

type RawSale = Parameters<typeof toSale>[0];
type RawStatus = Parameters<typeof toSyncStatus>[0];
type RawPlatform = RawStatus["platforms"][number];

const platform = (over: Partial<Record<keyof RawPlatform, unknown>> = {}) =>
  ({
    platform: "bsc",
    connected: true,
    listing: true,
    needsReauth: false,
    paused: false,
    sellerConflict: false,
    running: null,
    queued: { cards: [], more: false },
    sets: [],
    ...over,
  }) as unknown as RawPlatform;

describe("toSyncStatus", () => {
  it("passes the platform's state through and leaves every unset timestamp out", () => {
    const [p] = toSyncStatus({ platforms: [platform()] } as RawStatus).platforms;
    expect(p).toEqual({
      platform: "bsc",
      connected: true,
      listing: true,
      needsReauth: false,
      paused: false,
      sellerConflict: false,
      running: null,
      queued: { cards: [], more: false },
      sets: [],
    });
    expect(p).not.toHaveProperty("scheduledAt");
    expect(p).not.toHaveProperty("lastDrainAt");
  });

  it("a run with no set yet keeps only its start", () => {
    const [p] = toSyncStatus({ platforms: [platform({ running: { startedAt: 5, steps: [] }, lastDrainAt: 3, scheduledAt: 9 })] } as RawStatus)
      .platforms;
    expect(p.running).toEqual({ startedAt: 5, steps: [] });
    expect(p).toMatchObject({ lastDrainAt: 3, scheduledAt: 9 });
  });

  it("a queued card keeps its number and player only when set", () => {
    const [p] = toSyncStatus({
      platforms: [
        platform({
          queued: {
            cards: [
              { cardId: "c1", cardNo: "12", cardLabel: "Ken Griffey Jr.", variantId: "v1", setLabel: "1989 Upper Deck", changedAt: 1 },
              { cardId: "c2", variantId: "v1", setLabel: "1989 Upper Deck", changedAt: 2 },
            ],
            more: true,
          },
        }),
      ],
    } as RawStatus).platforms;
    expect(p.queued.more).toBe(true);
    expect(p.queued.cards[1]).toEqual({ cardId: "c2", variantId: "v1", setLabel: "1989 Upper Deck", changedAt: 2 });
  });

  it("a held-back total smaller than the problems shown is raised to the shown count", () => {
    const [p] = toSyncStatus({
      platforms: [
        platform({
          sets: [
            {
              variantId: "v1",
              setLabel: "Base",
              status: "idle",
              problemsTotal: 1,
              problems: [{ reason: "noPrice" }, { reason: "graded", cardNo: "3", cardId: "c3" }],
              steps: [],
            },
          ],
        }),
      ],
    } as RawStatus).platforms;
    expect(p.sets[0].problemsTotal).toBe(2);
    // The card id rides along (the row opens that card's panel); absent stays absent.
    expect(p.sets[0].problems).toEqual([{ reason: "noPrice" }, { reason: "graded", cardNo: "3", cardId: "c3" }]);
    expect(p.sets[0]).not.toHaveProperty("counts");
  });

  it("NEO-415: the run's steps pass through, kind, NB condition and state only, in run order", () => {
    const steps = [
      { kind: "read", condition: "Mint", conditions: ["Mint", "Near Mint"], status: "done", finishedAt: 4 },
      { kind: "send", status: "working" },
    ];
    const [p] = toSyncStatus({
      platforms: [
        platform({
          running: { startedAt: 5, variantId: "v1", steps },
          sets: [{ variantId: "v1", setLabel: "Base", status: "running", problemsTotal: 0, problems: [], steps }],
        }),
      ],
    } as RawStatus).platforms;
    const want = [
      { kind: "read", condition: "Mint", conditions: ["Mint", "Near Mint"], status: "done" },
      { kind: "send", status: "working" },
    ];
    expect(p.running?.steps).toEqual(want);
    expect(p.sets[0].steps).toEqual(want);
    expect(p.sets[0].steps?.[1]).not.toHaveProperty("condition");
    expect(p.sets[0].steps?.[1]).not.toHaveProperty("conditions");
  });

  it("NEO-415: a run with no plan yet, and a set never run since, carry empty ledgers", () => {
    const [p] = toSyncStatus({
      platforms: [
        platform({
          running: { startedAt: 5, steps: [] },
          sets: [{ variantId: "v1", setLabel: "Base", status: "idle", problemsTotal: 0, problems: [], steps: [] }],
        }),
      ],
    } as RawStatus).platforms;
    expect(p.running?.steps).toEqual([]);
    expect(p.sets[0].steps).toEqual([]);
  });

  it("toSetProblems keeps a larger total (a capped list)", () => {
    expect(toSetProblems({ problems: [{ reason: "noLink" }], problemsTotal: 40 } as Parameters<typeof toSetProblems>[0])).toEqual({
      problems: [{ reason: "noLink" }],
      problemsTotal: 40,
    });
  });
});

const sale = (items: unknown[]) =>
  ({
    _id: "s1",
    platform: "buysportscards",
    orderNo: "A-1",
    orderDate: 99,
    status: "SHIPPED",
    totals: { totalCents: 500 },
    items,
  }) as unknown as RawSale;

describe("toSale", () => {
  it("renames _id to id and passes the order fields through", () => {
    expect(toSale(sale([]))).toEqual({
      id: "s1",
      platform: "buysportscards",
      orderNo: "A-1",
      orderDate: 99,
      status: "SHIPPED",
      totals: { totalCents: 500 },
      items: [],
    });
  });

  it("an item NB could not match has no cardId, problem or shortBy keys at all", () => {
    const [item] = toSale(
      sale([{ condition: "NM", quantity: 1, priceCents: 250, applied: false }]),
    ).items;
    expect(item).toEqual({ condition: "NM", quantity: 1, priceCents: 250, applied: false });
    expect(item).not.toHaveProperty("cardId");
    expect(item).not.toHaveProperty("problem");
    expect(item).not.toHaveProperty("shortBy");
  });

  it("an oversold item keeps its cardId, problem and shortBy", () => {
    const [item] = toSale(
      sale([
        {
          cardId: "card1",
          condition: "NM",
          quantity: 3,
          priceCents: 100,
          applied: true,
          problem: "oversold",
          shortBy: 2,
        },
      ]),
    ).items;
    expect(item).toMatchObject({ cardId: "card1", problem: "oversold", shortBy: 2, applied: true });
  });

  it("NEO-520: an item's title is carried, and absent when the sale has none", () => {
    const [titled, plain] = toSale(
      sale([
        { condition: "", quantity: 1, priceCents: 1, applied: false, problem: "unmatched", title: "A lot" },
        { condition: "", quantity: 1, priceCents: 1, applied: false, problem: "unmatched" },
      ]),
    ).items;
    expect(titled.title).toBe("A lot");
    expect(plain).not.toHaveProperty("title");
  });

  it("a shortBy of 0 is still carried (only undefined is dropped)", () => {
    const [item] = toSale(
      sale([{ cardId: "c", condition: "NM", quantity: 1, priceCents: 1, applied: true, shortBy: 0 }]),
    ).items;
    expect(item.shortBy).toBe(0);
  });
});
