/**
 * NEO-478 — read a publisher's checklist the operator pasted or chose as a
 * file into rows of { number, players, teams }.
 *
 * Pure and browser-safe: no DOM, no Convex. The dialog previews exactly what
 * this returns, and the same rows go to `fetchCardChecklist`'s
 * `publishedChecklist`, which re-checks every limit on the server.
 *
 * Two shapes are read:
 *
 *  - **CSV / TSV with a header row.** Columns are found by header name (card
 *    number, player, team, each with several spellings). A cell naming
 *    several players or teams is split on "/" or ";".
 *  - **The published line format** a checklist page prints:
 *      `60 Rhett Lowder - Cincinnati Reds (Future Stars)`
 *      `11 Alonso/Schwarber/Soto (League Leaders)`
 *      `34 Team Card - Kansas City Royals`
 *    The number leads, then the players, then " - " and the team. RC
 *    markers and bracketed notes are dropped.
 *
 * Every non-blank line that does not give a row is listed in `skipped` with
 * the reason, never dropped silently. A card number is NOT treated as unique
 * (product rule 7): two rows with the same number are both kept, and the
 * server's exactly-one guard decides what they can match.
 *
 * A line whose leading "number" is a season ("1995-96 Fort Worth Fire team
 * set") or the set's own year (`options.setYear`) is the checklist's title,
 * not a card, and is skipped as `LOOKS_LIKE_A_TITLE`.
 */

export type PublishedChecklistRow = {
  number: string;
  players: string[];
  teams: string[];
};

export type SkippedLine = {
  /** 1-based line number in the pasted text or file. */
  line: number;
  text: string;
  reason: string;
};

export type PublishedChecklistParse = {
  rows: PublishedChecklistRow[];
  skipped: SkippedLine[];
  format: "lines" | "csv" | "tsv";
  /**
   * The text was over `PUBLISHED_CHECKLIST_MAX_TEXT` and was not read at all:
   * `rows` and `skipped` are empty. The dialog says so instead of a preview.
   */
  tooBig?: true;
};

/** The most rows one checklist may carry; the server refuses more. */
export const PUBLISHED_CHECKLIST_MAX_ROWS = 2000;
/** The longest card number, player or team name kept; longer is skipped. */
export const PUBLISHED_CHECKLIST_MAX_NAME = 120;
/**
 * The longest line read. A real checklist line is well under 200 characters;
 * a longer one is skipped with a reason before any pattern runs on it, so a
 * pasted run of whitespace or junk cannot stall the browser.
 */
export const PUBLISHED_CHECKLIST_MAX_LINE = 2000;
/**
 * The most text read, in characters: the same 2 MB the file picker allows, so
 * a paste cannot get past the limit a file is held to. Over it, nothing is
 * parsed and the result says `tooBig`.
 */
export const PUBLISHED_CHECKLIST_MAX_TEXT = 2 * 1024 * 1024;

/** The words a header cell may use for each column, compared folded. */
const HEADER_SPELLINGS: Record<"number" | "players" | "teams", readonly string[]> = {
  number: [
    "#",
    "no",
    "num",
    "number",
    "card",
    "card #",
    "card no",
    "card num",
    "card number",
    "cardnumber",
    "card_number",
    "card-number",
    "checklist #",
    "checklist number",
  ],
  players: [
    "player",
    "players",
    "player(s)",
    "player name",
    "player names",
    "playername",
    "player_name",
    "name",
    "names",
    "subject",
    "athlete",
    "athletes",
  ],
  teams: [
    "team",
    "teams",
    "team(s)",
    "team name",
    "teamname",
    "team_name",
    "club",
    "franchise",
  ],
};

/** "Card No." → "card no". Case, dots and runs of spaces don't count. */
function foldHeader(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}

function columnOf(header: string): "number" | "players" | "teams" | null {
  const folded = foldHeader(header);
  for (const key of ["number", "players", "teams"] as const) {
    if (HEADER_SPELLINGS[key].includes(folded)) return key;
  }
  return null;
}

/** Split one delimited line, honouring double quotes ("" is a literal quote). */
export function splitDelimited(line: string, delimiter: "," | "\t"): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

/** "Alonso / Schwarber; Soto" → ["Alonso", "Schwarber", "Soto"]. */
function splitNames(cell: string): string[] {
  return cell
    .split(/[/;]/)
    .map((name) => name.replace(/\s+/g, " ").trim())
    .filter((name) => name.length > 0);
}

