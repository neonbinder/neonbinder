/**
 * NEO-379 — match one scanned front/back pair to a card in a set variant.
 *
 * Pure and string-only, so the rules and the thresholds can be unit tested
 * and later tuned on real scans without a Convex harness. The Convex side
 * (`convex/intakeRuns.ts`) loads the variant's `cardChecklist` rows, turns
 * them into `IntakeCandidate`s and stores what this returns.
 *
 * The rules come from the product invariant (CLAUDE.md, 7 and 8):
 *
 *   - The card number ranks above the player, but nothing is keyed on a
 *     number without an exactly-one-match guard. A number shared by two
 *     cards picks one only when the player names exactly one of them.
 *   - A number/player disagreement is a likely misread. The number's card is
 *     proposed (it ranks higher), but the band is "check" and the reason says
 *     why, so the collector decides. It is never settled silently.
 *   - A tie (a number or a player that fits more than one card) leaves the
 *     pair UNMATCHED, with the tied cards as candidates. Never the first one.
 *
 * Variations (the same card with a different picture, `variationOfCardId`)
 * share their parent's number. A number hit on a parent and its variations is
 * one card, not a tie: the parent is proposed and the variations are listed
 * so the screen can switch between them (V in the CLI).
 */

import { playerNamesMatch, teamNamesMatch } from "./pairing/names";

/** What preprocess read off the pair. Any field may be missing. */
export interface IntakeRead {
  cardNumber: string | null;
  /** Every player name read off either side, front first. */
  players: string[];
  team: string | null;
}

/** One `cardChecklist` row of the variant, reduced to what matching reads. */
export interface IntakeCandidate {
  id: string;
  cardNumber: string;
  /** The names printed on the card (`playerLinks[].nameOnCard`, `cardName`). */
  names: string[];
  team?: string | null;
  /** Set when this row is a variation of another row in the variant. */
  variationOf?: string | null;
}

export type IntakeBand = "matched" | "check" | "none";

/**
 * Why the matcher decided what it did. A closed vocabulary so the screen can
 * word it for a collector and the thresholds can be measured per reason.
 */
export type IntakeReason =
  | "numberAndPlayer" // the number names one card and the player agrees
  | "numberOnly" // the number names one card; no player was read
  | "playerUnconfirmed" // the number names one card; the player read matches no card
  | "numberPlayerConflict" // the number names one card, the player names another
  | "numberSharedPlayerPicked" // several cards share the number; the player picked one
  | "numberShared" // several cards share the number and nothing picked one
  | "numberFuzzy" // only a look-alike reading of the number (O/0, I/1) found the card
  | "playerOnly" // no number hit; the player names exactly one card
  | "playerShared" // no number hit; the player fits several cards
  | "noMatch" // something was read, nothing in the variant fits
  | "nothingRead" // neither a number nor a player was read
  // Set by the Convex side, never by `matchIntakePair`:
  | "noVariant" // the run has no variant yet, so nothing was matched
  | "byUser"; // the collector picked the card

export interface IntakeMatchResult {
  /** The proposed card, or null when no card is proposed. */
  cardId: string | null;
  /** 0 to 100. */
  confidence: number;
  band: IntakeBand;
  reason: IntakeReason;
  /** Cards the collector may mean, best first. Includes `cardId` when set. */
  candidates: string[];
  /** Variations of the proposed card, for switching with V. */
  variations: string[];
}

/** At or above this a proposed card is "matched"; below it, "check this". */
export const INTAKE_MATCHED_MIN = 85;
/** Below this no card is proposed at all. */
export const INTAKE_NONE_BELOW = 20;
/** How many candidates a pair carries to the screen. */
export const INTAKE_MAX_CANDIDATES = 8;

/** The band for a proposal. The one rule; the demo intake reads it too. */
export function intakeBandFor(cardId: string | null, confidence: number): IntakeBand {
  if (!cardId || confidence < INTAKE_NONE_BELOW) return "none";
  return confidence >= INTAKE_MATCHED_MIN ? "matched" : "check";
}

