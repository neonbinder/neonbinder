/**
 * The server's re-check of publisher checklist rows, shared by every door that
 * takes them: a checklist pasted on one fetch (`selectorOptions.
 * fetchCardChecklist`), the operator's Match Cards links
 * (`publishedChecklistPairs`), each section of a stored checklist as it is
 * uploaded (NEO-496, `publishedChecklists.addSections`), and the stored rows
 * again as a fetch reads them. Moved here from `convex/selectorOptions.ts` in
 * NEO-496, unchanged; `selectorOptions.ts` re-exports every name.
 *
 * Pure: no database, so the stored rows and a paste are checked by the same
 * code. `noNumber` / `noTeam` are only ever emitted as `true`.
 */
import { ConvexError, v, type Infer } from "convex/values";
import { MAX_PLAYER_NAME_LENGTH } from "../../lib/players/name-limits";
import { rowHasNoNumber } from "../../lib/checklists/match-published-checklist";
import { isNoClaimTeamText, isNoTeamText } from "../../lib/checklists/no-team";
import { MAX_CARD_PLAYERS, MAX_CARD_TEAMS } from "../features/cardAttention";
import type { publishedChecklistStoredRowValidator } from "../schema";

/**
 * PR 451 (NEO-478) — the most rows one re-check takes: a pasted checklist on
 * one fetch, or one stored section (NEO-496, `MAX_SECTION_ROWS` is the same
 * number).
 */
export const MAX_PUBLISHED_CHECKLIST_ROWS = 2000;

/**
 * One publisher-checklist row as it crosses the wire. NEO-490 — exported for
 * `publishedChecklistPairs.applyPublishedChecklistPairs`, which takes the rows
 * the operator linked in Match Cards in this same shape.
 */
export const publishedChecklistRowValidator = v.object({
  number: v.string(),
  players: v.array(v.string()),
  teams: v.array(v.string()),
  // PR 451 (D-B) — the publisher printed no number ("NNO"). The re-check
  // below sets it from the number too, so a row sent without the flag
  // reads the same; the matcher pairs such a row by player only.
  noNumber: v.optional(v.boolean()),
  // NEO-489 — the checklist says the card shows no team ("No Team");
  // `teams` is then empty. The re-check below also reads it from a team
  // string that is exactly "No Team", so a row sent either way reads the
  // same, and refuses a row that says No Team and names a team.
  noTeam: v.optional(v.boolean()),
  // The parser's subset label (a file's "set" / "insert" column). The
  // client chooses rows by it; the fetch never reads it and drops it in
  // `checkPublishedChecklist`. Accepted so a row is sent as parsed.
  subset: v.optional(v.string()),
});
export const publishedChecklistValidator = v.object({
  rows: v.array(publishedChecklistRowValidator),
});
export type PublishedChecklist = Infer<typeof publishedChecklistValidator>;
/** NEO-496 — what the re-check returns, and what a stored chunk holds. */
export type PublishedChecklistStoredRow = Infer<typeof publishedChecklistStoredRowValidator>;

/** The characters a publisher checklist's card number may hold. */
const PUBLISHED_CHECKLIST_NUMBER_CHARS = /^[#A-Za-z0-9. -]*$/;

/**
 * The server's re-check of a publisher checklist (the client's parser applies
 * the same limits): at most `MAX_PUBLISHED_CHECKLIST_ROWS` rows, every number,
 * player and team within the stored-name cap, players and teams within a
 * card's caps. Refused whole, never trimmed, and named by row position only.
 * Strings are trimmed; empty names dropped. A row is a no-number row
 * (`noNumber: true`) when the client flagged it or its number is blank or
 * "NNO", by the matcher's own test (`rowHasNoNumber`), so the client's parse
 * and this re-check always agree on which rows pair by player.
 *
 * NEO-489: a row is a No Team row (`noTeam: true`, `teams: []`) when the
 * client flagged it or every team string is exactly "No Team"
 * (`isNoTeamText`, the parser's own test), so "No Team" never reaches the
 * fetch as a team name. A row that says No Team and also names a team
 * contradicts itself and refuses the whole checklist. A team string that
 * says nothing ("None", "N/A", a dash, "TBD": `isNoClaimTeamText`,
 * the parser's own list) as the row's only team is dropped, the same as a
 * blank cell, so a caller cannot plant a team named "None". Beside another
 * team it is kept as sent, exactly as the parser keeps it.
 */
export function checkPublishedChecklist(
  published: PublishedChecklist | undefined,
  options: { label?: string } = {},
): { rows: PublishedChecklistStoredRow[] } | undefined {
  if (!published) return undefined;
  // NEO-496: a stored section names itself ("section “Future Stars”"); a
  // pasted checklist reads as it always has.
  const label = options.label ?? "the publisher's checklist";
  const whole = label.charAt(0).toUpperCase() + label.slice(1);
  if (published.rows.length > MAX_PUBLISHED_CHECKLIST_ROWS) {
    throw new ConvexError(
      `${whole} has ${published.rows.length} rows; the limit is ${MAX_PUBLISHED_CHECKLIST_ROWS}.`,
    );
  }
  const rows = published.rows.map((row, index): PublishedChecklistStoredRow => {
    const where = `Row ${index + 1} of ${label}`;
    const number = row.number.trim();
    if (number.length > MAX_PLAYER_NAME_LENGTH) {
      throw new ConvexError(`${where} has a card number over ${MAX_PLAYER_NAME_LENGTH} characters.`);
    }
    // Defence in depth (NEO-489 security audit): the client parser only ever
    // sends letters, digits, ".", "-" (and "NNO"); "#" and spaces are what a
    // hand-written number may still carry. Anything else is refused.
    if (!PUBLISHED_CHECKLIST_NUMBER_CHARS.test(number)) {
      throw new ConvexError(`${where} has a card number with characters a card number never has.`);
    }
    // The subset is dropped below, but it still crossed the wire: held to the
    // same cap as a name, so an unread field cannot carry an unbounded string.
    if (row.subset !== undefined && row.subset.trim().length > MAX_PLAYER_NAME_LENGTH) {
      throw new ConvexError(`${where} has a set name over ${MAX_PLAYER_NAME_LENGTH} characters.`);
    }
    const clean = (names: string[], max: number, unit: string) => {
      const kept = names.map((n) => n.trim()).filter(Boolean);
      if (kept.length > max) {
        throw new ConvexError(`${where} names ${kept.length} ${unit}s; the limit is ${max}.`);
      }
      for (const n of kept) {
        if (n.length > MAX_PLAYER_NAME_LENGTH) {
          throw new ConvexError(
            `${where} has a ${unit} name over ${MAX_PLAYER_NAME_LENGTH} characters.`,
          );
        }
      }
      return kept;
    };
    // A no-claim word is dropped only as the whole cell (one string), as the
    // parser reads it; beside a team it is left as it is, like the client.
    const cleaned = clean(row.teams, MAX_CARD_TEAMS, "team");
    const named = cleaned.length === 1 && isNoClaimTeamText(cleaned[0]) ? [] : cleaned;
    const teams = named.filter((t) => !isNoTeamText(t));
    const noTeam = row.noTeam === true || teams.length < named.length;
    if (noTeam && teams.length > 0) {
      throw new ConvexError(`${where} says No Team and names a team.`);
    }
    return {
      number,
      players: clean(row.players, MAX_CARD_PLAYERS, "player"),
      teams,
      ...(rowHasNoNumber({ number, noNumber: row.noNumber }) ? { noNumber: true } : {}),
      ...(noTeam ? { noTeam: true } : {}),
    };
  });
  return { rows };
}
