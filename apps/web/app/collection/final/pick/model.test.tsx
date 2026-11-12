/**
 * NEO-500 — the Pick List's pure rules: the walking order, merging, the
 * groups, the filters and the box walk. Pure logic, named `.test.tsx` so the
 * `app/` project collects it.
 */
import { describe, expect, it } from "vitest";
import type { Card, VariantKind } from "../data/types";
import { sportHue } from "./colours";
import { DEMO_PICK_BOXES, DEMO_PICK_LINES } from "./demoPickStore";
import {
  boxStops,
  boxWalk,
  CANT_FIND_STOP,
  buildSections,
  compareBoxes,
  copiesLeft,
  filterRows,
  isPulled,
  mergeLines,
  naturalCompare,
  sortRows,
  variantRole,
  type PickRow,
} from "./model";
import type { PickBox, PickOrder, SaleLine } from "./types";

const EBAY_1: PickOrder = { id: "o1", venue: "eBay", number: "12-3456" };
const BSC_1: PickOrder = { id: "o2", venue: "BSC", number: "88213" };

function card(opts: {
  id?: string;
  setId?: string;
  setName?: string;
  sport?: string;
  season?: string;
  number: string;
  player?: string;
  kind?: VariantKind;
  name?: string;
  insertName?: string;
}): Card {
  const season = opts.season ?? "2026";
  const setId = opts.setId ?? "s1";
  const kind = opts.kind ?? "base";
  return {
    id: opts.id ?? `${setId}|${kind}|${opts.insertName ?? ""}|${opts.name ?? ""}|${opts.number}`,
    set: {
      id: setId,
      name: opts.setName ?? "Topps",
      season,
      year: Number.parseInt(season, 10),
      brand: { id: "b", name: "Topps" },
      sport: { id: (opts.sport ?? "Baseball").toLowerCase(), name: opts.sport ?? "Baseball" },
    },
    variant: {
      id: "v",
      kind,
      name: kind === "base" ? null : (opts.name ?? null),
      insertName: opts.insertName ?? null,
      printRun: null,
      order: 0,
      path: { typeId: "t", variantId: null, subVariantId: null },
      finish: { kind: "standard" },
    },
    cardNumber: opts.number,
    players: [{ id: "p", name: opts.player ?? "Player" }],
    teams: [],
    printRun: null,
    features: [],
    cardVariation: null,
    isVariation: false,
    sortOrder: 0,
    finish: { kind: "standard" },
  };
}

let n = 0;
function line(c: Card | null, extra: Partial<SaleLine> = {}): SaleLine {
  n += 1;
  return { id: `l${n}`, card: c, sportCode: "BB", listingTitle: "", quantity: 1, condition: "NM", order: EBAY_1, ...extra };
}

const numbers = (rows: PickRow[]) => rows.map((r) => r.card?.cardNumber);

describe("naturalCompare", () => {
  it("orders card numbers the way they print", () => {
    const sorted = ["US150", "12a", "BC-12", "2", "BC-2", "12", "100"].sort(naturalCompare);
    expect(sorted).toEqual(["2", "12", "12a", "100", "BC-2", "BC-12", "US150"]);
  });
});

describe("variantRole", () => {
  it("reads NB's variant kind, with a parallel under an insert as an insert parallel", () => {
    expect(variantRole(card({ number: "1" }))).toBe("base");
    expect(variantRole(card({ number: "1", kind: "parallel", name: "Gold" }))).toBe("parallel");
    expect(variantRole(card({ number: "1", kind: "insert", name: "Flyers" }))).toBe("insert");
    expect(variantRole(card({ number: "1", kind: "parallel", name: "Gold", insertName: "Flyers" }))).toBe("insertParallel");
    expect(variantRole(card({ number: "1", kind: "other", name: "Promo" }))).toBe("insert");
  });
});

