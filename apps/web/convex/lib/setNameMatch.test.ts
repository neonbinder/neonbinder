/**
 * NEO-339 — the name comparison the Reconcile matcher and the set-build draft
 * share: the manufacturer fold, accents, and the ranking a suggestion reads.
 */
import { describe, expect, test } from "vitest";
import { brandFoldedKey, nameAffinity, normalizeForMatch } from "./setNameMatch";

describe("normalizeForMatch", () => {
  test("folds accents and keeps the synonyms", () => {
    expect(normalizeForMatch("Exposé Autos")).toBe("expose autograph");
    expect(normalizeForMatch("Topps Chrome Authentics Relics")).toBe("topps chrome authentics relic");
  });
});

describe("brandFoldedKey", () => {
  test("drops a leading manufacturer word, whole tokens only", () => {
    expect(brandFoldedKey("Topps Chrome Authentics Relics", "Topps")).toBe("chrome authentics relic");
    expect(brandFoldedKey("Chrome Authentics Relics", "Topps")).toBe("chrome authentics relic");
    expect(brandFoldedKey("Toppstown Chrome", "Topps")).toBe("toppstown chrome");
    expect(brandFoldedKey("Upper Deck Exquisite", "Upper Deck")).toBe("exquisite");
  });

  test("a name that is only the manufacturer, or no manufacturer, is the plain name", () => {
    expect(brandFoldedKey("Topps", "Topps")).toBe("topps");
    expect(brandFoldedKey("Topps Chrome", undefined)).toBe("topps chrome");
    expect(brandFoldedKey("Chrome Topps Relics", "Topps")).toBe("chrome topps relic");
  });
});

describe("nameAffinity", () => {
  const ctx = { manufacturer: "Topps", slPrefixes: ["topps chrome", "chrome"] };

  test("the brand word one side drops, or the SportLots Base prefix, reads as the same name", () => {
    expect(nameAffinity("Topps Chrome Authentics Relics", "Chrome Authentics Relics", ctx)).toBe(1);
    expect(nameAffinity("Rookie Autographs", "Chrome Rookie Autos", ctx)).toBe(1);
  });

  test("the same words in another order score 0.95; unrelated names score low", () => {
    expect(nameAffinity("Prizms Red", "Red Prizm")).toBe(0.95);
    expect(nameAffinity("Future Stars", "Heritage Real One Autographs", ctx)).toBeLessThan(0.5);
  });
});
