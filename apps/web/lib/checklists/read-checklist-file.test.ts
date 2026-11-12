import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync, type Zippable } from "fflate";
import {
  CHECKLIST_FILE_ACCEPT,
  HIDDEN_FILE_NAME_CHARS,
  checklistFileNameProblem,
  parseChecklistInput,
  readChecklistFile,
  readChecklistSections,
  sniffChecklistFile,
  type ChecklistFile,
} from "./read-checklist-file";

const FIXTURES = join(__dirname, "../../playwright/fixtures/checklists");

function fileOf(name: string, bytes: Uint8Array, size = bytes.length): ChecklistFile {
  return {
    name,
    size,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer,
  };
}

function fixture(name: string): ChecklistFile {
  return fileOf(name, new Uint8Array(readFileSync(join(FIXTURES, name))));
}

const text = (s: string) => new TextEncoder().encode(s);

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A workbook of named tabs, each a list of rows of inline-string cells. */
function tabs(sheets: Array<{ name: string; rows: string[][] }>): Uint8Array {
  const col = (i: number) => String.fromCharCode(65 + i);
  const files: Zippable = {
    "xl/workbook.xml": strToU8(
      `<workbook ${NS} xmlns:r="${REL}"><sheets>${sheets
        .map((sh, i) => `<sheet name="${sh.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships>${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    ),
  };
  sheets.forEach((sh, i) => {
    const body = sh.rows
      .map(
        (cells, r) =>
          `<row r="${r + 1}">${cells
            .map((c, j) => `<c r="${col(j)}${r + 1}" t="inlineStr"><is><t>${c}</t></is></c>`)
            .join("")}</row>`,
      )
      .join("");
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<worksheet ${NS}><sheetData>${body}</sheetData></worksheet>`);
  });
  return zipSync(files);
}

describe("sniffChecklistFile", () => {
  it("goes by the bytes, with the name only deciding text", () => {
    expect(sniffChecklistFile("anything.bin", new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("xlsx");
    expect(sniffChecklistFile("list.txt", text("junk\n%PDF-1.7"))).toBe("pdf");
    expect(sniffChecklistFile("old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe("xls");
    expect(sniffChecklistFile("list.CSV", text("1,A,B"))).toBe("text");
    expect(sniffChecklistFile("photo.png", text("\x89PNG"))).toBe("unknown");
  });

  it("offers the formats it reads", () => {
    expect(CHECKLIST_FILE_ACCEPT).toBe(".xlsx,.pdf,.csv,.tsv,.txt");
  });
});

describe("readChecklistFile", () => {
  it("reads a CSV as text", async () => {
    const out = await readChecklistFile(fileOf("list.csv", text("#,Player\n1,Mike Trout")));
    expect(out).toEqual({ ok: true, input: { kind: "text", text: "#,Player\n1,Mike Trout" } });
  });

  it("reads the Donruss-layout sample spreadsheet into cells, by sheet row", async () => {
    const out = await readChecklistFile(fixture("2026-donruss-sample.xlsx"));
    if (!out.ok || out.input.kind !== "cells") throw new Error("not read");
    expect(out.input.cells.format).toBe("xlsx");
    expect(out.input.cells.records.slice(0, 3)).toEqual([
      { line: 1, cells: ["Spreadsheet made available by Checklist Insider."] },
      { line: 2, cells: ["CARD SET", "CARD #", "ATHLETE", "TEAM", "SEQ"] },
      { line: 3, cells: ["Base", "1", "Ken Griffey Jr.", "Seattle Mariners"] },
    ]);
  });

  it("hands a PDF to the PDF reader and keeps page, line and x", async () => {
    const readPdf = vi.fn(async () => ({
      ok: true as const,
      pages: 1,
      lines: [{ page: 1, line: 1, cells: ["1", "A"], xs: [53, 132.6] }],
    }));
    const out = await readChecklistFile(fileOf("t.pdf", text("%PDF-1.4\n")), { readPdf });
    expect(out).toEqual({
      ok: true,
      input: { kind: "cells", cells: { format: "pdf", records: [{ line: 1, page: 1, cells: ["1", "A"], xs: [53, 132.6] }] } },
    });
  });

  it("passes on where a long file was cut off", async () => {
    const readXlsx = () => ({ ok: true as const, rows: [{ row: 4, cells: ["1"] }], sheets: [""], truncatedAfterRow: 4 });
    const out = await readChecklistFile(fileOf("t.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04])), { readXlsx });
    expect(out.ok && out.input.kind === "cells" && out.input.cells.truncatedAfterLine).toBe(4);
  });

  it("refuses with a kind and words the dialog shows as they are", async () => {
    const big = await readChecklistFile(fileOf("huge.pdf", new Uint8Array(1), 21 * 1024 * 1024));
    expect(big).toEqual({
      ok: false,
      reason: "too-big",
      message: "huge.pdf is too big. PDFs top out at 20 MB; save just this set’s pages.",
    });
    const xlsx = await readChecklistFile(fileOf("big.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 11 * 1024 * 1024));
    expect(xlsx).toEqual({
      ok: false,
      reason: "too-big",
      message: "big.xlsx is too big. Spreadsheets top out at 10 MB; save just this set’s sheet.",
    });
    const xls = await readChecklistFile(fileOf("old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])));
    expect(xls).toEqual({
      ok: false,
      reason: "old-xls",
      message: "old.xls is an old .xls workbook. Save it as .xlsx, then choose that.",
    });
    const png = await readChecklistFile(fileOf("card.png", text("\x89PNG")));
    expect(png.ok === false && png.reason).toBe("unknown-format");
    expect(png.ok === false && png.message).toMatch(/isn’t a checklist file we can read/);
    const locked = await readChecklistFile(fileOf("l.pdf", text("%PDF-1.4")), {
      readPdf: async () => ({ ok: false, reason: "password" }),
    });
    expect(locked.ok === false && locked.reason).toBe("password");
    expect(locked.ok === false && locked.message).toMatch(/password-protected/);
    const broken = await readChecklistFile(fileOf("b.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])));
    expect(broken.ok === false && broken.reason).toBe("malformed");
    expect(broken.ok === false && broken.message).toMatch(/Couldn’t read b\.xlsx as a spreadsheet/);
    const brokenPdf = await readChecklistFile(fileOf("b.pdf", text("%PDF-1.4")), {
      readPdf: async () => ({ ok: false, reason: "malformed" }),
    });
    expect(brokenPdf.ok === false && brokenPdf.message).toBe(
      "Couldn’t read b.pdf as a PDF. Try the checklist’s spreadsheet, or paste the list.",
    );
    const longText = await readChecklistFile(fileOf("l.csv", new Uint8Array(3 * 1024 * 1024).fill(0x41)));
    expect(longText).toEqual({
      ok: false,
      reason: "too-big",
      message: "l.csv is too big. Text files top out at 2 MB; save just this set’s list.",
    });
    const packed = await readChecklistFile(fileOf("p.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04])), {
      readXlsx: () => ({ ok: false, reason: "part-too-big" }),
    });
    expect(packed).toEqual({
      ok: false,
      reason: "too-much-data",
      message: "p.xlsx packs more than one checklist. Copy this set’s sheet into its own file and upload that.",
    });
  });

  it("refuses a file name with a hidden direction or zero-width character before reading a byte", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    for (const name of ["list\u202Etxt.csv", "zero\u200Bwidth.xlsx", "mark\u200Ftop.pdf", "iso\u2066late.csv"]) {
      expect(checklistFileNameProblem(name)).toBe(HIDDEN_FILE_NAME_CHARS);
      const out = await readChecklistFile({ name, size: 10, arrayBuffer });
      expect(out).toEqual({ ok: false, reason: "hidden-name-chars", message: HIDDEN_FILE_NAME_CHARS });
    }
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(HIDDEN_FILE_NAME_CHARS).toBe(
      "This file's name has sneaky invisible characters. Rename the file and try again.",
    );
    expect(checklistFileNameProblem("2026 Donruss — checklist (final).xlsx")).toBeNull();
  });

  it("reads every tab of a workbook, each row carrying its tab", async () => {
    const out = await readChecklistFile(
      fileOf(
        "tabs.xlsx",
        tabs([
          { name: "Base", rows: [["#", "Player", "Team"], ["1", "Ken Griffey Jr.", "Seattle Mariners"]] },
          { name: "Bomb Squad", rows: [["#", "Player", "Team"], ["BS-1", "Aaron Judge", "New York Yankees"]] },
        ]),
      ),
    );
    if (!out.ok || out.input.kind !== "cells") throw new Error("not read");
    expect(out.input.cells.records).toEqual([
      { line: 1, cells: ["#", "Player", "Team"], sheet: "Base" },
      { line: 2, cells: ["1", "Ken Griffey Jr.", "Seattle Mariners"], sheet: "Base" },
      { line: 1, cells: ["#", "Player", "Team"], sheet: "Bomb Squad" },
      { line: 2, cells: ["BS-1", "Aaron Judge", "New York Yankees"], sheet: "Bomb Squad" },
    ]);
  });
});

describe("parseChecklistInput / readChecklistSections on the committed samples", () => {
  it("the spreadsheet and the CSV of the same Donruss content give the same sections", async () => {
    const xlsx = await readChecklistFile(fixture("2026-donruss-sample.xlsx"));
    const csv = await readChecklistFile(fixture("2026-donruss-sample.csv"));
    if (!xlsx.ok || !csv.ok) throw new Error("not read");
    const fromXlsx = readChecklistSections(xlsx.input, { setYear: 2026 });
    const fromCsv = readChecklistSections(csv.input, { setYear: 2026 });
    expect(fromXlsx.sections).toEqual(fromCsv.sections);
    expect(fromXlsx.sections.map((s) => [s.name, s.rows.length])).toEqual([
      ["Base", 5],
      ["Base Rated Prospects", 3],
      ["Bomb Squad", 3],
      ["Bomb Squad Red Ice", 3],
    ]);
    expect(fromXlsx.sections[1].rows[0]).toEqual({
      number: "101",
      players: ["Konnor Griffin"],
      teams: ["Pittsburgh Pirates"],
    });
  });

  it("a workbook of tabs gives one section per tab with no set column, and groups a set column's sections under its tab", async () => {
    const out = await readChecklistFile(
      fileOf(
        "tabs.xlsx",
        tabs([
          { name: "Base", rows: [["Card #", "Athlete", "Team"], ["1", "Ken Griffey Jr.", "Seattle Mariners"], ["2", "Mike Trout", "Los Angeles Angels"]] },
          {
            name: "Inserts",
            rows: [
              ["Card Set", "Card #", "Athlete", "Team"],
              ["Bomb Squad", "1", "Aaron Judge", "New York Yankees"],
              ["Crunch Time", "1", "Shohei Ohtani", "Los Angeles Dodgers"],
            ],
          },
          { name: "Notes", rows: [] },
        ]),
      ),
    );
    if (!out.ok) throw new Error("not read");
    const sections = readChecklistSections(out.input);
    expect(sections.sections.map((s) => [s.name, s.group ?? null, s.rows.length])).toEqual([
      ["Base", null, 2],
      ["Bomb Squad", "Inserts", 1],
      ["Crunch Time", "Inserts", 1],
    ]);
    expect(sections.skipped).toEqual([]);
  });

  it("a one-sheet workbook with blank extra tabs reads exactly as a one-sheet workbook", async () => {
    const rows = [["Card Set", "Card #", "Athlete", "Team"], ["Base", "1", "Ken Griffey Jr.", "Seattle Mariners"]];
    const one = await readChecklistFile(fileOf("one.xlsx", tabs([{ name: "Sheet 1", rows }])));
    const padded = await readChecklistFile(
      fileOf("two.xlsx", tabs([{ name: "Sheet 1", rows }, { name: "Sheet 2", rows: [] }])),
    );
    if (!one.ok || !padded.ok) throw new Error("not read");
    expect(padded.input).toEqual(one.input);
    expect(readChecklistSections(padded.input).sections[0].group).toBeUndefined();
  });

  it("leaf mode keeps the subset on each row for the dialog's ticks", async () => {
    const csv = await readChecklistFile(fixture("2026-donruss-sample.csv"));
    if (!csv.ok) throw new Error("not read");
    const parse = parseChecklistInput(csv.input);
    expect(parse.subsets).toEqual(["Base", "Base Rated Prospects", "Bomb Squad", "Bomb Squad Red Ice"]);
  });
});
