import { describe, expect, test } from "vitest";
import { compareCopiesOldestFirst, copyAgeDay, oldestCopy, type AgedCopy } from "./listingCopyOrder";

const T0 = Date.UTC(2026, 0, 1, 12);
const c = (copyId: string, over: Partial<AgedCopy> = {}): AgedCopy => ({ copyId, homeId: "box", creationTime: T0, ...over });

describe("listingCopyOrder (NEO-370)", () => {
  test("age is the acquired day, else the creation day", () => {
    expect(copyAgeDay({ acquiredOn: "1970-01-02", creationTime: T0 })).toBe(1);
    expect(copyAgeDay({ creationTime: Date.UTC(1970, 0, 3, 23, 59) })).toBe(2);
  });

  test("a malformed or impossible acquired date falls back to the creation day", () => {
    const creationDay = Math.floor(T0 / 86_400_000);
    expect(copyAgeDay({ acquiredOn: "2026-02-31", creationTime: T0 })).toBe(creationDay);
    expect(copyAgeDay({ acquiredOn: "2026/01/01", creationTime: T0 })).toBe(creationDay);
    expect(copyAgeDay({ acquiredOn: "", creationTime: T0 })).toBe(creationDay);
  });

  test("ties on the day go to the preferred home, then creation time, then id", () => {
    const a = c("a", { homeId: "x", creationTime: T0 + 2 });
    const b = c("b", { homeId: "y", creationTime: T0 + 1 });
    expect([a, b].sort((p, q) => compareCopiesOldestFirst(p, q)).map((x) => x.copyId)).toEqual(["b", "a"]);
    expect([a, b].sort((p, q) => compareCopiesOldestFirst(p, q, "x")).map((x) => x.copyId)).toEqual(["a", "b"]);
    const d = c("d");
    const e = c("e");
    expect(compareCopiesOldestFirst(e, d)).toBeGreaterThan(0);
    expect(compareCopiesOldestFirst(d, d)).toBe(0);
  });

  test("oldestCopy picks without a preference; null when empty", () => {
    expect(oldestCopy([c("n", { acquiredOn: "2025-01-01" }), c("o", { acquiredOn: "2001-01-01" })])?.copyId).toBe("o");
    expect(oldestCopy([])).toBeNull();
  });
});
