import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  clampSearchQuery,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_QUERY_MAX_TOKENS,
} from "./searchQueryClamp";

describe("clampSearchQuery (NEO-330)", () => {
  test("leaves a real name untouched, punctuation and all", () => {
    expect(clampSearchQuery("St. Louis Cardinals")).toBe("St. Louis Cardinals");
    expect(clampSearchQuery("  O'Neal  ")).toBe("  O'Neal  ");
    expect(clampSearchQuery("")).toBe("");
  });

  test("keeps at most the first 200 characters", () => {
    const out = clampSearchQuery("a".repeat(5000));
    expect(out).toHaveLength(SEARCH_QUERY_MAX_CHARS);
  });

  test("keeps at most the first 16 words", () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i}`);
    const out = clampSearchQuery(words.join(" "));
    expect(out).toBe(words.slice(0, SEARCH_QUERY_MAX_TOKENS).join(" "));
  });

  test("exactly 16 words is not cut, trailing punctuation included", () => {
    const text = `${Array.from({ length: 16 }, (_, i) => `w${i}`).join(" ")}.`;
    expect(clampSearchQuery(text)).toBe(text);
  });

  test("counts words split by punctuation, so a separator-only flood is bounded too", () => {
    // "a/b/c/…" is one whitespace token but many words to a normaliser that
    // turns "/" into a space; the clamp counts it the broader way.
    const out = clampSearchQuery(Array.from({ length: 50 }, () => "x").join("/"));
    expect(out.split("/")).toHaveLength(SEARCH_QUERY_MAX_TOKENS);
  });

  test("every typed-search handler clamps its query before using it", () => {
    // Pinned by source because the clamp only matters against a hostile
    // caller, and a handler that stopped calling it would pass every
    // behavioural test written with real names.
    const teams = readFileSync(join(__dirname, "..", "teams.ts"), "utf8");
    const players = readFileSync(join(__dirname, "..", "players.ts"), "utf8");
    for (const name of ["search", "searchForManagement"]) {
      const start = teams.indexOf(`export const ${name} = query({`);
      expect(start).toBeGreaterThan(-1);
      const body = teams.slice(start, teams.indexOf("\n});", start));
      expect(body).toContain("clampSearchQuery(args.query)");
      expect(body.split("args.query").length - 1).toBe(1);
    }
    const start = players.indexOf("export const search = query({");
    const body = players.slice(start, players.indexOf("\n});", start));
    expect(body).toContain("clampSearchQuery(args.query)");
    expect(body.split("args.query").length - 1).toBe(1);
  });
});
