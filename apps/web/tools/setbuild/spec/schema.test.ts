import { describe, expect, test } from "vitest";
import { parseSpec, parseSpecJson, SpecError, specJsonSchema } from "./schema";

const minimal = {
  version: 1,
  scope: "e2e-baseline",
  credentials: { seed: ["buysportscards", "sportlots"], warm: true },
  rootSync: true,
  steps: [
    {
      kind: "brand-year",
      path: { sport: "Baseball", year: "2026", manufacturer: "Bowman" },
      manufacturer: { whenMissing: "create" },
      syncSets: true,
      slReview: {
        decisions: [
          { slId: "101", placement: "own-set" },
          { slId: "102", set: "Bowman", variantType: "Parallel", name: "Blue" },
        ],
      },
    },
    {
      kind: "set",
      path: { sport: "Baseball", year: "2024", manufacturer: "Topps", set: "Topps Chrome" },
      variantTypes: { sync: true },
      base: {
        map: { bsc: "2024-topps-chrome", sportlots: "884412", whenPaused: "bsc-only" },
        checklist: {
          pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" },
          review: {
            players: [{ name: "Shohei Ohtani", decision: "create" }],
            teams: [{ name: "Seattle Mariners", decision: "create", location: "Seattle", league: "MLB" }],
            leagues: [{ name: "MLB", decision: { link: "MLB" } }],
          },
          expectCards: 335,
        },
      },
      variants: [
        {
          type: "Insert",
          sync: {
            pairs: [{ name: "Future Stars", bsc: ["future-stars"], sportlots: ["9001"] }],
            pending: [{ side: "sportlots", id: "9002", decision: "leave" }],
          },
          rows: [{ name: "Future Stars", checklist: { pairing: { unmatchedBsc: "drop", unmatchedSportlots: "drop" }, review: "none-expected", expectCards: 20 } }],
        },
        { type: "Parallel", rows: [{ name: "Gold Wave", buildFromBase: {}, expectCards: 300 }] },
      ],
    },
  ],
};

describe("SetBuildSpec", () => {
  test("parses a spec using every step shape, and fills the defaults", () => {
    const spec = parseSpec(minimal);
    expect(spec.steps).toHaveLength(2);
    const set = spec.steps[1];
    if (set.kind !== "set") throw new Error("expected a set step");
    expect(set.variants?.[0].sync?.pairs[0].bsc).toEqual(["future-stars"]);
    // `review` arrays default to empty when a block omits one.
    const reviewOnlyPlayers = parseSpec({
      ...minimal,
      steps: [
        {
          ...minimal.steps[1],
          base: {
            map: { bsc: "x", whenPaused: "skip" },
            checklist: { pairing: { unmatchedBsc: "keep", unmatchedSportlots: "keep" }, review: { players: [] } },
          },
          variants: undefined,
        },
      ],
    });
    const step = reviewOnlyPlayers.steps[0];
    if (step.kind !== "set" || !step.base?.checklist || step.base.checklist.review === "none-expected") {
      throw new Error("expected review answers");
    }
    expect(step.base.checklist.review.teams).toEqual([]);
  });

  test("a misspelt key is a parse error naming its path, never ignored", () => {
    const bad = structuredClone(minimal) as unknown as { steps: Array<{ base?: { map: Record<string, unknown> } }> };
    bad.steps[1].base!.map.whenPasued = "skip";
    try {
      parseSpec(bad);
      throw new Error("expected SpecError");
    } catch (err) {
      expect(err).toBeInstanceOf(SpecError);
      expect((err as SpecError).issues.map((i) => i.path)).toContain("steps[1].base.map");
    }
  });

  test("refuses a reconcile pair with no id and a conflict answer with no card ref", () => {
    const noIds = structuredClone(minimal) as unknown as {
      steps: Array<{ variants?: Array<{ sync?: { pairs: Array<Record<string, unknown>> } }> }>;
    };
    noIds.steps[1].variants![0].sync!.pairs = [{ name: "Nothing" }];
    expect(() => parseSpec(noIds)).toThrow(/at least one marketplace id/);

    const noRef = structuredClone(minimal) as unknown as {
      steps: Array<{ base?: { checklist: { pairing: Record<string, unknown> } } }>;
    };
    noRef.steps[1].base!.checklist.pairing.conflicts = [{ field: "players", choose: "bsc" }];
    expect(() => parseSpec(noRef)).toThrow(/card ref/);
  });

  test("an SL decision is own-set or filed under a set's type, nothing in between", () => {
    const half = structuredClone(minimal) as unknown as {
      steps: Array<{ slReview?: { decisions: Array<Record<string, unknown>> } }>;
    };
    half.steps[0].slReview!.decisions = [{ slId: "1", set: "Bowman" }];
    expect(() => parseSpec(half)).toThrow(SpecError);
  });

  test("version, scope and step kind are required", () => {
    expect(() => parseSpec({ ...minimal, version: 2 })).toThrow(SpecError);
    expect(() => parseSpec({ ...minimal, scope: "  " })).toThrow(SpecError);
    expect(() => parseSpec({ ...minimal, steps: [{ kind: "card" }] })).toThrow(SpecError);
  });

  test("bad JSON is a SpecError too", () => {
    expect(() => parseSpecJson("{ nope")).toThrow(/not JSON/);
    expect(parseSpecJson(JSON.stringify(minimal)).scope).toBe("e2e-baseline");
  });

  test("exports a JSON Schema for the spec", () => {
    const schema = specJsonSchema();
    expect(JSON.stringify(schema)).toContain("whenPaused");
  });
});
