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
 *
 * NEO-489, "No Team": a team cell (or a line's team part) that says exactly
 * "No Team", any case or spacing (`isNoTeamText`), is a claim that the card
 * shows no team. The row carries `noTeam: true` with `teams: []`; "No Team"
 * never travels as a team name. "None", "N/A", "-" and a blank cell make no
 * claim. "No Team" beside a real team, in one cell or across two team
 * columns, contradicts itself and the row is skipped as
 * `NO_TEAM_AND_A_TEAM`. A row with a number and a No Team claim but no
 * player is kept.
 *
 * Card numbers are read as printed, case kept. In a number column (a header
 * file, or a positional CSV / TSV) any one-word token of letters, digits,
 * "." and "-" is a number ("a", "PPR-DLa", "TBD", "1a"); "BDC 12" is two
 * words and is not. A line in the published line format is free text, so its
 * first word is a number only when it holds a digit or is a capitals letter
 * code ("RA-MT"): "Jean-Carlos Smith - Mets" is never card "Jean-Carlos".
 *
 * NEO-496, whole-set checklists, spreadsheets and PDFs:
 *  - The header row is looked for in the first `HEADER_SEARCH_LINES`
 *    non-blank lines; lines above it are skipped as `ABOVE_THE_HEADER`
 *    (Panini's sheets open with a credit line).
 *  - A lone ALL-CAPS line or cell ("FUTURE STARS") is a section heading
 *    (`headingText`) and names the subset of the rows under it, unless a
 *    subset cell names them. A heading with no rows is a group label. A
 *    repeated heading continues its section when nothing came between, and
 *    is told apart ("<group> <heading>", then " (2)") when met again later.
 *  - `parsePublishedChecklistCells` reads a spreadsheet's rows or a PDF's
 *    lines (from `read-xlsx.ts` / `read-pdf-lines.ts`). A PDF line is never
 *    read as free text: its cells, split by pdf.js x-gaps, are its columns.
 *  - In the default "leaf" mode the 2,000-row cap applies only when there
 *    are fewer than two subsets; with more, every row is returned and the
 *    dialog caps AFTER the operator's ticks (`capLeafRows`). "set" mode
 *    (`checklist-sections.ts`) has no per-leaf cap and skips rows outside
 *    any section as `NOT_IN_A_SECTION`.
 */

import { MAX_CARD_PLAYERS, MAX_CARD_TEAMS } from "../../convex/features/cardAttention";
import { isNoClaimTeamText, isNoTeamText, NO_TEAM_AND_A_TEAM } from "./no-team";

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
   * The checklist says this card shows no team ("No Team" in its team
   * cell). `teams` is then empty. A claim, never a team name (NEO-489).
   */
  noTeam?: true;
  /**
   * The subset the row belongs to: its "card set", "set", "subset" or
   * "insert" cell when the file has such a column and the cell is not
   * blank, else the latest section heading above it (NEO-496: a single
   * ALL-CAPS cell such as "FUTURE STARS"). Never sent to the server as row
   * data: `filterRowsBySubsets` chooses rows by it, and set mode
   * (`checklist-sections.ts`) groups rows into sections by it.
   */
  subset?: string;
};

export type SkippedLine = {
  /**
   * 1-based line number in the pasted text or file: the sheet's row number
   * for an .xlsx, the line counted across the document for a PDF.
   */
  line: number;
  /** For a PDF, the page the line is on. */
  page?: number;
  /** The line as read; a spreadsheet or PDF line's cells joined by " | ". */
  text: string;
  reason: string;
};

/** How the checklist was read: pasted or text-file lines, a delimited file, a spreadsheet, a PDF. */
export type PublishedChecklistFormat = "lines" | "csv" | "tsv" | "xlsx" | "pdf";

export type PublishedChecklistParse = {
  rows: PublishedChecklistRow[];
  skipped: SkippedLine[];
  format: PublishedChecklistFormat;
  /**
   * Present only when some row has a subset (a subset column or a section
   * heading): the distinct subsets of the kept rows, in file order. The
   * dialog lets the operator pick which belong to this set
   * (`filterRowsBySubsets`).
   */
  subsets?: string[];
  /**
   * For a subset named by a heading that sits under a group heading (a
   * heading with no rows of its own, such as Topps' "AUTOGRAPH"), the group.
   * Keyed by subset; absent when no subset has one.
   */
  groups?: Record<string, string>;
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

/** One whitespace character, as `String.prototype.trim` counts it. */
const WHITESPACE = /^\s$/;

/** Split one delimited line, honouring double quotes ("" is a literal quote). */
export function splitDelimited(line: string, delimiter: "," | "\t"): string[] {
  const cells: string[] = [];
  let cell = "";
  // Whether `cell` is still all whitespace. Tracked per character rather
  // than by `cell.trim()` at each quote, which re-reads the cell every time
  // and is quadratic on a cell of many quotes.
  let blank = true;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          blank = false;
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
        if (blank && !WHITESPACE.test(ch)) blank = false;
      }
    } else if (ch === '"' && blank) {
      quoted = true;
      cell = "";
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
      blank = true;
    } else {
      cell += ch;
      if (blank && !WHITESPACE.test(ch)) blank = false;
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
function splitNames(
  cell: string,
  andToo = false,
  keep: (name: string) => boolean = () => true,
  max = Infinity,
): string[] {
  const names: string[] = [];
  for (const part of cell.split(andToo ? / & | and |[/;]/ : /[/;]/)) {
    // A comma left at either end by a dropped marker ("Trout, RC").
    const name = trimEndSpacesAndCommas(part.replace(/\s+/g, " ").replace(/^[\s,]+/, ""));
    if (name.length === 0 || !keep(name)) continue;
    names.push(name);
    // One past `max` is enough for `overLimit` to skip the row; the rest of
    // a 900-name cell is never cleaned or held.
    if (names.length > max) break;
  }
  return names;
}

/** One character that `[\s,]` matches. */
const SPACE_OR_COMMA = /^[\s,]$/;

/**
 * Trailing whitespace and commas go. An index loop, never `/[\s,]+$/`: the
 * regex retries the run from every start in it and is quadratic on a cell
 * like "a , , , … x" (a 2 MB file of such cells took 31 s).
 */
function trimEndSpacesAndCommas(text: string): string {
  let end = text.length;
  while (end > 0 && SPACE_OR_COMMA.test(text[end - 1])) end--;
  return end === text.length ? text : text.slice(0, end);
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

/** At most one past `MAX_CARD_PLAYERS`: enough for `overLimit` to skip the row. */
function playersFrom(cell: string): string[] {
  return splitNames(cleanNamePart(cell), true, (name) => !isNotAPerson(name), MAX_CARD_PLAYERS);
}

/**
 * What one team cell or line part says. `teams` holds at most one past
 * `MAX_CARD_TEAMS` (enough for `overLimit` to skip the row) and never holds
 * "No Team": that is reported as `noTeam` instead.
 */
type TeamsRead = { teams: string[]; noTeam: boolean };

function teamsFrom(cell: string): TeamsRead {
  // "None", "N/A", "No team listed", "-": no claim, the same as blank (D2).
  if (isNoClaimTeamText(cell)) return { teams: [], noTeam: false };
  let noTeam = false;
  const teams = splitNames(
    cleanNamePart(cell),
    false,
    (name) => {
      if (!isNoTeamText(name)) return true;
      noTeam = true;
      return false;
    },
    MAX_CARD_TEAMS,
  );
  return { teams, noTeam };
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

/**
 * A free-text line's leading number: one token that holds a digit or is a
 * capitals letter code, so a name leading a line is never read as one.
 */
function cleanNumber(raw: string): string | null {
  const token = cleanColumnNumber(raw);
  if (!token) return null;
  if (!/\d/.test(token) && !LETTER_CODE.test(token)) return null;
  return token;
}

/**
 * A number column's cell: the column says it is a card number, so any one
 * token of letters, digits, "." and "-" is read as printed, case kept ("a",
 * "PPR-DLa", "TBD", "1a"). Two words ("BDC 12") are not a number.
 */
function cleanColumnNumber(raw: string): string | null {
  const token = numberToken(raw);
  if (!token || !NUMBER_TOKEN.test(token)) return null;
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

/**
 * Which limit, if any, a row breaks. The name counts are the server's own
 * caps (`checkPublishedChecklist` refuses the WHOLE checklist over either),
 * and skipping such a row also keeps a file of 900-name cells from holding
 * a million names in the preview.
 */
function overLimit(row: PublishedChecklistRow): string | null {
  if (row.number.length > PUBLISHED_CHECKLIST_MAX_NAME) return "Card number is too long";
  if (row.players.length > MAX_CARD_PLAYERS) return `More than ${MAX_CARD_PLAYERS} players on one card`;
  if (row.teams.length > MAX_CARD_TEAMS) return `More than ${MAX_CARD_TEAMS} teams on one card`;
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
  // `[\s\S]*`, not `.*`: a "\u2028" left in the line stops `.*` short of
  // the end, and the failed `$` then retries every shorter first word
  // (quadratic per line; a 2 MB file of such lines took over 2 s).
  const match = /^\s*(\S+)\s*([\s\S]*)$/.exec(text);
  if (match && readsAsTitle(match[1], setYear)) return { reason: LOOKS_LIKE_A_TITLE };
  const noNumber = match !== null && isNno(match[1]);
  const number = noNumber ? NO_NUMBER : match ? cleanNumber(match[1]) : null;
  if (!match || !number) return { reason: "No card number at the start" };
  const split = splitPlayerAndTeam(match[2]);
  let { playerPart, teamPart } = split;
  // "88 No Team": the only words after the number are the claim, so they are
  // the team part, never a player called "No Team".
  if (teamPart === "" && isNoTeamText(cleanNamePart(playerPart))) {
    teamPart = playerPart;
    playerPart = "";
  }
  const players = playersFrom(playerPart);
  const { teams, noTeam } = teamsFrom(teamPart);
  if (noTeam && teams.length > 0) return { reason: NO_TEAM_AND_A_TEAM };
  if (
    players.length === 0 &&
    teams.length === 0 &&
    !noTeam &&
    !isNotAPerson(subjectOf(playerPart))
  ) {
    return { reason: "No player or team after the number" };
  }
  return {
    number,
    players,
    teams,
    ...(noNumber ? { noNumber: true as const } : {}),
    ...(noTeam ? { noTeam: true as const } : {}),
  };
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
 * Rows a file with subsets carries, narrowed to the subsets the operator
 * chose. A row with no subset (its cell was blank and no heading came before
 * it) is kept: nothing says it belongs elsewhere. Pure; the input is not
 * touched.
 */
export function filterRowsBySubsets<T extends { subset?: string }>(
  rows: readonly T[],
  chosen: readonly string[],
): T[] {
  const keep = new Set(chosen);
  return rows.filter((row) => row.subset === undefined || keep.has(row.subset));
}

/**
 * The most rows one parse reads (NEO-496: the set-level limit). Past it a
 * row is skipped with `pastLimit`. A per-leaf checklist is then held to
 * `PUBLISHED_CHECKLIST_MAX_ROWS` AFTER the operator ticks its subsets
 * (`capLeafRows`), so a file of many subsets can still give one leaf its
 * 300 rows.
 */
export const PUBLISHED_CHECKLIST_MAX_TOTAL_ROWS = 50_000;

/** "Past the 2,000-row limit". */
export function pastLimit(limit: number): string {
  return `Past the ${limit.toLocaleString("en-US")}-row limit`;
}

/**
 * The rows one leaf may use: the first `PUBLISHED_CHECKLIST_MAX_ROWS`, and
 * how many past it were left off. The dialog runs it on the ticked subsets'
 * rows (`filterRowsBySubsets`) and says how many were dropped.
 */
export function capLeafRows<T>(rows: readonly T[]): { rows: T[]; dropped: number } {
  if (rows.length <= PUBLISHED_CHECKLIST_MAX_ROWS) return { rows: [...rows], dropped: 0 };
  return {
    rows: rows.slice(0, PUBLISHED_CHECKLIST_MAX_ROWS),
    dropped: rows.length - PUBLISHED_CHECKLIST_MAX_ROWS,
  };
}

/** Said for a line above the header row it was found under. */
export const ABOVE_THE_HEADER = "Above the header";
/** How many non-blank lines (or rows) are searched for the header. */
export const HEADER_SEARCH_LINES = 20;
/** Said for a spreadsheet row or PDF line holding one cell that is not a heading. */
export const ONE_CELL_ONLY = "Only one column here, so it isn't a card";
/** Said for a PDF line with more cells than number, player and team. */
export const TOO_MANY_COLUMNS = "More columns than number, player and team";
/** Said in set mode for a row above the first section heading or with a blank subset. */
export const NOT_IN_A_SECTION = "Not under any section heading";
/** Said where a spreadsheet or PDF was too long to read to the end. */
export const NOT_READ_PAST_HERE = "The file goes on past here; the rest wasn't read";

/** What the caller knows about the set the checklist is for. */
export type PublishedChecklistOptions = {
  /**
   * The set's year ("1995", or a season such as "1995-96": its first year is
   * used). A line whose card number is that year is a title line, skipped
   * with `LOOKS_LIKE_A_TITLE`.
   */
  setYear?: string | number | null;
  /**
   * "leaf" (the default): with fewer than two subsets, rows past
   * `PUBLISHED_CHECKLIST_MAX_ROWS` are skipped, as the one leaf would use
   * them all. With two or more, every row (up to
   * `PUBLISHED_CHECKLIST_MAX_TOTAL_ROWS`) is returned and the caller caps
   * after the ticks (`capLeafRows`). "set": no per-leaf cap at all;
   * `checklist-sections.ts` applies the set's own limits.
   */
  mode?: "leaf" | "set";
};

/**
 * A section heading: one non-blank cell (or a whole line) in capitals, such
 * as "FUTURE STARS" or "CLASS OF 2026 COOPERSTOWN CALLS". Not a heading: a
 * lone card number or letter code ("RA-MT", "NNO"), markers only ("RC"), a
 * count ("200 CARDS"), anything with a small letter, or a name over the
 * name limit. "®" and "™" are dropped from the name.
 */
export function headingText(cells: readonly string[]): string | null {
  let only: string | null = null;
  for (const cell of cells) {
    if (cell.trim() === "") continue;
    if (only !== null) return null;
    only = cell;
  }
  if (only === null) return null;
  const text = dropTrademarks(only).replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > PUBLISHED_CHECKLIST_MAX_NAME) return null;
  if (/\p{Ll}/u.test(text)) return null;
  if ((text.match(/\p{Lu}/gu) ?? []).length < 2) return null;
  if (isNno(text) || cleanNumber(text) !== null) return null;
  if (COUNT_LINE.test(text)) return null;
  if (cleanNamePart(text).trim() === "") return null;
  return text;
}

/**
 * Which section each row falls in, as the file goes.
 *
 * - A subset cell names its row's subset; the same name anywhere in the file
 *   is the same subset (the file says so).
 * - Otherwise the latest heading does. A heading followed straight by
 *   another heading, with no rows of its own, is a group label ("BASE",
 *   "INSERT", "AUTOGRAPH") for the headings after it.
 * - The same heading again with no other heading between (a heading
 *   repeated at the top of the next page) continues its section. Met again
 *   later, it is another section: named "<group> <heading>" when that is
 *   free, else with " (2)", " (3)"… after it.
 */
class SectionTracker {
  private heading: string | null = null;
  private assigned: string | null = null;
  private headingRows = 0;
  private group: string | null = null;
  private readonly used = new Set<string>();
  readonly groups = new Map<string, string>();
  sawHeadingRow = false;

  onHeading(name: string): void {
    if (name === this.heading) return;
    if (this.heading !== null && this.headingRows === 0) this.group = this.heading;
    this.heading = name;
    this.assigned = null;
    this.headingRows = 0;
  }

  /** The subset of a row about to be kept; `cell` is its subset cell ("" when none). */
  subsetFor(cell: string): string | undefined {
    this.headingRows++;
    if (cell !== "") {
      this.used.add(cell);
      return cell;
    }
    if (this.heading === null) return undefined;
    if (this.assigned === null) {
      this.assigned = this.uniqueName(this.heading);
      this.used.add(this.assigned);
      if (this.group !== null) this.groups.set(this.assigned, this.group);
    }
    this.sawHeadingRow = true;
    return this.assigned;
  }

  private uniqueName(heading: string): string {
    if (!this.used.has(heading)) return heading;
    const prefixed = this.group !== null ? `${this.group} ${heading}` : heading;
    if (prefixed.length <= PUBLISHED_CHECKLIST_MAX_NAME && !this.used.has(prefixed)) return prefixed;
    const base = prefixed.length <= PUBLISHED_CHECKLIST_MAX_NAME - 6 ? prefixed : heading;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (!this.used.has(candidate)) return candidate;
    }
  }
}

/** A row read from cells, or why the cells gave none. */
type CellsRead = { row: PublishedChecklistRow; subsetCell: string } | { reason: string };

/**
 * Read one row from cells already lined up with their columns. Shared by a
 * headered CSV / TSV, a positional one, a spreadsheet and a PDF.
 * `numberCells` "column" trusts any one-word token in the number column
 * (NEO-489); "free" needs a digit or a capitals letter code (a PDF line has
 * no declared column).
 */
function rowFromColumns(
  columns: ReadonlyArray<Column | null>,
  cells: readonly string[],
  setYear: string | null,
  numberCells: "column" | "free" = "column",
): CellsRead {
  let number: string | null = null;
  let noNumber = false;
  let numberCell = "";
  let subset = "";
  let notAPerson = false;
  let noTeam = false;
  const players: string[] = [];
  const teams: string[] = [];
  columns.forEach((column, c) => {
    const cell = cells[c] ?? "";
    if (column === "number" && numberCell === "") {
      numberCell = cell;
      noNumber = isNno(cell);
      number = noNumber
        ? NO_NUMBER
        : numberCells === "column"
          ? cleanColumnNumber(cell)
          : cleanNumber(cell);
    } else if (column === "players") {
      const named = playersFrom(cell);
      players.push(...named);
      // Read only when no player column names a person (a cell that names
      // one makes `players` non-empty, and the flag is then never read), so
      // a long cell is not split a second time.
      if (named.length === 0 && cell.trim() !== "" && isNotAPerson(subjectOf(cell))) {
        notAPerson = true;
      }
    } else if (column === "teams") {
      const read = teamsFrom(cell);
      teams.push(...read.teams);
      if (read.noTeam) noTeam = true;
    } else if (column === "subset" && subset === "") {
      subset = cell.replace(/\s+/g, " ").trim();
    }
  });
  if (numberCell !== "" && readsAsTitle(numberCell, setYear)) return { reason: LOOKS_LIKE_A_TITLE };
  if (!number) {
    return { reason: numberCell ? "Card number isn't one we can read" : "No card number" };
  }
  // "No Team" beside a team, in one cell or across two team columns.
  if (noTeam && teams.length > 0) return { reason: NO_TEAM_AND_A_TEAM };
  if (players.length === 0 && teams.length === 0 && !notAPerson && !noTeam) {
    return { reason: "No player or team on this line" };
  }
  return {
    row: {
      number,
      players,
      teams,
      ...(noNumber ? { noNumber: true as const } : {}),
      ...(noTeam ? { noTeam: true as const } : {}),
    },
    subsetCell: subset,
  };
}

/**
 * Collects rows and skipped lines for one parse, and finishes it: subsets,
 * groups, the per-leaf cap and the skipped list in line order.
 */
class ParseCollector {
  readonly rows: PublishedChecklistRow[] = [];
  private readonly rowAt: Array<{ line: number; page?: number; text: string }> = [];
  readonly skipped: SkippedLine[] = [];
  readonly sections = new SectionTracker();

  private readonly mode: "leaf" | "set";

  constructor(mode: "leaf" | "set") {
    this.mode = mode;
  }

  skip(line: number, text: string, reason: string, page?: number): void {
    this.skipped.push(page === undefined ? { line, text, reason } : { line, page, text, reason });
  }

  keep(line: number, text: string, row: PublishedChecklistRow, subsetCell: string, page?: number) {
    const tooLong = overLimit({ ...row, ...(subsetCell ? { subset: subsetCell } : {}) });
    if (tooLong) {
      this.skip(line, text, tooLong, page);
      return;
    }
    // Set mode holds the set's row limit by whole sections
    // (`checklist-sections.ts`), so a section is never cut part-way here.
    if (this.mode === "leaf" && this.rows.length >= PUBLISHED_CHECKLIST_MAX_TOTAL_ROWS) {
      this.skip(line, text, pastLimit(PUBLISHED_CHECKLIST_MAX_TOTAL_ROWS), page);
      return;
    }
    const subset = this.sections.subsetFor(subsetCell);
    if (subset === undefined && this.mode === "set") {
      this.skip(line, text, NOT_IN_A_SECTION, page);
      return;
    }
    this.rows.push(subset === undefined ? row : { ...row, subset });
    this.rowAt.push(page === undefined ? { line, text } : { line, page, text });
  }

  finish(format: PublishedChecklistFormat, hasSubsetColumn: boolean): PublishedChecklistParse {
    const mode = this.mode;
    let rows = this.rows;
    const withSubsets = hasSubsetColumn || this.sections.sawHeadingRow;
    const subsets = withSubsets
      ? [...new Set(rows.flatMap((r) => (r.subset === undefined ? [] : [r.subset])))]
      : undefined;
    if (mode === "leaf" && (subsets?.length ?? 0) < 2 && rows.length > PUBLISHED_CHECKLIST_MAX_ROWS) {
      for (const at of this.rowAt.slice(PUBLISHED_CHECKLIST_MAX_ROWS)) {
        this.skip(at.line, at.text, pastLimit(PUBLISHED_CHECKLIST_MAX_ROWS), at.page);
      }
      rows = rows.slice(0, PUBLISHED_CHECKLIST_MAX_ROWS);
      this.skipped.sort((a, b) => a.line - b.line);
    }
    const out: PublishedChecklistParse = { rows, skipped: this.skipped, format };
    if (subsets) out.subsets = subsets;
    if (this.sections.groups.size > 0) {
      const kept = new Set(subsets ?? []);
      const groups: Record<string, string> = {};
      for (const [subset, group] of this.sections.groups) if (kept.has(subset)) groups[subset] = group;
      if (Object.keys(groups).length > 0) out.groups = groups;
    }
    return out;
  }
}

/**
 * Read a pasted or uploaded checklist. Blank lines are not content and are
 * passed over; every other line is a row, a section heading or a `skipped`
 * entry.
 */
export function parsePublishedChecklist(
  text: string,
  options: PublishedChecklistOptions = {},
): PublishedChecklistParse {
  const setYear = fourDigitYear(options.setYear);
  const mode = options.mode ?? "leaf";
  if (text.length > PUBLISHED_CHECKLIST_MAX_TEXT) {
    return { rows: [], skipped: [], format: "lines", tooBig: true };
  }
  const lines = text.replace(/^﻿/, "").split(/\r\n|\r|\n/);
  const firstIndex = lines.findIndex((l) => l.trim() !== "");
  const out = new ParseCollector(mode);
  if (firstIndex === -1) return { rows: [], skipped: [], format: "lines" };

  // The header is looked for in the first `HEADER_SEARCH_LINES` non-blank
  // lines, so a title or a credit above it does not hide it. An over-long
  // line is never a header; it is skipped below like any other.
  let header: Delimited | null = null;
  let headerIndex = -1;
  for (let i = firstIndex, seen = 0; i < lines.length && seen < HEADER_SEARCH_LINES; i++) {
    if (lines[i].trim() === "") continue;
    seen++;
    if (lines[i].length > PUBLISHED_CHECKLIST_MAX_LINE) continue;
    header = detectDelimited(lines[i]);
    if (header) {
      headerIndex = i;
      break;
    }
  }
  if (!header) header = detectPositional(lines, firstIndex);
  const format: PublishedChecklistFormat = header
    ? header.delimiter === "\t"
      ? "tsv"
      : "csv"
    : "lines";

  for (let i = firstIndex; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    if (i === headerIndex) continue;
    if (i < headerIndex) {
      out.skip(i + 1, clip(raw), ABOVE_THE_HEADER);
      continue;
    }
    if (raw.length > PUBLISHED_CHECKLIST_MAX_LINE) {
      out.skip(
        i + 1,
        // Only the start is kept for the preview; the line itself is junk.
        `${raw.slice(0, 200).replace(/\s+/g, " ").trim().slice(0, 80)}…`,
        `Longer than ${PUBLISHED_CHECKLIST_MAX_LINE.toLocaleString("en-US")} characters`,
      );
      continue;
    }
    if (COUNT_LINE.test(raw.trim())) {
      out.skip(i + 1, raw, LOOKS_LIKE_A_COUNT);
      continue;
    }
    const cells = header ? splitDelimited(raw, header.delimiter) : [];
    // Without a header, a line that has no second cell is read as a line
    // (a heading, a title, or a card written the published way).
    if (!header || (!header.header && cells.length < 2)) {
      const parsed = parseLine(raw, setYear);
      if (!("reason" in parsed)) {
        out.keep(i + 1, raw, parsed, "");
        continue;
      }
      const heading = parsed.reason === LOOKS_LIKE_A_TITLE ? null : headingText([raw]);
      if (heading !== null) out.sections.onHeading(heading);
      else out.skip(i + 1, raw, parsed.reason);
      continue;
    }
    const heading = headingText(cells);
    if (heading !== null) {
      out.sections.onHeading(heading);
      continue;
    }
    const read = rowFromColumns(header.columns, cells, setYear);
    if ("reason" in read) out.skip(i + 1, raw, read.reason);
    else out.keep(i + 1, raw, read.row, read.subsetCell);
  }
  return out.finish(format, header?.columns.includes("subset") ?? false);
}

/** A skipped line's text, kept short for the preview. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

// ── Spreadsheets and PDFs (NEO-496) ────────────────────────────────────────

/** One spreadsheet row or PDF line, already split into cells. */
export type ChecklistCellRecord = {
  /** The sheet's row number, or the PDF line counted across the document. */
  line: number;
  /** A spreadsheet's cells by column (A = 0, blanks kept); a PDF line's cells left to right. */
  cells: readonly string[];
  /** For a PDF, the x (pt) each cell starts at; lines cells up with the columns. */
  xs?: readonly number[];
  /** For a PDF, the page. */
  page?: number;
};

/** A spreadsheet's or a PDF's lines, as `read-checklist-file.ts` hands them over. */
export type ChecklistCellsInput = {
  format: "xlsx" | "pdf";
  records: readonly ChecklistCellRecord[];
  /** The reader stopped early; the line after which nothing was read. */
  truncatedAfterLine?: number;
};

/** The header columns of a row of cells, or null when the row is not a header. */
function headerColumns(cells: readonly string[]): Array<Column | null> | null {
  const columns = cells.map((cell) => (cell.trim() === "" ? null : columnOf(cell)));
  return columns.includes("number") && (columns.includes("players") || columns.includes("teams"))
    ? columns
    : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** The nearest of `anchors` to `x`, by index; -1 when there are none. */
function nearest(anchors: ReadonlyArray<number | null>, x: number): number {
  let best = -1;
  let distance = Infinity;
  anchors.forEach((anchor, i) => {
    if (anchor === null) return;
    const d = Math.abs(anchor - x);
    if (d < distance) {
      best = i;
      distance = d;
    }
  });
  return best;
}

/**
 * Where a headerless PDF's number, player and team columns start, from its
 * three-cell lines: per page, else across the document. A two-cell line is
 * lined up with these, so a team card ("CT-1 … Los Angeles Dodgers") reads
 * its second cell as the team, not a player.
 */
function pdfColumnAnchors(records: readonly ChecklistCellRecord[]) {
  const all: [number[], number[], number[]] = [[], [], []];
  const byPage = new Map<number, [number[], number[], number[]]>();
  for (const record of records) {
    if (record.cells.length !== 3 || !record.xs || record.xs.length !== 3) continue;
    const page = record.page ?? 0;
    let lists = byPage.get(page);
    if (!lists) byPage.set(page, (lists = [[], [], []]));
    for (let c = 0; c < 3; c++) {
      lists[c].push(record.xs[c]);
      all[c].push(record.xs[c]);
    }
  }
  const whole = all.map(median);
  return (page: number | undefined): Array<number | null> => {
    const lists = byPage.get(page ?? 0);
    return lists ? lists.map(median) : whole;
  };
}

const POSITIONAL: ReadonlyArray<Column> = ["number", "players", "teams"];

/**
 * Read a spreadsheet's or a PDF's lines into rows. The same rules as a
 * pasted checklist: the header is looked for in the first
 * `HEADER_SEARCH_LINES` non-blank lines (lines above it are skipped as
 * `ABOVE_THE_HEADER`), a subset column or the latest heading names each
 * row's subset, and every line that gives no row is in `skipped` with the
 * reason. A PDF line is never read as a free-text line (`parseLine`): its
 * cells are its columns.
 *
 * Without a header a spreadsheet is read by position: A number, B player,
 * C team. A PDF line without a header is read by its cell count:
 *  - three cells: number, player, team;
 *  - two cells led by a card number: the number and a player, or a team
 *    when the second cell sits under the team column (a team card);
 *  - two cells not led by a number: a card printed with no number, read as
 *    player and team and numbered "NNO" (`noNumber`);
 *  - one cell: a heading when it is one, else skipped (`ONE_CELL_ONLY`);
 *  - more: skipped (`TOO_MANY_COLUMNS`).
 */
export function parsePublishedChecklistCells(
  input: ChecklistCellsInput,
  options: PublishedChecklistOptions = {},
): PublishedChecklistParse {
  const setYear = fourDigitYear(options.setYear);
  const mode = options.mode ?? "leaf";
  const out = new ParseCollector(mode);
  const records = input.records.filter((r) => r.cells.some((c) => c.trim() !== ""));
  const textOf = (record: ChecklistCellRecord) =>
    clip(record.cells.filter((c) => c.trim() !== "").join(" | "));

  let headerAt = -1;
  let columns: Array<Column | null> | null = null;
  for (let i = 0; i < Math.min(records.length, HEADER_SEARCH_LINES); i++) {
    columns = headerColumns(records[i].cells);
    if (columns) {
      headerAt = i;
      break;
    }
  }
  const headerXs = headerAt >= 0 ? records[headerAt].xs : undefined;
  const anchorsFor = input.format === "pdf" && !columns ? pdfColumnAnchors(records) : null;

  records.forEach((record, i) => {
    if (i === headerAt) return;
    const text = textOf(record);
    if (i < headerAt) {
      out.skip(record.line, text, ABOVE_THE_HEADER, record.page);
      return;
    }
    const heading = headingText(record.cells);
    if (heading !== null) {
      out.sections.onHeading(heading);
      return;
    }
    let read: CellsRead;
    if (columns) {
      let aligned: readonly string[] = record.cells;
      if (input.format === "pdf") {
        // Each cell goes under the header cell it sits nearest.
        const slots: string[] = columns.map(() => "");
        if (headerXs && record.xs && record.xs.length === record.cells.length) {
          record.cells.forEach((cell, c) => {
            const at = nearest(headerXs, record.xs![c]);
            if (at >= 0) slots[at] = slots[at] ? `${slots[at]} ${cell}` : cell;
          });
          aligned = slots;
        }
      }
      read = rowFromColumns(columns, aligned, setYear);
    } else if (input.format === "xlsx") {
      const filled = record.cells.filter((c) => c.trim() !== "").length;
      read =
        filled < 2
          ? { reason: oneCellReason(record.cells, setYear) }
          : rowFromColumns(POSITIONAL, record.cells, setYear);
    } else {
      read = readPdfLine(record, anchorsFor!(record.page), setYear);
    }
    if ("reason" in read) out.skip(record.line, text, read.reason, record.page);
    else out.keep(record.line, text, read.row, read.subsetCell, record.page);
  });
  if (input.truncatedAfterLine !== undefined) {
    out.skip(input.truncatedAfterLine + 1, "…", NOT_READ_PAST_HERE);
  }
  return out.finish(input.format, columns?.includes("subset") ?? false);
}

/** Why a lone cell that is not a heading gives no row. */
function oneCellReason(cells: readonly string[], setYear: string | null): string {
  const only = cells.find((c) => c.trim() !== "") ?? "";
  const first = /^\s*(\S+)/.exec(only)?.[1] ?? "";
  if (COUNT_LINE.test(only.trim())) return LOOKS_LIKE_A_COUNT;
  return readsAsTitle(first, setYear) ? LOOKS_LIKE_A_TITLE : ONE_CELL_ONLY;
}

/** A headerless PDF line, by its cell count (see `parsePublishedChecklistCells`). */
function readPdfLine(
  record: ChecklistCellRecord,
  anchors: ReadonlyArray<number | null>,
  setYear: string | null,
): CellsRead {
  const cells = record.cells;
  if (cells.length === 1) return { reason: oneCellReason(cells, setYear) };
  if (cells.length > 3) return { reason: TOO_MANY_COLUMNS };
  if (cells.length === 3) return rowFromColumns(POSITIONAL, cells, setYear, "free");
  const [first, second] = cells;
  if (!isNno(first) && cleanNumber(first) === null) {
    // No number: a card printed without one (Topps' "FANATICS AUTHENTICS").
    return rowFromColumns(POSITIONAL, [NO_NUMBER, first, second], setYear, "free");
  }
  const x = record.xs?.[1];
  const column = x === undefined ? 1 : nearest(anchors, x);
  return column === 2
    ? rowFromColumns(POSITIONAL, [first, "", second], setYear, "free")
    : rowFromColumns(POSITIONAL, [first, second, ""], setYear, "free");
}
