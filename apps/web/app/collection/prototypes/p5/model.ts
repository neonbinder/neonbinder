/**
 * NEO-350 prototype 5 ("Player PC") — pure helpers over the shared fake data.
 *
 * A PC (personal collection) is entered from a PLAYER or a TEAM, never a set.
 * Everything here is keyed on ids; a card number is never used on its own.
 */

import {
  cards,
  compareCards,
  evaluateRule,
  getCard,
  getPlayer,
  getSet,
  getTeam,
  type BinderRule,
  type Card,
  type CardId,
  type Copy,
  type Player,
  type PlayerId,
  type SetId,
  type Stint,
  type Team,
  type TeamId,
} from "../_shared/data";

/** The year a current stint (`to: null`) runs to on a career ribbon. */
export const THIS_YEAR = 2026;

/** What the collector follows: a player, or a team (a school is a team). */
export type PcRef =
  { kind: "player"; id: PlayerId } | { kind: "team"; id: TeamId };

/** For a team PC: the uniform on the front, or anyone who ever played there. */
export type TeamMode = "onCard" | "playedFor";

export function pcKey(ref: PcRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function parsePcKey(key: string | null): PcRef | null {
  if (!key) return null;
  const [kind, id] = key.split(":");
  if (!id) return null;
  try {
    if (kind === "player") {
      getPlayer(id);
      return { kind, id };
    }
    if (kind === "team") {
      getTeam(id);
      return { kind, id };
    }
  } catch {
    // An unknown id in the URL: fall back to the landing page.
  }
  return null;
}

export function isSchool(team: Team): boolean {
  return team.league === "NCAA";
}

/** A school's PC defaults to "played for" (alma mater, any uniform). */
export function defaultTeamMode(team: Team): TeamMode {
  return isSchool(team) ? "playedFor" : "onCard";
}

/** The rule a PC saves as a smart binder. */
export function pcRule(ref: PcRef, mode: TeamMode): BinderRule {
  if (ref.kind === "player") return { kind: "player", playerId: ref.id };
  return mode === "onCard"
    ? { kind: "teamOnCard", teamId: ref.id }
    : { kind: "playedFor", teamId: ref.id };
}

/** Default name for "Save as binder". */
export function pcBinderName(ref: PcRef, mode: TeamMode): string {
  if (ref.kind === "player") return `${getPlayer(ref.id).name} PC`;
  const team = getTeam(ref.id);
  if (mode === "onCard") return `${team.name} on the card`;
  return isSchool(team) ? `${team.name} alumni` : `Played for the ${team.name}`;
}

export function pcTitle(ref: PcRef): string {
  if (ref.kind === "player") return getPlayer(ref.id).name;
  const team = getTeam(ref.id);
  return `${team.location} ${team.name}`;
}

export function sameRule(a: BinderRule, b: BinderRule): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every catalog card in the PC, checklist order. */
export function pcCards(ref: PcRef, mode: TeamMode): Card[] {
  const rule = pcRule(ref, mode);
  return cards.filter((c) => evaluateRule(rule, c)).sort(compareCards);
}

export function ownedSet(copies: Copy[]): Set<CardId> {
  return new Set(copies.filter((c) => c.quantity > 0).map((c) => c.cardId));
}

export function countOwned(list: Card[], owned: Set<CardId>): number {
  return list.reduce((n, c) => n + (owned.has(c.id) ? 1 : 0), 0);
}

/** A stint's last year on the ribbon. */
export function stintEnd(st: Stint): number {
  return st.to ?? THIS_YEAR;
}

/** "1980–83", "2024–now", "2000". */
export function stintYears(st: Stint): string {
  if (st.to === null) return `${st.from}–now`;
  if (st.to === st.from) return String(st.from);
  const sameCentury = Math.floor(st.from / 100) === Math.floor(st.to / 100);
  return `${st.from}–${sameCentury ? String(st.to).slice(2) : st.to}`;
}

/** College first, then the pros, each in date order. */
export function careerOrder(player: Player): Stint[] {
  return [...player.stints].sort((a, b) => {
    const ca = isSchool(getTeam(a.teamId)) ? 0 : 1;
    const cb = isSchool(getTeam(b.teamId)) ? 0 : 1;
    return ca - cb || a.from - b.from;
  });
}

/** The teams a player was with in a year (several in a trade year). */
export function teamsInYear(player: Player, year: number): Team[] {
  return player.stints
    .filter((st) => st.from <= year && year <= stintEnd(st))
    .map((st) => getTeam(st.teamId));
}

/** The year a card is filed under (its set's year). */
export function cardYear(card: Card): number {
  return getSet(card.setId).year;
}

export interface YearGroup {
  year: number;
  cards: Card[];
}

/** Group cards by set year, oldest first (a career reads left to right). */
export function groupByYear(list: Card[]): YearGroup[] {
  const map = new Map<number, Card[]>();
  for (const c of list) {
    const y = cardYear(c);
    const row = map.get(y) ?? [];
    row.push(c);
    map.set(y, row);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, rows]) => ({ year, cards: rows.sort(compareCards) }));
}

