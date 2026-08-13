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
  findSeedColors,
  findSeedTeam,
  seedMatchKey,
} from "./seed-team-lookup";

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

  it("has colours for 135 of them, and none for any NBA team", () => {
    const withColors = SEED_TEAMS.filter((t) => t.hex.length > 0);
    expect(withColors).toHaveLength(135);
    // Every single NBA row ships with an empty hex array. If that ever changes
    // upstream this test should be updated, not deleted — the count is the
    // point.
    const nba = SEED_TEAMS.filter((t) => t.league === "nba");
    expect(nba).toHaveLength(30);
    expect(nba.every((t) => t.hex.length === 0)).toBe(true);
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

  it("returns null for a team that exists here but has no colours", () => {
    // Every NBA row. A row without colours cannot answer a colour lookup, so
    // it must fall through to the live source rather than resolve to nothing.
    expect(findSeedTeam("Boston Celtics")).not.toBeNull();
    expect(findSeedColors("Boston Celtics")).toBeNull();
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

  it("only remaps renames, never relocations we track separately", () => {
    // Montreal Expos → Washington Nationals is a relocation, and both are real
    // distinct rows for us. Collapsing them would lose the Expos.
    expect(RENAMED_FRANCHISES["Montreal Expos"]).toBeUndefined();
  });

  it("points every rename at a name the dataset does not already hold", () => {
    // Otherwise the two keys would collide and one franchise would shadow the
    // other in the index.
    const names = new Set(SEED_TEAMS.map((t) => t.name));
    for (const current of Object.values(RENAMED_FRANCHISES)) {
      expect(names.has(current)).toBe(false);
    }
  });
});
