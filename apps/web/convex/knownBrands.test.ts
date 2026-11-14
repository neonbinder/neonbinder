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
 *      all 70, so an entry can never be quietly mis-spelled into claiming
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
 * `UNO`, `ONIT`, `Grand` and `Historic` are each the shorter string someone
 * will reach for, and each is asserted to claim nothing while the longer
 * entry beside it claims its sets.
 *
 * NEO-527 added the majors SportLots used to supply (Topps, Panini, Upper
 * Deck and the rest, which a year synced while SportLots is paused lacks). Three
 * earlier assertions said "a big-manufacturer set is left to its own brand"
 * and "Classic is not an entry"; they were flipped on purpose, and the
 * 2026 Football Unknown table below is the sample that decision was made on.
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
  test("holds the 70 entries Jason approved", () => {
    // 39 from the baseball pass, + 10 certain and 4 probable from the
    // collector pass over the 266 sets still in Unknown after Football
    // 2025/1994 and Basketball 2026/2025/1994 were loaded, + the 17 majors
    // SportLots used to supply (NEO-527: 16 certain, 1 probable).
    expect(KNOWN_BRANDS).toHaveLength(70);
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
  ["Bowman", "Bowman Chrome Draft"],
  ["Boxscores", "Boxscores Team Set"],
  ["Calbee", "Calbee Baseball"],
  ["Champion's Deck", "Champion's Deck LSU Tigers"],
  ["Choice", "Choice Biloxi Shuckers"],
  ["Classic", "Classic Draft Picks"],
  ["CMC", "CMC Triple A All-Stars"],
  ["Collector's Edge", "Collector's Edge Rookies"],
  ["Collectors Edge", "Collectors Edge Supreme"],
  ["Diamond Cards", "Diamond Cards Memphis Chicks"],
  ["Donruss", "Donruss Optic"],
  ["Eclipse", "Eclipse Baseball Legends"],
  ["Epoch", "Epoch Pacific League"],
  ["Finest", "Finest Refractors"],
  ["Flair", "Flair Wave of the Future"],
  ["Fleer", "Fleer Tradition"],
  ["Futera", "Futera World Football"],
  ["Grand Slam", "Grand Slam Winston-Salem Spirits"],
  ["Historic Autographs", "Historic Autographs Originals"],
  ["Hoops", "Hoops Draft Redemption"],
  ["ITG", "ITG Heroes and Prospects"],
  ["JOGO", "JOGO CFL Hall of Fame"],
  ["Juco World Series", "Juco World Series Program"],
  ["Kahn's", "Kahn's Cincinnati Reds"],
  ["Kenner", "Kenner Starting Lineup"],
  ["Leaf", "Leaf Limited"],
  ["Little Sun", "Little Sun High School Prospects"],
  ["Mother's Cookies", "Mother's Cookies San Francisco Giants"],
  ["MSA", "MSA Disc"],
  ["NBA Hoops", "NBA Hoops Rookie Class"],
  ["O-Pee-Chee", "O-Pee-Chee Platinum"],
  ["ONIT Athlete", "ONIT Athlete Wisconsin Badgers"],
  ["Onyx", "Onyx Vintage"],
  ["Pacific", "Pacific Crown Royale"],
  ["Panini", "Panini Prizm"],
  ["Perez-Steele", "Perez-Steele Hall of Fame Postcards"],
  ["Pinnacle", "Pinnacle Inside"],
  ["Playoff", "Playoff Contenders Rookie Ticket"],
  ["Post", "Post Cereal"],
  ["Pro Set", "Pro Set Platinum"],
  ["ProCards", "ProCards Tulsa Drillers"],
  ["Pucko", "Pucko Swedish Elite League"],
  ["Pulse", "Pulse Trading Cards"],
  ["SAGE", "SAGE Hit Autographs"],
  ["SCC", "SCC Minor League"],
  ["Score", "Score Rookie and Traded"],
  ["Sisson Printing", "Sisson Printing Erie Sailors"],
  ["Skybox", "Skybox Premium"],
  ["SP", "SP Authentic"],
  ["Sport Pro", "Sport Pro Toledo Mud Hens"],
  ["Sportflics", "Sportflics Rookies"],
  ["SportsPrint", "SportsPrint Jackson Mets"],
  ["Stadium Club", "Stadium Club Chrome"],
  ["Star", "Star Michael Jordan"],
  ["Swell", "Swell Baseball Greats"],
  ["Takara", "Takara Nippon Ham Fighters"],
  ["Ted Williams", "Ted Williams Card Company Baseball"],
  ["Topps", "Topps Chrome"],
  ["Ultra", "Ultra Gold Medallion"],
  ["UNO Elite", "UNO Elite Dallas Mavericks"],
  ["UNO Fandom", "UNO Fandom Golden State Warriors"],
  ["Upper Deck", "Upper Deck Exquisite Collection"],
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

  /**
   * NEO-527 — FLIPPED ON PURPOSE. Before it, the majors came from SportLots'
   * brand list and this asserted they were not entries. SportLots is paused,
   * so NB's own list names them; a big-manufacturer set is claimed by the
   * brand its name starts with, and only that one.
   */
  test("a big-manufacturer set is claimed by the brand its name starts with", () => {
    expect(matchKnownBrand("Topps Chrome")).toBe("Topps");
    // Anchored at the start: an SP line under Upper Deck's name is Upper
    // Deck's, never SP's.
    expect(matchKnownBrand("Upper Deck SP Authentic")).toBe("Upper Deck");
    expect(matchKnownBrand("SP Authentic")).toBe("SP");
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

  test("Bleachers claims the slashed co-brand; Classic claims only its own", () => {
    expect(matchKnownBrand("Bleachers / Classic 23K Promos")).toBe("Bleachers");
    // NEO-527 — FLIPPED ON PURPOSE: Classic is one of the majors SportLots
    // used to supply (probable, a common word). Anchored at the start, so it
    // still cannot reach the Bleachers co-brand above.
    expect(KNOWN_BRANDS).toContain("Classic");
    expect(matchKnownBrand("Classic Draft Picks")).toBe("Classic");
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
    // NEO-527 — FLIPPED ON PURPOSE: Fleer and Panini are entries now, so a
    // set that names its manufacturer first is that manufacturer's, and
    // neither line reaches it.
    expect(matchKnownBrand("Fleer Ultra Gold Medallion")).toBe("Fleer");
    expect(matchKnownBrand("Panini Prizm Draft")).toBe("Panini");
    expect(matchKnownBrand("Fleer Flair")).toBe("Fleer");
    expect(matchKnownBrand("Panini Hoops")).toBe("Panini");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// NEO-527 — the majors, on the sample the decision was made on
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every set name under 2026 Football's Unknown row when NEO-527 was filed:
 * SportLots was paused, so the year got no major brand rows and these 26
 * landed in Unknown. With the majors on the list, 21 are claimed by their
 * brand and 5 stay in Unknown — a Valiant pair (rejected, Jason
 * 2026-11-12), a photographer, a team training camp and a chili sponsor.
 */
const FOOTBALL_2026_UNKNOWN: Array<[setName: string, brand: string | undefined]> = [
  ["Bowman", "Bowman"],
  ["Bowman Sapphire Edition", "Bowman"],
  ["Bowman U Now", "Bowman"],
  ["Bowman University Best", "Bowman"],
  ["Donruss", "Donruss"],
  ["Michael Zagaris 707 Gallery", undefined],
  ["Minnesota Vikings Training Camp", undefined],
  ["Panini Instant NIL", "Panini"],
  ["Panini Pro Football Hall Of Fame", "Panini"],
  ["Panini Senior Bowl", "Panini"],
  ["Skyline Chili Cincinnati Bengals", undefined],
  ["Topps Chrome", "Topps"],
  ["Topps Chrome The National Sports Collectors Convention", "Topps"],
  ["Topps Flagship", "Topps"],
  ["Topps Heritage", "Topps"],
  ["Topps Holiday", "Topps"],
  ["Topps Inception", "Topps"],
  ["Topps Living", "Topps"],
  ["Topps Midnight", "Topps"],
  ["Topps Now", "Topps"],
  ["Topps Now Draft", "Topps"],
  ["Topps Now Madden NFL 27 Cover", "Topps"],
  ["Topps Now Offseason", "Topps"],
  ["Upper Deck CFL", "Upper Deck"],
  ["Valiant Michigan Moments", undefined],
  ["Valiant Michigan Wolverines", undefined],
];

describe("NEO-527 — the 2026 Football sets SportLots' pause left in Unknown", () => {
  test("the sample is the 26 names, 21 claimed and 5 left in Unknown", () => {
    expect(FOOTBALL_2026_UNKNOWN).toHaveLength(26);
    const claimed = FOOTBALL_2026_UNKNOWN.filter(([name]) => matchKnownBrand(name));
    expect(claimed).toHaveLength(21);
  });

  test.each(FOOTBALL_2026_UNKNOWN)("%s → %s", (setName, brand) => {
    expect(matchKnownBrand(setName)).toBe(brand);
  });

  test("Valiant was considered with the majors and rejected", () => {
    expect(KNOWN_BRANDS).not.toContain("Valiant");
  });

  test("Skybox does not claim Skyline — the word boundary again", () => {
    expect(matchKnownBrand("Skyline Chili Cincinnati Bengals")).toBeUndefined();
  });

  test("SP is a whole word, so SPx (another Upper Deck line) is not claimed", () => {
    expect(matchKnownBrand("SPx")).toBeUndefined();
    expect(matchKnownBrand("SPx Finite")).toBeUndefined();
    expect(matchKnownBrand("SP")).toBe("SP");
  });

  test("an apostrophe is a word boundary, so Bowman's Best is Bowman's", () => {
    // The ASCII apostrophe ends the word "Bowman"; this is the same rule that
    // lets "Kahn's" stay one entry. `Best` cannot claim it: anchored at the
    // start of the name.
    expect(matchKnownBrand("Bowman's Best")).toBe("Bowman");
  });

  test("Stadium Club and Finest are their own rows; Topps-first names are Topps'", () => {
    expect(matchKnownBrand("Stadium Club Members Only")).toBe("Stadium Club");
    expect(matchKnownBrand("Topps Stadium Club")).toBe("Topps");
    expect(matchKnownBrand("Finest Refractors")).toBe("Finest");
    expect(matchKnownBrand("Topps Finest")).toBe("Topps");
  });

  test("Select stays rejected, and Panini Select is Panini's", () => {
    // The trap the rejection guards against, now with its answer: Panini
    // Select names its manufacturer first, so Panini claims it.
    expect(matchKnownBrand("Select")).toBeUndefined();
    expect(matchKnownBrand("Panini Select")).toBe("Panini");
  });
});