describe("the default order", () => {
  it("is sport, year newest first, set, variant type, variant name, then card number", () => {
    const rows = mergeLines([
      line(card({ sport: "Football", number: "1" })),
      line(card({ season: "2024", number: "1", setId: "old" })),
      line(card({ number: "9", kind: "insert", name: "Flyers" })),
      line(card({ number: "3", kind: "parallel", name: "Gold", insertName: "Flyers" })),
      line(card({ number: "8", kind: "parallel", name: "Silver" })),
      line(card({ number: "7", kind: "parallel", name: "Gold" })),
      line(card({ number: "12" })),
      line(card({ number: "2" })),
    ]);
    expect(numbers(sortRows(rows, null))).toEqual(["2", "12", "7", "8", "9", "3", "1", "1"]);
    const sorted = sortRows(rows, null);
    expect(sorted[6].card?.set.year).toBe(2024);
    expect(sorted[7].card?.set.sport.name).toBe("Football");
  });

  it("files a season under its start year", () => {
    const rows = mergeLines([
      line(card({ season: "2023-24", setId: "a", number: "1" })),
      line(card({ season: "2024", setId: "b", number: "1" })),
      line(card({ season: "2022-23", setId: "c", number: "1" })),
    ]);
    expect(sortRows(rows, null).map((r) => r.card?.set.season)).toEqual(["2024", "2023-24", "2022-23"]);
  });

  it("never assumes a card number is unique: a tie falls through to the player", () => {
    const rows = mergeLines([line(card({ id: "x", number: "13", player: "Zed" })), line(card({ id: "y", number: "13", player: "Abe" }))]);
    expect(sortRows(rows, null).map((r) => r.card?.players[0].name)).toEqual(["Abe", "Zed"]);
  });

  it("sorts by a column, ties falling back to the default order", () => {
    const rows = mergeLines([
      line(card({ number: "5" }), { quantity: 2 }),
      line(card({ number: "1" })),
      line(card({ number: "3" }), { quantity: 2 }),
    ]);
    expect(numbers(sortRows(rows, "qty", "desc"))).toEqual(["3", "5", "1"]);
    expect(numbers(sortRows(rows, "number", "desc"))).toEqual(["5", "3", "1"]);
  });
});

