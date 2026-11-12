/**
 * NEO-496 — read the first sheet of an .xlsx publisher checklist into rows of
 * cell text, in the browser, without a spreadsheet library.
 *
 * An .xlsx is a zip of XML parts. This reader:
 *
 *  1. finds every entry through the zip's central directory (so a part
 *     written with a trailing data descriptor is found too), and refuses an
 *     encrypted, Zip64 or unknown-compression part;
 *  2. inflates only the parts it needs (the workbook, its relationships, the
 *     shared strings and the FIRST sheet) with fflate's streaming `Inflate`,
 *     counting the real output and stopping at the cap. A part's declared
 *     size is checked first and its real size is never trusted to match: a
 *     zip bomb that lies about its size is stopped by the count, not by the
 *     header;
 *  3. tokenises the XML as it arrives, one `<si>` or `<row>` at a time,
 *     so the whole sheet is never held as one string;
 *  4. refuses any part carrying a DTD (`<!DOCTYPE`, `<!ENTITY`) and decodes
 *     only the five XML entities and numeric character references itself.
 *
 * Cells are returned as trimmed text by column: shared strings (`t="s"`),
 * inline strings (`t="inlineStr"`, rich-text runs joined), formula strings
 * (`t="str"`), booleans, and numbers. A whole number is written as an
 * integer ("1", never "1.0"), which is how a card number column reads.
 *
 * Pure and browser-safe: no DOM, no Convex. fflate is the only dependency.
 */

import { Inflate } from "fflate";

/** The largest .xlsx file read, in bytes. */
export const XLSX_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The most XML one sheet (or the shared strings) may inflate to, in bytes. */
export const XLSX_MAX_PART_BYTES = 32 * 1024 * 1024;
/** The most XML the workbook and its relationships may inflate to. */
const XLSX_MAX_SMALL_PART_BYTES = 1024 * 1024;
/**
 * The most rows kept from the sheet. Past it the sheet is not read further
 * and `truncatedAfterRow` says where it stopped. Well past the set-level
 * 50,000-row limit, so a real checklist is never cut.
 */
export const XLSX_MAX_ROWS = 100_000;
/** Columns past this one are ignored: a checklist uses a handful. */
export const XLSX_MAX_COLUMNS = 50;
/** The longest single row element or shared string read, in characters. */
const XLSX_MAX_ELEMENT_CHARS = 1024 * 1024;
/** Compressed bytes handed to the inflater at a time, so a bomb is caught early. */
const INFLATE_SLICE = 16 * 1024;

/** One sheet row: its 1-based row number in the sheet and its cells by column (A = 0). */
export type XlsxRow = { row: number; cells: string[] };

/** Why a file could not be read at all. The dialog words each one. */
export type XlsxRefusal =
  | "too-big"
  | "not-a-zip"
  | "not-a-workbook"
  | "encrypted"
  | "unsupported-zip"
  | "part-too-big"
  | "dtd"
  | "malformed";

export type XlsxRead =
  | {
      ok: true;
      /** Rows with at least one non-blank cell, in sheet order. */
      rows: XlsxRow[];
      /** Set when the sheet went past `XLSX_MAX_ROWS`; the last row kept. */
      truncatedAfterRow?: number;
    }
  | { ok: false; reason: XlsxRefusal };

class XlsxError extends Error {
  readonly reason: XlsxRefusal;
  constructor(reason: XlsxRefusal) {
    super(reason);
    this.reason = reason;
  }
}

// ── Zip central directory ──────────────────────────────────────────────────

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  declaredSize: number;
  dataStart: number;
};

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Every entry the central directory lists, by name. */
function readCentralDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  if (bytes.length < 22 || u32(bytes, 0) !== LOC_SIG) throw new XlsxError("not-a-zip");
  // The end record sits in the last 22 bytes plus a comment of up to 64 KB.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (u32(bytes, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new XlsxError("not-a-zip");
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new XlsxError("unsupported-zip");
  }
  if (cdOffset + cdSize > bytes.length) throw new XlsxError("not-a-zip");
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder("utf-8");
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || u32(bytes, at) !== CEN_SIG) throw new XlsxError("not-a-zip");
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const declaredSize = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const localOffset = u32(bytes, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new XlsxError("encrypted");
    if (compressedSize === 0xffffffff || declaredSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new XlsxError("unsupported-zip");
    }
    if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== LOC_SIG) {
      throw new XlsxError("not-a-zip");
    }
    const dataStart = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
    if (dataStart + compressedSize > bytes.length) throw new XlsxError("not-a-zip");
    entries.set(name, { name, method, compressedSize, declaredSize, dataStart });
  }
  return entries;
}

