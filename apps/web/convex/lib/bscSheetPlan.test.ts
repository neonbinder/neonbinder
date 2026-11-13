import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import {
  BSC_PUT_CHUNK_SIZE,
  chunkRows,
  foldBscTargets,
  joinNarrowedSheets,
  MAX_SHEET_CARD_ID,
  MAX_SHEET_CONDITION,
  MAX_SHEET_ROW_BYTES,
  MAX_SHEET_SKU,
  narrowBscSheet,
  narrowBscSheetRow,
  photoKeyFor,
  planBscSheet,
  rowNeedsSellerPhoto,
  type BscTarget,
  type ListingCopy,
  type NbVariantCard,
} from "./bscSheetPlan";
import { encodeId } from "./convexIdCodec";
import { buildListingSku, parseListingSku } from "./listingSku";

function idOf(table: number, seed: number): string {
  const bytes = new Uint8Array(16);
  bytes[0] = seed & 0xff;
  bytes[1] = (seed >> 8) & 0xff;
  return encodeId(table, bytes);
}
const card = (n: number) => idOf(10001, n) as Id<"cardChecklist">;
const box = (n: number) => idOf(10002, n) as Id<"collectionContainers">;
const copyId = (n: number) => idOf(10003, n) as Id<"collectionCopies">;
const privateCard = (n: number) => idOf(10004, n) as Id<"privateCards">;

let copySeq = 0;
function copy(over: Partial<ListingCopy> & { cardN?: number; boxN?: number } = {}): ListingCopy {
  copySeq += 1;
  const { cardN = 1, boxN = 1, ...rest } = over;
  return {
    copyId: copyId(copySeq),
    homeId: box(boxN),
    card: { kind: "catalog", id: card(cardN) },
    homeIsBox: true,
    graded: false,
    quantity: 1,
    condition: "Near Mint",
    creationTime: 1_700_000_000_000 + copySeq * 1000,
    hasPhotos: false,
    ...rest,
  };
}

/** A sheet row the way `seller/bulk-upload/results` sends it. */
function sheetRow(
  bscCardId: string,
  cardNo: string,
  condition: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    productId: `p-${bscCardId}-${condition}`,
    productType: "raw",
    cardId: bscCardId,
    price: "0",
    condition,
    availableQuantity: 0,
    active: false,
    sellerId: "seller",
    cardYear: 1988,
    updatedTimestamp: "2026-10-28T00:00:00",
    card: { id: bscCardId, cardNo, players: "Someone", playerAttribute: "" },
    ...over,
  };
}

function target(over: Partial<BscTarget> & { cardN?: number } = {}): BscTarget {
  const { cardN = 1, ...rest } = over;
  const cardId = card(cardN);
  const bscCondition = rest.bscCondition ?? "near_mint";
  return {
    cardId,
    bscCondition,
    quantity: 2,
    priceCents: 50,
    sku: buildListingSku({ cardId, bscCondition, boxId: box(1) }),
    oldestCopyId: copyId(9000 + cardN),
    photoCopyId: null,
    ...rest,
  };
}

const nbCard = (n: number, cardNumber: string, bscRef: string | null): NbVariantCard => ({
  cardId: card(n),
  cardNumber,
  bscRef,
});

// ── fold ────────────────────────────────────────────────────────────────────

