/**
 * NEO-350 prototype 2, "Nine-Pocket": the pure half. Turns the store's live
 * copies and binders into nine-pocket pages, picks a binder's spine colours,
 * and words the little bits of copy every view shares.
 *
 * Nothing here reads a marketplace id or a display name to decide anything:
 * pages come from ids, the checklist and the binder's own layout.
 */

import {
  binderCards,
  binderCopies,
  cardLabel,
  cardsInSet,
  compareCards,
  copiesOf,
  evaluateRule,
  getCard,
  getPlayer,
  getTeam,
  leadTeam,
  playerNames,
  printRunLabel,
  type Binder,
  type BinderId,
  type Card,
  type Copy,
  type ManualBinder,
  type SetId,
  type Team,
  teams,
} from "../_shared/data";

// ---------------------------------------------------------------------------
// Views and pockets
// ---------------------------------------------------------------------------

/** What is open on the desk: the master pile, one binder, or a set to browse. */
export type ViewKey =
  | { kind: "all" }
  | { kind: "binder"; binderId: BinderId }
  | { kind: "set"; setId: SetId };

/** "Lay out like my real binder" or "Just a stack". */
export type LayoutMode = "pockets" | "stack";

export type PocketContent =
  /** Owned. `copies` is one copy (a per-copy pocket) or every copy of the card. */
  | { kind: "have"; card: Card; copies: Copy[] }
  /** A card the binder wants and the collector does not own yet. */
  | { kind: "need"; card: Card }
  | { kind: "empty" };

/** A real pocket in a manual binder's layout: where a drop or a pick lands. */
export interface SlotRef {
  binderId: BinderId;
  page: number;
  slot: number;
}

export interface PocketModel {
  content: PocketContent;
  slot?: SlotRef;
}

export interface PageModel {
  pockets: PocketModel[];
  /** The checklist section the page belongs to ("Base", "Pennant Flyers"). */
  section: string | null;
  /** Pages past the binder's layout ("Not in a pocket yet"). */
  note?: string;
}

export type SortKey = "checklist" | "newest" | "player";
export interface PileFilters {
  graded: boolean;
  forSale: boolean;
  rookies: boolean;
}
export const NO_FILTERS: PileFilters = { graded: false, forSale: false, rookies: false };

const EMPTY: PocketModel = { content: { kind: "empty" } };

/** Chop pockets into pages of nine, padding the last with empty sleeves. */
function paginate(pockets: PocketModel[], section: string | null, note?: string): PageModel[] {
  const pages: PageModel[] = [];
  for (let i = 0; i < pockets.length; i += 9) {
    const chunk = pockets.slice(i, i + 9);
    while (chunk.length < 9) chunk.push(EMPTY);
    pages.push({ pockets: chunk, section, note });
  }
  return pages;
}

/** The checklist section a card files under: each insert alone, parallels together. */
function sectionOf(card: Card): string {
  if (card.variantPath.type === "Base") return "Base";
  if (card.variantPath.type === "Inserts") return card.variantPath.name ?? "Inserts";
  return "Parallels";
}

/** Cards in sections, each section starting on a fresh page, like a real set binder. */
function sectionedPages(cardsInOrder: Card[], toPocket: (c: Card) => PocketModel): PageModel[] {
  const pages: PageModel[] = [];
  let run: Card[] = [];
  let current: string | null = null;
  const flush = () => {
    if (run.length) pages.push(...paginate(run.map(toPocket), current));
    run = [];
  };
  for (const card of cardsInOrder) {
    const s = sectionOf(card);
    if (s !== current) {
      flush();
      current = s;
    }
    run.push(card);
  }
  flush();
  return pages;
}

function perCopy(copies: Copy[]): PocketModel[] {
  return copies.map((copy) => ({
    content: { kind: "have", card: getCard(copy.cardId), copies: [copy] },
  }));
}

function byChecklist(a: Copy, b: Copy): number {
  return compareCards(getCard(a.cardId), getCard(b.cardId));
}

/**
 * When a manual binder's filled pockets sit exactly where one checklist puts
 * them (pocket N holds card N of one set's base or one insert), it is a set
 * binder: its empty pockets are needs. Derived from ids every time, never
 * stored, so filing a stray card in it simply turns the ghosts off.
 */
export function followedChecklist(binder: ManualBinder, copies: Copy[]): Card[] | null {
  if (!binder.layout) return null;
  const byId = new Map(copies.map((c) => [c.id, c]));
  const filled: [number, Card][] = [];
  binder.layout.forEach((page, p) =>
    page.slots.forEach((id, s) => {
      const copy = id ? byId.get(id) : undefined;
      if (copy) filled.push([p * 9 + s, getCard(copy.cardId)]);
    }),
  );
  if (filled.length < 3) return null;
  const first = filled[0][1];
  const list = cardsInSet(first.setId, {
    type: first.variantPath.type,
    name: first.variantPath.name,
  }).filter((c) => c.variation === null);
  return filled.every(([i, card]) => list[i]?.id === card.id) ? list : null;
}

