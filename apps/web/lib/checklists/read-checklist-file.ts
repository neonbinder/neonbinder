/**
 * NEO-496 — read a checklist file the operator chose, whatever its format,
 * into what the parser takes: text for .csv / .tsv / .txt, cells for .xlsx
 * and .pdf.
 *
 * The format is decided by the file's first bytes, not its name alone: a
 * zip ("PK") is read as a spreadsheet, "%PDF-" as a PDF, an old binary
 * workbook (.xls) is refused with a way forward, and anything else named
 * .csv / .tsv / .txt is text. The spreadsheet and PDF readers are imported
 * only when such a file is chosen, so neither weighs on the main bundle.
 *
 * Every refusal comes back as `{ ok: false, message }` in words the dialog
 * shows as they are. Nothing is uploaded: the bytes are read in the browser
 * and only the parsed rows go anywhere.
 */

import {
  PUBLISHED_CHECKLIST_MAX_TEXT,
  parsePublishedChecklist,
  parsePublishedChecklistCells,
  type ChecklistCellsInput,
  type PublishedChecklistOptions,
  type PublishedChecklistParse,
} from "./parse-published-checklist";
import { checklistSections, type ChecklistSections } from "./checklist-sections";
import type { PdfRead } from "./read-pdf-lines";
import type { XlsxRead, XlsxRefusal } from "./read-xlsx";

/** What the file picker offers. */
export const CHECKLIST_FILE_ACCEPT = ".xlsx,.pdf,.csv,.tsv,.txt";
/** The largest text file read, in bytes: the paste limit. */
export const CHECKLIST_TEXT_MAX_BYTES = PUBLISHED_CHECKLIST_MAX_TEXT;
/** The largest spreadsheet read (read-xlsx.ts's own cap). */
export const CHECKLIST_XLSX_MAX_BYTES = 10 * 1024 * 1024;
/** The largest PDF read (read-pdf-lines.ts's own cap). */
export const CHECKLIST_PDF_MAX_BYTES = 20 * 1024 * 1024;

/** A file read and ready for the parser. */
export type ChecklistInput =
  | { kind: "text"; text: string }
  | { kind: "cells"; cells: ChecklistCellsInput };

export type ChecklistFileRead =
  | { ok: true; input: ChecklistInput }
  | { ok: false; message: string };

/** The readers, injectable so a test can stand in for pdf.js. */
export type ChecklistFileReaders = {
  readXlsx?: (bytes: Uint8Array) => XlsxRead | Promise<XlsxRead>;
  readPdf?: (bytes: Uint8Array) => Promise<PdfRead>;
};

/** A file as the picker hands it over: a name and its bytes. */
export type ChecklistFile = { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };

type Sniffed = "xlsx" | "pdf" | "xls" | "text" | "unknown";

const MB = 1024 * 1024;

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  return signature.every((b, i) => bytes[at + i] === b);
}

/** What the bytes are, with the name as the tie-breaker for text. */
export function sniffChecklistFile(name: string, head: Uint8Array): Sniffed {
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "xlsx";
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "xls";
  // "%PDF-" may follow a little junk; the spec allows it within the first 1 KB.
  const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d];
  for (let i = 0; i + pdf.length <= Math.min(head.length, 1024); i++) {
    if (startsWith(head, pdf, i)) return "pdf";
  }
  if (/\.(csv|tsv|txt)$/i.test(name)) return "text";
  return "unknown";
}

function sizeLimit(kind: "xlsx" | "pdf" | "text"): number {
  return kind === "xlsx"
    ? CHECKLIST_XLSX_MAX_BYTES
    : kind === "pdf"
      ? CHECKLIST_PDF_MAX_BYTES
      : CHECKLIST_TEXT_MAX_BYTES;
}

function tooBigMessage(name: string, kind: "xlsx" | "pdf" | "text"): string {
  const what = kind === "xlsx" ? "a spreadsheet" : kind === "pdf" ? "a PDF" : "a text";
  return `${name} is too big — ${what} checklist is under ${sizeLimit(kind) / MB} MB.`;
}

