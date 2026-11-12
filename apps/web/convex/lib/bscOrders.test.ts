import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BSC_LISTED_BOUNDS,
  BSC_ORDER_BOUNDS,
  bscListedText,
  bscOrderDisposition,
  chooseCopiesToLower,
  parseBscDate,
  parseBscOrder,
  parseBscOrderHistoryPage,
  type SaleCopy,
} from "./bscOrders";
import { parseListingSku } from "./listingSku";

/** A real BSC order detail payload, redacted (see its `_note`). */
const FIXTURE: unknown = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "bsc-order-redacted.json"), "utf8"),
);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("parseBscOrder (NEO-370) over the recorded payload", () => {
  const order = parseBscOrder(FIXTURE);

  test("reads ids, date, status and totals in cents", () => {
    expect(order).not.toBeNull();
    expect(order).toMatchObject({
      orderId: "0000fixtureorder0001",
      orderNo: "FIXT01-ORDER1-000AAAA",
      status: "SHIPPED",
      currency: "USD",
      unreadableItems: 0,
    });
    expect(order?.orderDateMs).toBe(Date.UTC(2026, 9, 30, 15, 1, 6, 541));
    expect(order?.totals).toEqual({
      subtotalCents: 175,
      shippingCents: 169,
      taxCents: 0,
      discountCents: 0,
      sellerFeeCents: 0,
      totalCents: 344,
      sellerNetCents: 133,
      refundCents: 0,
    });
  });

  test("reads each item: BSC card id, condition, quantity, unit price, SKU, description (NEO-509)", () => {
    expect(order?.items).toEqual([
      {
        bscCardId: "859115a1371626f4911ba3d70722d757",
        condition: "near_mint",
        productType: "raw",
        quantity: 1,
        priceCents: 25,
        sellerSku: "303|TB2",
        listed: {
          sport: "Football",
          platformSportId: "football",
          year: "2021",
          setName: "2021 Score",
          players: "Justin Fields",
          cardNo: "TB2",
          variant: "Insert",
          variantName: "1991 Throwback",
        },
      },
      {
        bscCardId: "b02b20ed43c7c2debf315550f92ddc13",
        condition: "near_mint",
        productType: "raw",
        quantity: 1,
        priceCents: 25,
        sellerSku: "303|TB10",
        listed: {
          sport: "Football",
          platformSportId: "football",
          year: "2021",
          setName: "2021 Score",
          players: "Kyle Trask",
          cardNo: "TB10",
          variant: "Insert",
          variantName: "1991 Throwback",
        },
      },
    ]);
  });

  test("the old platform's SKUs on the recorded order never parse as NB SKUs", () => {
    for (const item of order?.items ?? []) expect(parseListingSku(item.sellerSku)).toBeNull();
  });

  test("drops every buyer, seller, address, payment and shipment field", () => {
    const withPii = clone(FIXTURE) as Record<string, unknown>;
    withPii.buyer = { email: "x@example.com", firstName: "A" };
    withPii.seller = { email: "y@example.com" };
    withPii.shippingAddress = { addressLine1: "1 Main" };
    withPii.stripePaymentId = "pi_123";
    const parsed = parseBscOrder(withPii);
    const text = JSON.stringify(parsed);
    // NEO-509: the card's description words are kept (`listed`); image paths,
    // prices and seller fields on `item.card` and the item are not.
    for (const leak of ["example.com", "1 Main", "pi_123", "REDACTED", "fixtureseller", "stockImg", "/Catalog/", "lowestPrice", "playerAttribute"]) {
      expect(text).not.toContain(leak);
    }
    expect(Object.keys(parsed ?? {}).sort()).toEqual(
      ["currency", "items", "orderDateMs", "orderId", "orderNo", "status", "totals", "unreadableItems"].sort(),
    );
  });
});

