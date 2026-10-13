import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { contentDigest } from "../client/target";
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

  test("NEO-331: a league create carries a level from the schema's union; a link or skip carries none", () => {
    const withLeagues = (leagues: unknown[]) => {
      const spec = structuredClone(minimal) as unknown as {
        steps: Array<{ base?: { checklist: { review: { leagues: unknown[] } } } }>;
      };
      spec.steps[1].base!.checklist.review.leagues = leagues;
      return spec;
    };
    const ok = parseSpec(withLeagues([{ name: "Northwest League", decision: "create", level: "minor" }]));
    const set = ok.steps[1];
    if (set.kind !== "set" || !set.base?.checklist || set.base.checklist.review === "none-expected") {
      throw new Error("expected review answers");
    }
    expect(set.base.checklist.review.leagues).toEqual([{ name: "Northwest League", decision: "create", level: "minor" }]);

    const issues = (leagues: unknown[]) => {
      try {
        parseSpec(withLeagues(leagues));
      } catch (err) {
        expect(err).toBeInstanceOf(SpecError);
        return (err as SpecError).issues;
      }
      throw new Error("expected SpecError");
    };
    expect(issues([{ name: "Northwest League", decision: "create" }])).toEqual([
      expect.objectContaining({ path: "steps[1].base.checklist.review.leagues[0].level", message: expect.stringMatching(/needs a level/) }),
    ]);
    // The stored value, not the button's label.
    expect(issues([{ name: "Northwest League", decision: "create", level: "Minor" }])[0].path).toBe(
      "steps[1].base.checklist.review.leagues[0].level",
    );
    expect(issues([{ name: "Northwest League", decision: "create", level: "triple-a" }])[0].path).toBe(
      "steps[1].base.checklist.review.leagues[0].level",
    );
    expect(issues([{ name: "MLB", decision: { link: "MLB" }, level: "major" }])[0].message).toMatch(/only read on a "create"/);
    expect(issues([{ name: "MLB", decision: "skip", level: "major" }])[0].message).toMatch(/only read on a "create"/);
  });

  test("NEO-339: a player link may carry a birthYear; a team or league link may not", () => {
    const withReview = (review: Record<string, unknown[]>) => {
      const spec = structuredClone(minimal) as unknown as {
        steps: Array<{ base?: { checklist: { review: Record<string, unknown[]> } } }>;
      };
      spec.steps[1].base!.checklist.review = { players: [], teams: [], leagues: [], ...review };
      return spec;
    };
    const ok = parseSpec(withReview({ players: [{ name: "Jose Rodriguez", decision: { link: "Jose Rodriguez", birthYear: 2001 } }] }));
    const set = ok.steps[1];
    if (set.kind !== "set" || !set.base?.checklist || set.base.checklist.review === "none-expected") {
      throw new Error("expected review answers");
    }
    expect(set.base.checklist.review.players).toEqual([{ name: "Jose Rodriguez", decision: { link: "Jose Rodriguez", birthYear: 2001 } }]);
    // Without birthYear, a player link parses exactly as before.
    expect(() => parseSpec(withReview({ players: [{ name: "Jose Rodriguez", decision: { link: "Jose Rodriguez" } }] }))).not.toThrow();

    const pathOf = (review: Record<string, unknown[]>) => {
      try {
        parseSpec(withReview(review));
      } catch (err) {
        expect(err).toBeInstanceOf(SpecError);
        return (err as SpecError).issues[0].path;
      }
      throw new Error("expected SpecError");
    };
    expect(pathOf({ players: [{ name: "J R", decision: { link: "J R", birthYear: 2001.5 } }] })).toMatch(/^steps\[1\]\.base\.checklist\.review\.players\[0\]\.decision/);
    // A wrong TYPE fails the whole review union (zod reports it on the union's path); still refused.
    expect(pathOf({ players: [{ name: "J R", decision: { link: "J R", birthYear: "2001" } }] })).toMatch(/^steps\[1\]\.base\.checklist\.review/);
    expect(pathOf({ players: [{ name: "J R", decision: { link: "J R", birthYear: 1 } }] })).toMatch(/^steps\[1\]\.base\.checklist\.review\.players\[0\]\.decision/);
    // Strict: birthYear is a player's key only.
    expect(pathOf({ teams: [{ name: "Mariners", decision: { link: "Seattle Mariners", birthYear: 1977 } }] })).toMatch(/^steps\[1\]\.base\.checklist\.review\.teams\[0\]\.decision/);
    expect(pathOf({ leagues: [{ name: "MLB", decision: { link: "MLB", birthYear: 1903 } }] })).toMatch(/^steps\[1\]\.base\.checklist\.review\.leagues\[0\]\.decision/);
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

  test("NEO-339 one-shot: group (names and marketplace-id refs) and an insert's parallels parse", () => {
    const withGroup = structuredClone(minimal) as unknown as { steps: Array<{ variants?: Array<Record<string, unknown>> }> };
    const insert = withGroup.steps[1].variants![0];
    insert.group = {
      parents: [
        { insert: "Chrome Prospect Autographs", parallels: ["Chrome Prospect Autographs Gold", { bsc: "cpa-red" }, { sportlots: "378117" }] },
        { insert: { bsc: "future-stars" }, parallels: [{ sportlots: "9003" }] },
      ],
      expectUngrouped: 12,
    };
    (insert.rows as Array<Record<string, unknown>>)[0].parallels = [
      { name: "Future Stars Gold", build: { rebuild: true }, expectCards: 20 },
      { name: "Future Stars Red" },
    ];
    const spec = parseSpec(withGroup);
    const set = spec.steps[1];
    if (set.kind !== "set") throw new Error("expected a set step");
    expect(set.variants![0].group!.parents[0].parallels).toEqual(["Chrome Prospect Autographs Gold", { bsc: "cpa-red" }, { sportlots: "378117" }]);
    expect(set.variants![0].rows![0].parallels).toEqual([
      { name: "Future Stars Gold", build: { rebuild: true }, expectCards: 20 },
      { name: "Future Stars Red" },
    ]);
  });

  test.each([
    ["a ref with both ids", { parents: [{ insert: { bsc: "a", sportlots: "b" }, parallels: ["x"] }] }],
    ["a ref by an unknown key", { parents: [{ insert: { name: "a" }, parallels: ["x"] }] }],
    ["a parent with no parallels", { parents: [{ insert: "a", parallels: [] }] }],
    ["a blank name", { parents: [{ insert: "  ", parallels: ["x"] }] }],
    ["a misspelt key", { parents: [], expectUngroupd: 3 }],
  ])("group refuses %s", (_label, group) => {
    const bad = structuredClone(minimal) as unknown as { steps: Array<{ variants?: Array<Record<string, unknown>> }> };
    bad.steps[1].variants![0].group = group;
    expect(() => parseSpec(bad)).toThrow(SpecError);
  });

  test("an insert parallel's keys are strict too", () => {
    const bad = structuredClone(minimal) as unknown as { steps: Array<{ variants?: Array<{ rows?: Array<Record<string, unknown>> }> }> };
    bad.steps[1].variants![0].rows![0].parallels = [{ name: "Gold", buildFromBase: {} }];
    expect(() => parseSpec(bad)).toThrow(SpecError);
  });

  test("every committed seed spec still parses, unchanged by the new keys", () => {
    const dir = join(__dirname, "../../../.maestro/seed");
    for (const file of ["baseline.spec.json", "parallel.spec.json"]) {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const spec = parseSpec(raw);
      // The new keys carry no defaults, so a spec without them parses to the
      // same object (and the same confirm-phrase digest) as before them.
      expect(JSON.stringify(spec), file).not.toMatch(/"group"|"parallels"|"expectUngrouped"/);
      expect(contentDigest(parseSpec(JSON.parse(JSON.stringify(spec)))), file).toBe(contentDigest(spec));
    }
  });

  test("exports a JSON Schema for the spec", () => {
    const schema = specJsonSchema();
    expect(JSON.stringify(schema)).toContain("whenPaused");
    expect(JSON.stringify(schema)).toContain("expectUngrouped");
    // NEO-331: the league level's union reaches the JSON Schema too.
    expect(JSON.stringify(schema)).toContain("independent");
  });
});