/**
 * The comparable form of a card number: upper case, no spaces, no leading
 * "#" or "No.", and leading zeros dropped from each run of digits ("007" and
 * "7" are one number). Hyphens and letter prefixes stay, because an auto or
 * relic number ("RA-MT", "PR-12") is the prefix as much as the digits.
 */
export function normalizeIntakeCardNumber(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^(#|NO\.?)/, "")
    .replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ""));
}

/**
 * The look-alike form, for a fallback only: the characters OCR swaps most
 * (O/0, I/L/1, S/5, B/8, Z/2) folded to digits. A hit through this form is
 * never "matched" on its own.
 */
function foldLookAlikes(normalized: string): string {
  return normalized
    .replace(/[O]/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[S]/g, "5")
    .replace(/[B]/g, "8")
    .replace(/[Z]/g, "2")
    .replace(/\d+/g, (digits) => digits.replace(/^0+(?=\d)/, ""));
}

/**
 * The keys a read number is compared on. NB stores numbers bare, without the
 * marketplace prefix the variant may carry (`metadata.cardNumberPrefix`, e.g.
 * "DK-"), while the card itself prints it; so the read is compared both as
 * read and with that prefix taken off.
 */
function readNumberKeys(raw: string, prefix: string | null | undefined): string[] {
  const full = normalizeIntakeCardNumber(raw);
  const keys = [full];
  if (prefix) {
    const p = normalizeIntakeCardNumber(prefix);
    if (p && full.startsWith(p) && full.length > p.length) {
      keys.push(normalizeIntakeCardNumber(full.slice(p.length)));
    }
  }
  return keys;
}

interface PlayerHit {
  match: boolean;
  exact: boolean;
}

/** Does any read player name any name on the card? A subset is a match. */
function playerHit(read: string[], card: IntakeCandidate): PlayerHit {
  let match = false;
  for (const r of read) {
    for (const n of card.names) {
      const m = playerNamesMatch(r, n);
      if (m.exact) return { match: true, exact: true };
      if (m.match) match = true;
    }
  }
  return { match, exact: false };
}

/**
 * Collapse rows to cards: a variation folds into its parent when the parent
 * is also present. Returns the head ids in input order.
 */
function heads(rows: IntakeCandidate[], byId: Map<string, IntakeCandidate>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const present = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    const head = row.variationOf && present.has(row.variationOf) && byId.has(row.variationOf)
      ? row.variationOf
      : row.id;
    if (!seen.has(head)) {
      seen.add(head);
      out.push(head);
    }
  }
  return out;
}

function result(
  cardId: string | null,
  confidence: number,
  reason: IntakeReason,
  candidates: string[],
  variationsOf: Map<string, string[]>,
): IntakeMatchResult {
  const ordered = cardId ? [cardId, ...candidates.filter((c) => c !== cardId)] : candidates;
  return {
    cardId,
    confidence,
    band: intakeBandFor(cardId, confidence),
    reason,
    candidates: [...new Set(ordered)].slice(0, INTAKE_MAX_CANDIDATES),
    variations: cardId ? (variationsOf.get(cardId) ?? []) : [],
  };
}

/**
 * Match one read pair against the variant's cards.
 *
 * `prefix` is the variant's `cardNumberPrefix`, when it has one.
 */
