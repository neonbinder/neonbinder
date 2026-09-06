/**
 * NEO-156 — the bundled colour dataset and how names match against it.
 *
 * Several of these assert the dataset's LIMITS rather than its contents. That
 * is deliberate: the fallback to a live lookup only earns its complexity
 * because this data is incomplete, and a future edit that "fixes" a miss by
 * inventing a row would quietly remove the reason the fallback exists.
 */

import { describe, expect, it } from "vitest";
import {
  RENAMED_FRANCHISES,
  SEED_LEAGUES,
  SEED_TEAMS,
} from "./seed-team-colors";
import {
  currentFranchiseName,
  currentFranchiseParts,
  findSeedColors,
  findSeedTeam,
  seedMatchKey,
} from "./seed-team-lookup";
import { teamFullName } from "./team-name";

describe("the dataset itself", () => {
  it("covers six leagues and 165 teams", () => {
    expect(SEED_TEAMS).toHaveLength(165);
    expect(Object.keys(SEED_LEAGUES).sort()).toEqual([
      "epl",
      "mlb",
      "mls",
      "nba",
      "nfl",
      "nhl",
    ]);
  });

  it("has colours for every team", () => {
    // The NBA's 30 arrived empty in the original dataset and were filled from
    // a second source. The count is the point: a row without colours cannot
    // answer a lookup and silently falls through to the scrape.
    expect(SEED_TEAMS.every((t) => t.hex.length > 0)).toBe(true);
    expect(SEED_TEAMS.filter((t) => t.league === "nba")).toHaveLength(30);
  });

  it("uses current NBA colours, not retro ones", () => {
    // The second source lists `retrocolors` alongside current ones. Taking
    // those would label a binder in a palette the team retired — the same
    // failure the scraper's era-parsing avoids.
    // Hornets retro teal is #00778b; their current teal is #00788c.
    const hornets = findSeedTeam("Charlotte Hornets")!;
    expect(hornets.hex).toContain("#00788c");
    expect(hornets.hex).not.toContain("#00778b");
  });

  it("corrects hex values their own record contradicts", () => {
    // Lakers gold shipped as #f9a01b — the Miami Heat's yellow — while its RGB
    // (253,185,39) says #fdb927. Gold is the Lakers' SECONDARY colour, so this
    // is the lettering on a Lakers spine label.
    const lakers = findSeedColors("Los Angeles Lakers")!;
    expect(lakers.secondary).toBe("#fdb927");
    // Suns yellow shipped as #000000 against an RGB of (249,160,27).
    expect(findSeedTeam("Phoenix Suns")!.hex).toContain("#f9a01b");
  });

  it("stores every colour as lowercase #rrggbb", () => {
    for (const team of SEED_TEAMS) {
      for (const hex of team.hex) {
        expect(hex).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("maps every league to a sport", () => {
    for (const code of Object.keys(SEED_LEAGUES)) {
      const meta = SEED_LEAGUES[code as keyof typeof SEED_LEAGUES];
      expect(meta.sportValue).toBeTruthy();
      expect(meta.name).toBeTruthy();
      expect(meta.abbreviation).toBeTruthy();
    }
  });

  it("does NOT carry the long tail our teams table is full of", () => {
    // The reason the live lookup still exists. A survey of all 58 prod teams
    // found these; none are in this dataset, and none should be added by hand.
    for (const absent of [
      "Saitama Seibu Lions",
      "Chiba Lotte Marines",
      "Estrellas Orientales",
      "Fort Wayne TinCaps",
      "UConn Huskies",
    ]) {
      expect(findSeedTeam(absent)).toBeNull();
    }
  });
});

describe("seedMatchKey", () => {
  it("ignores case, punctuation and spacing", () => {
    expect(seedMatchKey("  St. Louis  Cardinals ")).toBe("st louis cardinals");
    expect(seedMatchKey("Brighton & Hove Albion")).toBe(
      "brighton and hove albion",
    );
  });

  it("strips the sport suffix our college rows carry", () => {
    expect(seedMatchKey("UConn Huskies baseball")).toBe("uconn huskies");
  });

  it("only strips a sport word at the END", () => {
    expect(seedMatchKey("Baseball Ground Rovers")).toBe("baseball ground rovers");
  });

  it("preserves word order", () => {
    // Unlike teams.normalizeTeamName, which token-sorts for dedup.
    expect(seedMatchKey("Chiba Lotte Marines")).not.toBe(
      seedMatchKey("Marines Lotte Chiba"),
    );
  });
});

describe("findSeedColors", () => {
  it("returns the first two colours, most prominent first", () => {
    const match = findSeedColors("Milwaukee Brewers");
    expect(match).not.toBeNull();
    expect(match!.primary).toMatch(/^#[0-9a-f]{6}$/);
    expect(match!.league).toBe("mlb");
    expect(match!.matchedName).toBe("Milwaukee Brewers");
  });

  it("matches regardless of case, punctuation or sport suffix", () => {
    expect(findSeedColors("st. louis cardinals")).not.toBeNull();
    expect(findSeedColors("Chicago Cubs baseball")).not.toBeNull();
  });

  it("returns null for a league the dataset does not carry", () => {
    expect(findSeedColors("Saitama Seibu Lions")).toBeNull();
  });

  it("answers for an NBA team now that the gap is filled", () => {
    const celtics = findSeedColors("Boston Celtics");
    expect(celtics!.primary).toBe("#007a33");
    expect(celtics!.secondary).toBe("#ba9653");
  });
});

describe("renamed franchises", () => {
  it("finds a franchise under the name it goes by today", () => {
    // The dataset still says "Cleveland Indians". A collector's binder must
    // not be labelled with a name retired in 2022, and our own table holds the
    // current one.
    const match = findSeedColors("Cleveland Guardians");
    expect(match).not.toBeNull();
    expect(match!.matchedName).toBe("Cleveland Indians");
  });

  it("still finds it under the dataset's own name", () => {
    expect(findSeedColors("Cleveland Indians")).not.toBeNull();
  });

  it("handles the Angels' 2016 rename", () => {
    expect(findSeedColors("Los Angeles Angels")).not.toBeNull();
  });

  it("maps a stale name forward and leaves current names alone", () => {
    expect(currentFranchiseName("Cleveland Indians")).toBe("Cleveland Guardians");
    expect(currentFranchiseName("Chicago Cubs")).toBe("Chicago Cubs");
  });

  /**
   * NEO-236 — a rename lands as Location + Name, like every other creation.
   *
   * `currentFranchiseName` still speaks in full strings because its callers
   * hold one (a scraped page title, a marketplace payload). The SEEDER needs
   * the two parts, so `RENAMED_FRANCHISES` stores the split and nothing has to
   * re-derive it from a string.
   */
  it("gives the seeder the CURRENT franchise split into location and name", () => {
    const indians = SEED_TEAMS.find((t) => t.name === "Indians")!;
    expect(currentFranchiseParts(indians)).toEqual({
      location: "Cleveland",
      name: "Guardians",
    });

    const cubs = SEED_TEAMS.find((t) => t.name === "Cubs")!;
    expect(currentFranchiseParts(cubs)).toEqual({
      location: "Chicago",
      name: "Cubs",
    });

    // A club with no place part stays that way — "Real" is the club's name,
    // not a location, and nothing here may invent one.
    const rsl = SEED_TEAMS.find((t) => t.name === "Real Salt Lake")!;
    expect(currentFranchiseParts(rsl)).toEqual({
      location: undefined,
      name: "Real Salt Lake",
    });
  });

  /**
   * NEO-236 — the dataset's split must ROUND-TRIP to the name it replaced.
   *
   * The rows were split by hand, which is the right way to do it and also the
   * way a typo survives review. Every row's composed name has to still find
   * its own colours through the same key `resolveTeamColors` uses; if a split
   * dropped or duplicated a word, this is where it shows up.
   */
  it("every row's composed full name still resolves to its own entry", () => {
    for (const team of SEED_TEAMS) {
      const full = teamFullName(team);
      expect(findSeedTeam(full), full).toBe(team);
    }
  });

  it("no two rows compose to the same full name", () => {
    const seen = new Set<string>();
    for (const team of SEED_TEAMS) {
      const key = seedMatchKey(teamFullName(team));
      expect(seen.has(key), teamFullName(team)).toBe(false);
      seen.add(key);
    }
  });

  it("only remaps renames, never relocations we track separately", () => {
    // Montreal Expos → Washington Nationals is a relocation, and both are real
    // distinct rows for us. Collapsing them would lose the Expos.
    expect(RENAMED_FRANCHISES["Montreal Expos"]).toBeUndefined();
  });

  it("points every rename at a name the dataset does not already hold", () => {
    // Otherwise the two keys would collide and one franchise would shadow the
    // other in the index.
    const names = new Set(SEED_TEAMS.map((t) => teamFullName(t)));
    for (const current of Object.values(RENAMED_FRANCHISES)) {
      expect(names.has(teamFullName(current))).toBe(false);
    }
  });
});
