/**
 * NEO-478 — read a publisher's checklist the operator pasted or chose as a
 * file into rows of { number, players, teams }.
 *
 * Pure and browser-safe: no DOM, no Convex. The dialog previews exactly what
 * this returns, and the same rows go to `fetchCardChecklist`'s
 * `publishedChecklist`, which re-checks every limit on the server.
 *
 * Three shapes are read:
 *
 *  - **CSV / TSV with a header row.** Columns are found by header name (card
 *    number, player, team, and the subset a row belongs to, each with several
 *    spellings). A cell naming several players or teams is split on "/" or
 *    ";"; players also on a spaced "&" or "and".
 *  - **CSV / TSV without a header.** When most lines carry two or more tabs
 *    (or commas) after a one-word first cell, the columns are read by
 *    position: number, player, team.
 *  - **The published line format** a checklist page prints:
 *      `60 Rhett Lowder - Cincinnati Reds (Future Stars)`
 *      `11 Alonso/Schwarber/Soto (League Leaders)`
 *      `34 Team Card - Kansas City Royals`
 *      `1 Shohei Ohtani, Los Angeles Dodgers`
 *      `1 Mike Trout ..... Los Angeles Angels`
 *    The number leads, then the players, then the team after the last spaced
 *    dash, a run of three or more dots, or an unspaced em/en dash between
 *    words. With none of those, a line of exactly two ", " parts (a "Jr." /
 *    "Sr." / "III" suffix stays with its name) is player, team; three or
 *    more is a list of players with no team. A trailing " - SP" style
 *    segment and a bracketed note ("(League Leaders)") are notes, never the
 *    team.
 *
 * Hobby markers (RC, SP, SSP, VAR, HOF, AU, 1st, print runs "/99" and
 * "#/99") and bracketed notes are dropped from players and teams; "®" and
 * "™" from both. A subject that is not a person ("Checklist 1-100", "Royals
 * Team Card", "Mets TC", "Team Leaders") keeps the row's number but names no
 * player, so it never fills one.
 *
 * Every non-blank line that does not give a row is listed in `skipped` with
 * the reason, never dropped silently. A card number is NOT treated as unique
 * (product rule 7): two rows with the same number are both kept, and the
 * server's exactly-one guard decides what they can match.
 *
 * A card printed with no number ("NNO") is kept as a row numbered "NNO" and
 * flagged `noNumber`: the matcher pairs it by player, and only when exactly
 * one unnumbered card and exactly one NNO row name that player.
 *
 * A line whose leading "number" is a season ("1995-96 Fort Worth Fire team
 * set") or the set's own year (`options.setYear`) is the checklist's title,
 * not a card, and is skipped as `LOOKS_LIKE_A_TITLE`.
 */

