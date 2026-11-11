/**
 * NEO-464 — the public demo's sample cards, added to its fake catalog and its
 * fake collector at load. Import it (for its effect) at the top of each demo
 * entry, before anything reads the catalog or seeds the demo store:
 *
 *   import "@/app/collection/final/data/sample";
 *
 * It is what makes the demo collector's story whole:
 * - the 1989 Score Football base set, all 330, in its own binder ("'89
 *   Score"), finished today (Barry Sanders #257 was the last card);
 * - real Reggie White cards across his career, for "All Reggie White";
 * - more cards for sale in the Show box, priced, over five sets.
 *
 * Signed-in pages never import it, so its checklists never reach their
 * chunks. Sample data from published checklists (see each file), not NB data.
 */

import {
  binders,
  cards,
  extendCatalog,
  myCopies,
  refreshDataIndexes,
  type Brand,
  type Card,
  type CardId,
  type Copy,
  type CopyDetails,
  type SetId,
  type Team,
} from "@/app/collection/prototypes/_shared/data";
import { REGGIE_WHITE_SETS } from "./reggie-white";
import { SCORE_1989_FOOTBALL, SCORE_1989_FOOTBALL_ID } from "./score-1989-football";

export { SCORE_1989_FOOTBALL_ID } from "./score-1989-football";

/** The binder the finished 1989 Score set lives in, in number order. */
export const SCORE_1989_BINDER_ID = "binder-89-score";

/** The card that finished the 1989 Score set, today. */
export const SCORE_1989_LAST_CARD = "257";

/** Today's 1989 Score pulls, the last card first: the four that finished the set. */
export const SCORE_1989_TODAY = ["257", "270", "246", "92"];

/** The 1989 teams the catalog does not hold yet (its Rams are St. Louis, its Cardinals Arizona). Real colours of the day. */
const TEAMS: Team[] = [
  { id: "raiders-la", location: "Los Angeles", name: "Raiders", league: "NFL", primary: "#000000", secondary: "#A5ACAF" },
  { id: "rams-la", location: "Los Angeles", name: "Rams", league: "NFL", primary: "#003594", secondary: "#FFD100" },
  { id: "oilers", location: "Houston", name: "Oilers", league: "NFL", primary: "#4B92DB", secondary: "#C8102E" },
  { id: "cardinals-phx", location: "Phoenix", name: "Cardinals", league: "NFL", primary: "#97233F", secondary: "#000000" },
  { id: "redskins", location: "Washington", name: "Redskins", league: "NFL", primary: "#5A1414", secondary: "#FFB612" },
  { id: "chargers-sd", location: "San Diego", name: "Chargers", league: "NFL", primary: "#002A5E", secondary: "#FFC20E" },
  { id: "saints", location: "New Orleans", name: "Saints", league: "NFL", primary: "#D3BC8D", secondary: "#101820" },
];

const BRANDS: Brand[] = [
  { id: "brand-pro-set", name: "Pro Set" },
  { id: "brand-fleer", name: "Fleer" },
];

/** The one regular (no variation) base card at (set, number). Throws unless exactly one. */
function baseCard(setId: SetId, cardNumber: string): CardId {
  const matches = cards.filter(
    (c: Card) => c.setId === setId && c.variantPath.type === "Base" && c.cardNumber === cardNumber && c.variation === null,
  );
  if (matches.length !== 1) throw new Error(`demo sample: ${setId} #${cardNumber} matched ${matches.length} cards`);
  return matches[0].id;
}

/** Deterministic acquisition dates, spread over 2025, by index. */
function dayIn2025(index: number): string {
  return new Date(Date.UTC(2025, 0, 4) + ((index * 7) % 330) * 86_400_000).toISOString().slice(0, 10);
}

function own(id: string, cardId: CardId, details: Partial<CopyDetails>): void {
  myCopies.push({
    id,
    cardId,
    quantity: 1,
    acquiredAt: "2025-06-01",
    binderIds: [],
    notes: "",
    forSale: false,
    ...details,
  } satisfies Copy);
}

let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  extendCatalog({ teams: TEAMS, brands: BRANDS, sets: [SCORE_1989_FOOTBALL, ...REGGIE_WHITE_SETS] });
  refreshDataIndexes();

  // --- 1989 Score: every card, in its binder, in number order --------------
  binders.push({
    id: SCORE_1989_BINDER_ID,
    kind: "manual",
    name: "'89 Score",
    description: "The whole 1989 Score set, 1 to 330.",
  });
  const today = new Set(SCORE_1989_TODAY);
  for (let n = 1; n <= 330; n++) {
    own(`copy-s89-${String(n).padStart(3, "0")}`, baseCard(SCORE_1989_FOOTBALL_ID, String(n)), {
      condition: "Near Mint",
      location: "Binder shelf",
      binderIds: [SCORE_1989_BINDER_ID],
      acquiredAt: today.has(String(n)) ? "2026-11-08" : dayIn2025(n),
      ...(n === 257 ? { costBasis: 18 } : n === 270 ? { costBasis: 14 } : {}),
    });
  }

  // --- Reggie White, across his career (Main; the rookie in the Slab case) --
  REGGIE_WHITE_SETS.forEach((def, i) => {
    const [number] = def.base[0];
    const rookie = def.set.year === 1986;
    own(`copy-rw-${String(i + 1).padStart(2, "0")}`, baseCard(def.set.id, String(number)), {
      ...(rookie
        ? { graded: { grader: "PSA", grade: "8", cert: "51077342" }, costBasis: 60, binderIds: ["binder-slab-case"] }
        : { condition: "Near Mint", costBasis: 1 }),
      acquiredAt: dayIn2025(40 + i * 3),
      location: rookie ? "Slab case" : "Binder shelf",
    });
  });

  // --- For sale in the Show box: priced dupes over five sets ---------------
  // (With the seed's Yzerman stack, Score Artist's Proof and Skenes auto.)
  const forSale = (id: string, cardId: CardId, minPrice: number | undefined, details: Partial<CopyDetails> = {}) =>
    own(id, cardId, {
      condition: "Near Mint",
      location: "Show box",
      forSale: true,
      acquiredAt: "2026-11-09",
      ...details,
      ...(minPrice === undefined ? {} : { minPrice }),
    });
  forSale("copy-box-01", baseCard(SCORE_1989_FOOTBALL_ID, "270"), 12, { notes: "Dupe from the set build." });
  forSale("copy-box-02", baseCard(SCORE_1989_FOOTBALL_ID, "257"), 15, { notes: "Dupe from the set build." });
  forSale("copy-box-03", baseCard(SCORE_1989_FOOTBALL_ID, "211"), 4, { quantity: 2 });
  forSale("copy-box-04", baseCard("1993-finest-baseball", "2"), 8);
  // No price yet: the sync holds it back until it has one.
  forSale("copy-box-05", baseCard("1993-finest-baseball", "5"), undefined, { condition: "Excellent", acquiredAt: "2026-11-10" });
}

load();
