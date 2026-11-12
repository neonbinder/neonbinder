#!/usr/bin/env node
/**
 * NEO-496 — build publisher-checklist fixtures in the publishers' own layouts:
 *
 *  - a **Topps-layout PDF**: a title line, ALL-CAPS group headings with no
 *    rows ("BASE", "INSERT"), ALL-CAPS section headings, then one line per
 *    card with the number, player and team in three columns set apart by
 *    wide gaps (x = 53, 132.6 and 298 pt, as Topps prints them). A card
 *    with no number prints only player and team; a team card only number
 *    and team. Optional filler pages carry nothing but a lone word per line
 *    (Topps' "Rookie" pages), which the reader skips.
 *  - a **Donruss-layout .xlsx**: a credit line, then the header `CARD SET |
 *    CARD # | ATHLETE | TEAM | SEQ`, then one row per card; card numbers are
 *    stored as numbers, the rest as shared strings.
 *  - the same Donruss content as a plain **.csv**.
 *
 * Every builder takes the section contents as data, so a spec can build a
 * per-attempt file (a token section of its own) at run time:
 *
 *   import { buildToppsPdf } from "../fixtures/checklists/build-fixtures.mjs";
 *   const pdf = buildToppsPdf({ title, groups: [...] }); // a Buffer
 *
 * Run as a script to (re)write the committed samples beside this file:
 *
 *   node playwright/fixtures/checklists/build-fixtures.mjs
 *
 * The builders write only what a checklist needs and nothing else: no fonts
 * are embedded (Helvetica is one of PDF's standard fonts), no scripts, no
 * external references.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

// ── Topps-layout PDF ──────────────────────────────────────────────────────

/**
 * @typedef {{ number?: string, player?: string, team?: string }} ToppsRow
 *   Omit `number` for a card printed without one; omit `player` for a team card.
 * @typedef {{ heading: string, rows: ToppsRow[] }} ToppsSection
 * @typedef {{ heading?: string, sections: ToppsSection[] }} ToppsGroup
 * @typedef {{ title: string, groups: ToppsGroup[], fillerPages?: number, fillerWord?: string }} ToppsSpec
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const TOP = 740;
const BOTTOM = 90;
const LINE = 14;
const COLUMNS = { number: 53, player: 132.6, team: 298 };
const FOOTER = [
  "Checklists provided by Topps reflect the intended configurations of that product at the time of",
  "production, but actual contents and odds may vary.",
];

/** WinAnsi bytes for a PDF string literal, with ( ) \ escaped. */
function pdfString(text) {
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    let byte;
    if (ch === "™") byte = 0x99;
    else if (ch === "’") byte = 0x92;
    else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) byte = code;
    else byte = 0x3f; // "?"
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) bytes.push(0x5c);
    bytes.push(byte);
  }
  return `(${Buffer.from(bytes).toString("latin1")})`;
}

function textAt(font, size, x, y, text) {
  return `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm ${pdfString(text)} Tj ET`;
}

/**
 * Lay a Topps-style checklist out on pages.
 * @param {ToppsSpec} spec
 * @returns {string[][]} each page's content-stream operations
 */
function layoutTopps(spec) {
  const pages = [];
  let ops = [];
  let y = TOP;
  const newPage = () => {
    ops.push(...FOOTER.map((line, i) => textAt("F1", 8, 53, 50 - i * 10, line)));
    pages.push(ops);
    ops = [];
    y = TOP;
  };
  const need = (lines) => {
    if (y - lines * LINE < BOTTOM) newPage();
  };
  ops.push(textAt("F2", 14, 53, y, spec.title));
  y -= LINE * 2;
  for (const group of spec.groups) {
    if (group.heading) {
      need(3);
      ops.push(textAt("F2", 12, 53, y, group.heading));
      y -= LINE;
    }
    for (const section of group.sections) {
      need(2);
      ops.push(textAt("F2", 10, 53, y, section.heading));
      y -= LINE;
      for (const row of section.rows) {
        need(1);
        if (row.number) ops.push(textAt("F1", 10, COLUMNS.number, y, row.number));
        if (row.player) ops.push(textAt("F1", 10, COLUMNS.player, y, row.player));
        if (row.team) ops.push(textAt("F1", 10, COLUMNS.team, y, row.team));
        y -= LINE;
      }
      y -= LINE / 2;
    }
  }
  newPage();
  for (let p = 0; p < (spec.fillerPages ?? 0); p++) {
    for (let line = 0; line < 9; line++) {
      ops.push(textAt("F1", 9, 470, TOP - line * 60, spec.fillerWord ?? "Rookie"));
    }
    newPage();
  }
  return pages;
}

