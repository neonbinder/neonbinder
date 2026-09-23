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
 *      all 53, so an entry can never be quietly mis-spelled into claiming
 *      nothing — a list that files no sets is the failure mode this ticket
 *      exists to avoid, and it is invisible without this table.
 *   3. THE DELIBERATE REJECTIONS STAY REJECTED. `MVP` (the product-line
 *      trap), `Collector's Choice` and `Select` (the same trap, where an
 *      entry would claim sets AWAY from Upper Deck and Panini),
 *      `Philadelphia` (a city), `Historic Limited Editions` (a
 *      singular/plural pair), `Pro Cards` (a spacing variant of the shipped
 *      `ProCards`), `Starline` (the word-boundary rule), `Other` (a
 *      marketplace bucket word) and a typographic apostrophe all claim
 *      NOTHING, and each of those is a decision someone will be tempted to
 *      undo.
 *
 * The bare-word guards are part of job 1 rather than a separate one: `Ted`,
 * `UNO`, `ONIT`, `Grand`, `Historic` and `Classic` are each the shorter
 * string someone will reach for, and each is asserted to claim nothing while
 * the longer entry beside it claims its sets.
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
  test("holds the 53 entries Jason approved", () => {
    // 39 from the baseball pass, + 10 certain and 4 probable from the
    // collector pass over the 266 sets still in Unknown after Football
    // 2025/1994 and Basketball 2026/2025/1994 were loaded.
    expect(KNOWN_BRANDS).toHaveLength(53);
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
  ["Action Packed", "Action Packed Rookie Update"],
  ["Bandai", "Bandai Carddass Dragon Ball"],
  ["Barry Colla", "Barry Colla Postcards"],
  ["BBM", "BBM Nippon Professional Baseball"],
  ["Best", "Best Charleston RiverDogs"],
  ["Bleachers", "Bleachers 23K Gold Emmitt Smith"],
  ["Boxscores", "Boxscores Team Set"],
  ["Calbee", "Calbee Baseball"],
  ["Champion's Deck", "Champion's Deck LSU Tigers"],
  ["Choice", "Choice Biloxi Shuckers"],
  ["CMC", "CMC Triple A All-Stars"],
  ["Collector's Edge", "Collector's Edge Rookies"],
  ["Collectors Edge", "Collectors Edge Supreme"],
  ["Diamond Cards", "Diamond Cards Memphis Chicks"],
  ["Eclipse", "Eclipse Baseball Legends"],
  ["Epoch", "Epoch Pacific League"],
  ["Flair", "Flair Wave of the Future"],
  ["Futera", "Futera World Football"],
  ["Grand Slam", "Grand Slam Winston-Salem Spirits"],
  ["Historic Autographs", "Historic Autographs Originals"],
  ["Hoops", "Hoops Draft Redemption"],
  ["JOGO", "JOGO CFL Hall of Fame"],
  ["Juco World Series", "Juco World Series Program"],
  ["Kahn's", "Kahn's Cincinnati Reds"],
  ["Kenner", "Kenner Starting Lineup"],
  ["Leaf", "Leaf Limited"],
  ["Little Sun", "Little Sun High School Prospects"],
  ["Mother's Cookies", "Mother's Cookies San Francisco Giants"],
  ["MSA", "MSA Disc"],
  ["NBA Hoops", "NBA Hoops Rookie Class"],
  ["ONIT Athlete", "ONIT Athlete Wisconsin Badgers"],
  ["Onyx", "Onyx Vintage"],
  ["Perez-Steele", "Perez-Steele Hall of Fame Postcards"],
  ["Playoff", "Playoff Contenders Rookie Ticket"],
  ["Post", "Post Cereal"],
  ["Pro Set", "Pro Set Platinum"],
  ["ProCards", "ProCards Tulsa Drillers"],
  ["Pucko", "Pucko Swedish Elite League"],
  ["Pulse", "Pulse Trading Cards"],
  ["SAGE", "SAGE Hit Autographs"],
  ["SCC", "SCC Minor League"],
  ["Sisson Printing", "Sisson Printing Erie Sailors"],
  ["Sport Pro", "Sport Pro Toledo Mud Hens"],
  ["Sportflics", "Sportflics Rookies"],
  ["SportsPrint", "SportsPrint Jackson Mets"],
  ["Star", "Star Michael Jordan"],
  ["Swell", "Swell Baseball Greats"],
  ["Takara", "Takara Nippon Ham Fighters"],
  ["Ted Williams", "Ted Williams Card Company Baseball"],
  ["UNO Elite", "UNO Elite Dallas Mavericks"],
  ["UNO Fandom", "UNO Fandom Golden State Warriors"],
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

  test("Collector's Choice — Upper Deck's line, the MVP shape exactly", () => {
    // The hobby heading is "UD Collector's Choice" and the line never left
    // Upper Deck, so it fails the "crossed owners" half of the test that let
    // `Hoops` in. `Choice` must not sweep it up either: the matcher is
    // anchored at the START of the name, so it cannot.
    expect(matchKnownBrand("Collector's Choice")).toBeUndefined();
    expect(matchKnownBrand("Collector's Choice Silver Signature")).toBeUndefined();
    // And the spelling without the apostrophe is no different.
    expect(matchKnownBrand("Collectors Choice Team Set")).toBeUndefined();
  });

  test("Select — an entry would claim future PANINI Select away from Panini", () => {
    // 1994 Select is Score/Pinnacle's, but "Select" today means Panini
    // Select. This is the worst trap in the data precisely because an entry
    // looks like a win on the 1994 sample and mis-files everything after it.
    expect(matchKnownBrand("Select")).toBeUndefined();
    expect(matchKnownBrand("Select Certified Edition")).toBeUndefined();
  });

  test("Pro Cards — a spacing variant of ProCards, and the fold does not close spaces", () => {
    expect(matchKnownBrand("Pro Cards French Series")).toBeUndefined();
    // The shipped spelling still claims its own sets, so nothing regressed.
    expect(matchKnownBrand("ProCards Tulsa Drillers")).toBe("ProCards");
  });

  test("NFL Properties and the Chris Martin cluster stay rejected", () => {
    expect(matchKnownBrand("NFL Properties Team Set")).toBeUndefined();
    expect(matchKnownBrand("Chris Martin Enterprises Promos")).toBeUndefined();
  });

  /**
   * `Other` IS A MARKETPLACE BUCKET WORD, and it has been concatenated into
   * NB set names at ingest — the data carries `Other ONIT Athlete LSU
   * Tigers` and `Other King B Discs` beside a bare `King B Discs`. An
   * `Other` entry would key an NB brand on a marketplace's own grouping
   * label (product invariant 4). Leaving these in Unknown fails safe.
   *
   * The visible cost, asserted rather than only described: `ONIT Athlete`
   * files ZERO football sets today, because every one arrives behind
   * "Other ". The fix is at the ADAPTER BOUNDARY (a separate ticket), not a
   * looser matcher and not an entry here.
   */
  test("Other is never an entry, and the sets behind it stay in Unknown", () => {
    expect(KNOWN_BRANDS).not.toContain("Other");
    expect(matchKnownBrand("Other ONIT Athlete LSU Tigers")).toBeUndefined();
    expect(matchKnownBrand("Other King B Discs")).toBeUndefined();
    // Without the bucket word in front, the same set files normally.
    expect(matchKnownBrand("ONIT Athlete LSU Tigers")).toBe("ONIT Athlete");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The bare-word traps the 2026-09-22 collector pass added
// ───────────────────────────────────────────────────────────────────────────

describe("the shorter word is never the entry", () => {
  test("Ted Williams is the Card Co.; a bare Ted claims nothing", () => {
    expect(matchKnownBrand("Ted Williams Etched In Stone Unitas")).toBe(
      "Ted Williams",
    );
    expect(KNOWN_BRANDS).not.toContain("Ted");
    // Any other Ted is somebody's first name, not a manufacturer.
    expect(matchKnownBrand("Ted Simmons Team Issue")).toBeUndefined();
    expect(matchKnownBrand("Ted")).toBeUndefined();
  });

  test("UNO Elite claims its line; a bare UNO is Nebraska Omaha", () => {
    // Case is folded, so the source's "Uno Elite" spelling is claimed too.
    expect(matchKnownBrand("Uno Elite All-Rookie Edition")).toBe("UNO Elite");
    expect(KNOWN_BRANDS).not.toContain("UNO");
    // "UNO" on its own is the university, and nothing claims it.
    expect(matchKnownBrand("UNO Mavericks Team Schedule")).toBeUndefined();
    expect(matchKnownBrand("UNO")).toBeUndefined();
  });

  test("Bleachers claims the slashed co-brand; Classic is not an entry", () => {
    expect(matchKnownBrand("Bleachers / Classic 23K Promos")).toBe("Bleachers");
    expect(KNOWN_BRANDS).not.toContain("Classic");
    expect(matchKnownBrand("Classic Draft Picks")).toBeUndefined();
  });

  test("Star still does not claim Stanford", () => {
    // The word boundary, re-asserted against the year the list doubled: a
    // new entry must not have loosened it.
    expect(matchKnownBrand("Stanford Cardinal Schedules")).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Two rows for one issuer, on purpose
// ───────────────────────────────────────────────────────────────────────────

/**
 * Three pairs ship both spellings, a deliberate exception to the
 * singular/plural rejection. Each member claims ONLY its own spelling — the
 * fold is case + trim, so neither reaches the other — and neither prefixes
 * the other, which is why the invariant above still holds with them in.
 */
describe("the deliberate two-spelling pairs", () => {
  test("Collector's Edge and Collectors Edge each claim their own spelling", () => {
    expect(matchKnownBrand("Collector's Edge Rookies")).toBe("Collector's Edge");
    expect(matchKnownBrand("Collectors Edge Supreme")).toBe("Collectors Edge");
  });

  test("UNO Elite and UNO Fandom are two lines, not one prefix", () => {
    expect(matchKnownBrand("UNO Elite Dallas Mavericks")).toBe("UNO Elite");
    expect(matchKnownBrand("UNO Fandom Golden State Warriors")).toBe(
      "UNO Fandom",
    );
  });

  /**
   * `NBA Hoops` is a MARKETPLACE-ARTIFACT spelling of the same line, and the
   * bigger claim of the two. Because the matcher is anchored at the start of
   * the name, `Hoops` cannot reach a set whose name begins "NBA Hoops" — the
   * second row is what files those 13 sets, and without it they stay in
   * Unknown.
   */
  test("Hoops does not claim an NBA Hoops name; NBA Hoops does", () => {
    expect(matchKnownBrand("NBA Hoops Supreme Court")).toBe("NBA Hoops");
    expect(matchKnownBrand("Hoops Supreme Court")).toBe("Hoops");
  });

  test("Hoops and Flair are lines that earned their own row", () => {
    // The test Jason adopted: the catalogue heading is that name alone AND
    // the line crossed owners. Hoops went Hoops Inc./SkyBox → Fleer →
    // Panini, so no one owner's row is right for it; Flair is Fleer-only and
    // clears only the first half, hence probable. Neither is filed under a
    // manufacturer, and a Fleer or Panini set is untouched by either.
    expect(matchKnownBrand("Hoops Draft Redemption")).toBe("Hoops");
    expect(matchKnownBrand("Flair Wave of the Future")).toBe("Flair");
    expect(matchKnownBrand("Fleer Ultra Gold Medallion")).toBeUndefined();
    expect(matchKnownBrand("Panini Prizm Draft")).toBeUndefined();
  });
});