function xlsxMessage(name: string, reason: XlsxRefusal): string {
  switch (reason) {
    case "too-big":
      return tooBigMessage(name, "xlsx");
    case "encrypted":
      return `${name} is password-protected. Save a copy without the password, then choose that.`;
    case "part-too-big":
      return `${name} holds more than one checklist’s worth of data — we read up to 32 MB of sheet.`;
    default:
      return `Couldn’t read ${name} as a spreadsheet. Save it as .xlsx, or as .csv, and try again.`;
  }
}

/**
 * Read a chosen file. Never throws. The first sheet of a workbook is read;
 * a PDF's every page.
 */
export async function readChecklistFile(
  file: ChecklistFile,
  readers: ChecklistFileReaders = {},
): Promise<ChecklistFileRead> {
  const name = file.name;
  // The largest limit first, so a huge file is never read into memory.
  if (file.size > CHECKLIST_PDF_MAX_BYTES) {
    const byName = /\.pdf$/i.test(name) ? "pdf" : /\.xlsx$/i.test(name) ? "xlsx" : "text";
    return { ok: false, message: tooBigMessage(name, byName) };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { ok: false, message: `Couldn’t read ${name}. Try choosing it again.` };
  }
  const kind = sniffChecklistFile(name, bytes.subarray(0, 1024));
  if (kind === "xls") {
    return {
      ok: false,
      message: `${name} is an old .xls workbook. Save it as .xlsx, then choose that.`,
    };
  }
  if (kind === "unknown") {
    return {
      ok: false,
      message: `${name} isn’t a checklist file we can read. Choose a .xlsx, .pdf, .csv, .tsv or .txt file.`,
    };
  }
  if (Math.max(file.size, bytes.length) > sizeLimit(kind)) {
    return { ok: false, message: tooBigMessage(name, kind) };
  }

  if (kind === "text") {
    return { ok: true, input: { kind: "text", text: new TextDecoder("utf-8").decode(bytes) } };
  }
  if (kind === "xlsx") {
    const read = readers.readXlsx ?? (await import("./read-xlsx")).readXlsx;
    const out = await read(bytes);
    if (!out.ok) return { ok: false, message: xlsxMessage(name, out.reason) };
    return {
      ok: true,
      input: {
        kind: "cells",
        cells: {
          format: "xlsx",
          records: out.rows.map((r) => ({ line: r.row, cells: r.cells })),
          ...(out.truncatedAfterRow !== undefined ? { truncatedAfterLine: out.truncatedAfterRow } : {}),
        },
      },
    };
  }
  const read = readers.readPdf ?? (await import("./read-pdf-lines")).readPdfLines;
  const out = await read(bytes);
  if (!out.ok) {
    const message =
      out.reason === "too-big"
        ? tooBigMessage(name, "pdf")
        : out.reason === "too-many-pages"
          ? `${name} has more than 300 pages — too long for one checklist.`
          : out.reason === "password"
            ? `${name} is password-protected. Save a copy without the password, then choose that.`
            : `Couldn’t read ${name} as a PDF. Try the publisher’s spreadsheet, or paste the list.`;
    return { ok: false, message };
  }
  const last = out.lines[out.lines.length - 1];
  return {
    ok: true,
    input: {
      kind: "cells",
      cells: {
        format: "pdf",
        records: out.lines.map((l) => ({ line: l.line, page: l.page, cells: l.cells, xs: l.xs })),
        ...(out.truncatedAfterPage !== undefined && last ? { truncatedAfterLine: last.line } : {}),
      },
    },
  };
}

/** Parse a file or paste for one leaf (the per-leaf checklist dialog). */
export function parseChecklistInput(
  input: ChecklistInput,
  options: PublishedChecklistOptions = {},
): PublishedChecklistParse {
  return input.kind === "text"
    ? parsePublishedChecklist(input.text, options)
    : parsePublishedChecklistCells(input.cells, options);
}

/** Parse a file or paste for a whole set: its sections, within the set's limits. */
export function readChecklistSections(
  input: ChecklistInput,
  options: Omit<PublishedChecklistOptions, "mode"> = {},
): ChecklistSections {
  return checklistSections(parseChecklistInput(input, { ...options, mode: "set" }));
}