export function matchIntakePair(
  read: IntakeRead,
  cards: IntakeCandidate[],
  prefix?: string | null,
): IntakeMatchResult {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const variationsOf = new Map<string, string[]>();
  for (const c of cards) {
    if (c.variationOf && byId.has(c.variationOf)) {
      const list = variationsOf.get(c.variationOf) ?? [];
      list.push(c.id);
      variationsOf.set(c.variationOf, list);
    }
  }

  const players = read.players.map((p) => p.trim()).filter(Boolean);
  const number = read.cardNumber?.trim() || null;
  if (!number && players.length === 0) {
    return result(null, 0, "nothingRead", [], variationsOf);
  }

  const playerHits = players.length > 0
    ? heads(cards.filter((c) => playerHit(players, c).match), byId)
    : [];
  const playerMatches = (id: string) => {
    const card = byId.get(id);
    if (!card) return false;
    if (playerHit(players, card).match) return true;
    // A head's variations print the same player; a hit on one counts for it.
    return (variationsOf.get(id) ?? []).some((v) => {
      const row = byId.get(v);
      return !!row && playerHit(players, row).match;
    });
  };

  if (number) {
    const keys = new Set(readNumberKeys(number, prefix));
    let numberHits = heads(
      cards.filter((c) => keys.has(normalizeIntakeCardNumber(c.cardNumber))),
      byId,
    );
    let fuzzy = false;
    if (numberHits.length === 0) {
      const folded = new Set([...keys].map(foldLookAlikes));
      numberHits = heads(
        cards.filter((c) => folded.has(foldLookAlikes(normalizeIntakeCardNumber(c.cardNumber)))),
        byId,
      );
      fuzzy = numberHits.length > 0;
    }

    if (numberHits.length === 1) {
      const id = numberHits[0];
      if (fuzzy) {
        // A look-alike number is a lead, never a match on its own.
        if (players.length > 0 && playerMatches(id)) {
          return result(id, 80, "numberFuzzy", [], variationsOf);
        }
        return result(id, 55, "numberFuzzy", playerHits, variationsOf);
      }
      if (players.length === 0) return result(id, 88, "numberOnly", [], variationsOf);
      if (playerMatches(id)) return result(id, 97, "numberAndPlayer", [], variationsOf);
      const elsewhere = playerHits.filter((h) => h !== id);
      if (elsewhere.length > 0) {
        // The number ranks above the player, so its card is proposed; the
        // disagreement is shown, never settled here.
        return result(id, 45, "numberPlayerConflict", elsewhere, variationsOf);
      }
      return result(id, 70, "playerUnconfirmed", [], variationsOf);
    }

    if (numberHits.length > 1) {
      const picked = players.length > 0 ? numberHits.filter(playerMatches) : [];
      if (picked.length === 1) {
        return result(picked[0], fuzzy ? 60 : 80, "numberSharedPlayerPicked", numberHits, variationsOf);
      }
      // A tie stays unmatched for the collector to pick.
      return result(null, 0, "numberShared", picked.length > 1 ? picked : numberHits, variationsOf);
    }
  }

  // No number hit: the player is the only lead left.
  if (playerHits.length === 1) {
    return result(playerHits[0], 60, "playerOnly", [], variationsOf);
  }
  if (playerHits.length > 1) {
    if (read.team) {
      const team = read.team;
      const byTeam = playerHits.filter((id) => {
        const t = byId.get(id)?.team;
        return !!t && teamNamesMatch(team, t).match;
      });
      if (byTeam.length === 1) {
        return result(byTeam[0], 50, "playerOnly", playerHits, variationsOf);
      }
    }
    return result(null, 0, "playerShared", playerHits, variationsOf);
  }
  return result(null, 0, "noMatch", [], variationsOf);
}

/**
 * The names a `cardChecklist` row prints, for `IntakeCandidate.names`: each
 * linked player's printed name, plus the card name split on the separators
 * multi-player cards use ("A / B", "A & B").
 */
export function intakeNamesFor(
  cardName: string,
  playerLinks: ReadonlyArray<{ nameOnCard: string }> | undefined,
): string[] {
  const names = new Set<string>();
  for (const link of playerLinks ?? []) {
    if (link.nameOnCard.trim()) names.add(link.nameOnCard.trim());
  }
  for (const part of cardName.split(/\s+(?:\/|&)\s+/)) {
    if (part.trim()) names.add(part.trim());
  }
  return [...names];
}