describe("parseBscOrder (NEO-370) edges", () => {
  test("null without an order id or a status, or for a non-object", () => {
    const noId = clone(FIXTURE) as Record<string, unknown>;
    delete noId.orderId;
    expect(parseBscOrder(noId)).toBeNull();
    const noStatus = clone(FIXTURE) as Record<string, unknown>;
    delete noStatus.orderStatus;
    expect(parseBscOrder(noStatus)).toBeNull();
    expect(parseBscOrder(null)).toBeNull();
    expect(parseBscOrder("order")).toBeNull();
  });

  test("tolerates missing optional fields", () => {
    const minimal = parseBscOrder({ orderId: "o1", orderStatus: "READY_TO_SHIP" });
    expect(minimal).toEqual({
      orderId: "o1",
      orderNo: null,
      orderDateMs: null,
      status: "READY_TO_SHIP",
      currency: null,
      totals: {
        subtotalCents: null,
        shippingCents: null,
        taxCents: null,
        discountCents: null,
        sellerFeeCents: null,
        totalCents: null,
        sellerNetCents: null,
        refundCents: null,
      },
      items: [],
      unreadableItems: 0,
    });
  });

  test("an item falls back to the top-level cardId, and SKU and price may be absent", () => {
    const order = parseBscOrder({
      orderId: "o1",
      orderStatus: "READY_TO_SHIP",
      orderItems: [{ cardId: "c1", condition: "ex", orderQuantity: 2 }],
    });
    expect(order?.items).toEqual([
      { bscCardId: "c1", condition: "ex", productType: null, quantity: 2, priceCents: null, sellerSku: null, listed: null },
    ]);
  });

  test("counts unreadable items instead of guessing", () => {
    const order = parseBscOrder({
      orderId: "o1",
      orderStatus: "READY_TO_SHIP",
      orderItems: [
        { card: { id: "a" }, cardId: "b", condition: "ex", orderQuantity: 1 }, // ids disagree
        { card: { id: "a" }, orderQuantity: 1 }, // no condition
        { card: { id: "a" }, condition: "ex", orderQuantity: 0 },
        { card: { id: "a" }, condition: "ex", orderQuantity: 1.5 },
        { condition: "ex", orderQuantity: 1 }, // no card id
        "junk",
        { card: { id: "a" }, condition: "ex", orderQuantity: 3 },
      ],
    });
    expect(order?.unreadableItems).toBe(6);
    expect(order?.items.map((i) => i.quantity)).toEqual([3]);
  });
});

describe("bscOrderDisposition (NEO-370)", () => {
  test("shipped and ready-to-ship orders are sales; cancelled is not; anything else is unknown", () => {
    for (const s of ["READY_TO_SHIP", "PARTIALLY_REFUNDED_READY_TO_SHIP", "SHIPPED", "PARTIALLY_REFUNDED_SHIPPED"]) {
      expect(bscOrderDisposition(s)).toBe("sale");
    }
    expect(bscOrderDisposition("CANCELLED")).toBe("cancelled");
    expect(bscOrderDisposition("REFUNDED")).toBe("unknown");
    expect(bscOrderDisposition("shipped")).toBe("unknown");
  });
});

describe("parseBscDate", () => {
  test("zone-less BSC dates are UTC, fractions cut to ms", () => {
    expect(parseBscDate("2026-10-30T15:01:06")).toBe(Date.UTC(2026, 9, 30, 15, 1, 6));
    expect(parseBscDate("2026-10-30T15:01:06.541323")).toBe(Date.UTC(2026, 9, 30, 15, 1, 6, 541));
    expect(parseBscDate("2026-10-30T15:01:06.5")).toBe(Date.UTC(2026, 9, 30, 15, 1, 6, 500));
    expect(parseBscDate("2026-10-30T15:01:06Z")).toBe(Date.UTC(2026, 9, 30, 15, 1, 6));
    expect(parseBscDate("2026-10-30T15:01:06-05:00")).toBe(Date.UTC(2026, 9, 30, 20, 1, 6));
  });

  test("null when unreadable", () => {
    expect(parseBscDate("")).toBeNull();
    expect(parseBscDate("yesterday")).toBeNull();
    expect(parseBscDate("2026-10-30")).toBeNull();
    expect(parseBscDate(1730300000)).toBeNull();
    expect(parseBscDate(null)).toBeNull();
  });
});

describe("parseBscOrderHistoryPage (NEO-370)", () => {
  test("reads the newest-first list", () => {
    const page = parseBscOrderHistoryPage({
      totalElements: 2,
      results: [
        { orderId: "o2", orderNo: "N2", orderDate: "2026-10-31T10:00:00", orderStatus: "CANCELLED" },
        { orderId: "o1", orderDate: "2026-10-30T15:01:06", orderStatus: "SHIPPED" },
      ],
    });
    expect(page).toEqual({
      totalElements: 2,
      unreadable: 0,
      orders: [
        { orderId: "o2", orderNo: "N2", orderDateMs: Date.UTC(2026, 9, 31, 10), status: "CANCELLED" },
        { orderId: "o1", orderNo: null, orderDateMs: Date.UTC(2026, 9, 30, 15, 1, 6), status: "SHIPPED" },
      ],
    });
  });

  test("a seller with no orders: results null or empty", () => {
    expect(parseBscOrderHistoryPage({ totalElements: 0, results: null })).toEqual({ totalElements: 0, orders: [], unreadable: 0 });
    expect(parseBscOrderHistoryPage({})).toEqual({ totalElements: null, orders: [], unreadable: 0 });
  });

  test("skips results with no order id, counting them; null for a non-object", () => {
    expect(parseBscOrderHistoryPage({ totalElements: 3, results: [{}, null, { orderId: "o1" }] })?.unreadable).toBe(2);
    expect(parseBscOrderHistoryPage([])).toBeNull();
  });
});