/**
 * The card's rainbow: the base card and every parallel of it in the same set,
 * in the set's own variant order. An insert or an image variation stands
 * alone (parallels are of the regular base card). Matched on set, variant
 * type, number AND variation, never on the number alone.
 */
export function rainbowOf(card: Card): Card[] {
  if (card.variantPath.type === "Inserts" || card.variation !== null)
    return [card];
  const set = getSet(card.setId);
  const order = (c: Card) =>
    set.variants.findIndex(
      (v) =>
        v.path.type === c.variantPath.type &&
        v.path.name === c.variantPath.name,
    );
  return cards
    .filter(
      (c) =>
        c.setId === card.setId &&
        c.cardNumber === card.cardNumber &&
        c.variation === null &&
        (c.variantPath.type === "Base" || c.variantPath.type === "Parallels"),
    )
    .sort((a, b) => order(a) - order(b));
}

/** The base card at the root of a rainbow (the key a chased rainbow is stored by). */
export function rainbowRoot(card: Card): Card {
  const rainbow = rainbowOf(card);
  return rainbow.find((c) => c.variantPath.type === "Base") ?? rainbow[0];
}

/** "Base", "Gold Refractor". */
export function parallelName(card: Card): string {
  return card.variantPath.name ?? "Base";
}

/**
 * Exactly one card at (set, variant name, number, variation), or a throw: a
 * card number is never unique on its own.
 */
export function uniqueCard(
  setId: SetId,
  variantName: string | null,
  cardNumber: string,
  variation: string | null = null,
): CardId {
  const matches = cards.filter(
    (c) =>
      c.setId === setId &&
      c.variantPath.name === variantName &&
      c.cardNumber === cardNumber &&
      c.variation === variation,
  );
  if (matches.length !== 1) {
    throw new Error(
      `p5: ${setId} ${variantName ?? "Base"} #${cardNumber} matched ${matches.length}`,
    );
  }
  return matches[0].id;
}

/** Copy one-liner for the drawer's copies list. */
export function copySummary(copy: Copy): string {
  const parts: string[] = [];
  if (copy.quantity > 1) parts.push(`×${copy.quantity}`);
  if (copy.graded) {
    parts.push(
      `${copy.graded.grader} ${copy.graded.grade || "(no grade yet)"}`.trim(),
    );
  } else {
    parts.push(copy.condition ? `Raw, ${copy.condition}` : "Raw");
  }
  if (copy.serialNumber) parts.push(`#${copy.serialNumber}`);
  return parts.join(", ");
}

export function copyMeta(copy: Copy): string {
  const parts: string[] = [];
  if (copy.location) parts.push(copy.location);
  if (copy.costBasis !== undefined) parts.push(`paid $${copy.costBasis}`);
  parts.push(`got it ${copy.acquiredAt}`);
  if (copy.graded?.cert) parts.push(`cert ${copy.graded.cert}`);
  return parts.join(", ");
}

export { getCard };
