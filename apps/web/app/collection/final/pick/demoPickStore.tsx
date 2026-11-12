import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { Card, CardFeature, Finish, VariantKind } from "../data/types";
import { PickListStoreContext } from "./store";
import type { PickBox, PickListData, PickListStore, PickOrder, SaleLine } from "./types";

/**
 * NEO-500 — the public demo's Pick List: a hard-coded stack of open orders,
 * never Convex or Clerk. Pulled marks live in memory only (a refresh or a
 * tab change starts the pull over).
 *
 * Like the rest of the demo's catalog (`prototypes/_shared/catalog.ts`):
 * real players on their real teams in their real colours, on made-up
 * checklist lines. No marketplace is named beyond the two order labels a
 * seller sees on their own orders.
 */

// ---------------------------------------------------------------------------
// The catalog bits the lines need
// ---------------------------------------------------------------------------

interface SportDef {
  id: string;
  name: string;
  /** NB's own sport code (the sport row's SKU code); null for a sport with none. */
  code: string | null;
}

const BASEBALL: SportDef = { id: "baseball", name: "Baseball", code: "BB" };
const FOOTBALL: SportDef = { id: "football", name: "Football", code: "FB" };
const BASKETBALL: SportDef = { id: "basketball", name: "Basketball", code: "BK" };
const HOCKEY: SportDef = { id: "hockey", name: "Hockey", code: "HK" };
const NON_SPORT: SportDef = { id: "non-sport", name: "Non-Sport", code: null };

interface SetDef {
  id: string;
  sport: SportDef;
  season: string;
  year: number;
  brand: string;
  name: string;
}

const set = (id: string, sport: SportDef, season: string, brand: string, name: string): SetDef => ({
  id,
  sport,
  season,
  year: Number.parseInt(season, 10),
  brand,
  name,
});

const S26_TOPPS_BB = set("26-topps-bb", BASEBALL, "2026", "Topps", "Topps Series 1");
const S22_HERITAGE = set("22-heritage", BASEBALL, "2022", "Topps", "Topps Heritage");
const S21_GYPSY = set("21-gypsy", BASEBALL, "2021", "Topps", "Topps Gypsy Queen");
const S21_AG_CHROME = set("21-ag-chrome", BASEBALL, "2021", "Topps", "Topps Allen & Ginter Chrome");
const S18_UPDATE = set("18-update", BASEBALL, "2018", "Topps", "Topps Update");
const S26_TOPPS_FB = set("26-topps-fb", FOOTBALL, "2026", "Topps", "Topps");
const S24_SCORE = set("24-score", FOOTBALL, "2024", "Score", "Score");
const S23_BOWMAN_U = set("23-bowman-u", FOOTBALL, "2023", "Bowman", "Bowman University Chrome");
const S20_MOSAIC = set("20-mosaic", FOOTBALL, "2020", "Panini", "Panini Mosaic");
const S19_ELITE = set("19-elite", FOOTBALL, "2019", "Donruss", "Donruss Elite");
const S89_SCORE = set("89-score", FOOTBALL, "1989", "Score", "Score");
const S24_PRIZM = set("24-prizm", BASKETBALL, "2024-25", "Panini", "Panini Prizm");
const S25_CHROME_BK = set("25-chrome-bk", BASKETBALL, "2025-26", "Topps", "Topps Chrome");
const S23_UD = set("23-ud", HOCKEY, "2023-24", "Upper Deck", "Upper Deck Series 1");
const S24_GPK = set("24-gpk", NON_SPORT, "2024", "Topps", "Topps Garbage Pail Kids");

interface CardDef {
  set: SetDef;
  number: string;
  player: string;
  team?: { name: string; location: string; primary: string; secondary: string };
  kind?: VariantKind;
  variant?: string;
  insert?: string;
  printRun?: number;
  finish?: Finish;
  features?: CardFeature[];
}

const team = (location: string, name: string, primary: string, secondary: string) => ({ location, name, primary, secondary });