export interface BuildInput {
  view: ViewKey;
  mode: LayoutMode;
  copies: Copy[];
  binders: Binder[];
  sort: SortKey;
  filters: PileFilters;
}

export function buildPages({ view, mode, copies, binders, sort, filters }: BuildInput): PageModel[] {
  if (view.kind === "all") {
    return paginate(perCopy(sortPile(filterPile(copies, filters), sort)), null);
  }

  if (view.kind === "set") {
    return sectionedPages(cardsInSet(view.setId), (card) => {
      const mine = copiesOf(card.id, copies);
      return {
        content: mine.length ? { kind: "have", card, copies: mine } : { kind: "need", card },
      };
    });
  }

  const binder = binders.find((b) => b.id === view.binderId);
  if (!binder) return [];

  if (binder.kind === "smart") {
    if (mode === "stack") {
      return paginate(perCopy([...binderCopies(binder, copies)].sort(byChecklist)), null);
    }
    return paginate(
      binderCards(binder, copies).map((card) => {
        const mine = copiesOf(card.id, copies);
        return {
          content: mine.length ? { kind: "have", card, copies: mine } : { kind: "need", card },
        };
      }),
      null,
    );
  }

  if (mode === "stack" || !binder.layout) {
    return paginate(perCopy([...binderCopies(binder, copies)].sort(byChecklist)), null);
  }

  // A manual binder laid out like the real one: its own pockets, in order.
  const byId = new Map(copies.map((c) => [c.id, c]));
  const followed = followedChecklist(binder, copies);
  const slotted = new Set<string>();
  const pages: PageModel[] = binder.layout.map((page, p) => ({
    section: followed ? sectionOf(followed[0]) : null,
    pockets: page.slots.map((id, s): PocketModel => {
      const slot = { binderId: binder.id, page: p, slot: s };
      const copy = id ? byId.get(id) : undefined;
      if (copy) {
        slotted.add(copy.id);
        return { slot, content: { kind: "have", card: getCard(copy.cardId), copies: [copy] } };
      }
      const wanted = followed?.[p * 9 + s];
      if (wanted && copiesOf(wanted.id, copies).length === 0) {
        return { slot, content: { kind: "need", card: wanted } };
      }
      return { slot, content: { kind: "empty" } };
    }),
  }));

  // A fresh page at the back, unless the last one is still blank.
  const last = pages[pages.length - 1];
  if (!last || last.pockets.some((pk) => pk.content.kind !== "empty")) {
    const p = binder.layout.length;
    pages.push({
      section: null,
      note: "A fresh page",
      pockets: Array.from({ length: 9 }, (_, s) => ({
        slot: { binderId: binder.id, page: p, slot: s },
        content: { kind: "empty" as const },
      })),
    });
  }

  // Filed in the binder (from a copy's details) but in no pocket yet.
  const loose = binderCopies(binder, copies).filter((c) => !slotted.has(c.id));
  if (loose.length) {
    pages.push(...paginate(perCopy(loose.sort(byChecklist)), null, "Not in a pocket yet"));
  }
  return pages;
}

function filterPile(copies: Copy[], f: PileFilters): Copy[] {
  return copies.filter((c) => {
    if (c.quantity < 1) return false;
    if (f.graded && !c.graded) return false;
    if (f.forSale && !c.forSale) return false;
    if (f.rookies && !getCard(c.cardId).features.includes("RC")) return false;
    return true;
  });
}

function sortPile(copies: Copy[], sort: SortKey): Copy[] {
  const out = [...copies];
  if (sort === "newest") {
    return out.sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt) || byChecklist(a, b));
  }
  if (sort === "player") {
    return out.sort(
      (a, b) =>
        lastName(getCard(a.cardId)).localeCompare(lastName(getCard(b.cardId))) ||
        byChecklist(a, b),
    );
  }
  return out.sort(byChecklist);
}

function lastName(card: Card): string {
  const words = getPlayer(card.playerIds[0])
    .name.split(/\s+/)
    .filter((w) => !/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(w));
  return words[words.length - 1] ?? "";
}

// ---------------------------------------------------------------------------
// Placing a card
// ---------------------------------------------------------------------------

/**
 * Where a card goes when the collector says "put it in this binder": its own
 * checklist pocket when the binder follows a checklist and that pocket is
 * free, else the first empty pocket, else a pocket on a new page.
 */
export function pocketFor(binder: ManualBinder, card: Card, copies: Copy[]): SlotRef {
  const layout = binder.layout ?? [];
  const followed = followedChecklist(binder, copies);
  const at = (i: number) => layout[Math.floor(i / 9)]?.slots[i % 9] ?? null;
  const total = layout.length * 9;
  if (followed) {
    const i = followed.findIndex((c) => c.id === card.id);
    if (i !== -1 && i < total && at(i) === null) {
      return { binderId: binder.id, page: Math.floor(i / 9), slot: i % 9 };
    }
  }
  for (let i = 0; i < total; i++) {
    // In a checklist binder, leave the other cards' pockets for them.
    if (at(i) === null && !(followed && i < followed.length)) {
      return { binderId: binder.id, page: Math.floor(i / 9), slot: i % 9 };
    }
  }
  return { binderId: binder.id, page: layout.length, slot: 0 };
}

