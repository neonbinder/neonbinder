import { describe, expect, test } from "vitest";
import {
  MAX_BSC_PRINT_RUN,
  MAX_BSC_PRODUCT_NAME_LENGTH,
  bscAttributeLabelTokens,
  bscAttributeTokensFromProductName,
  isBscAttributeLabel,
  normalizeBscAttributeTokens,
  normalizeBscAttributeTokensDetailed,
  printRunFromToken,
} from "./bscAttributeTokens";

describe("printRunFromToken", () => {
  test("reads SN<n> in any case and with a gap, and 1/1 as 1", () => {
    expect(printRunFromToken("SN99")).toBe(99);
    expect(printRunFromToken("sn 25")).toBe(25);
    expect(printRunFromToken(" 1/1 ")).toBe(1);
    expect(printRunFromToken("1 / 1")).toBe(1);
  });

  test("accepts the largest print run and refuses one past it", () => {
    expect(printRunFromToken(`SN${MAX_BSC_PRINT_RUN}`)).toBe(MAX_BSC_PRINT_RUN);
    expect(printRunFromToken(`SN${MAX_BSC_PRINT_RUN + 1}`)).toBeUndefined();
  });

  test("refuses zero, a missing number, more than seven digits and non-print-run tokens", () => {
    expect(printRunFromToken("SN0")).toBeUndefined();
    expect(printRunFromToken("SN")).toBeUndefined();
    expect(printRunFromToken("SN12345678")).toBeUndefined();
    expect(printRunFromToken("2/2")).toBeUndefined();
    expect(printRunFromToken("AU")).toBeUndefined();
  });
});

describe("normalizeBscAttributeTokensDetailed", () => {
  test("hands back the raw tokens that carried the one print run", () => {
    const out = normalizeBscAttributeTokensDetailed(["AU", "SN99"]);
    expect(out).toEqual({ attributes: ["AU", "NUM"], printRun: 99, printRunTokens: ["SN99"] });
  });

  test("two different print runs set no print run and keep BSC's tokens beside NUM", () => {
    const out = normalizeBscAttributeTokensDetailed(["SN10", "1/1"]);
    expect(out.printRun).toBeUndefined();
    expect(out.attributes).toEqual(["NUM", "SN10", "1/1"]);
    expect(out.printRunTokens).toEqual(["SN10", "1/1"]);
  });

  test("the same print run named twice is still one print run", () => {
    expect(normalizeBscAttributeTokensDetailed(["SN10", "sn 10"]).printRun).toBe(10);
  });

  test("no print-run token means no printRunTokens and no NUM", () => {
    expect(normalizeBscAttributeTokensDetailed(["RC"])).toEqual({
      attributes: ["RC"],
      printRunTokens: [],
    });
  });
});

describe("normalizeBscAttributeTokens", () => {
  test("omits printRun when there is none, rather than writing undefined", () => {
    expect(normalizeBscAttributeTokens(["rc"])).toStrictEqual({ attributes: ["RC"] });
  });

  test("is idempotent on its own output", () => {
    const once = normalizeBscAttributeTokens(["AU", "SN99", "JSY"]);
    expect(normalizeBscAttributeTokens(once.attributes).attributes).toEqual(once.attributes);
  });
});

describe("bscAttributeLabelTokens", () => {
  test("splits on spaces and commas and drops blanks", () => {
    expect(bscAttributeLabelTokens("AU  SN1")).toEqual(["AU", "SN1"]);
    expect(bscAttributeLabelTokens(" RC,AU , SP ")).toEqual(["RC", "AU", "SP"]);
  });

  test("an empty or blank label has no tokens", () => {
    expect(bscAttributeLabelTokens("")).toEqual([]);
    expect(bscAttributeLabelTokens("  ,  ")).toEqual([]);
  });
});

/**
 * NEO-339 — tokens read from BSC's per-card `productName` when
 * `playerAttribute` is empty. The PBDA strings are the live card-listing
 * values for 2024 Topps Chrome Black "Pitch Black Pairings Dual Autographs".
 */