describe("foldBscTargets (NEO-370)", () => {
  test("binder copies are never for sale and are not problems", () => {
    const { targets, problems } = foldBscTargets({
      copies: [copy({ homeIsBox: false, graded: true, condition: undefined })],
      era: "modern",
      commonPriceCents: 10,
    });
    expect(targets).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("the oldest copy with photos supplies them; the SKU's box stays the oldest copy's", () => {
    const first = copy({ boxN: 1, creationTime: 1_000, hasPhotos: false });
    const second = copy({ boxN: 2, creationTime: 2_000, hasPhotos: true });
    const third = copy({ boxN: 3, creationTime: 3_000, hasPhotos: true });
    const { targets } = foldBscTargets({ copies: [third, first, second], era: "modern", commonPriceCents: 40 });
    expect(targets).toHaveLength(1);
    expect(targets[0].photoCopyId).toBe(second.copyId);
    expect(targets[0].oldestCopyId).toBe(first.copyId);
    expect(targets[0].sku).toBe(buildListingSku({ cardId: card(1), bscCondition: "near_mint", boxId: box(1) }));
  });

  test("no photo on any copy of the group is null, and a photo in another condition doesn't leak across", () => {
    const nm = copy({ condition: "Near Mint", hasPhotos: false });
    const good = copy({ condition: "Good", hasPhotos: true });
    const { targets } = foldBscTargets({ copies: [nm, good], era: "modern", commonPriceCents: 40 });
    const byCondition = new Map(targets.map((t) => [t.bscCondition, t.photoCopyId]));
    expect(byCondition.get("near_mint")).toBeNull();
    expect([...byCondition.values()].filter((id) => id !== null)).toEqual([good.copyId]);
  });

  test("a zero-quantity or binder copy with photos never supplies them", () => {
    const empty = copy({ creationTime: 0, quantity: 0, hasPhotos: true });
    const binder = copy({ creationTime: 1, homeIsBox: false, hasPhotos: true });
    const live = copy({ creationTime: 9_000_000_000, hasPhotos: true });
    const { targets } = foldBscTargets({ copies: [empty, binder, live], era: "modern", commonPriceCents: 40 });
    expect(targets[0].photoCopyId).toBe(live.copyId);
  });

  test("two photo copies on one age day: the earlier created supplies them, then the lower id", () => {
    const day = 5 * 86_400_000;
    const late = copy({ creationTime: day + 20, hasPhotos: true });
    const early = copy({ creationTime: day + 10, hasPhotos: true });
    const twin = copy({ creationTime: day + 10, hasPhotos: true });
    const pick = (...copies: ListingCopy[]) =>
      foldBscTargets({ copies, era: "modern", commonPriceCents: 40 }).targets[0].photoCopyId;
    expect(pick(late, early)).toBe(early.copyId);
    const lower = early.copyId < twin.copyId ? early.copyId : twin.copyId;
    expect(pick(early, twin)).toBe(lower);
    expect(pick(twin, early)).toBe(lower);
  });

  test("Up for Trade box copies are for sale like any box copy", () => {
    // upForTrade is not an input: the home's kind alone decides.
    const { targets } = foldBscTargets({ copies: [copy({ quantity: 3 })], era: "modern", commonPriceCents: 40 });
    expect(targets).toHaveLength(1);
    expect(targets[0].quantity).toBe(3);
  });

  test("two NB conditions on one BSC condition sum into one target", () => {
    const { targets } = foldBscTargets({
      copies: [copy({ condition: "Mint", quantity: 2 }), copy({ condition: "Near Mint", quantity: 3 })],
      era: "modern",
      commonPriceCents: 40,
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ cardId: card(1), bscCondition: "near_mint", quantity: 5 });
  });

  test("vintage keeps them apart", () => {
    const { targets } = foldBscTargets({
      copies: [copy({ condition: "Mint" }), copy({ condition: "Near Mint" })],
      era: "vintage",
      commonPriceCents: 40,
    });
    expect(targets.map((t) => t.bscCondition).sort()).toEqual(["mint", "nm"]);
  });

  test("price is the highest floor: copy floor, else the common price", () => {
    const { targets } = foldBscTargets({
      copies: [copy({ minPriceCents: 75 }), copy({}), copy({ minPriceCents: 30 })],
      era: "modern",
      commonPriceCents: 60,
    });
    expect(targets[0].priceCents).toBe(75);
    const lower = foldBscTargets({ copies: [copy({ minPriceCents: 10 }), copy({})], era: "modern", commonPriceCents: 60 });
    expect(lower.targets[0].priceCents).toBe(60);
  });

  test("no floor anywhere leaves the price null (the plan reports it)", () => {
    const { targets } = foldBscTargets({ copies: [copy({})], era: "modern", commonPriceCents: undefined });
    expect(targets[0].priceCents).toBeNull();
  });

  test("the SKU names the oldest copy's box, by acquired date before creation", () => {
    const newerButAcquiredEarlier = copy({ boxN: 7, acquiredOn: "2019-05-01", creationTime: 1_800_000_000_000 });
    const olderCreated = copy({ boxN: 3, creationTime: 1_600_000_000_000 });
    const { targets } = foldBscTargets({
      copies: [olderCreated, newerButAcquiredEarlier],
      era: "modern",
      commonPriceCents: 40,
    });
    expect(parseListingSku(targets[0].sku)).toEqual({ cardId: card(1), bscCondition: "near_mint", boxId: box(7) });
    expect(targets[0].oldestCopyId).toBe(newerButAcquiredEarlier.copyId);
  });

  test("graded, private, no condition and no era are skipped and reported", () => {
    const priv = copy({});
    priv.card = { kind: "private", id: privateCard(1) };
    const { targets, problems } = foldBscTargets({
      copies: [copy({ cardN: 2, graded: true }), priv, copy({ cardN: 3, condition: undefined }), copy({ cardN: 4 })],
      era: "modern",
      commonPriceCents: 40,
    });
    expect(targets.map((t) => t.cardId)).toEqual([card(4)]);
    expect(problems).toEqual([
      { reason: "graded", cardId: card(2) },
      { reason: "private_card", cardId: privateCard(1) },
      { reason: "no_condition", cardId: card(3) },
    ]);
    const noEra = foldBscTargets({ copies: [copy({ cardN: 5 }), copy({ cardN: 5 })], era: null, commonPriceCents: 40 });
    expect(noEra.targets).toEqual([]);
    expect(noEra.problems).toEqual([{ reason: "no_era", cardId: card(5) }]);
  });

  test("a graded copy does not hold back the card's raw copies", () => {
    const { targets, problems } = foldBscTargets({
      copies: [copy({ graded: true }), copy({ quantity: 2 })],
      era: "modern",
      commonPriceCents: 40,
    });
    expect(targets[0].quantity).toBe(2);
    expect(problems).toEqual([{ reason: "graded", cardId: card(1) }]);
  });
});

// ── narrowing ───────────────────────────────────────────────────────────────

describe("narrowBscSheetRow (NEO-370)", () => {
  test("reads a real-shaped row and keeps the raw object", () => {
    const raw = sheetRow("abc", "12", "near_mint", { price: "0.50", availableQuantity: 3, sellerSku: "x" });
    const row = narrowBscSheetRow(raw);
    expect(row).toMatchObject({ bscCardId: "abc", cardNo: "12", condition: "near_mint", quantity: 3, priceCents: 50, sellerSku: "x" });
    expect(row?.raw).toBe(raw);
  });

  test("a numeric cardNo is read as text", () => {
    expect(narrowBscSheetRow(sheetRow("abc", "x", "near_mint", { card: { id: "abc", cardNo: 7 } }))?.cardNo).toBe("7");
  });

  test("rejects rows missing what a push needs", () => {
    expect(narrowBscSheetRow(null)).toBeNull();
    expect(narrowBscSheetRow([])).toBeNull();
    expect(narrowBscSheetRow(sheetRow("abc", "1", "near_mint", { card: null }))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("abc", "1", "near_mint", { card: { cardNo: "1" } }))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("abc", "1", "near_mint", { card: { id: "abc" } }))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("abc", "1", "near_mint", { cardId: "other" }))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("abc", "1", ""))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("abc", "1", "near_mint", { availableQuantity: "3" }))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("abc", "1", "near_mint", { availableQuantity: -1 }))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("abc", "1", "near_mint", { availableQuantity: 1.5 }))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("abc", "1", "near_mint", { price: "n/a" }))).toBeNull();
  });

  test("seller photo is needed while the row shows BSC's default or none", () => {
    const none = narrowBscSheetRow(sheetRow("a", "1", "near_mint"))!;
    expect(rowNeedsSellerPhoto(none, "front")).toBe(true);
    const def = narrowBscSheetRow(sheetRow("a", "1", "near_mint", { sellerImgFront: "/Images/DefaultFront.gif", sellerImgBack: "/prod/x-back.jpg" }))!;
    expect(rowNeedsSellerPhoto(def, "front")).toBe(true);
    expect(rowNeedsSellerPhoto(def, "back")).toBe(false);
  });
});

