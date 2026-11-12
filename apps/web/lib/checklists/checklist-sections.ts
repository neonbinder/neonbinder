/**
 * NEO-496 — a publisher checklist read for a whole SET: its rows grouped into
 * the publisher's own sections ("Base", "Bomb Squad", "FUTURE STARS"), each
 * becoming one more source the variant sync can match and a leaf's fetch can
 * use.
 *
 * The parse (`parse-published-checklist.ts`, in `mode: "set"`) already names
 * every row's section: its subset cell, or the latest heading above it, with
 * a repeated heading told apart from its first appearance. This module only
 * groups those rows and holds the set's limits, always by WHOLE sections:
 *
 *  - a section of more than `SET_CHECKLIST_MAX_SECTION_ROWS` rows is left
 *    out whole, with the reason, rather than cut;
 *  - past `SET_CHECKLIST_MAX_SECTIONS` sections, or once the next section
 *    would take the checklist past `SET_CHECKLIST_MAX_ROWS` rows, the rest
 *    are left out whole, with the reason;
 *  - a section whose name, or whose group's name, holds a hidden direction
 *    or zero-width character (`hasHiddenNameChars`, the server's own test)
 *    is left out whole, with the reason, since the server refuses that name.
 *
 * A section's `key` is its name folded for case and spacing
 * (`checklistSectionKey`): the stable handle a variant row links to (plan
 * D2). Two names that fold alike ("Bomb Squad", "BOMB SQUAD") are one
 * section, under the first name met. The key is the publisher's own name,
 * input data, never an NB title.
 *
 * Pure and browser-safe; the server re-checks every limit (plan D5).
 */

import {
  MAX_CHECKLIST_ROWS,
  MAX_SECTION_ROWS,
  MAX_SECTIONS,
  hasHiddenNameChars,
  sectionKeyOf,
} from "../../convex/lib/publishedChecklistSections";
import {
  PUBLISHED_CHECKLIST_MAX_NAME,
  type PublishedChecklistFormat,
  type PublishedChecklistParse,
  type PublishedChecklistRow,
  type SkippedLine,
} from "./parse-published-checklist";

/** The most rows one section may hold; a bigger one is left out whole. The server's own limit. */
export const SET_CHECKLIST_MAX_SECTION_ROWS = MAX_SECTION_ROWS;
/** The most sections one checklist may hold. The server's own limit. */
export const SET_CHECKLIST_MAX_SECTIONS = MAX_SECTIONS;
/** The most rows one checklist may hold, across its sections. The server's own limit. */
export const SET_CHECKLIST_MAX_ROWS = MAX_CHECKLIST_ROWS;

/** A checklist row as a section holds it: the section is the row's subset. */
export type ChecklistSectionRow = Omit<PublishedChecklistRow, "subset">;

export type ChecklistSection = {
  /** The publisher's section name, as the file gives it. */
  name: string;
  /** `checklistSectionKey(name)`: unique within the checklist. */
  key: string;
  /** The group heading the section sits under (Topps' "AUTOGRAPH"), when there is one. */
  group?: string;
  rows: ChecklistSectionRow[];
};

/** A section left out whole, and why. */
export type SkippedSection = { name: string; rowCount: number; reason: string };

export type ChecklistSections = {
  format: PublishedChecklistFormat;
  sections: ChecklistSection[];
  /** Every line that gave no row, with the reason (the parse's own list). */
  skipped: SkippedLine[];
  /** Sections left out whole: too big, or past a limit. */
  skippedSections: SkippedSection[];
  /** Rows across `sections`. */
  rowCount: number;
  /** The text was over the paste limit and was not read at all. */
  tooBig?: true;
};

/**
 * The key a section is linked by. The server's own fold (`sectionKeyOf`:
 * NFC, trimmed, whitespace collapsed, lower case), imported rather than
 * copied, so the client can never group sections the server keys apart.
 */
export function checklistSectionKey(name: string): string {
  return sectionKeyOf(name);
}