/**
 * A Topps-layout checklist PDF.
 * @param {ToppsSpec} spec
 * @returns {Buffer}
 */
export function buildToppsPdf(spec) {
  const pages = layoutTopps(spec);
  /** @type {string[]} object bodies, 1-based ids */
  const objects = [];
  const add = (body) => objects.push(body); // the new 1-based id
  const catalog = add("");
  const pagesId = add("");
  const regular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const pageIds = [];
  for (const ops of pages) {
    const stream = ops.join("\n");
    const content = add(
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// ── Donruss-layout spreadsheet and CSV ────────────────────────────────────

/**
 * @typedef {{ number: string, player: string, team: string, seq?: string }} DonrussRow
 * @typedef {{ name: string, rows: DonrussRow[] }} DonrussSection
 * @typedef {{ credit?: string, sections: DonrussSection[] }} DonrussSpec
 */

const DONRUSS_HEADER = ["CARD SET", "CARD #", "ATHLETE", "TEAM", "SEQ"];

function xmlEscape(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {DonrussSpec} spec @returns {Array<Array<string>>} the sheet's rows, credit first */
function donrussRows(spec) {
  const rows = [];
  if (spec.credit) rows.push([spec.credit]);
  rows.push(DONRUSS_HEADER);
  for (const section of spec.sections) {
    for (const row of section.rows) {
      rows.push([section.name, row.number, row.player, row.team, row.seq ?? ""]);
    }
  }
  return rows;
}

/**
 * A Donruss-layout .xlsx: one sheet, credit line, header, rows. A card
 * number or SEQ that is all digits is stored as a number, as Panini's are.
 * @param {DonrussSpec} spec
 * @returns {Buffer}
 */
export function buildDonrussXlsx(spec) {
  const shared = [];
  const sharedIndex = new Map();
  const stringCell = (ref, text) => {
    let index = sharedIndex.get(text);
    if (index === undefined) {
      index = shared.length;
      shared.push(text);
      sharedIndex.set(text, index);
    }
    return `<c r="${ref}" t="s"><v>${index}</v></c>`;
  };
  const sheetRows = donrussRows(spec).map((cells, r) => {
    const rowNumber = r + 1;
    const xmlCells = cells
      .map((cell, c) => {
        if (cell === "") return "";
        const ref = `${String.fromCharCode(65 + c)}${rowNumber}`;
        const numeric = (c === 1 || c === 4) && /^\d+$/.test(cell) && r > 0;
        return numeric ? `<c r="${ref}"><v>${cell}</v></c>` : stringCell(ref, cell);
      })
      .join("");
    return `<row r="${rowNumber}">${xmlCells}</row>`;
  });
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const files = {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      "</Types>",
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/>` +
      "</Relationships>",
    "xl/workbook.xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<workbook ${ns} xmlns:r="${rel}"><sheets>` +
      '<sheet name="Checklist" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/>` +
      "</Relationships>",
    "xl/worksheets/sheet1.xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<worksheet ${ns}><sheetData>${sheetRows.join("")}</sheetData></worksheet>`,
    "xl/sharedStrings.xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<sst ${ns} count="${shared.length}" uniqueCount="${shared.length}">` +
      shared.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join("") +
      "</sst>",
  };
  const zipped = zipSync(
    Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])),
    // A fixed date keeps the bytes the same run to run.
    { mtime: new Date("2026-01-01T00:00:00Z") },
  );
  return Buffer.from(zipped);
}

function csvCell(text) {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The same Donruss content as a plain CSV (credit line, header, rows).
 * @param {DonrussSpec} spec
 * @returns {Buffer}
 */
export function buildDonrussCsv(spec) {
  const lines = donrussRows(spec).map((cells) => cells.map(csvCell).join(","));
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

// ── Samples ───────────────────────────────────────────────────────────────

/** @type {ToppsSpec} A small 2026 Topps Chrome checklist in Topps' layout. */
export const TOPPS_SAMPLE = {
  title: "2026 Topps Chrome Baseball Checklist",
  groups: [
    {
      heading: "BASE",
      sections: [
        {
          heading: "BASE CARDS",
          rows: [
            { number: "1", player: "Shohei Ohtani", team: "Los Angeles Dodgers®" },
            { number: "2", player: "Cody Bellinger", team: "New York Yankees®" },
            { number: "3", player: "Yordan Alvarez", team: "Houston  Astros®" },
            { number: "4", player: "Brice Turang", team: "Milwaukee Brewers™" },
            { number: "5", player: "Trea Turner", team: "Philadelphia Phillies®" },
          ],
        },
      ],
    },
    {
      heading: "INSERT",
      sections: [
        {
          heading: "FUTURE STARS",
          rows: [
            { number: "FS-1", player: "Munetaka Murakami", team: "Chicago White Sox®" },
            { number: "FS-2", player: "Colson Montgomery", team: "Chicago White Sox®" },
            { number: "FS-3", player: "JJ Wetherholt", team: "St. Louis Cardinals®" },
            { number: "FS-4", player: "Samuel Basallo", team: "Baltimore Orioles®" },
            { number: "FS-5", player: "Nick Kurtz", team: "Athletics™" },
            { number: "FS-6", player: "Kevin McGonigle", team: "Detroit Tigers®" },
            { number: "FS-7", player: "Jac Caglianone", team: "Kansas City Royals®" },
            { number: "FS-8", player: "Roman Anthony", team: "Boston Red Sox®" },
            { number: "FS-9", player: "Paul Skenes", team: "Pittsburgh Pirates®" },
          ],
        },
        {
          heading: "2025 MLB COMMISSIONERS TROPHY",
          rows: [{ number: "CT-1", team: "Los Angeles Dodgers®" }],
        },
        {
          heading: "FANATICS AUTHENTICS REDEMPTION CARDS",
          rows: [
            { player: "Chase Utley", team: "Philadelphia Phillies®" },
            { player: "Nick Kurtz", team: "Athletics™" },
          ],
        },
      ],
    },
  ],
  fillerPages: 1,
  fillerWord: "Rookie",
};

/** @type {DonrussSpec} A small 2026 Donruss checklist in Panini's spreadsheet layout. */
export const DONRUSS_SAMPLE = {
  credit: "Spreadsheet made available by Checklist Insider.",
  sections: [
    {
      name: "Base",
      rows: [
        { number: "1", player: "Ken Griffey Jr.", team: "Seattle Mariners" },
        { number: "2", player: "Johnny Bench", team: "Cincinnati Reds" },
        { number: "3", player: "Chase DeLauter", team: "Cleveland Guardians" },
        { number: "4", player: "Byung-Hyun Kim", team: "Arizona Diamondbacks" },
        { number: "5", player: "Bubba Chandler", team: "Pittsburgh Pirates" },
      ],
    },
    {
      name: "Base Rated Prospects",
      rows: [
        { number: "101", player: "Konnor Griffin", team: "Pittsburgh Pirates" },
        { number: "102", player: "Andrew Fischer", team: "Milwaukee Brewers" },
        { number: "103", player: "Mike Sirota", team: "Los Angeles Dodgers" },
      ],
    },
    {
      name: "Bomb Squad",
      rows: [
        { number: "1", player: "Bryce Eldridge", team: "San Francisco Giants" },
        { number: "2", player: "Ken Griffey Jr.", team: "Seattle Mariners" },
        { number: "3", player: "Roman Anthony", team: "Boston Red Sox" },
      ],
    },
    {
      name: "Bomb Squad Red Ice",
      rows: [
        { number: "1", player: "Bryce Eldridge", team: "San Francisco Giants", seq: "149" },
        { number: "2", player: "Ken Griffey Jr.", team: "Seattle Mariners", seq: "149" },
        { number: "3", player: "Roman Anthony", team: "Boston Red Sox", seq: "149" },
      ],
    },
  ],
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const here = dirname(fileURLToPath(import.meta.url));
  writeFileSync(join(here, "2026-topps-chrome-sample.pdf"), buildToppsPdf(TOPPS_SAMPLE));
  writeFileSync(join(here, "2026-donruss-sample.xlsx"), buildDonrussXlsx(DONRUSS_SAMPLE));
  writeFileSync(join(here, "2026-donruss-sample.csv"), buildDonrussCsv(DONRUSS_SAMPLE));
  console.log("Wrote 2026-topps-chrome-sample.pdf, 2026-donruss-sample.xlsx, 2026-donruss-sample.csv");
}
