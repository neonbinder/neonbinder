import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CHECKLIST_FILE_ACCEPT,
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
    const readXlsx = () => ({ ok: true as const, rows: [{ row: 4, cells: ["1"] }], truncatedAfterRow: 4 });
    const out = await readChecklistFile(fileOf("t.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04])), { readXlsx });
    expect(out.ok && out.input.kind === "cells" && out.input.cells.truncatedAfterLine).toBe(4);
  });

  it("refuses with words the dialog shows as they are", async () => {
    const big = await readChecklistFile(fileOf("huge.pdf", new Uint8Array(1), 21 * 1024 * 1024));
    expect(big).toEqual({ ok: false, message: "huge.pdf is too big — a PDF checklist is under 20 MB." });
    const xlsx = await readChecklistFile(fileOf("big.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 11 * 1024 * 1024));
    expect(xlsx).toEqual({ ok: false, message: "big.xlsx is too big — a spreadsheet checklist is under 10 MB." });
    const xls = await readChecklistFile(fileOf("old.xls", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])));
    expect(xls).toEqual({ ok: false, message: "old.xls is an old .xls workbook. Save it as .xlsx, then choose that." });
    const png = await readChecklistFile(fileOf("card.png", text("\x89PNG")));
    expect(png.ok === false && png.message).toMatch(/isn’t a checklist file we can read/);
    const locked = await readChecklistFile(fileOf("l.pdf", text("%PDF-1.4")), {
      readPdf: async () => ({ ok: false, reason: "password" }),
    });
    expect(locked.ok === false && locked.message).toMatch(/password-protected/);
    const broken = await readChecklistFile(fileOf("b.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])));
    expect(broken.ok === false && broken.message).toMatch(/Couldn’t read b\.xlsx as a spreadsheet/);
    const longText = await readChecklistFile(fileOf("l.csv", new Uint8Array(3 * 1024 * 1024).fill(0x41)));
    expect(longText).toEqual({ ok: false, message: "l.csv is too big — a text checklist is under 2 MB." });
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

  it("leaf mode keeps the subset on each row for the dialog's ticks", async () => {
    const csv = await readChecklistFile(fixture("2026-donruss-sample.csv"));
    if (!csv.ok) throw new Error("not read");
    const parse = parseChecklistInput(csv.input);
    expect(parse.subsets).toEqual(["Base", "Base Rated Prospects", "Bomb Squad", "Bomb Squad Red Ice"]);
  });
});