/** A section name as stored: control characters gone, spacing collapsed. */
export function cleanSectionName(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

/** "More than 2,000 cards in one section". */
export function sectionTooBigReason(limit = SET_CHECKLIST_MAX_SECTION_ROWS): string {
  return `More than ${limit.toLocaleString("en-US")} cards in one section`;
}

/** "Past the 1,000-section limit". */
export function pastSectionLimitReason(limit = SET_CHECKLIST_MAX_SECTIONS): string {
  return `Past the ${limit.toLocaleString("en-US")}-section limit`;
}

/** A section left out because its own name holds a hidden character. */
export const HIDDEN_CHARS_IN_NAME = "Hidden characters in the section name";
/** A section left out because its group heading holds a hidden character. */
export const HIDDEN_CHARS_IN_GROUP = "Hidden characters in the section's group name";

/** "Past the 50,000-card limit for one checklist". */
export function pastRowLimitReason(limit = SET_CHECKLIST_MAX_ROWS): string {
  return `Past the ${limit.toLocaleString("en-US")}-card limit for one checklist`;
}

function withoutSubset(row: PublishedChecklistRow): ChecklistSectionRow {
  const out: ChecklistSectionRow = { number: row.number, players: row.players, teams: row.teams };
  if (row.noNumber) out.noNumber = true;
  if (row.noTeam) out.noTeam = true;
  return out;
}

/**
 * Group a set-mode parse into sections, in file order, holding the set's
 * limits by whole sections. Rows the parse kept without a subset (it skips
 * them itself in set mode) are ignored.
 */
export function checklistSections(parse: PublishedChecklistParse): ChecklistSections {
  if (parse.tooBig) {
    return {
      format: parse.format,
      sections: [],
      skipped: [],
      skippedSections: [],
      rowCount: 0,
      tooBig: true,
    };
  }
  type Draft = {
    name: string;
    key: string;
    group?: string;
    rows: ChecklistSectionRow[];
    /** Set when the section is left out whatever the limits say. */
    refused?: string;
  };
  const byKey = new Map<string, Draft>();
  const order: Draft[] = [];
  // `groups` is keyed by publisher text: read only its own keys, so a
  // section named "constructor" or "__proto__" is never handed a prototype's.
  const groups = parse.groups;
  const groupOf = (subset: string): string | undefined =>
    groups && Object.hasOwn(groups, subset) && typeof groups[subset] === "string"
      ? groups[subset]
      : undefined;
  for (const row of parse.rows) {
    if (row.subset === undefined) continue;
    const name = cleanSectionName(row.subset);
    if (name === "" || name.length > PUBLISHED_CHECKLIST_MAX_NAME) continue;
    const key = checklistSectionKey(name);
    let draft = byKey.get(key);
    if (!draft) {
      const rawGroup = groupOf(row.subset);
      const group = rawGroup === undefined ? "" : cleanSectionName(rawGroup);
      const refused = hasHiddenNameChars(name)
        ? HIDDEN_CHARS_IN_NAME
        : hasHiddenNameChars(group)
          ? HIDDEN_CHARS_IN_GROUP
          : undefined;
      draft = {
        name,
        key,
        ...(group ? { group } : {}),
        rows: [],
        ...(refused ? { refused } : {}),
      };
      byKey.set(key, draft);
      order.push(draft);
    }
    draft.rows.push(withoutSubset(row));
  }

  const sections: ChecklistSection[] = [];
  const skippedSections: SkippedSection[] = [];
  let rowCount = 0;
  for (const { refused, ...draft } of order) {
    const rowsHere = draft.rows.length;
    if (refused !== undefined) {
      skippedSections.push({ name: draft.name, rowCount: rowsHere, reason: refused });
    } else if (rowsHere > SET_CHECKLIST_MAX_SECTION_ROWS) {
      skippedSections.push({ name: draft.name, rowCount: rowsHere, reason: sectionTooBigReason() });
    } else if (sections.length >= SET_CHECKLIST_MAX_SECTIONS) {
      skippedSections.push({ name: draft.name, rowCount: rowsHere, reason: pastSectionLimitReason() });
    } else if (rowCount + rowsHere > SET_CHECKLIST_MAX_ROWS) {
      skippedSections.push({ name: draft.name, rowCount: rowsHere, reason: pastRowLimitReason() });
    } else {
      sections.push(draft);
      rowCount += rowsHere;
    }
  }
  return { format: parse.format, sections, skipped: parse.skipped, skippedSections, rowCount };
}
