import { describe, expect, it } from "vitest";
import { __test } from "./convexStore";

// NEO-370 — the two pure mappers between the listing queries' rows and the
// store's types. They carry the optional-field rules the Listing panel and the
// Sales list lean on, so each absent/odd shape is pinned here.
const { toVariantListing, toSale } = __test;

type RawStatus = Parameters<typeof toVariantListing>[0];
type RawSale = Parameters<typeof toSale>[0];

const record = (over: Record<string, unknown> = {}) =>
  ({
    status: "ok",
    problems: [],
    ...over,
  }) as unknown as NonNullable<RawStatus["record"]>;

describe("toVariantListing", () => {
  it("a checklist never pushed has no run, and keeps the pending flag", () => {
    expect(toVariantListing({ pending: true, record: null } as unknown as RawStatus)).toEqual({
      pending: true,
      run: null,
    });
  });

  it("omits listed when the record has no counts, and every unset timestamp and error", () => {
    const { run } = toVariantListing({
      pending: false,
      record: record(),
    } as unknown as RawStatus);
    expect(run).toEqual({ status: "ok", problems: [], problemsTotal: 0 });
    expect(run).not.toHaveProperty("listed");
    expect(run).not.toHaveProperty("lastRunAt");
    expect(run).not.toHaveProperty("lastError");
  });

  it("carries counts.listed, the timestamps and the last error when present", () => {
    const { run } = toVariantListing({
      pending: false,
      record: record({
        status: "failed",
        lastRunAt: 10,
        lastSuccessAt: 5,
        lastError: "boom",
        counts: { listed: 7 },
      }),
    } as unknown as RawStatus);
    expect(run).toMatchObject({
      status: "failed",
      lastRunAt: 10,
      lastSuccessAt: 5,
      lastError: "boom",
      listed: 7,
    });
  });

  it("a stored problemsTotal smaller than the problems shown is raised to the shown count", () => {
    const { run } = toVariantListing({
      pending: false,
      record: record({
        problems: [{ reason: "a" }, { reason: "b" }, { reason: "c" }],
        problemsTotal: 1,
      }),
    } as unknown as RawStatus);
    expect(run?.problemsTotal).toBe(3);
  });

  it("a problemsTotal larger than the shown problems (capped list) is kept", () => {
    const { run } = toVariantListing({
      pending: false,
      record: record({ problems: [{ reason: "a" }], problemsTotal: 40 }),
    } as unknown as RawStatus);
    expect(run?.problemsTotal).toBe(40);
  });

  it("a problem keeps cardId and detail only when set", () => {
    const { run } = toVariantListing({
      pending: false,
      record: record({
        problems: [{ reason: "no number" }, { reason: "bad", cardId: "c1", detail: "why" }],
      }),
    } as unknown as RawStatus);
    expect(run?.problems[0]).toEqual({ reason: "no number" });
    expect(run?.problems[1]).toEqual({ reason: "bad", cardId: "c1", detail: "why" });
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

  it("a shortBy of 0 is still carried (only undefined is dropped)", () => {
    const [item] = toSale(
      sale([{ cardId: "c", condition: "NM", quantity: 1, priceCents: 1, applied: true, shortBy: 0 }]),
    ).items;
    expect(item.shortBy).toBe(0);
  });
});