/**
 * Inflate one entry, handing each decoded text chunk to `onText`. The
 * declared size is checked before any work; the real output is counted as
 * it comes and the read stops the moment it passes `cap`.
 */
function streamEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  cap: number,
  onText: (text: string) => void,
): void {
  if (entry.declaredSize > cap) throw new XlsxError("part-too-big");
  const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  const take = (chunk: Uint8Array, final: boolean) => {
    total += chunk.length;
    if (total > cap) throw new XlsxError("part-too-big");
    const text = decoder.decode(chunk, { stream: !final });
    if (text.length > 0) onText(text);
  };
  if (entry.method === 0) {
    for (let i = 0; i < data.length; i += INFLATE_SLICE) {
      take(data.subarray(i, i + INFLATE_SLICE), i + INFLATE_SLICE >= data.length);
    }
    if (data.length === 0) take(new Uint8Array(0), true);
    return;
  }
  if (entry.method !== 8) throw new XlsxError("unsupported-zip");
  const inflate = new Inflate((chunk, final) => take(chunk, final));
  try {
    if (data.length === 0) inflate.push(new Uint8Array(0), true);
    for (let i = 0; i < data.length; i += INFLATE_SLICE) {
      inflate.push(data.subarray(i, i + INFLATE_SLICE), i + INFLATE_SLICE >= data.length);
    }
  } catch (error) {
    if (error instanceof XlsxError) throw error;
    throw new XlsxError("malformed");
  }
}

/** Inflate a small part whole (the workbook, a relationships file). */
function readSmallEntry(bytes: Uint8Array, entry: ZipEntry): string {
  let text = "";
  streamEntry(bytes, entry, XLSX_MAX_SMALL_PART_BYTES, (chunk) => {
    text += chunk;
  });
  refuseDtd(text);
  return text;
}

// ── XML helpers ────────────────────────────────────────────────────────────

const DTD = /<!(?:DOCTYPE|ENTITY)/i;

function refuseDtd(text: string): void {
  if (DTD.test(text)) throw new XlsxError("dtd");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Decode the five XML entities and numeric references. Anything else is left
 * as written: no DTD is ever read, so no other entity can be defined.
 */
function decodeXml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

/** `name="value"` (or single quotes) on a start tag, decoded; null when absent. */
function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  if (!match) return null;
  return decodeXml(match[1] ?? match[2] ?? "");
}

/** The text of every `<t>` inside `xml` (an `<si>` or an `<is>`), phonetic runs dropped. */
function textRuns(xml: string): string {
  const withoutPhonetic = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "");
  let out = "";
  const run = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
  for (let m = run.exec(withoutPhonetic); m; m = run.exec(withoutPhonetic)) out += m[1];
  return decodeXml(out);
}

/**
 * Feed text chunks in; get each complete `<name …>…</name>` (or self-closed
 * `<name …/>`) element out, in order. Only the unfinished tail is held.
 */
