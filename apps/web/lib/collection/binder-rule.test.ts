import { describe, expect, it } from "vitest";
import { ruleIds, ruleMatches, ruleProblem, yearOfSeason, type CardFacts, type StoredRule } from "./binder-rule";

const facts = (over: Partial<CardFacts> = {}): CardFacts => ({
  playerIds: new Set(["gooden"]),
  teamIds: new Set(["mets"]),
  playedForIds: new Set(["mets", "yankees"]),
  hallOfFame: false,
  sportId: "baseball",
  brandId: "topps-2024",
  setId: "chrome-2024",
  year: 2024,
  features: new Set(["RC"]),
  printRun: 50,
  ...over,
});

const rule = (match: "all" | "any", ...terms: StoredRule["terms"]): StoredRule => ({ version: 1, match, terms });

describe("ruleMatches (NEO-362)", () => {
  it("all: every line must hold; any: one is enough", () => {
    const r = (m: "all" | "any") =>
      rule(m, { test: { kind: "player", playerIds: ["gooden"] } }, { test: { kind: "team", teamIds: ["yankees"] } });
    expect(ruleMatches(r("all"), facts())).toBe(false);
    expect(ruleMatches(r("any"), facts())).toBe(true);
  });

  it("not turns a line around", () => {
    const r = rule(
      "all",
      { test: { kind: "player", playerIds: ["gooden"] } },
      { negate: true, test: { kind: "feature", feature: "AU" } },
    );
    expect(ruleMatches(r, facts())).toBe(true);
    expect(ruleMatches(r, facts({ features: new Set(["AU"]) }))).toBe(false);
  });

  it("played for reads every team of the card's players, not just the jersey", () => {
    const r = rule("all", { test: { kind: "playedFor", teamIds: ["yankees"] } });
    expect(ruleMatches(r, facts())).toBe(true);
    expect(ruleMatches(rule("all", { test: { kind: "team", teamIds: ["yankees"] } }), facts())).toBe(false);
  });

  it("years and print runs are inclusive, and unnumbered never matches a print run", () => {
    expect(ruleMatches(rule("all", { test: { kind: "year", from: 2024, to: 2024 } }), facts())).toBe(true);
    expect(ruleMatches(rule("all", { test: { kind: "year", to: 2023 } }), facts())).toBe(false);
    expect(ruleMatches(rule("all", { test: { kind: "printRun", max: 50 } }), facts())).toBe(true);
    expect(ruleMatches(rule("all", { test: { kind: "printRun", max: 49 } }), facts())).toBe(false);
    expect(ruleMatches(rule("all", { test: { kind: "printRun", max: 99 } }), facts({ printRun: null }))).toBe(false);
  });

  it("an empty rule matches nothing", () => {
    expect(ruleMatches(rule("any"), facts())).toBe(false);
  });
});

describe("ruleProblem", () => {
  it("is null for a whole rule", () => {
    expect(ruleProblem(rule("all", { test: { kind: "hallOfFame" } }))).toBeNull();
  });

  it("says what is missing, in the collector's words", () => {
    expect(ruleProblem(rule("all"))).toMatch(/at least one line/);
    expect(ruleProblem(rule("all", { test: { kind: "player", playerIds: [] } }))).toMatch(/Pick a player/);
    expect(ruleProblem(rule("all", { test: { kind: "year" } }))).toMatch(/first year, a last year/);
    expect(ruleProblem(rule("all", { test: { kind: "year", from: 2000, to: 1990 } }))).toMatch(/Swap them/);
  });

  it("refuses a rule that only leaves things out", () => {
    expect(ruleProblem(rule("all", { negate: true, test: { kind: "hallOfFame" } }))).toMatch(/what to include/);
  });
});

describe("ruleIds and yearOfSeason", () => {
  it("collects the ids by table", () => {
    const r = rule(
      "any",
      { test: { kind: "player", playerIds: ["p1"] } },
      { test: { kind: "playedFor", teamIds: ["t1"] } },
      { test: { kind: "set", setIds: ["s1"] } },
      { test: { kind: "brand", brandIds: ["b1", "b2"] } },
    );
    expect(ruleIds(r)).toEqual({ players: ["p1"], teams: ["t1"], options: ["s1", "b1", "b2"] });
  });

  it("files a season under its first year", () => {
    expect(yearOfSeason("1996-97")).toBe(1996);
    expect(yearOfSeason("Unknown")).toBeNull();
  });
});