// ── plan ────────────────────────────────────────────────────────────────────

describe("planBscSheet (NEO-370)", () => {
  const MODERN = ["near_mint", "excellent", "very_good", "poor"];

  test("sets a targeted row by spreading it back with quantity, price and SKU", () => {
    const t = target({ quantity: 2, priceCents: 50 });
    const raw = sheetRow("bsc-1", "1", "near_mint", { extra: { keep: true } });
    const plan = planBscSheet({
      sheetRows: [raw],
      conditionsRead: MODERN,
      targets: [t],
      cards: [nbCard(1, "1", "bsc-1")],
    });
    expect(plan.problems).toEqual([]);
    expect(plan.puts).toHaveLength(1);
    expect(plan.puts[0]).toMatchObject({ kind: "set", bscCardId: "bsc-1", condition: "near_mint", cardId: card(1) });
    expect(plan.puts[0].row).toEqual({ ...raw, availableQuantity: 2, price: 0.5, sellerSku: t.sku });
    expect(plan.chunks).toEqual([[plan.puts[0].row]]);
    expect(plan.counts).toMatchObject({ listed: 1, quantityListed: 2, toSet: 1, toZero: 0, unchanged: 0, problems: 0 });
  });

  test("a row that already matches quantity, price and SKU is not put", () => {
    const t = target({ quantity: 2, priceCents: 50 });
    const plan = planBscSheet({
      sheetRows: [sheetRow("bsc-1", "1", "near_mint", { availableQuantity: 2, price: "0.50", sellerSku: t.sku })],
      conditionsRead: MODERN,
      targets: [t],
      cards: [nbCard(1, "1", "bsc-1")],
    });
    expect(plan.puts).toEqual([]);
    expect(plan.chunks).toEqual([]);
    expect(plan.counts).toMatchObject({ listed: 1, unchanged: 1, toSet: 0 });
  });

  test("each of quantity, price and SKU alone is a change", () => {
    const t = target({ quantity: 2, priceCents: 50 });
    const base = { availableQuantity: 2, price: "0.50", sellerSku: t.sku };
    for (const over of [{ availableQuantity: 1 }, { price: "0.75" }, { sellerSku: "303|TB2" }]) {
      const plan = planBscSheet({
        sheetRows: [sheetRow("bsc-1", "1", "near_mint", { ...base, ...over })],
        conditionsRead: MODERN,
        targets: [t],
        cards: [nbCard(1, "1", "bsc-1")],
      });
      expect(plan.counts.toSet).toBe(1);
    }
  });

  test("every listed row NB does not target goes to 0; rows already at 0 are left", () => {
    const plan = planBscSheet({
      sheetRows: [
        sheetRow("bsc-1", "1", "near_mint", { availableQuantity: 4, price: "1.00", sellerSku: "303|1" }),
        sheetRow("bsc-1", "1", "excellent", { availableQuantity: 1, price: "1.00" }),
        sheetRow("bsc-2", "2", "near_mint", { availableQuantity: 0 }),
        sheetRow("bsc-9", "99", "poor", { availableQuantity: 2 }), // a BSC card NB has no row for
      ],
      conditionsRead: MODERN,
      targets: [],
      cards: [nbCard(1, "1", "bsc-1"), nbCard(2, "2", "bsc-2")],
    });
    expect(plan.puts.map((p) => [p.kind, p.bscCardId, p.condition, p.row.availableQuantity])).toEqual([
      ["zero", "bsc-1", "near_mint", 0],
      ["zero", "bsc-1", "excellent", 0],
      ["zero", "bsc-9", "poor", 0],
    ]);
    // Zeroing touches the quantity only.
    expect(plan.puts[0].row.price).toBe("1.00");
    expect(plan.puts[0].row.sellerSku).toBe("303|1");
    expect(plan.counts.toZero).toBe(3);
  });

  test("a target's other conditions are zeroed while its own is set", () => {
    const t = target({ bscCondition: "excellent", quantity: 1 });
    const plan = planBscSheet({
      sheetRows: [
        sheetRow("bsc-1", "1", "near_mint", { availableQuantity: 3 }),
        sheetRow("bsc-1", "1", "excellent", { availableQuantity: 0 }),
      ],
      conditionsRead: MODERN,
      targets: [t],
      cards: [nbCard(1, "1", "bsc-1")],
    });
    expect(plan.puts.map((p) => [p.kind, p.condition, p.row.availableQuantity])).toEqual([
      ["set", "excellent", 1],
      ["zero", "near_mint", 0],
    ]);
  });

  test("NB card with no BSC id: problem, nothing pushed for it", () => {
    const plan = planBscSheet({
      sheetRows: [sheetRow("bsc-1", "1", "near_mint")],
      conditionsRead: MODERN,
      targets: [target()],
      cards: [nbCard(1, "1", null)],
    });
    expect(plan.puts).toEqual([]);
    expect(plan.problems).toEqual([{ reason: "no_bsc_id", cardId: card(1) }]);
  });

  test("two NB cards sharing a BSC id: problem, and that BSC card's rows are left alone", () => {
    const plan = planBscSheet({
      sheetRows: [
        sheetRow("bsc-1", "1", "near_mint", { availableQuantity: 5 }),
        sheetRow("bsc-1", "1", "excellent", { availableQuantity: 2 }),
      ],
      conditionsRead: MODERN,
      targets: [target({ cardN: 1 })],
      cards: [nbCard(1, "1", "bsc-1"), nbCard(2, "1a", "bsc-1")],
    });
    expect(plan.puts).toEqual([]);
    expect(plan.problems).toEqual([{ reason: "shared_bsc_id", cardId: card(1), bscCardId: "bsc-1" }]);
  });

  test("a shared BSC id NB holds no stock of is zeroed like any other row", () => {
    const plan = planBscSheet({
      sheetRows: [sheetRow("bsc-1", "1", "near_mint", { availableQuantity: 5 })],
      conditionsRead: MODERN,
      targets: [],
      cards: [nbCard(1, "1", "bsc-1"), nbCard(2, "1a", "bsc-1")],
    });
    expect(plan.puts.map((p) => p.kind)).toEqual(["zero"]);
    expect(plan.problems).toEqual([]);
  });

  test("sheet cardNo differing from NB's number is a conflict, never pushed, never zeroed", () => {
    const plan = planBscSheet({
      sheetRows: [
        sheetRow("bsc-1", "12", "near_mint", { availableQuantity: 1 }),
        sheetRow("bsc-1", "12", "poor", { availableQuantity: 4 }),
      ],
      conditionsRead: MODERN,
      targets: [target()],
      cards: [nbCard(1, "21", "bsc-1")],
    });
    expect(plan.puts).toEqual([]);
    expect(plan.problems).toEqual([
      { reason: "card_number_conflict", cardId: card(1), bscCardId: "bsc-1", detail: "NB #21" },
    ]);
  });

  test("the card-number check is case- and space-insensitive only", () => {
    const ok = planBscSheet({
      sheetRows: [sheetRow("bsc-1", "tb2 ", "near_mint")],
      conditionsRead: MODERN,
      targets: [target()],
      cards: [nbCard(1, "TB2", "bsc-1")],
    });
    expect(ok.problems).toEqual([]);
    const leadingZero = planBscSheet({
      sheetRows: [sheetRow("bsc-1", "001", "near_mint")],
      conditionsRead: MODERN,
      targets: [target()],
      cards: [nbCard(1, "1", "bsc-1")],
    });
    expect(leadingZero.problems.map((p) => p.reason)).toEqual(["card_number_conflict"]);
  });

  describe("the check with a prefix on the variant's chain (NEO-458)", () => {
    const planOne = (sheetCardNo: string, nbNumber: string, cardNumberPrefixes?: readonly string[]) =>
      planBscSheet({
        sheetRows: [sheetRow("bsc-1", sheetCardNo, "near_mint", { availableQuantity: 4 })],
        conditionsRead: MODERN,
        targets: [target()],
        cards: [nbCard(1, nbNumber, "bsc-1")],
        cardNumberPrefixes,
      });
    const lists = (plan: ReturnType<typeof planOne>) => {
      expect(plan.problems).toEqual([]);
      expect(plan.puts.map((p) => [p.kind, p.bscCardId, p.row.availableQuantity])).toEqual([["set", "bsc-1", 2]]);
    };
    const holds = (plan: ReturnType<typeof planOne>, nbNumber: string) => {
      expect(plan.puts).toEqual([]);
      expect(plan.problems).toEqual([
        { reason: "card_number_conflict", cardId: card(1), bscCardId: "bsc-1", detail: `NB #${nbNumber}` },
      ]);
    };

    test("a prefix on the sheet's number and a bare NB number lists", () => {
      lists(planOne("BC-98", "98", ["BC-"]));
    });

    test("a prefix on NB's number and a bare sheet number lists", () => {
      lists(planOne("98", "BC-98", ["BC-"]));
    });

    test("the same prefixed number on both sides lists, as it always did", () => {
      lists(planOne("BC-98", "BC-98", ["BC-"]));
    });

    test("no prefix in force: a prefixed sheet number against a bare NB number is held", () => {
      holds(planOne("BC-98", "98"), "98");
      holds(planOne("BC-98", "98", []), "98");
    });

    test("no prefix in force: a differing number is held", () => {
      holds(planOne("12", "21", []), "21");
    });

    test("a prefix that is not this number's is held", () => {
      holds(planOne("XY-98", "98", ["BC-"]), "98");
    });

    test("a number that differs once stripped is held, and the detail stays NB's own", () => {
      const plan = planOne("BC-98", "99", ["BC-"]);
      holds(plan, "99");
      expect(JSON.stringify(plan.problems)).not.toContain("BC-");
    });

    test("a held card's other rows are not zeroed", () => {
      const plan = planBscSheet({
        sheetRows: [
          sheetRow("bsc-1", "BC-98", "near_mint", { availableQuantity: 1 }),
          sheetRow("bsc-1", "BC-98", "poor", { availableQuantity: 4 }),
        ],
        conditionsRead: MODERN,
        targets: [target()],
        cards: [nbCard(1, "99", "bsc-1")],
        cardNumberPrefixes: ["BC-"],
      });
      expect(plan.puts).toEqual([]);
    });

    test("a number equal to the prefix alone is not stripped down to nothing", () => {
      // NB's blank number never matches a sheet number that is only the prefix.
      holds(planOne("BC-", "", ["BC-"]), "");
      holds(planOne("", "BC-", ["BC-"]), "BC-");
      holds(planOne("BC-", "98", ["BC-"]), "98");
      holds(planOne("98", "BC-", ["BC-"]), "BC-");
      // Equal as written is still equal.
      lists(planOne("BC-", "BC-", ["BC-"]));
    });

    test("case differences anywhere are one number", () => {
      lists(planOne("bc-98", "98", ["BC-"]));
      lists(planOne("BC-98", "98", ["bc-"]));
      lists(planOne("BC-98A", "98a", ["BC-"]));
      lists(planOne("98a", "bc-98A", ["BC-"]));
    });

    test("surrounding spaces on the number or the prefix don't matter", () => {
      lists(planOne("  BC-98 ", " 98", [" BC- "]));
    });

    test("an insert's prefix on NB's number and the parallel's on the sheet's lists", () => {
      lists(planOne("DKS-98", "DK-98", ["DK-", "DKS-"]));
      lists(planOne("DKS-98", "DK-98", ["DKS-", "DK-"]));
      lists(planOne("DKS-98", "98", ["DK-", "DKS-"]));
      lists(planOne("DK-98", "98", ["DK-", "DKS-"]));
    });

    test("deliberate: a parallel's card copied from its insert may carry a different chain prefix on each side, so DK-98 against DKS-98 lists", () => {
      // Same idea as lib/parallelCardLink.ts: the parallel's cards are copied
      // from the insert, so NB can hold the insert's prefix while BSC shows
      // the parallel's. Each side is stripped with every prefix on the chain.
      lists(planOne("DK-98", "DKS-98", ["DK-", "DKS-"]));
      lists(planOne("DK-98", "DKS-98", ["DKS-", "DK-"]));
    });

    test("DK-98 against DKS-99 under the same chain prefixes is held", () => {
      holds(planOne("DK-98", "DKS-99", ["DK-", "DKS-"]), "DKS-99");
    });

    test("the deepest prefix alone would not pass the insert-and-parallel case", () => {
      holds(planOne("DKS-98", "DK-98", ["DKS-"]), "DK-98");
    });

    test("two prefixes still need the same number left over", () => {
      holds(planOne("DKS-98", "DK-99", ["DK-", "DKS-"]), "DK-99");
    });

    test.each([
      ["a leading zero", "BC-098", "98", ["BC-"]],
      ["a variation suffix on the sheet", "BC-98a", "98", ["BC-"]],
      ["a variation suffix on NB", "BC-98", "98a", ["BC-"]],
      ["a number stem", "BC-9", "98", ["BC-"]],
      ["the prefix twice", "BC-BC-98", "98", ["BC-"]],
      ["the prefix behind another word", "X-BC-98", "98", ["BC-"]],
      ["the prefix at the end", "98BC-", "98", ["BC-"]],
      ["a space left after the prefix", "BC- 98", "98", ["BC-"]],
      ["a digit prefix splitting the sheet's number", "12", "2", ["1"]],
      ["a digit prefix splitting a repeated digit", "11", "1", ["1"]],
      ["a prefix ending in a digit splitting the sheet's number", "T21", "1", ["T2"]],
      ["a digit prefix splitting NB's number", "2", "12", ["1"]],
      ["a prefix ending in a digit splitting NB's number", "1", "T21", ["T2"]],
      ["a digit prefix with a space after it", "12", "2", ["1 "]],
      ["the split prefix beside one that fits nothing", "T21", "1", ["T", "T2"]],
    ])("nothing looser: %s is held", (_label, sheetCardNo, nbNumber, prefixes) => {
      holds(planOne(sheetCardNo, nbNumber, prefixes), nbNumber);
    });

    test.each([
      ["a prefix ending in a letter", "BCV-26", "26", ["BCV-"]],
      ["a letter prefix with no separator", "T21", "21", ["T"]],
      ["a prefix ending in a digit, with a separator next", "T2-1", "1", ["T2-"]],
      ["a prefix ending in a digit, with a letter next", "T2A", "A", ["T2"]],
      ["a letter prefix beside a digit one", "T21", "21", ["T", "T2"]],
      ["the same number as written, under a digit prefix", "12", "12", ["1"]],
    ])("a prefix that splits no digits still lists: %s", (_label, sheetCardNo, nbNumber, prefixes) => {
      lists(planOne(sheetCardNo, nbNumber, prefixes));
    });

    test("nested prefixes come off one at a time, never stacked", () => {
      holds(planOne("BC-P-98", "98", ["BC-", "P-"]), "98");
    });

    test("an empty or blank prefix changes nothing", () => {
      holds(planOne("BC-98", "98", ["", "   "]), "98");
      lists(planOne("98", "98", ["", "   "]));
    });

    test("the BSC ref stays the key: a prefix never moves stock onto another card's row", () => {
      const plan = planBscSheet({
        sheetRows: [
          sheetRow("bsc-1", "BC-1", "near_mint"),
          sheetRow("bsc-2", "BC-2", "near_mint", { availableQuantity: 3 }),
        ],
        conditionsRead: MODERN,
        targets: [target()],
        cards: [nbCard(1, "1", "bsc-1"), nbCard(2, "2", "bsc-2")],
        cardNumberPrefixes: ["BC-"],
      });
      expect(plan.problems).toEqual([]);
      expect(plan.puts.map((p) => [p.kind, p.bscCardId])).toEqual([
        ["set", "bsc-1"],
        ["zero", "bsc-2"],
      ]);
    });

    test("photo keys re-plan the same way", () => {
      const plan = planBscSheet({
        sheetRows: [sheetRow("bsc-1", "BC-98", "near_mint")],
        conditionsRead: MODERN,
        targets: [target()],
        cards: [nbCard(1, "98", "bsc-1")],
        cardNumberPrefixes: ["BC-"],
        photoKeys: new Map([[photoKeyFor("bsc-1", "near_mint"), { front: "seller/front.jpg" }]]),
      });
      expect(plan.problems).toEqual([]);
      expect(plan.puts[0].row.sellerImgFront).toBe("seller/front.jpg");
    });
  });

  test("price problems: none and over $999 are refused; under 25¢ is raised", () => {
    const rows = [
      sheetRow("bsc-1", "1", "near_mint", { availableQuantity: 3 }),
      sheetRow("bsc-2", "2", "near_mint", { availableQuantity: 3 }),
      sheetRow("bsc-3", "3", "near_mint"),
    ];
    const plan = planBscSheet({
      sheetRows: rows,
      conditionsRead: MODERN,
      targets: [target({ cardN: 1, priceCents: null }), target({ cardN: 2, priceCents: 100_000 }), target({ cardN: 3, priceCents: 5 })],
      cards: [nbCard(1, "1", "bsc-1"), nbCard(2, "2", "bsc-2"), nbCard(3, "3", "bsc-3")],
    });
    expect(plan.problems).toEqual([
      { reason: "no_price", cardId: card(1), bscCardId: "bsc-1", bscCondition: "near_mint" },
      { reason: "price_too_high", cardId: card(2), bscCardId: "bsc-2", bscCondition: "near_mint" },
    ]);
    // The refused rows stay as they are on BSC (not zeroed); only card 3 is set, at 25¢.
    expect(plan.puts).toHaveLength(1);
    expect(plan.puts[0]).toMatchObject({ kind: "set", bscCardId: "bsc-3" });
    expect(plan.puts[0].row.price).toBe(0.25);
  });

  test("a target whose BSC id is not on the sheet, or whose condition was not read", () => {
    const plan = planBscSheet({
      sheetRows: [sheetRow("bsc-1", "1", "near_mint")],
      conditionsRead: ["near_mint"],
      targets: [target({ cardN: 2 }), target({ cardN: 1, bscCondition: "poor" })],
      cards: [nbCard(1, "1", "bsc-1"), nbCard(2, "2", "bsc-elsewhere")],
    });
    expect(plan.puts).toEqual([]);
    expect(plan.problems).toEqual([
      { reason: "not_on_bsc_sheet", cardId: card(2), bscCardId: "bsc-elsewhere", bscCondition: "near_mint" },
      { reason: "condition_not_read", cardId: card(1), bscCardId: "bsc-1", bscCondition: "poor" },
    ]);
  });

  test("a target for a card outside the variant is refused", () => {
    const plan = planBscSheet({
      sheetRows: [sheetRow("bsc-1", "1", "near_mint")],
      conditionsRead: MODERN,
      targets: [target({ cardN: 5 })],
      cards: [nbCard(1, "1", "bsc-1")],
    });
    expect(plan.problems).toEqual([{ reason: "card_not_in_variant", cardId: card(5) }]);
  });

  test("two sheet rows for one (card, condition): never put, reported once", () => {
    const plan = planBscSheet({
      sheetRows: [
        sheetRow("bsc-1", "1", "near_mint", { availableQuantity: 1 }),
        sheetRow("bsc-1", "1", "near_mint", { availableQuantity: 2, productId: "other" }),
        sheetRow("bsc-1", "1", "near_mint", { availableQuantity: 3, productId: "third" }),
      ],
      conditionsRead: MODERN,
      targets: [target()],
      cards: [nbCard(1, "1", "bsc-1")],
    });
    expect(plan.puts).toEqual([]);
    expect(plan.problems).toEqual([{ reason: "duplicate_sheet_row", bscCardId: "bsc-1", bscCondition: "near_mint" }]);
  });

  test("never two put rows for one (card.id, condition), even with duplicate targets", () => {
    const t = target();
    const plan = planBscSheet({
      sheetRows: [sheetRow("bsc-1", "1", "near_mint")],
      conditionsRead: MODERN,
      targets: [t, { ...t, quantity: 9 }],
      cards: [nbCard(1, "1", "bsc-1")],
    });
    const keys = plan.puts.map((p) => photoKeyFor(p.bscCardId, p.condition));
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.puts).toHaveLength(1);
  });

  test("keys on card.id + condition, never productId", () => {
    // A row that dropped to 0 came back with a new productId: still the same row.
    const t = target({ quantity: 1, priceCents: 50 });
    const plan = planBscSheet({
      sheetRows: [sheetRow("bsc-1", "1", "near_mint", { productId: "brand-new", availableQuantity: 1, price: "0.5", sellerSku: t.sku })],
      conditionsRead: MODERN,
      targets: [t],
      cards: [nbCard(1, "1", "bsc-1")],
    });
    expect(plan.counts.unchanged).toBe(1);
  });

  test("unreadable and graded sheet rows are never touched; unreadable ones are reported", () => {
    const plan = planBscSheet({
      sheetRows: [{ junk: true }, sheetRow("bsc-1", "1", "near_mint", { productType: "graded", availableQuantity: 4 })],
      conditionsRead: MODERN,
      targets: [],
      cards: [],
    });
    expect(plan.puts).toEqual([]);
    expect(plan.problems).toEqual([{ reason: "unreadable_sheet_row", detail: "1 of 2 rows" }]);
    expect(plan.counts).toMatchObject({ sheetRows: 2, unreadableRows: 1 });
  });

  test("photo keys go on a set row only where BSC still shows its default image", () => {
    const t = target({ quantity: 1, priceCents: 50 });
    const rowValues = { availableQuantity: 1, price: "0.50", sellerSku: t.sku, sellerImgFront: "/Images/DefaultFront.gif", sellerImgBack: "/prod/mine-back.jpg" };
    const input = {
      sheetRows: [sheetRow("bsc-1", "1", "near_mint", rowValues)],
      conditionsRead: MODERN,
      targets: [t],
      cards: [nbCard(1, "1", "bsc-1")],
    };
    // Without keys the row is unchanged, and the plan says which side wants a photo.
    expect(planBscSheet(input).puts).toEqual([]);
    const keys = new Map([[photoKeyFor("bsc-1", "near_mint"), { front: "k-front", back: "k-back" }]]);
    const plan = planBscSheet({ ...input, photoKeys: keys });
    expect(plan.puts).toHaveLength(1);
    expect(plan.puts[0].row.sellerImgFront).toBe("k-front");
    expect(plan.puts[0].row.sellerImgBack).toBe("/prod/mine-back.jpg");
    expect(plan.puts[0]).toMatchObject({ needsPhotoFront: true, needsPhotoBack: false });
  });

  test("NEO-481: a card flagged for a photo refresh takes its keys over a seller photo BSC already shows", () => {
    const t = target({ quantity: 1, priceCents: 50 });
    const rowValues = {
      availableQuantity: 1,
      price: "0.50",
      sellerSku: t.sku,
      sellerImgFront: "/prod/old-front.jpg",
      sellerImgBack: "/prod/old-back.jpg",
    };
    const input = {
      sheetRows: [sheetRow("bsc-1", "1", "near_mint", rowValues)],
      conditionsRead: MODERN,
      targets: [t],
      cards: [nbCard(1, "1", "bsc-1")],
      photoKeys: new Map([[photoKeyFor("bsc-1", "near_mint"), { front: "k-front", back: "k-back" }]]),
    };
    // Not flagged: the seller photos stand, the keys are ignored and the row is unchanged.
    expect(planBscSheet(input).puts).toEqual([]);
    // Flagged: the row is sent with NB's new photos on both sides, the rest of it as it was.
    const plan = planBscSheet({ ...input, refreshPhotoCardIds: new Set([t.cardId]) });
    expect(plan.puts).toHaveLength(1);
    expect(plan.puts[0].row).toMatchObject({
      sellerImgFront: "k-front",
      sellerImgBack: "k-back",
      availableQuantity: 1,
      sellerSku: t.sku,
    });
    expect(plan.counts).toMatchObject({ toSet: 1, unchanged: 0 });
    // The flag names the row as over a seller photo, not a stock one.
    expect(plan.puts[0]).toMatchObject({ needsPhotoFront: false, needsPhotoBack: false });
    // Flagged with no key for a side (no upload for it): that side is left alone.
    const frontOnly = planBscSheet({
      ...input,
      photoKeys: new Map([[photoKeyFor("bsc-1", "near_mint"), { front: "k-front" }]]),
      refreshPhotoCardIds: new Set([t.cardId]),
    });
    expect(frontOnly.puts[0].row.sellerImgFront).toBe("k-front");
    expect(frontOnly.puts[0].row.sellerImgBack).toBe("/prod/old-back.jpg");
    // Another card's flag changes nothing for this one.
    expect(planBscSheet({ ...input, refreshPhotoCardIds: new Set([card(2) as string]) }).puts).toEqual([]);
  });

  test("chunks at 100 rows, in order, sharing the put row objects", () => {
    const rows = Array.from({ length: 250 }, (_, i) => sheetRow(`bsc-${i}`, `${i}`, "near_mint", { availableQuantity: 1 }));
    const plan = planBscSheet({ sheetRows: rows, conditionsRead: MODERN, targets: [], cards: [] });
    expect(BSC_PUT_CHUNK_SIZE).toBe(100);
    expect(plan.chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(plan.chunks.flat()).toEqual(plan.puts.map((p) => p.row));
    expect(plan.chunks[0][0]).toBe(plan.puts[0].row);
  });

  test("fold then plan, end to end: Mint + Near Mint copies in two boxes make one row", () => {
    const a = copy({ cardN: 1, boxN: 2, condition: "Mint", quantity: 1, acquiredOn: "2020-01-01" });
    const b = copy({ cardN: 1, boxN: 3, condition: "Near Mint", quantity: 2, minPriceCents: 80 });
    const { targets } = foldBscTargets({ copies: [a, b], era: "modern", commonPriceCents: 40 });
    const plan = planBscSheet({
      sheetRows: [sheetRow("bsc-1", "1", "near_mint"), sheetRow("bsc-1", "1", "excellent")],
      conditionsRead: MODERN,
      targets,
      cards: [nbCard(1, "1", "bsc-1")],
    });
    expect(plan.puts).toHaveLength(1);
    expect(plan.puts[0].row).toMatchObject({ availableQuantity: 3, price: 0.8, condition: "near_mint" });
    expect(parseListingSku(String(plan.puts[0].row.sellerSku))?.boxId).toBe(box(2));
  });
});

