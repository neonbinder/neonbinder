import { describe, expect, it } from "vitest";
import { SLUG_MAX_CHARS, binderHref, cleanSlug, freeSlug, isSlug, suggestSlug } from "./share-links";

describe("share links (NEO-360)", () => {
  it("suggests a readable part from a binder's name, always valid", () => {
    expect(suggestSlug("Ohtani Rainbow!")).toBe("ohtani-rainbow");
    expect(suggestSlug("'96 Contenders")).toBe("96-contenders");
    expect(suggestSlug("Café & Crème")).toBe("cafe-and-creme");
    expect(suggestSlug("!!!")).toBe("binder");
    expect(suggestSlug("PC")).toBe("pc-binder");
    const long = suggestSlug("word ".repeat(30));
    expect(long.length).toBeLessThanOrEqual(SLUG_MAX_CHARS);
    expect(cleanSlug(long)).toBe(long);
  });

  it("cleans what the collector typed, and refuses rather than rewrites", () => {
    expect(cleanSlug("  Shohei Gold ")).toBe("shohei-gold");
    expect(cleanSlug("my_binder")).toBe("my-binder");
    for (const bad of ["ab", "a--b", "-ab", "ab-", "no/slash", "émoji", "a".repeat(51)]) {
      expect(cleanSlug(bad)).toBeNull();
    }
  });

  it("finds the first free link name, still within the length", () => {
    expect(freeSlug("tb-binder", new Set())).toBe("tb-binder");
    expect(freeSlug("tb-binder", new Set(["tb-binder", "tb-binder-2"]))).toBe("tb-binder-3");
    const long = "a".repeat(SLUG_MAX_CHARS);
    const next = freeSlug(long, new Set([long]));
    expect(next.length).toBeLessThanOrEqual(SLUG_MAX_CHARS);
    expect(next.endsWith("-2")).toBe(true);
    expect(isSlug(next)).toBe(true);
  });

  it("builds a plain path, and knows a well-formed link name", () => {
    expect(binderHref("ace", "ohtani-rainbow")).toBe("/u/ace/binders/ohtani-rainbow");
    expect(isSlug("ohtani-rainbow")).toBe(true);
    for (const bad of ["ab", "Ohtani", "-ab", "a--b", "x".repeat(SLUG_MAX_CHARS + 1)]) {
      expect(isSlug(bad)).toBe(false);
    }
  });
});
