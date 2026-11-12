import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  PDF_MAX_FILE_BYTES,
  PDF_MAX_PAGES,
  cellGap,
  groupPageItems,
  readPdfLines,
  type PdfTextItem,
} from "./read-pdf-lines";

/** A 10 pt text item at (x, y) whose width is ~0.5 pt per character. */
function item(str: string, x: number, y: number, size = 10): PdfTextItem {
  return { str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size };
}

describe("groupPageItems — Topps columns by x-gap", () => {
  it("splits number, player and team on the wide gaps and keeps each name whole", () => {
    const lines = groupPageItems([
      item("BASE CARDS", 53, 700),
      item("1", 53, 686),
      item("Shohei Ohtani", 132.6, 686),
      item("Los Angeles Dodgers®", 298, 686),
    ]);
    expect(lines).toEqual([
      { cells: ["BASE CARDS"], xs: [53] },
      { cells: ["1", "Shohei Ohtani", "Los Angeles Dodgers®"], xs: [53, 132.6, 298] },
    ]);
  });

  it("joins words a space apart into one cell, and touching runs without a space", () => {
    const lines = groupPageItems([
      item("Bobby", 132.6, 500),
      // "Bobby" ends at 157.6; a 2.5 pt word space.
      item("Witt", 160.1, 500),
      // Touching run: no space added.
      item("Jr.", 180.1, 500),
    ]);
    expect(lines).toEqual([{ cells: ["Bobby WittJr."], xs: [132.6] }]);
  });

  it("puts items on one baseline within half a font height on one line, top to bottom", () => {
    const lines = groupPageItems([
      item("Kansas City Royals®", 298, 600.3),
      item("12", 53, 600),
      item("Bobby Witt Jr.", 132.6, 599.8),
      item("13", 53, 586),
      item("Kyle Karros", 132.6, 586),
      item("Colorado Rockies™", 298, 586),
    ]);
    expect(lines.map((l) => l.cells)).toEqual([
      ["12", "Bobby Witt Jr.", "Kansas City Royals®"],
      ["13", "Kyle Karros", "Colorado Rockies™"],
    ]);
  });

  it("collapses runs of spaces inside a cell and skips blank and rotated items", () => {
    const rotated: PdfTextItem = { str: "DRAFT", transform: [0, 10, -10, 0, 300, 400], width: 30, height: 10 };
    const lines = groupPageItems([
      item("   ", 53, 300),
      rotated,
      item("Craig Biggio", 132.6, 300),
      item("Houston  Astros®", 298, 300),
    ]);
    expect(lines).toEqual([{ cells: ["Craig Biggio", "Houston Astros®"], xs: [132.6, 298] }]);
  });

  it("starts a new cell at a gap of twice the font size, never under 12 pt", () => {
    expect(cellGap(5)).toBe(12);
    expect(cellGap(10)).toBe(20);
    const lines = groupPageItems([item("A", 53, 100), item("B", 53 + 5 + 19.9, 100), item("C", 105, 100)]);
    // A ends at 58; B starts 19.9 pt later (same cell); C starts 20+ pt after B ends (new cell).
    expect(lines[0].cells).toEqual(["A B", "C"]);
  });
});

type FakeDoc = { numPages: number; getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }> };

function fakePdfjs(doc: FakeDoc | Error) {
  const destroy = vi.fn(async () => undefined);
  const getDocument = vi.fn(() => ({
    promise: doc instanceof Error ? Promise.reject(doc) : Promise.resolve(doc),
    destroy,
  }));
  return { pdfjs: { getDocument } as never, getDocument, destroy };
}