function elementStream(name: string, onElement: (xml: string) => boolean | void) {
  const open = new RegExp(`<(?:\\w+:)?${name}(?=[\\s/>])`, "g");
  const close = new RegExp(`</(?:\\w+:)?${name}\\s*>`, "g");
  let pending = "";
  let stopped = false;
  let sawDtdCheck = "";
  return {
    push(chunk: string) {
      if (stopped) return;
      // A DTD marker split across two chunks is still seen.
      sawDtdCheck = sawDtdCheck.slice(-16) + chunk;
      refuseDtd(sawDtdCheck);
      pending += chunk;
      let from = 0;
      for (;;) {
        open.lastIndex = from;
        const start = open.exec(pending);
        if (!start) {
          // Nothing opens: keep only a tail that could begin a tag.
          const lt = pending.lastIndexOf("<");
          pending = lt === -1 ? "" : pending.slice(Math.max(lt, from));
          from = 0;
          break;
        }
        const tagEnd = pending.indexOf(">", start.index);
        if (tagEnd === -1) {
          pending = pending.slice(start.index);
          from = 0;
          break;
        }
        let end: number;
        if (pending[tagEnd - 1] === "/") {
          end = tagEnd + 1;
        } else {
          close.lastIndex = tagEnd;
          const closing = close.exec(pending);
          if (!closing) {
            pending = pending.slice(start.index);
            from = 0;
            break;
          }
          end = closing.index + closing[0].length;
        }
        if (onElement(pending.slice(start.index, end)) === false) {
          stopped = true;
          pending = "";
          return;
        }
        from = end;
      }
      if (pending.length > XLSX_MAX_ELEMENT_CHARS) throw new XlsxError("malformed");
    },
  };
}

// ── Workbook: which part is the first sheet ───────────────────────────────

/** "worksheets/sheet1.xml" relative to "xl/workbook.xml" → "xl/worksheets/sheet1.xml". */
function resolvePart(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const piece of target.split("/")) {
    if (piece === "..") parts.pop();
    else if (piece !== "." && piece !== "") parts.push(piece);
  }
  return parts.join("/");
}

/** The relationships file beside a part: "xl/workbook.xml" → "xl/_rels/workbook.xml.rels". */
function relsPathOf(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

type Relationship = { id: string; type: string; target: string };

function relationships(xml: string): Relationship[] {
  const out: Relationship[] = [];
  const tag = /<(?:\w+:)?Relationship\b[^>]*>/g;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    out.push({
      id: attr(m[0], "Id") ?? "",
      type: attr(m[0], "Type") ?? "",
      target: attr(m[0], "Target") ?? "",
    });
  }
  return out;
}

function locateParts(
  bytes: Uint8Array,
  entries: Map<string, ZipEntry>,
): { sheet: string; sharedStrings: string | null } {
  let workbook = "xl/workbook.xml";
  const rootRels = entries.get("_rels/.rels");
  if (rootRels) {
    const office = relationships(readSmallEntry(bytes, rootRels)).find((r) =>
      r.type.endsWith("/officeDocument"),
    );
    if (office) workbook = resolvePart("", office.target);
  }
  const workbookEntry = entries.get(workbook);
  if (!workbookEntry) throw new XlsxError("not-a-workbook");
  const workbookXml = readSmallEntry(bytes, workbookEntry);
  const relsEntry = entries.get(relsPathOf(workbook));
  const rels = relsEntry ? relationships(readSmallEntry(bytes, relsEntry)) : [];

  let sheet: string | null = null;
  const firstSheet = /<(?:\w+:)?sheet\b[^>]*>/.exec(workbookXml);
  if (firstSheet) {
    const id = /\s(?:\w+:)?id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(firstSheet[0]);
    const relId = id ? decodeXml(id[1] ?? id[2] ?? "") : null;
    const rel = rels.find((r) => r.id === relId);
    if (rel) sheet = resolvePart(workbook, rel.target);
  }
  if (!sheet || !entries.has(sheet)) {
    // No usable pointer: the conventional first sheet.
    sheet = resolvePart(workbook, "worksheets/sheet1.xml");
    if (!entries.has(sheet)) throw new XlsxError("not-a-workbook");
  }
  const sharedRel = rels.find((r) => r.type.endsWith("/sharedStrings"));
  const shared = sharedRel
    ? resolvePart(workbook, sharedRel.target)
    : resolvePart(workbook, "sharedStrings.xml");
  return { sheet, sharedStrings: entries.has(shared) ? shared : null };
}

// ── Cells ──────────────────────────────────────────────────────────────────

