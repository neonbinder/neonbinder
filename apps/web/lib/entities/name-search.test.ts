/**
 * NEO-253 (audit) — the typeahead filter folds, and changes nothing else.
 *
 * Both halves matter. The fold is the fix; "changes nothing else" is what makes
 * the fix safe to drop into three pickers at once, because a substring filter
 * is the control an operator uses hundreds of times a session and any surprise
 * in it reads as the box being broken.
 */

import { describe, expect, test } from "vitest";
import {
  nameHasQueryPrefix,
  nameMatchesQuery,
  nameSearchKey,
} from "./name-search";
import { normalizeEntityName } from "./normalize-name";

describe("nameSearchKey", () => {
  test("is exactly toLowerCase for ASCII", () => {
    for (const s of ["New York Yankees", "O'Neal, Shaquille", "  spaced  "]) {
      expect(nameSearchKey(s)).toBe(s.toLowerCase());
    }
  });

  test("folds accents", () => {
    expect(nameSearchKey("José Ramírez")).toBe("jose ramirez");
  });

  test("does NOT sort, unlike the dedup key", () => {
    // The reason this module exists at all. Sorted, "New York Yankees" is
    // "new yankees york" and the commonest query in the app stops matching.
    expect(nameSearchKey("New York Yankees")).toBe("new york yankees");
    expect(normalizeEntityName("New York Yankees")).toBe("new yankees york");
  });
});

describe("nameMatchesQuery", () => {
  test("an ASCII query finds the accented row — the reported defect", () => {
    expect(nameMatchesQuery("José Ramírez", "Jose Ramirez")).toBe(true);
    expect(nameMatchesQuery("José Ramírez", "jose ram")).toBe(true);
    expect(nameMatchesQuery("Montréal Expos", "montreal")).toBe(true);
  });

  test("an accented query finds the ASCII row", () => {
    expect(nameMatchesQuery("Jose Ramirez", "José")).toBe(true);
  });

  test("multi-word partial typing still works — no token sorting", () => {
    expect(nameMatchesQuery("New York Yankees", "new york")).toBe(true);
    expect(nameMatchesQuery("New York Yankees", "york yan")).toBe(true);
    // And a genuine non-match is still a non-match.
    expect(nameMatchesQuery("New York Yankees", "boston")).toBe(false);
  });

  test("an empty query matches everything", () => {
    expect(nameMatchesQuery("Anything", "")).toBe(true);
    expect(nameMatchesQuery("Anything", "   ")).toBe(true);
  });
});

describe("nameHasQueryPrefix", () => {
  test("ranks a prefix hit, folded on both sides", () => {
    expect(nameHasQueryPrefix("Montréal Expos", "montreal")).toBe(true);
    expect(nameHasQueryPrefix("New York Yankees", "new")).toBe(true);
    expect(nameHasQueryPrefix("Newark Eagles", "new york")).toBe(false);
  });

  test("an empty query is not a prefix hit — it must not flatten the ordering", () => {
    expect(nameHasQueryPrefix("Anything", "")).toBe(false);
  });
});
