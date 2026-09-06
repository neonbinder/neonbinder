/**
 * NEO-254 — the preload generator, over a hand-built fixture set.
 *
 * The fixtures under `__fixtures__/preload/` are tiny on purpose: every row is
 * there to exercise one decision, so a failure names the decision rather than
 * "something in 21,000 players changed". The committed files themselves are
 * checked separately, by `lib/players/preload/preload-data.test.ts`.
 */

import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  buildMlb,
  buildNfl,
  parseCsv,
  parseCsvObjects,
  serializePreloadFile,
} from "./build-preload-data.mjs";

const FIXTURES = path.resolve(import.meta.dirname, "__fixtures__");
const GOOD = path.join(FIXTURES, "preload");
const BAD = path.join(FIXTURES, "preload-bad");
const GENERATED_AT = "2026-01-01";

const mlb = () => buildMlb({ rawDir: GOOD, generatedAt: GENERATED_AT });
const nfl = () => buildNfl({ rawDir: GOOD, generatedAt: GENERATED_AT });

const teamNames = (file) => file.teams.map((t) => t.name);
const player = (file, id) => file.players.find((p) => p.id === id);

describe("parseCsv", () => {
  test("keeps a comma inside a quoted field", () => {
    expect(parseCsv('a,b\n1,"x,y"\n')).toEqual([
      ["a", "b"],
      ["1", "x,y"],
    ]);
  });

  test("unescapes a doubled quote and spans a newline inside quotes", () => {
    expect(parseCsv('a\n"he said ""hi""\nand left"\n')).toEqual([
      ["a"],
      ['he said "hi"\nand left'],
    ]);
  });

  test("strips a UTF-8 BOM, so the first header is usable", () => {
    expect(parseCsvObjects("﻿yearID,name\n1871,Boston\n")[0]).toEqual({
      yearID: "1871",
      name: "Boston",
    });
  });

  test("handles CRLF and does not emit an empty trailing row", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("buildMlb", () => {
  test("excludes Negro League rows and drops a player left with no stints", () => {
    const { file, stats } = mlb();
    // The team never appears…
    expect(teamNames(file)).not.toContain("Pittsburgh Crawfords");
    // …nor the player who only ever played for it.
    expect(player(file, "gibsojo01")).toBeUndefined();
    // The excluded rows are counted rather than passed over quietly.
    expect(stats.excludedAppearances).toBe(2);
    expect(stats.excludedTeamSeasons).toBe(1);
  });

  test("a player who ALSO played in the AL/NL keeps only those stints", () => {
    const { file } = mlb();
    const gwynn = player(file, "gwynnto01");
    // 1936 Pittsburgh Crawfords is in the fixture for exactly this reason.
    expect(gwynn.stints).toEqual([
      [teamNames(file).indexOf("San Diego Padres"), 1990, 1991],
      [teamNames(file).indexOf("Boston Red Sox"), 1993, 1993],
    ]);
  });

  test("a gap season starts a new stint rather than extending the old one", () => {
    const { file } = mlb();
    // 1990-1991 then 1993 — two stints, not one 1990-1993 run.
    expect(player(file, "gwynnto01").stints).toHaveLength(2);
  });

  test("Hall of Fame is PLAYERS only, and only when inducted", () => {
    const { file } = mlb();
    expect(player(file, "gwynnto01").hof).toBe(true);
    // Voted on but not inducted.
    expect(player(file, "smithjo01").hof).toBeUndefined();
  });

  test("a player with no name is skipped and reported", () => {
    const { file, stats } = mlb();
    expect(player(file, "namelss01")).toBeUndefined();
    expect(stats.skippedNoName).toBe(1);
  });

  test("one team row per historical name, with its own years", () => {
    const { file } = mlb();
    const expos = file.teams.find((t) => t.name === "Montreal Expos");
    const nats = file.teams.find((t) => t.name === "Washington Nationals");
    expect(expos.to).toBe(2004);
    // Still playing in the dataset's final season, so no end year at all.
    expect(nats.to).toBeUndefined();
    // Two rows, one franchise.
    expect(expos.franchise).toBe(nats.franchise);
  });

  test("splits location and nickname, including the multi-word cases", () => {
    const { file } = mlb();
    const sox = file.teams.find((t) => t.name === "Boston Red Sox");
    expect(sox.location).toBe("Boston");
    expect(sox.nickname).toBe("Red Sox");
    const altoona = file.teams.find((t) => t.name === "Altoona Mountain City");
    expect(altoona.location).toBe("Altoona");
    expect(altoona.nickname).toBe("Mountain City");
  });

  test("AL and NL both resolve to the sport's own default league", () => {
    const { file } = mlb();
    const mlbLeague = file.leagues.find((l) => l.code === "MLB");
    expect(mlbLeague.default).toBe(true);
    expect(file.teams.find((t) => t.name === "Boston Red Sox").league).toBe("MLB");
    // A pre-modern league gets a real row of its own, not the default.
    expect(file.teams.find((t) => t.name === "Altoona Mountain City").league).toBe("UA");
    expect(file.leagues.find((l) => l.code === "UA").default).toBeUndefined();
  });

  test("players are ordered by source id, so the committed file is stable", () => {
    const { file } = mlb();
    const ids = file.players.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("carries the licence and the exclusion in the file itself", () => {
    const { file } = mlb();
    expect(file.source.licence).toBe("CC-BY-SA-3.0");
    expect(file.source.version).toContain("Jan 1, 2026");
    expect(file.source.notes.join(" ")).toContain("ShareAlike");
    expect(file.source.notes.join(" ")).toContain("EXCLUDED");
  });
});

describe("buildNfl", () => {
  test("resolves a team code through the era table, per season", () => {
    const { file } = nfl();
    // BUF is the AAFC Bisons in 1946 and the Bills from 1947 — one code, two
    // names, which is the whole reason the era table exists.
    expect(teamNames(file)).toContain("Buffalo Bisons");
    expect(teamNames(file)).toContain("Buffalo Bills");
    expect(file.teams.find((t) => t.name === "Cleveland Browns").league).toBe("AAFC");
  });

  test("an alternate code for the same team continues one stint", () => {
    const { file } = nfl();
    // ARZ 2015 → ARI 2016 is the same Arizona Cardinals row.
    const cards = teamNames(file).indexOf("Arizona Cardinals");
    expect(player(file, "00-0031234").stints).toEqual([[cards, 2015, 2016]]);
  });

  test("every roster status counts as membership", () => {
    const { file } = nfl();
    // Otto Graham is ACT in 1946 and RES in 1947; both are on the team.
    expect(player(file, "name:otto-graham|b1921#1").stints[0]).toEqual([
      teamNames(file).indexOf("Cleveland Browns"),
      1946,
      1947,
    ]);
    // "Rams Guy" is CUT and still present.
    expect(player(file, "00-0031235")).toBeDefined();
  });

  test("identity falls back from source id to name+birth year to name alone", () => {
    const { file } = nfl();
    expect(player(file, "00-0031234").lowConfidence).toBeUndefined();
    expect(player(file, "name:otto-graham|b1921#1").birthYear).toBe(1921);
    expect(player(file, "name:otto-graham|b1921#1").lowConfidence).toBeUndefined();
    // No id and no birth date: keyed by name and first season, and flagged.
    const guy = player(file, "name:no-birthdate-guy|s1946#1");
    expect(guy.lowConfidence).toBe(true);
    expect(guy.birthYear).toBeUndefined();
  });

  test("NO emitted id carries a full date of birth", () => {
    // Security review: `nflverseId` is committed publicly here and returned by
    // the public player queries. The birth date groups rows inside the
    // generator and must never leave it; the YEAR is what the UI needs.
    for (const p of nfl().file.players) {
      expect(p.id).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    expect(player(nfl().file, "name:otto-graham|b1921#1")).toBeDefined();
  });

  test("an ordinal separates two people who share a name AND a birth year", () => {
    // The ordinal is unconditional so the shape never varies, and it is what
    // replaces the birth date's discriminating power.
    for (const p of nfl().file.players) {
      if (p.id.startsWith("name:")) expect(p.id).toMatch(/#\d+$/);
    }
  });

  test("undated rows split per team and per NON-CONSECUTIVE season", () => {
    // Security review: grouping these by name alone folded different people
    // into one player — the `|s<firstSeason>` suffix was applied AFTER the
    // merge and could never separate them.
    const { file } = nfl();
    const browns = teamNames(file).indexOf("Cleveland Browns");

    // Same team, 1946 and 1948 — a gap, so two people as far as we can tell.
    expect(player(file, "name:ghost-player|s1946#1").stints).toEqual([[browns, 1946, 1946]]);
    expect(player(file, "name:ghost-player|s1948#2").stints).toEqual([[browns, 1948, 1948]]);

    // Different teams in consecutive seasons — also two, for the same reason.
    expect(player(file, "name:no-birthdate-guy|s1946#1")).toBeDefined();
    expect(player(file, "name:no-birthdate-guy|s1947#2")).toBeDefined();

    // Consecutive seasons on ONE team is the only thing that merges.
    expect(player(file, "name:twin-season|s1946#1").stints).toEqual([
      [browns, 1946, 1947],
    ]);
    expect(file.players.filter((p) => p.name === "Twin Season")).toHaveLength(1);
  });

  test("a roster row with no name is skipped and warned about", () => {
    const { stats } = nfl();
    expect(stats.warnings.join(" ")).toContain("no full_name");
    expect(stats.players).toBe(8);
    expect(stats.lowConfidence).toBe(5);
  });

  test("FAILS on a (code, season) the era table does not resolve", () => {
    // The point of the whole table: an unknown code would otherwise put real
    // players on an invented team.
    expect(() => buildNfl({ rawDir: BAD, generatedAt: GENERATED_AT })).toThrow(
      /NFL_TEAM_ERAS/,
    );
    expect(() => buildNfl({ rawDir: BAD, generatedAt: GENERATED_AT })).toThrow(/ZZZ 1999/);
  });

  test("carries the nflverse licence", () => {
    const { file } = nfl();
    expect(file.source.licence).toBe("CC-BY-4.0");
    expect(file.source.url).toContain("nflverse");
  });
});

describe("both files", () => {
  test("teams are sorted by name and stint indexes are in range", () => {
    for (const { file } of [mlb(), nfl()]) {
      const names = teamNames(file);
      expect(names).toEqual([...names].sort());
      for (const p of file.players) {
        expect(p.stints.length).toBeGreaterThan(0);
        for (const [teamIndex, from, to] of p.stints) {
          expect(teamIndex).toBeGreaterThanOrEqual(0);
          expect(teamIndex).toBeLessThan(file.teams.length);
          expect(from).toBeLessThanOrEqual(to);
        }
      }
    }
  });

  test("is deterministic — two builds of the same inputs are byte-identical", () => {
    expect(serializePreloadFile(mlb().file)).toBe(serializePreloadFile(mlb().file));
    expect(serializePreloadFile(nfl().file)).toBe(serializePreloadFile(nfl().file));
  });

  test("serialises one record per line, and still parses", () => {
    // Compact per line, one line per row: a regenerate is reviewable in a diff
    // instead of reading as "the whole 3 MB changed".
    const text = serializePreloadFile(nfl().file);
    expect(JSON.parse(text).players).toHaveLength(nfl().file.players.length);
    expect(text).not.toContain("\n  ");
    const lines = text.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(nfl().file.players.length);
    // Every player line is one whole record.
    for (const line of lines) {
      if (!line.startsWith('{"id":')) continue;
      expect(() => JSON.parse(line.replace(/,$/, ""))).not.toThrow();
    }
  });
});
