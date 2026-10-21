/**
 * NEO-350 — the one module a collection prototype imports for data. The
 * permanent collection demo (`../../final`) reads the same data, so what is
 * here is public: it ships on the `/binder-tracking` marketing page.
 *
 * Re-exports the fake catalog (catalog.ts), the collector's seed state
 * (collector.ts) and search (search.ts), and adds the typed helpers every
 * prototype needs: lookups, accessible labels, ownership counts, smart-binder
 * rules, set completion and team livery.
 *
 * Helpers that depend on what the collector owns take `copies` as their last
 * argument and default to the SEED copies. A prototype holding live state in
 * `usePrototypeStore` passes its own copies (or uses the store's bound
 * versions, which do that for it).
 */

import { contrastRatio } from "@/lib/print/contrast";
import { brands, cards, players, sets, sports, teams } from "./catalog";
import { myCopies } from "./collector";
import type {
  Binder,
  BinderRule,
  Brand,
  Card,
  CardId,
  CardSet,
  Copy,
  CopyDetails,
  Player,
  SetId,
  Sport,
  SportId,
  Team,
  VariantPath,
  VariantType,
} from "./types";

export * from "./types";
export { brands, cards, players, sets, sports, teams, slugify } from "./catalog";
export { binders, buildingSetIds, myCopies } from "./collector";
export { searchCards, normalizeSearchText } from "./search";
export type { SearchHit, SearchOptions } from "./search";

// ---------------------------------------------------------------------------
// Lookups. Ids come from this data, so an unknown id is a prototype bug and
// throws with the id in the message rather than rendering "undefined".
// ---------------------------------------------------------------------------

function indexBy<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.id, r]));
}
const cardById = indexBy(cards);
const playerById = indexBy(players);
const teamById = indexBy(teams);
const setById = indexBy(sets);
const brandById = indexBy(brands);
const sportById = new Map<SportId, Sport>(sports.map((s) => [s.id, s]));

function must<T>(row: T | undefined, kind: string, id: string): T {
  if (row === undefined) throw new Error(`prototype data: unknown ${kind} "${id}"`);
  return row;
}

export const getCard = (id: CardId): Card => must(cardById.get(id), "card", id);
export const getPlayer = (id: string): Player => must(playerById.get(id), "player", id);
export const getTeam = (id: string): Team => must(teamById.get(id), "team", id);
export const getSet = (id: SetId): CardSet => must(setById.get(id), "set", id);
export const getBrand = (id: string): Brand => must(brandById.get(id), "brand", id);
export const getSport = (id: SportId): Sport => must(sportById.get(id), "sport", id);

/** The first player / team on the card: what the face and the label lead with. */
export const leadPlayer = (card: Card): Player => getPlayer(card.playerIds[0]);
export const leadTeam = (card: Card): Team => getTeam(card.teamIds[0]);

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** "1996 Playoff Contenders", "1996-97 Upper Deck". */
export function setLabel(set: CardSet): string {
  return `${set.season} ${set.name}`;
}

/** "Base", "Pennant Flyers", "Gold Refractor". */
export function variantLabel(path: VariantPath): string {
  return path.name ?? path.type;
}

/** "/50", "1/1", or null when unnumbered. */
export function printRunLabel(card: Card): string | null {
  if (card.printRun === null) return null;
  return card.printRun === 1 ? "1/1" : `/${card.printRun}`;
}

/** "Packers", "Red Wings / Whalers" for a multi-team card. */
export function teamNames(card: Card): string {
  return card.teamIds.map((id) => getTeam(id).name).join(" / ");
}

/** "Reggie White", or "A / B" on a multi-player card. */
export function playerNames(card: Card): string {
  return card.playerIds.map((id) => getPlayer(id).name).join(" / ");
}

