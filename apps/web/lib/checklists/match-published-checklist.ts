/**
 * PR 451 (NEO-478) — pair the operator's official checklist with the cards a
 * checklist fetch reconciled, by card number, under product rule 7.
 *
 * Pure: no Convex, no DOM. `fetchCardChecklist` runs it on the server; the
 * rows come from `parsePublishedChecklist` (same folder) on the client.
 *
 * ## Rule 7: a number pairs only when it is exactly one on BOTH sides
 *
 * A card number is the strongest key and still not unique (two series both
 * start at #1, a variation reuses its parent's number). So a card and a row
 * pair only when the number names exactly one card AND exactly one row.
 * Anything else is left unmatched, never given to the first candidate.
 *
 * Numbers are compared as printed, case kept (NEO-489): "1a" and "1A" can be
 * two different cards in one set. Three passes, each on what the one before
 * left:
 *
 *  1. **Exact** (`exactChecklistNumber`): trimmed, a leading "#" / "No."
 *     dropped, inner spaces removed, case KEPT. Exactly one card and one row.
 *  2. **Case-folded** (`normalizeChecklistNumber`, the exact key upper-cased):
 *     a leftover pairs only when its folded key belongs to exactly one card
 *     in the WHOLE set and exactly one row in the WHOLE checklist. So "1a"
 *     and "1A" both on the card side never fold onto a lone "1A" row; a
 *     case-only twin on either side leaves the number unmatched.
 *  3. **Letter prefix stripped**: a leading letter prefix ("BCP-12", "US12")
 *     is stripped from the folded key on both sides and the same exactly-one
 *     guard applies again ("BCP-12" on BSC against "12" in the
 *     checklist).
 *
 * ## Cards with no number ("NNO") pair by player, never by a tie
 *
 * A row the checklist prints as "NNO" (`noNumber`) never takes part in the
 * number passes, and neither does a card whose number is blank or "NNO". Such
 * a row pairs with such a card only when the players (`namesKey`, the same
 * key the misread check uses) name exactly one no-number card AND exactly one
 * no-number row. Two cards or two rows for one player stay unmatched (the
 * card keeps its marketplace lookup). An NNO row never pairs with a numbered
 * card, and a numbered row never pairs by player.
 *
 * ## Disagreements are surfaced, never settled
 *
 *  - The players differ on both sides (both non-empty): `conflict.players`.
 *    Two lists of the same length agree when each checklist name is a
 *    marketplace name, or the end of one ("Alonso/Schwarber/Soto" against
 *    "Pete Alonso", "Kyle Schwarber", "Juan Soto"): checklists print surnames.
 *    That is a comparison only; nothing is written from it, and the card
 *    keeps the marketplace's full names (`playersAgree`).
 *  - The card already carries a team (BSC's bulk parse, or SportLots) and the
 *    row names a different one: `conflict.teams`. A row that says "No Team"
 *    (`noTeam`) against a card with a team is a disagreement too, with an
 *    empty checklist side.
 *  - A card still unmatched after every pass (the name passes below
 *    included) whose players appear on a row at a DIFFERENT number is a
 *    likely misread (`misreads`): reported, never paired. The
 *    list holds at most `MAX_CHECKLIST_MISREADS` pairs (a player on many
 *    rows times many unmatched cards could otherwise reach millions);
 *    `misreadCount` is always the whole.
 *
 * The card keeps the marketplace's values; the conflict carries both sides
 * for the operator ("Checklist says otherwise").
 *
 * Where the card has no players and the row has some, the row's players fill
 * them in (`fillPlayers`): a fill, not a disagreement.
 *
 * ## NEO-496: what no number paired, the players pair, on every fetch
 *
 * Some publishers number a set one way and the marketplace another (Panini's
 * "1".."17" against BSC's "SIG-FT"; "SIG-FT" has no digit after its letters,
 * so the prefix strip never reaches it), and an official checklist can carry a
 * misprinted number or a misspelled name. So after the number passes and the
 * NNO pass, the cards and rows still LEFT over pair by their players, in two
 * passes, each within its kind (a numbered card with a numbered row, a
 * no-number card with a no-number row; never across):
 *
 *  1. **Exact names** (`via: "playerName"`, `pairByPlayerName`): the same
 *     `namesKey`, exactly one leftover card AND exactly one leftover row per
 *     key. A player on two leftover cards or two leftover rows pairs neither.
 *     (For no-number entries the NNO pass already did exactly this.)
 *  2. **Near names** (`via: "playerFuzzy"`, with `confidence`): the first
 *     player of each, Jaro-Winkler at or above `PLAYER_NAME_AUTO_LINK` (0.92,
 *     the threshold BSC ↔ SportLots pairing uses), and only where the pair is
 *     each side's ONE best (`pairNamesBySimilarity`). A tie pairs nothing.
 *
 * Until NEO-496 (NEO-490) this ran only when no number paired at all, and was
 * applied only when the counts were equal.
 *
 * **A repeated number sits the name passes out** (D2, Jason 2026-11-10). A
 * number printed on two or more rows (as printed, case kept) is one the
 * checklist cannot pin down: every row bearing it, and every card whose number
 * is on two or more rows (as printed or case-folded), takes no part in either
 * name pass. So a card #6 against two "#6" rows stays unmatched even when its
 * player is on exactly one of them: the card keeps its marketplace lookup and
 * both rows are left over for the operator (rule 8, a tie stays unmatched).
 * NNO rows and cards are not numbered, so the NNO pass is unaffected.
 *
 * A name pair never touches the card's number (the card keeps the number it
 * was fetched with) and is never a number disagreement (NEO-490 rule A3). It
 * carries the row's number as printed (`checklistNumber`) so Match Cards can
 * show it beside the card. Players and teams are compared as for any pair.
 */

