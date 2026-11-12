import { describe, expect, it } from "vitest";
import { sectionKeyOf } from "../../convex/lib/publishedChecklistSections";
import {
  HIDDEN_CHARS_IN_GROUP,
  HIDDEN_CHARS_IN_NAME,
  SET_CHECKLIST_MAX_ROWS,
  SET_CHECKLIST_MAX_SECTION_ROWS,
  SET_CHECKLIST_MAX_SECTIONS,
  checklistSectionKey,
  checklistSections,
  pastRowLimitReason,
  pastSectionLimitReason,
  sectionTooBigReason,
} from "./checklist-sections";
import {
  NOT_IN_A_SECTION,
  parsePublishedChecklist,
  type PublishedChecklistParse,
  type PublishedChecklistRow,
} from "./parse-published-checklist";

function parseOf(rows: PublishedChecklistRow[], extra: Partial<PublishedChecklistParse> = {}) {
  return { rows, skipped: [], format: "csv" as const, ...extra };
}

function rowsIn(subset: string, count: number, from = 1): PublishedChecklistRow[] {
  return Array.from({ length: count }, (_, i) => ({
    number: String(from + i),
    players: [`P${from + i}`],
    teams: [],
    subset,
  }));
}

describe("checklistSections", () => {
  it("groups a set-mode parse into its sections in file order, rows without their subset", () => {
    const parse = parsePublishedChecklist(
      [
        "Spreadsheet made available by Checklist Insider.",
        "CARD SET,CARD #,ATHLETE,TEAM,SEQ",
        "Base,1,Ken Griffey Jr.,Seattle Mariners,",
        "Bomb Squad,1,Bryce Eldridge,San Francisco Giants,",
        "Base,2,Johnny Bench,No Team,",
      ].join("\n"),
      { mode: "set" },
    );
    const out = checklistSections(parse);
    expect(out.format).toBe("csv");
    expect(out.rowCount).toBe(3);
    expect(out.sections).toEqual([
      {
        name: "Base",
        key: "base",
        rows: [
          { number: "1", players: ["Ken Griffey Jr."], teams: ["Seattle Mariners"] },
          { number: "2", players: ["Johnny Bench"], teams: [], noTeam: true },
        ],
      },
      {
        name: "Bomb Squad",
        key: "bomb squad",
        rows: [{ number: "1", players: ["Bryce Eldridge"], teams: ["San Francisco Giants"] }],
      },
    ]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skippedSections).toEqual([]);
  });

  it("carries a heading's group and an NNO row's flag", () => {
    const parse = parsePublishedChecklist(
      ["INSERT", "FANATICS AUTHENTICS", "NNO Chase Utley - Philadelphia Phillies"].join("\n"),
      { mode: "set" },
    );
    expect(checklistSections(parse).sections).toEqual([
      {
        name: "FANATICS AUTHENTICS",
        key: "fanatics authentics",
        group: "INSERT",
        rows: [{ number: "NNO", players: ["Chase Utley"], teams: ["Philadelphia Phillies"], noNumber: true }],
      },
    ]);
  });

  it("skips rows outside any section in set mode, with the reason", () => {
    const parse = parsePublishedChecklist("1 A Guy - Team\nHELIX\n2 B Guy - Team", { mode: "set" });
    const out = checklistSections(parse);
    expect(out.sections.map((s) => s.name)).toEqual(["HELIX"]);
    expect(out.skipped.map((s) => s.reason)).toEqual([NOT_IN_A_SECTION]);
  });

  it("is one section for names that fold alike, under the first name met", () => {
    const out = checklistSections(
      parseOf([...rowsIn("Bomb Squad", 1), ...rowsIn("BOMB  SQUAD", 1, 2), ...rowsIn("Base", 1)]),
    );
    expect(out.sections.map((s) => [s.name, s.key, s.rows.length])).toEqual([
      ["Bomb Squad", "bomb squad", 2],
      ["Base", "base", 1],
    ]);
  });

  it("folds a key exactly as the server does", () => {
    for (const name of ["Bomb Squad", "  BOMB\tSQUAD ", "Café Ñ", "CAFÉ"]) {
      expect(checklistSectionKey(name)).toBe(sectionKeyOf(name));
    }
  });

  it("never reads a group off the prototype for a section named constructor, toString or __proto__", () => {
    const names = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"];
    const out = checklistSections(
      parseOf(
        names.flatMap((n, i) => rowsIn(n, 1, i + 1)),
        { groups: { INSERT: "AUTOGRAPH" } },
      ),
    );
    expect(out.sections.map((s) => [s.name, s.group, s.rows.length])).toEqual(
      names.map((n) => [n, undefined, 1]),
    );
  });

  it("reads a group the parse really holds under a prototype-shaped name", () => {
    const groups: Record<string, string> = Object.create(null);
    groups["__proto__"] = "AUTOGRAPH";
    groups["constructor"] = "INSERT";
    const out = checklistSections(
      parseOf([...rowsIn("__proto__", 1), ...rowsIn("constructor", 1, 2)], { groups }),
    );
    expect(out.sections.map((s) => [s.name, s.group])).toEqual([
      ["__proto__", "AUTOGRAPH"],
      ["constructor", "INSERT"],
    ]);
  });

  it("writes the parse's groups with no prototype", () => {
    const parse = parsePublishedChecklist(["INSERT", "CONSTRUCTOR", "1 A Guy - Team"].join("\n"), {
      mode: "set",
    });
    expect(parse.groups).toEqual({ CONSTRUCTOR: "INSERT" });
    expect(Object.getPrototypeOf(parse.groups)).toBeNull();
  });

  it("leaves out whole, with the reason, a section whose name or group hides a direction or zero-width character", () => {
    const out = checklistSections(
      parseOf(
        [
          ...rowsIn("Bomb\u200bSquad", 2),
          ...rowsIn("Future Stars", 1, 3),
          ...rowsIn("Helix\u202e", 1, 4),
          ...rowsIn("Base", 1, 5),
        ],
        { groups: { "Future Stars": "INSERT\u2066" } },
      ),
    );
    expect(out.sections.map((s) => s.name)).toEqual(["Base"]);
    expect(out.rowCount).toBe(1);
    expect(out.skippedSections).toEqual([
      { name: "Bomb\u200bSquad", rowCount: 2, reason: HIDDEN_CHARS_IN_NAME },
      { name: "Future Stars", rowCount: 1, reason: HIDDEN_CHARS_IN_GROUP },
      { name: "Helix\u202e", rowCount: 1, reason: HIDDEN_CHARS_IN_NAME },
    ]);
  });

  it("cleans control characters out of a section name", () => {
    const out = checklistSections(parseOf(rowsIn("Bomb\u0001Squad", 1)));
    expect(out.sections[0].name).toBe("Bomb Squad");
  });

  it("leaves a section over 2,000 rows out whole, never cut", () => {
    const out = checklistSections(
      parseOf([...rowsIn("Big", SET_CHECKLIST_MAX_SECTION_ROWS + 1), ...rowsIn("Small", 3)]),
    );
    expect(out.sections.map((s) => s.name)).toEqual(["Small"]);
    expect(out.skippedSections).toEqual([
      { name: "Big", rowCount: SET_CHECKLIST_MAX_SECTION_ROWS + 1, reason: sectionTooBigReason() },
    ]);
    expect(sectionTooBigReason()).toBe("More than 2,000 cards in one section");
  });

  it("keeps the first 1,000 sections and leaves the rest out with the reason", () => {
    const rows = Array.from({ length: SET_CHECKLIST_MAX_SECTIONS + 2 }, (_, i) => rowsIn(`S${i}`, 1)).flat();
    const out = checklistSections(parseOf(rows));
    expect(out.sections).toHaveLength(SET_CHECKLIST_MAX_SECTIONS);
    expect(out.skippedSections.map((s) => [s.name, s.reason])).toEqual([
      [`S${SET_CHECKLIST_MAX_SECTIONS}`, pastSectionLimitReason()],
      [`S${SET_CHECKLIST_MAX_SECTIONS + 1}`, pastSectionLimitReason()],
    ]);
  });

  it("holds the 50,000-row total by whole sections, still taking a later section that fits", () => {
    const full = Array.from({ length: SET_CHECKLIST_MAX_ROWS / 2000 }, (_, i) => rowsIn(`F${i}`, 2000)).flat();
    const out = checklistSections(parseOf([...full.slice(0, -10), ...rowsIn("Over", 20), ...rowsIn("Fits", 10)]));
    expect(out.rowCount).toBe(SET_CHECKLIST_MAX_ROWS);
    expect(out.skippedSections).toEqual([{ name: "Over", rowCount: 20, reason: pastRowLimitReason() }]);
    expect(out.sections.at(-1)?.name).toBe("Fits");
  });

  it("passes a paste too big to read straight through", () => {
    const out = checklistSections({ rows: [], skipped: [], format: "lines", tooBig: true });
    expect(out).toEqual({ format: "lines", sections: [], skipped: [], skippedSections: [], rowCount: 0, tooBig: true });
  });
});