describe("chooseCopiesToLower (NEO-370)", () => {
  const T0 = Date.UTC(2026, 0, 1);
  const c = (copyId: string, homeId: string, quantity: number, over: Partial<SaleCopy> = {}): SaleCopy => ({
    copyId,
    homeId,
    quantity,
    creationTime: T0,
    ...over,
  });

  test("lowers the oldest copy first, by acquired date", () => {
    const out = chooseCopiesToLower(
      [c("new", "boxA", 2, { acquiredOn: "2024-01-01" }), c("old", "boxB", 2, { acquiredOn: "2020-01-01" })],
      null,
      1,
    );
    expect(out).toEqual({ decrements: [{ copyId: "old", by: 1 }], shortfall: 0 });
  });

  test("an undated copy ages from when it was added to NB", () => {
    const out = chooseCopiesToLower(
      [c("dated", "boxA", 1, { acquiredOn: "2026-06-01" }), c("undated", "boxB", 1, { creationTime: Date.UTC(2025, 0, 1) })],
      null,
      1,
    );
    expect(out.decrements).toEqual([{ copyId: "undated", by: 1 }]);
  });

  test("the SKU's box wins a tie on the age day", () => {
    const sameDay = { acquiredOn: "2023-03-03" };
    const copies = [
      c("a", "boxA", 1, { ...sameDay, creationTime: T0 }),
      c("b", "boxB", 1, { ...sameDay, creationTime: T0 + 5000 }),
    ];
    expect(chooseCopiesToLower(copies, "boxB", 1).decrements).toEqual([{ copyId: "b", by: 1 }]);
    expect(chooseCopiesToLower(copies, null, 1).decrements).toEqual([{ copyId: "a", by: 1 }]);
  });

  test("the SKU's box does not beat an older copy elsewhere", () => {
    const out = chooseCopiesToLower(
      [c("sku", "boxSku", 1, { acquiredOn: "2024-01-01" }), c("older", "boxOther", 1, { acquiredOn: "2022-01-01" })],
      "boxSku",
      1,
    );
    expect(out.decrements).toEqual([{ copyId: "older", by: 1 }]);
  });

  test("a sale spanning lines takes the oldest line whole, then the next", () => {
    const out = chooseCopiesToLower(
      [c("b", "box", 5, { acquiredOn: "2022-01-01" }), c("a", "box", 2, { acquiredOn: "2021-01-01" })],
      null,
      4,
    );
    expect(out).toEqual({ decrements: [{ copyId: "a", by: 2 }, { copyId: "b", by: 2 }], shortfall: 0 });
  });

  test("oversell: every copy goes to 0 and the rest is the shortfall", () => {
    const out = chooseCopiesToLower([c("a", "box", 1), c("b", "box", 2, { creationTime: T0 + 1 })], null, 5);
    expect(out).toEqual({ decrements: [{ copyId: "a", by: 1 }, { copyId: "b", by: 2 }], shortfall: 2 });
    expect(chooseCopiesToLower([], "box", 3)).toEqual({ decrements: [], shortfall: 3 });
  });

  test("a non-positive or fractional sale lowers nothing; empty lines are skipped", () => {
    expect(chooseCopiesToLower([c("a", "box", 1)], null, 0)).toEqual({ decrements: [], shortfall: 0 });
    expect(chooseCopiesToLower([c("a", "box", 1)], null, 1.5)).toEqual({ decrements: [], shortfall: 0 });
    expect(chooseCopiesToLower([c("z", "box", 0), c("a", "box", 1, { creationTime: T0 + 1 })], null, 1).decrements).toEqual([
      { copyId: "a", by: 1 },
    ]);
  });

  test("does not reorder the caller's array", () => {
    const copies = [c("b", "box", 1, { creationTime: T0 + 1 }), c("a", "box", 1)];
    chooseCopiesToLower(copies, null, 1);
    expect(copies.map((x) => x.copyId)).toEqual(["b", "a"]);
  });
});

