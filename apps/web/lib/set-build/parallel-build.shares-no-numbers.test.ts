import { describe, expect, test } from "vitest";
import { listedOnlyCounts, sharesNoNumbers } from "./parallel-build";

const extra = (bsc: number, sportlots: number) => ({
  bsc: { count: bsc, cards: [] },
  sportlots: { count: sportlots, cards: [] },
});

describe("sharesNoNumbers — the panel and the tool read one signal (NEO-339)", () => {
  test("copied nothing while the parallel's marketplaces list cards: shares no numbers", () => {
    expect(sharesNoNumbers({ status: "built", copied: 0, extraOnMarketplace: extra(12, 0) })).toBe(true);
    expect(sharesNoNumbers({ status: "built", copied: 0, extraOnMarketplace: extra(0, 3) })).toBe(true);
  });
  test("a short-print subset (some copied) is an ordinary build", () => {
    expect(sharesNoNumbers({ status: "built", copied: 4, extraOnMarketplace: extra(12, 0) })).toBe(false);
  });
  test("copied nothing and listed nothing is an ordinary empty build", () => {
    expect(sharesNoNumbers({ status: "built", copied: 0, extraOnMarketplace: extra(0, 0) })).toBe(false);
  });
  test("a blocked build is not this question", () => {
    expect(sharesNoNumbers({ status: "blocked", copied: 0, extraOnMarketplace: extra(5, 5) })).toBe(false);
  });
  test("an older server's result without the field reads as nothing listed", () => {
    const old = { status: "built" as const, copied: 0 } as unknown as Parameters<typeof sharesNoNumbers>[0];
    expect(sharesNoNumbers(old)).toBe(false);
    expect(listedOnlyCounts(old as Parameters<typeof listedOnlyCounts>[0])).toEqual({ bsc: 0, sportlots: 0 });
  });
});