const PIRATES = team("Pittsburgh", "Pirates", "#27251F", "#FDB827");
const ANGELS = team("Los Angeles", "Angels", "#BA0021", "#003263");
const DODGERS = team("Los Angeles", "Dodgers", "#005A9C", "#EF3E42");
const YANKEES = team("New York", "Yankees", "#0C2340", "#C4CED3");
const WHITE_SOX = team("Chicago", "White Sox", "#27251F", "#C4CED4");
const GIANTS_SF = team("San Francisco", "Giants", "#FD5A1E", "#27251F");
const DOLPHINS = team("Miami", "Dolphins", "#008E97", "#FC4C02");
const GIANTS_NY = team("New York", "Giants", "#0B2265", "#A71930");
const TITANS = team("Tennessee", "Titans", "#0C2340", "#4B92DB");
const MICHIGAN = team("Michigan", "Wolverines", "#00274C", "#FFCB05");
const LIONS = team("Detroit", "Lions", "#0076B6", "#B0B7BC");
const BENGALS = team("Cincinnati", "Bengals", "#FB4F14", "#000000");
const VIKINGS = team("Minnesota", "Vikings", "#4F2683", "#FFC62F");
const SPURS = team("San Antonio", "Spurs", "#C4CED4", "#000000");
const MAVERICKS = team("Dallas", "Mavericks", "#00538C", "#B8C4CA");
const BLACKHAWKS = team("Chicago", "Blackhawks", "#CF0A2C", "#000000");
const AVALANCHE = team("Colorado", "Avalanche", "#6F263D", "#236192");

const STANDARD: Finish = { kind: "standard" };

function card(def: CardDef): Card {
  const kind = def.kind ?? "base";
  const variantName = kind === "base" ? null : (def.variant ?? null);
  const variantId = `${def.set.id}|${kind}|${def.insert ?? ""}|${variantName ?? ""}`;
  const id = `${variantId}|${def.number}`;
  return {
    id,
    set: {
      id: def.set.id,
      name: def.set.name,
      season: def.set.season,
      year: def.set.year,
      brand: { id: `brand-${def.set.brand}`, name: def.set.brand },
      sport: { id: def.set.sport.id, name: def.set.sport.name },
    },
    variant: {
      id: variantId,
      kind,
      name: variantName,
      insertName: def.insert ?? null,
      printRun: def.printRun ?? null,
      order: 0,
      path: { typeId: `${def.set.id}|${kind}`, variantId: variantName ? variantId : null, subVariantId: null },
      finish: def.finish ?? STANDARD,
    },
    cardNumber: def.number,
    players: [{ id: `player-${def.player}`, name: def.player }],
    teams: def.team ? [{ id: `team-${def.team.name}`, ...def.team }] : [],
    printRun: def.printRun ?? null,
    features: def.features ?? [],
    cardVariation: null,
    isVariation: false,
    sortOrder: 0,
    finish: def.finish ?? STANDARD,
  };
}

// ---------------------------------------------------------------------------
// Orders, boxes, lines
// ---------------------------------------------------------------------------

const order = (id: string, venue: string, number: string): PickOrder => ({ id, venue, number });

const O1 = order("o1", "eBay", "12-3456");
const O2 = order("o2", "eBay", "12-3471");
const O3 = order("o3", "eBay", "12-3502");
const O4 = order("o4", "BSC", "88213");
const O5 = order("o5", "BSC", "88240");
const O6 = order("o6", "eBay", "12-3519");
const O7 = order("o7", "BSC", "88257");
const O8 = order("o8", "eBay", "12-3533");

export const DEMO_PICK_BOXES: readonly PickBox[] = [
  { id: "box-unsorted", name: "Unsorted", unsorted: true },
  { id: "box-10", name: "Box 10" },
  { id: "box-slabs", name: "Slabs" },
  { id: "box-2", name: "Box 2" },
  { id: "box-3", name: "Box 3" }, // empty: By the Box skips it
  { id: "box-2026-bb", name: "2026 Baseball" },
];

const SKENES = card({ set: S26_TOPPS_BB, number: "150", player: "Paul Skenes", team: PIRATES });

