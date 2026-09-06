/**
 * NEO-236 — the pure half of the team name split.
 *
 * The cases that matter here are the ones that decide whether the split is
 * SAFE to roll out a row at a time, not the pretty-printing:
 *
 *  - `teamFullName` must never introduce or drop a space, because its output
 *    is what `normalizeTeamName` keys the whole `teams` table on.
 *  - `splitTeamName` must never split on a partial word, because a split that
 *    lands mid-token ("Sa" | "n Diego Padres") produces a `name` no operator
 *    typed and no marketplace would recognise.
 *  - and the round-trip invariant, asserted directly:
 *      normalizeTeamName(teamFullName(split)) === normalizeTeamName(full)
 *
 * `normalizeEntityName` (convex/lib/entityNearMatch.ts) is imported rather
 * than `normalizeTeamName` (convex/teams.ts) because the latter's module
 * imports `_generated/server`; the former is a documented verbatim copy whose
 * parity with it is asserted in `convex/lib/entityNearMatch.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { normalizeEntityName } from "../../convex/lib/entityNearMatch";
import { splitTeamName, teamFullName, teamShortName } from "./team-name";

describe("teamFullName", () => {
  test("joins location and name with a single space", () => {
    expect(teamFullName({ name: "Padres", location: "San Diego" })).toBe(
      "San Diego Padres",
    );
  });

  test("returns the bare name when there is no location", () => {
    // All four spellings of "no location" a row can carry.
    expect(teamFullName({ name: "Aztecs" })).toBe("Aztecs");
    expect(teamFullName({ name: "Aztecs", location: undefined })).toBe("Aztecs");
    expect(teamFullName({ name: "Aztecs", location: null })).toBe("Aztecs");
    expect(teamFullName({ name: "Aztecs", location: "" })).toBe("Aztecs");
  });

  test("a whitespace-only location is treated as absent, not as a space", () => {
    expect(teamFullName({ name: "Aztecs", location: "   " })).toBe("Aztecs");
  });

  test("never double-spaces, however the parts are padded", () => {
    expect(teamFullName({ name: "  Padres  ", location: "  San Diego  " })).toBe(
      "San Diego Padres",
    );
  });

  test("carries multi-word locations that are not cities", () => {
    // The reason the field is `location` and not `city`.
    expect(teamFullName({ name: "Buccaneers", location: "Tampa Bay" })).toBe(
      "Tampa Bay Buccaneers",
    );
    expect(teamFullName({ name: "Patriots", location: "New England" })).toBe(
      "New England Patriots",
    );
    expect(teamFullName({ name: "Warriors", location: "Golden State" })).toBe(
      "Golden State Warriors",
    );
  });
});

describe("teamShortName", () => {
  test("is the name, with or without a location", () => {
    expect(teamShortName({ name: "Padres", location: "San Diego" })).toBe(
      "Padres",
    );
    expect(teamShortName({ name: "Aztecs" })).toBe("Aztecs");
  });

  test("trims", () => {
    expect(teamShortName({ name: "  Padres  " })).toBe("Padres");
  });
});

describe("splitTeamName", () => {
  test("splits on a whole-word prefix", () => {
    expect(splitTeamName("San Diego Padres", "San Diego")).toEqual({
      location: "San Diego",
      name: "Padres",
    });
  });

  /**
   * NEO-236 security review — the caller's spelling decides WHERE to cut, not
   * what the pieces read as.
   *
   * Returning the argument would let ESPN's house style rewrite a stored name:
   * splitting our "St Louis Blues" on their "St. Louis" would re-punctuate the
   * row, and this case would re-case it. `applyEnrichmentInternal` writes both
   * halves straight back onto the row, so the split has to be a pure
   * rearrangement of the string we already hold.
   */
  test("matches case-insensitively but returns OUR spelling of the location", () => {
    expect(splitTeamName("SAN DIEGO PADRES", "san diego")).toEqual({
      location: "SAN DIEGO",
      name: "PADRES",
    });
  });

  test("a punctuation difference is not a match at all — the strict split refuses", () => {
    // The real case: ESPN answers "St. Louis"; our row says "St Louis". This
    // comparison is character-exact apart from case, so the period makes it a
    // MISS and the row is left whole — which is the conservative answer for
    // the background enrichment path, the only caller of this function.
    //
    // The operator-run migration (`convex/splitTeamLocations.ts`) does accept
    // this pair, through its own word-boundary equivalence fallback, and that
    // one likewise returns our spelling. The looser match is sanctioned there
    // because a human runs it and reads its report; it is deliberately NOT
    // available to a background writer.
    expect(splitTeamName("St Louis Blues", "St. Louis")).toBeNull();
  });

  test("trims and collapses whitespace on both sides", () => {
    expect(splitTeamName("  San   Diego   Padres  ", "  San Diego  ")).toEqual({
      location: "San Diego",
      name: "Padres",
    });
  });

  test("a shorter whole-word prefix is a valid mechanical split", () => {
    // "San" IS a whole word at the front of the name. Whether this split is
    // the RIGHT one is the caller's judgement, not this function's.
    expect(splitTeamName("San Diego Padres", "San")).toEqual({
      location: "San",
      name: "Diego Padres",
    });
  });

  test("a partial word is not a prefix", () => {
    expect(splitTeamName("San Diego Padres", "Sa")).toBeNull();
    expect(splitTeamName("San Diego Padres", "San Die")).toBeNull();
  });

  test("returns null when the location is not at the front", () => {
    expect(splitTeamName("Los Angeles Angels", "Anaheim")).toBeNull();
    expect(splitTeamName("Los Angeles Angels", "Angels")).toBeNull();
  });

  test("returns null when nothing would be left for the name", () => {
    expect(splitTeamName("San Diego Padres", "San Diego Padres")).toBeNull();
    expect(splitTeamName("Padres", "Padres")).toBeNull();
  });

  test("returns null for an empty or whitespace-only input", () => {
    expect(splitTeamName("San Diego Padres", "")).toBeNull();
    expect(splitTeamName("San Diego Padres", "   ")).toBeNull();
    expect(splitTeamName("", "San Diego")).toBeNull();
    expect(splitTeamName("   ", "San Diego")).toBeNull();
  });

  test("splits a name longer than the franchise — mechanically, as documented", () => {
    // Deliberately locked in: a caller reviewing college sides must not
    // assume this function protected them from an odd-looking split.
    expect(splitTeamName("San Diego State Aztecs baseball", "San Diego")).toEqual(
      { location: "San Diego", name: "State Aztecs baseball" },
    );
  });
});

