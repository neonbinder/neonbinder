import { describe, expect, test } from "vitest";
import { parseTitleQuery, searchTextFor, titleMatches } from "./titleQuery";

describe("parseTitleQuery", () => {
  test("unquoted words are terms, quoted text is a phrase", () => {
    expect(parseTitleQuery('Gooden  "Topps   Chrome" mets')).toEqual({
      terms: ["gooden", "mets"],
      phrases: ["topps chrome"],
    });
  });

  test("curly quotes work, and an unbalanced quote runs to the end", () => {
    expect(parseTitleQuery("“Gold Refractor” 1")).toEqual({
      terms: ["1"],
      phrases: ["gold refractor"],
    });
    expect(parseTitleQuery('gooden "chrome refr')).toEqual({
      terms: ["gooden"],
      phrases: ["chrome refr"],
    });
  });

  test("empty quotes and blank text are nothing", () => {
    expect(parseTitleQuery('  ""  ')).toEqual({ terms: [], phrases: [] });
  });

  test("the search text carries every word", () => {
    expect(searchTextFor(parseTitleQuery('a "b c"'))).toBe("a b c");
  });
});

describe("titleMatches", () => {
  const title = "2024 Topps Chrome #1 Dwight Gooden Mets";

  test("terms match anywhere, in any order, case-insensitively", () => {
    expect(titleMatches(title, parseTitleQuery("mets GOODEN 2024"))).toBe(true);
    expect(titleMatches(title, parseTitleQuery("mets yankees"))).toBe(false);
  });

  test("a phrase must appear verbatim", () => {
    expect(titleMatches(title, parseTitleQuery('"dwight gooden"'))).toBe(true);
    expect(titleMatches(title, parseTitleQuery('"gooden dwight"'))).toBe(false);
  });
});
