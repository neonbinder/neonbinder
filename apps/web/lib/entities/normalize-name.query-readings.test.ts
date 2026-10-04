/**
 * NEO-322 — `entityNameQueryReadings`: the typeahead readings of text still
 * being typed, matched as prefixes against stored key tokens.
 */

import { describe, expect, test } from "vitest";
import {
  entityNameQueryReadings,
  entityNameTokens,
  normalizeEntityName,
} from "./normalize-name";

/** The prefix rule `players.search`'s member leg applies, over every reading. */
function prefixMatches(query: string, stored: string): boolean {
  const nameTokens = stored.split(" ");
  return entityNameQueryReadings(query).some((tokens) =>
    tokens.length > 0 && tokens.every((t) => nameTokens.some((n) => n.startsWith(t))),
  );
}

describe("entityNameQueryReadings", () => {
  test("the first reading is always entityNameTokens", () => {
    for (const q of ["C. J. Kayfus", "J. T. R", "New York Yan", "Big 12", "", "   "]) {
      expect(entityNameQueryReadings(q)[0]).toEqual(entityNameTokens(q));
    }
  });

  test("text ending in two or more initials gets a second reading with the last letter apart", () => {
    expect(entityNameQueryReadings("J. T. R")).toEqual([["jtr"], ["jt", "r"]]);
    expect(entityNameQueryReadings("C. J")).toEqual([["cj"], ["c", "j"]]);
    expect(entityNameQueryReadings("N. C. S")).toEqual([["ncs"], ["nc", "s"]]);
    expect(entityNameQueryReadings("Kayfus C J")).toEqual([
      ["kayfus", "cj"],
      ["kayfus", "c", "j"],
    ]);
  });

  test("every other query has exactly one reading", () => {
    expect(entityNameQueryReadings("J. T. Real")).toEqual([["jt", "real"]]);
    expect(entityNameQueryReadings("P. Mahomes")).toEqual([["p", "mahomes"]]);
    expect(entityNameQueryReadings("Mahomes P")).toEqual([["mahomes", "p"]]);
    expect(entityNameQueryReadings("Big 1 2")).toEqual([["big", "1", "2"]]);
    expect(entityNameQueryReadings("")).toEqual([[]]);
  });

  test("never alters a key: normalizeEntityName is untouched by the second reading", () => {
    expect(normalizeEntityName("J. T. R")).toBe("jtr");
  });
});

describe("typing an initialled name, keystroke by keystroke", () => {
  const cj = normalizeEntityName("C.J. Kayfus");
  const jt = normalizeEntityName("J.T. Realmuto");

  test("stored keys are the joined ones", () => {
    expect(cj).toBe("cj kayfus");
    expect(jt).toBe("jt realmuto");
  });

  test.each(["C", "C.", "C. J", "C. J.", "C. J. K", "C. J. Ka", "C. J. Kayfus", "CJ Kay", "Kayfus"])(
    "%j finds cj kayfus",
    (typed) => {
      expect(prefixMatches(typed, cj)).toBe(true);
    },
  );

  test.each(["J", "J. T", "J. T. R", "J. T. Real", "JT Realmuto", "Realmuto J. T."])(
    "%j finds jt realmuto",
    (typed) => {
      expect(prefixMatches(typed, jt)).toBe(true);
    },
  );

  test("a key whose initials were never adjacent is still found by typing them together", () => {
    // "J Smith K" keys as "j k smith" (no run to join). Typing "J K" joins to
    // "jk"; the second reading keeps "j" and "k" and finds it.
    const stored = normalizeEntityName("J Smith K");
    expect(stored).toBe("j k smith");
    expect(prefixMatches("J K", stored)).toBe(true);
  });

  test("an unrelated name is still not found", () => {
    expect(prefixMatches("C. J. X", cj)).toBe(false);
    expect(prefixMatches("J. T. Q", jt)).toBe(false);
  });
});
