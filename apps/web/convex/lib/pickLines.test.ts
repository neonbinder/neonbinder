/**
 * NEO-500 — the Pick List's pure rules over a stored sale (`lib/pickLines.ts`):
 * line ids (opaque, stable under a re-poll's reorder, never carrying the
 * marketplace's card id or the seller SKU), which orders and lines are on the
 * list, and the stored `pullOpen`.
 */
import { describe, expect, test } from "vitest";
import {
  lineOnPickList,
  orderOnPickList,
  orderShipped,
  pullOpenOf,
  saleIdOfLine,
  saleItemKey,
  saleLineId,
  saleLineIndex,
  saleLineKeys,
} from "./pickLines";

const SALE = "k57salezz00000000000000000000001";

// Upper case and punctuation: a base-36 hash can never spell these by chance.
const A = { platformCardId: "BSC-REF-ALPHA", condition: "near_mint", sellerSku: "NB1-CARDA-NM-BOXA" };
const B = { platformCardId: "BSC-REF-BRAVO", condition: "excellent", sellerSku: "NB1-CARDB-EX-BOXA" };
const C = { platformCardId: "BSC-REF-ALPHA", condition: "near_mint" }; // no SKU: a different key from A

describe("saleLineKeys", () => {
  test("each item gets `${saleId}~<hash>`, and the id never carries the card id, SKU or condition", () => {
    const ids = saleLineKeys(SALE, [A, B, C]);
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(id).toMatch(new RegExp(`^${SALE}~[0-9a-z]+$`));
      for (const secret of ["BSC-REF", "NB1-", "CARDA", "BOXA", "near_mint", "excellent", "|", "#"]) {
        expect(id).not.toContain(secret);
      }
    }
    expect(new Set(ids).size).toBe(3);
  });

  test("a re-poll that reorders the items keeps each line's id", () => {
    const [a, b, c] = saleLineKeys(SALE, [A, B, C]);
    const reordered = saleLineKeys(SALE, [C, A, B]);
    expect(reordered).toEqual([c, a, b]);
  });

  test("repeats of one key count up in item order, so two identical lines get two ids", () => {
    const [first, , second] = saleLineKeys(SALE, [A, B, A]);
    expect(first).not.toBe(second);
    expect(first).toBe(saleLineId(SALE, A, 0));
    expect(second).toBe(saleLineId(SALE, A, 1));
    // Moving B around the repeats does not swap them.
    expect(saleLineKeys(SALE, [B, A, A])).toEqual([saleLineId(SALE, B, 0), first, second]);
  });

  test("the same item in another sale has another id", () => {
    expect(saleLineId(SALE, A, 0)).not.toBe(saleLineId("k57salezz00000000000000000000002", A, 0));
  });

  test("the key a re-poll matches on is card id, condition and SKU (absent SKU reads as empty)", () => {
    expect(saleItemKey(A)).toBe("BSC-REF-ALPHA|near_mint|NB1-CARDA-NM-BOXA");
    expect(saleItemKey(C)).toBe("BSC-REF-ALPHA|near_mint|");
  });
});

describe("saleIdOfLine and saleLineIndex", () => {
  test("a line id names its sale and, against the items, its index whatever their order", () => {
    const id = saleLineId(SALE, B, 0);
    expect(saleIdOfLine(id)).toBe(SALE);
    expect(saleLineIndex(SALE, [A, B, C], id)).toBe(1);
    expect(saleLineIndex(SALE, [B, C, A], id)).toBe(0);
    expect(saleLineIndex(SALE, [A, C], id)).toBe(-1);
  });

  test("a line id read against another sale's items names nothing", () => {
    expect(saleLineIndex("k57salezz00000000000000000000002", [A, B, C], saleLineId(SALE, B, 0))).toBe(-1);
  });

  test.each(["", "~abc", "abc~", "no-tilde"])("%j is not a line id", (bad) => {
    expect(saleIdOfLine(bad)).toBeNull();
  });
});