describe("readPdfLines — with pdf.js stood in", () => {
  it("opens the document with font faces and XFA off, and destroys it after", async () => {
    const page = { getTextContent: async () => ({ items: [item("1", 53, 700), item("Shohei Ohtani", 132.6, 700), { type: "beginMarkedContent" }] }) };
    const fake = fakePdfjs({ numPages: 1, getPage: async () => page });
    const out = await readPdfLines(new Uint8Array([1, 2, 3]), { pdfjs: fake.pdfjs });
    expect(out).toEqual({
      ok: true,
      pages: 1,
      lines: [{ page: 1, line: 1, cells: ["1", "Shohei Ohtani"], xs: [53, 132.6] }],
    });
    expect(fake.getDocument).toHaveBeenCalledWith(
      expect.objectContaining({ disableFontFace: true, enableXfa: false }),
    );
    expect(fake.destroy).toHaveBeenCalled();
  });

  it("refuses more than 300 pages without reading any", async () => {
    const getPage = vi.fn();
    const fake = fakePdfjs({ numPages: PDF_MAX_PAGES + 1, getPage });
    expect(await readPdfLines(new Uint8Array(1), { pdfjs: fake.pdfjs })).toEqual({
      ok: false,
      reason: "too-many-pages",
    });
    expect(getPage).not.toHaveBeenCalled();
  });

  it("says a password-protected PDF is one, and anything else is malformed", async () => {
    const password = Object.assign(new Error("needs a password"), { name: "PasswordException" });
    expect(await readPdfLines(new Uint8Array(1), { pdfjs: fakePdfjs(password).pdfjs })).toEqual({
      ok: false,
      reason: "password",
    });
    expect(await readPdfLines(new Uint8Array(1), { pdfjs: fakePdfjs(new Error("bad xref")).pdfjs })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a file over 20 MB before loading pdf.js", async () => {
    const fake = fakePdfjs({ numPages: 1, getPage: vi.fn() });
    expect(await readPdfLines(new Uint8Array(PDF_MAX_FILE_BYTES + 1), { pdfjs: fake.pdfjs })).toEqual({
      ok: false,
      reason: "too-big",
    });
    expect(fake.getDocument).not.toHaveBeenCalled();
  });
});

describe("pdf.js as shipped", () => {
  it("has no eval path: no `new Function(` or `eval(` in the builds the app loads (CVE-2024-4367 class)", () => {
    const require = createRequire(import.meta.url);
    for (const build of ["pdfjs-dist/build/pdf.mjs", "pdfjs-dist/build/pdf.worker.min.mjs"]) {
      const source = readFileSync(require.resolve(build), "utf8");
      expect(source).not.toMatch(/new Function\(|[^.\w]eval\(/);
    }
  });
});

describe("readPdfLines — the real pdf.js on the Topps-layout sample (probe P2)", () => {
  it("splits the generated Topps PDF into number / player / team cells by x-gap", async () => {
    // Node needs pdf.js's legacy build; its API is the browser build's.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const require = createRequire(import.meta.url);
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
    ).href;
    const bytes = readFileSync(
      join(__dirname, "../../playwright/fixtures/checklists/2026-topps-chrome-sample.pdf"),
    );
    const out = await readPdfLines(new Uint8Array(bytes), { pdfjs });
    if (!out.ok) throw new Error(out.reason);
    const cells = out.lines.map((l) => l.cells);
    expect(cells).toContainEqual(["BASE CARDS"]);
    expect(cells).toContainEqual(["1", "Shohei Ohtani", "Los Angeles Dodgers®"]);
    expect(cells).toContainEqual(["3", "Yordan Alvarez", "Houston Astros®"]);
    expect(cells).toContainEqual(["FS-9", "Paul Skenes", "Pittsburgh Pirates®"]);
    expect(cells).toContainEqual(["Chase Utley", "Philadelphia Phillies®"]);
    const teamCard = out.lines.find((l) => l.cells[0] === "CT-1");
    expect(teamCard?.cells).toEqual(["CT-1", "Los Angeles Dodgers®"]);
    expect(teamCard?.xs[1]).toBeCloseTo(298, 0);
    expect(out.pages).toBe(2);
  }, 20_000);
});
