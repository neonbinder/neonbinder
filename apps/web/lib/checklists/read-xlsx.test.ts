import { describe, expect, it } from "vitest";
import { strToU8, zipSync, type Zippable } from "fflate";
import {
  XLSX_MAX_COLUMNS,
  XLSX_MAX_FILE_BYTES,
  XLSX_MAX_PART_BYTES,
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

describe("readXlsx — which sheet", () => {
  it("reads only the workbook's first sheet", () => {
    const rows = rowsOf(
      workbook([
        '<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>',
        '<row r="1"><c r="A1" t="inlineStr"><is><t>second</t></is></c></row>',
      ]),
    );
    expect(rows).toEqual([{ row: 1, cells: ["first"] }]);
  });

  it("follows the workbook's own pointer when the first sheet is not sheet1.xml", () => {
    const zip = zipSync({
      "xl/workbook.xml": strToU8(
        `<workbook ${NS} xmlns:r="${REL}"><sheets><sheet name="B" sheetId="2" r:id="rId9"/><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>not me</t></is></c></row></sheetData></worksheet>',
      ),
      "xl/worksheets/sheet2.xml": strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>me</t></is></c></row></sheetData></worksheet>',
      ),
    });
    expect(rowsOf(zip)).toEqual([{ row: 1, cells: ["me"] }]);
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