/** "RW" for Reggie White, "KG" for Ken Griffey Jr. (suffixes dropped). */
export function playerInitials(player: Player): string {
  const parts = player.name
    .replace(/\./g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(jr|sr|ii|iii|iv)$/i.test(w));
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The card's accessible name, unique enough to tell two cards apart:
 *
 *   "1996 Playoff Contenders #4 Reggie White, Packers"
 *   "1996 Playoff Contenders Pennant Flyers #2 Reggie White, Packers"
 *   "2024 Topps Chrome #1 Shohei Ohtani, Dodgers, Gold Refractor /50"
 *   "2024 Topps Chrome #13 Elly De La Cruz, Reds, Sliding variation"
 *
 * Inserts read as part of the set name (how collectors say them); parallels,
 * print runs and variations trail after the team.
 */
export function cardLabel(card: Card): string {
  const set = getSet(card.setId);
  const insert =
    card.variantPath.type === "Inserts" && card.variantPath.name
      ? ` ${card.variantPath.name}`
      : "";
  const parts = [
    `${setLabel(set)}${insert} #${card.cardNumber} ${playerNames(card)}`,
    teamNames(card),
  ];
  if (card.variantPath.type === "Parallels" && card.variantPath.name) {
    const run = printRunLabel(card);
    parts.push(run ? `${card.variantPath.name} ${run}` : card.variantPath.name);
  } else if (printRunLabel(card)) {
    parts.push(`numbered ${printRunLabel(card)}`);
  }
  if (card.variation) parts.push(`${card.variation} variation`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Ordering and set contents
// ---------------------------------------------------------------------------

const VARIANT_ORDER: Record<VariantType, number> = { Base: 0, Inserts: 1, Parallels: 2 };

/** Position of the card's variant in its set's variant list (base first). */
function variantIndex(card: Card): number {
  const set = getSet(card.setId);
  const i = set.variants.findIndex(
    (v) => v.path.type === card.variantPath.type && v.path.name === card.variantPath.name,
  );
  return i === -1 ? 999 : i;
}

/**
 * Checklist order: set year, set name, base → inserts → parallels (in the
 * set's own order), card number naturally (2 < 13 < 13b), regular card before
 * its image variation.
 */
export function compareCards(a: Card, b: Card): number {
  if (a.setId !== b.setId) {
    const sa = getSet(a.setId);
    const sb = getSet(b.setId);
    return sa.year - sb.year || sa.name.localeCompare(sb.name);
  }
  return (
    VARIANT_ORDER[a.variantPath.type] - VARIANT_ORDER[b.variantPath.type] ||
    variantIndex(a) - variantIndex(b) ||
    a.cardNumber.localeCompare(b.cardNumber, undefined, { numeric: true }) ||
    Number(a.variation !== null) - Number(b.variation !== null)
  );
}

/** Narrow by variant type alone, or by type and exact name (`null` = Base). */
export interface VariantFilter {
  type: VariantType;
  name?: string | null;
}

function matchesVariant(card: Card, filter?: VariantFilter): boolean {
  if (!filter) return true;
  if (card.variantPath.type !== filter.type) return false;
  return filter.name === undefined || card.variantPath.name === filter.name;
}

/** The set's cards in checklist order, optionally one variant type or variant. */
export function cardsInSet(setId: SetId, variant?: VariantFilter): Card[] {
  return cards
    .filter((c) => c.setId === setId && matchesVariant(c, variant))
    .sort(compareCards);
}

/** Sets in browse order: sport, then year, then name. */
export function setsInOrder(): CardSet[] {
  return [...sets].sort(
    (a, b) => a.sportId.localeCompare(b.sportId) || a.year - b.year || a.name.localeCompare(b.name),
  );
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

export function copiesOf(cardId: CardId, copies: Copy[] = myCopies): Copy[] {
  return copies.filter((c) => c.cardId === cardId);
}

/** Total physical cards owned (quantities summed), 0 for a need. */
export function ownedCountFor(cardId: CardId, copies: Copy[] = myCopies): number {
  let n = 0;
  for (const c of copies) if (c.cardId === cardId) n += c.quantity;
  return n;
}

export interface Completion {
  total: number;
  /** Distinct cards with at least one copy. */
  owned: number;
  /** 0-100, rounded down so 99.6% never reads as done. */
  percent: number;
  /** The want list, in checklist order. */
  missing: Card[];
}

/** How much of a set (or one variant type / variant of it) the collector has. */
export function setCompletion(
  setId: SetId,
  variant?: VariantFilter,
  copies: Copy[] = myCopies,
): Completion {
  const owned = new Set(copies.filter((c) => c.quantity > 0).map((c) => c.cardId));
  const list = cardsInSet(setId, variant);
  const missing = list.filter((c) => !owned.has(c.id));
  const have = list.length - missing.length;
  return {
    total: list.length,
    owned: have,
    percent: list.length ? Math.floor((have / list.length) * 100) : 0,
    missing,
  };
}

/** Blank details for a new copy: one card, acquired today. */
export function emptyCopyDetails(): CopyDetails {
  return {
    quantity: 1,
    acquiredAt: todayIso(),
    binderIds: [],
    notes: "",
    forSale: false,
  };
}

/** Today in the viewer's own calendar, `YYYY-MM-DD`. */
export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------------------
// Smart binders
// ---------------------------------------------------------------------------

/** Does the card satisfy the rule? Pure, catalog-only: ownership never enters. */
export function evaluateRule(rule: BinderRule, card: Card): boolean {
  switch (rule.kind) {
    case "player":
      return card.playerIds.includes(rule.playerId);
    case "teamOnCard":
      return card.teamIds.includes(rule.teamId);
    case "playedFor":
      return card.playerIds.some((pid) =>
        getPlayer(pid).stints.some((st) => st.teamId === rule.teamId),
      );
    case "brand":
      return getSet(card.setId).brandId === rule.brandId;
    case "set":
      return card.setId === rule.setId;
    case "sport":
      return getSet(card.setId).sportId === rule.sportId;
    case "yearRange": {
      const year = getSet(card.setId).year;
      return year >= rule.from && year <= rule.to;
    }
    case "feature":
      return card.features.includes(rule.feature);
    case "variantType":
      return card.variantPath.type === rule.type;
    case "printRunBelow":
      return card.printRun !== null && card.printRun < rule.max;
    case "hallOfFame":
      return card.playerIds.some((pid) => getPlayer(pid).hallOfFame);
    case "and":
      return rule.rules.every((r) => evaluateRule(r, card));
    case "or":
      return rule.rules.some((r) => evaluateRule(r, card));
    case "not":
      return !evaluateRule(rule.rule, card);
  }
}

/**
 * The rule in words, for a binder's subtitle or a rule builder's preview:
 * "Reggie White", "Red Wings on the card", "Score, and not numbered under /50",
 * "Played for the Wisconsin Badgers".
 */
export function describeRule(rule: BinderRule): string {
  switch (rule.kind) {
    case "player":
      return getPlayer(rule.playerId).name;
    case "teamOnCard":
      return `${getTeam(rule.teamId).name} on the card`;
    case "playedFor": {
      const t = getTeam(rule.teamId);
      return `Played for the ${t.location} ${t.name}`;
    }
    case "brand":
      return getBrand(rule.brandId).name;
    case "set":
      return setLabel(getSet(rule.setId));
    case "sport":
      return getSport(rule.sportId).name;
    case "yearRange":
      return rule.from === rule.to ? String(rule.from) : `${rule.from} to ${rule.to}`;
    case "feature":
      return {
        RC: "Rookie cards",
        AU: "Autographs",
        Relic: "Relics",
        SP: "Short prints",
      }[rule.feature];
    case "variantType":
      return rule.type;
    case "printRunBelow":
      return `Numbered under /${rule.max}`;
    case "hallOfFame":
      return "Hall of Famers";
    case "and":
      return rule.rules
        .map((r, i) => (i === 0 ? describeRule(r) : `and ${lowerFirst(describeRule(r))}`))
        .join(", ");
    case "or":
      return rule.rules.map(describeRule).join(" or ");
    case "not":
      return `not ${lowerFirst(describeRule(rule.rule))}`;
  }
}

function lowerFirst(text: string): string {
  // Keep proper nouns: only lower a leading word that is a plain phrase.
  return /^(Numbered|Rookie|Autographs|Relics|Short|Hall|Played|Base|Inserts|Parallels)/.test(text)
    ? text[0].toLowerCase() + text.slice(1)
    : text;
}

/**
 * The cards a binder shows, in order.
 *
 * - Manual: the cards of the copies filed in it (`Copy.binderIds`), in
 *   layout order when the binder has pages, else checklist order. Distinct
 *   cards: two copies of one card list it once (see `binderCopies`).
 * - Smart: every CATALOG card the rule matches, owned or not, in checklist
 *   order. Pair with `ownedCountFor` to show haves and needs.
 */
export function binderCards(binder: Binder, copies: Copy[] = myCopies): Card[] {
  if (binder.kind === "smart") {
    return cards.filter((c) => evaluateRule(binder.rule, c)).sort(compareCards);
  }
  const filed = binderCopies(binder, copies);
  const seen = new Set<CardId>();
  const out: Card[] = [];
  for (const copy of filed) {
    if (seen.has(copy.cardId)) continue;
    seen.add(copy.cardId);
    out.push(getCard(copy.cardId));
  }
  return binder.layout ? out : out.sort(compareCards);
}

/**
 * The owned copies a binder holds. Manual: copies filed in it, in layout
 * order first when it has pages. Smart: owned copies whose card matches.
 */
export function binderCopies(binder: Binder, copies: Copy[] = myCopies): Copy[] {
  if (binder.kind === "smart") {
    return copies.filter((c) => evaluateRule(binder.rule, getCard(c.cardId)));
  }
  const filed = copies.filter((c) => c.binderIds.includes(binder.id));
  if (!binder.layout) return filed;
  const slotOrder = new Map<string, number>();
  binder.layout.forEach((page, p) =>
    page.slots.forEach((id, s) => {
      if (id) slotOrder.set(id, p * 9 + s);
    }),
  );
  return [...filed].sort(
    (a, b) => (slotOrder.get(a.id) ?? Infinity) - (slotOrder.get(b.id) ?? Infinity),
  );
}

// ---------------------------------------------------------------------------
// Team livery
// ---------------------------------------------------------------------------

/** The app's dark panel surface (Tailwind slate-900). */
export const DARK_SURFACE = "#0F172A";
/** Readable fallback ink on that surface (Tailwind slate-300). */
export const LIVERY_FALLBACK = "#CBD5E1";

/**
 * A team's colour for TEXT on a dark surface: the primary when it reaches
 * 4.5:1 there, else the secondary when that does (Packers gold, Padres gold),
 * else slate-300. Never a livery that fails contrast.
 */
export function teamTextColor(team: Team, surface: string = DARK_SURFACE): string {
  for (const hex of [team.primary, team.secondary]) {
    const ratio = contrastRatio(hex, surface);
    if (ratio !== null && ratio >= 4.5) return hex;
  }
  return LIVERY_FALLBACK;
}

/** Black or white, whichever reads better ON a fill of this colour. */
export function inkOn(fill: string): "#000000" | "#FFFFFF" {
  const black = contrastRatio("#000000", fill) ?? 0;
  const white = contrastRatio("#FFFFFF", fill) ?? 0;
  return black >= white ? "#000000" : "#FFFFFF";
}
