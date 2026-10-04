/**
 * NEO-253 — the one normalisation of an entity name.
 *
 * Two things are locked here and they fail differently:
 *
 *  1. **The fold.** "José Ramírez" and "Jose Ramirez" must key identically, in
 *     both directions and for teams and leagues as well as players. This is the
 *     behaviour the ticket exists for.
 *  2. **Everything else is unchanged.** The fold was inserted ahead of a chain
 *     that six modules depended on the exact output of, and every stored
 *     `nameNormalized` for an unaccented name has to keep the value it already
 *     has. The ASCII cases below are transcribed from the assertions that used
 *     to live in `convex/lib/entityNearMatch.test.ts` for precisely that reason:
 *     they are the regression surface, not decoration.
 */

import { describe, expect, test } from "vitest";
import {
  entityNameTokens,
  foldDiacritics,
  normalizeEntityName,
  normalizeOrderedEntityName,
} from "./normalize-name";

describe("foldDiacritics", () => {
  test("strips combining marks and nothing else", () => {
    expect(foldDiacritics("José Ramírez")).toBe("Jose Ramirez");
    expect(foldDiacritics("Montréal Expos")).toBe("Montreal Expos");
    // Case, spacing and punctuation are somebody else's job.
    expect(foldDiacritics("  St. Ástor's  ")).toBe("  St. Astor's  ");
  });

  test("is the identity on ASCII", () => {
    // The property that lets the fold be inserted ahead of the old chain
    // without changing a single existing unaccented key.
    for (const s of ["Mike Trout", "O'Neal, Shaquille", "Wilkes-Barre", "..."]) {
      expect(foldDiacritics(s)).toBe(s);
    }
  });

  test("leaves a letter with no canonical decomposition alone", () => {
    // "ø", "ß", "Æ", "Ł" carry no combining mark, so NFD does not separate
    // anything to strip. Deliberate: transliterating them needs per-language
    // rules, and a wrong rule MERGES two different people.
    //
    // All four are asserted rather than one standing in for the rest: they fail
    // for the same reason but in different scripts' worth of Unicode, and a
    // future "let us just add a small transliteration table" would plausibly
    // catch one and miss the others.
    expect(foldDiacritics("Bjørn Nielsen")).toBe("Bjørn Nielsen");
    expect(foldDiacritics("Weiß")).toBe("Weiß");
    expect(foldDiacritics("Ægir Hansen")).toBe("Ægir Hansen");
    expect(foldDiacritics("Łukasz Nowak")).toBe("Łukasz Nowak");
  });
});

describe("normalizeEntityName — the players/teams dedup key", () => {
  test("folds diacritics, in both directions", () => {
    expect(normalizeEntityName("José Ramírez")).toBe(
      normalizeEntityName("Jose Ramirez"),
    );
    expect(normalizeEntityName("José Ramírez")).toBe("jose ramirez");
    expect(normalizeEntityName("Montréal Expos")).toBe("expos montreal");
    expect(normalizeEntityName("Montréal Expos")).toBe(
      normalizeEntityName("Montreal Expos"),
    );
  });

  test("an accented name no longer shreds into fragments", () => {
    // The old chain lowercased and THEN dropped everything outside
    // `[a-z0-9\s-]`, so "é" became a separator: the key was "e jos", which
    // resembles neither spelling and shares no token with either.
    expect(entityNameTokens("José Ramírez")).toEqual(["jose", "ramirez"]);
  });

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
});

describe("entityNameTokens — source order", () => {
  test("preserves source order, unlike the sorted dedup key", () => {
    expect(entityNameTokens("New York Yankees")).toEqual([
      "new",
      "york",
      "yankees",
    ]);
  });

  test("the surname is the last token even when it is accented", () => {
    // `players.nearMatches` falls back to searching the last token. Before the
    // fold that token was "rez".
    const tokens = entityNameTokens("José Ramírez");
    expect(tokens[tokens.length - 1]).toBe("ramirez");
  });
});

