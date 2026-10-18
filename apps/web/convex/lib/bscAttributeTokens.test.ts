import { describe, expect, test } from "vitest";
import {
  MAX_BSC_PRINT_RUN,
  bscAttributeLabelTokens,
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
