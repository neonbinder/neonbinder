/**
 * NEO-212 — the pure ranking layer behind the entity review wizard's
 * "did you mean?" prompt.
 *
 * Two things are locked here, and they fail differently:
 *
 *   * **Normaliser parity.** `normalizeEntityName` is a hand copy of
 *     `normalizeTeamName` (convex/teams.ts) and `normalizePlayerName`
 *     (convex/players.ts), copied because this module must stay free of
 *     `_generated/server` so the browser can import it. A drift between the
 *     copy and the originals is silent at every layer: the wizard would dedupe
 *     a pasted list one way and the commit would write `nameNormalized` the
 *     other, so "will create 3" becomes 2 rows with no error anywhere. The
 *     parity cases below import the real server normalisers and assert
 *     character equality, which is the only place that drift can surface.
 *
 *   * **The match ladders.** These are the cases the ticket exists for —
 *     "Yankees" / "New York Yankees" / "NY Yankees" were three rows, and the
 *     wizard showed nothing before creating the third.
 */

import { describe, expect, test } from "vitest";
import {
  longestToken,
  nameTokens,
  normalizeEntityName,
  rankPlayerCandidates,
  rankTeamCandidates,
} from "./entityNearMatch";
import { normalizeTeamName } from "../teams";
import { normalizePlayerName } from "../players";

/** `{index, confidence}` is awkward to read in an expectation; names are not. */
function rankedTeamNames(
  query: string,
  candidates: { name: string }[],
): Array<[string, string]> {
  return rankTeamCandidates(query, candidates).map(({ index, confidence }) => [
    candidates[index].name,
    confidence,
  ]);
}

function rankedPlayerNames(
  query: string,
  candidates: { name: string }[],
): Array<[string, string]> {
  return rankPlayerCandidates(query, candidates).map(({ index, confidence }) => [
    candidates[index].name,
    confidence,
  ]);
}

describe("normalizeEntityName", () => {
  test("token-sorts, so word order stops mattering", () => {
    expect(normalizeEntityName("New York Yankees")).toBe(
      normalizeEntityName("Yankees, New York"),
    );
    expect(normalizeEntityName("New York Yankees")).toBe("new yankees york");
  });

  test("strips punctuation and collapses whitespace", () => {
    expect(normalizeEntityName("  St. Louis   Cardinals ")).toBe(
      "cardinals louis st",
    );
    expect(normalizeEntityName("O'Neal, Shaquille")).toBe("oneal shaquille");
    expect(normalizeEntityName("Green Bay (Packers)")).toBe("bay green packers");
  });

  test("keeps hyphens, so a hyphenated name stays one token", () => {
    expect(normalizeEntityName("Wilkes-Barre Barons")).toBe(
      "barons wilkes-barre",
    );
  });

  test("a punctuation-only name normalises to the empty key", () => {
    expect(normalizeEntityName("...")).toBe("");
    expect(normalizeEntityName("   ")).toBe("");
  });

  // The reason this file exists. If one of the three copies changes, this is
  // the check that says so — see the header.
  test.each([
    "New York Yankees",
    "Yankees, New York",
    "  St. Louis   Cardinals ",
    "O'Neal, Shaquille",
    "Ken Griffey Jr.",
    "Wilkes-Barre Barons",
    "D'Angelo Russell",
    "...",
  ])("parity with the server normalisers: %s", (fixture) => {
    expect(normalizeEntityName(fixture)).toBe(normalizeTeamName(fixture));
    expect(normalizeEntityName(fixture)).toBe(normalizePlayerName(fixture));
  });
});

describe("nameTokens", () => {
  test("preserves source order, unlike the sorted dedup key", () => {
    expect(nameTokens("New York Yankees")).toEqual(["new", "york", "yankees"]);
    expect(normalizeEntityName("New York Yankees")).toBe("new yankees york");
  });

  test("the last token is the surname — what the player fallback searches", () => {
    expect(nameTokens("Shohei Ohtani").at(-1)).toBe("ohtani");
    expect(nameTokens("S. Ohtani").at(-1)).toBe("ohtani");
  });

  test("an empty name yields no tokens", () => {
    expect(nameTokens("  ")).toEqual([]);
  });
});

describe("longestToken", () => {
  test("picks the distinctive token, not the leading city word", () => {
    expect(longestToken("New York Yankees")).toBe("yankees");
    expect(longestToken("Los Angeles Dodgers")).toBe("angeles");
  });

  test("ties resolve to the earlier token, deterministically", () => {
    expect(longestToken("Reds Cubs")).toBe("reds");
  });

  test("returns null when nothing survives normalisation", () => {
    expect(longestToken("...")).toBeNull();
  });
});

