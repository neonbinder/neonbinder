/**
 * NEO-254 — the nflverse (team code, season) era table.
 *
 * The table is the only thing standing between a bare code like BOS — which
 * was four unrelated franchises across four decades — and 33,000 players on
 * mislabelled teams. So the tests here are structural: no season can resolve
 * to two eras, every era must actually be reachable, and the committed
 * `nfl.json` must be entirely explicable by the table.
 *
 * The RAW rosters are gitignored, so this cannot walk them. It walks the
 * generated file instead, which is the same coverage claim one step removed:
 * the generator refuses to emit a file at all if a roster row does not resolve
 * (see `scripts/build-preload-data.mjs`), so a committed `nfl.json` whose
 * teams all trace back to eras IS a proof that every roster row resolved.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  NFL_TEAM_ERAS,
  nflEraTeamName,
  resolveNflTeamEra,
} from "./nfl-team-eras";
import type { PreloadFile } from "./preload-shape";

const NFL: PreloadFile = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../../data/preload/nfl.json"),
    "utf8",
  ),
);

/** Latest season any era mentions, so open eras have something to end at. */
const LAST_SEASON = Math.max(...NFL.teams.map((t) => t.to ?? 0), 2026);

describe("NFL_TEAM_ERAS", () => {
  test("no (code, season) resolves to two eras", () => {
    // `resolveNflTeamEra` throws on an overlap; walking every season of every
    // era is what turns that from a latent bug into a failed test.
    for (const era of NFL_TEAM_ERAS) {
      for (let season = era.from; season <= (era.to ?? LAST_SEASON); season += 1) {
        expect(() => resolveNflTeamEra(era.code, season)).not.toThrow();
        expect(resolveNflTeamEra(era.code, season)).not.toBeNull();
      }
    }
  });

  test("spans are well formed", () => {
    for (const era of NFL_TEAM_ERAS) {
      expect(era.from).toBeGreaterThanOrEqual(1920);
      if (era.to !== null) expect(era.to).toBeGreaterThanOrEqual(era.from);
      expect(era.nickname).not.toBe("");
      expect(era.franchise).not.toBe("");
      expect(era.code).toMatch(/^[A-Z-]{1,4}$/);
    }
  });

  test("the reused codes resolve to the right franchise per season", () => {
    // The four collisions that made the table necessary. Each was verified
    // against the roster rows themselves — see the file header.
    const name = (code: string, season: number) =>
      nflEraTeamName(resolveNflTeamEra(code, season)!);

    expect(name("BOS", 1929)).toBe("Boston Bulldogs");
    expect(name("BOS", 1932)).toBe("Boston Braves");
    expect(name("BOS", 1935)).toBe("Boston Redskins");
    expect(name("BOS", 1946)).toBe("Boston Yanks");
    expect(name("BOS", 1965)).toBe("Boston Patriots");

    // CHR is the AAFC Chicago Rockets, and then the 1960 AFL Chargers.
    expect(name("CHR", 1947)).toBe("Chicago Rockets");
    expect(name("CHR", 1960)).toBe("Los Angeles Chargers");

    expect(name("DAL", 1952)).toBe("Dallas Texans");
    expect(name("DAL", 1970)).toBe("Dallas Cowboys");

    expect(name("NY", 1921)).toBe("New York Brickley Giants");
    expect(name("NY", 1935)).toBe("New York Giants");

    expect(name("STL", 1923)).toBe("St. Louis All-Stars");
    expect(name("STL", 1934)).toBe("St. Louis Gunners");
    expect(name("STL", 1975)).toBe("St. Louis Cardinals");
    expect(name("STL", 1999)).toBe("St. Louis Rams");

    expect(name("HOU", 1990)).toBe("Houston Oilers");
    expect(name("HOU", 2020)).toBe("Houston Texans");
  });

  test("renames land on the right side of the year they happened", () => {
    const name = (code: string, season: number) =>
      nflEraTeamName(resolveNflTeamEra(code, season)!);
    // The Pittsburgh franchise was the Pirates until 1940.
    expect(name("PIT", 1939)).toBe("Pittsburgh Pirates");
    expect(name("PIT", 1940)).toBe("Pittsburgh Steelers");
    // Tennessee kept the Oilers name for two seasons.
    expect(name("TEN", 1998)).toBe("Tennessee Oilers");
    expect(name("TEN", 1999)).toBe("Tennessee Titans");
    // Washington, both times.
    expect(name("WAS", 2019)).toBe("Washington Redskins");
    expect(name("WAS", 2021)).toBe("Washington Football Team");
    expect(name("WAS", 2022)).toBe("Washington Commanders");
  });

  test("leagues are attached to the era, not the franchise", () => {
    expect(resolveNflTeamEra("GB", 1921)!.league).toBe("APFA");
    expect(resolveNflTeamEra("GB", 1922)!.league).toBe("NFL");
    expect(resolveNflTeamEra("CLE", 1948)!.league).toBe("AAFC");
    expect(resolveNflTeamEra("CLE", 1950)!.league).toBe("NFL");
    expect(resolveNflTeamEra("BUF", 1965)!.league).toBe("AFL");
    expect(resolveNflTeamEra("BUF", 1975)!.league).toBe("NFL");
  });

  test("relocations share a franchise key without sharing a row", () => {
    expect(resolveNflTeamEra("OAK", 2000)!.franchise).toBe("raiders");
    expect(resolveNflTeamEra("RAI", 1985)!.franchise).toBe("raiders");
    expect(resolveNflTeamEra("LV", 2022)!.franchise).toBe("raiders");
    // …and are three distinct team rows, because that is what a card says.
    expect(new Set(NFL.teams.map((t) => t.name)).size).toBe(NFL.teams.length);
    for (const n of ["Oakland Raiders", "Los Angeles Raiders", "Las Vegas Raiders"]) {
      expect(NFL.teams.map((t) => t.name)).toContain(n);
    }
  });

  test("returns null for a code or season it does not cover", () => {
    expect(resolveNflTeamEra("ZZZ", 1999)).toBeNull();
    expect(resolveNflTeamEra("AKR", 1990)).toBeNull();
  });

  test("COVERS the committed nfl.json: every team traces back to an era", () => {
    const eraNames = new Set(NFL_TEAM_ERAS.map(nflEraTeamName));
    const missing = NFL.teams.map((t) => t.name).filter((n) => !eraNames.has(n));
    expect(missing).toEqual([]);
  });

  test("has no dead rows: every era's name appears in the committed file", () => {
    // An era nothing resolves to is either a typo or a franchise nflverse does
    // not carry — both worth knowing about rather than leaving in place.
    const fileNames = new Set(NFL.teams.map((t) => t.name));
    const unused = [...new Set(NFL_TEAM_ERAS.map(nflEraTeamName))].filter(
      (n) => !fileNames.has(n),
    );
    expect(unused).toEqual([]);
  });
});
