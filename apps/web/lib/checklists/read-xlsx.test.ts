import { describe, expect, it } from "vitest";
import { strToU8, zipSync, type Zippable } from "fflate";
import {
  XLSX_MAX_CELL_CHARS,
  XLSX_MAX_COLUMNS,
  XLSX_MAX_FILE_BYTES,
  XLSX_MAX_KEPT_CHARS,
  XLSX_MAX_PART_BYTES,
  XLSX_MAX_ROWS,
  XLSX_MAX_SHEETS,
  cleanCellText,
  numberText,
  readXlsx,
} from "./read-xlsx";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** A minimal workbook: `sheets` in order, each a worksheet body, plus shared strings. */
function workbook(
  sheets: string[],
  shared: string[] | null = null,
  extra: Record<string, string> = {},
): Uint8Array {
  const files: Zippable = {
    "_rels/.rels": strToU8(
      `<Relationships><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<workbook ${NS} xmlns:r="${REL}"><sheets>${sheets
        .map((_, i) => `<sheet name="S${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships>${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("")}${
        shared ? `<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` : ""
      }</Relationships>`,
    ),
  };
  sheets.forEach((body, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><worksheet ${NS}><sheetData>${body}</sheetData></worksheet>`,
    );
  });
  if (shared) {
    files["xl/sharedStrings.xml"] = strToU8(
      `<sst ${NS}>${shared.map((s) => `<si>${s}</si>`).join("")}</sst>`,
    );
  }
  for (const [name, xml] of Object.entries(extra)) files[name] = strToU8(xml);
  return zipSync(files);
}

function rowsOf(bytes: Uint8Array) {
  const out = readXlsx(bytes);
  if (!out.ok) throw new Error(`refused: ${out.reason}`);
  return out.rows;
}

/** Offsets of the central-directory entry named `name`. */
function centralEntry(zip: Uint8Array, name: string): number {
  const target = new TextEncoder().encode(name);
  for (let i = 0; i < zip.length - 46; i++) {
    if (zip[i] !== 0x50 || zip[i + 1] !== 0x4b || zip[i + 2] !== 0x01 || zip[i + 3] !== 0x02) continue;
    const nameLength = zip[i + 28] | (zip[i + 29] << 8);
    if (nameLength !== target.length) continue;
    if (target.every((b, j) => zip[i + 46 + j] === b)) return i;
  }
  throw new Error(`no entry ${name}`);
}