describe("orderShipped and orderOnPickList", () => {
  test.each([
    ["bsc", "READY_TO_SHIP", false, true],
    ["bsc", "PARTIALLY_REFUNDED_READY_TO_SHIP", false, true],
    ["bsc", "SHIPPED", true, false],
    ["bsc", "PARTIALLY_REFUNDED_SHIPPED", true, false],
    ["bsc", "CANCELLED", false, false],
    ["bsc", "SOMETHING_NEW", false, false],
    ["ebay", "NOT_STARTED", false, true],
    ["ebay", "IN_PROGRESS", false, true],
    ["ebay", "PAID", false, true],
    ["ebay", "PARTIALLY_REFUNDED", false, true],
    ["ebay", "FULFILLED", true, false],
    ["ebay", "CANCELED", false, false],
    ["ebay", "FULLY_REFUNDED", false, false],
    ["ebay", "SOMETHING_NEW", false, false],
  ] as const)("%s %s: shipped %s, on the Pick List %s", (platform, status, shipped, onList) => {
    expect(orderShipped(platform, status)).toBe(shipped);
    expect(orderOnPickList({ platform, status })).toBe(onList);
  });

  test("a status is read for its own platform: eBay's FULFILLED means nothing on BSC, BSC's SHIPPED nothing on eBay", () => {
    expect(orderShipped("bsc", "FULFILLED")).toBe(false);
    expect(orderShipped("ebay", "SHIPPED")).toBe(false);
  });
});

describe("lineOnPickList", () => {
  test("an applied line is on the list, oversold included", () => {
    expect(lineOnPickList({ applied: true })).toBe(true);
    expect(lineOnPickList({ applied: true, problem: "oversold" })).toBe(true);
  });

  test("a line refused as unmatched or linkMismatch is on the list (Can't find it)", () => {
    expect(lineOnPickList({ applied: false, problem: "unmatched" })).toBe(true);
    expect(lineOnPickList({ applied: false, problem: "linkMismatch" })).toBe(true);
  });

  test("a line not applied yet and not refused is not on the list", () => {
    expect(lineOnPickList({ applied: false })).toBe(false);
  });

  test("a pulled line is off the list whatever else it says", () => {
    expect(lineOnPickList({ applied: true, pulledAt: 1 })).toBe(false);
    expect(lineOnPickList({ applied: false, problem: "unmatched", pulledAt: 1 })).toBe(false);
    // 0 is a time: present means pulled.
    expect(lineOnPickList({ applied: true, pulledAt: 0 })).toBe(false);
  });
});

describe("pullOpenOf", () => {
  const applied = { applied: true } as const;
  const pulled = { applied: true, pulledAt: 5 } as const;

  test("true while the order is open and one line is still to pull", () => {
    expect(pullOpenOf({ platform: "bsc", status: "READY_TO_SHIP", items: [pulled, applied] as never })).toBe(true);
  });

  test("undefined (never false) when every line is pulled or none is on the list", () => {
    expect(pullOpenOf({ platform: "bsc", status: "READY_TO_SHIP", items: [pulled] as never })).toBeUndefined();
    expect(pullOpenOf({ platform: "bsc", status: "READY_TO_SHIP", items: [{ applied: false }] as never })).toBeUndefined();
    expect(pullOpenOf({ platform: "bsc", status: "READY_TO_SHIP", items: [] })).toBeUndefined();
  });

  test.each([
    ["bsc", "SHIPPED"],
    ["bsc", "PARTIALLY_REFUNDED_SHIPPED"],
    ["bsc", "CANCELLED"],
    ["ebay", "FULFILLED"],
  ] as const)("%s %s with an unpulled line: undefined", (platform, status) => {
    expect(pullOpenOf({ platform, status, items: [applied] as never })).toBeUndefined();
  });
});