// ---------------------------------------------------------------------------
// Counts and colours
// ---------------------------------------------------------------------------

export interface BinderCount {
  /** Physical cards (quantities summed). */
  cards: number;
  /** Smart binders: distinct cards owned and wanted. */
  have?: number;
  need?: number;
}

export function binderCount(binder: Binder, copies: Copy[]): BinderCount {
  const filed = binderCopies(binder, copies);
  const cards = filed.reduce((n, c) => n + c.quantity, 0);
  if (binder.kind === "manual") {
    const followed = followedChecklist(binder, copies);
    if (!followed) return { cards };
    const owned = new Set(copies.map((c) => c.cardId));
    const have = followed.filter((c) => owned.has(c.id)).length;
    return { cards, have, need: followed.length - have };
  }
  const all = binderCards(binder, copies);
  const owned = new Set(copies.filter((c) => c.quantity > 0).map((c) => c.cardId));
  const have = all.filter((c) => owned.has(c.id)).length;
  return { cards, have, need: all.length - have };
}

export interface Livery {
  primary: string;
  secondary: string;
}

const MASTER: Livery = { primary: "#0B1220", secondary: "#00C2FF" };
const PLAIN: Livery = { primary: "#334155", secondary: "#94A3B8" };

function teamLivery(team: Team): Livery {
  return { primary: team.primary, secondary: team.secondary };
}

function dominantTeam(cards: Card[]): Team | null {
  const tally = new Map<string, number>();
  for (const c of cards) tally.set(c.teamIds[0], (tally.get(c.teamIds[0]) ?? 0) + 1);
  let best: string | null = null;
  let max = 0;
  for (const [id, n] of tally) if (n > max) [best, max] = [id, n];
  return best ? getTeam(best) : null;
}

/**
 * The vinyl colour of a binder. It must not change as cards go in and out,
 * so it never reads the collector's copies: a smart binder takes the team its
 * rule names, or the team most of its (catalog) cards wear; a manual binder
 * gets a team livery picked from its id.
 */
export function binderLivery(binder: Binder | "all"): Livery {
  if (binder === "all") return MASTER;
  if (binder.kind === "smart") {
    const r = binder.rule;
    if (r.kind === "teamOnCard" || r.kind === "playedFor") return teamLivery(getTeam(r.teamId));
    const team = dominantTeam(binderCards(binder));
    return team ? teamLivery(team) : PLAIN;
  }
  let h = 0;
  for (const ch of binder.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return teams.length ? teamLivery(teams[h % teams.length]) : PLAIN;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "#4 Reggie White", "Pennant Flyers #2 Reggie White", "Gold Refractor #1 Shohei Ohtani". */
export function shortName(card: Card): string {
  const variant = card.variantPath.name ? `${card.variantPath.name} ` : "";
  const variation = card.variation ? ` (${card.variation})` : "";
  return `${variant}#${card.cardNumber} ${playerNames(card)}${variation}`;
}

export function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** "PSA 9" or null for a raw copy. */
export function slabLabel(copy: Copy): string | null {
  return copy.graded ? `${copy.graded.grader} ${copy.graded.grade}`.trim() : null;
}

/** The pocket's accessible name for an owned card. */
export function havePocketLabel(card: Card, copies: Copy[]): string {
  const qty = copies.reduce((n, c) => n + c.quantity, 0);
  const parts = [cardLabel(card)];
  if (qty > 1) parts.push(`${qty} copies`);
  if (copies.length === 1) {
    const slab = slabLabel(copies[0]);
    if (slab) parts.push(slab);
    if (copies[0].serialNumber) parts.push(`serial ${copies[0].serialNumber}`);
  }
  const forSale = copies.find((c) => c.forSale);
  if (forSale) {
    parts.push(forSale.askPrice ? `for sale at ${money(forSale.askPrice)}` : "for sale");
  }
  return parts.join(", ");
}

/** One line per fact about a copy, for the detail view. */
export function copyFacts(copy: Copy, card: Card): string[] {
  const facts: string[] = [];
  if (copy.graded) {
    facts.push(
      `${slabLabel(copy)}${copy.graded.cert ? `, cert ${copy.graded.cert}` : ""}`,
    );
  } else {
    facts.push(copy.condition ? `Raw, ${copy.condition}` : "Raw");
  }
  if (copy.serialNumber) facts.push(`Serial ${copy.serialNumber}`);
  else if (printRunLabel(card)) facts.push(`Numbered ${printRunLabel(card)}, serial not noted`);
  if (copy.location) facts.push(`Lives in: ${copy.location}`);
  if (copy.costBasis !== undefined) facts.push(`Paid ${money(copy.costBasis)}`);
  facts.push(`Got it ${formatDate(copy.acquiredAt)}`);
  return facts;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Does the card belong in this smart binder? (For the "it doesn't fit" note.) */
export function fitsBinder(binder: Binder, card: Card): boolean {
  return binder.kind === "smart" ? evaluateRule(binder.rule, card) : true;
}

export { leadTeam };