describe("NEO-370 round 3 — BSC strings past NB's bounds are unreadable, never stored", () => {
  const long = (n: number) => "x".repeat(n + 1);
  const base = () => clone(FIXTURE) as Record<string, unknown> & { orderItems: Array<Record<string, unknown>> };

  test("an order id, order number or status past its bound makes the order unreadable", () => {
    for (const [field, max] of [
      ["orderId", BSC_ORDER_BOUNDS.orderId],
      ["orderNo", BSC_ORDER_BOUNDS.orderNo],
      ["orderStatus", BSC_ORDER_BOUNDS.status],
    ] as const) {
      const o = base();
      o[field] = long(max);
      expect(parseBscOrder(o)).toBeNull();
      o[field] = "y".repeat(max);
      expect(parseBscOrder(o)).not.toBeNull();
    }
  });

  test("an item whose card id, condition, product type or SKU is past its bound is counted unreadable", () => {
    const cases: Array<(item: Record<string, unknown>) => void> = [
      (i) => {
        i.cardId = long(BSC_ORDER_BOUNDS.cardId);
        i.card = { ...(i.card as object), id: i.cardId };
      },
      (i) => {
        i.condition = long(BSC_ORDER_BOUNDS.condition);
      },
      (i) => {
        i.productType = long(BSC_ORDER_BOUNDS.productType);
      },
      (i) => {
        i.sellerSku = long(BSC_ORDER_BOUNDS.sku);
      },
    ];
    const items = base().orderItems.length;
    for (const spoil of cases) {
      const o = base();
      spoil(o.orderItems[0]);
      const parsed = parseBscOrder(o);
      expect(parsed?.unreadableItems).toBe(1);
      expect(parsed?.items).toHaveLength(items - 1);
    }
  });

  test("a currency past its bound is dropped to null, the order still read", () => {
    const o = base();
    o.orderCurrency = long(BSC_ORDER_BOUNDS.currency);
    expect(parseBscOrder(o)?.currency).toBeNull();
  });

  test("a history result past a bound is counted unreadable and skipped", () => {
    const page = parseBscOrderHistoryPage({
      totalElements: 3,
      results: [
        { orderId: "ok-1", orderNo: "N1", orderStatus: "SHIPPED" },
        { orderId: long(BSC_ORDER_BOUNDS.orderId), orderNo: "N2", orderStatus: "SHIPPED" },
        { orderId: "ok-3", orderNo: "N3", orderStatus: long(BSC_ORDER_BOUNDS.status) },
      ],
    });
    expect(page?.orders.map((o) => o.orderId)).toEqual(["ok-1"]);
    expect(page?.unreadable).toBe(2);
  });
});

