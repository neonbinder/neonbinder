/**
 * PR 451 (NEO-478) — pair the operator's publisher checklist with the cards a
 * checklist fetch reconciled, by card number, under product rule 7.
 *
 * Pure: no Convex, no DOM. `fetchCardChecklist` runs it on the server; the
 * rows come from `parsePublishedChecklist` (same folder) on the client.
 *
 * ## Rule 7: a number pairs only when it is exactly one on BOTH sides
 *
 * A card number is the strongest key and still not unique (two series both
 * start at #1, a variation reuses its parent's number). So a card and a row
 * pair only when the normalised number names exactly one card AND exactly one
 * row. Anything else is left unmatched, never given to the first candidate.
 *
 * One fallback, on what the first pass left: a leading letter prefix
 * ("BCP-12", "US12") is stripped on both sides and the same exactly-one guard
 * applies again ("BCP-12" on BSC against "12" in the publisher's list).
 *
 * ## Cards with no number ("NNO") pair by player, never by a tie
 *
 * A row the publisher printed as "NNO" (`noNumber`) never takes part in the
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
 *    row names a different one: `conflict.teams`.
 *  - A card left unmatched whose players appear on a row at a DIFFERENT
 *    number is a likely misread (`misreads`): reported, never paired. The
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
 * ## NEO-490: when no number pairs at all, the players pair (`playerName`)
 *
 * Some publishers number a set one way and the marketplace another (Panini's
 * "1".."17" against BSC's "SIG-FT"; "SIG-FT" has no digit after its letters,
 * so the prefix strip never reaches it). When the number passes paired ZERO
 * cards and both sides hold numbered entries, the numbered cards and rows
 * pair by players instead (`pairByPlayerName`): the same `namesKey`, the same
 * exactly-one guard on both sides, so a player on two cards or two rows
 * leaves them unmatched. No surname pass. One number pair anywhere and this
 * never runs (`fallback: "none"`, today's behaviour); an all-NNO checklist
 * never reaches it either.
 *
 * Whether the name pairs are APPLIED turns on the counts:
 *  - Equal (numbered cards = numbered rows): the unique name pairs become
 *    matches (`via: "playerName"`, `fallback: "playerName"`), exactly like
 *    number pairs. Anything left on BOTH sides goes to the operator
 *    (`needsOperator`).
 *  - Different: the checklist and the fetch do not describe the same cards,
 *    so nothing is applied (`fallback: "operator"`, `needsOperator`); the
 *    unique name pairs come back as `suggestions` for the operator to accept.
 *
 * A name pair never touches the card's number (the card keeps the number it
 * was fetched with) and is never a number disagreement; players and teams are
 * compared as for any pair.
 */

export type ChecklistRowInput = {
  number: string;
  players: readonly string[];
  teams: readonly string[];
  /**
   * The publisher printed no number for this card ("NNO"). Such a row pairs
   * by player only (see the header). A row whose number is blank or "NNO"
   * counts as one whether or not the flag is set.
   */
  noNumber?: boolean;
};

export type ChecklistCardInput = {
  cardNumber: string;
  players?: readonly string[];
  teams?: readonly string[];
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
   * How the pair was made: the number as written, the number after the
   * letter-prefix strip, (a no-number card and an NNO row) the players, or
   * (NEO-490, no number paired at all and the counts agree) the players of
   * numbered cards and rows.
   */
  via: "number" | "prefixStripped" | "player" | "playerName";
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
   * NEO-490 — whether the players pass ran on numbered cards and rows, and
   * what came of it: `"none"` (a number paired, or one side has no numbered
   * entry: today's behaviour), `"playerName"` (equal counts: unique name
   * pairs applied as matches), `"operator"` (counts differ: nothing applied,
   * the name pairs are `suggestions`).
   */
  fallback: "none" | "playerName" | "operator";
  /**
   * NEO-490 — the operator must pair what is left: always under
   * `"operator"`; under `"playerName"` only when a card AND a row are both
   * left over. Never under `"none"`.
   */
  needsOperator: boolean;
  /** NEO-490 — under `"operator"` only: the unique name pairs, in card order. */
  suggestions: Array<{ cardIndex: number; rowIndex: number }>;
  /** NEO-490 — rows no match used, ascending. */
  unusedRowIndices: number[];
};

/** The most misread pairs listed; `misreadCount` counts the rest. */
export const MAX_CHECKLIST_MISREADS = 200;

/**
 * A card number as both sides compare it: trimmed, a leading "#" or "No."
 * dropped, inner whitespace removed, upper-cased. "#12" = "No. 12" = "12";
 * "bcp-12" = "BCP-12".
 */
