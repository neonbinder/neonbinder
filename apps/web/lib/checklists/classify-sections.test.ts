import { describe, expect, it } from "vitest";
import { classifySections, type SectionEvidence } from "./classify-sections";

/** "1".."n" from `from`, optionally with a prefix ("FS-"). */
function run(from: number, count: number, prefix = ""): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${from + i}`);
}

/** A section with every card number. */
const rows = (name: string, numbers: string[]): SectionEvidence => ({ name, numbers });

/** A section as the server stores it: first and last number, and its row count. */
const stored = (name: string, numbers: string[]): SectionEvidence => ({
  name,
  firstNumber: numbers[0],
  lastNumber: numbers[numbers.length - 1],
  rowCount: numbers.length,
});

describe("classifySections — names only", () => {
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
      // Names alone can't tell a subset from a parallel: read as a parallel, as always.
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

  it("names a base child's nearest parent: the parallel it extends", () => {
    const out = classifySections(["Base", "Base Optic", "Base Optic Gold"]);
    expect(out.sections[2]).toEqual({ name: "Base Optic Gold", kind: "base-child", parent: "Base Optic" });
  });
});

describe("classifySections — S5: the base heading's other spellings", () => {
  it.each([
    "Base Cards I",
    "Base Set Checklist",
    "Base Cards – Series 1",
    "Base Cards - Series 2",
    "BASE CARDS — SERIES 3",
    "Base Checklist",
    "Base Cards II",
    "Base Series 1",
    "base cards: series 1",
  ])("%s is the base", (name) => {
    expect(classifySections([name, "Future Stars"]).base).toBe(name);
  });

  it.each(["Base Cards Gold", "Base Set Rookies", "Base Cards Series", "Base Cards V", "Basecards"])(
    "%s is not a base name",
    (name) => {
      expect(classifySections([name, "Future Stars"]).base).toBeNull();
    },
  );

  it("two series headings are two bases, so the operator picks", () => {
    expect(classifySections(["Base Cards I", "Base Cards II"]).base).toBeNull();
  });
});

describe("classifySections — S1: never chained through an autograph or relic", () => {
  it.each([
    ["FUTURE STARS", "FUTURE STARS AUTOGRAPHS"],
    ["Donruss Ballpark Stars", "Donruss Ballpark Stars Signatures"],
    ["Diamond Kings", "Diamond Kings Auto"],
    ["Diamond Kings", "Diamond Kings Autos"],
    ["Diamond Kings", "Diamond Kings Autographed Gold"],
    ["Diamond Kings", "Diamond Kings Relics"],
    ["Diamond Kings", "Diamond Kings Dual Patch"],
    ["Diamond Kings", "Diamond Kings Jersey"],
    ["Diamond Kings", "Diamond Kings Memorabilia"],
    ["Diamond Kings", "Diamond Kings Materials Gold"],
    ["Diamond Kings", "Diamond Kings Signed"],
    ["Diamond Kings", "Diamond Kings Swatches"],
  ])("%s → %s is its own root", (parent, child) => {
    const out = classifySections([parent, child]);
    expect(out.sections[1]).toEqual({ name: child, kind: "other" });
  });

  it("an autograph of the base is its own insert, and its colours are ITS parallels", () => {
    const out = classifySections([
      "Base",
      "Base Rated Prospects",
      "Base Rated Prospects Optic",
      "Base Rated Prospects Optic Signatures",
      "Base Rated Prospects Optic Signatures Gold",
    ]);
    expect(out.sections.slice(3)).toEqual([
      { name: "Base Rated Prospects Optic Signatures", kind: "other" },
      {
        name: "Base Rated Prospects Optic Signatures Gold",
        kind: "other",
        parent: "Base Rated Prospects Optic Signatures",
      },
    ]);
  });

  it("only the words a section adds count: Jersey Kings Blue is still Jersey Kings' parallel", () => {
    const out = classifySections(["Jersey Kings", "Jersey Kings Blue", "Signature Series", "Signature Series Red"]);
    expect(out.sections[1]).toEqual({ name: "Jersey Kings Blue", kind: "other", parent: "Jersey Kings" });
    expect(out.sections[3]).toEqual({ name: "Signature Series Red", kind: "other", parent: "Signature Series" });
  });
});

describe("classifySections — S1: the card numbers decide what a link means", () => {
  const donruss = (of: (name: string, numbers: string[]) => SectionEvidence) => [
    of("Base", run(1, 100)),
    of("Base Red", run(1, 100)),
    of("Base Rated Prospects", run(101, 100)),
    of("Base Rated Prospects Red", run(101, 100)),
    of("Base Rated Prospects Optic Signatures", run(101, 89)),
    of("Bomb Squad", run(1, 20)),
    of("Bomb Squad Red Ice", run(1, 20)),
  ];
  const expected = [
    { name: "Base", kind: "base" },
    { name: "Base Red", kind: "base-child", parent: "Base" },
    { name: "Base Rated Prospects", kind: "base-subset", parent: "Base" },
    { name: "Base Rated Prospects Red", kind: "base-child", parent: "Base Rated Prospects" },
    { name: "Base Rated Prospects Optic Signatures", kind: "other" },
    { name: "Bomb Squad", kind: "other" },
    { name: "Bomb Squad Red Ice", kind: "other", parent: "Bomb Squad" },
  ];

  it("Donruss with every number: Rated Prospects (101-200 after a 1-100 base) is a base subset", () => {
    expect(classifySections(donruss(rows)).sections).toEqual(expected);
  });

  it("Donruss from the stored first/last numbers gives the same answer", () => {
    expect(classifySections(donruss(stored)).sections).toEqual(expected);
  });

  const topps = (of: (name: string, numbers: string[]) => SectionEvidence) => [
    of("BASE CARDS", run(1, 300)),
    of("BASE CARDS LIGHTBOARD LOGO VARIATION", run(1, 300)),
    of("BASE CARDS IMAGE VARIATIONS", [...run(1, 49), "299"]),
    of("FUTURE STARS", run(1, 10, "FS-")),
    of("FUTURE STARS REFRACTOR", run(1, 10, "FS-")),
  ];
  const toppsExpected = [
    { name: "BASE CARDS", kind: "base" },
    { name: "BASE CARDS LIGHTBOARD LOGO VARIATION", kind: "base-child", parent: "BASE CARDS" },
    // 50 of the base's 300 numbers: a variation, not a parallel. Its own insert.
    { name: "BASE CARDS IMAGE VARIATIONS", kind: "other" },
    { name: "FUTURE STARS", kind: "other" },
    { name: "FUTURE STARS REFRACTOR", kind: "other", parent: "FUTURE STARS" },
  ];

  it("Topps with every number: a parallel covers the base, an image variation only some of it", () => {
    expect(classifySections(topps(rows)).sections).toEqual(toppsExpected);
  });

  it("Topps from the stored first/last numbers gives the same answer", () => {
    expect(classifySections(topps(stored)).sections).toEqual(toppsExpected);
  });

  it("a base parallel across the base AND its subset is still a parallel", () => {
    const out = classifySections([
      rows("Base", run(1, 100)),
      rows("Base Rated Prospects", run(101, 100)),
      rows("Base Holo", run(1, 200)),
    ]);
    expect(out.sections[2]).toEqual({ name: "Base Holo", kind: "base-child", parent: "Base" });
    const fromStore = classifySections([
      stored("Base", run(1, 100)),
      stored("Base Rated Prospects", run(101, 100)),
      stored("Base Holo", run(1, 200)),
    ]);
    expect(fromStore.sections[2].kind).toBe("base-child");
  });

  it("numbered another way, a section named after its link is unrelated: its own root", () => {
    const out = classifySections([
      rows("Base", run(1, 100)),
      rows("Base Rookie Debut", run(1, 20, "RD-")),
      rows("Bomb Squad", run(1, 20)),
      rows("Bomb Squad Mini", run(1, 20, "BSM-")),
    ]);
    expect(out.sections[1]).toEqual({ name: "Base Rookie Debut", kind: "other" });
    expect(out.sections[3]).toEqual({ name: "Bomb Squad Mini", kind: "other" });
  });

  it("a section's NNO rows are left out of its numbers", () => {
    const out = classifySections([rows("Base", run(1, 10)), rows("Base Red", [...run(1, 10), "NNO", "nno"])]);
    expect(out.sections[1].kind).toBe("base-child");
  });

  it("a section with no numbers to read keeps the names-only reading", () => {
    const out = classifySections([rows("Base", run(1, 10)), { name: "Base Red" }, rows("Base Blue", ["NNO"])]);
    expect(out.sections.map((s) => s.kind)).toEqual(["base", "base-child", "base-child"]);
  });

  it("stored letter codes without a trailing number decide only by numbering", () => {
    const out = classifySections([
      stored("ROOKIE AUTOGRAPHS", ["RA-AA", "RA-ZM"]),
      stored("ROOKIE AUTOGRAPHS GOLD", ["RA-AB", "RA-ZM"]),
      stored("ROOKIE AUTOGRAPHS CHROME", ["CRA-AB", "CRA-ZM"]),
    ]);
    // Same numbering, no range to compare: read by name, a parallel.
    expect(out.sections[1]).toEqual({ name: "ROOKIE AUTOGRAPHS GOLD", kind: "other", parent: "ROOKIE AUTOGRAPHS" });
    // Another numbering: unrelated.
    expect(out.sections[2]).toEqual({ name: "ROOKIE AUTOGRAPHS CHROME", kind: "other" });
  });

  it("a subset's own continuation is a subset too, and never a parallel of the base", () => {
    const out = classifySections([
      rows("Base", run(1, 100)),
      rows("Base Rated Prospects", run(101, 100)),
      rows("Base Rated Prospects Rookies", run(201, 25)),
    ]);
    expect(out.sections[2]).toEqual({
      name: "Base Rated Prospects Rookies",
      kind: "base-subset",
      parent: "Base Rated Prospects",
    });
  });
});