describe("NEO-509 — the card a line describes (listed)", () => {
  type Item = Record<string, unknown> & { card: Record<string, unknown> };
  const base = () => clone(FIXTURE) as Record<string, unknown> & { orderItems: Item[] };
  const listedOf = (o: unknown) => parseBscOrder(o)?.items[0]?.listed;

  test("a value past its bound drops THAT field only; never truncated, the line still read", () => {
    const cardKeys = ["sport", "year", "setName", "players", "cardNo", "variant", "variantName"] as const;
    for (const key of cardKeys) {
      const o = base();
      o.orderItems[0].card[key] = "x".repeat(BSC_LISTED_BOUNDS[key] + 1);
      const parsed = parseBscOrder(o);
      expect(parsed?.unreadableItems).toBe(0);
      const listed = parsed?.items[0]?.listed;
      expect(listed).not.toBeNull();
      expect(listed && key in listed).toBe(false);
      expect(listed?.cardNo ?? listed?.players).toBeDefined();
      o.orderItems[0].card[key] = "y".repeat(BSC_LISTED_BOUNDS[key]);
      expect(listedOf(o)?.[key]).toBe("y".repeat(BSC_LISTED_BOUNDS[key]));
    }
    const o = base();
    o.orderItems[0].sportId = "x".repeat(BSC_LISTED_BOUNDS.platformSportId + 1);
    expect(listedOf(o)?.platformSportId).toBeUndefined();
    expect(listedOf(o)?.sport).toBe("Football");
  });

  test("trims; blank, control characters and non-strings are absent", () => {
    const o = base();
    const card = o.orderItems[0].card;
    card.players = "  Justin Fields  ";
    card.setName = "   ";
    card.cardNo = "TB\u00002";
    card.variant = "Insert\n";
    card.variantName = 42;
    card.sport = { name: "Football" };
    const listed = listedOf(o);
    expect(listed).toEqual({ platformSportId: "football", year: "2021", players: "Justin Fields", variant: "Insert" });
  });

  test("a control character inside a value drops it", () => {
    const o = base();
    o.orderItems[0].card.cardNo = "TB\u00072";
    expect(listedOf(o)?.cardNo).toBeUndefined();
  });

  // A format character can reorder or hide what a seller reads on the Pick
  // List (U+202E turns "TB2" into a visually different number), so each range
  // is absent like a control character. Escapes only: no literal format chars.
  test.each([
    // NEO-520: three more invisible marks, none of them JS whitespace.
    ["U+034F combining grapheme joiner", "\u034f"],
    ["U+061C Arabic letter mark", "\u061c"],
    ["U+180E Mongolian vowel separator", "\u180e"],
    ["U+200B zero-width space", "\u200b"],
    ["U+200C zero-width non-joiner", "\u200c"],
    ["U+200D zero-width joiner", "\u200d"],
    ["U+200E left-to-right mark", "\u200e"],
    ["U+200F right-to-left mark", "\u200f"],
    ["U+2028 line separator", "\u2028"],
    ["U+2029 paragraph separator", "\u2029"],
    ["U+202A left-to-right embedding", "\u202a"],
    ["U+202B right-to-left embedding", "\u202b"],
    ["U+202C pop directional formatting", "\u202c"],
    ["U+202D left-to-right override", "\u202d"],
    ["U+202E right-to-left override", "\u202e"],
    ["U+2060 word joiner", "\u2060"],
    ["U+2066 left-to-right isolate", "\u2066"],
    ["U+2067 right-to-left isolate", "\u2067"],
    ["U+2068 first strong isolate", "\u2068"],
    ["U+2069 pop directional isolate", "\u2069"],
    ["U+FEFF zero-width no-break space", "\ufeff"],
  ])("a format character (%s) inside a value drops it", (_name, ch) => {
    const o = base();
    o.orderItems[0].card.cardNo = `TB${ch}2`;
    o.orderItems[0].card.players = `Justin${ch} Fields`;
    o.orderItems[0].card.setName = `2021 ${ch}Score`;
    const listed = listedOf(o);
    expect(listed?.cardNo).toBeUndefined();
    expect(listed?.players).toBeUndefined();
    expect(listed?.setName).toBeUndefined();
    expect(listed?.year).toBe("2021");
    // At an edge: trim() removes U+2028, U+2029 and U+FEFF (JS whitespace),
    // which leaves clean text; every other one still drops the value.
    const atEdge = /\s/.test(ch) ? "TB2" : null;
    expect(bscListedText(`${ch}TB2`, BSC_LISTED_BOUNDS.cardNo)).toBe(atEdge);
    expect(bscListedText(`TB2${ch}`, BSC_LISTED_BOUNDS.cardNo)).toBe(atEdge);
  });

  test("the neighbours of the format ranges are still display text", () => {
    // One past each range edge (U+2010, U+2027, U+202F, U+205F, U+2070, U+FEFE),
    // plus U+00A0 no-break space and U+00E9 (e acute): readable, so kept.
    // NEO-520: and the visible marks beside the single code points (U+034E
    // combining upwards arrow below, U+061B Arabic semicolon).
    for (const ch of ["\u2010", "\u2027", "\u202f", "\u205f", "\u2070", "\ufefe", "\u00a0", "\u00e9", "\u034e", "\u061b"]) {
      expect(bscListedText(`TB${ch}2`, BSC_LISTED_BOUNDS.cardNo)).toBe(`TB${ch}2`);
    }
  });

  test("an integer year is read as its digits; other number shapes are not", () => {
    const o = base();
    o.orderItems[0].card.year = 2021;
    expect(listedOf(o)?.year).toBe("2021");
    o.orderItems[0].card.year = 2021.5;
    expect(listedOf(o)?.year).toBeUndefined();
  });

  test("reads only the named keys: no image paths, prices or attributes", () => {
    const o = base();
    o.orderItems[0].card.playerAttribute = "RC";
    const listed = listedOf(o) ?? {};
    expect(Object.keys(listed).sort()).toEqual(
      ["cardNo", "platformSportId", "players", "setName", "sport", "variant", "variantName", "year"].sort(),
    );
  });

  test("an item with no card and no sport id has no description", () => {
    const order = parseBscOrder({
      orderId: "o1",
      orderStatus: "READY_TO_SHIP",
      orderItems: [{ cardId: "c1", condition: "ex", orderQuantity: 1, card: "junk" }],
    });
    expect(order?.items[0]?.listed).toBeNull();
    expect(order?.unreadableItems).toBe(0);
  });
});
