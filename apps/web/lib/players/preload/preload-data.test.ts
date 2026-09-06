/**
 * NEO-254 — integrity of the COMMITTED preload files.
 *
 * `data/preload/{mlb,nfl}.json` are build output that is checked in, which
 * means nothing re-derives them on the way to production: whatever is in the
 * repo is what `convex/preloadPlayers.ts` writes into `teams` and `players`.
 * So they get the same treatment as source — a test that reads them and
 * asserts the properties the loader relies on.
 *
 * Scale assertions (20k / 30k players) are deliberately loose. They are not
 * measuring the datasets, they are catching the failure that would otherwise
 * be silent: a regenerate against a truncated or half-downloaded raw input,
 * which produces a perfectly valid file with a tenth of the rows in it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

import type { PreloadFile } from "./preload-shape";

const DIR = path.resolve(import.meta.dirname, "../../../data/preload");

function load(name: string): PreloadFile {
  return JSON.parse(readFileSync(path.join(DIR, name), "utf8"));
}

const MLB = load("mlb.json");
const NFL = load("nfl.json");

const cases: Array<[string, PreloadFile, number, number]> = [
  ["mlb.json", MLB, 20_000, 100],
  ["nfl.json", NFL, 30_000, 80],
];

describe.each(cases)("%s", (fileName, file, minPlayers, minTeams) => {
  test("has the source block, with a licence and a generated date", () => {
    expect(file.source.name).toBeTruthy();
    expect(file.source.licence).toMatch(/^CC-BY/);
    expect(file.source.url).toMatch(/^https:\/\//);
    expect(file.source.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(file.source.notes?.length ?? 0).toBeGreaterThan(0);
  });

  test("is big enough to be the whole dataset", () => {
    expect(file.players.length).toBeGreaterThanOrEqual(minPlayers);
    expect(file.teams.length).toBeGreaterThanOrEqual(minTeams);
    expect(file.leagues.length).toBeGreaterThan(0);
  });

  test("is compact — no pretty-printing in a committed multi-megabyte file", () => {
    const raw = readFileSync(path.join(DIR, fileName), "utf8");
    expect(raw).not.toContain("\n  ");
    // …and still under the Convex bundle budget with room to spare.
    expect(statSync(path.join(DIR, fileName)).size).toBeLessThan(8 * 1024 * 1024);
  });

  test("teams: unique names, a location/nickname that rebuilds the name", () => {
    const names = new Set<string>();
    for (const team of file.teams) {
      expect(team.name).toBeTruthy();
      // Duplicated names cannot both exist: NB dedupes teams on
      // (nameNormalized, sportId), so the loader would adopt the first and
      // silently drop the second's years.
      expect(names.has(team.name)).toBe(false);
      names.add(team.name);

      const rebuilt = team.location ? `${team.location} ${team.nickname}` : team.nickname;
      expect(rebuilt).toBe(team.name);
      expect(team.nickname).not.toBe("");
      expect(team.franchise).not.toBe("");
      expect(team.key).toMatch(/^[a-z0-9-]+$/);
    }
  });

  test("teams: years are sane and `to` is absent for an active team", () => {
    for (const team of file.teams) {
      expect(team.from).toBeGreaterThanOrEqual(1871);
      expect(team.from).toBeLessThanOrEqual(2030);
      if (team.to !== undefined) expect(team.to).toBeGreaterThanOrEqual(team.from);
    }
    // At least one row must be open-ended, or the "still active" branch is dead.
    expect(file.teams.some((t) => t.to === undefined)).toBe(true);
  });

  test("teams: every league code points at a declared league", () => {
    const codes = new Set(file.leagues.map((l) => l.code));
    for (const team of file.teams) expect(codes.has(team.league)).toBe(true);
  });

  test("leagues: exactly one is the sport's own default", () => {
    // More than one and the loader would route two codes through
    // `resolveDefaultLeagueId`, collapsing distinct historical leagues onto
    // the sport's league row.
    expect(file.leagues.filter((l) => l.default).length).toBe(1);
    const codes = file.leagues.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("players: unique ids, a name, and at least one stint", () => {
    const ids = new Set<string>();
    for (const p of file.players) {
      expect(p.id).toBeTruthy();
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(p.name.trim()).not.toBe("");
      expect(p.stints.length).toBeGreaterThan(0);
    }
  });

  test("players: every stint indexes a real team, earliest first", () => {
    for (const p of file.players) {
      let previousFrom = -Infinity;
      for (const [teamIndex, from, to] of p.stints) {
        expect(Number.isInteger(teamIndex)).toBe(true);
        expect(teamIndex).toBeGreaterThanOrEqual(0);
        expect(teamIndex).toBeLessThan(file.teams.length);
        expect(from).toBeLessThanOrEqual(to);
        expect(from).toBeGreaterThanOrEqual(1871);
        expect(to).toBeLessThanOrEqual(2030);
        expect(from).toBeGreaterThanOrEqual(previousFrom);
        previousFrom = from;
      }
    }
  });

  test("players: a birth year, when present, is plausible", () => {
    for (const p of file.players) {
      if (p.birthYear === undefined) continue;
      expect(p.birthYear).toBeGreaterThan(1820);
      expect(p.birthYear).toBeLessThan(2020);
    }
  });

  test("players: sorted by id, so a regenerate diffs cleanly", () => {
    const ids = file.players.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("players: no stint runs longer than the loader's cap would allow", () => {
    // The loader caps `teamYears` at 64 and reports truncation. If a real
    // career ever approached that, the cap would start silently shaping data
    // rather than guarding against a runaway.
    const worst = Math.max(...file.players.map((p) => p.stints.length));
    expect(worst).toBeLessThan(64);
  });
});

describe("who may import these files", () => {
  test("only convex/preloadPlayers.ts does", () => {
    // Convex bundles per module against a 32 MiB cap, and these two are 5.9 MB
    // together. A second importer silently puts the whole card dataset into an
    // unrelated function's bundle — which is not a build error, just a slower
    // deploy and a fatter function, so nothing else would catch it.
    const root = path.resolve(import.meta.dirname, "../../..");
    let out = "";
    try {
      out = execFileSync(
        "git",
        [
          "grep",
          "-l",
          "--untracked",
          "-E",
          // An IMPORT specifically. The generator names these paths in its
          // docblock because it WRITES them, which is not the same thing.
          'from "[^"]*data/preload/(mlb|nfl)[.]json"',
          "--",
          "*.ts",
          "*.tsx",
          "*.mjs",
        ],
        { cwd: root, encoding: "utf8" },
      );
    } catch {
      // `git grep` exits 1 when nothing matches, which cannot happen here (the
      // loader itself matches) but must not read as a pass either.
      out = "";
    }
    const importers = out.split("\n").filter(Boolean).sort();
    expect(importers).toEqual(["convex/preloadPlayers.ts"]);
  });
});

describe("mlb.json specifics", () => {
  test("the Negro Leagues are absent, and the exclusion is stated in the file", () => {
    // The whole reason those rows were left out — see data/preload/README.md.
    const names = new Set(MLB.teams.map((t) => t.name));
    for (const n of [
      "Pittsburgh Crawfords",
      "Homestead Grays",
      "Kansas City Monarchs",
      "Chicago American Giants",
      "Newark Eagles",
    ]) {
      expect(names.has(n)).toBe(false);
    }
    expect(MLB.source.notes?.join(" ")).toContain("EXCLUDED");
  });

  test("one row per historical name, linked by franchise", () => {
    const byName = new Map(MLB.teams.map((t) => [t.name, t]));
    const expos = byName.get("Montreal Expos");
    const nats = byName.get("Washington Nationals");
    expect(expos?.to).toBe(2004);
    expect(nats?.to).toBeUndefined();
    expect(expos?.franchise).toBe(nats?.franchise);

    const indians = byName.get("Cleveland Indians");
    const guardians = byName.get("Cleveland Guardians");
    expect(indians?.to).toBe(2021);
    expect(guardians?.from).toBe(2022);
    expect(indians?.franchise).toBe(guardians?.franchise);
  });

  test("Hall of Famers are marked, and only some of them", () => {
    const hof = MLB.players.filter((p) => p.hof);
    expect(hof.length).toBeGreaterThan(200);
    expect(hof.length).toBeLessThan(MLB.players.length / 10);
    expect(MLB.players.find((p) => p.id === "gwynnto01")?.hof).toBe(true);
  });

  test("the source ids are Lahman playerIDs", () => {
    expect(MLB.players.every((p) => /^[a-z0-9.'-]+$/i.test(p.id))).toBe(true);
    expect(MLB.players.some((p) => p.id === "ruthba01")).toBe(true);
  });
});

describe("nfl.json specifics", () => {
  test("ids are a gsis id or an explicit name key", () => {
    for (const p of NFL.players) {
      expect(/^\d{2}-\d{7}$/.test(p.id) || p.id.startsWith("name:")).toBe(true);
    }
    expect(NFL.players.some((p) => /^\d{2}-\d{7}$/.test(p.id))).toBe(true);
  });

  test("NO id carries a full date of birth", () => {
    // Security review. `nflverseId` is written to `players.externalIds`, which
    // the public player queries return, and it is committed here in a public
    // repo. A date of birth for 14,000 named people is personal data neither
    // NB nor the loader needs; the birth YEAR plus an ordinal does the same
    // job. The birth date groups rows inside the generator and stops there.
    const leaked = NFL.players.filter((p) => /\d{4}-\d{2}-\d{2}/.test(p.id));
    expect(leaked.map((p) => p.id)).toEqual([]);
    // …and the same for baseball, whose ids are opaque Lahman playerIDs.
    expect(MLB.players.filter((p) => /\d{4}-\d{2}-\d{2}/.test(p.id))).toEqual([]);
  });

  test("every name key carries a birth year or a first season, plus an ordinal", () => {
    const nameKeys = NFL.players.filter((p) => p.id.startsWith("name:"));
    expect(nameKeys.length).toBeGreaterThan(10_000);
    for (const p of nameKeys) {
      expect(p.id).toMatch(/^name:[a-z0-9-]+\|(b\d{4}|s\d{4})#\d+$/);
      // A `b` key states the year it names; an `s` key has no birth year at all.
      const dated = /\|b(\d{4})#/.exec(p.id);
      if (dated) expect(p.birthYear).toBe(Number(dated[1]));
      else expect(p.birthYear).toBeUndefined();
    }
    // The ordinal earns its place: some names really do collide within a year.
    expect(nameKeys.some((p) => /#[2-9]\d*$/.test(p.id))).toBe(true);
  });

  test("only name-keyed players can be low confidence, and few are", () => {
    const low = NFL.players.filter((p) => p.lowConfidence);
    expect(low.length).toBeGreaterThan(0);
    expect(low.length).toBeLessThan(500);
    for (const p of low) {
      // Keyed on the FIRST SEASON of one run, never a birth year.
      expect(p.id).toMatch(/^name:[a-z0-9-]+\|s\d{4}#\d+$/);
      // No birth date is exactly why they are flagged.
      expect(p.birthYear).toBeUndefined();
    }
  });

  test("a low-confidence player is one run on ONE team, never a merged career", () => {
    // Security review: grouping these by name alone folded two different
    // people — "Don Smith" was a 1929 Orange Tornadoes lineman and a 1930
    // Newark back — into a single row with a two-team "career".
    for (const p of NFL.players) {
      if (!p.lowConfidence) continue;
      expect(p.stints).toHaveLength(1);
      const [teamIndex, from] = p.stints[0];
      expect(Number.isInteger(teamIndex)).toBe(true);
      // The id names the run's first season, so it actually discriminates.
      expect(p.id.endsWith(`|s${from}#1`) || /\|s\d{4}#\d+$/.test(p.id)).toBe(true);
      expect(p.id).toContain(`|s${from}#`);
    }
  });

  test("carries the leagues nflverse spans, with the NFL as the default", () => {
    const codes = NFL.leagues.map((l) => l.code).sort();
    expect(codes).toEqual(["AAFC", "AFL", "APFA", "NFL"]);
    expect(NFL.leagues.find((l) => l.default)?.code).toBe("NFL");
  });
});