describe("normalizeOrderedEntityName — the leagues key", () => {
  test("folds, but does NOT sort", () => {
    expect(normalizeOrderedEntityName("Liga Mexicana de Béisbol")).toBe(
      "liga mexicana de beisbol",
    );
    // The reason leagues have their own entry point at all.
    expect(normalizeOrderedEntityName("National League")).not.toBe(
      normalizeOrderedEntityName("League National"),
    );
  });
});

describe("initials — NEO-322", () => {
  const key = normalizeEntityName;
  const ordered = normalizeOrderedEntityName;

  test("every spelling of C. J. Kayfus is one key", () => {
    for (const spelling of [
      "C.J. Kayfus",
      "C. J. Kayfus",
      "CJ Kayfus",
      "C J Kayfus",
    ]) {
      expect(key(spelling)).toBe("cj kayfus");
    }
  });

  test("entityNameTokens joins the run and keeps source order", () => {
    expect(entityNameTokens("C. J. Kayfus")).toEqual(["cj", "kayfus"]);
  });

  test.each([
    ["J.J. Watt", "J. J. Watt"],
    ["A.J. Brown", "A. J. Brown"],
  ])("%s and %s are one key", (a, b) => {
    expect(key(a)).toBe(key(b));
  });

  test("two initials before a surname sort as one token", () => {
    expect(key("R. A. Dickey")).toBe("dickey ra");
    expect(key("J. D. Martinez")).toBe("jd martinez");
  });

  test("three initials join into one token", () => {
    expect(key("J. R. R. Tolkien")).toBe("jrr tolkien");
  });

  test("A. J. Smith and J. A. Smith are different keys", () => {
    // Regression: the sort used to scatter initials, so both keyed "a j smith".
    expect(key("A. J. Smith")).not.toBe(key("J. A. Smith"));
    expect(key("A. J. Smith")).toBe("aj smith");
    expect(key("J. A. Smith")).toBe("ja smith");
  });

  test("a lone initial is left as its own token", () => {
    expect(entityNameTokens("P. Mahomes")).toEqual(["p", "mahomes"]);
    expect(key("Michael A. Taylor")).toBe("a michael taylor");
  });

  test("digits are never joined", () => {
    expect(key("Big 12")).toBe("12 big");
    expect(key("Formula 1")).toBe("1 formula");
    expect(ordered("Big 1 2")).toBe("big 1 2");
  });

  test("a letter between digits does not pull the digits in", () => {
    expect(entityNameTokens("Big 1 A 2")).toEqual(["big", "1", "a", "2"]);
  });

  test("team names with initials agree across spellings", () => {
    for (const spelling of ["Texas A&M", "Texas AM", "Texas A & M"]) {
      expect(key(spelling)).toBe("am texas");
    }
    expect(key("Oakland A's")).toBe("as oakland");
    expect(key("D.C. United")).toBe(key("D C United"));
    expect(key("D.C. United")).toBe("dc united");
    expect(key("U.S.A. Hockey")).toBe(key("U S A Hockey"));
    expect(key("U.S.A. Hockey")).toBe("hockey usa");
  });

  test("a name with no initials is unchanged", () => {
    expect(key("St. Louis Cardinals")).toBe("cardinals louis st");
  });

  test("the ordered league key joins initials and keeps order", () => {
    expect(ordered("N. H. L.")).toBe("nhl");
    expect(ordered("N. H. L.")).toBe(ordered("NHL"));
    expect(ordered("Class A")).toBe("class a");
    expect(ordered("Division I-A")).toBe("division i-a");
    expect(ordered("Liga MX")).toBe("liga mx");
  });
});

describe("normalizeEntityName — a stored key is not a name", () => {
  test("the sorted key is NOT idempotent under re-normalising", () => {
    // Joining initials runs BEFORE the token sort, so the sort can leave two
    // single-letter tokens side by side, and a second pass then joins them.
    // NOTHING may re-normalise a stored key (or a value read back from one):
    // always normalise the original NAME. `rekeyEntityNames` recomputes from
    // the row's name for exactly this reason.
    const once = normalizeEntityName("J. Doe K.");
    expect(once).toBe("doe j k");
    expect(normalizeEntityName(once)).toBe("doe jk");
    expect(normalizeEntityName(once)).not.toBe(once);
  });
});