export type PublishedChecklistRow = {
  number: string;
  players: string[];
  teams: string[];
  /**
   * The publisher printed no number on this card ("NNO"); `number` is "NNO".
   * The matcher pairs such a row by player only.
   */
  noNumber?: true;
  /**
   * The subset ("card set", "set", "subset" or "insert" column) the row
   * belongs to, when the file has such a column and the cell is not blank.
   * Never sent to the server as data: `filterRowsBySubsets` chooses rows by
   * it, and the fetch ignores it.
   */
  subset?: string;
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
   * Present only when the file's header has a subset column: the distinct
   * non-blank subsets of the kept rows, in file order. The dialog lets the
   * operator pick which belong to this set (`filterRowsBySubsets`).
   */
  subsets?: string[];
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

type Column = "number" | "players" | "teams" | "subset";

/** The words a header cell may use for each column, compared folded. */
const HEADER_SPELLINGS: Record<Column, readonly string[]> = {
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
    "description",
    "card description",
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
  subset: [
    "card set",
    "set",
    "set name",
    "subset",
    "sub set",
    "subset name",
    "insert",
    "insert name",
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

function columnOf(header: string): Column | null {
  const folded = foldHeader(header);
  for (const key of ["number", "players", "teams", "subset"] as const) {
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

/**
 * "Alonso / Schwarber; Soto" → ["Alonso", "Schwarber", "Soto"]. With
 * `andToo` (players only), a spaced "&" or "and" splits as well; "Anderson"
 * stays whole because the word must stand alone.
 */
function splitNames(cell: string, andToo = false): string[] {
  return cell
    .split(andToo ? / & | and |[/;]/ : /[/;]/)
    .map((name) =>
      name
        .replace(/\s+/g, " ")
        // A comma left at either end by a dropped marker ("Trout, RC").
        .replace(/^[\s,]+|[\s,]+$/g, "")
        .trim(),
    )
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

/**
 * Hobby markers as whole tokens go: RC, SP, SSP, VAR, HOF, AU, 1st, and the
 * print runs "/99" and "#/99". A name that merely contains the letters
 * ("Marcus Arcos", "Austin", "Spencer") stays. The letter markers are matched
 * in capitals only, as checklists print them.
 */
function dropMarkers(text: string): string {
  return text
    .replace(/(^|[\s,;])#?\/\d+(?=$|[\s,;/])/g, "$1")
    .replace(/(^|[\s,/;])(?:RC|SP|SSP|VAR|HOF|AU|1[sS][tT])(?=$|[\s,/;])/g, "$1");
}

/** "®" and "™" are never part of a name. */
function dropTrademarks(text: string): string {
  return text.replace(/[®™]/g, "");
}

/** A cell or line part as a name list reads it: notes, markers and ®/™ gone. */
function cleanNamePart(text: string): string {
  return dropTrademarks(dropMarkers(dropBracketed(text)));
}

/** Player names that are the card's subject, not a person. */
const NOT_A_PERSON = new Set(["team card", "checklist", "team checklist", "header card"]);
/**
 * Subjects that are not a person by their shape: "Checklist 1-100", "Kansas
 * City Royals Team", "Royals Team Card", "Mets TC", "Team Leaders", "AL
 * Team Leaders".
 */
const NOT_A_PERSON_SHAPES: readonly RegExp[] = [
  /^checklist\b/i,
  /\bteam$/i,
  /\bteam card$/i,
  /\bTC$/,
  /^team leaders\b/i,
  /\bteam leaders$/i,
];

function isNotAPerson(name: string): boolean {
  const folded = name.replace(/\s+/g, " ").trim().toLowerCase();
  if (NOT_A_PERSON.has(folded)) return true;
  const trimmed = name.replace(/\s+/g, " ").trim();
  return NOT_A_PERSON_SHAPES.some((shape) => shape.test(trimmed));
}

function playersFrom(cell: string): string[] {
  return splitNames(cleanNamePart(cell), true).filter((name) => !isNotAPerson(name));
}

function teamsFrom(cell: string): string[] {
  return splitNames(cleanNamePart(cell));
}

/** The subject of a player cell or part, for the "not a person" test. */
function subjectOf(cell: string): string {
  return splitNames(cleanNamePart(cell)).join(" / ");
}

/** A card number: one token with at least one digit ("60", "BDC-12", "US1", "T-34"). */
const NUMBER_TOKEN = /^#?([A-Za-z0-9][A-Za-z0-9.-]*)$/;
/**
 * An insert's letter code, capitals on both sides of a hyphen: "RA-MT",
 * "DA-TJ", "CPA-JH". Capitals only, so a hyphenated name leading a line
 * ("Jean-Carlos") is never taken for a number.
 */
const LETTER_CODE = /^[A-Z]{1,6}(?:-[A-Z]{1,6})+$/;

function cleanNumber(raw: string): string | null {
  const token = numberToken(raw);
  if (!token || !NUMBER_TOKEN.test(token)) return null;
  if (!/\d/.test(token) && !LETTER_CODE.test(token)) return null;
  return token;
}

/** The number an unnumbered card's row carries, as checklists print it. */
export const NO_NUMBER = "NNO";
/** Said for a line that counts the set ("200 cards"). */
export const LOOKS_LIKE_A_COUNT = "Looks like a count, not a card";

function isNno(raw: string): boolean {
  return numberToken(raw).toUpperCase() === "NNO";
}

const COUNT_LINE = /^\d+ cards?\.?$/i;

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
  if (row.subset !== undefined && row.subset.length > PUBLISHED_CHECKLIST_MAX_NAME) {
    return "The set name is too long";
  }
  return null;
}

/** A name suffix a ", " may come before without starting the team. */
const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv|v)\.?(?=$|[\s,])/i;

/**
 * The players text and the team text of a line, after its number. Bracketed
 * notes go first, so a dash or comma inside a note never splits. Separators,
 * in order: the last spaced dash (a run of 3+ dots and an unspaced em/en dash
 * between words count as one); else, with the name-suffix parts ("Jr.")
 * joined back, exactly two ", " parts are player and team, and three or more
 * are a player list with no team. A part after the first that holds only
 * markers (" - SP", ", RC") is a note, never the team.
 */
function splitPlayerAndTeam(rest: string): { playerPart: string; teamPart: string } {
  // Whitespace runs collapse to one space first: splitting on
  // `\s+[-–—]\s+` directly backtracks over every run and is quadratic in
  // its length (100k spaces took seconds on the main thread).
  const text = dropBracketed(rest)
    .replace(/\s+/g, " ")
    .replace(/ ?(?:\.{3,}|…+) ?/g, " - ")
    .replace(/(\p{L})[–—](\p{L})/gu, "$1 - $2")
    .trim();
  const parts = text
    .split(/ [-–—] /)
    .map((part) => part.replace(/^[-–—] ?| ?[-–—]$/g, "").trim())
    .filter((part, i) => i === 0 || cleanNamePart(part).trim() !== "");
  if (parts.length > 1) {
    // The team follows the LAST spaced dash, so a hyphenated name
    // ("Jean-Carlos", "Ryu Hyun-jin") stays in one piece.
    return { playerPart: parts.slice(0, -1).join(" - "), teamPart: parts[parts.length - 1] };
  }
  // No dash: the ", " parts decide. A suffix part ("Jr.") joins the name
  // before it; a part after the first holding only markers (", RC") is a note.
  const commaParts: string[] = [];
  for (const piece of (parts[0] ?? "").split(", ")) {
    if (commaParts.length > 0 && NAME_SUFFIX.test(piece)) {
      commaParts[commaParts.length - 1] += `, ${piece}`;
    } else if (commaParts.length === 0 || cleanNamePart(piece).trim() !== "") {
      commaParts.push(piece);
    }
  }
  // Exactly two: player, team ("Shohei Ohtani, Los Angeles Dodgers"). Three
  // or more is a list of players ("Alonso, Schwarber, Soto") and names no
  // team: a wrong team would be a claim that holds back the BSC lookup
  // (wrapper rule 8), so a list is never read as one.
  if (commaParts.length === 2) return { playerPart: commaParts[0], teamPart: commaParts[1] };
  if (commaParts.length >= 3) return { playerPart: commaParts.join(" / "), teamPart: "" };
  return { playerPart: commaParts[0] ?? "", teamPart: "" };
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
  const noNumber = match !== null && isNno(match[1]);
  const number = noNumber ? NO_NUMBER : match ? cleanNumber(match[1]) : null;
  if (!match || !number) return { reason: "No card number at the start" };
  const { playerPart, teamPart } = splitPlayerAndTeam(match[2]);
  const players = playersFrom(playerPart);
  const teams = teamsFrom(teamPart);
  if (players.length === 0 && teams.length === 0 && !isNotAPerson(subjectOf(playerPart))) {
    return { reason: "No player or team after the number" };
  }
  return { number, players, teams, ...(noNumber ? { noNumber: true as const } : {}) };
}

type Delimited = { delimiter: "," | "\t"; columns: Array<Column | null>; header: boolean };

function detectDelimited(firstLine: string): Delimited | null {
  for (const delimiter of ["\t", ","] as const) {
    if (!firstLine.includes(delimiter)) continue;
    const columns = splitDelimited(firstLine, delimiter).map(columnOf);
    if (columns.includes("number") && (columns.includes("players") || columns.includes("teams"))) {
      return { delimiter, columns, header: true };
    }
  }
  return null;
}

/**
 * No header: when most non-blank lines carry two or more of one delimiter
 * after a one-word first cell ("1\tMike Trout\tLos Angeles Angels",
 * `1,Mike Trout,"Los Angeles Angels"`), the columns are number, player,
 * team. Tabs are tried first. Over-long lines don't count either way.
 */
function detectPositional(lines: readonly string[], from: number): Delimited | null {
  for (const delimiter of ["\t", ","] as const) {
    let content = 0;
    let shaped = 0;
    for (let i = from; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "" || line.length > PUBLISHED_CHECKLIST_MAX_LINE) continue;
      content++;
      if (!line.includes(delimiter)) continue;
      const cells = splitDelimited(line, delimiter);
      if (cells.length >= 3 && /^\S+$/.test(cells[0])) shaped++;
    }
    if (content > 0 && shaped * 2 > content) {
      return { delimiter, columns: ["number", "players", "teams"], header: false };
    }
  }
  return null;
}

/**
 * Rows a file with a subset column carries, narrowed to the subsets the
 * operator chose. A row with no subset (its cell was blank) is kept: nothing
 * says it belongs elsewhere. Pure; the input is not touched.
 */
export function filterRowsBySubsets<T extends { subset?: string }>(
  rows: readonly T[],
  chosen: readonly string[],
): T[] {
  const keep = new Set(chosen);
  return rows.filter((row) => row.subset === undefined || keep.has(row.subset));
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
    (lines[firstIndex].length > PUBLISHED_CHECKLIST_MAX_LINE
      ? null
      : detectDelimited(lines[firstIndex])) ?? detectPositional(lines, firstIndex);
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

  for (let i = firstIndex + (header?.header ? 1 : 0); i < lines.length; i++) {
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
    if (COUNT_LINE.test(raw.trim())) {
      skipped.push({ line: i + 1, text: raw, reason: LOOKS_LIKE_A_COUNT });
      continue;
    }
    const cells = header ? splitDelimited(raw, header.delimiter) : [];
    // Without a header, a line that has no second cell is read as a line
    // (a title, or a card written the published way).
    if (!header || (!header.header && cells.length < 2)) {
      const parsed = parseLine(raw, setYear);
      if ("reason" in parsed) skipped.push({ line: i + 1, text: raw, reason: parsed.reason });
      else keep(i, raw, parsed);
      continue;
    }
    let number: string | null = null;
    let noNumber = false;
    let numberCell = "";
    let subset = "";
    let notAPerson = false;
    const players: string[] = [];
    const teams: string[] = [];
    header.columns.forEach((column, c) => {
      const cell = cells[c] ?? "";
      if (column === "number" && numberCell === "") {
        numberCell = cell;
        noNumber = isNno(cell);
        number = noNumber ? NO_NUMBER : cleanNumber(cell);
      } else if (column === "players") {
        players.push(...playersFrom(cell));
        if (cell.trim() !== "" && isNotAPerson(subjectOf(cell))) notAPerson = true;
      } else if (column === "teams") {
        teams.push(...teamsFrom(cell));
      } else if (column === "subset" && subset === "") {
        subset = cell.replace(/\s+/g, " ").trim();
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
    if (players.length === 0 && teams.length === 0 && !notAPerson) {
      skipped.push({ line: i + 1, text: raw, reason: "No player or team on this line" });
      continue;
    }
    keep(i, raw, {
      number,
      players,
      teams,
      ...(noNumber ? { noNumber: true as const } : {}),
      ...(subset ? { subset } : {}),
    });
  }
  if (header?.columns.includes("subset")) {
    const subsets = [...new Set(rows.flatMap((r) => (r.subset === undefined ? [] : [r.subset])))];
    return { rows, skipped, format, subsets };
  }
  return { rows, skipped, format };
}
