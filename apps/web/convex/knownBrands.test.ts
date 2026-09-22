/**
 * NEO-294 — the known-brands list and its matcher.
 *
 * Four jobs, in order of how much they would cost to get wrong:
 *
 *   0. EVERY ENTRY IS A LEGAL SELECTOR VALUE. `ensureBrandRowForName` writes
 *      these names without running `checkCustomSelectorValue`, so this file
 *      is the only place a bad entry is caught before a backfill hits it.
 *   1. THE INVARIANT. No entry may word-boundary-prefix another, because the
 *      whole of `matchKnownBrand`'s "exactly one answer" rests on it. Checked
 *      over the entire list rather than by eye, so a future one-line PR that
 *      adds "Grand" beside "Grand Slam" fails here and says why.
 *   2. EVERY ENTRY CLAIMS ITS EXAMPLE. One representative set name per brand,
 *      all 39, so an entry can never be quietly mis-spelled into claiming
 *      nothing — a list that files no sets is the failure mode this ticket
 *      exists to avoid, and it is invisible without this table.
 *   3. THE DELIBERATE REJECTIONS STAY REJECTED. `MVP` (the product-line
 *      trap), `Philadelphia` (a city), `Historic Limited Editions` (a
 *      singular/plural pair), `Starline` (the word-boundary rule) and a
 *      typographic apostrophe all claim NOTHING, and each of those is a
 *      decision someone will be tempted to undo.
 */

import { describe, expect, test } from "vitest";
import { KNOWN_BRANDS, matchKnownBrand } from "./knownBrands";
import {
  checkCustomSelectorValue,
  matchesBrandPrefix,
  selectorValueKey,
} from "./selectorSyncMatch";

// ───────────────────────────────────────────────────────────────────────────
// The list itself
// ───────────────────────────────────────────────────────────────────────────