describe("bscAttributeTokensFromProductName", () => {
  const read = bscAttributeTokensFromProductName;

  test("the live PBDA shape: 'AU, SN' between the names and #<cardNo>", () => {
    expect(read("Gerrit Cole / Andy Pettitte AU, SN #PBDA-CP")).toEqual(["AU", "SN"]);
    expect(read("Mike Schmidt / Bryce Harper AU, SN #PBDA-HS")).toEqual(["AU", "SN"]);
  });

  test("a bare SN names no print run and normalises as it always has: kept raw, no NUM", () => {
    expect(
      normalizeBscAttributeTokens(read("Gerrit Cole / Andy Pettitte AU, SN #PBDA-CP")),
    ).toStrictEqual({ attributes: ["AU", "SN"] });
    // The same as the token arriving in playerAttribute.
    expect(normalizeBscAttributeTokens(["AU", "SN"])).toStrictEqual({
      attributes: ["AU", "SN"],
    });
  });

  test("'AU, SN99' reads AU and a print run of 99", () => {
    const tokens = read("Jac Caglianone / Charlie Condon AU, SN99 #PDA-JC");
    expect(tokens).toEqual(["AU", "SN99"]);
    expect(normalizeBscAttributeTokens(tokens)).toEqual({
      attributes: ["AU", "NUM"],
      printRun: 99,
    });
  });

  test("odd spacing around the commas and before the suffix still reads", () => {
    expect(read("Mike Trout AU ,  SN25   #MT-1")).toEqual(["AU", "SN25"]);
    expect(read("Mike Trout RC, AU, 1/1 #MT-1")).toEqual(["RC", "AU", "1/1"]);
  });

  test("a productName with no token run reads nothing", () => {
    expect(read("Shohei Ohtani #17")).toEqual([]);
    expect(read("Gerrit Cole / Andy Pettitte #PBDA-CP")).toEqual([]);
    expect(read("2024 Topps Chrome Black Pitch Black Pairings #PBDA-CP")).toEqual([]);
  });

  test("a name made of 'Au' or 'Sn' letters never becomes a token", () => {
    expect(read("Tony Au #12")).toEqual([]);
    expect(read("Sn Kim #4")).toEqual([]);
    expect(read("Aubrey Huff / Duke Snider #AH-DS")).toEqual([]);
    expect(read("Jose Au, Sn #9")).toEqual([]);
    // Mixed case breaks the run: only the upper-case tokens after the name.
    expect(read("Tony Au AU, SN #12")).toEqual(["AU", "SN"]);
  });

  test("the walk stops at the first word it does not know", () => {
    // An upper-case name joined by a comma: the name is never taken.
    expect(read("BOBBY WITT, AU #BW")).toEqual(["AU"]);
    expect(read("Ken Griffey JR, RC #1")).toEqual(["RC"]);
    // An unknown upper-case word last: nothing after it, so nothing.
    expect(read("Mike Trout AU, XYZ #MT")).toEqual([]);
    expect(read("Cal Ripken III #8")).toEqual([]);
  });

  test("no #<cardNo> suffix means no run", () => {
    expect(read("Gerrit Cole / Andy Pettitte AU, SN")).toEqual([]);
    expect(read("Gerrit Cole / Andy Pettitte AU, SN #")).toEqual([]);
    expect(read("Gerrit Cole / Andy Pettitte AU, SN#PBDA-CP")).toEqual([]);
  });

  test("a run with no names before it is not the shape, and reads nothing", () => {
    expect(read("AU, SN #PBDA-CP")).toEqual([]);
    expect(read("#PBDA-CP")).toEqual([]);
  });

  test("NUM is NB's word, never read from BSC's title", () => {
    expect(read("Mike Trout NUM #1")).toEqual([]);
    expect(read("Mike Trout AU, NUM #1")).toEqual([]);
  });

  test("an out-of-range serial is not a token", () => {
    expect(read("Mike Trout AU, SN0 #1")).toEqual([]);
    expect(read("Mike Trout AU, SN12345678 #1")).toEqual([]);
  });

  test("non-strings, blanks and an over-long title read nothing", () => {
    expect(read(undefined)).toEqual([]);
    expect(read(null)).toEqual([]);
    expect(read(["Mike Trout AU #1"])).toEqual([]);
    expect(read({ productName: "Mike Trout AU #1" })).toEqual([]);
    expect(read("   ")).toEqual([]);
    const long = `${"A".repeat(MAX_BSC_PRODUCT_NAME_LENGTH)} AU #1`;
    expect(read(long)).toEqual([]);
  });

  test("zero-width characters do not hide a run", () => {
    expect(read("Mike Trout AU,\u200B SN99 #1")).toEqual(["AU", "SN99"]);
  });

  test("a token named twice is read once", () => {
    expect(read("Mike Trout AU, AU #1")).toEqual(["AU"]);
  });
});

describe("isBscAttributeLabel — bare SN (NEO-339)", () => {
  test("a team value made of AU and a bare SN is the label, not a team", () => {
    expect(isBscAttributeLabel("AU  SN", [])).toBe(true);
  });
});