/** Bracketed notes — "(Future Stars)", "[SP]", "{photo variation}" — go. */
function dropBracketed(text: string): string {
  let out = text;
  // Repeat so a note inside a note, or two notes, all go.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/\([^()]*\)|\[[^[\]]*\]|\{[^{}]*\}/g, " ");
    if (next === out) break;
    out = next;
  }
  return out;
}

/** "RC", "(RC)", "RC," as a whole word go; a name that merely contains "rc" stays. */
function dropRookieMarkers(text: string): string {
  return text.replace(/(^|[\s,/;])RC(?=$|[\s,/;])/g, "$1");
}

/** Player names that are the card's subject, not a person. */
const NOT_A_PERSON = new Set(["team card", "checklist", "team checklist", "header card"]);

function playersFrom(cell: string): string[] {
  return splitNames(dropRookieMarkers(dropBracketed(cell))).filter(
    (name) => !NOT_A_PERSON.has(name.toLowerCase()),
  );
}

function teamsFrom(cell: string): string[] {
  return splitNames(dropRookieMarkers(dropBracketed(cell)));
}

/** A card number: one token with at least one digit ("60", "BDC-12", "US1", "T-34"). */
const NUMBER_TOKEN = /^#?([A-Za-z0-9][A-Za-z0-9.-]*)$/;

function cleanNumber(raw: string): string | null {
  const token = numberToken(raw);
  if (!token || !/\d/.test(token) || !NUMBER_TOKEN.test(token)) return null;
  return token;
}