describe("mergeLines", () => {
  const skenes = card({ number: "150", player: "Paul Skenes" });

  it("merges the same card in the same condition across orders into one row", () => {
    const rows = mergeLines([line(skenes, { order: BSC_1 }), line(skenes, { order: EBAY_1 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(2);
    expect(rows[0].orders.map((o) => o.number)).toEqual(["88213", "12-3456"]);
  });

  it("keeps a different condition, serial, slab or a line with no card apart", () => {
    const rows = mergeLines([
      line(skenes),
      line(skenes, { condition: "EX" }),
      line(skenes, { serial: "1/99" }),
      line(skenes, { serial: "2/99" }),
      line(skenes, { grade: { grader: "PSA", grade: "10", cert: "1" } }),
      line(skenes, { grade: { grader: "PSA", grade: "10", cert: "2" } }),
      line(null, { listingTitle: "a" }),
      line(null, { listingTitle: "a" }),
    ]);
    expect(rows).toHaveLength(8);
  });

  it("keeps a new sale apart from the ones the pull began with", () => {
    expect(mergeLines([line(skenes), line(skenes, { isNew: true })])).toHaveLength(2);
  });

  it("adds up shortfalls and carries Last ones", () => {
    const [row] = mergeLines([line(skenes, { short: 1 }), line(skenes, { lastOnes: true, order: BSC_1 })]);
    expect(row.short).toBe(1);
    expect(row.lastOnes).toBe(true);
  });

  it("a merged row is pulled once every line in it is", () => {
    const a = line(skenes);
    const b = line(skenes, { order: BSC_1 });
    const [row] = mergeLines([a, b]);
    expect(isPulled(row, new Set([a.id]))).toBe(false);
    expect(isPulled(row, new Set([a.id, b.id]))).toBe(true);
    expect(copiesLeft([row], new Set([a.id]))).toBe(1);
  });
});

describe("filters", () => {
  const rows = mergeLines([
    line(card({ number: "1", player: "Paul Skenes" })),
    line(card({ number: "2" }), { grade: { grader: "PSA", grade: "10", cert: "9" } }),
    line(card({ number: "3" }), { serial: "4/5", order: BSC_1 }),
    line(card({ number: "4", kind: "insert", name: "Flyers" })),
  ]);

  it("narrows to slabs, numbered cards, an order, a type or a word", () => {
    expect(numbers(filterRows(rows, { slabs: true }))).toEqual(["2"]);
    expect(numbers(filterRows(rows, { numbered: true }))).toEqual(["3"]);
    expect(numbers(filterRows(rows, { order: "o2" }))).toEqual(["3"]);
    expect(numbers(filterRows(rows, { variant: "insert" }))).toEqual(["4"]);
    expect(numbers(filterRows(rows, { text: "skenes" }))).toEqual(["1"]);
    expect(numbers(filterRows(rows, { condition: "Graded" }))).toEqual(["2"]);
  });
});

describe("buildSections", () => {
  const lines = [
    line(card({ setId: "a", setName: "Alpha", number: "1" })),
    line(card({ setId: "a", setName: "Alpha", number: "2" }), { order: BSC_1 }),
    line(card({ setId: "b", setName: "Beta", number: "1" })),
    line(null, { listingTitle: "mystery", problem: "No such set" }),
    line(card({ setId: "a", setName: "Alpha", number: "3" }), { isNew: true }),
  ];

  it("puts Can't find it on top, one section per set, and new sales at the bottom", () => {
    const s = buildSections(lines, {}, { sort: null, dir: "asc", groupByOrder: false });
    expect(s.map((x) => x.kind)).toEqual(["cantFind", "set", "set", "new"]);
    expect(s[1].kind === "set" && s[1].title).toBe("2026 Alpha");
  });

  it("is one flat run when sorted by a column other than the set", () => {
    const s = buildSections(lines, {}, { sort: "number", dir: "asc", groupByOrder: false });
    expect(s.map((x) => x.kind)).toEqual(["cantFind", "flat", "new"]);
  });

  it("groups by order, each order with its own lines", () => {
    const s = buildSections(lines, {}, { sort: null, dir: "asc", groupByOrder: true });
    expect(s.map((x) => (x.kind === "order" ? x.order.number : x.kind))).toEqual(["88213", "12-3456"]);
  });
});

describe("By the Box", () => {
  const boxes: PickBox[] = [
    { id: "u", name: "Unsorted", unsorted: true },
    { id: "b10", name: "Box 10" },
    { id: "b2", name: "Box 2" },
    { id: "empty", name: "Box 1" },
    { id: "y", name: "2026 Baseball" },
  ];

  it("orders boxes naturally by name, Unsorted last", () => {
    expect([...boxes].sort(compareBoxes).map((b) => b.name)).toEqual(["2026 Baseball", "Box 1", "Box 2", "Box 10", "Unsorted"]);
  });

  it("skips empty boxes, files a line with no box under Unsorted and leaves out lines with no card", () => {
    const stops = boxWalk(
      [
        line(card({ number: "1" }), { spot: { boxId: "b10" } }),
        line(card({ number: "2" }), { spot: { boxId: "b2" } }),
        line(card({ number: "3" })),
        line(card({ number: "4" }), { spot: { boxId: "gone" } }),
        line(null, { listingTitle: "x" }),
      ],
      boxes,
    );
    expect(stops.map((s) => s.box.name)).toEqual(["Box 2", "Box 10", "Unsorted"]);
    expect(numbers(stops[2].rows)).toEqual(["3", "4"]);
  });

  it("walks a box in slot order when it has slots, else the default order", () => {
    const [stop] = boxWalk(
      [
        line(card({ number: "1" }), { spot: { boxId: "b2", slot: 9 } }),
        line(card({ number: "2" }), { spot: { boxId: "b2" } }),
        line(card({ number: "3" }), { spot: { boxId: "b2", slot: 2 } }),
      ],
      boxes,
    );
    expect(numbers(stop.rows)).toEqual(["3", "1", "2"]);
  });

  it("keeps the same card in two boxes as two rows", () => {
    const c = card({ number: "1" });
    const stops = boxWalk([line(c, { spot: { boxId: "b2" } }), line(c, { spot: { boxId: "b10" } })], boxes);
    expect(stops.map((s) => s.rows.length)).toEqual([1, 1]);
  });

  it("ends the walk on Can't find it, after every box, holding the sales with no card", () => {
    const stops = boxStops(
      [line(null, { listingTitle: "mystery lot" }), line(card({ number: "1" }), { spot: { boxId: "b2" } })],
      boxes,
    );
    expect(stops.map((s) => [s.box.id, Boolean(s.cantFind)])).toEqual([
      ["b2", false],
      [CANT_FIND_STOP, true],
    ]);
    expect(stops[1].rows.map((r) => r.listingTitle)).toEqual(["mystery lot"]);
  });

  it("adds no Can't find it stop when every sale has a card", () => {
    const stops = boxStops([line(card({ number: "1" }), { spot: { boxId: "b2" } })], boxes);
    expect(stops.some((s) => s.cantFind)).toBe(false);
  });
});

describe("divider colours", () => {
  it("key on NB's sport code, never the name; anything else is the black divider", () => {
    expect(["BB", "fb", "BK", "HK", null, "SO"].map(sportHue)).toEqual(["baseball", "football", "basketball", "hockey", "other", "other"]);
  });
});

describe("the demo fixture", () => {
  it("covers what the demo is meant to show", () => {
    const rows = mergeLines(DEMO_PICK_LINES);
    expect(DEMO_PICK_LINES.length).toBeGreaterThanOrEqual(25);
    expect(rows.some((r) => r.orders.length === 2 && r.quantity === 2)).toBe(true);
    expect(rows.some((r) => r.lastOnes)).toBe(true);
    expect(rows.some((r) => r.short === 1)).toBe(true);
    expect(rows.filter((r) => !r.card).length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => r.isNew)).toBe(true);
    expect(rows.filter((r) => r.grade).length).toBeGreaterThanOrEqual(2);
    expect(rows.filter((r) => r.serial).length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.card && variantRole(r.card)))).toEqual(new Set(["base", "parallel", "insert", "insertParallel", null]));
    expect(new Set(DEMO_PICK_LINES.map((l) => sportHue(l.sportCode)))).toEqual(new Set(["baseball", "football", "basketball", "hockey", "other"]));
    const stops = boxWalk(DEMO_PICK_LINES, DEMO_PICK_BOXES);
    expect(stops.map((s) => s.box.name)).toEqual(["2026 Baseball", "Box 2", "Box 10", "Slabs", "Unsorted"]);
  });
});