/** "B12" → 1 (column B). Null when the reference has no letters. */
function columnIndex(ref: string): number | null {
  const letters = /^([A-Za-z]{1,3})/.exec(ref);
  if (!letters) return null;
  let index = 0;
  for (const ch of letters[1].toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** A stored number as a checklist reads it: whole numbers without a decimal point. */
export function numberText(raw: string): string {
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) return trimmed.replace(/^(-?)0+(?=\d)/, "$1");
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return trimmed;
  if (Number.isInteger(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER) {
    return String(value);
  }
  // Excel's binary-float noise ("0.30000000000000004") reads as written.
  return String(Number(value.toPrecision(15)));
}

/** Control characters become spaces; runs of whitespace become one space. */
function cleanCellText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function cellValue(cellXml: string, startTag: string, shared: readonly string[]): string {
  const type = attr(startTag, "t") ?? "n";
  if (type === "inlineStr") {
    const is = /<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(cellXml);
    return is ? textRuns(is[1]) : "";
  }
  const v = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(cellXml);
  const raw = v ? decodeXml(v[1]) : "";
  if (raw === "") return "";
  switch (type) {
    case "s": {
      const index = Number(raw);
      return Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] : "";
    }
    case "b":
      return raw === "1" ? "TRUE" : "FALSE";
    case "str":
    case "e":
      return raw;
    default:
      return numberText(raw);
  }
}

function parseRow(
  rowXml: string,
  fallbackRow: number,
  shared: readonly string[],
): XlsxRow {
  const startTag = /^<[^>]*>/.exec(rowXml)?.[0] ?? "";
  const r = Number(attr(startTag, "r"));
  const row = Number.isInteger(r) && r > 0 ? r : fallbackRow;
  const cells: string[] = [];
  if (startTag.endsWith("/>")) return { row, cells };
  const cell = /<(?:\w+:)?c(?=[\s/>])[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c\s*>)/g;
  let next = 0;
  for (let m = cell.exec(rowXml); m; m = cell.exec(rowXml)) {
    const tag = /^<[^>]*>/.exec(m[0])?.[0] ?? "";
    const ref = attr(tag, "r");
    const col = ref === null ? next : (columnIndex(ref) ?? next);
    next = col + 1;
    if (col >= XLSX_MAX_COLUMNS) continue;
    const value = m[1] === undefined ? "" : cleanCellText(cellValue(m[0], tag, shared));
    while (cells.length < col) cells.push("");
    cells[col] = value;
  }
  while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return { row, cells };
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Read the first sheet of an .xlsx. Never throws: a file it cannot read
 * comes back `{ ok: false, reason }`.
 */
export function readXlsx(input: Uint8Array | ArrayBuffer): XlsxRead {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > XLSX_MAX_FILE_BYTES) return { ok: false, reason: "too-big" };
  try {
    const entries = readCentralDirectory(bytes);
    const parts = locateParts(bytes, entries);

    const shared: string[] = [];
    if (parts.sharedStrings) {
      const strings = elementStream("si", (xml) => {
        shared.push(cleanCellText(textRuns(xml)));
      });
      streamEntry(bytes, entries.get(parts.sharedStrings)!, XLSX_MAX_PART_BYTES, (text) =>
        strings.push(text),
      );
    }

    const rows: XlsxRow[] = [];
    let truncatedAfterRow: number | undefined;
    let lastRow = 0;
    const sheetRows = elementStream("row", (xml) => {
      const row = parseRow(xml, lastRow + 1, shared);
      lastRow = row.row;
      if (!row.cells.some((c) => c !== "")) return;
      if (rows.length >= XLSX_MAX_ROWS) {
        truncatedAfterRow = rows[rows.length - 1].row;
        return false;
      }
      rows.push(row);
    });
    streamEntry(bytes, entries.get(parts.sheet)!, XLSX_MAX_PART_BYTES, (text) =>
      sheetRows.push(text),
    );
    return truncatedAfterRow === undefined ? { ok: true, rows } : { ok: true, rows, truncatedAfterRow };
  } catch (error) {
    if (error instanceof XlsxError) return { ok: false, reason: error.reason };
    return { ok: false, reason: "malformed" };
  }
}