import {
  PLAYER_NAME_AUTO_LINK,
  pairNamesBySimilarity,
} from "../cards/name-similarity";
import { normalizeEntityName } from "../entities/normalize-name";

export type ChecklistRowInput = {
  number: string;
  players: readonly string[];
  teams: readonly string[];
  /**
   * The checklist prints no number for this card ("NNO"). Such a row pairs
   * by player only (see the header). A row whose number is blank or "NNO"
   * counts as one whether or not the flag is set.
   */
  noNumber?: boolean;
  /**
   * The checklist says this card shows no team ("No Team"); `teams` is then
   * empty. Against a card that has a team it is a conflict (NEO-489).
   */
  noTeam?: boolean;
};

export type ChecklistCardInput = {
  cardNumber: string;
  players?: readonly string[];
  teams?: readonly string[];
  /** A legacy single team, read only when `teams` is empty. */
  team?: string;
};

export type ChecklistConflictSides = { marketplace: string[]; checklist: string[] };
export type ChecklistConflict = {
  players?: ChecklistConflictSides;
  teams?: ChecklistConflictSides;
};

export type ChecklistCardMatch = {
  cardIndex: number;
  rowIndex: number;
  /**
   * How the pair was made: the number as printed (case kept), the number
   * case-folded (unique on both sides), the number after the letter-prefix
   * strip, (a no-number card and an NNO row) the players, or (NEO-496, what
   * no number paired) the players' exact names or a near first player.
   */
  via: "number" | "caseFolded" | "prefixStripped" | "player" | "playerName" | "playerFuzzy";
  /** NEO-496 — `playerFuzzy` only: the Jaro-Winkler score, 0.92..1. */
  confidence?: number;
  /**
   * NEO-496 — a name pair (`playerName` / `playerFuzzy`) with a numbered row:
   * the row's number as printed. The card keeps its own number; this is shown
   * beside it in Match Cards and is never a conflict.
   */
  checklistNumber?: string;
  /** Present only when the two disagree. */
  conflict?: ChecklistConflict;
  /** The row's players, when the card has none. */
  fillPlayers?: string[];
};

export type ChecklistMatchResult = {
  /** In card order. */
  matches: ChecklistCardMatch[];
  /** Cards no row paired with, in card order. */
  unmatchedCardIndices: number[];
  /**
   * Unmatched cards whose players a row lists under another number: the
   * first `MAX_CHECKLIST_MISREADS` pairs, in card then row order.
   */
  misreads: Array<{ cardIndex: number; rowIndex: number }>;
  /** Every such pair, including those past the list's cap. */
  misreadCount: number;
  /**
   * NEO-490 / NEO-496 — a card AND a row are both left over, so there is
   * something for the operator to pair by hand.
   */
  needsOperator: boolean;
  /** NEO-490 — rows no match used, ascending. */
  unusedRowIndices: number[];
};

/** The most misread pairs listed; `misreadCount` counts the rest. */
export const MAX_CHECKLIST_MISREADS = 200;