function setU32(bytes: Uint8Array, at: number, value: number) {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

describe("readXlsx — cells", () => {
  it("reads shared strings, numbers and the header under a credit line, by column", () => {
    const rows = rowsOf(
      workbook(
        [
          '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="s"><v>3</v></c></row>' +
            '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="4"><v>1</v></c><c r="C3" t="s"><v>5</v></c><c r="E3" s="5"/></row>',
        ],
        [
          "<t>Spreadsheet made available by Checklist Insider.</t>",
          "<t>CARD SET</t>",
          "<t>CARD #</t>",
          "<t>ATHLETE</t>",
          "<t>Bomb Squad</t>",
          "<t>Bryce Eldridge</t>",
        ],
      ),
    );
    expect(rows).toEqual([
      { row: 1, cells: ["Spreadsheet made available by Checklist Insider."] },
      { row: 2, cells: ["CARD SET", "CARD #", "ATHLETE"] },
      { row: 3, cells: ["Bomb Squad", "1", "Bryce Eldridge"] },
    ]);
  });

  it("writes a whole-number card number as an integer and keeps a gap column blank", () => {
    const rows = rowsOf(
      workbook(['<row r="7"><c r="A7"><v>12.0</v></c><c r="C7"><v>0.30000000000000004</v></c></row>']),
    );
    expect(rows).toEqual([{ row: 7, cells: ["12", "", "0.3"] }]);
    expect(numberText("007")).toBe("7");
    expect(numberText("1E+2")).toBe("100");
    expect(numberText("-4")).toBe("-4");
  });

  it("reads inline strings, rich-text runs and formula strings, dropping phonetic runs", () => {
    const rows = rowsOf(
      workbook(
        [
          '<row r="1">' +
            '<c r="A1" t="inlineStr"><is><t>Base</t></is></c>' +
            '<c r="B1" t="s"><v>0</v></c>' +
            '<c r="C1" t="str"><f>A1&amp;"x"</f><v>Basex</v></c>' +
            '<c r="D1" t="b"><v>1</v></c>' +
            "</row>",
        ],
        ['<r><t>Shohei </t></r><r><rPr><b/></rPr><t>Ohtani</t></r><rPh sb="0" eb="1"><t>ohtani</t></rPh>'],
      ),
    );
    expect(rows[0].cells).toEqual(["Base", "Shohei Ohtani", "Basex", "TRUE"]);
  });

  it("decodes the XML entities and character references, and only those", () => {
    const rows = rowsOf(
      workbook(
        ['<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'],
        ["<t>Oakland A&apos;s &amp; Jos&#233; Ram&#xED;rez</t>", "<t>&unknown; stays</t>"],
      ),
    );
    expect(rows[0].cells).toEqual(["Oakland A's & José Ramírez", "&unknown; stays"]);
  });

  it("never reads an entity name off the prototype (&constructor;, &__proto__;)", () => {
    const rows = rowsOf(
      workbook([
        '<row r="1">' +
          '<c r="A1" t="inlineStr"><is><t>&constructor;</t></is></c>' +
          '<c r="B1" t="inlineStr"><is><t>&__proto__; &toString; &hasOwnProperty;</t></is></c>' +
          '<c r="C1" t="str"><v>&valueOf;</v></c>' +
          "</row>",
      ]),
    );
    expect(rows[0].cells).toEqual([
      "&constructor;",
      "&__proto__; &toString; &hasOwnProperty;",
      "&valueOf;",
    ]);
  });

  it("turns line breaks and control characters in a cell into single spaces", () => {
    const rows = rowsOf(
      workbook(['<row r="1"><c r="A1" t="inlineStr"><is><t>Ken\nGriffey&#1;  Jr.</t></is></c></row>']),
    );
    expect(rows[0].cells).toEqual(["Ken Griffey Jr."]);
  });

  it("drops blank rows, numbers rows without an r, and ignores columns past the limit", () => {
    const far = "XFD"; // column 16384
    const rows = rowsOf(
      workbook([
        '<row r="1"><c r="A1"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>  </t></is></c></row>' +
          '<row><c><v>5</v></c><c><v>6</v></c></row>' +
          `<row r="9"><c r="A9"><v>9</v></c><c r="${far}9"><v>99</v></c></row>`,
      ]),
    );
    expect(rows).toEqual([
      { row: 1, cells: ["1"] },
      { row: 3, cells: ["5", "6"] },
      { row: 9, cells: ["9"] },
    ]);
    expect(XLSX_MAX_COLUMNS).toBe(50);
  });

  it("reads elements written with a namespace prefix", () => {
    const zip = zipSync({
      "xl/workbook.xml": strToU8(
        `<x:workbook xmlns:x="m" xmlns:r="${REL}"><x:sheets><x:sheet name="A" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="/xl/worksheets/data.xml"/></Relationships>`,
      ),
      "xl/worksheets/data.xml": strToU8(
        '<x:worksheet xmlns:x="m"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>FS-1</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>',
      ),
    });
    expect(rowsOf(zip)).toEqual([{ row: 1, cells: ["FS-1"] }]);
  });
});

/** A cell of inline text. */
const inline = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

/**
 * A workbook from `<sheet>` tags (each naming `r:id="rIdN"` for its part
 * `worksheets/sheetN.xml`) and those parts' sheetData bodies.
 */
function tabbed(sheetTags: string, parts: Record<number, string>, types: Record<number, string> = {}) {
  const files: Zippable = {
    "xl/workbook.xml": strToU8(`<workbook ${NS} xmlns:r="${REL}"><sheets>${sheetTags}</sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships>${Object.keys(parts)
        .map(
          (n) =>
            `<Relationship Id="rId${n}" Type="${REL}/${types[Number(n)] ?? "worksheet"}" Target="worksheets/sheet${n}.xml"/>`,
        )
        .join("")}</Relationships>`,
    ),
  };
  for (const [n, body] of Object.entries(parts)) {
    files[`xl/worksheets/sheet${n}.xml`] = strToU8(`<worksheet ${NS}><sheetData>${body}</sheetData></worksheet>`);
  }
  return zipSync(files);
}

describe("readXlsx — which sheet", () => {
  it("reads every sheet in tab order, each row carrying its sheet's name", () => {
    const read = readXlsx(
      tabbed('<sheet name="Base" sheetId="1" r:id="rId1"/><sheet name="Bomb &amp; Squad" sheetId="2" r:id="rId2"/>', {
        1: `<row r="1">${inline("A1", "first")}</row><row r="2">${inline("A2", "again")}</row>`,
        2: `<row r="1">${inline("A1", "second")}</row>`,
      }),
    );
    expect(read).toEqual({
      ok: true,
      sheets: ["Base", "Bomb & Squad"],
      rows: [
        { row: 1, cells: ["first"], sheet: "Base" },
        { row: 2, cells: ["again"], sheet: "Base" },
        { row: 1, cells: ["second"], sheet: "Bomb & Squad" },
      ],
    });
  });

  it("names no sheet when only one sheet gives rows, so a one-sheet checklist reads as it always has", () => {
    const read = readXlsx(
      workbook([
        '<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>',
        '<row r="1"><c r="A1" t="inlineStr"><is><t>  </t></is></c></row>',
        "",
      ]),
    );
    expect(read).toEqual({ ok: true, sheets: ["S1", "S2", "S3"], rows: [{ row: 1, cells: ["first"] }] });
  });

  it("passes over a hidden sheet, a chart sheet and a second pointer at a part already read", () => {
    const read = readXlsx(
      tabbed(
        '<sheet name="Lookups" sheetId="1" state="hidden" r:id="rId1"/>' +
          '<sheet name="Base" sheetId="2" r:id="rId2"/>' +
          '<sheet name="Scratch" sheetId="3" state="veryHidden" r:id="rId3"/>' +
          '<sheet name="Chart" sheetId="4" r:id="rId4"/>' +
          '<sheet name="Again" sheetId="5" r:id="rId2"/>' +
          '<sheet name="Inserts" sheetId="6" r:id="rId6"/>',
        {
          1: `<row r="1">${inline("A1", "hidden")}</row>`,
          2: `<row r="1">${inline("A1", "base")}</row>`,
          3: `<row r="1">${inline("A1", "very hidden")}</row>`,
          4: `<row r="1">${inline("A1", "chart")}</row>`,
          6: `<row r="1">${inline("A1", "insert")}</row>`,
        },
        { 4: "chartsheet" },
      ),
    );
    expect(read).toEqual({
      ok: true,
      sheets: ["Base", "Inserts"],
      rows: [
        { row: 1, cells: ["base"], sheet: "Base" },
        { row: 1, cells: ["insert"], sheet: "Inserts" },
      ],
    });
  });

  it("refuses a workbook of more visible sheets than one checklist needs", () => {
    const count = XLSX_MAX_SHEETS + 1;
    const tags = Array.from({ length: count }, (_, i) => `<sheet name="T${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
    const parts = Object.fromEntries(Array.from({ length: count }, (_, i) => [i + 1, `<row r="1">${inline("A1", "x")}</row>`]));
    expect(readXlsx(tabbed(tags, parts))).toEqual({ ok: false, reason: "part-too-big" });
    const atCap = tabbed(
      Array.from({ length: XLSX_MAX_SHEETS }, (_, i) => `<sheet name="T${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join(""),
      Object.fromEntries(Array.from({ length: XLSX_MAX_SHEETS }, (_, i) => [i + 1, `<row r="1">${inline("A1", "x")}</row>`])),
    );
    const read = readXlsx(atCap);
    expect(read.ok && read.rows).toHaveLength(XLSX_MAX_SHEETS);
  });

  it("holds the sheet XML cap across the whole workbook, not per sheet", () => {
    const zip = workbook([
      `<row r="1">${inline("A1", "first")}</row>`,
      `<row r="1">${inline("A1", "second")}</row>`,
    ]);
    // The second sheet declares just under the cap: alone it would pass, but
    // the first sheet's XML already counts against the same budget.
    const second = centralEntry(zip, "xl/worksheets/sheet2.xml");
    setU32(zip, second + 24, XLSX_MAX_PART_BYTES - 10);
    expect(readXlsx(zip)).toEqual({ ok: false, reason: "part-too-big" });
  });

  it("holds the kept-characters cap across the whole workbook", () => {
    // Each sheet alone stays under the cap; together they pass it.
    const perSheet = Math.ceil(XLSX_MAX_KEPT_CHARS / 2 / (50 * XLSX_MAX_CELL_CHARS)) + 10;
    const row = '<c t="s"><v>0</v></c>'.repeat(50);
    const body = Array.from({ length: perSheet }, (_, i) => `<row r="${i + 1}">${row}</row>`).join("");
    const big = [`<t>${"A B ".repeat(1_000)}</t>`];
    expect(readXlsx(workbook([body], big)).ok).toBe(true);
    expect(readXlsx(workbook([body, body], big))).toEqual({ ok: false, reason: "part-too-big" });
  });

  it("stops at the row cap across sheets and says which sheet it stopped in", () => {
    const half = XLSX_MAX_ROWS / 2 + 10;
    const body = Array.from({ length: half }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>1</v></c></row>`).join("");
    const read = readXlsx(
      tabbed('<sheet name="One" sheetId="1" r:id="rId1"/><sheet name="Two" sheetId="2" r:id="rId2"/>', { 1: body, 2: body }),
    );
    if (!read.ok) throw new Error(`refused: ${read.reason}`);
    expect(read.rows).toHaveLength(XLSX_MAX_ROWS);
    expect(read.truncatedInSheet).toBe("Two");
    expect(read.truncatedAfterRow).toBe(XLSX_MAX_ROWS - half);
  });

  it("follows the workbook's own pointers when the first tab is not sheet1.xml", () => {
    const zip = zipSync({
      "xl/workbook.xml": strToU8(
        `<workbook ${NS} xmlns:r="${REL}"><sheets><sheet name="B" sheetId="2" r:id="rId9"/><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>tab A</t></is></c></row></sheetData></worksheet>',
      ),
      "xl/worksheets/sheet2.xml": strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>tab B</t></is></c></row></sheetData></worksheet>',
      ),
    });
    // Both sheets are read, in TAB order (B first), whatever their part names.
    expect(rowsOf(zip)).toEqual([
      { row: 1, cells: ["tab B"], sheet: "B" },
      { row: 1, cells: ["tab A"], sheet: "A" },
    ]);
  });
});