describe("chunkRows", () => {
  test("empty in, empty out; refuses a bad size", () => {
    expect(chunkRows([])).toEqual([]);
    expect(chunkRows([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(() => chunkRows([1], 0)).toThrow();
  });
});

describe("NEO-370 — sheet rows are bounded and narrowed as they are read", () => {
  test("a card id, card number, condition or SKU past its bound makes the row unreadable", () => {
    const long = (n: number) => "x".repeat(n);
    expect(narrowBscSheetRow(sheetRow(long(MAX_SHEET_CARD_ID), "1", "near_mint"))).not.toBeNull();
    expect(narrowBscSheetRow(sheetRow(long(MAX_SHEET_CARD_ID + 1), "1", "near_mint"))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("c1", long(MAX_SHEET_CARD_ID + 1), "near_mint"))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("c1", "1", long(MAX_SHEET_CONDITION)))).not.toBeNull();
    expect(narrowBscSheetRow(sheetRow("c1", "1", long(MAX_SHEET_CONDITION + 1)))).toBeNull();
    expect(narrowBscSheetRow(sheetRow("c1", "1", "near_mint", { sellerSku: long(MAX_SHEET_SKU) }))).not.toBeNull();
    expect(narrowBscSheetRow(sheetRow("c1", "1", "near_mint", { sellerSku: long(MAX_SHEET_SKU + 1) }))).toBeNull();
  });

  test("narrowBscSheet keeps readable rows, counts the rest, and drops an oversized row whole", () => {
    const sheet = narrowBscSheet([
      sheetRow("c1", "1", "near_mint"),
      { nonsense: true },
      sheetRow("c2", "2", "near_mint", { padding: "y".repeat(MAX_SHEET_ROW_BYTES) }),
      sheetRow("c3", "3", "near_mint"),
    ]);
    expect(sheet.kind).toBe("narrowed");
    expect(sheet.total).toBe(4);
    expect(sheet.unreadable).toBe(2);
    expect(sheet.rows.map((r) => r.bscCardId)).toEqual(["c1", "c3"]);
  });

  test("joinNarrowedSheets adds the counts and keeps every row", () => {
    const a = narrowBscSheet([sheetRow("c1", "1", "near_mint"), null]);
    const b = narrowBscSheet([sheetRow("c2", "2", "excellent")]);
    expect(joinNarrowedSheets([a, b])).toMatchObject({ total: 3, unreadable: 1 });
    expect(joinNarrowedSheets([a, b]).rows.map((r) => r.bscCardId)).toEqual(["c1", "c2"]);
  });

  test("planBscSheet reads a narrowed sheet the same as the raw rows", () => {
    const t = target();
    const rows = [sheetRow("bsc-1", "1", "near_mint"), { unreadable: true }];
    const input = { conditionsRead: ["near_mint", "excellent", "very_good", "poor"], targets: [t], cards: [nbCard(1, "1", "bsc-1")] };
    const fromRaw = planBscSheet({ ...input, sheetRows: rows });
    const fromNarrowed = planBscSheet({ ...input, sheetRows: narrowBscSheet(rows) });
    expect(fromNarrowed).toEqual(fromRaw);
    expect(fromNarrowed.counts).toMatchObject({ sheetRows: 2, unreadableRows: 1 });
  });
});
