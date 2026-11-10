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
 * ## Disagreements are surfaced, never settled
 *
 *  - The players differ on both sides (both non-empty): `conflict.players`.
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
 */

export type ChecklistRowInput = {
  number: string;
  players: readonly string[];
  teams: readonly string[];
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
  /** How the number matched: as written, or after the letter-prefix strip. */
  via: "number" | "prefixStripped";
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

export function matchPublishedChecklist(
  cards: readonly ChecklistCardInput[],
  rows: readonly ChecklistRowInput[],
): ChecklistMatchResult {
  const cardNumbers = new Map<number, string>();
  cards.forEach((c, i) => {
    const n = normalizeChecklistNumber(c.cardNumber);
    if (n) cardNumbers.set(i, n);
  });
  const rowNumbers = new Map<number, string>();
  rows.forEach((r, i) => {
    const n = normalizeChecklistNumber(r.number);
    if (n) rowNumbers.set(i, n);
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

  const matches: ChecklistCardMatch[] = [];
  const unmatchedCardIndices: number[] = [];
  cards.forEach((card, cardIndex) => {
    const pair = paired.get(cardIndex);
    if (!pair) {
      unmatchedCardIndices.push(cardIndex);
      return;
    }
    const row = rows[pair.rowIndex];
    const cardPlayers = nonEmpty(card.players);
    const rowPlayers = nonEmpty(row.players);
    const cardTeams = nonEmpty(card.teams);
    const rowTeams = nonEmpty(row.teams);
    const conflict: ChecklistConflict = {};
    if (cardPlayers.length > 0 && rowPlayers.length > 0 && namesKey(cardPlayers) !== namesKey(rowPlayers)) {
      conflict.players = { marketplace: cardPlayers, checklist: rowPlayers };
    }
    if (cardTeams.length > 0 && rowTeams.length > 0 && namesKey(cardTeams) !== namesKey(rowTeams)) {
      conflict.teams = { marketplace: cardTeams, checklist: rowTeams };
    }
    matches.push({
      cardIndex,
      rowIndex: pair.rowIndex,
      via: pair.via,
      ...(conflict.players || conflict.teams ? { conflict } : {}),
      ...(cardPlayers.length === 0 && rowPlayers.length > 0 ? { fillPlayers: rowPlayers } : {}),
    });
  });

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

  return { matches, unmatchedCardIndices, misreads, misreadCount };
}
