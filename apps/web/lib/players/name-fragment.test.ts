import { describe, expect, test } from "vitest";
import {
  fragmentMatches,
  isGenerationalSuffix,
  isSingleToken,
  nameFragmentTokens,
} from "./name-fragment";

describe("NEO-463: nameFragmentTokens / isSingleToken", () => {
  test("folds case, accents and punctuation", () => {
    expect(nameFragmentTokens("Walker")).toEqual(["walker"]);
    expect(nameFragmentTokens("WALKER")).toEqual(["walker"]);
    expect(nameFragmentTokens("  Wálker. ")).toEqual(["walker"]);
    expect(nameFragmentTokens("O'Neal")).toEqual(["oneal"]);
  });

  test("a trailing generational suffix is dropped before counting", () => {
    expect(isSingleToken("Walker Jr.")).toBe(true);
    expect(isSingleToken("Walker SR")).toBe(true);
    expect(isSingleToken("Walker III")).toBe(true);
    expect(nameFragmentTokens("Ken Griffey Jr.")).toEqual(["ken", "griffey"]);
  });

  test("a suffix alone is never dropped down to nothing", () => {
    expect(nameFragmentTokens("Jr")).toEqual(["jr"]);
  });

  test("two real tokens are not a fragment", () => {
    expect(isSingleToken("Mr. Met")).toBe(false);
    expect(isSingleToken("Larry Walker")).toBe(false);
  });

  test("a mononym is one token", () => {
    expect(isSingleToken("Pelé")).toBe(true);
    expect(isSingleToken("Takuya")).toBe(true);
    expect(isSingleToken("")).toBe(false);
  });

  test("isGenerationalSuffix reads one written word", () => {
    expect(isGenerationalSuffix("Jr.")).toBe(true);
    expect(isGenerationalSuffix("iv")).toBe(true);
    expect(isGenerationalSuffix("Walker")).toBe(false);
  });
});

describe("NEO-463: fragmentMatches", () => {
  const candidates = [
    { name: "Larry Walker" },
    { name: "Walker Buehler" },
    { name: "Neil Walker Jr." },
    { name: "Christian Walkerson" },
    { name: "Walker" },
    { name: "Mike Trout" },
  ];

  test("matches on the first or last token, folded", () => {
    expect(fragmentMatches("WALKER", candidates).map((c) => c.name)).toEqual([
      "Larry Walker",
      "Walker Buehler",
      "Neil Walker Jr.",
    ]);
  });

  test("a prefix is not a match, and a single-token candidate is not fuller", () => {
    const names = fragmentMatches("Walker", candidates).map((c) => c.name);
    expect(names).not.toContain("Christian Walkerson");
    expect(names).not.toContain("Walker");
  });

  test("a middle token is not a match", () => {
    expect(fragmentMatches("Lee", [{ name: "Robert Lee Smith" }])).toEqual([]);
  });

  test("a two-token name never matches", () => {
    expect(fragmentMatches("Mr. Met", [{ name: "Mr. Met Jones" }])).toEqual([]);
  });

  test("accents fold on both sides", () => {
    expect(fragmentMatches("Jose", [{ name: "José Ramírez" }])).toHaveLength(1);
    expect(fragmentMatches("Ramírez", [{ name: "Jose Ramirez" }])).toHaveLength(1);
  });

  test("a suffix on the fragment is dropped before matching", () => {
    expect(fragmentMatches("Walker Jr.", [{ name: "Larry Walker" }])).toHaveLength(1);
  });
});