describe("rankTeamCandidates", () => {
  test("normalised equality is exact, whatever the word order", () => {
    expect(rankedTeamNames("Yankees, New York", [{ name: "New York Yankees" }]))
      .toEqual([["New York Yankees", "exact"]]);
  });

  // The bug: a nickname-only entry and the full club name were two rows.
  test("a nickname is close to the full club name (containment)", () => {
    expect(rankedTeamNames("yankees", [{ name: "New York Yankees" }])).toEqual([
      ["New York Yankees", "close"],
    ]);
  });

  // Containment cannot see this one — "NY Yankees" is not a substring of
  // "New York Yankees". The shared-token rung is what catches abbreviations.
  test("an abbreviated city is close via the shared token", () => {
    expect(rankedTeamNames("NY Yankees", [{ name: "New York Yankees" }])).toEqual(
      [["New York Yankees", "close"]],
    );
  });

  test("an unrelated team is dropped entirely", () => {
    expect(rankedTeamNames("Boston Red Sox", [{ name: "New York Yankees" }]))
      .toEqual([]);
  });

  test("short shared tokens are not evidence", () => {
    // "red"/"sox" are both under the four-character floor, so two teams
    // sharing only those do not surface each other.
    expect(rankedTeamNames("Chicago Red Sox", [{ name: "Cincinnati Reds" }]))
      .toEqual([]);
  });

  test("generic tokens are not evidence", () => {
    // "team" clears the length floor but is a stop word; nothing else is shared.
    expect(rankedTeamNames("Team Canada", [{ name: "Team Sweden" }])).toEqual([]);
  });

  test("orders exact first, then by shared tokens, then by name", () => {
    expect(
      rankedTeamNames("New York Yankees", [
        { name: "New York Mets" },
        { name: "New York Yankees" },
        { name: "Yankees" },
        { name: "Boston Red Sox" },
      ]),
    ).toEqual([
      // Both close rows share exactly one significant token ("york" for the
      // Mets, "yankees" for the nickname), so the tie falls to the name.
      ["New York Yankees", "exact"],
      ["New York Mets", "close"],
      ["Yankees", "close"],
    ]);
  });

  test("an empty query matches nothing rather than everything", () => {
    // Guard on `teamNamesMatch`'s containment rung: every string contains "".
    expect(rankedTeamNames("", [{ name: "New York Yankees" }])).toEqual([]);
    expect(rankedTeamNames("   ", [{ name: "New York Yankees" }])).toEqual([]);
  });
});

describe("rankPlayerCandidates", () => {
  test("identical names are exact", () => {
    expect(rankedPlayerNames("Mike Trout", [{ name: "Mike Trout" }])).toEqual([
      ["Mike Trout", "exact"],
    ]);
  });

  test("a surname on its own is close to the full name", () => {
    expect(rankedPlayerNames("Ohtani", [{ name: "Shohei Ohtani" }])).toEqual([
      ["Shohei Ohtani", "close"],
    ]);
  });

  test("an initialled first name is close", () => {
    expect(rankedPlayerNames("S. Ohtani", [{ name: "Shohei Ohtani" }])).toEqual([
      ["Shohei Ohtani", "close"],
    ]);
  });

  test("a truncated first name is close", () => {
    expect(rankedPlayerNames("Rob Gronkowski", [{ name: "Robert Gronkowski" }]))
      .toEqual([["Robert Gronkowski", "close"]]);
  });

  test("an unrelated player is dropped", () => {
    expect(rankedPlayerNames("Mike Trout", [{ name: "Shohei Ohtani" }])).toEqual(
      [],
    );
  });

  test("a shared surname with genuinely different first names is dropped", () => {
    // The ladder's rung 5: surnames agree, first names do not prefix each
    // other, so these are two people.
    expect(rankedPlayerNames("Mike Trout", [{ name: "Steve Trout" }])).toEqual(
      [],
    );
  });

  test("a suffix difference is close, never exact", () => {
    // `playerNamesMatch` calls this pair exact because it strips "Jr", but a
    // father and son are two rows — the operator gets the prompt, not a verdict.
    expect(rankedPlayerNames("Ken Griffey", [{ name: "Ken Griffey Jr." }]))
      .toEqual([["Ken Griffey Jr.", "close"]]);
  });

  test("orders exact first, then by shared tokens, then by name", () => {
    expect(
      rankedPlayerNames("Shohei Ohtani", [
        { name: "Ohtani" },
        { name: "Mike Trout" },
        { name: "Shohei Ohtani" },
        { name: "S. Ohtani" },
      ]),
    ).toEqual([
      ["Shohei Ohtani", "exact"],
      ["Ohtani", "close"],
      ["S. Ohtani", "close"],
    ]);
  });

  test("an empty query matches nothing", () => {
    expect(rankedPlayerNames("", [{ name: "Mike Trout" }])).toEqual([]);
  });
});