describe("KNOWN_BRANDS", () => {
  test("holds the 39 entries Jason approved", () => {
    expect(KNOWN_BRANDS).toHaveLength(39);
  });

  test("no entry appears twice, under the fold the matcher uses", () => {
    const keys = KNOWN_BRANDS.map(selectorValueKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("is sorted by folded name, so the diff of an addition is one line", () => {
    const keys = KNOWN_BRANDS.map(selectorValueKey);
    expect(keys).toEqual([...keys].sort());
  });

  test("every entry is trimmed and non-empty (an empty prefix matches nothing)", () => {
    for (const brand of KNOWN_BRANDS) {
      expect(brand).toBe(brand.trim());
      expect(brand.length).toBeGreaterThan(0);
    }
  });

  /**
   * EVERY ENTRY MUST SURVIVE THE DOOR IT GOES THROUGH. The `ensureBrandRow`
   * mutation checks each name with `checkCustomSelectorValue` before writing
   * it, but `ensureBrandRowForName` — the helper `backfillKnownBrands` calls
   * DIRECTLY, with no mutation wrapper — does not. So an entry that check
   * would refuse (a zero-width character, an over-long name, whitespace
   * only) reaches the database down one path and throws down the other, and
   * neither failure names this file. Assert it here, over the whole list, on
   * the same function the sync's door uses.
   */
  test("every entry passes checkCustomSelectorValue at manufacturer level", () => {
    const refused = KNOWN_BRANDS.filter(
      (brand) => !checkCustomSelectorValue("manufacturer", brand).ok,
    );
    expect(refused).toEqual([]);
  });

  /**
   * THE INVARIANT. If A word-boundary-prefixes B then a set name matching B
   * matches A too, and which brand claims it would depend on the order of an
   * array — two syncs could disagree. Ship `ONIT Athlete`, never `ONIT`.
   */
  test("NO ENTRY PREFIXES ANOTHER under matchesBrandPrefix", () => {
    const offenders: string[] = [];
    for (const a of KNOWN_BRANDS) {
      for (const b of KNOWN_BRANDS) {
        if (a === b) continue;
        if (matchesBrandPrefix(b, a)) offenders.push(`"${a}" prefixes "${b}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Every entry claims a real-shaped set name
// ───────────────────────────────────────────────────────────────────────────

/**
 * One example per entry, in the shape the sets under Unknown actually take
 * (brand + team / product / year). The point is coverage of the LIST, not of
 * the matcher — `matchesBrandPrefix` has its own tests in
 * selectorBrandRouting.test.ts.
 */
const EXAMPLES: Array<[brand: string, setName: string]> = [
  ["Bandai", "Bandai Carddass Dragon Ball"],
  ["Barry Colla", "Barry Colla Postcards"],
  ["BBM", "BBM Nippon Professional Baseball"],
  ["Best", "Best Charleston RiverDogs"],
  ["Boxscores", "Boxscores Team Set"],
  ["Calbee", "Calbee Baseball"],
  ["Choice", "Choice Biloxi Shuckers"],
  ["CMC", "CMC Triple A All-Stars"],
  ["Diamond Cards", "Diamond Cards Memphis Chicks"],
  ["Eclipse", "Eclipse Baseball Legends"],
  ["Epoch", "Epoch Pacific League"],
  ["Futera", "Futera World Football"],
  ["Grand Slam", "Grand Slam Winston-Salem Spirits"],
  ["Historic Autographs", "Historic Autographs Originals"],
  ["Juco World Series", "Juco World Series Program"],
  ["Kahn's", "Kahn's Cincinnati Reds"],
  ["Kenner", "Kenner Starting Lineup"],
  ["Leaf", "Leaf Limited"],
  ["Little Sun", "Little Sun High School Prospects"],
  ["Mother's Cookies", "Mother's Cookies San Francisco Giants"],
  ["MSA", "MSA Disc"],
  ["ONIT Athlete", "ONIT Athlete Wisconsin Badgers"],
  ["Onyx", "Onyx Vintage"],
  ["Perez-Steele", "Perez-Steele Hall of Fame Postcards"],
  ["Post", "Post Cereal"],
  ["Pro Set", "Pro Set Platinum"],
  ["ProCards", "ProCards Tulsa Drillers"],
  ["Pucko", "Pucko Swedish Elite League"],
  ["Pulse", "Pulse Trading Cards"],
  ["SCC", "SCC Minor League"],
  ["Sisson Printing", "Sisson Printing Erie Sailors"],
  ["Sport Pro", "Sport Pro Toledo Mud Hens"],
  ["Sportflics", "Sportflics Rookies"],
  ["SportsPrint", "SportsPrint Jackson Mets"],
  ["Star", "Star Michael Jordan"],
  ["Swell", "Swell Baseball Greats"],
  ["Takara", "Takara Nippon Ham Fighters"],
  ["Wild Card", "Wild Card Draft Picks"],
  ["WTHBALLS", "WTHBALLS 1960s Style"],
];

describe("matchKnownBrand claims a set for every entry", () => {
  test("the example table covers the whole list, once each", () => {
    expect(EXAMPLES.map(([brand]) => brand).sort()).toEqual(
      [...KNOWN_BRANDS].sort(),
    );
  });

  test.each(EXAMPLES)("%s claims %s", (brand, setName) => {
    expect(matchKnownBrand(setName)).toBe(brand);
  });

  test("a set named exactly after its brand is claimed by it", () => {
    expect(matchKnownBrand("Leaf")).toBe("Leaf");
  });

  test("case and surrounding whitespace do not matter", () => {
    expect(matchKnownBrand("  choice BILOXI shuckers ")).toBe("Choice");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The deliberate rejections
// ───────────────────────────────────────────────────────────────────────────

describe("matchKnownBrand claims nothing it was told not to", () => {
  test("MVP — a product line of a brand NB already has, not a brand", () => {
    // A bare MVP set is Upper Deck MVP. Filing it under an "MVP" brand would
    // take it away from the brand it belongs to.
    expect(matchKnownBrand("MVP")).toBeUndefined();
    expect(matchKnownBrand("MVP Gold Script")).toBeUndefined();
  });

  test("Philadelphia — a city, like every other city and team", () => {
    expect(matchKnownBrand("Philadelphia Phillies Team Issue")).toBeUndefined();
  });

  test("Historic Limited Editions — a singular/plural pair, both rejected", () => {
    // `Historic Autographs` is on the list; `Historic` is not, precisely so
    // this name is not swept in with it.
    expect(matchKnownBrand("Historic Limited Editions")).toBeUndefined();
    expect(matchKnownBrand("Historic Limited Edition")).toBeUndefined();
  });

  test("Star does not claim Starline — the word boundary is the whole rule", () => {
    expect(matchKnownBrand("Starline Prospects")).toBeUndefined();
    expect(matchKnownBrand("Starting Lineup")).toBeUndefined();
  });

  test("Grand does not exist, so Grandstand is not swept up with Grand Slam", () => {
    expect(matchKnownBrand("Grandstand Fresno Grizzlies")).toBeUndefined();
  });

  test("ONIT alone claims nothing — the entry is ONIT Athlete", () => {
    expect(matchKnownBrand("ONIT")).toBeUndefined();
    expect(matchKnownBrand("ONIT Promo")).toBeUndefined();
  });

  test("a TYPOGRAPHIC apostrophe fails safe back to Unknown", () => {
    // `selectorValueKey` folds case and trims and nothing else, on purpose.
    // The fix for this is a second entry, NEVER a wider fold: that fold is
    // shared with the sibling-clash check, where widening it merges rows
    // that are apart by design.
    expect(matchKnownBrand("Mother’s Cookies Astros")).toBeUndefined();
    expect(matchKnownBrand("Kahn’s Reds")).toBeUndefined();
    // The ASCII spelling still works, so the list is not broken — only that
    // one upstream spelling stays in Unknown.
    expect(matchKnownBrand("Mother's Cookies Astros")).toBe("Mother's Cookies");
  });

  test("a decorated lookalike is not the word", () => {
    expect(matchKnownBrand("St☆r Rookies")).toBeUndefined();
  });

  test("an empty or whitespace-only name claims nothing", () => {
    expect(matchKnownBrand("")).toBeUndefined();
    expect(matchKnownBrand("   ")).toBeUndefined();
  });

  test("an ordinary big-manufacturer set is left to its own brand", () => {
    expect(matchKnownBrand("Topps Chrome")).toBeUndefined();
    expect(matchKnownBrand("Upper Deck SP Authentic")).toBeUndefined();
  });
});
