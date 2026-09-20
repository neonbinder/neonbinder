/**
 * NEO-289 — the COMMITTED recording, `adapters/__fixtures__/enrichment-lookups.json`.
 *
 * `enrichmentFixtures.test.ts` proves the reader with fixtures it builds
 * itself; this file proves the one that ships. Every entry must be
 * self-consistent with `fixtureKey` (the capture and the reader share that
 * normaliser, and a hand edit that breaks the key is a silent miss at
 * runtime), every recorded id must be a real `Q<digits>`, and the live-proof
 * player must NOT be in it — that flow exists to prove the live lane still
 * works, and a recording would prove nothing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isWikidataQid } from "../lib/players/wikidata-id";
import {
  FIXTURE_VERSION,
  fixtureKey,
  getEnrichmentFixture,
  parseFixtureFile,
  type EnrichmentFixtureEntry,
} from "./adapters/enrichmentFixtures";

const FIXTURE_PATH = join(__dirname, "adapters", "__fixtures__", "enrichment-lookups.json");

/**
 * The player the `admin/player-live-wikidata-enrichment` flow adds to prove
 * the live lane. Baseball, and deliberately absent from every seeded set so
 * no other flow confirms the name through the wizard.
 */
const LIVE_PROOF_PLAYER = "Harmon Killebrew";

function readCommitted(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
}

/** Structural check of one recorded result against its kind's validator shape. */
function expectResultShape(entry: EnrichmentFixtureEntry): void {
  if (entry.result === null) return;
  const result = entry.result as Record<string, unknown>;
  const optionalString = (key: string) => {
    if (result[key] !== undefined) expect(typeof result[key], `${entry.name}.${key}`).toBe("string");
  };
  const optionalYears = (key: string) => {
    const years = result[key] as { from?: unknown; to?: unknown } | undefined;
    if (years === undefined) return;
    expect(typeof years.from, `${entry.name}.${key}.from`).toBe("number");
    if (years.to !== undefined) expect(typeof years.to, `${entry.name}.${key}.to`).toBe("number");
  };
  switch (entry.kind) {
    case "player": {
      expect(typeof result.wikidataId, `${entry.name}.wikidataId`).toBe("string");
      expect(Array.isArray(result.careerTeams), `${entry.name}.careerTeams`).toBe(true);
      for (const ct of result.careerTeams as Array<Record<string, unknown>>) {
        expect(typeof ct.name).toBe("string");
        expect(typeof ct.fromYear).toBe("number");
        if (ct.toYear !== undefined) expect(typeof ct.toYear).toBe("number");
        if (ct.wikidataId !== undefined) expect(isWikidataQid(String(ct.wikidataId))).toBe(true);
      }
      if (result.undatedCareerTeams !== undefined) {
        expect(Array.isArray(result.undatedCareerTeams)).toBe(true);
      }
      if (result.isHallOfFame !== undefined) expect(typeof result.isHallOfFame).toBe("boolean");
      optionalString("description");
      if (result.birthYear !== undefined) expect(typeof result.birthYear).toBe("number");
      optionalString("enwikiTitle");
      expect(Object.keys(result).every((k) => PLAYER_KEYS.has(k)), `${entry.name} unknown keys`).toBe(true);
      return;
    }
    case "team": {
      optionalString("wikidataId");
      optionalString("league");
      optionalString("leagueWikidataId");
      if (result.leagueWikidataId !== undefined) {
        expect(isWikidataQid(String(result.leagueWikidataId))).toBe(true);
      }
      optionalString("location");
      optionalYears("yearsActive");
      optionalString("espnId");
      const colors = result.colors as Record<string, unknown> | undefined;
      if (colors !== undefined) {
        if (colors.primary !== undefined) expect(typeof colors.primary).toBe("string");
        if (colors.secondary !== undefined) expect(typeof colors.secondary).toBe("string");
      }
      expect(Object.keys(result).every((k) => TEAM_KEYS.has(k)), `${entry.name} unknown keys`).toBe(true);
      return;
    }
    case "league": {
      expect(typeof result.wikidataId, `${entry.name}.wikidataId`).toBe("string");
      optionalString("abbreviation");
      optionalYears("yearsActive");
      // `country` is context the live lookup returns and the recording drops.
      expect(Object.keys(result).every((k) => LEAGUE_KEYS.has(k)), `${entry.name} unknown keys`).toBe(true);
      return;
    }
  }
}

const PLAYER_KEYS = new Set([
  "wikidataId",
  "careerTeams",
  "undatedCareerTeams",
  "isHallOfFame",
  "description",
  "birthYear",
  "enwikiTitle",
]);
const TEAM_KEYS = new Set([
  "wikidataId",
  "league",
  "leagueWikidataId",
  "location",
  "yearsActive",
  "colors",
  "espnId",
]);
const LEAGUE_KEYS = new Set(["wikidataId", "abbreviation", "yearsActive"]);

describe("the committed enrichment fixture", () => {
  test("parses, is version 1, and is what the runtime loads", () => {
    const parsed = parseFixtureFile(readCommitted());
    expect(parsed.ok, parsed.ok ? "" : parsed.reason).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fixture.version).toBe(FIXTURE_VERSION);
    expect(parsed.fixture.sportQid).toMatch(/^Q\d+$/);
    // The module-level import sees the same file the test just read.
    const loaded = getEnrichmentFixture();
    expect(loaded?.sportQid).toBe(parsed.fixture.sportQid);
    expect(Object.keys(loaded?.entries ?? {}).length).toBe(Object.keys(parsed.fixture.entries).length);
  });

  test("every entry's key equals fixtureKey(kind, sportQid, name) and its ids are QIDs", () => {
    const parsed = parseFixtureFile(readCommitted());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { sportQid, entries } = parsed.fixture;
    for (const [key, entry] of Object.entries(entries)) {
      expect(key).toBe(fixtureKey(entry.kind, sportQid, entry.name));
      expect(entry.name.trim().length).toBeGreaterThan(0);
      if (entry.result?.wikidataId !== undefined) {
        expect(isWikidataQid(entry.result.wikidataId), `${key} wikidataId`).toBe(true);
      }
      expectResultShape(entry);
    }
  });

  test("entries are sorted by key, so a re-capture diffs cleanly", () => {
    const raw = readCommitted() as { entries: Record<string, unknown> };
    const keys = Object.keys(raw.entries);
    expect(keys).toEqual([...keys].sort());
  });

  test("the live-proof player is NOT recorded", () => {
    const parsed = parseFixtureFile(readCommitted());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fixture.entries[fixtureKey("player", parsed.fixture.sportQid, LIVE_PROOF_PLAYER)]).toBeUndefined();
  });

  test("carries names and lookup answers only — no credentials, URLs or deployment names", () => {
    const text = readFileSync(FIXTURE_PATH, "utf8");
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/convex\.cloud|convex\.site|\.run\.app/);
    expect(text).not.toMatch(/secret|password|token/i);
  });
});