export function normalizeChecklistNumber(raw: string): string {
  let n = raw.normalize("NFKC").trim();
  n = n.replace(/^(?:#|no\.?(?=\s|\d|#))\s*/i, "");
  n = n.replace(/^#\s*/, "");
  return n.replace(/\s+/g, "").toUpperCase();
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

/** Pair keys that are exactly one on each side. */
function pairUnique(
  cardKeys: Map<number, string>,
  rowKeys: Map<number, string>,
): Array<{ cardIndex: number; rowIndex: number }> {
  const cardsByKey = new Map<string, number[]>();
  for (const [i, k] of cardKeys) {
    const list = cardsByKey.get(k);
    if (list) list.push(i);
    else cardsByKey.set(k, [i]);
  }
  const rowsByKey = new Map<string, number[]>();
  for (const [i, k] of rowKeys) {
    const list = rowsByKey.get(k);
    if (list) list.push(i);
    else rowsByKey.set(k, [i]);
  }
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
 */
export function compareChecklistRow(
  card: Pick<ChecklistCardInput, "players" | "teams">,
  row: Pick<ChecklistRowInput, "players" | "teams">,
): { conflict?: ChecklistConflict; fillPlayers?: string[] } {
  const cardPlayers = nonEmpty(card.players);
  const rowPlayers = nonEmpty(row.players);
  const cardTeams = nonEmpty(card.teams);
  const rowTeams = nonEmpty(row.teams);
  const conflict: ChecklistConflict = {};
  if (cardPlayers.length > 0 && rowPlayers.length > 0 && !playersAgree(cardPlayers, rowPlayers)) {
    conflict.players = { marketplace: cardPlayers, checklist: rowPlayers };
  }
  if (cardTeams.length > 0 && rowTeams.length > 0 && namesKey(cardTeams) !== namesKey(rowTeams)) {
    conflict.teams = { marketplace: cardTeams, checklist: rowTeams };
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
  const cardNumbers = new Map<number, string>();
  cards.forEach((c, i) => {
    if (isNoNumber(c.cardNumber)) return;
    cardNumbers.set(i, normalizeChecklistNumber(c.cardNumber));
  });
  const rowNumbers = new Map<number, string>();
  rows.forEach((r, i) => {
    if (rowHasNoNumber(r)) return;
    rowNumbers.set(i, normalizeChecklistNumber(r.number));
  });

  const paired = new Map<number, { rowIndex: number; via: ChecklistCardMatch["via"] }>();
  const usedRows = new Set<number>();
  for (const p of pairUnique(cardNumbers, rowNumbers)) {
    paired.set(p.cardIndex, { rowIndex: p.rowIndex, via: "number" });
    usedRows.add(p.rowIndex);
  }

  // The fallback, on what is left on both sides. A number with no prefix
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

  // NEO-490 — no number paired at all, and both sides have numbered entries:
  // the numbered cards and rows pair by players (see the header). Decided
  // before the NNO pass, which neither side of this one takes part in.
  let fallback: ChecklistMatchResult["fallback"] = "none";
  let suggestions: ChecklistMatchResult["suggestions"] = [];
  if (paired.size === 0 && cardNumbers.size > 0 && rowNumbers.size > 0) {
    const numberedCards = [...cardNumbers.keys()];
    const numberedRows = [...rowNumbers.keys()];
    const namePairs = pairByPlayerName(
      numberedCards.map((i) => cards[i]),
      numberedRows.map((i) => rows[i]),
    ).map((p) => ({ cardIndex: numberedCards[p.cardIndex], rowIndex: numberedRows[p.rowIndex] }));
    if (numberedCards.length === numberedRows.length) {
      fallback = "playerName";
      for (const p of namePairs) {
        paired.set(p.cardIndex, { rowIndex: p.rowIndex, via: "playerName" });
        usedRows.add(p.rowIndex);
      }
    } else {
      fallback = "operator";
      suggestions = namePairs;
    }
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

  const matches: ChecklistCardMatch[] = [];
  const unmatchedCardIndices: number[] = [];
  cards.forEach((card, cardIndex) => {
    const pair = paired.get(cardIndex);
    if (!pair) {
      unmatchedCardIndices.push(cardIndex);
      return;
    }
    matches.push({
      cardIndex,
      rowIndex: pair.rowIndex,
      via: pair.via,
      ...compareChecklistRow(card, rows[pair.rowIndex]),
    });
  });
  const unusedRowIndices: number[] = [];
  rows.forEach((_, i) => {
    if (!usedRows.has(i)) unusedRowIndices.push(i);
  });
  // NEO-490 — the operator pairs what is left: always when the counts
  // differed, and after an applied name pass only when a card AND a row are
  // both left (nothing to pair otherwise).
  const needsOperator =
    fallback === "operator" ||
    (fallback === "playerName" && unmatchedCardIndices.length > 0 && unusedRowIndices.length > 0);

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
    fallback,
    needsOperator,
    suggestions,
    unusedRowIndices,
  };
}
