import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { BSC_MODERN_RAW_CONDITIONS, BSC_VINTAGE_RAW_CONDITIONS } from "./bscConditions";
import { encodeId } from "./convexIdCodec";
import {
  BSC_CONDITION_SKU_CODE,
  LISTING_SKU_MAX_LENGTH,
  buildListingSku,
  parseListingSku,
} from "./listingSku";

function idOf(table: number, seed: number): string {
  const bytes = new Uint8Array(16);
  bytes.fill(seed & 0xff);
  bytes[0] = (seed * 7) & 0xff;
  return encodeId(table, bytes);
}
const cardId = idOf(10017, 1) as Id<"cardChecklist">;
const boxId = idOf(10042, 2) as Id<"collectionContainers">;

describe("listingSku (NEO-370)", () => {
  test("round-trips card, condition and box", () => {
    const sku = buildListingSku({ cardId, bscCondition: "near_mint", boxId });
    expect(sku).toBe(`NB1-${cardId}-NM-${boxId}`);
    expect(parseListingSku(sku)).toEqual({ cardId, bscCondition: "near_mint", boxId });
  });

  test("every BSC condition, both eras, round-trips with a unique code", () => {
    const all = [...BSC_MODERN_RAW_CONDITIONS, ...BSC_VINTAGE_RAW_CONDITIONS];
    const codes = new Set(all.map((c) => BSC_CONDITION_SKU_CODE[c]));
    expect(codes.size).toBe(all.length);
    for (const c of all) {
      const sku = buildListingSku({ cardId, bscCondition: c, boxId });
      expect(parseListingSku(sku)?.bscCondition).toBe(c);
    }
  });

  test("stays within BSC's 100 characters even with the longest ids", () => {
    // The largest table number makes the longest id string.
    const longCard = encodeId(2 ** 31, new Uint8Array(16).fill(0xff)) as Id<"cardChecklist">;
    const longBox = encodeId(2 ** 31, new Uint8Array(16).fill(0xfe)) as Id<"collectionContainers">;
    const sku = buildListingSku({ cardId: longCard, bscCondition: "vg-ex", boxId: longBox });
    expect(sku.length).toBeLessThanOrEqual(LISTING_SKU_MAX_LENGTH);
    expect(parseListingSku(sku)).toEqual({ cardId: longCard, bscCondition: "vg-ex", boxId: longBox });
  });

  test("rejects the old platform's SKUs", () => {
    expect(parseListingSku("303|TB2")).toBeNull();
    expect(parseListingSku("303|TB10")).toBeNull();
    expect(parseListingSku("303")).toBeNull();
  });

  test("rejects NB's catalog SKU (NEO-91)", () => {
    expect(parseListingSku("NB-BB-1988-TOPPS-123-ABC123")).toBeNull();
  });

  test("rejects blanks and non-strings", () => {
    expect(parseListingSku(undefined)).toBeNull();
    expect(parseListingSku(null)).toBeNull();
    expect(parseListingSku("")).toBeNull();
    expect(parseListingSku("   ")).toBeNull();
  });

  test("rejects a right-looking SKU whose id fails the checksum", () => {
    const good = buildListingSku({ cardId, bscCondition: "excellent", boxId });
    const last = cardId[cardId.length - 1];
    const flipped = cardId.slice(0, -1) + (last === "a" ? "b" : "a");
    expect(parseListingSku(good.replace(cardId, flipped))).toBeNull();
  });

  test("rejects an unknown condition code, a wrong prefix and extra parts", () => {
    expect(parseListingSku(`NB1-${cardId}-ZZ-${boxId}`)).toBeNull();
    expect(parseListingSku(`NB2-${cardId}-NM-${boxId}`)).toBeNull();
    expect(parseListingSku(`nb1-${cardId}-NM-${boxId}`)).toBeNull();
    expect(parseListingSku(`NB1-${cardId}-NM-${boxId}-x`)).toBeNull();
    expect(parseListingSku(`NB1-${cardId}-nm-${boxId}`)).toBeNull();
  });

  test("tolerates surrounding whitespace only", () => {
    const sku = buildListingSku({ cardId, bscCondition: "poor", boxId });
    expect(parseListingSku(`  ${sku} `)).toEqual({ cardId, bscCondition: "poor", boxId });
  });

  test("build refuses a value that is not a Convex id", () => {
    expect(() =>
      buildListingSku({ cardId: "not-an-id" as Id<"cardChecklist">, bscCondition: "poor", boxId }),
    ).toThrow(/cardId/);
    expect(() =>
      buildListingSku({ cardId, bscCondition: "poor", boxId: "303" as Id<"collectionContainers"> }),
    ).toThrow(/boxId/);
  });
});