/**
 * A card number as printed, as the exact pass compares it: trimmed, a
 * leading "#" or "No." dropped, inner whitespace removed, case KEPT.
 * "#12" = "No. 12" = "12"; "1a" and "1A" stay two numbers.
 */
export function exactChecklistNumber(raw: string): string {
  let n = raw.normalize("NFKC").trim();
  n = n.replace(/^(?:#|no\.?(?=\s|\d|#))\s*/i, "");
  n = n.replace(/^#\s*/, "");
  return n.replace(/\s+/g, "");
}

/**
 * The case-folded number: `exactChecklistNumber` upper-cased. "bcp-12" =
 * "BCP-12". Pairs only under the whole-set guard of the case-folded pass.
 */
export function normalizeChecklistNumber(raw: string): string {
  return exactChecklistNumber(raw).toUpperCase();
}

/**
 * The number without a leading letter prefix ("BCP-12" → "12", "US12" →
 * "12"), or null when there is none to strip. Only letters followed by an
 * optional "-" and then a digit count as a prefix.
 */
export function stripLetterPrefix(normalized: string): string | null {
  const m = /^[A-Z]+-?(?=\d)/.exec(normalized);
  if (!m) return null;
  const rest = normalized.slice(m[0].length);
  return rest.length > 0 ? rest : null;
}

/**
 * A card number that is no number: blank, or "NNO" ("#NNO", "nno.") as
 * checklists and marketplaces print an unnumbered card.
 */
export function isNoNumber(raw: string): boolean {
  const n = normalizeChecklistNumber(raw).replace(/[.:]$/, "");
  return n === "" || n === "NNO";
}

/** Whether a checklist row is a no-number row: flagged, or its number is none. */
export function rowHasNoNumber(row: Pick<ChecklistRowInput, "number" | "noNumber">): boolean {
  return row.noNumber === true || isNoNumber(row.number);
}

/** A person's or team's name as the two sides compare it. */
export function checklistNameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function namesKey(names: readonly string[]): string {
  return [...new Set(names.map(checklistNameKey).filter(Boolean))].sort().join("|");
}

/** A suffix a surname comparison passes over ("Ken Griffey Jr" ends "griffey"). */
const SURNAME_SUFFIX = /(?: (?:jr|sr|ii|iii|iv|v))+$/;

/**
 * Do the checklist's players name the marketplace's? The same names, or the
 * same count with each checklist name equal to a marketplace name or to its
 * last word(s), each marketplace name used once. Exact names are paired
 * first, so a full name never takes a surname's partner.
 *
 * A comparison for the conflict check only: never used to write a name.
 */
export function playersAgree(
  marketplace: readonly string[],
  checklist: readonly string[],
): boolean {
  if (namesKey(marketplace) === namesKey(checklist)) return true;
  const market = marketplace.map(checklistNameKey).filter(Boolean);
  const listed = checklist.map(checklistNameKey).filter(Boolean);
  if (market.length !== listed.length || market.length === 0) return false;
  const open = [...market];
  const surnameLeft: string[] = [];
  for (const key of listed) {
    const at = open.indexOf(key);
    if (at === -1) surnameLeft.push(key);
    else open.splice(at, 1);
  }
  for (const key of surnameLeft) {
    const at = open.findIndex((full) => {
      const bare = full.replace(SURNAME_SUFFIX, "");
      return bare.endsWith(` ${key}`);
    });
    if (at === -1) return false;
    open.splice(at, 1);
  }
  return true;
}

function nonEmpty(names: readonly string[] | undefined): string[] {
  return (names ?? []).map((n) => n.trim()).filter(Boolean);
}

function groupByKey(keys: Map<number, string>): Map<string, number[]> {
  const byKey = new Map<string, number[]>();
  for (const [i, k] of keys) {
    const list = byKey.get(k);
    if (list) list.push(i);
    else byKey.set(k, [i]);
  }
  return byKey;
}

/** Pair keys that are exactly one on each side. */
function pairUnique(
  cardKeys: Map<number, string>,
  rowKeys: Map<number, string>,
): Array<{ cardIndex: number; rowIndex: number }> {
  const cardsByKey = groupByKey(cardKeys);
  const rowsByKey = groupByKey(rowKeys);
  const pairs: Array<{ cardIndex: number; rowIndex: number }> = [];
  for (const [k, cardList] of cardsByKey) {
    const rowList = rowsByKey.get(k);
    if (cardList.length === 1 && rowList?.length === 1) {
      pairs.push({ cardIndex: cardList[0], rowIndex: rowList[0] });
    }
  }
  return pairs;
}

/**
 * NEO-490 — pair cards and rows by their players: the same `namesKey` the
 * NNO pass uses, exactly one card AND exactly one row per key (rule 7's guard
 * on the only key left), in card order. A card or row with no players has no
 * key and pairs with nothing; a tie leaves every card and row of that key
 * unmatched, never given to the first.
 *
 * Pure, and indexes are positions in the lists given, so a caller may pass
 * any subset (the Match Cards dialog passes its leftovers).
 */
export function pairByPlayerName(
  cards: ReadonlyArray<{ players?: readonly string[] }>,
  rows: ReadonlyArray<{ players: readonly string[] }>,
): Array<{ cardIndex: number; rowIndex: number }> {
  const cardKeys = new Map<number, string>();
  cards.forEach((c, i) => {
    const k = namesKey(nonEmpty(c.players));
    if (k) cardKeys.set(i, k);
  });
  const rowKeys = new Map<number, string>();
  rows.forEach((r, i) => {
    const k = namesKey(nonEmpty(r.players));
    if (k) rowKeys.set(i, k);
  });
  return pairUnique(cardKeys, rowKeys).sort((a, b) => a.cardIndex - b.cardIndex);
}

/**
 * One pair compared: what disagrees (both sides non-empty and different) and
 * the players the row fills in when the card has none. The row's teams are
 * compared as written; `applyChecklistRow` (same folder) re-reads a team
 * conflict against the RESOLVED names. Shared by the matcher and every caller
 * that pairs a card and a row some other way (the operator's own links), so
 * the comparison cannot differ by how the pair was made.
 *
 * NEO-489: the card's teams are its `teams`, else its legacy single `team`.
 * A row that says "No Team" (`noTeam`) against a card that has a team is a
 * team disagreement with an EMPTY checklist side, however the pair was made
 * (number, case-folded number, prefix strip, players, or the operator's own
 * link): the operator decides, nothing is filled.
 */
export function compareChecklistRow(
  card: Pick<ChecklistCardInput, "players" | "teams" | "team">,
  row: Pick<ChecklistRowInput, "players" | "teams" | "noTeam">,
): { conflict?: ChecklistConflict; fillPlayers?: string[] } {
  const cardPlayers = nonEmpty(card.players);
  const rowPlayers = nonEmpty(row.players);
  const listedTeams = nonEmpty(card.teams);
  const cardTeams = listedTeams.length > 0 ? listedTeams : nonEmpty(card.team ? [card.team] : []);
  const rowTeams = nonEmpty(row.teams);
  const conflict: ChecklistConflict = {};
  if (cardPlayers.length > 0 && rowPlayers.length > 0 && !playersAgree(cardPlayers, rowPlayers)) {
    conflict.players = { marketplace: cardPlayers, checklist: rowPlayers };
  }
  if (cardTeams.length > 0 && rowTeams.length > 0 && namesKey(cardTeams) !== namesKey(rowTeams)) {
    conflict.teams = { marketplace: cardTeams, checklist: rowTeams };
  } else if (cardTeams.length > 0 && rowTeams.length === 0 && row.noTeam === true) {
    // The checklist says No Team; the card has one. The operator decides.
    conflict.teams = { marketplace: cardTeams, checklist: [] };
  }
  return {
    ...(conflict.players || conflict.teams ? { conflict } : {}),
    ...(cardPlayers.length === 0 && rowPlayers.length > 0 ? { fillPlayers: rowPlayers } : {}),
  };
}

export function matchPublishedChecklist(
  cards: readonly ChecklistCardInput[],
  rows: readonly ChecklistRowInput[],
): ChecklistMatchResult {
  // A no-number card or row has no key here: it pairs by player below, and
  // only there. The misread check reads a missing number as "".
  const cardExact = new Map<number, string>();
  const cardNumbers = new Map<number, string>();
  cards.forEach((c, i) => {
    if (isNoNumber(c.cardNumber)) return;
    const exact = exactChecklistNumber(c.cardNumber);
    cardExact.set(i, exact);
    cardNumbers.set(i, exact.toUpperCase());
  });
  const rowExact = new Map<number, string>();
  const rowNumbers = new Map<number, string>();
  rows.forEach((r, i) => {
    if (rowHasNoNumber(r)) return;
    const exact = exactChecklistNumber(r.number);
    rowExact.set(i, exact);
    rowNumbers.set(i, exact.toUpperCase());
  });

  const paired = new Map<
    number,
    { rowIndex: number; via: ChecklistCardMatch["via"]; confidence?: number }
  >();
  const usedRows = new Set<number>();
  // Pass 1: the number as printed, case kept.
  for (const p of pairUnique(cardExact, rowExact)) {
    paired.set(p.cardIndex, { rowIndex: p.rowIndex, via: "number" });
    usedRows.add(p.rowIndex);
  }

  // Pass 2: case-folded, for leftovers only, and only when the folded number
  // is exactly one card in the whole set AND exactly one row in the whole
  // checklist. Counting the whole of each side (not just the leftovers) is
  // what keeps "1a" from folding onto a "1A" row whose own "1A" card paired
  // in pass 1.
  const foldedCards = groupByKey(cardNumbers);
  const foldedRows = groupByKey(rowNumbers);
  for (const [cardIndex, folded] of cardNumbers) {
    if (paired.has(cardIndex)) continue;
    const cardList = foldedCards.get(folded);
    const rowList = foldedRows.get(folded);
    if (cardList?.length !== 1 || rowList?.length !== 1) continue;
    const rowIndex = rowList[0];
    if (usedRows.has(rowIndex)) continue;
    paired.set(cardIndex, { rowIndex, via: "caseFolded" });
    usedRows.add(rowIndex);
  }

  // Pass 3, on what is left on both sides. A number with no prefix
  // keeps itself, so "BCP-12" (card) meets "12" (row) and the reverse.
  const strippedCards = new Map<number, string>();
  for (const [i, n] of cardNumbers) {
    if (paired.has(i)) continue;
    strippedCards.set(i, stripLetterPrefix(n) ?? n);
  }
  const strippedRows = new Map<number, string>();
  for (const [i, n] of rowNumbers) {
    if (usedRows.has(i)) continue;
    strippedRows.set(i, stripLetterPrefix(n) ?? n);
  }
  for (const p of pairUnique(strippedCards, strippedRows)) {
    // Both sides as written already failed the first pass; only a pair the
    // strip actually created is new.
    paired.set(p.cardIndex, { rowIndex: p.rowIndex, via: "prefixStripped" });
    usedRows.add(p.rowIndex);
  }

  // No-number cards against NNO rows, by players: exactly one card and
  // exactly one row per players key, or neither pairs (rule 7's guard, on the
  // only key these cards have). A card or row with no players has no key.
  const noNumberCards = new Map<number, string>();
  cards.forEach((c, i) => {
    if (!isNoNumber(c.cardNumber)) return;
    const k = namesKey(nonEmpty(c.players));
    if (k) noNumberCards.set(i, k);
  });
  const noNumberRows = new Map<number, string>();
  rows.forEach((r, i) => {
    if (!rowHasNoNumber(r)) return;
    const k = namesKey(nonEmpty(r.players));
    if (k) noNumberRows.set(i, k);
  });
  for (const p of pairUnique(noNumberCards, noNumberRows)) {
    paired.set(p.cardIndex, { rowIndex: p.rowIndex, via: "player" });
    usedRows.add(p.rowIndex);
  }

  // D2 (Jason, 2026-11-10) — a number printed on two or more rows is one the
  // checklist cannot pin down. Every row bearing it, and every card with that
  // number (as printed or case-folded), sits out the name passes below: the
  // players never rescue a pair the number refused (rule 8, a tie stays
  // unmatched). Such a card keeps its marketplace lookup; such rows are left
  // for the operator.
  const rowsByExact = groupByKey(rowExact);
  const repeatedRows = new Set<number>();
  for (const list of rowsByExact.values()) {
    if (list.length > 1) for (const i of list) repeatedRows.add(i);
  }
  const repeatedNumberCards = new Set<number>();
  for (const [i, folded] of cardNumbers) {
    const exactRows = rowsByExact.get(cardExact.get(i) ?? "")?.length ?? 0;
    const foldedRowCount = foldedRows.get(folded)?.length ?? 0;
    if (exactRows > 1 || foldedRowCount > 1) repeatedNumberCards.add(i);
  }

  // NEO-496 — the leftovers pair by players, within their kind (see the
  // header): exact names, then a near first player. Numbered first, then the
  // no-number kind, whose exact-name pass the NNO pass above already was.
  for (const numbered of [true, false]) {
    const leftCards = () =>
      cards.flatMap((c, i) =>
        !paired.has(i) && !repeatedNumberCards.has(i) && isNoNumber(c.cardNumber) !== numbered ? [i] : [],
      );
    const leftRows = () =>
      rows.flatMap((r, i) =>
        !usedRows.has(i) && !repeatedRows.has(i) && rowHasNoNumber(r) !== numbered ? [i] : [],
      );
    if (numbered) {
      const lc = leftCards();
      const lr = leftRows();
      for (const p of pairByPlayerName(
        lc.map((i) => cards[i]),
        lr.map((i) => rows[i]),
      )) {
        paired.set(lc[p.cardIndex], { rowIndex: lr[p.rowIndex], via: "playerName" });
        usedRows.add(lr[p.rowIndex]);
      }
    }
    const lc = leftCards();
    const lr = leftRows();
    const firstPlayer = (names: readonly string[] | undefined) => {
      const first = nonEmpty(names)[0];
      return first ? normalizeEntityName(first) || undefined : undefined;
    };
    for (const p of pairNamesBySimilarity(
      lc.map((i) => firstPlayer(cards[i].players)),
      lr.map((i) => firstPlayer(rows[i].players)),
      PLAYER_NAME_AUTO_LINK,
    )) {
      paired.set(lc[p.leftIndex], {
        rowIndex: lr[p.rightIndex],
        via: "playerFuzzy",
        confidence: p.score,
      });
      usedRows.add(lr[p.rightIndex]);
    }
  }

  const matches: ChecklistCardMatch[] = [];
  const unmatchedCardIndices: number[] = [];
  cards.forEach((card, cardIndex) => {
    const pair = paired.get(cardIndex);
    if (!pair) {
      unmatchedCardIndices.push(cardIndex);
      return;
    }
    const row = rows[pair.rowIndex];
    const byName = pair.via === "playerName" || pair.via === "playerFuzzy";
    matches.push({
      cardIndex,
      rowIndex: pair.rowIndex,
      via: pair.via,
      ...(pair.confidence !== undefined ? { confidence: pair.confidence } : {}),
      ...(byName && !rowHasNoNumber(row) ? { checklistNumber: row.number.trim() } : {}),
      ...compareChecklistRow(card, row),
    });
  });
  const unusedRowIndices: number[] = [];
  rows.forEach((_, i) => {
    if (!usedRows.has(i)) unusedRowIndices.push(i);
  });
  // The operator pairs what is left, when there is something on both sides.
  const needsOperator = unmatchedCardIndices.length > 0 && unusedRowIndices.length > 0;

  // Likely misreads: an unmatched card whose players a row lists under a
  // different number. Reported only. Counted per group (the group's rows
  // less those at the card's own number), so the count costs one pass over
  // cards and rows however large the cross product is; only the listed pairs
  // are walked, and the walk stops at the cap. "" stands for a blank number,
  // which a normalised number never is.
  const rowsByPlayers = new Map<string, { rows: number[]; byNumber: Map<string, number> }>();
  rows.forEach((r, i) => {
    const k = namesKey(nonEmpty(r.players));
    if (!k) return;
    let group = rowsByPlayers.get(k);
    if (!group) {
      group = { rows: [], byNumber: new Map() };
      rowsByPlayers.set(k, group);
    }
    group.rows.push(i);
    const n = rowNumbers.get(i) ?? "";
    group.byNumber.set(n, (group.byNumber.get(n) ?? 0) + 1);
  });
  const misreads: ChecklistMatchResult["misreads"] = [];
  let misreadCount = 0;
  for (const cardIndex of unmatchedCardIndices) {
    const k = namesKey(nonEmpty(cards[cardIndex].players));
    if (!k) continue;
    const group = rowsByPlayers.get(k);
    if (!group) continue;
    const cardNumber = cardNumbers.get(cardIndex) ?? "";
    const here = group.rows.length - (group.byNumber.get(cardNumber) ?? 0);
    misreadCount += here;
    if (here === 0 || misreads.length >= MAX_CHECKLIST_MISREADS) continue;
    for (const rowIndex of group.rows) {
      if ((rowNumbers.get(rowIndex) ?? "") === cardNumber) continue;
      misreads.push({ cardIndex, rowIndex });
      if (misreads.length >= MAX_CHECKLIST_MISREADS) break;
    }
  }

  return {
    matches,
    unmatchedCardIndices,
    misreads,
    misreadCount,
    needsOperator,
    unusedRowIndices,
  };
}