/** The raw number cell or first word, without a leading "#" or a trailing "." / ":". */
function numberToken(raw: string): string {
  return raw.trim().replace(/^#/, "").replace(/[.:]$/, "");
}

/**
 * A season, "1995-96", "2024/25", "1999–2000": a title line's leading word
 * ("1995-96 Fort Worth Fire team set"), never a card number.
 */
const SEASON = /^(19|20)\d{2}[-/–]\d{2,4}$/;

/** Said for a line whose leading number is the set's year or a season. */
export const LOOKS_LIKE_A_TITLE = "Looks like a title, not a card";

/**
 * A number that is the set's own year ("2024" on a 2024 set's heading line)
 * or a season reads as a title, not a card. `setYear` is the 4-digit year,
 * already pulled out of the set's year value.
 */
function readsAsTitle(raw: string, setYear: string | null): boolean {
  const token = numberToken(raw);
  return SEASON.test(token) || (setYear !== null && token === setYear);
}

/** "1995", "1995-96", 1995 → "1995"; anything without a leading 4-digit year → null. */
function fourDigitYear(year: string | number | null | undefined): string | null {
  if (year === null || year === undefined) return null;
  const match = /^\s*((?:19|20)\d{2})(?!\d)/.exec(String(year));
  return match ? match[1] : null;
}

/** Which limit, if any, a row breaks. */
function overLimit(row: PublishedChecklistRow): string | null {
  if (row.number.length > PUBLISHED_CHECKLIST_MAX_NAME) return "Card number is too long";
  if (row.players.some((p) => p.length > PUBLISHED_CHECKLIST_MAX_NAME)) {
    return "A player name is too long";
  }
  if (row.teams.some((t) => t.length > PUBLISHED_CHECKLIST_MAX_NAME)) {
    return "A team name is too long";
  }
  return null;
}

/**
 * The published line format, one line:
 * `<number> <players>[ - <teams>][ (note)]`.
 */
function parseLine(
  text: string,
  setYear: string | null,
): PublishedChecklistRow | { reason: string } {
  const match = /^\s*(\S+)\s*(.*)$/.exec(text);
  if (match && readsAsTitle(match[1], setYear)) return { reason: LOOKS_LIKE_A_TITLE };
  const number = match ? cleanNumber(match[1]) : null;
  if (!match || !number) return { reason: "No card number at the start" };
  // Whitespace runs collapse to one space first: splitting on
  // `\s+[-–—]\s+` directly backtracks over every run and is quadratic in
  // its length (100k spaces took seconds on the main thread).
  const rest = match[2].replace(/\s+/g, " ");
  // The team follows the LAST spaced dash, so a hyphenated name
  // ("Jean-Carlos", "Ryu Hyun-jin") stays in one piece.
  const parts = rest.split(/ [-–—] /);
  const playerPart = parts.length > 1 ? parts.slice(0, -1).join(" - ") : rest;
  const teamPart = parts.length > 1 ? parts[parts.length - 1] : "";
  const players = playersFrom(playerPart);
  const teams = teamsFrom(teamPart);
  const subject = dropBracketed(playerPart).trim().toLowerCase();
  if (players.length === 0 && teams.length === 0 && !NOT_A_PERSON.has(subject)) {
    return { reason: "No player or team after the number" };
  }
  return { number, players, teams };
}

function detectDelimited(firstLine: string): {
  delimiter: "," | "\t";
  columns: Array<"number" | "players" | "teams" | null>;
} | null {
  for (const delimiter of ["\t", ","] as const) {
    if (!firstLine.includes(delimiter)) continue;
    const columns = splitDelimited(firstLine, delimiter).map(columnOf);
    if (columns.includes("number") && (columns.includes("players") || columns.includes("teams"))) {
      return { delimiter, columns };
    }
  }
  return null;
}

/** What the caller knows about the set the checklist is for. */
export type PublishedChecklistOptions = {
  /**
   * The set's year ("1995", or a season such as "1995-96": its first year is
   * used). A line whose card number is that year is a title line, skipped
   * with `LOOKS_LIKE_A_TITLE`.
   */
  setYear?: string | number | null;
};

/**
 * Read a pasted or uploaded checklist. Blank lines are not content and are
 * passed over; every other line is a row or a `skipped` entry.
 */
export function parsePublishedChecklist(
  text: string,
  options: PublishedChecklistOptions = {},
): PublishedChecklistParse {
  const setYear = fourDigitYear(options.setYear);
  if (text.length > PUBLISHED_CHECKLIST_MAX_TEXT) {
    return { rows: [], skipped: [], format: "lines", tooBig: true };
  }
  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  const firstIndex = lines.findIndex((l) => l.trim() !== "");
  const rows: PublishedChecklistRow[] = [];
  const skipped: SkippedLine[] = [];
  if (firstIndex === -1) return { rows, skipped, format: "lines" };

  // An over-long first line is not a header; it is skipped below like any
  // other over-long line.
  const header =
    lines[firstIndex].length > PUBLISHED_CHECKLIST_MAX_LINE
      ? null
      : detectDelimited(lines[firstIndex]);
  const format: PublishedChecklistParse["format"] = header
    ? header.delimiter === "\t"
      ? "tsv"
      : "csv"
    : "lines";

  const keep = (lineIndex: number, raw: string, row: PublishedChecklistRow) => {
    const tooLong = overLimit(row);
    if (tooLong) {
      skipped.push({ line: lineIndex + 1, text: raw, reason: tooLong });
    } else if (rows.length >= PUBLISHED_CHECKLIST_MAX_ROWS) {
      skipped.push({
        line: lineIndex + 1,
        text: raw,
        reason: `Past the ${PUBLISHED_CHECKLIST_MAX_ROWS.toLocaleString("en-US")}-row limit`,
      });
    } else {
      rows.push(row);
    }
  };

  for (let i = firstIndex + (header ? 1 : 0); i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    if (raw.length > PUBLISHED_CHECKLIST_MAX_LINE) {
      skipped.push({
        line: i + 1,
        // Only the start is kept for the preview; the line itself is junk.
        text: `${raw.slice(0, 200).replace(/\s+/g, " ").trim().slice(0, 80)}…`,
        reason: `Longer than ${PUBLISHED_CHECKLIST_MAX_LINE.toLocaleString("en-US")} characters`,
      });
      continue;
    }
    if (!header) {
      const parsed = parseLine(raw, setYear);
      if ("reason" in parsed) skipped.push({ line: i + 1, text: raw, reason: parsed.reason });
      else keep(i, raw, parsed);
      continue;
    }
    const cells = splitDelimited(raw, header.delimiter);
    let number: string | null = null;
    let numberCell = "";
    const players: string[] = [];
    const teams: string[] = [];
    header.columns.forEach((column, c) => {
      const cell = cells[c] ?? "";
      if (column === "number" && numberCell === "") {
        numberCell = cell;
        number = cleanNumber(cell);
      } else if (column === "players") {
        players.push(...playersFrom(cell));
      } else if (column === "teams") {
        teams.push(...teamsFrom(cell));
      }
    });
    if (numberCell !== "" && readsAsTitle(numberCell, setYear)) {
      skipped.push({ line: i + 1, text: raw, reason: LOOKS_LIKE_A_TITLE });
      continue;
    }
    if (!number) {
      skipped.push({
        line: i + 1,
        text: raw,
        reason: numberCell ? "Card number isn't one we can read" : "No card number",
      });
      continue;
    }
    if (players.length === 0 && teams.length === 0) {
      skipped.push({ line: i + 1, text: raw, reason: "No player or team on this line" });
      continue;
    }
    keep(i, raw, { number, players, teams });
  }
  return { rows, skipped, format };
}