describe("readXlsx — refusals", () => {
  it("refuses a file that is not a zip", () => {
    expect(readXlsx(strToU8("CARD SET,CARD #\nBase,1"))).toEqual({ ok: false, reason: "not-a-zip" });
  });

  it("refuses a zip that is not a workbook", () => {
    expect(readXlsx(zipSync({ "hello.txt": strToU8("hi") }))).toEqual({
      ok: false,
      reason: "not-a-workbook",
    });
  });

  it("refuses a file over the 10 MB cap without reading it", () => {
    expect(readXlsx(new Uint8Array(XLSX_MAX_FILE_BYTES + 1))).toEqual({ ok: false, reason: "too-big" });
  });

  it("refuses an encrypted entry", () => {
    const zip = workbook(['<row r="1"><c r="A1"><v>1</v></c></row>']);
    const at = centralEntry(zip, "xl/worksheets/sheet1.xml");
    zip[at + 8] |= 1;
    expect(readXlsx(zip)).toEqual({ ok: false, reason: "encrypted" });
  });

  it("refuses a sheet that carries a DTD", () => {
    const zip = zipSync({
      "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="A" sheetId="1"/></sheets></workbook>`),
      "xl/worksheets/sheet1.xml": strToU8(
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY lol "lol">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol;</t></is></c></row></sheetData></worksheet>',
      ),
    });
    expect(readXlsx(zip)).toEqual({ ok: false, reason: "dtd" });
  });

  it("refuses a sheet whose declared size is over the cap, before inflating it", () => {
    const zip = workbook(['<row r="1"><c r="A1"><v>1</v></c></row>']);
    setU32(zip, centralEntry(zip, "xl/worksheets/sheet1.xml") + 24, XLSX_MAX_PART_BYTES + 1);
    expect(readXlsx(zip)).toEqual({ ok: false, reason: "part-too-big" });
  });

  it("stops a zip bomb that lies about its size once the real output passes the cap", () => {
    // 40 MB of spaces deflates to a few KB; the entry claims 100 bytes.
    const body = new Uint8Array(40 * 1024 * 1024).fill(0x20);
    const zip = zipSync({
      "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="A" sheetId="1"/></sheets></workbook>`),
      "xl/worksheets/sheet1.xml": [body, { level: 1 }],
    });
    expect(zip.length).toBeLessThan(XLSX_MAX_FILE_BYTES);
    setU32(zip, centralEntry(zip, "xl/worksheets/sheet1.xml") + 24, 100);
    expect(readXlsx(zip)).toEqual({ ok: false, reason: "part-too-big" });
  });

  it("refuses a corrupt deflate stream as malformed, never throwing", () => {
    const zip = workbook(['<row r="1"><c r="A1"><v>1</v></c></row>']);
    const at = centralEntry(zip, "xl/worksheets/sheet1.xml");
    const localOffset = zip[at + 42] | (zip[at + 43] << 8) | (zip[at + 44] << 16);
    const dataStart =
      localOffset + 30 + (zip[localOffset + 26] | (zip[localOffset + 27] << 8)) +
      (zip[localOffset + 28] | (zip[localOffset + 29] << 8));
    zip[dataStart] = 0xff;
    zip[dataStart + 1] = 0xff;
    expect(readXlsx(zip)).toEqual({ ok: false, reason: "malformed" });
  });

  it("reads past other large parts it was not asked to read", () => {
    // A workbook may carry other large parts (styles, images); only the
    // parts read count toward the caps.
    const zip = workbook(['<row r="1"><c r="A1"><v>1</v></c></row>'], null, {
      "xl/styles.xml": "x".repeat(2 * 1024 * 1024),
    });
    expect(rowsOf(zip)).toEqual([{ row: 1, cells: ["1"] }]);
  });
});

