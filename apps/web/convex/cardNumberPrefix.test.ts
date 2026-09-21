/**
 * NEO-291 — `normalizeCardNumberPrefix`, the one rule shared by
 * `setSelectorOptionCardNumberPrefix` and `storeReconciledOptions` so the
 * attributes panel and the reconciliation modal cannot disagree about what a
 * valid prefix is.
 */

import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import {
  MAX_CARD_NUMBER_PREFIX_LENGTH,
  normalizeCardNumberPrefix,
} from "./cardNumberPrefix";

describe("normalizeCardNumberPrefix", () => {
  test("trims surrounding whitespace", () => {
    expect(normalizeCardNumberPrefix("  DK- ")).toBe("DK-");
  });

  test("an empty string returns undefined — the operator cleared it", () => {
    expect(normalizeCardNumberPrefix("")).toBeUndefined();
  });

  test("a whitespace-only string also returns undefined", () => {
    expect(normalizeCardNumberPrefix("   ")).toBeUndefined();
  });

  test("refuses a line break", () => {
    expect(() => normalizeCardNumberPrefix("DK-\n1")).toThrow(ConvexError);
    expect(() => normalizeCardNumberPrefix("DK-\n1")).toThrow(
      /line breaks or control characters/,
    );
  });

  test("refuses a control character", () => {
    expect(() => normalizeCardNumberPrefix("DK-\u0007")).toThrow(
      /control characters/,
    );
  });

  test.each(["​", "‌", "‍", "⁠", "﻿"])(
    "refuses the zero-width/invisible character U+%s",
    (ch) => {
      // Mid-string, not trailing — ﻿ is itself in JS's WhiteSpace
      // production, so a TRAILING one is silently removed by `trim()` before
      // the invisible-character check ever runs.
      expect(() => normalizeCardNumberPrefix(`DK-${ch}1`)).toThrow(
        /zero-width or invisible/,
      );
    },
  );

  test("refuses a value over the max length", () => {
    const tooLong = "X".repeat(MAX_CARD_NUMBER_PREFIX_LENGTH + 1);
    expect(() => normalizeCardNumberPrefix(tooLong)).toThrow(
      new RegExp(`at most ${MAX_CARD_NUMBER_PREFIX_LENGTH} characters`),
    );
  });

  test("accepts a value at exactly the max length", () => {
    const atMax = "X".repeat(MAX_CARD_NUMBER_PREFIX_LENGTH);
    expect(normalizeCardNumberPrefix(atMax)).toBe(atMax);
  });

  test("the thrown ConvexError carries string data — what userFacingMessage shows verbatim", () => {
    try {
      normalizeCardNumberPrefix("DK-\n1");
      expect.unreachable("expected a ConvexError");
    } catch (e) {
      expect(e).toBeInstanceOf(ConvexError);
      expect(typeof (e as ConvexError<string>).data).toBe("string");
    }
  });
});
