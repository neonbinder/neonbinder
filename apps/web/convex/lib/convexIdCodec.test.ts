import { describe, expect, test } from "vitest";
import { decodeId, encodeId as loaderEncodeId } from "../../scripts/reference-seed/lib.mjs";
import { encodeId, findTableNumbers, tableNumberOf } from "./convexIdCodec";

const bytes = (seed: number) => Uint8Array.from({ length: 16 }, (_, i) => (seed * 31 + i * 7) & 0xff);

describe("convexIdCodec", () => {
  test("encodes the same string as the loader's codec, across vint widths", () => {
    for (const table of [1, 127, 128, 10001, 10008, 16383, 16384, 550_000, (1 << 20) - 1]) {
      for (const seed of [0, 1, 200]) {
        const id = encodeId(table, bytes(seed));
        expect(id).toBe(loaderEncodeId(table, bytes(seed)));
        expect(tableNumberOf(id)).toBe(table);
        expect(decodeId(id)?.table).toBe(table);
      }
    }
  });

  test("tableNumberOf rejects strings that are not canonical ids", () => {
    expect(tableNumberOf("")).toBeNull();
    expect(tableNumberOf("not-an-id-at-all-but-thirty-one-c")).toBeNull();
    const id = encodeId(10001, bytes(3));
    expect(tableNumberOf(id.slice(0, -1) + (id.endsWith("0") ? "1" : "0"))).toBeNull();
  });

  test("findTableNumbers recovers numbers through a normalizeId-like predicate", () => {
    const numbers = new Map([
      ["players", 10012],
      ["teams", 10007],
      ["selectorOptions", 10001],
    ]);
    const isIdOf = (table: string, id: string) => tableNumberOf(id) === numbers.get(table);
    const found = findTableNumbers(["players", "teams", "selectorOptions", "missing"], isIdOf, new Map(), 1, 20_000);
    expect([...found].sort()).toEqual([...numbers].sort());
    expect(found.has("missing")).toBe(false);
    // Ranges compose: a number outside [from, to) is not found in that range.
    expect(findTableNumbers(["teams"], isIdOf, new Map(), 1, 10_007).size).toBe(0);
    expect(findTableNumbers(["teams"], isIdOf, new Map(), 10_007, 10_008).get("teams")).toBe(10007);
  });

  test("findTableNumbers skips tables whose number is already known", () => {
    let calls = 0;
    const found = findTableNumbers(["a"], () => (calls++, false), new Map([["a", 5]]), 1, 100);
    expect(found.size).toBe(0);
    expect(calls).toBe(0);
  });
});