describe("readXlsx — hostile shapes stay bounded", () => {
  /** A sheet of `rows` rows, each `cols` cells all pointing at shared string 0. */
  function amplifier(rows: number, cols = 50): Uint8Array {
    const row = '<c t="s"><v>0</v></c>'.repeat(cols);
    const body = Array.from({ length: rows }, (_, i) => `<row r="${i + 1}">${row}</row>`).join("");
    return workbook([body], [`<t>${"A B ".repeat(100_000)}</t>`]);
  }

  it("cuts one 400,000-character shared string referenced by 50 cells a row, 1,000 rows, to the cell cap", () => {
    const zip = amplifier(1000);
    expect(zip.length).toBeLessThan(8 * 1024);
    const heapBefore = process.memoryUsage().heapUsed;
    const started = performance.now();
    const read = readXlsx(zip);
    const ms = performance.now() - started;
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    if (!read.ok) throw new Error(`refused: ${read.reason}`);
    expect(read.rows).toHaveLength(1000);
    expect(read.rows[0].cells).toHaveLength(50);
    for (const cell of read.rows[999].cells) {
      // Cut, but still far over the parser's 120-character name cap, so the
      // cell is refused as too long rather than read as a short name.
      expect(cell.length).toBeLessThanOrEqual(XLSX_MAX_CELL_CHARS);
      expect(cell.length).toBeGreaterThan(120);
      expect(cell.startsWith("A B A B")).toBe(true);
    }
    // Before the cap this shape took ~18 s and ~1 GB of heap at 50 rows.
    expect(ms).toBeLessThan(5_000);
    expect(heapGrowth).toBeLessThan(400 * 1024 * 1024);
  });

  it("refuses as part-too-big once the cells kept across rows pass the character cap", () => {
    const rowsToPass = Math.ceil(XLSX_MAX_KEPT_CHARS / (50 * XLSX_MAX_CELL_CHARS)) + 20;
    const started = performance.now();
    expect(readXlsx(amplifier(rowsToPass))).toEqual({ ok: false, reason: "part-too-big" });
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("cleans a long cell exactly as a short one, then cuts it to the cap", () => {
    expect(cleanCellText(`${" ".repeat(5000)}Mike\n\u0001 Trout${"\t".repeat(5000)}`)).toBe("Mike Trout");
    const long = cleanCellText(`  ${"word\u0000 ".repeat(2000)}`);
    expect(long).toHaveLength(XLSX_MAX_CELL_CHARS);
    expect(long).toBe("word ".repeat(2000).slice(0, XLSX_MAX_CELL_CHARS).trimEnd());
    const rows = rowsOf(
      workbook([`<row r="1"><c r="A1" t="inlineStr"><is><t>${"x".repeat(5000)}</t></is></c></row>`]),
    );
    expect(rows[0].cells[0]).toBe("x".repeat(XLSX_MAX_CELL_CHARS));
    // A cut that lands just after a space never keeps the space.
    expect(cleanCellText(`${"x".repeat(XLSX_MAX_CELL_CHARS - 1)} yyyy${"z".repeat(10)}`)).toBe(
      "x".repeat(XLSX_MAX_CELL_CHARS - 1),
    );
  });

  /** Reads `zip` and returns how long it took; it must read, not throw. */
  function timed(zip: Uint8Array): { ms: number; read: ReturnType<typeof readXlsx> } {
    const started = performance.now();
    const read = readXlsx(zip);
    return { ms: performance.now() - started, read };
  }

  // 100,000 unclosed tags: before the cursor scan each one re-scanned the
  // rest of the row (80,000 unclosed <c> took ~4.9 s); now one pass.
  const UNCLOSED = 100_000;

  it("reads a row of 100,000 unclosed <c> tags in one pass", () => {
    const { ms, read } = timed(workbook([`<row r="1">${"<c>".repeat(UNCLOSED)}</row>`]));
    expect(read.ok).toBe(true);
    expect(ms).toBeLessThan(1_500);
  });

  it("reads a cell of 100,000 unclosed <v>, <is> or <t> tags in one pass", () => {
    for (const body of [
      `<c r="A1">${"<v>".repeat(UNCLOSED)}</c>`,
      `<c r="A1" t="inlineStr">${"<is>".repeat(UNCLOSED)}</c>`,
      `<c r="A1" t="inlineStr"><is>${"<t>".repeat(UNCLOSED)}</is></c>`,
    ]) {
      const { ms, read } = timed(workbook([`<row r="1">${body}<c r="B1"><v>7</v></c></row>`]));
      expect(read).toEqual({ ok: true, sheets: ["S1"], rows: [{ row: 1, cells: ["", "7"] }] });
      expect(ms).toBeLessThan(1_500);
    }
  });

  it("reads a shared string of 100,000 unclosed <rPh> or <t> tags in one pass", () => {
    for (const si of [`${"<rPh>".repeat(UNCLOSED)}<t>Ohtani</t>`, `${"<t>".repeat(UNCLOSED)}`]) {
      const { ms, read } = timed(workbook(['<row r="1"><c r="A1" t="s"><v>0</v></c></row>'], [si]));
      expect(read.ok).toBe(true);
      expect(ms).toBeLessThan(1_500);
    }
  });

  it("passes over an unclosed cell without swallowing the cell after it", () => {
    const rows = rowsOf(
      workbook(['<row r="1"><c r="A1"><v>1</v><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c></row>']),
    );
    expect(rows).toEqual([{ row: 1, cells: ["", "2", "3"] }]);
  });

  it("reads a self-closed <t/> as empty rather than as the start of a run", () => {
    const rows = rowsOf(
      workbook([
        '<row r="1"><c r="A1" t="inlineStr"><is><r><t xml:space="preserve"/></r><r><t>Trout</t></r></is></c></row>',
      ]),
    );
    expect(rows[0].cells).toEqual(["Trout"]);
  });
});
