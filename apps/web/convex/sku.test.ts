/**
 * NEO-91: unit tests for `generateSku` (convex/sku.ts) — the pure,
 * deterministic SKU-string builder. No Convex runtime needed here (no
 * `convexTest`): this file only exercises the exported pure function, so it
 * can live anywhere; convex/ root is fine and matches every other test file.
 *
 * Wiring into commitCardChecklist/addCustomCard (the insert-then-patch
 * pattern, `crypto.randomUUID()` as the real uniqueSuffix source) is covered
 * separately in convex/skuWiring.test.ts.
 */

import { describe, expect, test } from "vitest";
import { generateSku, SKU_MAX_LENGTH } from "./sku";

describe("generateSku", () => {
  test("known-good input produces the exact expected SKU string", () => {
    const sku = generateSku({
      sport: "Baseball",
      year: "2026",
      setName: "Topps Chrome",
      cardNumber: "42",
      uniqueSuffix: "a1b2c3",
    });

    // "Topps Chrome" -> strip non-alphanumeric, uppercase -> "TOPPSCHROME"
    // (11 chars, under the 12-char cap, so untruncated).
    expect(sku).toBe("NB-BB-2026-TOPPSCHROME-42-A1B2C3");
  });

  test("a very long setName and cardNumber are truncated, and total length never exceeds SKU_MAX_LENGTH", () => {
    const sku = generateSku({
      sport: "Baseball",
      year: "2026",
      setName: "ThisSetNameIsWayTooLongToFitInTwelveCharacters",
      cardNumber: "1234567890123456",
      uniqueSuffix: "a1b2c3",
    });

    // setSlug capped to 12 chars, cardNumberSlug capped to 10 chars.
    expect(sku).toBe("NB-BB-2026-THISSETNAMEI-1234567890-A1B2C3");
    expect(sku.length).toBeLessThanOrEqual(SKU_MAX_LENGTH);
  });

  test("unicode and punctuation in setName/cardNumber are stripped, not left in, and generateSku never throws", () => {
    expect(() =>
      generateSku({
        sport: "Baseball",
        year: "2026",
        setName: "Café Ünïcode 🎉 Set!",
        cardNumber: "#42-A/B",
        uniqueSuffix: "a1b2c3",
      }),
    ).not.toThrow();

    const sku = generateSku({
      sport: "Baseball",
      year: "2026",
      setName: "Café Ünïcode 🎉 Set!",
      cardNumber: "#42-A/B",
      uniqueSuffix: "a1b2c3",
    });

    // Every non A-Z0-9 character (accents, emoji, punctuation, spaces) is
    // stripped by slugify's `[^A-Z0-9]` filter; the diacritic base letters
    // themselves are also stripped since they aren't plain A-Z after
    // uppercasing (toUpperCase() does not fold accents to ASCII).
    expect(sku).not.toMatch(/[^A-Z0-9-]/);
    expect(sku).toContain("42AB");
  });

  test("a sport not in SPORT_SKU_CODE falls back to a derived 2-char code instead of throwing or emitting undefined", () => {
    const sku = generateSku({
      sport: "Soccer",
      year: "2026",
      setName: "Panini",
      cardNumber: "7",
      uniqueSuffix: "xyz789",
    });

    expect(sku).not.toContain("undefined");
    // slugify("Soccer", 2) -> "SO" (already 2 chars, no padding needed).
    expect(sku).toBe("NB-SO-2026-PANINI-7-XYZ789");
  });

  test("a sport not in SPORT_SKU_CODE and shorter than 2 chars after slugify is padded with X to stay exactly 2 chars", () => {
    // slugify("A", 2) -> "A", then .padEnd(2, "X") -> "AX".
    const sku = generateSku({
      sport: "A",
      year: "2026",
      setName: "Panini",
      cardNumber: "7",
      uniqueSuffix: "xyz789",
    });

    expect(sku).toBe("NB-AX-2026-PANINI-7-XYZ789");
  });

  test("two calls with different uniqueSuffix values (all else identical) produce different SKUs", () => {
    const base = {
      sport: "Baseball",
      year: "2026",
      setName: "Topps",
      cardNumber: "10",
    };

    const skuA = generateSku({ ...base, uniqueSuffix: "aaaaaa" });
    const skuB = generateSku({ ...base, uniqueSuffix: "bbbbbb" });

    expect(skuA).not.toBe(skuB);
  });

  test("length is 'at most' SKU_MAX_LENGTH, not always exactly fixed — short components are only capped, never padded", () => {
    // year/setName/cardNumber use slugify() with no .padEnd(), so shorter
    // inputs than the cap produce a shorter total string. Only sportCode
    // (known sports are already exactly 2 chars, unknown sports padEnd to 2)
    // and the suffix (padEnd to 6) are guaranteed fixed-width.
    const shortSku = generateSku({
      sport: "Baseball",
      year: "26",
      setName: "X",
      cardNumber: "1",
      uniqueSuffix: "a1b2c3",
    });

    expect(shortSku).toBe("NB-BB-26-X-1-A1B2C3");
    expect(shortSku.length).toBeLessThan(SKU_MAX_LENGTH);

    // The worst-case (every component at its cap) is exactly SKU_MAX_LENGTH.
    const maxSku = generateSku({
      sport: "Baseball",
      year: "2026",
      setName: "ThisSetNameIsWayTooLongToFitInTwelveCharacters",
      cardNumber: "1234567890123456",
      uniqueSuffix: "a1b2c3",
    });
    expect(maxSku.length).toBe(SKU_MAX_LENGTH);
  });

  test("an empty setName/cardNumber falls back to the literal 'X' placeholder rather than an empty segment", () => {
    const sku = generateSku({
      sport: "Baseball",
      year: "2026",
      setName: "!!!",
      cardNumber: "???",
      uniqueSuffix: "a1b2c3",
    });

    expect(sku).toBe("NB-BB-2026-X-X-A1B2C3");
  });
});