describe("the dedup-key invariant", () => {
  // This is the whole reason the split is a safe migration: `normalizeTeamName`
  // token-SORTS, so moving a leading word from `name` into `location` cannot
  // change `nameNormalized`. A split row and an unsplit row still collide on
  // the same key, which is what keeps `findOrCreate` idempotent mid-rollout.
  const cases: Array<[string, string]> = [
    ["San Diego Padres", "San Diego"],
    ["Tampa Bay Buccaneers", "Tampa Bay"],
    ["New England Patriots", "New England"],
    ["Golden State Warriors", "Golden State"],
    ["St. Louis Cardinals", "St. Louis"],
    ["Toronto Blue Jays", "Toronto"],
    ["Wilkes-Barre/Scranton Penguins", "Wilkes-Barre/Scranton"],
  ];

  test.each(cases)(
    "normalizeTeamName(teamFullName(split(%s))) is unchanged",
    (full, location) => {
      const split = splitTeamName(full, location);
      expect(split).not.toBeNull();
      expect(normalizeEntityName(teamFullName(split!))).toBe(
        normalizeEntityName(full),
      );
    },
  );

  test("holds for a row that was never split", () => {
    expect(normalizeEntityName(teamFullName({ name: "Aztecs" }))).toBe(
      normalizeEntityName("Aztecs"),
    );
  });
});
