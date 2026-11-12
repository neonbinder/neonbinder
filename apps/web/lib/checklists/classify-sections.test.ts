import { describe, expect, it } from "vitest";
import { classifySections } from "./classify-sections";

describe("classifySections", () => {
  it("finds Base, its children, and the other roots with their parents (Donruss)", () => {
    const out = classifySections([
      "Base",
      "Base Rated Prospects",
      "Base Red Ice",
      "Bomb Squad",
      "Bomb Squad Red Ice",
      "Bomb Squad Red Ice Die Cut",
      "Alter Ego",
    ]);
    expect(out.base).toBe("Base");
    expect(out.sections).toEqual([
      { name: "Base", kind: "base" },
      { name: "Base Rated Prospects", kind: "base-child", parent: "Base" },
      { name: "Base Red Ice", kind: "base-child", parent: "Base" },
      { name: "Bomb Squad", kind: "other" },
      { name: "Bomb Squad Red Ice", kind: "other", parent: "Bomb Squad" },
      { name: "Bomb Squad Red Ice Die Cut", kind: "other", parent: "Bomb Squad Red Ice" },
      { name: "Alter Ego", kind: "other" },
    ]);
  });

  it("reads BASE CARDS as the base and its variations as children (Topps)", () => {
    const out = classifySections(["BASE CARDS", "FUTURE STARS", "BASE CARDS IMAGE VARIATIONS"]);
    expect(out.base).toBe("BASE CARDS");
    expect(out.sections.map((s) => s.kind)).toEqual(["base", "other", "base-child"]);
  });

  it("takes the set's own name off a section's front before looking for base", () => {
    const out = classifySections(["2026 Donruss Base Set", "2026 Donruss Bomb Squad"], {
      setNames: ["Donruss", "2026 Donruss"],
    });
    expect(out.base).toBe("2026 Donruss Base Set");
  });

  it("has no base when none, or more than one, section is named base", () => {
    expect(classifySections(["Bomb Squad", "Alter Ego"]).base).toBeNull();
    const two = classifySections(["Base", "Base Set", "Base Set Gold"]);
    expect(two.base).toBeNull();
    // With no base, nothing is a base child; "Base Set Gold" extends "Base Set".
    expect(two.sections).toEqual([
      { name: "Base", kind: "other" },
      { name: "Base Set", kind: "other", parent: "Base" },
      { name: "Base Set Gold", kind: "other", parent: "Base Set" },
    ]);
  });

  it("matches by whole words: Baseball Heroes is not a base child", () => {
    const out = classifySections(["Base", "Baseball Heroes"]);
    expect(out.sections[1]).toEqual({ name: "Baseball Heroes", kind: "other" });
  });

  it("ignores case and spacing", () => {
    const out = classifySections(["  base  cards ", "Base Cards  Gold"]);
    expect(out.base).toBe("  base  cards ");
    expect(out.sections[1].kind).toBe("base-child");
  });
});
