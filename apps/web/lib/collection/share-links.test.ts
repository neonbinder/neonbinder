import { describe, expect, it } from "vitest";
import {
  MAX_BINDER_PATH_CHARS,
  SLUG_MAX_CHARS,
  binderPath,
  cleanSlug,
  isSlugKey,
  mintSlugKey,
  splitBinderPath,
  suggestSlug,
} from "./share-links";

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

  it("mints 6 characters from [a-z0-9]", () => {
    const keys = new Set(Array.from({ length: 200 }, mintSlugKey));
    for (const key of keys) expect(isSlugKey(key)).toBe(true);
    expect(keys.size).toBeGreaterThan(190);
  });

  it("splits a path back into its parts, and refuses anything else", () => {
    expect(splitBinderPath(binderPath("ohtani-rainbow", "k7f3q2"))).toEqual({ slug: "ohtani-rainbow", slugKey: "k7f3q2" });
    for (const bad of ["ohtani-rainbow", "ab-k7f3q2", "ohtani-K7F3Q2", "-k7f3q2", "x".repeat(MAX_BINDER_PATH_CHARS + 1)]) {
      expect(splitBinderPath(bad)).toBeNull();
    }
  });
});