let seq = 0;
function line(
  c: Card | null,
  sport: SportDef | null,
  o: PickOrder,
  extra: Partial<Omit<SaleLine, "id" | "card" | "sportCode" | "order">> = {},
): SaleLine {
  seq += 1;
  return {
    id: `demo-line-${seq}`,
    card: c,
    sportCode: sport?.code ?? null,
    listingTitle: extra.listingTitle ?? "",
    quantity: 1,
    condition: "NM",
    order: o,
    ...extra,
  };
}

const at = (boxId: string, slot?: number) => ({ spot: slot === undefined ? { boxId } : { boxId, slot } });

export const DEMO_PICK_LINES: readonly SaleLine[] = [
  // Baseball
  line(SKENES, BASEBALL, O4, at("box-2026-bb", 3)),
  line(SKENES, BASEBALL, O1, at("box-2026-bb", 3)),
  line(card({ set: S26_TOPPS_BB, number: "27", player: "Mike Trout", team: ANGELS }), BASEBALL, O4, at("box-2026-bb", 1)),
  line(
    card({ set: S26_TOPPS_BB, number: "8B-7", player: "Shohei Ohtani", team: DODGERS, kind: "insert", variant: "8 Bit Ballers" }),
    BASEBALL,
    O2,
    at("box-2026-bb", 12),
  ),
  line(
    card({
      set: S26_TOPPS_BB,
      number: "111",
      player: "Cam Schlittler",
      team: YANKEES,
      kind: "parallel",
      variant: "Gold Foil",
      printRun: 2026,
      finish: { kind: "gold" },
      features: ["RC"],
    }),
    BASEBALL,
    O6,
    { ...at("box-2026-bb", 9), serial: "1187/2026" },
  ),
  line(
    card({
      set: S26_TOPPS_BB,
      number: "8B-12",
      player: "Aaron Judge",
      team: YANKEES,
      kind: "parallel",
      insert: "8 Bit Ballers",
      variant: "Red",
      printRun: 5,
      finish: { kind: "foil", tint: "#E0242B" },
    }),
    BASEBALL,
    O5,
    { ...at("box-2026-bb", 14), serial: "4/5", lastOnes: true },
  ),
  line(card({ set: S22_HERITAGE, number: "239", player: "Brian Goodwin", team: WHITE_SOX }), BASEBALL, O3, at("box-2")),
  line(card({ set: S21_GYPSY, number: "209", player: "Mike Yastrzemski", team: GIANTS_SF }), BASEBALL, O3, {
    ...at("box-2"),
    condition: "EX",
  }),
  line(card({ set: S21_AG_CHROME, number: "227", player: "Jeff Garlin" }), BASEBALL, O6, at("box-10")),
  line(
    card({ set: S18_UPDATE, number: "US1", player: "Shohei Ohtani", team: ANGELS, features: ["RC"] }),
    BASEBALL,
    O7,
    { ...at("box-slabs", 2), grade: { grader: "PSA", grade: "10", cert: "61234567" }, condition: "Graded" },
  ),

  // Football
  line(card({ set: S26_TOPPS_FB, number: "324", player: "Chris Bell", team: DOLPHINS, features: ["RC"] }), FOOTBALL, O4, at("box-10")),
  line(card({ set: S26_TOPPS_FB, number: "330", player: "Malachi Fields", team: GIANTS_NY, features: ["RC"] }), FOOTBALL, O4, {
    ...at("box-10"),
    quantity: 2,
    short: 1,
  }),
  line(card({ set: S26_TOPPS_FB, number: "365", player: "Caleb Douglas", team: DOLPHINS, features: ["RC"] }), FOOTBALL, O4, {
    ...at("box-10"),
    lastOnes: true,
  }),
  line(
    card({ set: S24_SCORE, number: "7", player: "JC Latham", team: TITANS, kind: "insert", variant: "NFL Draft", features: ["RC"] }),
    FOOTBALL,
    O5,
    at("box-10"),
  ),
  line(
    card({
      set: S23_BOWMAN_U,
      number: "34",
      player: "Corey Kiner",
      team: MICHIGAN,
      kind: "parallel",
      variant: "Purple Mini-Diamond Refractor",
      printRun: 399,
      finish: { kind: "refractor", tint: "#7B3FC4" },
    }),
    FOOTBALL,
    O1,
    { ...at("box-10"), serial: "212/399" },
  ),
  line(
    card({ set: S20_MOSAIC, number: "BC-12", player: "Joe Burrow", team: BENGALS, kind: "insert", variant: "Blue Chips" }),
    FOOTBALL,
    O2,
    at("box-2"),
  ),
  line(
    card({ set: S20_MOSAIC, number: "BC-5", player: "Matthew Stafford", team: LIONS, kind: "insert", variant: "Blue Chips" }),
    FOOTBALL,
    O7,
    at("box-2"),
  ),
  line(
    card({
      set: S19_ELITE,
      number: "75",
      player: "Kirk Cousins",
      team: VIKINGS,
      kind: "parallel",
      variant: "Orange",
      printRun: 49,
      finish: { kind: "foil", tint: "#FF6A13" },
    }),
    FOOTBALL,
    O5,
    { ...at("box-2"), serial: "49/49" },
  ),
  line(card({ set: S89_SCORE, number: "257", player: "Barry Sanders", team: LIONS, features: ["RC"] }), FOOTBALL, O6, {
    ...at("box-slabs", 1),
    grade: { grader: "SGC", grade: "9.5", cert: "4021337" },
    condition: "Graded",
  }),

  // Basketball
  line(card({ set: S24_PRIZM, number: "136", player: "Victor Wembanyama", team: SPURS }), BASKETBALL, O1, at("box-2")),
  line(
    card({
      set: S24_PRIZM,
      number: "200",
      player: "Stephon Castle",
      team: SPURS,
      kind: "parallel",
      variant: "Silver",
      finish: { kind: "refractor", tint: "#C0C6CC" },
      features: ["RC"],
    }),
    BASKETBALL,
    O3,
    at("box-2"),
  ),

  // Hockey: a season files under its start year (2023-24 is 2023).
  line(card({ set: S23_UD, number: "201", player: "Connor Bedard", team: BLACKHAWKS, features: ["RC"] }), HOCKEY, O2, at("box-10")),
  line(
    card({ set: S23_UD, number: "C12", player: "Nathan MacKinnon", team: AVALANCHE, kind: "insert", variant: "Canvas" }),
    HOCKEY,
    O4,
    at("box-10"),
  ),

  // Non-Sport: no sport code, so the black divider.
  line(card({ set: S24_GPK, number: "1a", player: "Adam Bomb" }), NON_SPORT, O6),
  line(card({ set: S24_GPK, number: "KP-3", player: "Dead Ted", kind: "insert", variant: "Kids at Play" }), NON_SPORT, O6),

  // Can't find it: NB could not tie these to one card.
  line(null, null, O3, {
    listingTitle: "2026 Topps Heritage Clubhouse Collection Relic Bobby Witt Jr. #CCR-BW",
    problem: "NB has no 2026 Topps Heritage checklist yet.",
  }),
  line(null, null, O7, {
    listingTitle: "2025 Bowman Chrome Prospects #BCP-77 Auto",
    problem: "#BCP-77 fits two cards in that set. Check the photo.",
  }),

  // Sold after the pull began.
  line(
    card({ set: S25_CHROME_BK, number: "1", player: "Cooper Flagg", team: MAVERICKS, features: ["RC"] }),
    BASKETBALL,
    O8,
    { isNew: true },
  ),
];

export const DEMO_PICK_DATA: PickListData = { lines: DEMO_PICK_LINES, boxes: DEMO_PICK_BOXES };

/** The demo's store: the fixture, and pulled marks in memory. */
export function DemoPickListProvider({ children, data = DEMO_PICK_DATA }: { children: ReactNode; data?: PickListData }) {
  const [pulled, setPulledState] = useState<ReadonlySet<string>>(() => new Set());
  const setPulled = useCallback((ids: readonly string[], on: boolean) => {
    setPulledState((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const value = useMemo<PickListStore>(() => ({ kind: "demo", data, pulled, setPulled }), [data, pulled, setPulled]);
  return <PickListStoreContext.Provider value={value}>{children}</PickListStoreContext.Provider>;
}
