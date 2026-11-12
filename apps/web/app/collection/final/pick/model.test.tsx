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
  compareDefault,
  copiesLeft,
  filterRows,
  isPulled,
  listedTitle,
  listedVariant,
  mergeLines,
  naturalCompare,
  NOT_IN_BOX_STOP,
  rowFacts,
  setSections,
  sortRows,
  variantRole,
  type PickRow,
} from "./model";
import type { ListedCard, PickBox, PickOrder, SaleLine } from "./types";

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

describe("NEO-509: a sale filed by its listing's words", () => {
  const listed = (over: Partial<ListedCard> = {}): ListedCard => ({
    sportName: "Baseball",
    year: 2026,
    season: "2026",
    setName: "Topps",
    players: "Listed Player",
    cardNumber: "5",
    role: "base",
    ...over,
  });
  const stray = (l: ListedCard | undefined, extra: Partial<SaleLine> = {}) =>
    line(null, { order: BSC_1, listingTitle: "a listing", sportCode: null, ...(l ? { listed: l } : {}), ...extra });

  it("joins the one NB set with its sport, year and name, between that set's numbers", () => {
    const s = buildSections(
      [line(card({ number: "3" })), line(card({ number: "9" })), stray(listed({ setName: "2026 TOPPS" }))],
      {},
      { sort: null, dir: "asc", groupByOrder: false },
    );
    expect(s.map((x) => x.kind)).toEqual(["set"]);
    expect(s[0].rows.map((r) => rowFacts(r)?.cardNumber)).toEqual(["3", "5", "9"]);
    expect(s[0].rows[1].card).toBeNull();
    // It wears the set's colour.
    expect(s[0].rows[1].sportCode).toBe("BB");
  });

  it("gets its own divider, after NB's of the same name, when no single NB set fits", () => {
    const two = [
      line(card({ number: "1", setId: "a" })),
      line(card({ number: "2", setId: "b" })),
      stray(listed()),
    ];
    const s = buildSections(two, {}, { sort: null, dir: "asc", groupByOrder: false });
    expect(s.map((x) => (x.kind === "set" ? x.title : x.kind))).toEqual(["2026 Topps", "2026 Topps", "2026 Topps"]);
    expect(s[2].rows[0].card).toBeNull();
    // Its heading reads apart from NB's two of the same text (an sr-only word); NB's never do.
    expect(s.map((x) => (x.kind === "set" ? Boolean(x.unmatchedTwin) : null))).toEqual([false, false, true]);
    const other = buildSections([line(card({ number: "1" })), stray(listed({ setName: "Bowman" }))], {}, {
      sort: null,
      dir: "asc",
      groupByOrder: false,
    });
    expect(other.map((x) => (x.kind === "set" ? x.title : x.kind))).toEqual(["2026 Bowman", "2026 Topps"]);
    // A title no NB divider shares needs no word.
    expect(other.some((x) => x.kind === "set" && x.unmatchedTwin)).toBe(false);
  });

  it("wears NB's sport colour on its own divider when the store resolved its sport, and black only when it did not", () => {
    const resolved = buildSections([stray(listed({ sportId: "sp-bb", sportCode: "BB", setName: "Bowman" }))], {}, {
      sort: null,
      dir: "asc",
      groupByOrder: false,
    });
    expect(resolved[0].kind === "set" && resolved[0].sportCode).toBe("BB");
    expect(sportHue(resolved[0].kind === "set" ? resolved[0].sportCode : null)).toBe("baseball");
    // A listing-only sport word is never matched to NB's colour by its name.
    const word = buildSections([stray(listed({ setName: "Bowman" }))], {}, { sort: null, dir: "asc", groupByOrder: false });
    expect(sportHue(word[0].kind === "set" ? word[0].sportCode : null)).toBe("other");
  });

  it("keeps every variant word the listing gives, and shows a role only when its word is one", () => {
    const facts = (l: ListedCard) => rowFacts(mergeLines([stray(l)])[0]);
    // Base said Base: the Base chip, and a name it gives kept.
    expect(facts(listed({ role: "base", variantName: "Photo Variation" }))).toMatchObject({
      role: "base",
      variantWord: null,
      variantName: "Photo Variation",
    });
    // A word NB does not file by: shown as that word, never read as Base.
    expect(facts(listed({ role: undefined, variantWord: "Variation" }))).toMatchObject({ role: null, variantWord: "Variation", variantName: null });
    // With a name too: both, still no role.
    expect(facts(listed({ role: undefined, variantWord: "SP", variantName: "Image" }))).toMatchObject({ role: null, variantWord: "SP", variantName: "Image" });
    // No variant named: no role at all (no "base" default).
    expect(facts(listed({ role: undefined }))).toMatchObject({ role: null, variantWord: null, variantName: null });
    // A name that only repeats the role or the word is not written twice.
    expect(listedVariant(listed({ role: "base", variantName: "Base" }))).toEqual({ word: null, name: null });
    expect(listedVariant(listed({ role: "insert", variantName: "Inserts" }))).toEqual({ word: null, name: null });
    expect(listedVariant(listed({ role: undefined, variantWord: "Promo", variantName: "promo" }))).toEqual({ word: "Promo", name: null });
  });

  it("walks a row with no role after Base and before the parallels and inserts", () => {
    const s = buildSections(
      [
        stray(listed({ cardNumber: "1", role: "insert", variantName: "Throwback" })),
        stray(listed({ cardNumber: "1", role: "parallel", variantName: "Gold" })),
        stray(listed({ cardNumber: "1", role: undefined, variantWord: "Variation" })),
        stray(listed({ cardNumber: "1", role: undefined })),
        stray(listed({ cardNumber: "1", role: "base" })),
      ],
      {},
      { sort: null, dir: "asc", groupByOrder: false },
    );
    expect(s[0].rows.map((r) => [rowFacts(r)?.role, rowFacts(r)?.variantWord ?? rowFacts(r)?.variantName ?? null])).toEqual([
      ["base", null],
      [null, null],
      [null, "Variation"],
      ["parallel", "Gold"],
      ["insert", "Throwback"],
    ]);
  });

  it("titles a listing as a seller finds it in a box: set, insert or parallel, number, then players", () => {
    expect(
      listedTitle({ season: "2021", year: 2021, setName: "Score", players: "Justin Fields", cardNumber: "TB2", role: "insert", variantName: "1991 Throwback" }),
    ).toBe("2021 Score 1991 Throwback #TB2 · Justin Fields");
    // Base is not written, and a "Base" name never writes "Base" either.
    expect(listedTitle({ season: "2024", setName: "Score", players: "Malik Nabers", cardNumber: "302", role: "base", variantName: "Base" })).toBe(
      "2024 Score #302 · Malik Nabers",
    );
    // A word NB does not file by is written; a name that already holds it is written once.
    expect(listedTitle({ season: "2024", setName: "Score", cardNumber: "302", variantWord: "Variation" })).toBe("2024 Score Variation #302");
    expect(listedTitle({ season: "2024", setName: "Score", cardNumber: "302", variantWord: "Variation", variantName: "Photo Variation" })).toBe(
      "2024 Score Photo Variation #302",
    );
    expect(listedTitle({ season: "2024", setName: "Score", cardNumber: "302", variantWord: "SP", variantName: "Photo" })).toBe("2024 Score SP Photo #302");
    // An Insert with no name says Insert; a set already led by its season is not doubled.
    expect(listedTitle({ season: "2024", setName: "2024 Topps Chrome", cardNumber: "9", role: "insert" })).toBe("2024 Topps Chrome Insert #9");
    // Only players: just the players. Nothing: empty.
    expect(listedTitle({ players: "Someone" })).toBe("Someone");
    expect(listedTitle({})).toBe("");
  });

  it("stays in Can't find it when it says too little; By the Box walks the described ones as Not in a box, by set, before Can't find it", () => {
    const lines = [
      line(card({ number: "1" }), { spot: { boxId: "b1" } }),
      stray(listed({ cardNumber: undefined })),
      stray(listed({ year: undefined })),
      stray(listed()),
    ];
    const s = buildSections(lines, {}, { sort: null, dir: "asc", groupByOrder: false });
    expect(s.map((x) => [x.kind, x.rows.length])).toEqual([
      ["cantFind", 2],
      ["set", 2],
    ]);
    const stops = boxStops(lines, [{ id: "b1", name: "Box 1" }]);
    expect(stops.map((x) => [x.box.id, x.box.name, x.rows.length])).toEqual([
      ["b1", "Box 1", 1],
      [NOT_IN_BOX_STOP, "Not in a box", 1],
      [CANT_FIND_STOP, "Can't find it", 2],
    ]);
    expect(stops[1].notInBox).toBe(true);
    expect(stops[2].cantFind).toBe(true);
    // Not in a box keeps the list's walking order and its set dividers (joined to NB's set here).
    expect(setSections(stops[1].rows).map((x) => x.title)).toEqual(["2026 Topps"]);
    // Only described sales: none of the stops comes up empty.
    expect(boxStops([stray(listed())], []).map((x) => x.box.id)).toEqual([NOT_IN_BOX_STOP]);
    expect(boxStops([stray(undefined)], []).map((x) => x.box.id)).toEqual([CANT_FIND_STOP]);
  });

  it("walks Not in a box by set across several sets, in the list's order", () => {
    const lines = [
      line(card({ number: "1" }), { spot: { boxId: "b1" } }),
      stray(listed({ setName: "Bowman", cardNumber: "7" })),
      stray(listed({ cardNumber: "9" })),
      stray(listed({ setName: "Bowman", cardNumber: "2" })),
    ];
    const notInBox = boxStops(lines, [{ id: "b1", name: "Box 1" }]).find((x) => x.notInBox)!;
    expect(setSections(notInBox.rows).map((x) => [x.title, x.rows.map((r) => rowFacts(r)?.cardNumber)])).toEqual([
      ["2026 Bowman", ["2", "7"]],
      ["2026 Topps", ["9"]],
    ]);
  });

  it("filters and finds by its facts", () => {
    const rows = mergeLines([line(card({ number: "1" })), stray(listed({ role: "insert", variantName: "1991 Throwback" }))]);
    expect(filterRows(rows, { variant: "insert" })).toHaveLength(1);
    expect(filterRows(rows, { text: "throwback" })).toHaveLength(1);
    expect(filterRows(rows, { text: "not in nb" })).toHaveLength(1);
    expect(filterRows(rows, { text: "unmatched" })).toHaveLength(0);
    expect(filterRows(rows, { sport: "baseball", year: "2026" })).toHaveLength(2);
    // Only not in NB: every sale NB has no card for, described or not.
    const withStray = mergeLines([line(card({ number: "1" })), stray(listed()), stray(undefined)]);
    expect(filterRows(withStray, { notInNb: true }).map((r) => r.card)).toEqual([null, null]);
    // Its own variant word finds it.
    expect(filterRows(mergeLines([stray(listed({ role: undefined, variantWord: "Variation" }))]), { text: "variation" })).toHaveLength(1);
  });

  it("sorts transitively over any mix of cards, joined, own-divider and undescribed sales", () => {
    const rows = mergeLines([
      line(card({ number: "3" })),
      line(card({ number: "4", setId: "s2", setName: "Bowman" })),
      line(card({ number: "4", setId: "s3", setName: "Bowman" })),
      line(card({ number: "1", sport: "Football", season: "2024" })),
      stray(listed({ cardNumber: "2" })),
      stray(listed({ setName: "Bowman", cardNumber: "1" })),
      stray(listed({ setName: "Chrome", cardNumber: "1", role: "parallel", variantName: "Gold" })),
      stray(listed({ setName: "Chrome", cardNumber: "1", role: undefined, variantWord: "SP" })),
      stray(listed({ setName: "Chrome", cardNumber: "1", role: undefined })),
      stray(listed({ setName: "Chrome", cardNumber: "1", role: "base", variantName: "Photo" })),
      stray(listed({ sportName: "football", year: 2024, setName: "Topps", cardNumber: "0" })),
      stray(listed({ sportName: "Hockey", year: 2023, season: "2023-24", setName: "Upper Deck", cardNumber: "9" })),
      stray(undefined),
      stray(listed({ setName: undefined })),
    ]);
    const sign = (x: number) => Math.sign(x);
    for (const a of rows) {
      expect(compareDefault(a, a)).toBe(0);
      for (const b of rows) {
        expect(sign(compareDefault(a, b)) + sign(compareDefault(b, a))).toBe(0);
        for (const c of rows) {
          if (compareDefault(a, b) <= 0 && compareDefault(b, c) <= 0) expect(compareDefault(a, c)).toBeLessThanOrEqual(0);
        }
      }
    }
  });
});
